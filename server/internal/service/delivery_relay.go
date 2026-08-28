package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// DeliveryRelayService — узкий транспорт «central пробивает заказ доставки ЗА
// филиал» (миграция 091). НЕ часть общего sync_log/sync_queue: тот синкает
// только вверх и только терминальные заказы (ADR-003), а доставке нужен
// быстрый путь ВНИЗ, до создания. central пишет строку по
// network_menu_item_id (мастер-меню сети, ADR-004), филиал забирает быстрым
// poll'ом (DeliveryPuller, delivery_pull.go) и материализует настоящий Order
// через OrdersService.Create — деньги/сток/смена считаются филиалу как за
// любой другой заказ.
type DeliveryRelayService struct {
	r *repo.Repo
}

func NewDeliveryRelayService(r *repo.Repo) *DeliveryRelayService {
	return &DeliveryRelayService{r: r}
}

// DeliveryRelayItemInput — позиция заказа при создании (central-сторона).
type DeliveryRelayItemInput struct {
	NetworkMenuItemID string `json:"network_menu_item_id"`
	Qty               string `json:"qty"`
	// VariantLabels — см. models.DeliveryRelayItem.VariantLabels.
	VariantLabels []string `json:"variant_labels,omitempty"`
}

// CreateDeliveryRelayInput — body POST /api/v1/delivery-relay.
type CreateDeliveryRelayInput struct {
	TargetRestaurantID string `json:"target_restaurant_id"`
	// OrderType — hall|takeaway|delivery. Пусто → delivery (обратная
	// совместимость со старыми клиентами, до 092 relay был только про
	// доставку). Определяет, в какую секцию кассы филиала попадёт заказ —
	// не только «Доставка».
	OrderType       string                   `json:"order_type,omitempty"`
	Items           []DeliveryRelayItemInput `json:"items"`
	DeliveryPhone   *string                  `json:"delivery_phone,omitempty"`
	DeliveryAddress *string                  `json:"delivery_address,omitempty"`
	Comment         *string                  `json:"comment,omitempty"`
}

// Create — POST /api/v1/delivery-relay, central-сторона (обычная user-сессия
// через middleware.Auth, НЕ sync-токен). Отправлять заказ филиалу может
// только сам central своей сети — тот же гвард по kind+account_id, что
// requireCentralOwner (network_invites.go), но БЕЗ ограничения ролью owner:
// диспетчеризация доставки — операционное действие ежедневного цикла, не
// управление составом сети.
func (s *DeliveryRelayService) Create(ctx context.Context, in CreateDeliveryRelayInput) (*models.DeliveryRelayOrder, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.TargetRestaurantID == "" {
		return nil, apperrors.Wrap("VALIDATION", "укажите филиал-получатель", nil)
	}
	if len(in.Items) == 0 {
		return nil, apperrors.Wrap("VALIDATION", "заказ должен содержать хотя бы одну позицию", nil)
	}
	orderType := in.OrderType
	if orderType == "" {
		orderType = "delivery"
	}
	if orderType != "hall" && orderType != "takeaway" && orderType != "delivery" {
		return nil, apperrors.Wrap("VALIDATION", "order_type must be hall, takeaway or delivery", nil)
	}
	// Дедуп: несколько ВАРИАНТОВ одного товара (Мини+Стандарт одного
	// «Гамбургера») шлют один и тот же network_menu_item_id родителя дважды —
	// без дедупа len(masters) (SQL IN схлопывает дубли в одну строку) не
	// совпадёт с len(ids) и валидный заказ отклонится как «не найден в сети».
	seenID := make(map[string]bool, len(in.Items))
	ids := make([]string, 0, len(in.Items))
	for _, it := range in.Items {
		if it.NetworkMenuItemID == "" || it.Qty == "" {
			return nil, apperrors.Wrap("VALIDATION", "у каждой позиции нужны network_menu_item_id и qty", nil)
		}
		if !seenID[it.NetworkMenuItemID] {
			seenID[it.NetworkMenuItemID] = true
			ids = append(ids, it.NetworkMenuItemID)
		}
	}

	var rest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", rid).First(&rest).Error; err != nil {
		return nil, err
	}
	if rest.Kind == nil || *rest.Kind != "central_warehouse" {
		return nil, apperrors.Wrap("VALIDATION", "отправлять заказ филиалу может только центральный узел сети", nil)
	}
	if rest.AccountID == nil || *rest.AccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "ресторан не в сети", nil)
	}
	account := *rest.AccountID

	var branch models.Restaurant
	if err := s.r.Raw().WithContext(ctx).
		Where("id = ? AND account_id = ?", in.TargetRestaurantID, account).
		First(&branch).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.Wrap("VALIDATION", "филиал не найден в этой сети", nil)
		}
		return nil, err
	}

	// Валидируем позиции ПРОТИВ мастер-меню сети сразу — иначе опечатка в id
	// всплывёт только на филиале минуты спустя как молчаливый failed. Заодно
	// тянем Attributes — тем же запросом сверяем VariantLabels против
	// combos[] мастера (092), а не только сам id товара.
	var masters []models.NetworkMenuItem
	if err := s.r.Raw().WithContext(ctx).
		Where("id IN ? AND account_id = ? AND deleted_at IS NULL", ids, account).
		Find(&masters).Error; err != nil {
		return nil, err
	}
	if len(masters) != len(ids) {
		return nil, apperrors.Wrap("VALIDATION", "одна или несколько позиций не найдены в меню сети", nil)
	}
	mastersByID := make(map[string]models.NetworkMenuItem, len(masters))
	for _, m := range masters {
		mastersByID[m.ID] = m
	}
	for _, it := range in.Items {
		if len(it.VariantLabels) == 0 {
			continue
		}
		m := mastersByID[it.NetworkMenuItemID]
		attrs, _, err := parseNetworkMenuAttrs(json.RawMessage(m.Attributes))
		if err != nil || attrs == nil {
			return nil, apperrors.Wrap("VALIDATION", "у «"+m.Name+"» нет вариаций в меню сети", nil)
		}
		target := comboLabelKey(it.VariantLabels)
		found := false
		for _, c := range attrs.Combos {
			if comboLabelKey(c.Labels) == target {
				found = true
				break
			}
		}
		if !found {
			return nil, apperrors.Wrap("VALIDATION", "вариант «"+strings.Join(it.VariantLabels, ", ")+"» не найден у «"+m.Name+"» в меню сети", nil)
		}
	}

	items := make([]models.DeliveryRelayItem, 0, len(in.Items))
	for _, it := range in.Items {
		items = append(items, models.DeliveryRelayItem{NetworkMenuItemID: it.NetworkMenuItemID, Qty: it.Qty, VariantLabels: it.VariantLabels})
	}
	itemsJSON, err := json.Marshal(items)
	if err != nil {
		return nil, err
	}

	row := &models.DeliveryRelayOrder{
		AccountID:          account,
		RestaurantID:       rid,
		TargetRestaurantID: in.TargetRestaurantID,
		OrderType:          orderType,
		Items:              datatypes.JSON(itemsJSON),
		DeliveryPhone:      in.DeliveryPhone,
		DeliveryAddress:    in.DeliveryAddress,
		Comment:            in.Comment,
		Status:             "pending",
	}
	if err := s.r.Raw().WithContext(ctx).Create(row).Error; err != nil {
		return nil, err
	}
	return row, nil
}

