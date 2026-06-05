package service

import (
	"context"
	"crypto/ed25519"
	"errors"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/license"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
)

// LicenseService — активация и проверка лицензии (CLAUDE.md «7+7+lock»).
//
// Состояния (вычисляются динамически из restaurants.license_expires_at + now()):
//   - active:  до expires
//   - grace:   expires .. expires+7d        — клиент видит warning, всё работает
//   - warning: expires+7d .. expires+14d    — read-only? нет, всё работает + красное окно
//   - locked:  > expires+14d                — write-операции блокируются (write middleware)
//
// Hardening (v2.6.0):
//   - Clock skew check: now() < license_issued_at → tampered → lock
//   - Signature re-verify: re-parse license_key (token) каждый запрос, если
//     parsed payload не совпадает с колонками БД → tampered_db → lock.
//     Кешируется на 60с — Ed25519.Verify ~50us, кэш разгружает hot-path.
type LicenseService struct {
	db        *gorm.DB
	publicKey ed25519.PublicKey
	pub       *EventPublisher // опционально; nil → SSE-эвенты не публикуются

	// hardening cache: restaurant_id → (verifiedAt, locked, reason).
	mu    sync.Mutex
	cache map[string]hardeningCacheEntry
}

type hardeningCacheEntry struct {
	verifiedAt  time.Time
	locked      bool
	blockReason string // "tampered_db" | "clock_tampered" | "" (ok)
}

const hardeningCacheTTL = 60 * time.Second

// NewLicenseService — pub_key обычно захардкожен в бинарь (через ldflags) или
// конфиг. nil → активировать нельзя (только bootstrap-режим dev).
func NewLicenseService(db *gorm.DB, pubKey ed25519.PublicKey) *LicenseService {
	return &LicenseService{
		db:        db,
		publicKey: pubKey,
		cache:     make(map[string]hardeningCacheEntry),
	}
}

// WithPublisher — добавляет SSE-эвенты на смену license-состояния.
func (s *LicenseService) WithPublisher(pub *EventPublisher) *LicenseService {
	s.pub = pub
	return s
}

// State — текущее состояние лицензии ресторана.
type State string

const (
	StateActive  State = "active"
	StateGrace   State = "grace"
	StateWarning State = "warning"
	StateLocked  State = "locked"
	StateNone    State = "none" // лицензия ещё не активирована
)

// Block reasons (v2.6.0+).
const (
	BlockReasonClockTampered = "clock_tampered"  // now() < license_issued_at
	BlockReasonTamperedDB    = "tampered_db"     // license_key signature mismatch / payload diff
	BlockReasonImpossible    = "impossible_time" // now > expires + 2 years
)

// DefaultGraceDays / DefaultWarningDays — fallback если в restaurants нет
// значений (теоретически невозможно после миграции 017 — там NOT NULL
// DEFAULT 7). Оставлены как safety-net для unit-тестов и для read-only
// клиентов в начальном bootstrap.
//
// Реальные значения берутся из restaurants.license_grace_days /
// license_warning_days, которые копятся из license-токена на activate'е.
const (
	DefaultGraceDays   = 7
	DefaultWarningDays = 7
)

// MachineInfo — fingerprint текущей машины + restaurant_id/name для
// активации. Клиент копирует MachineID и Restaurant.ID, отправляет админу,
// тот выписывает токен с такими же значениями.
type MachineInfo struct {
	MachineID      string `json:"machine_id"`
	RestaurantID   string `json:"restaurant_id"`
	RestaurantName string `json:"restaurant_name,omitempty"`
	// AccountID — если ресторан принадлежит сети. Заполняется только
	// если уже была активация с account-токеном. Иначе пусто (новый
	// install или одиночный).
	AccountID string `json:"account_id,omitempty"`
}

// MachineInfo возвращает fingerprint этой машины + сведения о ресторане.
// Используется на экране активации (GET /api/v1/license/machine-id).
func (s *LicenseService) MachineInfo(ctx context.Context) (*MachineInfo, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var r models.Restaurant
	if err := s.db.WithContext(ctx).Where("id = ?", rid).First(&r).Error; err != nil {
		return nil, err
	}
	info := &MachineInfo{
		MachineID:      license.MachineID(),
		RestaurantID:   r.ID,
		RestaurantName: r.Name,
	}
	if r.AccountID != nil {
		info.AccountID = *r.AccountID
	}
	return info, nil
}

