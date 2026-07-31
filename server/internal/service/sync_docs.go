package service

import (
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// Складские документы (ADR-003 «Central видит всё», Ф4): приёмки, списания,
// инвентаризации, возвраты поставщику — снапшот по списку id, тем же приёмом,
// что и recordIngredientSync (sync_stock.go), НЕ одна строка на вызов: доменные
// операции регулярно задевают сразу несколько документов (allocateDebtPayment —
// FIFO-гашение долга по МНОГИМ накладным поставщика одним платежом).
//
// У всех четырёх документов дочерние строки insert-only (подтверждено разведкой:
// ни одна из lines-таблиц нигде не мутируется после создания) — поэтому один
// свежий SELECT дочерних строк внутри recordXSync полностью и навсегда описывает
// их состояние, повторный вызов на том же документе просто перечитывает то же
// самое (идемпотентно по содержанию, даже если сам вызов не идемпотентен по
// sync_log-строкам).

// receiptSyncPayload — снимок накладной приёмки + её строк.
type receiptSyncPayload struct {
	models.StockReceipt
	Lines []models.StockReceiptLine `json:"lines"`
}

// recordReceiptSync — накладная мутирует (не создаётся) в 3 местах, не
// связанных с самим CreateReceipt: PayReceipt (оплата), allocateDebtPayment
// (FIFO-гашение долга — потенциально МНОГО накладных одного поставщика),
// CreateReturn/CancelReturn (списывают/возвращают debt_amount накладной).
func recordReceiptSync(tx *gorm.DB, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	var receipts []models.StockReceipt
	if err := tx.Where("id IN ?", ids).Find(&receipts).Error; err != nil {
		return err
	}
	for i := range receipts {
		var lines []models.StockReceiptLine
		if err := tx.Where("receipt_id = ?", receipts[i].ID).Find(&lines).Error; err != nil {
			return err
		}
		if err := synclog.Record(tx, synclog.Entry{
			Entity:       "stock_receipts",
			RowID:        receipts[i].ID,
			Op:           "update",
			RestaurantID: receipts[i].RestaurantID,
			Payload:      receiptSyncPayload{StockReceipt: receipts[i], Lines: lines},
		}); err != nil {
			return err
		}
	}
	return nil
}

// writeoffSyncPayload — снимок списания + его строк.
type writeoffSyncPayload struct {
	models.StockWriteoff
	Lines []models.StockWriteoffLine `json:"lines"`
}

// recordWriteoffSync — вызывать ПОСЛЕ финального total_cost-патча шапки
// (CreateWriteoff пересчитывает сумму отдельным Update уже после вставки
// строк — снапшот, снятый раньше, ушёл бы на central с total_cost=0).
func recordWriteoffSync(tx *gorm.DB, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	var writeoffs []models.StockWriteoff
	if err := tx.Where("id IN ?", ids).Find(&writeoffs).Error; err != nil {
		return err
	}
	for i := range writeoffs {
		var lines []models.StockWriteoffLine
		if err := tx.Where("writeoff_id = ?", writeoffs[i].ID).Find(&lines).Error; err != nil {
			return err
		}
		if err := synclog.Record(tx, synclog.Entry{
			Entity:       "stock_writeoffs",
			RowID:        writeoffs[i].ID,
			Op:           "update",
			RestaurantID: writeoffs[i].RestaurantID,
			Payload:      writeoffSyncPayload{StockWriteoff: writeoffs[i], Lines: lines},
		}); err != nil {
			return err
		}
	}
	return nil
}

// inventorySyncPayload — снимок инвентаризации + её строк.
type inventorySyncPayload struct {
	models.InventoryCheck
	Lines []models.InventoryCheckLine `json:"lines"`
}

// recordInventorySync — вызывается дважды в жизненном цикле документа:
// на Create (status=draft, для видимости незавершённой инвентаризации на
// central) и на Apply (status=applied). RestaurantID на InventoryCheck —
// не указатель (в отличие от остальных трёх документов) — берём адрес поля.
func recordInventorySync(tx *gorm.DB, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	var checks []models.InventoryCheck
	if err := tx.Where("id IN ?", ids).Find(&checks).Error; err != nil {
		return err
	}
	for i := range checks {
		var lines []models.InventoryCheckLine
		if err := tx.Where("check_id = ?", checks[i].ID).Find(&lines).Error; err != nil {
			return err
		}
		if err := synclog.Record(tx, synclog.Entry{
			Entity:       "inventory_checks",
			RowID:        checks[i].ID,
			Op:           "update",
			RestaurantID: &checks[i].RestaurantID,
			Payload:      inventorySyncPayload{InventoryCheck: checks[i], Lines: lines},
		}); err != nil {
			return err
		}
	}
	return nil
}

// returnSyncPayload — снимок возврата поставщику + его строк.
type returnSyncPayload struct {
	models.StockReturn
	Lines []models.StockReturnLine `json:"lines"`
}

// recordReturnSync — вызывается на CreateReturn и на CancelReturn (сторно
// через cancelled_at, строки при отмене не мутируются — снапшот перечитывает
// их заново, но содержимое то же самое, меняется только шапка документа).
func recordReturnSync(tx *gorm.DB, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	var returns []models.StockReturn
	if err := tx.Where("id IN ?", ids).Find(&returns).Error; err != nil {
		return err
	}
	for i := range returns {
		var lines []models.StockReturnLine
		if err := tx.Where("return_id = ?", returns[i].ID).Find(&lines).Error; err != nil {
			return err
		}
		if err := synclog.Record(tx, synclog.Entry{
			Entity:       "stock_returns",
			RowID:        returns[i].ID,
			Op:           "update",
			RestaurantID: returns[i].RestaurantID,
			Payload:      returnSyncPayload{StockReturn: returns[i], Lines: lines},
		}); err != nil {
			return err
		}
	}
	return nil
}

// recordSupplierSync — снапшот поставщика(ов), по списку id: current_debt
// мутируется из МНОГИХ разных мест (CreateReceipt/PayReceipt/CreateReturn/
// CancelReturn/PayDebt/allocateDebtPayment/RecomputeDebts — последний одним
// batch-UPDATE потенциально задевает ВСЕХ поставщиков ресторана разом).
func recordSupplierSync(tx *gorm.DB, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	var rows []models.Supplier
	if err := tx.Where("id IN ?", ids).Find(&rows).Error; err != nil {
		return err
	}
	for i := range rows {
		if err := synclog.Record(tx, synclog.Entry{
			Entity:       "suppliers",
			RowID:        rows[i].ID,
			Op:           "update",
			RestaurantID: rows[i].RestaurantID,
			Payload:      rows[i],
		}); err != nil {
			return err
		}
	}
	return nil
}

// recordSupplierDeleteSync — SuppliersService.Delete делает hard DELETE
// (единственная hard-delete точка среди всех сущностей Ф4).
func recordSupplierDeleteSync(tx *gorm.DB, supplierID string, restaurantID string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "suppliers",
		RowID:        supplierID,
		Op:           "delete",
		RestaurantID: &restaurantID,
	})
}
