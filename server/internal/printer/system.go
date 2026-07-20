package printer

import (
	"context"
	"errors"
	"strings"
)

// SystemPrinter — печать через системную очередь ОС (spooler), а не напрямую
// в устройство. Единственный способ достучаться до принтера, встроенного в
// кассовый моноблок: он висит на внутреннем USB, IP у него нет.
//
// Поток ESC/POS уходит в очередь «как есть», без рендеринга: на Windows —
// datatype="RAW", на CUPS — `-o raw`. Драйвер принтера в ОС нужен только чтобы
// очередь существовала; подойдёт и вендорный, и «Generic / Text Only».
//
// Queue — имя очереди в ОС («POS-80 Printer», «TC3680B-UP»), регистр важен на
// CUPS и не важен на Windows. Список доступных очередей — ListSystemQueues.
type SystemPrinter struct {
	Queue string
}

// NewSystem создаёт драйвер поверх системной очереди с именем queue.
func NewSystem(queue string) *SystemPrinter {
	return &SystemPrinter{Queue: strings.TrimSpace(queue)}
}

func (p *SystemPrinter) Name() string { return "system:" + p.Queue }

// ErrNoSystemQueue — target пустой: не выбрана очередь печати.
var ErrNoSystemQueue = errors.New("system printer: queue name is empty")

// Send отправляет payload в очередь. Реализация — в system_windows.go
// (winspool) и system_unix.go (CUPS).
func (p *SystemPrinter) Send(ctx context.Context, payload []byte) error {
	if p.Queue == "" {
		return ErrNoSystemQueue
	}
	if len(payload) == 0 {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return sendToSystemQueue(ctx, p.Queue, payload)
}

// SystemQueue — очередь печати, зарегистрированная в ОС. Отдаётся в UI, чтобы
// кассир выбирал принтер из списка, а не вбивал имя руками (опечатка в имени
// очереди = молча не печатающий принтер).
type SystemQueue struct {
	Name      string `json:"name"`
	IsDefault bool   `json:"is_default"`
	// Status — человекочитаемое состояние очереди, если ОС его отдаёт
	// («idle», «printing», «offline»). Пустая строка — состояние неизвестно.
	Status string `json:"status,omitempty"`
}

// ListSystemQueues возвращает очереди печати, видимые текущему процессу.
//
// Важно: список берётся с машины, где крутится Go-бэк (касса), а не с машины,
// где открыт браузер. Для LAN Web Access это ровно то, что нужно — принтер
// физически подключён к кассе.
func ListSystemQueues(ctx context.Context) ([]SystemQueue, error) {
	return listSystemQueues(ctx)
}
