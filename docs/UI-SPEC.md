# UI-SPEC.md — Futures Screener MVP

Эта спецификация описывает интерфейс MVP — таблицы плотностей для стратегии "отскок от плотностей".

## Scope

- **Фокус:** Tab 1 — Densities (только MVP, без мини-графиков/сигналов)
- **Платформа:** Desktop wide (1000px+), Mobile (320px–768px)
- **Тема:** Dark theme (фирменная)
- **Цель:** Отскок от плотностей (поддержка/сопротивление)

---

## Desktop Wide (1000px+)

### Global chrome
- **Header:**
  - Заголовок "Futures Screener"
  - 3 вкладки: `Densities` (active), `Mini-Charts`, `Signals`
  - Статус загрузки (Idle/Loading/Error)
- **Боковая панель слева (280px фиксированная ширина):**
  - Preset dropdown: Scalp Tight (0.5%), Scalp Wide (1.0%), Swing (2.0%), Custom
  - `minNotional` (number, default 50000)
  - `windowPct` (number, default 1.0)
  - `depthLimit` (number, default 100)
  - `symbols` (comma-separated, placeholder: `BTCUSDT,ETHUSDT`)
  - `concurrency` (number, default 6)
  - **x Filter** dropdown: x2, x4, x6, x10+
  - Checkbox `Auto` + `Interval` (5s/10s/20s)
  - Кнопка `Refresh` (зелёная)
- **Main content (занимает всё остальное пространство):**
  - Таблица плотностей (с горизонтальной прокруткой при необходимости)
  - Статус: "Idle", "Loading", "OK (X rows)", "Error"
  - Timestamp "Last updated: HH:MM"

### Таблица
**Колонки (14 шт):**
1. **Symbol** — имя тикера (жирный, `.sym`)
2. **BID level** — цена уровня (2 знака после запятой)
3. **BID dist %** — расстояние до markPrice в % (2 знака + `%`)
4. **BID notional** — notional = price * qty (с разделителями, compact)
5. **BID x** — **x = notional / mmBase** (во сколько раз больше маркет-мейкера)
6. **NATR %** — Normalized Average True Range % (фильтр)
7. **Vol 1×5m** — объём за 1-ю (самую старую) 5-минутку
8. **Vol 2×5m** — объём за 2-ю 5-минутку
9. **Vol 3×5m** — объём за 3-ю (самую новую) 5-минутку
10. **ASK level**
11. **ASK dist %**
12. **ASK notional**
13. **ASK x**
14. **Score** — общий score уровня (цветная индикация)
15. **isMM** — флаг Market Maker (зелёный фон или ⭐)

**Логика `x`:**
```
x = notional / mmBase

Пример:
- mmBase = 100k
- notional = 400k
- x = 4 (х4 от маркет-мейкера)
```

**Поведение:**
- Сортировка по клику на заголовки (стрелки ▲/▼ — пока не реализовано)
- Hover-эффекты на строках
- Зелёный фон (`isMM` класс) для строк с `isMM=true`
- Кнопка Refresh в sidebar (или в header на mobile)
- **Фильтр x:** показывать только уровни > выбранного x

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
  - Preset dropdown
  - `minNotional`, `windowPct`, `depthLimit`, `symbols`, `concurrency`
  - **x Filter** dropdown: x2, x4, x6, x10+
  - Кнопки: `Clear`, `Apply`
- **Main:**
  - Таблица с вертикальной прокруткой
  - Кнопка `Refresh` в header (если нет auto-refresh)
  - Timestamp и статус в footer

### Таблица
- Компактные колонки: `Symbol | BID level | BID dist | BID notional | BID x | ASK x | Score`
- `isMM` — зелёный фон или звёздочка ⭐
- `x` — во сколько раз больше маркет-мейкера
- Вертикальная прокрутка (основная)
- Горизонтальной прокрутки быть не должно

### Мобильные правила
- `sidebar` — `display: none`
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
  "xFilter": 4, // фильтр: показывать только x >= 4
  "data": [
    {
      "symbol": "BTCUSDT",
      "side": "bid",
      "levelPrice": 67225.1,
      "distancePct": 0.02,
      "notional": 81492,
      "mmBase": 200000,
      "x": 0.407, // 81492 / 200000
      "isMM": false,
      "score": 4.85
    },
    {
      "symbol": "BTCUSDT",
      "side": "bid",
      "levelPrice": 67200.5,
      "distancePct": 0.03,
      "notional": 800000,
      "mmBase": 200000,
      "x": 4.0, // 800000 / 200000
      "isMM": true,
      "score": 6.21
    },
    {
      "symbol": "BTCUSDT",
      "side": "ask",
      "levelPrice": 67230.5,
      "distancePct": 0.05,
      "notional": 102166,
      "mmBase": 200000,
      "x": 0.51,
      "isMM": false,
      "score": 5.32
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
- [x] Сортировка по колонкам (стрелки ▲/▼) — частично
- [x] Top-N (20 на symbol) — частично
- [x] Пресеты: `scalp tight`, `swing`
- [x] Метрики: `eatSpeed`, `lifetimeSec`, `state`
- [ ] Фильтр по `x` (x2, x4, x6, x10+)
- [ ] Фильтр по score (минимальный порог)
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
| `.x-high` | Золотистый/жёлтый фон для высокого x (опционально) |
| `.eatSpeed-high` | Красный фон для высокой eatSpeed (опционально) |
| `.error` | Блок ошибки |
| `.modal` | Модальное окно фильтров |
| `.btn-primary` | Основные кнопки |
| `.btn-secondary` | Вспомогательные кнопки |

---

## Текущий статус

✅ UI реализован под твои скрины (desktop wide + mobile)  
✅ Backend работает через systemd  
✅ HTTPS активен на `futures-screener.szhub.space`  
✅ Метрики `eatSpeed`, `lifetimeSec`, `state` добавлены в API  
✅ `x = notional / mmBase` — нужно добавить в API и UI

**Следующий шаг:** Добавить фильтр по `x` в UI и API.
