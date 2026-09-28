/*
 * North Point YSA — Supabase half of the sync. Run in ANY tab that is not LCR
 * (a blank tab, or https://northpointysa.com/admin.html). Pair with scripts/lcr-sync.js.
 *
 * Configure with window.NP_DB before running:
 *   { supabaseUrl, anonKey, pass, action, ... }
 * Actions:
 *   'pending' { week }             -> { ok, week, pending:[{id,u,cu,name,class}], counts }
 *                                     (site check-ins not yet in LCR, with the LCR class to mark)
 *   'mark'    { ids:[…] }          -> { ok, marked }
 *   'sheet'   { key, title, sourceUrl, headers, rows } -> { ok, stored }
 *                                     (store a table for Leaders › Callings — e.g. the output of
 *                                      scripts/lcr-report.js, key 'lcr_callings')
 *   'roster'  { classes, members, deactivateMissing } -> { ok, inserted, updated, deactivated }
 *                                     (classes/members exactly as lcr-sync.js 'roster' returned;
 *                                      pass deactivateMissing:false when sending a partial slice)
 *   'callings' { headers, rows, sourceUrl } -> { ok, stored, removed:[…], waiting:[…] }
 *                                     (LCR's "Members with Callings" report, as lcr-report.js reads
 *                                      it: stored as sheet 'lcr_with_callings', then every calling
 *                                      tracked on Leaders › Members that has reached "set apart" and
 *                                      now shows in LCR is removed from the tracking; the ones LCR
 *                                      doesn't have yet are listed as `waiting`)
 *   'status'  {}                   -> { ok, dates:[…] }   (recent Sundays with counts)
 */
