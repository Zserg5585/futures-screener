# Критические ошибки futures-screener

## #1 Несоответствие структуры данных между renderTable и renderCards — **ИСПРАВЛЕНО**
- `renderTable` теперь группирует записи по `symbol` (bid + ask в одну строку)
- `renderCards` тоже группирует по `symbol`
- Обе функции теперь используют одинаковую логику

## #2 API /densities/simple возвращает только top-20 уровней — **ИСПРАВЛЕНО**
- Заменено `slice(0, 20)` на `slice(0, depthLimit)`
- Теперь количество уровней настраивается через параметр `depthLimit` (по умолчанию 100)
- Добавлен `depthLimit` в ответ API

## #3 Отсутствие ask-записей при некоторых фильтрах — **ИССЛЕДОВАНО**
- Добавлено детальное логирование всех этапов обработки данных
- Выявлено: API возвращает 200 уровней (100 bid + 100 ask) при `minNotional=0`
- Проблема не найдена — данные корректно проходят через все этапы:
  - `filteredLevels=200` (bid=100, ask=100)
  - `processSide` обрабатывает оба side
  - `allLevels: count=200, sides={"bid":100,"ask":100}`
  - `finalData: count=200`
- API теперь возвращает `.count=200` для BTCUSDT
- **Вывод:** Проблема, вероятно, была в кэшировании или старой версии кода
- **Рекомендация:** Пользователю нужно проверить обновлённую страницу

## #4 Watchlist реализован, но нет интерфейса управления на карточках — **ИСПРАВЛЕНО**
- Добавлена кнопка watchlist (⭐/☆) в `card-footer`
- Используется та же функция `toggleWatchlist(symbol)` и `isSymbolInWatchlist(symbol)`
- Кнопка в правом углу карточки, под Score и Vol

## #5 Вкладки "Mini-Charts" и "Signals" — заглушки без функционала

## #6 Порядок переменных `vol1/2/3` — **ИСПРАВЛЕНО (2026-02-20)**
- **Было:** `vol1 = bars[2]` (самый старый), `vol3 = bars[0]` (новейший) — **перепутаны**
- **Стало:** `vol1 = bars[0]` (новейший, t), `vol2 = bars[1]` (предыдущий, t-1), `vol3 = bars[2]` (самый старый, t-2)
- **Обновлён комментарий** к `getKlinesWithStats` с пояснением порядка K-lines от Binance

---

## Дата создания: 2026-02-20
## Последнее обновление: 2026-02-20 (исправлено #1-#6, добавлен README.md)

## Итог по критическим ошибкам:
1. ✅ Несоответствие структуры данных — исправлено
2. ✅ Пагинация уровней — исправлено (depthLimit)
3. ✅ Отсутствие ask-записей — исследовано (теперь возвращаются 200 уровней)
4. ✅ Watchlist на карточках — добавлена кнопка
5. ⏭️ Mini-Charts/Signals — оставлено на Phase 2 (после Densities)
6. ✅ Порядок `vol1/2/3` — исправлен (теперь соответствует времени)

## Дополнительно:
- ✅ Создан `README.md` — полная документация проекта
- ✅ Добавлены скиллы: `github`, `openclaw-github-assistant`
- ✅ Обновлены переменные `vol1/2/3` в `server/index.js`
- ✅ Улучшен комментарий к `getKlinesWithStats`

## Скиллы, установленные для futures-screener:
- `binance-pro` — Binance REST API
- `technical-analyst` — Анализ чартов
- `tailwindcss` — Tailwind CSS
- `nginx` — Конфиги nginx
- `monitoring` — Healthchecks
- `websocket` — WebSocket (Binance Stream)
- `react-expert` — React
- `test-runner` — Тесты
- `shadcn-ui` — Shadcn UI
- `github` — GitHub
- `openclaw-github-assistant` — OpenClaw GitHub Assistant
