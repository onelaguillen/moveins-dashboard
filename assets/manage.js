// ── Manage (/manage) page logic ──────────────────────────────────────────────
// Admin-only. Multi-file CSV upload (homes/repairs/pro_services), repair-context
// JSON upload, sync history, and homes table.
//
// Files are detected by their column headers — the user can drop them in any
// order and the system routes each to the right table.

let allHomes = [];
let currentPage = 1;
let pageSize = 20;
let selectedIds = new Set();

// Pending upload set: { file, kind, rows, headers, error }
let pendingUploads = [];

// ── Schema mapping for v3 tables ─────────────────────────────────────────────
// Each table's column types — drives CSV coercion.
const TABLE_SCHEMAS = {
  homes: {
    int:   ['home_id','lease_id','resident_id','move_in_specialist_id','concierge_id',
            'improvements_specialist_id','qa_group_id','qa_inspection_count','csat_response_count',
            'balances_unpaid'],
    float: ['rent_amount','deposit_amount','paid_rent','received_rent',
            'processing_receive_rent','avg_rating'],
    bool:  ['has_hoa','hoa_is_notified','is_revised','enrolled_in_auto_pay',
            'deposit_unpaid','rent_unpaid','has_deposit','has_rent',
            'had_qa_inspection','is_satisfied'],
    date:  ['report_date','lease_start_on','lease_executed_on','original_executed_on'],
    timestamp: ['current_milestone_on','move_in_ready','move_in_completed','csat_created_on']
  },
  repairs: {
    int:   ['maintenance_id','home_id'],
    float: ['repair_estimated_cost'],
    bool:  [],
    date:  [],
    timestamp: ['repair_created_on']
  },
  pro_services: {
    int:   ['pro_service_id','home_id'],
    float: [],
    bool:  [],
    date:  [],
    timestamp: ['service_created_on','service_completed_on']
  }
};

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
  await renderSyncHistory();
  await renderSnapshots();
})();

// ── Online users panel ───────────────────────────────────────────────────────
let _onlineMyEmail = '';
function initOnlineUsersPanel(session) {
  _onlineMyEmail = (session.user.email || '').toLowerCase();
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
  try {
    allHomes = await dataSource.getHomes();
    selectedIds.clear();
    currentPage = 1;
    render();
  } catch (e) {
    showToast('Failed to load homes: ' + e.message, 'error');
  }
}

// ── Render homes table ───────────────────────────────────────────────────────
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

  const allChecked = page.length > 0 && page.every(h => selectedIds.has(h.home_id));
  const someChecked = page.some(h => selectedIds.has(h.home_id));
  const selectAll = document.getElementById('selectAll');
  selectAll.checked = allChecked;
  selectAll.indeterminate = !allChecked && someChecked;

  const tbody = document.getElementById('homesBody');
  if (!total) {
    tbody.innerHTML = `<tr><td colspan="6">
      <div class="empty-state">
        <div class="empty-icon">🏠</div>
        <div class="empty-title">No homes yet</div>
        <div class="empty-sub">Upload BigQuery exports (homes / repairs / pro services) above</div>
      </div>
    </td></tr>`;
  } else {
    tbody.innerHTML = page.map(h => {
      const leaseDate = h.lease_start_on
        ? new Date(h.lease_start_on).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '—';
      const milestone = h.current_milestone
        ? h.current_milestone.replace(/([A-Z])/g, ' $1').trim()
        : '—';
      const linkHref = `https://foundation.bln.hm/homes/${h.home_id}`;
      return `<tr class="${selectedIds.has(h.home_id) ? 'selected' : ''}">
        <td><input type="checkbox" class="cb" ${selectedIds.has(h.home_id) ? 'checked' : ''} onchange="toggleSelect(${h.home_id})"></td>
        <td><span class="home-id" onclick="copyId(event, ${h.home_id})">#${h.home_id}</span></td>
        <td><a class="addr-link" href="${escapeAttr(linkHref)}" target="_blank" rel="noopener">${escapeHtml(h.address || '—')}</a></td>
        <td style="font-size:11px;color:var(--muted)">${escapeHtml(h.move_in_specialist || '—')}</td>
        <td style="font-size:11px;color:var(--muted);white-space:nowrap">${leaseDate}</td>
        <td style="font-size:11px;color:var(--muted)">${milestone}</td>
      </tr>`;
    }).join('');
  }

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

