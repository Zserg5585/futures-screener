# STATUS.md

## Checklist

- [x] Phase 0: Foundation (Foundation for Futures Screener)
- [x] Phase 1: MVP Hardening + Scoring
- [ ] Phase 2: UX and Extensions
- [ ] Phase 3: Production deployment

## Progress Log

- **2026-02-17** — Futures Screener перенесён из `_trash/`, запущен сервер (`node index.js`), порт 3200.
- **2026-02-17** — добавлен `mmSeedMultiplier` в `server/index.js` (default `2.0`, был `0.5`).
- **2026-02-17** — добавлен `detector.js` (stub, пока не используется).
- **2026-02-17** — удалены OpenClaw-агентские файлы, структурировано `docs/`.
- **2026-02-17** — обновлены README, VISION, ROADMAP, UI-SPEC, MEMORY.md.
- **2026-02-17** — добавлен scorинг: `score = log10(1 + notional) * exp(-d/0.45) * (isMM ? 1.8 : 1)`.
- **2026-02-17** — добавлена сортировка по `score desc, distancePct asc, notional desc`.
- **2026-02-17** — добавлен top-N (20 на symbol).
- **2026-02-17** — добавлен in-memory cache (3 sec TTL).
- **2026-02-17** — добавлен retry/backoff (3 attempts, exponential delay).
- **2026-02-17** — добавлены UI error states и loading animation.
- **2026-02-17** — SSL certificate на `futures-screener.szhub.space` работает.
- **2026-02-17** — UI-SPEC.md заполнен под скрины (desktop wide + mobile).
- **2026-02-17** — Created systemd service template (`futures-screener.service`).

## Todo (Phase 2)

- [ ] Верстка UI под скрины (desktop wide + mobile)
- [ ] Пресеты: `scalp tight (0.3–0.6%)`, `swing (1–2%)`
- [ ] Вкладки: Top Densities / By Symbol / Watchlist
- [ ] Watchlist (localStorage)
- [ ] Алерты (Telegram)

## Todo (Phase 3)

- [ ] Systemd service для backend (автостарт)
- [ ] Продакшен-конфигурация nginx (gzip, кэширование)
- [ ] Мониторинг и логирование