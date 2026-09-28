/**
 * Ward announcements — publish the weekly announcements email to the ward's site.
 *
 * Runs inside Google Apps Script under whichever Google account receives the ward's weekly
 * announcements email (script.google.com), so it can read that email — attachments included —
 * and commit announcements.json + the flyer files to the GitHub repo that serves the site.
 * Edit the SITE / CAL_NAME constants further down for your ward before deploying this.
 *
 * One-time setup (about 3 minutes):
 *   1. script.google.com → New project → name it "NPYSA announcements" → replace the editor
 *      contents with this file → Save.
 *   2. Project Settings (gear) → Script properties → Add properties:
 *        GITHUB_TOKEN  = the fine-grained GitHub token (Contents: read/write on the repo)
 *        SUPABASE_URL  = https://utkbhlyvmfbtjyfqeoze.supabase.co
 *        SUPABASE_KEY  = the publishable (anon) key from config.js
 *        ADMIN_PASS    = the Leaders passphrase (so the text lands in the editable copy too)
 *   3. Back in the editor, pick `publishAnnouncements` in the function dropdown → Run.
 *      Approve the Gmail + "connect to external service" permissions the first time.
 *      The execution log shows what it published.
 *   4. Triggers (clock icon) → Add trigger → publishAnnouncements · Time-driven ·
 *      Week timer · Every Sunday · 9pm to 10pm → Save.
 *
 * Leaders › Callings (the members-without-callings meeting tool) — same project:
 *   5. Function dropdown → `syncMemberSheets` → Run once (approve the Sheets permission). It
 *      copies the "Members without Callings" doc and the "New Member Form (Responses)" sheet
 *      into the site's database (needs SUPABASE_URL / SUPABASE_KEY / ADMIN_PASS from step 2).
 *   6. Triggers → Add trigger → syncMemberSheets · Time-driven · Hour timer · Every 6 hours.
 *      The same run also writes any edits leaders made on the site (Leaders › Callings → Edit)
 *      into the "Members without Callings" sheet — only the meeting columns (proposed calling,
 *      who texts, texted, answer, sustained, other notes); people not on the sheet get a new row.
 *      Needs supabase/edits.sql.
 *   7. "Refresh from Google Sheets" button (and the site's other web-app actions, like the
 *      texting check under Leaders › Settings): Deploy → New deployment → Web app ·
 *      Execute as: Me · Who has access: Anyone → Deploy, copy the web-app URL into
 *      `sheetsRefreshUrl` in config.js. The endpoint only does anything when a signed-in
 *      leader's token (or the passphrase) is sent with the request.
 *   8. Texts: Script properties → SIMPLETEXTING_KEY = an API key from SimpleTexting
 *      (Settings → API), and SIMPLETEXTING_NUMBER = the ward texting number (digits only).
 *   9. Text list sync (new member form → SimpleTexting): `syncTextList` reads the "New Member
 *      Form" responses and adds only the people who ticked "agree" on the form's
 *      "Automated Messages - Terms and conditions" question (and gave a mobile number) to the
 *      SimpleTexting list named in Script property SIMPLETEXTING_LIST (default "North Point Ward -
 *      Notifications"). The form timestamp goes into the contact's comment as the consent record.
 *      It runs at the end of every syncMemberSheets run and from Leaders › Settings → "Sync now".
 *      It never re-adds anyone who replied STOP and never removes anyone; a later form response
 *      that says "Opt out" cancels an earlier "agree" from the same number.
 *  10. Calendar files: `syncCalendar` turns the approved posts into calendar.ics (the ward
 *      calendar people subscribe to from calendar.html) and cal/<id>.ics (the "Add to calendar"
 *      links on each post and in the weekly email), committed to the repo like the flyers. It runs
 *      at the end of every syncMemberSheets and the Leaders page calls it (web app action
 *      "calendar") the moment a post is approved, edited, taken down or deleted. After pasting this
 *      version: function dropdown → syncCalendar → Run once, then Deploy → Manage deployments →
 *      edit → Version: New version → Deploy, so the web app picks it up.
 *  11. "Text a reminder" on Leaders › Announcements sends one SimpleTexting campaign to the list in
 *      SIMPLETEXTING_LIST (web app action "remind"). Nothing to set up beyond steps 8–9.
 *  12. Bishop meeting requests: bishop.html pokes the web app (action "bishop") and the executive
 *      secretary gets a text (site setting bishop_notify_phone, Leaders › Settings). Needs
 *      supabase/bishop.sql; the web app must be deployed with "Who has access: Anyone" (it is).
 *
 * Each run: finds the newest announcements email from the last 8 days (Trash included, since
 * those get deleted regularly), turns the body into clean text, uploads every image/PDF
 * attachment as img/ann-<date>-N.<ext>, removes last week's files, writes announcements.json,
 * then labels the email "NPYSA/Announcements" and archives it (unless it is already in Trash).
 * It is idempotent: running it twice on the same email does nothing the second time.
 */

const REPO = 'YOUR-GITHUB-USERNAME/YOUR-REPO';  // EDIT: the GitHub repo that serves this site
const BRANCH = 'main';
const SEARCH = 'from:noreply-lcr@mail.churchofjesuschrist.org subject:"Weekly Announcements" newer_than:8d in:anywhere';
const LABEL = 'NPYSA/Announcements';
const MIN_IMAGE_BYTES = 3000;   // skip tracking pixels / signature icons

