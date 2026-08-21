package service

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
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
		case "money_transfers":
			if err := s.applyMoneyTransfer(ctx, e, updateAll); err != nil {
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
		case "time_entries":
			if err := s.applyTimeEntry(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "salary_worked_days":
			if err := s.applySalaryWorkedDay(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "salary_day_multipliers":
			if err := s.applySalaryDayMultiplier(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "salary_deductions":
			if err := s.applySalaryDeduction(ctx, e, updateAll); err != nil {
				return nil, err
			}
			res.Applied++
		case "salary_advances":
			if err := s.applySalaryAdvance(ctx, e, updateAll); err != nil {
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
		case "nomenclature":
			if err := s.applyNomenclature(ctx, e, branchID); err != nil {
				return nil, err
			}
			res.Applied++
		case "restaurants":
			if branchID == "" {
				res.Skipped++ // только down-pull на филиале — central сам заводит соседей через RedeemInvite, не через этот путь
				continue
			}
			if err := s.applyRestaurantStub(ctx, e); err != nil {
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

// applyNomenclature — распространение общего каталога номенклатуры сети на
// филиал (ADR-003 вариант 3B). В отличие от applyNetworkMenu, строка сети И
// строка филиала — ОДНА и та же запись (тот же id: ingredients.nomenclature_id
// ссылается на него одинаково на любом узле) — обычный upsert по id, без
// производной локальной копии.
//
// Фаза М — авто-материализация: следом заводим у филиала сам ТОВАР с нулевым
// остатком. Без этого запись в каталоге сети оставалась чистой абстракцией:
// владелец создавал продукт в центре, на складах филиалов не менялось ничего,
// и товар появлялся там только после первого перемещения. Ожидание владельца
// («создал в центре → есть у всех») теперь выполняется буквально.
//
// Если у филиала уже есть свой товар с тем же именем и единицей — он
// СВЯЗЫВАЕТСЯ с номенклатурой, а не дублируется (см. ensureNomenclatureIngredient).
//
// Направление ОБА (Фаза Г): вниз — распространение каталога, вверх — запись,
// которую завёл филиал (руками или автоматически при первой отправке товара).
// branchID == "" означает приём на central: там только пишем строку каталога,
// без материализации товара — у central свой склад и своя номенклатура ему
// материализуется в CreateNomenclature, а заводить у себя товары всех филиалов
// он не должен.
func (s *SyncService) applyNomenclature(ctx context.Context, e SyncEntry, branchID string) error {
	var n models.Nomenclature
	if err := json.Unmarshal(e.Payload, &n); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid nomenclature payload", err)
	}
	if n.ID == "" {
		return apperrors.Wrap("VALIDATION", "nomenclature payload missing id", nil)
	}
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(onConflict(true)).Create(&n).Error; err != nil {
			return err
		}
		if branchID == "" {
			return nil // приём на central: только запись каталога, без товара
		}
		name := n.Name
		_, err := ensureNomenclatureIngredient(tx, branchID, ensureIngredientInput{
			NomenclatureID: &n.ID,
			Name:           &name,
			Unit:           n.Unit,
			PricePerUnit:   decimal.Zero, // цену задаст первая приёмка/перемещение
			Now:            time.Now().UTC(),
		})
		return err
	})
}

// applyRestaurantStub — заводит/обновляет НА ФИЛИАЛЕ заглушку-строку соседа
// по сети (central или другой филиал) — только для cross-node ссылок
// (to_restaurant_id в перемещениях, ListBranches-дропдаун), НЕ реальные
// бизнес-данные соседа. Явный список колонок (не UpdateAll) — у Restaurant
// десятки полей (license_key/license_expires_at/settings и т.д.), которых в
// этом зеркале нет и заведомо не будет; UpdateAll затёр бы их NULL при
// каждом pull, если бы id когда-нибудь совпал с чем-то настоящим.
func (s *SyncService) applyRestaurantStub(ctx context.Context, e SyncEntry) error {
	var r models.Restaurant
	if err := json.Unmarshal(e.Payload, &r); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid restaurants payload", err)
	}
	if r.ID == "" {
		return apperrors.Wrap("VALIDATION", "restaurants payload missing id", nil)
	}
	stub := models.Restaurant{ID: r.ID, Name: r.Name, AccountID: r.AccountID, Kind: r.Kind}
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		// Select — иначе Create() шлёт INSERT со ВСЕМИ полями модели (Currency/
		// ServicePercent/... на zero-value); default-теги GORM для указателей
		// омитит не всегда надёжно (см. gorm-zero-value-default-tag-gotcha).
		// Явный список колонок — и для insert, и для conflict-update — снимает
		// вопрос целиком.
		return tx.Select("id", "name", "account_id", "kind").Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "id"}},
			DoUpdates: clause.AssignmentColumns([]string{"name", "account_id", "kind"}),
		}).Create(&stub).Error
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

