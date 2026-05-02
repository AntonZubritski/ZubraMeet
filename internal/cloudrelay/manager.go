package cloudrelay

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// defaultStateDirName is the per-user dir under $HOME used when
	// ManagerConfig.StateDir is empty.
	defaultStateDirName = ".zubrameet"

	// defaultDestroyTTL is the hard upper bound on relay lifetime applied at
	// CreateRelay time. The watchdog destroys the relay once this expires
	// regardless of what Touch was last called with — it is the safety net
	// for a crashed/disconnected host.
	defaultDestroyTTL = 4 * time.Hour

	// watchdogInterval controls how often the background goroutine checks
	// the active relay's TTL.
	watchdogInterval = 30 * time.Second

	// destroyShutdownTimeout caps how long Stop / forceStop spends waiting
	// for the provider to acknowledge a delete.
	destroyShutdownTimeout = 60 * time.Second
)

// ErrNoActiveRelay is returned by operations that need an active relay
// (Touch, Stop is tolerant) when none has been started.
var ErrNoActiveRelay = errors.New("cloudrelay: no active relay")

// ManagerConfig configures NewManager.
type ManagerConfig struct {
	// Provider drives VM lifecycle. Required.
	Provider Provider
	// Region is the default provider region passed to CreateRelay.
	Region string
	// StateDir is the directory used for persistent state and per-provider
	// secrets (e.g. SSH keys). Defaults to ~/.zubrameet/.
	StateDir string
}

// Manager owns the lifetime of at most one active relay at a time. It is
// safe for concurrent use from any goroutine.
type Manager struct {
	cfg ManagerConfig

	mu     sync.Mutex
	active *Relay

	// watchdog state, guarded by mu (start/stop), watchdog goroutine reads
	// active under the same lock.
	wdCancel context.CancelFunc
	wdDone   chan struct{}
}

// NewManager validates cfg, ensures the state dir exists, and returns a
// ready-to-use Manager. It does NOT touch the network — call Recover to
// reconcile with persisted state and Start to provision.
func NewManager(cfg ManagerConfig) (*Manager, error) {
	if cfg.Provider == nil {
		return nil, errors.New("cloudrelay: ManagerConfig.Provider is required")
	}
	if cfg.StateDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("cloudrelay: resolve home dir: %w", err)
		}
		cfg.StateDir = filepath.Join(home, defaultStateDirName)
	}
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		return nil, fmt.Errorf("cloudrelay: mkdir %s: %w", cfg.StateDir, err)
	}
	return &Manager{cfg: cfg}, nil
}

// Active returns a snapshot of the currently active relay, or nil if none.
// The returned pointer must be treated as read-only by callers.
func (m *Manager) Active() *Relay {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active == nil {
		return nil
	}
	cp := *m.active
	return &cp
}

// Start provisions a relay if none is active. If one is already active it is
// returned unchanged (idempotent). The call blocks on provider provisioning
// and respects ctx cancellation.
func (m *Manager) Start(ctx context.Context) (*Relay, error) {
	m.mu.Lock()
	if m.active != nil {
		cp := *m.active
		m.mu.Unlock()
		return &cp, nil
	}
	region := m.cfg.Region
	prov := m.cfg.Provider
	m.mu.Unlock()

	relay, err := prov.CreateRelay(ctx, region)
	if err != nil {
		return nil, fmt.Errorf("cloudrelay: create relay: %w", err)
	}
	if relay == nil {
		return nil, errors.New("cloudrelay: provider returned nil relay")
	}
	if relay.DestroyTTL.IsZero() {
		relay.DestroyTTL = time.Now().Add(defaultDestroyTTL)
	}

	m.mu.Lock()
	// In the (unlikely) race where Start was called twice we keep the first
	// winner and tear down the loser instead of leaking it.
	if m.active != nil {
		winner := *m.active
		m.mu.Unlock()
		go func(loser Relay) {
			ctx, cancel := context.WithTimeout(context.Background(), destroyShutdownTimeout)
			defer cancel()
			if err := prov.DestroyRelay(ctx, loser.ID); err != nil {
				log.Printf("cloudrelay: destroy losing concurrent relay %s: %v", loser.ID, err)
			}
		}(*relay)
		return &winner, nil
	}
	m.active = relay
	m.startWatchdogLocked()
	m.mu.Unlock()

	if err := saveState(m.cfg.StateDir, relay); err != nil {
		// Persistence failures are surfaced as warnings — the relay is
		// already running, killing it because of a disk error would be
		// worse for the user.
		log.Printf("cloudrelay: persist state: %v", err)
	}

	cp := *relay
	return &cp, nil
}

