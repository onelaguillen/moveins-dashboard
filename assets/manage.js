// ── Manage (/manage) page logic ──────────────────────────────────────────────
// Admin-only: upload BigQuery CSV, upload Claude's repair-context JSON,
// bulk-delete homes.

let allHomes = [];
let currentPage = 1;
let pageSize = 20;
let selectedIds = new Set();

// Integer and float columns for CSV coercion
const INT_COLS = new Set([
  'HomeId','LeaseId','ResidentId','MoveInSpecialistId','ConciergeId',
  'ImprovementsSpecialistId','HasHoa','HoaIsNotified','HadQAInspection','QAInspectionCount',
  'UnfinishedImprovements','UnfinishedImprovementsCount','IsSatisfied','CSATResponseCount',
  'NewProServices','NewProServicesCount','BalancesUnpaid','DepositUnpaid','RentUnpaid',
  'HasDeposit','HasRent','IsPerfectMoveIn','IsPerfectMoveInStrict','EnrolledInAutoPay',
  'DaysToLeaseStart','BusinessDaysToLeaseStart','IsFastMoveIn'
]);
const FLOAT_COLS = new Set([
  'DepositAmount','RentAmount','PaidRent','ReceivedRent','ProcessingReceiveRent','AvgRating'
]);

// ── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  const session = await requireAuth(true); // admin only
  if (!session) return;

  await mountHeader({ page: 'manage', session });
  startIdleWatcher();
  initOnlineUsersPanel(session);
  startPresence(session, { onSync: renderOnlineUsers });

  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('pageContent').style.display = 'block';

  setupCsvDropZone();
  setupJsonDropZone();
  await loadHomes();
})();

// ── Online users panel ───────────────────────────────────────────────────────
let _onlineMyEmail = '';
function initOnlineUsersPanel(session) {
  _onlineMyEmail = (session.user.email || '').toLowerCase();
  // Refresh idle-time labels every 30s
  setInterval(renderOnlineUsers, 30000);
}

