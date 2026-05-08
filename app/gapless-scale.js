/**
 * Gapless Horizontal Scale Behavior for LWC v5
 *
 * Makes candles equally spaced, hiding time gaps (like TradingView).
 * Used with LightweightCharts.createChartEx(el, behavior, options).
 *
 * Data keeps original UTC timestamps — the behavior maps them to
 * sequential indices internally. All formatting shows real time.
 */

// TickMarkWeight constants (from LWC source)
const TMW = { Second: 10, Minute1: 20, Minute5: 21, Minute30: 22, Hour1: 30, Hour3: 31, Hour6: 32, Hour12: 33, Day: 50, Month: 60, Year: 70 };

class GaplessHorzScaleBehavior {
    constructor() {
        this._options = {};
        this._timeMap = new Map();      // utcSec → sequential index
        this._reverseMap = new Map();   // sequential index → utcSec
        this._nextIndex = 0;
        this._locale = navigator.language || 'en-US';
    }

    options() { return this._options; }

    setOptions(options) {
        this._options = options;
        this.updateFormatter(options.localization);
    }

    preprocessData(data) {
        if (Array.isArray(data)) {
            // setData — rebuild full index from sorted timestamps
            this._timeMap.clear();
            this._reverseMap.clear();
            let idx = 0;
            for (let i = 0; i < data.length; i++) {
                const t = data[i].time;
                if (t !== undefined && !this._timeMap.has(t)) {
                    this._timeMap.set(t, idx);
                    this._reverseMap.set(idx, t);
                    idx++;
                }
            }
            this._nextIndex = idx;
        } else if (data && data.time !== undefined) {
            // series.update(item) — add single timestamp if new
            if (!this._timeMap.has(data.time)) {
                this._timeMap.set(data.time, this._nextIndex);
                this._reverseMap.set(this._nextIndex, data.time);
                this._nextIndex++;
            }
        }
    }

    updateFormatter(options) {
        this._locale = options?.locale || navigator.language || 'en-US';
    }

    createConverterToInternalObj(_data) {
        // Return converter: utcSec → { _internal_timestamp: index }
        return (time) => {
            if (this._timeMap.has(time)) {
                return { _internal_timestamp: this._timeMap.get(time) };
            }
            // Unknown timestamp — extend the index
            const idx = this._nextIndex++;
            this._timeMap.set(time, idx);
            this._reverseMap.set(idx, time);
            return { _internal_timestamp: idx };
        };
    }

    key(item) {
        if (typeof item === 'object' && '_internal_timestamp' in item) {
            return item._internal_timestamp;
        }
        return this.key(this.convertHorzItemToInternal(item));
    }

    cacheKey(item) {
        return item._internal_timestamp;
    }

    convertHorzItemToInternal(time) {
        if (this._timeMap.has(time)) {
            return { _internal_timestamp: this._timeMap.get(time) };
        }
        const idx = this._nextIndex++;
        this._timeMap.set(time, idx);
        this._reverseMap.set(idx, time);
        return { _internal_timestamp: idx };
    }