// Stop destroys the active relay (if any) and clears persisted state. Safe
// to call when no relay is active.
func (m *Manager) Stop(ctx context.Context) error {
	m.mu.Lock()
	if m.active == nil {
		m.mu.Unlock()
		// Best-effort cleanup of stale state on disk.
		_ = clearState(m.cfg.StateDir)
		return nil
	}
	relay := *m.active
	prov := m.cfg.Provider
	m.stopWatchdogLocked()
	m.active = nil
	m.mu.Unlock()

	err := prov.DestroyRelay(ctx, relay.ID)
	if cerr := clearState(m.cfg.StateDir); cerr != nil {
		log.Printf("cloudrelay: clear state file: %v", cerr)
	}
	if err != nil {
		return fmt.Errorf("cloudrelay: destroy relay %s: %w", relay.ID, err)
	}
	return nil
}

// Touch extends the active relay's hard TTL by ttl from now. Typically called
// from a heartbeat handler whenever a guest is connected, so an idle host
// eventually allows the watchdog to reap the VM.
func (m *Manager) Touch(ctx context.Context, ttl time.Duration) error {
	if ttl <= 0 {
		return errors.New("cloudrelay: ttl must be positive")
	}
	m.mu.Lock()
	if m.active == nil {
		m.mu.Unlock()
		return ErrNoActiveRelay
	}
	m.active.DestroyTTL = time.Now().Add(ttl)
	snap := *m.active
	m.mu.Unlock()

	if err := saveState(m.cfg.StateDir, &snap); err != nil {
		log.Printf("cloudrelay: persist touch: %v", err)
	}
	return nil
}

// Recover reconciles in-memory state with what was persisted before a
// (potentially crashed) previous run. Behaviour:
//   - no persisted state → no-op
//   - persisted relay belongs to a different provider → log + delete file
//   - persisted relay's TTL has expired → destroy it on the provider, then
//     drop the file (cleanup of leaked VMs from a previous crash)
//   - persisted relay is still within TTL → adopt it as the active relay,
//     start the watchdog, and return
func (m *Manager) Recover(ctx context.Context) error {
	relay, err := loadState(m.cfg.StateDir)
	if err != nil {
		return fmt.Errorf("cloudrelay: load state: %w", err)
	}
	if relay == nil {
		return nil
	}

	if relay.Provider != m.cfg.Provider.Name() {
		log.Printf(
			"cloudrelay: persisted relay belongs to provider %q, current is %q; ignoring and clearing state",
			relay.Provider, m.cfg.Provider.Name(),
		)
		_ = clearState(m.cfg.StateDir)
		return nil
	}

	if time.Now().After(relay.DestroyTTL) {
		log.Printf("cloudrelay: recovering expired relay %s, destroying", relay.ID)
		if err := m.cfg.Provider.DestroyRelay(ctx, relay.ID); err != nil {
			// Don't fail Recover — the user should still be able to start
			// fresh. We log loudly instead.
			log.Printf("cloudrelay: destroy expired relay %s: %v", relay.ID, err)
		}
		_ = clearState(m.cfg.StateDir)
		return nil
	}

	m.mu.Lock()
	m.active = relay
	m.startWatchdogLocked()
	m.mu.Unlock()
	log.Printf("cloudrelay: recovered active relay %s (TTL %s)", relay.ID, relay.DestroyTTL.Format(time.RFC3339))
	return nil
}

