import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Check,
  X,
  ArrowLeft,
  Star,
  Zap,
  Crown,
  Rocket,
  MessageSquare,
} from 'lucide-react'

const plans = [
  {
    id: 'lite',
    name: 'Lite',
    price: 300,
    priceDaily: 10,
    priceUsd: 27,
    icon: Zap,
    description: 'Для небольших точек, стрит-фуда, мини-кафе',
    cta: 'Начать пробный период',
    ctaVariant: 'outline' as const,
    style: 'border-border',
    limits: ['1 заведение', '1 терминал', '2 пользователя', '50 позиций меню'],
    features: {
      'POS и Заказы': true,
      'Офлайн-режим': true,
      'Печать чеков': true,
      'Кухонный дисплей': false,
      'Склад (базовый)': false,
      'Техкарты, полуфабрикаты': false,
      'Поставщики': false,
      'Финансы (P&L, cashflow)': false,
      'Расчёт ЗП': false,
      'Аналитика (ABC, фудкост)': false,
      'Прогноз выручки': false,
      'Excel импорт/экспорт': false,
      'Мобильная версия': false,
      'Клиентская база': false,
      'Онлайн-каталог': false,
      'Приложение для клиентов': false,
      'Онлайн-оплата': false,
      'QR-меню': false,
      'Программа лояльности': false,
      'API / интеграции': false,
    },
    support: 'Email / Telegram',
    sla: '—',
  },
  {
    id: 'start',
    name: 'Start',
    price: 700,
    priceDaily: 23,
    priceUsd: 64,
    icon: Star,
    description: 'Для кафе и небольших ресторанов',
    cta: 'Начать пробный период',
    ctaVariant: 'outline' as const,
    style: 'border-border',
    limits: ['1 заведение', '2 терминала', '5 пользователей', '150 позиций меню'],
    features: {
      'POS и Заказы': true,
      'Офлайн-режим': true,
      'Печать чеков': true,
      'Кухонный дисплей': true,
      'Склад (базовый)': true,
      'Техкарты, полуфабрикаты': false,
      'Поставщики': false,
      'Финансы (P&L, cashflow)': false,
      'Расчёт ЗП': false,
      'Аналитика (ABC, фудкост)': false,
      'Прогноз выручки': false,
      'Excel импорт/экспорт': false,
      'Мобильная версия': true,
      'Клиентская база': true,
      'Онлайн-каталог': false,
      'Приложение для клиентов': false,
      'Онлайн-оплата': false,
      'QR-меню': false,
      'Программа лояльности': false,
      'API / интеграции': false,
    },
    support: 'Рабочие часы',
    sla: '—',
  },
  {
    id: 'pro',
    name: 'PRO',
    price: 1200,
    priceDaily: 40,
    priceUsd: 110,
    icon: Rocket,
    popular: true,
    description: 'Для растущих ресторанов. Основной тариф.',
    cta: 'Попробовать бесплатно 14 дней',
    ctaVariant: 'default' as const,
    style: 'border-primary shadow-lg shadow-primary/10 scale-[1.02]',
    limits: ['1 заведение', '5 терминалов', '15 пользователей', 'Меню без ограничений'],
    features: {
      'POS и Заказы': true,
      'Офлайн-режим': true,
      'Печать чеков': true,
      'Кухонный дисплей': true,
      'Склад (базовый)': true,
      'Техкарты, полуфабрикаты': true,
      'Поставщики': true,
      'Финансы (P&L, cashflow)': true,
      'Расчёт ЗП': true,
      'Аналитика (ABC, фудкост)': true,
      'Прогноз выручки': true,
      'Excel импорт/экспорт': true,
      'Мобильная версия': true,
      'Клиентская база': true,
      'Онлайн-каталог': false,
      'Приложение для клиентов': false,
      'Онлайн-оплата': false,
      'QR-меню': false,
      'Программа лояльности': false,
      'API / интеграции': false,
    },
    support: 'Приоритетная',
    sla: '99.5%',
  },
  {
    id: 'max',
    name: 'MAX',
    price: 2500,
    priceDaily: 83,
    priceUsd: 230,
    icon: Crown,
    description: 'Для ресторанов, которые хотят продавать онлайн',
    cta: 'Связаться с отделом продаж',
    ctaVariant: 'outline' as const,
    style: 'border-border bg-card dark:bg-zinc-900',
    limits: ['1 заведение', 'Терминалы — без ограничений', 'Пользователи — без ограничений', 'Меню без ограничений'],
    features: {
      'POS и Заказы': true,
      'Офлайн-режим': true,
      'Печать чеков': true,
      'Кухонный дисплей': true,
      'Склад (базовый)': true,
      'Техкарты, полуфабрикаты': true,
      'Поставщики': true,
      'Финансы (P&L, cashflow)': true,
      'Расчёт ЗП': true,
      'Аналитика (ABC, фудкост)': true,
      'Прогноз выручки': true,
      'Excel импорт/экспорт': true,
      'Мобильная версия': true,
      'Клиентская база': true,
      'Онлайн-каталог': true,
      'Приложение для клиентов': true,
      'Онлайн-оплата': true,
      'QR-меню': true,
      'Программа лояльности': true,
      'API / интеграции': true,
    },
    support: 'Персональный менеджер',
    sla: '99.9%',
  },
]

