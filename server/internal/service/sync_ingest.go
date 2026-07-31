package service

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/repo"
)

// SyncService — приём дельт на ЦЕНТРАЛЬНОМ узле (Фаза 2 multi-branch, ADR-003).
// Филиалы пушат сюда неотправленные строки sync_log; центральный узел делает
// upsert по row_id (идемпотентно) в свою БД — она становится сводной по сети.
//
// ВАЖНО: ingest НЕ скоупится по ресторану центрального узла — он хранит данные
// ВСЕХ филиалов сети (в payload уже есть restaurant_id/account_id). Поэтому
// используем Raw + явный upsert (легитимный сетевой агрегатор, не утечка).
//
// Режим «только нужное»: применяем известные сущности (перемещения), остальные
// пропускаем (forward-compat: новый филиал может прислать то, что старый центр
// ещё не умеет).
type SyncService struct {
	r *repo.Repo
}

func NewSyncService(r *repo.Repo) *SyncService {
	return &SyncService{r: r}
}

// SyncEntry — одна дельта в батче ingest.
type SyncEntry struct {
	Entity  string          `json:"entity"`
	RowID   string          `json:"row_id"`
	Op      string          `json:"op"`
	Payload json.RawMessage `json:"payload"`
}

// IngestInput — body POST /api/v1/sync/ingest.
type IngestInput struct {
	Entries []SyncEntry `json:"entries"`
}

// IngestResult — сколько дельт применено/пропущено.
type IngestResult struct {
	Applied int `json:"applied"`
	Skipped int `json:"skipped"`
}

// Ingest применяет батч UP-пушей на центральном узле — upsert по PK (центр
// зеркалит авторитетные данные филиала). Идемпотентно.
func (s *SyncService) Ingest(ctx context.Context, in IngestInput) (*IngestResult, error) {
	return s.apply(ctx, in, true, "")
}

// ApplyPulled применяет DOWN-pull на филиале — insert-if-absent (НЕ перезаписывает).
// Критично: получатель — авторитет по статусу received своих входящих перемещений;
// pull не должен откатить локальный received обратно в sent (гонка до up-sync).
//
// branchRestaurantID — id этого филиала (для сетевого меню: мастер → menu_items
// с merge, наследуемое из мастера, локальные цена/стоп сохраняются).
func (s *SyncService) ApplyPulled(ctx context.Context, in IngestInput, branchRestaurantID string) (*IngestResult, error) {
	return s.apply(ctx, in, false, branchRestaurantID)
}

