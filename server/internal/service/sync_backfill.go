package service

import (
	"context"
	"errors"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// Бэкфилл истории (ADR-003 «Central видит всё», Ф6): sync_log копит только
// НОВЫЕ дельты с момента, когда на узле включён пушер — филиал, работавший
// месяцы до этого (или до выхода очередной Ф1-Ф5 фазы), никогда не отправит
// СУЩЕСТВУЮЩИЕ строки, central увидит историю только «с сегодня». Backfill
// проходит по текущему состоянию каждой реплицируемой таблицы и enqueue'ит
// её в sync_log — теми же явными recordXSync-функциями, что и живые точки
// мутации (Ф1-Ф5), поэтому payload на central получается БИТ-В-БИТ той же
// формы, что и обычный sync — apply*-функциям всё равно, откуда пришла
// дельта.
//
// НЕ идемпотентно само по себе (повторный вызов пишет новые sync_log-строки
// для тех же исходных id) — идемпотентность обеспечивает central (upsert по
// id, тот же payload просто перезапишется тем же). Повторный забфилл —
// не баг, а осознанно дешёвая операция (см. Backfill).

// var, не const: тесты временно уменьшают размер страницы, чтобы проверить
// многостраничную пагинацию без создания 500+ строк-фикстур.
var backfillBatchSize = 500

// backfillPageIDs — одна страница id (ASC) по проивольному WHERE-условию,
// с курсором id > lastID (exclusive, пусто на первой странице). where/args —
// условие БЕЗ курсора (курсор добавляется отдельно) — так каждая сущность
// свободна в том, как именно она скоупится по ресторану (прямая колонка
// restaurant_id, JOIN через родителя, from_restaurant_id и т.п.).
func backfillPageIDs(tx *gorm.DB, table, where string, args []any, lastID string) ([]string, error) {
	q := tx.Table(table).Where(where, args...)
	if lastID != "" {
		q = q.Where("id > ?", lastID)
	}
	var ids []string
	err := q.Order("id ASC").Limit(backfillBatchSize).Pluck("id", &ids).Error
	return ids, err
}

// backfillLoop — постраничный драйвер: тянет id пачками по backfillBatchSize
// (backfillPageIDs), на каждую пачку вызывает process (сам решает, что
// делать со списком id — вызвать recordXSync целиком списком, либо
// перечитать полные строки и вызвать per-row sync). Останавливается на
// первой пачке короче backfillBatchSize (или пустой). Возвращает суммарное
// число обработанных строк.
func backfillLoop(tx *gorm.DB, table, where string, args []any, process func(ids []string) error) (int64, error) {
	var total int64
	lastID := ""
	for {
		ids, err := backfillPageIDs(tx, table, where, args, lastID)
		if err != nil {
			return total, err
		}
		if len(ids) == 0 {
			return total, nil
		}
		if err := process(ids); err != nil {
			return total, err
		}
		total += int64(len(ids))
		lastID = ids[len(ids)-1]
		if len(ids) < backfillBatchSize {
			return total, nil
		}
	}
}

// backfillFetch — грузит полные строки по списку id (для сущностей, чья
// record-функция принимает *models.X, а не список id — recordOrderSync,
// recordShiftSync, recordUserSync, recordTableSync, recordZoneSync — плюс
// для «голых» sync_log-записей 5 generic-hook-only сущностей ниже).
func backfillFetch[T any](tx *gorm.DB, ids []string) ([]T, error) {
	var rows []T
	err := tx.Where("id IN ?", ids).Find(&rows).Error
	return rows, err
}

// backfillEntity — одна строка реестра.
type backfillEntity struct {
	name string
	run  func(tx *gorm.DB, rid string) (int64, error)
}

// backfillRegistry — 26 реплицируемых сущностей (Ф1-Ф5б + пред-Ф1 фундамент
// ADR-003 Фаза 2/5.1: orders, stock_transfers; Фаза Д: money_transfers;
// Фаза Г: nomenclature). Порядок — по фазам, в
// которых сущность появилась; central не имеет FK между таблицами (см.
// CLAUDE.md — tenant-целостность через код), порядок enqueue не влияет на
// корректность.
var backfillRegistry = []backfillEntity{
	// Фаза 2/5.1 (фундамент, до 8-фазного плана).
	{name: "orders", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "orders", "restaurant_id = ? AND status IN ('closed','cancelled','refunded')", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.Order](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := recordOrderSync(tx, &rows[i], "insert"); err != nil {
					return err
				}
			}
			return nil
		})
	}},
	{name: "stock_transfers", run: func(tx *gorm.DB, rid string) (int64, error) {
		// RestaurantID в Entry — всегда ORIGIN (см. CreateTransfer,
		// stock_transfer.go) — скоупим по from_restaurant_id, не to_, чтобы
		// не задвоить (получатель этот же transfer не пушит повторно).
		return backfillLoop(tx, "stock_transfers", "from_restaurant_id = ?", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.StockTransfer](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				var lines []models.StockTransferLine
				if err := tx.Where("transfer_id = ?", rows[i].ID).Find(&lines).Error; err != nil {
					return err
				}
				rows[i].Lines = lines
				if err := synclog.Record(tx, synclog.Entry{
					Entity: "stock_transfers", RowID: rows[i].ID, Op: "insert",
					RestaurantID: rows[i].FromRestaurantID, AccountID: rows[i].AccountID, Payload: rows[i],
				}); err != nil {
					return err
				}
			}
			return nil
		})
	}},

	// Фаза Г — общий каталог сети. Скоуп по account_id, а не restaurant_id:
	// таблица account-level, своего ресторана у записи нет. Нужен потому, что
	// филиал мог завести записи ДО подключения к сети (например, отправляя
	// товар в рамках прежней конфигурации) — без забфилла они остались бы
	// только у него.
	{name: "nomenclature", run: func(tx *gorm.DB, rid string) (int64, error) {
		var rest models.Restaurant
		err := tx.Select("account_id").Where("id = ?", rid).First(&rest).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// Строки ресторана нет — сети нет, каталога тоже. Молча пропускаем,
			// а не роняем: иначе одна отсутствующая строка обрывала бы забфилл
			// ВСЕХ остальных сущностей, и филиал уезжал бы на central пустым.
			return 0, nil
		}
		if err != nil {
			return 0, err
		}
		if rest.AccountID == nil || *rest.AccountID == "" {
			return 0, nil // не в сети — каталога у него и нет
		}
		return backfillLoop(tx, "nomenclature", "account_id = ?", []any{*rest.AccountID}, func(ids []string) error {
			return recordNomenclatureSync(tx, ids)
		})
	}},

	// Фаза Д — денежные переводы между узлами. Тот же скоуп по ОТПРАВИТЕЛЮ и по
	// той же причине, что у stock_transfers выше (не задваивать с получателем).
	{name: "money_transfers", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "money_transfers", "from_restaurant_id = ?", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.MoneyTransfer](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := synclog.Record(tx, synclog.Entry{
					Entity: "money_transfers", RowID: rows[i].ID, Op: "insert",
					RestaurantID: rows[i].FromRestaurantID, AccountID: rows[i].AccountID, Payload: rows[i],
				}); err != nil {
					return err
				}
			}
			return nil
		})
	}},

	// Ф1 — смены + сотрудники.
	{name: "cash_shifts", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "cash_shifts", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.CashShift](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := recordShiftSync(tx, &rows[i], "insert"); err != nil {
					return err
				}
			}
			return nil
		})
	}},
	{name: "cash_shift_operations", run: func(tx *gorm.DB, rid string) (int64, error) {
		// Таблица не несёт restaurant_id вовсе (см. 001_init.sql) — скоуп
		// только через родителя-смену. Тот же факт, что и в generic
		// trackedInsert-хуке для этой таблицы: RestaurantID в Entry всегда
		// nil (readStringField не находит поля) — воспроизводим то же самое
		// в backfill, не новый пробел, а существующее свойство таблицы.
		where := "shift_id IN (SELECT id FROM cash_shifts WHERE restaurant_id = ?)"
		return backfillLoop(tx, "cash_shift_operations", where, []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.CashShiftOperation](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := synclog.Record(tx, synclog.Entry{
					Entity: "cash_shift_operations", RowID: rows[i].ID, Op: "insert",
					Payload: rows[i],
				}); err != nil {
					return err
				}
			}
			return nil
		})
	}},
	{name: "users", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "users", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.User](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := recordUserSync(tx, &rows[i], "insert"); err != nil {
					return err
				}
			}
			return nil
		})
	}},

	// Ф2 — меню + столы/зоны.
	{name: "menu_items", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "menu_items", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			return recordMenuItemsSync(tx, ids)
		})
	}},
	{name: "tables", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "tables", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.Table](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := recordTableSync(tx, &rows[i], "insert"); err != nil {
					return err
				}
			}
			return nil
		})
	}},
	{name: "zones", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "zones", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.Zone](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := recordZoneSync(tx, &rows[i], "insert"); err != nil {
					return err
				}
			}
			return nil
		})
	}},

	// Ф3 — склад: остатки + движения.
	{name: "ingredients", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "ingredients", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			return recordIngredientSync(tx, ids)
		})
	}},
	{name: "stock_movements", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "stock_movements", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.StockMovement](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := synclog.Record(tx, synclog.Entry{
					Entity: "stock_movements", RowID: rows[i].ID, Op: "insert",
					RestaurantID: rows[i].RestaurantID, Payload: rows[i],
				}); err != nil {
					return err
				}
			}
			return nil
		})
	}},

	// Ф4 — складские документы.
	{name: "stock_receipts", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "stock_receipts", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			return recordReceiptSync(tx, ids)
		})
	}},
	{name: "stock_writeoffs", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "stock_writeoffs", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			return recordWriteoffSync(tx, ids)
		})
	}},
	{name: "inventory_checks", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "inventory_checks", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			return recordInventorySync(tx, ids)
		})
	}},
	{name: "stock_returns", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "stock_returns", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			return recordReturnSync(tx, ids)
		})
	}},
	{name: "suppliers", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "suppliers", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			return recordSupplierSync(tx, ids)
		})
	}},
	{name: "supply_expenses", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "supply_expenses", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.SupplyExpense](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := synclog.Record(tx, synclog.Entry{
					Entity: "supply_expenses", RowID: rows[i].ID, Op: "insert",
					RestaurantID: rows[i].RestaurantID, Payload: rows[i],
				}); err != nil {
					return err
				}
			}
			return nil
		})
	}},

	// Ф5 — деньги: счета + платежи.
	{name: "financial_accounts", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "financial_accounts", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.FinancialAccount](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := synclog.Record(tx, synclog.Entry{
					Entity: "financial_accounts", RowID: rows[i].ID, Op: "insert",
					RestaurantID: rows[i].RestaurantID, Payload: rows[i],
				}); err != nil {
					return err
				}
			}
			return nil
		})
	}},
	{name: "recurring_payments", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "recurring_payments", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			return recordRecurringPaymentSync(tx, ids)
		})
	}},
	{name: "financial_operations", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "financial_operations", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.FinancialOperation](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := synclog.Record(tx, synclog.Entry{
					Entity: "financial_operations", RowID: rows[i].ID, Op: "insert",
					RestaurantID: rows[i].RestaurantID, Payload: rows[i],
				}); err != nil {
					return err
				}
			}
			return nil
		})
	}},

	// Ф5б — персонал (табель + дневная оплата + удержания/авансы).
	{name: "time_entries", run: func(tx *gorm.DB, rid string) (int64, error) {
		// recordTimeEntrySync берёт id и перечитывает строку сам — тот же
		// вызов, что и на живых точках мутации (ClockIn/ClockOut/Patch).
		return backfillLoop(tx, "time_entries", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			for _, id := range ids {
				if err := recordTimeEntrySync(tx, id); err != nil {
					return err
				}
			}
			return nil
		})
	}},
	{name: "salary_worked_days", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "salary_worked_days", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.SalaryWorkedDay](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := recordSalaryWorkedDaySync(tx, &rows[i]); err != nil {
					return err
				}
			}
			return nil
		})
	}},
	{name: "salary_day_multipliers", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "salary_day_multipliers", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.SalaryDayMultiplier](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := recordSalaryDayMultiplierSync(tx, &rows[i]); err != nil {
					return err
				}
			}
			return nil
		})
	}},
	{name: "salary_deductions", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "salary_deductions", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.SalaryDeduction](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := recordSalaryDeductionSync(tx, &rows[i]); err != nil {
					return err
				}
			}
			return nil
		})
	}},
	{name: "salary_advances", run: func(tx *gorm.DB, rid string) (int64, error) {
		return backfillLoop(tx, "salary_advances", "restaurant_id = ?", []any{rid}, func(ids []string) error {
			rows, err := backfillFetch[models.SalaryAdvance](tx, ids)
			if err != nil {
				return err
			}
			for i := range rows {
				if err := recordSalaryAdvanceSync(tx, &rows[i]); err != nil {
					return err
				}
			}
			return nil
		})
	}},
}

// BackfillResult — итог по каждой сущности (число enqueued строк).
type BackfillResult struct {
	Entities map[string]int64 `json:"entities"`
}

// Backfill — только owner. Каждая сущность реестра — своя транзакция (не всё
// одной гигантской): падение на одной сущности не откатывает уже записанные
// предыдущие, и не держит одну многочасовую транзакцию на весь исторический
// объём ресторана. Внутри сущности — постраничный backfillLoop
// (backfillBatchSize строк за раз).
func (s *SyncService) Backfill(ctx context.Context, rid string) (*BackfillResult, error) {
	actor, _ := audit.ActorFromContext(ctx)
	if actor.Role != "owner" {
		return nil, apperrors.Wrap("FORBIDDEN", "только владелец может отправить историю на central", nil)
	}
	res := &BackfillResult{Entities: make(map[string]int64, len(backfillRegistry))}
	for _, e := range backfillRegistry {
		var n int64
		err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx)
			var runErr error
			n, runErr = e.run(tx, rid)
			return runErr
		})
		if err != nil {
			return res, apperrors.Wrap("INTERNAL", "backfill: "+e.name, err)
		}
		res.Entities[e.name] = n
	}
	return res, nil
}
