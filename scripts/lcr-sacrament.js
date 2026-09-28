/*
 * North Point YSA — copy LCR's Sacrament Meeting Attendance (the weekly headcount the clerk
 * enters) into the site, for the Leaders › Overview page.
 *
 * Run INSIDE the signed-in LCR tab on
 *   https://lcr.churchofjesuschrist.org/report/sacrament-attendance?lang=eng
 * (the year shown in the Year dropdown is the one that is read; switch it and run again for
 * another year). No network access here (LCR's CSP), so hand the result to scripts/db-sync.js
 * in a site tab exactly like lcr-report.js:
 *
 *   LCR tab:   window.NP_SACRAMENT = { key: 'lcr_sacrament', title: 'LCR: Sacrament Meeting Attendance' };
 *              <this file>                      -> { ok, key, title, headers:['Sunday','Attendance'], rows:[['2026-09-13','111'],…] }
 *   site tab:  window.NP_DB = { supabaseUrl, anonKey, pass, action: 'sheet', key, title, sourceUrl, headers, rows };
 *              scripts/db-sync.js               -> { ok, stored }
 *
 * Merge note: the site keeps one row per Sunday, so send the whole year each time (db-sync
 * replaces the stored table). Blank = nothing entered in LCR for that Sunday.
 */
(function npLcrSacrament(userCfg) {
  const cfg = Object.assign({ key: 'lcr_sacrament', title: 'LCR: Sacrament Meeting Attendance', year: null }, userCfg || window.NP_SACRAMENT || {});
  const out = { ok: false, key: cfg.key, title: cfg.title, sourceUrl: location.href, errors: [] };
  if (!location.pathname.includes('sacrament-attendance')) { out.errors.push('Not on the LCR Sacrament Meeting Attendance page'); return out; }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const yearSel = [...document.querySelectorAll('select')].find(s => [...s.options].every(o => /^20\d\d$/.test(o.textContent.trim())));
  const year = cfg.year || (yearSel && +yearSel.value) || new Date().getFullYear();
  const rows = [];
  // past months are disabled text inputs, the current month editable number inputs; each sits
  // under a day label ("4th") inside a month block whose text starts with the month name
  for (const input of document.querySelectorAll('input[type=text], input[type=number]')) {
    const lbl = ((input.parentElement && input.parentElement.parentElement || {}).innerText || '').trim();
    const dm = lbl.match(/^(\d{1,2})(st|nd|rd|th)$/);
    if (!dm) continue;
    let el = input, month = -1;
    for (let k = 0; k < 10 && el.parentElement; k++) {
      el = el.parentElement;
      const m = (el.innerText || '').match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
      if (m) { month = MONTHS.indexOf(m[1]); break; }
    }
    if (month < 0) continue;
    rows.push([`${year}-${String(month + 1).padStart(2, '0')}-${String(dm[1]).padStart(2, '0')}`, String(input.value || '').trim()]);
  }
  if (!rows.length) out.errors.push('No Sundays found — wait for the page to finish loading and run again');
  out.headers = ['Sunday', 'Attendance']; out.rows = rows; out.year = year; out.count = rows.length;
  out.ok = !out.errors.length;
  window.__npSacrament = out;
  return out;
})();