function toggleSelect(homeId) {
  selectedIds.has(homeId) ? selectedIds.delete(homeId) : selectedIds.add(homeId);
  render();
}
function toggleSelectAll() {
  const start = (currentPage - 1) * pageSize;
  const page = allHomes.slice(start, Math.min(start + pageSize, allHomes.length));
  const allChecked = page.every(h => selectedIds.has(h.home_id));
  page.forEach(h => allChecked ? selectedIds.delete(h.home_id) : selectedIds.add(h.home_id));
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

function confirmDelete() {
  if (!selectedIds.size) return;
  document.getElementById('modalBody').innerHTML =
    `You're about to permanently delete <strong>${selectedIds.size} home${selectedIds.size !== 1 ? 's' : ''}</strong>.<br><br>This cannot be undone.`;
  document.getElementById('modalOverlay').classList.add('show');
}
function closeModal() {
  document.getElementById('modalOverlay').classList.remove('show');
}
async function executeDelete() {
  closeModal();
  const ids = [...selectedIds];
  const { error } = await sb.from('homes').delete().in('home_id', ids);
  if (error) { showToast('Delete failed: ' + error.message, 'error'); return; }
  showToast(`✅ ${ids.length} home${ids.length !== 1 ? 's' : ''} deleted`, 'success');
  await loadHomes();
}

// ── CSV multi-file drop ──────────────────────────────────────────────────────
function setupCsvDropZone() {
  const zone = document.getElementById('csvDropZone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    handleCsvFiles(e.dataTransfer.files);
  });
}

async function handleCsvFiles(fileList) {
  const files = [...(fileList || [])].filter(f => f && f.name.toLowerCase().endsWith('.csv'));
  if (!files.length) { showToast('Please drop CSV files', 'error'); return; }

  pendingUploads = [];
  for (const f of files) {
    try {
      const text = await f.text();
      const { headers, rows: rawRows } = parseCSVRaw(text);

      // Combined export: split rows by __source_table column into 3 virtual uploads
      if (isCombinedFile(headers)) {
        const split = splitCombined(rawRows);
        for (const kind of ['homes', 'repairs', 'pro_services']) {
          if (!split[kind].length) continue;
          const rows = split[kind].map(r => coerceRow(r, kind));
          pendingUploads.push({
            file: f,
            kind,
            rows,
            headers,
            sourceLabel: `${f.name} → ${kind}`
          });
        }
        if (!split.homes.length && !split.repairs.length && !split.pro_services.length) {
          pendingUploads.push({ file: f, kind: null, rows: [], headers, error: 'Combined file had no recognized rows' });
        }
        continue;
      }

      const kind = detectFileKind(headers);
      if (!kind) {
        pendingUploads.push({ file: f, kind: null, rows: [], headers, error: 'Unrecognized columns' });
        continue;
      }
      const rows = rawRows.map(r => coerceRow(r, kind));
      pendingUploads.push({ file: f, kind, rows, headers });
    } catch (e) {
      pendingUploads.push({ file: f, kind: null, rows: [], headers: [], error: e.message });
    }
  }
  renderUploadPreview();
}

function isCombinedFile(headers) {
  return headers.map(s => s.toLowerCase()).includes('__source_table');
}

function splitCombined(rawRows) {
  const out = { homes: [], repairs: [], pro_services: [] };
  for (const r of rawRows) {
    const kind = (r['__source_table'] || '').trim();
    if (out[kind]) out[kind].push(r);
  }
  return out;
}

