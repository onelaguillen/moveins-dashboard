# Migration v3 — Step-by-step Supabase walkthrough

Three normalized cache tables (`homes`, `repairs`, `pro_services`) replace the wide v1/v2 `homes` table. Plus annotation tables for handoff, delay tracking, repair status, and sync history.

This is **destructive** — old `homes` table gets dropped. Dashboard will show 0 homes until Phase 7 (multi-file upload) is built.

Total time: ~15 minutes.

---

## STEP 1 — Back up existing data

Open Supabase → **SQL Editor** → run each query, click "Download CSV" on the result.

### 1a. Back up `homes`
```sql
SELECT * FROM homes;
```
→ `backup_homes_YYYY-MM-DD.csv`

### 1b. Back up `home_repair_context`
```sql
SELECT * FROM home_repair_context;
```
→ `backup_home_repair_context_YYYY-MM-DD.csv`

Save both files (local + Drive).

---

## STEP 2 — Confirm no extra dependencies

```sql
SELECT
  c.conname            AS constraint_name,
  c.conrelid::regclass AS table_with_fk
FROM pg_constraint c
WHERE c.confrelid = 'homes'::regclass;
```

Expected: only `home_repair_context.home_id`. Anything else, tell me first.

---

## STEP 3 — Run the migration

1. Supabase → **SQL Editor** → **+ New query**
2. Open `supabase/migration_v3.sql` from this repo
3. Copy the entire file into the SQL Editor
4. Click **Run**

Expected: green "Success. No rows returned".

If you see an error, **stop**, copy it, and tell me. Don't proceed to Step 4.

---

## STEP 4 — Verify the schema

### 4a. All 6 tables exist
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('homes','repairs','pro_services','repair_status','home_repair_context','sync_log')
ORDER BY table_name;
```
Expected: 6 rows.

### 4b. `homes` is the new normalized version
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'homes'
ORDER BY ordinal_position;
```
Expected: ~40 rows. Spot-check for `home_id` (PK), `original_executed_on`, `is_revised`. **No** `maintenance_id` or `repair_summary` (those moved to `repairs`).

### 4c. `repairs` exists with the right columns
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'repairs'
ORDER BY ordinal_position;
```
Expected: ~9 rows including `maintenance_id` (PK), `home_id`, `repair_assessment`, `repair_category`, `repair_created_on`.

### 4d. `home_repair_context` got the new columns
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'home_repair_context'
  AND column_name IN ('handed_off_to_concierge','is_delayed','delay_reasons','delay_other_text','lease_url')
ORDER BY column_name;
```
Expected: 4 rows — `delay_other_text`, `delay_reasons`, `handed_off_to_concierge`, `is_delayed`. **`lease_url` should NOT appear.**

### 4e. RLS policies in place
```sql
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE tablename IN ('homes','repairs','pro_services','repair_status','home_repair_context','sync_log')
ORDER BY tablename, cmd;
```
Expected: ~12-15 rows. Each table should have at least a SELECT policy.

---

## STEP 5 — Confirm old `homes` is replaced (not deleted)

The new `homes` table exists but is **empty**:
```sql
SELECT COUNT(*) FROM homes;
```
Expected: `0`. Dashboard will show no homes until Phase 7 + new BQ upload land.

---

## STEP 6 — What to expect now

- Dashboard loads but shows 0 homes
- Filters/search work but match nothing
- Existing `home_repair_context` rows preserved — when `homes` re-populates, annotations link by `home_id`
- DO NOT try uploading the OLD CSV format — it won't match the new schema

---

## STEP 7 — When Phase 7 is built

You'll:
1. Run `bigquery/01_homes.sql` → export → `homes.csv`
2. Run `bigquery/02_repairs.sql` → export → `repairs.csv`
3. Run `bigquery/03_pro_services.sql` → export → `pro_services.csv`
4. Drop all three into the `/manage` page
5. Dashboard auto-fingerprints each file by columns and routes to the right table
6. Click "Load all"

Phase 7 hasn't been built yet — until then you'll be in "schema migrated, dashboard empty" state. Expected.

---

## Rollback

If you need to revert:

1. Restore `homes` and `home_repair_context` from the CSVs you backed up in Step 1 (Supabase → Table Editor → Import CSV)
2. Drop the new tables:
   ```sql
   DROP TABLE IF EXISTS repairs       CASCADE;
   DROP TABLE IF EXISTS pro_services  CASCADE;
   DROP TABLE IF EXISTS repair_status CASCADE;
   DROP TABLE IF EXISTS sync_log      CASCADE;
   ```
3. Re-add `lease_url`:
   ```sql
   ALTER TABLE home_repair_context ADD COLUMN IF NOT EXISTS lease_url TEXT;
   ```
4. Re-deploy the dashboard from a pre-migration commit.

You shouldn't need this if Step 4 verifies clean.

---

## When done

Reply "**migration done**" and I'll start Phase 4 (DataSource refactor) → 5 (derive.js) → 6 (rendering) → 7 (multi-file upload). After Phase 7 the dashboard reads/writes the new schema and you can re-populate from BQ.
