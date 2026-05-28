package service

import (
	"context"
	"encoding/json"

	"github.com/rs/zerolog/log"

	"github.com/restos/restos-v4/server/internal/transport/sse"
)

// EventPublisher — обёртка над sse.Hub с двумя слоями:
//  1. внутри транзакции собираем pending-события через PublishAfterCommit;
//  2. после коммита (вызывает сервис) flush'аем их в hub.
//
// Если транзакция откатывается, события не публикуются — это инвариант.
//
// Использование:
//
//	pub := events.NewBuffer()
//	err := db.Transaction(func(tx) error {
//	    ... mutate ...
//	    pub.Add(EventOrderCreated, order)
//	    return nil
//	})
//	if err == nil { publisher.Flush(ctx, restaurantID, pub) }
type EventPublisher struct {
	hub *sse.Hub
}

func NewEventPublisher(hub *sse.Hub) *EventPublisher {
	return &EventPublisher{hub: hub}
}

// Event type names. Не енам, потому что в Phase 3 их будет много и они растут.
const (
	EventOrderCreated    = "order.created"
	EventOrderUpdated    = "order.updated"
	EventOrderClosed     = "order.closed"
	EventOrderCancelled  = "order.cancelled"
	EventOrderItemAdded  = "order.item.added"
	EventOrderItemVoided = "order.item.voided"
	EventStockMovement   = "stock.movement"
	EventShiftOpened     = "shift.opened"
	EventShiftClosed     = "shift.closed"
	EventLicenseUpdated  = "license.updated" // state changed (грейс/локед) или активирован
)

// EventBuffer накапливает события внутри транзакции.
// Thread-safe не нужен: транзакция выполняется в одной goroutine.
type EventBuffer struct {
	events []pendingEvent
}

type pendingEvent struct {
	Type string
	Data any
}

// NewBuffer создаёт пустой буфер.
func NewBuffer() *EventBuffer { return &EventBuffer{} }

// Add добавляет событие в буфер. data сериализуется в JSON при Flush.
func (b *EventBuffer) Add(eventType string, data any) {
	b.events = append(b.events, pendingEvent{Type: eventType, Data: data})
}

// Flush публикует все накопленные события в hub.
// Вызывается ПОСЛЕ успешного commit'а. Если ошибка коммита — не вызывать.
func (p *EventPublisher) Flush(ctx context.Context, restaurantID string, buf *EventBuffer) {
	if buf == nil || len(buf.events) == 0 {
		return
	}
	for _, e := range buf.events {
		data, err := json.Marshal(e.Data)
		if err != nil {
			log.Warn().Err(err).Str("type", e.Type).Msg("event marshal failed")
			continue
		}
		p.hub.Publish(sse.Event{
			RestaurantID: restaurantID,
			Type:         e.Type,
			Data:         data,
		})
	}
}
