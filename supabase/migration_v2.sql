-- ============================================================
-- Belong Move-In Dashboard — Migration v2
-- Drop old `repairs` table and replace with `home_repair_context`
-- Run in Supabase > SQL Editor
-- ============================================================

-- 1. Drop old repairs table (we never populated it, safe to drop)
DROP TABLE IF EXISTS repairs CASCADE;

-- 2. New table: Claude's Slack-derived analysis layer
CREATE TABLE IF NOT EXISTS home_repair_context (
  home_id          INTEGER PRIMARY KEY REFERENCES homes("HomeId") ON DELETE CASCADE,
  status           TEXT CHECK (status IN ('ready','postponed','grant_access','signed_off','in_progress')),
  repairs_context  TEXT,   -- 🔧 narrative from Slack (stacked after CSV repair data in UI)
  postpone_reason  TEXT,   -- Why postponed (shown under Postponed badge click)
  expectations     TEXT,   -- What resident must be informed about (under Grant Access badge click)
  lease_url        TEXT,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-touch updated_at (reuse function from v1 if present)
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS home_repair_context_updated_at ON home_repair_context;
CREATE TRIGGER home_repair_context_updated_at
  BEFORE UPDATE ON home_repair_context
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 3. Row Level Security
ALTER TABLE home_repair_context ENABLE ROW LEVEL SECURITY;

-- Read: any authenticated @belonghome.com user
DROP POLICY IF EXISTS "Belong users can read repair context" ON home_repair_context;
CREATE POLICY "Belong users can read repair context"
  ON home_repair_context FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND auth.jwt() ->> 'email' LIKE '%@belonghome.com'
  );

-- Insert: admin only (repair-context JSON uploads happen on /manage)
DROP POLICY IF EXISTS "Admin can insert repair context" ON home_repair_context;
CREATE POLICY "Admin can insert repair context"
  ON home_repair_context FOR INSERT
  WITH CHECK (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com');

-- Update: admin OR Tami (so Tami's "Mark Signed Off" button works)
DROP POLICY IF EXISTS "Admin or Tami can update repair context" ON home_repair_context;
CREATE POLICY "Admin or Tami can update repair context"
  ON home_repair_context FOR UPDATE
  USING (auth.jwt() ->> 'email' IN (
    'guillen.onela@belonghome.com',
    'epelbaum.tamara@belonghome.com'
  ))
  WITH CHECK (auth.jwt() ->> 'email' IN (
    'guillen.onela@belonghome.com',
    'epelbaum.tamara@belonghome.com'
  ));

-- Delete: admin only
DROP POLICY IF EXISTS "Admin can delete repair context" ON home_repair_context;
CREATE POLICY "Admin can delete repair context"
  ON home_repair_context FOR DELETE
  USING (auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com');

-- 4. Index for fast joins on home_id (PK already indexed, but explicit for clarity)
-- (PRIMARY KEY creates an index automatically — no extra index needed.)

-- 5. Verify
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'home_repair_context' ORDER BY ordinal_position;
-- SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename='home_repair_context';
