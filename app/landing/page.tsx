import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Toaster } from '@/components/ui/sonner'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import {
  ShoppingCart,
  ChefHat,
  Warehouse,
  Calculator,
  BarChart3,
  Settings,
  WifiOff,
  Printer,
  Radio,
  Smartphone,
  Building2,
  FileSpreadsheet,
  ArrowRight,
  Send,
  CheckCircle2,
  ClipboardList,
  Phone,
  MessageSquare,
  AlertTriangle,
  Clock,
  PackageX,
  ReceiptText,
  Users,
  X,
  Check,
  Star,
  Zap,
  Crown,
  Rocket,
} from 'lucide-react'

const problems = [
  { icon: PackageX, title: 'Списания и потери', desc: 'Продукты пропадают, а вы узнаёте об этом только при инвентаризации. Нет контроля — нет прибыли.' },
  { icon: ReceiptText, title: 'Учёт на бумаге', desc: 'Excel-таблицы, тетрадки, стикеры. Данные теряются, дублируются, никто не знает актуальных остатков.' },
  { icon: Clock, title: 'Долгое обслуживание', desc: 'Официант бегает между залом и кухней. Заказы путаются, гости ждут, средний чек падает.' },
  { icon: AlertTriangle, title: 'Непрозрачные финансы', desc: 'Выручка есть, а прибыли нет. Фудкост не считается, P&L собирается раз в квартал — если вообще собирается.' },
  { icon: Users, title: 'Хаос в сменах', desc: 'Кто работал, сколько часов, какие чаевые — всё держится в голове управляющего.' },
  { icon: WifiOff, title: 'Зависимость от интернета', desc: 'Пропал Wi-Fi — касса встала. Заказы не принимаются, кухня простаивает, гости уходят.' },
]

const modules = [
  {
    icon: ShoppingCart,
    title: 'POS и Заказы',
    desc: 'Прием заказов, интерактивная карта зала, управление столиками, быстрый расчет гостей. Поддержка нескольких типов оплаты.',
    features: ['Карта зала', 'Управление столиками', 'История заказов', 'Витрина блюд'],
  },
  {
    icon: ChefHat,
    title: 'Кухня',
    desc: 'Кухонный дисплей для поваров, батч-приготовление, автоматические уведомления о готовности блюд.',
    features: ['Кухонный дисплей', 'Батч-приготовление', 'Статусы готовности', 'Витрина'],
  },
  {
    icon: Warehouse,
    title: 'Склад',
    desc: 'Полный складской учет: инвентаризация, приходы, списания, техкарты, полуфабрикаты, работа с поставщиками.',
    features: ['Инвентаризация', 'Поставщики', 'Техкарты', 'Полуфабрикаты', 'Списания', 'Приходы'],
  },
  {
    icon: Calculator,
    title: 'Финансы',
    desc: 'P&L отчеты, баланс, cashflow, бюджетирование, расчет заработной платы, управление счетами.',
    features: ['P&L', 'Баланс', 'Cashflow', 'Бюджет', 'Расчет ЗП', 'Счета'],
  },
  {
    icon: BarChart3,
    title: 'Аналитика',
    desc: 'ABC-анализ меню и склада, фудкост, прогноз выручки, анализ пиковых часов, эффективность столов и официантов.',
    features: ['ABC-анализ', 'Фудкост', 'Прогноз', 'Пиковые часы', 'Анализ столов'],
  },
  {
    icon: Settings,
    title: 'Управление',
    desc: 'Управление сменами, пользователями, клиентской базой, аудит действий, печать чеков, импорт данных.',
    features: ['Смены', 'Пользователи', 'Клиенты', 'Аудит', 'Печать чеков', 'Импорт'],
  },
]

const advantages = [
  { icon: WifiOff, title: 'Работа офлайн', desc: 'Система работает без интернета. Данные синхронизируются автоматически при восстановлении связи.' },
  { icon: Printer, title: 'Печать чеков', desc: 'Интеграция с чековыми принтерами. Автоматическая печать при оформлении заказа.' },
  { icon: Radio, title: 'Realtime', desc: 'Мгновенные обновления на всех устройствах. Кухня видит заказ сразу после оформления.' },
  { icon: Smartphone, title: 'Мобильная версия', desc: 'Полноценная работа с планшета и телефона. Официанты принимают заказы на ходу.' },
  { icon: Building2, title: 'Мульти-ресторан', desc: 'Управляйте сетью ресторанов из единой панели администратора.' },
  { icon: FileSpreadsheet, title: 'Excel импорт/экспорт', desc: 'Загружайте меню, остатки и данные из Excel. Выгружайте отчеты в один клик.' },
]

