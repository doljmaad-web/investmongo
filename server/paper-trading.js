import { db } from './database.js';

// ── Leverage multiplier ─────────────────────────────────────
// Change this value to simulate leveraged trading.
// 1 = no leverage (original behaviour)
// 3 = 3x leverage, 5 = 5x leverage, etc.
const LEVERAGE = 5;
const DEFAULT_PAPER_BALANCE = 10000;
let paperSessionCache = null;

export function getConfiguredPaperBalance() {
  const configured = parseFloat(process.env.PAPER_BALANCE ?? DEFAULT_PAPER_BALANCE);
  return Number.isFinite(configured) ? configured : DEFAULT_PAPER_BALANCE;
}

function getDbNow() {
  return db.prepare(`SELECT datetime('now') AS now`).get()?.now
    || new Date().toISOString().slice(0, 19).replace('T', ' ');
}

export function getPaperSession() {
  const configuredBalance = getConfiguredPaperBalance();

  if (paperSessionCache && paperSessionCache.startingBalance === configuredBalance) {
    return paperSessionCache;
  }

  const existing = db.prepare(
    `SELECT starting_balance, session_started_at FROM paper_state WHERE id=1`
  ).get();

  if (!existing) {
    const sessionStartedAt = getDbNow();
    db.prepare(`
      INSERT INTO paper_state (id, starting_balance, session_started_at, updated_at)
      VALUES (1, ?, ?, ?)
    `).run(configuredBalance, sessionStartedAt, sessionStartedAt);
    paperSessionCache = { startingBalance: configuredBalance, sessionStartedAt };
    return paperSessionCache;
  }

  if (parseFloat(existing.starting_balance) !== configuredBalance) {
    const sessionStartedAt = getDbNow();
    db.prepare(`
      UPDATE paper_state
      SET starting_balance=?, session_started_at=?, updated_at=?
      WHERE id=1
    `).run(configuredBalance, sessionStartedAt, sessionStartedAt);
    paperSessionCache = { startingBalance: configuredBalance, sessionStartedAt };
    return paperSessionCache;
  }

  paperSessionCache = {
    startingBalance: parseFloat(existing.starting_balance),
    sessionStartedAt: existing.session_started_at,
  };
  return paperSessionCache;
}

export function getPaperSessionStart() {
  return getPaperSession().sessionStartedAt;
}

export function hasPaperTradeHistory() {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM trades
    WHERE mode='PAPER' AND opened_at >= ?
  `).get(getPaperSessionStart());
  return (row?.count ?? 0) > 0;
}

export function getCashBalance() {
  const configuredBalance = getConfiguredPaperBalance();
  const sessionStart = getPaperSessionStart();
  if (!hasPaperTradeHistory()) return configuredBalance;

  const snap = db.prepare(
    'SELECT cash_balance FROM portfolio_snapshots WHERE snapshot_at >= ? ORDER BY snapshot_at DESC LIMIT 1'
  ).get(sessionStart);
  return snap?.cash_balance ?? configuredBalance;
}

export function getRecentPortfolioSnapshots(limit = 100) {
  const sessionStart = getPaperSessionStart();
  if (!hasPaperTradeHistory()) return [];
  return db.prepare(
    'SELECT total_value, snapshot_at FROM portfolio_snapshots WHERE snapshot_at >= ? ORDER BY snapshot_at DESC LIMIT ?'
  ).all(sessionStart, limit).reverse();
}

export function getPortfolioSnapshotsSince(cutoff) {
  const sessionStart = getPaperSessionStart();
  if (!hasPaperTradeHistory()) return [];
  return db.prepare(
    'SELECT total_value, snapshot_at FROM portfolio_snapshots WHERE snapshot_at >= ? AND snapshot_at >= ? ORDER BY snapshot_at ASC'
  ).all(sessionStart, cutoff);
}

export function resetPaperPortfolio() {
  const configuredBalance = getConfiguredPaperBalance();
  const sessionStartedAt = getDbNow();
  const tradeCount = db.prepare(`SELECT COUNT(*) AS count FROM trades WHERE mode='PAPER'`).get()?.count ?? 0;
  const snapshotCount = db.prepare(`SELECT COUNT(*) AS count FROM portfolio_snapshots`).get()?.count ?? 0;

  db.prepare(`
    INSERT OR REPLACE INTO paper_state (id, starting_balance, session_started_at, updated_at)
    VALUES (1, ?, ?, ?)
  `).run(configuredBalance, sessionStartedAt, sessionStartedAt);
  paperSessionCache = { startingBalance: configuredBalance, sessionStartedAt };

  db.prepare(`DELETE FROM trades WHERE mode='PAPER'`).run();
  db.prepare(`DELETE FROM portfolio_snapshots`).run();

  return {
    deletedTrades: tradeCount,
    deletedSnapshots: snapshotCount,
    resetBalance: configuredBalance,
  };
}

// Capital currently free to deploy: AUM minus what's locked in open trades
export function getAvailableCapital() {
  const stats      = getPortfolioStats();
  const deployed   = stats.openTrades.reduce((s, t) => s + (t.size_usd || 0), 0);
  return Math.max(0, parseFloat((stats.totalValue - deployed).toFixed(2)));
}

// Close a single trade by ID (smart exit, reversal, HTF signal)
export function closeTradeById(tradeId, exitPrice) {
  const t = db.prepare(`SELECT * FROM trades WHERE id=? AND status='OPEN'`).get(tradeId);
  if (!t) return;
  const isLong  = t.direction === 'LONG';
  const pnlUsd  = isLong
    ? (exitPrice - t.entry_price) / t.entry_price * t.size_usd * LEVERAGE
    : (t.entry_price - exitPrice) / t.entry_price * t.size_usd * LEVERAGE;
  db.prepare(`
    UPDATE trades SET status='CLOSED', exit_price=?, pnl_usd=?, pnl_pct=?, closed_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(exitPrice, parseFloat(pnlUsd.toFixed(2)), parseFloat((pnlUsd / t.size_usd * 100).toFixed(2)), tradeId);
  snapshotPortfolio();
}

