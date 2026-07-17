// size_scales — CRUD переиспользуемых шкал размеров («Пиццы 25/30/35»).
// Тот же паттерн List/Create/Patch/Delete с ForTenant, что и у
// SemiFinishedType в admin_extra.go: Patch с непустым Values полностью
// заменяет значения шкалы (delete+recreate), а не диффит по id.
package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

type SizeScaleService struct{ r *repo.Repo }

func NewSizeScaleService(r *repo.Repo) *SizeScaleService { return &SizeScaleService{r: r} }

type SizeScaleValueInput struct {
	ID        *string `json:"id,omitempty"`
	Code      *string `json:"code,omitempty"`
	Title     *string `json:"title,omitempty"`
	SortOrder *int    `json:"sort_order,omitempty"`
	IsDefault *bool   `json:"is_default,omitempty"`
}

type SizeScaleInput struct {
	Name   *string                `json:"name,omitempty"`
	Values *[]SizeScaleValueInput `json:"values,omitempty"`
}

// SizeScaleWithValues — DTO для листинга/чтения шкалы вместе с её значениями.
type SizeScaleWithValues struct {
	*models.SizeScale
	Values []models.SizeScaleValue `json:"values"`
}

func (s *SizeScaleService) ListScales(ctx context.Context) ([]models.SizeScale, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.SizeScale
	if err := scoped.Order("name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// ListScalesWithValues — шкалы + их значения одним батчем.
func (s *SizeScaleService) ListScalesWithValues(ctx context.Context) ([]SizeScaleWithValues, error) {
	rows, err := s.ListScales(ctx)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return []SizeScaleWithValues{}, nil
	}
	ids := make([]string, 0, len(rows))
	for i := range rows {
		ids = append(ids, rows[i].ID)
	}
	var values []models.SizeScaleValue
	if err := s.r.Raw().WithContext(ctx).
		Where("size_scale_id IN ?", ids).Order("sort_order ASC").Find(&values).Error; err != nil {
		return nil, err
	}
	byScale := make(map[string][]models.SizeScaleValue, len(rows))
	for _, v := range values {
		byScale[v.SizeScaleID] = append(byScale[v.SizeScaleID], v)
	}
	out := make([]SizeScaleWithValues, len(rows))
	for i := range rows {
		row := rows[i]
		vs := byScale[row.ID]
		if vs == nil {
			vs = []models.SizeScaleValue{}
		}
		out[i] = SizeScaleWithValues{SizeScale: &row, Values: vs}
	}
	return out, nil
}

func (s *SizeScaleService) GetScale(ctx context.Context, id string) (*SizeScaleWithValues, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var scale models.SizeScale
	if err := scoped.Where("id = ?", id).First(&scale).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	var values []models.SizeScaleValue
	if err := s.r.Raw().WithContext(ctx).
		Where("size_scale_id = ?", id).Order("sort_order ASC").Find(&values).Error; err != nil {
		return nil, err
	}
	if values == nil {
		values = []models.SizeScaleValue{}
	}
	return &SizeScaleWithValues{SizeScale: &scale, Values: values}, nil
}

func (s *SizeScaleService) CreateScale(ctx context.Context, in SizeScaleInput) (*SizeScaleWithValues, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	scale := &models.SizeScale{
		ID: uuid.NewString(), Name: *in.Name,
		RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
	}
	var created []models.SizeScaleValue
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Create(scale).Error; err != nil {
			return err
		}
		if in.Values != nil {
			for _, v := range *in.Values {
				line, err := buildSizeScaleValue(scale.ID, rid, v, now)
				if err != nil {
					return err
				}
				if err := tx.Create(line).Error; err != nil {
					return err
				}
				created = append(created, *line)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if created == nil {
		created = []models.SizeScaleValue{}
	}
	return &SizeScaleWithValues{SizeScale: scale, Values: created}, nil
}

func buildSizeScaleValue(scaleID, restaurantID string, in SizeScaleValueInput, now time.Time) (*models.SizeScaleValue, error) {
	if in.Code == nil || *in.Code == "" {
		return nil, apperrors.Wrap("VALIDATION", "code is required", nil)
	}
	v := &models.SizeScaleValue{
		ID: uuid.NewString(), SizeScaleID: scaleID, Code: *in.Code, Title: in.Title,
		RestaurantID: &restaurantID, CreatedAt: now, UpdatedAt: now,
	}
	if in.SortOrder != nil {
		v.SortOrder = *in.SortOrder
	}
	if in.IsDefault != nil {
		v.IsDefault = *in.IsDefault
	}
	return v, nil
}

func (s *SizeScaleService) PatchScale(ctx context.Context, id string, in SizeScaleInput) (*SizeScaleWithValues, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.SizeScale
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Name != nil {
		if *in.Name == "" {
			return nil, apperrors.Wrap("VALIDATION", "name cannot be empty", nil)
		}
		updates["name"] = *in.Name
	}
	now := time.Now().UTC()
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Model(&existing).Updates(updates).Error; err != nil {
			return err
		}
		// Полная замена значений, если переданы — мирроры в menu_attribute_values
		// (size_scale_value_id) откатятся на NULL по ON DELETE SET NULL и
		// пересинкуются при следующем PUT /menu/items/{id}/attributes.
		if in.Values != nil {
			if err := tx.Where("size_scale_id = ?", id).Delete(&models.SizeScaleValue{}).Error; err != nil {
				return err
			}
			for _, v := range *in.Values {
				line, err := buildSizeScaleValue(id, rid, v, now)
				if err != nil {
					return err
				}
				if err := tx.Create(line).Error; err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.GetScale(ctx, id)
}

func (s *SizeScaleService) DeleteScale(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.SizeScale{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}
