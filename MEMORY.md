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
- **2026-02-20** — Исправлен `ReferenceError` в `server/index.js` (переменная `symbols` не была объявлена через `let`).
- **2026-02-20** — Исправлен `state.onlyMM` в `app.js` — чекбокс `Only MM` теперь влияет на запрос (`mmMode` добавлен в API params).
- **2026-02-20** — Исправлен `isMobile = true` жёстко в `app.js` — UI теперь корректно переключается между mobile/desktop.
- **2026-02-20** — Добавлены поля `natr`, `vol1`, `vol2`, `vol3` в API через K-lines Binance (`/fapi/v1/klines`), реализована фильтрация по `natrFilter`.
- **2026-02-20** — Добавлен watchlist (localStorage) — кнопки ⭐/☆ для добавления/удаления символов, вкладка "Watchlist".
- **2026-02-20** — Обновлён UI мобильной версии — карточки в стиле "вариант А", колонки: level, dist, notional, x, isMM.
- **2026-02-20** — Исправлен порядок `vol1/2/3` (теперь соответствует времени: vol1=newest, vol2=prev, vol3=oldest).
- **2026-02-20** — Обновлён `CRITICAL_ISSUES.md` — добавлены исправления и новые скиллы.
- **2026-02-20** — Создан `README.md` — полная документация проекта.
- **2026-02-20** — Установлены 26 скиллов для futures-screener: Binance, technical-analyst, tailwindcss, nextjs-expert, react-expert, test-runner, shadcn-ui, nginx, docker, pm2, monitoring, alerts, code-review, cron-scheduling, redis-store, websocket, crypto-market-data и др.
- **2026-02-20** — OpenClaw memory setup: добавлен `memorySearch` в конфиг, создана структура `memory/logs/`, `memory/projects/`, `memory/groups/`, `memory/system/`.
- **2026-02-20** — OpenClaw backup: создан `~/openclaw-backups/openclaw-2026-02-20.tar.gz` (9.4 MB), скрипт `~/.openclaw/backup.sh`.
- **2026-02-20** — Git commit и push: `refactor: fix vol1/2/3 order, add GitHub skill, update docs` (commit c62f8ac).

## Текущее состояние

- **Статус:** Phase 0 завершён, Phase 1 завершён, Phase 2 — в работе.
- **Ключевые файлы:**
  - `server/index.js` — API endpoint `/densities/simple` (исправлен vol1/2/3)
  - `app/app.js` — UI с автообновлением
  - `app/index.html` — HTML структура
  - `app/styles.css` — CSS стили
  - `README.md` — полная документация
  - `CRITICAL_ISSUES.md` — исправленные ошибки
- **Проблемы:**
  - UI ещё не сверстан под новые скрины (Phase 2)
  - Backend запущен через `nohup` (не systemd service)
- **Планы:**
  - Phase 2 — UX и расширение (верстка UI + пресеты + вкладки)
  - Phase 3 — Production deployment (systemd + nginx config)
  - Веб-поиск — нужен API ключ (SerpAPI или Brave)