// Close all open positions for an asset (called on signal flip)
export function closeOpenPosition(asset, exitPrice) {
  const open = db.prepare(`
    SELECT * FROM trades
    WHERE status='OPEN' AND mode='PAPER' AND asset=? AND opened_at >= ?
  `).all(asset, getPaperSessionStart());
  for (const t of open) {
    const isLong = t.direction === 'LONG';
    const pnlUsd = isLong
      ? (exitPrice - t.entry_price) / t.entry_price * t.size_usd * LEVERAGE
      : (t.entry_price - exitPrice) / t.entry_price * t.size_usd * LEVERAGE;
    db.prepare(`
      UPDATE trades SET status='CLOSED', exit_price=?, pnl_usd=?, pnl_pct=?, closed_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(exitPrice, parseFloat(pnlUsd.toFixed(2)), parseFloat((pnlUsd / t.size_usd * 100).toFixed(2)), t.id);
    console.log(`[PAPER] Signal flip exit: ${asset} ${t.direction} @ $${exitPrice} PnL: $${pnlUsd.toFixed(2)}`);
  }
  if (open.length > 0) snapshotPortfolio();
  return open.length;
}

export function openPaperTrade(signalId, decision, signal) {
  // size_usd wins if explicitly provided (deploy_pct × available capital path)
  // falls back to size_pct × cash_balance for backward compatibility
  const cash    = getCashBalance();
  const sizeUsd = decision.size_usd != null
    ? parseFloat(decision.size_usd.toFixed(2))
    : parseFloat((cash * (decision.size_pct ?? 50) / 100).toFixed(2));

  const result = db.prepare(`
    INSERT INTO trades
      (signal_id, asset, direction, entry_price, stop_loss, take_profit,
       size_usd, size_pct, status, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 'PAPER')
  `).run(
    signalId,
    signal.asset,
    signal.signal === 'BUY' ? 'LONG' : 'SHORT',
    decision.entry || signal.price,
    decision.stop_loss,
    decision.take_profit || 0,
    sizeUsd,
    decision.size_pct,
  );

  // Snapshot portfolio after opening
  snapshotPortfolio();
  return result.lastInsertRowid;
}

export function updateOpenTrades(prices) {
  const open = db.prepare(`
    SELECT * FROM trades
    WHERE status='OPEN' AND mode='PAPER' AND opened_at >= ?
  `).all(getPaperSessionStart());

  for (const t of open) {
    const price = prices[t.asset];
    if (!price) continue;

    const isLong  = t.direction === 'LONG';
    const pnlUsd  = isLong
      ? (price - t.entry_price) / t.entry_price * t.size_usd * LEVERAGE
      : (t.entry_price - price) / t.entry_price * t.size_usd * LEVERAGE;
    const pnlPct  = pnlUsd / t.size_usd * 100;

    // Hit stop loss? (only if stop_loss > 0 — 0 means disabled)
    if (t.stop_loss > 0 && ((isLong && price <= t.stop_loss) || (!isLong && price >= t.stop_loss))) {
      const finalPnl = isLong
        ? (t.stop_loss - t.entry_price) / t.entry_price * t.size_usd * LEVERAGE
        : (t.entry_price - t.stop_loss) / t.entry_price * t.size_usd * LEVERAGE;
      db.prepare(`
        UPDATE trades SET status='STOPPED', exit_price=?, pnl_usd=?,
        pnl_pct=?, closed_at=CURRENT_TIMESTAMP WHERE id=?
      `).run(t.stop_loss, parseFloat(finalPnl.toFixed(2)), parseFloat((finalPnl / t.size_usd * 100).toFixed(2)), t.id);
      console.log(`[PAPER] Stop loss hit: ${t.asset} ${t.direction} @ $${t.stop_loss} PnL: $${finalPnl.toFixed(2)}`);
      snapshotPortfolio();
      continue;
    }

    // Hit take profit? (only if take_profit > 0 — 0 means hold until signal)
    if (t.take_profit > 0 && ((isLong && price >= t.take_profit) || (!isLong && price <= t.take_profit))) {
      const finalPnl = isLong
        ? (t.take_profit - t.entry_price) / t.entry_price * t.size_usd * LEVERAGE
        : (t.entry_price - t.take_profit) / t.entry_price * t.size_usd * LEVERAGE;
      db.prepare(`
        UPDATE trades SET status='CLOSED', exit_price=?, pnl_usd=?,
        pnl_pct=?, closed_at=CURRENT_TIMESTAMP WHERE id=?
      `).run(t.take_profit, parseFloat(finalPnl.toFixed(2)), parseFloat((finalPnl / t.size_usd * 100).toFixed(2)), t.id);
      console.log(`[PAPER] Take profit hit: ${t.asset} ${t.direction} @ $${t.take_profit} PnL: $${finalPnl.toFixed(2)}`);
      snapshotPortfolio();
      continue;
    }

    // Update live P&L
    db.prepare(`UPDATE trades SET pnl_usd=?, pnl_pct=? WHERE id=?`)
      .run(parseFloat(pnlUsd.toFixed(2)), parseFloat(pnlPct.toFixed(2)), t.id);
  }
}

export function getPortfolioStats() {
  const sessionStart = getPaperSessionStart();
  const open = db.prepare(`
    SELECT * FROM trades
    WHERE status='OPEN' AND mode='PAPER' AND opened_at >= ?
  `).all(sessionStart);
  const closedTodayRows = db.prepare(`
    SELECT * FROM trades
    WHERE mode='PAPER' AND status IN ('CLOSED','STOPPED')
      AND opened_at >= ?
      AND DATE(closed_at) = DATE('now')
  `).all(sessionStart);
  const allClosed = db.prepare(`
    SELECT * FROM trades
    WHERE mode='PAPER' AND status IN ('CLOSED','STOPPED')
      AND opened_at >= ?
  `).all(sessionStart);
  const recentClosed = db.prepare(`
    SELECT * FROM trades
    WHERE mode='PAPER' AND status IN ('CLOSED','STOPPED')
      AND opened_at >= ?
    ORDER BY closed_at DESC LIMIT 50
  `).all(sessionStart);

  const cash          = getCashBalance();
  const openPnl       = open.reduce((s, t) => s + (t.pnl_usd || 0), 0);
  const closedToday_  = closedTodayRows.reduce((s, t) => s + (t.pnl_usd || 0), 0);
  const totalPnl      = allClosed.reduce((s, t) => s + (t.pnl_usd || 0), 0);
  const wins          = allClosed.filter(t => t.pnl_usd > 0).length;
  const winRate       = allClosed.length > 0 ? (wins / allClosed.length * 100) : 0;

  return {
    initialBalance:  getConfiguredPaperBalance(),
    totalValue:      parseFloat((cash + openPnl + totalPnl).toFixed(2)),
    cashBalance:     cash,
    openPnl:         parseFloat(openPnl.toFixed(2)),
    closedPnlToday:  parseFloat(closedToday_.toFixed(2)),
    closedTodayCount: closedTodayRows.length,
    totalPnl:        parseFloat(totalPnl.toFixed(2)),
    openTrades:      open,
    closedToday:     recentClosed,
    allClosed,
    winRate:         parseFloat(winRate.toFixed(1)),
    totalTrades:     allClosed.length,
    openCount:       open.length,
  };
}

export function snapshotPortfolio() {
  const stats = getPortfolioStats();
  db.prepare(`
    INSERT INTO portfolio_snapshots
      (total_value, cash_balance, open_pnl, closed_pnl_today, win_rate, total_trades)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    stats.totalValue, stats.cashBalance, stats.openPnl,
    stats.closedPnlToday, stats.winRate, stats.totalTrades
  );
}