    formatHorzItem(item) {
        const idx = Math.round(item._internal_timestamp);
        const utcSec = this._reverseMap.get(idx);
        if (utcSec === undefined) return '';
        const d = new Date(utcSec * 1000);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    formatTickmark(tickMark, localizationOptions) {
        // Delegate to custom tickMarkFormatter if set (receives original UTC seconds)
        const tsOpts = this._options?.timeScale;
        if (tsOpts?.tickMarkFormatter && tickMark.originalTime !== undefined) {
            const w = tickMark.weight;
            let tickMarkType;
            if (w >= TMW.Year) tickMarkType = 0;        // Year
            else if (w >= TMW.Month) tickMarkType = 1;   // Month
            else if (w >= TMW.Day) tickMarkType = 2;     // DayOfMonth
            else tickMarkType = tsOpts.timeVisible ? 3 : 2; // Time or DayOfMonth
            const result = tsOpts.tickMarkFormatter(tickMark.originalTime, tickMarkType, localizationOptions?.locale);
            if (result !== null && result !== undefined) return result;
        }

        // Fallback: format from reverse map
        const idx = typeof tickMark.time === 'object'
            ? Math.round(tickMark.time._internal_timestamp)
            : Math.round(tickMark.time);
        const utcSec = tickMark.originalTime ?? this._reverseMap.get(idx);
        if (utcSec === undefined) return '';
        const d = new Date(utcSec * 1000);
        const w = tickMark.weight;
        if (w >= TMW.Year) return d.toLocaleDateString([], { year: 'numeric' });
        if (w >= TMW.Month) return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
        if (w >= TMW.Day) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    maxTickMarkWeight(tickMarks) {
        let maxWeight = 0;
        for (const tm of tickMarks) {
            if (tm.weight > maxWeight) maxWeight = tm.weight;
        }
        // Normalize: if between Hour1 and Day, use Hour1 (LWC convention)
        if (maxWeight > TMW.Hour1 && maxWeight < TMW.Day) maxWeight = TMW.Hour1;
        return maxWeight;
    }

    fillWeightsForPoints(sortedTimePoints, startIndex = 0) {
        if (sortedTimePoints.length === 0) return;

        let prevDate = null;
        if (startIndex > 0) {
            const prevIdx = Math.round(sortedTimePoints[startIndex - 1].time._internal_timestamp);
            const prevUtc = this._reverseMap.get(prevIdx);
            if (prevUtc) prevDate = new Date(prevUtc * 1000);
        }

        let totalTimeDiff = 0;
        let prevUtcSec = null;

        for (let i = startIndex; i < sortedTimePoints.length; i++) {
            const point = sortedTimePoints[i];
            const idx = Math.round(point.time._internal_timestamp);
            const utcSec = this._reverseMap.get(idx);

            if (utcSec === undefined) {
                point.timeWeight = TMW.Second;
                continue;
            }

            const d = new Date(utcSec * 1000);
            if (prevDate !== null) {
                point.timeWeight = GaplessHorzScaleBehavior._weightByTime(d, prevDate);
            }

            totalTimeDiff += utcSec - (prevUtcSec || utcSec);
            prevUtcSec = utcSec;
            prevDate = d;
        }

        // Guess weight for first point
        if (startIndex === 0 && sortedTimePoints.length > 1 && prevUtcSec !== null) {
            const firstIdx = Math.round(sortedTimePoints[0].time._internal_timestamp);
            const firstUtc = this._reverseMap.get(firstIdx);
            if (firstUtc !== undefined) {
                const avgDiff = Math.ceil(totalTimeDiff / Math.max(sortedTimePoints.length - 1, 1));
                const approxPrev = new Date((firstUtc - avgDiff) * 1000);
                sortedTimePoints[0].timeWeight = GaplessHorzScaleBehavior._weightByTime(
                    new Date(firstUtc * 1000), approxPrev
                );
            }
        }
    }

    // ─── Static: weight assignment matching LWC's default logic ────────
    static _weightByTime(cur, prev) {
        if (cur.getUTCFullYear() !== prev.getUTCFullYear()) return TMW.Year;
        if (cur.getUTCMonth() !== prev.getUTCMonth()) return TMW.Month;
        if (cur.getUTCDate() !== prev.getUTCDate()) return TMW.Day;

        const h = cur.getUTCHours(), ph = prev.getUTCHours();
        if (h !== ph) {
            if (h % 12 === 0) return TMW.Hour12;
            if (h % 6 === 0) return TMW.Hour6;
            if (h % 3 === 0) return TMW.Hour3;
            return TMW.Hour1;
        }

        const m = cur.getUTCMinutes(), pm = prev.getUTCMinutes();
        if (m !== pm) {
            if (m % 30 === 0) return TMW.Minute30;
            if (m % 5 === 0) return TMW.Minute5;
            return TMW.Minute1;
        }

        return TMW.Second;
    }

    // ─── Public helpers for external use ─────────────────────────────
    getTimestamp(index) {
        return this._reverseMap.get(Math.round(index));
    }

    getIndex(utcSec) {
        return this._timeMap.get(utcSec);
    }

    get size() {
        return this._timeMap.size;
    }
}

// Export as global for vanilla JS usage
window.GaplessHorzScaleBehavior = GaplessHorzScaleBehavior;
