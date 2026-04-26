# Data Contract — Move-Ins Dashboard

**Version:** v3 (normalized, three-stream split)
**Status:** LOCKED — do not change without bumping version

This is the contract between the data layer (BigQuery view today, Belong DB later) and the dashboard. Any field marked "derived in JS" is computed by `assets/derive.js`, never by the data layer.

---

## Architecture overview

```
[Source: BigQuery view  /  Belong DB view]
                │
                │  (cron + manual refresh)
                ▼
[Cache: Supabase tables]
                │
                ▼
[Dashboard]  ←  reads cache, writes annotations
                │
                ▼
[Annotations: Supabase tables — dashboard-owned]
```

**Three read streams, joined in JS by `home_id`:**

1. **`homes`** — one row per home. All home/lease/payment/balance/QA/CSAT fields.
2. **`repairs`** — one row per repair. Keyed by `home_id`.
3. **`pro_services`** — one row per pro service. Keyed by `home_id`.

**Three annotation tables** (writes, dashboard-owned):

4. `home_repair_context` — postpone reasons, expectations, hand-off, delay tracking
5. `repair_status` — per-repair editable status (open/in_progress/done)
6. `sync_log` — refresh history

---

## Cohort rule (applied to all three views)

```sql
DECLARE cohort_anchor_date DATE DEFAULT DATE '2026-04-15';

-- A home is in the cohort if its lease was executed on/after the anchor
-- OR has a start date on/after the anchor.
WHERE LeaseExecutedOn >= cohort_anchor_date
   OR LeaseStartOn   >= cohort_anchor_date
```

`repairs` and `pro_services` are filtered to homes in the cohort (via `WHERE home_id IN (SELECT home_id FROM cohort_homes)`).

To roll the cohort forward (new season), bump `cohort_anchor_date` in all three queries.

---

## Stream 1: `homes`

One row per home. Pure home/lease/payment/balance/QA/CSAT data — no repair info, no pro-service info.

### Identity
| column | type | source | notes |
|---|---|---|---|
| `home_id` | INT PK | Home.HomeId | not null, unique |
| `lease_id` | INT | Lease.LeaseId | |
| `resident_id` | INT | Resident.ResidentId | |
| `report_date` | DATE | extract date | when snapshot was taken |

### Address
| column | type | source |
|---|---|---|
| `address` | TEXT | Home.Address |
| `region` | TEXT | Home.Region |

### Resident
| column | type | source | notes |
|---|---|---|---|
| `resident_name` | TEXT | Resident.Name | |
| `intercom_id` | TEXT | TBD | nullable, populated when join is wired |

### Specialists
| column | type | source |
|---|---|---|
| `move_in_specialist` | TEXT | |
| `move_in_specialist_id` | INT | |
| `concierge` | TEXT | |
| `concierge_id` | INT | |
| `improvements_specialist` | TEXT | |
| `improvements_specialist_id` | INT | |

### HOA (raw)
| column | type | source |
|---|---|---|
| `has_hoa` | BOOLEAN | Home.HasHoa |
| `hoa_is_notified` | BOOLEAN | Home.HoaIsNotified |

### Lease (raw)
| column | type | source | notes |
|---|---|---|---|
| `lease_start_on` | DATE | Lease.LeaseStartOn | |
| `lease_executed_on` | DATE | Lease.ExecutedOn | most recent execution |
| `original_executed_on` | DATE | derived in BQ: MIN(ExecutedOn) over HomeId | for fast-move-in calc |
| `is_revised` | BOOLEAN | Lease.IsRevised | |

### Milestones (raw)
| column | type | source |
|---|---|---|
| `current_milestone` | TEXT | |
| `current_milestone_on` | TIMESTAMPTZ | |
| `move_in_ready` | TIMESTAMPTZ | |
| `move_in_completed` | TIMESTAMPTZ | |

