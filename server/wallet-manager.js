// ============================================================
// WALLET MANAGER — HD wallet derivation, deposit scanning,
// and proportional gain sync
// ============================================================
import { ethers } from 'ethers';
import { db }     from './database.js';

const ARBITRUM_RPC   = process.env.ARBITRUM_RPC || 'https://arb1.arbitrum.io/rpc';
const MASTER_MNEMONIC = process.env.MASTER_MNEMONIC || '';

// Arbitrum token contracts
const USDC_CONTRACT = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // 6 decimals
const USDT_CONTRACT = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'; // 6 decimals on Arbitrum

// ERC-20 ABI — balanceOf + transfer
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

// ── Sweep helper ─────────────────────────────────────────────
function deriveWallet(index, provider) {
  const mnemonic = process.env.MASTER_MNEMONIC;
  if (!mnemonic) throw new Error('MASTER_MNEMONIC not set');
  return ethers.HDNodeWallet.fromPhrase(
    mnemonic, undefined, `m/44'/60'/0'/0/${index}`
  ).connect(provider);
}

// ── HD Wallet ─────────────────────────────────────────────────

/**
 * Derives a deposit address for the given user index from the master mnemonic.
 * Uses the standard BIP-44 path: m/44'/60'/0'/0/{index}
 * All addresses are on Arbitrum (same address space as Ethereum).
 * @param {number} userIndex
 * @returns {string} checksummed Ethereum/Arbitrum address
 */
export function generateDepositAddress(userIndex) {
  if (!MASTER_MNEMONIC) {
    throw new Error('MASTER_MNEMONIC env var is not set');
  }
  const hdNode = ethers.HDNodeWallet.fromPhrase(
    MASTER_MNEMONIC,
    undefined,
    `m/44'/60'/0'/0/${userIndex}`
  );
  return hdNode.address;
}

// ── ETH price from Hyperliquid ────────────────────────────────

/**
 * Fetches ETH price from Hyperliquid.
 * @returns {Promise<number>}
 */
export async function getUserETHPrice() {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'allMids' }),
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HL API ${res.status}`);
    const mids = await res.json();
    const price = parseFloat(mids['ETH'] || mids['eth'] || 0);
    return price || 2500; // fallback if API changes
  } catch (err) {
    console.error('[WALLET] ETH price fetch error:', err.message);
    return 2500; // safe fallback
  }
}

// ── Deposit scanning ──────────────────────────────────────────

/**
 * Checks all token balances at a user's deposit address and records
 * any new deposits in client_deposits + updates user_balances.
 * @param {{ id, deposit_address }} user
 */
export async function checkUserDeposits(user) {
  if (!user.deposit_address) return;

  try {
    const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);

    // ETH balance
    const ethBalance = await provider.getBalance(user.deposit_address);
    const ethAmt     = parseFloat(ethers.formatEther(ethBalance));

    // USDC balance (6 decimals)
    const usdcContract = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, provider);
    const usdcRaw      = await usdcContract.balanceOf(user.deposit_address);
    const usdcAmt      = parseFloat(ethers.formatUnits(usdcRaw, 6));

    // USDT balance (6 decimals on Arbitrum)
    const usdtContract = new ethers.Contract(USDT_CONTRACT, ERC20_ABI, provider);
    const usdtRaw      = await usdtContract.balanceOf(user.deposit_address);
    const usdtAmt      = parseFloat(ethers.formatUnits(usdtRaw, 6));

    // Get ETH price
    const ethPrice = await getUserETHPrice();

    // Total USD value currently sitting at the deposit address
    const totalUsd = (ethAmt * ethPrice) + usdcAmt + usdtAmt;

    // Sum of all confirmed deposits on record
    const confirmedRow = db.prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) AS total FROM client_deposits WHERE user_id = ? AND status = 'confirmed'`
    ).get(user.id);
    const confirmedTotal = confirmedRow ? confirmedRow.total : 0;

    const newFunds = totalUsd - confirmedTotal;

    // Only record if meaningful (ignore dust < $0.50)
    if (newFunds > 0.5) {
      // Determine which token has new funds (prioritize stablecoins)
      let token = 'ETH';
      let amountNative = ethAmt;

      if (usdcAmt - confirmedTotal > 0.5) {
        token         = 'USDC';
        amountNative  = usdcAmt;
      } else if (usdtAmt - confirmedTotal > 0.5) {
        token         = 'USDT';
        amountNative  = usdtAmt;
      }

      // Insert deposit record (no tx_hash for balance-based detection)
      const txHashPlaceholder = `auto_${user.id}_${Date.now()}`;
      db.prepare(`
        INSERT OR IGNORE INTO client_deposits
          (user_id, tx_hash, amount_native, amount_usd, token, network, status)
        VALUES (?, ?, ?, ?, ?, 'arbitrum', 'confirmed')
      `).run(user.id, txHashPlaceholder, amountNative, newFunds, token);

      // Upsert user_balances
      const existing = db.prepare(
        `SELECT * FROM user_balances WHERE user_id = ?`
      ).get(user.id);

      if (existing) {
        db.prepare(`
          UPDATE user_balances
          SET deposited_usd       = deposited_usd + ?,
              visible_balance_usd = visible_balance_usd + ?,
              last_updated        = datetime('now')
          WHERE user_id = ?
        `).run(newFunds, newFunds, user.id);
      } else {
        db.prepare(`
          INSERT INTO user_balances (user_id, deposited_usd, visible_balance_usd, total_gain_usd, monthly_gain_usd)
          VALUES (?, ?, ?, 0, 0)
        `).run(user.id, newFunds, newFunds);
      }

      console.log(`[WALLET] New deposit detected for user ${user.id}: $${newFunds.toFixed(2)} ${token}`);
    }
  } catch (err) {
    console.error(`[WALLET] checkUserDeposits error for user ${user.id}:`, err.message);
  }
}

