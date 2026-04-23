// ── Belong Move-In Dashboard — Header nav renderer ───────────────────────────
// Usage: mountHeader({ page: 'dashboard' | 'ready' | 'manage', session })
// Injects the header into <div id="appHeader"></div>.

async function mountHeader({ page, session }) {
  const container = document.getElementById('appHeader');
  if (!container) return;

  const user      = session?.user;
  const email     = user?.email || '';
  const isAdmin   = email === ADMIN_EMAIL;
  const fullName  = user?.user_metadata?.full_name || email;
  const avatarUrl = user?.user_metadata?.avatar_url;

  // Subtitle per page
  const subtitle =
    page === 'manage' ? 'Manage' :
    page === 'ready'  ? 'Ready for Sign-Off' :
                        'Move-Ins';

  container.innerHTML = `
    <header class="app-header">
      <div class="logo">
        <svg width="22" height="22" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path d="M20 4L4 14v22h32V14L20 4z" fill="#325E77"/>
          <path d="M14 36V24h12v12" fill="#3EE4A9"/>
        </svg>
        <span class="logo-text">Belong</span>
        <span class="logo-sep">/</span>
        <span class="logo-sub">${subtitle}</span>
      </div>

      <nav class="nav-links">
        <a href="/" class="nav-link ${page === 'dashboard' ? 'active' : ''}">Dashboard</a>
        <a href="/ready" class="nav-link ${page === 'ready' ? 'active' : ''}">
          Ready<span class="nav-count" id="navReadyCount">…</span>
        </a>
        ${isAdmin ? `<a href="/manage" class="nav-link ${page === 'manage' ? 'active' : ''}">Manage</a>` : ''}
      </nav>

      <div class="header-right">
        ${avatarUrl ? `<img class="avatar" id="userAvatar" src="${avatarUrl}" alt="" style="display:block">` : ''}
        <span class="user-name">${escapeHtml(fullName)}</span>
        <button class="btn btn-ghost" onclick="signOut()">Sign out</button>
      </div>
    </header>
  `;

  // Live Ready count
  updateReadyCount();
}

async function updateReadyCount() {
  const el = document.getElementById('navReadyCount');
  if (!el) return;
  const { count, error } = await sb
    .from('home_repair_context')
    .select('home_id', { count: 'exact', head: true })
    .eq('status', 'ready');
  if (error) { el.textContent = '—'; return; }
  el.textContent = String(count ?? 0);
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
