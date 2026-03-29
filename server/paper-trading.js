import { db } from './database.js';

export function getCashBalance() {
  const snap = db.prepare(
    'SELECT cash_balance FROM portfolio_snapshots ORDER BY snapshot_at DESC LIMIT 1'
  ).get();
  return snap?.cash_balance ?? parseFloat(process.env.PAPER_BALANCE ?? 10000);
}

export function openPaperTrade(signalId, decision, signal) {
  const cash    = getCashBalance();
  const sizeUsd = parseFloat((cash * decision.size_pct / 100).toFixed(2));

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
    decision.take_profit,
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
      ? (price - t.entry_price) / t.entry_price * t.size_usd
      : (t.entry_price - price) / t.entry_price * t.size_usd;
    const pnlPct  = pnlUsd / t.size_usd * 100;

    // Hit stop loss?
    if ((isLong && price <= t.stop_loss) || (!isLong && price >= t.stop_loss)) {
      const finalPnl = isLong
        ? (t.stop_loss - t.entry_price) / t.entry_price * t.size_usd
        : (t.entry_price - t.stop_loss) / t.entry_price * t.size_usd;
      db.prepare(`
        UPDATE trades SET status='STOPPED', exit_price=?, pnl_usd=?,
        pnl_pct=?, closed_at=CURRENT_TIMESTAMP WHERE id=?
      `).run(t.stop_loss, finalPnl, finalPnl / t.size_usd * 100, t.id);
      console.log(`[PAPER] Stop loss hit: ${t.asset} ${t.direction} PnL: $${finalPnl.toFixed(2)}`);
      continue;
    }

    // Hit take profit?
    if ((isLong && price >= t.take_profit) || (!isLong && price <= t.take_profit)) {
      const finalPnl = isLong
        ? (t.take_profit - t.entry_price) / t.entry_price * t.size_usd
        : (t.entry_price - t.take_profit) / t.entry_price * t.size_usd;
      db.prepare(`
        UPDATE trades SET status='CLOSED', exit_price=?, pnl_usd=?,
        pnl_pct=?, closed_at=CURRENT_TIMESTAMP WHERE id=?
      `).run(t.take_profit, finalPnl, finalPnl / t.size_usd * 100, t.id);
      console.log(`[PAPER] Take profit hit: ${t.asset} ${t.direction} PnL: $${finalPnl.toFixed(2)}`);
      continue;
    }

    // Update live P&L
    db.prepare(`UPDATE trades SET pnl_usd=?, pnl_pct=? WHERE id=?`)
      .run(parseFloat(pnlUsd.toFixed(2)), parseFloat(pnlPct.toFixed(2)), t.id);
  }
}

export function getPortfolioStats() {
  const open = db.prepare(`SELECT * FROM trades WHERE status='OPEN' AND mode='PAPER'`).all();
  const closedToday = db.prepare(`
    SELECT * FROM trades WHERE mode='PAPER' AND status IN ('CLOSED','STOPPED')
    AND DATE(closed_at) = DATE('now')
  `).all();
  const allClosed = db.prepare(`
    SELECT * FROM trades WHERE mode='PAPER' AND status IN ('CLOSED','STOPPED')
  `).all();

  const cash          = getCashBalance();
  const openPnl       = open.reduce((s, t) => s + (t.pnl_usd || 0), 0);
  const closedToday_  = closedToday.reduce((s, t) => s + (t.pnl_usd || 0), 0);
  const totalPnl      = allClosed.reduce((s, t) => s + (t.pnl_usd || 0), 0);
  const wins          = allClosed.filter(t => t.pnl_usd > 0).length;
  const winRate       = allClosed.length > 0 ? (wins / allClosed.length * 100) : 0;

  return {
    totalValue:      parseFloat((cash + openPnl + totalPnl).toFixed(2)),
    cashBalance:     cash,
    openPnl:         parseFloat(openPnl.toFixed(2)),
    closedPnlToday:  parseFloat(closedToday_.toFixed(2)),
    totalPnl:        parseFloat(totalPnl.toFixed(2)),
    openTrades:      open,
    closedToday:     closedToday,
    allClosed,
    winRate:         parseFloat(winRate.toFixed(1)),
    totalTrades:     allClosed.length,
    openCount:       open.length,
  };
}

function snapshotPortfolio() {
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