/**
 * Scans deposits for all users who have a deposit_address assigned.
 */
export async function scanAllDeposits() {
  try {
    const users = db.prepare(
      `SELECT id, deposit_address FROM users WHERE deposit_address IS NOT NULL`
    ).all();

    console.log(`[WALLET] Scanning deposits for ${users.length} users...`);

    for (const user of users) {
      await checkUserDeposits(user);
    }

    console.log('[WALLET] Deposit scan complete');
  } catch (err) {
    console.error('[WALLET] scanAllDeposits error:', err.message);
  }
}

// ── Gain sync ─────────────────────────────────────────────────

/**
 * Mirrors the bot's daily P&L proportionally to all users,
 * capped at each user's tier monthly rate, with platform keeping excess.
 */
export async function syncUserGains() {
  try {
    // Get last 24h bot P&L
    const pnlRow = db.prepare(`
      SELECT COALESCE(SUM(pnl_usd), 0) AS total_pnl
      FROM trades
      WHERE status IN ('CLOSED','STOPPED')
        AND mode = 'PAPER'
        AND closed_at >= datetime('now', '-1 day')
    `).get();

    const totalBotPnl = pnlRow ? pnlRow.total_pnl : 0;

    if (totalBotPnl <= 0) {
      console.log('[GAINS] No positive P&L to distribute today');
      return;
    }

    // Get total portfolio value for % calculation
    const portfolioRow = db.prepare(`
      SELECT total_value FROM portfolio_snapshots ORDER BY snapshot_at DESC LIMIT 1
    `).get();
    const totalPortfolioValue = Math.max(portfolioRow ? portfolioRow.total_value : 1, 1);

    const dailyPnlPct = totalBotPnl / totalPortfolioValue;

    console.log(`[GAINS] Bot daily P&L: $${totalBotPnl.toFixed(2)} (${(dailyPnlPct * 100).toFixed(4)}%)`);

    // Get all users with balances, joined to tier info
    const balances = db.prepare(`
      SELECT ub.*, u.tier, u.tier_pct, u.lock_months
      FROM user_balances ub
      JOIN users u ON u.id = ub.user_id
    `).all();

    let totalPlatformProfit = 0;

    for (const balance of balances) {
      if (!balance.visible_balance_usd || balance.visible_balance_usd <= 0) continue;

      // Raw daily gain proportional to bot performance
      const rawDailyGain = balance.visible_balance_usd * dailyPnlPct;

      // Monthly cap: tier_pct is monthly %, divide by 30 for daily
      const dailyCapRate         = (balance.tier_pct || 9) / 100 / 30;
      const dailyCapAmount       = balance.deposited_usd * dailyCapRate;
      const monthlyCapTotal      = (balance.deposited_usd * (balance.tier_pct || 9)) / 100;
      const monthlyAlreadyEarned = balance.monthly_gain_usd || 0;
      const monthlyRemaining     = Math.max(0, monthlyCapTotal - monthlyAlreadyEarned);

      // Actual gain is min of raw gain and remaining monthly cap
      const actualGain       = Math.min(rawDailyGain, Math.max(0, monthlyRemaining));
      const platformProfit   = rawDailyGain - actualGain;
      totalPlatformProfit   += platformProfit;

      if (actualGain <= 0) continue;

      db.prepare(`
        UPDATE user_balances
        SET visible_balance_usd = visible_balance_usd + ?,
            total_gain_usd      = total_gain_usd + ?,
            monthly_gain_usd    = monthly_gain_usd + ?,
            last_updated        = datetime('now')
        WHERE user_id = ?
      `).run(actualGain, actualGain, actualGain, balance.user_id);
    }

    console.log(`[GAINS] Sync complete. Platform profit kept: $${totalPlatformProfit.toFixed(2)}`);

    // Reset monthly gains on the 1st of each month
    const today = new Date();
    if (today.getDate() === 1) {
      db.prepare(`
        UPDATE user_balances
        SET monthly_gain_usd = 0,
            gain_reset_at    = datetime('now')
      `).run();
      console.log('[GAINS] Monthly gain counters reset (1st of month)');
    }

  } catch (err) {
    console.error('[GAINS] syncUserGains error:', err.message);
  }
}

