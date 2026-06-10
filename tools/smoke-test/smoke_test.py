"""
RestOS smoke test — read-only проверка работающей кассы.

Что делает:
  1. Логинится по PIN.
  2. Дёргает все ключевые GET-эндпоинты (catalog, orders, shifts, analytics, finance, license, SSE).
  3. Проверяет shape ответов + замеряет latency.
  4. Опционально (--write) делает create-order → close-order цикл на тестовом столе.
  5. Пишет всё в smoke-test.log с таймстампами.

Запуск:
  pip install pytest requests
  set RESTOS_BASE_URL=http://127.0.0.1:3001
  set RESTOS_RESTAURANT_ID=<uuid ресторана>
  set RESTOS_PIN=<пин менеджера или owner>
  pytest smoke_test.py -v -s
  # или с write-цикл:
  pytest smoke_test.py -v -s --write

Лог появится в smoke-test.log в текущей папке.
"""

from __future__ import annotations  # для list[dict] на Python 3.8

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import pytest
import requests


# ─── Config ────────────────────────────────────────────────────────────────

BASE_URL = os.environ.get("RESTOS_BASE_URL", "http://127.0.0.1:3001")
RESTAURANT_ID = os.environ.get("RESTOS_RESTAURANT_ID", "")
PIN = os.environ.get("RESTOS_PIN", "")
LOG_PATH = Path(os.environ.get("RESTOS_LOG_PATH", "smoke-test.log"))

# Слоты результатов для итогового summary.
RESULTS: list[dict] = []


# ─── Logger ────────────────────────────────────────────────────────────────

_log_file = None


def _open_log():
    global _log_file
    if _log_file is None:
        _log_file = LOG_PATH.open("w", encoding="utf-8")
        _log_file.write(f"# RestOS smoke test — {datetime.now().isoformat()}\n")
        _log_file.write(f"# BASE_URL={BASE_URL}\n")
        _log_file.write(f"# RESTAURANT_ID={RESTAURANT_ID}\n")
        _log_file.write(f"# Python={sys.version.split()[0]}\n")
        _log_file.write("\n")
        _log_file.flush()


def log(msg: str):
    _open_log()
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    line = f"[{ts}] {msg}"
    print(line)
    _log_file.write(line + "\n")
    _log_file.flush()


def log_result(name: str, ok: bool, latency_ms: float, detail: str = ""):
    RESULTS.append({"name": name, "ok": ok, "latency_ms": latency_ms, "detail": detail})
    status = "PASS" if ok else "FAIL"
    log(f"  → {status} ({latency_ms:.0f}ms) {detail}")


# ─── HTTP helper ───────────────────────────────────────────────────────────


class Client:
    def __init__(self):
        self.s = requests.Session()
        self.token: Optional[str] = None
        self.user: dict = {}
        self.restaurant: dict = {}

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def request(self, method: str, path: str, **kw) -> requests.Response:
        url = BASE_URL + path
        kw.setdefault("timeout", 30)
        kw.setdefault("headers", self._headers())
        t0 = time.perf_counter()
        try:
            r = self.s.request(method, url, **kw)
        except Exception as e:
            log(f"  ! Network error: {e}")
            raise
        elapsed = (time.perf_counter() - t0) * 1000
        return r, elapsed

    def get(self, path: str, params: dict = None):
        return self.request("GET", path, params=params)

    def post(self, path: str, json_body: dict = None):
        return self.request("POST", path, json=json_body)


@pytest.fixture(scope="session")
def client():
    return Client()


# ─── Helpers ───────────────────────────────────────────────────────────────


def check_shape(resp_json: Any, required_fields: list[str], name: str) -> str:
    """Проверяет что в ответе есть все required_fields (только top-level).
    Возвращает строку для лога."""
    if not isinstance(resp_json, dict):
        return f"NOT-A-DICT (got {type(resp_json).__name__})"
    missing = [f for f in required_fields if f not in resp_json]
    if missing:
        return f"MISSING fields: {missing}"
    return f"shape ok ({len(resp_json)} fields)"


def first_n(arr, n=3):
    if not isinstance(arr, list):
        return str(arr)[:200]
    return str(arr[:n])[:200]


# ─── Tests ─────────────────────────────────────────────────────────────────


def test_00_environment(client):
    """Проверяем что env-vars заданы."""
    log("=" * 70)
    log("0. ENVIRONMENT")
    log("=" * 70)
    assert RESTAURANT_ID, "RESTOS_RESTAURANT_ID не задан"
    assert PIN, "RESTOS_PIN не задан"
    log(f"BASE_URL={BASE_URL}")
    log(f"RESTAURANT_ID={RESTAURANT_ID}")
    log(f"PIN=*** ({len(PIN)} chars)")


