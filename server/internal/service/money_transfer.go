package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// MoneyTransferService — переводы ДЕНЕГ между узлами сети (ADR-003, Фаза Д):
// инкассация филиал→central и переброска между филиалами.
// FinancialAccountsService.Transfer двигает деньги только внутри ОДНОГО
// ресторана (жёсткий WHERE restaurant_id = ?) — межузловой операции до этого
// не существовало вовсе.
//
// Структурно — зеркало TransferService (товарные перемещения): та же
// двухфазность sent→received, тот же скоуп «me ∈ (from, to)» вручную (у
// документа две стороны, одной колонки restaurant_id нет, ForTenant неприменим).
//
// Деньги двигаются парой financial_operations с activity='financial' — той же
// зарезервированной активностью, что у внутренних переводов между счетами:
// перевод не расход и не доход, applyOpexFilter его исключает, в ОПиУ он не
// попадает ни на одной стороне. Балансы счетов и сами финопы уезжают на
// central обычным generic-хуком (synclog/recorder_hook.go, trackedInsert/
// trackedSave) — явно синкаем только сам документ.
type MoneyTransferService struct {
	r *repo.Repo
}

func NewMoneyTransferService(r *repo.Repo) *MoneyTransferService {
	return &MoneyTransferService{r: r}
}

// CategoryNetworkTransfer — категория обеих финопер перевода. Одна на оба
// направления (не «в филиал»/«из филиала»): направление уже однозначно задано
// type=in/out, а единая категория оставляет её грепаемой одной строкой и не
// плодит два синонима в списке категорий ДДС.
const CategoryNetworkTransfer = "Перевод между филиалами"

// CreateMoneyTransferInput — body POST /api/v1/money/transfers.
// Источник = ресторан из контекста; FromAccountID — счёт списания у источника.
type CreateMoneyTransferInput struct {
	ToRestaurantID string  `json:"to_restaurant_id"`
	FromAccountID  string  `json:"from_account_id"`
	Amount         string  `json:"amount"`
	Note           *string `json:"note,omitempty"`
}