(async function npDbSync(userCfg) {
  const cfg = Object.assign({
    supabaseUrl: '', anonKey: '', pass: '', action: 'status', week: null, ids: [], classes: [], members: [],
    key: null, title: null, sourceUrl: null, headers: null, rows: null,
    deactivateMissing: true,
    ssOrgTypeIds: [1255, 1256, 1257], prsOrgTypeIds: [70, 71, 74],
  }, userCfg || window.NP_DB || {});
  const out = { ok: false, action: cfg.action, errors: [] };
  if (!cfg.supabaseUrl || !cfg.anonKey || !cfg.pass) { out.errors.push('Missing supabaseUrl / anonKey / pass'); return out; }

  async function rpc(fn, args) {
    const r = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` },
      body: JSON.stringify(args || {}),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${fn}: ${r.status} ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  }
  function lastSunday() {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
    const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
    const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day)); d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  }
  function displayName(lcrName) {
    const [last, rest] = String(lcrName).split(/,\s*/); const given = (rest || '').split(' ')[0];
    return (given ? `${given} ${last}` : last).trim();
  }

  try {
    if (cfg.action === 'status') {
      out.dates = await rpc('admin_meeting_dates', { p_pass: cfg.pass });
    }
    if (cfg.action === 'pending') {
      const week = cfg.week || lastSunday(); out.week = week;
      const rows = await rpc('admin_attendance', { p_pass: cfg.pass, p_date: week });
      out.counts = { total: rows.length, synced: rows.filter(r => r.synced_to_lcr_at).length };
      out.pending = []; out.unmappable = [];
      for (const r of rows) {
        if (r.synced_to_lcr_at) continue;
        const wanted = r.class === 'sunday_school' ? cfg.ssOrgTypeIds : cfg.prsOrgTypeIds;
        const target = (r.lcr_classes || []).find(c => wanted.includes(c.orgTypeId));
        if (!target || !r.lcr_uuid) { out.unmappable.push({ id: r.attendance_id, name: r.name, class: r.class }); continue; }
        out.pending.push({ id: r.attendance_id, u: r.lcr_uuid, cu: target.classUuid, name: r.name, class: r.class });
      }
    }
    if (cfg.action === 'mark') {
      out.marked = cfg.ids.length ? await rpc('admin_mark_synced', { p_pass: cfg.pass, p_attendance_ids: cfg.ids }) : 0;
    }
    if (cfg.action === 'sheet') {
      if (!cfg.key || !Array.isArray(cfg.headers) || !Array.isArray(cfg.rows)) throw new Error('sheet needs key, headers, rows');
      out.stored = await rpc('admin_replace_sheet', { p_pass: cfg.pass, p_key: cfg.key, p_title: cfg.title || cfg.key, p_source_url: cfg.sourceUrl || null, p_headers: cfg.headers, p_rows: cfg.rows, p_by: 'lcr-sync' });
    }
    if (cfg.action === 'callings') {
      if (!Array.isArray(cfg.headers) || !Array.isArray(cfg.rows)) throw new Error('callings needs headers, rows (run scripts/lcr-report.js on Members with Callings)');
      // the report also carries birth dates and phone numbers — the site has no use for them, so
      // the copy keeps only the person, organization, calling and dates (and drops LCR's unnamed icon column)
      const keep = cfg.headers.map((h, i) => i).filter(i => String(cfg.headers[i] || '').trim() && !/birth|phone/i.test(String(cfg.headers[i])));
      cfg.headers = keep.map(i => cfg.headers[i]); cfg.rows = cfg.rows.map(r => keep.map(i => r[i]));
      out.stored = await rpc('admin_replace_sheet', { p_pass: cfg.pass, p_key: 'lcr_with_callings', p_title: 'LCR: Members with Callings', p_source_url: cfg.sourceUrl || null, p_headers: cfg.headers, p_rows: cfg.rows, p_by: 'lcr-sync' });
      // columns by meaning, whatever LCR calls them this month
      const col = re => cfg.headers.findIndex(h => re.test(String(h || '')));
      const iU = col(/person uuid/i), iN = col(/^(preferred )?name$/i), iC = col(/^calling/i), iS = col(/sustain/i), iA = col(/set apart/i);
      if (iC < 0) throw new Error('no Calling column in the report (headers: ' + cfg.headers.join(', ') + ')');
      const norm = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z' -]/g, ' ').replace(/\s+/g, ' ').trim();
      const nameKey = n => { const [last, rest] = String(n || '').split(/,\s*/); return rest ? norm(rest).split(' ')[0] + '|' + norm(last) : norm(n).split(' ').length > 1 ? norm(n).split(' ')[0] + '|' + norm(n).split(' ').slice(-1)[0] : norm(n); };
      const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const day = v => { const t = String(v || '').trim(); let m;
        if ((m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/))) return Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
        if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return Date.UTC(+m[3], +m[1] - 1, +m[2]);
        if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})/))) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
        return null; };
      // LCR's rows by person: uuid, and first|last as a fallback for rows tracked without a uuid
      const byUuid = new Map(), byName = new Map();
      for (const r of cfg.rows) {
        const rec = { calling: String(r[iC] || '').trim(), sustained: iS >= 0 ? day(r[iS]) : null, setApart: iA >= 0 ? /^y/i.test(String(r[iA] || '')) : null, name: iN >= 0 ? r[iN] : '' };
        if (!rec.calling) continue;
        const u = iU >= 0 ? String(r[iU] || '') : ''; if (u) { if (!byUuid.has(u)) byUuid.set(u, []); byUuid.get(u).push(rec); }
        const k = nameKey(rec.name); if (k) { if (!byName.has(k)) byName.set(k, []); byName.get(k).push(rec); }
      }
      const tracked = (await rpc('admin_pipeline', { p_pass: cfg.pass, p_include_closed: true })) || [];
      out.removed = []; out.waiting = [];
      for (const t of tracked.filter(x => x.status === 'done' && x.set_apart_at)) {
        const since = day(t.sustained_at || t.set_apart_at) - 14 * 864e5;   // LCR's sustained date can sit a little before the tracked one
        const recs = (t.lcr_uuid && byUuid.get(String(t.lcr_uuid))) || byName.get(nameKey(t.name)) || [];
        // a calling LCR sustained on or after the tracked date; if the report has no dates, the same calling by name
        const words = norm(t.calling).split(' ').filter(w => w.length > 2);
        const hit = recs.find(r => (r.sustained != null ? r.sustained >= since : words.some(w => norm(r.calling).includes(w))));
        if (!hit) { out.waiting.push({ name: t.name, calling: t.calling, setApart: t.set_apart_at }); continue; }
        await rpc('admin_pipeline_delete', { p_pass: cfg.pass, p_id: t.id });
        out.removed.push({ name: t.name, calling: t.calling, lcrCalling: hit.calling, lcrSetApart: hit.setApart });
      }
    }
    if (cfg.action === 'roster') {
      const members = (cfg.members || []).map(m => {
        const lcr_classes = (m.c || []).map(i => cfg.classes[i]).filter(Boolean);
        const org = lcr_classes.some(c => c.orgTypeId === 70 || c.orgTypeId === 71) ? 'EQ' : (lcr_classes.some(c => c.orgTypeId === 74) ? 'RS' : null);
        return { lcr_uuid: m.u, name: m.n, display_name: displayName(m.n), sex: m.g || null, org, lcr_classes };
      });
      if (!members.length) throw new Error('no members given');
      const res = (await rpc('admin_upsert_members', { p_pass: cfg.pass, p_members: members, p_deactivate_missing: !!cfg.deactivateMissing }))[0];
      Object.assign(out, res, { sent: members.length });
    }
    out.ok = true;
  } catch (e) { out.errors.push(String(e && e.message || e)); }
  window.__npDbResult = out;
  return out;
})();