// --- watchdog ----------------------------------------------------------

// startWatchdogLocked launches the TTL watchdog. Caller must hold m.mu.
func (m *Manager) startWatchdogLocked() {
	if m.wdCancel != nil {
		// already running
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.wdCancel = cancel
	m.wdDone = make(chan struct{})
	go m.watchdog(ctx, m.wdDone)
}

// stopWatchdogLocked signals the watchdog to exit and waits for it.
// Caller must hold m.mu.
func (m *Manager) stopWatchdogLocked() {
	if m.wdCancel == nil {
		return
	}
	cancel := m.wdCancel
	done := m.wdDone
	m.wdCancel = nil
	m.wdDone = nil

	// Release the lock briefly so the watchdog can take it for its periodic
	// check (it grabs m.mu to read active). It's fine to drop and reacquire
	// — the only state the caller cares about is m.active which it has
	// already nil'd.
	m.mu.Unlock()
	cancel()
	<-done
	m.mu.Lock()
}

// watchdog periodically checks if the active relay's hard TTL has expired
// and force-destroys the VM if so. Panics in the destroy path are caught
// to avoid taking the host process down.
func (m *Manager) watchdog(ctx context.Context, done chan<- struct{}) {
	defer close(done)
	t := time.NewTicker(watchdogInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.mu.Lock()
			if m.active == nil {
				m.mu.Unlock()
				return
			}
			expired := time.Now().After(m.active.DestroyTTL)
			m.mu.Unlock()
			if expired {
				m.forceStop()
				return
			}
		}
	}
}

// forceStop is the panic-safe destroy path used by the watchdog.
func (m *Manager) forceStop() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("cloudrelay: panic in forceStop: %v", r)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), destroyShutdownTimeout)
	defer cancel()
	if err := m.Stop(ctx); err != nil {
		log.Printf("cloudrelay: watchdog forceStop: %v", err)
	} else {
		log.Printf("cloudrelay: watchdog destroyed expired relay")
	}
}

// --- cloud-init helper -------------------------------------------------

// cloudInitScript renders the bash script handed to Hetzner via UserData.
// It installs and configures coturn with long-term credentials (turnUser /
// turnPass) on UDP/TCP 3478. external-ip is filled in at boot via ipify
// because the VM does not know its public address until DHCP completes.
func cloudInitScript(turnUser, turnPass string) string {
	// Disallow characters that would break the heredoc / config parsing.
	// turnUser/turnPass are generated by us so this is purely defence in
	// depth, but it makes the failure mode loud rather than silent.
	if strings.ContainsAny(turnUser, "\n:") || strings.ContainsAny(turnPass, "\n:") {
		// Replace offending chars rather than panic — caller has already
		// committed to creating the VM by this point.
		turnUser = sanitizeCred(turnUser)
		turnPass = sanitizeCred(turnPass)
	}

	const tpl = `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq coturn curl
PUBLIC_IP=$(curl -sS --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')
cat > /etc/turnserver.conf <<EOF
listening-port=3478
listening-ip=0.0.0.0
relay-ip=0.0.0.0
external-ip=$PUBLIC_IP
user=%s:%s
realm=zubrameet
no-tls
no-dtls
no-cli
fingerprint
lt-cred-mech
EOF
echo "TURNSERVER_ENABLED=1" > /etc/default/coturn
systemctl enable coturn
systemctl restart coturn
`
	return fmt.Sprintf(tpl, turnUser, turnPass)
}

func sanitizeCred(s string) string {
	r := strings.NewReplacer("\n", "", "\r", "", ":", "")
	return r.Replace(s)
}
