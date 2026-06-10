"""
RestOS load test — найти предел кассы по конкурентным официантам.

Что делает:
  1. Логинится по PIN.
  2. Несколько раундов с растущим числом «официантов»:
       1 → 2 → 5 → 10 → 20 → 50 параллельных потоков.
  3. Каждый «официант» в своём потоке делает K циклов:
       create_order (с 1-3 позициями) → cancel_order
     (cancel чтобы не пачкать БД real-выручкой; close требует payment_method
     и реальной оплаты в кассу).
  4. Меряет p50/p95/p99 латентность для create + cancel.
  5. Считает throughput, error-rate.
  6. Определяет предел: «касса держит N официантов без лагов» (p99 < 500ms,
     err_rate < 1%).
  7. Пишет всё в load-test.log + красивую таблицу в консоль.

Запуск (на винде):
  pip install -r requirements.txt
  set RESTOS_BASE_URL=http://127.0.0.1:3001
  set RESTOS_RESTAURANT_ID=<uuid>
  set RESTOS_PIN=<пин>
  python load_test.py

Опции:
  --max-waiters N    Макс. число конкурентных официантов (default 50)
  --orders-per N     Сколько заказов делает каждый официант в раунде (default 10)
  --p99-threshold MS Граница «лага» (default 500)

Все заказы создаются и тут же отменяются — БД остаётся почти чистой
(только audit_log и order_voids растут).
"""

from __future__ import annotations  # для list[float] на Python 3.8

import argparse
import os
import random
import statistics
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Optional

import requests


# ─── Config ────────────────────────────────────────────────────────────────

BASE_URL = os.environ.get("RESTOS_BASE_URL", "http://127.0.0.1:3001")
RESTAURANT_ID = os.environ.get("RESTOS_RESTAURANT_ID", "")
PIN = os.environ.get("RESTOS_PIN", "")
LOG_PATH = Path(os.environ.get("RESTOS_LOAD_LOG", "load-test.log"))

# Стандартный профиль раундов. --max-waiters обрезает с конца.
ROUNDS = [1, 2, 5, 10, 20, 50]


# ─── Logger ────────────────────────────────────────────────────────────────


class Logger:
    def __init__(self, path: Path):
        self.f = path.open("w", encoding="utf-8")
        self.f.write(f"# RestOS load test — {datetime.now().isoformat()}\n")
        self.f.write(f"# BASE_URL={BASE_URL}\n")
        self.f.write(f"# Python={sys.version.split()[0]}\n\n")
        self.f.flush()

    def log(self, msg: str):
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        line = f"[{ts}] {msg}"
        print(line)
        self.f.write(line + "\n")
        self.f.flush()

    def raw(self, msg: str):
        print(msg)
        self.f.write(msg + "\n")
        self.f.flush()

    def close(self):
        self.f.close()


# ─── HTTP helper ───────────────────────────────────────────────────────────


def login() -> str:
    r = requests.post(
        BASE_URL + "/api/v1/auth/login",
        json={"restaurant_id": RESTAURANT_ID, "pin": PIN},
        timeout=10,
    )
    if r.status_code != 200:
        raise RuntimeError(f"login failed: {r.status_code} {r.text[:200]}")
    return r.json()["token"]


def fetch_setup(token: str) -> tuple[list, list]:
    """Возвращает (tables, menu_items) — нужны для генерации заказов."""
    h = {"Authorization": f"Bearer {token}"}
    # Берём только свободные столы.
    r = requests.get(BASE_URL + "/api/v1/tables", headers=h, timeout=10)
    r.raise_for_status()
    body = r.json()
    tables = body.get("data", []) if isinstance(body, dict) else body
    free_tables = [t for t in tables if t.get("status") == "free"]

    r = requests.get(BASE_URL + "/api/v1/menu/items", headers=h, params={"limit": 100}, timeout=10)
    r.raise_for_status()
    body = r.json()
    items = body.get("data", []) if isinstance(body, dict) else body
    # Только доступные блюда с ценой.
    items = [i for i in items if i.get("is_available", True) and float(i.get("price", 0)) > 0]
    return free_tables, items


# ─── Worker ────────────────────────────────────────────────────────────────


class WaiterResult:
    def __init__(self):
        self.create_ms: list[float] = []
        self.cancel_ms: list[float] = []
        self.errors: list[str] = []
        self.created_order_ids: list[str] = []


