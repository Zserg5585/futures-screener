# UI-SPEC.md — Futures Screener MVP

Эта спецификация описывает интерфейс MVP — таблицы плотностей с автообновлением, фильтрацией и MM-подсветкой.

## Scope

- **Фокус:** Tab 1 — Densities (только MVP, без мини-графиков/сигналов)
- **Платформа:** Desktop wide (1000px+), Mobile (320px–768px)
- **Тема:** Dark theme (фирменная)

---

## Desktop Wide (1000px+)

### Global chrome
- **Header:**
  - Заголовок "Futures Screener"
  - 3 вкладки: `Densities` (active), `Mini-Charts`, `Signals`
  - Статус загрузки (Idle/Loading/Error)
- **Боковая панель слева (280px фиксированная ширина):**
  - `minNotional` (number, default 50000)
  - `windowPct` (number, default 1.0)
  - `depthLimit` (number, default 100)
  - `symbols` (comma-separated, placeholder: `BTCUSDT,ETHUSDT`)
  - `concurrency` (number, default 6)
  - Checkbox `Auto` + `Interval` (5s/10s/20s)
  - Кнопка `Refresh` (зелёная)
- **Main content (занимает всё остальное пространство):**
  - Таблица плотностей (с горизонтальной прокруткой при необходимости)
  - Статус: "Idle", "Loading", "OK (X rows)", "Error"
  - Timestamp "Last updated: HH:MM"

### Таблица
**Колонки (7 шт):**
1. **Symbol** — имя тикера (жирный, `.sym`)
2. **BID level** — цена уровня (2 знака после запятой)
3. **BID dist %** — расстояние до markPrice в % (2 знака + `%`)
4. **BID notional** — notional = price * qty (с разделителями, compact)
5. **ASK level**
6. **ASK dist %**
7. **ASK notional**

**Поведение:**
- Сортировка по клику на заголовки (стрелки ▲/▼ — пока не реализовано)
- Hover-эффекты на строках
- Зелёный фон (`isMM` класс) для строк с `isMM=true`
- Кнопка Refresh в sidebar (или в header на mobile)

### Состояния UI

**Idle:**
- Статус: "Idle" (серый фон)
- Таблица отображается

**Loading:**
- Статус: "Loading..." (анимация точек)
- Затемнённый фон таблицы (опционально)

**Success:**
- Статус: "OK (X rows)"
- Timestamp "Last updated: HH:MM"

**Error:**
- Красный фон блока ошибки
- Текст ошибки (для отладки)
- Кнопка "Retry"

---

## Mobile (320px–768px)

### Global chrome
- **Header:**
  - Заголовок "Futures Screener"
  - 3 вкладки (Densities, Mini-Charts, Signals)
  - Кнопка `Filter` (шестерёнка или "Filter")
- **Боковая панель скрыта**
- **Фильтры в modal (выпадает по кнопке Filter):**
  - `minNotional`, `windowPct`, `depthLimit`, `symbols`, `concurrency`
  - Кнопки: `Clear`, `Apply`
- **Main:**
  - Таблица с вертикальной прокруткой
  - Кнопка `Refresh` в header (если нет auto-refresh)
  - Timestamp и статус в footer

### Таблица
- Компактные колонки: `Symbol | BID level | ASK level | isMM`
- or: `Symbol + BID in row`, `ASK` — отдельная строка под BID
- Вертикальная прокрутка (основная)
- Горизонтальной прокрутки быть не должно

### Мобильные правила
- `sidebar`display: none`
- `btn-filters` — показывается только на mobile
- `modal` — показывается по кнопке Filter
- Шрифты: `11px` для таблицы

---

## Анимации и статусы

### Loading
- Текст "Loading..." с анимацией точек (..)
- Спиннер (круглый loader) — опционально

### Error
- Красный фон блока ошибки
- Текст ошибки (для отладки)
- Кнопка "Retry" (в modal или в header)

### Success
- Текст "OK (X rows)" в статус-панели
- Timestamp "Last updated: HH:MM"

---

## Mock data format (для UI)

```json
{
  "count": 16,
  "minNotional": 50000,
  "windowPct": 1.0,
  "data": [
    {
      "symbol": "BTCUSDT",
      "side": "bid",
      "levelPrice": 67225.1,
      "distancePct": 0.02,
      "notional": 81492,
      "isMM": false
    },
    {
      "symbol": "BTCUSDT",
      "side": "ask",
      "levelPrice": 67230.5,
      "distancePct": 0.05,
      "notional": 102166,
      "isMM": true
    }
  ]
}
```

---

## План реализации (Phase 0 → Phase 1)

### Phase 0 — MVP (точно сверстать)
- [x] Desktop wide: боковая панель + таблица
- [x] Mobile: фильтры в modal + таблица
- [x] Auto-refresh: checkbox + интервал (5s/10s/20s)
- [x] Loading/error states
- [x] isMM подсветка
- [x] Systemd service (автостарт)

### Phase 1 — Доработки
- [ ] Сортировка по колонкам (стрелки ▲/▼)
- [ ] Top-N (20 на символ) — частично реализовано
- [ ] Пресеты: `scalp tight`, `swing`
- [ ] Вкладки: Top Densities / By Symbol / Watchlist

### Phase 2 — UX
- [ ] Watchlist (сохранение в localStorage)
- [ ] Алерты (Telegram)
- [ ] Мобильная версия — доработать

---

## CSS классы

| Класс | Назначение |
|-------|-----------|
| `.sidebar` | Боковая панель (desktop) |
| `.main` | Основной контейнер |
| `.table` | Таблица плотностей |
| `.sym` | Жирный текст символа |
| `.isMM` | Зелёный фон для MM-уровней |
| `.error` | Блок ошибки |
| `.modal` | Модальное окно фильтров |
| `.btn-primary` | Основные кнопки |
| `.btn-secondary` | Вспомогательные кнопки |

---

## Текущий статус

✅ UI реализован под твои скрины (desktop wide + mobile)
✅ Backend работает через systemd
✅ HTTPS активен на `futures-screener.szhub.space`

Следующие шаги: пресеты и вкладки (Phase 1).