function publishAnnouncements() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('Add GITHUB_TOKEN under Project Settings → Script properties');

  // 1. newest matching message
  let latest = null;
  GmailApp.search(SEARCH, 0, 10).forEach(function (t) {
    t.getMessages().forEach(function (m) { if (!latest || m.getDate() > latest.getDate()) latest = m; });
  });
  if (!latest) { Logger.log('No announcements email in the last 8 days — nothing to do.'); return; }
  const msgId = latest.getId();
  Logger.log('Found: "%s" from %s', latest.getSubject(), latest.getDate());

  // 2. already published?
  const existing = ghGet_(token, 'announcements.json');
  if (existing && existing.content) {
    try {
      const prev = JSON.parse(Utilities.newBlob(Utilities.base64Decode(existing.content.replace(/\n/g, ''))).getDataAsString('UTF-8'));
      if (prev.message_id === msgId) { Logger.log('That email is already on the site — nothing to do.'); return; }
    } catch (e) { /* fall through and republish */ }
  }

  // 3. body → text
  const text = cleanText_(htmlToText_(latest.getBody() || '') || latest.getPlainBody() || '');

  // 4. attachments → repo files
  const stamp = Utilities.formatDate(latest.getDate(), 'America/New_York', 'yyyy-MM-dd');
  const images = [], files = [], keep = {};
  let n = 0;
  latest.getAttachments({ includeInlineImages: true, includeAttachments: true }).forEach(function (att) {
    const type = (att.getContentType() || '').toLowerCase();
    const bytes = att.getBytes();
    const isImage = type.indexOf('image/') === 0, isPdf = type === 'application/pdf';
    if (!isImage && !isPdf) return;
    if (isImage && bytes.length < MIN_IMAGE_BYTES) return;
    n += 1;
    const ext = isPdf ? 'pdf' : ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[type] || 'bin');
    const path = 'img/ann-' + stamp + '-' + n + '.' + ext;
    const name = (att.getName() || ('Attachment ' + n)).replace(/\.[A-Za-z0-9]+$/, '');
    ghPut_(token, path, Utilities.base64Encode(bytes), 'Announcements ' + stamp + ': ' + name);
    keep[path] = true;
    (isPdf ? files : images).push({ path: path, name: name });
  });

  // 5. drop last week's files
  const dir = ghGet_(token, 'img');
  if (Array.isArray(dir)) {
    dir.forEach(function (f) {
      if (f.type === 'file' && /^ann-/.test(f.name) && !keep['img/' + f.name]) ghDelete_(token, 'img/' + f.name, f.sha, 'Remove old flyer ' + f.name);
    });
  }

  // 6. announcements.json
  const data = {
    subject: latest.getSubject(),
    sent_at: latest.getDate().toISOString(),
    updated_at: new Date().toISOString(),
    message_id: msgId,
    text: text,
    images: images,
    files: files,
  };
  ghPut_(token, 'announcements.json', Utilities.base64Encode(JSON.stringify(data, null, 2), Utilities.Charset.UTF_8), 'Announcements for ' + stamp, existing && existing.sha);

  // 6b. the editable copy the site actually shows (Leaders → Announcements). Optional but recommended.
  const props = PropertiesService.getScriptProperties();
  const sbUrl = props.getProperty('SUPABASE_URL'), sbKey = props.getProperty('SUPABASE_KEY'), adminPass = props.getProperty('ADMIN_PASS');
  if (sbUrl && sbKey && adminPass) {
    const res = UrlFetchApp.fetch(sbUrl + '/rest/v1/rpc/admin_publish_announcements', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey },
      payload: JSON.stringify({ p_pass: adminPass, p_text: text, p_images: images, p_files: files, p_subject: data.subject, p_sent_at: data.sent_at, p_message_id: msgId, p_source: 'email' }),
    });
    if (res.getResponseCode() >= 300) Logger.log('Supabase publish failed: %s %s', res.getResponseCode(), res.getContentText().slice(0, 200));
    else Logger.log('Supabase announcements row: %s', res.getContentText());
  } else {
    Logger.log('SUPABASE_URL / SUPABASE_KEY / ADMIN_PASS not set — site will use announcements.json until leaders save a copy.');
  }

  // 7. tidy the inbox
  if (!latest.isInTrash()) {
    const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
    const thread = latest.getThread();
    thread.addLabel(label);
    thread.moveToArchive();
  }
  Logger.log('Published %s chars of text, %s images, %s files for %s.', text.length, images.length, files.length, stamp);
}

// ---------- Leaders › Callings: mirror the two leadership sheets into the database ----------

// The sheets, by spreadsheet ID. `tab` is the sheet/tab name (null = first tab); `key` is what
// the site reads (supabase/sheets.sql → admin_sheets).
const MEMBER_SHEETS = [
  { key: 'callings',            id: '1PMS3f4ncGaeIhJJ9ZaVAbOgA0kUTBnMOWgpvhKgMbe8', tab: null,                 title: 'Members without callings' },
  { key: 'callings_committees', id: '1PMS3f4ncGaeIhJJ9ZaVAbOgA0kUTBnMOWgpvhKgMbe8', tab: 'Committee Requests', title: 'Committee requests' },
  { key: 'newmember',           id: '1OyPHy_STcN-Nbh_OiPVIiSIu16cq1gxvs1ffzgePLlA', tab: 'Form Responses 1',   title: 'New member form' },
];

function syncMemberSheets() {
  const props = PropertiesService.getScriptProperties();
  const sbUrl = props.getProperty('SUPABASE_URL'), sbKey = props.getProperty('SUPABASE_KEY'), adminPass = props.getProperty('ADMIN_PASS');
  if (!sbUrl || !sbKey || !adminPass) throw new Error('Set SUPABASE_URL, SUPABASE_KEY and ADMIN_PASS under Project Settings → Script properties');
  const result = {};
  // 0. edits made on the Leaders page go into the callings sheet first, so the copy below has them
  try { result.written = writePendingEdits_(sbUrl, sbKey, adminPass); } catch (e) { Logger.log('Writing edits failed: %s', e && e.message); result.writeError = String(e && e.message); }

  MEMBER_SHEETS.forEach(function (s) { result[s.key] = pullSheet_(s, sbUrl, sbKey, adminPass); });
  // 2. form opt-ins → the SimpleTexting list (only when the token is set up)
  if (props.getProperty('SIMPLETEXTING_KEY')) {
    try { result.textList = syncTextList(); } catch (e) { Logger.log('Text list sync failed: %s', e && e.message); result.textListError = String(e && e.message); }
  }
  // 3. approved posts → calendar.ics + cal/<id>.ics on the site (drops events that have passed)
  try { result.calendar = syncCalendar(); } catch (e) { Logger.log('Calendar sync failed: %s', e && e.message); result.calendarError = String(e && e.message); }
  // 4. Bishop meeting requests nobody was texted about yet (needs supabase/bishop.sql)
  try { result.bishop = sweepBishopRequests_(); } catch (e) { Logger.log('Bishop sweep failed: %s', e && e.message); }
  return result;
}

