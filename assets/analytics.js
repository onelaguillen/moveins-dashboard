// ── Analytics page logic ─────────────────────────────────────────────────────
// Reuses dataSource + derive. Reads current homes for cohort metrics, and
// homes_snapshots for trend lines. Filters by lease_start_on date range +
// optional MIS/HQS multi-select. Every metric drills to the main dashboard
// via URL params.

const FILTER_KEY = 'belong.analytics.filters.v1';

let allRows = [];        // enriched homes
let snapshots = [];      // raw snapshot rows in the date range
let filtered = [];       // homes whose lease_start_on falls in current range

const filterState = {
  dateFrom: '',
  dateTo: '',
  dateChip: 'this_month',
  misNames: [],
  hqsNames: []
};

const charts = {};       // Chart.js instances, so we can destroy + redraw

// ── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  const session = await requireAuth(false);
  if (!session) return;
  await mountHeader({ page: 'analytics', session });
  startIdleWatcher();
  startPresence(session);

  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('pageContent').style.display = 'block';

  restoreFilters();
  initDatePicker();
  // Default range: this calendar month, if no saved range.
  if (!filterState.dateFrom && !filterState.dateTo) {
    setAnalyticsChip('this_month', /*persist=*/false);
  } else {
    syncDatePickerToState();
    updateDateClearUI();
    updateChipsUI();
  }
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
    await loadSnapshots();
    applyAndRender();
  } catch (err) {
    console.error(err);
    document.getElementById('aCohortCount').textContent = 'Failed to load: ' + err.message;
  }
}

async function loadSnapshots() {
  // Load up to 90 days back so trend chart has reasonable history.
  const ninetyAgo = new Date();
  ninetyAgo.setDate(ninetyAgo.getDate() - 90);
  const fromDate = ninetyAgo.toISOString().slice(0, 10);
  try {
    snapshots = await dataSource.getSnapshots(fromDate, null);
  } catch (err) {
    console.warn('No snapshots loaded:', err.message);
    snapshots = [];
  }
}

// ── Filtering ────────────────────────────────────────────────────────────────
function applyAndRender() {
  const fromD = filterState.dateFrom ? startOfDay(new Date(filterState.dateFrom)) : null;
  const toD   = filterState.dateTo   ? startOfDay(new Date(filterState.dateTo))   : null;
  const mis = filterState.misNames || [];
  const hqs = filterState.hqsNames || [];

  filtered = allRows.filter(r => {
    if (!r.lease_start_on) return false;
    const d = startOfDay(new Date(r.lease_start_on));
    if (fromD && d < fromD) return false;
    if (toD && d > toD) return false;
    if (mis.length && !mis.includes(r.move_in_specialist)) return false;
    if (hqs.length && !hqs.includes(r.improvements_specialist)) return false;
    return true;
  });

  document.getElementById('aCohortCount').textContent =
    `${filtered.length} home${filtered.length === 1 ? '' : 's'} in range`;

  renderKpis();
  renderVolume();
  renderReadiness();
  renderRepairs();
  renderDelays();
  renderPeople();
  renderCsat();
  renderTrends();
}

// ── Drill-down URL builder ───────────────────────────────────────────────────
function drillUrl(extraParams = {}) {
  const p = new URLSearchParams();
  if (filterState.dateFrom) p.set('dateFrom', filterState.dateFrom);
  if (filterState.dateTo)   p.set('dateTo',   filterState.dateTo);
  if (filterState.misNames?.length) p.set('mis', filterState.misNames.join(','));
  if (filterState.hqsNames?.length) p.set('hqs', filterState.hqsNames.join(','));
  for (const [k, v] of Object.entries(extraParams)) {
    if (v == null || v === '' || v === false) continue;
    p.set(k, String(v));
  }
  return '/?' + p.toString();
}
function drillLink(label, extraParams) {
  return `<a href="${drillUrl(extraParams)}" target="_blank" rel="noopener">${escapeHtml(label)} ↗</a>`;
}

