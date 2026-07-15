//go:build integration

package http_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
)

// Воспроизводит инцидент кассы (15.07.2026): goose_db_version=36, но колонки
// ingredients.warehouse_id нет → добавление покупного товара падает
// (`столбец "warehouse_id" ... не существует`, SQLSTATE 42703). Проверяет, что
// стартовый self-heal (db.EnsureCriticalSchema) восстанавливает схему и товар
// снова добавляется — независимо от того, что думает goose.
func TestSelfHeal_WarehouseColumnDrift(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if s, e := gdb.DB(); e == nil {
			_ = s.Close()
		}
	})

	purchased := func() (*http.Response, []byte) {
		return f.post(t, "/api/v1/menu/items", tok, uuid.NewString(), map[string]any{
			"name": "Кола-" + uuid.NewString()[:8], "category": "Напитки", "price": "15",
			"is_purchased": true, "purchase_price": "10", "purchase_unit": "шт.", "purchase_min_qty": "0",
		})
	}

	// 1. Симулируем дрейф: goose «применил» 036, но колонки нет.
	if err := gdb.Exec(`ALTER TABLE ingredients DROP COLUMN IF EXISTS warehouse_id`).Error; err != nil {
		t.Fatal(err)
	}

	// 2. Без колонки покупной товар НЕ добавляется — воспроизводим баг.
	if r, b := purchased(); r.StatusCode == http.StatusCreated {
		t.Fatalf("ожидали провал без warehouse_id, но товар создался: %s", b)
	} else {
		t.Logf("баг воспроизведён (ожидаемо): %d %s", r.StatusCode, b)
	}

	// 3. Self-heal восстанавливает схему.
	if err := db.EnsureCriticalSchema(context.Background(), gdb); err != nil {
		t.Fatalf("self-heal вернул ошибку: %v", err)
	}

	// 4. Колонка вернулась.
	var hasCol bool
	if err := gdb.Raw(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_name='ingredients' AND column_name='warehouse_id')`).Scan(&hasCol).Error; err != nil {
		t.Fatal(err)
	}
	if !hasCol {
		t.Fatal("после self-heal колонка warehouse_id так и не появилась")
	}

	// 5. Теперь покупной товар добавляется.
	if r, b := purchased(); r.StatusCode != http.StatusCreated {
		t.Fatalf("после self-heal ожидали 201, получили %d: %s", r.StatusCode, b)
	}
}

// Повторный self-heal на здоровой БД — no-op, без ошибок (идемпотентность).
func TestSelfHeal_IdempotentOnHealthyDB(t *testing.T) {
	_ = setupE2E(t) // прогоняет MigrateUp → схема уже цела
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if s, e := gdb.DB(); e == nil {
			_ = s.Close()
		}
	})
	for i := 0; i < 3; i++ {
		if err := db.EnsureCriticalSchema(context.Background(), gdb); err != nil {
			t.Fatalf("повтор %d: self-heal на здоровой БД вернул ошибку: %v", i, err)
		}
	}
}
