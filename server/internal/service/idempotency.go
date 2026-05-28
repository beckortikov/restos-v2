package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// IdempotencyService — кэш ответов write-эндпоинтов по UUID-ключу.
//
// Контракт (CLAUDE.md):
//   - Все POST/PUT/DELETE принимают Idempotency-Key (UUID v4).
//   - Кэш живёт 24 часа (поле expires_at в таблице).
//   - Повтор с тем же ключом и тем же телом → возвращаем кэшированный ответ.
//   - Повтор с тем же ключом, но другим телом → 409 CONFLICT (защита от
//     случайного переиспользования ключа фронтом для разной операции).
type IdempotencyService struct {
	db *gorm.DB
}

func NewIdempotencyService(db *gorm.DB) *IdempotencyService {
	return &IdempotencyService{db: db}
}

// CacheTTL — сколько хранить ответы.
const CacheTTL = 24 * time.Hour

// Cached — найденный ответ под этот ключ.
type Cached struct {
	Status int
	Body   []byte
}

// ErrConflict возвращается, если ключ уже использован для ДРУГОГО запроса.
var ErrConflict = errors.New("idempotency: key reused for different request")

// Lookup проверяет, есть ли кэш под ключ + хэш запроса.
//   - ok=true → запрос уже выполнялся, body вернуть как есть.
//   - ok=false, err=nil → ключа нет, можно выполнять.
//   - err=ErrConflict → ключ есть, но requestHash другой.
func (s *IdempotencyService) Lookup(ctx context.Context, key, method, path string, requestBody []byte) (*Cached, error) {
	if key == "" {
		return nil, nil
	}
	var row models.IdempotencyKey
	err := s.db.WithContext(ctx).
		Where("key = ? AND expires_at > ?", key, time.Now().UTC()).
		First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	want := hashRequest(method, path, requestBody)
	if row.RequestHash != want {
		return nil, ErrConflict
	}
	return &Cached{
		Status: row.ResponseStatus,
		Body:   row.ResponseBody,
	}, nil
}

// Save сохраняет ответ в кэш. Используется ПОСЛЕ успешного хендлера.
//
// status и body — то, что отдали клиенту. restaurantID/userID извлекаются из
// контекста (auth middleware кладёт), но опциональны.
func (s *IdempotencyService) Save(
	ctx context.Context,
	key, method, path string,
	requestBody []byte,
	status int,
	respBody []byte,
	restaurantID, userID *string,
) error {
	if key == "" {
		return nil
	}
	now := time.Now().UTC()
	row := models.IdempotencyKey{
		Key:            key,
		Method:         method,
		Path:           path,
		RequestHash:    hashRequest(method, path, requestBody),
		ResponseStatus: status,
		ResponseBody:   respBody,
		RestaurantID:   restaurantID,
		UserID:         userID,
		CreatedAt:      now,
		ExpiresAt:      now.Add(CacheTTL),
	}
	// SkipHooks — не светим idempotency-cache в audit_log.
	return s.db.WithContext(ctx).
		Session(&gorm.Session{SkipHooks: true}).
		Create(&row).Error
}

// hashRequest — стабильный хэш для сравнения «тот же ли запрос».
// SHA-256 хватает с большим запасом.
func hashRequest(method, path string, body []byte) string {
	h := sha256.New()
	h.Write([]byte(method))
	h.Write([]byte{0})
	h.Write([]byte(path))
	h.Write([]byte{0})
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}
