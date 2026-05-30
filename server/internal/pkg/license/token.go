// Package license — Ed25519-подписанный лицензионный токен для оффлайн-валидации.
//
// Формат: base64url(payloadJSON) + "." + base64url(signature).
//
// Payload:
//
//	{
//	  "v":  1,                          // версия формата
//	  "rid": "<restaurant_uuid>",
//	  "iat": "<RFC3339>",               // когда выписан
//	  "exp": "<RFC3339>",               // когда истекает
//	  "ed":  "<edition>"                // start | business | pro
//	}
//
// Private key — у издателя лицензий (Owner Dashboard / SaaS-billing).
// Public key — захардкожен в restos-server бинаре или передаётся через
// --license-public-key. На машине кассира хранится только public key, поэтому
// валидировать токен можно полностью оффлайн.
//
// Это намеренно не JWT: JWT-libs притаскивают много мусора, токен мы сами
// контролируем end-to-end.
package license

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Edition — тариф (см. CLAUDE.md).
type Edition string

const (
	EditionStart    Edition = "start"
	EditionBusiness Edition = "business"
	EditionPro      Edition = "pro"
)

// Payload — содержимое токена.
//
// MachineID — fingerprint железа (hash MAC+disk+CPU, см. MachineID()).
// Если задан в токене, при activate бэкенд сверяет с текущим железом —
// один токен можно установить только на машину для которой он выписан.
// Empty → токен machine-agnostic (legacy / тестирование).
type Payload struct {
	Version      int       `json:"v"`
	RestaurantID string    `json:"rid"`
	IssuedAt     time.Time `json:"iat"`
	ExpiresAt    time.Time `json:"exp"`
	Edition      Edition   `json:"ed,omitempty"`
	MachineID    string    `json:"mid,omitempty"`
	// AccountID — владелец сети ресторанов (Phase 1 multi-branch).
	// Empty → одиночный ресторан (текущая модель). Заполнен →
	// этот ресторан принадлежит сети с консолидированной отчётностью
	// (будущий Owner Dashboard читает по account_id).
	AccountID string `json:"aid,omitempty"`
}

// CurrentVersion — версия формата. Изменение → отдельный verifier.
const CurrentVersion = 1

// Errors.
var (
	ErrBadFormat          = errors.New("license: bad token format")
	ErrBadSignature       = errors.New("license: invalid signature")
	ErrBadVersion         = errors.New("license: unsupported version")
	ErrExpired            = errors.New("license: expired")
	ErrRestaurantMismatch = errors.New("license: restaurant_id mismatch")
)

// Sign выпускает токен. Используется издателем (CLI / Owner backoffice).
func Sign(priv ed25519.PrivateKey, p Payload) (string, error) {
	if p.Version == 0 {
		p.Version = CurrentVersion
	}
	body, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	bodyEnc := base64.RawURLEncoding.EncodeToString(body)
	sig := ed25519.Sign(priv, []byte(bodyEnc))
	sigEnc := base64.RawURLEncoding.EncodeToString(sig)
	return bodyEnc + "." + sigEnc, nil
}

// Parse валидирует подпись и возвращает Payload.
// НЕ проверяет expires_at — это делает Validate (отдельно, чтобы вызывающий
// мог получить payload даже у истёкшего токена — например для warning UI).
func Parse(token string, pub ed25519.PublicKey) (*Payload, error) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return nil, ErrBadFormat
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, fmt.Errorf("%w: bad payload base64", ErrBadFormat)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("%w: bad sig base64", ErrBadFormat)
	}
	if !ed25519.Verify(pub, []byte(parts[0]), sig) {
		return nil, ErrBadSignature
	}
	var p Payload
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, fmt.Errorf("%w: bad json", ErrBadFormat)
	}
	if p.Version != CurrentVersion {
		return nil, ErrBadVersion
	}
	return &p, nil
}

// Validate — Parse + проверка expires против сейчас.
func Validate(token string, pub ed25519.PublicKey, now time.Time) (*Payload, error) {
	p, err := Parse(token, pub)
	if err != nil {
		return nil, err
	}
	if now.After(p.ExpiresAt) {
		return p, ErrExpired
	}
	return p, nil
}

// GenerateKeypair создаёт новую пару Ed25519 (для setup'а издателя).
func GenerateKeypair() (pub ed25519.PublicKey, priv ed25519.PrivateKey, err error) {
	pub, priv, err = ed25519.GenerateKey(rand.Reader)
	return
}

// EncodeKey base64-кодирует ключ (для хранения в env / config).
func EncodeKey(key []byte) string { return base64.StdEncoding.EncodeToString(key) }

// DecodePublicKey декодирует ed25519 public-key из base64.
func DecodePublicKey(s string) (ed25519.PublicKey, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("decode pub: %w", err)
	}
	if len(b) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("decode pub: wrong size %d (want %d)", len(b), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(b), nil
}

// DecodePrivateKey декодирует ed25519 private-key из base64.
func DecodePrivateKey(s string) (ed25519.PrivateKey, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("decode priv: %w", err)
	}
	if len(b) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("decode priv: wrong size %d (want %d)", len(b), ed25519.PrivateKeySize)
	}
	return ed25519.PrivateKey(b), nil
}
