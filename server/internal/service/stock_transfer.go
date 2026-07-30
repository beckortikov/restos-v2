package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// TransferService — перемещения товара между филиалами одной сети (ADR-003,
// Фаза 1). Работает в пределах одной БД: центральный склад и филиалы — разные
// restaurant_id одного account_id.
//
// Модель движения остатка — пара stock_movements (правило проекта «qty только
// через event-stream»): transfer_out (-qty на источнике) при отправке ↔
// transfer_in (+qty на получателе) при приёме. Денормализация qty —
// существующим хуком AfterCreate StockMovement.
//
// Сопоставление ингредиентов между филиалами — через nomenclature_id
// (вариант 3B): получатель находит свой ингредиент по (to_restaurant_id,
// nomenclature_id), при отсутствии создаёт с 0-остатком.
//
// stock_transfers не имеет одной колонки restaurant_id (есть from/to), поэтому
// ForTenant к нему неприменим — скоупим вручную «me ∈ (from, to)». Все запросы
// обязаны включать этот фильтр (защита от утечки между сетями).
type TransferService struct {
	r *repo.Repo
}

func NewTransferService(r *repo.Repo) *TransferService {
	return &TransferService{r: r}
}

// CreateTransferInput — body POST /api/v1/stock/transfers.
// Источник = ресторан из контекста (где залогинен отправитель).
type CreateTransferInput struct {
	ToRestaurantID string              `json:"to_restaurant_id"`
	Note           *string             `json:"note,omitempty"`
	Lines          []TransferLineInput `json:"lines"`
}

// TransferLineInput — позиция. IngredientID — ингредиент СТОРОНЫ-ИСТОЧНИКА.
type TransferLineInput struct {
	IngredientID string `json:"ingredient_id"`
	Qty          string `json:"qty"`
	CostPerUnit  string `json:"cost_per_unit,omitempty"`
}

type parsedTransferLine struct {
	in   TransferLineInput
	qty  decimal.Decimal
	cost decimal.Decimal
	ing  models.Ingredient
}

