package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// NetworkHandler — сетевые справочники multi-branch (ADR-003, Фаза 1):
// филиалы, общий каталог номенклатуры, привязка ингредиентов.
type NetworkHandler struct {
	svc *service.NetworkService
}

func NewNetwork(svc *service.NetworkService) *NetworkHandler {
	return &NetworkHandler{svc: svc}
}

// ListBranches — GET /api/v1/network/branches.
func (h *NetworkHandler) ListBranches(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.ListBranches(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.Branch](rows, ""))
}

// Summary — GET /api/v1/network/summary?from=&to=. Сводка выручки владельцу.
func (h *NetworkHandler) Summary(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Summary(r.Context(), r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// PnL — GET /api/v1/network/pnl?from=&to=. Сводный P&L сети (Ф8).
func (h *NetworkHandler) PnL(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.PnL(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Cashflow — GET /api/v1/network/cashflow?from=&to=. Сводный ДДС сети (Ф8).
func (h *NetworkHandler) Cashflow(w http.ResponseWriter, r *http.Request) {
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

// Warehouse — GET /api/v1/network/warehouse. Стоимость остатков по сети (Ф8).
func (h *NetworkHandler) Warehouse(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Warehouse(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Accounts — GET /api/v1/network/accounts. Все счета сети с балансами (Ф8).
func (h *NetworkHandler) Accounts(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Accounts(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Dashboard — GET /api/v1/network/dashboard?from=&to=. Сводка «на сегодня»
// по всей сети для главного экрана central (Ф-С1).
func (h *NetworkHandler) Dashboard(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.Dashboard(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// DashboardDetail — GET /api/v1/network/dashboard-detail?from=&to=. Тяжёлая
// item-level часть дашборда central (топ блюда/категории/оплата/склад/типы/
// часы) — отдельно от Dashboard, см. головной комментарий DashboardDetail.
func (h *NetworkHandler) DashboardDetail(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.DashboardDetail(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// MonthlyRevenue — GET /api/v1/network/monthly-revenue?months=N. Тренд
// «Динамика выручки» по всей сети для главного дашборда central.
func (h *NetworkHandler) MonthlyRevenue(w http.ResponseWriter, r *http.Request) {
	months := 6
	if v := r.URL.Query().Get("months"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			months = n
		}
	}
	out, err := h.svc.MonthlyRevenue(r.Context(), months)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList(out, ""))
}

// Shifts — GET /api/v1/network/shifts?from=&to=&branch_id=&status=. Сводный
// список смен по всей сети — «Операции» на central скрыты целиком (Ф-С4), это
// единственный способ увидеть смены филиалов из центра.
func (h *NetworkHandler) Shifts(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.Shifts(r.Context(), f, r.URL.Query().Get("branch_id"), r.URL.Query().Get("status"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// ShiftZReport — GET /api/v1/network/shifts/{id}/zreport. Полный Z-отчёт
// одной смены сети (тот же формат, что у /shifts/{id}/zreport).
func (h *NetworkHandler) ShiftZReport(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.ShiftZReport(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// ─── Аналитика сети ─────────────────────────────────────────────────────
// Владелец 2026-08-25: «весь раздел аналитики тоже должен в центре
// показывать всю сводную по филиалам». Та же логика periodFilter-based
// маршрутизации, что у остальных /network/* отчётов.

func (h *NetworkHandler) PeakHours(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.PeakHours(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *NetworkHandler) ABCMenu(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.ABCMenuNetwork(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *NetworkHandler) ABCInventory(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.ABCInventoryNetwork(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *NetworkHandler) SalesReport(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.SalesReportNetwork(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Staff — GET /api/v1/network/staff. Весь персонал сети с указанием филиала.
func (h *NetworkHandler) Staff(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Staff(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// ListNetworkMenu — GET /api/v1/network/menu.
func (h *NetworkHandler) ListNetworkMenu(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.ListNetworkMenu(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.NetworkMenuItem](rows, ""))
}

// CreateNetworkMenuItem — POST /api/v1/network/menu.
func (h *NetworkHandler) CreateNetworkMenuItem(w http.ResponseWriter, r *http.Request) {
	var in service.NetworkMenuInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	m, err := h.svc.CreateNetworkMenuItem(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, m)
}

// UpdateNetworkMenuItem — PATCH /api/v1/network/menu/{id}.
func (h *NetworkHandler) UpdateNetworkMenuItem(w http.ResponseWriter, r *http.Request) {
	var in service.NetworkMenuInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	m, err := h.svc.UpdateNetworkMenuItem(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, m)
}

// CreateNetwork — POST /api/v1/network. Заводит сеть, текущий ресторан —
// центральный склад.
func (h *NetworkHandler) CreateNetwork(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	acc, err := h.svc.CreateNetwork(r.Context(), in.Name)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, acc)
}

// SetBranchKind — POST /api/v1/network/branches/{id}/kind.
func (h *NetworkHandler) SetBranchKind(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Kind string `json:"kind"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	if err := h.svc.SetBranchKind(r.Context(), chi.URLParam(r, "id"), in.Kind); err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DetachBranch — POST /api/v1/network/branches/{id}/detach. Отключить филиал
// от сети. Данные, которые он уже прислал, сохраняются.
func (h *NetworkHandler) DetachBranch(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.DetachBranch(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// PayBranchSalary — POST /api/v1/network/payroll/pay. Выплата сотруднику
// филиала со счёта центрального узла (ADR-003, Фаза Р).
func (h *NetworkHandler) PayBranchSalary(w http.ResponseWriter, r *http.Request) {
	var in service.PayBranchSalaryInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	op, err := h.svc.PayBranchSalary(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, op)
}

// BranchPayables — GET /api/v1/network/branches/{id}/payables. Что филиал
// должен: долги по накладным + регулярные платежи (ADR-003, Фаза Р).
func (h *NetworkHandler) BranchPayables(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.BranchPayables(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList(rows, ""))
}

// PayBranchExpense — POST /api/v1/network/expenses/pay. Центр оплачивает
// расход филиала (ADR-003, Фаза Р).
func (h *NetworkHandler) PayBranchExpense(w http.ResponseWriter, r *http.Request) {
	var in service.PayBranchExpenseInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	op, err := h.svc.PayBranchExpense(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, op)
}

// RequestMoneyTransfer — POST /api/v1/network/money-transfers/request. Центр
// заводит запрос на списание со счёта филиала (Ф-Ц) — реальное движение денег
// произойдёт на самом филиале при получении, см. NetworkService.RequestMoneyTransfer.
func (h *NetworkHandler) RequestMoneyTransfer(w http.ResponseWriter, r *http.Request) {
	var in service.RequestMoneyTransferInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	t, err := h.svc.RequestMoneyTransfer(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, t)
}

// BranchExpenses — GET /api/v1/network/branches/{id}/expenses. Что центр уже
// оплатил за этот филиал (ADR-003, Фаза Р).
func (h *NetworkHandler) BranchExpenses(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.BranchExpenses(r.Context(), chi.URLParam(r, "id"), 0)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList(rows, ""))
}

// CancelBranchExpense — POST /api/v1/network/expenses/{id}/cancel. Отмена
// расхода, проведённого центром за филиал: деньги обратно, зеркало у филиала
// снимается, долг и срок откатываются.
func (h *NetworkHandler) CancelBranchExpense(w http.ResponseWriter, r *http.Request) {
	op, err := h.svc.CancelBranchExpense(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, op)
}

// DeleteNomenclature — DELETE /api/v1/nomenclature/{id}. Убирает запись из
// каталога сети; товары филиалов отвязываются, но не удаляются.
func (h *NetworkHandler) DeleteNomenclature(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.DeleteNomenclature(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ListNomenclature — GET /api/v1/nomenclature.
func (h *NetworkHandler) ListNomenclature(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.ListNomenclature(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.Nomenclature](rows, ""))
}

// CreateNomenclature — POST /api/v1/nomenclature.
func (h *NetworkHandler) CreateNomenclature(w http.ResponseWriter, r *http.Request) {
	var in service.CreateNomenclatureInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	n, err := h.svc.CreateNomenclature(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, n)
}

// LinkIngredient — POST /api/v1/stock/ingredients/{id}/nomenclature.
func (h *NetworkHandler) LinkIngredient(w http.ResponseWriter, r *http.Request) {
	var in struct {
		NomenclatureID string `json:"nomenclature_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	if err := h.svc.LinkIngredient(r.Context(), chi.URLParam(r, "id"), in.NomenclatureID); err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]string{"status": "linked"})
}
