// ── Shared auth config ────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://zfpaddrjgedsggnoldyb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmcGFkZHJqZ2Vkc2dnbm9sZHliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNTQ1ODEsImV4cCI6MjA4ODkzMDU4MX0.OBnHlVhP-HEaeENMSIucT9Zyz01WEJpIkmNO5yZGGkM';
const ADMIN_EMAIL    = 'guillen.onela@belonghome.com';
const ALLOWED_DOMAIN = '@belonghome.com';

// ── Supabase client (supabase-js loaded via CDN before this file) ─────────────
const { createClient } = window.supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Auth guard ────────────────────────────────────────────────────────────────
// Call at the top of any protected page.
// adminOnly = true  → only guillen.onela@belonghome.com gets through
// adminOnly = false → any @belonghome.com user gets through
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

// ── Sign out ──────────────────────────────────────────────────────────────────
async function signOut() {
  await sb.auth.signOut();
  window.location.replace('/login');
}

// ── Sign in with Google ───────────────────────────────────────────────────────
async function signInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
      queryParams: { hd: 'belonghome.com' } // hints Google to show Belong accounts first
    }
  });
  if (error) console.error('Sign-in error:', error.message);
}

// ── Get current user email ────────────────────────────────────────────────────
async function getCurrentUser() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.user || null;
}
