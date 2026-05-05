// src/config/logger.js
const isProd = process.env.NODE_ENV === 'production';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? (isProd ? LEVELS.info : LEVELS.debug);

const COLORS = {
  debug: '\x1b[36m', // cyan
  info:  '\x1b[32m', // green
  warn:  '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  reset: '\x1b[0m',
};

function serialize(args) {
  return args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }
    return String(a);
  }).join(' ');
}

function write(level, args) {
  if (LEVELS[level] < MIN_LEVEL) return;

  const ts  = new Date().toISOString();
  const msg = serialize(args);
  const out = level === 'error' ? process.stderr : process.stdout;

  if (isProd) {
    out.write(JSON.stringify({ ts, level, msg }) + '\n');
  } else {
    const c = COLORS[level];
    out.write(`${c}[${level.toUpperCase()}]${COLORS.reset} ${ts} ${msg}\n`);
  }
}

const logger = {
  debug: (...args) => write('debug', args),
  info:  (...args) => write('info',  args),
  warn:  (...args) => write('warn',  args),
  error: (...args) => write('error', args),
};

module.exports = logger;
