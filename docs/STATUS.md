# STATUS.md

## Checklist

- [x] Phase 0: Foundation (Foundation for Futures Screener)
- [x] Phase 1: MVP Hardening + Scoring
- [x] Phase 1: UI Implementation (desktop wide + mobile)
- [x] Phase 1: Bug Fixes (symbols, onlyMM, isMobile)
- [x] Phase 1: Advanced Features (natr, vol1/vol2/vol3)
- [x] Phase 1: Watchlist (⭐/☆ buttons, localStorage, tab switch)
- [x] Phase 1: UI Refresh (mobile variant A)
- [x] Phase 2: Production deployment (systemd service + HTTPS)
- [ ] Phase 2: UX and Extensions (presets, tabs, watchlist, alerts)
- [ ] Phase 3: Advanced features (sort by columns)

## Progress Log

- **2026-02-17** — Futures Screener перенесён из `_trash/`, запущен сервер (`node index.js`), порт 3200.
- **2026-02-17** — `mmSeedMultiplier` = 2.0 (default, был 0.5).
- **2026-02-17** — `detector.js` (stub, пока не используется).
- **2026-02-17** — удалены OpenClaw-агентские файлы, структурировано `docs/`.
- **2026-02-17** — добавлен scorинг: `score = log10(1 + notional) * exp(-d/0.45) * (isMM ? 1.8 : 1)`.
- **2026-02-17** — добавлена сортировка: `score desc, distancePct asc, notional desc`.
- **2026-02-17** — добавлен top-N: 20 на symbol.
- **2026-02-17** — добавлен cache: in-memory Map (3 sec TTL).
- **2026-02-17** — добавлен retry/backoff: 3 attempts, exponential delay.
- **2026-02-17** — добавлены UI error states и loading animation.
- **2026-02-17** — SSL certificate на `futures-screener.szhub.space` работает.
- **2026-02-17** — UI-SPEC.md заполнен под скрины (desktop wide + mobile).
- **2026-02-17** — Создана UI реализация (HTML/CSS/JS).
- **2026-02-17** — Backend запущен через systemd service (автостарт).
- **2026-02-17** — HTTPS активен на `https://futures-screener.szhub.space`.
- **2026-02-20** — Исправлен `ReferenceError` в `server/index.js` (переменная `symbols` не была объявлена через `let`).
- **2026-02-20** — Обновлен `docs/TASKS.md`, `docs/STATUS.md`, `MEMORY.md`.
- **2026-02-20** — Исправлен `state.onlyMM` в `app.js` — чекбокс Now влияет на запрос (`onlyMM` добавлен в API params).
- **2026-02-20** — Исправлен `isMobile = true` жёстко в `app.js` — UI теперь корректно переключается между mobile/desktop.
- **2026-02-20** — Добавлены поля `natr`, `vol1`, `vol2`, `vol3` в API через K-lines Binance (`/fapi/v1/klines`), реализована фильтрация по `natrFilter`.
- **2026-02-20** — Добавлен watchlist — кнопки ⭐/☆ для добавления/удаления символов, вкладка "Watchlist", localStorage сохранение.
- **2026-02-20** — Обновлён UI мобильной версии — карточки в стиле "вариант А", колонки: level, dist, notional, x, isMM.

## Todo (Phase 2)

- [ ] Вкладки в header — реальное переключение (отдельно для моб/деск)
- [ ] Алерты (Telegram) — отложено до полного функционала

## Todo (Phase 3)

- [ ] Продакшен-конфигурация nginx (gzip, кэширование)
- [ ] Мониторинг и логирование
