-- ============================================================
-- Belong Move-In Dashboard — Migration v4 (analytics snapshots)
-- ============================================================
-- Creates the `homes_snapshots` table + a nightly pg_cron job
-- that stamps a daily copy of `homes` for trend analytics.
--
-- BEFORE running:
--   1. Enable the pg_cron extension in Supabase:
--      Dashboard → Database → Extensions → search "pg_cron" → toggle ON
--   2. Run this whole file in the SQL editor.
-- ============================================================


-- ============================================================
-- STEP 1: Snapshot table — same shape as `homes` + snapshot_date
-- ============================================================
CREATE TABLE IF NOT EXISTS homes_snapshots (
  snapshot_date                DATE        NOT NULL,
  home_id                      INTEGER     NOT NULL,
  lease_id                     INTEGER,
  resident_id                  INTEGER,
  report_date                  DATE,

  address                      TEXT,
  region                       TEXT,

  resident_name                TEXT,
  intercom_id                  TEXT,

  move_in_specialist           TEXT,
  move_in_specialist_id        INTEGER,
  concierge                    TEXT,
  concierge_id                 INTEGER,
  improvements_specialist      TEXT,
  improvements_specialist_id   INTEGER,

  has_hoa                      BOOLEAN,
  hoa_is_notified              BOOLEAN,

  lease_start_on               DATE,
  lease_executed_on            DATE,
  original_executed_on         DATE,
  is_revised                   BOOLEAN,

  current_milestone            TEXT,
  current_milestone_on         TIMESTAMPTZ,
  move_in_ready                TIMESTAMPTZ,
  move_in_completed            TIMESTAMPTZ,

  rent_amount                  NUMERIC,
  deposit_amount               NUMERIC,
  deposit_type                 TEXT,
  paid_rent                    NUMERIC,
  received_rent                NUMERIC,
  processing_receive_rent      NUMERIC,
  enrolled_in_auto_pay         BOOLEAN,
  move_in_payment_status       TEXT,

  balances_unpaid              INTEGER,
  deposit_unpaid               BOOLEAN,
  rent_unpaid                  BOOLEAN,
  has_deposit                  BOOLEAN,
  has_rent                     BOOLEAN,
  balance_detail               TEXT,

  qa_group_id                  INTEGER,
  had_qa_inspection            BOOLEAN,
  qa_inspection_count          INTEGER,

  is_satisfied                 BOOLEAN,
  csat_response_count          INTEGER,
  csat_status                  TEXT,
  avg_rating                   NUMERIC,
  csat_requester_name          TEXT,
  csat_created_on              TIMESTAMPTZ,
  csat_comment                 TEXT,

  -- Derived effective status at time of snapshot (so we don't have to
  -- re-derive when graphing trends — what mattered was what showed at the time).
  derived_effective_status     TEXT,
  was_handed_off               BOOLEAN,
  was_delayed                  BOOLEAN,

  PRIMARY KEY (snapshot_date, home_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_date     ON homes_snapshots (snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_home_id  ON homes_snapshots (home_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_region   ON homes_snapshots (region);


-- ============================================================
-- STEP 2: Stored procedure that performs one snapshot
-- ============================================================
-- Captures the current state of `homes` joined with
-- `home_repair_context` so we can record handoff/delay/manual_status
-- at the time the snapshot was taken.
CREATE OR REPLACE FUNCTION take_homes_snapshot()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted_count INTEGER;
  today DATE := CURRENT_DATE;
BEGIN
  -- Idempotent for a given day: if today's snapshot already exists, replace it.
  DELETE FROM homes_snapshots WHERE snapshot_date = today;

  INSERT INTO homes_snapshots (
    snapshot_date, home_id, lease_id, resident_id, report_date,
    address, region, resident_name, intercom_id,
    move_in_specialist, move_in_specialist_id,
    concierge, concierge_id,
    improvements_specialist, improvements_specialist_id,
    has_hoa, hoa_is_notified,
    lease_start_on, lease_executed_on, original_executed_on, is_revised,
    current_milestone, current_milestone_on, move_in_ready, move_in_completed,
    rent_amount, deposit_amount, deposit_type,
    paid_rent, received_rent, processing_receive_rent,
    enrolled_in_auto_pay, move_in_payment_status,
    balances_unpaid, deposit_unpaid, rent_unpaid, has_deposit, has_rent, balance_detail,
    qa_group_id, had_qa_inspection, qa_inspection_count,
    is_satisfied, csat_response_count, csat_status, avg_rating,
    csat_requester_name, csat_created_on, csat_comment,
    derived_effective_status, was_handed_off, was_delayed
  )
  SELECT
    today, h.home_id, h.lease_id, h.resident_id, h.report_date,
    h.address, h.region, h.resident_name, h.intercom_id,
    h.move_in_specialist, h.move_in_specialist_id,
    h.concierge, h.concierge_id,
    h.improvements_specialist, h.improvements_specialist_id,
    h.has_hoa, h.hoa_is_notified,
    h.lease_start_on, h.lease_executed_on, h.original_executed_on, h.is_revised,
    h.current_milestone, h.current_milestone_on, h.move_in_ready, h.move_in_completed,
    h.rent_amount, h.deposit_amount, h.deposit_type,
    h.paid_rent, h.received_rent, h.processing_receive_rent,
    h.enrolled_in_auto_pay, h.move_in_payment_status,
    h.balances_unpaid, h.deposit_unpaid, h.rent_unpaid, h.has_deposit, h.has_rent, h.balance_detail,
    NULL::INTEGER, h.had_qa_inspection, h.qa_inspection_count,
    h.is_satisfied, h.csat_response_count, h.csat_status, h.avg_rating,
    h.csat_requester_name, h.csat_created_on, h.csat_comment,
    -- Effective status at snapshot time: prefer manual_status, else compute later in app.
    COALESCE(c.manual_status,
             CASE WHEN c.handed_off_to_concierge THEN 'handed_off' END),
    COALESCE(c.handed_off_to_concierge, FALSE),
    COALESCE(c.is_delayed, FALSE)
  FROM homes h
  LEFT JOIN home_repair_context c ON c.home_id = h.home_id;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;


-- ============================================================
-- STEP 3: pg_cron job — nightly at 06:00 UTC
-- ============================================================
-- Requires pg_cron extension to be enabled (Dashboard → Database → Extensions).
-- Schedule format: '<minute> <hour> <day> <month> <day-of-week>'
-- 06:00 UTC = ~01:00 ET / ~22:00 PT (previous day) — quiet time for the team.
SELECT cron.schedule(
  'nightly_homes_snapshot',
  '0 6 * * *',
  $$ SELECT take_homes_snapshot(); $$
);


-- ============================================================
-- STEP 4: Row Level Security
-- ============================================================
ALTER TABLE homes_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Belong users can read homes_snapshots" ON homes_snapshots;
CREATE POLICY "Belong users can read homes_snapshots"
  ON homes_snapshots FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() ->> 'email' LIKE '%@belonghome.com'
      OR auth.jwt() ->> 'email' LIKE '%@belong.pe')
  );

DROP POLICY IF EXISTS "Admin can write homes_snapshots" ON homes_snapshots;
CREATE POLICY "Admin can write homes_snapshots"
  ON homes_snapshots FOR ALL
  USING      (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com');


-- ============================================================
-- STEP 5: Verification queries (optional)
-- ============================================================
-- View the cron job:
-- SELECT * FROM cron.job WHERE jobname = 'nightly_homes_snapshot';

-- Run a snapshot now (instead of waiting for nightly):
-- SELECT take_homes_snapshot();

-- See snapshots so far:
-- SELECT snapshot_date, COUNT(*) AS row_count
-- FROM homes_snapshots
-- GROUP BY snapshot_date
-- ORDER BY snapshot_date DESC;

-- Unschedule the cron job (to disable):
-- SELECT cron.unschedule('nightly_homes_snapshot');
