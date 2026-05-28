package models

// All — список всех GORM-моделей. Используется в auto-migration (если включена),
// для регистрации хуков и в тестах для проверки соответствия моделей миграциям.
//
// ПОРЯДОК НЕ ВАЖЕН: связи внутри моделей по строкам, GORM сам распарсит FK.
func All() []any {
	return []any{
		// core
		&Restaurant{}, &User{}, &AuditLog{},
		// layout
		&Zone{}, &Table{}, &Reservation{}, &Customer{},
		// menu
		&MenuCategory{}, &CustomCategory{}, &MenuItem{},
		&ModifierGroup{}, &Modifier{}, &TechCardLine{},
		// orders
		&Order{}, &OrderItem{}, &OrderItemModifier{},
		&OrderVoid{}, &OrderSplit{},
		// stock
		&Ingredient{}, &StockMovement{}, &Supplier{},
		&StockReceipt{}, &StockReceiptLine{},
		&StockWriteoff{}, &StockWriteoffLine{},
		&SemiFinishedType{}, &SemiRecipeLine{}, &SemiFinishedStock{},
		&BatchCookingLog{}, &SupplyExpense{},
		&InventoryCheck{}, &InventoryCheckLine{},
		// finance
		&FinancialAccount{}, &FinancialOperation{},
		&CashShift{}, &CashShiftOperation{},
		&Asset{}, &Liability{}, &EquityEntry{}, &BudgetLine{},
		// misc
		&TimeEntry{}, &IdempotencyKey{}, &PrintJob{},
		// auth
		&Session{},
		// printers (Phase 4.5)
		&Printer{},
		// shadow drifts (Phase 8)
		&ShadowDrift{},
	}
}