def test_01_server_alive(client):
    """Бэк отвечает на login с пустым body → 400 VALIDATION (=alive)."""
    log("")
    log("=" * 70)
    log("1. SERVER ALIVE")
    log("=" * 70)
    log("POST /api/v1/auth/login (empty body)")
    # Любой 4xx/200 = server жив. ConnectionRefused = сервер мёртв.
    r, ms = client.post("/api/v1/auth/login", {})
    assert r.status_code < 500, f"server мёртвый: {r.status_code} {r.text[:100]}"
    log_result("server.alive", True, ms, f"http {r.status_code}")


def test_02_login(client):
    """POST /api/v1/auth/login."""
    log("")
    log("=" * 70)
    log("2. LOGIN")
    log("=" * 70)
    log(f"POST /api/v1/auth/login  body={{restaurant_id: '{RESTAURANT_ID[:8]}...', pin: '***'}}")
    r, ms = client.post("/api/v1/auth/login", {"restaurant_id": RESTAURANT_ID, "pin": PIN})
    if r.status_code != 200:
        log(f"  ! Ответ: {r.status_code} {r.text[:500]}")
        log_result("auth.login", False, ms, f"http {r.status_code}: {r.text[:200]}")
        pytest.fail(f"login failed: {r.status_code} {r.text[:200]}")
    body = r.json()
    assert "token" in body, f"нет token в ответе: {body}"
    client.token = body["token"]
    client.user = body.get("user", {})
    client.restaurant = body.get("restaurant", {})
    log_result(
        "auth.login",
        True,
        ms,
        f"user={client.user.get('full_name') or client.user.get('username')} role={client.user.get('role')}",
    )


def test_03_license_status(client):
    """GET /api/v1/license/status — состояние лицензии."""
    log("")
    log("=" * 70)
    log("3. LICENSE STATUS")
    log("=" * 70)
    log("GET /api/v1/license/status")
    r, ms = client.get("/api/v1/license/status")
    if r.status_code != 200:
        log_result("license.status", False, ms, f"http {r.status_code}")
        return
    body = r.json()
    log(f"  license status: {json.dumps(body, ensure_ascii=False)[:300]}")
    log_result("license.status", True, ms, f"locked={body.get('locked')} expires={body.get('expires_at') or '—'}")


def test_04_catalog_reads(client):
    """Каталоги: menu, tables, zones, users, ingredients."""
    log("")
    log("=" * 70)
    log("4. CATALOG READS")
    log("=" * 70)
    cases = [
        ("/api/v1/menu/items", "menu.items"),
        ("/api/v1/menu/categories", "menu.categories"),
        ("/api/v1/tables", "tables"),
        ("/api/v1/zones", "zones"),
        ("/api/v1/users", "users"),
        ("/api/v1/ingredients", "ingredients"),
        ("/api/v1/customers", "customers"),
        ("/api/v1/suppliers", "suppliers"),
        ("/api/v1/printers", "printers"),
    ]
    for path, name in cases:
        log(f"GET {path}")
        r, ms = client.get(path)
        ok = r.status_code == 200
        count = "?"
        if ok:
            try:
                body = r.json()
                if isinstance(body, dict) and "data" in body:
                    count = len(body["data"])
                elif isinstance(body, list):
                    count = len(body)
            except Exception:
                pass
        log_result(name, ok, ms, f"http {r.status_code}, count={count}")


def test_05_orders_list_with_items(client):
    """GET /api/v1/orders?include=items — проверяем что N+1 фикс работает."""
    log("")
    log("=" * 70)
    log("5. ORDERS LIST + ITEMS (N+1 fix)")
    log("=" * 70)
    log("GET /api/v1/orders?limit=20&include=items")
    r, ms = client.get("/api/v1/orders", params={"limit": 20, "include": "items"})
    ok = r.status_code == 200
    detail = f"http {r.status_code}"
    if ok:
        body = r.json()
        rows = body.get("data", []) if isinstance(body, dict) else body
        if rows:
            with_items = sum(1 for r in rows if isinstance(r.get("items"), list))
            avg_items = sum(len(r.get("items", []) or []) for r in rows) / max(1, len(rows))
            detail = f"orders={len(rows)} with_items={with_items} avg_items={avg_items:.1f}"
            # Если ни у одного нет items[] — N+1 фикс не работает или нет данных.
            if with_items == 0 and len(rows) > 0:
                ok = False
                detail += " (⚠ N+1 фикс не сработал — items[] отсутствует)"
        else:
            detail = "orders=0 (БД пуста)"
    log_result("orders.list+items", ok, ms, detail)


