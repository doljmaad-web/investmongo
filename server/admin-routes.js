// ============================================================
// ADMIN ROUTES — protected by adminMiddleware
// ============================================================
import { Router } from 'express';
import { db }     from './database.js';
import { adminMiddleware } from './auth.js';
import { syncUserGains, scanAllDeposits } from './wallet-manager.js';

const router = Router();

// ── GET /api/admin/stats ──────────────────────────────────────
router.get('/api/admin/stats', adminMiddleware, (req, res) => {
  try {
    const totalUsersRow = db.prepare(`SELECT COUNT(*) AS count FROM users`).get();
    const totalAUMRow   = db.prepare(
      `SELECT COALESCE(SUM(deposited_usd), 0) AS total FROM user_balances`
    ).get();
    const totalGainRow  = db.prepare(
      `SELECT COALESCE(SUM(total_gain_usd), 0) AS total FROM user_balances`
    ).get();
    const pendingWRow   = db.prepare(
      `SELECT COUNT(*) AS count FROM client_withdrawals WHERE status = 'pending'`
    ).get();
    const pendingWAmtRow = db.prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) AS total FROM client_withdrawals WHERE status = 'pending'`
    ).get();

    // Platform profit = bot P&L total - gain paid to users
    const botPnlRow = db.prepare(
      `SELECT COALESCE(SUM(pnl_usd), 0) AS total FROM trades WHERE status IN ('CLOSED','STOPPED') AND mode = 'PAPER'`
    ).get();

    const platformProfit = Math.max(
      0,
      (botPnlRow?.total || 0) - (totalGainRow?.total || 0)
    );

    res.json({
      totalUsers:          totalUsersRow?.count          || 0,
      totalAUM:            totalAUMRow?.total             || 0,
      totalGainPaid:       totalGainRow?.total            || 0,
      platformProfit:      parseFloat(platformProfit.toFixed(2)),
      pendingWithdrawals:  pendingWRow?.count             || 0,
      pendingWithdrawalsAmt: pendingWAmtRow?.total        || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/admin/users ──────────────────────────────────────
router.get('/api/admin/users', adminMiddleware, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT
        u.id, u.name, u.email, u.wallet_address, u.avatar,
        u.auth_provider, u.tier, u.tier_pct, u.lock_months,
        u.lock_until, u.is_admin, u.created_at, u.deposit_address,
        COALESCE(ub.deposited_usd, 0)       AS deposited_usd,
        COALESCE(ub.visible_balance_usd, 0) AS visible_balance_usd,
        COALESCE(ub.total_gain_usd, 0)      AS total_gain_usd,
        COALESCE(ub.monthly_gain_usd, 0)    AS monthly_gain_usd,
        ub.last_updated
      FROM users u
      LEFT JOIN user_balances ub ON ub.user_id = u.id
      ORDER BY u.created_at DESC
    `).all();

    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/admin/deposits ───────────────────────────────────
router.get('/api/admin/deposits', adminMiddleware, (req, res) => {
  try {
    const deposits = db.prepare(`
      SELECT
        cd.*,
        u.name AS user_name,
        u.email AS user_email
      FROM client_deposits cd
      JOIN users u ON u.id = cd.user_id
      ORDER BY cd.deposited_at DESC
      LIMIT 200
    `).all();

    res.json({ deposits });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/admin/withdrawals ────────────────────────────────
router.get('/api/admin/withdrawals', adminMiddleware, (req, res) => {
  try {
    const withdrawals = db.prepare(`
      SELECT
        cw.*,
        u.name  AS user_name,
        u.email AS user_email
      FROM client_withdrawals cw
      JOIN users u ON u.id = cw.user_id
      ORDER BY cw.requested_at DESC
      LIMIT 200
    `).all();

    res.json({ withdrawals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/admin/withdrawals/:id/approve ───────────────────
// body: { tx_hash }
router.post('/api/admin/withdrawals/:id/approve', adminMiddleware, (req, res) => {
  const id       = parseInt(req.params.id);
  const { tx_hash } = req.body;

  if (!tx_hash) return res.status(400).json({ error: 'tx_hash required' });

  try {
    const withdrawal = db.prepare(`SELECT * FROM client_withdrawals WHERE id = ?`).get(id);
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: `Cannot approve — current status: ${withdrawal.status}` });
    }

    db.prepare(`
      UPDATE client_withdrawals
      SET status       = 'sent',
          tx_hash      = ?,
          processed_at = datetime('now')
      WHERE id = ?
    `).run(tx_hash, id);

    // Deduct from deposited_usd as well (funds have left)
    db.prepare(`
      UPDATE user_balances
      SET deposited_usd = MAX(0, deposited_usd - ?),
          last_updated  = datetime('now')
      WHERE user_id = ?
    `).run(withdrawal.amount_usd, withdrawal.user_id);

    res.json({ ok: true, id, status: 'sent' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/admin/withdrawals/:id/reject ────────────────────
// body: { note? }
router.post('/api/admin/withdrawals/:id/reject', adminMiddleware, (req, res) => {
  const id     = parseInt(req.params.id);
  const { note } = req.body;

  try {
    const withdrawal = db.prepare(`SELECT * FROM client_withdrawals WHERE id = ?`).get(id);
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: `Cannot reject — current status: ${withdrawal.status}` });
    }

    db.prepare(`
      UPDATE client_withdrawals
      SET status       = 'rejected',
          admin_note   = ?,
          processed_at = datetime('now')
      WHERE id = ?
    `).run(note || null, id);

    // Refund the held balance back to user
    db.prepare(`
      UPDATE user_balances
      SET visible_balance_usd = visible_balance_usd + ?,
          last_updated        = datetime('now')
      WHERE user_id = ?
    `).run(withdrawal.amount_usd, withdrawal.user_id);

    res.json({ ok: true, id, status: 'rejected' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/admin/users/:id/credit ─────────────────────────
// body: { amount_usd, note? }
router.post('/api/admin/users/:id/credit', adminMiddleware, (req, res) => {
  const userId   = parseInt(req.params.id);
  const { amount_usd, note } = req.body;

  if (amount_usd === undefined || isNaN(amount_usd)) {
    return res.status(400).json({ error: 'amount_usd required (can be negative to debit)' });
  }

  try {
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const existing = db.prepare(`SELECT * FROM user_balances WHERE user_id = ?`).get(userId);

    if (existing) {
      db.prepare(`
        UPDATE user_balances
        SET visible_balance_usd = MAX(0, visible_balance_usd + ?),
            total_gain_usd      = CASE WHEN ? > 0 THEN total_gain_usd + ? ELSE total_gain_usd END,
            last_updated        = datetime('now')
        WHERE user_id = ?
      `).run(amount_usd, amount_usd, amount_usd, userId);
    } else {
      db.prepare(`
        INSERT INTO user_balances (user_id, deposited_usd, visible_balance_usd, total_gain_usd, monthly_gain_usd)
        VALUES (?, 0, MAX(0, ?), MAX(0, ?), 0)
      `).run(userId, amount_usd, amount_usd > 0 ? amount_usd : 0);
    }

    const balance = db.prepare(`SELECT * FROM user_balances WHERE user_id = ?`).get(userId);

    console.log(`[ADMIN] Credit: user ${userId} adjusted by $${amount_usd}${note ? ` — ${note}` : ''}`);
    res.json({ ok: true, balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/admin/gains/sync ────────────────────────────────
router.post('/api/admin/gains/sync', adminMiddleware, async (req, res) => {
  try {
    await syncUserGains();
    res.json({ synced: true, synced_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/admin/deposits/scan ────────────────────────────
router.post('/api/admin/deposits/scan', adminMiddleware, async (req, res) => {
  try {
    await scanAllDeposits();
    res.json({ scanned: true, scanned_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
