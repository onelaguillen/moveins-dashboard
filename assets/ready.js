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
    .select('home_id, status, repairs_context, updated_at')
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
    .select('home_id, address, region, move_in_specialist, resident_name, lease_start_on, lease_id')
    .in('home_id', ids);
  if (hErr) { showToast('Failed: ' + hErr.message, 'error'); return; }

  const homeById = new Map((homes || []).map(h => [h.home_id, h]));
  readyHomes = ctxRows.map(c => ({
    ...c,
    home: homeById.get(c.home_id) || null
  })).filter(r => r.home);

  // Sort by lease_start_on
  readyHomes.sort((a, b) => {
    const da = a.home.lease_start_on ? new Date(a.home.lease_start_on).getTime() : Infinity;
    const db = b.home.lease_start_on ? new Date(b.home.lease_start_on).getTime() : Infinity;
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
    const leaseDate = h.lease_start_on
      ? new Date(h.lease_start_on).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      : '—';
    const leaseHref = h.lease_id
      ? `https://admin.bln.hm/leases/${h.lease_id}`
      : `https://foundation.bln.hm/homes/${h.home_id}`;
    return `
      <div class="card" style="margin-bottom:10px;padding:16px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <div style="flex:1;min-width:260px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;flex-wrap:wrap">
            <span class="home-id">#${h.home_id}</span>
            <span style="font-size:14px;font-weight:600">${escapeHtml(h.address || '—')}</span>
            <span class="status-badge status-ready">Ready</span>
          </div>
          <div style="font-size:11px;color:var(--muted)">
            ${h.resident_name ? escapeHtml(h.resident_name) + ' · ' : ''}
            ${h.move_in_specialist ? escapeHtml(h.move_in_specialist) + ' · ' : ''}
            Move-in ${leaseDate}
          </div>
          ${r.repairs_context ? `<div style="font-size:11px;color:var(--faint);margin-top:6px;line-height:1.5">${escapeHtml(r.repairs_context)}</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn btn-ghost" href="${escapeAttr(leaseHref)}" target="_blank" rel="noopener">Open Lease ↗</a>
          <button class="btn btn-green btn-lg" onclick="markSignedOff(${h.home_id})">✓ Mark Signed Off</button>
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
