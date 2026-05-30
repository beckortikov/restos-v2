package middleware

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
)

// DecodeStrict — drop-in замена `json.NewDecoder(r.Body).Decode(&in)` для
// «денежных» handler'ов. Включает DisallowUnknownFields — любое лишнее
// поле в request body (FE мог отправить через `body as any`) сразу
// возвращается как ошибка вместо silent-drop.
//
// Зачем: исторически handler'ы используют обычный Decode. Если FE из-за
// `as any` cast'а шлёт extra поле (например, опечатался в `discount_value`
// → `discont_value`), backend парсит без поля и пишет неполные данные.
// На деньгах это особенно опасно: скидка/чаевые/service могут не дойти.
//
// Не глобально потому что:
//   - старые FE-installation (≤ v2.0.23) шлют extra поля через `as any`;
//     включение DisallowUnknownFields везде сломает им работу.
//   - применяется точечно на endpoint'ы где деньги: close order, cancel
//     order, finance/operations, shifts/{id}/close.
//
// Feature-flag: env RESTOS_STRICT_MONEY_BODIES.
//   - "" (unset) или "1"/"true"/"on" → strict (default в v2.0.25).
//   - "0"/"false"/"off" → legacy permissive (без DisallowUnknownFields).
//   Позволяет выключить strict без redeploy если что-то сломалось.
func DecodeStrict(r *http.Request, dst any) error {
	if r.Body == nil {
		return io.EOF
	}
	dec := json.NewDecoder(r.Body)
	if strictEnabled() {
		dec.DisallowUnknownFields()
	}
	return dec.Decode(dst)
}

func strictEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("RESTOS_STRICT_MONEY_BODIES")))
	if v == "" {
		return true // default ON в v2.0.25
	}
	return v == "1" || v == "true" || v == "yes" || v == "on"
}
