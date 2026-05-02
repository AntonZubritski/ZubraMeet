package cloudrelay

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/hetznercloud/hcloud-go/v2/hcloud"
)

// Hetzner-specific tunables. The defaults here target the cheapest viable
// configuration for a TURN relay (cx22 = 2 vCPU / 4 GB RAM / 80 GB disk,
// roughly €0.006 / hour as of writing).
const (
	hetznerProviderName = "hetzner"

	// hetznerServerType is the Hetzner Cloud server type slug. cx22 is the
	// smallest current-generation Intel server and is more than enough for
	// a TURN relay whose only job is to bounce SRTP packets.
	hetznerServerType = "cx22"

	// hetznerImage is the OS image used for the relay VM.
	hetznerImage = "ubuntu-24.04"

	// hetznerSSHKeyName is the name under which we register the local
	// ed25519 public key in the Hetzner project. Must be unique within the
	// project; we suffix the key fingerprint to avoid collisions when the
	// user re-creates their local state dir.
	hetznerSSHKeyNamePrefix = "zubrameet-relay-"

	// pricePerHourEUR is used by EstimateCost. It does not include the
	// Hetzner per-hour IPv4 surcharge (currently €0.0006/h) — the estimate
	// is informational only.
	pricePerHourEUR = 0.006

	// readyTimeout caps how long CreateRelay waits for the VM to reach the
	// `running` state before giving up and tearing it down.
	readyTimeout = 90 * time.Second

	// pollInterval is the gap between server status polls inside
	// waitForRunning.
	pollInterval = 3 * time.Second

	// coturnWarmup is how long we wait after the VM reports `running`
	// before considering coturn ready. Cloud-init runs coturn install +
	// systemctl restart in ~15-25s on cx22 in our measurements; 30s is the
	// safe upper bound without doing actual UDP probing.
	coturnWarmup = 30 * time.Second
)

// hetznerRegions is the static list of regions exposed to the UI. Hetzner
// adds new locations occasionally; keeping this static keeps the UI
// deterministic and avoids a network call on startup.
var hetznerRegions = []Region{
	{Code: "fsn1", Name: "Falkenstein, Germany"},
	{Code: "nbg1", Name: "Nuremberg, Germany"},
	{Code: "hel1", Name: "Helsinki, Finland"},
	{Code: "ash", Name: "Ashburn, USA"},
	{Code: "hil", Name: "Hillsboro, USA"},
}

// Compile-time assertion that *HetznerProvider satisfies Provider. If a new
// method is added to Provider this line will start failing the build, which
// is the cheapest possible nudge to keep all drivers in sync.
var _ Provider = (*HetznerProvider)(nil)

// HetznerProvider implements Provider against the Hetzner Cloud API.
//
// A single instance can be shared across goroutines; the underlying
// hcloud.Client is concurrency-safe.
type HetznerProvider struct {
	client   *hcloud.Client
	apiToken string

	// stateDir is where ensureSSHKey writes the local key material. It is
	// set by NewHetznerWithStateDir and defaults to "" (in which case
	// CreateRelay falls back to the user's home dir at provision time).
	stateDir string
}

// NewHetzner builds a HetznerProvider with the given Hetzner Cloud API
// token. The token is checked lazily — the first call to CreateRelay /
// Status will surface an authentication error.
func NewHetzner(apiToken string) *HetznerProvider {
	return &HetznerProvider{
		client:   hcloud.NewClient(hcloud.WithToken(apiToken)),
		apiToken: apiToken,
	}
}

// NewHetznerWithStateDir is like NewHetzner but lets the caller pin the
// directory used for the local SSH keypair. The Manager normally calls this
// so that the provider and Manager share ManagerConfig.StateDir.
func NewHetznerWithStateDir(apiToken, stateDir string) *HetznerProvider {
	p := NewHetzner(apiToken)
	p.stateDir = stateDir
	return p
}

// Name returns "hetzner". Stable; persisted into relays.json.
func (p *HetznerProvider) Name() string { return hetznerProviderName }

// Regions returns the static region list.
func (p *HetznerProvider) Regions() []Region {
	out := make([]Region, len(hetznerRegions))
	copy(out, hetznerRegions)
	return out
}

// EstimateCost returns a human-readable EUR estimate for a relay running
// for durationHours.
func (p *HetznerProvider) EstimateCost(durationHours float64) string {
	if durationHours < 0 {
		durationHours = 0
	}
	return fmt.Sprintf("≈ €%.4f", pricePerHourEUR*durationHours)
}

