// Package config — keychain.go: безопасное хранение Postgres password в OS
// keychain (v2.6.0+).
//
// На каждой платформе используется родной secure store:
//   - macOS:   Security.framework Keychain
//   - Windows: DPAPI (Credential Manager)
//   - Linux:   libsecret / GNOME Keyring
//
// Если keychain недоступен (CI/headless Linux без libsecret) → fallback
// на переданный fallbackPwd (env/CLI flag). Документировано в CLAUDE.md.
//
// Эффект: password не лежит в plain text в config-файле. Только current
// OS-user может прочитать значение через keychain API. Прямой psql-коннект
// без знания password → no-go.
package config

import (
	"crypto/rand"
	"encoding/hex"

	"github.com/rs/zerolog/log"
	"github.com/zalando/go-keyring"
)

const (
	keychainService = "restos-v4"
	keychainAccount = "postgres-password"
)

// ResolvePGPassword возвращает (password, source, err).
//
// Logic:
//  1. Пытаемся read из keychain. Если найден → используем.
//  2. Если NotFound → генерируем 32 hex-chars (128 бит энтропии), пишем в
//     keychain, возвращаем.
//  3. Если keychain unavailable (libsecret missing на Linux, etc) →
//     fallback на fallbackPwd, возвращаем error (caller логирует).
//
// source ∈ {"keychain", "keychain-new", "fallback"}.
func ResolvePGPassword(fallbackPwd string) (string, string, error) {
	// Try read.
	pwd, err := keyring.Get(keychainService, keychainAccount)
	if err == nil && pwd != "" {
		return pwd, "keychain", nil
	}
	if err != nil && err != keyring.ErrNotFound {
		// Keychain недоступен. Возвращаем fallback + error.
		return fallbackPwd, "fallback", err
	}
	// ErrNotFound → генерируем новый и пишем.
	newPwd, genErr := generateRandomPassword(32)
	if genErr != nil {
		return fallbackPwd, "fallback", genErr
	}
	if writeErr := keyring.Set(keychainService, keychainAccount, newPwd); writeErr != nil {
		log.Warn().Err(writeErr).Msg("keychain: failed to write generated password")
		return fallbackPwd, "fallback", writeErr
	}
	return newPwd, "keychain-new", nil
}

// ResetPGPassword удаляет password из keychain. Использовать только в
// dev-tooling (например при ресете БД). НЕ вызывается из main.
func ResetPGPassword() error {
	return keyring.Delete(keychainService, keychainAccount)
}

// generateRandomPassword — N hex-chars из crypto/rand.
func generateRandomPassword(n int) (string, error) {
	buf := make([]byte, n/2)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