function renderOnlineUsers() {
  const listEl  = document.getElementById('onlineList');
  const countEl = document.getElementById('onlineCount');
  if (!listEl || !countEl) return;
  if (!presenceChannel) return;

  const state = presenceChannel.presenceState();
  const rows = Object.values(state).flat()
    .map(p => ({
      id:     p.id    || '',
      email:  p.email || '',
      name:   p.name  || p.email || '',
      avatar: p.avatar || '',
      page:   p.page   || '/',
      status: p.status || 'active',
      since:  p.since  || Date.now()
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  countEl.textContent = rows.length;

  if (!rows.length) {
    listEl.innerHTML = `<div class="online-empty">No one else is online.</div>`;
    return;
  }

  listEl.innerHTML = rows.map(u => {
    const isMe  = u.email.toLowerCase() === _onlineMyEmail;
    const pageLabel =
      u.page === '/'             ? 'Dashboard' :
      u.page.includes('manage')  ? 'Manage'    :
      u.page.includes('ready')   ? 'Ready'     : u.page;
    const initials = (u.name || '?').split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase();
    const dotCls   = u.status === 'idle' ? 'dot-idle' : 'dot-active';
    const sinceMin = Math.max(0, Math.floor((Date.now() - u.since) / 60000));
    const statusLabel = u.status === 'idle' ? `idle ${sinceMin}m` : 'active';

    return `
      <div class="online-row">
        <div class="online-avatar">
          ${u.avatar ? `<img src="${escAttr(u.avatar)}" alt="">` : escHtml(initials)}
        </div>
        <div>
          <span class="online-name">${escHtml(u.name)}${isMe ? ' (you)' : ''}</span>
          <span class="online-email">${escHtml(u.email)}</span>
        </div>
        <span class="online-page">${escHtml(pageLabel)}</span>
        <span class="online-status"><i class="dot ${dotCls}"></i>${escHtml(statusLabel)}</span>
        <button class="btn-kick" ${isMe ? 'disabled title="You"' : `onclick="kickUser('${escAttr(u.id||'')}','${escAttr(u.email)}','${escAttr(u.name)}')"`}>
          Sign out
        </button>
      </div>`;
  }).join('');
}

async function kickUser(userId, email, name) {
  if (!userId) { showToast('Missing user id for this session', 'error'); return; }
  if (!confirm(`Sign out ${name || email}?`)) return;
  try {
    await adminSignOutUser({ userId, email });
    showToast(`${name || email} signed out`, 'success');
  } catch (e) {
    showToast(`Failed to sign out: ${e.message}`, 'error');
  }
}

function escHtml(s=''){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function escAttr(s=''){ return escHtml(s); }

// ── Load homes ───────────────────────────────────────────────────────────────
async function loadHomes() {
  const { data, error } = await sb
    .from('homes')
    .select('"HomeId","Address","MoveInSpecialist","LeaseStartOn","CurrentMilestone","AdminLink"')
    .order('"LeaseStartOn"', { ascending: true });

  if (error) { showToast('Failed to load homes: ' + error.message, 'error'); return; }
  allHomes = data || [];
  selectedIds.clear();
  currentPage = 1;
  render();
}

// ── Render table ─────────────────────────────────────────────────────────────
function render() {
  const total = allHomes.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  const page = allHomes.slice(start, end);

  document.getElementById('tableCount').innerHTML =
    `<strong>${total}</strong> <span>home${total !== 1 ? 's' : ''} in Supabase</span>`;

  const selCount = selectedIds.size;
  const bar = document.getElementById('deleteBar');
  bar.classList.toggle('show', selCount > 0);
  if (selCount > 0) {
    document.getElementById('deleteBarText').textContent =
      `${selCount} home${selCount !== 1 ? 's' : ''} selected`;
  }

  const allChecked = page.length > 0 && page.every(h => selectedIds.has(h.HomeId));
  const someChecked = page.some(h => selectedIds.has(h.HomeId));
  const selectAll = document.getElementById('selectAll');
  selectAll.checked = allChecked;
  selectAll.indeterminate = !allChecked && someChecked;

  const tbody = document.getElementById('homesBody');
  if (!total) {
    tbody.innerHTML = `<tr><td colspan="6">
      <div class="empty-state">
        <div class="empty-icon">🏠</div>
        <div class="empty-title">No homes yet</div>
        <div class="empty-sub">Upload a BigQuery CSV export to populate the dashboard</div>
      </div>
    </td></tr>`;
  } else {
    tbody.innerHTML = page.map(h => {
      const leaseDate = h.LeaseStartOn
        ? new Date(h.LeaseStartOn).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '—';
      const milestone = h.CurrentMilestone
        ? h.CurrentMilestone.replace(/([A-Z])/g, ' $1').trim()
        : '—';
      const linkHref = h.AdminLink || `https://foundation.bln.hm/homes/${h.HomeId}`;
      return `<tr class="${selectedIds.has(h.HomeId) ? 'selected' : ''}">
        <td><input type="checkbox" class="cb" ${selectedIds.has(h.HomeId) ? 'checked' : ''} onchange="toggleSelect(${h.HomeId})"></td>
        <td><span class="home-id" onclick="copyId(event, ${h.HomeId})">#${h.HomeId}</span></td>
        <td><a class="addr-link" href="${escapeAttr(linkHref)}" target="_blank" rel="noopener">${escapeHtml(h.Address || '—')}</a></td>
        <td style="font-size:11px;color:var(--muted)">${escapeHtml(h.MoveInSpecialist || '—')}</td>
        <td style="font-size:11px;color:var(--muted);white-space:nowrap">${leaseDate}</td>
        <td style="font-size:11px;color:var(--muted)">${milestone}</td>
      </tr>`;
    }).join('');
  }

  // Pagination
  const pag = document.getElementById('pagination');
  if (total === 0) { pag.style.display = 'none'; return; }
  pag.style.display = 'flex';
  document.getElementById('pageInfo').textContent = `Showing ${start + 1}–${end} of ${total}`;

  let html = `<button class="page-btn" onclick="goPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>←</button>`;
  const range = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) range.push(i);
    else if (range[range.length - 1] !== '…') range.push('…');
  }
  range.forEach(p => {
    if (p === '…') html += `<span class="page-btn" style="cursor:default;pointer-events:none">…</span>`;
    else html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" onclick="goPage(${p})">${p}</button>`;
  });
  html += `<button class="page-btn" onclick="goPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>→</button>`;
  document.getElementById('pageBtns').innerHTML = html;
}

function copyId(ev, id) {
  ev.stopPropagation();
  navigator.clipboard?.writeText(String(id));
  const el = ev.currentTarget;
  el.classList.add('copied');
  const orig = el.textContent;
  el.textContent = '✓ Copied';
  setTimeout(() => { el.classList.remove('copied'); el.textContent = orig; }, 900);
}

// ── Selection ────────────────────────────────────────────────────────────────
function toggleSelect(homeId) {
  selectedIds.has(homeId) ? selectedIds.delete(homeId) : selectedIds.add(homeId);
  render();
}
function toggleSelectAll() {
  const start = (currentPage - 1) * pageSize;
  const page = allHomes.slice(start, Math.min(start + pageSize, allHomes.length));
  const allChecked = page.every(h => selectedIds.has(h.HomeId));
  page.forEach(h => allChecked ? selectedIds.delete(h.HomeId) : selectedIds.add(h.HomeId));
  render();
}
function goPage(p) {
  const totalPages = Math.ceil(allHomes.length / pageSize);
  if (p < 1 || p > totalPages) return;
  currentPage = p;
  render();
}
function changePageSize() {
  pageSize = parseInt(document.getElementById('pageSizeSelect').value, 10);
  currentPage = 1;
  render();
}

// ── Delete ───────────────────────────────────────────────────────────────────
function confirmDelete() {
  if (!selectedIds.size) return;
  document.getElementById('modalBody').innerHTML =
    `You're about to permanently delete <strong>${selectedIds.size} home${selectedIds.size !== 1 ? 's' : ''}</strong> and all their associated repair context.<br><br>This cannot be undone.`;
  document.getElementById('modalOverlay').classList.add('show');
}
function closeModal() {
  document.getElementById('modalOverlay').classList.remove('show');
}
async function executeDelete() {
  closeModal();
  const ids = [...selectedIds];
  const { error } = await sb.from('homes').delete().in('"HomeId"', ids);
  if (error) { showToast('Delete failed: ' + error.message, 'error'); return; }
  showToast(`✅ ${ids.length} home${ids.length !== 1 ? 's' : ''} deleted`, 'success');
  await loadHomes();
}

// ── CSV upload (BigQuery homes) ──────────────────────────────────────────────
function setupCsvDropZone() {
  const zone = document.getElementById('csvDropZone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) handleCsv(f);
  });
}

async function handleCsv(file) {
  if (!file?.name.endsWith('.csv')) { showToast('Please upload a CSV file', 'error'); return; }

  const text = await file.text();
  const rows = parseCSV(text);
  if (!rows.length) { showToast('No data found in CSV', 'error'); return; }

  const progress = document.getElementById('csvProgress');
  const fill = document.getElementById('csvProgressFill');
  const label = document.getElementById('csvProgressLabel');
  progress.style.display = 'block';
  fill.style.width = '0%';

  const BATCH = 100;
  let uploaded = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await sb.from('homes').upsert(batch, { onConflict: '"HomeId"' });
    if (error) { showToast('Upload error: ' + error.message, 'error'); break; }
    uploaded += batch.length;
    const pct = Math.round((uploaded / rows.length) * 100);
    fill.style.width = pct + '%';
    label.textContent = `Uploading… ${uploaded} / ${rows.length} homes`;
  }
  fill.style.width = '100%';
  label.textContent = `✅ ${uploaded} homes synced`;
  setTimeout(() => { progress.style.display = 'none'; fill.style.width = '0%'; }, 3000);
  showToast(`✅ ${uploaded} homes uploaded`, 'success');
  await loadHomes();
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length < 2) continue;
    const row = {};
    headers.forEach((h, idx) => {
      const val = values[idx] ?? '';
      if (val === '') row[h] = null;
      else if (INT_COLS.has(h)) row[h] = parseInt(val, 10);
      else if (FLOAT_COLS.has(h)) row[h] = parseFloat(val);
      else row[h] = val;
    });
    row['last_synced_at'] = new Date().toISOString();
    rows.push(row);
  }
  return rows;
}
function parseCSVLine(line) {
  const result = []; let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { result.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  result.push(cur.trim());
  return result;
}

// ── JSON upload (Claude repair context) ──────────────────────────────────────
function setupJsonDropZone() {
  const zone = document.getElementById('jsonDropZone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) handleJson(f);
  });
}

