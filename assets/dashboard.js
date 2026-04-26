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
  region: '',
  spec: '',
  fastMoveIn: false,
  noQaOnly: false,
  showHandedOff: false, // hide handed-off homes by default
  columnFilters: {}
};

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
      { value: 'ready',        label: 'Ready',        test: r => r.derived.derived_ready_state === 'ready' },
      { value: 'in_progress',  label: 'In Progress',  test: r => r.derived.derived_ready_state === 'in_progress' },
      { value: 'urgent',       label: 'Urgent',       test: r => r.derived.derived_ready_state === 'urgent' },
      { value: 'handed_off',   label: 'Handed off',   test: r => !!r.context?.handed_off_to_concierge }
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
  Status:         r => r.derived.derived_ready_state || ''
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

// Row expansion state: Map<homeId, Set<'repairs'|'status'|'payment'>>
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
  const regions = [...new Set(allRows.map(r => r.region).filter(Boolean))].sort();
  const specs   = [...new Set(allRows.map(r => r.move_in_specialist).filter(Boolean))].sort();
  regionSel.innerHTML = `<option value="">All regions</option>` +
    regions.map(r => `<option${r === filterState.region ? ' selected' : ''}>${escapeHtml(r)}</option>`).join('');
  specSel.innerHTML = `<option value="">All specialists</option>` +
    specs.map(s => `<option${s === filterState.spec ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('');
}

function applyFilters() {
  const q = (filterState.q || '').trim().toLowerCase();

  filtered = allRows.filter(r => {
    // Hide handed-off homes by default; the 'handed_off' status card or chip toggles them.
    const handedOff = !!r.context?.handed_off_to_concierge;
    if (handedOff && !filterState.showHandedOff && filterState.statusCard !== 'handed_off') return false;

    // Metric card filter
    if (filterState.statusCard) {
      if (filterState.statusCard === 'urgent') {
        if (r.derived.derived_ready_state !== 'urgent') return false;
      } else if (filterState.statusCard === 'handed_off') {
        if (!handedOff) return false;
      } else {
        if (r.derived.derived_ready_state !== filterState.statusCard) return false;
      }
    }

    if (filterState.region && r.region !== filterState.region) return false;
    if (filterState.spec   && r.move_in_specialist !== filterState.spec) return false;
    if (filterState.fastMoveIn && !r.derived.is_fast_move_in) return false;
    if (filterState.noQaOnly && r.qa_group_id) return false;

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
  filterState.region = ''; filterState.spec = '';
  filterState.fastMoveIn = false;
  filterState.noQaOnly = false;
  filterState.showHandedOff = false;
  filterState.columnFilters = {};
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
      region: s.region || '', spec: s.spec || '',
      fastMoveIn: !!s.fastMoveIn,
      noQaOnly:   !!s.noQaOnly,
      showHandedOff: !!s.showHandedOff,
      columnFilters: s.columnFilters || {}
    });
    if (s.pageSize) pageSize = parseInt(s.pageSize, 10) || 20;
    document.getElementById('fSearch').value = filterState.q;
    const ps = document.getElementById('pageSizeSelect');
    if (ps) ps.value = String(pageSize);
  } catch {}
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
    const s = r.derived.derived_ready_state;
    if (s === 'ready') m.ready++;
    else if (s === 'in_progress') m.in_progress++;
    else if (s === 'urgent') m.urgent++;
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
    tbody.innerHTML = `<tr><td colspan="8">
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
  const state = d.derived_ready_state;
  const stateLabel = labelForState(state);
  const expSet = expanded.get(r.home_id) || new Set();

  const linkHref = d.admin_link;
  const openRepairs = r.repairs.filter(x => x.status !== 'done');
  const hasRepairs = openRepairs.length > 0;
  const statusOpen  = expSet.has('status');
  const repairsOpen = expSet.has('repairs');
  const paymentOpen = expSet.has('payment');
  const hasExpansion = statusOpen || repairsOpen || paymentOpen;

  const paymentBadge = paymentBadgeHtml(d.payment_status, r.home_id, paymentOpen, d.payment_blocking_move_in);
  const hoaBadge     = hoaBadgeHtml(r.has_hoa, r.hoa_is_notified);
  const handedOff    = !!ctx.handed_off_to_concierge;

  const fastFlag = d.is_fast_move_in
    ? ` <span class="fast-moveIn-flag" data-tip="Fast Move-In" onclick="toggleExpansion(${r.home_id}, 'payment')">⚡</span>` : '';
  const critFlag = (d.business_days_to_lease_start != null && d.business_days_to_lease_start <= 3)
    ? ` <span class="fast-moveIn-flag critical" data-tip="Critical — ${d.business_days_to_lease_start} biz day${d.business_days_to_lease_start === 1 ? '' : 's'} left" onclick="toggleExpansion(${r.home_id}, 'payment')">🚨</span>` : '';
  const handoffFlag = handedOff ? ` <span class="lease-type-tag" title="Handed off to concierge">🤝</span>` : '';
  const noQaFlag    = !r.qa_group_id ? ` <span class="no-qa-flag" title="No QA inspection record on file">NO QA</span>` : '';

  const mainRow = `
    <tr class="${hasExpansion ? 'expanded' : ''}">
      <td>
        <a class="addr-link" href="${escapeAttr(linkHref)}" target="_blank" rel="noopener">${escapeHtml(r.address || '—')}</a>${fastFlag}${critFlag}${handoffFlag}${noQaFlag}
        ${r.is_revised ? `<div style="margin-top:3px"><span class="lease-type-tag">Revised</span></div>` : ''}
        ${r.move_in_specialist ? `<div style="font-size:10px;color:var(--faint);margin-top:2px">MIS · ${escapeHtml(r.move_in_specialist)}</div>` : ''}
      </td>
      <td style="font-size:12px">${escapeHtml(r.resident_name || '—')}</td>
      <td class="mono" style="font-size:11px;color:var(--muted);white-space:nowrap">${formatDateNumeric(r.lease_start_on)}</td>
      <td>${paymentBadge}</td>
      <td>${hoaBadge}</td>
      <td style="font-size:11px;color:var(--muted)">${escapeHtml(r.improvements_specialist || '—')}</td>
      <td>
        <span class="status-badge status-${state} ${statusOpen ? 'active' : ''}">
          ${stateLabel}
        </span>
      </td>
      <td>
        ${hasRepairs ? `
          <span class="row-action ${repairsOpen ? 'active' : ''}" onclick="toggleExpansion(${r.home_id}, 'repairs')">
            🔧 ${openRepairs.length}
          </span>
        ` : ''}
      </td>
    </tr>
  `;

  if (!hasExpansion) return mainRow;

  let expInner = '';
  if (repairsOpen) {
    expInner += repairsPanelHtml(r);
  }
  if (paymentOpen) {
    expInner += paymentPanelHtml(r);
  }
  if (statusOpen) {
    expInner += `
      <div class="exp-section">
        <div class="exp-header">
          <span class="exp-label">Status</span>
          <button class="exp-close" onclick="toggleExpansion(${r.home_id}, 'status')" aria-label="Close">✕</button>
        </div>
        <div class="exp-body exp-body-text">${escapeHtml(ctx.repairs_context || ctx.expectations || ctx.postpone_reason || '—')}</div>
      </div>
    `;
  }

  return mainRow + `<tr class="expansion"><td colspan="8"><div class="exp-inner">${expInner}</div></td></tr>`;
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
function labelForState(s) {
  return ({
    ready: 'Ready',
    in_progress: 'In Progress',
    urgent: 'Urgent'
  })[s] || 'Unknown';
}

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

function paymentBadgeHtml(payStatus, homeId, open, blocking) {
  const map = {
    all_paid:       { cls: 'mini-ok',   label: 'All paid' },
    deposit_unpaid: { cls: 'mini-warn', label: 'Deposit unpaid' },
    rent_unpaid:    { cls: 'mini-warn', label: 'Rent unpaid' },
    both_unpaid:    { cls: 'mini-err',  label: 'Both unpaid' }
  };
  const cfg = map[payStatus] || { cls: 'mini-none', label: '—' };
  const blockTag = blocking ? ' <span title="Blocking move-in">🚨</span>' : '';
  return `<span class="mini-badge ${cfg.cls} clickable ${open ? 'active' : ''}" onclick="toggleExpansion(${homeId}, 'payment')" title="Show payment details">💲 ${escapeHtml(cfg.label)}${blockTag}</span>`;
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
