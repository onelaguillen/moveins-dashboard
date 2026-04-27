// ── Dashboard (/) page logic ─────────────────────────────────────────────────
// v3 schema: reads via dataSource, derives view-models via derive.js.

const FILTER_STORAGE_KEY = 'belong.dashboard.filters.v3';
const URGENT_DAYS = 2;

let allRows   = [];          // enriched homes (post-derive)
let filtered  = [];
let currentPage = 1;
let pageSize    = 20;

const filterState = {
  q: '',
  statusCard: '',     // 'ready' | 'in_progress' | 'urgent' | 'handed_off' | ''
  dateFrom: '',
  dateTo: '',
  dateChip: '',       // 'overdue' | 'this_week' | '30_days' | ''
  // Combined specialists: arrays of names. OR within section, AND across sections.
  misNames: [],
  hqsNames: [],
  fastMoveIn: false,
  noQaOnly: false,
  unpricedOnly: false,
  requiredOnly: false,
  showHandedOff: false, // hide handed-off homes by default
  columnFilters: {}
};

// Delay reason chip presets
const DELAY_REASON_OPTIONS = [
  { value: 'waiting_resident',   label: 'Waiting on resident' },
  { value: 'pro_delay',          label: 'Pro delay' },
  { value: 'vendor_reschedule',  label: 'Vendor reschedule' },
  { value: 'hoa',                label: 'HOA' },
  { value: 'payment',            label: 'Payment' },
  { value: 'parts_materials',    label: 'Parts / materials' },
  { value: 'inspection',         label: 'Inspection / QA' },
  { value: 'other',              label: 'Other' }
];

// Manual status options
const MANUAL_STATUS_OPTIONS = [
  { value: 'on_track',              label: 'On Track' },
  { value: 'at_risk',               label: 'At Risk' },
  { value: 'urgent',                label: 'Urgent' },
  { value: 'blocked',               label: 'Blocked' },
  { value: 'handed_off',            label: 'Handed Off' },
  { value: 'lease_break',           label: 'Lease Break' },
  { value: 'back_out',              label: 'Back Out' },
  { value: 'back_out_lease_break',  label: 'Back Out + Lease Break' },
  { value: 'back_out_self_manage',  label: 'Back Out + Self Manage' }
];

// Column-filter config: per-column filter options + predicate.
const COLUMN_FILTERS = {
  HOA: {
    label: 'HOA',
    options: [
      { value: 'no_hoa',       label: 'No HOA',       test: r => !r.has_hoa },
      { value: 'notified',     label: 'Notified',     test: r => r.has_hoa &&  r.hoa_is_notified },
      { value: 'not_notified', label: 'Not notified', test: r => r.has_hoa && !r.hoa_is_notified }
    ]
  },
  Payment: {
    label: 'Payment',
    options: [
      { value: 'all_paid',        label: 'All paid',        test: r => r.derived.payment_status === 'all_paid' },
      { value: 'deposit_unpaid',  label: 'Deposit unpaid',  test: r => r.derived.payment_status === 'deposit_unpaid' },
      { value: 'rent_unpaid',     label: 'Rent unpaid',     test: r => r.derived.payment_status === 'rent_unpaid' },
      { value: 'both_unpaid',     label: 'Both unpaid',     test: r => r.derived.payment_status === 'both_unpaid' },
      { value: 'autopay_on',      label: 'Autopay on',      test: r => r.enrolled_in_auto_pay === true },
      { value: 'autopay_off',     label: 'Autopay off',     test: r => r.enrolled_in_auto_pay === false }
    ]
  },
  Status: {
    label: 'Status',
    options: [
      { value: 'ready',        label: 'Ready',        test: r => r.derived.effective_status === 'ready' },
      { value: 'on_track',     label: 'On Track',     test: r => r.derived.effective_status === 'on_track' },
      { value: 'in_progress',  label: 'In Progress',  test: r => r.derived.effective_status === 'in_progress' },
      { value: 'at_risk',      label: 'At Risk',      test: r => r.derived.effective_status === 'at_risk' },
      { value: 'urgent',       label: 'Urgent',       test: r => r.derived.effective_status === 'urgent' },
      { value: 'blocked',      label: 'Blocked',      test: r => r.derived.effective_status === 'blocked' },
      { value: 'handed_off',   label: 'Handed off',   test: r => r.derived.effective_status === 'handed_off' || !!r.context?.handed_off_to_concierge },
      { value: 'lease_break',           label: 'Lease Break',          test: r => r.derived.effective_status === 'lease_break' },
      { value: 'back_out',              label: 'Back Out',             test: r => r.derived.effective_status === 'back_out' },
      { value: 'back_out_lease_break',  label: 'Back Out + Lease Break', test: r => r.derived.effective_status === 'back_out_lease_break' },
      { value: 'back_out_self_manage',  label: 'Back Out + Self Manage', test: r => r.derived.effective_status === 'back_out_self_manage' }
    ]
  },
  HQS: {
    label: 'HQS',
    dynamic: true,
    build: rows => {
      const names = [...new Set(rows.map(r => r.improvements_specialist).filter(Boolean))].sort();
      const opts = names.map(n => ({
        value: n, label: n, test: r => r.improvements_specialist === n
      }));
      opts.unshift({ value: '__none__', label: '— Unassigned —', test: r => !r.improvements_specialist });
      return opts;
    }
  }
};

const sortState = { key: 'lease_start_on', dir: 'asc' };
const SORT_KEYS = {
  Address:        r => (r.address || '').toLowerCase(),
  Resident:       r => (r.resident_name || '').toLowerCase(),
  lease_start_on: r => r.lease_start_on ? new Date(r.lease_start_on).getTime() : Infinity,
  Payment:        r => (r.derived.payment_status || '').toLowerCase(),
  HOA:            r => (r.has_hoa ? 1 : 0) + (r.hoa_is_notified ? 0.5 : 0),
  HQS:            r => (r.improvements_specialist || '').toLowerCase(),
  Status:         r => r.derived.effective_status || ''
};

function setSort(key) {
  if (!SORT_KEYS[key]) return;
  if (sortState.key === key) {
    sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    sortState.key = key; sortState.dir = 'asc';
  }
  applyFilters();
}

// Drawer state: which home is open (or null).
let drawerHomeId = null;
// In-memory drafts for the new-entry boxes (not yet saved).
const drawerDraft = {
  noteBody: '',
  delayChips: [],
  delayBody: '',
  delayOther: ''
};
// Log entries for the open home, loaded on demand.
let drawerLogEntries = [];

// Track the current user's email so we can show "by Onela G." inline.
let currentUserEmail = null;

// ── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  const session = await requireAuth(false);
  if (!session) return;
  currentUserEmail = session?.user?.email || null;

  await mountHeader({ page: 'dashboard', session });
  startIdleWatcher();
  startPresence(session);

  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('pageContent').style.display = 'block';

  restoreFilters();
  wireFilters();
  await loadData();
})();

function canDeleteEntry(entry) {
  if (!entry || !currentUserEmail) return false;
  // ADMIN_EMAILS (Set) is defined in supabase.js
  if (typeof isAdmin === 'function' && isAdmin(currentUserEmail)) return true;
  return (entry.created_by_email || '').toLowerCase() === currentUserEmail.toLowerCase();
}

