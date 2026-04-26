-- ============================================================
-- Move-Ins Dashboard — Stream 3: pro_services
-- Belong's data warehouse doesn't have a separate ProService table —
-- pro services ARE Maintenance rows that:
--   • are Required (Assessment = 'Required')
--   • are not inspections
--   • were created on/after lease start
-- The 7-day actionable rule is applied in assets/derive.js, not here.
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
  m.MaintenanceId              AS pro_service_id,
  m.HomeId                     AS home_id,
  m.Summary                    AS service_name,
  m.ProServiceResponsibility   AS service_category,
  m.ConsentStatus              AS service_status,
  m.CreatedOn                  AS service_created_on,
  m.ClosedOn                   AS service_completed_on,
  'pro_services'               AS __source_table,
  CURRENT_TIMESTAMP()          AS last_synced_at
FROM `dwh.Maintenance` m
INNER JOIN cohort c ON c.HomeId = m.HomeId
WHERE m.Assessment = 'Required'
  AND UPPER(m.Summary) NOT LIKE '%INSPECTION%'
  AND DATE(m.CreatedOn) >= c.LeaseStartOn
ORDER BY home_id, service_created_on;