// PublicMachineInfo — то же что MachineInfo, но без tenant из ctx. Берёт
// первый ресторан из БД (на v4 локально всегда один на машину). Нужен для
// onboarding APK официанта и любого pre-auth probe экрана — например,
// чтобы клиент мог проверить «это RestOS-бэк?» до логина.
func (s *LicenseService) PublicMachineInfo(ctx context.Context) (*MachineInfo, error) {
	var r models.Restaurant
	if err := s.db.WithContext(ctx).Order("created_at ASC").First(&r).Error; err != nil {
		return nil, err
	}
	info := &MachineInfo{
		MachineID:      license.MachineID(),
		RestaurantID:   r.ID,
		RestaurantName: r.Name,
	}
	if r.AccountID != nil {
		info.AccountID = *r.AccountID
	}
	return info, nil
}

// LicenseStatus — публичный ответ /license/status.
type LicenseStatus struct {
	State         State      `json:"state"`
	ExpiresAt     *time.Time `json:"expires_at,omitempty"`
	DaysLeft      int        `json:"days_left"`       // до expires (отрицательно после)
	DaysUntilLock int        `json:"days_until_lock"` // до lock (отрицательно после lock)
	IsBlocked     bool       `json:"is_blocked"`
	BlockReason   string     `json:"block_reason,omitempty"`
	Edition       string     `json:"edition,omitempty"`
	// GraceDays / WarningDays — фактические периоды этой лицензии
	// (per-key, v2.1.3+). Используются клиентом для точного UI:
	// «Истёк 2 дн. назад. Софт заблокируется через 5 дн.».
	GraceDays   int `json:"grace_days"`
	WarningDays int `json:"warning_days"`
}

// hardeningCheck — clock-skew + signature re-verify. Возвращает
// (locked, reason). Cache 60с per-restaurant.
//
// Logic:
//  1. Если license_issued_at set и now() < issued_at → clock_tampered.
//  2. Если license_expires_at set и now() > expires + 2 года → impossible_time
//     (защита от absurdly forward clock).
//  3. Если license_key (token) set и publicKey set → re-parse.
//     Подпись invalid → tampered_db.
//     Parsed payload.expires_at != r.license_expires_at → tampered_db.
//     Parsed payload.rid != r.id → tampered_db.
//  4. Если license_key nil (legacy < v2.6.0) → skip signature check, allow
//     (с warning в audit) — backward compat.
func (s *LicenseService) hardeningCheck(r models.Restaurant, now time.Time) (bool, string) {
	// Clock backdate: now < issued_at.
	if r.LicenseIssuedAt != nil && now.Before(*r.LicenseIssuedAt) {
		return true, BlockReasonClockTampered
	}
	// Impossible forward clock: now > expires + 2 years.
	if r.LicenseExpiresAt != nil && now.After(r.LicenseExpiresAt.AddDate(2, 0, 0)) {
		return true, BlockReasonImpossible
	}
	// Signature re-verify. Pub key nil → dev mode, skip.
	if s.publicKey == nil {
		return false, ""
	}
	// license_key nil → legacy < v2.6.0 → skip (backward compat).
	if r.LicenseKey == nil || *r.LicenseKey == "" {
		return false, ""
	}
	p, err := license.Parse(*r.LicenseKey, s.publicKey)
	if err != nil {
		// Подпись битая → кто-то изменил БД.
		log.Warn().Err(err).Str("rid", r.ID).Msg("license: signature re-verify failed (tampered_db?)")
		return true, BlockReasonTamperedDB
	}
	// Cross-check: parsed payload vs DB columns.
	if r.LicenseExpiresAt == nil || !p.ExpiresAt.Equal(*r.LicenseExpiresAt) {
		log.Warn().Str("rid", r.ID).
			Time("token_exp", p.ExpiresAt).
			Interface("db_exp", r.LicenseExpiresAt).
			Msg("license: expires_at mismatch token vs DB (tampered_db)")
		return true, BlockReasonTamperedDB
	}
	if p.RestaurantID != r.ID {
		return true, BlockReasonTamperedDB
	}
	return false, ""
}

