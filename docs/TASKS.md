# Tasks — Futures Screener MVP

## Pending

- [x] Добавить `windowPct = 5.0` (по умолчанию)
- [x] Blacklist монет: BTC, ETH, SOL, XRP, DOGE, ADA, REPE
- [x] Колонка `Natr%` (фильтр + отображение)
- [x] Колонки `Объём 1×5m`, `Объём 2×5m`, `Объём 3×5m` (по отдельности)

## Done

- [x] `xFilter` (x2, x4, x6, x10+)
- [x] `mmBase`, `x` в API
- [x] Сортировка по `score`
- [x] UI: sidebar (desktop) + modal (mobile)
- [x] Исправлен `ReferenceError` в `server/index.js` (переменная `symbols` не была объявлена через `let`)
- [x] Исправлен `state.onlyMM` в `app.js` — чекбокс Now влияет на запрос (`onlyMM` добавлен в API params)
- [x] Исправлен `isMobile = true` жёстко в `app.js` — UI теперь корректно переключается между mobile/desktop
- [x] Добавлены поля `natr`, `vol1`, `vol2`, `vol3` в API через K-lines Binance (`/fapi/v1/klines`)
- [x] Watchlist — добавлены кнопки ⭐/☆, вкладка "Watchlist", localStorage сохранение
- [x] UI mobile (вариант А) — карточки с level, dist, notional, x, isMM

## Status

- Backend: `server/index.js`
- UI: `app/index.html`, `app/app.js`
- Docs: `docs/VISION.md`, `docs/UI-SPEC.md`

## Current Priorities (Phase 2)

1. **Добавить поля `natr`, `vol1`, `vol2`, `vol3` в API** — ✅ завершено
2. **Watchlist** — ✅ завершено
3. **Вкладки в header** — Top Densities / By Symbol / Watchlist (отдельно для моб/деск) — пропущено
4. **Алерты (Telegram)** — отложено до полного функционала