const featureGroups = [
  {
    name: 'Основные',
    features: ['POS и Заказы', 'Офлайн-режим', 'Печать чеков', 'Кухонный дисплей'],
  },
  {
    name: 'Склад',
    features: ['Склад (базовый)', 'Техкарты, полуфабрикаты', 'Поставщики'],
  },
  {
    name: 'Финансы и аналитика',
    features: ['Финансы (P&L, cashflow)', 'Расчёт ЗП', 'Аналитика (ABC, фудкост)', 'Прогноз выручки'],
  },
  {
    name: 'Удобство',
    features: ['Excel импорт/экспорт', 'Мобильная версия', 'Клиентская база'],
  },
  {
    name: 'Онлайн-продажи',
    features: ['Онлайн-каталог', 'Приложение для клиентов', 'Онлайн-оплата', 'QR-меню', 'Программа лояльности', 'API / интеграции'],
  },
]

const TG_LINK = 'https://t.me/muhammad_babolo'

export default function PricingPage() {
  const [billing, setBilling] = useState<'monthly' | 'annual' | 'biennial'>('monthly')

  const discount = billing === 'annual' ? 0.85 : billing === 'biennial' ? 0.8 : 1
  const discountLabel = billing === 'annual' ? '-15%' : billing === 'biennial' ? '-20%' : null

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/" className="text-lg font-bold tracking-tight">
              Rest<span className="text-primary">OS</span>
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/oferta" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Оферта
            </Link>
            <a href="/login" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Войти
            </a>
            <Link to="/">
              <Button size="sm" variant="outline">
                <ArrowLeft className="mr-1.5 size-3.5" />
                На главную
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-28 pb-12 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
            Тарифы Rest<span className="text-primary">OS</span>
          </h1>
          <p className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto">
            Выберите тариф, который подходит вашему бизнесу. 14 дней бесплатно на тарифе PRO.
          </p>

          {/* Billing toggle */}
          <div className="mt-8 inline-flex items-center gap-1 bg-muted rounded-lg p-1">
            <button
              onClick={() => setBilling('monthly')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                billing === 'monthly' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Ежемесячно
            </button>
            <button
              onClick={() => setBilling('annual')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                billing === 'annual' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              За год
              <span className="ml-1.5 text-xs text-primary font-semibold">-15%</span>
            </button>
            <button
              onClick={() => setBilling('biennial')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                billing === 'biennial' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              За 2 года
              <span className="ml-1.5 text-xs text-primary font-semibold">-20%</span>
            </button>
          </div>
        </div>
      </section>

      {/* Pricing cards */}
      <section className="pb-20 px-4">
        <div className="max-w-6xl mx-auto grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {plans.map((plan) => {
            const monthlyPrice = Math.round(plan.price * discount)
            return (
              <Card
                key={plan.id}
                className={`relative flex flex-col border-2 ${plan.style}`}
              >
                {plan.popular && (
                  <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground px-4 py-1">
                    Популярный
                  </Badge>
                )}
                <CardHeader className="pb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`size-9 rounded-lg flex items-center justify-center ${plan.popular ? 'bg-primary/10' : 'bg-muted'}`}>
                      <plan.icon className={`size-5 ${plan.popular ? 'text-primary' : 'text-muted-foreground'}`} />
                    </div>
                    <h3 className="text-xl font-bold">{plan.name}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground">{plan.description}</p>
                </CardHeader>
                <CardContent className="flex flex-col flex-1">
                  {/* Price */}
                  <div className="mb-6">
                    <div className="flex items-baseline gap-1">
                      <span className="text-3xl font-bold">{monthlyPrice}</span>
                      <span className="text-muted-foreground">SMN / мес</span>
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">
                      от {Math.round(monthlyPrice / 30)} SMN / день
                      <span className="text-xs ml-1">(~${Math.round(monthlyPrice / 10.9)}/мес)</span>
                    </div>
                    {discountLabel && (
                      <Badge variant="secondary" className="mt-2 text-xs">
                        {discountLabel} скидка
                      </Badge>
                    )}
                  </div>

                  {/* Limits */}
                  <div className="space-y-2 mb-6">
                    {plan.limits.map((l) => (
                      <div key={l} className="flex items-center gap-2 text-sm">
                        <Check className="size-4 text-primary shrink-0" />
                        <span>{l}</span>
                      </div>
                    ))}
                  </div>

                  {/* Key features */}
                  <div className="space-y-1.5 mb-6 flex-1">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Включено</p>
                    {Object.entries(plan.features)
                      .filter(([, v]) => v)
                      .slice(0, 8)
                      .map(([f]) => (
                        <div key={f} className="flex items-center gap-2 text-sm">
                          <Check className="size-3.5 text-primary shrink-0" />
                          <span className="text-muted-foreground">{f}</span>
                        </div>
                      ))}
                    {Object.values(plan.features).filter(Boolean).length > 8 && (
                      <p className="text-xs text-muted-foreground mt-1">
                        + ещё {Object.values(plan.features).filter(Boolean).length - 8} функций
                      </p>
                    )}
                  </div>

                  {/* Support */}
                  <div className="text-xs text-muted-foreground mb-4 pt-4 border-t border-border">
                    <div>Поддержка: {plan.support}</div>
                    {plan.sla !== '—' && <div>SLA: {plan.sla}</div>}
                  </div>

                  {/* CTA */}
                  {plan.id === 'max' ? (
                    <a href={TG_LINK} target="_blank" rel="noopener noreferrer" className="mt-auto">
                      <Button variant={plan.ctaVariant} className="w-full text-xs h-auto py-2.5 whitespace-normal">
                        <MessageSquare className="mr-1.5 size-3.5 shrink-0" />
                        {plan.cta}
                      </Button>
                    </a>
                  ) : (
                    <Link to="/login" className="mt-auto">
                      <Button variant={plan.ctaVariant} className="w-full text-xs h-auto py-2.5 whitespace-normal">
                        {plan.cta}
                      </Button>
                    </Link>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      </section>

      {/* Comparison table */}
      <section className="py-20 px-4 bg-muted/50">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl font-bold tracking-tight text-center mb-12">Сравнение тарифов</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 pr-4 font-medium w-[240px]">Функция</th>
                  {plans.map((p) => (
                    <th key={p.id} className={`text-center py-3 px-4 font-semibold ${p.popular ? 'text-primary' : ''}`}>
                      {p.name}
                      <div className="text-xs font-normal text-muted-foreground mt-0.5">{p.price} SMN</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  <tr key="limits-header" className="border-b border-border bg-muted/30">
                    <td colSpan={5} className="py-2.5 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Лимиты
                    </td>
                  </tr>,
                  ...[
                    { label: 'Терминалы', values: ['1', '2', '5', '\u221E'] },
                    { label: 'Пользователи', values: ['2', '5', '15', '\u221E'] },
                    { label: 'Позиции меню', values: ['50', '150', '\u221E', '\u221E'] },
                  ].map((row) => (
                    <tr key={`limit-${row.label}`} className="border-b border-border/50">
                      <td className="py-2.5 pr-4">{row.label}</td>
                      {row.values.map((v, i) => (
                        <td key={i} className={`text-center py-2.5 px-4 ${plans[i].popular ? 'bg-primary/5' : ''}`}>
                          {v}
                        </td>
                      ))}
                    </tr>
                  )),
                  ...featureGroups.flatMap((group) => [
                    <tr key={`group-${group.name}`} className="border-b border-border bg-muted/30">
                      <td colSpan={5} className="py-2.5 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {group.name}
                      </td>
                    </tr>,
                    ...group.features.map((f) => (
                      <tr key={`feature-${f}`} className="border-b border-border/50">
                        <td className="py-2.5 pr-4">{f}</td>
                        {plans.map((p) => (
                          <td key={p.id} className={`text-center py-2.5 px-4 ${p.popular ? 'bg-primary/5' : ''}`}>
                            {p.features[f as keyof typeof p.features] ? (
                              <Check className="size-4 text-primary mx-auto" />
                            ) : (
                              <X className="size-4 text-muted-foreground/30 mx-auto" />
                            )}
                          </td>
                        ))}
                      </tr>
                    )),
                  ]),
                  <tr key="support-header" className="border-b border-border bg-muted/30">
                    <td colSpan={5} className="py-2.5 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Поддержка
                    </td>
                  </tr>,
                  <tr key="support-channel" className="border-b border-border/50">
                    <td className="py-2.5 pr-4">Канал поддержки</td>
                    {plans.map((p) => (
                      <td key={p.id} className={`text-center py-2.5 px-4 text-xs ${p.popular ? 'bg-primary/5' : ''}`}>
                        {p.support}
                      </td>
                    ))}
                  </tr>,
                  <tr key="support-sla" className="border-b border-border/50">
                    <td className="py-2.5 pr-4">SLA</td>
                    {plans.map((p) => (
                      <td key={p.id} className={`text-center py-2.5 px-4 ${p.popular ? 'bg-primary/5' : ''}`}>
                        {p.sla}
                      </td>
                    ))}
                  </tr>,
                ]}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* FAQ / Additional info */}
      <section className="py-20 px-4">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl font-bold tracking-tight text-center mb-12">Частые вопросы</h2>
          <div className="space-y-6">
            {[
              {
                q: 'Есть ли пробный период?',
                a: '14 дней бесплатно на тарифе PRO с полным функционалом. Банковская карта не требуется. По окончании пробного периода аккаунт переводится на Lite.',
              },
              {
                q: 'Можно ли сменить тариф?',
                a: 'Да, вы можете перейти на другой тариф в любой момент. При повышении тарифа разница рассчитывается пропорционально.',
              },
              {
                q: 'Какие скидки доступны?',
                a: 'При оплате за год — скидка 15%. За 2 года — 20%. Также действует партнёрская программа: 10% от первого года клиента.',
              },
              {
                q: 'Что такое мульти-ресторан?',
                a: 'Управление несколькими заведениями из единой панели. Доступно как отдельная опция на тарифе MAX (+900 SMN/мес за каждое дополнительное заведение) или в рамках тарифа Enterprise.',
              },
              {
                q: 'Как работает возврат средств?',
                a: 'При расторжении договора возврат неиспользованной части производится пропорционально оставшемуся периоду в течение 10 банковских дней.',
              },
            ].map((faq) => (
              <div key={faq.q} className="border border-border rounded-lg p-5">
                <h3 className="font-semibold mb-2">{faq.q}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 px-4 bg-primary/5">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-2xl font-bold mb-4">Готовы попробовать?</h2>
          <p className="text-muted-foreground mb-8">14 дней бесплатно на тарифе PRO. Без привязки карты.</p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link to="/login">
              <Button size="lg" className="text-base px-8">
                Попробовать бесплатно
              </Button>
            </Link>
            <a href={TG_LINK} target="_blank" rel="noopener noreferrer">
              <Button size="lg" variant="outline" className="text-base px-8">
                <MessageSquare className="mr-2 size-4" />
                Написать в Telegram
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-4 border-t border-border">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <Link to="/" className="font-semibold text-foreground">
            Rest<span className="text-primary">OS</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link to="/oferta" className="hover:text-foreground transition-colors">Оферта</Link>
            <span>&copy; {new Date().getFullYear()} RestOS. Все права защищены.</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