// ── Data ─────────────────────────────────────────────────────────────────────
async function loadData() {
  try {
    const [homes, repairs, proServices, repairStatuses, repairContext] = await Promise.all([
      dataSource.getHomes(),
      dataSource.getRepairs(),
      dataSource.getProServices(),
      dataSource.getRepairStatuses(),
      dataSource.getRepairContext()
    ]);

    allRows = deriveViewModels(homes, repairs, proServices, repairStatuses, repairContext);

    populateSelectOptions();
    renderMetrics();
    applyFilters();
  } catch (err) {
    console.error(err);
    showToast('Failed to load: ' + err.message, 'error');
  }
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
  document.getElementById('fClear').addEventListener('click', clearFilters);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeDrawer(); closeSpecialistMenu(); }
  });
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
  updateSpecialistButtonLabel();
}

function updateSpecialistButtonLabel() {
  const btn = document.getElementById('fSpecialistBtn');
  const lbl = document.getElementById('fSpecialistLabel');
  if (!btn || !lbl) return;
  const m = filterState.misNames || [];
  const h = filterState.hqsNames || [];
  const total = m.length + h.length;
  if (total === 0) { lbl.textContent = 'All specialists'; btn.classList.remove('has-active'); return; }
  btn.classList.add('has-active');
  const parts = [];
  if (m.length) parts.push(`MIS: ${m.length === 1 ? m[0] : m.length}`);
  if (h.length) parts.push(`HQS: ${h.length === 1 ? h[0] : h.length}`);
  lbl.textContent = parts.join(' · ');
}

// Combined MIS+HQS multi-select popover
function toggleSpecialistMenu(event) {
  event.stopPropagation();
  const existing = document.getElementById('specialistPop');
  if (existing) { existing.remove(); return; }
  const anchor = document.getElementById('fSpecialistBtn');
  const misNames = [...new Set(allRows.map(r => r.move_in_specialist).filter(Boolean))].sort();
  const hqsNames = [...new Set(allRows.map(r => r.improvements_specialist).filter(Boolean))].sort();
  const misSel = new Set(filterState.misNames || []);
  const hqsSel = new Set(filterState.hqsNames || []);

  const pop = document.createElement('div');
  pop.id = 'specialistPop';
  pop.className = 'multi-pop';
  pop.innerHTML = `
    <div class="mp-section-title">MIS — Move-In Specialist</div>
    <div class="mp-list" data-section="mis">
      ${misNames.length
        ? misNames.map(n => `
          <label class="mp-opt">
            <input type="checkbox" data-section="mis" value="${escapeAttr(n)}" ${misSel.has(n) ? 'checked' : ''}>
            <span>${escapeHtml(n)}</span>
          </label>
        `).join('')
        : '<div class="faint" style="padding:6px">No MIS</div>'}
    </div>
    <div class="mp-divider"></div>
    <div class="mp-section-title">HQS — Home Quality Specialist</div>
    <div class="mp-list" data-section="hqs">
      ${hqsNames.length
        ? hqsNames.map(n => `
          <label class="mp-opt">
            <input type="checkbox" data-section="hqs" value="${escapeAttr(n)}" ${hqsSel.has(n) ? 'checked' : ''}>
            <span>${escapeHtml(n)}</span>
          </label>
        `).join('')
        : '<div class="faint" style="padding:6px">No HQS</div>'}
    </div>
    <div class="mp-actions">
      <button type="button" class="mp-clear">Clear</button>
      <button type="button" class="mp-apply">Apply</button>
    </div>
  `;
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.top  = (window.scrollY + rect.bottom + 4) + 'px';
  pop.style.left = (window.scrollX + rect.left) + 'px';

  pop.querySelector('.mp-apply').onclick = () => {
    filterState.misNames = [...pop.querySelectorAll('input[data-section="mis"]:checked')].map(i => i.value);
    filterState.hqsNames = [...pop.querySelectorAll('input[data-section="hqs"]:checked')].map(i => i.value);
    persistFilters(); applyFilters();
    updateSpecialistButtonLabel();
    pop.remove();
  };
  pop.querySelector('.mp-clear').onclick = () => {
    filterState.misNames = []; filterState.hqsNames = [];
    persistFilters(); applyFilters();
    updateSpecialistButtonLabel();
    pop.remove();
  };

  setTimeout(() => {
    document.addEventListener('click', _closeSpecialistOnOutside, { once: true });
  }, 0);
}
function _closeSpecialistOnOutside(e) {
  const pop = document.getElementById('specialistPop');
  if (!pop) return;
  if (pop.contains(e.target) || e.target.closest('#fSpecialistBtn')) {
    document.addEventListener('click', _closeSpecialistOnOutside, { once: true });
    return;
  }
  pop.remove();
}
function closeSpecialistMenu() {
  const pop = document.getElementById('specialistPop');
  if (pop) pop.remove();
}

