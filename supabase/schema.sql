-- ============================================================
-- Belong Move-In Dashboard — Supabase Schema
-- Run this in Supabase > SQL Editor
-- ============================================================

-- ============================================================
-- 1. HOMES TABLE
--    Source of truth from BigQuery CSV exports.
--    Upserted by HomeId — uploading a new CSV updates existing
--    rows and inserts new ones. Nothing is deleted on upload.
-- ============================================================
CREATE TABLE IF NOT EXISTS homes (
  -- Identity
  "HomeId"                    INTEGER       PRIMARY KEY,
  "LeaseId"                   INTEGER,
  "ResidentId"                INTEGER,
  "ReportDate"                DATE,
  "LeaseStartOn"              DATE,

  -- Address
  "Address"                   TEXT,
  "Region"                    TEXT,
  "AdminLink"                 TEXT,

  -- Resident
  "ResidentName"              TEXT,

  -- Specialists
  "MoveInSpecialist"          TEXT,
  "MoveInSpecialistId"        INTEGER,
  "Concierge"                 TEXT,
  "ConciergeId"               INTEGER,
  "ImprovementsSpecialist"    TEXT,
  "ImprovementsSpecialistId"  INTEGER,

  -- HOA
  "HasHoa"                    SMALLINT,
  "HoaIsNotified"             SMALLINT,

  -- Milestones
  "CurrentMilestone"          TEXT,
  "CurrentMilestoneOn"        TIMESTAMPTZ,
  "MoveInReady"               TIMESTAMPTZ,
  "MoveInCompleted"           TIMESTAMPTZ,

  -- Payments (from Lease)
  "RentAmount"                NUMERIC,
  "DepositAmount"             NUMERIC,
  "DepositType"               TEXT,
  "PaidRent"                  NUMERIC,
  "ReceivedRent"              NUMERIC,
  "ProcessingReceiveRent"     NUMERIC,
  "EnrolledInAutoPay"         SMALLINT,
  "MoveInPaymentStatus"       TEXT,

  -- Payment status (from Balance)
  "BalancesUnpaid"            SMALLINT,
  "DepositUnpaid"             SMALLINT,
  "RentUnpaid"                SMALLINT,
  "HasDeposit"                SMALLINT,
  "HasRent"                   SMALLINT,
  "PaymentStatus"             TEXT,
  "BalanceDetail"             TEXT,
  "PaymentsResult"            TEXT,

  -- QA Inspection
  "HadQAInspection"           SMALLINT,
  "QAInspectionCount"         INTEGER,
  "QAMaintenanceIds"          TEXT,
  "QAInspectionResult"        TEXT,

  -- Improvements / Repairs (from BigQuery)
  "UnfinishedImprovements"    SMALLINT,
  "UnfinishedImprovementsCount" INTEGER,
  "UnfinishedGroupDetails"    TEXT,
  "AllUnfinishedDetails"      TEXT,
  "ImprovementsResult"        TEXT,

  -- CSAT
  "IsSatisfied"               SMALLINT,
  "CSATResponseCount"         INTEGER,
  "CSATStatus"                TEXT,
  "AvgRating"                 NUMERIC,
  "CsatRequesterName"         TEXT,
  "CsatCreatedOn"             TIMESTAMPTZ,
  "CsatComment"               TEXT,
  "CSATResult"                TEXT,

  -- ProServices
  "NewProServices"            SMALLINT,
  "NewProServicesCount"       INTEGER,
  "NewProServicesDetails"     TEXT,
  "ProServicesResult"         TEXT,

  -- Summary
  "FailureReasons"            TEXT,
  "IsPerfectMoveIn"           SMALLINT,
  "IsPerfectMoveInStrict"     SMALLINT,

  -- Internal tracking
  "last_synced_at"            TIMESTAMPTZ   DEFAULT NOW()
);

-- ============================================================
-- 2. REPAIRS TABLE
--    Claude's analysis layer from Slack.
--    Additive — Claude writes repair progress here per home.
--    Multiple repair rows can exist per home.
-- ============================================================
CREATE TABLE IF NOT EXISTS repairs (
  id                UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  home_id           INTEGER       NOT NULL REFERENCES homes("HomeId") ON DELETE CASCADE,

  -- Repair details (extracted by Claude from Slack)
  summary           TEXT,           -- e.g. "HVAC not cooling"
  trade             TEXT,           -- e.g. "HVAC", "Plumbing", "Electrical"
  status            TEXT            CHECK (status IN ('open', 'in_progress', 'completed', 'blocked', 'cancelled')),
  notes             TEXT,           -- Claude's extracted context / progress update
  slack_thread_url  TEXT,           -- Link to the Slack thread

  -- Timestamps
  analyzed_at       TIMESTAMPTZ   DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   DEFAULT NOW()
);

-- Index for fast lookup by home
CREATE INDEX IF NOT EXISTS repairs_home_id_idx ON repairs (home_id);

-- Auto-update updated_at on any change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER repairs_updated_at
  BEFORE UPDATE ON repairs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 3. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE homes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE repairs ENABLE ROW LEVEL SECURITY;

-- homes: any authenticated @belonghome.com user can read
CREATE POLICY "Belong users can read homes"
  ON homes FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND auth.jwt() ->> 'email' LIKE '%@belonghome.com'
  );

-- homes: only admin can write
CREATE POLICY "Admin can insert homes"
  ON homes FOR INSERT
  WITH CHECK (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com');

CREATE POLICY "Admin can update homes"
  ON homes FOR UPDATE
  USING (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com');

CREATE POLICY "Admin can delete homes"
  ON homes FOR DELETE
  USING (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com');

-- repairs: any authenticated @belonghome.com user can read
CREATE POLICY "Belong users can read repairs"
  ON repairs FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND auth.jwt() ->> 'email' LIKE '%@belonghome.com'
  );

-- repairs: only admin can write (Claude API uses admin session or service role)
CREATE POLICY "Admin can insert repairs"
  ON repairs FOR INSERT
  WITH CHECK (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com');

CREATE POLICY "Admin can update repairs"
  ON repairs FOR UPDATE
  USING (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com');

CREATE POLICY "Admin can delete repairs"
  ON repairs FOR DELETE
  USING (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com');

-- ============================================================
-- 4. VERIFICATION (run separately to confirm setup)
-- ============================================================
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'homes' ORDER BY ordinal_position;

-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'repairs' ORDER BY ordinal_position;

-- SELECT tablename, policyname, cmd FROM pg_policies
-- WHERE tablename IN ('homes', 'repairs');
