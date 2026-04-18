import { db } from './database.js';

// ── Leverage multiplier ─────────────────────────────────────
// Change this value to simulate leveraged trading.
// 1 = no leverage (original behaviour)
// 3 = 3x leverage, 5 = 5x leverage, etc.
const LEVERAGE = 5;
const DEFAULT_PAPER_BALANCE = 10000;

export function getConfiguredPaperBalance() {
  const configured = parseFloat(process.env.PAPER_BALANCE ?? DEFAULT_PAPER_BALANCE);
  return Number.isFinite(configured) ? configured : DEFAULT_PAPER_BALANCE;
}

export function hasPaperTradeHistory() {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM trades WHERE mode='PAPER'`).get();
  return (row?.count ?? 0) > 0;
}

export function getCashBalance() {
  const configuredBalance = getConfiguredPaperBalance();
  if (!hasPaperTradeHistory()) return configuredBalance;

  const snap = db.prepare(
    'SELECT cash_balance FROM portfolio_snapshots ORDER BY snapshot_at DESC LIMIT 1'
  ).get();
  return snap?.cash_balance ?? configuredBalance;
}

export function getRecentPortfolioSnapshots(limit = 100) {
  if (!hasPaperTradeHistory()) return [];
  return db.prepare(
    'SELECT total_value, snapshot_at FROM portfolio_snapshots ORDER BY snapshot_at DESC LIMIT ?'
  ).all(limit).reverse();
}

export function getPortfolioSnapshotsSince(cutoff) {
  if (!hasPaperTradeHistory()) return [];
  return db.prepare(
    'SELECT total_value, snapshot_at FROM portfolio_snapshots WHERE snapshot_at >= ? ORDER BY snapshot_at ASC'
  ).all(cutoff);
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
  const open = db.prepare(`SELECT * FROM trades WHERE status='OPEN' AND mode='PAPER' AND asset=?`).all(asset);
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
  const open = db.prepare(`SELECT * FROM trades WHERE status='OPEN' AND mode='PAPER'`).all();

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
  const open = db.prepare(`SELECT * FROM trades WHERE status='OPEN' AND mode='PAPER'`).all();
  const closedTodayRows = db.prepare(`
    SELECT * FROM trades WHERE mode='PAPER' AND status IN ('CLOSED','STOPPED')
    AND DATE(closed_at) = DATE('now')
  `).all();
  const allClosed = db.prepare(`
    SELECT * FROM trades WHERE mode='PAPER' AND status IN ('CLOSED','STOPPED')
  `).all();
  const recentClosed = db.prepare(`
    SELECT * FROM trades WHERE mode='PAPER' AND status IN ('CLOSED','STOPPED')
    ORDER BY closed_at DESC LIMIT 50
  `).all();

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
