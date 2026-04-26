// ── Belong Move-In Dashboard — Header nav renderer ───────────────────────────
// Usage: mountHeader({ page, session })
// Injects header into <div id="appHeader"></div>.

async function mountHeader({ page, session }) {
  const container = document.getElementById('appHeader');
  if (!container) return;

  const user      = session?.user;
  const email     = user?.email || '';
  const isAdminUser = isAdmin(email);
  const fullName  = user?.user_metadata?.full_name || email;
  const avatarUrl = user?.user_metadata?.avatar_url || '';

  const subtitle =
    page === 'manage' ? 'Manage' :
    page === 'ready'  ? 'Sign-Off Queue' :
                        'Move-Ins';

  container.innerHTML = `
    <header class="app-header">
      <div class="logo">
        <a class="brand-wordmark" href="/">belong</a>
        <span class="logo-sep">/</span>
        <span class="logo-sub">${subtitle}</span>

        <nav class="nav-links">
          <a href="/" class="nav-link ${page === 'dashboard' ? 'active' : ''}">Dashboard</a>
          <a href="/ready" class="nav-link ${page === 'ready' ? 'active' : ''}">Ready</a>
          ${isAdminUser ? `<a href="/manage" class="nav-link ${page === 'manage' ? 'active' : ''}">Manage</a>` : ''}
        </nav>
      </div>

      <div class="header-right">
        <span class="header-pill pill-live" id="pillLive">— homes · live</span>
        <a href="/ready" class="header-pill pill-ready">
          Ready for Tami <span class="pill-count" id="pillReady">—</span>
        </a>
        <span class="header-pill pill-user">
          ${avatarUrl ? `<img class="avatar" src="${escapeAttr(avatarUrl)}" alt="">` : `<span style="width:22px;height:22px;border-radius:50%;background:var(--navy);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700">${initials(fullName)}</span>`}
          ${escapeHtml(shortName(fullName))}
        </span>
        <button class="btn btn-ghost" onclick="signOut()" title="Sign out">↩</button>
      </div>
    </header>
  `;

  updateHeaderCounts();
}

async function updateHeaderCounts() {
  // Live homes count + Ready count, in parallel
  const [homesRes, readyRes] = await Promise.all([
    sb.from('homes').select('home_id', { count: 'exact', head: true }),
    sb.from('home_repair_context').select('home_id', { count: 'exact', head: true }).eq('status', 'ready')
  ]);
  const livePill = document.getElementById('pillLive');
  const readyPill = document.getElementById('pillReady');
  if (livePill)  livePill.textContent  = `${homesRes.count ?? 0} homes · live`;
  if (readyPill) readyPill.textContent = String(readyRes.count ?? 0);
}

function initials(name = '') {
  const parts = String(name).trim().split(/\s+/);
  return (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
}
function shortName(name = '') {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length <= 1) return name;
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}
function escapeHtml(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escapeAttr(s = '') { return escapeHtml(s); }