### Payments (raw)
| column | type | source |
|---|---|---|
| `rent_amount` | NUMERIC | |
| `deposit_amount` | NUMERIC | |
| `deposit_type` | TEXT | |
| `paid_rent` | NUMERIC | |
| `received_rent` | NUMERIC | |
| `processing_receive_rent` | NUMERIC | |
| `enrolled_in_auto_pay` | BOOLEAN | |
| `move_in_payment_status` | TEXT | raw status string |

### Balance (raw)
| column | type | source |
|---|---|---|
| `balances_unpaid` | INT | |
| `deposit_unpaid` | BOOLEAN | |
| `rent_unpaid` | BOOLEAN | |
| `has_deposit` | BOOLEAN | |
| `has_rent` | BOOLEAN | |
| `balance_detail` | TEXT | optional human-readable summary |

### QA Inspection (raw)
| column | type | source |
|---|---|---|
| `had_qa_inspection` | BOOLEAN | |
| `qa_inspection_count` | INT | |

### CSAT (raw)
| column | type | source |
|---|---|---|
| `is_satisfied` | BOOLEAN | |
| `csat_response_count` | INT | |
| `csat_status` | TEXT | |
| `avg_rating` | NUMERIC | |
| `csat_requester_name` | TEXT | |
| `csat_created_on` | TIMESTAMPTZ | |
| `csat_comment` | TEXT | |

### Tracking
| column | type |
|---|---|
| `__source_table` | TEXT (`'homes'`) |
| `last_synced_at` | TIMESTAMPTZ |

---

## Stream 2: `repairs`

One row per repair. Filtered to cohort homes only.

| column | type | source | notes |
|---|---|---|---|
| `maintenance_id` | INT PK | Maintenance.MaintenanceId | not null, unique |
| `home_id` | INT FK | Maintenance.HomeId | join key |
| `repair_summary` | TEXT | Maintenance.Summary | |
| `repair_estimated_cost` | NUMERIC | Maintenance.EstimatedCost | nullable |
| `repair_assessment` | TEXT | Maintenance.Assessment | 'Required' / 'Recommended' / null |
| `repair_category` | TEXT | Maintenance.RequestCategory | 'QA' / 'Moveout' / 'Improvements' / etc. |
| `repair_created_on` | TIMESTAMPTZ | Maintenance.CreatedOn | for post-move-in detection |
| `__source_table` | TEXT (`'repairs'`) | | |
| `last_synced_at` | TIMESTAMPTZ | | |

Homes with zero repairs simply have zero rows here — no NULL filler row needed.

---

## Stream 3: `pro_services`

One row per pro service. Returns ALL pro services for cohort homes — the dashboard applies the 7-day actionable rule in JS.

| column | type | source | notes |
|---|---|---|---|
| `pro_service_id` | INT PK | ProService.Id | |
| `home_id` | INT FK | join key | |
| `service_name` | TEXT | | |
| `service_category` | TEXT | nullable | |
| `service_status` | TEXT | raw status | |
| `service_created_on` | TIMESTAMPTZ | when submitted | needed for 7-day rule |
| `service_completed_on` | TIMESTAMPTZ | nullable | |
| `__source_table` | TEXT (`'pro_services'`) | | |
| `last_synced_at` | TIMESTAMPTZ | | |

---

## Annotation tables (dashboard-owned writes)

These are NOT in any view. They live in Supabase, are written by the dashboard, and survive every refresh.

### `home_repair_context`

| column | type | notes |
|---|---|---|
| `home_id` | INT PK | FK to homes.home_id |
| `status` | TEXT | manual override of derived state (kept for now) |
| `repairs_context` | TEXT | narrative |
| `postpone_reason` | TEXT | |
| `expectations` | TEXT | |
| `handed_off_to_concierge` | BOOLEAN | default false |
| `handed_off_at` | TIMESTAMPTZ | nullable |
| `handed_off_by` | TEXT | email |
| `is_delayed` | BOOLEAN | default false |
| `delay_reasons` | TEXT[] | values: `'repairs'`, `'hoa'`, `'other'` |
| `delay_other_text` | TEXT | only if `'other'` in array |
| `delay_logged_at` | TIMESTAMPTZ | |
| `delay_logged_by` | TEXT | |
| `updated_at` | TIMESTAMPTZ | auto-updated |

