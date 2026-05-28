package service

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ReceiptInput — body POST /api/v1/stock/receipts.
type ReceiptInput struct {
	SupplierID   *string       `json:"supplier_id,omitempty"`
	SupplierName *string       `json:"supplier_name,omitempty"`
	Date         string        `json:"date,omitempty"` // YYYY-MM-DD, default — today
	Note         *string       `json:"note,omitempty"`
	PaymentType  string        `json:"payment_type"` // paid | credit
	PaidAmount   string        `json:"paid_amount,omitempty"`
	DueDate      *string       `json:"due_date,omitempty"`
	Lines        []ReceiptLine `json:"lines"`
}

// ReceiptLine — позиция приёмки.
type ReceiptLine struct {
	IngredientID string  `json:"ingredient_id"`
	Name         string  `json:"name"` // snapshot для печати
	Qty          string  `json:"qty"`
	Unit         *string `json:"unit,omitempty"`
	PricePerUnit string  `json:"price_per_unit"`
}

// WriteoffInput — body POST /api/v1/stock/writeoffs.
type WriteoffInput struct {
	Reason      string         `json:"reason"`
	Description *string        `json:"description,omitempty"`
	Lines       []WriteoffLine `json:"lines"`
}

// WriteoffLine — позиция списания. Стоимость считается как qty * price_per_unit
// или передаётся явно (например для FIFO/средневзвешенной — будет в Phase 4).
type WriteoffLine struct {
	IngredientID string  `json:"ingredient_id"`
	Name         string  `json:"name"`
	Qty          string  `json:"qty"`
	Unit         *string `json:"unit,omitempty"`
	Cost         string  `json:"cost"`
}

// WithPublisher (как в других сервисах).
func (s *StockService) WithPublisher(pub *EventPublisher) *StockService {
	s.pub = pub
	return s
}

