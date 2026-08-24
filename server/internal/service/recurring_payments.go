package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// RecurringPaymentsService — модуль «Платежи»: шаблоны повторяющихся платежей
// (аренда, коммуналка, оклады) + проведение платежа по шаблону.
type RecurringPaymentsService struct {
	r *repo.Repo
}

func NewRecurringPaymentsService(r *repo.Repo) *RecurringPaymentsService {
	return &RecurringPaymentsService{r: r}
}

// RecurringPaymentInput — тело create/patch. Поля-указатели: nil = «не менять»
// в patch; в create отсутствие имени/суммы отбивается валидацией.
type RecurringPaymentInput struct {
	Name         *string `json:"name,omitempty"`
	Category     *string `json:"category,omitempty"`
	Amount       *string `json:"amount,omitempty"`
	AccountID    *string `json:"account_id,omitempty"`
	Activity     *string `json:"activity,omitempty"`
	Counterparty *string `json:"counterparty,omitempty"`
	DayOfMonth   *int    `json:"day_of_month,omitempty"`
	Active       *bool   `json:"active,omitempty"`
	Note         *string `json:"note,omitempty"`
}

// RecurringPaymentPayInput — тело POST /{id}/pay. amount/account_id
// необязательны: по умолчанию берутся из шаблона (аренда — фикс), но
// правятся при оплате (коммуналка меняется от месяца к месяцу).
type RecurringPaymentPayInput struct {
	Amount    *string `json:"amount,omitempty"`
	AccountID *string `json:"account_id,omitempty"`
}

func (s *RecurringPaymentsService) List(ctx context.Context) ([]models.RecurringPayment, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	// active-first, затем по ближайшей дате платежа — чтобы «к оплате» было сверху.
	var rows []models.RecurringPayment
	if err := scoped.Order("active DESC, next_due ASC NULLS LAST, name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *RecurringPaymentsService) Create(ctx context.Context, in RecurringPaymentInput) (*models.RecurringPayment, error) {
	if err := requirePermFor(ctx, s.r, "finance.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	dom := 1
	if in.DayOfMonth != nil {
		dom = *in.DayOfMonth
	}
	if dom < 1 || dom > 31 {
		return nil, apperrors.Wrap("VALIDATION", "day_of_month must be 1..31", nil)
	}
	now := time.Now().UTC()
	activity := "operational"
	if in.Activity != nil && *in.Activity != "" {
		activity = *in.Activity
	}
	rp := &models.RecurringPayment{
		ID: uuid.NewString(), Name: in.Name, Category: in.Category,
		AccountID: in.AccountID, Activity: &activity, Counterparty: in.Counterparty,
		DayOfMonth: dom, Note: in.Note, Active: true,
		RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
	}
	if in.Active != nil {
		rp.Active = *in.Active
	}
	if in.Amount != nil {
		d, err := decimal.FromString(*in.Amount)
		if err != nil || decimal.IsNegative(d) {
			return nil, apperrors.Wrap("VALIDATION", "bad amount", err)
		}
		rp.Amount = d
	}
	nd := nextDueDate(now, dom)
	rp.NextDue = &nd

	if err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Create(rp).Error; err != nil {
			return err
		}
		return recordRecurringPaymentSync(tx, []string{rp.ID})
	}); err != nil {
		return nil, err
	}
	return rp, nil
}

func (s *RecurringPaymentsService) Patch(ctx context.Context, id string, in RecurringPaymentInput) (*models.RecurringPayment, error) {
	if err := requirePermFor(ctx, s.r, "finance.manage"); err != nil {
		return nil, err
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.RecurringPayment
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	now := time.Now().UTC()
	updates := map[string]any{"updated_at": now}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.Category != nil {
		updates["category"] = *in.Category
	}
	if in.AccountID != nil {
		updates["account_id"] = *in.AccountID
	}
	if in.Activity != nil {
		updates["activity"] = *in.Activity
	}
	if in.Counterparty != nil {
		updates["counterparty"] = *in.Counterparty
	}
	if in.Note != nil {
		updates["note"] = *in.Note
	}
	if in.Active != nil {
		updates["active"] = *in.Active
	}
	if in.Amount != nil {
		d, err := decimal.FromString(*in.Amount)
		if err != nil || decimal.IsNegative(d) {
			return nil, apperrors.Wrap("VALIDATION", "bad amount", err)
		}
		updates["amount"] = d
	}
	if in.DayOfMonth != nil {
		if *in.DayOfMonth < 1 || *in.DayOfMonth > 31 {
			return nil, apperrors.Wrap("VALIDATION", "day_of_month must be 1..31", nil)
		}
		updates["day_of_month"] = *in.DayOfMonth
		// День оплаты изменили — пересчитываем next_due от сегодня.
		nd := nextDueDate(now, *in.DayOfMonth)
		updates["next_due"] = nd
	}
	if err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Model(&existing).Updates(updates).Error; err != nil {
			return err
		}
		return recordRecurringPaymentSync(tx, []string{existing.ID})
	}); err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.RecurringPayment
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *RecurringPaymentsService) Delete(ctx context.Context, id string) error {
	if err := requirePermFor(ctx, s.r, "finance.manage"); err != nil {
		return err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return err
	}
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		res := tx.Where("restaurant_id = ? AND id = ?", rid, id).Delete(&models.RecurringPayment{})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return apperrors.ErrNotFound
		}
		return recordRecurringPaymentDeleteSync(tx, id, rid)
	})
}