// cachedHardeningCheck — same as hardeningCheck но с 60-сек TTL кэшем.
func (s *LicenseService) cachedHardeningCheck(r models.Restaurant, now time.Time) (bool, string) {
	s.mu.Lock()
	entry, ok := s.cache[r.ID]
	s.mu.Unlock()
	if ok && now.Sub(entry.verifiedAt) < hardeningCacheTTL {
		return entry.locked, entry.blockReason
	}
	locked, reason := s.hardeningCheck(r, now)
	s.mu.Lock()
	s.cache[r.ID] = hardeningCacheEntry{verifiedAt: now, locked: locked, blockReason: reason}
	s.mu.Unlock()
	return locked, reason
}

// InvalidateCache — сбросить hardening cache (вызывается после Activate).
func (s *LicenseService) InvalidateCache(rid string) {
	s.mu.Lock()
	delete(s.cache, rid)
	s.mu.Unlock()
}

// Status — для GET /api/v1/license/status. Учитывает ручной is_blocked
// (Owner может заблокировать ресторан вручную через backoffice).
func (s *LicenseService) Status(ctx context.Context) (*LicenseStatus, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var r models.Restaurant
	if err := s.db.WithContext(ctx).Where("id = ?", rid).First(&r).Error; err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	out := &LicenseStatus{
		ExpiresAt: r.LicenseExpiresAt,
		IsBlocked: r.IsBlocked != nil && *r.IsBlocked,
	}
	if r.BlockReason != nil {
		out.BlockReason = *r.BlockReason
	}
	// Hardening: clock skew + signature re-verify (v2.6.0).
	if locked, reason := s.cachedHardeningCheck(r, now); locked {
		out.State = StateLocked
		out.IsBlocked = true
		out.BlockReason = reason
		out.ExpiresAt = r.LicenseExpiresAt
		out.GraceDays = r.LicenseGraceDays
		out.WarningDays = r.LicenseWarningDays
		return out, nil
	}
	if r.LicenseExpiresAt == nil {
		out.State = StateNone
		return out, nil
	}
	exp := *r.LicenseExpiresAt
	graceDays := r.LicenseGraceDays
	warningDays := r.LicenseWarningDays
	out.GraceDays = graceDays
	out.WarningDays = warningDays
	out.DaysLeft = daysBetween(now, exp)
	lockAt := exp.AddDate(0, 0, graceDays+warningDays)
	out.DaysUntilLock = daysBetween(now, lockAt)
	switch {
	case out.IsBlocked:
		out.State = StateLocked
	case now.Before(exp):
		out.State = StateActive
	case now.Before(exp.AddDate(0, 0, graceDays)):
		out.State = StateGrace
	case now.Before(lockAt):
		out.State = StateWarning
	default:
		out.State = StateLocked
	}
	return out, nil
}

// IsLocked — горячий путь для middleware (cache 60с).
//
// Возвращает true, если ресторан в состоянии locked (write нельзя) ИЛИ
// заблокирован вручную. Read-операции и /license/* допустимы — middleware
// решает скоупом применения.
func (s *LicenseService) IsLocked(ctx context.Context, restaurantID string) bool {
	var r models.Restaurant
	if err := s.db.WithContext(ctx).
		Select("id, license_key, license_expires_at, license_issued_at, is_blocked, license_grace_days, license_warning_days").
		Where("id = ?", restaurantID).First(&r).Error; err != nil {
		// Fail-open: если БД недоступна — не блокируем (лучше короткий abuse,
		// чем потеря всех касс при network blip).
		return false
	}
	if r.IsBlocked != nil && *r.IsBlocked {
		return true
	}
	now := time.Now().UTC()
	if locked, _ := s.cachedHardeningCheck(r, now); locked {
		return true
	}
	if r.LicenseExpiresAt == nil {
		// Лицензия НЕ активирована → блокируем (требуется activate).
		// v2.0.29+: строгая модель «без активации не работаем».
		// Read-эндпоинты остаются доступны (middleware применяется только к
		// write-роутам), плюс /license/* всегда работают — клиент может
		// видеть machine_id и активировать.
		return true
	}
	lockAt := r.LicenseExpiresAt.AddDate(0, 0, r.LicenseGraceDays+r.LicenseWarningDays)
	return now.After(lockAt)
}