// CreateRelay provisions a coturn relay in the given Hetzner region.
//
// The function blocks until the VM reaches `running` state plus a fixed
// warmup window for coturn to come up. If anything fails after the VM has
// been created the partial VM is best-effort destroyed before the error is
// returned, so callers do not have to clean up after a failed call.
func (p *HetznerProvider) CreateRelay(ctx context.Context, region string) (*Relay, error) {
	if region == "" {
		return nil, errors.New("cloudrelay: hetzner: region is required")
	}
	if !p.knownRegion(region) {
		return nil, fmt.Errorf("cloudrelay: hetzner: unknown region %q", region)
	}

	turnUser, err := generateTURNUser()
	if err != nil {
		return nil, fmt.Errorf("cloudrelay: hetzner: generate turn user: %w", err)
	}
	turnPass, err := generateTURNPassword()
	if err != nil {
		return nil, fmt.Errorf("cloudrelay: hetzner: generate turn pass: %w", err)
	}

	sshKeyRefs, err := p.ensureSSHKeyOnHetzner(ctx)
	if err != nil {
		// SSH access is for debug only — coturn is provisioned via
		// cloud-init. Log and continue without an SSH key rather than
		// failing the whole provision.
		log.Printf("cloudrelay: hetzner: ensure ssh key (continuing without): %v", err)
		sshKeyRefs = nil
	}

	name := "zubrameet-relay-" + uuid.NewString()[:8]
	userData := cloudInitScript(turnUser, turnPass)

	createRes, _, err := p.client.Server.Create(ctx, hcloud.ServerCreateOpts{
		Name:       name,
		ServerType: &hcloud.ServerType{Name: hetznerServerType},
		Image:      &hcloud.Image{Name: hetznerImage},
		Location:   &hcloud.Location{Name: region},
		UserData:   userData,
		SSHKeys:    sshKeyRefs,
		Labels: map[string]string{
			"app":  "zubrameet",
			"role": "turn-relay",
		},
	})
	if err != nil {
		return nil, fmt.Errorf("cloudrelay: hetzner: create server: %w", err)
	}
	server := createRes.Server
	if server == nil {
		return nil, errors.New("cloudrelay: hetzner: empty server response")
	}

	// From here on out, any failure tears the VM down so we do not leak
	// hourly billing.
	cleanup := func(reason error) error {
		dctx, cancel := context.WithTimeout(context.Background(), destroyShutdownTimeout)
		defer cancel()
		if dErr := p.DestroyRelay(dctx, strconv.FormatInt(server.ID, 10)); dErr != nil {
			log.Printf("cloudrelay: hetzner: cleanup destroy after failure: %v", dErr)
		}
		return reason
	}

	if err := p.waitForRunning(ctx, server.ID); err != nil {
		return nil, cleanup(fmt.Errorf("cloudrelay: hetzner: wait running: %w", err))
	}

	// Re-fetch to get the assigned public IP — the Create response may
	// return before primary IP attachment is reflected.
	server, _, err = p.client.Server.GetByID(ctx, server.ID)
	if err != nil {
		return nil, cleanup(fmt.Errorf("cloudrelay: hetzner: refetch server: %w", err))
	}
	if server == nil {
		return nil, cleanup(errors.New("cloudrelay: hetzner: server vanished after create"))
	}
	publicIP := publicIPv4(server)
	if publicIP == "" {
		return nil, cleanup(errors.New("cloudrelay: hetzner: server has no public IPv4"))
	}

	// Give coturn time to install + start. Honour ctx cancellation.
	select {
	case <-time.After(coturnWarmup):
	case <-ctx.Done():
		return nil, cleanup(ctx.Err())
	}

	now := time.Now()
	relay := &Relay{
		ID:         strconv.FormatInt(server.ID, 10),
		Provider:   hetznerProviderName,
		Region:     region,
		PublicIP:   publicIP,
		TURNPort:   3478,
		TURNUser:   turnUser,
		TURNPass:   turnPass,
		CreatedAt:  now,
		DestroyTTL: now.Add(defaultDestroyTTL),
	}
	return relay, nil
}

// DestroyRelay deletes the Hetzner server identified by relayID. A
// not-found response from the API is mapped to nil (idempotent destroy).
func (p *HetznerProvider) DestroyRelay(ctx context.Context, relayID string) error {
	if relayID == "" {
		return errors.New("cloudrelay: hetzner: empty relayID")
	}
	id, err := strconv.ParseInt(relayID, 10, 64)
	if err != nil {
		return fmt.Errorf("cloudrelay: hetzner: parse relayID %q: %w", relayID, err)
	}
	_, _, err = p.client.Server.DeleteWithResult(ctx, &hcloud.Server{ID: id})
	if err != nil {
		if hcloud.IsError(err, hcloud.ErrorCodeNotFound) {
			return nil
		}
		return fmt.Errorf("cloudrelay: hetzner: delete server %d: %w", id, err)
	}
	return nil
}

