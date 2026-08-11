// restaurants — глобальный CRUD ресторанов (Phase 10).
// Используется only Owner/superadmin level — в v4 локальный сервер, поэтому
// фильтрации по tenant нет (Raw()). Domain-операции (clear-operations / clear-menu /
// stats) выполняются строго по rid из path.
package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/repo"
)

//nolint:repolint
type RestaurantsService struct{ r *repo.Repo }

func NewRestaurantsService(r *repo.Repo) *RestaurantsService { return &RestaurantsService{r: r} }

type RestaurantCreateInput struct {
	Name           *string `json:"name,omitempty"`
	Slug           *string `json:"slug,omitempty"`
	LogoURL        *string `json:"logo_url,omitempty"`
	Address        *string `json:"address,omitempty"`
	Phone          *string `json:"phone,omitempty"`
	Currency       *string `json:"currency,omitempty"`
	ServicePercent *string `json:"service_percent,omitempty"`
	// DiscountApprovalThreshold — скидка выше этого % требует одобрения
	// менеджера/владельца. Строка (decimal), как service_percent.
	DiscountApprovalThreshold *string `json:"discount_approval_threshold,omitempty"`
	Timezone                  *string `json:"timezone,omitempty"`
	EnforceStockCheck         *bool   `json:"enforce_stock_check,omitempty"`
	TechCardsEnabled          *bool   `json:"tech_cards_enabled,omitempty"`
	AutoReadyMode             *bool   `json:"auto_ready_mode,omitempty"`
	AutoReadyBufferMin        *int    `json:"auto_ready_buffer_min,omitempty"`
	PinLockEnabled            *bool   `json:"pin_lock_enabled,omitempty"`
	PinLockTimeoutMin         *int    `json:"pin_lock_timeout_min,omitempty"`
	SupplyAllowNeg            *bool   `json:"supply_allow_negative,omitempty"`
	OnScreenKbdEnabled        *bool   `json:"on_screen_keyboard_enabled,omitempty"`
	TablesEnabled             *bool   `json:"tables_enabled,omitempty"`
	KitchenOnPay              *bool   `json:"kitchen_on_pay,omitempty"`
	PosV2Default              *bool   `json:"pos_v2_default,omitempty"`
	// Доставка (052).
	DeliveryEnabled          *bool `json:"delivery_enabled,omitempty"`
	DeliveryContactsRequired *bool `json:"delivery_contacts_required,omitempty"`
	// Сортировать меню по продаваемости (060). Default false → алфавит.
	MenuSortBySales *bool `json:"menu_sort_by_sales,omitempty"`
	// Табло выдачи /board (072). BoardStations — CSV станций (пусто = все).
	// BoardLogoOpacity — яркость логотипа-фона, проценты 0–100.
	BoardStations    *string `json:"board_stations,omitempty"`
	BoardLogoOpacity *int    `json:"board_logo_opacity,omitempty"`
}

func (s *RestaurantsService) List(ctx context.Context) ([]models.Restaurant, error) {
	var rows []models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Order("created_at ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *RestaurantsService) Get(ctx context.Context, id string) (*models.Restaurant, error) {
	var r models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", id).First(&r).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	return &r, nil
}

func (s *RestaurantsService) Create(ctx context.Context, in RestaurantCreateInput) (*models.Restaurant, error) {
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	currency := "UZS"
	if in.Currency != nil && *in.Currency != "" {
		currency = *in.Currency
	}
	tz := "Asia/Tashkent"
	if in.Timezone != nil && *in.Timezone != "" {
		tz = *in.Timezone
	}
	r := &models.Restaurant{
		ID:                      uuid.NewString(),
		Name:                    *in.Name,
		Slug:                    in.Slug,
		LogoURL:                 in.LogoURL,
		Address:                 in.Address,
		Phone:                   in.Phone,
		Currency:                &currency,
		Timezone:                &tz,
		EnforceStockCheck:       in.EnforceStockCheck,
		TechCardsEnabled:        in.TechCardsEnabled,
		AutoReadyMode:           in.AutoReadyMode,
		AutoReadyBufferMin:      in.AutoReadyBufferMin,
		PinLockEnabled:          in.PinLockEnabled,
		PinLockTimeoutMin:       in.PinLockTimeoutMin,
		OnScreenKeyboardEnabled: in.OnScreenKbdEnabled,
		TablesEnabled:           in.TablesEnabled,
		KitchenOnPay:            in.KitchenOnPay,
		PosV2Default:            in.PosV2Default,
		MenuSortBySales:         in.MenuSortBySales,
		CreatedAt:               now,
		UpdatedAt:               now,
	}
	if in.SupplyAllowNeg != nil {
		r.SupplyAllowNeg = *in.SupplyAllowNeg
	} else {
		r.SupplyAllowNeg = true
	}
	if in.ServicePercent != nil {
		d, err := decimal.FromString(*in.ServicePercent)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad service_percent", err)
		}
		r.ServicePercent = d
	}
	if in.DiscountApprovalThreshold != nil {
		d, err := decimal.FromString(*in.DiscountApprovalThreshold)
		if err != nil || decimal.IsNegative(d) {
			return nil, apperrors.Wrap("VALIDATION", "bad discount_approval_threshold", err)
		}
		r.DiscountApprovalThreshold = d
	}
	if err := s.r.Raw().WithContext(ctx).Create(r).Error; err != nil {
		return nil, err
	}
	return r, nil
}