### `repair_status` (NEW)

| column | type | notes |
|---|---|---|
| `maintenance_id` | INT PK | FK to repairs.maintenance_id |
| `status` | TEXT | 'open' / 'in_progress' / 'done' |
| `notes` | TEXT | |
| `updated_at` | TIMESTAMPTZ | auto |
| `updated_by` | TEXT | email |

### `sync_log` (NEW)

| column | type |
|---|---|
| `id` | SERIAL PK |
| `started_at` | TIMESTAMPTZ |
| `finished_at` | TIMESTAMPTZ |
| `row_count_homes` | INT |
| `row_count_repairs` | INT |
| `row_count_pro_services` | INT |
| `status` | TEXT (`success`/`error`) |
| `error_message` | TEXT |
| `triggered_by` | TEXT (email or `'cron'`) |

---

## Removed entirely (now derived in JS via `derive.js`)

These were columns in v1/v2 — they no longer exist in the data layer:

- `IsFastMoveIn` → `derive.isFastMoveIn(home)` using `original_executed_on`
- `BusinessDaysToLeaseStart` → `derive.businessDaysToLeaseStart(home)`
- `PaymentStatus` / `PaymentsResult` → `derive.paymentStatus(home)`
- `ImprovementsResult` → `derive.improvementsStatus(home, repairs)`
- `CSATResult` → `derive.csatStatus(home)`
- `QAInspectionResult` → `derive.qaStatus(home)` (pending = failure)
- `IsPerfectMoveIn` / `IsPerfectMoveInStrict` → `derive.readinessChecks(...)`
- `FailureReasons` → derived from readinessChecks
- `UnfinishedImprovements*` / `UnfinishedGroupDetails` / `AllUnfinishedDetails` → counted/built from `repairs` rows
- `QAMaintenanceIds` → identified by `repair_category = 'QA'`
- `NewProServices*` → from `pro_services` stream
- `lease_url` → constructed in JS as `https://admin.bln.hm/leases/${lease_id}`
- `admin_link` → constructed in JS from `home_id`

## Derived flags in `derive.js` (computed once per refresh, memoized)

- `isFastMoveIn(home)` — based on `original_executed_on → lease_start_on`
- `businessDaysToLeaseStart(home)`
- `paymentStatus(home)` — `'all_paid' | 'deposit_unpaid' | 'rent_unpaid' | 'both_unpaid'`
- `paymentBlockingMoveIn(home)` — auto badge when `business_days_to_lease_start ≤ 3 AND NOT all_paid`
- `qaStatus(home)` — pending counts as failure
- `improvementsStatus(home, repairs)` — Required-only blocking; Recommended optional
- `csatStatus(home)`
- `readinessChecks(home, repairs, repairStatuses, repairContext)` — 7-check validation
- `derivedReadyState(home, ...)` — `'in_progress' | 'ready' | 'urgent'`
- `actionableProServices(home, services)` — filters to `created_on BETWEEN lease_start_on AND lease_start_on + 7 days`
- `postMoveInRepairs(home, repairs)` — `repair_created_on > lease_start_on` → red escalation badge
- `isHandoffEligible(home)` — `move_in_completed IS NOT NULL`
- `leaseUrl(home)` — `https://admin.bln.hm/leases/${lease_id}`

## In-memory join (in `derive.js`, runs once after data load)

```js
for each home:
  home.repairs       = repairs.filter(r => r.home_id === home.home_id)
  home.pro_services  = pro_services.filter(s => s.home_id === home.home_id)
  // then run all derivations on the enriched home
  home.derived = computeAllDerivations(home, ...)
```

Render code reads from `home.derived.*` — never recomputes.
