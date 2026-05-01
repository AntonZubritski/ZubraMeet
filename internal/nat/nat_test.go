package nat

import (
	"context"
	"testing"
	"time"
)

// TestDiscoverContext verifies that Discover honours an already-cancelled
// context and returns quickly with an error instead of blocking on SSDP.
func TestDiscoverContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before calling

	start := time.Now()
	c, err := Discover(ctx)
	elapsed := time.Since(start)

	if err == nil {
		// If by some chance a real router was discovered before the
		// cancellation propagated, clean up but still fail: the contract
		// is that a cancelled context must produce an error.
		if c != nil {
			_ = c.Close()
		}
		t.Fatalf("Discover with cancelled ctx returned nil error")
	}
	if elapsed > 2*time.Second {
		t.Fatalf("Discover with cancelled ctx took too long: %v", elapsed)
	}
}

// TestAddMappingLive requires a live UPnP router on the LAN; skipped by
// default.
func TestAddMappingLive(t *testing.T) {
	t.Skip("requires live UPnP router")
}

// TestRemoveMappingLive requires a live UPnP router on the LAN; skipped by
// default.
func TestRemoveMappingLive(t *testing.T) {
	t.Skip("requires live UPnP router")
}

// TestExternalIPLive requires a live UPnP router on the LAN; skipped by
// default.
func TestExternalIPLive(t *testing.T) {
	t.Skip("requires live UPnP router")
}
