package cloudrelay

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// stateFileName is the file inside ManagerConfig.StateDir that stores the
// active relay's metadata across host process restarts.
const stateFileName = "relays.json"

// stateFile is the wire format of relays.json. Wrapping the relay in a
// struct (rather than serialising *Relay directly) leaves room to add
// schema versioning or multiple relays later without breaking old files.
type stateFile struct {
	Active *Relay `json:"active,omitempty"`
}

// saveState atomically writes the state file. Writing to a temp file and
// renaming guarantees that a partial write does not produce a half-decoded
// JSON the next time we start up.
func saveState(dir string, relay *Relay) error {
	if dir == "" {
		return errors.New("cloudrelay: empty state dir")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("cloudrelay: mkdir %s: %w", dir, err)
	}
	path := filepath.Join(dir, stateFileName)
	tmp := path + ".tmp"

	payload := stateFile{Active: relay}
	body, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return fmt.Errorf("cloudrelay: marshal state: %w", err)
	}
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return fmt.Errorf("cloudrelay: write state tmp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		// Best-effort cleanup on rename failure.
		_ = os.Remove(tmp)
		return fmt.Errorf("cloudrelay: rename state: %w", err)
	}
	return nil
}

// loadState reads the state file. A missing file is not an error and yields
// (nil, nil). A corrupt file is treated as missing — we do not want a single
// bad write to wedge the user; the caller will simply re-provision.
func loadState(dir string) (*Relay, error) {
	if dir == "" {
		return nil, errors.New("cloudrelay: empty state dir")
	}
	path := filepath.Join(dir, stateFileName)
	body, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("cloudrelay: read state: %w", err)
	}
	var sf stateFile
	if err := json.Unmarshal(body, &sf); err != nil {
		// Corrupt file — wipe so future writes succeed cleanly.
		_ = os.Remove(path)
		return nil, nil
	}
	return sf.Active, nil
}

// clearState removes the state file. Idempotent: a missing file is fine.
func clearState(dir string) error {
	if dir == "" {
		return nil
	}
	path := filepath.Join(dir, stateFileName)
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("cloudrelay: remove state: %w", err)
	}
	return nil
}