function detectFileKind(headers) {
  const h = new Set(headers.map(s => s.toLowerCase()));
  if (h.has('maintenance_id') && h.has('home_id') && h.has('repair_summary')) return 'repairs';
  if (h.has('pro_service_id') && h.has('home_id') && h.has('service_name'))   return 'pro_services';
  if (h.has('home_id') && h.has('lease_start_on') && h.has('address')
      && !h.has('maintenance_id') && !h.has('pro_service_id')) return 'homes';
  return null;
}

function renderUploadPreview() {
  const box = document.getElementById('uploadPreview');
  if (!box) return;
  if (!pendingUploads.length) { box.innerHTML = ''; return; }

  const labels = { homes: 'Homes', repairs: 'Repairs', pro_services: 'Pro Services' };
  const rows = pendingUploads.map(u => {
    const ok = !!u.kind && !u.error;
    const icon = ok ? '✓' : '✗';
    const cls  = ok ? 'upload-row-ok' : 'upload-row-err';
    const dest = ok ? `${labels[u.kind]} (${u.rows.length} rows)` : (u.error || 'Unrecognized — won\'t be uploaded');
    return `<div class="upload-row ${cls}">
      <span class="upload-icon">${icon}</span>
      <span class="upload-name">${escapeHtml(u.file.name)}</span>
      <span class="upload-arrow">→</span>
      <span class="upload-dest">${escapeHtml(dest)}</span>
    </div>`;
  }).join('');

  const validCount = pendingUploads.filter(u => u.kind).length;

  box.innerHTML = `
    <div class="upload-preview-list">${rows}</div>
    <div class="upload-actions" style="margin-top:12px;display:flex;gap:8px">
      <button class="btn btn-ghost" onclick="cancelUploads()">Cancel</button>
      <button class="btn btn-green" onclick="commitUploads()" ${validCount ? '' : 'disabled'}>
        Upload all (${validCount})
      </button>
    </div>
  `;
}

function cancelUploads() {
  pendingUploads = [];
  renderUploadPreview();
}

async function commitUploads() {
  const valid = pendingUploads.filter(u => u.kind);
  if (!valid.length) return;

  const session = await sb.auth.getSession();
  const email = session.data?.session?.user?.email || 'unknown';

  // Open a sync_log entry up front
  const startedAt = new Date().toISOString();
  let logRow;
  try {
    logRow = await dataSource.logSync({
      startedAt, status: 'running', triggeredBy: email,
      counts: {}
    });
  } catch (e) {
    showToast('Could not start sync log: ' + e.message, 'error');
  }

  const progress = document.getElementById('csvProgress');
  const fill  = document.getElementById('csvProgressFill');
  const label = document.getElementById('csvProgressLabel');
  progress.style.display = 'block';
  fill.style.width = '0%';

  const counts = {};
  let errored = null;

  try {
    for (let i = 0; i < valid.length; i++) {
      const u = valid[i];
      label.textContent = `Uploading ${u.file.name} → ${u.kind}…`;
      let result;
      if (u.kind === 'homes')        result = await dataSource.replaceHomes(u.rows);
      if (u.kind === 'repairs')      result = await dataSource.replaceRepairs(u.rows);
      if (u.kind === 'pro_services') result = await dataSource.replaceProServices(u.rows);
      counts[u.kind] = result?.inserted ?? u.rows.length;
      fill.style.width = Math.round(((i + 1) / valid.length) * 100) + '%';
    }
  } catch (e) {
    errored = e.message;
  }

  // Close out sync_log
  try {
    if (logRow?.id) {
      await dataSource.updateSyncLog(logRow.id, {
        finished_at: new Date().toISOString(),
        row_count_homes:        counts.homes        ?? null,
        row_count_repairs:      counts.repairs      ?? null,
        row_count_pro_services: counts.pro_services ?? null,
        status: errored ? 'error' : 'success',
        error_message: errored || null
      });
    }
  } catch (_) {}

  if (errored) {
    label.textContent = '✗ Upload failed: ' + errored;
    showToast('Upload error: ' + errored, 'error');
  } else {
    const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
    label.textContent = `✅ ${summary}`;
    showToast(`✅ Synced: ${summary}`, 'success');
  }

  setTimeout(() => { progress.style.display = 'none'; fill.style.width = '0%'; }, 5000);
  pendingUploads = [];
  renderUploadPreview();
  await loadHomes();
  await renderSyncHistory();
}

