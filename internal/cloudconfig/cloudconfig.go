// Package cloudconfig — persisted-конфиг cloud-провайдера для cloudrelay.
//
// Хранит API-токены и настройки провайдера в ~/.zubrameet/cloud.json с
// permission 0600. AT-REST шифрования нет (это локальный файл на машине
// пользователя; угроза модели — не злоумышленник-с-FS-доступом, а случайная
// синхронизация в облако/git).
//
// Использование:
//
//	cfg, err := cloudconfig.Load()
//	if err != nil { ... }
//	cfg.Provider = "hetzner"
//	cfg.APIToken = "abcdef..."
//	cfg.Region = "fsn1"
//	cfg.Enabled = true
//	if err := cloudconfig.Save(cfg); err != nil { ... }
//
// Контракт:
//   - Load возвращает (*Config{}, nil) если файла нет (НЕ ошибку).
//   - Save создаёт ~/.zubrameet/ если её нет (perm 0700) и пишет 0600.
//   - Path может вернуть ошибку, если os.UserHomeDir недоступна (редкость).
package cloudconfig

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Config — содержимое ~/.zubrameet/cloud.json.
type Config struct {
	Provider string `json:"provider"` // "hetzner" / ""
	APIToken string `json:"apiToken"` // plain-text, perm-protected
	Region   string `json:"region"`   // напр. "fsn1"
	Enabled  bool   `json:"enabled"`  // true → можно стартовать relay
}

// dirName — имя директории внутри $HOME для всех persisted-конфигов ZubraMeet.
const dirName = ".zubrameet"

// fileName — имя файла с cloud-настройками.
const fileName = "cloud.json"

// Path возвращает абсолютный путь к ~/.zubrameet/cloud.json.
//
// Ошибка только при невозможности определить домашнюю директорию.
func Path() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cloudconfig: user home dir: %w", err)
	}
	return filepath.Join(home, dirName, fileName), nil
}

// Load читает config с диска. Если файла нет — возвращает пустой Config и nil
// (это норм: первый запуск, ничего не настроено).
//
// Ошибки декодирования JSON или I/O возвращаются как есть.
func Load() (*Config, error) {
	p, err := Path()
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &Config{}, nil
		}
		return nil, fmt.Errorf("cloudconfig: read %s: %w", p, err)
	}

	var cfg Config
	if len(data) == 0 {
		return &cfg, nil
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("cloudconfig: parse %s: %w", p, err)
	}
	return &cfg, nil
}

// Save пишет cfg в ~/.zubrameet/cloud.json с perm 0600. Создаёт директорию
// при необходимости (perm 0700).
//
// Запись atomic-стилем: пишем во временный файл, fsync, rename. Это защищает
// от частично записанного JSON при крэше процесса.
func Save(cfg *Config) error {
	if cfg == nil {
		return errors.New("cloudconfig: nil config")
	}
	p, err := Path()
	if err != nil {
		return err
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("cloudconfig: mkdir %s: %w", dir, err)
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("cloudconfig: marshal: %w", err)
	}

	tmp, err := os.CreateTemp(dir, "cloud-*.json.tmp")
	if err != nil {
		return fmt.Errorf("cloudconfig: tempfile: %w", err)
	}
	tmpPath := tmp.Name()
	// Если что-то пойдёт не так — почистить за собой.
	cleanup := func() { _ = os.Remove(tmpPath) }

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("cloudconfig: write temp: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("cloudconfig: chmod temp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("cloudconfig: fsync temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("cloudconfig: close temp: %w", err)
	}
	if err := os.Rename(tmpPath, p); err != nil {
		cleanup()
		return fmt.Errorf("cloudconfig: rename %s → %s: %w", tmpPath, p, err)
	}
	return nil
}