const steps = [
  { num: '01', title: 'Оставьте заявку', desc: 'Заполните форму ниже — мы свяжемся в течение дня' },
  { num: '02', title: 'Получите демо', desc: 'Покажем систему на примере вашего ресторана' },
  { num: '03', title: 'Начните работать', desc: 'Подключение и настройка за 1 день' },
]

const pricingPlans = [
  {
    id: 'lite',
    name: 'Lite',
    price: 300,
    priceDaily: 10,
    icon: Zap,
    description: 'Для небольших точек и стрит-фуда',
    features: ['POS и Заказы', 'Офлайн-режим', 'Печать чеков', 'Базовый отчёт по выручке'],
    cta: 'Начать бесплатно',
    ctaVariant: 'outline' as const,
    style: '',
  },
  {
    id: 'start',
    name: 'Start',
    price: 700,
    priceDaily: 23,
    icon: Star,
    description: 'Для кафе и небольших ресторанов',
    features: ['Всё из Lite', 'Кухонный дисплей', 'Базовый склад', 'Мобильная версия', 'Клиентская база'],
    cta: 'Начать бесплатно',
    ctaVariant: 'outline' as const,
    style: '',
  },
  {
    id: 'pro',
    name: 'PRO',
    price: 1200,
    priceDaily: 40,
    icon: Rocket,
    popular: true,
    description: 'Для растущих ресторанов',
    features: ['Всё из Start', 'Техкарты и полуфабрикаты', 'Финансы (P&L, cashflow)', 'Аналитика и фудкост', 'Excel импорт/экспорт'],
    cta: 'Попробовать 14 дней бесплатно',
    ctaVariant: 'default' as const,
    style: 'border-primary shadow-lg shadow-primary/10 scale-[1.02]',
  },
  {
    id: 'max',
    name: 'MAX',
    price: 2500,
    priceDaily: 83,
    icon: Crown,
    description: 'Онлайн-продажи и масштаб',
    features: ['Всё из PRO', 'Онлайн-каталог', 'Приложение для клиентов', 'QR-меню и лояльность', 'API и интеграции', 'SLA 99.9%'],
    cta: 'Связаться с продажами',
    ctaVariant: 'outline' as const,
    style: '',
  },
]

const TG_DIRECT_LINK = 'https://t.me/muhammad_babolo'
const hasTelegramBot = !!(import.meta.env.VITE_TG_BOT_TOKEN && import.meta.env.VITE_TG_CHAT_ID)

