-- ============================================================
-- Move-Ins Dashboard — Stream 3: pro_services
-- One row per (home × pro service). Returns ALL pro services
-- for cohort homes. The 7-day actionable rule is applied in
-- assets/derive.js, NOT here.
--
-- Output columns must match docs/data-contract.md exactly.
-- ============================================================

DECLARE cohort_anchor_date DATE DEFAULT DATE '2026-04-15';

WITH

cohort AS (
  SELECT DISTINCT l.HomeId
  FROM `belong_main.Lease` l
  WHERE l.ExecutedOn   >= cohort_anchor_date
     OR l.LeaseStartOn >= cohort_anchor_date
)

SELECT
  ps.Id                 AS pro_service_id,         -- TODO: confirm PK column name
  ps.HomeId             AS home_id,
  ps.Name               AS service_name,           -- TODO: confirm column name
  ps.Category           AS service_category,
  ps.Status             AS service_status,
  ps.CreatedOn          AS service_created_on,
  ps.CompletedOn        AS service_completed_on,
  'pro_services'        AS __source_table,
  CURRENT_TIMESTAMP()   AS last_synced_at
FROM `belong_main.ProService` ps                   -- TODO: confirm pro service table name
WHERE ps.HomeId IN (SELECT HomeId FROM cohort)
ORDER BY home_id, service_created_on;
