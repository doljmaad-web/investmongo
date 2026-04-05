// ============================================================
// AUTH — JWT helpers, Google OAuth, GitHub OAuth, MetaMask
// ============================================================
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const JWT_EXPIRES = '30d';

// ── JWT ──────────────────────────────────────────────────────

export function signJWT(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

export function verifyJWT(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Express middleware — reads Bearer token from Authorization header.
 * Attaches decoded payload to req.user or returns 401.
 */
export function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const payload = verifyJWT(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = payload;
  next();
}

/**
 * Express middleware — requires authMiddleware first.
 * Checks req.user.is_admin, returns 403 if not admin.
 */
export function adminMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const payload = verifyJWT(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  if (!payload.is_admin) return res.status(403).json({ error: 'Admin access required' });
  req.user = payload;
  next();
}

// ── Google OAuth ─────────────────────────────────────────────

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

/**
 * Returns the Google OAuth authorization URL.
 * @param {string} redirectUri  e.g. https://yourapp.up.railway.app/auth
 */
export function getGoogleAuthUrl(redirectUri) {
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'online',
    prompt:        'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Exchanges an auth code for user info.
 * @returns {{ id, email, name, picture }}
 */
export async function googleExchange(code, redirectUri) {
  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Google token exchange failed: ${err}`);
  }

  const { access_token } = await tokenRes.json();

  // Fetch user info
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (!userRes.ok) throw new Error('Failed to fetch Google user info');

  const { id, email, name, picture } = await userRes.json();
  return { id, email, name, picture };
}

// ── GitHub OAuth ─────────────────────────────────────────────

const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID     || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';

/**
 * Returns the GitHub OAuth authorization URL.
 * @param {string} redirectUri
 */
export function getGithubAuthUrl(redirectUri) {
  const params = new URLSearchParams({
    client_id:    GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope:        'read:user user:email',
    state:        'github',
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

/**
 * Exchanges a GitHub auth code for user info.
 * @returns {{ id, login, name, avatar_url, email }}
 */
export async function githubExchange(code, redirectUri) {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify({
      client_id:     GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri:  redirectUri,
    }),
  });

  if (!tokenRes.ok) throw new Error('GitHub token exchange failed');
  const { access_token, error } = await tokenRes.json();
  if (error) throw new Error(`GitHub OAuth error: ${error}`);

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${access_token}`,
      'User-Agent':  'DeFiMongo-App',
    },
  });

  if (!userRes.ok) throw new Error('Failed to fetch GitHub user info');
  const userData = await userRes.json();

  // Try to get primary email if not public
  let email = userData.email;
  if (!email) {
    try {
      const emailRes = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${access_token}`,
          'User-Agent':  'DeFiMongo-App',
        },
      });
      if (emailRes.ok) {
        const emails = await emailRes.json();
        const primary = emails.find(e => e.primary && e.verified);
        email = primary ? primary.email : (emails[0]?.email || null);
      }
    } catch {}
  }

  return {
    id:         String(userData.id),
    login:      userData.login,
    name:       userData.name || userData.login,
    avatar_url: userData.avatar_url,
    email,
  };
}

// ── MetaMask signature verification ──────────────────────────

// In-memory nonce store: address → { nonce, expires }
const nonceStore = new Map();
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generates and stores a nonce for a given address.
 * @param {string} address  checksummed or lowercase Ethereum address
 * @returns {string}        the nonce
 */
export function generateNonce(address) {
  // Clean up expired nonces
  const now = Date.now();
  for (const [addr, entry] of nonceStore.entries()) {
    if (entry.expires < now) nonceStore.delete(addr);
  }

  const nonce = `DeFiMongo login nonce: ${Math.random().toString(36).slice(2)}:${now}`;
  nonceStore.set(address.toLowerCase(), { nonce, expires: now + NONCE_TTL_MS });
  return nonce;
}

/**
 * Verifies a MetaMask personal_sign signature against a stored nonce.
 * @param {string} address    the address that claimed to sign
 * @param {string} signature  hex signature from personal_sign
 * @param {string} nonce      the nonce that was signed
 * @returns {boolean}
 */
export function verifyMetaMaskSignature(address, signature, nonce) {
  try {
    const key = address.toLowerCase();
    const stored = nonceStore.get(key);

    if (!stored) return false;
    if (stored.nonce !== nonce) return false;
    if (stored.expires < Date.now()) {
      nonceStore.delete(key);
      return false;
    }

    const recovered = ethers.verifyMessage(nonce, signature);
    const valid = recovered.toLowerCase() === key;

    // Consume the nonce regardless
    nonceStore.delete(key);
    return valid;
  } catch {
    return false;
  }
}
