package service

import (
	"context"
	"crypto/ed25519"
	"errors"
	"time"

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
// Кэшируется в памяти на 60 сек (license-check на hot-path не должна бить БД).
type LicenseService struct {
	db        *gorm.DB
	publicKey ed25519.PublicKey
	pub       *EventPublisher // опционально; nil → SSE-эвенты не публикуются
}

// NewLicenseService — pub_key обычно захардкожен в бинарь (через ldflags) или
// конфиг. nil → активировать нельзя (только bootstrap-режим dev).
func NewLicenseService(db *gorm.DB, pubKey ed25519.PublicKey) *LicenseService {
	return &LicenseService{db: db, publicKey: pubKey}
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

// GraceDays — 7 дней до warning.
const GraceDays = 7

// WarningDays — ещё 7 дней до lock.
const WarningDays = 7

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
	if r.LicenseExpiresAt == nil {
		out.State = StateNone
		return out, nil
	}
	exp := *r.LicenseExpiresAt
	out.DaysLeft = daysBetween(now, exp)
	lockAt := exp.AddDate(0, 0, GraceDays+WarningDays)
	out.DaysUntilLock = daysBetween(now, lockAt)
	switch {
	case out.IsBlocked:
		out.State = StateLocked
	case now.Before(exp):
		out.State = StateActive
	case now.Before(exp.AddDate(0, 0, GraceDays)):
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
//
// MVP без кэша: при 100 req/s — 100 SELECT'ов restaurants. Это OK для одной
// кассы. Кэш добавим если станет узким местом.
func (s *LicenseService) IsLocked(ctx context.Context, restaurantID string) bool {
	var r models.Restaurant
	if err := s.db.WithContext(ctx).
		Select("license_expires_at, is_blocked").
		Where("id = ?", restaurantID).First(&r).Error; err != nil {
		// Fail-open: если БД недоступна — не блокируем (лучше короткий abuse,
		// чем потеря всех касс при network blip).
		return false
	}
	if r.IsBlocked != nil && *r.IsBlocked {
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
	lockAt := r.LicenseExpiresAt.AddDate(0, 0, GraceDays+WarningDays)
	return time.Now().UTC().After(lockAt)
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