// Pay — провести платёж по шаблону. Атомарно: списывает сумму со счёта, создаёт
// financial_operation out, ставит last_paid_at/last_paid_amount. Сумма/счёт по
// умолчанию из шаблона, но правятся во входе (коммуналка меняется помесячно).
// Это НЕ гашение долга — обычный операционный расход (аренда/коммуналка
// попадают в opex ОПиУ, в отличие от supplier_payment).
//
// Частичная оплата (amount < остатка текущего цикла — «Погащение» долями):
// next_due НЕ двигается, remaining_amount уменьшается на amount. Цикл
// закрывается (next_due на месяц вперёд, remaining_amount сбрасывается)
// только когда amount покрывает остаток целиком — иначе доплата молча
// терялась: next_due двигался безусловно, а строка тут же снова показывала
// полную Amount шаблона как будто ничего не платили.
func (s *RecurringPaymentsService) Pay(ctx context.Context, id string, in RecurringPaymentPayInput) (*models.RecurringPayment, error) {
	if err := requirePermFor(ctx, s.r, "finance.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()

	var out *models.RecurringPayment
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		var rp models.RecurringPayment
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, id).First(&rp).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}

		// Остаток текущего цикла: ничего не платили — вся Amount шаблона.
		owed := rp.Amount
		if rp.RemainingAmount != nil {
			owed = *rp.RemainingAmount
		}
		// Сумма: override или остаток текущего цикла (не всегда полная Amount —
		// если цикл уже частично оплачен, дефолт должен быть «долить остаток»).
		amount := owed
		if in.Amount != nil {
			d, err := decimal.FromString(*in.Amount)
			if err != nil {
				return apperrors.Wrap("VALIDATION", "bad amount", err)
			}
			amount = d
		}
		if !decimal.IsPositive(amount) {
			return apperrors.Wrap("VALIDATION", "amount must be > 0", nil)
		}
		// Счёт: override или из шаблона.
		accID := ""
		if in.AccountID != nil && *in.AccountID != "" {
			accID = *in.AccountID
		} else if rp.AccountID != nil {
			accID = *rp.AccountID
		}
		if accID == "" {
			return apperrors.Wrap("VALIDATION", "account_id is required", nil)
		}

		var acc models.FinancialAccount
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, accID).First(&acc).Error; err != nil {
			return apperrors.Wrap("VALIDATION", "account not found", err)
		}
		// Счёт мог быть отключён после создания шаблона. SetEnabled не даёт
		// отключить счёт с активными платежами, но шаблон могли создать/
		// переключить позже — проверяем на месте оплаты.
		if !acc.IsEnabled {
			return apperrors.Wrap("CONFLICT", "счёт платежа отключён — выберите другой счёт", nil)
		}
		newBal := decimal.Normalize(decimal.Sub(acc.Balance, amount))
		if decimal.IsNegative(newBal) {
			return apperrors.Wrap("CONFLICT", "insufficient funds on account", nil)
		}
		if err := tx.Model(&acc).Updates(map[string]any{"balance": newBal, "updated_at": now}).Error; err != nil {
			return err
		}

		// Остаток ПОСЛЕ этого платежа: >0 — цикл не закрыт (доплата), иначе
		// (0 или переплата) — цикл закрыт целиком.
		remaining := decimal.Normalize(decimal.Sub(owed, amount))
		partial := decimal.IsPositive(remaining)

		opType := "out"
		opActivity := "operational"
		if rp.Activity != nil && *rp.Activity != "" {
			opActivity = *rp.Activity
		}
		opDate := now.Format("2006-01-02")
		isAuto := true
		desc := "Платёж"
		if rp.Name != nil && *rp.Name != "" {
			desc = "Платёж: " + *rp.Name
		}
		if partial {
			desc += " (частично)"
		}
		ridStr := rid
		fo := &models.FinancialOperation{
			ID: uuid.NewString(), Type: &opType, Amount: amount, Category: rp.Category,
			AccountID: &accID, AccountName: acc.Name, Activity: &opActivity, Date: &opDate,
			Description: &desc, Counterparty: rp.Counterparty, IsAuto: &isAuto,
			RestaurantID: &ridStr, CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(fo).Error; err != nil {
			return err
		}

		updates := map[string]any{
			"last_paid_at":     now,
			"last_paid_amount": amount,
			"updated_at":       now,
		}
		nd := ""
		if partial {
			// Доплата не покрыла остаток — цикл остаётся открытым на том же
			// сроке, следующий раз к оплате предлагается именно остаток.
			updates["remaining_amount"] = remaining
		} else {
			// Остаток закрыт (ровно или с переплатой) — двигаем срок на
			// следующий месяц от текущего next_due (а не от now): если платёж
			// провели заранее/с опозданием, ритм дня-месяца сохраняется.
			base := opDate
			if rp.NextDue != nil && *rp.NextDue != "" {
				base = *rp.NextDue
			}
			nd = advanceMonth(base, rp.DayOfMonth)
			updates["next_due"] = nd
			updates["remaining_amount"] = nil
		}
		if err := tx.Model(&rp).Updates(updates).Error; err != nil {
			return err
		}
		if err := recordRecurringPaymentSync(tx, []string{rp.ID}); err != nil {
			return err
		}
		if partial {
			rp.RemainingAmount = &remaining
		} else {
			rp.NextDue = &nd
			rp.RemainingAmount = nil
		}
		rp.LastPaidAt = &now
		rp.LastPaidAmount = &amount
		out = &rp
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ─── date helpers ───────────────────────────────────────────────────────────

// nextDueDate — ближайшая дата с днём dom в текущем или следующем месяце,
// не раньше from. День клампится к длине месяца (dom=31 в феврале → 28/29).
func nextDueDate(from time.Time, dom int) string {
	from = from.UTC()
	y, m, d := from.Date()
	cand := clampedDay(y, m, dom)
	if cand >= d { // день ещё не прошёл в этом месяце
		return dateStr(y, m, cand)
	}
	ny, nm := nextMonth(y, m)
	return dateStr(ny, nm, clampedDay(ny, nm, dom))
}

// advanceMonth — сдвиг даты cur (YYYY-MM-DD) на один месяц вперёд с тем же
// днём dom (клампится к длине следующего месяца).
func advanceMonth(cur string, dom int) string {
	t, err := time.Parse("2006-01-02", cur)
	if err != nil {
		return nextDueDate(time.Now().UTC().AddDate(0, 0, 1), dom)
	}
	ny, nm := nextMonth(t.Year(), t.Month())
	return dateStr(ny, nm, clampedDay(ny, nm, dom))
}

func nextMonth(y int, m time.Month) (int, time.Month) {
	if m == time.December {
		return y + 1, time.January
	}
	return y, m + 1
}

func daysInMonth(y int, m time.Month) int {
	return time.Date(y, m+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func clampedDay(y int, m time.Month, dom int) int {
	last := daysInMonth(y, m)
	if dom > last {
		return last
	}
	if dom < 1 {
		return 1
	}
	return dom
}

func dateStr(y int, m time.Month, d int) string {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
}

// retreatMonth — обратный advanceMonth: тот же день месяца, но на месяц назад,
// с тем же клампом по длине месяца (31 → 28/29 в феврале). Нужен для отката
// срока при отмене платежа (Фаза Р, reverseMirrorSideEffect).
func retreatMonth(cur string, dom int) string {
	t, err := time.Parse("2006-01-02", cur)
	if err != nil {
		return cur
	}
	py, pm := prevMonth(t.Year(), t.Month())
	return dateStr(py, pm, clampedDay(py, pm, dom))
}

func prevMonth(y int, m time.Month) (int, time.Month) {
	if m == time.January {
		return y - 1, time.December
	}
	return y, m - 1
}
