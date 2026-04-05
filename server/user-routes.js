// ============================================================
// USER ROUTES — Auth (Google, GitHub, MetaMask) + Portfolio API
// ============================================================
import { Router } from 'express';
import { db }     from './database.js';
import {
  signJWT,
  authMiddleware,
  getGoogleAuthUrl,
  googleExchange,
  getGithubAuthUrl,
  githubExchange,
  generateNonce,
  verifyMetaMaskSignature,
} from './auth.js';
import { generateDepositAddress } from './wallet-manager.js';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────

/**
 * Gets the next available deposit_index (max existing + 1, or 0).
 */
function getNextDepositIndex() {
  const row = db.prepare(
    `SELECT COALESCE(MAX(deposit_index), -1) + 1 AS next_index FROM users`
  ).get();
  return row ? row.next_index : 0;
}

/**
 * Creates user_balances row for a new user if not already exists.
 */
function ensureUserBalance(userId) {
  const existing = db.prepare(`SELECT id FROM user_balances WHERE user_id = ?`).get(userId);
  if (!existing) {
    db.prepare(`
      INSERT INTO user_balances (user_id, deposited_usd, visible_balance_usd, total_gain_usd, monthly_gain_usd)
      VALUES (?, 0, 0, 0, 0)
    `).run(userId);
  }
}

/**
 * Assigns a unique Arbitrum deposit address to a new user.
 */
function assignDepositAddress(userId) {
  if (!userId) { console.error('[AUTH] assignDepositAddress: no userId'); return null; }
  try {
    const index   = getNextDepositIndex();
    const address = generateDepositAddress(index);
    db.prepare(`
      UPDATE users SET deposit_address = ?, deposit_index = ? WHERE id = ?
    `).run(address, index, userId);
    return address;
  } catch (err) {
    console.error('[USER-ROUTES] assignDepositAddress error:', err.message);
    return null;
  }
}

/**
 * Builds the JWT payload from a user row.
 */
function buildJwtPayload(user) {
  return {
    id:             user.id,
    name:           user.name,
    email:          user.email || null,
    wallet_address: user.wallet_address || null,
    is_admin:       !!user.is_admin,
    tier:           user.tier || 'flexible',
    tier_pct:       user.tier_pct || 9,
  };
}

/**
 * Fetches balance info for a user.
 */
function getUserBalance(userId) {
  return db.prepare(`SELECT * FROM user_balances WHERE user_id = ?`).get(userId) || {
    deposited_usd:       0,
    visible_balance_usd: 0,
    total_gain_usd:      0,
    monthly_gain_usd:    0,
  };
}

// ── Google OAuth ──────────────────────────────────────────────

