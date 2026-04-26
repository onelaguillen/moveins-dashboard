-- ============================================================
-- Move-Ins Dashboard — Stream 2: repairs
-- One row per repair. Filtered to cohort homes only.
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
  m.MaintenanceId        AS maintenance_id,
  m.HomeId               AS home_id,
  m.Summary              AS repair_summary,
  m.EstimatedCost        AS repair_estimated_cost,
  m.Assessment           AS repair_assessment,        -- 'Required' / 'Recommended' / NULL
  m.RequestCategory      AS repair_category,          -- 'QA' / 'Moveout' / 'Improvements' / etc.
  m.CreatedOn            AS repair_created_on,
  'repairs'              AS __source_table,
  CURRENT_TIMESTAMP()    AS last_synced_at
FROM `belong_main.Maintenance` m
WHERE m.HomeId IN (SELECT HomeId FROM cohort)
  AND m.Status IN ('open', 'in_progress')             -- TODO: confirm status values for "unfinished"
ORDER BY home_id, repair_created_on;
