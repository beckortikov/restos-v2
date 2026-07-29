import { describe, it, expect } from 'vitest'
import { comboKeyOf, combosOf, buildCombosPayload, type AttrForm, type ComboPrices } from './attributes-editor'

// Регрессия на баг: «в покупном вариационном товаре правка вариантов удаляет
// закупочную и цену продажи». Причина была — карта цен ключевалась по ЛЕЙБЛУ
// значения, и переименование «осиротлло» цену. Теперь ключ — по id значения.
describe('attributes-editor: ключ комбинации стабилен при переименовании', () => {
  it('comboKeyOf не меняется при правке лейбла (ключ по id значения)', () => {
    const before = comboKeyOf([{ id: 'v1', label: '0.5' }])
    const after = comboKeyOf([{ id: 'v1', label: '0,5 л' }])
    expect(after).toBe(before)
  })

  it('ключ не зависит от порядка значений', () => {
    const a = comboKeyOf([{ id: 'v1', label: 'L' }, { id: 'v2', label: 'Кола' }])
    const b = comboKeyOf([{ id: 'v2', label: 'Кола' }, { id: 'v1', label: 'L' }])
    expect(a).toBe(b)
  })

  it('ключ загрузки (набор value_ids) совпадает с ключом формы', () => {
    const variantValueIds = ['v2', 'v1'] // бэк отдаёт value_ids в произвольном порядке
    const loadKey = variantValueIds.map(String).slice().sort().join('\x1f')
    const formKey = comboKeyOf([{ id: 'v1', label: 'L' }, { id: 'v2', label: 'Кола' }])
    expect(loadKey).toBe(formKey)
  })

  it('цена и закупка комбинации переживают переименование значения', () => {
    const attrsBefore: AttrForm[] = [
      { name: 'Объём', values: [{ id: 'v1', label: '0.5' }, { id: 'v2', label: '1' }] },
    ]
    const prices: ComboPrices = {}
    for (const c of combosOf(attrsBefore)) {
      prices[c.key] = c.title === '0.5' ? { price: 60, purchase: 45 } : { price: 90, purchase: 70 }
    }
    // Переименовываем «0.5» → «0,5 л»; id значения сохраняется (как в форме).
    const attrsAfter: AttrForm[] = [
      { name: 'Объём', values: [{ id: 'v1', label: '0,5 л' }, { id: 'v2', label: '1' }] },
    ]
    const payload = buildCombosPayload(attrsAfter, prices)
    const renamed = payload.find(c => c.labels[0] === '0,5 л')
    expect(renamed).toBeDefined()
    expect(renamed?.price).toBe(60) // до фикса было бы 0 (цена «осиротела»)
    expect(renamed?.purchasePrice).toBe(45) // до фикса было бы 0
  })
})