def test_06_shifts_list(client):
    """GET /api/v1/shifts."""
    log("")
    log("=" * 70)
    log("6. SHIFTS")
    log("=" * 70)
    log("GET /api/v1/shifts?limit=10")
    r, ms = client.get("/api/v1/shifts", params={"limit": 10})
    ok = r.status_code == 200
    detail = f"http {r.status_code}"
    if ok:
        body = r.json()
        rows = body.get("data", []) if isinstance(body, dict) else body
        open_count = sum(1 for s in rows if s.get("status") == "open")
        detail = f"shifts={len(rows)} open={open_count}"
    log_result("shifts.list", ok, ms, detail)


def test_07_analytics_endpoints(client):
    """8 analytics endpoints — все должны вернуть 200 + правильный shape."""
    log("")
    log("=" * 70)
    log("7. ANALYTICS (Phase v3.x)")
    log("=" * 70)
    # Период — последние 30 дней (если бэк понимает from/to).
    cases = [
        ("/api/v1/analytics/abc-menu", "analytics.abc_menu", ["items", "total_revenue"]),
        ("/api/v1/analytics/peak-hours", "analytics.peak_hours", ["cells", "total_orders"]),
        ("/api/v1/analytics/waiters", "analytics.waiters", ["rows", "total_revenue"]),
        ("/api/v1/analytics/tables", "analytics.tables", ["rows", "total_revenue"]),
        ("/api/v1/analytics/food-cost", "analytics.food_cost", ["rows", "total_revenue"]),
        ("/api/v1/analytics/food-cost/monthly", "analytics.food_cost_monthly", ["months"]),
        ("/api/v1/analytics/ingredient-stock-value", "analytics.ingredient_stock", ["items", "total_value"]),
        ("/api/v1/analytics/forecast", "analytics.forecast", ["monthly_revenue", "historical_months"]),
        ("/api/v1/analytics/abc-inventory", "analytics.abc_inventory", ["items", "total_consumption_value"]),
    ]
    for path, name, fields in cases:
        log(f"GET {path}")
        r, ms = client.get(path)
        ok = r.status_code == 200
        detail = f"http {r.status_code}"
        if ok:
            try:
                body = r.json()
                shape_msg = check_shape(body, fields, name)
                detail = shape_msg
                # Доп. инфа для каждого:
                if name == "analytics.abc_menu":
                    a = sum(1 for it in body.get("items", []) if it.get("class") == "A")
                    b = sum(1 for it in body.get("items", []) if it.get("class") == "B")
                    c = sum(1 for it in body.get("items", []) if it.get("class") == "C")
                    detail += f" | A={a} B={b} C={c} total_rev={body.get('total_revenue')}"
                elif name == "analytics.peak_hours":
                    detail += f" | cells={len(body.get('cells', []))} total_orders={body.get('total_orders')}"
                elif name == "analytics.waiters":
                    detail += f" | waiters={len(body.get('rows', []))}"
                elif name == "analytics.tables":
                    detail += f" | tables={len(body.get('rows', []))}"
                elif name == "analytics.food_cost":
                    detail += f" | dishes={len(body.get('rows', []))} food_cost%={body.get('food_cost_pct')}"
                elif name == "analytics.forecast":
                    detail += f" | months={body.get('historical_months')} forecast_next={body.get('forecast_next_month')} ({body.get('forecast_next_month_label')})"
                elif name == "analytics.abc_inventory":
                    detail += f" | ingredients={len(body.get('items', []))}"
            except Exception as e:
                detail = f"BODY PARSE ERROR: {e}"
                ok = False
        log_result(name, ok, ms, detail)


def test_08_finance_reports(client):
    """3 finance JSON endpoints."""
    log("")
    log("=" * 70)
    log("8. FINANCE REPORTS")
    log("=" * 70)
    cases = [
        ("/api/v1/finance/pnl", "finance.pnl", ["revenue", "cogs", "opex", "gross_profit"]),
        ("/api/v1/finance/cashflow", "finance.cashflow", ["by_activity", "net_total", "by_day"]),
        ("/api/v1/finance/balance", "finance.balance", ["assets", "liabilities", "equity"]),
        ("/api/v1/finance/monthly-revenue", "finance.monthly_revenue", ["data"]),
    ]
    for path, name, fields in cases:
        log(f"GET {path}")
        r, ms = client.get(path)
        ok = r.status_code == 200
        detail = f"http {r.status_code}"
        if ok:
            try:
                body = r.json()
                detail = check_shape(body, fields, name)
                if name == "finance.pnl":
                    detail += f" | rev={body.get('revenue', {}).get('total')} cogs={body.get('cogs', {}).get('total')} net={body.get('net_profit')} margin%={body.get('margin_percent')}"
                elif name == "finance.cashflow":
                    detail += f" | by_activity={list(body.get('by_activity', {}).keys())} categories={len(body.get('out_by_category', []))}"
                elif name == "finance.balance":
                    detail += f" | assets={len(body.get('assets', []))} liab={len(body.get('liabilities', []))} eq={len(body.get('equity', []))}"
            except Exception as e:
                detail = f"BODY PARSE ERROR: {e}"
                ok = False
        log_result(name, ok, ms, detail)


