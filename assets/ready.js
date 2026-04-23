// ── Ready (/ready) page logic ────────────────────────────────────────────────
// Tami's sign-off queue. Shows only homes where home_repair_context.status='ready'.
// "Mark Signed Off" button flips status to 'signed_off'.

let readyHomes = [];

(async () => {
  const session = await requireAuth(false);
  if (!session) return;

  const email = session.user.email || '';
  // Surface-level guard: Ready page is meant for Tami + admin. Anyone else sees a note.
  const canSignOff = (isAdmin(email) || email === TAMI_EMAIL);

  await mountHeader({ page: 'ready', session });
  startIdleWatcher();
  startPresence(session);

  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('pageContent').style.display = 'block';

  if (!canSignOff) {
    document.getElementById('readOnlyNote').style.display = 'block';
  }

  await loadReady();
})();

async function loadReady() {
  // Read ready rows + join home address data
  const { data: ctxRows, error: ctxErr } = await sb
    .from('home_repair_context')
    .select('home_id, status, lease_url, repairs_context, updated_at')
    .eq('status', 'ready');
  if (ctxErr) { showToast('Failed: ' + ctxErr.message, 'error'); return; }

  const ids = (ctxRows || []).map(r => r.home_id);
  if (!ids.length) {
    readyHomes = [];
    render();
    return;
  }
  const { data: homes, error: hErr } = await sb
    .from('homes')
    .select('"HomeId","Address","Region","MoveInSpecialist","ResidentName","LeaseStartOn","AdminLink"')
    .in('"HomeId"', ids);
  if (hErr) { showToast('Failed: ' + hErr.message, 'error'); return; }

  const homeById = new Map((homes || []).map(h => [h.HomeId, h]));
  readyHomes = ctxRows.map(c => ({
    ...c,
    home: homeById.get(c.home_id) || null
  })).filter(r => r.home);

  // Sort by LeaseStartOn
  readyHomes.sort((a, b) => {
    const da = a.home.LeaseStartOn ? new Date(a.home.LeaseStartOn).getTime() : Infinity;
    const db = b.home.LeaseStartOn ? new Date(b.home.LeaseStartOn).getTime() : Infinity;
    return da - db;
  });

  render();
}

function render() {
  const list = document.getElementById('readyList');
  document.getElementById('readyCount').textContent =
    `${readyHomes.length} home${readyHomes.length !== 1 ? 's' : ''} ready`;

  if (!readyHomes.length) {
    list.innerHTML = `
      <div class="card" style="padding:60px 20px;text-align:center">
        <div style="font-size:36px;margin-bottom:12px">✨</div>
        <div style="font-size:15px;font-weight:600;margin-bottom:4px">All caught up</div>
        <div style="font-size:12px;color:var(--faint)">No homes are waiting for sign-off right now.</div>
      </div>`;
    return;
  }

  list.innerHTML = readyHomes.map(r => {
    const h = r.home;
    const leaseDate = h.LeaseStartOn
      ? new Date(h.LeaseStartOn).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      : '—';
    const leaseHref = r.lease_url || h.AdminLink || `https://foundation.bln.hm/homes/${h.HomeId}`;
    return `
      <div class="card" style="margin-bottom:10px;padding:16px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div style="flex:1;min-width:260px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;flex-wrap:wrap">
            <span class="home-id">#${h.HomeId}</span>
            <span style="font-size:14px;font-weight:600">${escapeHtml(h.Address || '—')}</span>
            <span class="status-badge status-ready">Ready</span>
          </div>
          <div style="font-size:11px;color:var(--muted)">
            ${h.ResidentName ? escapeHtml(h.ResidentName) + ' · ' : ''}
            ${h.MoveInSpecialist ? escapeHtml(h.MoveInSpecialist) + ' · ' : ''}
            Move-in ${leaseDate}
          </div>
          ${r.repairs_context ? `<div style="font-size:11px;color:var(--faint);margin-top:6px;line-height:1.5">${escapeHtml(r.repairs_context)}</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn btn-ghost" href="${escapeAttr(leaseHref)}" target="_blank" rel="noopener">Open Lease ↗</a>
          <button class="btn btn-green btn-lg" onclick="markSignedOff(${h.HomeId})">✓ Mark Signed Off</button>
        </div>
      </div>
    `;
  }).join('');
}

async function markSignedOff(homeId) {
  const { error } = await sb
    .from('home_repair_context')
    .update({ status: 'signed_off' })
    .eq('home_id', homeId);
  if (error) {
    showToast('Failed: ' + error.message, 'error');
    return;
  }
  showToast('✓ Signed off', 'success');
  // Remove from local list without full refetch
  readyHomes = readyHomes.filter(r => r.home_id !== homeId);
  render();
  updateReadyCount(); // refresh header pill
}

function escapeHtml(s = '') {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s = '') { return escapeHtml(s); }