// ── KPI strip ────────────────────────────────────────────────────────────────
function renderKpis() {
  const total = filtered.length;

  // % Ready On-Time: of homes with lease_start_on in range AND in the past
  // (so we can know if they made it), what % were Ready/On-Track.
  const today = startOfDay(new Date());
  const past = filtered.filter(r => startOfDay(new Date(r.lease_start_on)) <= today);
  const onTime = past.filter(r => {
    const s = r.derived.effective_status;
    return s === 'ready' || s === 'on_track' || s === 'handed_off';
  });
  const onTimePct = past.length ? Math.round((onTime.length / past.length) * 100) : null;

  const fast = filtered.filter(r => r.derived.is_fast_move_in).length;
  const fastPct = total ? Math.round((fast / total) * 100) : 0;

  const handed = filtered.filter(r => !!r.context?.handed_off_to_concierge).length;
  const handedPct = total ? Math.round((handed / total) * 100) : 0;

  // Avg biz days lease executed before lease start
  const leadTimes = filtered
    .map(r => (r.lease_executed_on && r.lease_start_on)
      ? businessDaysBetween(r.lease_executed_on, r.lease_start_on) : null)
    .filter(v => v != null);
  const avgLead = leadTimes.length ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length) : null;

  const cards = [
    {
      label: '% Ready On-Time',
      value: onTimePct == null ? '—' : `${onTimePct}%`,
      sub: past.length ? `${onTime.length} of ${past.length} past move-ins` : 'No past move-ins yet',
      hero: true,
      drill: { status: 'ready' }
    },
    {
      label: 'Total move-ins',
      value: total,
      sub: 'in selected range',
      drill: {}
    },
    {
      label: 'Fast move-ins',
      value: `${fastPct}%`,
      sub: `${fast} of ${total}`,
      drill: { fast: '1' }
    },
    {
      label: 'Avg lead time',
      value: avgLead == null ? '—' : `${avgLead}d`,
      sub: 'biz days lease signed → lease start',
      drill: null
    },
    {
      label: 'Handed off',
      value: `${handedPct}%`,
      sub: `${handed} of ${total}`,
      drill: { status: 'handed_off', handedOff: '1' }
    }
  ];

  document.getElementById('aKpiStrip').innerHTML = cards.map(c => `
    <div class="kpi-card ${c.hero ? 'kpi-hero' : ''} ${c.drill ? '' : 'kpi-skel'}"
         ${c.drill ? `onclick="window.open('${drillUrl(c.drill)}', '_blank')"` : ''}>
      <div class="kpi-label">${escapeHtml(c.label)}</div>
      <div class="kpi-value">${escapeHtml(String(c.value))}</div>
      <div class="kpi-sub">${escapeHtml(c.sub)}</div>
      ${c.drill ? `<div class="kpi-drill">View homes ↗</div>` : ''}
    </div>
  `).join('');
}

// ── Volume & timing ──────────────────────────────────────────────────────────
function renderVolume() {
  // Move-ins per month
  const byMonth = {};
  for (const r of filtered) {
    const d = new Date(r.lease_start_on);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    byMonth[key] = (byMonth[key] || 0) + 1;
  }
  const monthLabels = Object.keys(byMonth).sort();
  const monthValues = monthLabels.map(k => byMonth[k]);
  drawBar('chartByMonth', monthLabels.map(prettyMonth), monthValues, '#325E77');
  document.getElementById('byMonthNote').innerHTML =
    `${monthLabels.length} month${monthLabels.length === 1 ? '' : 's'} · ${filtered.length} total`;

  // By region
  const byRegion = {};
  for (const r of filtered) {
    const k = r.region || '—';
    byRegion[k] = (byRegion[k] || 0) + 1;
  }
  const regionLabels = Object.keys(byRegion).sort();
  const regionValues = regionLabels.map(k => byRegion[k]);
  drawBar('chartByRegion', regionLabels, regionValues, '#1DB87A');
  document.getElementById('byRegionNote').textContent =
    regionLabels.length ? `${regionLabels.length} region${regionLabels.length === 1 ? '' : 's'}` : '—';

  // Lead time histogram: bucket biz days
  const buckets = { 'Same week (≤5)': 0, '6-10': 0, '11-20': 0, '21-30': 0, '31-60': 0, '60+': 0 };
  for (const r of filtered) {
    if (!r.lease_executed_on || !r.lease_start_on) continue;
    const d = businessDaysBetween(r.lease_executed_on, r.lease_start_on);
    if (d == null) continue;
    if      (d <= 5)  buckets['Same week (≤5)']++;
    else if (d <= 10) buckets['6-10']++;
    else if (d <= 20) buckets['11-20']++;
    else if (d <= 30) buckets['21-30']++;
    else if (d <= 60) buckets['31-60']++;
    else              buckets['60+']++;
  }
  drawBar('chartLeadTime', Object.keys(buckets), Object.values(buckets), '#FFAF00');
  const leads = filtered
    .map(r => (r.lease_executed_on && r.lease_start_on)
      ? businessDaysBetween(r.lease_executed_on, r.lease_start_on) : null)
    .filter(v => v != null);
  const med = leads.length ? leads.slice().sort((a, b) => a - b)[Math.floor(leads.length / 2)] : null;
  document.getElementById('leadTimeNote').innerHTML =
    leads.length
      ? `Median: <strong>${med}</strong> business days · Fast move-ins (≤5): ${drillLink(buckets['Same week (≤5)'] + ' homes', { fast: '1' })}`
      : 'Not enough lease data to compute lead time.';
}