func (s *RestaurantsService) Patch(ctx context.Context, id string, in RestaurantCreateInput) (*models.Restaurant, error) {
	var existing models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.Slug != nil {
		updates["slug"] = *in.Slug
	}
	if in.LogoURL != nil {
		updates["logo_url"] = *in.LogoURL
	}
	if in.Address != nil {
		updates["address"] = *in.Address
	}
	if in.Phone != nil {
		updates["phone"] = *in.Phone
	}
	if in.Currency != nil {
		updates["currency"] = *in.Currency
	}
	if in.Timezone != nil {
		updates["timezone"] = *in.Timezone
	}
	if in.ServicePercent != nil {
		d, err := decimal.FromString(*in.ServicePercent)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad service_percent", err)
		}
		updates["service_percent"] = d
	}
	if in.DiscountApprovalThreshold != nil {
		d, err := decimal.FromString(*in.DiscountApprovalThreshold)
		if err != nil || decimal.IsNegative(d) {
			return nil, apperrors.Wrap("VALIDATION", "bad discount_approval_threshold", err)
		}
		updates["discount_approval_threshold"] = d
	}
	if in.EnforceStockCheck != nil {
		updates["enforce_stock_check"] = *in.EnforceStockCheck
	}
	if in.TechCardsEnabled != nil {
		updates["tech_cards_enabled"] = *in.TechCardsEnabled
	}
	if in.AutoReadyMode != nil {
		updates["auto_ready_mode"] = *in.AutoReadyMode
	}
	if in.AutoReadyBufferMin != nil {
		updates["auto_ready_buffer_min"] = *in.AutoReadyBufferMin
	}
	if in.PinLockEnabled != nil {
		updates["pin_lock_enabled"] = *in.PinLockEnabled
	}
	if in.PinLockTimeoutMin != nil {
		updates["pin_lock_timeout_min"] = *in.PinLockTimeoutMin
	}
	if in.SupplyAllowNeg != nil {
		updates["supply_allow_negative"] = *in.SupplyAllowNeg
	}
	if in.OnScreenKbdEnabled != nil {
		updates["on_screen_keyboard_enabled"] = *in.OnScreenKbdEnabled
	}
	if in.TablesEnabled != nil {
		updates["tables_enabled"] = *in.TablesEnabled
	}
	if in.KitchenOnPay != nil {
		updates["kitchen_on_pay"] = *in.KitchenOnPay
	}
	if in.PosV2Default != nil {
		updates["pos_v2_default"] = *in.PosV2Default
	}
	if in.MenuSortBySales != nil {
		updates["menu_sort_by_sales"] = *in.MenuSortBySales
	}
	if in.DeliveryEnabled != nil {
		updates["delivery_enabled"] = *in.DeliveryEnabled
	}
	if in.DeliveryContactsRequired != nil {
		updates["delivery_contacts_required"] = *in.DeliveryContactsRequired
	}
	if in.BoardStations != nil {
		updates["board_stations"] = *in.BoardStations
	}
	if in.BoardLogoOpacity != nil {
		op := *in.BoardLogoOpacity
		if op < 0 {
			op = 0
		} else if op > 100 {
			op = 100
		}
		updates["board_logo_opacity"] = op
	}
	if err := s.r.Raw().WithContext(ctx).Model(&models.Restaurant{}).
		Where("id = ?", id).Updates(updates).Error; err != nil {
		return nil, err
	}
	return s.Get(ctx, id)
}