// CreateReceipt принимает товар. Создаёт:
//   - stock_receipts (header)
//   - stock_receipt_lines (детали)
//   - stock_movements с положительным qty (тип "receipt") — для каждой строки.
//
// Всё в одной транзакции. Идемпотентность middleware — на уровне HTTP.
func (s *StockService) CreateReceipt(ctx context.Context, in ReceiptInput) (*models.StockReceipt, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if len(in.Lines) == 0 {
		return nil, apperrors.Wrap("VALIDATION", "at least one line required", nil)
	}
	if in.PaymentType == "" {
		in.PaymentType = "paid"
	}
	actor, _ := audit.ActorFromContext(ctx)
	now := time.Now().UTC()
	date := in.Date
	if date == "" {
		date = now.Format("2006-01-02")
	}

	// Парсинг и validation полей.
	totalAmount := decimal.Zero
	paid := decimal.Zero
	if in.PaidAmount != "" {
		paid, err = decimal.FromString(in.PaidAmount)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad paid_amount", err)
		}
	}

	// Pre-parse lines, чтобы знать total_amount до Save заголовка.
	parsedLines := make([]struct {
		in   ReceiptLine
		qty  decimal.Decimal
		ppu  decimal.Decimal
		line decimal.Decimal
	}, len(in.Lines))
	for i, l := range in.Lines {
		qty, err := decimal.FromString(l.Qty)
		if err != nil || !decimal.IsPositive(qty) {
			return nil, apperrors.Wrap("VALIDATION", "bad qty in line", err)
		}
		ppu, err := decimal.FromString(l.PricePerUnit)
		if err != nil || decimal.IsNegative(ppu) {
			return nil, apperrors.Wrap("VALIDATION", "bad price_per_unit", err)
		}
		line := decimal.Normalize(decimal.Mul(qty, ppu))
		parsedLines[i] = struct {
			in   ReceiptLine
			qty  decimal.Decimal
			ppu  decimal.Decimal
			line decimal.Decimal
		}{l, qty, ppu, line}
		totalAmount = decimal.Add(totalAmount, line)
	}
	totalAmount = decimal.Normalize(totalAmount)
	debt := decimal.Normalize(decimal.Sub(totalAmount, paid))
	if in.PaymentType == "paid" {
		paid = totalAmount
		debt = decimal.Zero
	}

	var created *models.StockReceipt
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		receiptID := uuid.NewString()
		confirmedBy := actor.UserID
		pt := in.PaymentType
		receipt := &models.StockReceipt{
			ID:           receiptID,
			SupplierID:   in.SupplierID,
			SupplierName: in.SupplierName,
			Date:         &date,
			Note:         in.Note,
			TotalAmount:  totalAmount,
			PaymentType:  &pt,
			PaidAmount:   paid,
			DebtAmount:   debt,
			DueDate:      in.DueDate,
			ConfirmedAt:  &now,
			ConfirmedBy:  &confirmedBy,
			RestaurantID: &rid,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(receipt).Error; err != nil {
			return err
		}

		for _, pl := range parsedLines {
			lineID := uuid.NewString()
			rl := &models.StockReceiptLine{
				ID:           lineID,
				ReceiptID:    &receiptID,
				IngredientID: &pl.in.IngredientID,
				Name:         &pl.in.Name,
				Qty:          pl.qty,
				Unit:         pl.in.Unit,
				PricePerUnit: pl.ppu,
				CreatedAt:    now,
				UpdatedAt:    now,
			}
			if err := tx.Create(rl).Error; err != nil {
				return err
			}

			// stock_movement +qty
			mvType := "receipt"
			desc := "receipt:" + receiptID
			mv := &models.StockMovement{
				ID:             uuid.NewString(),
				Type:           &mvType,
				IngredientID:   &pl.in.IngredientID,
				IngredientName: &pl.in.Name,
				Description:    &desc,
				Qty:            pl.qty,
				Unit:           pl.in.Unit,
				RestaurantID:   &rid,
				CreatedAt:      now,
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}
		}
		created = receipt
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventStockMovement, map[string]any{
			"kind":         "receipt",
			"receipt_id":   created.ID,
			"lines":        len(in.Lines),
			"total_amount": totalAmount.String(),
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return created, nil
}

// CreateWriteoff списывает товар. Создаёт stock_writeoffs + lines +
// stock_movements (qty < 0).
func (s *StockService) CreateWriteoff(ctx context.Context, in WriteoffInput) (*models.StockWriteoff, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Reason == "" {
		return nil, apperrors.Wrap("VALIDATION", "reason required", nil)
	}
	if len(in.Lines) == 0 {
		return nil, apperrors.Wrap("VALIDATION", "at least one line required", nil)
	}
	actor, _ := audit.ActorFromContext(ctx)
	now := time.Now().UTC()

	parsed := make([]struct {
		in   WriteoffLine
		qty  decimal.Decimal
		cost decimal.Decimal
	}, len(in.Lines))
	totalCost := decimal.Zero
	for i, l := range in.Lines {
		qty, err := decimal.FromString(l.Qty)
		if err != nil || !decimal.IsPositive(qty) {
			return nil, apperrors.Wrap("VALIDATION", "bad qty in line", err)
		}
		cost, err := decimal.FromString(l.Cost)
		if err != nil || decimal.IsNegative(cost) {
			return nil, apperrors.Wrap("VALIDATION", "bad cost", err)
		}
		parsed[i] = struct {
			in   WriteoffLine
			qty  decimal.Decimal
			cost decimal.Decimal
		}{l, qty, cost}
		totalCost = decimal.Add(totalCost, cost)
	}
	totalCost = decimal.Normalize(totalCost)

	var created *models.StockWriteoff
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		writeoffID := uuid.NewString()
		creator := actor.UserID
		reason := in.Reason
		w := &models.StockWriteoff{
			ID:           writeoffID,
			Reason:       &reason,
			Description:  in.Description,
			TotalCost:    totalCost,
			CreatedBy:    &creator,
			RestaurantID: &rid,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(w).Error; err != nil {
			return err
		}
		for _, pl := range parsed {
			lineID := uuid.NewString()
			wl := &models.StockWriteoffLine{
				ID:           lineID,
				WriteoffID:   &writeoffID,
				IngredientID: &pl.in.IngredientID,
				Name:         &pl.in.Name,
				Qty:          pl.qty,
				Unit:         pl.in.Unit,
				Cost:         pl.cost,
				UpdatedAt:    now,
			}
			if err := tx.Create(wl).Error; err != nil {
				return err
			}
			mvType := "writeoff"
			desc := "writeoff:" + writeoffID
			mv := &models.StockMovement{
				ID:             uuid.NewString(),
				Type:           &mvType,
				IngredientID:   &pl.in.IngredientID,
				IngredientName: &pl.in.Name,
				Description:    &desc,
				Qty:            pl.qty.Neg(),
				Unit:           pl.in.Unit,
				RestaurantID:   &rid,
				CreatedAt:      now,
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}
		}
		created = w
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventStockMovement, map[string]any{
			"kind":        "writeoff",
			"writeoff_id": created.ID,
			"lines":       len(in.Lines),
			"total_cost":  totalCost.String(),
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return created, nil
}
