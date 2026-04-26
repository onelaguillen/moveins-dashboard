-- ============================================================
-- Move-Ins Dashboard — Stream 2: repairs
-- One row per unfinished repair for cohort homes.
--
-- Schema source: dwh.* (Belong's data warehouse)
-- ============================================================

DECLARE cohort_anchor_date DATE DEFAULT DATE '2026-04-15';

WITH cohort AS (
  SELECT
    l.HomeId,
    DATE(l.LeaseStartOn) AS LeaseStartOn
  FROM `dwh.Lease` l
  WHERE l.Status <> 'Voided'
    AND COALESCE(l.OriginalLeasetype, l.LeaseType) IN ('New', 'Turnover')
    AND (DATE(l.ExecutedOn) >= cohort_anchor_date
         OR DATE(l.LeaseStartOn) >= cohort_anchor_date)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY l.HomeId ORDER BY l.ExecutedOn DESC) = 1
)

SELECT
  m.MaintenanceId                       AS maintenance_id,
  m.HomeId                              AS home_id,
  m.Summary                             AS repair_summary,
  SAFE_CAST(m.EstimatedCost AS NUMERIC) AS repair_estimated_cost,
  m.Assessment                          AS repair_assessment,
  m.RequestCategory                     AS repair_category,
  m.CreatedOn                           AS repair_created_on,
  'repairs'                             AS __source_table,
  CURRENT_TIMESTAMP()                   AS last_synced_at
FROM `dwh.Maintenance` m
INNER JOIN cohort c ON c.HomeId = m.HomeId
WHERE m.RequestCategory IN (
        'MoveOutRepairs', 'HomeOnboarding', 'PreMoveInRepairs', 'RepairsDuringListing', 'QA'
      )
  AND (m.RequestCategory = 'QA' OR m.Trade NOT IN ('FieldOperations', 'Inspection'))
  AND (m.ConsentStatus IN ('Approved', 'NotRequired') OR m.Assessment = 'Required')
  AND (m.ClosedOn IS NULL OR DATE(m.ClosedOn) > c.LeaseStartOn)
ORDER BY home_id, repair_created_on;