function applyFilters() {
  const q = (filterState.q || '').trim().toLowerCase();

  filtered = allRows.filter(r => {
    // Hide handed-off homes by default; the 'handed_off' status card or chip toggles them.
    const handedOff = !!r.context?.handed_off_to_concierge;
    if (handedOff && !filterState.showHandedOff && filterState.statusCard !== 'handed_off') return false;

    // Metric card filter (uses effective status: manual override wins, else auto-derived)
    if (filterState.statusCard) {
      const eff = r.derived.effective_status;
      if (filterState.statusCard === 'urgent') {
        if (eff !== 'urgent') return false;
      } else if (filterState.statusCard === 'handed_off') {
        if (!handedOff) return false;
      } else {
        if (eff !== filterState.statusCard) return false;
      }
    }

    // Combined MIS+HQS filter: OR within each section, AND across sections.
    const mis = filterState.misNames || [];
    const hqs = filterState.hqsNames || [];
    if (mis.length && !mis.includes(r.move_in_specialist)) return false;
    if (hqs.length && !hqs.includes(r.improvements_specialist)) return false;

    if (filterState.fastMoveIn && !r.derived.is_fast_move_in) return false;
    if (filterState.noQaOnly && r.qa_group_id) return false;
    if (filterState.unpricedOnly && !r.derived.has_unpriced_open_repair) return false;
    if (filterState.requiredOnly && !r.repairs.some(x => x.repair_assessment === 'Required' && x.status !== 'done')) return false;

    // Column filters (Excel-style popovers)
    for (const [key, values] of Object.entries(filterState.columnFilters || {})) {
      if (!values || !values.length) continue;
      const cfg = COLUMN_FILTERS[key];
      if (!cfg) continue;
      const allOpts = cfg.dynamic ? cfg.build(allRows || []) : cfg.options;
      const opts = allOpts.filter(o => values.includes(o.value));
      if (!opts.some(o => o.test(r))) return false;
    }

    if (filterState.dateFrom || filterState.dateTo) {
      if (!r.lease_start_on) return false;
      const d = startOfDay(new Date(r.lease_start_on));
      if (filterState.dateFrom && d < startOfDay(new Date(filterState.dateFrom))) return false;
      if (filterState.dateTo   && d > startOfDay(new Date(filterState.dateTo)))   return false;
    }

    if (q) {
      const ctx = r.context || {};
      const haystack = [
        r.address, r.resident_name, r.move_in_specialist, r.concierge,
        r.improvements_specialist, r.region, String(r.home_id),
        ctx.repairs_context, ctx.postpone_reason, ctx.expectations
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const keyFn = SORT_KEYS[sortState.key] || SORT_KEYS.lease_start_on;
  const mul = sortState.dir === 'desc' ? -1 : 1;
  filtered.sort((a, b) => {
    const va = keyFn(a), vb = keyFn(b);
    if (va < vb) return -1 * mul;
    if (va > vb) return  1 * mul;
    return 0;
  });

  currentPage = 1;
  render();
}

function clearFilters() {
  filterState.q = ''; filterState.statusCard = '';
  filterState.dateFrom = ''; filterState.dateTo = ''; filterState.dateChip = '';
  filterState.misNames = []; filterState.hqsNames = [];
  filterState.fastMoveIn = false;
  filterState.noQaOnly = false;
  filterState.unpricedOnly = false;
  filterState.requiredOnly = false;
  filterState.showHandedOff = false;
  filterState.columnFilters = {};
  document.getElementById('fSearch').value = '';
  if (window._datePicker) window._datePicker.clear();
  updateSpecialistButtonLabel();
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
      misNames: Array.isArray(s.misNames) ? s.misNames : [],
      hqsNames: Array.isArray(s.hqsNames) ? s.hqsNames : [],
      fastMoveIn: !!s.fastMoveIn,
      noQaOnly:   !!s.noQaOnly,
      unpricedOnly: !!s.unpricedOnly,
      requiredOnly: !!s.requiredOnly,
      showHandedOff: !!s.showHandedOff,
      columnFilters: s.columnFilters || {}
    });
    if (s.pageSize) pageSize = parseInt(s.pageSize, 10) || 20;
    document.getElementById('fSearch').value = filterState.q;
    const ps = document.getElementById('pageSizeSelect');
    if (ps) ps.value = String(pageSize);
  } catch {}

  // URL params override stored filters (used for drill-downs from analytics).
  applyUrlParams();
}

function applyUrlParams() {
  const p = new URLSearchParams(window.location.search);
  if (!p.toString()) return;
  if (p.has('status'))     filterState.statusCard = p.get('status');
  if (p.has('dateFrom'))   filterState.dateFrom   = p.get('dateFrom');
  if (p.has('dateTo'))     filterState.dateTo     = p.get('dateTo');
  if (p.has('mis'))        filterState.misNames   = p.get('mis').split(',').filter(Boolean);
  if (p.has('hqs'))        filterState.hqsNames   = p.get('hqs').split(',').filter(Boolean);
  if (p.has('fast'))       filterState.fastMoveIn = p.get('fast') === '1';
  if (p.has('noQa'))       filterState.noQaOnly   = p.get('noQa') === '1';
  if (p.has('unpriced'))   filterState.unpricedOnly = p.get('unpriced') === '1';
  if (p.has('required'))   filterState.requiredOnly = p.get('required') === '1';
  if (p.has('handedOff'))  filterState.showHandedOff = p.get('handedOff') === '1';
  if (p.has('q'))          filterState.q          = p.get('q');

  // Generic column filter via URL: ?colFilter=HOA:not_notified|Payment:deposit_unpaid,rent_unpaid
  if (p.has('colFilter')) {
    const groups = p.get('colFilter').split('|').filter(Boolean);
    filterState.columnFilters = filterState.columnFilters || {};
    for (const g of groups) {
      const [key, valuesCsv] = g.split(':');
      if (!key || !valuesCsv) continue;
      filterState.columnFilters[key] = valuesCsv.split(',').filter(Boolean);
    }
  }
  // Don't persist URL params back to localStorage — they're a one-shot view.
}

// ── Metric cards ─────────────────────────────────────────────────────────────
function computeMetrics() {
  const m = { total: 0, ready: 0, in_progress: 0, urgent: 0, handed_off: 0 };
  allRows.forEach(r => {
    const handedOff = !!r.context?.handed_off_to_concierge;
    if (handedOff) m.handed_off++;
    // Total/state counts exclude handed-off so the dashboard stays clean.
    if (handedOff) return;
    m.total++;
    const s = r.derived.effective_status;
    if (s === 'ready' || s === 'on_track') m.ready++;
    else if (s === 'in_progress' || s === 'at_risk') m.in_progress++;
    else if (s === 'urgent' || s === 'blocked') m.urgent++;
  });
  return m;
}

function renderMetrics() {
  const m = computeMetrics();
  const cards = [
    { key: '',            label: 'Total Homes',     value: m.total,        cls: 'm-total' },
    { key: 'ready',       label: 'Ready',           value: m.ready,        cls: 'm-ready' },
    { key: 'in_progress', label: 'In Progress',     value: m.in_progress,  cls: 'm-in_progress' },
    { key: 'urgent',      label: 'Urgent ≤3 Days',  value: m.urgent,       cls: 'm-urgent' },
    { key: 'handed_off',  label: '🤝 Handed Off',    value: m.handed_off,   cls: 'm-signed_off' }
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
    filterState.dateChip = ''; filterState.dateFrom = ''; filterState.dateTo = '';
  } else {
    filterState.dateChip = chip;
    if (chip === 'overdue') {
      filterState.dateFrom = ''; filterState.dateTo = fmt(addDays(today, -1));
    } else if (chip === 'this_week') {
      const dow = today.getDay();
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
  const fast = document.getElementById('chip_fast_movein');
  if (fast) fast.classList.toggle('active', !!filterState.fastMoveIn);
  const noQa = document.getElementById('chip_no_qa');
  if (noQa) noQa.classList.toggle('active', !!filterState.noQaOnly);
  const up = document.getElementById('chip_unpriced');
  if (up) up.classList.toggle('active', !!filterState.unpricedOnly);
  const rq = document.getElementById('chip_required');
  if (rq) rq.classList.toggle('active', !!filterState.requiredOnly);
  const ho = document.getElementById('chip_handed_off');
  if (ho) ho.classList.toggle('active', !!filterState.showHandedOff);
}

function toggleFastMoveInFilter() {
  filterState.fastMoveIn = !filterState.fastMoveIn;
  updateDateChipsUI();
  persistFilters();
  applyFilters();
}

function toggleNoQaFilter() {
  filterState.noQaOnly = !filterState.noQaOnly;
  updateDateChipsUI();
  persistFilters();
  applyFilters();
}

function toggleUnpricedFilter() {
  filterState.unpricedOnly = !filterState.unpricedOnly;
  updateDateChipsUI();
  persistFilters();
  applyFilters();
}
window.toggleUnpricedFilter = toggleUnpricedFilter;

function toggleRequiredFilter() {
  filterState.requiredOnly = !filterState.requiredOnly;
  updateDateChipsUI();
  persistFilters();
  applyFilters();
}
window.toggleRequiredFilter = toggleRequiredFilter;

function toggleHandedOffFilter() {
  filterState.showHandedOff = !filterState.showHandedOff;
  updateDateChipsUI();
  persistFilters();
  applyFilters();
}

// ── Render table ─────────────────────────────────────────────────────────────
function renderSortIndicators() {
  document.querySelectorAll('.col-menu-btn').forEach(btn => {
    const k = btn.getAttribute('data-col');
    const sortActive   = sortState.key === k;
    const filterActive = (filterState.columnFilters?.[k] || []).length > 0;
    btn.classList.toggle('sort-active',   sortActive && !filterActive);
    btn.classList.toggle('filter-active', filterActive);
    btn.setAttribute('data-sort-dir', sortActive ? sortState.dir : '');
  });
}

function toggleColumnMenu(event, key) {
  event.stopPropagation();
  const existing = document.getElementById('colFilterPop');
  if (existing && existing.getAttribute('data-col') === key) { existing.remove(); return; }
  if (existing) existing.remove();

  const cfg = COLUMN_FILTERS[key];
  const options = cfg ? (cfg.dynamic ? cfg.build(allRows || []) : cfg.options) : null;
  const hasFilter = !!options;
  const anchor = event.currentTarget;
  const current = new Set(filterState.columnFilters?.[key] || []);
  const sortActive = sortState.key === key;

  const sortLabels = (key === 'lease_start_on')
    ? { asc: 'Oldest → Newest', desc: 'Newest → Oldest' }
    : (key === 'Payment' || key === 'Status' || key === 'HOA')
      ? { asc: 'Sort ascending', desc: 'Sort descending' }
      : { asc: 'A → Z', desc: 'Z → A' };

  const pop = document.createElement('div');
  pop.id = 'colFilterPop';
  pop.className = 'col-filter-pop';
  pop.setAttribute('data-col', key);
  pop.innerHTML = `
    <div class="cfp-section">
      <button type="button" class="cfp-sort ${sortActive && sortState.dir === 'asc' ? 'active' : ''}" data-dir="asc">
        <span class="cfp-arrow">↑</span> ${escapeHtml(sortLabels.asc)}
      </button>
      <button type="button" class="cfp-sort ${sortActive && sortState.dir === 'desc' ? 'active' : ''}" data-dir="desc">
        <span class="cfp-arrow">↓</span> ${escapeHtml(sortLabels.desc)}
      </button>
    </div>
    ${hasFilter ? `
      <div class="cfp-divider"></div>
      <div class="cfp-title">Filter ${escapeHtml(cfg.label)}</div>
      <div class="cfp-options">
        ${options.map(o => `
          <label class="cfp-opt">
            <input type="checkbox" value="${escapeAttr(o.value)}" ${current.has(o.value) ? 'checked' : ''}>
            <span>${escapeHtml(o.label)}</span>
          </label>
        `).join('')}
      </div>
      <div class="cfp-actions">
        <button type="button" class="cfp-clear">Clear</button>
        <button type="button" class="cfp-apply">Apply</button>
      </div>
    ` : ''}
  `;
  document.body.appendChild(pop);

  const rect = anchor.getBoundingClientRect();
  pop.style.top  = (window.scrollY + rect.bottom + 4) + 'px';
  pop.style.left = (window.scrollX + rect.left) + 'px';

  pop.querySelectorAll('.cfp-sort').forEach(btn => {
    btn.onclick = () => {
      sortState.key = key;
      sortState.dir = btn.getAttribute('data-dir');
      applyFilters();
      pop.remove();
    };
  });

  if (hasFilter) {
    pop.querySelector('.cfp-apply').onclick = () => {
      const values = [...pop.querySelectorAll('input:checked')].map(i => i.value);
      filterState.columnFilters = { ...filterState.columnFilters, [key]: values };
      if (!values.length) delete filterState.columnFilters[key];
      persistFilters();
      applyFilters();
      pop.remove();
    };
    pop.querySelector('.cfp-clear').onclick = () => {
      delete filterState.columnFilters[key];
      persistFilters();
      applyFilters();
      pop.remove();
    };
  }

  setTimeout(() => {
    document.addEventListener('click', _closeColFilterOnOutside, { once: true });
  }, 0);
}

function _closeColFilterOnOutside(e) {
  const pop = document.getElementById('colFilterPop');
  if (!pop) return;
  if (pop.contains(e.target)) {
    document.addEventListener('click', _closeColFilterOnOutside, { once: true });
    return;
  }
  pop.remove();
}

function render() {
  renderSortIndicators();
  renderMetrics();
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * pageSize;
  const end   = Math.min(start + pageSize, total);
  const page  = filtered.slice(start, end);

  // Live repair counter: count from filtered repairs (open ones only).
  const totalOpenRepairs = filtered.reduce((n, r) => n + r.repairs.filter(x => x.status !== 'done').length, 0);
  const homesWithRepairs = filtered.filter(r => r.repairs.some(x => x.status !== 'done')).length;
  document.getElementById('tableCount').innerHTML =
    `<strong>${total}</strong> <span>home${total !== 1 ? 's' : ''}${allRows.length !== total ? ` of ${allRows.length}` : ''}</span>` +
    ` <span class="count-sep">·</span> <span class="repair-count" title="${homesWithRepairs} home${homesWithRepairs !== 1 ? 's' : ''} with open repairs">🔧 <strong>${totalOpenRepairs}</strong> repair${totalOpenRepairs !== 1 ? 's' : ''}</span>`;

  const tbody = document.getElementById('homesBody');
  if (!total) {
    tbody.innerHTML = `<tr><td colspan="7">
      <div class="empty-state">
        <div class="empty-icon">🏠</div>
        <div class="empty-title">${allRows.length ? 'No matches' : 'No homes yet'}</div>
        <div class="empty-sub">${allRows.length ? 'Clear filters to see more' : 'Ask admin to upload BigQuery exports in Manage'}</div>
      </div>
    </td></tr>`;
    renderPagination(0, 0, 0, 1);
    return;
  }

  tbody.innerHTML = page.map(rowHtml).join('');
  renderPagination(start, end, total, totalPages);
}

function rowHtml(r) {
  const ctx = r.context || {};
  const d = r.derived;
  const state = d.effective_status;
  const stateLabel = labelForState(state);

  const openRepairs = r.repairs.filter(x => x.status !== 'done');
  const hasRepairs = openRepairs.length > 0;

  const paymentBadge = paymentBadgeHtml(d.payment_status, d.payment_blocking_move_in);
  const hoaBadge     = hoaBadgeHtml(r.has_hoa, r.hoa_is_notified);
  const handedOff    = !!ctx.handed_off_to_concierge;
  const manualPill   = d.manual_status ? ` <span class="dr-manual-pill" title="Manual status override">M</span>` : '';

  const fastFlag = d.is_fast_move_in
    ? ` <span class="fast-moveIn-flag" data-tip="Fast Move-In">⚡</span>` : '';
  const critFlag = (d.business_days_to_lease_start != null && d.business_days_to_lease_start <= 3)
    ? ` <span class="fast-moveIn-flag critical" data-tip="Critical — ${d.business_days_to_lease_start} biz day${d.business_days_to_lease_start === 1 ? '' : 's'} left">🚨</span>` : '';
  const handoffFlag = handedOff ? ` <span class="lease-type-tag" title="Handed off to concierge">🤝</span>` : '';
  const noQaFlag    = !r.qa_group_id ? ` <span class="no-qa-flag" title="No QA inspection record on file">NO QA</span>` : '';
  const unpricedCount = d.unpriced_open_repair_count || 0;
  const unpricedFlag = unpricedCount > 0
    ? ` <span class="unpriced-flag" title="${unpricedCount} open repair${unpricedCount === 1 ? '' : 's'} without a price">UNPRICED${unpricedCount > 1 ? ` ${unpricedCount}` : ''}</span>` : '';

  const misPart = r.move_in_specialist ? `MIS · ${escapeHtml(r.move_in_specialist)}` : '';
  const hqsPart = r.improvements_specialist ? `HQS · ${escapeHtml(r.improvements_specialist)}` : '';
  const specLine = [misPart, hqsPart].filter(Boolean)
    .join(' <span style="color:var(--border2);margin:0 6px">|</span> ');
  const misLine = specLine
    ? `<div style="font-size:10px;color:var(--faint);margin-top:2px">${specLine}</div>` : '';
  const hqsLine = '';

  return `
    <tr onclick="openDrawer(${r.home_id})">
      <td>
        <span class="addr-link">${escapeHtml(r.address || '—')}</span>${fastFlag}${critFlag}${handoffFlag}${noQaFlag}${unpricedFlag}
        ${r.is_revised ? `<div style="margin-top:3px"><span class="lease-type-tag">Revised</span></div>` : ''}
        ${misLine}${hqsLine}
      </td>
      <td style="font-size:12px">${escapeHtml(r.resident_name || '—')}</td>
      <td class="mono" style="font-size:11px;color:var(--muted);white-space:nowrap">${formatDateNumeric(r.lease_start_on)}</td>
      <td>${paymentBadge}</td>
      <td>${hoaBadge}</td>
      <td>
        <span class="status-badge status-${state}">${stateLabel}${manualPill}</span>
      </td>
      <td>
        ${hasRepairs ? `<span class="row-action">🔧 ${openRepairs.length}</span>` : ''}
      </td>
    </tr>
  `;
}

function repairsPanelHtml(r) {
  const ctx = r.context || {};
  const items = r.repairs;
  const cards = items.map(it => {
    const open = it.status !== 'done';
    const cat  = it.repair_category
      ? `<span class="repair-cat">${escapeHtml(it.repair_category)}</span>`
      : '';
    const assess = it.repair_assessment
      ? `<span class="repair-cat repair-assess ${it.repair_assessment === 'Required' ? 'mini-err' : 'mini-warn'}">${escapeHtml(it.repair_assessment)}</span>`
      : '';
    const cost = it.repair_estimated_cost != null
      ? `<span class="repair-cost">$${Number(it.repair_estimated_cost).toLocaleString()}</span>`
      : `<span class="repair-cost repair-cost-missing">Not priced</span>`;
    const post = it.is_post_move_in
      ? `<span class="badge-post-move-in" title="Created after lease start">⚠ Post-move-in</span>`
      : '';
    const statusTag = `<span class="repair-status-tag status-${open ? 'open' : 'done'}">${escapeHtml(it.status)}</span>`;

    const inner = `
      <span class="repair-id">#${escapeHtml(String(it.maintenance_id))}</span>
      ${cat}${assess}
      <span class="repair-title">${escapeHtml(it.repair_summary || '—')}</span>
      ${statusTag}${cost}${post}
      <span class="repair-ext">↗</span>`;
    return `<a class="repair-card" href="https://foundation.bln.hm/maintenance/${it.maintenance_id}" target="_blank" rel="noopener">${inner}</a>`;
  });

  const list = cards.length
    ? `<div class="repairs-grid">${cards.join('')}</div>`
    : `<div class="faint">No repairs.</div>`;
  const note = ctx.repairs_context
    ? `<div class="repairs-note">${escapeHtml(ctx.repairs_context)}</div>` : '';

  const qaLink = r.qa_group_id
    ? ` <a class="qa-group-link" href="https://admin.bln.hm/maintenance/${r.qa_group_id}" target="_blank" rel="noopener" title="Open QA group on Foundation">QA #${r.qa_group_id} ↗</a>`
    : ` <span class="no-qa-flag" style="margin-left:6px">NO QA</span>`;

  return `
    <div class="exp-section">
      <div class="exp-header">
        <span class="exp-label">🔧 Repairs (${items.length})${qaLink}</span>
        <button class="exp-close" onclick="toggleExpansion(${r.home_id}, 'repairs')" aria-label="Close">✕</button>
      </div>
      <div class="exp-body">${list}${note}</div>
    </div>
  `;
}

// ── Detail drawer ────────────────────────────────────────────────────────────
async function openDrawer(homeId) {
  drawerHomeId = homeId;
  drawerDraft.noteBody = '';
  drawerDraft.delayChips = [];
  drawerDraft.delayBody = '';
  drawerDraft.delayOther = '';
  drawerLogEntries = [];
  document.getElementById('drawerBackdrop').classList.add('open');
  document.getElementById('detailDrawer').classList.add('open');
  document.getElementById('detailDrawer').setAttribute('aria-hidden', 'false');
  renderDrawer(); // initial paint (no entries yet)
  try {
    drawerLogEntries = await dataSource.getLogEntries(homeId);
    renderDrawer();
  } catch (err) {
    showToast('Could not load log: ' + err.message, 'error');
  }
}
function closeDrawer() {
  drawerHomeId = null;
  drawerLogEntries = [];
  document.getElementById('drawerBackdrop').classList.remove('open');
  document.getElementById('detailDrawer').classList.remove('open');
  document.getElementById('detailDrawer').setAttribute('aria-hidden', 'true');
}
window.openDrawer = openDrawer;
window.closeDrawer = closeDrawer;
window.toggleSpecialistMenu = toggleSpecialistMenu;

function renderDrawer() {
  const r = allRows.find(h => h.home_id === drawerHomeId);
  if (!r) { closeDrawer(); return; }
  const ctx = r.context || {};
  const d = r.derived;
  const state = d.effective_status;
  const manualSet = !!d.manual_status;
  const handedOff = !!ctx.handed_off_to_concierge;
  const isDelayed = !!ctx.is_delayed;

  // Drafts for the new-entry boxes
  const reasons   = drawerDraft.delayChips || [];
  const otherSelected = reasons.includes('other');
  const noteDirty  = !!(drawerDraft.noteBody && drawerDraft.noteBody.trim());
  const delayDirty = reasons.length > 0 || (drawerDraft.delayBody && drawerDraft.delayBody.trim()) ||
                     (otherSelected && drawerDraft.delayOther && drawerDraft.delayOther.trim());

  const misName = r.move_in_specialist ? `MIS · ${escapeHtml(r.move_in_specialist)}` : '';
  const hqsName = r.improvements_specialist ? `HQS · ${escapeHtml(r.improvements_specialist)}` : '';
  const specLine = [misName, hqsName].filter(Boolean).join(' &nbsp;·&nbsp; ');
  document.getElementById('drawerTitle').innerHTML = `
    <a href="${escapeAttr(d.admin_link)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${escapeHtml(r.address || '—')} ↗</a>
    <small>${escapeHtml(r.resident_name || '—')} · Move-in ${formatDateNumeric(r.lease_start_on)}</small>
    ${specLine ? `<small>${specLine}</small>` : ''}
  `;

  // Status section
  const statusHtml = `
    <div class="dr-section">
      <div class="dr-h">Status</div>
      <div class="dr-status-row">
        <span class="status-badge status-${state}">${labelForState(state)}</span>
        <select class="dr-status-select" onchange="onManualStatusChange(this.value)">
          <option value="">— Override status —</option>
          ${MANUAL_STATUS_OPTIONS.map(o =>
            `<option value="${o.value}" ${d.manual_status === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
          ).join('')}
        </select>
        ${manualSet ? `<button class="dr-status-reset" onclick="onResetManualStatus()">Reset to auto</button>` : ''}
      </div>
      <div style="font-size:11px;color:var(--faint);margin-top:6px">
        Auto-derived: <strong style="color:var(--muted)">${labelForState(d.derived_ready_state)}</strong>
        ${manualSet ? ` · Manually set ${ctx.manual_status_set_by ? 'by ' + escapeHtml(ctx.manual_status_set_by) : ''}` : ''}
      </div>
    </div>
  `;

  // Handoff section
  const conciergeName = r.concierge ? escapeHtml(r.concierge) : 'concierge';
  const handoffHtml = `
    <div class="dr-section">
      <div class="dr-h">Handoff to concierge</div>
      <label class="dr-toggle">
        <input type="checkbox" ${handedOff ? 'checked' : ''} onchange="onToggleHandoff(this.checked)">
        Handed off to ${conciergeName}
      </label>
      ${!r.concierge ? `<div style="font-size:11px;color:var(--amber);margin-top:4px">⚠️ No concierge assigned to this home</div>` : ''}
      ${handedOff && ctx.handed_off_at ? `<div style="font-size:11px;color:var(--faint);margin-top:4px">on ${formatDateNumeric(ctx.handed_off_at)}${ctx.handed_off_by ? ' by ' + escapeHtml(ctx.handed_off_by) : ''}</div>` : ''}
    </div>
  `;

  // Filter helpers for the log thread
  const delayEntries  = drawerLogEntries.filter(e => e.kind === 'delay' || e.kind === 'delay_cleared');
  const noteEntries   = drawerLogEntries.filter(e => e.kind === 'note');
  const eventEntries  = drawerLogEntries.filter(e =>
    ['status_change','status_reset','handoff','handoff_cleared'].includes(e.kind));

  // Delay section
  const chipsHtml = DELAY_REASON_OPTIONS.map(o => `
    <span class="dr-chip ${reasons.includes(o.value) ? 'active' : ''}" onclick="onToggleDelayReason('${o.value}')">${escapeHtml(o.label)}</span>
  `).join('');
  const delayHtml = `
    <div class="dr-section">
      <div class="dr-h">Delay${isDelayed ? ' · active' : ''}</div>
      <div class="dr-chip-grid">${chipsHtml}</div>
      ${otherSelected ? `
        <input class="dr-input" type="text" placeholder="Specify 'other' reason…" value="${escapeAttr(drawerDraft.delayOther || '')}" oninput="drawerDraft.delayOther = this.value; updateDelaySaveBtn()" style="margin-bottom:8px">
      ` : ''}
      <textarea class="dr-textarea" placeholder="Context (what happened, ETA, who's blocking)…" oninput="drawerDraft.delayBody = this.value; updateDelaySaveBtn()">${escapeHtml(drawerDraft.delayBody || '')}</textarea>
      <div class="dr-actions">
        <button class="dr-btn dr-btn-primary" id="drDelaySaveBtn" ${delayDirty ? '' : 'disabled'} onclick="onAddDelayEntry()">Log delay</button>
        ${isDelayed ? `<button class="dr-btn dr-btn-ghost" onclick="onClearDelay()">Clear delay</button>` : ''}
      </div>
      <div class="log-thread">
        ${delayEntries.length
          ? delayEntries.map(renderDelayEntry).join('')
          : '<div class="log-empty">No delays logged yet.</div>'}
      </div>
    </div>
  `;

  // Notes section
  const notesHtml = `
    <div class="dr-section">
      <div class="dr-h">Notes</div>
      <textarea class="dr-textarea" placeholder="Add a note for this home (visible to all move-ins team)…" oninput="drawerDraft.noteBody = this.value; updateNotesSaveBtn()">${escapeHtml(drawerDraft.noteBody || '')}</textarea>
      <div class="dr-actions">
        <button class="dr-btn dr-btn-primary" id="drNotesSaveBtn" ${noteDirty ? '' : 'disabled'} onclick="onAddNoteEntry()">Add note</button>
      </div>
      <div class="log-thread">
        ${noteEntries.length
          ? noteEntries.map(renderNoteEntry).join('')
          : '<div class="log-empty">No notes yet.</div>'}
      </div>
    </div>
  `;

  // Activity (events) — auto-logged status changes, handoffs
  const activityHtml = eventEntries.length ? `
    <div class="dr-section">
      <div class="dr-h">Activity</div>
      <div class="log-thread">
        ${eventEntries.map(renderEventEntry).join('')}
      </div>
    </div>
  ` : '';

  // Repairs section
  const repItems = r.repairs.map(it => {
    const open = it.status !== 'done';
    const costHtml = it.repair_estimated_cost != null
      ? `<span class="dr-rep-tag" style="font-family:ui-monospace,monospace">$${Number(it.repair_estimated_cost).toLocaleString()}</span>`
      : `<span class="dr-rep-tag" style="color:var(--red);border-color:var(--red-border);background:var(--red-dim);font-weight:600">Not priced</span>`;
    // Aging tag: show only on unpriced open repairs that are ≥7 calendar days old.
    let ageHtml = '';
    if (it.repair_estimated_cost == null && it.status !== 'done' && it.repair_created_on) {
      const days = Math.floor((Date.now() - new Date(it.repair_created_on).getTime()) / 86400000);
      if (days >= 7) {
        const cls = days >= 30 ? 'dr-rep-age age-warn' : 'dr-rep-age';
        ageHtml = `<span class="${cls}" title="Unpriced for ${days} calendar day${days === 1 ? '' : 's'}">⏱ ${days}d unpriced</span>`;
      }
    }
    const categoryTag = it.repair_category
      ? `<span class="dr-rep-tag" style="background:var(--navy-dim);color:var(--navy);border-color:var(--navy-border);font-weight:600">${escapeHtml(it.repair_category)}</span>`
      : '';
    return `
      <a class="dr-repair-item dr-repair-link" href="https://foundation.bln.hm/maintenance/${it.maintenance_id}" target="_blank" rel="noopener">
        <span class="dr-rep-id">#${escapeHtml(String(it.maintenance_id))}</span>
        ${categoryTag}
        ${it.repair_assessment ? `<span class="dr-rep-tag">${escapeHtml(it.repair_assessment)}</span>` : ''}
        <span class="dr-rep-title">${escapeHtml(it.repair_summary || '—')}</span>
        ${costHtml}${ageHtml}
        <span class="dr-rep-tag" style="${open ? 'color:var(--amber);border-color:var(--amber-border);background:var(--amber-dim)' : 'color:var(--green);border-color:var(--green-border);background:var(--green-dim)'}">${escapeHtml(it.status)}</span>
        <span style="color:var(--blue);margin-left:auto">↗</span>
      </a>
    `;
  }).join('') || '<div class="faint" style="font-size:12px">No repairs.</div>';
  const qaLink = r.qa_group_id
    ? ` · <a href="https://admin.bln.hm/maintenance/${r.qa_group_id}" target="_blank" rel="noopener" style="color:var(--blue);font-size:11px">QA #${r.qa_group_id} ↗</a>`
    : ` · <span class="no-qa-flag" style="font-size:10px">NO QA</span>`;
  const repairsHtml = `
    <div class="dr-section">
      <div class="dr-h">🔧 Repairs (${r.repairs.length})${qaLink}</div>
      ${repItems}
    </div>
  `;

  // Payment summary
  const money = v => (v == null || v === '' || isNaN(v)) ? '—' : `$${Number(v).toLocaleString('en-US')}`;
  const paymentHtml = `
    <div class="dr-section">
      <div class="dr-h">💲 Payment</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px">
        <div><span style="color:var(--muted)">Rent:</span> ${money(r.rent_amount)}</div>
        <div><span style="color:var(--muted)">Deposit:</span> ${money(r.deposit_amount)}</div>
        <div><span style="color:var(--muted)">Autopay:</span> ${r.enrolled_in_auto_pay ? 'Yes' : 'No'}</div>
        <div><span style="color:var(--muted)">Status:</span> ${escapeHtml(d.payment_status)}</div>
      </div>
    </div>
  `;

  // Status + Handoff side-by-side (both short). Everything else full-width.
  document.getElementById('drawerBody').innerHTML = `
    <div class="dr-section"><div class="dr-grid-2">${statusHtml}${handoffHtml}</div></div>
    ${paymentHtml}
    ${delayHtml}
    ${notesHtml}
    ${activityHtml}
    ${repairsHtml}
  `;
}

// ── Log-entry renderers ─────────────────────────────────────────────────────
function renderDelayEntry(e) {
  const author = escapeHtml(e.created_by_name || e.created_by_email || 'Unknown');
  const when = formatLogTime(e.created_at);
  const canDelete = canDeleteEntry(e);
  if (e.kind === 'delay_cleared') {
    return `
      <div class="log-entry">
        <div class="log-entry-head">
          <span class="log-author">${author}</span>
          <div style="display:flex;gap:6px;align-items:center">
            <span class="log-time">${when}</span>
            ${canDelete ? `<button class="log-delete" onclick="onDeleteLogEntry(${e.id})" title="Delete entry">✕</button>` : ''}
          </div>
        </div>
        <div class="log-meta">✅ Delay cleared</div>
      </div>
    `;
  }
  const chips = Array.isArray(e.chips) ? e.chips : [];
  const chipsHtml = chips.length
    ? `<div class="log-chips">${chips.map(c => {
        const label = (DELAY_REASON_OPTIONS.find(o => o.value === c) || {}).label || c;
        return `<span class="log-chip">${escapeHtml(label)}</span>`;
      }).join('')}</div>`
    : '';
  const otherHtml = e.other_text ? `<div class="log-other">Other: ${escapeHtml(e.other_text)}</div>` : '';
  const bodyHtml = e.body ? `<div class="log-body">${escapeHtml(e.body)}</div>` : '';
  return `
    <div class="log-entry">
      <div class="log-entry-head">
        <span class="log-author">${author}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="log-time">${when}</span>
          ${canDelete ? `<button class="log-delete" onclick="onDeleteLogEntry(${e.id})" title="Delete entry">✕</button>` : ''}
        </div>
      </div>
      ${chipsHtml}${otherHtml}${bodyHtml}
    </div>
  `;
}

function renderNoteEntry(e) {
  const author = escapeHtml(e.created_by_name || e.created_by_email || 'Unknown');
  const when = formatLogTime(e.created_at);
  const canDelete = canDeleteEntry(e);
  return `
    <div class="log-entry">
      <div class="log-entry-head">
        <span class="log-author">${author}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="log-time">${when}</span>
          ${canDelete ? `<button class="log-delete" onclick="onDeleteLogEntry(${e.id})" title="Delete entry">✕</button>` : ''}
        </div>
      </div>
      <div class="log-body">${escapeHtml(e.body || '')}</div>
    </div>
  `;
}

function renderEventEntry(e) {
  const author = escapeHtml(e.created_by_name || e.created_by_email || 'Unknown');
  const when = formatLogTime(e.created_at);
  const canDelete = canDeleteEntry(e);
  let summary = '';
  const meta = e.meta || {};
  if (e.kind === 'status_change') {
    const fromL = labelForState(meta.from);
    const toL   = labelForState(meta.to);
    summary = `Status changed from <strong>${escapeHtml(fromL)}</strong> to <strong>${escapeHtml(toL)}</strong>`;
  } else if (e.kind === 'status_reset') {
    summary = `Status reset to auto-derived`;
  } else if (e.kind === 'handoff') {
    summary = `🤝 Handed off to concierge`;
  } else if (e.kind === 'handoff_cleared') {
    summary = `↩️ Handoff cleared`;
  }
  return `
    <div class="log-event">
      <strong>${author}</strong> · ${when} — ${summary}
      ${canDelete ? `<button class="log-delete" onclick="onDeleteLogEntry(${e.id})" style="float:right" title="Delete entry">✕</button>` : ''}
    </div>
  `;
}

function formatLogTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + time;
}

// Drawer event handlers — write to context + log entry, then reload
async function onManualStatusChange(value) {
  if (!drawerHomeId) return;
  const r = allRows.find(h => h.home_id === drawerHomeId);
  const fromStatus = r?.context?.manual_status || r?.derived?.derived_ready_state || null;
  try {
    if (!value) {
      await dataSource.clearManualStatus(drawerHomeId);
      await dataSource.insertLogEntry(drawerHomeId, 'status_reset', { meta: { from: fromStatus } });
    } else {
      await dataSource.setManualStatus(drawerHomeId, value, currentUserEmail);
      await dataSource.insertLogEntry(drawerHomeId, 'status_change', { meta: { from: fromStatus, to: value } });
    }
    await reloadAfterDrawerWrite();
    showToast('Status updated', 'success');
  } catch (err) { showToast('Save failed: ' + err.message, 'error'); }
}
async function onResetManualStatus() {
  if (!drawerHomeId) return;
  const r = allRows.find(h => h.home_id === drawerHomeId);
  const fromStatus = r?.context?.manual_status || null;
  try {
    await dataSource.clearManualStatus(drawerHomeId);
    await dataSource.insertLogEntry(drawerHomeId, 'status_reset', { meta: { from: fromStatus } });
    await reloadAfterDrawerWrite();
    showToast('Reset to auto', 'success');
  } catch (err) { showToast('Reset failed: ' + err.message, 'error'); }
}
async function onToggleHandoff(checked) {
  if (!drawerHomeId) return;
  try {
    if (checked) {
      await dataSource.markHandedOff(drawerHomeId, currentUserEmail);
      await dataSource.insertLogEntry(drawerHomeId, 'handoff');
    } else {
      await dataSource.unmarkHandedOff(drawerHomeId);
      await dataSource.insertLogEntry(drawerHomeId, 'handoff_cleared');
    }
    await reloadAfterDrawerWrite();
    showToast(checked ? 'Handed off' : 'Handoff cleared', 'success');
  } catch (err) { showToast('Save failed: ' + err.message, 'error'); }
}
function onToggleDelayReason(value) {
  const current = [...(drawerDraft.delayChips || [])];
  const idx = current.indexOf(value);
  if (idx >= 0) current.splice(idx, 1); else current.push(value);
  drawerDraft.delayChips = current;
  renderDrawer();
}
async function onAddDelayEntry() {
  if (!drawerHomeId) return;
  const reasons = drawerDraft.delayChips || [];
  const body = (drawerDraft.delayBody || '').trim();
  const otherText = reasons.includes('other') ? (drawerDraft.delayOther || '').trim() : null;
  if (!reasons.length && !body && !otherText) return;
  try {
    await dataSource.insertLogEntry(drawerHomeId, 'delay', {
      chips: reasons, body: body || null, other_text: otherText || null
    });
    // Mirror state to home_repair_context so dashboard list view reflects current delay
    await dataSource.markDelayed(drawerHomeId, reasons, otherText, body, currentUserEmail);
    drawerDraft.delayChips = [];
    drawerDraft.delayBody = '';
    drawerDraft.delayOther = '';
    await reloadAfterDrawerWrite();
    showToast('Delay logged', 'success');
  } catch (err) { showToast('Save failed: ' + err.message, 'error'); }
}
async function onClearDelay() {
  if (!drawerHomeId) return;
  try {
    await dataSource.unmarkDelayed(drawerHomeId);
    await dataSource.insertLogEntry(drawerHomeId, 'delay_cleared');
    await reloadAfterDrawerWrite();
    showToast('Delay cleared', 'success');
  } catch (err) { showToast('Clear failed: ' + err.message, 'error'); }
}
async function onAddNoteEntry() {
  if (!drawerHomeId) return;
  const body = (drawerDraft.noteBody || '').trim();
  if (!body) return;
  try {
    await dataSource.insertLogEntry(drawerHomeId, 'note', { body });
    drawerDraft.noteBody = '';
    await reloadAfterDrawerWrite();
    showToast('Note added', 'success');
  } catch (err) { showToast('Save failed: ' + err.message, 'error'); }
}
async function onDeleteLogEntry(id) {
  if (!drawerHomeId) return;
  const ok = await confirmModal({
    title: 'Delete entry?',
    body: 'This entry will be permanently removed and won\'t appear in the activity log anymore.',
    confirmText: 'Delete'
  });
  if (!ok) return;
  try {
    await dataSource.deleteLogEntry(id);
    drawerLogEntries = drawerLogEntries.filter(e => e.id !== id);
    renderDrawer();
    showToast('Entry deleted', 'success');
  } catch (err) { showToast('Delete failed: ' + err.message, 'error'); }
}
function updateNotesSaveBtn() {
  const dirty = !!(drawerDraft.noteBody && drawerDraft.noteBody.trim());
  const btn = document.getElementById('drNotesSaveBtn');
  if (btn) btn.disabled = !dirty;
}
function updateDelaySaveBtn() {
  const reasons = drawerDraft.delayChips || [];
  const otherSelected = reasons.includes('other');
  const dirty = reasons.length > 0
    || (drawerDraft.delayBody && drawerDraft.delayBody.trim())
    || (otherSelected && drawerDraft.delayOther && drawerDraft.delayOther.trim());
  const btn = document.getElementById('drDelaySaveBtn');
  if (btn) btn.disabled = !dirty;
}
async function reloadAfterDrawerWrite() {
  // Reload data + log entries, then re-render the drawer.
  try {
    await loadData();
    if (drawerHomeId) {
      drawerLogEntries = await dataSource.getLogEntries(drawerHomeId);
      renderDrawer();
    }
  } catch (err) { showToast('Reload failed: ' + err.message, 'error'); }
}
window.onManualStatusChange = onManualStatusChange;
window.onResetManualStatus = onResetManualStatus;
window.onToggleHandoff = onToggleHandoff;
window.onToggleDelayReason = onToggleDelayReason;
window.onAddDelayEntry = onAddDelayEntry;
window.onClearDelay = onClearDelay;
window.onAddNoteEntry = onAddNoteEntry;
window.onDeleteLogEntry = onDeleteLogEntry;
window.updateNotesSaveBtn = updateNotesSaveBtn;
window.updateDelaySaveBtn = updateDelaySaveBtn;
window.drawerDraft = drawerDraft;
window.renderDrawer = renderDrawer;

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
function labelForState(s) {
  return ({
    ready: 'Ready',
    on_track: 'On Track',
    in_progress: 'In Progress',
    at_risk: 'At Risk',
    urgent: 'Urgent',
    blocked: 'Blocked',
    handed_off: 'Handed Off',
    lease_break: 'Lease Break',
    back_out: 'Back Out',
    back_out_lease_break: 'Back Out + Lease Break',
    back_out_self_manage: 'Back Out + Self Manage'
  })[s] || 'Unknown';
}

// Promise-based confirm modal. Returns true/false. Replaces browser confirm().
function confirmModal({ title = 'Are you sure?', body = 'This action cannot be undone.', confirmText = 'Delete', cancelText = 'Cancel', danger = true } = {}) {
  return new Promise(resolve => {
    const backdrop = document.getElementById('confirmModalBackdrop');
    const titleEl  = document.getElementById('cmTitle');
    const bodyEl   = document.getElementById('cmBody');
    const okBtn    = document.getElementById('cmConfirm');
    const cancelBtn= document.getElementById('cmCancel');
    if (!backdrop) { resolve(window.confirm(body)); return; }

    titleEl.textContent = title;
    bodyEl.textContent  = body;
    okBtn.textContent   = confirmText;
    cancelBtn.textContent = cancelText;
    okBtn.className = 'cm-btn ' + (danger ? 'cm-btn-danger' : 'cm-btn-ghost');

    const cleanup = (result) => {
      backdrop.classList.remove('open');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => { if (e.target === backdrop) cleanup(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter')  cleanup(true);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    backdrop.classList.add('open');
    okBtn.focus();
  });
}
window.confirmModal = confirmModal;

function showToast(msg, kind = '') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast-item ${kind === 'success' ? 'toast-success' : kind === 'error' ? 'toast-error' : ''}`;
  const icon = kind === 'success' ? '✅' : kind === 'error' ? '⚠️' : 'ℹ️';
  el.innerHTML = `<span class="toast-icon">${icon}</span><span>${escapeHtml(msg)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 200);
  }, 3000);
}
window.showToast = showToast;

function paymentPanelHtml(r) {
  const money = v => (v == null || v === '' || isNaN(v)) ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const yesNo = v => v === true ? 'Yes' : v === false ? 'No' : '—';
  const leaseStart    = formatDateNumeric(r.lease_start_on);
  const leaseExecuted = r.lease_executed_on ? formatDateNumeric(r.lease_executed_on) : '—';
  const isFast = r.derived.is_fast_move_in;
  const bizDays = r.derived.business_days_to_lease_start;

  const fastBanner = isFast
    ? `<div class="fast-moveIn-banner">
         ⚡ <strong>Fast Move-In</strong> — only ${bizDays != null ? bizDays : '≤5'} business day${bizDays === 1 ? '' : 's'} until lease start. Resident must <strong>wire</strong> the payment; ACH won't clear in time.
       </div>`
    : '';

  const items = (r.balance_detail || '')
    .split('||').map(s => s.trim()).filter(Boolean);
  const linkifyBalanceId = (txt) =>
    escapeHtml(txt).replace(/ID:\s*(\d+)/g,
      (_, id) => `ID: <a href="https://admin.bln.hm/accounting/balance/${id}" target="_blank" rel="noopener">${id}</a>`);
  const breakdown = items.length
    ? `<div class="pay-breakdown">${items.map(it => `<div class="pay-breakdown-row">${linkifyBalanceId(it)}</div>`).join('')}</div>`
    : `<div class="faint" style="font-size:12px">All balances paid or no detail available.</div>`;

  return `
    <div class="exp-section">
      <div class="exp-header">
        <span class="exp-label">📝 Lease & Payment</span>
        <button class="exp-close" onclick="toggleExpansion(${r.home_id}, 'payment')" aria-label="Close">✕</button>
      </div>
      <div class="exp-body">
        ${fastBanner}
        <div class="pay-grid">
          <div class="pay-cell"><div class="pay-label">Lease signed</div><div class="pay-value">${leaseExecuted}</div></div>
          <div class="pay-cell"><div class="pay-label">Lease start</div><div class="pay-value">${leaseStart}</div></div>
          <div class="pay-cell"><div class="pay-label">Biz days to start</div><div class="pay-value">${bizDays != null ? bizDays : '—'}</div></div>
          <div class="pay-cell"><div class="pay-label">Monthly rent</div><div class="pay-value">${money(r.rent_amount)}</div></div>
          <div class="pay-cell"><div class="pay-label">Deposit</div><div class="pay-value">${money(r.deposit_amount)}${r.deposit_type ? ` <span class="faint">· ${escapeHtml(r.deposit_type)}</span>` : ''}</div></div>
          <div class="pay-cell"><div class="pay-label">Autopay</div><div class="pay-value">${yesNo(r.enrolled_in_auto_pay)}</div></div>
          <div class="pay-cell"><div class="pay-label">Move-in payment status</div><div class="pay-value">${escapeHtml(r.move_in_payment_status || '—')}</div></div>
          <div class="pay-cell"><div class="pay-label">Rollup</div><div class="pay-value">${escapeHtml(r.derived.payment_status || '—')}</div></div>
        </div>
        ${breakdown}
      </div>
    </div>
  `;
}

function paymentBadgeHtml(payStatus, blocking) {
  const map = {
    all_paid:       { cls: 'mini-ok',   label: 'All paid' },
    deposit_unpaid: { cls: 'mini-warn', label: 'Deposit unpaid' },
    rent_unpaid:    { cls: 'mini-warn', label: 'Rent unpaid' },
    both_unpaid:    { cls: 'mini-err',  label: 'Both unpaid' }
  };
  const cfg = map[payStatus] || { cls: 'mini-none', label: '—' };
  const blockTag = blocking ? ' <span title="Blocking move-in">🚨</span>' : '';
  return `<span class="mini-badge ${cfg.cls}" title="Payment status">💲 ${escapeHtml(cfg.label)}${blockTag}</span>`;
}

function hoaBadgeHtml(hasHoa, notified) {
  if (!hasHoa) return `<span class="mini-badge mini-none">No HOA</span>`;
  if (notified) return `<span class="mini-badge mini-ok">Notified</span>`;
  return `<span class="mini-badge mini-warn">Not notified</span>`;
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
