package handlers

import (
	"net/http"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type WarehouseHandler struct {
	svc *service.WarehouseService
}

func NewWarehouse(svc *service.WarehouseService) *WarehouseHandler {
	return &WarehouseHandler{svc: svc}
}

// List — GET /api/v1/warehouses. Возвращает 3 фиксированных склада ресторана.
func (h *WarehouseHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.Warehouse](rows, ""))
}