// ── CSV parsing + coercion ───────────────────────────────────────────────────
function parseCSVRaw(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 1) return { headers: [], rows: [] };
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (!values.length) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ''; });
    rows.push(row);
  }
  return { headers, rows };
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

// Allowed columns per table — anything else (e.g. union NULL padding columns
// from the combined CSV) gets dropped before insert.
const TABLE_COLUMNS = {
  homes: new Set([
    'home_id','lease_id','resident_id','report_date','address','region',
    'resident_name','intercom_id',
    'move_in_specialist','move_in_specialist_id','concierge','concierge_id',
    'improvements_specialist','improvements_specialist_id',
    'has_hoa','hoa_is_notified',
    'lease_start_on','lease_executed_on','original_executed_on','is_revised',
    'current_milestone','current_milestone_on','move_in_ready','move_in_completed',
    'rent_amount','deposit_amount','deposit_type','paid_rent','received_rent',
    'processing_receive_rent','enrolled_in_auto_pay','move_in_payment_status',
    'balances_unpaid','deposit_unpaid','rent_unpaid','has_deposit','has_rent','balance_detail',
    'qa_group_id','had_qa_inspection','qa_inspection_count',
    'is_satisfied','csat_response_count','csat_status','avg_rating',
    'csat_requester_name','csat_created_on','csat_comment',
    'last_synced_at'
  ]),
  repairs: new Set([
    'maintenance_id','home_id','repair_summary','repair_estimated_cost',
    'repair_assessment','repair_category','repair_created_on','last_synced_at'
  ]),
  pro_services: new Set([
    'pro_service_id','home_id','service_name','service_category','service_status',
    'service_created_on','service_completed_on','last_synced_at'
  ])
};

function coerceRow(raw, kind) {
  const schema = TABLE_SCHEMAS[kind];
  const cols   = TABLE_COLUMNS[kind];
  if (!schema || !cols) return raw;
  const intSet  = new Set(schema.int);
  const flSet   = new Set(schema.float);
  const boolSet = new Set(schema.bool);
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!cols.has(k)) continue; // strip union-padding columns from combined CSV
    const val = (v === '' || v == null) ? null : v;
    if (val == null) { out[k] = null; continue; }
    if (intSet.has(k))   { const n = parseInt(val, 10);  out[k] = isNaN(n) ? null : n; continue; }
    if (flSet.has(k))    { const n = parseFloat(val);    out[k] = isNaN(n) ? null : n; continue; }
    if (boolSet.has(k))  { out[k] = coerceBool(val); continue; }
    out[k] = val;
  }
  out.last_synced_at = new Date().toISOString();
  return out;
}

function coerceBool(v) {
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  if (s === 'true'  || s === 't' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === 'f' || s === '0' || s === 'no')  return false;
  return null;
}

