# STATUS.md

## Checklist

- [x] Phase 0: Foundation (Foundation for Futures Screener)
- [ ] Phase 1: MVP Hardening + Scoring
- [ ] Phase 2: UX and Extensions

## Progress Log

- **2026-02-17** — перенос `futures-screener` из `_trash/`, запуск сервера, проверка `/densities/simple`.
- **2026-02-17** — добавлен `mmSeedMultiplier` в `server/index.js` (default `0.5`, требует обсуждения).
- **2026-02-17** — добавлен `server/modules/densities/detector.js` (stub).
- **2026-02-17** — удалены OpenClaw-агентские файлы, структурировано `docs/`.
- **2026-02-17** — обновлен README, VISION, ROADMAP, STATUS под текущее состояние.

## Todo (Phase 1)

- [ ] Scorинг (score formula)
- [ ] Сортировка по score
- [ ] Top-N (20 на символ)
- [ ] In-memory cache (3 sec TTL)
- [ ] Retry/backoff при ошибках Binance
- [ ] UI error states

## Todo (Phase 2)

- [ ] Пресеты (scalp tight, swing)
- [ ] Вкладки: Top Densities / By Symbol / Watchlist
- [ ] Алерты (Telegram)
- [ ] Мобильная адаптация