// ---------------------------------------------------------------------------------------------
// New member form → SimpleTexting list. Only people who ticked "agree" on the form's
// "Automated Messages - Terms and conditions" question (and gave a mobile number) are added; the
// form timestamp is kept in the contact's comment as the consent record. Nobody is removed here
// (STOP replies are SimpleTexting's job), and a later "Opt out" response from the same number
// cancels an earlier "agree". Returns a summary that is also saved under the site setting
// `textlist_last_sync` so Leaders › Settings can show it.
const TEXT_OPTIN_COLUMN = /automated messages|terms and conditions|text messag|\bsms\b|opt[ -]?in/i;
function syncTextList() {
  const props = PropertiesService.getScriptProperties();
  const sbUrl = props.getProperty('SUPABASE_URL'), sbKey = props.getProperty('SUPABASE_KEY'), adminPass = props.getProperty('ADMIN_PASS');
  const key = String(props.getProperty('SIMPLETEXTING_KEY') || '').trim().replace(/^(Authorization:\s*)?Bearer\s+/i, '');  // just the token — the script adds "Bearer" itself
  const listName = props.getProperty('SIMPLETEXTING_LIST') || (CAL_NAME + ' - Notifications');
  if (!sbUrl || !sbKey || !adminPass) throw new Error('Set SUPABASE_URL, SUPABASE_KEY and ADMIN_PASS under Script properties');
  if (!key) throw new Error('SIMPLETEXTING_KEY is not set in Script properties');
  const ST = 'https://api-app2.simpletexting.com/v2/api';
  const stFetch = function (path, method, payload) {
    const r = UrlFetchApp.fetch(ST + path, { method: method || 'get', contentType: 'application/json', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + key }, payload: payload ? JSON.stringify(payload) : undefined });
    const code = r.getResponseCode(), text = r.getContentText();
    if (code >= 300) throw new Error('SimpleTexting ' + method + ' ' + path + ' → ' + code + ' ' + text.slice(0, 160));
    return text ? JSON.parse(text) : null;
  };
  const digits10 = function (v) { let d = String(v || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') d = d.slice(1); return d.length === 10 ? d : ''; };
  const summary = { list: listName, responses: 0, answered: 0, optedIn: 0, declined: 0, added: 0, addedToList: 0, alreadyOnList: 0, optedOut: 0, noPhone: [], errors: [], at: new Date().toISOString() };

  // 1. the form responses, straight from the sheet (so "Sync now" sees today's sign-ups)
  const form = MEMBER_SHEETS.filter(function (s) { return s.key === 'newmember'; })[0];
  const ss = SpreadsheetApp.openById(form.id);
  const tab = form.tab ? ss.getSheetByName(form.tab) : ss.getSheets()[0];
  if (!tab) throw new Error('Tab "' + form.tab + '" not found in the New Member Form responses');
  const values = tab.getDataRange().getDisplayValues();
  const h = (values[0] || []).map(function (x) { return String(x || '').trim(); });
  const col = function (re) { for (let i = 0; i < h.length; i++) if (re.test(h[i])) return i; return -1; };
  const iFirst = col(/^first name/i), iLast = col(/^last name/i), iPhone = col(/phone/i), iWhen = col(/^timestamp/i), iOpt = col(TEXT_OPTIN_COLUMN);
  if (iOpt < 0) throw new Error('The form responses have no "Automated Messages - Terms and conditions" column yet — add the opt-in question to the New Member Form first (columns: ' + h.join(', ') + ')');
  if (iFirst < 0 || iPhone < 0) throw new Error('The form responses need a First Name and a Phone Number column (columns: ' + h.join(', ') + ')');
  // "agree" (the form's checkbox label) counts; "Opt out", "no" or both boxes ticked don't
  const agreed = function (v) { v = String(v || '').trim(); return /\bagree\b|^y(es)?$/i.test(v) && !/opt.?out|\bno\b|disagree/i.test(v); };
  const when = function (r) { const d = iWhen >= 0 ? new Date(r[iWhen]) : null; return d && !isNaN(d) ? d.getTime() : 0; };
  // the latest response per number decides
  const byPhone = {}, noPhone = {};
  values.slice(1).forEach(function (r, idx) {
    const first = String(r[iFirst] || '').trim(), last = iLast >= 0 ? String(r[iLast] || '').trim() : '';
    if (!first && !last) return;
    summary.responses++;
    const answer = String(r[iOpt] || '').trim(); if (!answer) return;   // filled in before the question existed
    summary.answered++;
    const yes = agreed(answer), phone = digits10(r[iPhone]), name = (first + ' ' + last).trim();
    if (!phone) { if (yes) noPhone[name] = true; return; }
    const t = when(r) || idx;
    if (byPhone[phone] && byPhone[phone].t > t) return;
    byPhone[phone] = { name: name, first: first, last: last, phone: phone, yes: yes, t: t, when: iWhen >= 0 ? String(r[iWhen] || '') : '' };
  });
  const members = [];
  Object.keys(byPhone).forEach(function (p) { const m = byPhone[p]; if (m.yes) { summary.optedIn++; members.push(m); } else summary.declined++; });
  summary.noPhone = Object.keys(noPhone);

  // 2. everything SimpleTexting has (paged)
  const contacts = {};
  for (let page = 0; page < 40; page++) {
    const pg = stFetch('/contacts?page=' + page + '&size=500');
    (pg.content || []).forEach(function (c) { const d = digits10(c.contactPhone); if (d) contacts[d] = c; });
    if (!pg.content || pg.content.length < 500) break;
  }
  const onList = function (c) { return (c.lists || []).some(function (l) { return l && (l.name === listName || l.listId === listName || l.id === listName); }); };

  // 3. add who's missing — never anyone who replied STOP
  const toCreate = [];
  members.forEach(function (m) {
    const c = contacts[m.phone];
    const note = 'New member form opt-in' + (m.when ? ' ' + m.when : '');
    if (!c) { toCreate.push({ contactPhone: m.phone, firstName: m.first, lastName: m.last, comment: note, listIds: [listName] }); return; }
    if (String(c.subscriptionStatus || '').toUpperCase().indexOf('OPT_OUT') === 0 || /UNSUB/i.test(c.subscriptionStatus || '')) { summary.optedOut++; return; }
    if (onList(c)) { summary.alreadyOnList++; return; }
    try { stFetch('/contact-lists/' + encodeURIComponent(listName) + '/contacts', 'post', { contactPhoneOrId: m.phone }); summary.addedToList++; }
    catch (e) { summary.errors.push(m.name + ': ' + e.message); }
  });
  for (let i = 0; i < toCreate.length; i += 100) {
    const chunk = toCreate.slice(i, i + 100);
    try { stFetch('/contacts-batch/batch-update', 'post', { listsReplacement: false, updates: chunk }); summary.added += chunk.length; }
    catch (e) {  // fall back to one at a time so one bad number doesn't block the rest
      chunk.forEach(function (u) { try { stFetch('/contacts?upsert=true&listsReplacement=false', 'post', u); summary.added++; } catch (e2) { summary.errors.push(u.firstName + ' ' + u.lastName + ': ' + e2.message); } });
    }
  }
  summary.noPhoneCount = summary.noPhone.length; summary.noPhone = summary.noPhone.slice(0, 40);
  Logger.log('Text list: %s', JSON.stringify(summary));
  // remember the result for the Leaders page
  try {
    UrlFetchApp.fetch(sbUrl + '/rest/v1/rpc/admin_set_setting', { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey }, payload: JSON.stringify({ p_pass: adminPass, p_key: 'textlist_last_sync', p_value: JSON.stringify(summary) }) });
  } catch (e) { Logger.log('could not save summary: %s', e && e.message); }
  return summary;
}

// One Google Sheet tab → the `sheets` table (display values = exactly what leaders see: dates as
// text, no formulas). Returns the row count, or -1 when the tab is missing.
function pullSheet_(s, sbUrl, sbKey, adminPass) {
  const ss = SpreadsheetApp.openById(s.id);
  const sheet = s.tab ? ss.getSheetByName(s.tab) : ss.getSheets()[0];
  if (!sheet) { Logger.log('Tab "%s" not found in %s — skipped', s.tab, ss.getName()); return -1; }
  const values = sheet.getDataRange().getDisplayValues();
  if (!values.length) return 0;
  const headers = values[0].map(function (h) { return String(h || '').trim(); });
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i].slice(0, headers.length).map(function (v) { return String(v == null ? '' : v).trim(); });
    while (r.length < headers.length) r.push('');
    if (r.some(function (v) { return v; })) rows.push(r);
  }
  const url = 'https://docs.google.com/spreadsheets/d/' + s.id + '/edit#gid=' + sheet.getSheetId();
  const res = UrlFetchApp.fetch(sbUrl + '/rest/v1/rpc/admin_replace_sheet', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey },
    payload: JSON.stringify({ p_pass: adminPass, p_key: s.key, p_title: s.title, p_source_url: url, p_headers: headers, p_rows: rows, p_by: 'apps-script' }),
  });
  if (res.getResponseCode() >= 300) throw new Error(s.key + ': Supabase said ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  Logger.log('%s: %s rows, %s columns', s.key, rows.length, headers.length);
  return rows.length;
}