export default function LandingPage() {
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', phone: '', restaurant: '', message: '' })
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem('restos-auth-user')
      if (stored) {
        const user = JSON.parse(stored)
        if (user?.id) navigate('/dashboard', { replace: true })
      }
    } catch {}
  }, [navigate])

  const scrollToForm = () => {
    document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.phone.trim()) {
      toast.error('Заполните имя и телефон')
      return
    }

    setSending(true)
    const text = [
      '🔔 Новая заявка RestOS',
      '',
      `👤 Имя: ${form.name}`,
      `📞 Телефон: ${form.phone}`,
      form.restaurant ? `🏪 Ресторан: ${form.restaurant}` : '',
      form.message ? `💬 Сообщение: ${form.message}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    try {
      const token = import.meta.env.VITE_TG_BOT_TOKEN
      const chatId = import.meta.env.VITE_TG_CHAT_ID

      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      })

      if (!res.ok) throw new Error('Ошибка отправки')

      setSent(true)
      toast.success('Заявка отправлена! Мы скоро свяжемся с вами.')
      setForm({ name: '', phone: '', restaurant: '', message: '' })
    } catch {
      toast.error('Не удалось отправить заявку. Попробуйте позже.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster />

      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <span className="text-lg font-bold tracking-tight">
            Rest<span className="text-primary">OS</span>
          </span>
          <div className="flex items-center gap-1 sm:gap-3">
            {[
              { label: 'Модули', target: 'modules' },
              { label: 'Преимущества', target: 'advantages' },
              { label: 'Тарифы', target: 'pricing' },
              { label: 'Контакты', target: 'contact' },
            ].map((link) => (
              <button
                key={link.target}
                onClick={() => document.getElementById(link.target)?.scrollIntoView({ behavior: 'smooth' })}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors hidden md:inline px-1.5"
              >
                {link.label}
              </button>
            ))}
            <a href="/login" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Войти
            </a>
            <Button size="sm" onClick={scrollToForm}>
              Получить демо
            </Button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-32 pb-20 px-4">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight leading-tight">
            Система управления{' '}
            <span className="text-primary">рестораном</span>{' '}
            нового поколения
          </h1>
          <p className="mt-6 text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Заказы, кухня, склад, финансы и аналитика — всё в одной системе.
            Работает офлайн, обновляется мгновенно.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
            <Button size="lg" onClick={scrollToForm} className="text-base px-8">
              Получить демо
              <ArrowRight className="ml-2 size-4" />
            </Button>
            <Button size="lg" variant="outline" onClick={() => document.getElementById('modules')?.scrollIntoView({ behavior: 'smooth' })} className="text-base px-8">
              Узнать больше
            </Button>
          </div>
        </div>
      </section>

      {/* Problems */}
      <section className="py-20 px-4 bg-muted/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">Знакомые проблемы?</h2>
            <p className="mt-4 text-muted-foreground text-lg">Большинство ресторанов сталкиваются с этим каждый день</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {problems.map((p) => (
              <div key={p.title} className="relative p-6 rounded-xl border border-destructive/20 bg-destructive/5">
                <div className="size-10 rounded-lg bg-destructive/10 flex items-center justify-center mb-4">
                  <p.icon className="size-5 text-destructive" />
                </div>
                <h3 className="font-semibold mb-2">{p.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{p.desc}</p>
              </div>
            ))}
          </div>
          <div className="text-center mt-12">
            <p className="text-lg font-medium mb-4">RestOS решает все эти проблемы</p>
            <Button variant="outline" onClick={() => document.getElementById('modules')?.scrollIntoView({ behavior: 'smooth' })}>
              Смотреть решения
              <ArrowRight className="ml-2 size-4" />
            </Button>
          </div>
        </div>
      </section>

      {/* Modules */}
      <section id="modules" className="py-20 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">Всё для вашего ресторана</h2>
            <p className="mt-4 text-muted-foreground text-lg">6 модулей, которые закрывают все потребности</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {modules.map((m) => (
              <Card key={m.title} className="border border-border bg-card hover:shadow-lg transition-shadow">
                <CardContent className="p-6">
                  <div className="size-12 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                    <m.icon className="size-6 text-primary" />
                  </div>
                  <h3 className="text-xl font-semibold mb-2">{m.title}</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed mb-4">{m.desc}</p>
                  <div className="flex flex-wrap gap-2">
                    {m.features.map((f) => (
                      <span key={f} className="text-xs px-2.5 py-1 rounded-full bg-secondary text-secondary-foreground">
                        {f}
                      </span>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Advantages */}
      <section id="advantages" className="py-20 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">Почему RestOS</h2>
            <p className="mt-4 text-muted-foreground text-lg">Технологии, которые делают работу проще</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-8">
            {advantages.map((a) => (
              <div key={a.title} className="flex gap-4">
                <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <a.icon className="size-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold mb-1">{a.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{a.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 px-4 bg-muted/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">Тарифы</h2>
            <p className="mt-4 text-muted-foreground text-lg">Выберите план, который подходит вашему бизнесу</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {pricingPlans.map((plan) => (
              <Card key={plan.id} className={`relative flex flex-col border-2 ${plan.style || 'border-border'}`}>
                {plan.popular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-xs font-semibold px-3 py-1 rounded-full">
                    Популярный
                  </span>
                )}
                <CardContent className="p-6 flex flex-col flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`size-9 rounded-lg flex items-center justify-center ${plan.popular ? 'bg-primary/10' : 'bg-muted'}`}>
                      <plan.icon className={`size-5 ${plan.popular ? 'text-primary' : 'text-muted-foreground'}`} />
                    </div>
                    <h3 className="text-xl font-bold">{plan.name}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">{plan.description}</p>

                  <div className="mb-4">
                    <div className="flex items-baseline gap-1">
                      <span className="text-3xl font-bold">{plan.price}</span>
                      <span className="text-muted-foreground text-sm">SMN/мес</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">от {plan.priceDaily} SMN / день</p>
                  </div>

                  <div className="space-y-2 mb-6 flex-1">
                    {plan.features.map((f) => (
                      <div key={f} className="flex items-center gap-2 text-sm">
                        <Check className="size-3.5 text-primary shrink-0" />
                        <span className="text-muted-foreground">{f}</span>
                      </div>
                    ))}
                  </div>

                  <Button
                    variant={plan.ctaVariant}
                    className="w-full text-xs h-auto py-2.5 whitespace-normal"
                    onClick={scrollToForm}
                  >
                    {plan.id === 'max' && <MessageSquare className="mr-1.5 size-3.5 shrink-0" />}
                    {plan.cta}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="text-center mt-10">
            <Link to="/pricing">
              <Button variant="outline">
                Подробное сравнение тарифов
                <ArrowRight className="ml-2 size-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-20 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">Как начать</h2>
          </div>
          <div className="grid sm:grid-cols-3 gap-8">
            {steps.map((s) => (
              <div key={s.num} className="text-center">
                <div className="text-5xl font-bold text-primary/20 mb-4">{s.num}</div>
                <h3 className="text-lg font-semibold mb-2">{s.title}</h3>
                <p className="text-sm text-muted-foreground">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Contact form */}
      <section id="contact" className="py-20 px-4">
        <div className="max-w-lg mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">Получить демо</h2>
            <p className="mt-4 text-muted-foreground">
              {hasTelegramBot
                ? 'Оставьте контакты — мы покажем систему и ответим на вопросы'
                : 'Напишите нам в Telegram — покажем систему и ответим на вопросы'}
            </p>
          </div>

          {!hasTelegramBot ? (
            <div className="text-center py-12">
              <Send className="size-16 text-primary mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">Свяжитесь с нами</h3>
              <p className="text-muted-foreground mb-6">Мы ответим в течение нескольких часов</p>
              <a href={TG_DIRECT_LINK} target="_blank" rel="noopener noreferrer">
                <Button size="lg" className="text-base px-8">
                  <MessageSquare className="mr-2 size-4" />
                  Написать в Telegram
                </Button>
              </a>
            </div>
          ) : sent ? (
            <div className="text-center py-12">
              <CheckCircle2 className="size-16 text-primary mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">Заявка отправлена!</h3>
              <p className="text-muted-foreground">Мы свяжемся с вами в ближайшее время</p>
              <Button variant="outline" className="mt-6" onClick={() => setSent(false)}>
                Отправить ещё
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1.5 block">
                  Имя <span className="text-destructive">*</span>
                </label>
                <Input
                  placeholder="Как вас зовут"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">
                  Телефон <span className="text-destructive">*</span>
                </label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <Input
                    placeholder="+7 (___) ___-__-__"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/[^\d+\-\s()]/g, '') })}
                    inputMode="tel"
                    className="pl-10"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">Название ресторана</label>
                <div className="relative">
                  <ClipboardList className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <Input
                    placeholder="Ваше заведение"
                    value={form.restaurant}
                    onChange={(e) => setForm({ ...form, restaurant: e.target.value })}
                    className="pl-10"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">Сообщение</label>
                <div className="relative">
                  <MessageSquare className="absolute left-3 top-3 size-4 text-muted-foreground" />
                  <Textarea
                    placeholder="Расскажите о вашем заведении или задайте вопрос"
                    value={form.message}
                    onChange={(e) => setForm({ ...form, message: e.target.value })}
                    className="pl-10 min-h-[100px]"
                  />
                </div>
              </div>
              <Button type="submit" className="w-full" size="lg" disabled={sending}>
                {sending ? (
                  <div className="size-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                ) : (
                  <>
                    <Send className="mr-2 size-4" />
                    Отправить заявку
                  </>
                )}
              </Button>
            </form>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-4 border-t border-border">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">
            Rest<span className="text-primary">OS</span>
          </span>
          <div className="flex items-center gap-4">
            <Link to="/pricing" className="hover:text-foreground transition-colors">Тарифы</Link>
            <Link to="/oferta" className="hover:text-foreground transition-colors">Оферта</Link>
            <span>&copy; {new Date().getFullYear()} RestOS. Все права защищены.</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
