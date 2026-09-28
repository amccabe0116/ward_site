/*
 * North Point YSA — LCR half of the sync. NO network access (LCR's CSP blocks Supabase),
 * so this only reads/clicks the page. Pair it with scripts/db-sync.js, which runs in any
 * other tab and talks to Supabase. The runner (Claude, or you) hands the small JSON results
 * from one to the other.
 *
 * Run INSIDE a signed-in LCR tab on
 *   https://lcr.churchofjesuschrist.org/mlt/report/class-and-quorum-attendance?lang=eng
 *
 * Configure with window.NP_SYNC before running:
 *   { mode: 'roster', week: '2026-09-06', from: 0, to: 150 }
 *       -> { ok, week, total, classes:[{classUuid,orgName,orgTypeId}], members:[{u,n,g,c:[classIdx]}] }
 *          (members sliced [from,to) so the result stays small; call again with to..total)
 *   { mode: 'push', week: '2026-09-06', pending: [{ id, u, cu }], dryRun: false }
 *       -> { ok, week, synced:[id], alreadyMarked:[id], noCell:[id], failed:[id] }
 *          id = attendance_id, u = LCR person uuid, cu = LCR class uuid to mark
 * The week must be a Sunday LCR still lets you edit (it opens weeks through the coming Sunday).
 */
(async function npLcrSync(userCfg) {
  const cfg = Object.assign({ mode: 'roster', week: null, from: 0, to: 10000, pending: [], dryRun: false, clickDelayMs: 500 }, userCfg || window.NP_SYNC || {});
  const out = { ok: false, week: null, errors: [], log: [] };
  const say = (...a) => { out.log.push(a.join(' ')); console.log('[np-sync]', ...a); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  if (!/lcr\.churchofjesuschrist\.org$/.test(location.hostname) || !location.pathname.includes('class-and-quorum-attendance')) {
    out.errors.push('Not on the LCR Class and Quorum Attendance page'); return out;
  }

  function lastSunday() {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
    const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
    const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day)); d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  }
  function props(btn) {
    const k = Object.keys(btn).find(x => x.startsWith('__reactFiber$'));
    let f = k && btn[k];
    for (let i = 0; i < 8 && f; i++) { const p = f.memoizedProps; if (p && p.memberId && p.weekDate) return p; f = f.return; }
    return null;
  }
  function cells() {
    const res = [];
    for (const b of document.querySelectorAll('button[aria-label]')) { const p = props(b); if (p && p.classUuid) res.push({ btn: b, p }); }
    return res;
  }
  function setSelect(sel, value) {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const findSelect = pred => [...document.querySelectorAll('select')].find(s => [...s.options].some(pred));
  async function waitFor(test, ms, step) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 15000)) { const v = test(); if (v) return v; await sleep(step || 250); } return null; }

  async function showMonth(week) {
    const ym = week.slice(0, 7);
    const orgSel = findSelect(o => o.value === 'ALL' && /All Classes/i.test(o.textContent));
    if (orgSel && orgSel.value !== 'ALL') { setSelect(orgSel, 'ALL'); await sleep(800); }
    const monthSel = findSelect(o => /^\d{4}-\d{2}$/.test(o.value));
    if (!monthSel) throw new Error('month selector not found');
    if (monthSel.value !== ym) {
      if (![...monthSel.options].some(o => o.value === ym)) throw new Error(`month ${ym} not available in LCR`);
      say('switching month to', ym); setSelect(monthSel, ym);
    }
    const weekSel = findSelect(o => o.value === 'ALL' && /^All$/i.test(o.textContent.trim()));
    if (weekSel && weekSel.value !== 'ALL') setSelect(weekSel, 'ALL');
    const ok = await waitFor(() => cells().some(c => c.p.weekDate === week) ? true : null, 20000);
    if (!ok) throw new Error(`LCR shows no editable cells for ${week}`);
  }

  try {
    const week = cfg.week || lastSunday(); out.week = week;
    await showMonth(week);
    const all = cells().filter(c => c.p.weekDate === week);
    say('mode', cfg.mode, 'week', week, 'cells', all.length);

    if (cfg.mode === 'roster') {
      const classes = [], classIdx = new Map(), members = new Map();
      for (const { btn, p } of all) {
        if (!classIdx.has(p.classUuid)) { classIdx.set(p.classUuid, classes.length); classes.push({ classUuid: p.classUuid, orgName: p.orgName, orgTypeId: p.orgTypeId }); }
        let m = members.get(p.memberId);
        if (!m) {
          const tr = btn.closest('tr');
          const g = tr ? ((tr.querySelector('td:nth-child(2)') || {}).textContent || '').replace(/Gender/i, '').trim() : '';
          m = { u: p.memberId, n: p.memberName, g: g === 'M' || g === 'F' ? g : null, c: [] }; members.set(p.memberId, m);
        }
        const ci = classIdx.get(p.classUuid); if (!m.c.includes(ci)) m.c.push(ci);
      }
      const list = [...members.values()];
      out.total = list.length; out.classes = classes; out.members = list.slice(cfg.from, cfg.to);
      out.from = cfg.from; out.to = Math.min(cfg.to, list.length);
    }

    if (cfg.mode === 'push') {
      const byKey = new Map(all.map(c => [c.p.memberId + '|' + c.p.classUuid, c]));
      const r = { synced: [], alreadyMarked: [], noCell: [], failed: [] };
      for (const item of cfg.pending || []) {
        const cell = byKey.get(item.u + '|' + item.cu);
        if (!cell) { r.noCell.push(item.id); continue; }
        const pressed = () => cell.btn.getAttribute('aria-pressed') === 'true';
        if (pressed()) { r.alreadyMarked.push(item.id); continue; }
        if (cfg.dryRun) { r.synced.push(item.id); continue; }
        cell.btn.click();
        const ok = await waitFor(() => pressed() ? true : null, 8000, 200);
        if (ok) r.synced.push(item.id); else r.failed.push(item.id);
        await sleep(cfg.clickDelayMs);
      }
      Object.assign(out, r);
      say('push:', JSON.stringify({ synced: r.synced.length, alreadyMarked: r.alreadyMarked.length, noCell: r.noCell.length, failed: r.failed.length }));
    }
    out.ok = true;
  } catch (e) {
    out.errors.push(String(e && e.message || e)); say('ERROR', String(e && e.message || e));
  }
  window.__npSyncResult = out;
  return out;
})();
