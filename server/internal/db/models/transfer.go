package models

import (
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// StockTransfer — документ перемещения товара между филиалами сети (ADR-003).
// Расход на складе-источнике (transfer_out) ↔ приход на получателе
// (transfer_in). Движения остатка идут через stock_movements; здесь — шапка.
//
// status: draft → sent (списано с источника) → received (зачислено получателю);
// cancelled — отменён до отправки.
type StockTransfer struct {
	ID               string     `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	AccountID        *string    `gorm:"column:account_id;type:uuid;index" json:"account_id"`
	FromRestaurantID *string    `gorm:"column:from_restaurant_id;type:uuid;index" json:"from_restaurant_id"`
	ToRestaurantID   *string    `gorm:"column:to_restaurant_id;type:uuid;index" json:"to_restaurant_id"`
	TransferNumber   *int       `gorm:"column:transfer_number" json:"transfer_number"`
	Status           string     `gorm:"not null;default:'draft'" json:"status"`
	Note             *string    `json:"note"`
	SentAt           *time.Time `gorm:"column:sent_at" json:"sent_at"`
	ReceivedAt       *time.Time `gorm:"column:received_at" json:"received_at"`
	CreatedBy        *string    `gorm:"column:created_by" json:"created_by"`
	ReceivedBy       *string    `gorm:"column:received_by" json:"received_by"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`

	Lines []StockTransferLine `gorm:"foreignKey:TransferID" json:"lines,omitempty"`
}

func (StockTransfer) TableName() string { return "stock_transfers" }

// StockTransferLine — позиция перемещения.
type StockTransferLine struct {
	ID         string  `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	TransferID *string `gorm:"column:transfer_id;type:uuid;index" json:"transfer_id"`
	// IngredientID — ингредиент СТОРОНЫ-ИСТОЧНИКА (для движения transfer_out).
	IngredientID *string `gorm:"column:ingredient_id" json:"ingredient_id"`
	// NomenclatureID — общий ключ сети (ADR-003, 3B): по нему получатель находит
	// свой ингредиент (to_restaurant_id, nomenclature_id) для transfer_in.
	NomenclatureID *string         `gorm:"column:nomenclature_id;type:uuid" json:"nomenclature_id"`
	IngredientName *string         `gorm:"column:ingredient_name" json:"ingredient_name"`
	Qty            decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"qty"`
	Unit           *string         `json:"unit"`
	CostPerUnit    decimal.Decimal `gorm:"column:cost_per_unit;type:numeric(14,4);default:0" json:"cost_per_unit"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

func (StockTransferLine) TableName() string { return "stock_transfer_lines" }
