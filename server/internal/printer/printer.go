// Package printer — драйверы физической отправки ESC/POS байтов.
//
// Интерфейс простой: один метод Send(ctx, payload) error. Реализации:
//   - TCP    — обычный сетевой принтер на порту 9100 (Epson, Xprinter, Star).
//   - USB    — за build tag (требует libusb через gousb). MVP без USB.
//   - Mock   — пишет в in-memory buffer, для тестов.
//   - Virtual — пишет в файл, для smoke/staging.
//
// Очередь (queue.go) принимает любой Printer и вызывает Send. Реализация
// не должна знать про идемпотентность/ретраи — это забота queue.
package printer

import "context"

// Printer — единый интерфейс для всех драйверов.
type Printer interface {
	// Send отправляет ESC/POS-поток в принтер.
	// Возвращает ошибку, если устройство недоступно/timeout/error отказа.
	//
	// payload уже содержит ВСЕ команды (Init, CodePage, текст, Cut).
	// Driver не должен ничего добавлять.
	Send(ctx context.Context, payload []byte) error

	// Name — человекочитаемое имя для логов.
	Name() string
}