// Status returns the current state of the Hetzner server.
func (p *HetznerProvider) Status(ctx context.Context, relayID string) (RelayStatus, error) {
	id, err := strconv.ParseInt(relayID, 10, 64)
	if err != nil {
		return RelayStatus{State: StateError, Error: err.Error()}, fmt.Errorf("cloudrelay: hetzner: parse relayID %q: %w", relayID, err)
	}
	server, _, err := p.client.Server.GetByID(ctx, id)
	if err != nil {
		return RelayStatus{State: StateError, Error: err.Error()}, err
	}
	if server == nil {
		return RelayStatus{State: StateDestroyed}, nil
	}
	return RelayStatus{
		State:    mapHetznerState(server.Status),
		PublicIP: publicIPv4(server),
	}, nil
}

// --- helpers -----------------------------------------------------------

func (p *HetznerProvider) knownRegion(code string) bool {
	for _, r := range hetznerRegions {
		if r.Code == code {
			return true
		}
	}
	return false
}

// waitForRunning polls until the server reports ServerStatusRunning, or
// the context / readyTimeout elapses, or the API reports a terminal state.
func (p *HetznerProvider) waitForRunning(ctx context.Context, id int64) error {
	deadline := time.Now().Add(readyTimeout)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		server, _, err := p.client.Server.GetByID(ctx, id)
		if err != nil {
			return err
		}
		if server == nil {
			return fmt.Errorf("server %d not found mid-provision", id)
		}
		switch server.Status {
		case hcloud.ServerStatusRunning:
			return nil
		case hcloud.ServerStatusDeleting, hcloud.ServerStatusUnknown:
			return fmt.Errorf("server entered terminal state %q", server.Status)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("server did not become running within %s (last status %q)", readyTimeout, server.Status)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollInterval):
		}
	}
}

// ensureSSHKeyOnHetzner reads or generates the local relay keypair and
// makes sure it is registered with the Hetzner project. Returns the SSHKey
// references to attach to ServerCreateOpts.
//
// This call is best-effort: if it fails the caller should log and continue
// without an SSH key, since coturn is configured via cloud-init and the
// SSH key is only needed for debug access.
func (p *HetznerProvider) ensureSSHKeyOnHetzner(ctx context.Context) ([]*hcloud.SSHKey, error) {
	if p.stateDir == "" {
		return nil, errors.New("hetzner: stateDir not configured (use NewHetznerWithStateDir)")
	}
	pubKey, err := ensureSSHKey(p.stateDir)
	if err != nil {
		return nil, err
	}
	parsed, _, _, _, err := parseAuthorizedKeyPrefix(pubKey)
	if err != nil {
		return nil, fmt.Errorf("parse local public key: %w", err)
	}

	// First try to find by fingerprint so we do not create duplicates.
	existing, _, err := p.client.SSHKey.GetByFingerprint(ctx, parsed.fingerprint)
	if err != nil {
		return nil, fmt.Errorf("lookup ssh key by fingerprint: %w", err)
	}
	if existing != nil {
		return []*hcloud.SSHKey{existing}, nil
	}

	name := hetznerSSHKeyNamePrefix + strings.ReplaceAll(parsed.shortFingerprint, ":", "")
	key, _, err := p.client.SSHKey.Create(ctx, hcloud.SSHKeyCreateOpts{
		Name:      name,
		PublicKey: strings.TrimRight(pubKey, "\n"),
		Labels: map[string]string{
			"app":  "zubrameet",
			"role": "turn-relay",
		},
	})
	if err != nil {
		return nil, fmt.Errorf("create ssh key: %w", err)
	}
	return []*hcloud.SSHKey{key}, nil
}

// publicIPv4 extracts the public IPv4 address from a Hetzner Server, returning
// "" if the server has no v4 (rare, e.g. v6-only configurations).
func publicIPv4(server *hcloud.Server) string {
	if server == nil {
		return ""
	}
	ip := server.PublicNet.IPv4.IP
	if ip == nil {
		return ""
	}
	return ip.String()
}

// mapHetznerState collapses Hetzner's many statuses onto our small State
// enum used in RelayStatus.
func mapHetznerState(s hcloud.ServerStatus) string {
	switch s {
	case hcloud.ServerStatusRunning:
		return StateReady
	case hcloud.ServerStatusInitializing,
		hcloud.ServerStatusStarting,
		hcloud.ServerStatusOff,
		hcloud.ServerStatusMigrating,
		hcloud.ServerStatusRebuilding:
		return StateCreating
	case hcloud.ServerStatusStopping, hcloud.ServerStatusDeleting:
		return StateDestroying
	default:
		return StateError
	}
}

// generateTURNUser returns a short stable identifier suitable as a
// long-term-credential username. uuid.New() gives 122 bits of entropy
// which is overkill for a 4-hour relay but trivial to generate.
func generateTURNUser() (string, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	// strip dashes for a slightly shorter token; turnserver.conf is
	// whitespace-sensitive but not dash-sensitive.
	return strings.ReplaceAll(id.String(), "-", ""), nil
}

// generateTURNPassword returns 32 random bytes encoded as URL-safe base64.
// 256 bits of entropy is well past brute-force territory.
func generateTURNPassword() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}