// Edits saved on the Leaders page (supabase/edits.sql) → the "Members without Callings" sheet.
// Finds each person's row by NAME (exact, then ignoring anything in parentheses / accents),
// appends a new row when they are not on the sheet yet, writes only the edited columns, then
// tells the database those edits are in. A blank edit never overwrites something already in the
// sheet (only an explicit clear from the site — stored as null — empties a cell). Pass onlyNames
// to write just those people (the "Save to sheet" button on a slide). Returns how many were written.
function writePendingEdits_(sbUrl, sbKey, adminPass, onlyNames) {
  const res = UrlFetchApp.fetch(sbUrl + '/rest/v1/rpc/admin_callings_pending', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey }, payload: JSON.stringify({ p_pass: adminPass }),
  });
  if (res.getResponseCode() === 404) return 0;  // edits.sql not run yet
  if (res.getResponseCode() >= 300) throw new Error('admin_callings_pending ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 120));
  let pending = JSON.parse(res.getContentText() || '[]');
  if (onlyNames) { const want = onlyNames.map(function (n) { return String(n).trim().toLowerCase(); }); pending = pending.filter(function (e) { return want.indexOf(String(e.name).trim().toLowerCase()) >= 0; }); }
  if (!pending.length) return 0;
  const asOf = new Date().toISOString();

  const cfg = MEMBER_SHEETS.filter(function (s) { return s.key === 'callings'; })[0];
  const ss = SpreadsheetApp.openById(cfg.id);
  const sheet = cfg.tab ? ss.getSheetByName(cfg.tab) : ss.getSheets()[0];
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(function (h) { return String(h || '').trim(); });
  // columns the site can write; "Flag" and "Flag sent" are added to the sheet the first time they are
  // needed, any other column that has been renamed on the sheet is skipped (logged) rather than failing the run
  const col = function (name) {
    let i = headers.indexOf(name);
    if (i < 0) {
      if (name !== 'Flag' && name !== 'Flag sent') { Logger.log('column "%s" not on the sheet — skipped', name); return 0; }
      i = headers.length; headers.push(name); sheet.getRange(1, i + 1).setValue(name).setFontWeight('bold');
    }
    return i + 1;
  };
  const nameCol = col('NAME');
  const norm = function (s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z' -]/g, ' ').replace(/\s+/g, ' ').trim(); };
  const rowOf = function (name) {
    const exact = String(name).trim().toLowerCase(), loose = norm(name);
    for (let r = 1; r < data.length; r++) if (String(data[r][nameCol - 1] || '').trim().toLowerCase() === exact) return r + 1;
    for (let r = 1; r < data.length; r++) if (norm(data[r][nameCol - 1]) === loose && loose) return r + 1;
    return 0;
  };
  const done = [];
  // deletions last, bottom-up, so row numbers stay valid
  const toDelete = [];
  pending.forEach(function (e) {
    if (e.deleted) { const r = rowOf(e.name); if (r) toDelete.push(r); else Logger.log('delete: %s not on the sheet (already gone)', e.name); done.push(e.name); return; }
    let row = rowOf(e.name);
    if (!row) { row = sheet.getLastRow() + 1; sheet.getRange(row, nameCol).setValue(e.name); data.push([]); }
    Object.keys(e.edits || {}).forEach(function (k) {
      const v = e.edits[k], c = col(k); if (!c) return;
      const current = String((data[row - 1] || [])[c - 1] == null ? '' : (data[row - 1] || [])[c - 1]).trim();
      if (v === null) { sheet.getRange(row, c).clearContent(); return; }          // cleared on purpose on the site
      if (String(v).trim() === '' && current) { Logger.log('%s / %s: blank edit kept "%s"', e.name, k, current); return; }
      sheet.getRange(row, c).setValue(v);
    });
    done.push(e.name);
    Logger.log('sheet row %s ← %s: %s', row, e.name, JSON.stringify(e.edits));
  });
  toDelete.sort(function (a, b) { return b - a; }).forEach(function (r) { Logger.log('deleting sheet row %s (%s)', r, data[r - 1][nameCol - 1]); sheet.deleteRow(r); });
  SpreadsheetApp.flush();
  const mark = UrlFetchApp.fetch(sbUrl + '/rest/v1/rpc/admin_callings_mark_synced', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey }, payload: JSON.stringify({ p_pass: adminPass, p_names: done, p_as_of: asOf }),
  });
  if (mark.getResponseCode() >= 300) throw new Error('admin_callings_mark_synced ' + mark.getResponseCode());
  return done.length;
}

// Web app entry point for the Leaders page (see setup step 7). Body is JSON with the Leaders
// passphrase or session token as "pass" and an "action":
//   sheets → write every pending edit to the callings sheet, then re-copy all sheets  {"ok":true,"written":2,"callings":130,…}
//   save   → one person's pending edits ("name") to the sheet, re-copy the callings sheet
//   notify → send a text and/or email (sendFlagMessage_) — used by the Settings "test text" check
//            and the announcements "Text a reminder" single-number test
//   textlist → add the form's text opt-ins to the SimpleTexting list now (syncTextList)
//   calendar → rebuild calendar.ics + cal/<id>.ics from the approved posts now (syncCalendar)
//   remind   → text the ward list about a post (sendReminder_); { preview: true } just returns the list size;
//              { media: <flyer url> } sends it as a picture (MMS)
//   bishop   → { id } from bishop.html, no passphrase: text the exec secretary about that meeting request
//              (notifyBishop_ — the database hands the request over once, so a repeat poke sends nothing)
function doPost(e) {
  const out = function (o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); };
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'bishop') return out(notifyBishop_(Number(body.id)));   // public poke: only ever texts a real, unclaimed request once
    if (!isLeader_(body.pass)) return out({ ok: false, error: 'not authorized' });
    if (body.action === 'notify') return out(sendFlagMessage_(body));
    if (body.action === 'textlist') { const r = syncTextList(); r.ok = true; return out(r); }
    if (body.action === 'calendar') { const r = syncCalendar(); r.ok = true; return out(r); }
    if (body.action === 'remind') return out(sendReminder_(body));
    if (body.action === 'save') {  // one person's edits → the sheet now (the "Save to sheet" button on a slide)
      const props = PropertiesService.getScriptProperties();
      const sbUrl = props.getProperty('SUPABASE_URL'), sbKey = props.getProperty('SUPABASE_KEY'), adminPass = props.getProperty('ADMIN_PASS');
      const written = writePendingEdits_(sbUrl, sbKey, adminPass, [String(body.name || '')]);
      const cfg = MEMBER_SHEETS.filter(function (s) { return s.key === 'callings'; })[0];
      const rows = pullSheet_(cfg, sbUrl, sbKey, adminPass);
      return out({ ok: true, written: written, callings: rows });
    }
    if (body.action !== 'sheets') return out({ ok: false, error: 'unknown action' });
    const r = syncMemberSheets(); r.ok = true;
    return out(r);
  } catch (err) { return out({ ok: false, error: String(err && err.message || err) }); }
}
function doGet() { return ContentService.createTextOutput('ok'); }

// Texts coming back "401 Tenant not found"? Function dropdown → checkSimpleTexting → Run, then
// read the execution log: it shows what the key looks like (length + last 2 characters, never
// the key itself) and how each SimpleTexting API host answers it.
function checkSimpleTexting() {
  const raw = PropertiesService.getScriptProperties().getProperty('SIMPLETEXTING_KEY');
  const key = String(raw || '').trim().replace(/^(Authorization:\s*)?Bearer\s+/i, '');
  if (!key) { Logger.log('SIMPLETEXTING_KEY is empty / missing in Script properties'); return; }
  Logger.log('SIMPLETEXTING_KEY: %s characters, ends with "…%s"%s', key.length, key.slice(-2), raw !== key ? ' (had spaces or a Bearer prefix — ignored)' : '');
  [['API v2 (api-app2.simpletexting.com)', 'https://api-app2.simpletexting.com/v2/api/contact-lists?size=1'],
   ['API v1 (app2.simpletexting.com)',     'https://app2.simpletexting.com/v1/messaging/check']].forEach(function (t) {
    try {
      const r = UrlFetchApp.fetch(t[1], { muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + key } });
      Logger.log('%s → %s %s', t[0], r.getResponseCode(), r.getContentText().slice(0, 200));
    } catch (e) { Logger.log('%s → %s', t[0], e && e.message); }
  });
}