func (s *SyncService) apply(ctx context.Context, in IngestInput, updateAll bool, branchID string) (*IngestResult, error) {
	res := &IngestResult{}
	for _, e := range in.Entries {
		switch e.Entity {
		case "stock_transfers":
			if err := s.applyTransfer(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "financial_operations":
			if err := s.applyFinancialOp(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "orders":
			if err := s.applyOrder(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "cash_shifts":
			if err := s.applyShift(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "cash_shift_operations":
			if err := s.applyShiftOp(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "users":
			if err := s.applyUser(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "menu_items":
			if err := s.applyMenuItem(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "tables":
			if err := s.applyTable(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "zones":
			if err := s.applyZone(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "ingredients":
			if err := s.applyIngredient(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "stock_movements":
			if err := s.applyStockMovement(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "stock_receipts":
			if err := s.applyStockReceipt(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "stock_writeoffs":
			if err := s.applyStockWriteoff(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "inventory_checks":
			if err := s.applyInventoryCheck(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "stock_returns":
			if err := s.applyStockReturn(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "suppliers":
			if err := s.applySupplier(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "supply_expenses":
			if err := s.applySupplyExpense(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "financial_accounts":
			if err := s.applyFinancialAccount(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "recurring_payments":
			if err := s.applyRecurringPayment(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "network_menu_items":
			if branchID == "" {
				res.Skipped++ // мастер-меню применяется только при down-pull на филиале
				continue
			}
			if err := s.applyNetworkMenu(ctx, e, branchID); err != nil {
				return nil, err
			}
			res.Applied++
		default:
			res.Skipped++ // неизвестная сущность — не роняем весь батч
		}
	}
	return res, nil
}

// applyNetworkMenu — распространение мастер-блюда сети в меню филиала (ADR-004).
// Наследуемые поля (name/category/station/unit) берём из мастера; локальные
// (price/is_available/emoji) НЕ трогаем. Нет локального блюда с этим master_id →
// создаём (цена = base_price, доступно). Есть → обновляем только наследуемое.
func (s *SyncService) applyNetworkMenu(ctx context.Context, e SyncEntry, branchID string) error {
	var m models.NetworkMenuItem
	if err := json.Unmarshal(e.Payload, &m); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid network_menu_items payload", err)
	}
	if m.ID == "" {
		return apperrors.Wrap("VALIDATION", "network_menu_items payload missing id", nil)
	}
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		var existing models.MenuItem
		err := tx.Where("restaurant_id = ? AND master_id = ?", branchID, m.ID).First(&existing).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			avail := true
			item := &models.MenuItem{
				ID: uuid.NewString(), MasterID: &m.ID, RestaurantID: &branchID,
				Name: &m.Name, Category: m.Category, Price: m.BasePrice,
				Station: m.Station, Unit: m.Unit, Emoji: m.Emoji, IsAvailable: &avail,
			}
			if err := tx.Create(item).Error; err != nil {
				return err
			}
			// Унаследованный от мастера товар — тоже часть меню ЭТОГО филиала:
			// пишем в sync_log филиала, чтобы обычный Pusher отправил его
			// central обратно (иначе central никогда не увидит товары сети в
			// branch-view меню конкретного филиала — только на филиале локально).
			return recordMenuItemsSync(tx, []string{item.ID})
		}
		if err != nil {
			return err
		}
		// Есть ли РЕАЛЬНОЕ изменение наследуемых полей? applyNetworkMenu вызывается
		// на КАЖДЫЙ down-pull (раз в --sync-interval-sec, т.е. постоянно, а не
		// только когда мастер реально поменялся) — без этой проверки
		// recordMenuItemsSync писал бы дельту каждый цикл ДАЖЕ без изменений,
		// а поскольку сама запись в sync_log тоже реплицируется на central —
		// получался бы бесконечный поток "изменений" туда-обратно (найдено
		// вживую на двухузловом стенде: одна и та же строка синкалась каждые
		// 5 секунд без остановки).
		if (existing.Name == nil || *existing.Name != m.Name) ||
			!strPtrEqual(existing.Category, m.Category) ||
			!strPtrEqual(existing.Station, m.Station) ||
			!strPtrEqual(existing.Unit, m.Unit) {
			if err := tx.Model(&models.MenuItem{}).Where("id = ?", existing.ID).
				Updates(map[string]any{
					"name": m.Name, "category": m.Category, "station": m.Station, "unit": m.Unit,
				}).Error; err != nil {
				return err
			}
			return recordMenuItemsSync(tx, []string{existing.ID})
		}
		return nil
	})
}

// onConflict — UpdateAll (upsert) или DoNothing (insert-if-absent) по id.
func onConflict(updateAll bool) clause.OnConflict {
	c := clause.OnConflict{Columns: []clause.Column{{Name: "id"}}}
	if updateAll {
		c.UpdateAll = true
	} else {
		c.DoNothing = true
	}
	return c
}

// applyTransfer — upsert перемещения + его строк из payload. На центральном
// узле это лишь запись документа (для сводки/доставки получателю); движения
// остатка НЕ выполняются — их сделает получатель при Receive у себя.
func (s *SyncService) applyTransfer(ctx context.Context, e SyncEntry, updateAll bool) error {
	var t models.StockTransfer
	if err := json.Unmarshal(e.Payload, &t); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid stock_transfers payload", err)
	}
	if t.ID == "" {
		return apperrors.Wrap("VALIDATION", "stock_transfers payload missing id", nil)
	}
	lines := t.Lines
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		// SkipHooks: реплицированные данные не аудируем и не рекордим повторно.
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		// upsert/insert самого перемещения (без ассоциаций).
		if err := tx.Omit("Lines").Clauses(conflict).Create(&t).Error; err != nil {
			return err
		}
		// строки.
		for i := range lines {
			l := lines[i]
			if err := tx.Clauses(conflict).Create(&l).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// applyOrder — upsert заказа + его позиций из payload (ADR-003 Фаза 5).
// Central получает точную копию терминального снимка заказа филиала
// (closed/cancelled/refunded); это голый upsert двух таблиц, а не вызов
// OrdersService — списание склада и создание financial_operations здесь
// НЕ выполняются повторно (у Order/OrderItem нет GORM-хуков, только
// императивный код внутри Close()/Cancel()/Refund() на филиале).
func (s *SyncService) applyOrder(ctx context.Context, e SyncEntry, updateAll bool) error {
	var p orderSyncPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid orders payload", err)
	}
	if p.ID == "" {
		return apperrors.Wrap("VALIDATION", "orders payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&p.Order).Error; err != nil {
			return err
		}
		for i := range p.Items {
			if err := tx.Clauses(conflict).Create(&p.Items[i]).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// applyShift — upsert кассовой смены из payload (ADR-003 «Central видит всё»,
// Ф1). В отличие от заказов, синкается на КАЖДОЕ сохранение (см.
// recordShiftSync) — central должен видеть агрегаты ещё открытой смены.
func (s *SyncService) applyShift(ctx context.Context, e SyncEntry, updateAll bool) error {
	var sh models.CashShift
	if err := json.Unmarshal(e.Payload, &sh); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid cash_shifts payload", err)
	}
	if sh.ID == "" {
		return apperrors.Wrap("VALIDATION", "cash_shifts payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&sh).Error
	})
}

// applyShiftOp — upsert/delete операции смены. INSERT приходит через
// generic-хук (trackedInsert), DELETE — явно из recordShiftOpDeleteSync
// (DeleteExpense/DeleteOperation на филиале); такой payload пуст, удаляем
// строго по RowID.
func (s *SyncService) applyShiftOp(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "cash_shift_operations delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.CashShiftOperation{}).Error
		})
	}
	var op models.CashShiftOperation
	if err := json.Unmarshal(e.Payload, &op); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid cash_shift_operations payload", err)
	}
	if op.ID == "" {
		return apperrors.Wrap("VALIDATION", "cash_shift_operations payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&op).Error
	})
}

// applyUser — upsert сотрудника из payload. PIN/Password несут json:"-" на
// models.User — payload их не содержит вовсе, поэтому реплицированная строка
// на central всегда с pin/password = NULL. LoginByPIN фильтрует
// "pin IS NOT NULL" (см. auth.go) — реплицированный сотрудник филиала физически
// не может залогиниться на central.
func (s *SyncService) applyUser(ctx context.Context, e SyncEntry, updateAll bool) error {
	var u models.User
	if err := json.Unmarshal(e.Payload, &u); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid users payload", err)
	}
	if u.ID == "" {
		return apperrors.Wrap("VALIDATION", "users payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&u).Error
	})
}

// applyMenuItem — upsert блюда меню (снапшот, Ф2). Delete отдельно не
// нужен — удаление на филиале всегда soft (is_deleted=true уже в payload,
// см. recordMenuItemsSync/SoftDeleteItem), обычный upsert его переносит.
func (s *SyncService) applyMenuItem(ctx context.Context, e SyncEntry, updateAll bool) error {
	var mi models.MenuItem
	if err := json.Unmarshal(e.Payload, &mi); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid menu_items payload", err)
	}
	if mi.ID == "" {
		return apperrors.Wrap("VALIDATION", "menu_items payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&mi).Error
	})
}

// applyTable — upsert/delete стола (Ф2). Delete — НАСТОЯЩИЙ (в отличие от
// menu_items): TablesWriteService.Delete делает hard DELETE, не soft.
func (s *SyncService) applyTable(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "tables delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.Table{}).Error
		})
	}
	var t models.Table
	if err := json.Unmarshal(e.Payload, &t); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid tables payload", err)
	}
	if t.ID == "" {
		return apperrors.Wrap("VALIDATION", "tables payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&t).Error
	})
}

// applyZone — upsert/delete зоны (Ф2). Delete — настоящий, как у tables.
func (s *SyncService) applyZone(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "zones delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.Zone{}).Error
		})
	}
	var z models.Zone
	if err := json.Unmarshal(e.Payload, &z); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid zones payload", err)
	}
	if z.ID == "" {
		return apperrors.Wrap("VALIDATION", "zones payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&z).Error
	})
}

// applyIngredient — upsert снапшота ингредиента (Ф3). Delete — настоящий
// (IngredientsWriteService.Delete/removeParentPhantomBacking), как у tables/
// zones. SkipHooks здесь избыточен для самой модели Ingredient (она не в
// trackedInsert), но консистентен с остальными apply*-функциями.
func (s *SyncService) applyIngredient(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "ingredients delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.Ingredient{}).Error
		})
	}
	var ing models.Ingredient
	if err := json.Unmarshal(e.Payload, &ing); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid ingredients payload", err)
	}
	if ing.ID == "" {
		return apperrors.Wrap("VALIDATION", "ingredients payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&ing).Error
	})
}