// applyStatusEcho — ЕДИНСТВЕННОЕ обновление, разрешённое поверх
// insert-if-absent при down-pull на филиале (Фаза Д2): перевод статуса
// sent → received у документа, который филиал ОТПРАВИЛ.
//
// Зачем: получатель принимает документ у себя и пушит новый статус на central,
// но обратно отправителю central его не отдавал никогда — PullFor выбирал
// только доки, адресованные текущему узлу. У отправителя документ навсегда
// оставался «отправлено», хотя товар/деньги давно приняты (баг виден в 2 из 3
// топологий: филиал→central и филиал→филиал; central→филиал работал случайно,
// потому что там central обновляется прямым пушем получателя).
//
// Почему это не ломает insert-if-absent, ради которого pull вообще не
// перезатирает локальные строки: переход разрешён РОВНО ОДИН, вперёд, и
// зашит в WHERE status='sent'. Отсюда сразу три свойства:
//   - откатить локальный received обратно в sent невозможно (гонка «central
//     ещё sent, филиал уже received» — исходная причина insert-if-absent);
//   - идемпотентность: второй pull того же received матчит 0 строк;
//   - нет бесконечного цикла репликации (см. sync-replication-infinite-loop):
//     запись происходит только когда статус РЕАЛЬНО меняется, а сравнение
//     атомарно в самом UPDATE, а не read-then-compare.
//
// to_account_id получателя намеренно НЕ эхуем: это UUID из ЕГО БД, на стороне
// отправителя он не резолвится ни во что осмысленное.
func applyStatusEcho(tx *gorm.DB, table, rowID, status string, receivedAt *time.Time, receivedBy *string) error {
	if status != "received" || rowID == "" {
		return nil
	}
	return tx.Table(table).
		Where("id = ? AND status = ?", rowID, "sent").
		Updates(map[string]any{
			"status":      "received",
			"received_at": receivedAt,
			"received_by": receivedBy,
			"updated_at":  time.Now().UTC(),
		}).Error
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
		if !updateAll {
			// Филиал: единственный разрешённый апдейт — эхо приёма отправителю.
			return applyStatusEcho(tx, "stock_transfers", t.ID, t.Status, t.ReceivedAt, t.ReceivedBy)
		}
		return nil
	})
}

