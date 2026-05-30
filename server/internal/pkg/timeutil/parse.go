// Package timeutil содержит helpers для парсинга временных меток с разных клиентов.
package timeutil

import (
	"fmt"
	"time"
)

// looseLayouts — список форматов, которые принимаем на входе.
// Java's OffsetDateTime.toString() при нулевых секундах опускает их,
// что нарушает strict RFC3339. Поэтому принимаем варианты без секунд/tz.
var looseLayouts = []string{
	time.RFC3339Nano,
	time.RFC3339,
	"2006-01-02T15:04Z07:00", // без секунд (Java OffsetDateTime.toString())
	"2006-01-02T15:04:05",    // без timezone
	"2006-01-02T15:04",       // без секунд и tz
	"2006-01-02",             // только дата
}

// ParseLooseRFC3339 принимает RFC3339 с опциональными секундами/милли/таймзоной.
// Используется на всех HTTP-входах (query params + body fields), где клиент
// (Kotlin APK / React) может прислать неполный ISO.
func ParseLooseRFC3339(s string) (time.Time, error) {
	for _, layout := range looseLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognized timestamp %q", s)
}
