// ── Belong Move-In Dashboard — Supabase client + auth ────────────────────────
// Loaded on every page AFTER the supabase-js UMD bundle.

const SUPABASE_URL      = 'https://zfpaddrjgedsggnoldyb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmcGFkZHJqZ2Vkc2dnbm9sZHliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNTQ1ODEsImV4cCI6MjA4ODkzMDU4MX0.OBnHlVhP-HEaeENMSIucT9Zyz01WEJpIkmNO5yZGGkM';

const ADMIN_EMAIL    = 'guillen.onela@belonghome.com';
const ADMIN_EMAILS   = new Set([
  'guillen.onela@belonghome.com',
  'quiroga.veronica@belonghome.com'
]);
const TAMI_EMAIL     = 'epelbaum.tamara@belonghome.com';
const ALLOWED_DOMAIN = '@belonghome.com';

function isAdmin(email) { return ADMIN_EMAILS.has((email || '').toLowerCase()); }

const { createClient } = window.supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Auth guard ───────────────────────────────────────────────────────────────
async function requireAuth(adminOnly = false) {
  const { data: { session } } = await sb.auth.getSession();

  if (!session) {
    window.location.replace('/login');
    return null;
  }
  const email = session.user.email || '';
  if (!email.endsWith(ALLOWED_DOMAIN)) {
    await sb.auth.signOut();
    window.location.replace('/login?error=domain');
    return null;
  }
  if (adminOnly && !isAdmin(email)) {
    window.location.replace('/');
    return null;
  }
  return session;
}

async function signOut() {
  await sb.auth.signOut();
  window.location.replace('/login');
}

async function signInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
      queryParams: { hd: 'belonghome.com' }
    }
  });
  if (error) console.error('Sign-in error:', error.message);
}

// ── 2hr idle auto-logout ─────────────────────────────────────────────────────
const IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours
let idleTimer = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    await sb.auth.signOut();
    window.location.replace('/login?error=idle');
  }, IDLE_MS);
}

function startIdleWatcher() {
  ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(ev =>
    window.addEventListener(ev, () => { resetIdleTimer(); markPresenceActive(); }, { passive: true })
  );
  resetIdleTimer();
}

// ── Presence tracking (who's online, active/idle, force-logout) ──────────────
const PRESENCE_CHANNEL  = 'online-users';
const PRESENCE_IDLE_MS  = 5 * 60 * 1000; // 5 min inactivity = idle
let   presenceChannel   = null;
let   presenceActivityTimer = null;
let   presenceStatus    = 'active';
let   presenceUser      = null;

async function startPresence(session, opts = {}) {
  const user = session?.user;
  if (!user) return;
  presenceUser = {
    id:    user.id,
    email: user.email,
    name:  user.user_metadata?.full_name || user.email,
    avatar: user.user_metadata?.avatar_url || '',
    page:  location.pathname,
    status: 'active',
    since: Date.now()
  };

  presenceChannel = sb.channel(PRESENCE_CHANNEL, {
    config: { presence: { key: user.email } }
  });

  // Attach listeners BEFORE subscribe
  presenceChannel.on('broadcast', { event: 'force-signout' }, ({ payload }) => {
    if ((payload?.email || '').toLowerCase() === (user.email || '').toLowerCase()) {
      sb.auth.signOut().finally(() => window.location.replace('/login?error=kicked'));
    }
  });

  if (typeof opts.onSync === 'function') {
    presenceChannel.on('presence', { event: 'sync' },  opts.onSync);
    presenceChannel.on('presence', { event: 'join' },  opts.onSync);
    presenceChannel.on('presence', { event: 'leave' }, opts.onSync);
  }

  presenceChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await presenceChannel.track(presenceUser);
      if (typeof opts.onSync === 'function') opts.onSync();
    }
  });

  scheduleIdleMark();
  window.addEventListener('beforeunload', () => {
    try { presenceChannel?.untrack(); } catch {}
  });
}

function scheduleIdleMark() {
  if (presenceActivityTimer) clearTimeout(presenceActivityTimer);
  presenceActivityTimer = setTimeout(() => {
    if (!presenceChannel || !presenceUser) return;
    presenceStatus = 'idle';
    presenceUser = { ...presenceUser, status: 'idle', since: Date.now() };
    presenceChannel.track(presenceUser).catch(() => {});
  }, PRESENCE_IDLE_MS);
}

function markPresenceActive() {
  if (!presenceChannel || !presenceUser) return;
  if (presenceStatus !== 'active') {
    presenceStatus = 'active';
    presenceUser = { ...presenceUser, status: 'active', since: Date.now() };
    presenceChannel.track(presenceUser).catch(() => {});
  }
  scheduleIdleMark();
}

// Admin force-signout via Vercel function (revokes refresh tokens server-side)
// Also broadcasts so the target's tab logs out immediately instead of waiting
// for the next token refresh.
async function adminSignOutUser({ userId, email }) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Not signed in');

  const res = await fetch('/api/admin-signout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ userId })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = [err.error, err.detail].filter(Boolean).join(' — ');
    throw new Error(msg || `HTTP ${res.status}`);
  }

  // Also tell their tab to redirect now (token revoke on Supabase side will
  // invalidate the refresh token; the broadcast gives instant UX).
  if (presenceChannel && email) {
    presenceChannel.send({
      type: 'broadcast',
      event: 'force-signout',
      payload: { email }
    }).catch(() => {});
  }
}

// ── Toast (shared) ───────────────────────────────────────────────────────────
function showToast(msg, type = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = 'toast', 3500);
}
