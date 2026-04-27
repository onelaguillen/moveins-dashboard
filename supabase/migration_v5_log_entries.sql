-- ============================================================
-- Belong Move-In Dashboard — Migration v5
--   1) Relax manual_status CHECK to include new statuses
--   2) home_log_entries — append-only thread of notes + delay logs
-- ============================================================
-- Run in Supabase SQL editor.


-- ============================================================
-- STEP 1: Expand manual_status allowed values
-- ============================================================
-- Postgres auto-names the CHECK constraint; drop the old one safely if it
-- exists, then re-create with the expanded list.
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'home_repair_context'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%manual_status%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE home_repair_context DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

ALTER TABLE home_repair_context
  ADD CONSTRAINT home_repair_context_manual_status_check
  CHECK (manual_status IS NULL OR manual_status IN (
    'urgent',
    'at_risk',
    'blocked',
    'on_track',
    'handed_off',
    'lease_break',
    'back_out',
    'back_out_lease_break',
    'back_out_self_manage'
  ));


-- ============================================================
-- STEP 2: home_log_entries — running thread per home
-- ============================================================
-- Append-only history for notes, delay logs, and state-change events.
-- Each entry preserves who said what, when. Delete is supported
-- but only by the author or hardcoded admins.
CREATE TABLE IF NOT EXISTS home_log_entries (
  id                BIGSERIAL PRIMARY KEY,
  home_id           INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN (
                      'note',
                      'delay',
                      'delay_cleared',
                      'status_change',
                      'status_reset',
                      'handoff',
                      'handoff_cleared'
                    )),
  body              TEXT,                -- free-text comment
  chips             TEXT[],              -- selected delay-reason chips (kind='delay')
  other_text        TEXT,                -- "Other" reason free-text (kind='delay')
  meta              JSONB,               -- { from: 'urgent', to: 'blocked' } for status_change, etc.
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_email  TEXT NOT NULL,
  created_by_name   TEXT                 -- "Onela G." derived at insert time
);

CREATE INDEX IF NOT EXISTS idx_log_home_id    ON home_log_entries (home_id);
CREATE INDEX IF NOT EXISTS idx_log_created_at ON home_log_entries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_log_kind       ON home_log_entries (kind);


-- ============================================================
-- STEP 3: RLS — read all team, insert only as self,
--                delete only as author or admin
-- ============================================================
ALTER TABLE home_log_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Belong users can read log entries" ON home_log_entries;
CREATE POLICY "Belong users can read log entries"
  ON home_log_entries FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (auth.jwt() ->> 'email' LIKE '%@belonghome.com'
      OR auth.jwt() ->> 'email' LIKE '%@belong.pe')
  );

DROP POLICY IF EXISTS "Belong users can insert log entries as self" ON home_log_entries;
CREATE POLICY "Belong users can insert log entries as self"
  ON home_log_entries FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated'
    AND (auth.jwt() ->> 'email' LIKE '%@belonghome.com'
      OR auth.jwt() ->> 'email' LIKE '%@belong.pe')
    AND created_by_email = (auth.jwt() ->> 'email')
  );

DROP POLICY IF EXISTS "Authors and admins can delete log entries" ON home_log_entries;
CREATE POLICY "Authors and admins can delete log entries"
  ON home_log_entries FOR DELETE
  USING (
    auth.role() = 'authenticated'
    AND (
      created_by_email = (auth.jwt() ->> 'email')
      OR (auth.jwt() ->> 'email') IN (
        'guillen.onela@belonghome.com',
        'quiroga.veronica@belonghome.com'
      )
    )
  );

-- Updates are forbidden — log entries are immutable.
DROP POLICY IF EXISTS "No updates on log entries" ON home_log_entries;
-- (no policy = denied for non-admin; we don't grant UPDATE.)


-- ============================================================
-- Verify (optional)
-- ============================================================
-- SELECT * FROM information_schema.check_constraints
--   WHERE constraint_name LIKE '%manual_status%';
-- SELECT * FROM home_log_entries ORDER BY created_at DESC LIMIT 5;