def waiter_loop(token: str, table_id: str, menu_items: list, n_orders: int) -> WaiterResult:
    """Один «официант» — последовательно создаёт+отменяет n_orders заказов."""
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    res = WaiterResult()
    for _ in range(n_orders):
        # Случайные 1-3 позиции.
        chosen = random.sample(menu_items, min(random.randint(1, 3), len(menu_items)))
        # ВАЖНО: backend ждёт qty и price как строки (Decimal scale=4).
        # Передаёшь float — VALIDATION error.
        body = {
            "table_id": table_id,
            "type": "hall",
            "guests_count": random.randint(1, 4),
            "items": [
                {
                    "menu_item_id": it["id"],
                    "qty": str(random.choice([1, 1, 1, 2])),
                    "price": str(it["price"]),
                }
                for it in chosen
            ],
        }
        # create
        t0 = time.perf_counter()
        try:
            r = s.post(
                BASE_URL + "/api/v1/orders",
                json=body,
                headers={"Idempotency-Key": str(uuid.uuid4())},
                timeout=30,
            )
        except Exception as e:
            res.errors.append(f"create network: {e}")
            continue
        ms = (time.perf_counter() - t0) * 1000
        res.create_ms.append(ms)
        if r.status_code not in (200, 201):
            res.errors.append(f"create http {r.status_code}: {r.text[:120]}")
            continue
        try:
            order = r.json()
            order_id = order.get("id") or order.get("order", {}).get("id")
        except Exception:
            res.errors.append("create body parse")
            continue
        if not order_id:
            res.errors.append("create no order id")
            continue
        res.created_order_ids.append(order_id)

        # cancel
        t0 = time.perf_counter()
        try:
            r = s.post(
                BASE_URL + f"/api/v1/orders/{order_id}/cancel",
                json={"reason": "load-test"},
                headers={"Idempotency-Key": str(uuid.uuid4())},
                timeout=30,
            )
        except Exception as e:
            res.errors.append(f"cancel network: {e}")
            continue
        ms = (time.perf_counter() - t0) * 1000
        res.cancel_ms.append(ms)
        if r.status_code not in (200, 204):
            res.errors.append(f"cancel http {r.status_code}: {r.text[:120]}")
    return res


# ─── Round runner ──────────────────────────────────────────────────────────


def percentile(xs: list[float], p: float) -> float:
    if not xs:
        return 0.0
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


def fmt_lat(samples: list[float]) -> str:
    if not samples:
        return "—"
    return f"p50={percentile(samples, 50):.0f} p95={percentile(samples, 95):.0f} p99={percentile(samples, 99):.0f} max={max(samples):.0f}ms"


def run_round(token: str, tables: list, menu: list, n_waiters: int, n_orders: int, log: Logger) -> dict:
    """Один раунд: n_waiters параллельно делают n_orders циклов."""
    if not tables or not menu:
        raise RuntimeError("нет свободных столов или меню для теста")
    # Распределяем столы по воркерам циклически — два воркера на один стол OK,
    # это симулирует реальную ситуацию когда заказы создаются часто.
    log.log(f"── Раунд: {n_waiters} официантов × {n_orders} заказов ──")
    t0 = time.perf_counter()
    create_all: list[float] = []
    cancel_all: list[float] = []
    errors_all: list[str] = []
    created: list[str] = []
    with ThreadPoolExecutor(max_workers=n_waiters) as ex:
        futures = []
        for i in range(n_waiters):
            table = tables[i % len(tables)]
            futures.append(ex.submit(waiter_loop, token, table["id"], menu, n_orders))
        for fut in as_completed(futures):
            try:
                r = fut.result()
                create_all.extend(r.create_ms)
                cancel_all.extend(r.cancel_ms)
                errors_all.extend(r.errors)
                created.extend(r.created_order_ids)
            except Exception as e:
                errors_all.append(f"worker died: {e}")
    elapsed = time.perf_counter() - t0
    total_orders = len(create_all)
    err_count = len(errors_all)
    err_rate = err_count / max(1, total_orders) * 100
    tps = total_orders / elapsed if elapsed > 0 else 0

    log.log(f"  total: {total_orders} orders in {elapsed:.1f}s  throughput={tps:.1f}/sec")
    log.log(f"  create: {fmt_lat(create_all)}")
    log.log(f"  cancel: {fmt_lat(cancel_all)}")
    log.log(f"  errors: {err_count} ({err_rate:.1f}%)")
    # Всегда показываем первые 3 ошибки — без этого непонятно что не так.
    if err_count:
        for e in errors_all[:3]:
            log.log(f"    ! {e}")

    return {
        "n_waiters": n_waiters,
        "n_orders": n_orders,
        "elapsed": elapsed,
        "total": total_orders,
        "tps": tps,
        "create_p50": percentile(create_all, 50),
        "create_p95": percentile(create_all, 95),
        "create_p99": percentile(create_all, 99),
        "create_max": max(create_all) if create_all else 0,
        "cancel_p50": percentile(cancel_all, 50),
        "cancel_p95": percentile(cancel_all, 95),
        "cancel_p99": percentile(cancel_all, 99),
        "cancel_max": max(cancel_all) if cancel_all else 0,
        "errors": err_count,
        "err_rate": err_rate,
        "created_ids": created,
    }


