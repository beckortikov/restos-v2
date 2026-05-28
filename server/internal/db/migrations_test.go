package db

import (
	"io/fs"
	"strings"
	"testing"
)

// Проверка, что embed.FS подцепил миграции.
// Полный прогон против реального Postgres делается в Phase 0 вручную (make run)
// и в Phase 1 — через integration-тест с embedded-postgres.
func TestMigrationFSEmbedded(t *testing.T) {
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		t.Fatalf("read embedded migrations: %v", err)
	}
	if len(entries) == 0 {
		t.Fatalf("no migrations embedded")
	}
	var has001 bool
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "001_") && strings.HasSuffix(e.Name(), ".sql") {
			has001 = true
		}
	}
	if !has001 {
		t.Fatalf("expected 001_*.sql migration, got: %v", entries)
	}
}
