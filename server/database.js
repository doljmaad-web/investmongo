// ============================================================
// DATABASE — sql.js (pure WASM, no native compilation needed)
// Exposes a better-sqlite3-compatible synchronous API
// ============================================================
import initSqlJs from 'sql.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

// Use Railway persistent volume in production, local file in dev
// On Railway: add a volume in the dashboard and set mount path to /data
const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;
const DB_DIR     = IS_RAILWAY ? '/data' : '.';
const DB_PATH    = path.join(DB_DIR, 'invest_mongo.db');

if (IS_RAILWAY && !existsSync('/data')) mkdirSync('/data', { recursive: true });

// ── Bootstrap sql.js ──────────────────────────────────────
const SQL    = await initSqlJs();
const rawDb  = existsSync(DB_PATH)
  ? new SQL.Database(readFileSync(DB_PATH))
  : new SQL.Database();

// Persist to disk after every write
function save() {
  writeFileSync(DB_PATH, Buffer.from(rawDb.export()));
}

// ── Compatibility shim (better-sqlite3 API) ───────────────
const db = {
  /**
   * Execute a multi-statement SQL string (DDL / no results).
   */
  exec(sql) {
    rawDb.run(sql);
    save();
    return this;
  },

  /**
   * Set a pragma (sql.js ignores most, WAL is auto-handled).
   */
  pragma(stmt) {
    try { rawDb.run(`PRAGMA ${stmt}`); } catch {}
    return this;
  },

  /**
   * Prepare a statement and return an object with
   * .run(), .get(), and .all() — matching better-sqlite3.
   */
  prepare(sql) {
    return {
      /**
       * Execute a write statement. Returns { lastInsertRowid, changes }.
       */
      run(...args) {
        const params = flattenParams(args);
        rawDb.run(sql, params);
        save();
        const id  = rawDb.exec('SELECT last_insert_rowid() AS id')[0]?.values[0][0] ?? null;
        const chg = rawDb.exec('SELECT changes() AS c')[0]?.values[0][0] ?? 0;
        return { lastInsertRowid: id, changes: chg };
      },

      /**
       * Return the first matching row as a plain object, or undefined.
       */
      get(...args) {
        const params = flattenParams(args);
        const res = rawDb.exec(sql, params);
        if (!res.length || !res[0].values.length) return undefined;
        const { columns, values } = res[0];
        return Object.fromEntries(columns.map((c, i) => [c, values[0][i]]));
      },

      /**
       * Return all matching rows as an array of plain objects.
       */
      all(...args) {
        const params = flattenParams(args);
        const res = rawDb.exec(sql, params);
        if (!res.length) return [];
        const { columns, values } = res[0];
        return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
      },
    };
  },
};

/** Flatten variadic or single-array param patterns used by better-sqlite3. */
function flattenParams(args) {
  if (args.length === 0) return [];
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

// ── Schema ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    source TEXT NOT NULL,
    asset TEXT NOT NULL,
    action TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    price REAL NOT NULL,
    rsi REAL,
    sma50 REAL,
    sma200 REAL,
    timeframe TEXT,
    pattern TEXT,
    strength TEXT,
    gemini_verdict TEXT,
    gemini_confidence INTEGER,
    gemini_reasoning TEXT,
    gemini_news_sentiment TEXT,
    gemini_macro_risk TEXT,
    validated_news TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id INTEGER,
    asset TEXT NOT NULL,
    direction TEXT NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL,
    stop_loss REAL NOT NULL,
    take_profit REAL,
    size_usd REAL NOT NULL,
    size_pct REAL NOT NULL,
    pnl_usd REAL DEFAULT 0,
    pnl_pct REAL DEFAULT 0,
    status TEXT DEFAULT 'OPEN',
    mode TEXT DEFAULT 'PAPER',
    opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME,
    FOREIGN KEY (signal_id) REFERENCES signals(id)
  );

  CREATE TABLE IF NOT EXISTS news_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    sentiment TEXT,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total_value REAL NOT NULL,
    cash_balance REAL NOT NULL,
    open_pnl REAL DEFAULT 0,
    closed_pnl_today REAL DEFAULT 0,
    win_rate REAL DEFAULT 0,
    total_trades INTEGER DEFAULT 0,
    snapshot_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS trading_assets (
    asset      TEXT PRIMARY KEY,
    deploy_pct REAL DEFAULT 50
  );

  INSERT OR IGNORE INTO trading_assets (asset) VALUES ('BTC');
  INSERT OR IGNORE INTO trading_assets (asset) VALUES ('ETH');
  INSERT OR IGNORE INTO trading_assets (asset) VALUES ('DOGE');
  INSERT OR IGNORE INTO trading_assets (asset) VALUES ('GOLD');
  INSERT OR IGNORE INTO trading_assets (asset) VALUES ('HYPE');
