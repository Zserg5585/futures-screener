# UI-SPEC.md — Futures Screener MVP

Эта спецификация описывает интерфейс MVP — простой таблицы плотностей с автообновлением.

## Scope

- Фокус: Tab 1 — Densities.
- Мобильная адаптация: минимальная (вертикальная прокрутка).
- Платформа: десктоп (широкий экран), в будущем — адаптивная верстка.

## Desktop Wide (ключевые блоки)

- **Заголовок:** "Futures Screener" + 3 вкладки (Densities, Mini-Charts, Signals).
- **Панель фильтров:**
  - `minNotional` (по умолчанию 50000)
  - `windowPct` (по умолчанию 1.0)
  - `depthLimit` (по умолчанию 100)
  - `symbols` (список через запятую)
  - `concurrency` (по умолчанию 6)
  - кнопка `Refresh`
  - чекбокс `Auto` + интервал (5s/10s/20s)
- **Таблица плотностей:**
  - Колонки:
    - Symbol
    - BID level, BID distance %, BID notional
    - ASK level, ASK distance %, ASK notional
    - Флаг isMM (зелёный/серый фон)
  - Сортировка: по `distancePct`, `notional` (без scorинга).
  - Автообновление каждые N секунд.
- **Статус:** "Loading...", "OK (X symbols)", "Error".

## Поведение UI

- **Refresh:** один клик → перезагрузить данные.
- **Auto:** включить → автообновление каждые N секунд (остановить по выключению чекбокса).
- **Фильтры:** применяются сразу при изменении.
- **Кэш:** локальный (в памяти браузера, 30 сек), чтобы не трогать API при быстрых переключениях фильтров.

## Data (от `/densities/simple`)

Поле | Тип | Описание
-----|-----|----------
`symbol` | string | Например, BTCUSDT
`side` | string | bid / ask
`markPrice` | number | Цена из /fapi/v1/premiumIndex
`levelPrice` | number | Цена уровня в стакане
`distancePct` | number | Расстояние до markPrice в %
`notional` | number | notional = price * qty
`isMM` | boolean | Флаг MM (высокий notional)

## Future tabs (Phase 1+)

- **Top Densities** — глобальный топ по `score`.
- **By Symbol** — детально по одному символу.
- **Watchlist** — символы из localStorage.

## Accessibility

- Клавиатурная навигация по таблице.
- Focus states на строках.