// Create списывает деньги со счёта отправителя и создаёт документ в статусе
// sent. Зачисление — отдельным вызовом Receive получателем (он же выбирает,
// на какой свой счёт принять). Между sent и received деньги не лежат ни на
// одном счёте — как товар в пути у stock_transfers.
func (s *MoneyTransferService) Create(ctx context.Context, in CreateMoneyTransferInput) (*models.MoneyTransfer, error) {
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
	if in.FromAccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "from_account_id is required", nil)
	}
	amount, err := decimal.FromString(in.Amount)
	if err != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be positive decimal", err)
	}
	amount = decimal.Normalize(amount)
	// Деньги между юрлицами — под тем же правом, что и остальная работа с
	// финансами (owner/manager/бухгалтер), не под голой аутентификацией.
	if err := requirePermFor(ctx, s.r, "finance.manage"); err != nil {
		return nil, err
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

	now := time.Now().UTC()
	transferID := uuid.NewString()
	var created *models.MoneyTransfer

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// FOR UPDATE — тот же row-lock, что в FinancialAccountsService.Transfer:
		// без него два параллельных перевода читают старый баланс и один
		// теряется (порча денег).
		var acc models.FinancialAccount
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", from, in.FromAccountID).
			First(&acc).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("NOT_FOUND", "from account not found", nil)
			}
			return err
		}
		// Счёт-источник намеренно НЕ проверяем на is_enabled — как и внутренний
		// перевод: забрать остаток с отключённого счёта штатно.
		if decimal.IsNegative(decimal.Sub(acc.Balance, amount)) {
			return apperrors.Wrap("CONFLICT", "insufficient funds on from account", nil)
		}
		if err := tx.Model(&acc).Updates(map[string]any{
			"balance":    decimal.Normalize(decimal.Sub(acc.Balance, amount)),
			"updated_at": now,
		}).Error; err != nil {
			return err
		}

		// Человекочитаемый номер — порядковый в рамках сети (как у товарных).
		var cnt int64
		tx.Model(&models.MoneyTransfer{}).Where("account_id = ?", accountID).Count(&cnt)
		num := int(cnt) + 1

		outType, category, activity := "out", CategoryNetworkTransfer, "financial"
		date := now.Format("2006-01-02")
		isAuto := false
		ridStr := from
		toName := toRest.Name
		op := &models.FinancialOperation{
			ID:           uuid.NewString(),
			Type:         &outType,
			Amount:       amount,
			Category:     &category,
			AccountID:    &acc.ID,
			AccountName:  acc.Name,
			Activity:     &activity,
			Date:         &date,
			Description:  in.Note,
			Counterparty: &toName,
			IsAuto:       &isAuto,
			RestaurantID: &ridStr,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(op).Error; err != nil {
			return err
		}

		t := &models.MoneyTransfer{
			ID:               transferID,
			AccountID:        &accountID,
			FromRestaurantID: &from,
			ToRestaurantID:   &in.ToRestaurantID,
			TransferNumber:   &num,
			Amount:           amount,
			Status:           "sent",
			Note:             in.Note,
			FromAccountID:    &acc.ID,
			FromAccountName:  acc.Name,
			SentAt:           &now,
			CreatedBy:        &actor.UserID,
			CreatedAt:        now,
			UpdatedAt:        now,
		}
		if err := tx.Create(t).Error; err != nil {
			return err
		}

		if err := synclog.Record(tx, synclog.Entry{
			Entity: "money_transfers", RowID: transferID, Op: "insert",
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
	return created, nil
}

// ReceiveMoneyTransferInput — body POST /api/v1/money/transfers/{id}/receive.
// ToAccountID — счёт ПОЛУЧАТЕЛЯ, куда зачислить (свой выбор, не отправителя).
type ReceiveMoneyTransferInput struct {
	ToAccountID string `json:"to_account_id"`
}

// Receive зачисляет перевод на выбранный счёт получателя. Идемпотентно:
// повторный вызов на уже принятом возвращает его без изменений (и БЕЗ второго
// зачисления — иначе двойные деньги при ретрае сети).
func (s *MoneyTransferService) Receive(ctx context.Context, transferID string, in ReceiveMoneyTransferInput) (*models.MoneyTransfer, error) {
	me, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "finance.manage"); err != nil {
		return nil, err
	}
	var t models.MoneyTransfer
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
		return &t, nil // идемпотентность
	}
	if t.Status != "sent" {
		return nil, apperrors.Wrap("CONFLICT", "transfer is not in 'sent' state", nil)
	}
	if in.ToAccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "to_account_id is required", nil)
	}
	// Принимающий счёт обязан быть включён — новые деньги на отключённый счёт
	// не заводим (тот же инвариант, что во внутреннем переводе).
	if err := MustBeEnabled(ctx, s.r, in.ToAccountID); err != nil {
		return nil, err
	}

	// Имя отправителя для counterparty — из локальной строки restaurants
	// (заглушка соседа приезжает down-sync'ом, см. applyRestaurantStub).
	fromName := ""
	if t.FromRestaurantID != nil {
		var fr models.Restaurant
		if err := s.r.Raw().WithContext(ctx).Select("name").Where("id = ?", *t.FromRestaurantID).
			First(&fr).Error; err == nil {
			fromName = fr.Name
		}
	}

	now := time.Now().UTC()
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		var acc models.FinancialAccount
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", me, in.ToAccountID).
			First(&acc).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("NOT_FOUND", "to account not found", nil)
			}
			return err
		}
		if err := tx.Model(&acc).Updates(map[string]any{
			"balance":    decimal.Normalize(decimal.Add(acc.Balance, t.Amount)),
			"updated_at": now,
		}).Error; err != nil {
			return err
		}

		inType, category, activity := "in", CategoryNetworkTransfer, "financial"
		date := now.Format("2006-01-02")
		isAuto := false
		ridStr := me
		op := &models.FinancialOperation{
			ID:           uuid.NewString(),
			Type:         &inType,
			Amount:       t.Amount,
			Category:     &category,
			AccountID:    &acc.ID,
			AccountName:  acc.Name,
			Activity:     &activity,
			Date:         &date,
			Description:  t.Note,
			Counterparty: &fromName,
			IsAuto:       &isAuto,
			RestaurantID: &ridStr,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(op).Error; err != nil {
			return err
		}

		t.Status = "received"
		t.ToAccountID = &acc.ID
		t.ReceivedAt = &now
		t.UpdatedAt = now
		if actor, ok := audit.ActorFromContext(ctx); ok && actor.UserID != "" {
			t.ReceivedBy = &actor.UserID
		}
		if err := tx.Save(&t).Error; err != nil {
			return err
		}

		return synclog.Record(tx, synclog.Entry{
			Entity: "money_transfers", RowID: transferID, Op: "update",
			RestaurantID: &me, AccountID: t.AccountID, Payload: &t,
		})
	})
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// List возвращает переводы, где текущий ресторан — отправитель или получатель.
func (s *MoneyTransferService) List(ctx context.Context) ([]models.MoneyTransfer, error) {
	me, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.MoneyTransfer
	if err := s.r.Raw().WithContext(ctx).
		Where("from_restaurant_id = ? OR to_restaurant_id = ?", me, me).
		Order("created_at DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// Get — одна строка, с тем же скоупом «me ∈ (from, to)».
func (s *MoneyTransferService) Get(ctx context.Context, transferID string) (*models.MoneyTransfer, error) {
	me, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var t models.MoneyTransfer
	if err := s.r.Raw().WithContext(ctx).
		Where("id = ? AND (from_restaurant_id = ? OR to_restaurant_id = ?)", transferID, me, me).
		First(&t).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	return &t, nil
}
