-- ============================================================
-- Move-Ins Dashboard — Combined export (one CSV for all 3 streams)
-- ============================================================
-- Stacks homes / repairs / pro_services into a single result set
-- via UNION ALL. The `__source_table` column identifies which
-- stream each row belongs to. The dashboard upload page splits
-- rows by `__source_table` and routes them to the right table.
--
-- Schema source: dwh.* (Belong's data warehouse)
-- ============================================================

DECLARE cohort_anchor_date DATE DEFAULT DATE '2026-04-15';

WITH

-- ── Cohort: leases executed on/after anchor OR start date on/after anchor ──
--     Keep revisions (we'll flag them via is_revised). Drop voided leases.
cohort AS (
  SELECT
    l.LeaseId,
    l.HomeId,
    l.ResidentId,
    DATE(l.LeaseStartOn)                                                 AS LeaseStartOn,
    DATE(l.ExecutedOn)                                                   AS LeaseExecutedOn,
    -- Earliest non-voided ExecutedOn for the home; tells us the "real"
    -- move-in date even when this row is a revision.
    MIN(DATE(l.ExecutedOn)) OVER (PARTITION BY l.HomeId)                 AS OriginalExecutedOn,
    -- A revision is when OriginalLeasetype is set AND differs from current LeaseType.
    (l.OriginalLeasetype IS NOT NULL AND l.OriginalLeasetype <> l.LeaseType) AS IsRevised,
    l.DepositAmount,
    l.DepositType,
    l.RentAmount,
    l.PaidRent,
    l.ReceivedRent,
    l.ProcessingReceiveRent,
    l.EnrolledInAutoPay,
    l.MoveInPaymentStatus
  FROM `dwh.Lease` l
  WHERE l.Status <> 'Voided'
    AND COALESCE(l.OriginalLeasetype, l.LeaseType) IN ('New', 'Turnover')
    AND (DATE(l.ExecutedOn) >= cohort_anchor_date
         OR DATE(l.LeaseStartOn) >= cohort_anchor_date)
  -- Pick the most recent lease row per home (revision if exists, else original)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY l.HomeId ORDER BY l.ExecutedOn DESC) = 1
),

-- ── Payments rollup: through LeaseMoveInBalance → Balance + BalancePlan ──
payments_drill AS (
  SELECT
    c.HomeId,
    c.LeaseId,
    c.LeaseStartOn,
    b.Account,                                       -- 'DEPOSIT' / 'RENT'
    bp.BillStatus,
    COALESCE(bp.SourceAccountProcessedOn, bp.ProcessedOn) AS PaidOn,
    bp.PaymentMethod,
    b.BalanceId
  FROM cohort c
  INNER JOIN `dwh.LeaseMoveInBalance` lmib ON lmib.LeaseId = c.LeaseId
  INNER JOIN `dwh.Balance` b
    ON b.BalanceId = lmib.BalanceId
   AND b.Account IN ('DEPOSIT', 'RENT')
  LEFT JOIN `dwh.BalancePlan` bp ON bp.BalancePlanId = lmib.BalancePlanId
  WHERE DATE(bp.ProcessOn) <= c.LeaseStartOn
),

payments_summary AS (
  SELECT
    HomeId,
    LeaseId,
    MAX(IF(Account = 'DEPOSIT' AND (BillStatus <> 'Paid' OR DATE(PaidOn) > LeaseStartOn), 1, 0)) AS DepositUnpaid,
    MAX(IF(Account = 'RENT'    AND (BillStatus <> 'Paid' OR DATE(PaidOn) > LeaseStartOn), 1, 0)) AS RentUnpaid,
    COALESCE(MAX(IF(BillStatus <> 'Paid' OR DATE(PaidOn) > LeaseStartOn, 1, 0)), 0)              AS BalancesUnpaid,
    MAX(IF(Account = 'DEPOSIT', 1, 0)) AS HasDeposit,
    MAX(IF(Account = 'RENT',    1, 0)) AS HasRent,
    STRING_AGG(
      DISTINCT CASE
        WHEN BillStatus <> 'Paid' OR DATE(PaidOn) > LeaseStartOn THEN
          CONCAT(Account, ' - ',
            CASE
              WHEN BillStatus <> 'Paid' AND PaidOn IS NULL THEN 'Never Paid'
              WHEN BillStatus <> 'Paid' AND PaidOn IS NOT NULL THEN CONCAT('Partially Paid on ', CAST(DATE(PaidOn) AS STRING))
              WHEN DATE(PaidOn) > LeaseStartOn THEN CONCAT('Paid Late on ', CAST(DATE(PaidOn) AS STRING))
              ELSE 'Status Unknown'
            END,
            ' | ID: ', CAST(BalanceId AS STRING))
        ELSE NULL
      END,
      ' || '
    ) AS BalanceDetail
  FROM payments_drill
  GROUP BY HomeId, LeaseId
),

-- ── QA group rollup ──
--   The QA "group" is a parent Maintenance row with RequestCategory='QA'
--   AND Summary='Quality Assurance'. Children are Maintenance rows whose
--   GroupId = the parent's MaintenanceId. If no parent exists for a home,
--   the QA inspection wasn't done → NO QA alert.
qa_parent AS (
  -- A home counts as having QA done if there's a parent Maintenance row that is
  -- either the new automated QA ('Quality Assurance' under RequestCategory='QA')
  -- or the legacy manual QA ('Post Improvements QA').
  SELECT HomeId, MaintenanceId AS QAGroupId, CreatedOn
  FROM `dwh.Maintenance`
  WHERE HomeId IN (SELECT HomeId FROM cohort)
    AND (
      (RequestCategory = 'QA' AND Summary = 'Quality Assurance')
      OR Summary = 'Post Improvements QA'
    )
  QUALIFY ROW_NUMBER() OVER (PARTITION BY HomeId ORDER BY CreatedOn DESC) = 1
),
qa_summary AS (
  SELECT
    p.HomeId,
    p.QAGroupId,
    COUNT(c.MaintenanceId) AS QAChildCount
  FROM qa_parent p
  LEFT JOIN `dwh.Maintenance` c ON c.GroupId = p.QAGroupId
  GROUP BY p.HomeId, p.QAGroupId
),

-- ── CSAT rollup: via User.IntercomId → CsatNps.RequesterId ──
csat_summary AS (
  SELECT
    c.HomeId,
    MAX(csat.CsatSatisfied)                                      AS IsSatisfied,
    COUNT(DISTINCT csat.InternalId)                              AS CSATResponseCount,
    AVG(csat.Score)                                              AS AvgRating,
    MAX(csat.RequesterName)                                      AS CsatRequesterName,
    MAX(csat.CreatedOn)                                          AS CsatCreatedOn,
    MAX(csat.Comment)                                            AS CsatComment,
    CASE
      WHEN COUNT(DISTINCT csat.InternalId) = 0 THEN 'No CSAT Response'
      WHEN MAX(csat.CsatSatisfied) = 1 THEN 'Satisfied'
      ELSE 'Unsatisfied'
    END                                                          AS CSATStatus
  FROM cohort c
  LEFT JOIN `dwh.User` u ON u.UserId = c.ResidentId
  LEFT JOIN `dwh.CsatNps` csat
    ON csat.RequesterId = u.IntercomId
   AND csat.TeamName = 'Move In Specialist'
   AND csat.ReviewType <> 'NPS'
   AND DATE(csat.CreatedOn) BETWEEN DATE_SUB(c.LeaseStartOn, INTERVAL 60 DAY)
                                AND DATE_ADD(c.LeaseStartOn, INTERVAL 30 DAY)
  GROUP BY c.HomeId
),

-- ── Stream 1: homes (one row per home) ──
stream_homes AS (
  SELECT
    'homes'                                  AS __source_table,

    -- home identity & data
    h.HomeId                                 AS home_id,
    c.LeaseId                                AS lease_id,
    c.ResidentId                             AS resident_id,
    CURRENT_DATE()                           AS report_date,
    h.Address                                AS address,
    h.Region                                 AS region,
    u.Name                                   AS resident_name,
    u.IntercomId                             AS intercom_id,
    h.MoveInSpecialist                       AS move_in_specialist,
    h.MoveInSpecialistId                     AS move_in_specialist_id,
    h.Concierge                              AS concierge,
    h.ConciergeId                            AS concierge_id,
    h.ImprovementsSpecialist                 AS improvements_specialist,
    h.ImprovementsSpecialistId               AS improvements_specialist_id,
    SAFE_CAST(h.HasHoa         AS BOOL)      AS has_hoa,
    SAFE_CAST(h.HoaIsNotified  AS BOOL)      AS hoa_is_notified,
    c.LeaseStartOn                           AS lease_start_on,
    c.LeaseExecutedOn                        AS lease_executed_on,
    c.OriginalExecutedOn                     AS original_executed_on,
    c.IsRevised                              AS is_revised,
    h.CurrentMilestone                       AS current_milestone,
    CAST(h.CurrentMilestoneOn AS TIMESTAMP)  AS current_milestone_on,
    CAST(IF(DATE(h.LastMoveInReady)     >= c.LeaseStartOn, h.LastMoveInReady,     NULL) AS TIMESTAMP) AS move_in_ready,
    CAST(IF(DATE(h.LastMoveInCompleted) >= c.LeaseStartOn, h.LastMoveInCompleted, NULL) AS TIMESTAMP) AS move_in_completed,
    c.RentAmount                             AS rent_amount,
    c.DepositAmount                          AS deposit_amount,
    c.DepositType                            AS deposit_type,
    c.PaidRent                               AS paid_rent,
    c.ReceivedRent                           AS received_rent,
    c.ProcessingReceiveRent                  AS processing_receive_rent,
    SAFE_CAST(c.EnrolledInAutoPay AS BOOL)   AS enrolled_in_auto_pay,
    c.MoveInPaymentStatus                    AS move_in_payment_status,
    COALESCE(p.BalancesUnpaid, 0)            AS balances_unpaid,
    SAFE_CAST(p.DepositUnpaid AS BOOL)       AS deposit_unpaid,
    SAFE_CAST(p.RentUnpaid    AS BOOL)       AS rent_unpaid,
    SAFE_CAST(p.HasDeposit    AS BOOL)       AS has_deposit,
    SAFE_CAST(p.HasRent       AS BOOL)       AS has_rent,
    p.BalanceDetail                          AS balance_detail,
    qa.QAGroupId                             AS qa_group_id,
    qa.QAGroupId IS NOT NULL                 AS had_qa_inspection,
    COALESCE(qa.QAChildCount, 0)             AS qa_inspection_count,
    SAFE_CAST(cs.IsSatisfied AS BOOL)        AS is_satisfied,
    cs.CSATResponseCount                     AS csat_response_count,
    cs.CSATStatus                            AS csat_status,
    cs.AvgRating                             AS avg_rating,
    cs.CsatRequesterName                     AS csat_requester_name,
    CAST(cs.CsatCreatedOn AS TIMESTAMP)      AS csat_created_on,
    cs.CsatComment                           AS csat_comment,

    -- repair fields (NULL)
    CAST(NULL AS INT64)                      AS maintenance_id,
    CAST(NULL AS STRING)                     AS repair_summary,
    CAST(NULL AS NUMERIC)                    AS repair_estimated_cost,
    CAST(NULL AS STRING)                     AS repair_assessment,
    CAST(NULL AS STRING)                     AS repair_category,
    CAST(NULL AS TIMESTAMP)                  AS repair_created_on,

    -- pro_service fields (NULL)
    CAST(NULL AS INT64)                      AS pro_service_id,
    CAST(NULL AS STRING)                     AS service_name,
    CAST(NULL AS STRING)                     AS service_category,
    CAST(NULL AS STRING)                     AS service_status,
    CAST(NULL AS TIMESTAMP)                  AS service_created_on,
    CAST(NULL AS TIMESTAMP)                  AS service_completed_on,

    CURRENT_TIMESTAMP()                      AS last_synced_at
  FROM cohort c
  JOIN `dwh.Home` h     ON h.HomeId = c.HomeId
  LEFT JOIN `dwh.User` u ON u.UserId  = c.ResidentId
  LEFT JOIN payments_summary p ON p.HomeId = c.HomeId AND p.LeaseId = c.LeaseId
  LEFT JOIN qa_summary       qa ON qa.HomeId = c.HomeId
  LEFT JOIN csat_summary     cs ON cs.HomeId = c.HomeId
),

-- ── Stream 2: repairs — unfinished maintenance for cohort homes ──
--     Excludes inspections (those are tracked in qa_summary on stream 1).
stream_repairs AS (
  SELECT
    'repairs'                                AS __source_table,

    -- home fields (NULL — only home_id filled)
    m.HomeId                                 AS home_id,
    CAST(NULL AS INT64)                      AS lease_id,
    CAST(NULL AS INT64)                      AS resident_id,
    CAST(NULL AS DATE)                       AS report_date,
    CAST(NULL AS STRING)                     AS address,
    CAST(NULL AS STRING)                     AS region,
    CAST(NULL AS STRING)                     AS resident_name,
    CAST(NULL AS STRING)                     AS intercom_id,
    CAST(NULL AS STRING)                     AS move_in_specialist,
    CAST(NULL AS INT64)                      AS move_in_specialist_id,
    CAST(NULL AS STRING)                     AS concierge,
    CAST(NULL AS INT64)                      AS concierge_id,
    CAST(NULL AS STRING)                     AS improvements_specialist,
    CAST(NULL AS INT64)                      AS improvements_specialist_id,
    CAST(NULL AS BOOL)                       AS has_hoa,
    CAST(NULL AS BOOL)                       AS hoa_is_notified,
    CAST(NULL AS DATE)                       AS lease_start_on,
    CAST(NULL AS DATE)                       AS lease_executed_on,
    CAST(NULL AS DATE)                       AS original_executed_on,
    CAST(NULL AS BOOL)                       AS is_revised,
    CAST(NULL AS STRING)                     AS current_milestone,
    CAST(NULL AS TIMESTAMP)                  AS current_milestone_on,
    CAST(NULL AS TIMESTAMP)                  AS move_in_ready,
    CAST(NULL AS TIMESTAMP)                  AS move_in_completed,
    CAST(NULL AS NUMERIC)                    AS rent_amount,
    CAST(NULL AS NUMERIC)                    AS deposit_amount,
    CAST(NULL AS STRING)                     AS deposit_type,
    CAST(NULL AS NUMERIC)                    AS paid_rent,
    CAST(NULL AS NUMERIC)                    AS received_rent,
    CAST(NULL AS NUMERIC)                    AS processing_receive_rent,
    CAST(NULL AS BOOL)                       AS enrolled_in_auto_pay,
    CAST(NULL AS STRING)                     AS move_in_payment_status,
    CAST(NULL AS INT64)                      AS balances_unpaid,
    CAST(NULL AS BOOL)                       AS deposit_unpaid,
    CAST(NULL AS BOOL)                       AS rent_unpaid,
    CAST(NULL AS BOOL)                       AS has_deposit,
    CAST(NULL AS BOOL)                       AS has_rent,
    CAST(NULL AS STRING)                     AS balance_detail,
    CAST(NULL AS INT64)                      AS qa_group_id,
    CAST(NULL AS BOOL)                       AS had_qa_inspection,
    CAST(NULL AS INT64)                      AS qa_inspection_count,
    CAST(NULL AS BOOL)                       AS is_satisfied,
    CAST(NULL AS INT64)                      AS csat_response_count,
    CAST(NULL AS STRING)                     AS csat_status,
    CAST(NULL AS NUMERIC)                    AS avg_rating,
    CAST(NULL AS STRING)                     AS csat_requester_name,
    CAST(NULL AS TIMESTAMP)                  AS csat_created_on,
    CAST(NULL AS STRING)                     AS csat_comment,

    -- repair fields
    m.MaintenanceId                          AS maintenance_id,
    m.Summary                                AS repair_summary,
    SAFE_CAST(m.EstimatedCost AS NUMERIC)    AS repair_estimated_cost,
    m.Assessment                             AS repair_assessment,
    m.RequestCategory                        AS repair_category,
    CAST(m.CreatedOn AS TIMESTAMP)           AS repair_created_on,

    -- pro_service fields (NULL)
    CAST(NULL AS INT64)                      AS pro_service_id,
    CAST(NULL AS STRING)                     AS service_name,
    CAST(NULL AS STRING)                     AS service_category,
    CAST(NULL AS STRING)                     AS service_status,
    CAST(NULL AS TIMESTAMP)                  AS service_created_on,
    CAST(NULL AS TIMESTAMP)                  AS service_completed_on,

    CURRENT_TIMESTAMP()                      AS last_synced_at
  FROM `dwh.Maintenance` m
  INNER JOIN cohort c ON c.HomeId = m.HomeId
  WHERE m.RequestCategory IN (
          'MoveOutRepairs', 'HomeOnboarding', 'PreMoveInRepairs', 'RepairsDuringListing', 'QA'
        )
    AND (m.RequestCategory = 'QA' OR m.Trade NOT IN ('FieldOperations', 'Inspection'))
    AND (m.ConsentStatus IN ('Approved', 'NotRequired') OR m.Assessment = 'Required')
    AND m.ClosedOn IS NULL
),

-- ── Stream 3: pro_services — Maintenance rows created on/after lease start ──
--     Filters out inspections. JS layer applies the 7-day actionable window.
stream_pro_services AS (
  SELECT
    'pro_services'                           AS __source_table,

    -- home fields (NULL — only home_id filled)
    m.HomeId                                 AS home_id,
    CAST(NULL AS INT64)                      AS lease_id,
    CAST(NULL AS INT64)                      AS resident_id,
    CAST(NULL AS DATE)                       AS report_date,
    CAST(NULL AS STRING)                     AS address,
    CAST(NULL AS STRING)                     AS region,
    CAST(NULL AS STRING)                     AS resident_name,
    CAST(NULL AS STRING)                     AS intercom_id,
    CAST(NULL AS STRING)                     AS move_in_specialist,
    CAST(NULL AS INT64)                      AS move_in_specialist_id,
    CAST(NULL AS STRING)                     AS concierge,
    CAST(NULL AS INT64)                      AS concierge_id,
    CAST(NULL AS STRING)                     AS improvements_specialist,
    CAST(NULL AS INT64)                      AS improvements_specialist_id,
    CAST(NULL AS BOOL)                       AS has_hoa,
    CAST(NULL AS BOOL)                       AS hoa_is_notified,
    CAST(NULL AS DATE)                       AS lease_start_on,
    CAST(NULL AS DATE)                       AS lease_executed_on,
    CAST(NULL AS DATE)                       AS original_executed_on,
    CAST(NULL AS BOOL)                       AS is_revised,
    CAST(NULL AS STRING)                     AS current_milestone,
    CAST(NULL AS TIMESTAMP)                  AS current_milestone_on,
    CAST(NULL AS TIMESTAMP)                  AS move_in_ready,
    CAST(NULL AS TIMESTAMP)                  AS move_in_completed,
    CAST(NULL AS NUMERIC)                    AS rent_amount,
    CAST(NULL AS NUMERIC)                    AS deposit_amount,
    CAST(NULL AS STRING)                     AS deposit_type,
    CAST(NULL AS NUMERIC)                    AS paid_rent,
    CAST(NULL AS NUMERIC)                    AS received_rent,
    CAST(NULL AS NUMERIC)                    AS processing_receive_rent,
    CAST(NULL AS BOOL)                       AS enrolled_in_auto_pay,
    CAST(NULL AS STRING)                     AS move_in_payment_status,
    CAST(NULL AS INT64)                      AS balances_unpaid,
    CAST(NULL AS BOOL)                       AS deposit_unpaid,
    CAST(NULL AS BOOL)                       AS rent_unpaid,
    CAST(NULL AS BOOL)                       AS has_deposit,
    CAST(NULL AS BOOL)                       AS has_rent,
    CAST(NULL AS STRING)                     AS balance_detail,
    CAST(NULL AS INT64)                      AS qa_group_id,
    CAST(NULL AS BOOL)                       AS had_qa_inspection,
    CAST(NULL AS INT64)                      AS qa_inspection_count,
    CAST(NULL AS BOOL)                       AS is_satisfied,
    CAST(NULL AS INT64)                      AS csat_response_count,
    CAST(NULL AS STRING)                     AS csat_status,
    CAST(NULL AS NUMERIC)                    AS avg_rating,
    CAST(NULL AS STRING)                     AS csat_requester_name,
    CAST(NULL AS TIMESTAMP)                  AS csat_created_on,
    CAST(NULL AS STRING)                     AS csat_comment,

    -- repair fields (NULL)
    CAST(NULL AS INT64)                      AS maintenance_id,
    CAST(NULL AS STRING)                     AS repair_summary,
    CAST(NULL AS NUMERIC)                    AS repair_estimated_cost,
    CAST(NULL AS STRING)                     AS repair_assessment,
    CAST(NULL AS STRING)                     AS repair_category,
    CAST(NULL AS TIMESTAMP)                  AS repair_created_on,

    -- pro_service fields (Maintenance rows acting as pro services)
    m.MaintenanceId                          AS pro_service_id,
    m.Summary                                AS service_name,
    m.ProServiceResponsibility               AS service_category,
    m.ConsentStatus                          AS service_status,
    CAST(m.CreatedOn AS TIMESTAMP)           AS service_created_on,
    CAST(m.ClosedOn  AS TIMESTAMP)           AS service_completed_on,

    CURRENT_TIMESTAMP()                      AS last_synced_at
  FROM `dwh.Maintenance` m
  INNER JOIN cohort c ON c.HomeId = m.HomeId
  WHERE m.Assessment = 'Required'
    AND UPPER(m.Summary) NOT LIKE '%INSPECTION%'
    AND DATE(m.CreatedOn) >= c.LeaseStartOn
)

SELECT * FROM stream_homes
UNION ALL
SELECT * FROM stream_repairs
UNION ALL
SELECT * FROM stream_pro_services
ORDER BY __source_table, home_id;