// ── Readiness ────────────────────────────────────────────────────────────────
function renderReadiness() {
  // Status breakdown (donut)
  const buckets = { ready: 0, on_track: 0, in_progress: 0, at_risk: 0, urgent: 0, blocked: 0, handed_off: 0 };
  for (const r of filtered) {
    const s = r.derived.effective_status;
    if (s in buckets) buckets[s]++;
    else buckets.in_progress++;
  }
  const labels = ['Ready', 'On Track', 'In Progress', 'At Risk', 'Urgent', 'Blocked', 'Handed Off'];
  const values = ['ready', 'on_track', 'in_progress', 'at_risk', 'urgent', 'blocked', 'handed_off'].map(k => buckets[k]);
  const colors = ['#1DB87A', '#3EE4A9', '#FFAF00', '#D97706', '#DC2626', '#991B1B', '#94A3B8'];
  drawDonut('chartStatus', labels, values, colors);
  const total = filtered.length;
  const lines = [
    drillLink(`${buckets.ready + buckets.on_track} Ready`, { status: 'ready' }),
    drillLink(`${buckets.in_progress + buckets.at_risk} In Progress`, { status: 'in_progress' }),
    drillLink(`${buckets.urgent + buckets.blocked} Urgent`, { status: 'urgent' })
  ];
  document.getElementById('statusNote').innerHTML =
    total ? lines.join(' · ') : '—';

  // Readiness checks % (which gates pass for the cohort)
  const checks = ['repairs', 'process', 'hoa', 'payments', 'autopay', 'qa', 'lease'];
  const labelMap = { repairs: 'Repairs done', process: 'No process issues', hoa: 'HOA OK', payments: 'Payments paid', autopay: 'Autopay enrolled', qa: 'QA done', lease: 'Lease executed' };
  const drillMap = { qa: { noQa: '1' }, payments: {}, autopay: {} };
  const counts = Object.fromEntries(checks.map(c => [c, 0]));
  for (const r of filtered) {
    for (const c of (r.derived.readiness_checks || [])) {
      if (c.passed) counts[c.id] = (counts[c.id] || 0) + 1;
    }
  }
  const rcGrid = checks.map(c => {
    const passed = counts[c] || 0;
    const pct = total ? Math.round((passed / total) * 100) : 0;
    const drillTarget = c === 'qa' ? drillUrl({ noQa: '1' }) : null;
    return `
      <div class="readiness-row">
        <div>${escapeHtml(labelMap[c])}</div>
        <div class="rc-bar-bg"><div class="rc-bar-fill" style="width:${pct}%"></div></div>
        <div class="rc-pct">${pct}%</div>
        ${drillTarget
          ? `<a class="rc-link" href="${drillTarget}" target="_blank">${total - passed} miss ↗</a>`
          : `<div class="rc-link" style="color:var(--faint)">${total - passed} miss</div>`}
      </div>
    `;
  }).join('');
  document.getElementById('readinessChecks').innerHTML = rcGrid;
}