// ListPending — GET /api/v1/sync/delivery/pending?restaurant_id=X, филиал.
func (s *DeliveryRelayService) ListPending(ctx context.Context, restaurantID string) ([]models.DeliveryRelayOrder, error) {
	if restaurantID == "" {
		return nil, apperrors.Wrap("VALIDATION", "restaurant_id is required", nil)
	}
	var rows []models.DeliveryRelayOrder
	if err := s.r.Raw().WithContext(ctx).
		Where("target_restaurant_id = ? AND status = ?", restaurantID, "pending").
		Order("created_at ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// AckDeliveryRelayInput — body POST /api/v1/sync/delivery/{id}/ack.
type AckDeliveryRelayInput struct {
	Status       string  `json:"status"` // delivered|failed
	LocalOrderID *string `json:"local_order_id,omitempty"`
	Error        *string `json:"error,omitempty"`
}

// Ack — филиал подтверждает результат материализации. Идемпотентно:
// повторный ack с тем же результатом — не ошибка (сеть могла оборваться уже
// ПОСЛЕ того, как первый ack применился на central).
func (s *DeliveryRelayService) Ack(ctx context.Context, id, restaurantID string, in AckDeliveryRelayInput) error {
	if in.Status != "delivered" && in.Status != "failed" {
		return apperrors.Wrap("VALIDATION", "status must be delivered or failed", nil)
	}
	now := time.Now().UTC()
	updates := map[string]any{"status": in.Status, "updated_at": now}
	if in.Status == "delivered" {
		updates["delivered_at"] = now
	}
	if in.LocalOrderID != nil && *in.LocalOrderID != "" {
		updates["local_order_id"] = *in.LocalOrderID
	}
	if in.Error != nil {
		updates["error"] = *in.Error
	}
	q := s.r.Raw().WithContext(ctx).Model(&models.DeliveryRelayOrder{}).Where("id = ?", id)
	// restaurantID — из личного sync-токена филиала, если он опознан
	// (SyncCallerID); легаси общий секрет узел не опознаёт, тогда не сужаем.
	if restaurantID != "" {
		q = q.Where("target_restaurant_id = ?", restaurantID)
	}
	res := q.Updates(updates)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}
