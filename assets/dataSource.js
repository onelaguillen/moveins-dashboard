// ── Data source layer ────────────────────────────────────────────────────────
// Single module exposing all data access. Dashboard/Manage/Ready call these
// methods, never Supabase directly. The implementation today is Supabase, but
// the interface is what matters — it's swappable.
//
// Depends on `sb` from supabase.js being loaded first.

class SupabaseDataSource {
  constructor(client) {
    this.sb = client;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────
  async getHomes() {
    const { data, error } = await this.sb
      .from('homes')
      .select('*')
      .order('lease_start_on', { ascending: true });
    if (error) throw new Error('homes load failed: ' + error.message);
    return data || [];
  }

  async getRepairs() {
    const { data, error } = await this.sb
      .from('repairs')
      .select('*');
    if (error) throw new Error('repairs load failed: ' + error.message);
    return data || [];
  }

  async getProServices() {
    const { data, error } = await this.sb
      .from('pro_services')
      .select('*');
    if (error) throw new Error('pro_services load failed: ' + error.message);
    return data || [];
  }

  async getRepairContext() {
    const { data, error } = await this.sb
      .from('home_repair_context')
      .select('*');
    if (error) throw new Error('home_repair_context load failed: ' + error.message);
    return data || [];
  }

  async getRepairStatuses() {
    const { data, error } = await this.sb
      .from('repair_status')
      .select('*');
    if (error) throw new Error('repair_status load failed: ' + error.message);
    return data || [];
  }

  async getSyncLog(limit = 10) {
    const { data, error } = await this.sb
      .from('sync_log')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error('sync_log load failed: ' + error.message);
    return data || [];
  }

  // ── Writes: home_repair_context ────────────────────────────────────────────
  async upsertRepairContext(homeId, fields) {
    const row = { home_id: homeId, ...fields };
    const { error } = await this.sb
      .from('home_repair_context')
      .upsert(row, { onConflict: 'home_id' });
    if (error) throw new Error('upsertRepairContext failed: ' + error.message);
  }

  async upsertRepairStatus(maintenanceId, status, notes, email) {
    const row = {
      maintenance_id: maintenanceId,
      status,
      notes: notes ?? null,
      updated_by: email ?? null
    };
    const { error } = await this.sb
      .from('repair_status')
      .upsert(row, { onConflict: 'maintenance_id' });
    if (error) throw new Error('upsertRepairStatus failed: ' + error.message);
  }

  async markHandedOff(homeId, email) {
    return this.upsertRepairContext(homeId, {
      handed_off_to_concierge: true,
      handed_off_at: new Date().toISOString(),
      handed_off_by: email || null
    });
  }

  async unmarkHandedOff(homeId) {
    return this.upsertRepairContext(homeId, {
      handed_off_to_concierge: false,
      handed_off_at: null,
      handed_off_by: null
    });
  }

  async markDelayed(homeId, reasons, otherText, email) {
    return this.upsertRepairContext(homeId, {
      is_delayed: true,
      delay_reasons: Array.isArray(reasons) ? reasons : [],
      delay_other_text: otherText || null,
      delay_logged_at: new Date().toISOString(),
      delay_logged_by: email || null
    });
  }

  async unmarkDelayed(homeId) {
    return this.upsertRepairContext(homeId, {
      is_delayed: false,
      delay_reasons: null,
      delay_other_text: null,
      delay_logged_at: null,
      delay_logged_by: null
    });
  }

  // ── Bulk-load (Phase 7 upload) ─────────────────────────────────────────────
  async replaceHomes(rows) { return this._replaceTable('homes', rows); }
  async replaceRepairs(rows) { return this._replaceTable('repairs', rows); }
  async replaceProServices(rows) { return this._replaceTable('pro_services', rows); }

  async _replaceTable(table, rows) {
    // Truncate. Postgres won't accept an unconditional DELETE without a filter
    // on the supabase-js client, so we use a guaranteed-true predicate.
    const del = await this.sb.from(table).delete().neq('home_id', -1);
    // Note: `homes` PK is home_id; repairs/pro_services also have home_id.
    if (del.error && !/no rows/i.test(del.error.message)) {
      throw new Error(`${table} truncate failed: ` + del.error.message);
    }
    if (!rows || !rows.length) return { inserted: 0 };

    const BATCH = 500;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const { error } = await this.sb.from(table).insert(slice);
      if (error) throw new Error(`${table} insert failed: ` + error.message);
      inserted += slice.length;
    }
    return { inserted };
  }

  // ── Sync log ───────────────────────────────────────────────────────────────
  async logSync({ startedAt, finishedAt, counts, status, error, triggeredBy }) {
    const row = {
      started_at:  startedAt  || new Date().toISOString(),
      finished_at: finishedAt || null,
      row_count_homes:        counts?.homes        ?? null,
      row_count_repairs:      counts?.repairs      ?? null,
      row_count_pro_services: counts?.pro_services ?? null,
      status: status || 'success',
      error_message: error || null,
      triggered_by:  triggeredBy || null
    };
    const { data, error: err } = await this.sb
      .from('sync_log')
      .insert(row)
      .select()
      .single();
    if (err) throw new Error('sync_log write failed: ' + err.message);
    return data;
  }

  async updateSyncLog(id, fields) {
    const { error } = await this.sb
      .from('sync_log')
      .update(fields)
      .eq('id', id);
    if (error) throw new Error('sync_log update failed: ' + error.message);
  }
}

// Single global instance the rest of the app uses.
const dataSource = new SupabaseDataSource(sb);