// CreateTransfer создаёт перемещение и СРАЗУ отправляет его (status=sent):
// пишет transfer_out (-qty) на складе-источнике. Приём — отдельным вызовом
// Receive получателем. Если у источника enforce_stock_check и остатка не
// хватает — хук откатит транзакцию (CONFLICT).
func (s *TransferService) CreateTransfer(ctx context.Context, in CreateTransferInput) (*models.StockTransfer, error) {
	from, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.ToRestaurantID == "" {
		return nil, apperrors.Wrap("VALIDATION", "to_restaurant_id is required", nil)
	}
	if in.ToRestaurantID == from {
		return nil, apperrors.Wrap("VALIDATION", "to_restaurant_id must differ from source", nil)
	}
	if len(in.Lines) == 0 {
		return nil, apperrors.Wrap("VALIDATION", "lines must not be empty", nil)
	}
	actor, _ := audit.ActorFromContext(ctx)

	// Источник и сеть. Источник обязан быть в сети (account_id != NULL).
	var fromRest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", from).First(&fromRest).Error; err != nil {
		return nil, err
	}
	if fromRest.AccountID == nil || *fromRest.AccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "source restaurant is not part of a network", nil)
	}
	accountID := *fromRest.AccountID

	// Получатель должен существовать и быть в той же сети.
	var toRest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", in.ToRestaurantID).First(&toRest).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.Wrap("VALIDATION", "to_restaurant not found", nil)
		}
		return nil, err
	}
	if toRest.AccountID == nil || *toRest.AccountID != accountID {
		return nil, apperrors.Wrap("VALIDATION", "to_restaurant belongs to a different network", nil)
	}

	// Парсим строки + загружаем ингредиенты источника. Ингредиент без сетевой
	// номенклатуры (nomenclature_id) — не ошибка: заводим её автоматически
	// внутри транзакции ниже, из его же имени/единицы, вместо требования
	// сделать это вручную заранее (см. упрощение номенклатуры сети, ADR-004).
	parsed := make([]parsedTransferLine, 0, len(in.Lines))
	for _, l := range in.Lines {
		qty, err := decimal.FromString(l.Qty)
		if err != nil || !decimal.IsPositive(qty) {
			return nil, apperrors.Wrap("VALIDATION", "line qty must be a positive number", nil)
		}
		cost := decimal.Zero
		if l.CostPerUnit != "" {
			if c, err := decimal.FromString(l.CostPerUnit); err == nil {
				cost = c
			}
		}
		var ing models.Ingredient
		if err := s.r.Raw().WithContext(ctx).
			Where("restaurant_id = ? AND id = ?", from, l.IngredientID).
			First(&ing).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, apperrors.Wrap("VALIDATION", "ingredient "+l.IngredientID+" not found at source", nil)
			}
			return nil, err
		}
		if cost.IsZero() {
			cost = ing.PricePerUnit
		}
		parsed = append(parsed, parsedTransferLine{in: l, qty: decimal.Normalize(qty), cost: decimal.Normalize(cost), ing: ing})
	}

	now := time.Now().UTC()
	transferID := uuid.NewString()
	var created *models.StockTransfer

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// Человекочитаемый номер — порядковый в рамках сети.
		var cnt int64
		tx.Model(&models.StockTransfer{}).Where("account_id = ?", accountID).Count(&cnt)
		num := int(cnt) + 1

		sent := "sent"
		t := &models.StockTransfer{
			ID:               transferID,
			AccountID:        &accountID,
			FromRestaurantID: &from,
			ToRestaurantID:   &in.ToRestaurantID,
			TransferNumber:   &num,
			Status:           sent,
			Note:             in.Note,
			SentAt:           &now,
			CreatedBy:        &actor.UserID,
			CreatedAt:        now,
			UpdatedAt:        now,
		}
		if err := tx.Create(t).Error; err != nil {
			return err
		}

		desc := "transfer:" + transferID
		for _, pl := range parsed {
			// Автосоздание сетевой номенклатуры при первой отправке этого
			// ингредиента: имя/единица берутся с самого ингредиента, второй
			// раз их вводить не нужно. Линкуем ингредиент источника сразу —
			// повторные перемещения того же товара уже не создадут дубль.
			if pl.ing.NomenclatureID == nil || *pl.ing.NomenclatureID == "" {
				nom := &models.Nomenclature{
					ID:        uuid.NewString(),
					AccountID: &accountID,
					Name:      *pl.ing.Name,
					Unit:      pl.ing.Unit,
					Category:  pl.ing.Category,
					CreatedAt: now,
					UpdatedAt: now,
				}
				if err := tx.Create(nom).Error; err != nil {
					return err
				}
				if err := tx.Model(&models.Ingredient{}).Where("id = ?", pl.ing.ID).
					Update("nomenclature_id", nom.ID).Error; err != nil {
					return err
				}
				if err := recordIngredientSync(tx, []string{pl.ing.ID}); err != nil {
					return err
				}
				pl.ing.NomenclatureID = &nom.ID
			}

			lineID := uuid.NewString()
			line := &models.StockTransferLine{
				ID:             lineID,
				TransferID:     &transferID,
				IngredientID:   &pl.in.IngredientID,
				NomenclatureID: pl.ing.NomenclatureID,
				IngredientName: pl.ing.Name,
				Qty:            pl.qty,
				Unit:           pl.ing.Unit,
				CostPerUnit:    pl.cost,
				CreatedAt:      now,
				UpdatedAt:      now,
			}
			if err := tx.Create(line).Error; err != nil {
				return err
			}
			t.Lines = append(t.Lines, *line)

			// transfer_out: -qty на источнике. Хук уменьшит ingredients.qty
			// и (если enforce_stock_check) не даст уйти в минус.
			mvType := "transfer_out"
			negQty := decimal.Sub(decimal.Zero, pl.qty)
			mv := &models.StockMovement{
				ID:             uuid.NewString(),
				Type:           &mvType,
				IngredientID:   &pl.in.IngredientID,
				IngredientName: pl.ing.Name,
				Description:    &desc,
				Qty:            negQty,
				Unit:           pl.ing.Unit,
				RestaurantID:   &from,
				CreatedAt:      now,
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}
		}

		// sync-дельта: перемещение с полными строками (для upsert на
		// центральном узле и доставки получателю). Режим «только нужное».
		if err := synclog.Record(tx, synclog.Entry{
			Entity: "stock_transfers", RowID: transferID, Op: "insert",
			RestaurantID: &from, AccountID: &accountID, Payload: t,
		}); err != nil {
			return err
		}

		created = t
		return nil
	})
	if err != nil {
		return nil, err
	}
	created.Lines = s.loadLines(ctx, transferID)
	return created, nil
}