// applyMoneyTransfer — то же для денежного перевода (Фаза Д). Только запись
// документа: балансы счетов НЕ трогаются ни на одной стороне — списание уже
// сделал отправитель у себя (Create), зачисление сделает получатель, когда
// нажмёт «принять» (Receive). Иначе деньги удвоились бы на каждом pull.
func (s *SyncService) applyMoneyTransfer(ctx context.Context, e SyncEntry, updateAll bool) error {
	var t models.MoneyTransfer
	if err := json.Unmarshal(e.Payload, &t); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid money_transfers payload", err)
	}
	if t.ID == "" {
		return apperrors.Wrap("VALIDATION", "money_transfers payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		if err := tx.Clauses(conflict).Create(&t).Error; err != nil {
			return err
		}
		if !updateAll {
			return applyStatusEcho(tx, "money_transfers", t.ID, t.Status, t.ReceivedAt, t.ReceivedBy)
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
// mirrorSince — курсор для зеркальных расходов (Фаза Р), который присылает САМ
// филиал: «самая свежая зеркальная проводка, которая у меня уже есть».
//
// Почему курсор именно от филиала, а не окно по дате на стороне central: всё
// остальное в down-sync самоограничено (каталог сети конечен, перемещения
// перестают выбираться после приёма), а зеркала расходов копятся без предела —
// отдавать их целиком каждые 20-30 секунд нельзя. Окно «за последние N дней»
// было бы проще, но у него есть режим тихой потери: касса, простоявшая офлайн
// дольше N, никогда не узнала бы о выплате, и её зарплатный кап перестал бы
// видеть уже выплаченное — то есть вернулся бы риск ДВОЙНОЙ выплаты, ради
// закрытия которого вся зеркальная схема и существует. Филиал же знает
// достоверно, что у него есть, сколько бы он ни отсутствовал.
//
// Сравнение идёт по created_at, проставленному ЦЕНТРОМ (филиал сохраняет то же
// значение из payload), поэтому расхождение часов между узлами на него не
// влияет. Граница нестрогая (>=) — при совпадении меток в одну секунду лучше
// прислать лишнее: применение идемпотентно (insert-if-absent по id).
func (s *SyncService) PullFor(ctx context.Context, restaurantID string, mirrorSince *time.Time) (*IngestInput, error) {
	if restaurantID == "" {
		return nil, apperrors.Wrap("VALIDATION", "restaurant_id is required", nil)
	}
	// Входящие (принять у себя) + Фаза Д2: СВОИ отправленные, которые получатель
	// уже принял — иначе у отправителя документ навсегда «отправлено»
	// (см. applyStatusEcho). Один запрос вместо двух: обе выборки узкие и
	// покрыты индексами по from/to.
	var transfers []models.StockTransfer
	if err := s.r.Raw().WithContext(ctx).
		Preload("Lines").
		Where("(to_restaurant_id = ? AND status = ?) OR (from_restaurant_id = ? AND status = ?)",
			restaurantID, "sent", restaurantID, "received").
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

	// Денежные переводы (Фаза Д) — та же пара выборок, тот же смысл.
	var money []models.MoneyTransfer
	if err := s.r.Raw().WithContext(ctx).
		Where("(to_restaurant_id = ? AND status = ?) OR (from_restaurant_id = ? AND status = ?)",
			restaurantID, "sent", restaurantID, "received").
		Order("created_at ASC").
		Find(&money).Error; err != nil {
		return nil, err
	}
	for i := range money {
		payload, err := json.Marshal(money[i])
		if err != nil {
			return nil, err
		}
		out.Entries = append(out.Entries, SyncEntry{
			Entity: "money_transfers", RowID: money[i].ID, Op: "insert", Payload: payload,
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

		// Номенклатура сети (ADR-003, вариант 3B) — тем же путём, что и мастер-меню
		// выше: central целиком отдаёт СВОЙ локальный каталог на каждый pull
		// (account-scoped, без курсора). Раньше эта строка отсутствовала — товар,
		// заведённый в номенклатуре на central, никогда не попадал на филиал
		// (найдено вживую: «рис» создан на central, на филиале не появился).
		var nomenclature []models.Nomenclature
		if err := s.r.Raw().WithContext(ctx).Where("account_id = ?", *rest.AccountID).Find(&nomenclature).Error; err != nil {
			return nil, err
		}
		for i := range nomenclature {
			payload, err := json.Marshal(nomenclature[i])
			if err != nil {
				return nil, err
			}
			out.Entries = append(out.Entries, SyncEntry{
				Entity: "nomenclature", RowID: nomenclature[i].ID, Op: "upsert", Payload: payload,
			})
		}

		// Соседи по сети (central + прочие филиалы) — тем же путём. Филиал
		// узнаёт о central только из JoinNetwork (account_id + sync_settings),
		// но НИКОГДА не заводит у себя саму строку central как restaurants —
		// поэтому «Перемещения» (CreateTransfer ищет to_restaurant_id в
		// ЛОКАЛЬНОЙ restaurants) и ListBranches (dropdown получателя) не
		// видели вообще никого, включая central. Central после RedeemInvite
		// уже видит ВСЕХ (см. фикс v3.16.293) — отдаём филиалу зеркало этого
		// же списка, себя самого исключаем (сам о себе и так всё знает,
		// перезаписывать НЕ должны — задел бы license_key/license_expires_at
		// и остальные поля, которых в этом зеркале нет и быть не может).
		// Найдено вживую: «в перемещении нет филиала пишет» (2026-08-20).
		var neighbors []models.Restaurant
		if err := s.r.Raw().WithContext(ctx).
			Where("account_id = ? AND id != ?", *rest.AccountID, restaurantID).
			Find(&neighbors).Error; err != nil {
			return nil, err
		}
		for i := range neighbors {
			payload, err := json.Marshal(neighbors[i])
			if err != nil {
				return nil, err
			}
			out.Entries = append(out.Entries, SyncEntry{
				Entity: "restaurants", RowID: neighbors[i].ID, Op: "upsert", Payload: payload,
			})
		}

		// Зеркала расходов, которые центр оплатил ЗА этот филиал (Фаза Р).
		// Именно они делают затрату видимой в ОПиУ филиала и — критично —
		// в его зарплатном капе, который иначе не знал бы о выплате и
		// разрешил бы выплатить второй раз. Курсор mirrorSince — см. выше.
		mirrors := s.r.Raw().WithContext(ctx).
			Where("target_restaurant_id = ?", restaurantID)
		if mirrorSince != nil {
			mirrors = mirrors.Where("created_at >= ?", *mirrorSince)
		}
		var ops []models.FinancialOperation
		if err := mirrors.Order("created_at ASC").Find(&ops).Error; err != nil {
			return nil, err
		}
		for i := range ops {
			// Филиалу уезжает ЗЕРКАЛО, а не проводка центра: у него не должно
			// быть ни счёта плательщика, ни признака «заплатил за кого-то»;
			// вместо этого — «за нас заплатил вот этот узел».
			m := ops[i]
			m.ID = mirrorOpID(ops[i].ID)
			m.AccountID, m.AccountName = nil, nil
			m.TargetRestaurantID = nil
			m.PaidByRestaurantID = m.RestaurantID
			m.RestaurantID = &restaurantID
			m.ShiftID = nil // смена — понятие кассы плательщика, у филиала её нет
			payload, err := json.Marshal(m)
			if err != nil {
				return nil, err
			}
			out.Entries = append(out.Entries, SyncEntry{
				Entity: "financial_operations", RowID: m.ID, Op: "insert", Payload: payload,
			})
		}
	}
	return out, nil
}

// mirrorOpNS — фиксированное пространство имён для id зеркальных проводок.
// Значение произвольно, но менять его нельзя: от него зависит совпадение id
// при повторной доставке.
var mirrorOpNS = uuid.MustParse("6f1b7c2e-9d3a-4f58-8b21-0e5a7c9d4f10")

// mirrorOpID — id зеркальной проводки, ДЕТЕРМИНИРОВАННО выведенный из id
// проводки плательщика (UUIDv5).
//
// Свой id, а не общий с оригиналом, по двум причинам. Во-первых,
// financial_operations.id — первичный ключ: стоит обеим строкам оказаться в
// одной БД (а на центре так и есть, если он же и филиал в другой сети, или
// просто при разборе на копии базы), и вставка ломается либо, что хуже, одна
// строка молча затирает другую — платёж теряет счёт и исчезает из кассы.
// Во-вторых, id обязан быть ВОСПРОИЗВОДИМЫМ: зеркало отдаётся повторно, пока
// филиал не подтвердит его курсором, и каждая доставка должна попадать в ту же
// строку (insert-if-absent), а не плодить дубли зарплаты в его ОПиУ.
func mirrorOpID(sourceID string) string {
	return uuid.NewSHA1(mirrorOpNS, []byte(sourceID)).String()
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

// ─── Ф5б «Персонал» ─────────────────────────────────────────────────────────
// time_entries/salary_worked_days/salary_day_multipliers/salary_deductions/
// salary_advances — ни у одной нет bool/int-поля с gorm:"default:..." И
// зоной риска zero-value одновременно (Multiplier у salary_day_multipliers
// формально имеет default:2, но реально ВСЕГДА создаётся со значением 2 —
// payload из JSON никогда не даёт Go zero-value для этого поля, поэтому
// GORM-ловушка из applyFinancialAccount/applyRecurringPayment здесь физически
// не может сработать — обычный Create+OnConflict без force-Update.

func (s *SyncService) applyTimeEntry(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "time_entries delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.TimeEntry{}).Error
		})
	}
	var row models.TimeEntry
	if err := json.Unmarshal(e.Payload, &row); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid time_entries payload", err)
	}
	if row.ID == "" {
		return apperrors.Wrap("VALIDATION", "time_entries payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&row).Error
	})
}

func (s *SyncService) applySalaryWorkedDay(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "salary_worked_days delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.SalaryWorkedDay{}).Error
		})
	}
	var row models.SalaryWorkedDay
	if err := json.Unmarshal(e.Payload, &row); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid salary_worked_days payload", err)
	}
	if row.ID == "" {
		return apperrors.Wrap("VALIDATION", "salary_worked_days payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&row).Error
	})
}

