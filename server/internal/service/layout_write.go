// layout_write — write-операции для zones и tables (Phase 10 cutover).
//
// Zones: CRUD.
// Tables: CRUD + status/waiter/open-for-order/merge/unmerge + cleanup стуков.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ═══════════════════════════════════════════════════════════════════════════
// Zones write
// ═══════════════════════════════════════════════════════════════════════════

type ZonesWriteService struct{ r *repo.Repo }

func NewZonesWriteService(r *repo.Repo) *ZonesWriteService { return &ZonesWriteService{r: r} }

type ZoneInput struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
	SortOrder   *int    `json:"sort_order,omitempty"`
}

func (s *ZonesWriteService) Create(ctx context.Context, in ZoneInput) (*models.Zone, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	z := &models.Zone{
		ID:           uuid.NewString(),
		Name:         *in.Name,
		Description:  in.Description,
		SortOrder:    in.SortOrder,
		RestaurantID: &rid,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(z).Error; err != nil {
		return nil, err
	}
	return z, nil
}

func (s *ZonesWriteService) Patch(ctx context.Context, id string, in ZoneInput) (*models.Zone, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.Zone
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.Description != nil {
		updates["description"] = *in.Description
	}
	if in.SortOrder != nil {
		updates["sort_order"] = *in.SortOrder
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.Zone
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ZonesWriteService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	// FK check: есть ли столы, ссылающиеся на эту зону?
	var cnt int64
	if err := scoped.Model(&models.Table{}).Where("zone_id = ?", id).Count(&cnt).Error; err != nil {
		return err
	}
	if cnt > 0 {
		return apperrors.Wrap("CONFLICT", "zone is referenced by tables", nil)
	}
	scoped2, _ := s.r.ForTenant(ctx)
	res := scoped2.Where("id = ?", id).Delete(&models.Zone{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ═══════════════════════════════════════════════════════════════════════════
// Tables write
// ═══════════════════════════════════════════════════════════════════════════

type TablesWriteService struct{ r *repo.Repo }

func NewTablesWriteService(r *repo.Repo) *TablesWriteService { return &TablesWriteService{r: r} }

type TableInput struct {
	Name           *string `json:"name,omitempty"`
	Number         *int    `json:"number,omitempty"`
	Capacity       *int    `json:"capacity,omitempty"`
	ZoneID         *string `json:"zone_id,omitempty"`
	Status         *string `json:"status,omitempty"`
	CurrentOrderID *string `json:"current_order_id,omitempty"`
	WaiterID       *string `json:"waiter_id,omitempty"`
	OpenedAt       *string `json:"opened_at,omitempty"` // RFC3339
}

func (s *TablesWriteService) Create(ctx context.Context, in TableInput) (*models.Table, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Number == nil {
		return nil, apperrors.Wrap("VALIDATION", "number is required", nil)
	}
	now := time.Now().UTC()
	t := &models.Table{
		ID:           uuid.NewString(),
		Number:       in.Number,
		Name:         in.Name,
		Capacity:     in.Capacity,
		ZoneID:       in.ZoneID,
		Status:       in.Status,
		RestaurantID: &rid,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(t).Error; err != nil {
		return nil, err
	}
	return t, nil
}

func (s *TablesWriteService) Patch(ctx context.Context, id string, in TableInput) (*models.Table, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.Table
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.Number != nil {
		updates["number"] = *in.Number
	}
	if in.Capacity != nil {
		updates["capacity"] = *in.Capacity
	}
	if in.ZoneID != nil {
		updates["zone_id"] = *in.ZoneID
	}
	if in.Status != nil {
		updates["status"] = *in.Status
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.Table
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *TablesWriteService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	var existing models.Table
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return apperrors.ErrNotFound
		}
		return err
	}
	if existing.CurrentOrderID != nil && *existing.CurrentOrderID != "" {
		return apperrors.Wrap("CONFLICT", "table has an active order", nil)
	}
	scoped2, _ := s.r.ForTenant(ctx)
	res := scoped2.Where("id = ?", id).Delete(&models.Table{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// SetStatus — PATCH /tables/{id}/status. Атомарное изменение статуса + связанных полей.
func (s *TablesWriteService) SetStatus(ctx context.Context, id string, in TableInput) (*models.Table, error) {
	if in.Status == nil || *in.Status == "" {
		return nil, apperrors.Wrap("VALIDATION", "status is required", nil)
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.Table
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{
		"status":     *in.Status,
		"updated_at": time.Now().UTC(),
	}
	if in.CurrentOrderID != nil {
		updates["current_order_id"] = *in.CurrentOrderID
	}
	if in.WaiterID != nil {
		updates["waiter_id"] = *in.WaiterID
	}
	if in.OpenedAt != nil {
		t, err := time.Parse(time.RFC3339, *in.OpenedAt)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad opened_at", err)
		}
		updates["opened_at"] = t
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.Table
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

// AssignWaiterInput — body POST /tables/{id}/assign-waiter.
// WaiterID — *string чтобы можно было явно сбросить null'ом.
type AssignWaiterInput struct {
	WaiterID *string `json:"waiter_id"`
}

func (s *TablesWriteService) AssignWaiter(ctx context.Context, id string, in AssignWaiterInput) (*models.Table, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var out models.Table
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		scoped, err := tr.ForTenant(ctx)
		if err != nil {
			return err
		}
		var existing models.Table
		if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		// Snapshot old waiter for audit.
		var oldWaiterID string
		if existing.WaiterID != nil {
			oldWaiterID = *existing.WaiterID
		}
		var newWaiterID string
		if in.WaiterID != nil {
			newWaiterID = *in.WaiterID
		}
		updates := map[string]any{"updated_at": time.Now().UTC()}
		if in.WaiterID == nil {
			updates["waiter_id"] = nil
		} else {
			updates["waiter_id"] = *in.WaiterID
		}
		scoped2, _ := tr.ForTenant(ctx)
		if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
			return err
		}

		// Explicit audit_log entry with old/new waiter details.
		actor, _ := audit.ActorFromContext(ctx)
		action := "table.assign_waiter"
		entityType := "table"
		entityID := id
		details, _ := json.Marshal(map[string]any{
			"old_waiter_id": oldWaiterID,
			"new_waiter_id": newWaiterID,
			"table_id":      id,
		})
		entry := &models.AuditLog{
			ID:           uuid.NewString(),
			Action:       &action,
			EntityType:   &entityType,
			EntityID:     &entityID,
			RestaurantID: &rid,
			Details:      datatypes.JSON(details),
			CreatedAt:    time.Now().UTC(),
		}
		if actor.UserID != "" {
			u := actor.UserID
			entry.UserID = &u
		}
		if actor.UserName != "" {
			u := actor.UserName
			entry.UserName = &u
		}
		// SkipHooks: audit_log писать без рекурсии собственного хука.
		scopedA, _ := tr.ForTenant(ctx)
		if err := scopedA.Session(&gorm.Session{SkipHooks: true}).Create(entry).Error; err != nil {
			return err
		}

		scoped3, _ := tr.ForTenant(ctx)
		if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// OpenForOrderInput — body POST /tables/{id}/open-for-order.
type OpenForOrderInput struct {
	OrderID  *string `json:"order_id,omitempty"`
	WaiterID *string `json:"waiter_id,omitempty"`
}

func (s *TablesWriteService) OpenForOrder(ctx context.Context, id string, in OpenForOrderInput) (*models.Table, error) {
	if in.OrderID == nil || *in.OrderID == "" {
		return nil, apperrors.Wrap("VALIDATION", "order_id is required", nil)
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.Table
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	now := time.Now().UTC()
	updates := map[string]any{
		"status":           "occupied",
		"current_order_id": *in.OrderID,
		"opened_at":        now,
		"updated_at":       now,
	}
	if in.WaiterID != nil && *in.WaiterID != "" {
		updates["waiter_id"] = *in.WaiterID
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.Table
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

// MergeInput — body POST /tables/merge.
type MergeInput struct {
	PrimaryID   *string `json:"primary_id,omitempty"`
	SecondaryID *string `json:"secondary_id,omitempty"`
}

// MergeResult — что вернули.
type MergeResult struct {
	Primary   *models.Table `json:"primary"`
	Secondary *models.Table `json:"secondary"`
}

func (s *TablesWriteService) Merge(ctx context.Context, in MergeInput) (*MergeResult, error) {
	if in.PrimaryID == nil || *in.PrimaryID == "" ||
		in.SecondaryID == nil || *in.SecondaryID == "" {
		return nil, apperrors.Wrap("VALIDATION", "primary_id and secondary_id are required", nil)
	}
	if *in.PrimaryID == *in.SecondaryID {
		return nil, apperrors.Wrap("VALIDATION", "primary_id and secondary_id must differ", nil)
	}

	var result *MergeResult
	err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		scoped, err := tr.ForTenant(ctx)
		if err != nil {
			return err
		}
		var primary, secondary models.Table
		if err := scoped.Where("id = ?", *in.PrimaryID).First(&primary).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		scoped2, _ := tr.ForTenant(ctx)
		if err := scoped2.Where("id = ?", *in.SecondaryID).First(&secondary).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if secondary.MergedWith != nil && *secondary.MergedWith != "" {
			return apperrors.Wrap("CONFLICT", "secondary table already merged", nil)
		}

		now := time.Now().UTC()
		// Сохраняем original_capacity вторички, если ещё не сохранён.
		secUpdates := map[string]any{
			"merged_with": primary.ID,
			"status":      "merged",
			"updated_at":  now,
		}
		if secondary.OriginalCapacity == nil && secondary.Capacity != nil {
			secUpdates["original_capacity"] = *secondary.Capacity
		}

		// Увеличиваем capacity primary на capacity secondary.
		addCap := 0
		if secondary.Capacity != nil {
			addCap = *secondary.Capacity
		}
		newPrimaryCap := 0
		if primary.Capacity != nil {
			newPrimaryCap = *primary.Capacity
		}
		newPrimaryCap += addCap

		priUpdates := map[string]any{
			"capacity":   newPrimaryCap,
			"updated_at": now,
		}
		if primary.OriginalCapacity == nil && primary.Capacity != nil {
			priUpdates["original_capacity"] = *primary.Capacity
		}

		scoped3, _ := tr.ForTenant(ctx)
		if err := scoped3.Model(&secondary).Updates(secUpdates).Error; err != nil {
			return err
		}
		scoped4, _ := tr.ForTenant(ctx)
		if err := scoped4.Model(&primary).Updates(priUpdates).Error; err != nil {
			return err
		}

		scoped5, _ := tr.ForTenant(ctx)
		var pri models.Table
		if err := scoped5.Where("id = ?", primary.ID).First(&pri).Error; err != nil {
			return err
		}
		scoped6, _ := tr.ForTenant(ctx)
		var sec models.Table
		if err := scoped6.Where("id = ?", secondary.ID).First(&sec).Error; err != nil {
			return err
		}
		result = &MergeResult{Primary: &pri, Secondary: &sec}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// Unmerge — POST /tables/{id}/unmerge. id — primary. Восстанавливает все secondary
// (merged_with = primary.id): возвращает им original_capacity, очищает merged_with,
// status='free'. Уменьшает primary.capacity на сумму возвращённых ёмкостей.
func (s *TablesWriteService) Unmerge(ctx context.Context, id string) (*models.Table, error) {
	var result *models.Table
	err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		scoped, err := tr.ForTenant(ctx)
		if err != nil {
			return err
		}
		var primary models.Table
		if err := scoped.Where("id = ?", id).First(&primary).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		scoped2, _ := tr.ForTenant(ctx)
		var secs []models.Table
		if err := scoped2.Where("merged_with = ?", id).Find(&secs).Error; err != nil {
			return err
		}
		if len(secs) == 0 {
			return apperrors.Wrap("CONFLICT", "no merged secondary tables", nil)
		}

		now := time.Now().UTC()
		removed := 0
		for i := range secs {
			sec := secs[i]
			restoreCap := 0
			if sec.OriginalCapacity != nil {
				restoreCap = *sec.OriginalCapacity
			} else if sec.Capacity != nil {
				restoreCap = *sec.Capacity
			}
			removed += restoreCap
			updates := map[string]any{
				"merged_with":       nil,
				"status":            "free",
				"capacity":          restoreCap,
				"original_capacity": nil,
				"updated_at":        now,
			}
			scopedU, _ := tr.ForTenant(ctx)
			if err := scopedU.Model(&sec).Updates(updates).Error; err != nil {
				return err
			}
		}

		// Восстанавливаем primary.capacity.
		newPrimaryCap := 0
		if primary.Capacity != nil {
			newPrimaryCap = *primary.Capacity
		}
		newPrimaryCap -= removed
		if newPrimaryCap < 0 {
			newPrimaryCap = 0
		}
		// Если primary имеет original_capacity и текущее значение совпадает с
		// (original+removed) — это полный откат, возвращаем original и обнуляем.
		priUpdates := map[string]any{
			"capacity":   newPrimaryCap,
			"updated_at": now,
		}
		if primary.OriginalCapacity != nil && newPrimaryCap == *primary.OriginalCapacity {
			priUpdates["original_capacity"] = nil
		}
		scopedP, _ := tr.ForTenant(ctx)
		if err := scopedP.Model(&primary).Updates(priUpdates).Error; err != nil {
			return err
		}

		scopedR, _ := tr.ForTenant(ctx)
		var out models.Table
		if err := scopedR.Where("id = ?", id).First(&out).Error; err != nil {
			return err
		}
		result = &out
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// CleanupStuck — POST /admin/cleanup/stuck-tables.
// «Стуками» считаем столы со status='occupied' и без current_order_id, либо
// с current_order_id указывающим на закрытый/отменённый order. Возвращаем им
// status='free'.
type CleanupResult struct {
	Cleaned int64 `json:"cleaned"`
}

func (s *TablesWriteService) CleanupStuck(ctx context.Context) (*CleanupResult, error) {
	var total int64
	err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		// 1. occupied без current_order_id.
		scoped1, err := tr.ForTenant(ctx)
		if err != nil {
			return err
		}
		res1 := scoped1.Model(&models.Table{}).
			Where("status = ? AND (current_order_id IS NULL OR current_order_id = '')", "occupied").
			Updates(map[string]any{
				"status":     "free",
				"updated_at": time.Now().UTC(),
			})
		if res1.Error != nil {
			return res1.Error
		}
		total += res1.RowsAffected

		// 2. occupied с current_order_id ссылающимся на closed/cancelled.
		scoped2, _ := tr.ForTenant(ctx)
		var stuck []models.Table
		if err := scoped2.
			Where("status = ? AND current_order_id IS NOT NULL AND current_order_id <> ''", "occupied").
			Find(&stuck).Error; err != nil {
			return err
		}
		for _, tb := range stuck {
			if tb.CurrentOrderID == nil {
				continue
			}
			scopedO, _ := tr.ForTenant(ctx)
			var o models.Order
			if err := scopedO.Where("id = ?", *tb.CurrentOrderID).First(&o).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					// order вообще нет — освобождаем.
					scopedU, _ := tr.ForTenant(ctx)
					if err := scopedU.Model(&models.Table{}).Where("id = ?", tb.ID).
						Updates(map[string]any{
							"status":           "free",
							"current_order_id": nil,
							"updated_at":       time.Now().UTC(),
						}).Error; err != nil {
						return err
					}
					total++
					continue
				}
				return err
			}
			if o.Status != nil && (*o.Status == "closed" || *o.Status == "cancelled") {
				scopedU, _ := tr.ForTenant(ctx)
				if err := scopedU.Model(&models.Table{}).Where("id = ?", tb.ID).
					Updates(map[string]any{
						"status":           "free",
						"current_order_id": nil,
						"updated_at":       time.Now().UTC(),
					}).Error; err != nil {
					return err
				}
				total++
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &CleanupResult{Cleaned: total}, nil
}
