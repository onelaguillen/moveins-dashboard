-- ============================================================
-- Belong Move-In Dashboard — Migration v3 (normalized split)
-- ============================================================
-- Replaces the wide v1/v2 `homes` table with three normalized
-- cache tables: `homes`, `repairs`, `pro_services`.
--
-- Plus annotation tables: `repair_status`, `sync_log`, and new
-- columns on `home_repair_context` for handoff + delay tracking.
--
-- BEFORE running:
--  1. BACK UP `homes` and `home_repair_context` (export to CSV)
--  2. Run during off-hours — dashboard goes empty until refresh
--
-- See MIGRATION_V3_STEPS.md for the full walkthrough.
-- ============================================================


-- ============================================================
-- STEP 1: Drop old wide `homes` table
-- ============================================================
DROP TABLE IF EXISTS homes CASCADE;


-- ============================================================
-- STEP 2: Create new normalized `homes` table (one row per home)
-- ============================================================
CREATE TABLE IF NOT EXISTS homes (
  -- Identity
  home_id                      INTEGER PRIMARY KEY,
  lease_id                     INTEGER,
  resident_id                  INTEGER,
  report_date                  DATE,

  -- Address
  address                      TEXT,
  region                       TEXT,

  -- Resident
  resident_name                TEXT,
  intercom_id                  TEXT,

  -- Specialists
  move_in_specialist           TEXT,
  move_in_specialist_id        INTEGER,
  concierge                    TEXT,
  concierge_id                 INTEGER,
  improvements_specialist      TEXT,
  improvements_specialist_id   INTEGER,

  -- HOA
  has_hoa                      BOOLEAN,
  hoa_is_notified              BOOLEAN,

  -- Lease
  lease_start_on               DATE,
  lease_executed_on            DATE,
  original_executed_on         DATE,
  is_revised                   BOOLEAN,

  -- Milestones
  current_milestone            TEXT,
  current_milestone_on         TIMESTAMPTZ,
  move_in_ready                TIMESTAMPTZ,
  move_in_completed            TIMESTAMPTZ,

  -- Payments
  rent_amount                  NUMERIC,
  deposit_amount               NUMERIC,
  deposit_type                 TEXT,
  paid_rent                    NUMERIC,
  received_rent                NUMERIC,
  processing_receive_rent      NUMERIC,
  enrolled_in_auto_pay         BOOLEAN,
  move_in_payment_status       TEXT,

  -- Balance
  balances_unpaid              INTEGER,
  deposit_unpaid               BOOLEAN,
  rent_unpaid                  BOOLEAN,
  has_deposit                  BOOLEAN,
  has_rent                     BOOLEAN,
  balance_detail               TEXT,

  -- QA
  had_qa_inspection            BOOLEAN,
  qa_inspection_count          INTEGER,

  -- CSAT
  is_satisfied                 BOOLEAN,
  csat_response_count          INTEGER,
  csat_status                  TEXT,
  avg_rating                   NUMERIC,
  csat_requester_name          TEXT,
  csat_created_on              TIMESTAMPTZ,
  csat_comment                 TEXT,

  -- Tracking
  __source_table               TEXT DEFAULT 'homes',
  last_synced_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_homes_lease_start_on ON homes (lease_start_on);
CREATE INDEX idx_homes_region         ON homes (region);


-- ============================================================
-- STEP 3: Create `repairs` table (one row per repair)
-- ============================================================
CREATE TABLE IF NOT EXISTS repairs (
  maintenance_id        INTEGER PRIMARY KEY,
  home_id               INTEGER NOT NULL,
  repair_summary        TEXT,
  repair_estimated_cost NUMERIC,
  repair_assessment     TEXT,                  -- 'Required' / 'Recommended' / NULL
  repair_category       TEXT,                  -- 'QA' / 'Moveout' / etc.
  repair_created_on     TIMESTAMPTZ,

  __source_table        TEXT DEFAULT 'repairs',
  last_synced_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_repairs_home_id           ON repairs (home_id);
CREATE INDEX idx_repairs_repair_category   ON repairs (repair_category);
CREATE INDEX idx_repairs_repair_assessment ON repairs (repair_assessment);


-- ============================================================
-- STEP 4: Create `pro_services` table
-- ============================================================
CREATE TABLE IF NOT EXISTS pro_services (
  pro_service_id        INTEGER PRIMARY KEY,
  home_id               INTEGER NOT NULL,
  service_name          TEXT,
  service_category      TEXT,
  service_status        TEXT,
  service_created_on    TIMESTAMPTZ,
  service_completed_on  TIMESTAMPTZ,

  __source_table        TEXT DEFAULT 'pro_services',
  last_synced_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pro_services_home_id            ON pro_services (home_id);
CREATE INDEX idx_pro_services_service_created_on ON pro_services (service_created_on);


-- ============================================================
-- STEP 5: Create `repair_status` annotation table
-- ============================================================
CREATE TABLE IF NOT EXISTS repair_status (
  maintenance_id    INTEGER PRIMARY KEY,
  status            TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'in_progress', 'done')),
  notes             TEXT,
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_by        TEXT
);


-- ============================================================
-- STEP 6: Update `home_repair_context` — add handoff + delay
--         columns, drop obsolete `lease_url`
-- ============================================================
ALTER TABLE home_repair_context
  ADD COLUMN IF NOT EXISTS handed_off_to_concierge  BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS handed_off_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS handed_off_by            TEXT,
  ADD COLUMN IF NOT EXISTS is_delayed               BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS delay_reasons            TEXT[],
  ADD COLUMN IF NOT EXISTS delay_other_text         TEXT,
  ADD COLUMN IF NOT EXISTS delay_logged_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delay_logged_by          TEXT;

ALTER TABLE home_repair_context
  DROP COLUMN IF EXISTS lease_url;

CREATE INDEX IF NOT EXISTS idx_home_repair_context_handoff
  ON home_repair_context (handed_off_to_concierge);


-- ============================================================
-- STEP 7: `sync_log` — refresh history
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_log (
  id                          BIGSERIAL PRIMARY KEY,
  started_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at                 TIMESTAMPTZ,
  row_count_homes             INTEGER,
  row_count_repairs           INTEGER,
  row_count_pro_services      INTEGER,
  status                      TEXT CHECK (status IN ('running', 'success', 'error')),
  error_message               TEXT,
  triggered_by                TEXT
);

CREATE INDEX idx_sync_log_started_at ON sync_log (started_at DESC);


-- ============================================================
-- STEP 8: Row Level Security
--   Reads:  authenticated @belonghome.com or @belong.pe
--   Writes: admin (guillen.onela@belonghome.com)
--           Plus team-write on repair_status (Tami + Onela)
-- ============================================================

-- helper: read policy template applied to all read tables
-- (We inline since Postgres doesn't support policy macros.)

-- ----- homes -----
ALTER TABLE homes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Belong users can read homes" ON homes;
CREATE POLICY "Belong users can read homes"
  ON homes FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() ->> 'email' LIKE '%@belonghome.com'
      OR auth.jwt() ->> 'email' LIKE '%@belong.pe')
  );