func (s *SyncService) applySalaryDayMultiplier(ctx context.Context, e SyncEntry, updateAll bool) error {
	if e.Op == "delete" {
		if e.RowID == "" {
			return apperrors.Wrap("VALIDATION", "salary_day_multipliers delete missing row_id", nil)
		}
		return s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
			return tx.Where("id = ?", e.RowID).Delete(&models.SalaryDayMultiplier{}).Error
		})
	}
	var row models.SalaryDayMultiplier
	if err := json.Unmarshal(e.Payload, &row); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid salary_day_multipliers payload", err)
	}
	if row.ID == "" {
		return apperrors.Wrap("VALIDATION", "salary_day_multipliers payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&row).Error
	})
}

// applySalaryDeduction — только upsert: SalaryDeduction никогда не
// hard-удаляется (CancelDeduction — soft, cancelled_at/by), делать branch
// нет причин.
func (s *SyncService) applySalaryDeduction(ctx context.Context, e SyncEntry, updateAll bool) error {
	var row models.SalaryDeduction
	if err := json.Unmarshal(e.Payload, &row); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid salary_deductions payload", err)
	}
	if row.ID == "" {
		return apperrors.Wrap("VALIDATION", "salary_deductions payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&row).Error
	})
}

// applySalaryAdvance — только upsert: SalaryAdvance никогда не
// hard-удаляется (CancelAdvance — soft), тот же случай, что и deduction.
func (s *SyncService) applySalaryAdvance(ctx context.Context, e SyncEntry, updateAll bool) error {
	var row models.SalaryAdvance
	if err := json.Unmarshal(e.Payload, &row); err != nil {
		return apperrors.Wrap("VALIDATION", "invalid salary_advances payload", err)
	}
	if row.ID == "" {
		return apperrors.Wrap("VALIDATION", "salary_advances payload missing id", nil)
	}
	conflict := onConflict(updateAll)
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx).Session(&gorm.Session{SkipHooks: true})
		return tx.Clauses(conflict).Create(&row).Error
	})
}
