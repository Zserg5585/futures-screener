# VISION — Futures Screener MVP

> Скринер работает **только с Binance Futures USDT-M PERPETUAL**.
> Цель: быстро видеть ближайшие плотности по множеству символов с подсветкой «MM» — крупных уровней ликвидности.

---

## MVP-цель (ТЕКУЩИЙ СТАТУС)

**Ключевые задачи:**
- Быстрый скрин: показать ближайшие плотности по 10–50 символам.
- Фильтрация: `minNotional`, `windowPct`, `depthLimit`, `symbols`.
- Сортировка: по `score desc, distancePct asc, notional desc`.
- Подсветка: флаг `isMM` для крупных уровней.
- Auto-refresh: каждые 5–15 секунд (без DDOS — с кэшированием и retry/backoff).

**Что уже сделано:**
- ✅ API `/densities/simple` работает
- ✅ Scoring формула: `score = log10(1 + notional) * exp(-d/0.45) * (isMM ? 1.8 : 1)`
- ✅ Сортировка по score + distance + notional
- ✅ Top-N: 20 на symbol
- ✅ Cache: in-memory Map (3 sec TTL)
- ✅ Retry/backoff: 3 attempts, exponential delay
- ✅ UI error states + loading animation
- ✅ SSL certificate на `futures-screener.szhub.space`

**Осталось:**
- ⏳ Верстка UI под скрины (desktop wide + mobile)
- ⏳ Пресеты: `scalp tight (0.3–0.6%)`, `swing (1–2%)`
- ⏳ Вкладки: Top Densities / By Symbol / Watchlist
- ⏳ Алерты (Telegram)
- ⏳ Systemd service

---

## Как считаем плотности (текущая логика)

1. Берём `markPrice` из `/fapi/v1/premiumIndex`.
2. Для каждого символа:
   - Получаем стакан `/fapi/v1/depth?symbol=X&limit=depthLimit`.
   - Фильтруем уровни:
     - `notional = price * qty >= minNotional`
     - `distancePct <= windowPct` (от `markPrice`).
3. Для каждой стороны (bid/ask):
   - `baseAll = percentile(notionals, 70)`
   - `filteredNotionals = [n for n in notionals if n <= baseAll * 2]`
   - `finalBaseAll = percentile(filteredNotionals, 70)`
   - `mm0 = finalBaseAll * mmSeedMultiplier` (default 2.0)
   - `mmCandidates = levels.filter(notional >= mm0)`
   - `mmBase = mmCandidates.length >= 3 ? percentile(mmCandidates.notionals, 50) : mm0`
   - `isMM = notional >= mmBase * mmMultiplier` (default 4)
4. **Scorинг:**
   - `score = log10(1 + notional) * exp(-distancePct / 0.45) * (isMM ? 1.8 : 1)`
   - `score rounded to 4 decimals`
5. Сортировка: `score desc, distancePct asc, notional desc`
6. Top-N: 20 на symbol

---

## Состояние API

| Эндпоинт | Статус | Описание |
|----------|--------|----------|
| `/health` | ✅ | healthcheck |
| `/symbols` | ✅ | список всех USDT-PERP символов |
| `/depth/:symbol` | ✅ | стакан по символу |
| `/densities/simple` | ✅ | плотности с score, isMM, top-N |
| `/_cache/stats` | ✅ | статистика кэша (для отладки) |

---

## Следующий уровень (Phase 2+)

- Вкладки: `Top Densities`, `By Symbol`, `Watchlist`
- Пресеты: `scalp tight (0.3–0.6%)`, `swing (1–2%)`
- Алерты: уведомления при приближении цены к уровню (Telegram)
- Systemd service для автостарта backend