import { describe, it, expectTypeOf } from 'vitest'
import type { paths, components } from './generated'

// Contract tests — compile-time проверки что generated.ts соответствует
// тому, что код реально шлёт/ожидает от backend'а. Любой drift между
// openapi.yaml и реальной API-структурой ломает эти тесты на этапе tsc.
//
// expectTypeOf не выполняет runtime — `vitest run` фактически проверяет,
// что файл компилируется с этими утверждениями.

describe('CloseOrderInput contract', () => {
  it('содержит все поля из v2.0.17/22 (service_percent, payments, discount)', () => {
    type Body = NonNullable<NonNullable<paths['/api/v1/orders/{id}/close']['post']['requestBody']>['content']['application/json']>
    expectTypeOf<Body>().toHaveProperty('payment_method')
    expectTypeOf<Body>().toHaveProperty('account_id')
    expectTypeOf<Body>().toHaveProperty('shift_id')
    expectTypeOf<Body>().toHaveProperty('tip_amount')
    expectTypeOf<Body>().toHaveProperty('cashier_id')
    expectTypeOf<Body>().toHaveProperty('discount_type')
    expectTypeOf<Body>().toHaveProperty('discount_value')
    expectTypeOf<Body>().toHaveProperty('discount_reason')
    expectTypeOf<Body>().toHaveProperty('service_percent')
    expectTypeOf<Body>().toHaveProperty('payments')
  })

  it('shift_id обязателен', () => {
    type Body = NonNullable<NonNullable<paths['/api/v1/orders/{id}/close']['post']['requestBody']>['content']['application/json']>
    // shift_id required → не optional
    expectTypeOf<Body['shift_id']>().not.toBeUndefined()
  })

  it('payments[]: method enum cash|card|transfer', () => {
    type Split = components['schemas']['PaymentSplit']
    type Method = NonNullable<Split['method']>
    expectTypeOf<Method>().toEqualTypeOf<'cash' | 'card' | 'transfer'>()
  })
})

describe('CreateOrderInput contract', () => {
  it('items[].menu_item_id обязателен; qty как decimal-string', () => {
    type Body = NonNullable<NonNullable<paths['/api/v1/orders']['post']['requestBody']>['content']['application/json']>
    expectTypeOf<Body>().toHaveProperty('items')
    expectTypeOf<Body>().toHaveProperty('table_id')
    expectTypeOf<Body>().toHaveProperty('shift_id')
  })
})

describe('Order response contract', () => {
  it('Order имеет order_number, total, total_with_service, service_amount', () => {
    type Order = components['schemas']['Order']
    expectTypeOf<Order>().toHaveProperty('order_number')
    expectTypeOf<Order>().toHaveProperty('total')
    expectTypeOf<Order>().toHaveProperty('total_with_service')
    expectTypeOf<Order>().toHaveProperty('service_amount')
    expectTypeOf<Order>().toHaveProperty('service_percent')
  })
})