// Receive принимает перемещение получателем: пишет transfer_in (+qty) на
// каждый ингредиент получателя (находя его по nomenclature_id или создавая).
// Идемпотентно: повторный вызов на уже принятом возвращает его без изменений.
func (s *TransferService) Receive(ctx context.Context, transferID string) (*models.StockTransfer, error) {
	me, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}

	var t models.StockTransfer
	if err := s.r.Raw().WithContext(ctx).
		Where("id = ? AND (from_restaurant_id = ? OR to_restaurant_id = ?)", transferID, me, me).
		First(&t).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	if t.ToRestaurantID == nil || *t.ToRestaurantID != me {
		return nil, apperrors.Wrap("FORBIDDEN", "only the receiver can accept this transfer", nil)
	}
	if t.Status == "received" {
		// Идемпотентность: уже принято — возвращаем как есть.
		t.Lines = s.loadLines(ctx, transferID)
		return &t, nil
	}
	if t.Status != "sent" {
		return nil, apperrors.Wrap("CONFLICT", "transfer is not in 'sent' state", nil)
	}

	lines := s.loadLines(ctx, transferID)
	now := time.Now().UTC()

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		desc := "transfer:" + transferID

		for _, l := range lines {
			// Ингредиент получателя по (me, nomenclature_id); нет — сперва
			// пробуем найти уже существующий у получателя НЕпривязанный
			// ингредиент с тем же именем+единицей (завёл его сам, до первого
			// перемещения) и связать его, а не плодить дубль на складе;
			// не нашли — заводим с нуля.
			var dest models.Ingredient
			derr := tx.Where("restaurant_id = ? AND nomenclature_id = ?", me, l.NomenclatureID).
				First(&dest).Error
			if errors.Is(derr, gorm.ErrRecordNotFound) {
				matchErr := tx.Where("restaurant_id = ? AND nomenclature_id IS NULL AND name = ? AND unit = ?",
					me, l.IngredientName, l.Unit).First(&dest).Error
				switch {
				case matchErr == nil:
					if err := tx.Model(&models.Ingredient{}).Where("id = ?", dest.ID).
						Update("nomenclature_id", l.NomenclatureID).Error; err != nil {
						return err
					}
					dest.NomenclatureID = l.NomenclatureID
				case errors.Is(matchErr, gorm.ErrRecordNotFound):
					dest = models.Ingredient{
						ID:             uuid.NewString(),
						Name:           l.IngredientName,
						Unit:           l.Unit,
						Qty:            decimal.Zero,
						PricePerUnit:   l.CostPerUnit,
						RestaurantID:   &me,
						NomenclatureID: l.NomenclatureID,
						CreatedAt:      now,
						UpdatedAt:      now,
					}
					if err := tx.Create(&dest).Error; err != nil {
						return err
					}
				default:
					return matchErr
				}
				// Обе ветки (реюз с линковкой / новый ингредиент) меняют dest —
				// синкаем один раз после switch.
				if err := recordIngredientSync(tx, []string{dest.ID}); err != nil {
					return err
				}
			} else if derr != nil {
				return derr
			}

			// transfer_in: +qty получателю. Хук увеличит ingredients.qty.
			mvType := "transfer_in"
			mv := &models.StockMovement{
				ID:             uuid.NewString(),
				Type:           &mvType,
				IngredientID:   &dest.ID,
				IngredientName: l.IngredientName,
				Description:    &desc,
				Qty:            l.Qty,
				Unit:           l.Unit,
				RestaurantID:   &me,
				CreatedAt:      now,
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}
		}

		// load-then-save структуры (а не Model().Updates(map[string]any{...})):
		// апдейт через голую map лишает generic audit-хук возможности прочитать
		// entity_id (extractFromValue умеет только struct/slice), и заодно тут
		// же фиксируем received_by — раньше приём не писал нигде, кто принял.
		t.Status = "received"
		t.ReceivedAt = &now
		t.UpdatedAt = now
		if actor, ok := audit.ActorFromContext(ctx); ok && actor.UserID != "" {
			t.ReceivedBy = &actor.UserID
		}
		if err := tx.Save(&t).Error; err != nil {
			return err
		}

		// sync-дельта: приём (смена статуса) — чтобы центральный узел знал,
		// что перемещение завершено.
		t.Lines = lines
		if err := synclog.Record(tx, synclog.Entry{
			Entity: "stock_transfers", RowID: transferID, Op: "update",
			RestaurantID: &me, AccountID: t.AccountID, Payload: &t,
		}); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	t.Status = "received"
	t.ReceivedAt = &now
	t.Lines = lines
	return &t, nil
}