func (s *RestaurantsService) Delete(ctx context.Context, id string) error {
	// Не разрешаем удалять, если есть orders или users.
	db := s.r.Raw().WithContext(ctx)
	var existing models.Restaurant
	if err := db.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return apperrors.ErrNotFound
		}
		return err
	}
	var cnt int64
	if err := db.Model(&models.Order{}).Where("restaurant_id = ?", id).Count(&cnt).Error; err != nil {
		return err
	}
	if cnt > 0 {
		return apperrors.Wrap("CONFLICT", "restaurant has orders", nil)
	}
	if err := db.Model(&models.User{}).Where("restaurant_id = ?", id).Count(&cnt).Error; err != nil {
		return err
	}
	if cnt > 0 {
		return apperrors.Wrap("CONFLICT", "restaurant has users", nil)
	}
	res := db.Where("id = ?", id).Delete(&models.Restaurant{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ClearOperations — полный операционный сброс ресторана: удаляет ВСЕ операции
// (заказы, смены, финоперации; склад: движения/накладные/инвентаризации/
// списания/возвраты/заготовки/хозрасходы; ЗП-историю, брони, журнал, плановые
// платежи, очередь печати) и ОБНУЛЯЕТ денормализованные балансы
// (ingredients.qty, financial_accounts.balance, suppliers.current_debt).
// Остаются справочники/настройка: номенклатура, поставщики, меню, техкарты,
// столы, зоны, сотрудники, счета (как записи), клиенты. Всё в одной транзакции
// (либо чистится целиком, либо никак). Счётчики — map (фронт суммирует).
type ClearOperationsResult struct {
	Counts map[string]int64 `json:"counts"`
}

func (s *RestaurantsService) ClearOperations(ctx context.Context, id string) (*ClearOperationsResult, error) {
	if err := requireOwner(ctx, s.r); err != nil {
		return nil, err
	}
	var existing models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	out := &ClearOperationsResult{Counts: map[string]int64{}}
	err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		// SkipHooks: массовый сброс НЕ должен плодить per-row audit_log/sync/
		// domain-события (иначе журнал сразу пере-наполнится своими же
		// удалениями, а sync захлебнётся тысячами событий). Для wipe это верно.
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		// acc — накопить RowsAffected удаления/обнуления в счётчик по ключу.
		acc := func(key string, res *gorm.DB) error {
			if res.Error != nil {
				return res.Error
			}
			out.Counts[key] += res.RowsAffected
			return nil
		}
		// delRest — удалить всю таблицу модели по restaurant_id.
		delRest := func(key string, model any) error {
			return acc(key, tx.Where("restaurant_id = ?", id).Delete(model))
		}
		// orderIDs — свежий подзапрос id заказов ресторана (не переиспользуем
		// один *gorm.DB дважды — билдер мутируется).
		orderIDs := func() *gorm.DB { return tx.Model(&models.Order{}).Select("id").Where("restaurant_id = ?", id) }

		// ── Заказы (дети → родитель) ──
		if err := acc("order_item_modifiers", tx.Where("order_item_id IN (?)",
			tx.Model(&models.OrderItem{}).Select("id").Where("order_id IN (?)", orderIDs()),
		).Delete(&models.OrderItemModifier{})); err != nil {
			return err
		}
		if err := acc("order_items", tx.Where("order_id IN (?)", orderIDs()).Delete(&models.OrderItem{})); err != nil {
			return err
		}
		if err := delRest("orders", &models.Order{}); err != nil {
			return err
		}

		// ── Финансы + кассовые смены ──
		if err := delRest("financial_operations", &models.FinancialOperation{}); err != nil {
			return err
		}
		// Капитал: взносы/изъятия собственника, в т.ч. авто «Взнос собственника —
		// начальный остаток» склада и счёта. Без очистки после сброса Баланс
		// показывал бы висящий капитал без актива (актив уже обнулён), а
		// повторный ввод начального остатка задваивал бы капитал.
		if err := delRest("equity_entries", &models.EquityEntry{}); err != nil {
			return err
		}
		if err := acc("cash_shift_operations", tx.Where("shift_id IN (?)",
			tx.Model(&models.CashShift{}).Select("id").Where("restaurant_id = ?", id),
		).Delete(&models.CashShiftOperation{})); err != nil {
			return err
		}
		if err := delRest("cash_shifts", &models.CashShift{}); err != nil {
			return err
		}
		if err := delRest("time_entries", &models.TimeEntry{}); err != nil {
			return err
		}

		// ── Склад: операции (строки-«дети» без restaurant_id — по родителю) ──
		if err := acc("stock_receipt_lines", tx.Where("receipt_id IN (?)",
			tx.Model(&models.StockReceipt{}).Select("id").Where("restaurant_id = ?", id),
		).Delete(&models.StockReceiptLine{})); err != nil {
			return err
		}
		if err := delRest("stock_receipts", &models.StockReceipt{}); err != nil {
			return err
		}
		if err := acc("stock_writeoff_lines", tx.Where("writeoff_id IN (?)",
			tx.Model(&models.StockWriteoff{}).Select("id").Where("restaurant_id = ?", id),
		).Delete(&models.StockWriteoffLine{})); err != nil {
			return err
		}
		if err := delRest("stock_writeoffs", &models.StockWriteoff{}); err != nil {
			return err
		}
		if err := acc("stock_return_lines", tx.Where("return_id IN (?)",
			tx.Model(&models.StockReturn{}).Select("id").Where("restaurant_id = ?", id),
		).Delete(&models.StockReturnLine{})); err != nil {
			return err
		}
		if err := delRest("stock_returns", &models.StockReturn{}); err != nil {
			return err
		}
		if err := acc("inventory_check_lines", tx.Where("check_id IN (?)",
			tx.Model(&models.InventoryCheck{}).Select("id").Where("restaurant_id = ?", id),
		).Delete(&models.InventoryCheckLine{})); err != nil {
			return err
		}
		if err := delRest("inventory_checks", &models.InventoryCheck{}); err != nil {
			return err
		}
		if err := delRest("stock_movements", &models.StockMovement{}); err != nil {
			return err
		}
		if err := delRest("semi_finished_stock", &models.SemiFinishedStock{}); err != nil {
			return err
		}
		if err := delRest("batch_cooking_logs", &models.BatchCookingLog{}); err != nil {
			return err
		}
		if err := delRest("supply_expenses", &models.SupplyExpense{}); err != nil {
			return err
		}

		// ── ЗП-история ──
		if err := delRest("salary_advances", &models.SalaryAdvance{}); err != nil {
			return err
		}
		if err := delRest("salary_deductions", &models.SalaryDeduction{}); err != nil {
			return err
		}
		if err := delRest("salary_worked_days", &models.SalaryWorkedDay{}); err != nil {
			return err
		}
		if err := delRest("salary_day_multipliers", &models.SalaryDayMultiplier{}); err != nil {
			return err
		}

		// ── Прочие операции (по выбору владельца — журнал и плановые платежи тоже) ──
		if err := delRest("reservations", &models.Reservation{}); err != nil {
			return err
		}
		if err := delRest("print_jobs", &models.PrintJob{}); err != nil {
			return err
		}
		if err := delRest("audit_log", &models.AuditLog{}); err != nil {
			return err
		}
		if err := delRest("recurring_payments", &models.RecurringPayment{}); err != nil {
			return err
		}

		// ── Обнуление денормализованных балансов (сами записи остаются) ──
		if err := acc("ingredients_zeroed", tx.Model(&models.Ingredient{}).
			Where("restaurant_id = ? AND qty <> 0", id).Update("qty", 0)); err != nil {
			return err
		}
		if err := acc("accounts_zeroed", tx.Model(&models.FinancialAccount{}).
			Where("restaurant_id = ? AND balance <> 0", id).Update("balance", 0)); err != nil {
			return err
		}
		if err := acc("suppliers_debt_cleared", tx.Model(&models.Supplier{}).
			Where("restaurant_id = ? AND current_debt <> 0", id).Update("current_debt", 0)); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ClearMenu — удалить меню ресторана: menu_items, menu_categories, tech_card_lines,
// modifier_groups, modifiers (через group_id).
type ClearMenuCounts struct {
	MenuItems      int64 `json:"menu_items"`
	MenuCategories int64 `json:"menu_categories"`
	TechCardLines  int64 `json:"tech_card_lines"`
	ModifierGroups int64 `json:"modifier_groups"`
	Modifiers      int64 `json:"modifiers"`
}

type ClearMenuResult struct {
	Counts ClearMenuCounts `json:"counts"`
}

func (s *RestaurantsService) ClearMenu(ctx context.Context, id string) (*ClearMenuResult, error) {
	if err := requireOwner(ctx, s.r); err != nil {
		return nil, err
	}
	var existing models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	out := &ClearMenuResult{}
	err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// modifiers через group_id IN modifier_groups ресторана.
		if err := tx.Model(&models.Modifier{}).
			Where("group_id IN (?)", tx.Model(&models.ModifierGroup{}).Select("id").Where("restaurant_id = ?", id)).
			Count(&out.Counts.Modifiers).Error; err != nil {
			return err
		}
		if err := tx.Where("group_id IN (?)", tx.Model(&models.ModifierGroup{}).Select("id").Where("restaurant_id = ?", id)).
			Delete(&models.Modifier{}).Error; err != nil {
			return err
		}

		// modifier_groups.
		res := tx.Where("restaurant_id = ?", id).Delete(&models.ModifierGroup{})
		if res.Error != nil {
			return res.Error
		}
		out.Counts.ModifierGroups = res.RowsAffected

		// tech_card_lines.
		res = tx.Where("restaurant_id = ?", id).Delete(&models.TechCardLine{})
		if res.Error != nil {
			return res.Error
		}
		out.Counts.TechCardLines = res.RowsAffected

		// menu_items.
		res = tx.Where("restaurant_id = ?", id).Delete(&models.MenuItem{})
		if res.Error != nil {
			return res.Error
		}
		out.Counts.MenuItems = res.RowsAffected

		// menu_categories.
		res = tx.Where("restaurant_id = ?", id).Delete(&models.MenuCategory{})
		if res.Error != nil {
			return res.Error
		}
		out.Counts.MenuCategories = res.RowsAffected
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Stats — агрегатные счётчики для ресторана.
type RestaurantStats struct {
	OrdersCount      int64           `json:"orders_count"`
	MenuItemsCount   int64           `json:"menu_items_count"`
	UsersCount       int64           `json:"users_count"`
	IngredientsCount int64           `json:"ingredients_count"`
	TotalRevenue     decimal.Decimal `json:"total_revenue"`
	LastOrderAt      *time.Time      `json:"last_order_at"`
}

func (s *RestaurantsService) Stats(ctx context.Context, id string) (*RestaurantStats, error) {
	var existing models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	out := &RestaurantStats{}
	db := s.r.Raw().WithContext(ctx)
	if err := db.Model(&models.Order{}).Where("restaurant_id = ?", id).Count(&out.OrdersCount).Error; err != nil {
		return nil, err
	}
	if err := db.Model(&models.MenuItem{}).Where("restaurant_id = ?", id).Count(&out.MenuItemsCount).Error; err != nil {
		return nil, err
	}
	if err := db.Model(&models.User{}).Where("restaurant_id = ?", id).Count(&out.UsersCount).Error; err != nil {
		return nil, err
	}
	if err := db.Model(&models.Ingredient{}).Where("restaurant_id = ?", id).Count(&out.IngredientsCount).Error; err != nil {
		return nil, err
	}
	// total_revenue — SUM(total_with_service) для закрытых заказов.
	var revAgg struct {
		Total decimal.Decimal `gorm:"column:total"`
	}
	if err := db.Model(&models.Order{}).
		Select("COALESCE(SUM(total_with_service), 0) AS total").
		Where("restaurant_id = ? AND status = ?", id, "closed").
		Scan(&revAgg).Error; err != nil {
		return nil, err
	}
	out.TotalRevenue = decimal.Normalize(revAgg.Total)
	// last_order_at.
	var last models.Order
	if err := db.Where("restaurant_id = ?", id).Order("created_at DESC").Limit(1).Find(&last).Error; err != nil {
		return nil, err
	}
	if last.ID != "" {
		t := last.CreatedAt
		out.LastOrderAt = &t
	}
	return out, nil
}