def test_09_finance_extras(client):
    """Финансовые операции, счета, кастомные категории."""
    log("")
    log("")
    log("=" * 70)
    log("9. FINANCE EXTRAS")
    log("=" * 70)
    cases = [
        ("/api/v1/finance/accounts", "finance.accounts"),
        ("/api/v1/finance/operations", "finance.operations"),
        ("/api/v1/finance/custom-categories", "finance.custom_categories"),
        ("/api/v1/assets", "finance.assets"),
        ("/api/v1/liabilities", "finance.liabilities"),
        ("/api/v1/equity", "finance.equity"),
        ("/api/v1/budget-lines", "finance.budget"),
    ]
    for path, name in cases:
        log(f"GET {path}")
        r, ms = client.get(path)
        ok = r.status_code == 200
        count = "?"
        if ok:
            try:
                body = r.json()
                if isinstance(body, dict) and "data" in body:
                    count = len(body["data"])
                elif isinstance(body, list):
                    count = len(body)
            except Exception:
                pass
        log_result(name, ok, ms, f"http {r.status_code}, count={count}")


def test_10_stock(client):
    """Склад: ingredients, stock-movements, suppliers."""
    log("")
    log("=" * 70)
    log("10. STOCK")
    log("=" * 70)
    cases = [
        ("/api/v1/stock-movements", "stock.movements"),
        ("/api/v1/supply-expenses", "stock.supply_expenses"),
        ("/api/v1/stop-list", "stock.stop_list"),
    ]
    for path, name in cases:
        log(f"GET {path}")
        r, ms = client.get(path)
        ok = r.status_code == 200
        count = "?"
        if ok:
            try:
                body = r.json()
                if isinstance(body, dict) and "data" in body:
                    count = len(body["data"])
                elif isinstance(body, list):
                    count = len(body)
            except Exception:
                pass
        log_result(name, ok, ms, f"http {r.status_code}, count={count}")


def test_11_reservations(client):
    """GET /api/v1/reservations."""
    log("")
    log("=" * 70)
    log("11. RESERVATIONS")
    log("=" * 70)
    log("GET /api/v1/reservations")
    r, ms = client.get("/api/v1/reservations")
    ok = r.status_code == 200
    count = "?"
    if ok:
        try:
            body = r.json()
            if isinstance(body, dict) and "data" in body:
                count = len(body["data"])
            elif isinstance(body, list):
                count = len(body)
        except Exception:
            pass
    log_result("reservations.list", ok, ms, f"http {r.status_code}, count={count}")


def test_12_sse_handshake(client):
    """SSE /api/v1/events — handshake (1 событие за 5 сек или таймаут)."""
    log("")
    log("=" * 70)
    log("12. SSE HANDSHAKE")
    log("=" * 70)
    log("GET /api/v1/events  (stream, 5s timeout)")
    url = BASE_URL + "/api/v1/events"
    t0 = time.perf_counter()
    try:
        r = requests.get(
            url,
            headers={"Authorization": f"Bearer {client.token}", "Accept": "text/event-stream"},
            stream=True,
            timeout=5,
        )
        ms = (time.perf_counter() - t0) * 1000
        if r.status_code != 200:
            log_result("sse.handshake", False, ms, f"http {r.status_code}")
            return
        # Читаем до первого ":heartbeat" или event:
        got_data = False
        line_count = 0
        for line in r.iter_lines(decode_unicode=True):
            if line:
                line_count += 1
                if line_count <= 3:
                    log(f"  SSE> {line[:100]}")
                got_data = True
                if line_count >= 3:
                    break
        ms = (time.perf_counter() - t0) * 1000
        log_result("sse.handshake", got_data, ms, f"got {line_count} lines")
    except requests.exceptions.ReadTimeout:
        ms = (time.perf_counter() - t0) * 1000
        log_result("sse.handshake", False, ms, "ReadTimeout (нет heartbeat за 5с)")
    except Exception as e:
        log_result("sse.handshake", False, 0, f"error: {e}")