// Send a text through SimpleTexting (script property SIMPLETEXTING_KEY = the API token from
// SimpleTexting → Settings → API — the API is enabled per account by SimpleTexting support;
// optional SIMPLETEXTING_NUMBER = the ward's texting number, digits only, when it isn't the
// account's primary number) and/or an email from this Google account, given a fromEmail/replyTo
// (verified "Send mail as" alias of this Gmail, if set). A "test" body ({ action: 'notify', test: true, phone, sms })
// sends just the text — the Settings page's "Check texting" uses it to check the token, and the
// announcements "Text a reminder" box uses it for its single-number test. Also used directly (not
// through the web app) by notifyBishop_. Returns { ok, sms: 'sent'|'skipped'|'failed', email: … }.
function sendFlagMessage_(b) {
  const props = PropertiesService.getScriptProperties();
  const res = { ok: true, sms: 'skipped', email: 'skipped' };
  const phone = String(b.phone || '').replace(/\D/g, '');
  if (phone && b.sms) {
    const key = String(props.getProperty('SIMPLETEXTING_KEY') || '').trim().replace(/^(Authorization:\s*)?Bearer\s+/i, '');  // just the token — the script adds "Bearer" itself
    if (!key) { res.sms = 'skipped'; res.error = 'no SimpleTexting key yet (SIMPLETEXTING_KEY in Script properties)'; }
    else {
      // SimpleTexting wants a 10-digit US number ("3051234567"); drop a leading 1 if LCR gave 11 digits
      const digits = phone.length === 11 && phone[0] === '1' ? phone.slice(1) : phone;
      const payload = { contactPhone: digits, mode: 'AUTO', text: b.sms };
      if (b.media && /^https:\/\//.test(b.media)) { payload.mediaItems = [String(b.media)]; payload.mode = 'MMS_PREFERRED'; }   // a picture along (the reminder test)
      const from = props.getProperty('SIMPLETEXTING_NUMBER'); if (from) payload.accountPhone = from.replace(/\D/g, '');
      const r = UrlFetchApp.fetch('https://api-app2.simpletexting.com/v2/api/messages', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + key }, payload: JSON.stringify(payload),
      });
      if (r.getResponseCode() < 300) res.sms = 'sent';
      else { res.sms = 'failed'; res.error = 'SimpleTexting ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200); }
      Logger.log('SimpleTexting → %s: %s %s', phone, r.getResponseCode(), r.getContentText().slice(0, 200));
    }
  }
  if (b.email && b.body) {
    try {
      const opts = { name: b.fromName || CAL_NAME };
      const fromEmail = String(b.fromEmail || '').trim().toLowerCase(), replyTo = String(b.replyTo || '').trim() || fromEmail;
      if (replyTo) opts.replyTo = replyTo;
      // Gmail only lets the script send "from" an address this Google account has verified under
      // Settings → Accounts and Import → "Send mail as"; otherwise it goes from the account itself.
      if (fromEmail) {
        const alias = GmailApp.getAliases().filter(function (a) { return String(a).toLowerCase() === fromEmail; })[0];
        if (alias) opts.from = alias;
        else res.note = 'email went from ' + Session.getEffectiveUser().getEmail() + ' — ' + fromEmail + ' is not a "Send mail as" address of that Gmail account yet';
      }
      GmailApp.sendEmail(b.email, b.subject || CAL_NAME, b.body, opts);
      res.email = 'sent'; res.from = opts.from || Session.getEffectiveUser().getEmail();
    } catch (e) { res.email = 'failed'; res.error = (res.error ? res.error + '; ' : '') + 'email: ' + (e && e.message); }
  }
  // one channel getting through counts as sent; res.error then explains the other one
  res.ok = res.sms === 'sent' || res.email === 'sent';
  if (!res.ok && !res.error) res.error = 'nothing to send (no phone/text or email/body)';
  return res;
}

// A new "meet with the Bishop" request → one text to the number in the site setting
// bishop_notify_phone (Leaders › Settings). bishop.html pokes the web app with the request id right
// after submitting (no secret involved: the page is public); this asks the database to CLAIM the
// request (supabase/bishop.sql), which succeeds exactly once and only for a real, recent request —
// so a stray or repeated poke can never send a second text. If the text fails the claim is released
// and the 6-hourly sweep (sweepBishopRequests_, from syncMemberSheets) tries again.
function notifyBishop_(id) {
  if (!id) return { ok: false, error: 'no id' };
  const props = PropertiesService.getScriptProperties();
  const sbUrl = props.getProperty('SUPABASE_URL'), sbKey = props.getProperty('SUPABASE_KEY'), adminPass = props.getProperty('ADMIN_PASS');
  const call = function (fn, payload) {
    const r = UrlFetchApp.fetch(sbUrl + '/rest/v1/rpc/' + fn, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey }, payload: JSON.stringify(Object.assign({ p_pass: adminPass }, payload)) });
    if (r.getResponseCode() >= 300) throw new Error(fn + ' → ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 160));
    return JSON.parse(r.getContentText() || 'null');
  };
  let to = '';
  try { to = String((call('admin_get_settings', {}).filter(function (x) { return x.key === 'bishop_notify_phone'; })[0] || {}).value || '').replace(/\D/g, ''); } catch (e) { return { ok: false, error: String(e && e.message) }; }
  if (to.length < 10) return { ok: true, skipped: 'no number set' };
  let rows;
  try { rows = call('admin_meeting_request_claim', { p_id: id, p_claim: true }); } catch (e) { return { ok: false, error: /admin_meeting_request_claim/.test(String(e)) ? 'run supabase/bishop.sql' : String(e && e.message) }; }
  const q = rows && rows[0]; if (!q) return { ok: true, skipped: 'already texted, or not a recent request' };
  const bits = [CAL_NAME + ': ' + q.name + ' asked to meet with the Bishop' + (q.temple_recommend ? ' (temple recommend interview)' : '') + '.', 'Reach them at ' + q.phone + (q.email ? ' or ' + q.email : '') + '.'];
  if (q.note) bits.push('Note: ' + String(q.note).replace(/\s+/g, ' ').slice(0, 300).replace(/[.\s]+$/, '') + '.');
  bits.push('Leaders > Inbox: ' + SITE + '/admin.html');
  const res = sendFlagMessage_({ phone: to, sms: bits.join(' '), email: '' });
  if (res.sms !== 'sent') { try { call('admin_meeting_request_claim', { p_id: id, p_claim: false }); } catch (e) {} return { ok: false, error: res.error || 'text not sent' }; }
  Logger.log('Bishop request %s → texted %s', id, to);
  return { ok: true, sent: true };
}
// Any recent request nobody texted (the page's poke got lost, or the text failed) — from syncMemberSheets.
function sweepBishopRequests_() {
  const props = PropertiesService.getScriptProperties();
  const sbUrl = props.getProperty('SUPABASE_URL'), sbKey = props.getProperty('SUPABASE_KEY'), adminPass = props.getProperty('ADMIN_PASS');
  const r = UrlFetchApp.fetch(sbUrl + '/rest/v1/rpc/admin_meeting_requests', { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey }, payload: JSON.stringify({ p_pass: adminPass, p_include_handled: false }) });
  if (r.getResponseCode() >= 300) return { error: r.getResponseCode() };
  const out = { texted: 0, skipped: 0 };
  JSON.parse(r.getContentText() || '[]').forEach(function (q) {
    if (q.notified_at || Date.parse(q.created_at) < Date.now() - 2 * 864e5) return;
    const res = notifyBishop_(q.id); if (res.sent) out.texted++; else out.skipped++;
  });
  return out;
}

