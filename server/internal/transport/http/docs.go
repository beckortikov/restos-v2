// Package http — статические шаблоны импорта (Excel) для /docs/*.
//
// Эти .xlsx-файлы вшиты в бинарь НАПРЯМУЮ через go:embed (а не через
// embed-spa pipeline). Это критично: если кассу собрали без `make embed-spa`
// (frontend не запекли — spa/ содержит только placeholder index.html), то
// раньше запрос `/docs/шаблон-техкарты.xlsx` проваливался в SPA-fallback и
// возвращал index.html с кодом 200. Браузер сохранял эти HTML-байты под
// именем *.xlsx, и Excel ругался «формат или расширение не являются
// допустимыми». Теперь шаблоны всегда в бинаре и отдаются отдельным
// роутом, который на отсутствующий файл честно отвечает 404 (а не HTML).
package http

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed docs/*.xlsx
var docsFS embed.FS

// DocsHandler отдаёт вшитые Excel-шаблоны импорта на /docs/*.
//
// В отличие от SPAHandler здесь НЕТ fallback на index.html: если файла нет,
// возвращается 404. Это гарантирует, что фронт получит res.ok === false и
// покажет тост ошибки вместо того, чтобы сохранить битый .xlsx (HTML внутри).
func DocsHandler() http.Handler {
	sub, err := fs.Sub(docsFS, "docs")
	if err != nil {
		return http.NotFoundHandler()
	}
	fileServer := http.FileServer(http.FS(sub))

	return http.StripPrefix("/docs/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Кэшируем шаблоны — они меняются редко, версия привязана к релизу.
		w.Header().Set("Cache-Control", "public, max-age=3600")
		fileServer.ServeHTTP(w, r)
	}))
}
