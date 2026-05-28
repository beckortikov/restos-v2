package handlers

import (
	"net/http"
	"strconv"

	"github.com/restos/restos-v4/server/internal/pkg/cursor"
)

// parsePage парсит ?limit=&cursor= из URL.
func parsePage(r *http.Request) cursor.Page {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	return cursor.Page{
		Limit:  limit, // NormalizeLimit применится в cursor.Apply
		Cursor: q.Get("cursor"),
	}
}

// page envelope под фронт.
type listEnvelope[T any] struct {
	Data       []T    `json:"data"`
	NextCursor string `json:"next_cursor,omitempty"`
}

func makeList[T any](data []T, next string) listEnvelope[T] {
	return listEnvelope[T]{Data: data, NextCursor: next}
}

// queryString — короткий хэлпер: req.URL.Query().Get(key).
func queryString(r *http.Request, key string) string {
	return r.URL.Query().Get(key)
}