// "Text a reminder" on Leaders › Announcements: one SimpleTexting campaign to the ward list
// (Script property SIMPLETEXTING_LIST, the same list the form opt-ins go to). The page sends the
// wording it showed the leader; with { preview: true } this only looks the list up (name + how
// many active contacts) so the confirmation can say "Send to 87 people". A successful send is
// stamped on the post (admin_post_reminded, supabase/repeat.sql) so the card shows when it went.
function sendReminder_(b) {
  const props = PropertiesService.getScriptProperties();
  const key = String(props.getProperty('SIMPLETEXTING_KEY') || '').trim().replace(/^(Authorization:\s*)?Bearer\s+/i, '');
  if (!key) return { ok: false, error: 'no SimpleTexting key yet (SIMPLETEXTING_KEY in Script properties)' };
  const list = props.getProperty('SIMPLETEXTING_LIST') || (CAL_NAME + ' - Notifications');
  const api = 'https://api-app2.simpletexting.com/v2/api', headers = { Authorization: 'Bearer ' + key };
  const info = UrlFetchApp.fetch(api + '/contact-lists/' + encodeURIComponent(list), { headers: headers, muteHttpExceptions: true });
  if (info.getResponseCode() >= 300) return { ok: false, error: 'SimpleTexting list "' + list + '": ' + info.getResponseCode() + ' ' + info.getContentText().slice(0, 200) };
  const li = JSON.parse(info.getContentText() || '{}');
  const contacts = Number(li.activeContactsCount != null ? li.activeContactsCount : li.totalContactsCount) || 0;
  if (b.preview) return { ok: true, list: list, contacts: contacts };
  const text = String(b.text || '').trim();
  if (!text) return { ok: false, error: 'the message is empty' };
  if (text.length > 900) return { ok: false, error: 'the message is too long (' + text.length + ' characters)' };
  const payload = { title: ('Reminder: ' + String(b.title || 'post')).slice(0, 250), listIds: [list], messageTemplate: { mode: 'AUTO', text: text } };
  if (b.media && /^https:\/\//.test(b.media)) { payload.messageTemplate.mediaItems = [String(b.media)]; payload.messageTemplate.mode = 'MMS_PREFERRED'; }   // the flyer as a picture
  const from = props.getProperty('SIMPLETEXTING_NUMBER'); if (from) payload.accountPhone = from.replace(/\D/g, '');
  const r = UrlFetchApp.fetch(api + '/campaigns', { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: headers, payload: JSON.stringify(payload) });
  Logger.log('SimpleTexting campaign → %s: %s %s', list, r.getResponseCode(), r.getContentText().slice(0, 200));
  if (r.getResponseCode() >= 300) return { ok: false, error: 'SimpleTexting ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200) };
  const res = { ok: true, sent: true, list: list, contacts: contacts, campaignId: (JSON.parse(r.getContentText() || '{}') || {}).id || null };
  if (b.postId) {
    try {
      const sbUrl = props.getProperty('SUPABASE_URL'), sbKey = props.getProperty('SUPABASE_KEY');
      const m = UrlFetchApp.fetch(sbUrl + '/rest/v1/rpc/admin_post_reminded', { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey }, payload: JSON.stringify({ p_pass: props.getProperty('ADMIN_PASS'), p_id: Number(b.postId) }) });
      if (m.getResponseCode() >= 300) res.note = 'sent, but could not stamp the post (run supabase/repeat.sql)';
    } catch (e) { res.note = 'sent, but could not stamp the post: ' + (e && e.message); }
  }
  return res;
}

// The Leaders page sends its 12-hour session token, not the passphrase, so ask the database
// whether it is valid (any admin function will do). The passphrase itself is accepted too.
function isLeader_(pass) {
  if (!pass) return false;
  const props = PropertiesService.getScriptProperties();
  if (pass === props.getProperty('ADMIN_PASS')) return true;
  const sbUrl = props.getProperty('SUPABASE_URL'), sbKey = props.getProperty('SUPABASE_KEY');
  if (!sbUrl || !sbKey) return false;
  const res = UrlFetchApp.fetch(sbUrl + '/rest/v1/rpc/admin_notes_count', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey }, payload: JSON.stringify({ p_pass: pass }),
  });
  return res.getResponseCode() < 300;
}

