// ============================================
// Klines Cache — SQLite persistent storage
// Eliminates Binance API dependency for historical data
// ============================================
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'klines.db');
let db;

function initDB() {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');      // faster concurrent reads
    db.pragma('synchronous = NORMAL');    // good enough durability
    db.pragma('cache_size = -64000');     // 64MB cache

    db.exec(`
        CREATE TABLE IF NOT EXISTS klines (
            symbol TEXT NOT NULL,
            interval TEXT NOT NULL,
            time INTEGER NOT NULL,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL NOT NULL,
            PRIMARY KEY (symbol, interval, time)
        ) WITHOUT ROWID;

        CREATE INDEX IF NOT EXISTS idx_klines_sym_int
            ON klines(symbol, interval);
    `);

    console.log('[KlinesCache] SQLite initialized at', DB_PATH);
    return db;
}

// Prepared statements (created lazily after initDB)
let _stmts = null;
function stmts() {
    if (!_stmts) {
        _stmts = {
            upsert: db.prepare(`
                INSERT OR REPLACE INTO klines (symbol, interval, time, open, high, low, close, volume)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `),
            getRange: db.prepare(`
                SELECT time, open, high, low, close, volume
                FROM klines
                WHERE symbol = ? AND interval = ?
                ORDER BY time ASC
            `),
            getRangeLimit: db.prepare(`
                SELECT time, open, high, low, close, volume
                FROM klines
                WHERE symbol = ? AND interval = ?
                ORDER BY time DESC
                LIMIT ?
            `),
            getAfter: db.prepare(`
                SELECT time, open, high, low, close, volume
                FROM klines
                WHERE symbol = ? AND interval = ? AND time > ?
                ORDER BY time ASC
            `),
            getBefore: db.prepare(`
                SELECT time, open, high, low, close, volume
                FROM klines
                WHERE symbol = ? AND interval = ? AND time < ?
                ORDER BY time DESC
                LIMIT ?
            `),
            getLatestTime: db.prepare(`
                SELECT MAX(time) as maxTime
                FROM klines
                WHERE symbol = ? AND interval = ?
            `),
            getCount: db.prepare(`
                SELECT COUNT(*) as cnt
                FROM klines
                WHERE symbol = ? AND interval = ?
            `),
            getSymbols: db.prepare(`
                SELECT DISTINCT symbol FROM klines WHERE interval = ?
            `),
        };
    }
    return _stmts;
}

// Store candles in bulk (from Binance raw format)
function storeCandles(symbol, interval, rawKlines) {
    if (!rawKlines || rawKlines.length === 0) return 0;
    const s = stmts();
    const tx = db.transaction((rows) => {
        for (const k of rows) {
            const time = Math.floor(k[0] / 1000); // ms → sec
            s.upsert.run(symbol, interval, time,
                parseFloat(k[1]), parseFloat(k[2]),
                parseFloat(k[3]), parseFloat(k[4]),
                parseFloat(k[7])
            );
        }
    });
    tx(rawKlines);
    return rawKlines.length;
}

// Get candles (latest N, ordered ASC for chart display)
function getCandles(symbol, interval, limit = 500) {
    const s = stmts();
    const rows = s.getRangeLimit.all(symbol, interval, limit);
    return rows.reverse(); // DESC → ASC
}

// Get candles after a timestamp (for delta updates)
function getCandlesAfter(symbol, interval, afterTime) {
    const s = stmts();
    return s.getAfter.all(symbol, interval, afterTime);
}

// Get candles before a timestamp (for backward pagination)
function getCandlesBefore(symbol, interval, beforeTime, limit = 1500) {
    const s = stmts();
    const rows = s.getBefore.all(symbol, interval, beforeTime, limit);
    return rows.reverse(); // DESC → ASC
}

// Get latest cached timestamp for a symbol
function getLatestTime(symbol, interval) {
    const s = stmts();
    const row = s.getLatestTime.get(symbol, interval);
    return row ? row.maxTime : null;
}

// Get count of cached candles
function getCount(symbol, interval) {
    const s = stmts();
    const row = s.getCount.get(symbol, interval);
    return row ? row.cnt : 0;
}

// Get all cached symbols for an interval
function getCachedSymbols(interval) {
    const s = stmts();
    return s.getSymbols.all(interval).map(r => r.symbol);
}

// DB stats
function getStats() {
    const totalRows = db.prepare('SELECT COUNT(*) as cnt FROM klines').get().cnt;
    const symbols = db.prepare('SELECT COUNT(DISTINCT symbol) as cnt FROM klines').get().cnt;
    const dbSize = require('fs').statSync(DB_PATH).size;
    return { totalRows, symbols, dbSizeMB: (dbSize / 1024 / 1024).toFixed(1) };
}

module.exports = {
    initDB,
    storeCandles,
    getCandles,
    getCandlesAfter,
    getCandlesBefore,
    getLatestTime,
    getCount,
    getCachedSymbols,
    getStats,
};
