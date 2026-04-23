// ── Belong Move-In Dashboard — Supabase client + auth ────────────────────────
// Loaded on every page AFTER the supabase-js UMD bundle.

const SUPABASE_URL      = 'https://zfpaddrjgedsggnoldyb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmcGFkZHJqZ2Vkc2dnbm9sZHliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNTQ1ODEsImV4cCI6MjA4ODkzMDU4MX0.OBnHlVhP-HEaeENMSIucT9Zyz01WEJpIkmNO5yZGGkM';

const ADMIN_EMAIL    = 'guillen.onela@belonghome.com';
const TAMI_EMAIL     = 'epelbaum.tamara@belonghome.com';
const ALLOWED_DOMAIN = '@belonghome.com';

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
  if (adminOnly && email !== ADMIN_EMAIL) {
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
    window.addEventListener(ev, resetIdleTimer, { passive: true })
  );
  resetIdleTimer();
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
