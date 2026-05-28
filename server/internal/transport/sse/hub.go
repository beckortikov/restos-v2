// Package sse — in-memory hub для Server-Sent Events.
//
// В Phase 2 шлёт только heartbeat. В Phase 3 сюда придут domain-события:
// order_created, order_status_changed, stock_low и т.д.
//
// Архитектура:
//   - Один Hub на процесс.
//   - На каждого клиента создаётся Subscriber c буферизованным каналом.
//   - Publish(event) рассылает всем подписчикам соответствующего ресторана.
//   - Если канал переполнен (медленный клиент) — событие дропается, клиент
//     не блокирует hub.
package sse

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Event — единица потока.
type Event struct {
	// RestaurantID определяет, кому шлём (или "" — broadcast системный).
	RestaurantID string
	// Type — имя SSE-события (`event: <Type>` в потоке).
	Type string
	// Data — сериализованное тело (обычно JSON).
	Data []byte
}

// Hub — реестр подписчиков.
type Hub struct {
	mu          sync.RWMutex
	subscribers map[*subscriber]struct{}

	// Heartbeat interval. Если 0 — не шлём.
	heartbeatEvery time.Duration

	// Метрики (atomic, для будущего /metrics endpoint).
	publishes  atomic.Int64
	dropped    atomic.Int64
	subscribed atomic.Int64
}

type subscriber struct {
	restaurantID string
	ch           chan Event
}

// NewHub создаёт хаб. heartbeat — интервал между «ping»-эвентами (0 = выкл).
func NewHub(heartbeat time.Duration) *Hub {
	return &Hub{
		subscribers:    make(map[*subscriber]struct{}),
		heartbeatEvery: heartbeat,
	}
}

// Publish рассылает событие подписчикам своего ресторана.
// Медленных клиентов пропускаем (drop) — это сознательная стратегия.
func (h *Hub) Publish(e Event) {
	h.publishes.Add(1)
	h.mu.RLock()
	defer h.mu.RUnlock()
	for sub := range h.subscribers {
		if sub.restaurantID != e.RestaurantID {
			continue
		}
		select {
		case sub.ch <- e:
		default:
			h.dropped.Add(1)
		}
	}
}

// ServeHTTP — handler для /api/v1/events. Требует tenant в context'е
// (auth middleware кладёт).
//
// Протокол: text/event-stream. Каждые heartbeatEvery шлёт `: ping`.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request, restaurantID string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // на случай прокси

	sub := &subscriber{
		restaurantID: restaurantID,
		ch:           make(chan Event, 64),
	}
	h.mu.Lock()
	h.subscribers[sub] = struct{}{}
	h.mu.Unlock()
	h.subscribed.Add(1)

	defer func() {
		h.mu.Lock()
		delete(h.subscribers, sub)
		h.mu.Unlock()
		close(sub.ch)
	}()

	// Сразу шлём "hello", чтобы клиент знал, что коннект жив.
	fmt.Fprintf(w, "event: hello\ndata: {\"restaurant_id\":%q}\n\n", restaurantID)
	flusher.Flush()

	var ticker *time.Ticker
	if h.heartbeatEvery > 0 {
		ticker = time.NewTicker(h.heartbeatEvery)
		defer ticker.Stop()
	}

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case e := <-sub.ch:
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e.Type, e.Data)
			flusher.Flush()
		case <-tickerC(ticker):
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func tickerC(t *time.Ticker) <-chan time.Time {
	if t == nil {
		return nil // блокирующий канал — select его игнорирует
	}
	return t.C
}

// Stats возвращает текущие счётчики (для дебага/мониторинга).
func (h *Hub) Stats() (subs, pub, drop int64) {
	return h.subscribed.Load(), h.publishes.Load(), h.dropped.Load()
}

// withTimeoutCtx — публичный хелпер для тестов.
func withTimeoutCtx(parent context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, d)
}
