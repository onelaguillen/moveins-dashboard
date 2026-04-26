-- ============================================================
-- Move-Ins Dashboard — Combined export (one CSV for all 3 streams)
-- ============================================================
-- Stacks homes / repairs / pro_services into a single result set
-- via UNION ALL. The `__source_table` column identifies which
-- stream each row belongs to. The dashboard upload page splits
-- rows by `__source_table` and routes them to the right table.
--
-- Columns not relevant to a given stream are NULL.
-- ============================================================

DECLARE cohort_anchor_date DATE DEFAULT DATE '2026-04-15';

WITH

-- ── Cohort: leases executed on/after anchor OR start date on/after anchor ──
cohort AS (
  SELECT
    l.LeaseId,
    l.HomeId,
    l.ResidentId,
    l.LeaseStartOn,
    l.ExecutedOn         AS LeaseExecutedOn,
    l.IsRevised,
    MIN(l.ExecutedOn) OVER (PARTITION BY l.HomeId) AS OriginalExecutedOn
  FROM `belong_main.Lease` l
  WHERE l.ExecutedOn   >= cohort_anchor_date
     OR l.LeaseStartOn >= cohort_anchor_date
),

-- ── Per-home rollups (used by Stream 1 only) ──
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

qa_summary AS (
  SELECT
    m.HomeId,
    COUNTIF(m.RequestCategory = 'QA')        AS QAInspectionCount,
    COUNTIF(m.RequestCategory = 'QA') > 0    AS HadQAInspection
  FROM `belong_main.Maintenance` m
  WHERE m.HomeId IN (SELECT HomeId FROM cohort)
  GROUP BY m.HomeId
),

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
),

-- ── Stream 1: homes (one row per home) ──
stream_homes AS (
  SELECT
    'homes'                                  AS __source_table,

    -- home identity & data (filled)
    h.HomeId                                 AS home_id,
    c.LeaseId                                AS lease_id,
    c.ResidentId                             AS resident_id,
    CURRENT_DATE()                           AS report_date,
    h.Address                                AS address,
    h.Region                                 AS region,
    r.Name                                   AS resident_name,
    CAST(NULL AS STRING)                     AS intercom_id,
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
    SAFE_CAST(c.IsRevised AS BOOL)           AS is_revised,
    h.CurrentMilestone                       AS current_milestone,
    h.CurrentMilestoneOn                     AS current_milestone_on,
    h.MoveInReady                            AS move_in_ready,
    h.MoveInCompleted                        AS move_in_completed,
    c.RentAmount                             AS rent_amount,
    c.DepositAmount                          AS deposit_amount,
    c.DepositType                            AS deposit_type,
    c.PaidRent                               AS paid_rent,
    c.ReceivedRent                           AS received_rent,
    c.ProcessingReceiveRent                  AS processing_receive_rent,
    SAFE_CAST(c.EnrolledInAutoPay AS BOOL)   AS enrolled_in_auto_pay,
    c.MoveInPaymentStatus                    AS move_in_payment_status,
    COALESCE(bs.BalancesUnpaid, 0)           AS balances_unpaid,
    SAFE_CAST(bs.DepositUnpaid AS BOOL)      AS deposit_unpaid,
    SAFE_CAST(bs.RentUnpaid    AS BOOL)      AS rent_unpaid,
    SAFE_CAST(bs.HasDeposit    AS BOOL)      AS has_deposit,
    SAFE_CAST(bs.HasRent       AS BOOL)      AS has_rent,
    bs.BalanceDetail                         AS balance_detail,
    COALESCE(qa.HadQAInspection, FALSE)      AS had_qa_inspection,
    COALESCE(qa.QAInspectionCount, 0)        AS qa_inspection_count,
    cs.IsSatisfied                           AS is_satisfied,
    cs.CSATResponseCount                     AS csat_response_count,
    cs.CSATStatus                            AS csat_status,
    cs.AvgRating                             AS avg_rating,
    cs.CsatRequesterName                     AS csat_requester_name,
    cs.CsatCreatedOn                         AS csat_created_on,
    cs.CsatComment                           AS csat_comment,

    -- repair fields (NULL — this is a homes row)
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
  JOIN `belong_main.Home`     h  ON h.HomeId     = c.HomeId
  LEFT JOIN `belong_main.Resident` r ON r.ResidentId = c.ResidentId
  LEFT JOIN balance_summary  bs  ON bs.HomeId    = c.HomeId
  LEFT JOIN qa_summary       qa  ON qa.HomeId    = c.HomeId
  LEFT JOIN csat_latest      cs  ON cs.HomeId    = c.HomeId
),

-- ── Stream 2: repairs (one row per repair) ──
stream_repairs AS (
  SELECT
    'repairs'                                AS __source_table,

    -- home fields (NULL — this is a repair row; only home_id is filled for joining)
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
    CAST(NULL AS BOOL)                       AS had_qa_inspection,
    CAST(NULL AS INT64)                      AS qa_inspection_count,
    CAST(NULL AS BOOL)                       AS is_satisfied,
    CAST(NULL AS INT64)                      AS csat_response_count,
    CAST(NULL AS STRING)                     AS csat_status,
    CAST(NULL AS NUMERIC)                    AS avg_rating,
    CAST(NULL AS STRING)                     AS csat_requester_name,
    CAST(NULL AS TIMESTAMP)                  AS csat_created_on,
    CAST(NULL AS STRING)                     AS csat_comment,

    -- repair fields (filled)
    m.MaintenanceId                          AS maintenance_id,
    m.Summary                                AS repair_summary,
    m.EstimatedCost                          AS repair_estimated_cost,
    m.Assessment                             AS repair_assessment,
    m.RequestCategory                        AS repair_category,
    m.CreatedOn                              AS repair_created_on,

    -- pro_service fields (NULL)
    CAST(NULL AS INT64)                      AS pro_service_id,
    CAST(NULL AS STRING)                     AS service_name,
    CAST(NULL AS STRING)                     AS service_category,
    CAST(NULL AS STRING)                     AS service_status,
    CAST(NULL AS TIMESTAMP)                  AS service_created_on,
    CAST(NULL AS TIMESTAMP)                  AS service_completed_on,

    CURRENT_TIMESTAMP()                      AS last_synced_at
  FROM `belong_main.Maintenance` m
  WHERE m.HomeId IN (SELECT HomeId FROM cohort)
    AND m.Status IN ('open', 'in_progress')   -- TODO: confirm status values
),

-- ── Stream 3: pro_services ──
stream_pro_services AS (
  SELECT
    'pro_services'                           AS __source_table,

    -- home fields (NULL — only home_id filled for joining)
    ps.HomeId                                AS home_id,
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

    -- pro_service fields (filled)
    ps.Id                                    AS pro_service_id,         -- TODO: confirm PK
    ps.Name                                  AS service_name,           -- TODO: confirm column
    ps.Category                              AS service_category,
    ps.Status                                AS service_status,
    ps.CreatedOn                             AS service_created_on,
    ps.CompletedOn                           AS service_completed_on,

    CURRENT_TIMESTAMP()                      AS last_synced_at
  FROM `belong_main.ProService` ps           -- TODO: confirm pro service table name
  WHERE ps.HomeId IN (SELECT HomeId FROM cohort)
)

SELECT * FROM stream_homes
UNION ALL
SELECT * FROM stream_repairs
UNION ALL
SELECT * FROM stream_pro_services
ORDER BY __source_table, home_id;
