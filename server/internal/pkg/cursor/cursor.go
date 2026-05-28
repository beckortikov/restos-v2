// Package cursor — keyset-пагинация для GORM-запросов.
//
// Формат: base64url(JSON{"t":"<RFC3339Nano>","i":"<uuid>"})
//
// Используется для коллекций, упорядоченных по `(created_at DESC, id DESC)`.
// Индекс на каждой таблице обязателен (см. миграцию 001).
//
// Почему keyset, а не OFFSET: на 10k+ строк OFFSET сканирует всё и отбрасывает,
// p99 деградирует линейно. Keyset «WHERE (created_at, id) < (?, ?)» использует
// индекс и стабилен на любой глубине пагинации.
//
// Не подходит для:
//   - произвольной сортировки (тогда нужен per-endpoint cursor),
//   - стабильности при изменении сортировочного ключа (created_at нельзя
//     править на «живых» строках; в RestOS это и так нельзя).
package cursor

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// Page — параметры пагинации, извлечённые из query string.
type Page struct {
	Limit  int    // 1..MaxLimit
	Cursor string // raw (base64), пустой = первая страница
}

// MaxLimit — потолок, чтобы избежать «дай всё».
const MaxLimit = 200

// DefaultLimit — если limit не указан в query.
const DefaultLimit = 50

// Token — распакованный cursor.
type Token struct {
	Time time.Time `json:"t"`
	ID   string    `json:"i"`
}

// Encode сериализует Token в base64url.
func Encode(t Token) string {
	b, _ := json.Marshal(t)
	return base64.RawURLEncoding.EncodeToString(b)
}

// Decode разбирает base64url-токен. Пустая строка → zero-value (первая страница).
func Decode(s string) (Token, error) {
	if s == "" {
		return Token{}, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return Token{}, fmt.Errorf("cursor: bad base64: %w", err)
	}
	var t Token
	if err := json.Unmarshal(b, &t); err != nil {
		return Token{}, fmt.Errorf("cursor: bad json: %w", err)
	}
	return t, nil
}

// NormalizeLimit зажимает limit в [1, MaxLimit] с дефолтом.
func NormalizeLimit(raw int) int {
	switch {
	case raw <= 0:
		return DefaultLimit
	case raw > MaxLimit:
		return MaxLimit
	default:
		return raw
	}
}

// Apply навешивает на db keyset-условие и ORDER BY + LIMIT+1.
// LIMIT+1 — чтобы понять, есть ли следующая страница, без отдельного COUNT.
//
// Пример:
//
//	tx, err := r.ForTenant(ctx)
//	tx = cursor.Apply(tx, "orders", page)
//	var rows []models.Order
//	tx.Find(&rows)
//	next := cursor.Next(rows, page.Limit, func(r models.Order) cursor.Token {
//	    return cursor.Token{Time: r.CreatedAt, ID: r.ID}
//	})
func Apply(db *gorm.DB, table string, page Page) *gorm.DB {
	limit := NormalizeLimit(page.Limit)
	t, err := Decode(page.Cursor)
	if err != nil {
		// Битый cursor — стартуем с начала; ошибку проглатываем тут (хендлер
		// валидирует Decode заранее и возвращает 400, если хочет строгости).
		t = Token{}
	}
	q := db.Order(table + ".created_at DESC").Order(table + ".id DESC").Limit(limit + 1)
	if !t.Time.IsZero() {
		// (created_at, id) < (cursor.t, cursor.i) — лексикографически.
		// В Postgres работает «row comparison» — мы используем его явно.
		q = q.Where(
			"("+table+".created_at, "+table+".id) < (?, ?)",
			t.Time, t.ID,
		)
	}
	return q
}

// Next вычисляет следующий cursor по слайсу из Find (с +1 элементом).
// Возвращает trimmed-слайс (без хвостового +1) и cursor для следующей страницы.
// Если elements <= limit — следующей страницы нет, возвращает "".
func Next[T any](rows []T, limit int, key func(T) Token) (trimmed []T, next string) {
	if len(rows) <= limit {
		return rows, ""
	}
	last := rows[limit-1]
	return rows[:limit], Encode(key(last))
}
