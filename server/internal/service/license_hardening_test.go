package service

import (
	"testing"
	"time"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/license"
)

// TestClockBackdating — если now() < license_issued_at → hardeningCheck
// возвращает (true, "clock_tampered").
func TestClockBackdating(t *testing.T) {
	pub, priv, err := license.GenerateKeypair()
	if err != nil {
		t.Fatalf("keypair: %v", err)
	}
	issued := time.Date(2026, 6, 5, 12, 0, 0, 0, time.UTC)
	exp := issued.AddDate(0, 0, 30)
	tok, err := license.Sign(priv, license.Payload{
		Version:      license.CurrentVersion,
		RestaurantID: "rest-1",
		IssuedAt:     issued,
		ExpiresAt:    exp,
	})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	r := models.Restaurant{
		ID:               "rest-1",
		LicenseKey:       &tok,
		LicenseIssuedAt:  &issued,
		LicenseExpiresAt: &exp,
	}
	svc := &LicenseService{publicKey: pub, cache: make(map[string]hardeningCacheEntry)}

	// Time before issued — backdate detected.
	yesterday := issued.AddDate(0, 0, -1)
	locked, reason := svc.hardeningCheck(r, yesterday)
	if !locked || reason != BlockReasonClockTampered {
		t.Fatalf("backdate: got locked=%v reason=%q, want true %q", locked, reason, BlockReasonClockTampered)
	}

	// Time at issued+1h — OK.
	now := issued.Add(time.Hour)
	locked, reason = svc.hardeningCheck(r, now)
	if locked {
		t.Fatalf("normal time: got locked=%v reason=%q, want false", locked, reason)
	}
}

// TestDirectDBTamper — если в БД license_expires_at изменён без перевыдачи
// токена → signature re-verify обнаруживает mismatch → tampered_db.
func TestDirectDBTamper(t *testing.T) {
	pub, priv, err := license.GenerateKeypair()
	if err != nil {
		t.Fatalf("keypair: %v", err)
	}
	issued := time.Date(2026, 6, 5, 12, 0, 0, 0, time.UTC)
	exp := issued.AddDate(0, 0, 30)
	tok, _ := license.Sign(priv, license.Payload{
		Version:      license.CurrentVersion,
		RestaurantID: "rest-1",
		IssuedAt:     issued,
		ExpiresAt:    exp,
	})

	// Симулируем UPDATE restaurants SET license_expires_at = '2099-12-31'
	// при этом license_key остался прежним (admin не знает private key).
	tamperedExp := time.Date(2099, 12, 31, 0, 0, 0, 0, time.UTC)
	r := models.Restaurant{
		ID:               "rest-1",
		LicenseKey:       &tok,
		LicenseIssuedAt:  &issued,
		LicenseExpiresAt: &tamperedExp,
	}
	svc := &LicenseService{publicKey: pub, cache: make(map[string]hardeningCacheEntry)}

	now := issued.Add(time.Hour)
	locked, reason := svc.hardeningCheck(r, now)
	if !locked || reason != BlockReasonTamperedDB {
		t.Fatalf("DB tamper: got locked=%v reason=%q, want true %q", locked, reason, BlockReasonTamperedDB)
	}
}

// TestTokenSignatureValid — legit token + правильные колонки → hardening OK.
func TestTokenSignatureValid(t *testing.T) {
	pub, priv, err := license.GenerateKeypair()
	if err != nil {
		t.Fatalf("keypair: %v", err)
	}
	issued := time.Date(2026, 6, 5, 12, 0, 0, 0, time.UTC)
	exp := issued.AddDate(0, 0, 365)
	tok, _ := license.Sign(priv, license.Payload{
		Version:      license.CurrentVersion,
		RestaurantID: "rest-1",
		IssuedAt:     issued,
		ExpiresAt:    exp,
	})
	r := models.Restaurant{
		ID:               "rest-1",
		LicenseKey:       &tok,
		LicenseIssuedAt:  &issued,
		LicenseExpiresAt: &exp,
	}
	svc := &LicenseService{publicKey: pub, cache: make(map[string]hardeningCacheEntry)}
	now := issued.AddDate(0, 0, 30) // 30 дней после выдачи — внутри валидности
	locked, reason := svc.hardeningCheck(r, now)
	if locked {
		t.Fatalf("valid token: got locked=%v reason=%q, want false", locked, reason)
	}
}

