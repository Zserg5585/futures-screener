# VISION — Futures Screener MVP

> Скринер работает **только с Binance Futures USDT-M PERPETUAL**.
> Цель: быстро видеть ближайшие плотности по множеству символов с подсветкой «MM» — крупных уровней ликвидности.

---

## MVP-цель (тот, что делаем сейчас)

**Ключевые задачи:**
- Быстрый скрин: показать ближайшие плотности по 10–50 символам.
- Фильтрация: `minNotional`, `windowPct`, `depthLimit`, `symbols`.
- Сортировка: по `distancePct`, `notional`.
- Подсветка: флаг `isMM` для крупных уровней.
- Auto-refresh: каждые 5–15 секунд (без DDOS — с кэшированием и пакетированием).

**Не делаем в MVP:**
- Скоринг (score) — запланирован в Phase 1.
- Вкладки (Top/By Symbol/Watchlist) — Phase 1+.
- Алерты — Phase 1+.

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
   - `mm0 = finalBaseAll * mmSeedMultiplier`
   - `mmCandidates = levels.filter(notional >= mm0)`
   - `mmBase = mmCandidates.length >= 3 ? percentile(mmCandidates.notionals, 50) : mm0`
   - `isMM = notional >= mmBase * mmMultiplier`

**Минусы текущей логики:**
- Нет scorинга (нельзя сравнить bid и ask между собой).
- Нет top-N (возвращаются все уровни).
- Нет сортировки по `score` (только по `distancePct`).

---

## Что включено в MVP

| Слой | Статус | Описание |
|------|--------|----------|
| Backend API | ✅ | `/densities/simple` возвращает `data[]` |
| Frontend UI | ✅ | Таблица с автообновлением |
| Сортировка | ⚠️ | По `distancePct`, `notional` (без scorинга) |
| MM-флаг | ⚠️ | Есть `isMM`, но без scorинга |
| Auto-refresh | ✅ | Каждые 10 сек (настраивается) |
| Cache | ⏳ | Планируется (in-memory Map, ~3 сек TTL) |

---

## Следующий уровень (Phase 1+)

- Добавить пресеты: `scalp tight`, `swing`.
- Вкладки: `Top Densities`, `By Symbol`, `Watchlist`.
- Scorинг: `score = log10(1 + notional) * exp(-distancePct / decayPct) * (isMM ? 1.8 : 1)`.
- Сортировка по `score`.
- Top-N (например, top 20 на символ).
- Алерты: уведомления при приближении цены к уровню.
