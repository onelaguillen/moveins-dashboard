// ── Dashboard (/) page logic ─────────────────────────────────────────────────
// Reads `homes` (BigQuery source of truth) joined with `home_repair_context`
// (Claude's Slack analysis) and renders the main list.

const FILTER_STORAGE_KEY = 'belong.dashboard.filters.v1';

let allRows   = [];      // joined home + context records
let filtered  = [];
let currentPage = 1;
let pageSize    = 20;
// Row expansion state: Map<homeId, Set<'repairs'|'status'>>
const expanded = new Map();

// ── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  const session = await requireAuth(false);
  if (!session) return;

  await mountHeader({ page: 'dashboard', session });
  startIdleWatcher();

  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('pageContent').style.display = 'block';

  restoreFilters();
  wireFilters();
  await loadData();
})();

// ── Data ─────────────────────────────────────────────────────────────────────
async function loadData() {
  const [homesRes, ctxRes] = await Promise.all([
    sb.from('homes').select(
      '"HomeId","Address","Region","MoveInSpecialist","Concierge","LeaseStartOn",' +
      '"CurrentMilestone","CurrentMilestoneOn","MoveInReady","MoveInCompleted",' +
      '"AdminLink","ResidentName","RentAmount","DepositAmount",' +
      '"PaymentStatus","BalanceDetail",' +
      '"UnfinishedImprovements","UnfinishedImprovementsCount",' +
      '"UnfinishedGroupDetails","AllUnfinishedDetails",' +
      '"HasHoa","HoaIsNotified","CSATStatus","AvgRating"'
    ).order('"LeaseStartOn"', { ascending: true }),
    sb.from('home_repair_context').select('*')
  ]);

  if (homesRes.error) { showToast('Failed to load homes: ' + homesRes.error.message, 'error'); return; }
  if (ctxRes.error)   { console.warn('Context load failed:', ctxRes.error.message); }

  const ctxByHome = new Map((ctxRes.data || []).map(r => [r.home_id, r]));
  allRows = (homesRes.data || []).map(h => ({
    ...h,
    _ctx: ctxByHome.get(h.HomeId) || null
  }));

  populateFilterOptions();
  applyFilters();
}

// ── Filters ──────────────────────────────────────────────────────────────────
function wireFilters() {
  ['fSearch', 'fRegion', 'fSpecialist', 'fStatus'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => { persistFilters(); applyFilters(); });
    el.addEventListener('change', () => { persistFilters(); applyFilters(); });
  });
  document.getElementById('fClear').addEventListener('click', clearFilters);
}

function populateFilterOptions() {
  const regionSel = document.getElementById('fRegion');
  const specSel   = document.getElementById('fSpecialist');
  const regionCur = regionSel.value;
  const specCur   = specSel.value;
  const regions = [...new Set(allRows.map(r => r.Region).filter(Boolean))].sort();
  const specs   = [...new Set(allRows.map(r => r.MoveInSpecialist).filter(Boolean))].sort();
  regionSel.innerHTML = `<option value="">All regions</option>` +
    regions.map(r => `<option>${escapeHtml(r)}</option>`).join('');
  specSel.innerHTML = `<option value="">All specialists</option>` +
    specs.map(s => `<option>${escapeHtml(s)}</option>`).join('');
  regionSel.value = regionCur;
  specSel.value   = specCur;
}