# ─── Optional write cycle (опасно — реально создаёт заказ) ─────────────────


def pytest_addoption(parser):
    """Регистрируем --write флаг чтобы pytest не ругался."""
    parser.addoption(
        "--write",
        action="store_true",
        default=False,
        help="Включить create-order/cancel цикл (test_99_write_cycle).",
    )


# Env-var тоже поддерживаем — удобнее в PowerShell.
WRITE_ENABLED = os.environ.get("RESTOS_WRITE") == "1"


@pytest.fixture
def write_enabled(request):
    """True если флаг --write передан или RESTOS_WRITE=1 в env."""
    return WRITE_ENABLED or request.config.getoption("--write")


@pytest.mark.skipif(
    not (WRITE_ENABLED or "--write" in sys.argv),
    reason="запусти с --write или RESTOS_WRITE=1 чтобы включить create-order/cancel цикл",
)
def test_99_write_cycle(client):
    """ОСТОРОЖНО: создаёт заказ, добавляет позицию, отменяет. Только для теста на пустой машине."""
    log("")
    log("=" * 70)
    log("99. WRITE CYCLE (create order → add item → cancel order)")
    log("=" * 70)

    # 1. Найдём первый свободный стол и первое блюдо.
    r, _ = client.get("/api/v1/tables")
    tables = r.json().get("data", []) if r.status_code == 200 else []
    free_table = next((t for t in tables if t.get("status") == "free"), None)
    if not free_table:
        log_result("write.find_table", False, 0, "нет свободных столов")
        pytest.skip("нет свободных столов для write-теста")

    r, _ = client.get("/api/v1/menu/items", params={"limit": 5})
    menu = r.json().get("data", []) if r.status_code == 200 else []
    if not menu:
        log_result("write.find_menu", False, 0, "пустое меню")
        pytest.skip("нет блюд")

    log(f"  table={free_table.get('name')} ({free_table['id'][:8]})")
    log(f"  menu_item={menu[0].get('name')} price={menu[0].get('price')}")

    # 2. Создаём заказ.
    log("POST /api/v1/orders")
    body = {
        "table_id": free_table["id"],
        "type": "hall",
        "guests_count": 1,
        "items": [{"menu_item_id": menu[0]["id"], "qty": "1", "price": str(menu[0]["price"])}],
    }
    r, ms = client.post("/api/v1/orders", body)
    if r.status_code not in (200, 201):
        log_result("write.create_order", False, ms, f"http {r.status_code}: {r.text[:200]}")
        pytest.fail("create failed")
    order = r.json()
    order_id = order.get("id") or order.get("order", {}).get("id")
    log_result("write.create_order", True, ms, f"order_id={order_id[:8] if order_id else '?'}")

    # 3. Отменяем заказ.
    log(f"POST /api/v1/orders/{order_id[:8]}.../cancel")
    r, ms = client.post(f"/api/v1/orders/{order_id}/cancel", {"reason": "smoke-test cleanup"})
    log_result("write.cancel_order", r.status_code in (200, 204), ms, f"http {r.status_code}")


# ─── Summary ───────────────────────────────────────────────────────────────


def pytest_sessionfinish(session, exitstatus):
    """Финальный summary в логе."""
    _open_log()
    _log_file.write("\n")
    _log_file.write("=" * 70 + "\n")
    _log_file.write("SUMMARY\n")
    _log_file.write("=" * 70 + "\n")
    total = len(RESULTS)
    passed = sum(1 for r in RESULTS if r["ok"])
    failed = total - passed
    _log_file.write(f"Tests: {total}  Passed: {passed}  Failed: {failed}\n")
    _log_file.write("\n")
    if RESULTS:
        max_name = max(len(r["name"]) for r in RESULTS)
        _log_file.write(f"{'name'.ljust(max_name)}  ms       status  detail\n")
        _log_file.write("-" * (max_name + 60) + "\n")
        for r in RESULTS:
            status = "✓" if r["ok"] else "✗"
            _log_file.write(f"{r['name'].ljust(max_name)}  {r['latency_ms']:>6.0f}   {status}      {r['detail']}\n")
    _log_file.write("\n")
    if failed:
        _log_file.write(f"⚠ {failed} тест(а/ов) упали — см. детали выше.\n")
    else:
        _log_file.write("✓ Все тесты прошли.\n")
    _log_file.close()
    print(f"\nLog written to: {LOG_PATH.resolve()}")
