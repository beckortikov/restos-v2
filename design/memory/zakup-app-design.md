---
name: zakup-app-design
description: Phone app design for the закупщик (buyer/procurement) role lives in design/app_zakup.pen
metadata:
  type: project
---

Phone app UI for the **закупщик (buyer/procurement)** role is designed in `design/app_zakup.pen` (Pencil). 390px-wide mobile screens.

**Screens (13):** 01 Вход (PIN) · 02 Обзор · 03 Склад · 04 Поставщики · 05 Новая приёмка · 06 Что закупить · 07 Поставщик (деталь) · 08 История приёмок · 09 Возврат поставщику (`POST /stock/returns`, reason spoilage/breakage/expired/other, refund debt/money) · 10 Списание (`POST /stock/writeoffs`) · 11 Инвентаризация (`/stock/inventory`, system_qty vs actual_qty diff) · 12 Погашение долга (bottom-sheet, `POST /suppliers/{id}/pay-debt`) · 13 Ещё · 14 Приёмка-поиск позиций (вкладки по warehouse.kind products/purchased/supplies=Хозтовары, частые позиции, добавление в 1 тап) · 15 Начальный остаток (`POST /stock/opening-balance`, взнос в капитал) · 16 Расход хозтоваров (`createSupplyExpense`, reasons SUPPLY_EXPENSE_REASONS: Выдано в зал/кухню/бар, Хоз.нужды, Порча/бой, Прочее; issuedTo).

Модель складов: `warehouse.kind` = products / purchased / supplies. Хозтовары = supplies (ингредиент `is_food=false`). Приёмка фильтруется вкладками по kind. Two reusable components: `StatusBar` (id oFKUg) and `TabBar` (id wnbWS, tabs: Обзор/Склад/Поставщики/Ещё).

**Auth** replicates the cashier/waiter PIN flow from `app/(auth)/login/page.tsx` (logo tile + PIN dots + numpad, `POST /api/v1/auth/login` {restaurant_id, pin}).

**Design decision:** the product's base theme is neutral grayscale (shadcn, primary ≈ near-black). For the buyer app I introduced an **emerald accent `#0E9F6E`** (with soft `#E6F6EF`) as the primary action color to give procurement its own identity, keeping near-black `#15171C` text on `#F4F5F7` page bg. Font Inter, card radius 20, button radius 14. Semantic: danger `#E5484D` (debt), warn `#E8880C` (low stock).

Backed by real API: `/api/v1/stock/ingredients` (qty, unit, min_qty, price_per_unit), `/api/v1/stock/receipts` (ReceiptInput: supplier, lines, payment_type paid/credit, account_id), `/api/v1/suppliers` (current_debt, credit_limit, categories, pay-debt), `/api/v1/stock/movements|returns|writeoffs`. See [[restos-v4-guidelines]].
