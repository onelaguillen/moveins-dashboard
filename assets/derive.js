// ── Derive: pure view-model construction ─────────────────────────────────────
// No side effects, no Supabase calls. Takes raw rows from dataSource and
// produces enriched homes ready for render. Run ONCE per refresh; renders
// read pre-computed `home.derived.*`.

// ── Date helpers ─────────────────────────────────────────────────────────────
function _startOfDay(d) {
  const x = new Date(d);
  if (isNaN(x)) return null;
  x.setHours(0, 0, 0, 0);
  return x;
}

// Count business days (Mon-Fri) between two dates, inclusive of both endpoints.
// Returns null if either is missing/invalid.
function businessDaysBetween(start, end) {
  const s = _startOfDay(start);
  const e = _startOfDay(end);
  if (!s || !e) return null;
  if (s > e) return -businessDaysBetween(end, start);
  let count = 0;
  const cur = new Date(s);
  while (cur <= e) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ── Per-home derivations ─────────────────────────────────────────────────────

function isFastMoveIn(home) {
  // Use original_executed_on (earliest lease execution) — distinguishes real
  // fast move-ins from revisions that look fast.
  const days = businessDaysBetween(home.original_executed_on, home.lease_start_on);
  return days != null && days <= 5;
}

function businessDaysToLeaseStart(home) {
  if (!home.lease_start_on) return null;
  return businessDaysBetween(new Date(), home.lease_start_on);
}

function paymentStatus(home) {
  // Autopay does NOT count as paid.
  const dep = !!home.deposit_unpaid;
  const rent = !!home.rent_unpaid;
  if (dep && rent) return 'both_unpaid';
  if (dep)         return 'deposit_unpaid';
  if (rent)        return 'rent_unpaid';
  return 'all_paid';
}

function paymentBlockingMoveIn(home, bizDays, payStatus) {
  if (bizDays == null) return false;
  return bizDays <= 3 && payStatus !== 'all_paid';
}

function qaStatus(home) {
  // QA "passed" = the QA group record exists in Foundation. Children (linked
  // repair tickets) are tracked separately as repairs — not a QA failure.
  return home.qa_group_id ? 'done' : 'no_qa';
}

function csatStatus(home) {
  if (home.is_satisfied === true)  return 'satisfied';
  if (home.is_satisfied === false) return 'unsatisfied';
  return 'no_response';
}

function hasUnpricedOpenRepair(repairs) {
  return repairs.some(r => r.status !== 'done' && (r.repair_estimated_cost == null));
}

function unpricedOpenRepairCount(repairs) {
  return repairs.filter(r => r.status !== 'done' && (r.repair_estimated_cost == null)).length;
}

function improvementsStatus(home, repairs) {
  let hasReqOpen = false;
  let hasRecOpen = false;
  let postCount  = 0;
  for (const r of repairs) {
    const open = r.status !== 'done';
    if (open && r.repair_assessment === 'Required')    hasReqOpen = true;
    if (open && r.repair_assessment === 'Recommended') hasRecOpen = true;
    if (r.is_post_move_in) postCount++;
  }
  return {
    has_required_open: hasReqOpen,
    has_recommended_open: hasRecOpen,
    post_move_in_count: postCount
  };
}

function readinessChecks(home, repairs) {
  const repairsDone = !repairs.some(r => r.repair_assessment === 'Required' && r.status !== 'done');
  const noProcessIssues = true; // placeholder — Phase 8/8b
  const hoaOk = !home.has_hoa || !!home.hoa_is_notified;
  const paymentsOk = home.derived?.payment_status === 'all_paid'
    || paymentStatus(home) === 'all_paid';
  const autopayOk = home.enrolled_in_auto_pay === true;
  const qaOk = qaStatus(home) === 'done';
  const leaseExecutedOk = !!home.lease_executed_on;

  return [
    { id: 'repairs',  label: 'Repairs done',      passed: repairsDone,    blocker: !repairsDone },
    { id: 'process',  label: 'No process issues', passed: noProcessIssues, blocker: !noProcessIssues },
    { id: 'hoa',      label: 'HOA',               passed: hoaOk,           blocker: !hoaOk },
    { id: 'payments', label: 'Payments',          passed: paymentsOk,      blocker: !paymentsOk },
    { id: 'autopay',  label: 'Autopay',           passed: autopayOk,       blocker: !autopayOk },
    { id: 'qa',       label: 'QA',                passed: qaOk,            blocker: !qaOk },
    { id: 'lease',    label: 'Lease executed',    passed: leaseExecutedOk, blocker: !leaseExecutedOk }
  ];
}

function derivedReadyState(checks, bizDays) {
  const anyBlocker = checks.some(c => c.blocker);
  if (bizDays != null && bizDays <= 3 && anyBlocker) return 'urgent';
  if (!anyBlocker) return 'ready';
  return 'in_progress';
}

function actionableProServicesFilter(home, services) {
  if (!home.lease_start_on) return [];
  const start = _startOfDay(home.lease_start_on);
  if (!start) return [];
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return services.filter(s => {
    if (!s.service_created_on) return false;
    const c = new Date(s.service_created_on);
    return c >= start && c <= end;
  });
}

function isPostMoveInRepair(repair, home) {
  if (!repair.repair_created_on || !home.lease_start_on) return false;
  const c = new Date(repair.repair_created_on);
  const s = new Date(home.lease_start_on);
  if (isNaN(c) || isNaN(s)) return false;
  return c > s;
}

function adminLink(home) {
  return `https://foundation.bln.hm/homes/${home.home_id}`;
}

function leaseUrl(home) {
  return home.lease_id ? `https://admin.bln.hm/leases/${home.lease_id}` : null;
}

// ── Main entry: deriveViewModels ─────────────────────────────────────────────
function deriveViewModels(rawHomes, rawRepairs, rawProServices, repairStatuses, repairContext) {
  const homes = Array.isArray(rawHomes) ? rawHomes : [];
  const repairs = Array.isArray(rawRepairs) ? rawRepairs : [];
  const proServices = Array.isArray(rawProServices) ? rawProServices : [];
  const statuses = Array.isArray(repairStatuses) ? repairStatuses : [];
  const ctxRows  = Array.isArray(repairContext)  ? repairContext  : [];

  const statusByMid = new Map(statuses.map(s => [s.maintenance_id, s]));
  const ctxByHome   = new Map(ctxRows.map(c => [c.home_id, c]));

  // Group repairs and services by home_id once.
  const repairsByHome = new Map();
  for (const r of repairs) {
    if (!repairsByHome.has(r.home_id)) repairsByHome.set(r.home_id, []);
    repairsByHome.get(r.home_id).push(r);
  }
  const servicesByHome = new Map();
  for (const s of proServices) {
    if (!servicesByHome.has(s.home_id)) servicesByHome.set(s.home_id, []);
    servicesByHome.get(s.home_id).push(s);
  }

  return homes.map(rawHome => {
    const home = { ...rawHome };

    // Attach context (default empty object so callers don't need null-checks)
    home.context = ctxByHome.get(home.home_id) || {};

    // Augment repairs with status + post-move-in flag
    const homeRepairs = (repairsByHome.get(home.home_id) || []).map(r => {
      const stat = statusByMid.get(r.maintenance_id);
      const rr = { ...r };
      rr.status = stat?.status || 'open';
      rr.status_notes = stat?.notes || null;
      rr.status_updated_at = stat?.updated_at || null;
      rr.status_updated_by = stat?.updated_by || null;
      rr.is_post_move_in = isPostMoveInRepair(r, home);
      return rr;
    });
    home.repairs = homeRepairs;

    const homeServices = servicesByHome.get(home.home_id) || [];
    home.pro_services = homeServices;
    home.actionable_pro_services = actionableProServicesFilter(home, homeServices);

    // ── Compute all derivations ──────────────────────────────────────────────
    const bizDays      = businessDaysToLeaseStart(home);
    const payStatus    = paymentStatus(home);
    const fast         = isFastMoveIn(home);
    const qa           = qaStatus(home);
    const csat         = csatStatus(home);
    const imp          = improvementsStatus(home, homeRepairs);
    // readinessChecks needs payment_status; pre-stash it before calling.
    home.derived = { payment_status: payStatus };
    const checks       = readinessChecks(home, homeRepairs);
    const readyState   = derivedReadyState(checks, bizDays);

    // Manual status override (urgent / at_risk / blocked / on_track / handed_off).
    // NULL/undefined = use auto-derived. Handed-off context flag also forces handed_off.
    const manualStatus = home.context?.manual_status || null;
    const handedOff = !!home.context?.handed_off_to_concierge;
    let effectiveStatus = manualStatus || readyState;
    if (handedOff && !manualStatus) effectiveStatus = 'handed_off';

    home.derived = {
      is_fast_move_in: fast,
      business_days_to_lease_start: bizDays,
      payment_status: payStatus,
      payment_blocking_move_in: paymentBlockingMoveIn(home, bizDays, payStatus),
      qa_status: qa,
      improvements_status: imp,
      csat_status: csat,
      is_handoff_eligible: !!home.move_in_completed,
      lease_url: leaseUrl(home),
      admin_link: adminLink(home),
      readiness_checks: checks,
      derived_ready_state: readyState,
      manual_status: manualStatus,
      effective_status: effectiveStatus,
      has_unpriced_open_repair: hasUnpricedOpenRepair(homeRepairs),
      unpriced_open_repair_count: unpricedOpenRepairCount(homeRepairs)
    };

    return home;
  });
}

// Expose helpers globally (no module system in use).
window.deriveViewModels    = deriveViewModels;
window.businessDaysBetween = businessDaysBetween;