// ── Sync history ─────────────────────────────────────────────────────────────
async function renderSyncHistory() {
  const box = document.getElementById('syncHistory');
  if (!box) return;
  let rows = [];
  try {
    rows = await dataSource.getSyncLog(10);
  } catch (e) {
    box.innerHTML = `<div class="faint">Could not load sync history: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!rows.length) {
    box.innerHTML = `<div class="faint" style="font-size:12px">No syncs yet.</div>`;
    return;
  }

  box.innerHTML = `
    <table class="sync-log-table" style="width:100%;font-size:12px;border-collapse:collapse">
      <thead>
        <tr style="text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">
          <th style="padding:6px 8px">Started</th>
          <th style="padding:6px 8px">Status</th>
          <th style="padding:6px 8px">Homes</th>
          <th style="padding:6px 8px">Repairs</th>
          <th style="padding:6px 8px">Pro Svcs</th>
          <th style="padding:6px 8px">By</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:6px 8px;white-space:nowrap">${escapeHtml(formatDateTime(r.started_at))}</td>
            <td style="padding:6px 8px"><span class="mini-badge ${r.status === 'success' ? 'mini-ok' : (r.status === 'error' ? 'mini-err' : 'mini-warn')}">${escapeHtml(r.status || '—')}</span></td>
            <td style="padding:6px 8px">${r.row_count_homes ?? '—'}</td>
            <td style="padding:6px 8px">${r.row_count_repairs ?? '—'}</td>
            <td style="padding:6px 8px">${r.row_count_pro_services ?? '—'}</td>
            <td style="padding:6px 8px;color:var(--muted)">${escapeHtml(r.triggered_by || '—')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ── JSON upload (Claude repair context) ──────────────────────────────────────
function setupJsonDropZone() {
  const zone = document.getElementById('jsonDropZone');
  if (!zone) return;
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

  const knownHomeIds = new Set(allHomes.map(h => h.home_id));
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
      expectations: h.expectations ?? null
    });
  });

  if (!toUpsert.length) {
    label.textContent = `No valid homes matched (${missing.length} unknown)`;
    showToast('No matching homes in database', 'error');
    return;
  }

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

// ── Daily Snapshots ──────────────────────────────────────────────────────────
async function renderSnapshots() {
  const container = document.getElementById('snapshotList');
  if (!container) return;
  try {
    const dates = await dataSource.getSnapshotDates();
    if (!dates.length) {
      container.innerHTML = `<div class="faint" style="font-size:12px;padding:12px 16px">
        No snapshots yet. The first one runs tonight at 06:00 UTC, or click "Take snapshot now" above.
      </div>`;
      return;
    }
    container.innerHTML = `
      <table style="width:100%;font-size:12px">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 16px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border-bottom:1px solid var(--border)">Date</th>
            <th style="text-align:right;padding:8px 16px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border-bottom:1px solid var(--border)">Rows</th>
            <th style="width:90px;border-bottom:1px solid var(--border)"></th>
          </tr>
        </thead>
        <tbody>
          ${dates.map(d => `
            <tr>
              <td style="padding:8px 16px;font-family:ui-monospace,monospace">${escapeHtml(d.snapshot_date)}</td>
              <td style="padding:8px 16px;text-align:right;color:var(--muted)">${d.row_count}</td>
              <td style="padding:6px 16px;text-align:right">
                <button class="btn btn-ghost" style="font-size:11px;padding:3px 10px;color:var(--red);border-color:var(--red-border)" onclick="confirmDeleteSnapshot('${escapeAttr(d.snapshot_date)}', ${d.row_count})">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    container.innerHTML = `<div style="color:var(--red);font-size:12px;padding:12px 16px">Failed to load snapshots: ${escapeHtml(err.message)}</div>`;
  }
}

async function takeSnapshotNow() {
  const btn = document.getElementById('snapshotNowBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
  try {
    const count = await dataSource.takeSnapshotNow();
    showToast(`✅ Snapshot saved · ${count} rows`, 'success');
    await renderSnapshots();
  } catch (err) {
    showToast('Snapshot failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Take snapshot now'; }
  }
}
window.takeSnapshotNow = takeSnapshotNow;

function confirmDeleteSnapshot(date, count) {
  if (!confirm(`Delete the snapshot from ${date}?\n\n${count} rows will be permanently removed and won't appear in any analytics chart.\n\nThis cannot be undone.`)) return;
  doDeleteSnapshot(date);
}
window.confirmDeleteSnapshot = confirmDeleteSnapshot;

async function doDeleteSnapshot(date) {
  try {
    await dataSource.deleteSnapshot(date);
    showToast(`Snapshot ${date} deleted`, 'success');
    await renderSnapshots();
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

// ── Utils ────────────────────────────────────────────────────────────────────
function escapeHtml(s = '') {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s = '') { return escapeHtml(s); }
