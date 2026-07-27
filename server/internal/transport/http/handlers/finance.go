package handlers

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/timeutil"
	"github.com/restos/restos-v4/server/internal/service"
	httpmw "github.com/restos/restos-v4/server/internal/transport/http/middleware"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// ─── FinancialAccounts ─────────────────────────────────────────────────────

type FinancialAccountsHandler struct {
	svc *service.FinancialAccountsService
}

func NewFinancialAccounts(svc *service.FinancialAccountsService) *FinancialAccountsHandler {
	return &FinancialAccountsHandler{svc: svc}
}

func (h *FinancialAccountsHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.FinancialAccount](rows, ""))
}

// BalanceHistory — GET /api/v1/finance/accounts/balance-history?from=&to=
// Остаток по каждому счёту на конец каждого дня периода + движение за период.
// Статический сегмент пути приоритетнее {id} в chi, конфликта нет.
func (h *FinancialAccountsHandler) BalanceHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	out, err := h.svc.BalanceHistory(r.Context(), q.Get("from"), q.Get("to"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *FinancialAccountsHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.FinancialAccountInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, out)
}

func (h *FinancialAccountsHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.FinancialAccountInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.Patch(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// SetEnabled — POST /api/v1/finance/accounts/{id}/enabled  {"enabled": false}
// Отключение счёта вместо удаления: см. FinancialAccountsService.SetEnabled.
func (h *FinancialAccountsHandler) SetEnabled(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Enabled *bool `json:"enabled"`
	}
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	if in.Enabled == nil {
		respond.BadRequest(w, "enabled is required")
		return
	}
	out, err := h.svc.SetEnabled(r.Context(), chi.URLParam(r, "id"), *in.Enabled)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *FinancialAccountsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *FinancialAccountsHandler) Transfer(w http.ResponseWriter, r *http.Request) {
	var in service.AccountTransferInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.Transfer(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// ─── FinancialOperations ───────────────────────────────────────────────────

type FinancialOperationsHandler struct {
	svc *service.FinancialOperationsService
}

func NewFinancialOperations(svc *service.FinancialOperationsService) *FinancialOperationsHandler {
	return &FinancialOperationsHandler{svc: svc}
}

func (h *FinancialOperationsHandler) List(w http.ResponseWriter, r *http.Request) {
	var f service.FinancialOperationsFilter
	f.Type = queryString(r, "type")
	f.AccountID = queryString(r, "account_id")
	f.Category = queryString(r, "category")
	f.Activity = queryString(r, "activity")
	f.ShiftID = queryString(r, "shift_id")
	if v := queryString(r, "from"); v != "" {
		t, err := timeutil.ParseLooseRFC3339(v)
		if err != nil {
			respond.BadRequest(w, "bad ?from")
			return
		}
		f.From = &t
	}
	if v := queryString(r, "to"); v != "" {
		t, err := timeutil.ParseLooseRFC3339(v)
		if err != nil {
			respond.BadRequest(w, "bad ?to")
			return
		}
		f.To = &t
	}
	f.Page = parsePage(r)
	rows, next, err := h.svc.List(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.FinancialOperation](rows, next))
}

func (h *FinancialOperationsHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.FinancialOperationInput
	// Strict-decode: ручная финансовая операция → деньги. Любое лишнее
	// поле (FE через `body as any`) сразу 400 вместо silent-drop.
	if err := httpmw.DecodeStrict(r, &in); err != nil {
		respond.BadRequest(w, "invalid JSON body: "+err.Error())
		return
	}
	out, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, out)
}

// ─── CustomCategories ──────────────────────────────────────────────────────

type CustomCategoriesHandler struct {
	svc *service.CustomCategoriesService
}

func NewCustomCategories(svc *service.CustomCategoriesService) *CustomCategoriesHandler {
	return &CustomCategoriesHandler{svc: svc}
}

func (h *CustomCategoriesHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context(), queryString(r, "type"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.CustomCategory](rows, ""))
}