# ─── Main ──────────────────────────────────────────────────────────────────


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-waiters", type=int, default=50)
    ap.add_argument("--orders-per", type=int, default=10)
    ap.add_argument("--p99-threshold", type=float, default=500)
    ap.add_argument("--err-threshold", type=float, default=1.0)
    args = ap.parse_args()

    if not RESTAURANT_ID or not PIN:
        print("❌ Set RESTOS_RESTAURANT_ID и RESTOS_PIN env vars")
        sys.exit(1)

    log = Logger(LOG_PATH)
    log.log(f"=== RestOS Load Test ===")
    log.log(f"base_url={BASE_URL}  restaurant_id={RESTAURANT_ID[:8]}...")
    log.log(f"max_waiters={args.max_waiters} orders_per={args.orders_per}")
    log.log(f"p99 threshold = {args.p99_threshold}ms,  err threshold = {args.err_threshold}%")
    log.log("")

    # 1. Login.
    log.log("1) Login...")
    try:
        token = login()
        log.log(f"   ✓ logged in")
    except Exception as e:
        log.log(f"   ✗ {e}")
        log.close()
        sys.exit(1)

    # 2. Setup.
    log.log("2) Fetching tables + menu...")
    tables, menu = fetch_setup(token)
    log.log(f"   ✓ free tables = {len(tables)},  menu items = {len(menu)}")
    if not tables:
        log.log("   ⚠ Нет свободных столов — load test невозможен. Освободи столы или используй --use-occupied (TBD)")
        log.close()
        sys.exit(1)
    if not menu:
        log.log("   ⚠ Пустое меню — load test невозможен.")
        log.close()
        sys.exit(1)

    # 3. Прогон раундов.
    rounds = [n for n in ROUNDS if n <= args.max_waiters]
    log.log(f"3) Раунды: {rounds}")
    log.log("")
    results = []
    breaking_point = None
    for n in rounds:
        res = run_round(token, tables, menu, n, args.orders_per, log)
        results.append(res)
        # Определяем breaking point: первый раунд где p99 create > threshold ИЛИ err_rate > threshold.
        if breaking_point is None and (res["create_p99"] > args.p99_threshold or res["err_rate"] > args.err_threshold):
            breaking_point = n
        log.log("")
        time.sleep(1)  # короткий cooldown между раундами

    # 4. Сводка.
    log.raw("")
    log.raw("=" * 90)
    log.raw("SUMMARY")
    log.raw("=" * 90)
    header = f"{'waiters':>8} {'orders':>7} {'time':>6} {'tps':>6}  {'create_p99':>11} {'cancel_p99':>11}  {'errors':>7}"
    log.raw(header)
    log.raw("-" * 90)
    for r in results:
        lag_mark = "  ← lag" if r["create_p99"] > args.p99_threshold else ""
        err_mark = "  ← errs" if r["err_rate"] > args.err_threshold else ""
        log.raw(
            f"{r['n_waiters']:>8} {r['total']:>7} {r['elapsed']:>5.1f}s {r['tps']:>5.1f}  "
            f"{r['create_p99']:>9.0f}ms {r['cancel_p99']:>9.0f}ms  {r['errors']:>7}{lag_mark}{err_mark}"
        )
    log.raw("")

    # 5. Verdict.
    log.raw("=" * 90)
    log.raw("VERDICT")
    log.raw("=" * 90)
    if breaking_point is None:
        last = results[-1]
        log.raw(
            f"✅ Касса спокойно держит {last['n_waiters']} конкурентных официантов "
            f"(p99 create = {last['create_p99']:.0f}ms, err_rate = {last['err_rate']:.1f}%)."
        )
        log.raw(f"   Throughput: {last['tps']:.1f} заказов/сек.")
        log.raw("   Чтобы найти реальный предел — увеличь --max-waiters.")
    else:
        # Найдём последний безопасный раунд.
        safe = [r for r in results if r["n_waiters"] < breaking_point]
        if safe:
            s = safe[-1]
            log.raw(f"⚠ Лаги начинаются с {breaking_point} официантов.")
            log.raw(
                f"   Безопасный максимум: {s['n_waiters']} официантов "
                f"(p99 create = {s['create_p99']:.0f}ms, throughput = {s['tps']:.1f}/сек)."
            )
        else:
            log.raw(f"❌ Лаги уже на минимальной нагрузке ({breaking_point} официант).")
            log.raw("   Проверь железо кассы (диск, антивирус, postgres process).")
    log.raw("")

    # 6. Cleanup hint.
    total_created = sum(len(r["created_ids"]) for r in results)
    log.raw(f"Всего создано заказов: {total_created} (все отменены).")
    log.raw(f"Лог: {LOG_PATH.resolve()}")
    log.close()


if __name__ == "__main__":
    main()
