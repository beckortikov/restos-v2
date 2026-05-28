//go:build bench

package http_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	httpx "github.com/restos/restos-v4/server/internal/transport/http"
)

func newSkipHooksSession() *gorm.Session {
	return &gorm.Session{SkipHooks: true}
}

// Запуск:
//
//	go test -tags=bench ./internal/transport/http/... -run TestPerf_OrdersList -v
//
// Цель (PRD): p99 GET /api/v1/orders < 50мс на 10k заказов.
//
// Сеет 10k заказов в БД и шлёт 500 запросов /api/v1/orders?limit=50,
// меряет latency, печатает p50/p95/p99.

func benchDSN() string {
	if v := os.Getenv("RESTOS_BENCH_DSN"); v != "" {
		return v
	}
	return "host=127.0.0.1 port=5432 user=restos dbname=restos_v4_test sslmode=disable"
}

const benchOrderCount = 10_000

func TestPerf_OrdersList(t *testing.T) {
	gdb, err := db.Open(benchDSN())
	if err != nil {
		t.Fatal(err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatal(err)
	}

	// Полная чистка target-таблиц.
	for _, tbl := range []string{
		"audit_log", "order_items", "orders",
		"sessions", "users", "restaurants",
	} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatal(err)
		}
	}

	rid := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: rid, Name: "Bench"}).Error; err != nil {
		t.Fatal(err)
	}
	name := "BenchCashier"
	pin := "9999"
	if err := gdb.Create(&models.User{
		ID: uuid.NewString(), Name: &name, PIN: &pin, RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Сеем 10k заказов батчами. AuditHook на каждом Create — отключим временно
	// через DryRun не получится, поэтому пишем через CreateInBatches с SkipHooks.
	t.Logf("seeding %d orders…", benchOrderCount)
	t0 := time.Now()
	orders := make([]models.Order, benchOrderCount)
	statuses := []string{"closed", "new", "open", "bill_requested"}
	now := time.Now().UTC()
	for i := 0; i < benchOrderCount; i++ {
		st := statuses[i%len(statuses)]
		o := models.Order{
			RestaurantID:     &rid,
			Status:           &st,
			Total:            decimal.MustFromString("123.45"),
			TotalWithService: decimal.MustFromString("135.80"),
			CreatedAt:        now.Add(-time.Duration(i) * time.Second),
			UpdatedAt:        now,
		}
		orders[i] = o
	}
	// Используем CreateInBatches с SkipHooks (выкл audit-хук на сидинге).
	if err := gdb.Session(newSkipHooksSession()).CreateInBatches(orders, 500).Error; err != nil {
		t.Fatal(err)
	}
	t.Logf("seeded in %v", time.Since(t0))

	// httptest сервер.
	router := httpx.NewRouter(httpx.Deps{DB: gdb, Build: httpx.BuildInfo{Version: "bench"}})
	srv := httptest.NewServer(router)
	defer srv.Close()

	// login.
	body := fmt.Sprintf(`{"restaurant_id":%q,"pin":%q}`, rid, pin)
	resp, err := http.Post(srv.URL+"/api/v1/auth/login", "application/json", stringReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var loginOut struct{ Token string }
	_ = json.NewDecoder(resp.Body).Decode(&loginOut)
	resp.Body.Close()
	if loginOut.Token == "" {
		t.Fatal("no token")
	}

	// Warmup.
	for i := 0; i < 10; i++ {
		callOrders(t, srv.URL, loginOut.Token)
	}

	// Measure.
	const N = 500
	durs := make([]time.Duration, 0, N)
	for i := 0; i < N; i++ {
		d := callOrders(t, srv.URL, loginOut.Token)
		durs = append(durs, d)
	}
	sort.Slice(durs, func(i, j int) bool { return durs[i] < durs[j] })
	p := func(q float64) time.Duration { return durs[int(float64(N)*q)] }

	t.Logf("GET /orders?limit=50 over %d orders: p50=%v p95=%v p99=%v max=%v",
		benchOrderCount, p(0.5), p(0.95), p(0.99), durs[N-1])

	if p(0.99) > 50*time.Millisecond {
		t.Errorf("PRD requires p99 < 50ms, got %v", p(0.99))
	}
}

func callOrders(t *testing.T, baseURL, tok string) time.Duration {
	t.Helper()
	req, _ := http.NewRequest("GET", baseURL+"/api/v1/orders?limit=50", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	t0 := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	d := time.Since(t0)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	return d
}

func stringReader(s string) *stringReadCloser { return &stringReadCloser{s: s} }

type stringReadCloser struct {
	s   string
	pos int
}

func (r *stringReadCloser) Read(p []byte) (int, error) {
	if r.pos >= len(r.s) {
		return 0, io.EOF
	}
	n := copy(p, r.s[r.pos:])
	r.pos += n
	return n, nil
}
func (r *stringReadCloser) Close() error { return nil }