// ActivateInput — body POST /api/v1/license/activate.
type ActivateInput struct {
	Token string `json:"token"`
}

// Activate валидирует подпись токена и обновляет restaurants.license_expires_at.
//
// Если restaurant_id в токене не совпадает с tenant из сессии → 400.
// Если токен уже истёк (даже валидный) → возвращаем 400 (нечего активировать).
// Иначе сохраняем expires и снимаем is_blocked.
func (s *LicenseService) Activate(ctx context.Context, in ActivateInput) (*LicenseStatus, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if s.publicKey == nil {
		return nil, apperrors.Wrap("CONFLICT", "license verification key not configured", nil)
	}
	if in.Token == "" {
		return nil, apperrors.Wrap("VALIDATION", "token is required", nil)
	}
	now := time.Now().UTC()
	p, err := license.Validate(in.Token, s.publicKey, now)
	if err != nil {
		switch {
		case errors.Is(err, license.ErrBadSignature):
			return nil, apperrors.Wrap("VALIDATION", "bad license signature", err)
		case errors.Is(err, license.ErrBadFormat), errors.Is(err, license.ErrBadVersion):
			return nil, apperrors.Wrap("VALIDATION", "bad license token", err)
		case errors.Is(err, license.ErrExpired):
			return nil, apperrors.Wrap("VALIDATION", "license token already expired", err)
		}
		return nil, err
	}
	if p.RestaurantID != rid {
		return nil, apperrors.Wrap("VALIDATION", "token issued for a different restaurant", nil)
	}
	// Machine binding (v2.0.26+): если токен выписан с machine_id, сверяем
	// с текущим железом. Empty mid → legacy machine-agnostic токен
	// (продолжаем принимать для backward compat со старыми токенами).
	if p.MachineID != "" {
		current := license.MachineID()
		if p.MachineID != current {
			return nil, apperrors.Wrap("VALIDATION",
				"token issued for different machine (got "+current+", token "+p.MachineID+")", nil)
		}
	}

	// Update restaurant.
	expires := p.ExpiresAt
	noBlock := false
	updates := map[string]any{
		"license_key":        in.Token,
		"license_expires_at": expires,
		"is_blocked":         &noBlock,
		"block_reason":       nil,
		"updated_at":         now,
		// v2.1.3: per-key grace/warning. Старые токены без этих полей →
		// 0/0 (hard lock сразу при истечении). Защита продавца.
		"license_grace_days":   p.GraceDays,
		"license_warning_days": p.WarningDays,
	}
	// v2.6.0: сохраняем issued_at для clock-skew check. Legacy токены
	// без iat → zero time → пропускаем (NULL в БД).
	if !p.IssuedAt.IsZero() {
		updates["license_issued_at"] = p.IssuedAt
	} else {
		updates["license_issued_at"] = nil
	}
	// Phase 1 multi-branch: если токен выписан с account_id (сеть),
	// сохраняем в restaurants.account_id. Empty → NULL (одиночный).
	if p.AccountID != "" {
		updates["account_id"] = p.AccountID
	}
	if err := s.db.WithContext(ctx).Model(&models.Restaurant{}).
		Where("id = ?", rid).Updates(updates).Error; err != nil {
		return nil, err
	}
	// Сброс hardening cache (свежая активация — старая запись могла быть locked).
	s.InvalidateCache(rid)
	st, err := s.Status(ctx)
	if err != nil {
		return nil, err
	}
	// SSE: license.updated сразу после успешной активации.
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventLicenseUpdated, st)
		s.pub.Flush(ctx, rid, buf)
	}
	return st, nil
}

// daysBetween — целое число дней между now и target (отрицательное если target в прошлом).
func daysBetween(now, target time.Time) int {
	d := target.Sub(now)
	return int(d.Hours() / 24)
}
