// Package service — бизнес-логика. Чистые функции/методы, без HTTP.
package service

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
)

// SessionTTL — длительность сессии. 12 часов = одна смена + запас.
const SessionTTL = 12 * time.Hour

// LastSeenWindow — как часто обновляем last_seen_at в БД.
// Чаще не имеет смысла — это лишний write на каждый GET.
const LastSeenWindow = 30 * time.Second

// AuthService — login / validate / logout по PIN.
//
// Включает in-memory cache валидированных токенов (sync.Map). Это ключевая
// перф-оптимизация: 100% запросов проходят через middleware → если каждый
// дёргает БД, p99 страдает. Кэш с TTL мс.
type AuthService struct {
	db    *gorm.DB
	cache sync.Map // map[string]*cachedSession
}

type cachedSession struct {
	UserID       string
	RestaurantID string
	UserName     string
	Role         string
	ExpiresAt    time.Time
	// Если now() > nextRefreshAt → лезем в БД обновить last_seen_at.
	nextRefreshAt time.Time
}

// NewAuthService создаёт сервис. Один экземпляр на процесс.
func NewAuthService(db *gorm.DB) *AuthService {
	return &AuthService{db: db}
}

// LoginByPIN валидирует PIN в пределах ресторана и возвращает opaque-токен.
//
// Контракт: уникальность PIN внутри ресторана. Если два юзера с одинаковым PIN —
// возвращаем UNAUTHORIZED (не CONFLICT, чтобы не светить юзеров наружу).
func (s *AuthService) LoginByPIN(ctx context.Context, restaurantID, pin string) (token string, user *models.User, err error) {
	if restaurantID == "" || pin == "" {
		return "", nil, apperrors.Wrap("VALIDATION", "restaurant_id and pin are required", nil)
	}

	var matches []models.User
	// Прямой запрос — это auth, ForTenant неприменим (мы только-только узнаём
	// tenant'а из login-данных). См. CLAUDE.md: исключения для login допустимы.
	if err := s.db.WithContext(ctx).
		Where("restaurant_id = ? AND pin IS NOT NULL", restaurantID).
		Find(&matches).Error; err != nil {
		return "", nil, fmt.Errorf("auth: lookup user: %w", err)
	}

	var found *models.User
	for i := range matches {
		if matches[i].PIN == nil {
			continue
		}
		// Constant-time сравнение — PIN короткий, но привычка хорошая.
		if subtle.ConstantTimeCompare([]byte(*matches[i].PIN), []byte(pin)) == 1 {
			if found != nil {
				// Коллизия PIN внутри ресторана — это бардак в данных.
				return "", nil, apperrors.Wrap("UNAUTHORIZED", "invalid credentials", nil)
			}
			found = &matches[i]
		}
	}
	if found == nil {
		return "", nil, apperrors.Wrap("UNAUTHORIZED", "invalid credentials", nil)
	}

	tok, err := generateToken()
	if err != nil {
		return "", nil, err
	}
	now := time.Now().UTC()
	sess := &models.Session{
		Token:        tok,
		UserID:       found.ID,
		RestaurantID: restaurantID,
		UserName:     found.Name,
		Role:         found.Role,
		CreatedAt:    now,
		ExpiresAt:    now.Add(SessionTTL),
		LastSeenAt:   now,
	}
	if err := s.db.WithContext(ctx).Create(sess).Error; err != nil {
		return "", nil, fmt.Errorf("auth: create session: %w", err)
	}
	return tok, found, nil
}

// Validate — горячий путь, дёргается middleware на КАЖДОМ запросе.
//
// Сначала кэш. Промах → одна выборка из sessions с проверкой expires_at.
// last_seen_at обновляем не чаще раза в LastSeenWindow.
func (s *AuthService) Validate(ctx context.Context, token string) (*cachedSession, error) {
	if token == "" {
		return nil, apperrors.Wrap("UNAUTHORIZED", "missing token", nil)
	}
	now := time.Now().UTC()

	if v, ok := s.cache.Load(token); ok {
		cs := v.(*cachedSession)
		if cs.ExpiresAt.After(now) {
			// Освежаем last_seen_at в БД с throttling'ом.
			if now.After(cs.nextRefreshAt) {
				go s.touchLastSeen(token, now)
				cs.nextRefreshAt = now.Add(LastSeenWindow)
			}
			return cs, nil
		}
		s.cache.Delete(token)
	}

	var sess models.Session
	if err := s.db.WithContext(ctx).
		Where("token = ? AND expires_at > ?", token, now).
		First(&sess).Error; err != nil {
		return nil, apperrors.Wrap("UNAUTHORIZED", "invalid or expired token", err)
	}

	cs := &cachedSession{
		UserID:        sess.UserID,
		RestaurantID:  sess.RestaurantID,
		UserName:      strOr(sess.UserName, ""),
		Role:          strOr(sess.Role, ""),
		ExpiresAt:     sess.ExpiresAt,
		nextRefreshAt: now.Add(LastSeenWindow),
	}
	s.cache.Store(token, cs)
	return cs, nil
}

// Logout удаляет сессию из БД и кэша.
func (s *AuthService) Logout(ctx context.Context, token string) error {
	s.cache.Delete(token)
	return s.db.WithContext(ctx).
		Where("token = ?", token).
		Delete(&models.Session{}).Error
}

// SessionInfo — публичная инфа о текущей сессии (для middleware/handler).
type SessionInfo struct {
	UserID       string    `json:"user_id"`
	RestaurantID string    `json:"restaurant_id"`
	UserName     string    `json:"user_name"`
	Role         string    `json:"role"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// Public конвертирует cachedSession в SessionInfo (без приватных полей).
func (cs *cachedSession) Public() SessionInfo {
	return SessionInfo{
		UserID:       cs.UserID,
		RestaurantID: cs.RestaurantID,
		UserName:     cs.UserName,
		Role:         cs.Role,
		ExpiresAt:    cs.ExpiresAt,
	}
}

func (s *AuthService) touchLastSeen(token string, now time.Time) {
	// fire-and-forget; ошибки логировать в самом updater'е не нужно — не критично.
	_ = s.db.Model(&models.Session{}).
		Where("token = ?", token).
		Update("last_seen_at", now).Error
}

func generateToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("rand: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func strOr(s *string, def string) string {
	if s == nil {
		return def
	}
	return *s
}