async function handleJson(file) {
  if (!file?.name.endsWith('.json')) { showToast('Please upload a JSON file', 'error'); return; }

  let parsed;
  try { parsed = JSON.parse(await file.text()); }
  catch (e) { showToast('Invalid JSON: ' + e.message, 'error'); return; }

  const homesArr = Array.isArray(parsed) ? parsed : (parsed.homes || []);
  if (!homesArr.length) { showToast('No homes found in JSON', 'error'); return; }

  const progress = document.getElementById('jsonProgress');
  const fill = document.getElementById('jsonProgressFill');
  const label = document.getElementById('jsonProgressLabel');
  progress.style.display = 'block';
  fill.style.width = '0%';

  // Build rows. Accept home_id directly or extract from foundation_url.
  const knownHomeIds = new Set(allHomes.map(h => h.HomeId));
  const toUpsert = [];
  const missing  = [];

  homesArr.forEach(h => {
    let homeId = h.home_id;
    if (!homeId && h.foundation_url) {
      const m = String(h.foundation_url).match(/\/homes\/(\d+)/);
      if (m) homeId = parseInt(m[1], 10);
    }
    if (!homeId) return;
    if (!knownHomeIds.has(homeId)) { missing.push(homeId); return; }
    toUpsert.push({
      home_id: homeId,
      status: h.status || null,
      repairs_context: h.repairs_context ?? h.notes ?? null,
      postpone_reason: h.postpone_reason ?? null,
      expectations: h.expectations ?? null,
      lease_url: h.lease_url ?? null
    });
  });

  if (!toUpsert.length) {
    label.textContent = `No valid homes matched (${missing.length} unknown)`;
    showToast('No matching homes in database', 'error');
    return;
  }

  // Upsert in batches
  const BATCH = 100;
  let uploaded = 0;
  for (let i = 0; i < toUpsert.length; i += BATCH) {
    const batch = toUpsert.slice(i, i + BATCH);
    const { error } = await sb.from('home_repair_context').upsert(batch, { onConflict: 'home_id' });
    if (error) { showToast('Upload error: ' + error.message, 'error'); break; }
    uploaded += batch.length;
    const pct = Math.round((uploaded / toUpsert.length) * 100);
    fill.style.width = pct + '%';
    label.textContent = `Uploading… ${uploaded} / ${toUpsert.length} homes`;
  }

  fill.style.width = '100%';
  const warn = missing.length ? ` · ${missing.length} home_id${missing.length !== 1 ? 's' : ''} not found in DB` : '';
  label.textContent = `✅ ${uploaded} repair contexts updated${warn}`;
  if (missing.length) console.warn('Unknown home_ids from repair JSON:', missing);
  setTimeout(() => { progress.style.display = 'none'; fill.style.width = '0%'; }, 6000);
  showToast(`✅ ${uploaded} repair contexts updated${warn}`, missing.length ? '' : 'success');
}

// ── Utils ────────────────────────────────────────────────────────────────────
function escapeHtml(s = '') {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s = '') { return escapeHtml(s); }
