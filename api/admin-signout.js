// Vercel serverless function — admin force-signout
// POST /api/admin-signout
// Headers: Authorization: Bearer <caller access_token>
// Body:    { userId: string }
//
// 1. Verifies caller's JWT via Supabase auth
// 2. Checks caller is in ADMIN_EMAILS
// 3. Calls Supabase admin API to revoke target user's refresh tokens

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zfpaddrjgedsggnoldyb.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ADMIN_EMAILS = new Set([
  'guillen.onela@belonghome.com',
  'quiroga.veronica@belonghome.com'
]);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Server missing SUPABASE_SERVICE_ROLE_KEY' });
    return;
  }

  // Parse body (Vercel Node runtime auto-parses JSON when content-type is set,
  // but be defensive)
  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch { body = {}; }
  }
  const { userId } = body || {};
  if (!userId) {
    res.status(400).json({ error: 'Missing userId' });
    return;
  }

  // 1. Verify caller
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }

  let callerEmail = '';
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`
      }
    });
    if (!userRes.ok) {
      res.status(401).json({ error: 'Invalid caller token' });
      return;
    }
    const userJson = await userRes.json();
    callerEmail = (userJson.email || '').toLowerCase();
  } catch (e) {
    res.status(401).json({ error: 'Token verification failed' });
    return;
  }

  if (!ADMIN_EMAILS.has(callerEmail)) {
    res.status(403).json({ error: 'Not an admin' });
    return;
  }

  // 2. Revoke target user's sessions (global = all refresh tokens)
  try {
    const logoutRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}/logout`,
      {
        method: 'POST',
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ scope: 'global' })
      }
    );
    if (!logoutRes.ok) {
      const text = await logoutRes.text();
      res.status(502).json({ error: 'Admin signout failed', detail: text });
      return;
    }
  } catch (e) {
    res.status(502).json({ error: 'Network error', detail: String(e) });
    return;
  }

  res.status(200).json({ ok: true });
};
