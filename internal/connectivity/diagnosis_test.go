package connectivity

import (
	"net"
	"testing"
)

func TestIsPrivateOrCGNAT(t *testing.T) {
	tests := []struct {
		name string
		ip   string
		want bool
	}{
		// RFC1918.
		{"10.0.0.1", "10.0.0.1", true},
		{"192.168.1.1", "192.168.1.1", true},
		{"172.16.0.1", "172.16.0.1", true},
		{"172.31.255.255", "172.31.255.255", true},
		{"172.15.0.1 (out of RFC1918)", "172.15.0.1", false},
		{"172.32.0.1 (out of RFC1918)", "172.32.0.1", false},

		// CGNAT (100.64.0.0/10).
		{"100.64.0.1 CGNAT low", "100.64.0.1", true},
		{"100.127.255.255 CGNAT high", "100.127.255.255", true},
		{"100.100.5.5 CGNAT mid", "100.100.5.5", true},

		// Граница CGNAT.
		{"100.63.0.0 below CGNAT", "100.63.0.0", false},
		{"100.128.0.0 above CGNAT", "100.128.0.0", false},
		{"100.63.255.255 just below", "100.63.255.255", false},

		// Public.
		{"public 8.8.8.8", "8.8.8.8", false},
		{"public 1.1.1.1", "1.1.1.1", false},
		{"public 203.0.113.5", "203.0.113.5", false},

		// Special.
		{"loopback", "127.0.0.1", false},
		{"link-local", "169.254.1.1", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ip := net.ParseIP(tt.ip)
			if ip == nil {
				t.Fatalf("ParseIP(%q) returned nil", tt.ip)
			}
			got := IsPrivateOrCGNAT(ip)
			if got != tt.want {
				t.Errorf("IsPrivateOrCGNAT(%q) = %v, want %v", tt.ip, got, tt.want)
			}
		})
	}

	// Не-IPv4 / nil → false.
	if IsPrivateOrCGNAT(nil) {
		t.Errorf("IsPrivateOrCGNAT(nil) = true, want false")
	}
	if IsPrivateOrCGNAT(net.ParseIP("fe80::1")) {
		t.Errorf("IsPrivateOrCGNAT(fe80::1) = true, want false")
	}
	if IsPrivateOrCGNAT(net.ParseIP("2001:db8::1")) {
		t.Errorf("IsPrivateOrCGNAT(2001:db8::1) = true, want false")
	}
}

// hasReason — helper для проверки наличия конкретной Reason в slice.
func hasReason(reasons []Reason, want Reason) bool {
	for _, r := range reasons {
		if r == want {
			return true
		}
	}
	return false
}

