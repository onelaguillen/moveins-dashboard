// ── Dashboard (/) page logic ─────────────────────────────────────────────────
// Reads `homes` + `home_repair_context`, renders Belong-style dashboard with
// clickable metric cards, date range filter, and per-row toggle panels.

const FILTER_STORAGE_KEY = 'belong.dashboard.filters.v2';
const URGENT_DAYS = 2;

let allRows   = [];
let filtered  = [];
let currentPage = 1;
let pageSize    = 20;

const filterState = {
  q: '',
  statusCard: '',     // 'ready' | 'in_progress' | 'urgent' | 'grant_access' | 'postponed' | 'signed_off' | ''
  dateFrom: '',
  dateTo: '',
  dateChip: '',       // 'overdue' | 'this_week' | '30_days' | ''
  region: '',
  spec: ''
};

// Row expansion state: Map<homeId, Set<'repairs'|'status'>>
const expanded = new Map();

// ── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  const session = await requireAuth(false);
  if (!session) return;

  await mountHeader({ page: 'dashboard', session });
  startIdleWatcher();
  startPresence(session);

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
      '"HomeId","Address","Region","ResidentName",' +
      '"MoveInSpecialist","Concierge","ImprovementsSpecialist",' +
      '"LeaseStartOn","CurrentMilestone","MoveInReady","MoveInCompleted",' +
      '"AdminLink",' +
      '"RentAmount","DepositAmount","PaymentStatus","BalanceDetail",' +
      '"UnfinishedImprovements","UnfinishedImprovementsCount",' +
      '"UnfinishedGroupDetails","AllUnfinishedDetails",' +
      '"HasHoa","HoaIsNotified"'
    ).order('"LeaseStartOn"', { ascending: true }),
    sb.from('home_repair_context').select('*')
  ]);

  if (homesRes.error) { showToast('Failed to load homes: ' + homesRes.error.message, 'error'); return; }
  if (ctxRes.error)   { console.warn('Context load failed:', ctxRes.error.message); }

  const ctxByHome = new Map((ctxRes.data || []).map(r => [r.home_id, r]));
  allRows = (homesRes.data || []).map(h => ({
    ...h,
    _ctx: ctxByHome.get(h.HomeId) || null,
    _status: deriveStatus(h, ctxByHome.get(h.HomeId) || null)
  }));

  populateSelectOptions();
  renderMetrics();
  applyFilters();
}

// ── Filters ──────────────────────────────────────────────────────────────────
function wireFilters() {
  document.getElementById('fSearch').addEventListener('input', e => {
    filterState.q = e.target.value;
    persistFilters(); applyFilters();
  });
  initDateRangePicker();
  document.getElementById('fDateClear').addEventListener('click', () => {
    filterState.dateFrom = ''; filterState.dateTo = ''; filterState.dateChip = '';
    if (window._datePicker) window._datePicker.clear();
    updateDateClearUI();
    updateDateChipsUI();
    persistFilters(); applyFilters();
  });
  document.getElementById('fRegion').addEventListener('change', e => {
    filterState.region = e.target.value; persistFilters(); applyFilters();
  });
  document.getElementById('fSpecialist').addEventListener('change', e => {
    filterState.spec = e.target.value; persistFilters(); applyFilters();
  });
  document.getElementById('fClear').addEventListener('click', clearFilters);
}

function initDateRangePicker() {
  const input = document.getElementById('fDateRange');
  if (!input || !window.flatpickr) return;
  const initial = [];
  if (filterState.dateFrom) initial.push(filterState.dateFrom);
  if (filterState.dateTo && filterState.dateTo !== filterState.dateFrom) initial.push(filterState.dateTo);

  window._datePicker = flatpickr(input, {
    mode: 'range',
    dateFormat: 'Y-m-d',
    altInput: true,
    altFormat: 'M j, Y',
    defaultDate: initial,
    onChange(selectedDates) {
      const fmt = d => d.toISOString().slice(0, 10);
      if (selectedDates.length === 0) {
        filterState.dateFrom = ''; filterState.dateTo = '';
      } else if (selectedDates.length === 1) {
        filterState.dateFrom = fmt(selectedDates[0]);
        filterState.dateTo   = fmt(selectedDates[0]);
      } else {
        filterState.dateFrom = fmt(selectedDates[0]);
        filterState.dateTo   = fmt(selectedDates[selectedDates.length - 1]);
      }
      filterState.dateChip = '';
      updateDateClearUI();
      updateDateChipsUI();
      persistFilters(); applyFilters();
    }
  });
  updateDateClearUI();
}

