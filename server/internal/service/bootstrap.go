package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/repo"
)

// BootstrapService — первичная инициализация пустой БД.
//
// Когда пользователь первый раз запускает Electron-сборку, БД пустая. Login
// невозможен — нет ни одного User. Bootstrap-endpoint создаёт первый
// `restaurant` + первого `owner`-юзера с PIN. Дальше Owner логинится и через
// Manager-UI CRUD'ы настраивает всё остальное.
//
// SECURITY: endpoint доступен ТОЛЬКО если `restaurants` пустая. Это защита
// от случайного «сброса» прода если кто-то найдёт URL.
type BootstrapService struct {
	r *repo.Repo
}

func NewBootstrapService(r *repo.Repo) *BootstrapService { return &BootstrapService{r: r} }

// BootstrapInput — body POST /api/v1/bootstrap.
type BootstrapInput struct {
	RestaurantName string `json:"restaurant_name"`
	OwnerName      string `json:"owner_name"`
	OwnerPIN       string `json:"owner_pin"`
	Currency       string `json:"currency,omitempty"` // default "TJS"
	Timezone       string `json:"timezone,omitempty"` // default "Asia/Dushanbe"
}

// BootstrapResult — что вернули клиенту.
type BootstrapResult struct {
	Restaurant *models.Restaurant `json:"restaurant"`
	Owner      *models.User       `json:"owner"`
}

// Run выполняет инициализацию. Атомарно: если хоть один INSERT упал — rollback.
func (s *BootstrapService) Run(ctx context.Context, in BootstrapInput) (*BootstrapResult, error) {
	if in.RestaurantName == "" || in.OwnerName == "" || in.OwnerPIN == "" {
		return nil, apperrors.Wrap("VALIDATION", "restaurant_name, owner_name and owner_pin are required", nil)
	}

	var result *BootstrapResult
	err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// Guard: bootstrap доступен только на пустой БД.
		// SELECT FOR UPDATE на каунте бессмысленно (нет строк), но мы делаем COUNT
		// внутри tx — если параллельный запрос успел вставить restaurant между нашими
		// COUNT и INSERT, второй INSERT просто продолжит, в результате будет 2 restaurants.
		// Это accepted edge case для первой инициализации.
		var count int64
		if err := tx.Model(&models.Restaurant{}).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return apperrors.Wrap("CONFLICT", "system already initialized (restaurants table not empty)", nil)
		}

		now := time.Now().UTC()
		currency := in.Currency
		if currency == "" {
			currency = "TJS"
		}
		timezone := in.Timezone
		if timezone == "" {
			timezone = "Asia/Dushanbe"
		}

		rest := &models.Restaurant{
			ID:        uuid.NewString(),
			Name:      in.RestaurantName,
			Currency:  &currency,
			Timezone:  &timezone,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if err := tx.Create(rest).Error; err != nil {
			return err
		}

		ownerRole := "owner"
		ownerName := in.OwnerName
		ownerPIN := in.OwnerPIN
		owner := &models.User{
			ID:           uuid.NewString(),
			Name:         &ownerName,
			Role:         &ownerRole,
			PIN:          &ownerPIN,
			RestaurantID: &rest.ID,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(owner).Error; err != nil {
			return err
		}

		// Не возвращаем PIN наружу.
		owner.PIN = nil
		owner.Password = nil
		result = &BootstrapResult{Restaurant: rest, Owner: owner}
		return nil
	})
	if err != nil {
		// gorm.ErrRecordNotFound в bootstrap не бывает; пропускаем маппинг.
		var appErr *apperrors.AppError
		if errors.As(err, &appErr) {
			return nil, err
		}
		return nil, err
	}
	return result, nil
}

// IsInitialized — публичный getter, фронт использует чтобы решить: показать
// bootstrap-форму или login-форму.
//
// nil-tx (без транзакции) — просто COUNT, доступен без auth.
func (s *BootstrapService) IsInitialized(ctx context.Context) (bool, error) {
	var count int64
	if err := s.r.Raw().WithContext(ctx).Model(&models.Restaurant{}).Count(&count).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		return false, err
	}
	return count > 0, nil
}
