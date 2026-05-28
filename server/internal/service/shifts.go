package service

import (
	"context"
	"errors"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/cursor"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/repo"
)

type ShiftsService struct {
	r   *repo.Repo
	pub *EventPublisher // опционально; nil → no-op
}

func NewShiftsService(r *repo.Repo) *ShiftsService {
	return &ShiftsService{r: r}
}

// ShiftsFilter — фильтры для GET /shifts.
type ShiftsFilter struct {
	Status string // open|closed
	Page   cursor.Page
}

// ShiftWithAccount — DTO: смена + имя её account'а (денормализация на чтении).
// Не наследует embeddable structs (на JSON-уровне просто разворачивается).
type ShiftWithAccount struct {
	*models.CashShift
	AccountName *string `json:"account_name"`
}

// enrichWithAccountNames подгружает имена financial_accounts для накопленных
// shifts и возвращает DTO. Один SELECT IN (...).
func (s *ShiftsService) enrichWithAccountNames(ctx context.Context, shifts []models.CashShift) ([]ShiftWithAccount, error) {
	out := make([]ShiftWithAccount, len(shifts))
	ids := make([]string, 0, len(shifts))
	seen := map[string]bool{}
	for _, sh := range shifts {
		if sh.AccountID != nil && *sh.AccountID != "" && !seen[*sh.AccountID] {
			seen[*sh.AccountID] = true
			ids = append(ids, *sh.AccountID)
		}
	}
	nameByID := map[string]string{}
	if len(ids) > 0 {
		type row struct {
			ID   string  `gorm:"column:id"`
			Name *string `gorm:"column:name"`
		}
		var rows []row
		if err := s.r.Raw().WithContext(ctx).
			Table("financial_accounts").
			Select("id, name").
			Where("id IN ?", ids).
			Find(&rows).Error; err != nil {
			return nil, err
		}
		for _, r := range rows {
			if r.Name != nil {
				nameByID[r.ID] = *r.Name
			}
		}
	}
	for i := range shifts {
		sh := shifts[i]
		var name *string
		if sh.AccountID != nil {
			if n, ok := nameByID[*sh.AccountID]; ok {
				nameCopy := n
				name = &nameCopy
			}
		}
		out[i] = ShiftWithAccount{CashShift: &sh, AccountName: name}
	}
	return out, nil
}

// List — пагинированный список смен ресторана с подгружённым account_name.
func (s *ShiftsService) List(ctx context.Context, f ShiftsFilter) ([]ShiftWithAccount, string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, "", err
	}
	q := scoped
	if f.Status != "" {
		q = q.Where("status = ?", f.Status)
	}
	// CashShift отсортирован по opened_at, а не created_at — это естественный
	// порядок смен. Пагинируем по нему. Применяем keyset вручную (cursor.Apply
	// смотрит на created_at; здесь подходит свой ORDER BY).
	limit := cursor.NormalizeLimit(f.Page.Limit)
	q = q.Order("opened_at DESC").Order("id DESC").Limit(limit + 1)
	if f.Page.Cursor != "" {
		t, err := cursor.Decode(f.Page.Cursor)
		if err != nil {
			return nil, "", apperrors.Wrap("BAD_REQUEST", "bad cursor", err)
		}
		q = q.Where("(opened_at, id) < (?, ?)", t.Time, t.ID)
	}
	var rows []models.CashShift
	if err := q.Find(&rows).Error; err != nil {
		return nil, "", err
	}
	trimmed, next := cursor.Next(rows, limit, func(m models.CashShift) cursor.Token {
		return cursor.Token{Time: m.OpenedAt, ID: m.ID}
	})
	enriched, err := s.enrichWithAccountNames(ctx, trimmed)
	if err != nil {
		return nil, "", err
	}
	return enriched, next, nil
}

// ShiftDetail — смена с операциями (взносы/изъятия) и именем account'а.
type ShiftDetail struct {
	Shift      ShiftWithAccount            `json:"shift"`
	Operations []models.CashShiftOperation `json:"operations"`
}

// Get — детальная смена по id, с операциями.
func (s *ShiftsService) Get(ctx context.Context, id string) (*ShiftDetail, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var shift models.CashShift
	if err := scoped.First(&shift, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	// cash_shift_operations не имеет restaurant_id — фильтруем по shift_id
	// (FK даёт изоляцию: id шла через ForTenant).
	var ops []models.CashShiftOperation
	if err := s.r.Raw().WithContext(ctx).
		Where("shift_id = ?", id).
		Order("created_at ASC").
		Find(&ops).Error; err != nil {
		return nil, err
	}
	enriched, err := s.enrichWithAccountNames(ctx, []models.CashShift{shift})
	if err != nil {
		return nil, err
	}
	return &ShiftDetail{Shift: enriched[0], Operations: ops}, nil
}