function updateDateClearUI() {
  const btn = document.getElementById('fDateClear');
  if (!btn) return;
  btn.style.display = (filterState.dateFrom || filterState.dateTo) ? '' : 'none';
}

function populateSelectOptions() {
  const regionSel = document.getElementById('fRegion');
  const specSel   = document.getElementById('fSpecialist');
  const regions = [...new Set(allRows.map(r => r.Region).filter(Boolean))].sort();
  const specs   = [...new Set(allRows.map(r => r.MoveInSpecialist).filter(Boolean))].sort();
  regionSel.innerHTML = `<option value="">All regions</option>` +
    regions.map(r => `<option${r === filterState.region ? ' selected' : ''}>${escapeHtml(r)}</option>`).join('');
  specSel.innerHTML = `<option value="">All specialists</option>` +
    specs.map(s => `<option${s === filterState.spec ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
}

function applyFilters() {
  const q = (filterState.q || '').trim().toLowerCase();
  const now = startOfDay(new Date());

  filtered = allRows.filter(r => {
    // Metric card filter
    if (filterState.statusCard) {
      if (filterState.statusCard === 'urgent') {
        // urgent = LeaseStartOn within URGENT_DAYS and not ready/signed_off
        if (!r.LeaseStartOn) return false;
        const d = startOfDay(new Date(r.LeaseStartOn));
        const diff = Math.ceil((d - now) / (24 * 60 * 60 * 1000));
        if (!(diff >= 0 && diff <= URGENT_DAYS)) return false;
        if (r._status === 'ready' || r._status === 'signed_off') return false;
      } else {
        if (r._status !== filterState.statusCard) return false;
      }
    }

    if (filterState.region && r.Region !== filterState.region) return false;
    if (filterState.spec   && r.MoveInSpecialist !== filterState.spec) return false;

    // Date range
    if (filterState.dateFrom || filterState.dateTo) {
      if (!r.LeaseStartOn) return false;
      const d = startOfDay(new Date(r.LeaseStartOn));
      if (filterState.dateFrom && d < startOfDay(new Date(filterState.dateFrom))) return false;
      if (filterState.dateTo   && d > startOfDay(new Date(filterState.dateTo)))   return false;
    }

    if (q) {
      const haystack = [
        r.Address, r.ResidentName, r.MoveInSpecialist, r.Concierge,
        r.ImprovementsSpecialist, r.Region, String(r.HomeId),
        r._ctx?.repairs_context, r._ctx?.postpone_reason, r._ctx?.expectations
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
  currentPage = 1;
  render();
}

function clearFilters() {
  filterState.q = ''; filterState.statusCard = '';
  filterState.dateFrom = ''; filterState.dateTo = ''; filterState.dateChip = '';
  filterState.region = ''; filterState.spec = '';
  document.getElementById('fSearch').value = '';
  if (window._datePicker) window._datePicker.clear();
  document.getElementById('fRegion').value = '';
  document.getElementById('fSpecialist').value = '';
  updateMetricCardsUI();
  updateDateClearUI();
  updateDateChipsUI();
  persistFilters();
  applyFilters();
}

function persistFilters() {
  try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({ ...filterState, pageSize })); } catch {}
}
function restoreFilters() {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    Object.assign(filterState, {
      q: s.q || '', statusCard: s.statusCard || '',
      dateFrom: s.dateFrom || '', dateTo: s.dateTo || '', dateChip: s.dateChip || '',
      region: s.region || '', spec: s.spec || ''
    });
    if (s.pageSize) pageSize = parseInt(s.pageSize, 10) || 20;
    document.getElementById('fSearch').value = filterState.q;
    const ps = document.getElementById('pageSizeSelect');
    if (ps) ps.value = String(pageSize);
  } catch {}
}

// ── Metric cards ─────────────────────────────────────────────────────────────
function computeMetrics() {
  const now = startOfDay(new Date());
  const m = { total: 0, ready: 0, in_progress: 0, urgent: 0, grant_access: 0, postponed: 0, signed_off: 0 };
  allRows.forEach(r => {
    m.total++;
    if (m[r._status] != null) m[r._status]++;
    if (r.LeaseStartOn && r._status !== 'ready' && r._status !== 'signed_off') {
      const d = startOfDay(new Date(r.LeaseStartOn));
      const diff = Math.ceil((d - now) / (24 * 60 * 60 * 1000));
      if (diff >= 0 && diff <= URGENT_DAYS) m.urgent++;
    }
  });
  return m;
}

function renderMetrics() {
  const m = computeMetrics();
  const cards = [
    { key: '',             label: 'Total Homes',     value: m.total,        cls: 'm-total' },
    { key: 'ready',        label: 'Ready for Tami',  value: m.ready,        cls: 'm-ready' },
    { key: 'in_progress',  label: 'In Progress',     value: m.in_progress,  cls: 'm-in_progress' },
    { key: 'urgent',       label: 'Urgent ≤2 Days',  value: m.urgent,       cls: 'm-urgent' },
    { key: 'grant_access', label: '🔑 Grant Access',  value: m.grant_access, cls: 'm-grant_access' },
    { key: 'postponed',    label: '⚠ Postponed',     value: m.postponed,    cls: 'm-postponed' },
    { key: 'signed_off',   label: '✅ Signed Off',    value: m.signed_off,   cls: 'm-signed_off' }
  ];
  document.getElementById('metricStrip').innerHTML = cards.map(c => `
    <div class="metric-card ${c.cls} ${filterState.statusCard === c.key && c.key !== '' ? 'active' : ''}"
         onclick="setStatusCard('${c.key}')">
      <div class="metric-label">${c.label}</div>
      <div class="metric-value">${c.value}</div>
    </div>
  `).join('');
}

function setStatusCard(key) {
  // Toggle off if already active, otherwise set it. Empty key = "Total" = clear.
  filterState.statusCard = (!key || filterState.statusCard === key) ? '' : key;
  updateMetricCardsUI();
  persistFilters();
  applyFilters();
}

function updateMetricCardsUI() {
  document.querySelectorAll('.metric-card').forEach(el => el.classList.remove('active'));
  if (!filterState.statusCard) return;
  const el = [...document.querySelectorAll('.metric-card')]
    .find(c => c.getAttribute('onclick')?.includes(`setStatusCard('${filterState.statusCard}')`));
  if (el) el.classList.add('active');
}

// ── Date chips ───────────────────────────────────────────────────────────────
function setDateChip(chip) {
  const today = startOfDay(new Date());
  const fmt = d => d.toISOString().slice(0, 10);

  if (filterState.dateChip === chip) {
    // Toggle off
    filterState.dateChip = ''; filterState.dateFrom = ''; filterState.dateTo = '';
  } else {
    filterState.dateChip = chip;
    if (chip === 'overdue') {
      filterState.dateFrom = ''; filterState.dateTo = fmt(addDays(today, -1));
    } else if (chip === 'this_week') {
      const dow = today.getDay();                    // 0=Sun
      const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
      const sunday = addDays(monday, 6);
      filterState.dateFrom = fmt(monday); filterState.dateTo = fmt(sunday);
    } else if (chip === '30_days') {
      filterState.dateFrom = fmt(today); filterState.dateTo = fmt(addDays(today, 30));
    }
  }
  if (window._datePicker) {
    if (filterState.dateFrom && filterState.dateTo) {
      window._datePicker.setDate([filterState.dateFrom, filterState.dateTo], false);
    } else if (filterState.dateFrom) {
      window._datePicker.setDate([filterState.dateFrom], false);
    } else if (filterState.dateTo) {
      window._datePicker.setDate([filterState.dateTo], false);
    } else {
      window._datePicker.clear();
    }
  }
  updateDateClearUI();
  updateDateChipsUI();
  persistFilters();
  applyFilters();
}
function updateDateChipsUI() {
  ['overdue', 'this_week', '30_days'].forEach(c => {
    const el = document.getElementById('chip_' + c);
    if (el) el.classList.toggle('active', filterState.dateChip === c);
  });
}

// ── Render table ─────────────────────────────────────────────────────────────
function render() {
  renderMetrics();  // keep counts live (they don't change from filters, but layout re-highlights)
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * pageSize;
  const end   = Math.min(start + pageSize, total);
  const page  = filtered.slice(start, end);

  document.getElementById('tableCount').innerHTML =
    `<strong>${total}</strong> <span>home${total !== 1 ? 's' : ''}${allRows.length !== total ? ` of ${allRows.length}` : ''}</span>`;

  const tbody = document.getElementById('homesBody');
  if (!total) {
    tbody.innerHTML = `<tr><td colspan="8">
      <div class="empty-state">
        <div class="empty-icon">🏠</div>
        <div class="empty-title">${allRows.length ? 'No matches' : 'No homes yet'}</div>
        <div class="empty-sub">${allRows.length ? 'Clear filters to see more' : 'Ask admin to upload a BigQuery CSV in Manage'}</div>
      </div>
    </td></tr>`;
    renderPagination(0, 0, 0, 1);
    return;
  }

  tbody.innerHTML = page.map(rowHtml).join('');
  renderPagination(start, end, total, totalPages);
}

function rowHtml(r) {
  const ctx = r._ctx;
  const status = r._status;
  const statusLabel = labelForStatus(status);
  const clickableStatus = status === 'postponed' || status === 'grant_access';
  const expSet = expanded.get(r.HomeId) || new Set();

  const linkHref = r.AdminLink || `https://foundation.bln.hm/homes/${r.HomeId}`;
  const hasCsvRepairs = (r.UnfinishedImprovementsCount ?? 0) > 0;
  const statusOpen  = expSet.has('status');
  const repairsOpen = expSet.has('repairs');
  const hasExpansion = statusOpen || repairsOpen;

  const paymentBadge = paymentBadgeHtml(r.PaymentStatus);
  const hoaBadge     = hoaBadgeHtml(r.HasHoa, r.HoaIsNotified);

  const mainRow = `
    <tr class="${hasExpansion ? 'expanded' : ''}">
      <td>
        <a class="addr-link" href="${escapeAttr(linkHref)}" target="_blank" rel="noopener">${escapeHtml(r.Address || '—')}</a>
        ${r.MoveInSpecialist ? `<div style="font-size:10px;color:var(--faint);margin-top:2px">MIS · ${escapeHtml(r.MoveInSpecialist)}</div>` : ''}
      </td>
      <td style="font-size:12px">${escapeHtml(r.ResidentName || '—')}</td>
      <td class="mono" style="font-size:11px;color:var(--muted);white-space:nowrap">${formatDateNumeric(r.LeaseStartOn)}</td>
      <td>${paymentBadge}</td>
      <td>${hoaBadge}</td>
      <td style="font-size:11px;color:var(--muted)">${escapeHtml(r.ImprovementsSpecialist || '—')}</td>
      <td>
        <span class="status-badge status-${status} ${clickableStatus ? 'clickable' : ''} ${statusOpen ? 'active' : ''}"
              ${clickableStatus ? `onclick="toggleExpansion(${r.HomeId}, 'status')"` : ''}>
          ${statusLabel}
        </span>
      </td>
      <td>
        ${hasCsvRepairs ? `
          <span class="row-action ${repairsOpen ? 'active' : ''}" onclick="toggleExpansion(${r.HomeId}, 'repairs')">
            🔧 ${r.UnfinishedImprovementsCount}
          </span>
        ` : ''}
      </td>
    </tr>
  `;

  if (!hasExpansion) return mainRow;

  let expInner = '';
  if (repairsOpen) {
    const items = parseRepairs(r.AllUnfinishedDetails || r.UnfinishedGroupDetails);
    const listHtml = items.length
      ? `<div class="repairs-grid">${items.map(it => it.id
          ? `<a class="repair-card" href="https://foundation.bln.hm/maintenance/${it.id}" target="_blank" rel="noopener">
               <span class="repair-id">#${it.id}</span>
               <span>${escapeHtml(it.label)}</span>
               <span class="repair-ext">↗</span>
             </a>`
          : `<span class="repair-card">${escapeHtml(it.label)}</span>`
        ).join('')}</div>`
      : `<div class="faint">${r.UnfinishedImprovementsCount} unfinished improvements</div>`;
    const note = ctx?.repairs_context
      ? `<div class="repairs-note">${escapeHtml(ctx.repairs_context)}</div>` : '';
    expInner += `
      <div class="exp-section">
        <div class="exp-header">
          <span class="exp-label">🔧 Repairs</span>
          <button class="exp-close" onclick="toggleExpansion(${r.HomeId}, 'repairs')" aria-label="Close">✕</button>
        </div>
        <div class="exp-body">${listHtml}${note}</div>
      </div>
    `;
  }
  if (statusOpen) {
    const title = status === 'postponed' ? 'Postponed' : 'Grant Access — Expectations';
    const body  = status === 'postponed'
      ? (ctx?.postpone_reason || ctx?.repairs_context || '—')
      : (ctx?.expectations    || ctx?.repairs_context || '—');
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

  return mainRow + `<tr class="expansion"><td colspan="8"><div class="exp-inner">${expInner}</div></td></tr>`;
}

function toggleExpansion(homeId, kind) {
  const set = expanded.get(homeId) || new Set();
  set.has(kind) ? set.delete(kind) : set.add(kind);
  if (set.size === 0) expanded.delete(homeId);
  else expanded.set(homeId, set);
  render();
}

// ── Pagination ───────────────────────────────────────────────────────────────
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

// ── Helpers ──────────────────────────────────────────────────────────────────
function deriveStatus(h, ctx) {
  // 1. Slack context wins if present
  if (ctx?.status) return ctx.status;

  // 2. CSV fallback — BUT only trust milestone dates that belong to the CURRENT lease.
  //    BigQuery sometimes carries over LastMoveInCompleted/LastMoveInReady from a
  //    previous lease. We only treat them as current if >= LeaseStartOn.
  if (isCurrentLeaseDate(h.MoveInCompleted, h.LeaseStartOn)) return 'signed_off';
  return 'in_progress';
}

// Returns true if `milestoneDate` is a real event in the CURRENT lease cycle.
// Guards against stale BigQuery rows where Last* fields point at a previous lease.
function isCurrentLeaseDate(milestoneDate, leaseStartOn) {
  if (!milestoneDate) return false;
  if (!leaseStartOn) return false; // no lease to anchor against → don't trust
  const m = new Date(milestoneDate);
  const l = new Date(leaseStartOn);
  if (isNaN(m) || isNaN(l)) return false;
  // Compare calendar days so an on-the-day match still counts
  return startOfDay(m) >= startOfDay(l);
}

function labelForStatus(s) {
  return ({
    ready: 'Ready', postponed: 'Postponed', grant_access: 'Grant Access',
    signed_off: 'Signed Off', in_progress: 'In Progress'
  })[s] || 'Unknown';
}

function paymentBadgeHtml(status) {
  if (!status) return `<span class="mini-badge mini-none">—</span>`;
  const isPaid = /all\s*paid/i.test(status);
  const isPartial = /unpaid/i.test(status) && !/both/i.test(status);
  const cls = isPaid ? 'mini-ok' : (isPartial ? 'mini-warn' : 'mini-err');
  return `<span class="mini-badge ${cls}">${escapeHtml(status)}</span>`;
}

function hoaBadgeHtml(hasHoa, notified) {
  if (!hasHoa || hasHoa === 0) return `<span class="mini-badge mini-none">No HOA</span>`;
  if (notified === 1) return `<span class="mini-badge mini-ok">Notified</span>`;
  return `<span class="mini-badge mini-warn">Not notified</span>`;
}

function parseRepairs(str) {
  if (!str) return [];
  return String(str).split('|').map(s => s.trim()).filter(Boolean).map(item => {
    const i = item.indexOf(':');
    if (i === -1) return { id: null, label: item };
    const id = item.slice(0, i).trim();
    const label = item.slice(i + 1).trim();
    return { id: /^\d+$/.test(id) ? id : null, label };
  });
}

function formatDateNumeric(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return '—';
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const yy = dt.getUTCFullYear();
  return `${mm}/${dd}/${yy}`;
}

function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

function escapeHtml(s = '') {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escapeAttr(s = '') { return escapeHtml(s); }