DROP POLICY IF EXISTS "Admin can write homes" ON homes;
CREATE POLICY "Admin can write homes"
  ON homes FOR ALL
  USING      (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com');


-- ----- repairs -----
ALTER TABLE repairs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Belong users can read repairs" ON repairs;
CREATE POLICY "Belong users can read repairs"
  ON repairs FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() ->> 'email' LIKE '%@belonghome.com'
      OR auth.jwt() ->> 'email' LIKE '%@belong.pe')
  );

DROP POLICY IF EXISTS "Admin can write repairs" ON repairs;
CREATE POLICY "Admin can write repairs"
  ON repairs FOR ALL
  USING      (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com');


-- ----- pro_services -----
ALTER TABLE pro_services ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Belong users can read pro_services" ON pro_services;
CREATE POLICY "Belong users can read pro_services"
  ON pro_services FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() ->> 'email' LIKE '%@belonghome.com'
      OR auth.jwt() ->> 'email' LIKE '%@belong.pe')
  );

DROP POLICY IF EXISTS "Admin can write pro_services" ON pro_services;
CREATE POLICY "Admin can write pro_services"
  ON pro_services FOR ALL
  USING      (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com');


-- ----- repair_status (move-ins team can write) -----
ALTER TABLE repair_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Belong users can read repair_status" ON repair_status;
CREATE POLICY "Belong users can read repair_status"
  ON repair_status FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() ->> 'email' LIKE '%@belonghome.com'
      OR auth.jwt() ->> 'email' LIKE '%@belong.pe')
  );

DROP POLICY IF EXISTS "Move-ins team can write repair_status" ON repair_status;
CREATE POLICY "Move-ins team can write repair_status"
  ON repair_status FOR ALL
  USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() ->> 'email' LIKE '%@belonghome.com'
      OR auth.jwt() ->> 'email' LIKE '%@belong.pe')
  )
  WITH CHECK (
    auth.role() = 'authenticated'
    AND (auth.jwt() ->> 'email' LIKE '%@belonghome.com'
      OR auth.jwt() ->> 'email' LIKE '%@belong.pe')
  );


-- ----- sync_log -----
ALTER TABLE sync_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Belong users can read sync_log" ON sync_log;
CREATE POLICY "Belong users can read sync_log"
  ON sync_log FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() ->> 'email' LIKE '%@belonghome.com'
      OR auth.jwt() ->> 'email' LIKE '%@belong.pe')
  );

DROP POLICY IF EXISTS "Admin can write sync_log" ON sync_log;
CREATE POLICY "Admin can write sync_log"
  ON sync_log FOR ALL
  USING      (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com');


-- ============================================================
-- STEP 9: Trigger to auto-update repair_status.updated_at
-- ============================================================
DROP TRIGGER IF EXISTS repair_status_updated_at ON repair_status;
CREATE TRIGGER repair_status_updated_at
  BEFORE UPDATE ON repair_status
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================
-- STEP 10: Verification queries (optional, run separately)
-- ============================================================
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public'
--     AND table_name IN ('homes','repairs','pro_services','repair_status','home_repair_context','sync_log')
--   ORDER BY table_name;

-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name='homes' ORDER BY ordinal_position;

-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='home_repair_context'
--     AND column_name IN ('handed_off_to_concierge','is_delayed','delay_reasons','lease_url');

-- SELECT tablename, policyname, cmd FROM pg_policies
--   WHERE tablename IN ('homes','repairs','pro_services','repair_status','home_repair_context','sync_log')
--   ORDER BY tablename, cmd;