// ── Repairs ──────────────────────────────────────────────────────────────────
function renderRepairs() {
  let totalOpen = 0, totalCost = 0, unpriced = 0, requiredOpen = 0, recommendedOpen = 0;
  const homesWithUnpriced = new Set();
  const repairsByHqs = {};
  for (const r of filtered) {
    const hqs = r.improvements_specialist || '— Unassigned —';
    if (!repairsByHqs[hqs]) repairsByHqs[hqs] = { homes: 0, repairs: 0, cost: 0 };
    repairsByHqs[hqs].homes++;
    for (const rep of r.repairs) {
      const open = rep.status !== 'done';
      if (!open) continue;
      totalOpen++;
      repairsByHqs[hqs].repairs++;
      if (rep.repair_estimated_cost == null) {
        unpriced++;
        homesWithUnpriced.add(r.home_id);
      } else {
        totalCost += Number(rep.repair_estimated_cost);
        repairsByHqs[hqs].cost += Number(rep.repair_estimated_cost);
      }
      if (rep.repair_assessment === 'Required')    requiredOpen++;
      if (rep.repair_assessment === 'Recommended') recommendedOpen++;
    }
  }
  const homesWithUnpricedCount = homesWithUnpriced.size;
  const totalHomes = filtered.length;
  const avgRepairsPerHome = totalHomes ? (totalOpen / totalHomes).toFixed(1) : '0';

  const kpis = [
    { label: 'Open repairs', value: totalOpen, sub: `${avgRepairsPerHome} per home avg`, drill: {} },
    { label: 'Open repair $', value: '$' + Math.round(totalCost).toLocaleString(), sub: 'priced repairs only', drill: null },
    { label: 'Unpriced repairs', value: unpriced, sub: `${homesWithUnpricedCount} home${homesWithUnpricedCount === 1 ? '' : 's'} affected`, drill: { unpriced: '1' } },
    { label: 'Required (open)', value: requiredOpen, sub: `${recommendedOpen} recommended`, drill: null }
  ];
  document.getElementById('repairKpis').innerHTML = kpis.map(c => `
    <div class="kpi-card ${c.drill ? '' : 'kpi-skel'}"
         ${c.drill ? `onclick="window.open('${drillUrl(c.drill)}', '_blank')"` : ''}>
      <div class="kpi-label">${escapeHtml(c.label)}</div>
      <div class="kpi-value">${escapeHtml(String(c.value))}</div>
      <div class="kpi-sub">${escapeHtml(c.sub)}</div>
      ${c.drill ? `<div class="kpi-drill">View homes ↗</div>` : ''}
    </div>
  `).join('');

  // Repairs per HQS bar chart
  const hqsLabels = Object.keys(repairsByHqs).sort();
  const hqsValues = hqsLabels.map(k => repairsByHqs[k].repairs);
  drawBar('chartRepairsByHqs', hqsLabels, hqsValues, '#325E77');
  const top = hqsLabels.slice().sort((a, b) => repairsByHqs[b].repairs - repairsByHqs[a].repairs)[0];
  document.getElementById('repairsByHqsNote').innerHTML = top
    ? `Most repairs: <strong>${escapeHtml(top)}</strong> · ${repairsByHqs[top].repairs} open · $${Math.round(repairsByHqs[top].cost).toLocaleString()} priced`
    : '—';

  // Required vs Recommended donut
  drawDonut('chartAssessment',
    ['Required', 'Recommended', 'Not assessed'],
    [requiredOpen, recommendedOpen, Math.max(0, totalOpen - requiredOpen - recommendedOpen)],
    ['#DC2626', '#FFAF00', '#94A3B8']);
  document.getElementById('assessmentNote').textContent = `${totalOpen} open repair${totalOpen === 1 ? '' : 's'} total`;
}