`);

// Migration: add deploy_pct column if upgrading from the initial schema
try { db.exec(`ALTER TABLE trading_assets ADD COLUMN deploy_pct REAL DEFAULT 50`); } catch (_) {}
// Migration: add oanda_trade_id for live OANDA execution on SILVER/OIL
try { db.exec(`ALTER TABLE trades ADD COLUMN oanda_trade_id TEXT`); } catch (_) {}

// Drawings table for Spatial Trade Planner manual annotations
db.exec(`
  CREATE TABLE IF NOT EXISTS drawings (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    coin     TEXT NOT NULL,
    interval TEXT NOT NULL,
    type     TEXT NOT NULL,
    data     TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Auth & Portfolio Schema ───────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    email            TEXT UNIQUE,
    wallet_address   TEXT UNIQUE,
    github_id        TEXT UNIQUE,
    name             TEXT NOT NULL,
    avatar           TEXT,
    auth_provider    TEXT NOT NULL,
    deposit_address  TEXT UNIQUE,
    deposit_index    INTEGER UNIQUE,
    tier             TEXT DEFAULT 'flexible',
    tier_pct         REAL DEFAULT 9,
    lock_months      INTEGER DEFAULT 0,
    lock_until       TEXT,
    is_admin         INTEGER DEFAULT 0,
    created_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS client_deposits (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    tx_hash       TEXT UNIQUE,
    amount_native REAL,
    amount_usd    REAL NOT NULL,
    token         TEXT DEFAULT 'ETH',
    network       TEXT DEFAULT 'arbitrum',
    status        TEXT DEFAULT 'pending',
    deposited_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_balances (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER UNIQUE NOT NULL,
    deposited_usd       REAL DEFAULT 0,
    visible_balance_usd REAL DEFAULT 0,
    total_gain_usd      REAL DEFAULT 0,
    monthly_gain_usd    REAL DEFAULT 0,
    gain_reset_at       TEXT DEFAULT (datetime('now')),
    last_updated        TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS client_withdrawals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    amount_usd   REAL NOT NULL,
    to_address   TEXT NOT NULL,
    status       TEXT DEFAULT 'pending',
    tx_hash      TEXT,
    requested_at TEXT DEFAULT (datetime('now')),
    processed_at TEXT,
    admin_note   TEXT
  );
`);

// ── Community Schema ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS community_posts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    content       TEXT NOT NULL,
    ticker        TEXT,
    likes_count   INTEGER DEFAULT 0,
    comments_count INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS community_likes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(post_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS community_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Community follows table
db.exec(`
  CREATE TABLE IF NOT EXISTS community_follows (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    follower_id  INTEGER NOT NULL,
    following_id INTEGER NOT NULL,
    created_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(follower_id, following_id)
  );
`);

// ── MONGO Token Schema ────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS mongo_balances (
    user_id      INTEGER PRIMARY KEY,
    balance      REAL DEFAULT 0,
    last_updated TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mongo_transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    amount      REAL NOT NULL,
    type        TEXT NOT NULL,
    description TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );
`);

// Community post image/link support
try { db.exec(`ALTER TABLE community_posts ADD COLUMN image TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE community_posts ADD COLUMN link  TEXT`); } catch (_) {}

// Community profile migrations
try { db.exec(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN handle TEXT`); } catch (_) {}

// Migrations — safe to run on every boot
try { db.exec(`ALTER TABLE users ADD COLUMN tier TEXT DEFAULT 'flexible'`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN tier_pct REAL DEFAULT 9`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN lock_months INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN lock_until TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN deposit_address TEXT UNIQUE`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN deposit_index INTEGER UNIQUE`); } catch (_) {}
try { db.exec(`ALTER TABLE user_balances ADD COLUMN monthly_gain_usd REAL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE user_balances ADD COLUMN gain_reset_at TEXT DEFAULT (datetime('now'))`); } catch (_) {}

export { db };
export default db;
