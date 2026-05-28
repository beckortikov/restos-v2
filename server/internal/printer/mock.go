package printer

import (
	"context"
	"sync"
)

// Mock — печатает в in-memory slice. Безопасен для конкуррентных тестов.
type Mock struct {
	mu       sync.Mutex
	payloads [][]byte
	FailNext bool // если true, следующий Send вернёт ошибку
}

func NewMock() *Mock { return &Mock{} }

func (m *Mock) Name() string { return "mock" }

func (m *Mock) Send(ctx context.Context, payload []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.FailNext {
		m.FailNext = false
		return ErrMockFail
	}
	// Копируем, чтобы внешний код не мог изменить наш буфер.
	cp := make([]byte, len(payload))
	copy(cp, payload)
	m.payloads = append(m.payloads, cp)
	return nil
}

// Payloads возвращает копию накопленных.
func (m *Mock) Payloads() [][]byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([][]byte, len(m.payloads))
	copy(out, m.payloads)
	return out
}

// Reset очищает буфер (для повторного использования в тестах).
func (m *Mock) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.payloads = nil
}

// ErrMockFail — sentinel для тестов retry.
var ErrMockFail = mockErr("mock printer failed (FailNext=true)")

type mockErr string

func (e mockErr) Error() string { return string(e) }