// ── Delays ───────────────────────────────────────────────────────────────────
const DELAY_LABEL_MAP = {
  waiting_resident: 'Waiting on resident',
  pro_delay: 'Pro delay',
  vendor_reschedule: 'Vendor reschedule',
  hoa: 'HOA',
  payment: 'Payment',
  parts_materials: 'Parts / materials',
  inspection: 'Inspection / QA',
  other: 'Other'
};
function renderDelays() {
  const reasonCounts = {};
  let manualUrgent = 0, manualBlocked = 0, manualAtRisk = 0, manualOnTrack = 0;
  let handedOff = 0;
  for (const r of filtered) {
    const ctx = r.context || {};
    if (Array.isArray(ctx.delay_reasons)) {
      for (const reason of ctx.delay_reasons) {
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      }
    }
    if (ctx.manual_status === 'urgent') manualUrgent++;
    if (ctx.manual_status === 'blocked') manualBlocked++;
    if (ctx.manual_status === 'at_risk') manualAtRisk++;
    if (ctx.manual_status === 'on_track') manualOnTrack++;
    if (ctx.handed_off_to_concierge) handedOff++;
  }
  const sorted = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]);
  const labels = sorted.map(([k]) => DELAY_LABEL_MAP[k] || k);
  const values = sorted.map(([_, v]) => v);
  drawBar('chartDelays', labels, values, '#D97706');
  document.getElementById('delaysNote').textContent = sorted.length
    ? `${sorted.reduce((a, [, v]) => a + v, 0)} delay tag${sorted.length === 1 ? '' : 's'} logged`
    : 'No delays logged in this range.';

  const sidebar = [
    { label: '🚨 Manually marked Urgent', count: manualUrgent, drill: { status: 'urgent' } },
    { label: '🛑 Manually marked Blocked', count: manualBlocked, drill: { status: 'blocked' } },
    { label: '⚠️  Manually At Risk',      count: manualAtRisk, drill: { status: 'at_risk' } },
    { label: '✅ Manually On Track',       count: manualOnTrack, drill: { status: 'on_track' } },
    { label: '🤝 Handed off to concierge', count: handedOff, drill: { handedOff: '1', status: 'handed_off' } }
  ];
  document.getElementById('delaysSidebar').innerHTML = sidebar.map(s => `
    <div class="ms-item ${s.count > 0 ? 'clickable' : ''}"
         ${s.count > 0 ? `onclick="window.open('${drillUrl(s.drill)}', '_blank')"` : ''}>
      <span>${escapeHtml(s.label)}</span>
      <span class="ms-count">${s.count}</span>
    </div>
  `).join('');
}

// ── People ───────────────────────────────────────────────────────────────────
function renderPeople() {
  const mis = aggregatePeople(filtered, r => r.move_in_specialist, 'mis');
  const hqs = aggregatePeople(filtered, r => r.improvements_specialist, 'hqs');
  document.getElementById('misTable').innerHTML = peopleTableHtml(mis, 'mis');
  document.getElementById('hqsTable').innerHTML = peopleTableHtml(hqs, 'hqs');
}

function aggregatePeople(rows, keyFn, kind) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r) || '— Unassigned —';
    if (!out[k]) out[k] = { name: k, homes: 0, urgent: 0, ready: 0, repairs: 0, repairCost: 0, unpriced: 0, csatSat: 0, csatUnsat: 0, csatNoResp: 0 };
    out[k].homes++;
    const s = r.derived.effective_status;
    if (s === 'urgent' || s === 'blocked') out[k].urgent++;
    if (s === 'ready' || s === 'on_track' || s === 'handed_off') out[k].ready++;
    for (const rep of r.repairs) {
      if (rep.status === 'done') continue;
      out[k].repairs++;
      if (rep.repair_estimated_cost == null) out[k].unpriced++;
      else out[k].repairCost += Number(rep.repair_estimated_cost);
    }
    const cs = r.derived.csat_status;
    if (cs === 'satisfied')   out[k].csatSat++;
    if (cs === 'unsatisfied') out[k].csatUnsat++;
    if (cs === 'no_response') out[k].csatNoResp++;
  }
  return Object.values(out).sort((a, b) => b.homes - a.homes);
}

function peopleTableHtml(rows, kind) {
  const filterKey = kind === 'mis' ? 'mis' : 'hqs';
  const head = `
    <thead><tr>
      <th>${kind === 'mis' ? 'Move-In Specialist' : 'Home Quality Specialist'}</th>
      <th>Homes</th>
      <th>% Ready</th>
      <th>Urgent</th>
      <th>Open repairs</th>
      <th>Unpriced</th>
      <th>Repair $</th>
      <th>CSAT (👍 / 👎 / no resp)</th>
    </tr></thead>`;
  const body = rows.map(r => {
    const pctReady = r.homes ? Math.round((r.ready / r.homes) * 100) : 0;
    const url = drillUrl({ [filterKey]: r.name === '— Unassigned —' ? '' : r.name });
    return `
      <tr class="clickable" onclick="window.open('${url}', '_blank')">
        <td><span class="ppl-name">${escapeHtml(r.name)}</span></td>
        <td>${r.homes}</td>
        <td class="${pctReady >= 80 ? 'ppl-num-ok' : pctReady >= 50 ? 'ppl-num-warn' : 'ppl-num-bad'}">${pctReady}%</td>
        <td class="${r.urgent > 0 ? 'ppl-num-bad' : ''}">${r.urgent}</td>
        <td>${r.repairs}</td>
        <td class="${r.unpriced > 0 ? 'ppl-num-warn' : ''}">${r.unpriced}</td>
        <td>$${Math.round(r.repairCost).toLocaleString()}</td>
        <td>${r.csatSat} / ${r.csatUnsat} / ${r.csatNoResp}</td>
      </tr>
    `;
  }).join('');
  return head + `<tbody>${body || '<tr><td colspan="8" style="text-align:center;color:var(--faint);padding:20px">No data</td></tr>'}</tbody>`;
}

