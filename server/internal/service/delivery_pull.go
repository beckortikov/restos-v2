package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// DeliveryPuller — сторона ФИЛИАЛА. Симметричен Puller (sync_pull.go), но
// отдельный: тянет НЕ общий sync_log (тот только терминальные заказы раз в
// interval_sec, ADR-003), а узкую очередь delivery_relay_orders (091), своим
// значительно более коротким интервалом — заказ на доставку должен начать
// готовиться сразу, а не после общего 30-секундного цикла синхронизации.
//
// На каждый pending-заказ: резолвит позиции в локальные menu_items (по
// master_id, ADR-004), материализует НАСТОЯЩИЙ Order через OrdersService.Create
// и печатает пре-чек (PrintPreBill) — деньги/сток/смена считаются филиалу как
// за любой другой заказ. Читает central_url/token/restaurant_id из ТОЙ ЖЕ
// sync_settings (singleton), что и обычный Puller — это тот же доверенный
// central, отдельного конфига заводить незачем.
type DeliveryPuller struct {
	ordersSvc *OrdersService
	r         *repo.Repo
	client    *http.Client
	fallback  PullerFallback
}

func NewDeliveryPuller(ordersSvc *OrdersService, r *repo.Repo, fallback PullerFallback) *DeliveryPuller {
	return &DeliveryPuller{ordersSvc: ordersSvc, r: r, client: &http.Client{Timeout: 30 * time.Second}, fallback: fallback}
}

func (p *DeliveryPuller) activeConfig(ctx context.Context) (centralURL, token, restaurantID string, enabled bool, err error) {
	var st models.SyncSettings
	err = p.r.Raw().WithContext(ctx).Where("id = 1").First(&st).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return p.fallback.CentralURL, p.fallback.Token, p.fallback.RestaurantID, p.fallback.Enabled, nil
	}
	if err != nil {
		return "", "", "", false, err
	}
	if st.CentralURL != nil {
		centralURL = *st.CentralURL
	}
	if st.Token != nil {
		token = *st.Token
	}
	if st.RestaurantID != nil {
		restaurantID = *st.RestaurantID
	}
	return centralURL, token, restaurantID, st.Enabled, nil
}

// deliveryRelayOrderOut — зеркало ответа GET /api/v1/sync/delivery/pending
// (см. handlers/delivery_relay.go / models.DeliveryRelayOrder).
type deliveryRelayOrderOut struct {
	ID        string `json:"id"`
	OrderType string `json:"order_type"`
	// Kind — create|amend (094). Пусто (старые relay-строки до 094) →
	// create, как было раньше.
	Kind            string                     `json:"kind"`
	ParentRelayID   *string                    `json:"parent_relay_id"`
	Items           []models.DeliveryRelayItem `json:"items"`
	DeliveryPhone   *string                    `json:"delivery_phone"`
	DeliveryAddress *string                    `json:"delivery_address"`
	Comment         *string                    `json:"comment"`
}

