# MEMORY.md — Долговременная память Futures Screener

## Зачем

Сохранять значимые решения, контекст и выводы между сессиями.
Каждую сессию я просыпаюсь с нуля — этот файл и `docs/` помогают вспомнить.

## Структура

- `MEMORY.md` — консолидированные выводы и ключевые факты
- `docs/` — документация (VISION.md, ROADMAP.md, STATUS.md, UI-SPEC.md)

## Правила

- Факты, даты, ссылки на файлы — без воды.
- Не размещать приватные данные без явного запроса.
- Обновлять по мере изменений; удалять устаревшее.
- Завершённые решения помечать ✅.

## Ключевые факты

- **2026-02-17** — Futures Screener перенесён из `_trash/`. Запущен сервер (`node index.js`), порт 3200.
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
- **2026-02-17** — Created systemd service template (`futures-screener.service`).
- **2026-02-17** — `futures-screener.szhub.space` доступен по HTTPS.

## Текущее состояние

- **Статус:** Phase 0 завершён, Phase 1 завершён.
- **Ключевые файлы:**
  - `server/index.js` — API endpoint `/densities/simple`
  - `app/app.js` — UI с автообновлением
  - `app/index.html` — HTML структура
  - `app/styles.css` — CSS стили
- **Проблемы:**
  - UI ещё не сверстан под новые скрины
  - Backend запущен через `nohup` (не systemd service)
- **Планы:**
  - Phase 2 — UX и расширение (верстка UI + пресеты + вкладки)
  - Phase 3 — Production deployment (systemd + nginx config)