// ── CSAT ─────────────────────────────────────────────────────────────────────
function renderCsat() {
  let sat = 0, unsat = 0, none = 0;
  const scoreBuckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let scoreTotal = 0, scoreCount = 0;
  for (const r of filtered) {
    const s = r.derived.csat_status;
    if (s === 'satisfied')   sat++;
    if (s === 'unsatisfied') unsat++;
    if (s === 'no_response') none++;
    if (r.avg_rating != null && !isNaN(r.avg_rating)) {
      const rounded = Math.round(Number(r.avg_rating));
      if (scoreBuckets[rounded] !== undefined) scoreBuckets[rounded]++;
      scoreTotal += Number(r.avg_rating); scoreCount++;
    }
  }
  drawDonut('chartCsat', ['Satisfied', 'Unsatisfied', 'No response'], [sat, unsat, none], ['#1DB87A', '#DC2626', '#94A3B8']);
  const respRate = filtered.length ? Math.round(((sat + unsat) / filtered.length) * 100) : 0;
  document.getElementById('csatNote').innerHTML = `Response rate: <strong>${respRate}%</strong> · ${sat + unsat} of ${filtered.length}`;

  drawBar('chartCsatScore',
    ['1', '2', '3', '4', '5'],
    [scoreBuckets[1], scoreBuckets[2], scoreBuckets[3], scoreBuckets[4], scoreBuckets[5]],
    '#FFAF00');
  document.getElementById('csatScoreNote').textContent = scoreCount
    ? `Avg score: ${(scoreTotal / scoreCount).toFixed(2)} · ${scoreCount} response${scoreCount === 1 ? '' : 's'}`
    : 'No CSAT scores in range.';
}

// ── Trends (snapshot-based) ──────────────────────────────────────────────────
function renderTrends() {
  if (!snapshots.length) {
    document.getElementById('trendsNote').innerHTML =
      '<strong>No snapshot history yet.</strong> Trend lines will appear once you have at least 2 days of snapshots. The cron runs nightly at 06:00 UTC; you can also click "Take snapshot now" on the Manage page.';
    drawLine('chartTrends', [], { Total: [], Ready: [], 'In Progress': [], Urgent: [] });
    return;
  }
  // Group snapshots by date
  const byDate = {};
  for (const s of snapshots) {
    if (!byDate[s.snapshot_date]) byDate[s.snapshot_date] = [];
    byDate[s.snapshot_date].push(s);
  }
  const dates = Object.keys(byDate).sort();
  const total = [], ready = [], inProgress = [], urgent = [];
  for (const d of dates) {
    const rows = byDate[d];
    let t = 0, r = 0, ip = 0, u = 0;
    for (const s of rows) {
      // Use derived_effective_status if present (may be null in older snapshots).
      // Fallback heuristic: was_handed_off → handed_off; else infer from is_satisfied/payments? Skip for v1.
      const eff = s.derived_effective_status || (s.was_handed_off ? 'handed_off' : null);
      if (s.was_handed_off) continue;
      t++;
      if (eff === 'ready' || eff === 'on_track') r++;
      else if (eff === 'urgent' || eff === 'blocked') u++;
      else ip++;
    }
    total.push(t); ready.push(r); inProgress.push(ip); urgent.push(u);
  }
  drawLine('chartTrends', dates, {
    Total:        total,
    Ready:        ready,
    'In Progress': inProgress,
    Urgent:       urgent
  });
  const last = dates[dates.length - 1];
  document.getElementById('trendsNote').innerHTML =
    `${dates.length} day${dates.length === 1 ? '' : 's'} of history · latest: <strong>${last}</strong>`;
}