// ---------------------------------------------------------------------------------------------
// Posts → calendar files on the site.
//   calendar.ics   the whole ward calendar: subscribe once (calendar.html) and Apple / Google /
//                  Outlook keep it fresh on their own — every approved event, and the last few
//                  weeks of past ones.
//   cal/<id>.ics   one event each, for the "Add to calendar" links on the home page and in the
//                  weekly email (Apple / Outlook; Google users get a calendar.google.com link).
//   e/<id>.html    one page per live post: e.html with the post's Open Graph tags (title, date, flyer)
//                  in the head, so the short link in a text reminder shows a preview with the flyer.
// Runs at the end of every syncMemberSheets and right away from the Leaders page (web app action
// "calendar") after a post is approved, edited, taken down or deleted. Only files whose content
// actually changed are committed, so a run with nothing new makes no commits at all.
// Times: posts hold Eastern wall-clock times; the files carry UTC instants, which every calendar
// understands without a VTIMEZONE block. A repeating post is one VEVENT with an RRULE (and an
// EXDATE per cancelled date), so subscribers get the whole series and see cancellations.
// EDIT THESE THREE for your ward — Apps Script has no browser `location`, so unlike the site's own
// code (which reads config.js at runtime), this script needs its site URL and ward name as constants.
const SITE = 'https://YOUR-WARD-SITE.example';
const CAL_TZ = 'America/New_York';
const CAL_NAME = 'Your Ward';
const CAL_PAST_DAYS = 60;        // past events stay in the subscribed calendar this long (admin_posts keeps ~60 days)
const CAL_LINK_PAST_DAYS = 7;    // cal/<id>.ics stays this long after the event, then the file goes
const CAL_DEFAULT_HOURS = 2;     // an event with a start time and no end time
const SITE_HOST = SITE.replace(/^https?:\/\//, '').replace(/\/$/, '');

function syncCalendar() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN'), sbUrl = props.getProperty('SUPABASE_URL'), sbKey = props.getProperty('SUPABASE_KEY'), adminPass = props.getProperty('ADMIN_PASS');
  if (!token || !sbUrl || !sbKey || !adminPass) throw new Error('Set GITHUB_TOKEN, SUPABASE_URL, SUPABASE_KEY and ADMIN_PASS under Project Settings → Script properties');
  const res = UrlFetchApp.fetch(sbUrl + '/rest/v1/rpc/admin_posts', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey }, payload: JSON.stringify({ p_pass: adminPass }),
  });
  if (res.getResponseCode() >= 300) throw new Error('admin_posts → ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  const all = JSON.parse(res.getContentText() || '[]');
  const today = Utilities.formatDate(new Date(), CAL_TZ, 'yyyy-MM-dd');
  const dayIso = function (daysAgo) { return Utilities.formatDate(new Date(Date.now() - daysAgo * 864e5), CAL_TZ, 'yyyy-MM-dd'); };
  // a repeating post (supabase/repeat.sql) stays while its series is running
  const alive = function (p, cutoff) { return String(p.event_date).slice(0, 10) >= cutoff || (p.repeat && (!p.repeat_until || String(p.repeat_until).slice(0, 10) >= cutoff)); };
  const events = all.filter(function (p) { return p.status === 'approved' && p.event_date && alive(p, dayIso(CAL_PAST_DAYS)); })
    .sort(function (a, b) { return (a.event_date + (a.start_time || '')) < (b.event_date + (b.start_time || '')) ? -1 : 1; });
  const linked = events.filter(function (p) { return alive(p, dayIso(CAL_LINK_PAST_DAYS)); });
  const stamp = icsStamp_(new Date());
  const summary = { events: events.length, links: linked.length, written: [], deleted: [], unchanged: 0 };

  // what is on the site now (one listing call each; a missing folder is fine on the first run)
  const dir = ghGet_(token, 'cal'); const have = {};
  (Array.isArray(dir) ? dir : []).forEach(function (f) { if (f.type === 'file') have[f.name] = f.sha; });
  const pdir = ghGet_(token, 'e'); const havePage = {};
  (Array.isArray(pdir) ? pdir : []).forEach(function (f) { if (f.type === 'file') havePage[f.name] = f.sha; });
  const tplFile = ghGet_(token, 'e.html');
  const tpl = tplFile && tplFile.content ? Utilities.newBlob(Utilities.base64Decode(tplFile.content.replace(/\n/g, ''))).getDataAsString() : '';
  const cur = ghGet_(token, 'calendar.ics');
  if (cur && cur.content && gitBlobSha_(Utilities.newBlob(Utilities.base64Decode(cur.content.replace(/\n/g, ''))).getDataAsString()) !== cur.sha) Logger.log('Warning: the blob-sha check disagrees with GitHub, so unchanged files will be re-committed each run');

  const put = function (path, text, sha, message) {
    if (sha && sha === gitBlobSha_(text)) { summary.unchanged++; return; }
    ghPut_(token, path, Utilities.base64Encode(text, Utilities.Charset.UTF_8), message, sha || undefined);
    summary.written.push(path);
  };
  // 1. one file per upcoming event
  const keep = {};
  linked.forEach(function (p) {
    const name = p.id + '.ics'; keep[name] = true;
    put('cal/' + name, icsCalendar_([p], stamp, p.title), have[name], 'Calendar: ' + p.title);
  });
  // 2. files for events that are gone (past a week, taken down, deleted)
  Object.keys(have).forEach(function (name) {
    if (/\.ics$/.test(name) && !keep[name]) { ghDelete_(token, 'cal/' + name, have[name], 'Calendar: remove ' + name); summary.deleted.push('cal/' + name); }
  });
  // 2b. one page per live post (dated or not): e/<id>.html — e.html with the post's Open Graph tags,
  //     so the short link in a text reminder previews the flyer, title and date
  if (tpl) {
    const keepPage = {};
    all.filter(function (p) { return p.status === 'approved' && (!p.event_date ? Date.parse(p.created_at) > Date.now() - 30 * 864e5 : alive(p, dayIso(CAL_LINK_PAST_DAYS))); }).forEach(function (p) {
      const name = p.id + '.html'; keepPage[name] = true;
      put('e/' + name, eventPage_(tpl, p), havePage[name], 'Page: ' + p.title);
    });
    Object.keys(havePage).forEach(function (name) {
      if (/\.html$/.test(name) && !keepPage[name]) { ghDelete_(token, 'e/' + name, havePage[name], 'Page: remove ' + name); summary.deleted.push('e/' + name); }
    });
  } else Logger.log('e.html not found in the repo — no per-post pages written');
  // 3. the subscribable calendar
  put('calendar.ics', icsCalendar_(events, stamp, CAL_NAME), cur && cur.sha, 'Calendar: ' + events.length + ' events');
  Logger.log(JSON.stringify(summary));
  return summary;
}

