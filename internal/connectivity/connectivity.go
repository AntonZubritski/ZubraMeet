// Package connectivity discovers the URLs at which the local ZubraMeet
// instance is reachable: localhost (host-only), LAN (RFC1918 private IPs),
// and the public Internet (when a public IP is known).
package connectivity

import (
	"context"
	"fmt"
	"net"
)

// Kind is the type of an endpoint.
type Kind string

const (
	// KindLocal means localhost/127.0.0.1 — only the host can reach it.
	KindLocal Kind = "local"
	// KindLAN means an RFC1918 private subnet — guests on the same network.
	KindLAN Kind = "lan"
	// KindInternet means a public IP — guests from the Internet.
	KindInternet Kind = "internet"
)

// Endpoint describes one reachable address for the server.
type Endpoint struct {
	Kind   Kind   `json:"kind"`
	Host   string `json:"host"`   // "localhost", "192.168.1.42", "203.0.113.5"
	Port   uint16 `json:"port"`   // e.g. 7777 for http, 7443 for https
	Scheme string `json:"scheme"` // "http" or "https"
	URL    string `json:"url"`    // full URL: "https://192.168.1.42:7443"
}

// Discover returns all endpoints by which the server can be reached.
//
// httpPort is the HTTP server port (used for the localhost endpoint).
// httpsPort is the HTTPS server port (used for LAN and Internet endpoints).
// publicIP is the externally reachable IP (e.g. discovered via UPnP); when
// empty the Internet endpoint is omitted.
//
// Order: Local, then LAN endpoints, then Internet (if any).
func Discover(ctx context.Context, httpPort, httpsPort uint16, publicIP string) ([]Endpoint, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	endpoints := make([]Endpoint, 0, 4)

	// 1. Local — always present.
	endpoints = append(endpoints, Endpoint{
		Kind:   KindLocal,
		Host:   "localhost",
		Port:   httpPort,
		Scheme: "http",
		URL:    fmt.Sprintf("http://localhost:%d", httpPort),
	})

	// 2. LAN — for every private IPv4 found on local interfaces.
	ips, err := LocalIPs()
	if err != nil {
		return nil, fmt.Errorf("connectivity: enumerate local IPs: %w", err)
	}
	for _, ip := range ips {
		endpoints = append(endpoints, Endpoint{
			Kind:   KindLAN,
			Host:   ip,
			Port:   httpsPort,
			Scheme: "https",
			URL:    fmt.Sprintf("https://%s:%d", ip, httpsPort),
		})
	}

	// 3. Internet — only if we know our public IP.
	if publicIP != "" {
		endpoints = append(endpoints, Endpoint{
			Kind:   KindInternet,
			Host:   publicIP,
			Port:   httpsPort,
			Scheme: "https",
			URL:    fmt.Sprintf("https://%s:%d", publicIP, httpsPort),
		})
	}

	return endpoints, nil
}

// LocalIPs returns all private (RFC1918) IPv4 addresses bound to up,
// non-loopback interfaces on the local host. The result is deduplicated.
func LocalIPs() ([]string, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, fmt.Errorf("net.Interfaces: %w", err)
	}

	seen := make(map[string]struct{})
	out := make([]string, 0, 4)

	for _, iface := range ifaces {
		// Skip loopback and down interfaces.
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if iface.Flags&net.FlagUp == 0 {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			// One bad interface should not abort enumeration.
			continue
		}

		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			default:
				continue
			}
			if ip == nil {
				continue
			}
			ip4 := ip.To4()
			if ip4 == nil {
				continue
			}
			if ip4.IsLoopback() || ip4.IsLinkLocalUnicast() || ip4.IsMulticast() {
				continue
			}
			if !isPrivateIPv4(ip4) {
				continue
			}
			s := ip4.String()
			if _, ok := seen[s]; ok {
				continue
			}
			seen[s] = struct{}{}
			out = append(out, s)
		}
	}

	return out, nil
}

// isPrivateIPv4 reports whether ip is in one of the RFC1918 ranges:
// 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16. Non-IPv4 inputs return false.
func isPrivateIPv4(ip net.IP) bool {
	if ip == nil {
		return false
	}
	ip4 := ip.To4()
	if ip4 == nil {
		return false
	}
	switch {
	case ip4[0] == 10:
		return true
	case ip4[0] == 172 && ip4[1] >= 16 && ip4[1] <= 31:
		return true
	case ip4[0] == 192 && ip4[1] == 168:
		return true
	}
	return false
}