// ── Sweep all deposit addresses → master wallet ───────────────
/**
 * Sweeps ETH, USDC, and USDT from every user's derived deposit address
 * into the destination address (set via SWEEP_TO_ADDRESS env var).
 * Sends tokens first, then remaining ETH minus gas.
 */
export async function sweepAllFunds(destinationAddress) {
  const mnemonic = process.env.MASTER_MNEMONIC;
  const rpc      = process.env.ARBITRUM_RPC || 'https://arb1.arbitrum.io/rpc';
  if (!mnemonic)          throw new Error('MASTER_MNEMONIC not set');
  if (!destinationAddress) throw new Error('destinationAddress required');

  const provider = new ethers.JsonRpcProvider(rpc);
  const MIN_ETH  = ethers.parseEther('0.000001'); // dust threshold
  const results  = [];
  let   totalSweptUsd = 0;

  const users = db.prepare(
    `SELECT id, deposit_address, deposit_index FROM users
     WHERE deposit_address IS NOT NULL AND deposit_index IS NOT NULL`
  ).all();

  console.log(`[SWEEP] Starting sweep of ${users.length} addresses → ${destinationAddress}`);

  for (const user of users) {
    try {
      const wallet       = deriveWallet(user.deposit_index, provider);
      const ethBal       = await provider.getBalance(wallet.address);
      const usdcContract = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, wallet);
      const usdtContract = new ethers.Contract(USDT_CONTRACT, ERC20_ABI, wallet);
      const usdcBal      = await usdcContract.balanceOf(wallet.address);
      const usdtBal      = await usdtContract.balanceOf(wallet.address);

      if (ethBal < MIN_ETH && usdcBal === 0n && usdtBal === 0n) continue;

      // ── Sweep USDC ──────────────────────────────────────────
      if (usdcBal > 0n) {
        try {
          const tx  = await usdcContract.transfer(destinationAddress, usdcBal);
          await tx.wait();
          const amt = parseFloat(ethers.formatUnits(usdcBal, 6));
          totalSweptUsd += amt;
          results.push({ user_id: user.id, token: 'USDC', amount: amt, tx: tx.hash });
          console.log(`[SWEEP] User ${user.id}: ${amt} USDC swept`);
        } catch (e) {
          results.push({ user_id: user.id, token: 'USDC', error: e.message });
        }
      }

      // ── Sweep USDT ──────────────────────────────────────────
      if (usdtBal > 0n) {
        try {
          const tx  = await usdtContract.transfer(destinationAddress, usdtBal);
          await tx.wait();
          const amt = parseFloat(ethers.formatUnits(usdtBal, 6));
          totalSweptUsd += amt;
          results.push({ user_id: user.id, token: 'USDT', amount: amt, tx: tx.hash });
          console.log(`[SWEEP] User ${user.id}: ${amt} USDT swept`);
        } catch (e) {
          results.push({ user_id: user.id, token: 'USDT', error: e.message });
        }
      }

      // ── Sweep ETH (after tokens, leaving gas buffer) ────────
      const freshEth = await provider.getBalance(wallet.address);
      if (freshEth > MIN_ETH) {
        try {
          const feeData  = await provider.getFeeData();
          const gasPrice = feeData.gasPrice || ethers.parseUnits('0.1', 'gwei');
          const gasCost  = gasPrice * 21000n * 3n; // 3× buffer for safety
          const sweepable = freshEth > gasCost ? freshEth - gasCost : 0n;

          if (sweepable > 0n) {
            const tx  = await wallet.sendTransaction({
              to: destinationAddress, value: sweepable, gasLimit: 21000n,
            });
            await tx.wait();
            const ethAmt    = parseFloat(ethers.formatEther(sweepable));
            const ethPrice  = await getUserETHPrice();
            const usdValue  = ethAmt * ethPrice;
            totalSweptUsd  += usdValue;
            results.push({ user_id: user.id, token: 'ETH', amount: ethAmt, amountUsd: parseFloat(usdValue.toFixed(2)), tx: tx.hash });
            console.log(`[SWEEP] User ${user.id}: ${ethAmt.toFixed(6)} ETH swept (~$${usdValue.toFixed(2)})`);
          }
        } catch (e) {
          results.push({ user_id: user.id, token: 'ETH', error: e.message });
        }
      }

    } catch (err) {
      console.error(`[SWEEP] User ${user.id} error:`, err.message);
      results.push({ user_id: user.id, address: user.deposit_address, error: err.message });
    }
  }

  const summary = {
    results,
    swept_count:    results.filter(r => r.tx).length,
    error_count:    results.filter(r => r.error).length,
    total_swept_usd: parseFloat(totalSweptUsd.toFixed(2)),
    destination:    destinationAddress,
    swept_at:       new Date().toISOString(),
  };
  console.log(`[SWEEP] Done. Swept ~$${totalSweptUsd.toFixed(2)} across ${summary.swept_count} transactions`);
  return summary;
}
