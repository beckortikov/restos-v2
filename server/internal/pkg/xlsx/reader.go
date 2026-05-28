package xlsx

import (
	"bytes"
	"fmt"
	"io"
	"strings"

	"github.com/xuri/excelize/v2"
)

// Read открывает xlsx из reader (io.Reader / bytes / multipart upload).
// Возвращает все строки первого листа в виде [][]string. Первая строка — header.
//
// Не сохраняет в memory excelize-объект — закрывает сразу.
func Read(r io.Reader) ([][]string, error) {
	// excelize требует ReadAt / *bytes.Reader.
	buf, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("xlsx read: %w", err)
	}
	f, err := excelize.OpenReader(bytes.NewReader(buf))
	if err != nil {
		return nil, fmt.Errorf("xlsx open: %w", err)
	}
	defer f.Close()
	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return nil, fmt.Errorf("xlsx: no sheets")
	}
	rows, err := f.GetRows(sheets[0])
	if err != nil {
		return nil, fmt.Errorf("xlsx rows: %w", err)
	}
	return rows, nil
}

// IndexHeader строит мапу нормализованный_header → index по первой строке.
// Нормализация: strings.ToLower(TrimSpace(.)). Помогает фронту прислать xlsx
// с заголовками в разном регистре и порядке.
func IndexHeader(headers []string) map[string]int {
	m := make(map[string]int, len(headers))
	for i, h := range headers {
		k := strings.ToLower(strings.TrimSpace(h))
		if k == "" {
			continue
		}
		m[k] = i
	}
	return m
}

// Cell возвращает значение колонки col (нормализованное имя) из row или "".
// Удобно для импорта: индекс заранее не известен.
func Cell(row []string, headers map[string]int, col string) string {
	idx, ok := headers[strings.ToLower(col)]
	if !ok || idx >= len(row) {
		return ""
	}
	return strings.TrimSpace(row[idx])
}
