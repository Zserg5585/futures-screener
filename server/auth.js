/**
 * Auth Module — JWT + SQLite + Google OAuth ready
 *
 * Users table: id, email, password_hash, name, tier, provider, provider_id, created_at
 * Tiers: free, pro
 * Providers: local, google
 */

const Database = require('better-sqlite3')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const path = require('path')
const crypto = require('crypto')

// --- Config ---
const DB_PATH = path.join(__dirname, 'data', 'users.db')
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex')
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d'
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || ''

// Warn if using random JWT_SECRET (tokens won't survive restart)
if (!process.env.JWT_SECRET) {
  console.warn('[Auth] WARNING: JWT_SECRET not set in env, using random secret (tokens reset on restart)')
}

// --- Database Setup ---
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    name TEXT DEFAULT '',
    tier TEXT DEFAULT 'free' CHECK(tier IN ('free', 'pro', 'admin')),
    provider TEXT DEFAULT 'local' CHECK(provider IN ('local', 'google')),
    provider_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id);

  -- User settings (JSON blob per user, server-side sync for PRO)
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings TEXT DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Watchlists (server-side for PRO, replaces localStorage)
  CREATE TABLE IF NOT EXISTS watchlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    color TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, symbol)
  );
  CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id);

  -- Saved chart layouts (multi-chart configs)
  CREATE TABLE IF NOT EXISTS saved_layouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT DEFAULT 'Default',
    layout_type TEXT DEFAULT '1',
    config TEXT DEFAULT '{}',
    is_active INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_layouts_user ON saved_layouts(user_id);

  -- Price / density / impulse alert rules
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('price', 'density', 'impulse', 'listing', 'volume_spike')),
    symbol TEXT,
    condition TEXT DEFAULT '{}',
    enabled INTEGER DEFAULT 1,
    cooldown_sec INTEGER DEFAULT 300,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id);
  CREATE INDEX IF NOT EXISTS idx_alerts_enabled ON alerts(enabled);

  -- Alert trigger log (capped per user)
  CREATE TABLE IF NOT EXISTS alert_triggers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    symbol TEXT,
    message TEXT,
    data TEXT DEFAULT '{}',
    triggered_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_alert_triggers_user ON alert_triggers(user_id);

  -- Signal log for backtest (density breakouts, impulses, etc.)
  CREATE TABLE IF NOT EXISTS signal_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT,
    entry_price REAL,
    confidence REAL,
    metadata TEXT DEFAULT '{}',
    spot_after_5m REAL,
    spot_after_15m REAL,
    spot_after_1h REAL,
    spot_after_4h REAL,
    outcome TEXT,
    pnl_pct REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_signal_log_type ON signal_log(type);
  CREATE INDEX IF NOT EXISTS idx_signal_log_symbol ON signal_log(symbol);
  CREATE INDEX IF NOT EXISTS idx_signal_log_created ON signal_log(created_at);
