# STATUS.md

## Checklist

- [x] Phase 0: Foundation (Foundation for Futures Screener)
- [x] Phase 1: MVP Hardening + Scoring
- [x] Phase 1: UI Implementation (desktop wide + mobile)
- [x] Phase 2: Production deployment (systemd service + HTTPS)
- [ ] Phase 2: UX and Extensions
- [ ] Phase 3: Advanced features (presets, tabs, alerts)

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

## Todo (Phase 2)

- [ ] Пресеты: `scalp tight (0.3–0.6%)`, `swing (1–2%)`
- [ ] Вкладки: Top Densities / By Symbol / Watchlist
- [ ] Watchlist (сохранение в localStorage)
- [ ] Алерты (Telegram)
- [ ] Сортировка по колонкам (стрелки ▲/▼)

## Todo (Phase 3)

- [ ] Продакшен-конфигурация nginx (gzip, кэширование)
- [ ] Мониторинг и логирование