function icsCalendar_(posts, stamp, name) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//' + icsText_(CAL_NAME) + '//' + SITE_HOST + '//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsText_(name || CAL_NAME), 'X-WR-TIMEZONE:' + CAL_TZ, 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  posts.forEach(function (p) { lines.push.apply(lines, icsEvent_(p, stamp)); });
  lines.push('END:VCALENDAR');
  return lines.map(icsFold_).join('\r\n') + '\r\n';
}
function icsEvent_(p, stamp) {
  const span = eventSpan_(p);
  // DTSTAMP = the post's last edit, not "now": the file only changes when the post does, so the
  // unchanged-file check can actually skip it (a fresh stamp every run meant a commit every run)
  const edited = Date.parse(p.updated_at || p.reviewed_at || p.created_at);
  const lines = ['BEGIN:VEVENT', 'UID:post-' + p.id + '@' + SITE_HOST, 'DTSTAMP:' + (edited ? icsStamp_(new Date(edited)) : stamp)];
  if (span.allDay) lines.push('DTSTART;VALUE=DATE:' + span.start, 'DTEND;VALUE=DATE:' + span.end);
  else lines.push('DTSTART:' + span.start, 'DTEND:' + span.end);
  const rule = rrule_(p); if (rule) lines.push('RRULE:' + rule);
  (p.skip_dates || []).forEach(function (d) {      // cancelled occurrences
    const iso = String(d).slice(0, 10);
    lines.push(span.allDay ? 'EXDATE;VALUE=DATE:' + iso.replace(/-/g, '') : 'EXDATE:' + icsStamp_(zonedToUtc_(iso, p.start_time)));
  });
  lines.push('SUMMARY:' + icsText_(p.title));
  if (p.location) lines.push('LOCATION:' + icsText_(p.location));
  const desc = [String(p.details || '').trim(), p.link ? 'Sign up / details: ' + p.link : '', p.flyer_url ? 'Flyer: ' + p.flyer_url : '', 'Everything, always up to date: ' + SITE].filter(Boolean).join('\n');
  lines.push('DESCRIPTION:' + icsText_(desc), 'URL:' + (p.link || SITE));
  const created = Date.parse(p.created_at), updated = Date.parse(p.updated_at || p.reviewed_at || p.created_at);
  if (created) lines.push('CREATED:' + icsStamp_(new Date(created)));
  if (updated) lines.push('LAST-MODIFIED:' + icsStamp_(new Date(updated)), 'SEQUENCE:' + Math.max(0, Math.floor((updated - created) / 60000)));
  lines.push('END:VEVENT');
  return lines;
}
// 'YYYY-MM-DD' + 'HH:MM[:SS]' Eastern -> { allDay, start, end } as calendar stamps (UTC, or dates)
function eventSpan_(p) {
  const iso = String(p.event_date).slice(0, 10), parts = iso.split('-').map(Number);
  if (!p.start_time) {
    const next = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1));
    return { allDay: true, start: iso.replace(/-/g, ''), end: Utilities.formatDate(next, 'UTC', 'yyyyMMdd') };
  }
  const start = zonedToUtc_(iso, p.start_time);
  let end = p.end_time ? zonedToUtc_(iso, p.end_time) : new Date(start.getTime() + CAL_DEFAULT_HOURS * 36e5);
  if (end <= start) end = new Date(end.getTime() + 864e5);     // runs past midnight
  return { allDay: false, start: icsStamp_(start), end: icsStamp_(end) };
}
function zonedToUtc_(iso, time) {
  const d = iso.split('-').map(Number), t = String(time).split(':').map(Number);
  const naive = Date.UTC(d[0], d[1] - 1, d[2], t[0], t[1] || 0);            // the wall-clock time, read as if UTC
  const off = Utilities.formatDate(new Date(naive), CAL_TZ, 'Z');           // e.g. -0400 at that moment
  const mins = (off[0] === '-' ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3, 5)));
  return new Date(naive - mins * 60000);
}
// e.html with the post's Open Graph tags in the head and the id preset: what iMessage / WhatsApp /
// Facebook read (without running any script) to show the flyer, title and date under a link.
function eventPage_(tpl, p) {
  const esc = function (s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  const desc = [whenText_(p), p.location].filter(Boolean).join(' · ') || String(p.details || '').replace(/\s+/g, ' ').slice(0, 160);
  const tags = [
    '<meta property="og:site_name" content="' + esc(CAL_NAME) + '">',
    '<meta property="og:type" content="article">',
    '<meta property="og:url" content="' + SITE + '/e/' + p.id + '">',
    '<meta property="og:title" content="' + esc(p.title) + '">',
    '<meta property="og:description" content="' + esc(desc) + '">',
    '<meta name="description" content="' + esc(desc) + '">',
    p.flyer_url ? '<meta property="og:image" content="' + esc(p.flyer_url) + '">' : '',
    p.flyer_url ? '<meta name="twitter:card" content="summary_large_image">' : '',
    p.flyer_url ? '<meta name="twitter:image" content="' + esc(p.flyer_url) + '">' : '',
    '<script>window.NP_POST_ID = ' + Number(p.id) + ';</script>',
  ].filter(Boolean).join('\n  ');
  return tpl.replace('<title>Ward</title>', '<title>' + esc(p.title) + ' · ' + esc(CAL_NAME) + '</title>').replace('<!--og-->', tags);
}
// 'Saturday, Sep 26 · 6 – 9 PM' / 'Every Tuesday · 7 PM' / '' for a notice
function whenText_(p) {
  if (!p.event_date) return '';
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = String(p.event_date).slice(0, 10).split('-').map(Number), dow = new Date(Date.UTC(d[0], d[1] - 1, d[2])).getUTCDay();
  const t = function (v) { if (!v) return ''; const h = Number(String(v).slice(0, 2)), m = Number(String(v).slice(3, 5)); return (((h + 11) % 12) + 1) + (m ? ':' + ('0' + m).slice(-2) : '') + ' ' + (h >= 12 ? 'PM' : 'AM'); };
  let time = t(p.start_time); if (time && p.end_time) { const e = t(p.end_time); time = time.slice(-2) === e.slice(-2) ? time.slice(0, -3) + ' – ' + e : time + ' – ' + e; }
  let day;
  if (p.repeat === 'weekly') day = 'Every ' + DAYS[dow];
  else if (p.repeat === 'biweekly') day = 'Every other ' + DAYS[dow];
  else if (p.repeat === 'monthly') day = 'Every ' + ['1st', '2nd', '3rd', '4th', 'last'][Math.min(5, Math.ceil(d[2] / 7)) - 1] + ' ' + DAYS[dow];
  else day = DAYS[dow] + ', ' + MON[d[1] - 1] + ' ' + d[2];
  return day + (time ? ' · ' + time : '');
}
// weekly / every 2 weeks / monthly on the same weekday (1st Tuesday…), optionally until a date
function rrule_(p) {
  if (!p.repeat) return '';
  const d = String(p.event_date).slice(0, 10).split('-').map(Number), BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const dow = new Date(Date.UTC(d[0], d[1] - 1, d[2])).getUTCDay(), ord = Math.min(5, Math.ceil(d[2] / 7));
  let rule = p.repeat === 'monthly' ? 'FREQ=MONTHLY;BYDAY=' + (ord === 5 ? -1 : ord) + BYDAY[dow] : 'FREQ=WEEKLY;' + (p.repeat === 'biweekly' ? 'INTERVAL=2;' : '') + 'BYDAY=' + BYDAY[dow];
  if (p.repeat_until) { const u = String(p.repeat_until).slice(0, 10); rule += ';UNTIL=' + (p.start_time ? icsStamp_(zonedToUtc_(u, '23:59')) : u.replace(/-/g, '')); }
  return rule;
}
function icsStamp_(d) { return Utilities.formatDate(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'"); }
function icsText_(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsFold_(line) {   // RFC 5545: lines over 75 octets continue on the next line after a space
  const out = []; let l = line;
  while (l.length > 72) { out.push(l.slice(0, 72)); l = ' ' + l.slice(72); }
  out.push(l); return out.join('\r\n');
}
// git's own id for a file's content, so unchanged files are skipped without an extra download
function gitBlobSha_(text) {
  const body = Utilities.newBlob(text).getBytes();
  const head = Utilities.newBlob('blob ' + body.length + '\0').getBytes();
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, head.concat(body)).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

// ---------- helpers ----------

function htmlToText_(h) {
  h = h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n');
  h = h.replace(/<li[^>]*>/gi, '• ');
  h = h.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, function (m, href, inner) {
    const label = inner.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
    href = href.replace(/&amp;/g, '&');
    if (/^mailto:/i.test(href)) return label;
    return label && href.indexOf(label) === -1 ? label + ' ' + href : href;
  });
  h = h.replace(/<[^>]+>/g, '');
  h = h.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  h = h.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return h.trim();
}

function cleanText_(t) {
  t = t.replace(/\n-{5,}\s*\nYou received this email because[\s\S]*$/, '');
  t = t.replace(/\nYou received this email because[\s\S]*$/, '');
  t = t.replace(/^(The Church of Jesus Christ of Latter-day Saints\s*\n+)?(North ?Point YSA Ward\s*\n+)?/i, '');
  return t.trim();
}

function ghFetch_(token, method, path, payload) {
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/contents/' + path + (method === 'get' ? '?ref=' + BRANCH : ''), {
    method: method,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    contentType: 'application/json',
    payload: payload ? JSON.stringify(payload) : undefined,
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 404 && method === 'get') return null;
  if (code >= 300) throw new Error('GitHub ' + method + ' ' + path + ' → ' + code + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText() || '{}');
}
function ghGet_(token, path) { return ghFetch_(token, 'get', path); }
function ghPut_(token, path, base64, message, sha) {
  if (!sha) { const cur = ghGet_(token, path); if (cur && cur.sha) sha = cur.sha; }
  const body = { message: message, content: base64, branch: BRANCH };
  if (sha) body.sha = sha;
  return ghFetch_(token, 'put', path, body);
}
function ghDelete_(token, path, sha, message) { return ghFetch_(token, 'delete', path, { message: message, sha: sha, branch: BRANCH }); }
