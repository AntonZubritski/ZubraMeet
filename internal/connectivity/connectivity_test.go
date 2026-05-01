package connectivity

import (
	"context"
	"net"
	"testing"
)

func TestDiscoverShape(t *testing.T) {
	ctx := context.Background()
	eps, err := Discover(ctx, 7777, 7443, "1.2.3.4")
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(eps) < 2 {
		t.Fatalf("expected at least Local + Internet endpoints, got %d: %+v", len(eps), eps)
	}

	// First must be Local.
	first := eps[0]
	if first.Kind != KindLocal {
		t.Errorf("first endpoint kind = %q, want %q", first.Kind, KindLocal)
	}
	if first.Host != "localhost" {
		t.Errorf("local host = %q, want localhost", first.Host)
	}
	if first.Port != 7777 {
		t.Errorf("local port = %d, want 7777", first.Port)
	}
	if first.Scheme != "http" {
		t.Errorf("local scheme = %q, want http", first.Scheme)
	}
	if first.URL != "http://localhost:7777" {
		t.Errorf("local URL = %q, want http://localhost:7777", first.URL)
	}

	// Last must be the Internet endpoint we asked for.
	last := eps[len(eps)-1]
	if last.Kind != KindInternet {
		t.Fatalf("last endpoint kind = %q, want %q (eps=%+v)", last.Kind, KindInternet, eps)
	}
	if last.Host != "1.2.3.4" {
		t.Errorf("internet host = %q, want 1.2.3.4", last.Host)
	}
	if last.Port != 7443 {
		t.Errorf("internet port = %d, want 7443", last.Port)
	}
	if last.Scheme != "https" {
		t.Errorf("internet scheme = %q, want https", last.Scheme)
	}
	if last.URL != "https://1.2.3.4:7443" {
		t.Errorf("internet URL = %q, want https://1.2.3.4:7443", last.URL)
	}

	// Any middle endpoints must be LAN with https + httpsPort.
	for i := 1; i < len(eps)-1; i++ {
		ep := eps[i]
		if ep.Kind != KindLAN {
			t.Errorf("eps[%d].Kind = %q, want %q", i, ep.Kind, KindLAN)
		}
		if ep.Scheme != "https" {
			t.Errorf("eps[%d].Scheme = %q, want https", i, ep.Scheme)
		}
		if ep.Port != 7443 {
			t.Errorf("eps[%d].Port = %d, want 7443", i, ep.Port)
		}
		if ep.URL == "" || ep.Host == "" {
			t.Errorf("eps[%d] missing URL/Host: %+v", i, ep)
		}
	}
}

func TestDiscoverNoPublic(t *testing.T) {
	ctx := context.Background()
	eps, err := Discover(ctx, 7777, 7443, "")
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(eps) == 0 {
		t.Fatalf("expected at least the Local endpoint")
	}
	for _, ep := range eps {
		if ep.Kind == KindInternet {
			t.Errorf("unexpected Internet endpoint when publicIP is empty: %+v", ep)
		}
	}
	if eps[0].Kind != KindLocal {
		t.Errorf("first endpoint kind = %q, want %q", eps[0].Kind, KindLocal)
	}
}

func TestLocalIPsAreIPv4(t *testing.T) {
	ips, err := LocalIPs()
	if err != nil {
		t.Fatalf("LocalIPs: %v", err)
	}
	// We can't guarantee any IP exists in a CI sandbox, but every returned
	// string must parse as IPv4 and be private.
	for _, s := range ips {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Errorf("LocalIPs returned unparseable %q", s)
			continue
		}
		if ip.To4() == nil {
			t.Errorf("LocalIPs returned non-IPv4 %q", s)
		}
		if !isPrivateIPv4(ip) {
			t.Errorf("LocalIPs returned non-private IP %q", s)
		}
	}

	// Result must be deduplicated.
	seen := make(map[string]struct{})
	for _, s := range ips {
		if _, ok := seen[s]; ok {
			t.Errorf("LocalIPs contains duplicate %q", s)
		}
		seen[s] = struct{}{}
	}
}

func TestRFC1918Filter(t *testing.T) {
	tests := []struct {
		name string
		ip   string
		want bool
	}{
		{"10.0.0.0/8 low", "10.0.0.0", true},
		{"10.0.0.1", "10.0.0.1", true},
		{"10.255.255.255", "10.255.255.255", true},
		{"172.16.0.0", "172.16.0.0", true},
		{"172.16.5.4", "172.16.5.4", true},
		{"172.31.255.255", "172.31.255.255", true},
		{"172.15.0.1 (out of range)", "172.15.0.1", false},
		{"172.32.0.1 (out of range)", "172.32.0.1", false},
		{"192.168.0.1", "192.168.0.1", true},
		{"192.168.1.42", "192.168.1.42", true},
		{"192.168.255.255", "192.168.255.255", true},
		{"192.169.0.1 (out of range)", "192.169.0.1", false},
		{"public 8.8.8.8", "8.8.8.8", false},
		{"public 1.1.1.1", "1.1.1.1", false},
		{"link-local 169.254.1.1", "169.254.1.1", false},
		{"link-local 169.254.169.254", "169.254.169.254", false},
		{"loopback 127.0.0.1", "127.0.0.1", false},
		{"zero", "0.0.0.0", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ip := net.ParseIP(tt.ip)
			if ip == nil {
				t.Fatalf("ParseIP(%q) returned nil", tt.ip)
			}
			got := isPrivateIPv4(ip)
			if got != tt.want {
				t.Errorf("isPrivateIPv4(%q) = %v, want %v", tt.ip, got, tt.want)
			}
		})
	}

	// Non-IPv4 input must be false.
	if isPrivateIPv4(net.ParseIP("fe80::1")) {
		t.Errorf("isPrivateIPv4(IPv6) = true, want false")
	}
	if isPrivateIPv4(nil) {
		t.Errorf("isPrivateIPv4(nil) = true, want false")
	}
}
