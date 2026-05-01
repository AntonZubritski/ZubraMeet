// Package nat provides automatic UPnP IGD port-mapping for ZubraMeet.
//
// It discovers a UPnP-capable router on the LAN and creates TCP port
// forwardings so that internet guests can reach the local server
// (uTorrent-style hole punching).
package nat

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"

	"github.com/huin/goupnp/dcps/internetgateway1"
	"github.com/huin/goupnp/dcps/internetgateway2"
)

// Mapping describes an active port-mapping on the router.
type Mapping struct {
	InternalPort uint16
	ExternalPort uint16
	Protocol     string // "TCP" or "UDP"
	Description  string
	ExternalIP   string // public IP discovered via UPnP
	Lease        time.Duration
}

// wanConnection is the minimal subset of WANIPConnection{1,2} that we need.
// Both internetgateway1.WANIPConnection1 and internetgateway2.WANIPConnection1
// satisfy this interface.
type wanConnection interface {
	AddPortMappingCtx(
		ctx context.Context,
		newRemoteHost string,
		newExternalPort uint16,
		newProtocol string,
		newInternalPort uint16,
		newInternalClient string,
		newEnabled bool,
		newPortMappingDescription string,
		newLeaseDuration uint32,
	) error
	DeletePortMappingCtx(
		ctx context.Context,
		newRemoteHost string,
		newExternalPort uint16,
		newProtocol string,
	) error
	GetExternalIPAddressCtx(ctx context.Context) (string, error)
}

// Client is a UPnP client. Hold the reference and call Close on shutdown.
type Client struct {
	conn       wanConnection
	internalIP string
}

// Discover searches the LAN for a UPnP IGD router. A timeout around 5s is
// recommended (via ctx). Returns an error if no router with WANIPConnection
// support was found.
//
// IGDv2 is tried first, with fallback to IGDv1.
func Discover(ctx context.Context) (*Client, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("nat: discover: %w", err)
	}

	// Try IGDv2 first.
	v2Clients, _, v2Err := internetgateway2.NewWANIPConnection1ClientsCtx(ctx)
	if v2Err == nil && len(v2Clients) > 0 {
		ip, err := localInternalIP()
		if err != nil {
			return nil, fmt.Errorf("nat: discover: detect internal ip: %w", err)
		}
		return &Client{conn: v2Clients[0], internalIP: ip}, nil
	}

	// Fallback to IGDv1.
	v1Clients, _, v1Err := internetgateway1.NewWANIPConnection1ClientsCtx(ctx)
	if v1Err == nil && len(v1Clients) > 0 {
		ip, err := localInternalIP()
		if err != nil {
			return nil, fmt.Errorf("nat: discover: detect internal ip: %w", err)
		}
		return &Client{conn: v1Clients[0], internalIP: ip}, nil
	}

	// Surface the most informative error available.
	switch {
	case v2Err != nil && v1Err != nil:
		return nil, fmt.Errorf("nat: discover: igdv2: %v; igdv1: %w", v2Err, v1Err)
	case v2Err != nil:
		return nil, fmt.Errorf("nat: discover: igdv2: %w", v2Err)
	case v1Err != nil:
		return nil, fmt.Errorf("nat: discover: igdv1: %w", v1Err)
	default:
		return nil, errors.New("nat: discover: no UPnP IGD router found on LAN")
	}
}

// AddMapping creates a TCP port-forwarding internalPort -> externalPort on the
// router. description is shown in the router admin UI. lease is the mapping
// lifetime (0 = unlimited if the router supports it; otherwise routers
// typically clamp to ~7200s).
//
// Returns the created Mapping, including the actual external port (the router
// may pick another if the requested one is busy) and the public IP.
func (c *Client) AddMapping(ctx context.Context, internalPort uint16, externalPort uint16, description string, lease time.Duration) (*Mapping, error) {
	if c == nil || c.conn == nil {
		return nil, errors.New("nat: add mapping: client is closed")
	}
	if internalPort == 0 || externalPort == 0 {
		return nil, errors.New("nat: add mapping: ports must be non-zero")
	}

	leaseSec := uint32(lease / time.Second)
	const protocol = "TCP"

	if err := c.conn.AddPortMappingCtx(
		ctx,
		"", // remote host: empty == any
		externalPort,
		protocol,
		internalPort,
		c.internalIP,
		true, // enabled
		description,
		leaseSec,
	); err != nil {
		return nil, fmt.Errorf("nat: add mapping: %w", err)
	}

	externalIP, err := c.conn.GetExternalIPAddressCtx(ctx)
	if err != nil {
		// The mapping itself succeeded; surface the external-IP error but
		// still return what we know would be useful.
		return nil, fmt.Errorf("nat: add mapping: get external ip: %w", err)
	}

	return &Mapping{
		InternalPort: internalPort,
		ExternalPort: externalPort,
		Protocol:     protocol,
		Description:  description,
		ExternalIP:   externalIP,
		Lease:        time.Duration(leaseSec) * time.Second,
	}, nil
}

// RemoveMapping deletes a previously created mapping. Idempotent: missing
// mappings are not treated as an error by most routers, but if a router does
// surface "no such entry" we still return that error wrapped.
func (c *Client) RemoveMapping(ctx context.Context, externalPort uint16, protocol string) error {
	if c == nil || c.conn == nil {
		return errors.New("nat: remove mapping: client is closed")
	}
	if protocol == "" {
		protocol = "TCP"
	}
	if err := c.conn.DeletePortMappingCtx(ctx, "", externalPort, protocol); err != nil {
		return fmt.Errorf("nat: remove mapping: %w", err)
	}
	return nil
}

// ExternalIP returns the public IP as reported by the router.
func (c *Client) ExternalIP(ctx context.Context) (string, error) {
	if c == nil || c.conn == nil {
		return "", errors.New("nat: external ip: client is closed")
	}
	ip, err := c.conn.GetExternalIPAddressCtx(ctx)
	if err != nil {
		return "", fmt.Errorf("nat: external ip: %w", err)
	}
	return ip, nil
}

// Close releases resources. It does NOT remove port mappings; use
// RemoveMapping for that.
func (c *Client) Close() error {
	if c == nil {
		return nil
	}
	c.conn = nil
	return nil
}

// localInternalIP returns the source IP that the OS would use to reach the
// public internet (i.e. the address the router sees us as). We do this by
// opening a UDP socket to a public IP -- no packet is actually sent because
// UDP is connectionless and Dial only sets up the socket's local endpoint.
func localInternalIP() (string, error) {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "", fmt.Errorf("nat: local ip: dial: %w", err)
	}
	defer conn.Close()

	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || addr == nil {
		return "", errors.New("nat: local ip: unexpected local addr type")
	}
	return addr.IP.String(), nil
}