// ── Chart.js helpers ─────────────────────────────────────────────────────────
function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}
function drawBar(id, labels, data, color) {
  destroyChart(id);
  const ctx = document.getElementById(id);
  if (!ctx) return;
  charts[id] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: color, borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { beginAtZero: true, ticks: { font: { size: 10 }, precision: 0 } }
      }
    }
  });
}
function drawDonut(id, labels, data, colors) {
  destroyChart(id);
  const ctx = document.getElementById(id);
  if (!ctx) return;
  charts[id] = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 10 } }
      },
      cutout: '60%'
    }
  });
}
function drawLine(id, labels, datasetMap) {
  destroyChart(id);
  const ctx = document.getElementById(id);
  if (!ctx) return;
  const palette = { Total: '#325E77', Ready: '#1DB87A', 'In Progress': '#FFAF00', Urgent: '#DC2626' };
  const datasets = Object.entries(datasetMap).map(([label, data]) => ({
    label, data, fill: false, tension: 0.25,
    borderColor: palette[label] || '#5A6B7A',
    backgroundColor: palette[label] || '#5A6B7A',
    pointRadius: 2
  }));
  charts[id] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 10 }, boxWidth: 10 } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0, autoSkip: true } },
        y: { beginAtZero: true, ticks: { font: { size: 10 }, precision: 0 } }
      }
    }
  });
}

// ── Date picker + chip handlers ──────────────────────────────────────────────
function initDatePicker() {
  const input = document.getElementById('aDateRange');
  if (!input || !window.flatpickr) return;
  window._datePicker = flatpickr(input, {
    mode: 'range', dateFormat: 'Y-m-d', altInput: true, altFormat: 'M j, Y',
    onChange(dates) {
      const fmt = d => d.toISOString().slice(0, 10);
      if (dates.length === 0)      { filterState.dateFrom = ''; filterState.dateTo = ''; }
      else if (dates.length === 1) { filterState.dateFrom = fmt(dates[0]); filterState.dateTo = fmt(dates[0]); }
      else                          { filterState.dateFrom = fmt(dates[0]); filterState.dateTo = fmt(dates[dates.length - 1]); }
      filterState.dateChip = '';
      updateChipsUI(); updateDateClearUI(); persistFilters(); applyAndRender();
    }
  });
  document.getElementById('aDateClear').addEventListener('click', () => {
    filterState.dateFrom = ''; filterState.dateTo = ''; filterState.dateChip = '';
    if (window._datePicker) window._datePicker.clear();
    updateChipsUI(); updateDateClearUI(); persistFilters(); applyAndRender();
  });
}

function syncDatePickerToState() {
  if (!window._datePicker) return;
  if (filterState.dateFrom && filterState.dateTo)
    window._datePicker.setDate([filterState.dateFrom, filterState.dateTo], false);
  else if (filterState.dateFrom)
    window._datePicker.setDate([filterState.dateFrom], false);
  else
    window._datePicker.clear();
}

function setAnalyticsChip(chip, persist = true) {
  const today = startOfDay(new Date());
  const fmt = d => d.toISOString().slice(0, 10);
  if (chip === 'this_month') {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const last  = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    filterState.dateFrom = fmt(first); filterState.dateTo = fmt(last);
  } else if (chip === 'last_month') {
    const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const last  = new Date(today.getFullYear(), today.getMonth(), 0);
    filterState.dateFrom = fmt(first); filterState.dateTo = fmt(last);
  } else if (chip === '30_days') {
    filterState.dateFrom = fmt(addDays(today, -30)); filterState.dateTo = fmt(today);
  } else if (chip === '90_days') {
    filterState.dateFrom = fmt(addDays(today, -90)); filterState.dateTo = fmt(today);
  } else if (chip === 'all_time') {
    filterState.dateFrom = ''; filterState.dateTo = '';
  }
  filterState.dateChip = chip;
  syncDatePickerToState();
  updateChipsUI();
  updateDateClearUI();
  if (persist) persistFilters();
  applyAndRender();
}
window.setAnalyticsChip = setAnalyticsChip;

