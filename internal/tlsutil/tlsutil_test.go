package tlsutil

import (
	"crypto/x509"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerateAndLoad(t *testing.T) {
	dir := t.TempDir()
	hosts := []string{"localhost", "127.0.0.1", "192.168.1.42"}

	first, err := ensureCertIn(dir, hosts)
	if err != nil {
		t.Fatalf("first ensure: %v", err)
	}
	if first == nil || len(first.Certificate) == 0 {
		t.Fatal("first ensure returned empty cert")
	}

	// Files exist with reasonable perms (perm bits are not enforced on Windows
	// — just check they exist).
	for _, name := range []string{certFile, keyFile} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("expected %s to exist: %v", name, err)
		}
	}

	// Snapshot the cert bytes from the first generation.
	firstBytes := append([]byte(nil), first.Certificate[0]...)

	second, err := ensureCertIn(dir, hosts)
	if err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	if len(second.Certificate) == 0 {
		t.Fatal("second ensure returned empty cert")
	}
	if string(second.Certificate[0]) != string(firstBytes) {
		t.Fatal("expected ensureCertIn to reuse cached certificate, got new one")
	}
}

func TestRegenerateOnHostMismatch(t *testing.T) {
	dir := t.TempDir()

	first, err := ensureCertIn(dir, []string{"localhost", "127.0.0.1"})
	if err != nil {
		t.Fatalf("first ensure: %v", err)
	}
	firstBytes := append([]byte(nil), first.Certificate[0]...)

	second, err := ensureCertIn(dir, []string{"localhost", "127.0.0.1", "10.0.0.5"})
	if err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	if string(second.Certificate[0]) == string(firstBytes) {
		t.Fatal("expected regeneration when a new host is added, got cached cert")
	}

	leaf, err := x509.ParseCertificate(second.Certificate[0])
	if err != nil {
		t.Fatalf("parse leaf: %v", err)
	}
	found := false
	for _, ip := range leaf.IPAddresses {
		if ip.String() == "10.0.0.5" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("regenerated cert is missing the requested 10.0.0.5 IP SAN")
	}
}

func TestMandatoryHostsAlwaysPresent(t *testing.T) {
	dir := t.TempDir()
	cert, err := ensureCertIn(dir, []string{"example.local"})
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	hasDNS := func(want string) bool {
		for _, n := range leaf.DNSNames {
			if n == want {
				return true
			}
		}
		return false
	}
	if !hasDNS("localhost") {
		t.Errorf("missing mandatory DNS SAN localhost; got %v", leaf.DNSNames)
	}
	if !hasDNS("example.local") {
		t.Errorf("missing requested DNS SAN example.local; got %v", leaf.DNSNames)
	}

	hasIP := func(want string) bool {
		for _, ip := range leaf.IPAddresses {
			if ip.String() == want {
				return true
			}
		}
		return false
	}
	if !hasIP("127.0.0.1") {
		t.Errorf("missing mandatory IP SAN 127.0.0.1; got %v", leaf.IPAddresses)
	}
	if !hasIP("::1") {
		t.Errorf("missing mandatory IP SAN ::1; got %v", leaf.IPAddresses)
	}
}

func TestCertProperties(t *testing.T) {
	dir := t.TempDir()
	cert, err := ensureCertIn(dir, []string{"localhost"})
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	if leaf.IsCA {
		t.Error("self-signed leaf should not be a CA")
	}
	if leaf.PublicKeyAlgorithm != x509.ECDSA {
		t.Errorf("expected ECDSA key, got %v", leaf.PublicKeyAlgorithm)
	}
	if leaf.Subject.CommonName != "ZubraMeet self-signed" {
		t.Errorf("unexpected CN: %q", leaf.Subject.CommonName)
	}

	hasServerAuth := false
	for _, eku := range leaf.ExtKeyUsage {
		if eku == x509.ExtKeyUsageServerAuth {
			hasServerAuth = true
			break
		}
	}
	if !hasServerAuth {
		t.Error("expected ExtKeyUsageServerAuth")
	}

	span := leaf.NotAfter.Sub(leaf.NotBefore)
	// ~1 year give-or-take the small NotBefore back-shift.
	if span < 360*24*60*60*1_000_000_000 || span > 370*24*60*60*1_000_000_000 {
		t.Errorf("unexpected validity span: %v", span)
	}
}

func TestPathHasZubraMeet(t *testing.T) {
	p, err := CertPath()
	if err != nil {
		t.Fatalf("CertPath: %v", err)
	}
	if !strings.Contains(p, ".zubrameet") {
		t.Errorf("CertPath %q does not contain .zubrameet", p)
	}
}

func TestCorruptCertTriggersRegeneration(t *testing.T) {
	dir := t.TempDir()
	hosts := []string{"localhost"}

	if _, err := ensureCertIn(dir, hosts); err != nil {
		t.Fatalf("first ensure: %v", err)
	}

	// Corrupt the cert file.
	if err := os.WriteFile(filepath.Join(dir, certFile), []byte("not a pem"), 0o644); err != nil {
		t.Fatalf("corrupt cert: %v", err)
	}

	cert, err := ensureCertIn(dir, hosts)
	if err != nil {
		t.Fatalf("second ensure after corruption: %v", err)
	}
	if cert == nil || len(cert.Certificate) == 0 {
		t.Fatal("expected regenerated cert after corruption")
	}
}