// TestSignatureTampered — кто-то изменил токен (несовпадение подписи) →
// tampered_db.
func TestSignatureTampered(t *testing.T) {
	pub, priv, err := license.GenerateKeypair()
	if err != nil {
		t.Fatalf("keypair: %v", err)
	}
	issued := time.Date(2026, 6, 5, 12, 0, 0, 0, time.UTC)
	exp := issued.AddDate(0, 0, 30)
	tok, _ := license.Sign(priv, license.Payload{
		Version:      license.CurrentVersion,
		RestaurantID: "rest-1",
		IssuedAt:     issued,
		ExpiresAt:    exp,
	})
	// Корпачим первый байт подписи (после "."): вальем подпись.
	bad := tok[:len(tok)-2] + "XX"
	r := models.Restaurant{
		ID:               "rest-1",
		LicenseKey:       &bad,
		LicenseIssuedAt:  &issued,
		LicenseExpiresAt: &exp,
	}
	svc := &LicenseService{publicKey: pub, cache: make(map[string]hardeningCacheEntry)}

	locked, reason := svc.hardeningCheck(r, issued.Add(time.Hour))
	if !locked || reason != BlockReasonTamperedDB {
		t.Fatalf("bad signature: got locked=%v reason=%q, want true %q", locked, reason, BlockReasonTamperedDB)
	}
}

// TestLegacyNoToken — старый ресторан без license_key (до v2.6.0) →
// hardening skip (backward compat).
func TestLegacyNoToken(t *testing.T) {
	pub, _, _ := license.GenerateKeypair()
	exp := time.Now().AddDate(0, 0, 30)
	r := models.Restaurant{
		ID:               "rest-1",
		LicenseKey:       nil, // legacy
		LicenseExpiresAt: &exp,
		LicenseIssuedAt:  nil,
	}
	svc := &LicenseService{publicKey: pub, cache: make(map[string]hardeningCacheEntry)}
	locked, _ := svc.hardeningCheck(r, time.Now())
	if locked {
		t.Fatal("legacy restaurant (no token) should pass hardening check")
	}
}

// TestImpossibleForwardClock — если now > expires + 2 года → impossible_time.
func TestImpossibleForwardClock(t *testing.T) {
	pub, _, _ := license.GenerateKeypair()
	exp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	r := models.Restaurant{
		ID:               "rest-1",
		LicenseExpiresAt: &exp,
		LicenseKey:       nil, // legacy чтобы не падать на signature
	}
	svc := &LicenseService{publicKey: pub, cache: make(map[string]hardeningCacheEntry)}
	farFuture := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	locked, reason := svc.hardeningCheck(r, farFuture)
	if !locked || reason != BlockReasonImpossible {
		t.Fatalf("impossible forward: got locked=%v reason=%q, want true %q", locked, reason, BlockReasonImpossible)
	}
}

// TestCacheTTL — повторный вызов в пределах 60с не вызывает re-verify
// (signature cache работает).
func TestCacheTTL(t *testing.T) {
	pub, priv, _ := license.GenerateKeypair()
	issued := time.Date(2026, 6, 5, 12, 0, 0, 0, time.UTC)
	exp := issued.AddDate(0, 0, 30)
	tok, _ := license.Sign(priv, license.Payload{
		Version: license.CurrentVersion, RestaurantID: "rest-1",
		IssuedAt: issued, ExpiresAt: exp,
	})
	r := models.Restaurant{
		ID: "rest-1", LicenseKey: &tok, LicenseIssuedAt: &issued, LicenseExpiresAt: &exp,
	}
	svc := &LicenseService{publicKey: pub, cache: make(map[string]hardeningCacheEntry)}

	now := issued.Add(time.Hour)
	locked1, _ := svc.cachedHardeningCheck(r, now)
	// Симулируем tamper после первой проверки — но кэш ещё свежий.
	bad := tok[:len(tok)-2] + "XX"
	r.LicenseKey = &bad
	locked2, _ := svc.cachedHardeningCheck(r, now.Add(10*time.Second))
	if locked1 != locked2 {
		t.Fatalf("cache miss: first=%v second=%v (cache should hide bad swap within TTL)", locked1, locked2)
	}
}