`)

// --- Prepared Statements ---
const stmts = {
  findByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  findById: db.prepare('SELECT id, email, name, tier, provider, created_at FROM users WHERE id = ?'),
  findByProvider: db.prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?'),
  create: db.prepare(`
    INSERT INTO users (email, password_hash, name, tier, provider, provider_id)
    VALUES (@email, @password_hash, @name, @tier, @provider, @provider_id)
  `),
  updateTier: db.prepare('UPDATE users SET tier = ?, updated_at = datetime(\'now\') WHERE id = ?'),
  updateName: db.prepare('UPDATE users SET name = ?, updated_at = datetime(\'now\') WHERE id = ?'),
  countUsers: db.prepare('SELECT COUNT(*) as count FROM users'),
  allUsers: db.prepare('SELECT id, email, name, tier, provider, created_at FROM users ORDER BY created_at DESC'),

  // Settings
  getSettings: db.prepare('SELECT settings FROM user_settings WHERE user_id = ?'),
  upsertSettings: db.prepare(`
    INSERT INTO user_settings (user_id, settings, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings, updated_at = datetime('now')
  `),

  // Watchlists
  getWatchlist: db.prepare('SELECT * FROM watchlists WHERE user_id = ? ORDER BY sort_order'),
  addWatchlistItem: db.prepare('INSERT OR IGNORE INTO watchlists (user_id, symbol, color, sort_order) VALUES (?, ?, ?, ?)'),
  removeWatchlistItem: db.prepare('DELETE FROM watchlists WHERE user_id = ? AND symbol = ?'),
  updateWatchlistColor: db.prepare('UPDATE watchlists SET color = ? WHERE user_id = ? AND symbol = ?'),
  clearWatchlist: db.prepare('DELETE FROM watchlists WHERE user_id = ?'),

  // Layouts
  getLayouts: db.prepare('SELECT * FROM saved_layouts WHERE user_id = ? ORDER BY created_at'),
  getActiveLayout: db.prepare('SELECT * FROM saved_layouts WHERE user_id = ? AND is_active = 1'),
  createLayout: db.prepare('INSERT INTO saved_layouts (user_id, name, layout_type, config) VALUES (?, ?, ?, ?)'),
  updateLayout: db.prepare('UPDATE saved_layouts SET config = ?, layout_type = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?'),
  setActiveLayout: db.prepare('UPDATE saved_layouts SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE user_id = ?'),
  deleteLayout: db.prepare('DELETE FROM saved_layouts WHERE id = ? AND user_id = ?'),

  // Alerts
  getAlerts: db.prepare('SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at DESC'),
  getEnabledAlerts: db.prepare('SELECT a.*, u.tier FROM alerts a JOIN users u ON a.user_id = u.id WHERE a.enabled = 1'),
  createAlert: db.prepare('INSERT INTO alerts (user_id, type, symbol, condition, cooldown_sec) VALUES (?, ?, ?, ?, ?)'),
  updateAlert: db.prepare('UPDATE alerts SET condition = ?, enabled = ?, cooldown_sec = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?'),
  deleteAlert: db.prepare('DELETE FROM alerts WHERE id = ? AND user_id = ?'),
  toggleAlert: db.prepare('UPDATE alerts SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?'),
  countUserAlerts: db.prepare('SELECT COUNT(*) as count FROM alerts WHERE user_id = ?'),

  // Alert Triggers
  logTrigger: db.prepare('INSERT INTO alert_triggers (alert_id, user_id, symbol, message, data) VALUES (?, ?, ?, ?, ?)'),
  getTriggers: db.prepare('SELECT * FROM alert_triggers WHERE user_id = ? ORDER BY triggered_at DESC LIMIT ?'),
  cleanupTriggers: db.prepare(`
    DELETE FROM alert_triggers WHERE user_id = ? AND id NOT IN (
      SELECT id FROM alert_triggers WHERE user_id = ? ORDER BY triggered_at DESC LIMIT 1000
    )
  `),

  // Signal Log
  logSignal: db.prepare('INSERT INTO signal_log (type, symbol, direction, entry_price, confidence, metadata) VALUES (?, ?, ?, ?, ?, ?)'),
  updateSignalOutcome: db.prepare(`
    UPDATE signal_log SET spot_after_5m = ?, spot_after_15m = ?, spot_after_1h = ?, spot_after_4h = ?,
    outcome = ?, pnl_pct = ? WHERE id = ?
  `),
  getPendingSignals: db.prepare("SELECT * FROM signal_log WHERE outcome IS NULL AND created_at > datetime('now', '-5 hours')"),
  getSignalStats: db.prepare(`
    SELECT type, COUNT(*) as total,
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl
    FROM signal_log WHERE outcome IS NOT NULL GROUP BY type
  `),
  getRecentSignals: db.prepare('SELECT * FROM signal_log ORDER BY created_at DESC LIMIT ?'),
  cleanupSignals: db.prepare("DELETE FROM signal_log WHERE created_at < datetime('now', '-30 days')"),
}

// --- Helpers ---
function hashPassword(password) {
  return bcrypt.hashSync(password, 10)
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash)
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, tier: user.tier },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  )
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch (e) {
    return null
  }
}

// --- Auth Functions ---

/**
 * Register with email + password
 */
function register(email, password, name = '') {
  if (!email || !password) {
    return { error: 'Email and password required' }
  }
  if (password.length < 6) {
    return { error: 'Password must be at least 6 characters' }
  }

  const existing = stmts.findByEmail.get(email.toLowerCase())
  if (existing) {
    return { error: 'Email already registered' }
  }

  const result = stmts.create.run({
    email: email.toLowerCase(),
    password_hash: hashPassword(password),
    name: name || email.split('@')[0],
    tier: 'free',
    provider: 'local',
    provider_id: null,
  })

  const user = stmts.findById.get(result.lastInsertRowid)
  const token = generateToken(user)

  return { success: true, user, token }
}

/**
 * Login with email + password
 */
function login(email, password) {
  if (!email || !password) {
    return { error: 'Email and password required' }
  }

  const user = stmts.findByEmail.get(email.toLowerCase())
  if (!user) {
    return { error: 'Invalid email or password' }
  }

  if (user.provider !== 'local' || !user.password_hash) {
    return { error: `This account uses ${user.provider} login` }
  }

  if (!verifyPassword(password, user.password_hash)) {
    return { error: 'Invalid email or password' }
  }

  const token = generateToken({
    id: user.id,
    email: user.email,
    tier: user.tier,
  })

  const safeUser = stmts.findById.get(user.id)
  return { success: true, user: safeUser, token }
}

/**
 * Google OAuth: exchange code for user info, create/login user
 */
async function googleAuth(code) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return { error: 'Google OAuth not configured' }
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    })
    const tokens = await tokenRes.json()
    if (!tokens.access_token) {
      return { error: 'Failed to get Google token' }
    }

    // Get user info
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    const info = await infoRes.json()
    if (!info.email) {
      return { error: 'Failed to get Google user info' }
    }

    // Find or create user
    let user = stmts.findByProvider.get('google', info.id)
    if (!user) {
      // Check if email already registered with local
      const existing = stmts.findByEmail.get(info.email.toLowerCase())
      if (existing) {
        return { error: 'Email already registered with password login' }
      }

      stmts.create.run({
        email: info.email.toLowerCase(),
        password_hash: null,
        name: info.name || info.email.split('@')[0],
        tier: 'free',
        provider: 'google',
        provider_id: info.id,
      })
      user = stmts.findByEmail.get(info.email.toLowerCase())
    }

    const safeUser = stmts.findById.get(user.id)
    const token = generateToken(safeUser)

    return { success: true, user: safeUser, token }
  } catch (e) {
    return { error: `Google auth failed: ${e.message}` }
  }
}

/**
 * Get Google OAuth URL (redirect user here)
 */
function getGoogleAuthUrl() {
  if (!GOOGLE_CLIENT_ID) return null
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'email profile',
    access_type: 'offline',
    prompt: 'consent',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

// --- Fastify Middleware ---

/**
 * Extract user from JWT (non-blocking — sets req.user or null)
 */
function authHook(req) {
  req.user = null
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) return

  const token = authHeader.slice(7)
  const decoded = verifyToken(token)
  if (!decoded) return

  // Refresh user from DB (tier might have changed)
  const user = stmts.findById.get(decoded.id)
  if (user) req.user = user
}

/**
 * Require authenticated user (returns 401 if not)
 */
function requireAuth(req, reply) {
  authHook(req)
  if (!req.user) {
    reply.code(401).send({ error: 'Authentication required' })
    return false
  }
  return true
}

/**
 * Require PRO tier (returns 403 if free)
 */
function requirePro(req, reply) {
  if (!requireAuth(req, reply)) return false
  if (req.user.tier !== 'pro' && req.user.tier !== 'admin') {
    reply.code(403).send({ error: 'PRO subscription required' })
    return false
  }
  return true
}

// --- Admin Functions ---
function setTier(userId, tier) {
  stmts.updateTier.run(tier, userId)
  return stmts.findById.get(userId)
}

function listUsers() {
  return stmts.allUsers.all()
}

function getUserCount() {
  return stmts.countUsers.get().count
}

// --- DB Access Functions (for routes) ---

function getSettings(userId) {
  const row = stmts.getSettings.get(userId)
  return row ? JSON.parse(row.settings) : {}
}

function saveSettings(userId, settings) {
  stmts.upsertSettings.run(userId, JSON.stringify(settings))
}

function getWatchlist(userId) {
  return stmts.getWatchlist.all(userId)
}

function addToWatchlist(userId, symbol, color = '', sortOrder = 0) {
  stmts.addWatchlistItem.run(userId, symbol.toUpperCase(), color, sortOrder)
}

function removeFromWatchlist(userId, symbol) {
  stmts.removeWatchlistItem.run(userId, symbol.toUpperCase())
}

function getLayouts(userId) {
  return stmts.getLayouts.all(userId)
}

function getActiveLayout(userId) {
  return stmts.getActiveLayout.get(userId) || null
}

function createLayout(userId, name, layoutType, config) {
  return stmts.createLayout.run(userId, name, layoutType, JSON.stringify(config))
}

function updateLayout(layoutId, userId, config, layoutType) {
  stmts.updateLayout.run(JSON.stringify(config), layoutType, layoutId, userId)
}

function getUserAlerts(userId) {
  return stmts.getAlerts.all(userId).map(a => ({ ...a, condition: JSON.parse(a.condition || '{}') }))
}

function getAllEnabledAlerts() {
  return stmts.getEnabledAlerts.all().map(a => ({ ...a, condition: JSON.parse(a.condition || '{}') }))
}

function createUserAlert(userId, type, symbol, condition, cooldownSec = 300) {
  return stmts.createAlert.run(userId, type, symbol, JSON.stringify(condition), cooldownSec)
}

function logAlertTrigger(alertId, userId, symbol, message, data = {}) {
  stmts.logTrigger.run(alertId, userId, symbol, message, JSON.stringify(data))
  stmts.cleanupTriggers.run(userId, userId) // cap at 1000
}

function getAlertTriggers(userId, limit = 50) {
  return stmts.getTriggers.all(userId, limit).map(t => ({ ...t, data: JSON.parse(t.data || '{}') }))
}

function logSignal(type, symbol, direction, entryPrice, confidence, metadata = {}) {
  return stmts.logSignal.run(type, symbol, direction, entryPrice, confidence, JSON.stringify(metadata))
}

function getSignalStats() {
  return stmts.getSignalStats.all()
}

function getRecentSignals(limit = 50) {
  return stmts.getRecentSignals.all(limit).map(s => ({ ...s, metadata: JSON.parse(s.metadata || '{}') }))
}

// --- Exports ---
module.exports = {
  // Auth
  register,
  login,
  googleAuth,
  getGoogleAuthUrl,
  authHook,
  requireAuth,
  requirePro,
  verifyToken,
  setTier,
  listUsers,
  getUserCount,
  GOOGLE_CLIENT_ID,

  // Settings
  getSettings,
  saveSettings,

  // Watchlists
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,

  // Layouts
  getLayouts,
  getActiveLayout,
  createLayout,
  updateLayout,

  // Alerts
  getUserAlerts,
  getAllEnabledAlerts,
  createUserAlert,
  logAlertTrigger,
  getAlertTriggers,

  // Signals
  logSignal,
  getSignalStats,
  getRecentSignals,

  // DB direct (for advanced use)
  db,
  stmts,
}