// List возвращает перемещения, где текущий ресторан — источник или получатель.
func (s *TransferService) List(ctx context.Context) ([]models.StockTransfer, error) {
	me, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var out []models.StockTransfer
	if err := s.r.Raw().WithContext(ctx).
		Where("from_restaurant_id = ? OR to_restaurant_id = ?", me, me).
		Order("created_at DESC").
		Find(&out).Error; err != nil {
		return nil, err
	}
	// Строки — одним батч-запросом на все перемещения списка, а не в Get()
	// (там на одно перемещение). Без этого List() отдавал Lines=nil, и на
	// экране «Перемещения» колонка «Позиций» всегда показывала 0 независимо
	// от реального состава.
	if len(out) == 0 {
		return out, nil
	}
	ids := make([]string, len(out))
	for i, t := range out {
		ids[i] = t.ID
	}
	var lines []models.StockTransferLine
	if err := s.r.Raw().WithContext(ctx).
		Where("transfer_id IN ?", ids).
		Order("created_at ASC").
		Find(&lines).Error; err != nil {
		return nil, err
	}
	byTransfer := make(map[string][]models.StockTransferLine, len(out))
	for _, l := range lines {
		if l.TransferID == nil {
			continue
		}
		byTransfer[*l.TransferID] = append(byTransfer[*l.TransferID], l)
	}
	for i := range out {
		out[i].Lines = byTransfer[out[i].ID]
	}
	return out, nil
}

// Get возвращает одно перемещение со строками (если текущий ресторан причастен).
func (s *TransferService) Get(ctx context.Context, transferID string) (*models.StockTransfer, error) {
	me, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var t models.StockTransfer
	if err := s.r.Raw().WithContext(ctx).
		Where("id = ? AND (from_restaurant_id = ? OR to_restaurant_id = ?)", transferID, me, me).
		First(&t).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	t.Lines = s.loadLines(ctx, transferID)
	return &t, nil
}

func (s *TransferService) loadLines(ctx context.Context, transferID string) []models.StockTransferLine {
	var lines []models.StockTransferLine
	s.r.Raw().WithContext(ctx).Where("transfer_id = ?", transferID).Order("created_at ASC").Find(&lines)
	return lines
}
