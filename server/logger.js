// ============================================
// Logger — structured logging with pino
// Uses pino (bundled with Fastify) + multistream (stdout + file)
// Rotation handled by pm2-logrotate
// ============================================
const pino = require('pino')
const path = require('path')
const fs = require('fs')

const LOG_DIR = path.resolve(__dirname, '..', 'logs')
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase()

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })

// File destination (sync write — reliable, no worker thread flush issues)
const fileDest = pino.destination({
  dest: path.join(LOG_DIR, 'server.log'),
  sync: false,       // async for performance
  minLength: 0,      // flush immediately (no buffering)
})

// Multistream: stdout (for PM2) + file (for structured search)
const streams = [
  { level: LOG_LEVEL, stream: process.stdout },
  { level: 'debug',   stream: fileDest },
]

const rootLogger = pino({ level: 'debug' }, pino.multistream(streams))

// Flush file on exit
const flushAndExit = () => { fileDest.flushSync(); process.exit() }
process.once('SIGTERM', flushAndExit)
process.once('SIGINT', flushAndExit)

// Registry for runtime level changes
const childLoggers = new Map()

/**
 * Create a child logger for a module
 * @param {string} module - Module name (e.g. 'signals', 'ws', 'state')
 * @returns {pino.Logger} Child logger with { module } field
 */
function createLogger(module) {
  const envKey = `LOG_LEVEL_${module.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
  const level = (process.env[envKey] || LOG_LEVEL).toLowerCase()
  const child = rootLogger.child({ module })
  child.level = level
  childLoggers.set(module, child)
  return child
}

/**
 * Change log level at runtime (no restart needed)
 * @param {string} module - Module name or '*' for all
 * @param {string} level - pino level: 'debug', 'info', 'warn', 'error', 'fatal'
 */
function setLevel(module, level) {
  if (module === '*') {
    for (const [, child] of childLoggers) child.level = level
    return { changed: childLoggers.size }
  }
  const child = childLoggers.get(module)
  if (child) {
    child.level = level
    return { changed: 1 }
  }
  return { changed: 0, error: `Module '${module}' not found` }
}

/**
 * Get current log levels for all modules
 */
function getLevels() {
  const result = {}
  for (const [name, child] of childLoggers) {
    result[name] = child.level
  }
  return result
}

module.exports = { createLogger, setLevel, getLevels }
