-- ============================================================
-- Belong Move-In Dashboard — Supabase RLS Setup
-- Run this in Supabase > SQL Editor (one-time setup)
-- ============================================================

-- 1. Enable Row Level Security on the table
ALTER TABLE belong_files ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. READ policy
--    Any authenticated user whose email ends with
--    @belonghome.com can SELECT rows.
-- ============================================================
CREATE POLICY "Authenticated Belong users can read files"
  ON belong_files
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (
      auth.jwt() ->> 'email' LIKE '%@belonghome.com'
      OR auth.jwt() ->> 'email' LIKE '%@belong.pe'
    )
  );

-- ============================================================
-- 3. INSERT policy
--    Only the admin account can add new rows.
-- ============================================================
CREATE POLICY "Admin can insert files"
  ON belong_files
  FOR INSERT
  WITH CHECK (
    auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com'
  );

-- ============================================================
-- 4. UPDATE policy
--    Only the admin account can update rows.
-- ============================================================
CREATE POLICY "Admin can update files"
  ON belong_files
  FOR UPDATE
  USING (
    auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com'
  )
  WITH CHECK (
    auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com'
  );

-- ============================================================
-- 5. DELETE policy
--    Only the admin account can delete rows.
-- ============================================================
CREATE POLICY "Admin can delete files"
  ON belong_files
  FOR DELETE
  USING (
    auth.jwt() ->> 'email' = 'guillen.onela@belonghome.com'
  );

-- ============================================================
-- 6. Verify everything looks correct (optional — run separately)
-- ============================================================
-- SELECT tablename, policyname, permissive, roles, cmd, qual
-- FROM pg_policies
-- WHERE tablename = 'belong_files';