// GET /api/auth/google/url
router.get('/api/auth/google/url', (req, res) => {
  const redirectUri = req.query.redirect_uri || `${req.protocol}://${req.get('host')}/auth`;
  try {
    const url = getGoogleAuthUrl(redirectUri);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/google/callback?code=&redirect_uri=
router.get('/api/auth/google/callback', async (req, res) => {
  const { code, redirect_uri } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  const redirectUri = redirect_uri || `${req.protocol}://${req.get('host')}/auth`;

  try {
    const { id: googleId, email, name, picture } = await googleExchange(code, redirectUri);

    // Find or create user
    let user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);

    if (!user) {
      const info = db.prepare(`
        INSERT INTO users (email, name, avatar, auth_provider)
        VALUES (?, ?, ?, 'google')
      `).run(email, name, picture || null);

      // sql.js lastInsertRowid can be unreliable — fall back to email lookup
      user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid)
          || db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
      if (!user) throw new Error('Failed to create user account — please try again');
      assignDepositAddress(user.id);
      ensureUserBalance(user.id);
      user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
    } else {
      // Update avatar and name in case they changed
      db.prepare(`UPDATE users SET avatar = ?, name = ? WHERE id = ?`)
        .run(picture || user.avatar, name, user.id);
      if (!user.deposit_address) {
        assignDepositAddress(user.id);
        user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id);
      }
      ensureUserBalance(user.id);
    }

    const token = signJWT(buildJwtPayload(user));
    const safeUser = {
      id:              user.id,
      name:            user.name,
      email:           user.email,
      avatar:          user.avatar,
      is_admin:        !!user.is_admin,
      tier:            user.tier,
      tier_pct:        user.tier_pct,
      deposit_address: user.deposit_address,
    };

    res.json({ token, user: safeUser });
  } catch (e) {
    console.error('[AUTH] Google callback error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GitHub OAuth ──────────────────────────────────────────────

// GET /api/auth/github/url
router.get('/api/auth/github/url', (req, res) => {
  const redirectUri = req.query.redirect_uri || `${req.protocol}://${req.get('host')}/auth`;
  try {
    const url = getGithubAuthUrl(redirectUri);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/github/callback?code=&redirect_uri=
router.get('/api/auth/github/callback', async (req, res) => {
  const { code, redirect_uri } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  const redirectUri = redirect_uri || `${req.protocol}://${req.get('host')}/auth`;

  try {
    const { id: githubId, login, name, avatar_url, email } = await githubExchange(code, redirectUri);

    const adminGithubUsername = (process.env.ADMIN_GITHUB_USERNAME || '').toLowerCase();
    const isAdmin             = login.toLowerCase() === adminGithubUsername ? 1 : 0;

    // Find existing user by github_id or email
    let user = db.prepare(`SELECT * FROM users WHERE github_id = ?`).get(githubId);

    if (!user && email) {
      user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
    }

    if (!user) {
      const info = db.prepare(`
        INSERT INTO users (github_id, email, name, avatar, auth_provider, is_admin)
        VALUES (?, ?, ?, ?, 'github', ?)
      `).run(githubId, email || null, name || login, avatar_url || null, isAdmin);

      user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid)
          || db.prepare(`SELECT * FROM users WHERE github_id = ?`).get(githubId);
      if (!user) throw new Error('Failed to create user account — please try again');
      assignDepositAddress(user.id);
      ensureUserBalance(user.id);
      user = db.prepare(`SELECT * FROM users WHERE github_id = ?`).get(githubId);
    } else {
      // Update GitHub fields + admin status
      db.prepare(`
        UPDATE users SET github_id = ?, avatar = ?, name = ?, is_admin = ? WHERE id = ?
      `).run(githubId, avatar_url || user.avatar, name || login, isAdmin, user.id);

      if (!user.deposit_address) {
        assignDepositAddress(user.id);
      }
      ensureUserBalance(user.id);
      user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id);
    }

    const token = signJWT(buildJwtPayload(user));
    const safeUser = {
      id:              user.id,
      name:            user.name,
      email:           user.email,
      avatar:          user.avatar,
      is_admin:        !!user.is_admin,
      tier:            user.tier,
      tier_pct:        user.tier_pct,
      deposit_address: user.deposit_address,
    };

    res.json({ token, user: safeUser, is_admin: !!user.is_admin });
  } catch (e) {
    console.error('[AUTH] GitHub callback error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── MetaMask Auth ─────────────────────────────────────────────

// POST /api/auth/metamask/nonce
// body: { address }
router.post('/api/auth/metamask/nonce', (req, res) => {
  const { address } = req.body;
  if (!address || typeof address !== 'string') {
    return res.status(400).json({ error: 'address required' });
  }

  const nonce   = generateNonce(address);
  const message = nonce;
  res.json({ nonce, message });
});

// POST /api/auth/metamask/verify
// body: { address, signature, nonce }
router.post('/api/auth/metamask/verify', (req, res) => {
  const { address, signature, nonce } = req.body;
  if (!address || !signature) {
    return res.status(400).json({ error: 'address and signature required' });
  }
  if (!nonce) {
    return res.status(400).json({ error: 'nonce required' });
  }

  const valid = verifyMetaMaskSignature(address, signature, nonce);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid signature or expired nonce' });
  }

  const normalizedAddress = address.toLowerCase();

  try {
  // Find or create user by wallet_address
  let user = db.prepare(`SELECT * FROM users WHERE LOWER(wallet_address) = ?`).get(normalizedAddress);

  if (!user) {
    const checksummed = address; // store as provided (MetaMask sends checksum)
    const info = db.prepare(`
      INSERT INTO users (wallet_address, name, auth_provider)
      VALUES (?, ?, 'metamask')
    `).run(checksummed, `Wallet ${address.slice(0, 6)}...${address.slice(-4)}`);

    user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
    assignDepositAddress(user.id);
    ensureUserBalance(user.id);
    user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id);
  } else {
    if (!user.deposit_address) {
      assignDepositAddress(user.id);
      user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id);
    }
    ensureUserBalance(user.id);
  }

  const token = signJWT(buildJwtPayload(user));
  const safeUser = {
    id:              user.id,
    name:            user.name,
    email:           user.email,
    avatar:          user.avatar,
    wallet_address:  user.wallet_address,
    is_admin:        !!user.is_admin,
    tier:            user.tier,
    tier_pct:        user.tier_pct,
    deposit_address: user.deposit_address,
  };

  res.json({ token, user: safeUser });
  } catch (e) {
    console.error('[AUTH] MetaMask verify error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/auth/me ──────────────────────────────────────────────

// GET /api/auth/me
router.get('/api/auth/me', authMiddleware, (req, res) => {
  try {
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const balance = getUserBalance(user.id);

    res.json({
      user: {
        id:              user.id,
        name:            user.name,
        email:           user.email,
        avatar:          user.avatar,
        wallet_address:  user.wallet_address,
        is_admin:        !!user.is_admin,
        tier:            user.tier,
        tier_pct:        user.tier_pct,
        lock_months:     user.lock_months,
        lock_until:      user.lock_until,
        deposit_address: user.deposit_address,
        auth_provider:   user.auth_provider,
        created_at:      user.created_at,
      },
      balance,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Portfolio routes ──────────────────────────────────────────

// GET /api/portfolio/summary
router.get('/api/portfolio/summary', authMiddleware, (req, res) => {
  try {
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const balance     = getUserBalance(user.id);
    const deposits    = db.prepare(
      `SELECT * FROM client_deposits WHERE user_id = ? ORDER BY deposited_at DESC LIMIT 10`
    ).all(user.id);
    const withdrawals = db.prepare(
      `SELECT * FROM client_withdrawals WHERE user_id = ? ORDER BY requested_at DESC LIMIT 10`
    ).all(user.id);

    const gainPct = balance.deposited_usd > 0
      ? ((balance.total_gain_usd / balance.deposited_usd) * 100).toFixed(2)
      : '0.00';

    const tierInfo = {
      tier:        user.tier,
      tier_pct:    user.tier_pct,
      lock_months: user.lock_months,
      lock_until:  user.lock_until,
      is_locked:   user.tier === 'locked' && user.lock_until && new Date(user.lock_until) > new Date(),
    };

    res.json({ balance, deposits, withdrawals, tier_info: tierInfo, gain_pct: gainPct });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/portfolio/deposit
// body: { amount_usd, token, tx_hash?, tier?, lock_months? }
router.post('/api/portfolio/deposit', authMiddleware, (req, res) => {
  const { amount_usd, token, tx_hash, tier, lock_months } = req.body;

  if (!amount_usd || isNaN(amount_usd) || amount_usd <= 0) {
    return res.status(400).json({ error: 'Invalid amount_usd' });
  }

  try {
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Handle tier upgrade if provided
    if (tier && ['flexible', 'locked'].includes(tier)) {
      const months = parseInt(lock_months) || 0;

      let tierPct = 9;
      if (tier === 'locked') {
        if      (months === 3)  tierPct = 10;
        else if (months === 6)  tierPct = 14;
        else if (months === 12) tierPct = 18;
        else return res.status(400).json({ error: 'lock_months must be 3, 6, or 12 for locked tier' });
      }

      let lockUntil = null;
      if (tier === 'locked') {
        const now       = new Date();
        const unlockDate = new Date(now);
        unlockDate.setMonth(unlockDate.getMonth() + months);
        lockUntil = unlockDate.toISOString();
      }

      db.prepare(`
        UPDATE users
        SET tier = ?, tier_pct = ?, lock_months = ?, lock_until = ?
        WHERE id = ?
      `).run(tier, tierPct, months, lockUntil, user.id);
    }

    // Record the deposit
    const txHashValue = tx_hash || `manual_${user.id}_${Date.now()}`;
    db.prepare(`
      INSERT OR IGNORE INTO client_deposits
        (user_id, tx_hash, amount_usd, token, network, status)
      VALUES (?, ?, ?, ?, 'arbitrum', 'confirmed')
    `).run(user.id, txHashValue, amount_usd, token || 'USDC');

    // Update balances
    const existing = db.prepare(`SELECT * FROM user_balances WHERE user_id = ?`).get(user.id);
    if (existing) {
      db.prepare(`
        UPDATE user_balances
        SET deposited_usd       = deposited_usd + ?,
            visible_balance_usd = visible_balance_usd + ?,
            last_updated        = datetime('now')
        WHERE user_id = ?
      `).run(amount_usd, amount_usd, user.id);
    } else {
      db.prepare(`
        INSERT INTO user_balances (user_id, deposited_usd, visible_balance_usd, total_gain_usd, monthly_gain_usd)
        VALUES (?, ?, ?, 0, 0)
      `).run(user.id, amount_usd, amount_usd);
    }

    const balance     = getUserBalance(user.id);
    const updatedUser = db.prepare(`SELECT * FROM users WHERE id = ?`).get(user.id);

    res.json({
      ok:      true,
      balance,
      tier:    updatedUser.tier,
      tier_pct: updatedUser.tier_pct,
    });
  } catch (e) {
    console.error('[PORTFOLIO] deposit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/portfolio/withdraw
// body: { amount_usd, to_address }
router.post('/api/portfolio/withdraw', authMiddleware, (req, res) => {
  const { amount_usd, to_address } = req.body;

  if (!amount_usd || isNaN(amount_usd) || amount_usd <= 0) {
    return res.status(400).json({ error: 'Invalid amount_usd' });
  }
  if (!to_address || typeof to_address !== 'string') {
    return res.status(400).json({ error: 'to_address required' });
  }

  try {
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check lock status
    if (user.tier === 'locked' && user.lock_until) {
      const lockExpiry = new Date(user.lock_until);
      if (lockExpiry > new Date()) {
        const formattedDate = lockExpiry.toLocaleDateString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric',
        });
        return res.status(403).json({
          error: `Funds are locked until ${formattedDate}`,
          locked_until: user.lock_until,
        });
      }
    }

    // Check balance
    const balance = getUserBalance(user.id);
    if (amount_usd > balance.visible_balance_usd) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Create withdrawal request
    db.prepare(`
      INSERT INTO client_withdrawals (user_id, amount_usd, to_address, status)
      VALUES (?, ?, ?, 'pending')
    `).run(user.id, amount_usd, to_address);

    // Deduct from visible balance immediately (holds funds)
    db.prepare(`
      UPDATE user_balances
      SET visible_balance_usd = visible_balance_usd - ?,
          last_updated        = datetime('now')
      WHERE user_id = ?
    `).run(amount_usd, user.id);

    res.json({ ok: true, message: 'Withdrawal request submitted. An admin will process it shortly.' });
  } catch (e) {
    console.error('[PORTFOLIO] withdraw error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/portfolio/history
router.get('/api/portfolio/history', authMiddleware, (req, res) => {
  try {
    const deposits = db.prepare(
      `SELECT *, 'deposit' AS type FROM client_deposits WHERE user_id = ? ORDER BY deposited_at DESC`
    ).all(req.user.id);

    const withdrawals = db.prepare(
      `SELECT *, 'withdrawal' AS type FROM client_withdrawals WHERE user_id = ? ORDER BY requested_at DESC`
    ).all(req.user.id);

    res.json({ deposits, withdrawals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
