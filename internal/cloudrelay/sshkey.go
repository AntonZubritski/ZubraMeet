package cloudrelay

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/crypto/ssh"
)

// sshKeyFileName is the unencrypted private key for relay debug access.
// We store the OpenSSH-format private key (PEM) so it can be used directly
// with `ssh -i`. The matching public key is stored alongside as `.pub` and
// uploaded to the cloud provider's project.
const (
	sshKeyFileName    = "ssh_relay_ed25519"
	sshKeyPubFileName = "ssh_relay_ed25519.pub"
)

// ensureSSHKey loads or generates the relay SSH keypair. The keypair lives
// in stateDir and is reused across runs so that re-provisioned relays keep
// the same authorised_keys entry.
//
// Returns the OpenSSH-format public key (e.g. "ssh-ed25519 AAAA... zubrameet")
// suitable for handing to a cloud provider.
func ensureSSHKey(stateDir string) (publicKey string, err error) {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return "", fmt.Errorf("cloudrelay: mkdir %s: %w", stateDir, err)
	}
	pubPath := filepath.Join(stateDir, sshKeyPubFileName)
	keyPath := filepath.Join(stateDir, sshKeyFileName)

	// Reuse if both files exist and are non-empty.
	if data, err := os.ReadFile(pubPath); err == nil && len(data) > 0 {
		if _, statErr := os.Stat(keyPath); statErr == nil {
			return string(data), nil
		}
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", fmt.Errorf("cloudrelay: generate ed25519 key: %w", err)
	}

	// Marshal private key in OpenSSH format (the only format that supports
	// ed25519 in stdlib without third-party encoders).
	pemBlock, err := ssh.MarshalPrivateKey(priv, "zubrameet relay key")
	if err != nil {
		return "", fmt.Errorf("cloudrelay: marshal private key: %w", err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(pemBlock), 0o600); err != nil {
		return "", fmt.Errorf("cloudrelay: write private key: %w", err)
	}

	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return "", fmt.Errorf("cloudrelay: build ssh public key: %w", err)
	}
	authLine := string(ssh.MarshalAuthorizedKey(sshPub))
	// MarshalAuthorizedKey appends a trailing newline; trim it for clean
	// concatenation when we add a comment suffix.
	for len(authLine) > 0 && (authLine[len(authLine)-1] == '\n' || authLine[len(authLine)-1] == '\r') {
		authLine = authLine[:len(authLine)-1]
	}
	authLine += " zubrameet-relay\n"

	if err := os.WriteFile(pubPath, []byte(authLine), 0o644); err != nil {
		return "", fmt.Errorf("cloudrelay: write public key: %w", err)
	}
	return authLine, nil
}

// parsedAuthorizedKey carries fingerprints derived from an authorized_keys
// line. Used to look up / name keys at the Hetzner project level.
type parsedAuthorizedKey struct {
	// fingerprint is the standard MD5-colon SHA fingerprint expected by
	// Hetzner's SSHKey.GetByFingerprint (e.g. "aa:bb:cc:..."). Hetzner
	// stores MD5 fingerprints internally, so that's what we compute.
	fingerprint string
	// shortFingerprint is a short URL-safe identifier suitable for use in
	// resource names.
	shortFingerprint string
}

// parseAuthorizedKeyPrefix extracts the public key from an authorized_keys
// line and computes both a Hetzner-compatible fingerprint and a short
// resource-name-friendly identifier.
//
// Returns three additional values for symmetry with ssh.ParseAuthorizedKey
// (comment, options, rest) which we discard, plus the parsed metadata and
// error. The unused returns keep the call site readable when future callers
// want them.
func parseAuthorizedKeyPrefix(line string) (parsedAuthorizedKey, string, []string, string, error) {
	pub, comment, options, rest, err := ssh.ParseAuthorizedKey([]byte(line))
	if err != nil {
		return parsedAuthorizedKey{}, "", nil, "", fmt.Errorf("parse authorized key: %w", err)
	}
	if pub == nil {
		return parsedAuthorizedKey{}, "", nil, "", errors.New("nil public key")
	}
	fp := ssh.FingerprintLegacyMD5(pub) // "aa:bb:cc:..."
	// For naming we want something filename-safe. SHA-256 of the wire
	// format gives a stable short id without colons.
	sum := sha256.Sum256(pub.Marshal())
	short := base64.RawURLEncoding.EncodeToString(sum[:6])
	return parsedAuthorizedKey{
		fingerprint:      fp,
		shortFingerprint: short,
	}, comment, options, string(rest), nil
}