function applyFilters() {
  const q      = document.getElementById('fSearch').value.trim().toLowerCase();
  const region = document.getElementById('fRegion').value;
  const spec   = document.getElementById('fSpecialist').value;
  const status = document.getElementById('fStatus').value;

  filtered = allRows.filter(r => {
    if (region && r.Region !== region) return false;
    if (spec && r.MoveInSpecialist !== spec) return false;
    if (status) {
      const st = r._ctx?.status || '';
      if (st !== status) return false;
    }
    if (q) {
      const haystack = [
        r.Address, r.ResidentName, r.MoveInSpecialist, r.Concierge, r.Region,
        String(r.HomeId)
      ].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
  currentPage = 1;
  render();
}

function clearFilters() {
  ['fSearch', 'fRegion', 'fSpecialist', 'fStatus'].forEach(id => document.getElementById(id).value = '');
  persistFilters();
  applyFilters();
}

function persistFilters() {
  const state = {
    q: document.getElementById('fSearch').value,
    region: document.getElementById('fRegion').value,
    spec: document.getElementById('fSpecialist').value,
    status: document.getElementById('fStatus').value,
    pageSize
  };
  try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function restoreFilters() {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.q)       document.getElementById('fSearch').value = s.q;
    if (s.region)  document.getElementById('fRegion').value = s.region; // may not be an option yet
    if (s.spec)    document.getElementById('fSpecialist').value = s.spec;
    if (s.status)  document.getElementById('fStatus').value = s.status;
    if (s.pageSize) {
      pageSize = parseInt(s.pageSize, 10) || 20;
      const sel = document.getElementById('pageSizeSelect');
      if (sel) sel.value = String(pageSize);
    }
  } catch {}
}

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * pageSize;
  const end   = Math.min(start + pageSize, total);
  const page  = filtered.slice(start, end);

  document.getElementById('tableCount').innerHTML =
    `<strong>${total}</strong> <span>home${total !== 1 ? 's' : ''}${allRows.length !== total ? ` (of ${allRows.length})` : ''}</span>`;

  const tbody = document.getElementById('homesBody');
  if (!total) {
    tbody.innerHTML = `<tr><td colspan="7">
      <div class="empty-state">
        <div class="empty-icon">🏠</div>
        <div class="empty-title">${allRows.length ? 'No matches' : 'No homes yet'}</div>
        <div class="empty-sub">${allRows.length ? 'Clear filters to see more' : 'Ask admin to upload a BigQuery CSV in Manage'}</div>
      </div>
    </td></tr>`;
    renderPagination(0, 0, 0, 1);
    return;
  }

  tbody.innerHTML = page.map(r => rowHtml(r)).join('');
  renderPagination(start, end, total, totalPages);
}

function rowHtml(r) {
  const ctx = r._ctx;
  const status = ctx?.status || deriveStatusFromCsv(r);
  const statusLabel = labelForStatus(status);
  const isClickable = status === 'postponed' || status === 'grant_access';
  const expSet = expanded.get(r.HomeId) || new Set();

  // Lease date
  const leaseDate = r.LeaseStartOn
    ? new Date(r.LeaseStartOn).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

  // Address link
  const linkHref = r.AdminLink || `https://foundation.bln.hm/homes/${r.HomeId}`;

  // Repairs toggle visibility: CSV has unfinished improvements > 0
  const hasCsvRepairs = (r.UnfinishedImprovementsCount ?? 0) > 0;
  const hasClaudeRepairs = !!(ctx?.repairs_context);
  const showRepairsToggle = hasCsvRepairs; // CSV-gated per spec

  // Status toggle (Postponed/Grant Access)
  const statusOpen  = expSet.has('status');
  const repairsOpen = expSet.has('repairs');
  const hasExpansion = statusOpen || repairsOpen;

  const mainRow = `
    <tr class="${hasExpansion ? 'expanded' : ''}">
      <td>
        <span class="home-id" onclick="copyHomeId(event, ${r.HomeId})" title="Copy HomeId">#${r.HomeId}</span>
      </td>
      <td>
        <a class="addr-link" href="${escapeAttr(linkHref)}" target="_blank" rel="noopener">${escapeHtml(r.Address || '—')}</a>
        ${r.ResidentName ? `<div style="font-size:10px;color:var(--faint);margin-top:2px">${escapeHtml(r.ResidentName)}</div>` : ''}
      </td>
      <td style="font-size:11px;color:var(--muted)">${escapeHtml(r.Region || '—')}</td>
      <td style="font-size:11px;color:var(--muted)">${escapeHtml(r.MoveInSpecialist || '—')}</td>
      <td style="font-size:11px;color:var(--muted);white-space:nowrap">${leaseDate}</td>
      <td>
        <span class="status-badge status-${status} ${isClickable ? 'clickable' : ''} ${statusOpen ? 'active' : ''}"
              ${isClickable ? `onclick="toggleExpansion(${r.HomeId}, 'status')"` : ''}>
          ${statusLabel}
        </span>
      </td>
      <td>
        ${showRepairsToggle ? `
          <span class="row-action ${repairsOpen ? 'active' : ''}" onclick="toggleExpansion(${r.HomeId}, 'repairs')">
            🔧 Repairs${r.UnfinishedImprovementsCount ? ` (${r.UnfinishedImprovementsCount})` : ''}
          </span>
        ` : ''}
      </td>
    </tr>
  `;

  if (!hasExpansion) return mainRow;

  // Expansion row
  let expInner = '';

  if (repairsOpen) {
    let repairsBody = '';
    if (hasCsvRepairs) {
      const csvDetail = r.UnfinishedGroupDetails || r.AllUnfinishedDetails;
      repairsBody += `<div class="sublabel">From CSV (BigQuery)</div>`;
      repairsBody += `<div>${escapeHtml(csvDetail || `${r.UnfinishedImprovementsCount} unfinished improvements`)}</div>`;
    }
    if (hasClaudeRepairs) {
      repairsBody += `<div class="sublabel">From Slack (Claude analysis)</div>`;
      repairsBody += `<div>${escapeHtml(ctx.repairs_context)}</div>`;
    }
    expInner += `
      <div class="exp-section">
        <div class="exp-header">
          <span class="exp-label">🔧 Repairs</span>
          <button class="exp-close" onclick="toggleExpansion(${r.HomeId}, 'repairs')" aria-label="Close">✕</button>
        </div>
        <div class="exp-body">${repairsBody}</div>
      </div>
    `;
  }

  if (statusOpen) {
    const title =
      status === 'postponed'    ? '🔴 Postponed' :
      status === 'grant_access' ? '🟡 Grant Access — Expectations' : 'Status';
    const body =
      status === 'postponed'    ? (ctx?.postpone_reason || ctx?.repairs_context || '—') :
      status === 'grant_access' ? (ctx?.expectations   || ctx?.repairs_context || '—') : '—';
    expInner += `
      <div class="exp-section">
        <div class="exp-header">
          <span class="exp-label">${title}</span>
          <button class="exp-close" onclick="toggleExpansion(${r.HomeId}, 'status')" aria-label="Close">✕</button>
        </div>
        <div class="exp-body">${escapeHtml(body)}</div>
      </div>
    `;
  }

  return mainRow + `
    <tr class="expansion">
      <td colspan="7"><div class="exp-inner">${expInner}</div></td>
    </tr>
  `;
}

function deriveStatusFromCsv(r) {
  // When no Claude context exists, fall back to CSV milestone.
  if (r.MoveInCompleted) return 'signed_off';
  return 'in_progress';
}

function labelForStatus(s) {
  return ({
    ready:        'Ready',
    postponed:    'Postponed',
    grant_access: 'Grant Access',
    signed_off:   'Signed Off',
    in_progress:  'In Progress'
  })[s] || 'Unknown';
}

function toggleExpansion(homeId, kind) {
  const set = expanded.get(homeId) || new Set();
  set.has(kind) ? set.delete(kind) : set.add(kind);
  if (set.size === 0) expanded.delete(homeId);
  else expanded.set(homeId, set);
  render();
}

function copyHomeId(ev, id) {
  ev.stopPropagation();
  navigator.clipboard?.writeText(String(id));
  const el = ev.currentTarget;
  el.classList.add('copied');
  const original = el.textContent;
  el.textContent = '✓ Copied';
  setTimeout(() => { el.classList.remove('copied'); el.textContent = original; }, 900);
}

function renderPagination(start, end, total, totalPages) {
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

function goPage(p) {
  const totalPages = Math.ceil(filtered.length / pageSize);
  if (p < 1 || p > totalPages) return;
  currentPage = p;
  render();
}

function changePageSize() {
  pageSize = parseInt(document.getElementById('pageSizeSelect').value, 10);
  currentPage = 1;
  persistFilters();
  render();
}

// ── Utils ────────────────────────────────────────────────────────────────────
function escapeHtml(s = '') {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s = '') { return escapeHtml(s); }
