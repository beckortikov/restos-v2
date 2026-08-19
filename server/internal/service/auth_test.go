//go:build integration

package service

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
)

func authTestDSN() string {
	if v := os.Getenv("RESTOS_TEST_DSN"); v != "" {
		return v
	}
	return "host=127.0.0.1 port=5432 user=restos dbname=restos_v4_test sslmode=disable"
}

// TestAuth_SessionRollingExtendsOnActivity — sessions.expires_at должен
// сдвигаться вперёд на активности (см. комментарий к миграции 002: "TTL: 12
// часов rolling"), а не быть фиксированным от логина. Без этого табло
// (/board), которое висит сутками и ничего кроме поллинга не делает, вылетает
// на PIN каждые ~12 часов — для смены кассира это было незаметно (смена
// короче TTL), для табло без выхода — нет.
//
// nextRefreshAt (throttle 30с) двигаем в прошлое напрямую, а не спим 30с
// реального времени — Validate не принимает инжектируемые часы, а тест на
// таймер это единственный способ проверить throttled-путь быстро.
func TestAuth_SessionRollingExtendsOnActivity(t *testing.T) {
	gdb, err := db.Open(authTestDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.MigrateUp(context.Background(), gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	rid := "auth-rolling-test-" + uuid.NewString()
	userID := uuid.NewString()
	userName, role := "Test Cashier", "cashier"
	pin := "4321"
	if err := gdb.Create(&models.User{
		ID: userID, Name: &userName, Role: &role, PIN: &pin, RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	t.Cleanup(func() {
		gdb.Exec("DELETE FROM sessions WHERE restaurant_id = ?", rid)
		gdb.Exec("DELETE FROM users WHERE id = ?", userID)
	})

	auth := NewAuthService(gdb)
	token, _, err := auth.LoginByPIN(context.Background(), rid, pin)
	if err != nil {
		t.Fatalf("login: %v", err)
	}

	// Первый Validate — cache miss, грузит expires_at из БД (now+12ч), ставит
	// nextRefreshAt = now+30с.
	if _, err := auth.Validate(context.Background(), token); err != nil {
		t.Fatalf("validate 1: %v", err)
	}

	// Симулируем «сессию залогинили давно, до истечения осталось 5 секунд, но
	// throttle-окно на обновление уже прошло» — напрямую правим приватный кэш
	// (тот же пакет). near-expiry, а не time.Now().Add(-time.Second) на
	// ExpiresAt — если Validate ничего не продлит, кэш-ветка cs.ExpiresAt.
	// After(now) всё ещё пропустит запрос (сессия ещё формально жива), и тест
	// СЛУЧАЙНО прошёл бы даже без rolling-фикса. Нужно поймать именно
	// «активность отодвигает даже почти истёкшую сессию».
	nearExpiry := time.Now().Add(5 * time.Second)
	v, ok := auth.cache.Load(token)
	if !ok {
		t.Fatal("сессия не осела в кэше после первого Validate")
	}
	cs := v.(*cachedSession)
	cs.ExpiresAt = nearExpiry
	cs.nextRefreshAt = time.Now().Add(-time.Second)

	cs2, err := auth.Validate(context.Background(), token)
	if err != nil {
		t.Fatalf("validate 2 (сессия должна была спастись активностью): %v", err)
	}
	// Rolling должен вернуть ExpiresAt к свежему ~now+SessionTTL, а не оставить
	// её у искусственно состаренной near-expiry (~5с) — это и есть разница
	// между «rolling» и «фиксированный TTL от логина».
	if diff := cs2.ExpiresAt.Sub(nearExpiry); diff < SessionTTL-time.Minute {
		t.Fatalf("сессию не продлило: было %v (осталось ~5с), стало %v — rolling не сработал", nearExpiry, cs2.ExpiresAt)
	}

	// touchLastSeen пишет в БД асинхронно (fire-and-forget) — короткая пауза,
	// чтобы дать горутине завершиться перед проверкой персистентности.
	time.Sleep(150 * time.Millisecond)
	var sess models.Session
	if err := gdb.Where("token = ?", token).First(&sess).Error; err != nil {
		t.Fatalf("session not found in db: %v", err)
	}
	if diff := sess.ExpiresAt.Sub(nearExpiry); diff < SessionTTL-time.Minute {
		t.Errorf("expires_at в БД не продлился: было %v (осталось ~5с), стало %v", nearExpiry, sess.ExpiresAt)
	}
}
