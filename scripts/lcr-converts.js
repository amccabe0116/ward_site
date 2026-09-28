/*
 * North Point YSA — copy LCR's recent converts into the site, for the Leaders › Overview page.
 *
 * Run INSIDE the signed-in LCR tab on Covenant Path Progress, "New Members" tab (converts from the
 * last two years):
 *   https://lcr.churchofjesuschrist.org/one-work/progress-record?lang=eng
 * once every card has loaded. No network access here (LCR's CSP), so hand the result to
 * scripts/db-sync.js in a site tab exactly like lcr-report.js:
 *
 *   LCR tab:   <this file>                      -> { ok, key, title, headers, rows, count }
 *   site tab:  window.NP_DB = { supabaseUrl, anonKey, pass, action: 'sheet', key, title, sourceUrl, headers, rows };
 *              scripts/db-sync.js               -> { ok, stored }
 *
 * One row per person: LCR uuid, name, how long they have been a member ("Member for 1 year 3
 * months" → also as a number of months, for the Overview's 3 mo / 6 mo / 1 yr / 2 yr filter), the
 * last six Sundays as ✓ / · (attended / not), LCR's running count of sacrament meetings missed,
 * friends in the Church, and the link to their LCR details page.
 */
(function npLcrConverts(userCfg) {
  const cfg = Object.assign({ key: 'lcr_converts', title: 'LCR: Recent converts (Covenant Path Progress)' }, userCfg || window.NP_CONVERTS || {});
  const out = { ok: false, key: cfg.key, title: cfg.title, sourceUrl: location.href.split('#')[0], errors: [] };
  if (!/progress-record/.test(location.pathname)) { out.errors.push('Not on LCR’s Covenant Path Progress page'); return out; }
  const cards = [...document.querySelectorAll('div.row')].filter(d => d.querySelector('[data-member-card-person-uuid]'));
  if (!cards.length) { out.errors.push('No cards on the page — is the New Members tab showing, and has it finished loading?'); return out; }
  const months = s => { const y = (s.match(/(\d+)\s+year/) || [])[1], m = (s.match(/(\d+)\s+month/) || [])[1]; return (y ? 12 * +y : 0) + (m ? +m : 0); };  // "6 days" → 0
  const rows = [];
  for (const c of cards) {
    const a = c.querySelector('[data-member-card-person-uuid]');
    const name = a.textContent.trim();
    const text = c.innerText.replace(/\s+/g, ' ');
    const since = (text.match(/Member for ([^.|]*?)(?= View Details| Attended|$)/) || [, ''])[1].trim();
    // each Sunday: a date label followed by an icon — a check mark (attended) or an empty circle
    const days = [];
    for (const svg of c.querySelectorAll('svg')) {
      const lbl = svg.previousElementSibling && svg.previousElementSibling.textContent.trim();
      if (!lbl || !/^\d{1,2} [A-Z][a-z]{2}$/.test(lbl)) continue;
      const d = (svg.querySelector('path') || {}).getAttribute ? (svg.querySelector('path').getAttribute('d') || '') : '';
      days.push({ lbl, on: /^M12 22c5\.523/.test(d) });
    }
    const missed = (text.match(/(\d+) sacrament meetings? missed/) || [, '0'])[1];
    const friends = /not yet identified/.test(text) ? '0' : (text.match(/(\d+) friends? in the Church identified/) || [, ''])[1];
    const details = c.querySelector('a[href*="progress-details"]');
    rows.push([a.dataset.memberCardPersonUuid || '', name, since, String(months(since)), days.map(x => x.on ? '✓' : '·').join(''), days.map(x => x.lbl).join(', '), missed, friends, details ? new URL(details.getAttribute('href'), location.origin).href : '']);
  }
  out.headers = ['Person UUID', 'Name', 'Member for', 'Months', 'Last 6 Sundays', 'Sunday dates', 'Missed', 'Friends', 'Details'];
  out.rows = rows; out.count = rows.length;
  out.ok = !out.errors.length;
  window.__npConverts = out;
  return out;
})();
