/*
 * North Point YSA — copy an LCR custom report (e.g. "Members without Callings") into the site.
 *
 * Run INSIDE the signed-in LCR tab showing the report (Reports → Create a Report → the report),
 * after it has fully loaded ("Count: N" at the bottom). No network access here (LCR's CSP), so
 * it only reads the table; hand the result to scripts/db-sync.js in a site tab:
 *
 *   LCR tab:   window.NP_REPORT = { key: 'lcr_callings', title: 'LCR: Members without Callings' };
 *              <this file>                      -> { ok, key, title, headers, rows, count }
 *   site tab:  window.NP_DB = { supabaseUrl, anonKey, pass, action: 'sheet', key, title, sourceUrl, headers, rows };
 *              scripts/db-sync.js               -> { ok, stored }
 *
 * Rows come out as strings in column order, with the person's LCR uuid prepended as column
 * "Person UUID" (from the member-card button in the name cell) so the site can match exactly.
 */
(function npLcrReport(userCfg) {
  const cfg = Object.assign({ key: 'lcr_callings', title: document.title }, userCfg || window.NP_REPORT || {});
  const out = { ok: false, key: cfg.key, title: cfg.title, sourceUrl: location.href, errors: [] };
  const t = document.querySelector('table');
  if (!t || !t.tHead || !t.tBodies.length) { out.errors.push('No report table on this page — open the report in LCR and wait for it to load'); return out; }
  // LCR sometimes renders its column headers as untranslated keys ("record.preferred.name");
  // map the ones the site relies on back to the labels it expects, and warn about any other key
  const KEY_LABELS = { 'record.preferred.name': 'Preferred Name', 'custom-reports.address.city': 'Address - City', 'custom-reports.address.state': 'Address - State or Province', 'custom-reports.temple.recommend.status': 'Temple Recommend Status', 'custom-reports.temple.recommend.type': 'Temple Recommend Type', 'record.individual.phone': 'Individual Phone', 'record.individual.email': 'Individual E-mail', 'record.home.teachers': 'Ministering Brothers', 'record.visiting.teachers': 'Ministering Sisters', 'custom-reports.is.returned.missionary': 'Is Returned Missionary', 'custom-reports.has.children': 'Has Children', 'members-moved-in.move.in.date': 'Move In Date', 'record.age': 'Age', 'record.gender': 'Gender', 'record.name': 'Name', 'members-moved-in.prior.unit': 'Prior Unit' };
  const headers = [...t.tHead.rows[0].cells].map(c => { const s = c.querySelector('span'); const h = (s ? s.textContent : c.textContent).trim().replace(/^(.+?)\1$/, '$1'); return KEY_LABELS[h] || h; });
  headers.forEach(h => { if (/^[a-z-]+(\.[a-z-]+)+$/.test(h)) out.errors.push('untranslated LCR header "' + h + '" — add it to KEY_LABELS in lcr-report.js'); });
  const rows = [];
  for (const tr of t.tBodies[0].rows) {
    const btn = tr.querySelector('[data-member-card-person-uuid]');
    const vals = [...tr.cells].map(c => {
      // in card view LCR clones the column header into each cell; strip it
      const h = c.querySelector('.eden-table-card-view__cloned-column-header');
      const label = h ? h.textContent.trim() : '';
      let v = c.textContent.trim();
      if (label && v.startsWith(label)) v = v.slice(label.length).trim();
      return v.replace(/\s+/g, ' ');
    });
    if (vals.some(v => v)) rows.push([btn ? btn.getAttribute('data-member-card-person-uuid') : '', ...vals]);
  }
  const m = document.body.innerText.match(/Count:\s*(\d+)/);
  out.headers = ['Person UUID', ...headers]; out.rows = rows; out.count = m ? +m[1] : rows.length;
  if (m && +m[1] !== rows.length) out.errors.push(`page says ${m[1]} rows but ${rows.length} were read — scroll/wait and run again`);
  out.ok = !out.errors.some(e => !/^untranslated/.test(e));   // an unknown header is a warning, the copy still goes through
  window.__npReport = out;
  return out;
})();
