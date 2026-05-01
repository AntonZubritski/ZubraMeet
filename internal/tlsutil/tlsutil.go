// Package tlsutil provides a self-signed TLS certificate generator for
// ZubraMeet's HTTPS endpoint (:7443).
//
// The browser requires HTTPS for getUserMedia on non-localhost origins, so
// guests joining over LAN/internet need a TLS-enabled server. The certificate
// is self-signed and persisted to ~/.zubrameet/{cert,key}.pem; guests
// click-through the browser warning once.
package tlsutil

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

const (
	dirName  = ".zubrameet"
	certFile = "cert.pem"
	keyFile  = "key.pem"

	certValidity   = 365 * 24 * time.Hour
	renewThreshold = 30 * 24 * time.Hour
)

// EnsureCert loads or generates a self-signed TLS certificate.
//
// hosts is the list of DNS names and IP addresses for which the cert must be
// valid. If a cached cert exists, has at least 30 days of validity remaining,
// and covers every requested host, it is reused; otherwise a fresh cert is
// generated.
//
// Storage:
//   - Linux/Mac: ~/.zubrameet/cert.pem + key.pem
//   - Windows:   %USERPROFILE%\.zubrameet\cert.pem + key.pem
//
// The certificate uses ECDSA P-256 (faster than RSA), is valid for one year,
// and is not a CA.
func EnsureCert(hosts []string) (*tls.Certificate, error) {
	dir, err := defaultDir()
	if err != nil {
		return nil, err
	}
	return ensureCertIn(dir, hosts)
}

// CertPath returns the directory in which the certificate is stored. Useful
// for logging.
func CertPath() (string, error) {
	return defaultDir()
}

func defaultDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("tlsutil: resolve home dir: %w", err)
	}
	return filepath.Join(home, dirName), nil
}

// ensureCertIn is the testable core of EnsureCert: it operates on an explicit
// directory rather than the user's home directory.
func ensureCertIn(dir string, hosts []string) (*tls.Certificate, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("tlsutil: mkdir %s: %w", dir, err)
	}

	certPath := filepath.Join(dir, certFile)
	keyPath := filepath.Join(dir, keyFile)

	dnsNames, ipAddrs := normalizeHosts(hosts)

	if cert, ok := loadIfValid(certPath, keyPath, dnsNames, ipAddrs, time.Now()); ok {
		return cert, nil
	}

	if err := generate(certPath, keyPath, dnsNames, ipAddrs, time.Now()); err != nil {
		return nil, err
	}

	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, fmt.Errorf("tlsutil: load freshly generated cert: %w", err)
	}
	return &cert, nil
}

// normalizeHosts splits the input into DNS names and IPs and ensures the
// mandatory loopback entries are present.
func normalizeHosts(hosts []string) ([]string, []net.IP) {
	dnsSet := make(map[string]struct{})
	ipSet := make(map[string]net.IP)

	for _, h := range hosts {
		if h == "" {
			continue
		}
		if ip := net.ParseIP(h); ip != nil {
			ipSet[ip.String()] = ip
		} else {
			dnsSet[h] = struct{}{}
		}
	}

	// Mandatory entries.
	dnsSet["localhost"] = struct{}{}
	for _, mand := range []string{"127.0.0.1", "::1"} {
		ip := net.ParseIP(mand)
		ipSet[ip.String()] = ip
	}

	dns := make([]string, 0, len(dnsSet))
	for n := range dnsSet {
		dns = append(dns, n)
	}
	ips := make([]net.IP, 0, len(ipSet))
	for _, ip := range ipSet {
		ips = append(ips, ip)
	}
	return dns, ips
}

// loadIfValid returns the cached cert if it parses, has enough validity left,
// and covers every requested host.
func loadIfValid(certPath, keyPath string, dnsNames []string, ipAddrs []net.IP, now time.Time) (*tls.Certificate, bool) {
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, false
	}
	if len(cert.Certificate) == 0 {
		return nil, false
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return nil, false
	}
	if leaf.NotAfter.Before(now.Add(renewThreshold)) {
		return nil, false
	}
	if !covers(leaf, dnsNames, ipAddrs) {
		return nil, false
	}
	cert.Leaf = leaf
	return &cert, true
}

func covers(leaf *x509.Certificate, dnsNames []string, ipAddrs []net.IP) bool {
	have := make(map[string]struct{}, len(leaf.DNSNames))
	for _, n := range leaf.DNSNames {
		have[n] = struct{}{}
	}
	for _, want := range dnsNames {
		if _, ok := have[want]; !ok {
			return false
		}
	}

	haveIP := make(map[string]struct{}, len(leaf.IPAddresses))
	for _, ip := range leaf.IPAddresses {
		haveIP[ip.String()] = struct{}{}
	}
	for _, want := range ipAddrs {
		if _, ok := haveIP[want.String()]; !ok {
			return false
		}
	}
	return true
}

func generate(certPath, keyPath string, dnsNames []string, ipAddrs []net.IP, now time.Time) error {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("tlsutil: generate key: %w", err)
	}

	serialMax := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialMax)
	if err != nil {
		return fmt.Errorf("tlsutil: generate serial: %w", err)
	}

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   "ZubraMeet self-signed",
			Organization: []string{"ZubraMeet"},
		},
		NotBefore:             now.Add(-1 * time.Minute),
		NotAfter:              now.Add(certValidity),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  false,
		DNSNames:              dnsNames,
		IPAddresses:           ipAddrs,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		return fmt.Errorf("tlsutil: create certificate: %w", err)
	}

	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return fmt.Errorf("tlsutil: marshal private key: %w", err)
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	if certPEM == nil {
		return errors.New("tlsutil: encode cert PEM")
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if keyPEM == nil {
		return errors.New("tlsutil: encode key PEM")
	}

	// cert is world-readable; key must be owner-only.
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		return fmt.Errorf("tlsutil: write cert: %w", err)
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return fmt.Errorf("tlsutil: write key: %w", err)
	}
	return nil
}
