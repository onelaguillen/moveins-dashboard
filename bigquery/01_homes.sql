-- ============================================================
-- Move-Ins Dashboard — Stream 1: homes
-- One row per home. Pure home/lease/payment/balance/QA/CSAT data.
-- NO repair info, NO pro-service info.
--
-- Output columns must match docs/data-contract.md exactly.
-- ============================================================

DECLARE cohort_anchor_date DATE DEFAULT DATE '2026-04-15';

WITH

-- 1. Cohort: leases executed on/after anchor OR start date on/after anchor
cohort AS (
  SELECT
    l.LeaseId,
    l.HomeId,
    l.ResidentId,
    l.LeaseStartOn,
    l.ExecutedOn         AS LeaseExecutedOn,
    l.IsRevised,
    -- Earliest ExecutedOn for the same home — distinguishes real fast move-ins
    -- from lease revisions that look fast but aren't.
    MIN(l.ExecutedOn) OVER (PARTITION BY l.HomeId) AS OriginalExecutedOn
  FROM `belong_main.Lease` l
  WHERE l.ExecutedOn   >= cohort_anchor_date
     OR l.LeaseStartOn >= cohort_anchor_date
),

-- 2. Balance summary per home
balance_summary AS (
  SELECT
    b.HomeId,
    SUM(CASE WHEN b.Status = 'unpaid' THEN 1 ELSE 0 END)                            AS BalancesUnpaid,
    MAX(CASE WHEN b.Type = 'deposit' AND b.Status = 'unpaid' THEN 1 ELSE 0 END)    AS DepositUnpaid,
    MAX(CASE WHEN b.Type = 'rent'    AND b.Status = 'unpaid' THEN 1 ELSE 0 END)    AS RentUnpaid,
    MAX(CASE WHEN b.Type = 'deposit' THEN 1 ELSE 0 END)                            AS HasDeposit,
    MAX(CASE WHEN b.Type = 'rent'    THEN 1 ELSE 0 END)                            AS HasRent,
    STRING_AGG(
      CONCAT(b.Type, ': ', b.Status, ' ($', CAST(b.Amount AS STRING), ')'),
      ' | ' ORDER BY b.Type
    ) AS BalanceDetail
  FROM `belong_main.Balance` b
  WHERE b.HomeId IN (SELECT HomeId FROM cohort)
  GROUP BY b.HomeId
),

-- 3. QA inspection summary per home
qa_summary AS (
  SELECT
    m.HomeId,
    COUNTIF(m.RequestCategory = 'QA')                                AS QAInspectionCount,
    COUNTIF(m.RequestCategory = 'QA') > 0                            AS HadQAInspection
  FROM `belong_main.Maintenance` m
  WHERE m.HomeId IN (SELECT HomeId FROM cohort)
  GROUP BY m.HomeId
),

-- 4. CSAT summary per home (most recent + counts)
csat_latest AS (
  SELECT
    c.HomeId,
    ANY_VALUE(c.IsSatisfied)        AS IsSatisfied,
    COUNT(*)                        AS CSATResponseCount,
    ANY_VALUE(c.Status)             AS CSATStatus,
    AVG(c.Rating)                   AS AvgRating,
    ANY_VALUE(c.RequesterName)      AS CsatRequesterName,
    MAX(c.CreatedOn)                AS CsatCreatedOn,
    ANY_VALUE(c.Comment)            AS CsatComment
  FROM `belong_main.CSAT` c          -- TODO: confirm CSAT table name
  WHERE c.HomeId IN (SELECT HomeId FROM cohort)
  GROUP BY c.HomeId
)

-- 5. Final: one row per home
SELECT
  -- Identity
  h.HomeId                         AS home_id,
  c.LeaseId                        AS lease_id,
  c.ResidentId                     AS resident_id,
  CURRENT_DATE()                   AS report_date,

  -- Address
  h.Address                        AS address,
  h.Region                         AS region,

  -- Resident
  r.Name                           AS resident_name,
  CAST(NULL AS STRING)             AS intercom_id,    -- placeholder, populate when join is wired

  -- Specialists
  h.MoveInSpecialist               AS move_in_specialist,
  h.MoveInSpecialistId             AS move_in_specialist_id,
  h.Concierge                      AS concierge,
  h.ConciergeId                    AS concierge_id,
  h.ImprovementsSpecialist         AS improvements_specialist,
  h.ImprovementsSpecialistId       AS improvements_specialist_id,

  -- HOA
  SAFE_CAST(h.HasHoa         AS BOOL) AS has_hoa,
  SAFE_CAST(h.HoaIsNotified  AS BOOL) AS hoa_is_notified,

  -- Lease
  c.LeaseStartOn                   AS lease_start_on,
  c.LeaseExecutedOn                AS lease_executed_on,
  c.OriginalExecutedOn             AS original_executed_on,
  SAFE_CAST(c.IsRevised AS BOOL)         AS is_revised,

  -- Milestones
  h.CurrentMilestone               AS current_milestone,
  h.CurrentMilestoneOn             AS current_milestone_on,
  h.MoveInReady                    AS move_in_ready,
  h.MoveInCompleted                AS move_in_completed,

  -- Payments  (TODO: confirm whether RentAmount/DepositAmount live on Lease or Home)
  c.RentAmount                     AS rent_amount,
  c.DepositAmount                  AS deposit_amount,
  c.DepositType                    AS deposit_type,
  c.PaidRent                       AS paid_rent,
  c.ReceivedRent                   AS received_rent,
  c.ProcessingReceiveRent          AS processing_receive_rent,
  SAFE_CAST(c.EnrolledInAutoPay AS BOOL) AS enrolled_in_auto_pay,
  c.MoveInPaymentStatus            AS move_in_payment_status,

  -- Balance
  COALESCE(bs.BalancesUnpaid, 0)         AS balances_unpaid,
  SAFE_CAST(bs.DepositUnpaid AS BOOL)    AS deposit_unpaid,
  SAFE_CAST(bs.RentUnpaid    AS BOOL)    AS rent_unpaid,
  SAFE_CAST(bs.HasDeposit    AS BOOL)    AS has_deposit,
  SAFE_CAST(bs.HasRent       AS BOOL)    AS has_rent,
  bs.BalanceDetail                       AS balance_detail,

  -- QA
  COALESCE(qa.HadQAInspection, FALSE)    AS had_qa_inspection,
  COALESCE(qa.QAInspectionCount, 0)      AS qa_inspection_count,

  -- CSAT
  cs.IsSatisfied                   AS is_satisfied,
  cs.CSATResponseCount             AS csat_response_count,
  cs.CSATStatus                    AS csat_status,
  cs.AvgRating                     AS avg_rating,
  cs.CsatRequesterName             AS csat_requester_name,
  cs.CsatCreatedOn                 AS csat_created_on,
  cs.CsatComment                   AS csat_comment,

  -- Tracking
  'homes'                          AS __source_table,
  CURRENT_TIMESTAMP()              AS last_synced_at

FROM cohort c
JOIN `belong_main.Home`     h  ON h.HomeId     = c.HomeId
LEFT JOIN `belong_main.Resident` r ON r.ResidentId = c.ResidentId
LEFT JOIN balance_summary  bs  ON bs.HomeId    = c.HomeId
LEFT JOIN qa_summary       qa  ON qa.HomeId    = c.HomeId
LEFT JOIN csat_latest      cs  ON cs.HomeId    = c.HomeId

ORDER BY lease_start_on, home_id;