// PullOnce тянет и материализует один батч. Возвращает число успешно
// доставленных (delivered) заказов.
func (p *DeliveryPuller) PullOnce(ctx context.Context) (int, error) {
	centralURL, token, restaurantID, enabled, err := p.activeConfig(ctx)
	if err != nil {
		return 0, err
	}
	if !enabled || centralURL == "" || restaurantID == "" {
		return 0, nil
	}

	u := centralURL + "/api/v1/sync/delivery/pending?restaurant_id=" + url.QueryEscape(restaurantID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return 0, fmt.Errorf("delivery relay pull %d: %s", resp.StatusCode, b)
	}
	var out struct {
		Orders []deliveryRelayOrderOut `json:"orders"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, err
	}

	delivered := 0
	for _, ro := range out.Orders {
		if p.processOne(ctx, centralURL, token, restaurantID, ro) {
			delivered++
		}
	}
	return delivered, nil
}

// processOne материализует один relay-заказ (или переиспользует уже
// материализованный — см. delivery_relay_received) и шлёт ack. Возвращает
// true при успешной доставке (для метрики вызывающего PullOnce). kind=amend
// (094) уходит в отдельную ветку — processAmend; kind=create (или пусто —
// старые relay-строки до 094) — исходное поведение, без изменений.
func (p *DeliveryPuller) processOne(ctx context.Context, centralURL, token, restaurantID string, ro deliveryRelayOrderOut) bool {
	// Уже материализован локально (напр. предыдущий ack не дошёл до central
	// из-за обрыва сети) — не создаём/не дозаказываем повторно, просто
	// повторяем ack. Для amend это тот же localOrderID, что у родителя — см.
	// запись в конце processAmend.
	var already models.DeliveryRelayReceived
	err := p.r.Raw().WithContext(ctx).Where("relay_order_id = ?", ro.ID).First(&already).Error
	if err == nil {
		p.ack(ctx, centralURL, token, ro.ID, AckDeliveryRelayInput{Status: "delivered", LocalOrderID: &already.LocalOrderID})
		return true
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		log.Warn().Err(err).Str("relay_order_id", ro.ID).Msg("delivery relay: local lookup failed")
		return false
	}

	if ro.Kind == "amend" {
		return p.processAmend(ctx, centralURL, token, restaurantID, ro)
	}
	return p.processCreate(ctx, centralURL, token, restaurantID, ro)
}

// processCreate — материализует НОВЫЙ заказ (исходное поведение relay, 091).
func (p *DeliveryPuller) processCreate(ctx context.Context, centralURL, token, restaurantID string, ro deliveryRelayOrderOut) bool {
	items, resolveErr := p.resolveItems(ctx, restaurantID, ro.Items)
	if resolveErr != nil {
		msg := resolveErr.Error()
		p.ack(ctx, centralURL, token, ro.ID, AckDeliveryRelayInput{Status: "failed", Error: &msg})
		return false
	}

	// order_type — hall|takeaway|delivery, диспетчер central выбирает сам
	// (092): заказ должен попасть в ту же секцию кассы филиала, что и
	// обычный заказ такого типа, не всегда «Доставка». Пусто (старые
	// relay-строки до 092) → delivery, как было раньше.
	orderType := ro.OrderType
	if orderType == "" {
		orderType = "delivery"
	}
	octx := audit.WithActor(tenant.WithRestaurant(ctx, restaurantID), audit.Actor{UserName: "Central (доставка)"})
	order, _, err := p.ordersSvc.Create(octx, CreateOrderInput{
		Type:    orderType,
		Comment: ro.Comment,
		Items:   items,
	})
	if err != nil {
		msg := err.Error()
		p.ack(ctx, centralURL, token, ro.ID, AckDeliveryRelayInput{Status: "failed", Error: &msg})
		return false
	}

	// Контакты доставки — тем же путём, что касса перед оплатой (PatchOrder,
	// #052): Create() их не принимает, это поле обычной кассовой формы, не
	// создания заказа. Здесь они уже известны сразу, ждать оплаты незачем —
	// курьеру нужно выезжать сейчас, а не после того, как заказ закроют.
	if ro.DeliveryPhone != nil || ro.DeliveryAddress != nil {
		if _, err := p.ordersSvc.PatchOrder(octx, order.ID, OrderPatchInput{
			DeliveryPhone: ro.DeliveryPhone, DeliveryAddress: ro.DeliveryAddress,
		}); err != nil {
			log.Warn().Err(err).Str("order_id", order.ID).Msg("delivery relay: failed to set delivery contacts")
		}
	}

	// Пре-чек — не блокирует ack: заказ уже реален и корректно посчитан
	// филиалу, отсутствие/сбой чекового принтера — отдельная эксплуатационная
	// проблема (см. PrintPreBill: 412, если ни одного не настроено), решать
	// заказ из-за неё не должен.
	if _, err := p.ordersSvc.PrintPreBill(octx, order.ID); err != nil {
		log.Warn().Err(err).Str("order_id", order.ID).Msg("delivery relay: pre-bill print failed")
	}

	p.recordReceived(ctx, ro.ID, order.ID)
	p.ack(ctx, centralURL, token, ro.ID, AckDeliveryRelayInput{Status: "delivered", LocalOrderID: &order.ID})
	return true
}

// processAmend — дозаказ (094) в заказ, уже материализованный родительской
// create-строкой (ro.ParentRelayID). Резолвит local_order_id родителя через
// ЕГО СОБСТВЕННУЮ запись в delivery_relay_received (не заводит новый заказ),
// добавляет позиции обычным OrdersService.AddItems — тем же путём, которым
// официант дозаказывает вживую: печатает кухонный тикет только на новые
// позиции, сам решает merge с уже пробитыми строками. Если заказ УЖЕ закрыт
// на кассе к моменту обработки — AddItems вернёт CONFLICT, дозаказ падает в
// failed с понятной причиной, central это увидит в истории (#2), а не тихо
// потеряет заказ: central не может знать заранее, успел ли кассир закрыть
// заказ, спрашивать смысла нет — филиал сам решает по факту.
func (p *DeliveryPuller) processAmend(ctx context.Context, centralURL, token, restaurantID string, ro deliveryRelayOrderOut) bool {
	if ro.ParentRelayID == nil || *ro.ParentRelayID == "" {
		msg := "дозаказ без ссылки на исходный заказ"
		p.ack(ctx, centralURL, token, ro.ID, AckDeliveryRelayInput{Status: "failed", Error: &msg})
		return false
	}
	var parentReceived models.DeliveryRelayReceived
	if err := p.r.Raw().WithContext(ctx).Where("relay_order_id = ?", *ro.ParentRelayID).First(&parentReceived).Error; err != nil {
		msg := "исходный заказ ещё не материализован на этой кассе"
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			log.Warn().Err(err).Str("relay_order_id", ro.ID).Msg("delivery relay amend: parent lookup failed")
			msg = err.Error()
		}
		p.ack(ctx, centralURL, token, ro.ID, AckDeliveryRelayInput{Status: "failed", Error: &msg})
		return false
	}

	items, resolveErr := p.resolveItems(ctx, restaurantID, ro.Items)
	if resolveErr != nil {
		msg := resolveErr.Error()
		p.ack(ctx, centralURL, token, ro.ID, AckDeliveryRelayInput{Status: "failed", Error: &msg})
		return false
	}

	octx := audit.WithActor(tenant.WithRestaurant(ctx, restaurantID), audit.Actor{UserName: "Central (доставка)"})
	if _, _, err := p.ordersSvc.AddItems(octx, parentReceived.LocalOrderID, AddItemsInput{Items: items}); err != nil {
		msg := err.Error()
		p.ack(ctx, centralURL, token, ro.ID, AckDeliveryRelayInput{Status: "failed", Error: &msg})
		return false
	}

	p.recordReceived(ctx, ro.ID, parentReceived.LocalOrderID)
	p.ack(ctx, centralURL, token, ro.ID, AckDeliveryRelayInput{Status: "delivered", LocalOrderID: &parentReceived.LocalOrderID})
	return true
}

// recordReceived — идемпотентность ДО ack (и для create, и для amend) —
// если ack не дойдёт, следующий тик найдёт эту запись и не продублирует
// заказ/дозаказ повторно.
func (p *DeliveryPuller) recordReceived(ctx context.Context, relayID, localOrderID string) {
	if err := p.r.Raw().WithContext(ctx).Exec(
		`INSERT INTO delivery_relay_received (relay_order_id, local_order_id) VALUES (?, ?) ON CONFLICT (relay_order_id) DO NOTHING`,
		relayID, localOrderID,
	).Error; err != nil {
		log.Warn().Err(err).Str("relay_order_id", relayID).Msg("delivery relay: failed to record idempotency ledger")
	}
}

// resolveItems — network_menu_item_id (мастер-меню сети) → локальный
// menu_items.id этого филиала, по menu_items.master_id (ADR-004). Всё или
// ничего: если хоть одна позиция не материализована на филиале, вся
// relay-строка падает в failed, а не создаёт частичный заказ.
func (p *DeliveryPuller) resolveItems(ctx context.Context, restaurantID string, items []models.DeliveryRelayItem) ([]CreateOrderItem, error) {
	if len(items) == 0 {
		return nil, errors.New("в заказе нет позиций")
	}
	masterIDs := make([]string, 0, len(items))
	for _, it := range items {
		masterIDs = append(masterIDs, it.NetworkMenuItemID)
	}
	var local []models.MenuItem
	if err := p.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND master_id IN ? AND is_deleted = false", restaurantID, masterIDs).
		Find(&local).Error; err != nil {
		return nil, err
	}
	byMaster := make(map[string]models.MenuItem, len(local))
	for _, m := range local {
		if m.MasterID != nil {
			byMaster[*m.MasterID] = m
		}
	}
	out := make([]CreateOrderItem, 0, len(items))
	for _, it := range items {
		m, ok := byMaster[it.NetworkMenuItemID]
		if !ok {
			return nil, fmt.Errorf("товар не найден на филиале (network_menu_item_id=%s)", it.NetworkMenuItemID)
		}
		itemID := m.ID
		if len(it.VariantLabels) > 0 {
			variantID, err := p.resolveVariant(ctx, restaurantID, m.ID, it.VariantLabels)
			if err != nil {
				return nil, fmt.Errorf("«%s»: %w", strOrEmpty(m.Name), err)
			}
			itemID = variantID
		} else {
			hasVariants, err := p.hasVariants(ctx, restaurantID, m.ID)
			if err != nil {
				return nil, err
			}
			if hasVariants {
				return nil, fmt.Errorf("«%s»: не указан вариант", strOrEmpty(m.Name))
			}
		}
		out = append(out, CreateOrderItem{MenuItemID: itemID, Qty: it.Qty})
	}
	return out, nil
}

// hasVariants — есть ли у локального продукта сгенерированные варианты
// (parent_id → него). Если да, сам продукт не продаётся напрямую — POS
// всегда уводит в пикер вариантов (app/pos2/order/page.tsx: variantsByParent),
// значит relay-строка без VariantLabels для такого товара — баг отправителя,
// а не «товар без вариаций».
func (p *DeliveryPuller) hasVariants(ctx context.Context, restaurantID, parentID string) (bool, error) {
	var count int64
	if err := p.r.Raw().WithContext(ctx).Model(&models.MenuItem{}).
		Where("restaurant_id = ? AND parent_id = ? AND is_deleted = false", restaurantID, parentID).
		Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

// resolveVariant — находит дочерний вариант локального продукта по лейблам
// комбинации, в canonical-порядке атрибутов продукта (по MenuAttribute.
// SortOrder) — тот же порядок, что central использует для VariantLabels
// (см. app/pos2/order/page.tsx submitDispatch). Сеть не хранит id вариантов
// (084) — сами лейблы это единственный портируемый идентификатор комбинации
// между central и филиалом, id атрибутов/значений на обоих узлах разные.
func (p *DeliveryPuller) resolveVariant(ctx context.Context, restaurantID, parentID string, labels []string) (string, error) {
	var attrs []models.MenuAttribute
	if err := p.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND menu_item_id = ?", restaurantID, parentID).
		Order("sort_order ASC").Find(&attrs).Error; err != nil {
		return "", err
	}
	attrOrder := make(map[string]int, len(attrs))
	attrIDs := make([]string, len(attrs))
	for i, a := range attrs {
		attrOrder[a.ID] = i
		attrIDs[i] = a.ID
	}
	var values []models.MenuAttributeValue
	if len(attrIDs) > 0 {
		if err := p.r.Raw().WithContext(ctx).Where("attribute_id IN ?", attrIDs).Find(&values).Error; err != nil {
			return "", err
		}
	}
	type valueMeta struct {
		order int
		label string
	}
	metaByValueID := make(map[string]valueMeta, len(values))
	for _, v := range values {
		metaByValueID[v.ID] = valueMeta{order: attrOrder[v.AttributeID], label: v.Label}
	}

	var variants []models.MenuItem
	if err := p.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND parent_id = ? AND is_deleted = false", restaurantID, parentID).
		Find(&variants).Error; err != nil {
		return "", err
	}
	variantIDs := make([]string, len(variants))
	for i, v := range variants {
		variantIDs[i] = v.ID
	}
	var links []models.MenuItemVariantValue
	if len(variantIDs) > 0 {
		if err := p.r.Raw().WithContext(ctx).Where("menu_item_id IN ?", variantIDs).Find(&links).Error; err != nil {
			return "", err
		}
	}
	valueIDsByVariant := make(map[string][]string, len(variants))
	for _, l := range links {
		valueIDsByVariant[l.MenuItemID] = append(valueIDsByVariant[l.MenuItemID], l.ValueID)
	}

	target := comboLabelKey(labels)
	for _, v := range variants {
		metas := make([]valueMeta, 0, len(valueIDsByVariant[v.ID]))
		for _, id := range valueIDsByVariant[v.ID] {
			if meta, ok := metaByValueID[id]; ok {
				metas = append(metas, meta)
			}
		}
		sort.Slice(metas, func(i, j int) bool { return metas[i].order < metas[j].order })
		combo := make([]string, len(metas))
		for i, m := range metas {
			combo[i] = m.label
		}
		if comboLabelKey(combo) == target {
			return v.ID, nil
		}
	}
	return "", fmt.Errorf("вариант «%s» не найден", strings.Join(labels, " "))
}

func (p *DeliveryPuller) ack(ctx context.Context, centralURL, token, relayID string, in AckDeliveryRelayInput) {
	body, err := json.Marshal(in)
	if err != nil {
		log.Warn().Err(err).Msg("delivery relay: ack marshal failed")
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, centralURL+"/api/v1/sync/delivery/"+relayID+"/ack", bytes.NewReader(body))
	if err != nil {
		log.Warn().Err(err).Msg("delivery relay: ack request build failed")
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		log.Warn().Err(err).Str("relay_order_id", relayID).Msg("delivery relay: ack failed")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		log.Warn().Str("relay_order_id", relayID).Int("status", resp.StatusCode).Bytes("body", b).Msg("delivery relay: ack rejected")
	}
}

// Run гоняет PullOnce по таймеру до отмены ctx. Запускается БЕЗУСЛОВНО, как и
// Puller — activeConfig на каждом тике сам решает, есть ли что делать.
func (p *DeliveryPuller) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	log.Info().Dur("interval", interval).Msg("delivery relay puller started")
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("delivery relay puller stopped")
			return
		case <-ticker.C:
			if _, err := p.PullOnce(ctx); err != nil {
				log.Warn().Err(err).Msg("delivery relay pull failed")
			}
		}
	}
}