// applyStockMovement — upsert append-only события движения (Ф3). SkipHooks
// КРИТИЧЕН здесь: stockAfterCreate (audit/stock_hook.go) проверяет
// tx.Statement.SkipHooks первой строкой и отказывается от повторной
// денормализации ingredients.qty — central получает уже денормализованный
// снапшот отдельно (applyIngredient), «проигрывание» движения задвоило бы
// delta. Delete не нужен — движения не удаляются (append-only источник истины).
func (s *SyncService) applyStockMovement(ctx context.Context, e SyncEntry, updateAll bool) error {
	var mv models.StockMovement
	if err := json.Unmarshal(e.Payload, &mv); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid stock_movements payload", err)
	}
	if mv.ID == "" {
		return apperrors.Wrap("VALIDATION", "stock_movements payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&mv).Error
	})
}

// applyStockReceipt — upsert накладной приёмки + её строк (Ф4). Строки
// insert-only (см. разведку sync_docs.go) — upsert безопасен и на повторе.
func (s *SyncService) applyStockReceipt(ctx context.Context, e SyncEntry, updateAll bool) error {
	var p receiptSyncPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid stock_receipts payload", err)
	}
	if p.ID == "" {
		return apperrors.Wrap("VALIDATION", "stock_receipts payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&p.StockReceipt).Error; err != nil {
			return err
		}
		for i := range p.Lines {
			if err := tx.Clauses(conflict).Create(&p.Lines[i]).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// applyStockWriteoff — upsert списания + его строк (Ф4).
func (s *SyncService) applyStockWriteoff(ctx context.Context, e SyncEntry, updateAll bool) error {
	var p writeoffSyncPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid stock_writeoffs payload", err)
	}
	if p.ID == "" {
		return apperrors.Wrap("VALIDATION", "stock_writeoffs payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&p.StockWriteoff).Error; err != nil {
			return err
		}
		for i := range p.Lines {
			if err := tx.Clauses(conflict).Create(&p.Lines[i]).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// applyInventoryCheck — upsert инвентаризации + её строк (Ф4). Приходит
// дважды за жизненный цикл документа (Create=draft, Apply=applied) — upsert
// второй раз просто перезаписывает шапку тем же id, строки не меняются.
func (s *SyncService) applyInventoryCheck(ctx context.Context, e SyncEntry, updateAll bool) error {
	var p inventorySyncPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid inventory_checks payload", err)
	}
	if p.ID == "" {
		return apperrors.Wrap("VALIDATION", "inventory_checks payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&p.InventoryCheck).Error; err != nil {
			return err
		}
		for i := range p.Lines {
			if err := tx.Clauses(conflict).Create(&p.Lines[i]).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// applyStockReturn — upsert возврата поставщику + его строк (Ф4). Приходит
// дважды (CreateReturn, CancelReturn) — второй раз только шапка меняется
// (cancelled_at/cancelled_by), строки те же (перечитаны заново, содержимое
// идентично).
func (s *SyncService) applyStockReturn(ctx context.Context, e SyncEntry, updateAll bool) error {
	var p returnSyncPayload
	if err := json.Unmarshal(e.Payload, &p); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid stock_returns payload", err)
	}
	if p.ID == "" {
		return apperrors.Wrap("VALIDATION", "stock_returns payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&p.StockReturn).Error; err != nil {
			return err
		}
		for i := range p.Lines {
			if err := tx.Clauses(conflict).Create(&p.Lines[i]).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// applySupplier — upsert/delete снапшота поставщика (Ф4). Delete — настоящий
// (SuppliersService.Delete делает hard DELETE), как у tables/zones/ingredients.
func (s *SyncService) applySupplier(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "suppliers delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.Supplier{}).Error
		})
	}
	var sup models.Supplier
	if err := json.Unmarshal(e.Payload, &sup); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid suppliers payload", err)
	}
	if sup.ID == "" {
		return apperrors.Wrap("VALIDATION", "suppliers payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&sup).Error
	})
}

// applySupplyExpense — upsert append-only расхода снабжения (Ф4). Приходит
// через generic trackedInsert (recorder_hook.go), не explicit recordXSync —
// единственная точка создания (SupplyExpensesService.Create) никогда не
// обновляет/не удаляет строку. Delete не нужен.
func (s *SyncService) applySupplyExpense(ctx context.Context, e SyncEntry, updateAll bool) error {
	var se models.SupplyExpense
	if err := json.Unmarshal(e.Payload, &se); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid supply_expenses payload", err)
	}
	if se.ID == "" {
		return apperrors.Wrap("VALIDATION", "supply_expenses payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&se).Error
	})
}

// PullFor — сторона ЦЕНТРАЛЬНОГО узла: дельты, адресованные филиалу
// restaurantID (down-sync, ADR-003 Фаза 2). Пока — входящие перемещения в
// статусе sent (получатель ещё не принял). Возвращаем в формате ingest, чтобы
// филиал применил их своим же Ingest (upsert). Идемпотентно и без курсора:
// после приёма статус станет received и перестанет попадать в выборку.
func (s *SyncService) PullFor(ctx context.Context, restaurantID string) (*IngestInput, error) {
	if restaurantID == "" {
		return nil, apperrors.Wrap("VALIDATION", "restaurant_id is required", nil)
	}
	var transfers []models.StockTransfer
	if err := s.r.Raw().WithContext(ctx).
		Preload("Lines").
		Where("to_restaurant_id = ? AND status = ?", restaurantID, "sent").
		Order("created_at ASC").
		Find(&transfers).Error; err != nil {
		return nil, err
	}
	out := &IngestInput{Entries: make([]SyncEntry, 0, len(transfers))}
	for i := range transfers {
		payload, err := json.Marshal(transfers[i])
		if err != nil {
			return nil, err
		}
		out.Entries = append(out.Entries, SyncEntry{
			Entity: "stock_transfers", RowID: transfers[i].ID, Op: "insert", Payload: payload,
		})
	}

	// Мастер-меню сети (ADR-004) — филиал наследует его целиком.
	var rest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Select("account_id").Where("id = ?", restaurantID).First(&rest).Error; err == nil &&
		rest.AccountID != nil && *rest.AccountID != "" {
		var master []models.NetworkMenuItem
		if err := s.r.Raw().WithContext(ctx).Where("account_id = ?", *rest.AccountID).Find(&master).Error; err != nil {
			return nil, err
		}
		for i := range master {
			payload, err := json.Marshal(master[i])
			if err != nil {
				return nil, err
			}
			out.Entries = append(out.Entries, SyncEntry{
				Entity: "network_menu_items", RowID: master[i].ID, Op: "upsert", Payload: payload,
			})
		}
	}
	return out, nil
}

// applyFinancialOp — upsert денежной операции из payload (для сводки владельцу).
// Только запись строки; балансы счетов на центральном узле НЕ трогаем (они —
// производные операций филиала, сводку считаем из financial_operations).
// Delete (Ф5) — закрывает пробел: DeleteExpense/DeleteOperation на филиале
// реально удаляют связанную финоперацию при отмене кассового расхода.
func (s *SyncService) applyFinancialOp(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "financial_operations delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.FinancialOperation{}).Error
		})
	}
	var op models.FinancialOperation
	if err := json.Unmarshal(e.Payload, &op); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid financial_operations payload", err)
	}
	if op.ID == "" {
		return apperrors.Wrap("VALIDATION", "financial_operations payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&op).Error
	})
}

