// Package cloudrelay provides on-demand provisioning of throw-away TURN
// (coturn) relay VPSes used to punch through CGNAT when guests cannot reach
// the host's SFU directly.
//
// The package is structured around a provider-agnostic interface (Provider)
// and a higher level Manager that owns the lifecycle (start/stop/touch/recover)
// and persists active relay state under ~/.zubrameet/ so that a crashed host
// process can clean up its leaked VMs on the next launch instead of leaving
// the user with a surprise cloud bill.
package cloudrelay

import (
	"context"
	"time"
)

// Provider abstracts a concrete cloud provider (Hetzner, DigitalOcean, ...).
//
// Implementations must be safe for concurrent use from a single Manager — the
// Manager itself serialises calls, but callers may invoke EstimateCost /
// Regions / Name / Status from arbitrary goroutines.
type Provider interface {
	// Name returns the canonical provider identifier (e.g. "hetzner").
	Name() string

	// CreateRelay provisions a VM running coturn in the given region and
	// blocks until the relay is reachable on its public IP. The call honours
	// ctx cancellation: if ctx is cancelled mid-provision the implementation
	// must best-effort destroy the partially-created VM before returning.
	CreateRelay(ctx context.Context, region string) (*Relay, error)

	// DestroyRelay tears down the VM identified by relayID. Idempotent: a
	// missing/already-deleted resource is treated as success.
	DestroyRelay(ctx context.Context, relayID string) error

	// Status reports the provider-side state of the relay.
	Status(ctx context.Context, relayID string) (RelayStatus, error)

	// EstimateCost returns a human-readable approximate cost for running a
	// relay for durationHours, suitable for display in the UI.
	EstimateCost(durationHours float64) string

	// Regions lists regions in which CreateRelay may be called.
	Regions() []Region
}

// Region describes one provider region exposed to the UI.
type Region struct {
	// Code is the provider-specific region code (e.g. "fsn1", "nyc3").
	Code string
	// Name is the human-readable location ("Falkenstein, Germany").
	Name string
}

// Relay is the public description of an active TURN relay. All fields are
// safe to expose to the host UI; TURNUser/TURNPass are also given to guests
// so they can authenticate against coturn.
type Relay struct {
	ID         string    `json:"id"`         // provider-specific resource id
	Provider   string    `json:"provider"`   // matches Provider.Name()
	Region     string    `json:"region"`     // region code
	PublicIP   string    `json:"publicIP"`   // public IPv4 of the VM
	TURNPort   int       `json:"turnPort"`   // coturn listening port (3478)
	TURNUser   string    `json:"turnUser"`   // long-term TURN username
	TURNPass   string    `json:"turnPass"`   // long-term TURN password
	CreatedAt  time.Time `json:"createdAt"`  // provisioning timestamp
	DestroyTTL time.Time `json:"destroyTTL"` // hard auto-destroy deadline
}

// State enumerates RelayStatus.State values.
const (
	StateCreating   = "creating"
	StateReady      = "ready"
	StateDestroying = "destroying"
	StateDestroyed  = "destroyed"
	StateError      = "error"
)

// RelayStatus is the provider-side observable state of a relay.
type RelayStatus struct {
	State    string `json:"state"`
	PublicIP string `json:"publicIP"`
	Error    string `json:"error,omitempty"`
}
