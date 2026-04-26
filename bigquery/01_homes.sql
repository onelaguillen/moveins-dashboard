-- ============================================================
-- Move-Ins Dashboard — Stream 1: homes
-- One row per home. Pure home/lease/payment/balance/QA/CSAT data.
-- NO repair info, NO pro-service info.
--
-- Schema source: dwh.* (Belong's data warehouse)
-- ============================================================

DECLARE cohort_anchor_date DATE DEFAULT DATE '2026-04-15';

WITH

cohort AS (
  SELECT
    l.LeaseId,
    l.HomeId,
    l.ResidentId,
    DATE(l.LeaseStartOn)                                                 AS LeaseStartOn,
    DATE(l.ExecutedOn)                                                   AS LeaseExecutedOn,
    MIN(DATE(l.ExecutedOn)) OVER (PARTITION BY l.HomeId)                 AS OriginalExecutedOn,
    (l.OriginalLeasetype IS NOT NULL AND l.OriginalLeasetype <> l.LeaseType) AS IsRevised,
    l.DepositAmount, l.DepositType, l.RentAmount,
    l.PaidRent, l.ReceivedRent, l.ProcessingReceiveRent,
    l.EnrolledInAutoPay, l.MoveInPaymentStatus
  FROM `dwh.Lease` l
  WHERE l.Status <> 'Voided'
    AND COALESCE(l.OriginalLeasetype, l.LeaseType) IN ('New', 'Turnover')
    AND (DATE(l.ExecutedOn) >= cohort_anchor_date
         OR DATE(l.LeaseStartOn) >= cohort_anchor_date)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY l.HomeId ORDER BY l.ExecutedOn DESC) = 1
),

payments_drill AS (
  SELECT
    c.HomeId, c.LeaseId, c.LeaseStartOn,
    b.Account, bp.BillStatus,
    COALESCE(bp.SourceAccountProcessedOn, bp.ProcessedOn) AS PaidOn,
    b.BalanceId
  FROM cohort c
  INNER JOIN `dwh.LeaseMoveInBalance` lmib ON lmib.LeaseId = c.LeaseId
  INNER JOIN `dwh.Balance` b ON b.BalanceId = lmib.BalanceId AND b.Account IN ('DEPOSIT','RENT')
  LEFT JOIN `dwh.BalancePlan` bp ON bp.BalancePlanId = lmib.BalancePlanId
  WHERE DATE(bp.ProcessOn) <= c.LeaseStartOn
),

payments_summary AS (
  SELECT
    HomeId, LeaseId,
    MAX(IF(Account='DEPOSIT' AND (BillStatus<>'Paid' OR DATE(PaidOn)>LeaseStartOn),1,0)) AS DepositUnpaid,
    MAX(IF(Account='RENT'    AND (BillStatus<>'Paid' OR DATE(PaidOn)>LeaseStartOn),1,0)) AS RentUnpaid,
    COALESCE(MAX(IF(BillStatus<>'Paid' OR DATE(PaidOn)>LeaseStartOn,1,0)),0)             AS BalancesUnpaid,
    MAX(IF(Account='DEPOSIT',1,0)) AS HasDeposit,
    MAX(IF(Account='RENT',1,0))    AS HasRent,
    STRING_AGG(DISTINCT
      IF(BillStatus<>'Paid' OR DATE(PaidOn)>LeaseStartOn,
         CONCAT(Account,' - ',BillStatus,' | ID:',CAST(BalanceId AS STRING)), NULL),
      ' || '
    ) AS BalanceDetail
  FROM payments_drill
  GROUP BY HomeId, LeaseId
),

qa_parent AS (
  SELECT HomeId, MaintenanceId AS QAGroupId, CreatedOn
  FROM `dwh.Maintenance`
  WHERE RequestCategory = 'QA'
    AND Summary = 'Quality Assurance'
    AND HomeId IN (SELECT HomeId FROM cohort)
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

csat_summary AS (
  SELECT
    c.HomeId,
    MAX(csat.CsatSatisfied)                    AS IsSatisfied,
    COUNT(DISTINCT csat.InternalId)            AS CSATResponseCount,
    AVG(csat.Score)                            AS AvgRating,
    MAX(csat.RequesterName)                    AS CsatRequesterName,
    MAX(csat.CreatedOn)                        AS CsatCreatedOn,
    MAX(csat.Comment)                          AS CsatComment,
    CASE
      WHEN COUNT(DISTINCT csat.InternalId) = 0 THEN 'No CSAT Response'
      WHEN MAX(csat.CsatSatisfied) = 1 THEN 'Satisfied'
      ELSE 'Unsatisfied'
    END AS CSATStatus
  FROM cohort c
  LEFT JOIN `dwh.User` u ON u.UserId = c.ResidentId
  LEFT JOIN `dwh.CsatNps` csat
    ON csat.RequesterId = u.IntercomId
   AND csat.TeamName = 'Move In Specialist'
   AND csat.ReviewType <> 'NPS'
   AND DATE(csat.CreatedOn) BETWEEN DATE_SUB(c.LeaseStartOn, INTERVAL 60 DAY)
                                AND DATE_ADD(c.LeaseStartOn, INTERVAL 30 DAY)
  GROUP BY c.HomeId
)

SELECT
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
  SAFE_CAST(h.HasHoa AS BOOL)              AS has_hoa,
  SAFE_CAST(h.HoaIsNotified AS BOOL)       AS hoa_is_notified,
  c.LeaseStartOn                           AS lease_start_on,
  c.LeaseExecutedOn                        AS lease_executed_on,
  c.OriginalExecutedOn                     AS original_executed_on,
  c.IsRevised                              AS is_revised,
  h.CurrentMilestone                       AS current_milestone,
  h.CurrentMilestoneOn                     AS current_milestone_on,
  IF(DATE(h.LastMoveInReady)     >= c.LeaseStartOn, h.LastMoveInReady,     NULL) AS move_in_ready,
  IF(DATE(h.LastMoveInCompleted) >= c.LeaseStartOn, h.LastMoveInCompleted, NULL) AS move_in_completed,
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
  cs.CsatCreatedOn                         AS csat_created_on,
  cs.CsatComment                           AS csat_comment,
  'homes'                                  AS __source_table,
  CURRENT_TIMESTAMP()                      AS last_synced_at
FROM cohort c
JOIN `dwh.Home` h     ON h.HomeId = c.HomeId
LEFT JOIN `dwh.User` u ON u.UserId  = c.ResidentId
LEFT JOIN payments_summary p ON p.HomeId = c.HomeId AND p.LeaseId = c.LeaseId
LEFT JOIN qa_summary       qa ON qa.HomeId = c.HomeId
LEFT JOIN csat_summary     cs ON cs.HomeId = c.HomeId
ORDER BY lease_start_on, home_id;
