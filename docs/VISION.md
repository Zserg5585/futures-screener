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
- ⏳ Стратегия отскока (документация)
- ⏳ Метрики устойчивости: `eatSpeedUSDTperSec`, `lifetimeSec`, `state`
- ⏳ Фильтр по минимальному `score`
- ⏳ Визуальная индикация MM + bounce-probability
- ⏳ Вкладки: Top Densities / By Symbol / Watchlist

---

## Стратегия "Отскок от плотностей"

### Основная идея

Мы **торгуем отскок**, а не пробой!  
Цена подходит к плотности → если плотность удерживается → ожидаем отскок.

### LONG (отскок от bid-плотности)

**Условия входа:**
- Плотность: **bid** (уровень под ценой)
- `distanceFromPricePct < 0.3–0.5%` — очень близко к цене
- Высокий `score` — сильный уровень
- `isMM = true` — Market Maker уровень
- Низкая `eatSpeedUSDTperSec` — уровень не "съедается" быстро
- Достаточный `lifetimeSec` — уровень уже стоит какое-то время

**Вход:** при касании или ложном проколе уровня  
**Подтверждение:** замедление, тень, удержание  
**Стоп:** чуть ниже плотности или % (0.3–0.5%)  
**Тейк:** возврат к VWAP / середине диапазона (1:2 RR)

### SHORT (отскок от ask-плотности)

Зеркальная логика:
- Плотность: **ask** (уровень над ценой)
- `distanceFromPricePct < 0.3–0.5%`
- Высокий `score`
- `isMM = true`
- Низкая `eatSpeedUSDTperSec`
- Достаточный `lifetimeSec`

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

## Что критично для стратегии отскока

| Метрика | Описание | Почему важно |
|---------|----------|--------------|
| `distanceFromPricePct` | Расстояние от цены до уровня | Чем ближе — тем выше вероятность отскока |
| `notional` | Объём уровня (price * qty) | Чем больше — тем сильнее поддержка/сопротивление |
| `isMM` | Market Maker уровень | MM уровни чаще удерживаются |
| `eatSpeedUSDTperSec` | Скорость "поедания" уровня | Низкая скорость = устойчивость |
| `lifetimeSec` | Время существования уровня | Долго стоит = важный уровень |
| `state` | APPEARED / UPDATED / MOVED | MOVED — уровень передвигается, это слабость |

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

- Метрики устойчивости: `eatSpeedUSDTperSec`, `lifetimeSec`, `state`
- Фильтр по `score` (минимальный порог)
- Визуальная индикация MM + bounce-probability
- Вкладки: Top Densities / By Symbol / Watchlist
- Алерты: уведомления при приближении цены к уровню (Telegram)
- Systemd service для автостарта backend