func TestDiagnose(t *testing.T) {
	t.Run("public IPv4 from UPnP → StatusOK", func(t *testing.T) {
		d := Diagnose("8.8.8.8")
		if d.Status != StatusOK {
			t.Errorf("Status = %q, want %q", d.Status, StatusOK)
		}
		if d.PublicIPv4 != "8.8.8.8" {
			t.Errorf("PublicIPv4 = %q, want 8.8.8.8", d.PublicIPv4)
		}
		if d.BehindCGNAT {
			t.Errorf("BehindCGNAT = true, want false for public IP")
		}
		if !d.UPnPWorked {
			t.Errorf("UPnPWorked = false, want true")
		}
		if hasReason(d.Reasons, ReasonCGNATDetected) {
			t.Errorf("Reasons must not contain ReasonCGNATDetected for public IP: %v", d.Reasons)
		}
		if hasReason(d.Reasons, ReasonNoUPnP) {
			t.Errorf("Reasons must not contain ReasonNoUPnP when UPnP worked: %v", d.Reasons)
		}
	})

	t.Run("private IPv4 from UPnP → StatusBehindCGNAT", func(t *testing.T) {
		d := Diagnose("10.31.218.232")
		if d.Status != StatusBehindCGNAT {
			t.Errorf("Status = %q, want %q", d.Status, StatusBehindCGNAT)
		}
		if d.PublicIPv4 != "" {
			t.Errorf("PublicIPv4 = %q, want empty (private IP)", d.PublicIPv4)
		}
		if !d.BehindCGNAT {
			t.Errorf("BehindCGNAT = false, want true")
		}
		if !d.UPnPWorked {
			t.Errorf("UPnPWorked = false, want true")
		}
		if !hasReason(d.Reasons, ReasonCGNATDetected) {
			t.Errorf("Reasons must contain ReasonCGNATDetected: %v", d.Reasons)
		}
		if !hasReason(d.Reasons, ReasonUPnPGotPrivate) {
			t.Errorf("Reasons must contain ReasonUPnPGotPrivate: %v", d.Reasons)
		}
	})

	t.Run("CGNAT IPv4 from UPnP → StatusBehindCGNAT", func(t *testing.T) {
		d := Diagnose("100.64.5.5")
		if d.Status != StatusBehindCGNAT {
			t.Errorf("Status = %q, want %q", d.Status, StatusBehindCGNAT)
		}
		if d.PublicIPv4 != "" {
			t.Errorf("PublicIPv4 = %q, want empty (CGNAT)", d.PublicIPv4)
		}
		if !d.BehindCGNAT {
			t.Errorf("BehindCGNAT = false, want true for CGNAT range")
		}
		if !hasReason(d.Reasons, ReasonCGNATDetected) {
			t.Errorf("Reasons must contain ReasonCGNATDetected for CGNAT: %v", d.Reasons)
		}
	})

	t.Run("upnp not working → reason NoUPnP", func(t *testing.T) {
		d := Diagnose("")
		if d.UPnPWorked {
			t.Errorf("UPnPWorked = true, want false")
		}
		if d.PublicIPv4 != "" {
			t.Errorf("PublicIPv4 = %q, want empty", d.PublicIPv4)
		}
		if d.BehindCGNAT {
			t.Errorf("BehindCGNAT = true, want false")
		}
		if !hasReason(d.Reasons, ReasonNoUPnP) {
			t.Errorf("Reasons must contain ReasonNoUPnP: %v", d.Reasons)
		}
		// Status зависит от наличия IPv6 на машине: если нет IPv6 →
		// StatusLANOnly; если есть → StatusOK. Не пиним конкретное значение,
		// но оно должно быть одним из этих двух.
		if d.Status != StatusLANOnly && d.Status != StatusOK {
			t.Errorf("Status = %q, want lan-only or ok", d.Status)
		}
	})

	t.Run("public IPv4 with no IPv6 → reason NoIPv6 if applicable", func(t *testing.T) {
		// IPv6 на машине может быть, может не быть; проверяем только
		// инвариант: если PublicIPv6 == "", то ReasonNoIPv6 присутствует.
		d := Diagnose("8.8.8.8")
		if d.PublicIPv6 == "" && !hasReason(d.Reasons, ReasonNoIPv6) {
			t.Errorf("PublicIPv6 пустой, но ReasonNoIPv6 не выставлен: %v", d.Reasons)
		}
		if d.PublicIPv6 != "" && hasReason(d.Reasons, ReasonNoIPv6) {
			t.Errorf("PublicIPv6 непустой, но ReasonNoIPv6 присутствует: %v", d.Reasons)
		}
	})
}

func TestPublicIPv6(t *testing.T) {
	t.Skip("depends on host network — skipped to keep tests deterministic in CI sandboxes")
	// Smoke-логика, оставлено для возможного локального запуска:
	v6, err := PublicIPv6()
	if err != nil {
		t.Fatalf("PublicIPv6: %v", err)
	}
	if v6 == "" {
		t.Logf("no global IPv6 found on this host (это допустимо)")
		return
	}
	ip := net.ParseIP(v6)
	if ip == nil {
		t.Errorf("returned non-parseable IPv6 %q", v6)
	}
	if ip.To4() != nil {
		t.Errorf("returned IPv4 %q from PublicIPv6", v6)
	}
}
