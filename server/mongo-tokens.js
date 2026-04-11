// ============================================================
// MONGO TOKEN ENGINE
// Off-chain points system — each unit = 1 MONGO token
// Converts to real tokens during airdrop event
// ============================================================
import { db } from './database.js';

// ── Multipliers by tier ──────────────────────────────────────
function getMultiplier(tier, lockMonths) {
  if (tier === 'locked') {
    if (lockMonths >= 12) return 8;   // Vault
    if (lockMonths >= 6)  return 4;   // Pro
    if (lockMonths >= 3)  return 2;   // Growth
  }
  return 1;                           // Liquid (flexible)
}

// ── Award tokens to a user ───────────────────────────────────
export function awardTokens(userId, amount, type, description) {
  if (!userId || !amount || amount <= 0) return;
  const rounded = parseFloat(amount.toFixed(4));
  db.prepare(`INSERT OR IGNORE INTO mongo_balances (user_id, balance) VALUES (?,0)`).run(userId);
  db.prepare(`UPDATE mongo_balances SET balance = balance + ?, last_updated = datetime('now') WHERE user_id = ?`).run(rounded, userId);
  db.prepare(`INSERT INTO mongo_transactions (user_id, amount, type, description) VALUES (?,?,?,?)`).run(userId, rounded, type, description);
}

// ── Get balance for a user ───────────────────────────────────
export function getBalance(userId) {
  return db.prepare(`SELECT balance FROM mongo_balances WHERE user_id=?`).get(userId)?.balance || 0;
}

// ── Get recent transactions ──────────────────────────────────
export function getTransactions(userId, limit = 20) {
  return db.prepare(`SELECT * FROM mongo_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT ?`).all(userId, limit);
}

// ── Daily deposit reward cron (runs once per day at midnight) ─
export function runDailyRewards() {
  console.log('[MONGO] Running daily token rewards…');
  const users = db.prepare(`
    SELECT u.id, u.name, COALESCE(u.tier,'flexible') AS tier,
           COALESCE(u.lock_months,0) AS lock_months,
           COALESCE(ub.visible_balance_usd,0) AS balance_usd
    FROM users u
    LEFT JOIN user_balances ub ON ub.user_id = u.id
    WHERE COALESCE(ub.visible_balance_usd,0) > 0
  `).all();

  let count = 0;
  for (const u of users) {
    const multiplier = getMultiplier(u.tier, u.lock_months);
    // Base: 1 MONGO per $100 locked per day × multiplier
    const earned = (u.balance_usd / 100) * multiplier;
    if (earned > 0) {
      awardTokens(u.id, earned, 'deposit_reward',
        `Daily: $${Math.round(u.balance_usd)} locked × ${multiplier}x`);
      count++;
    }
  }
  console.log(`[MONGO] Rewarded ${count} users`);
}

// ── Lock completion bonus (call when lock period ends) ───────
export function awardLockCompletionBonus(userId) {
  const bal = db.prepare(`SELECT balance FROM mongo_balances WHERE user_id=?`).get(userId);
  if (!bal || bal.balance <= 0) return;
  const bonus = parseFloat((bal.balance * 0.5).toFixed(4));
  awardTokens(userId, bonus, 'lock_bonus', 'Lock period completed — 50% loyalty bonus');
}

// ── Admin snapshot for airdrop ────────────────────────────────
export function getAirdropSnapshot() {
  return db.prepare(`
    SELECT u.id, u.name, u.email,
           COALESCE(u.wallet_address,'—') AS wallet_address,
           COALESCE(u.tier,'flexible') AS tier,
           COALESCE(u.lock_months,0) AS lock_months,
           COALESCE(mb.balance,0) AS mongo_balance,
           mb.last_updated
    FROM users u
    LEFT JOIN mongo_balances mb ON mb.user_id = u.id
    ORDER BY COALESCE(mb.balance,0) DESC
  `).all();
}
