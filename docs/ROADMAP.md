# ROADMAP — Futures Screener

---

## Phase 0 · MVP (ТЕКУЩИЙ СТАТУС) — завершён

**Цель:** Базовый инструмент скрининга плотностей.

**Шаги:**

| #   | Задача                                                        | Статус |
|-----|---------------------------------------------------------------|--------|
| 0.1 | Базовая инфраструктура сервера (Fastify, Binance API)        | ✅     |
| 0.2 | Endpoint `/densities/simple`                                 | ✅     |
| 0.3 | MM-логика (mmSeedMultiplier, mmBase, isMM)                   | ✅     |
| 0.4 | Scoring: log10(1 + notional) * exp(-d/decay) * boost         | ✅     |
| 0.5 | Сортировка по score desc, distancePct asc, notional desc     | ✅     |
| 0.6 | In-memory cache (3 sec TTL)                                  | ✅     |
| 0.7 | Retry/backoff (3 attempts, exponential delay)                | ✅     |
| 0.8 | Минимальный UI (таблица + автообновление)                    | ⏳      |
| 0.9 | Документация: README, VISION, ROADMAP, UI-SPEC               | ✅     |
| 0.10| SSL certificate на futures-screener.szhub.space              | ✅     |

**Результат:** Рабочий скринер с API, scoring, cache и базовым UI.

---

## Phase 1 · Hardening + Scoring (ЗАВЕРШЁН)

**Цель:** Стабильность, scorинг, сортировка, кэш.

**Шаги:**

| #   | Задача                                                        | Статус |
|-----|---------------------------------------------------------------|--------|
| 1.1 | Scoring (formula: `score = log10(1 + notional) * exp(-d/dp) * boost`) | ✅     |
| 1.2 | Сортировка по `score desc, distancePct asc, notional desc`   | ✅     |
| 1.3 | Top-N (например, top 20 на символ)                            | ✅     |
| 1.4 | In-memory cache (Map, ~3 сек TTL)                            | ✅     |
| 1.5 | Retry/backoff при сбоях Binance                              | ✅     |
| 1.6 | UI error states (красный фон + сообщение)                    | ✅     |
| 1.7 | UI loading animation (dots)                                   | ✅     |
| 1.8 | Пресеты (scalp tight, swing)                                 | ⏳     |

---

## Phase 2 · UX and Extensions

**Цель:** Удобные вкладки, watchlist, алерты.

**Шаги:**

| #   | Задача                                                        | Статус |
|-----|---------------------------------------------------------------|--------|
| 2.1 | Верстка UI под скрины (desktop wide + mobile)                | ⏳     |
| 2.2 | Вкладки: Top Densities / By Symbol / Watchlist               | ⏳     |
| 2.3 | Пресеты: scalp tight (0.3–0.6%), swing (1–2%)                | ⏳     |
| 2.4 | Watchlist (сохранение в localStorage)                         | ⏳     |
| 2.5 | Алерты: уведомление при приближении цены к уровню (Telegram) | ⏳     |

---

## Phase 3 · Production deployment

**Цель:** Стабильный production-релиз.

**Шаги:**

| #   | Задача                                                        | Статус |
|-----|---------------------------------------------------------------|--------|
| 3.1 | Systemd service для backend (автостарт)                      | ⏳     |
| 3.2 | Продакшен-конфигурация nginx (gzip, кэширование)             | ⏳     |
| 3.3 | Мониторинг и логирование                                      | ⏳     |

---

## Текущий приоритет

**Phase 2 — UX и расширение** (на ближайших PR):

1. **Верстка UI** — HTML/CSS под твоим дизайном (скрины приложены: desktop wide + mobile)
2. **Пресеты** — `scalp tight (0.3–0.6%)`, `swing (1–2%)`
3. **Вкладки** — Top Densities / By Symbol / Watchlist

После Phase 2 — переходим к Phase 3 (production deployment, systemd service).