func (h *CustomCategoriesHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.CustomCategoryInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, out)
}

func (h *CustomCategoriesHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── FinanceReports (JSON) ─────────────────────────────────────────────────

type FinanceReportsHandler struct {
	svc *service.FinanceReportsService
}

func NewFinanceReports(svc *service.FinanceReportsService) *FinanceReportsHandler {
	return &FinanceReportsHandler{svc: svc}
}

func (h *FinanceReportsHandler) PnL(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	f.OperationalOnly = queryString(r, "operational_only") == "true"
	out, err := h.svc.PnL(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *FinanceReportsHandler) Cashflow(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.Cashflow(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *FinanceReportsHandler) Balance(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Balance(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *FinanceReportsHandler) MonthlyRevenue(w http.ResponseWriter, r *http.Request) {
	months := 12
	if v := queryString(r, "months"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			months = n
		}
	}
	rows, err := h.svc.MonthlyRevenue(r.Context(), months)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.MonthlyRevenueRow](rows, ""))
}

// ─── Salary / Service charge ───────────────────────────────────────────────

type SalaryHandler struct{ svc *service.SalaryService }

func NewSalary(svc *service.SalaryService) *SalaryHandler { return &SalaryHandler{svc: svc} }

func (h *SalaryHandler) PaySalary(w http.ResponseWriter, r *http.Request) {
	var in service.SalaryPayInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.PaySalary(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, out)
}

// SalaryReport — GET /api/v1/finance/salary/report?from=&to=
// «Кому сколько выдали и когда» за период: сводка по сотрудникам + плоский
// список выплат с датой, суммой и счётом.
func (h *SalaryHandler) SalaryReport(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	out, err := h.svc.SalaryReport(r.Context(), q.Get("from"), q.Get("to"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// SalaryAccrual — GET /api/v1/finance/salary/accrual?from=&to=
// Начислено за период по каждому сотруднику: оклад или ставка × отработанные
// дни из табеля.
func (h *SalaryHandler) SalaryAccrual(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	rows, err := h.svc.SalaryAccrual(r.Context(), q.Get("from"), q.Get("to"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList(rows, ""))
}

// WorkedDays — GET /finance/salary/worked-days?user_id=&from=&to=.
func (h *SalaryHandler) WorkedDays(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	out, err := h.svc.WorkedDays(r.Context(), q.Get("user_id"), q.Get("from"), q.Get("to"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// SetWorkedDays — PUT /finance/salary/worked-days: замена ручных отметок дней.
func (h *SalaryHandler) SetWorkedDays(w http.ResponseWriter, r *http.Request) {
	var in struct {
		UserID string   `json:"user_id"`
		From   string   `json:"from"`
		To     string   `json:"to"`
		Dates  []string `json:"dates"`
	}
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.SetWorkedDays(r.Context(), in.UserID, in.From, in.To, in.Dates)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *SalaryHandler) PayServiceCharge(w http.ResponseWriter, r *http.Request) {
	var in service.ServiceChargePayInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.PayServiceCharge(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, out)
}

func (h *SalaryHandler) AccrualByWaiter(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	rows, err := h.svc.AccrualByWaiter(r.Context(), f.From, f.To, "")
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.ServiceAccrualRow](rows, ""))
}

func (h *SalaryHandler) AccrualByShift(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.AccrualByWaiter(r.Context(), nil, nil, chi.URLParam(r, "shift_id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.ServiceAccrualRow](rows, ""))
}

func (h *SalaryHandler) PayoutByWaiter(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	rows, err := h.svc.PayoutByWaiter(r.Context(), f.From, f.To, "")
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.ServicePayoutRow](rows, ""))
}

func (h *SalaryHandler) PayoutByShift(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.PayoutByWaiter(r.Context(), nil, nil, chi.URLParam(r, "shift_id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.ServicePayoutRow](rows, ""))
}
