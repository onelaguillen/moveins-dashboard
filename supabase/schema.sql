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
-- 2. ROW LEVEL SECURITY
--    NOTE: the repair-context table (home_repair_context) is created
--    in migration_v2.sql with its own RLS policies. The legacy "repairs"
--    table has been removed.
-- ============================================================

ALTER TABLE homes ENABLE ROW LEVEL SECURITY;

-- homes: any authenticated @belonghome.com user can read
CREATE POLICY "Belong users can read homes"
  ON homes FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (
      auth.jwt() ->> 'email' LIKE '%@belonghome.com'
      OR auth.jwt() ->> 'email' LIKE '%@belong.pe'
    )
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


-- ============================================================
-- 4. VERIFICATION (run separately to confirm setup)
-- ============================================================
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'homes' ORDER BY ordinal_position;

-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'home_repair_context' ORDER BY ordinal_position;

-- SELECT tablename, policyname, cmd FROM pg_policies
-- WHERE tablename IN ('homes', 'home_repair_context');