function updateChipsUI() {
  ['this_month', 'last_month', '30_days', '90_days', 'all_time'].forEach(c => {
    const el = document.getElementById('achip_' + c);
    if (el) el.classList.toggle('active', filterState.dateChip === c);
  });
}
function updateDateClearUI() {
  const btn = document.getElementById('aDateClear');
  if (!btn) return;
  btn.style.display = (filterState.dateFrom || filterState.dateTo) ? '' : 'none';
}

// ── Specialist multi-select ──────────────────────────────────────────────────
function toggleAnalyticsSpecialistMenu(event) {
  event.stopPropagation();
  const existing = document.getElementById('aSpecialistPop');
  if (existing) { existing.remove(); return; }
  const anchor = document.getElementById('aSpecialistBtn');
  const misNames = [...new Set(allRows.map(r => r.move_in_specialist).filter(Boolean))].sort();
  const hqsNames = [...new Set(allRows.map(r => r.improvements_specialist).filter(Boolean))].sort();
  const misSel = new Set(filterState.misNames || []);
  const hqsSel = new Set(filterState.hqsNames || []);

  const pop = document.createElement('div');
  pop.id = 'aSpecialistPop';
  pop.className = 'multi-pop';
  pop.innerHTML = `
    <div class="mp-section-title">MIS — Move-In Specialist</div>
    <div class="mp-list">
      ${misNames.length ? misNames.map(n => `
        <label class="mp-opt">
          <input type="checkbox" data-section="mis" value="${escapeAttr(n)}" ${misSel.has(n) ? 'checked' : ''}>
          <span>${escapeHtml(n)}</span>
        </label>
      `).join('') : '<div class="faint" style="padding:6px">No MIS</div>'}
    </div>
    <div class="mp-divider"></div>
    <div class="mp-section-title">HQS — Home Quality Specialist</div>
    <div class="mp-list">
      ${hqsNames.length ? hqsNames.map(n => `
        <label class="mp-opt">
          <input type="checkbox" data-section="hqs" value="${escapeAttr(n)}" ${hqsSel.has(n) ? 'checked' : ''}>
          <span>${escapeHtml(n)}</span>
        </label>
      `).join('') : '<div class="faint" style="padding:6px">No HQS</div>'}
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
    persistFilters(); applyAndRender(); updateSpecialistButtonLabel(); pop.remove();
  };
  pop.querySelector('.mp-clear').onclick = () => {
    filterState.misNames = []; filterState.hqsNames = [];
    persistFilters(); applyAndRender(); updateSpecialistButtonLabel(); pop.remove();
  };
  setTimeout(() => document.addEventListener('click', _closeSpec, { once: true }), 0);
}
window.toggleAnalyticsSpecialistMenu = toggleAnalyticsSpecialistMenu;
function _closeSpec(e) {
  const pop = document.getElementById('aSpecialistPop');
  if (!pop) return;
  if (pop.contains(e.target) || e.target.closest('#aSpecialistBtn')) {
    document.addEventListener('click', _closeSpec, { once: true }); return;
  }
  pop.remove();
}
function updateSpecialistButtonLabel() {
  const lbl = document.getElementById('aSpecialistLabel');
  const btn = document.getElementById('aSpecialistBtn');
  if (!lbl || !btn) return;
  const m = filterState.misNames || [], h = filterState.hqsNames || [];
  const total = m.length + h.length;
  if (total === 0) { lbl.textContent = 'All specialists'; btn.classList.remove('has-active'); return; }
  btn.classList.add('has-active');
  const parts = [];
  if (m.length) parts.push(`MIS: ${m.length === 1 ? m[0] : m.length}`);
  if (h.length) parts.push(`HQS: ${h.length === 1 ? h[0] : h.length}`);
  lbl.textContent = parts.join(' · ');
}

// ── Persistence ──────────────────────────────────────────────────────────────
function persistFilters() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(filterState)); } catch {}
}
function restoreFilters() {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    Object.assign(filterState, {
      dateFrom: s.dateFrom || '',
      dateTo: s.dateTo || '',
      dateChip: s.dateChip || 'this_month',
      misNames: Array.isArray(s.misNames) ? s.misNames : [],
      hqsNames: Array.isArray(s.hqsNames) ? s.hqsNames : []
    });
    updateSpecialistButtonLabel();
  } catch {}
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function prettyMonth(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
}
function escapeHtml(s = '') {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s = '') { return escapeHtml(s); }
