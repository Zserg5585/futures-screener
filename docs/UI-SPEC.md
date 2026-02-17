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
- **Боковая панель слева (25% ширины):**
  - `minNotional` (number, default 50000)
  - `windowPct` (number, default 1.0)
  - `depthLimit` (number, default 100)
  - `symbols` (comma-separated, placeholder: `BTCUSDT,ETHUSDT`)
  - `concurrency` (number, default 6)
  - Checkbox `Auto` + `Interval` (5s/10s/20s)
  - Кнопка `Refresh`
- **Main content (75% ширины):**
  - Таблица плотностей (с горизонтальной прокруткой, если ширина < 1200px)
  - Статус: "Loading..." / "OK (X symbols)" / "Error"
  - Last updated timestamp

### Таблица
**Колонки (8 шт):**
1. **Symbol** — имя тикера (жирный)
2. **BID level** — цена уровня
3. **BID dist %** — расстояние до markPrice в %
4. **BID notional** — notional = price * qty
5. **ASK level**
6. **ASK dist %**
7. **ASK notional**
8. **isMM** — флаг MM (зелёный фон, если `true`)

**Поведение:**
- Горизонтальная прокрутка (если ширина таблицы > контейнера)
- Сортировка по клику на заголовки (стрелки: ▲/▼)
- Hover-эффекты на строках
- Loading spinner при загрузке

**Формат ячеек:**
- `level`: 8 знаков после запятой (например, `67225.10000000`)
- `dist %`: 2 знака + `%` (например, `0.02%`)
- `notional`: с разделителями (например, `1,234,567`)
- `isMM`: зелёный фон для `true`, серый для `false`

### Desktop (768px–999px)
- Боковая панель сворачивается в drawer (кнопка меню в header)
- Таблица адаптируется: уменьшается padding, шрифт 13px

---

## Mobile (320px–768px)

### Global chrome
- **Header:**
  - Заголовок "Futures Screener"
  - Иконка меню (☰) для вызова фильтров
  - Кнопка `Refresh` (слева от заголовка)
  - Аватар пользователя (если есть)
- **Фильтры (modal/drawer):**
  - `minNotional`, `windowPct`, `depthLimit`, `symbols`, `concurrency`
  - Checkbox `Auto` + `Interval`
  - Кнопки: `Apply`, `Clear`, `Close`

### Таблица
**Вариант A (вертикальная прокрутка):**
- Строки с вертикальной прокруткой
- Каждая строка: `Symbol | BID | ASK` (в одной колонке)
- BID/ASK данные на вкладках внутри строки (tap для переключения)
- или: `Symbol + BID in row`, `ASK` — отдельная строка под BID

**Вариант B (горизонтальная прокрутка):**
- Компактные колонки: `Symbol | BID level | ASK level | isMM`
- Детали (dist, notional) — по tap (modal с подробной информацией)
- less readable, но экономит место

### Поведение
- Вертикальная прокрутка (основная)
- Горизонтальной прокрутки быть не должно (контейнер фиксированной ширины)
- Loading spinner в шапке при загрузке
- Swipe для переключения между BID/ASK (если вариант A с вкладками)

**Формат ячеек:**
- `Symbol`: 12px, жирный
- `BID/ASK level`: 11px
- `dist %`: 10px (например, `0.02%`)
- `notional`: 10px (сокращённый формат: `1.2M`, `500K`)
- `isMM`: зелёный фон, маленький значок (✅)

---

## Анимации и статусы

### Loading
- Spinner (крутящееся колесо) в header
- Текст "Loading..." в статус-панели
- Затемнённый фон таблицы

### Error
- Красный фон блока ошибки
- Текст ошибки (для отладки)
- Кнопка "Retry"

### Success
- Текст "OK (X symbols)" в статус-панели
- Timestamp "Last updated: 14:30"

---

## Mock data format (для UI)

```json
{
  "count": 16,
  "minNotional": 50000,
  "data": [
    {
      "symbol": "BTCUSDT",
      "bid": { "level": 67225.1, "distPct": 0.02, "notional": 81492 },
      "ask": { "level": 67230.5, "distPct": 0.05, "notional": 102166 },
      "isMM": false
    }
  ]
}
```

---

## План реализации (Phase 0 → Phase 1)

### Phase 0 — MVP (точно сверстать)
- [ ] Desktop wide: боковая панель + таблица
- [ ] Mobile: фильтры в modal + таблица
- [ ] Auto-refresh: checkbox + интервал (5s/10s/20s)
- [ ] Loading/error states
- [ ] isMM подсветка

### Phase 1 — Доработки
- [ ] Сортировка по колонкам
- [ ] Топ-N (20 на символ)
- [ ] Пресеты: `scalp tight`, `swing`
- [ ] Вкладки: Top Densities / By Symbol / Watchlist