// applyFinancialAccount — upsert/delete снапшота счёта (Ф5). Приходит на
// каждый Create/Update (generic trackedSave-хук, synclog/recorder_hook.go) —
// частота ≈ каждая денежная операция в системе, central всегда видит
// актуальный баланс филиала. Delete — настоящий (hard, FinancialAccountsService.
// Delete), как у suppliers/ingredients/tables.
func (s *SyncService) applyFinancialAccount(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "financial_accounts delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.FinancialAccount{}).Error
		})
	}
	var acc models.FinancialAccount
	if err := json.Unmarshal(e.Payload, &acc); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid financial_accounts payload", err)
	}
	if acc.ID == "" {
		return apperrors.Wrap("VALIDATION", "financial_accounts payload missing id", nil)
	}
	// IsEnabled — bool (не указатель) с gorm:"default:true": GORM's
	// ConvertToCreateValues (callbacks/create.go) БЕЗУСЛОВНО подменяет
	// zero-значение поля (false) значением из default-тега (true) при
	// Create()/ON CONFLICT DO UPDATE — это внутренняя логика построения
	// VALUES, Select("*")/Omit её не отключают (проверено чтением исходников
	// GORM). Хуже: подмена пишет исправленное значение ОБРАТНО в саму
	// переданную структуру (field.Set(...)) — поэтому значение нужно
	// захватить ДО Create(), иначе acc.IsEnabled к моменту форс-апдейта уже
	// испорчено самим Create(). Map-based Update этой подмене не подвержен
	// (другой путь в GORM — ConvertToAssignments, не ConvertToCreateValues).
	wantEnabled := acc.IsEnabled
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&acc).Error; err != nil {
			return err
		}
		return tx.Model(&models.FinancialAccount{ID: acc.ID}).Update("is_enabled", wantEnabled).Error
	})
}

// applyRecurringPayment — upsert/delete снапшота регулярного платежа (Ф5).
// Delete — настоящий (hard, RecurringPaymentsService.Delete).
func (s *SyncService) applyRecurringPayment(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "recurring_payments delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.RecurringPayment{}).Error
		})
	}
	var rp models.RecurringPayment
	if err := json.Unmarshal(e.Payload, &rp); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid recurring_payments payload", err)
	}
	if rp.ID == "" {
		return apperrors.Wrap("VALIDATION", "recurring_payments payload missing id", nil)
	}
	// Active — та же ловушка, что у FinancialAccount.IsEnabled (bool +
	// gorm:"default:true", см. подробный комментарий в applyFinancialAccount) —
	// захватываем ДО Create(), которая испортит rp.Active обратной записью.
	wantActive := rp.Active
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&rp).Error; err != nil {
			return err
		}
		return tx.Model(&models.RecurringPayment{ID: rp.ID}).Update("active", wantActive).Error
	})
}
