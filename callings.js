/*
 * Leaders › Callings — the "members without callings" meeting tool.
 *
 * Reads what is mirrored into the database (supabase/sheets.sql):
 *   lcr_callings – LCR's "Members without Callings" custom report: the base list (who is without
 *                  a calling right now, with age, city, phone, email, recommend, RM, move-in date)
 *   callings     – the leaders' "Members without Callings" Google Sheet: the NOTES (proposed
 *                  calling, who texts, answer, sustained, warnings…), attached to each LCR person
 *   newmember    – the "New Member Form" responses (how each person moved into the ward)
 * matches each person to the LCR roll (for attendance), and shows it two ways:
 *   • a list you can filter/search and click into
 *   • a meeting deck: one person per slide, ← → to move through everyone
 *
 * admin.html calls NPCallings.init({ getPass, getMembers }) once the leader is signed in.
 */
window.NPCallings = (function () {
  const { C, rpc, el, toast, fmtDate, escapeHtml } = NP;
  const $ = id => document.getElementById(id);

  let ctx = null;
  let sheets = {};           // key -> { headers, rows, updated_at, source_url, title }
  let people = [];           // built from the callings sheet, in sheet order
  let view = [];             // people after filter + search
  let attendance = new Map();// member_id -> Map(date -> Set(class))
  let sundays = [];          // last N Sundays, oldest → newest (YYYY-MM-DD)
  let edits = [];            // rows from callings_edits (site-side edits waiting for / written to the sheet)
  let settings = {};         // settings rows (message templates, due-day thresholds)
  let filter = 'all', query = '', deckAt = -1, loaded = false, loading = null;
  const savingToSheet = new Set();  // sheet names with a Google Sheet write in flight

  // ---------- helpers ----------
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\(.*?\)/g, ' ').replace(/[^a-z' -]/g, ' ').replace(/\s+/g, ' ').trim();
  const truthy = v => !!String(v || '').trim();
  const yes = v => /^\s*y(es)?\b/i.test(String(v || ''));
  function lev(a, b) {
    const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  function parseDate(s) {
    if (!s) return null;
    const d = new Date(String(s).trim());
    return isNaN(d) ? null : d;
  }
  const fmtShort = d => d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  // "new" = moved in within this many days, by LCR's Move In Date
  const NEW_DAYS = 30;
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  // LCR dates come as "3 Nov 2024"; also accepts 9/13/2026 and 2026-09-13. Local midnight or null.
  function parseDay(s) {
    s = String(s || '').trim(); let m;
    if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/))) { const mo = MONTHS[m[2].toLowerCase()]; return mo == null ? null : new Date(+m[3], mo, +m[1]); }
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) return new Date(+(m[3].length === 2 ? '20' + m[3] : m[3]), +m[1] - 1, +m[2]);
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return new Date(+m[1], +m[2] - 1, +m[3]);
    return null;
  }
  function rowObj(sheet, row) { const o = {}; sheet.headers.forEach((h, i) => { if (h) o[h] = row[i] || ''; }); return o; }
  function col(o, re) { const k = Object.keys(o).find(h => re.test(h)); return k ? o[k] : ''; }

  function lastSundays(n) {
    const out = []; let d = NP.currentMeetingDate();
    for (let i = 0; i < n; i++) { out.unshift(d); const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - 7); d = t.toISOString().slice(0, 10); }
    return out;
  }

  // ---------- matching people across the three sources ----------
  function buildIndexes(members) {
    // LCR: "Last, First Middle" -> keys "first|last"
    const byKey = new Map(), byLast = new Map();
    // active members first so they win over a same-name record that has left the ward
    for (const m of [...members].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0))) {
      const [last, rest] = String(m.name).split(/,\s*/);
      const first = norm(rest).split(' ')[0], ln = norm(last);
      if (!first || !ln) continue;
      // multi-word last names ("Orozco Lopez", "Figueroa Duarte") are also findable by either word
      const lasts = new Set([ln, ...ln.split(' ').filter(w => w.length > 2)]);
      for (const l of lasts) {
        if (!byKey.has(first + '|' + l)) byKey.set(first + '|' + l, m);
        if (!byLast.has(l)) byLast.set(l, []);
        byLast.get(l).push({ first, m });
      }
    }
    function findMember(nameVariants) {
      for (const [first, last] of nameVariants) {
        const hit = byKey.get(first + '|' + last); if (hit) return hit;
      }
      for (const [first, last] of nameVariants) {
        const cands = byLast.get(last) || [];
        const close = cands.filter(c => c.first.startsWith(first.slice(0, 3)) || first.startsWith(c.first.slice(0, 3)) || lev(c.first, first) <= 2);
        if (close.length === 1) return close[0].m;
      }
      return null;
    }
    return { findMember };
  }
  // a last name as written, plus each part of a hyphenated / two-word one ("esparza-pulido" → also "esparza", "pulido")
  function lastParts(last) {
    const whole = norm(last); if (!whole) return [];
    const out = [whole]; const parts = whole.split(/[\s-]+/).filter(w => w.length > 2);
    if (parts.length > 1) parts.forEach(w => { if (!out.includes(w)) out.push(w); });
    return out;
  }
  // "First [Middle] Last Last" -> every [first, last] split worth trying
  function splits(fullName) {
    const t = norm(fullName).split(' ').filter(Boolean);
    if (t.length < 2) return t.length ? [[t[0], '']] : [];
    const out = [];
    for (let i = 1; i < t.length; i++) out.push([t[0], t.slice(i).join(' ')]);
    out.push([t[0], t[t.length - 1]]);
    return out;
  }

  function build() {
    const members = ctx.getMembers();
    const idx = buildIndexes(members);
    const cs = sheets.callings, ns = sheets.newmember;
    people = [];
    if (!cs) return;

    // new-member form responses grouped by name, newest first
    const forms = new Map();
    if (ns) {
      for (const row of ns.rows) {
        const o = rowObj(ns, row);
        const first = col(o, /^first name/i), last = col(o, /^last name/i), pref = col(o, /^preferred name/i);
        if (!truthy(first) && !truthy(last)) continue;
        // "Esparza-Pulido" on the form should still find "Michelle Esparza" on the sheet / in LCR, so a
        // hyphenated or two-word last name is keyed by the whole and by each part
        const lasts = lastParts(last);
        const keys = new Set(lasts.map(l => norm(first).split(' ')[0] + '|' + l));
        if (truthy(pref) && !/^(no|n\/a|none)\b/i.test(pref)) lasts.forEach(l => keys.add(norm(pref).split(' ')[0] + '|' + l));
        const rec = { o, when: parseDate(col(o, /^timestamp/i)), member: idx.findMember([...keys].map(k => k.split('|'))) };
        for (const k of keys) { if (!forms.has(k)) forms.set(k, []); forms.get(k).push(rec); }
      }
      for (const list of forms.values()) list.sort((a, b) => (b.when || 0) - (a.when || 0));
    }

    // the leaders' sheet rows (notes), keyed so they can be attached to LCR people by name
    const sheetRows = [];
    let section = '';
    cs.rows.forEach((row, i) => {
      const o = rowObj(cs, row);
      const rawName = o.NAME || row[0] || '';
      if (!truthy(rawName)) return;
      const rest = row.slice(1).some(truthy);
      if (!rest && /^new additions/i.test(rawName)) { section = rawName.replace(/^new additions\s*(since)?\s*/i, 'New since '); return; }
      if (!rest && rawName === rawName.toUpperCase() && rawName.length > 12) { section = rawName; return; }
      sheetRows.push({ i, rawName, name: rawName.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim(), tag: (rawName.match(/\((.*?)\)/) || [])[1] || '', section, o, variants: splits(rawName), used: false });
    });
    const findSheetRow = (variants) => {
      for (const [f, l] of variants) { const hit = sheetRows.find(r => !r.used && r.variants.some(([f2, l2]) => f2 === f && l2 === l)); if (hit) return hit; }
      for (const [f, l] of variants) { const hits = sheetRows.filter(r => !r.used && r.variants.some(([f2, l2]) => l2 === l && (f2.startsWith(f.slice(0, 3)) || f.startsWith(f2.slice(0, 3)) || lev(f2, f) <= 2))); if (hits.length === 1) return hits[0]; }
      return null;
    };
    const findForm = (variants, member) => {
      for (const [f, l] of variants) for (const lp of lastParts(l)) { if (forms.has(f + '|' + lp)) return forms.get(f + '|' + lp); }
      if (member) { const [last, restName] = String(member.name).split(/,\s*/); const f = norm(restName).split(' ')[0]; for (const lp of lastParts(last)) { if (forms.has(f + '|' + lp)) return forms.get(f + '|' + lp); } }
      return null;
    };
    const sheetAt = cs.updated_at ? new Date(cs.updated_at) : new Date(0);
    const editByName = new Map(edits.map(e => [norm(e.name), e])), editByUuid = new Map(edits.filter(e => e.lcr_uuid).map(e => [e.lcr_uuid, e]));
    const mk = (name, sr, lcr, member, variants) => {
      const o = Object.assign({}, sr ? sr.o : {});
      const tag = sr ? sr.tag : '';
      const sheetName = sr ? sr.rawName : name;
      // site-side edits win over the sheet copy until the Apps Script has written them into the sheet
      const ed = (lcr && editByUuid.get(lcr['Person UUID'])) || (member && editByUuid.get(member.lcr_uuid)) || editByName.get(norm(sheetName)) || editByName.get(norm(name));
      const pending = !!(ed && (!ed.synced_at || new Date(ed.updated_at) > sheetAt));
      if (pending || !sr) for (const [k, v] of Object.entries((ed && ed.edits) || {})) o[k] = v == null ? '' : v;  // null = cleared on purpose; no sheet row = the site copy is all there is
      const notes = o['Other Notes'] || '';
      // Flag is its own column (Warning / Magnet) — the only place it comes from. Other Notes is free text
      // and is never read for meaning (a note like "removed from warning list" must not flag anyone).
      const flag = /^(warning|magnet)$/i.test(o.Flag || '') ? o.Flag.replace(/^\w/, c => c.toUpperCase()) : '';
      // tags come from the sheet's name suffix only, e.g. "Shane Woods (aged out)"
      const tags = [];
      if (/moved|moving/i.test(tag)) tags.push('Move');
      if (/aged out/i.test(tag)) tags.push('Aged out');
      // when the warning / magnet message went out, and whether enough days have passed to move the records
      const sentM = String(o['Flag sent'] || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      const sentAt = sentM ? new Date(+(sentM[3].length === 2 ? '20' + sentM[3] : sentM[3]), +sentM[1] - 1, +sentM[2]) : null;
      const sentDays = sentAt ? Math.floor((Date.now() - sentAt.getTime()) / 864e5) : null;
      const dueDays = flag ? dueDaysFor(flag) : null;
      const movedIn = lcr ? parseDay(lcr['Move In Date']) : null;
      const movedDays = movedIn ? Math.floor((Date.now() - movedIn.getTime()) / 864e5) : null;
      const isNew = movedDays !== null && movedDays >= 0 && movedDays <= NEW_DAYS;
      return { name, sheetName, tag, section: sr ? sr.section : '', movedIn, movedDays, isNew, o, lcr, member, forms: findForm(variants, member) || [], notes, onSheet: !!sr, pending, editedAt: ed ? ed.updated_at : null,
        deleted: !!(ed && ed.deleted && !(sr && ed.synced_at && sheetAt > new Date(ed.synced_at))), flag, flagSent: o['Flag sent'] || '', sentAt, sentDays, dueDays, due: !!(flag && sentDays !== null && sentDays >= dueDays), tags,
        flagged: !!flag || tags.length > 0,
        proposed: o['Proposed calling'] || '', assignment: o['text assignment / calling'] || '',
        texted: o['texted'] || '', answer: o['answer'] || '', sustained: o['sustained'] || '' };
    };

    const ls = sheets.lcr_callings;
    if (ls && ls.rows.length) {
      // LCR's report is the truth for WHO is without a calling; the sheet supplies the notes.
      const byUuid = new Map(members.map(m => [m.lcr_uuid, m]));
      for (const row of ls.rows) {
        const l = rowObj(ls, row);
        const lcrName = l['Preferred Name'] || ''; if (!truthy(lcrName)) continue;
        const [last, rest] = lcrName.split(/,\s*/);
        const name = ((rest || '').split(' ')[0] + ' ' + (last || '')).trim();
        const variants = [[norm(rest).split(' ')[0], norm(last)], ...norm(last).split(' ').filter(w => w.length > 2).map(w => [norm(rest).split(' ')[0], w])];
        const member = byUuid.get(l['Person UUID']) || idx.findMember(variants);
        const sr = findSheetRow(variants); if (sr) sr.used = true;
        people.push(mk(name, sr, l, member, variants));
      }
      // people still on the sheet but no longer on LCR's report (got a calling, or moved)
      for (const sr of sheetRows) {
        if (sr.used) continue;
        const member = idx.findMember(sr.variants);
        const p = mk(sr.name, sr, null, member, sr.variants); p.sheetOnly = true; people.push(p);
      }
    } else {
      for (const sr of sheetRows) { const member = idx.findMember(sr.variants); people.push(mk(sr.name, sr, null, member, sr.variants)); }
    }
    // People who exist only as a pending site edit so far — flagged from Leaders › Members before
    // the Google Sheet has their row. They show as pending until the sheet copy comes back with them.
    const have = new Set(people.flatMap(p => [norm(p.sheetName), norm(p.name)]));
    for (const e of edits) {
      if (e.deleted || have.has(norm(e.name))) continue;
      if (e.synced_at && !(new Date(e.updated_at) > sheetAt)) continue;        // synced long ago and gone from the sheet since: not ours to resurrect
      const variants = splits(e.name);
      const member = (e.lcr_uuid && members.find(m => m.lcr_uuid === e.lcr_uuid)) || idx.findMember(variants);
      const p = mk(e.name, null, null, member, variants); p.editOnly = true; people.push(p);
    }
  }

  function status(p) {
    if (isTicked(p.sustained)) return { k: 'ok', t: 'Sustained' };
    if (/accept|^\s*y(es)?\s*$/i.test(p.answer)) return { k: 'ok', t: 'Accepted' };
    if (truthy(p.answer)) return { k: 'need', t: /declin|not at this time|moved|not in ward|undeliverable/i.test(p.answer) ? 'Declined' : 'Answered' };
    if (isTicked(p.texted)) return { k: 'wait', t: 'Texted' };
    if (truthy(p.proposed) || truthy(p.assignment)) return { k: 'wait', t: 'Proposed' };
    return { k: 'off', t: 'Nothing yet' };
  }
  const FILTERS = {
    all: { label: 'Everyone', test: p => !p.sheetOnly && !p.deleted },
    none: { label: 'Nothing proposed', test: p => !p.sheetOnly && !p.deleted && !truthy(p.proposed) && !truthy(p.assignment) && !p.flag },
    waiting: { label: 'Proposed, waiting', test: p => !p.sheetOnly && !p.deleted && (truthy(p.proposed) || truthy(p.assignment)) && !isTicked(p.sustained) && !/accept/i.test(p.answer) },
    // flags follow the person, calling or not (someone flagged from Leaders › Members may well have one)
    warning: { label: 'Warning', test: p => !p.deleted && p.flag === 'Warning' },
    magnet: { label: 'Magnet', test: p => !p.deleted && p.flag === 'Magnet' },
    due: { label: 'Ready to move out', test: p => !p.deleted && p.due },
    other: { label: 'Other notes', test: p => !p.sheetOnly && !p.deleted && !p.flag && truthy(p.notes) },
    new: { label: 'New / not on sheet', test: p => !p.sheetOnly && !p.deleted && (p.isNew || !p.onSheet) },
    hasCalling: { label: 'Has a calling?', test: p => !!p.sheetOnly && !!(p.member && p.member.active) },
    sheetOnly: { label: 'Not in LCR', test: p => !!p.sheetOnly && !(p.member && p.member.active) },
    removed: { label: 'Removed / left off', test: p => !!p.deleted },
  };
  const FLAG_CLASS = { Warning: 'flag', Magnet: 'magnet' };
  const DUE_DEFAULT = { Warning: 21, Magnet: 7 };
  function dueDaysFor(flag) { const v = parseInt(settings['flag_due_days_' + flag.toLowerCase()], 10); return isNaN(v) ? DUE_DEFAULT[flag] : v; }
  function sentLabel(p) {
    if (!p.flag) return '';
    if (p.sentDays === null) return truthy(p.flagSent) ? 'sent ' + p.flagSent : 'not sent yet';
    const ago = p.sentDays === 0 ? 'today' : p.sentDays === 1 ? 'yesterday' : p.sentDays + ' days ago';
    return `sent ${p.sentAt.getMonth() + 1}/${p.sentAt.getDate()} · ${ago}` + (p.due ? ' · ready to move' : ` · move after ${p.dueDays}d`);
  }
  function flagPill(p, opts) {
    if (!p.flag) return null;
    return el('span', { class: 'pill ' + FLAG_CLASS[p.flag], title: p.flagSent ? 'Message sent ' + p.flagSent : '' }, p.flag + (opts && opts.long && p.flagSent ? ' · sent ' + p.flagSent : ''));
  }
  function sheetOnlyPill(p) {
    if (!p.sheetOnly) return null;
    const inLcr = p.member && p.member.active;
    return el('span', { class: 'pill ' + (inLcr ? 'ok' : 'warn'), title: inLcr ? 'On the roll but no longer on LCR\'s no-calling report — probably has a calling now' : 'Not on the LCR roll (records moved out or never here)' }, inLcr ? 'Has a calling?' : 'Not in LCR');
  }

  function attFor(p) {
    const rows = p.member ? attendance.get(p.member.id) : null;
    return sundays.map(d => ({ d, ss: !!(rows && rows.get(d) && rows.get(d).has('sunday_school')), prs: !!(rows && rows.get(d) && rows.get(d).has('priesthood_rs')) }));
  }
  function attDots(p, n) {
    const a = attFor(p).slice(-n);
    return el('span', { class: 'att-dots', title: 'Last ' + n + ' Sundays' }, a.map(x => el('i', { class: 'dot' + (x.ss && x.prs ? ' both' : (x.ss || x.prs ? ' one' : '')), title: fmtDate(x.d, { weekday: undefined }) + (x.ss ? ' · SS' : '') + (x.prs ? ' · P/RS' : '') })));
  }

  // ---------- list view ----------
  function applyFilter() {
    const q = norm(query);
    view = people.filter(p => FILTERS[filter].test(p) && (!q || norm(p.name).includes(q)));
    // flag views: longest-sent first, then flagged-but-not-sent
    if (filter === 'warning' || filter === 'magnet' || filter === 'due') view.sort((a, b) => (b.sentDays === null ? -1 : b.sentDays) - (a.sentDays === null ? -1 : a.sentDays));
  }
  function renderList() {
    applyFilter();
    const box = $('cal-list'); box.innerHTML = '';
    const chips = $('cal-filters'); chips.innerHTML = '';
    for (const [k, f] of Object.entries(FILTERS)) {
      const n = people.filter(f.test).length;
      chips.appendChild(el('button', { class: 'chip' + (filter === k ? ' on' : ''), onclick: () => { filter = k; renderList(); } }, `${f.label} · ${n}`));
    }
    const cs = sheets.callings;
    const ls = sheets.lcr_callings, when = d => new Date(d).toLocaleString('en-US', { timeZone: C.timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const nPending = people.filter(p => p.pending && !p.deleted).length, nDel = people.filter(p => p.deleted).length;
    $('cal-meta').textContent = (ls ? `${people.filter(p => !p.sheetOnly).length} without a calling · LCR report ${when(ls.updated_at)} · sheet ${cs ? when(cs.updated_at) : '—'}` : (cs ? `${people.length} people · sheet updated ${when(cs.updated_at)}` : '')) + (nPending ? ` · ${nPending} edit${nPending === 1 ? '' : 's'} waiting to go to the sheet` : '') + (nDel ? ` · ${nDel} row${nDel === 1 ? '' : 's'} to delete` : '');
    if (!view.length) { box.appendChild(el('p', { class: 'empty' }, people.length ? 'Nobody matches.' : 'No sheet data yet — run supabase/sheets.sql, then refresh the sheets.')); return; }
    // on the "New / not on sheet" view: one button to give everyone missing from the sheet a row
    const addable = filter === 'new' && C.sheetsRefreshUrl ? people.filter(p => !p.onSheet && p.lcr && !p.deleted && !p.pending).length : 0;
    if (addable) box.appendChild(el('div', { class: 'inline cal-bulk' }, [
      el('button', { class: 'chip add-sheet-btn', type: 'button', onclick: e => addAllToSheet(e.currentTarget) }, `Add all ${addable} not on the sheet`),
      el('span', { class: 'muted small' }, 'Makes a row for each of them on the Google Sheet, pre-filled from LCR and their move-in form.'),
    ]));
    // just the names and their tags — tap a row for the details (the slide)
    const list = el('div', { class: 'cal-list' });
    view.forEach((p, vi) => {
      const st = status(p);
      const pills = [
        el('span', { class: 'pill ' + st.k }, st.t),
        flagPill(p, { long: true }),
        p.due ? el('span', { class: 'pill due' }, 'Ready to move out') : null,
        ...p.tags.map(tg => el('span', { class: 'pill off' }, tg)),
        p.isNew ? el('span', { class: 'pill new', title: 'Moved in ' + fmtShort(p.movedIn) + ' (LCR)' }, 'new') : null,
        (!p.onSheet && p.lcr && !p.deleted) ? el('span', { class: 'pill new' }, 'not on sheet') : null,
        sheetOnlyPill(p),
        p.deleted ? el('span', { class: 'pill warn' }, p.onSheet ? 'Removed' : 'Left off the sheet') : null,
        p.pending && !p.deleted ? el('span', { class: 'pill wait' }, '✎ pending') : null,
        (!p.sheetOnly && p.member && !p.member.active) ? el('span', { class: 'pill warn' }, 'Records moved out') : null,
      ];
      list.appendChild(el('button', { class: 'cal-item' + (p.deleted ? ' deleted' : ''), type: 'button', onclick: () => openDeck(vi) }, [
        el('span', { class: 'cal-item-main' }, [el('b', {}, p.name), el('span', { class: 'row-pills' }, pills)]),
        el('span', { class: 'cal-chev' }, '›'),
      ]));
    });
    box.appendChild(list);
  }

  // ---------- meeting deck ----------
  const FORM_LABELS = [
    [/^timestamp/i, 'Filled out'], [/preferred name/i, 'Goes by'], [/birth ?date/i, 'Birthday'], [/phone/i, 'Phone'], [/email/i, 'Email'],
    [/live with your family/i, 'Lives with family'], [/have a car/i, 'Has a car'], [/current address/i, 'Address'], [/help getting to church/i, 'Needs a ride'],
    [/how long do you plan/i, 'Plans to be here'], [/apartment|roommates/i, 'Looking for housing'], [/currently hold a temple recommend/i, 'Temple recommend'],
    [/renew or get a temple/i, 'Wants a recommend'], [/priesthood/i, 'Priesthood'], [/serve a mission/i, 'Mission'], [/why you're here|why you’re here/i, 'Why here'],
    [/hobbies/i, 'Hobbies'], [/upload a current photo/i, 'Photo in LDS Tools'], [/sing or play/i, 'Music'], [/piano|organ/i, 'Piano / organ'], [/attach a current photo/i, 'Photo'],
  ];
  const SKIP_FORM = [/^first name/i, /^last name/i];
  function formLabel(h) { const m = FORM_LABELS.find(([re]) => re.test(h)); return m ? m[1] : h.replace(/\?.*$/, '').slice(0, 40); }
  function dl(pairs) {
    const d = el('dl', { class: 'facts' });
    for (const [k, v, opts] of pairs) {
      if (!truthy(v)) continue;
      const dd = el('dd', {});
      if (opts && opts.tel) dd.appendChild(el('a', { href: 'tel:' + String(v).replace(/\D/g, '') }, v));
      else if (opts && opts.mail) dd.appendChild(el('a', { href: 'mailto:' + v }, v));
      else if (opts && opts.link) dd.appendChild(el('a', { href: v, target: '_blank', rel: 'noopener' }, 'open'));
      else dd.textContent = v;
      if (opts && opts.big) dd.classList.add('big');
      d.appendChild(el('div', { class: 'fact' }, [el('dt', {}, k), dd]));
    }
    return d;
  }
  function slide(p) {
    const st = status(p);
    const o = p.o, L = p.lcr || {};
    const age = L.Age || o.AGE, city = L['Address - City'] ? L['Address - City'].replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()) : o.LOCATION;
    const head = el('div', { class: 'slide-head' }, [
      el('h1', {}, p.name),
      el('p', { class: 'slide-sub' }, [age ? age : null, city, truthy(L['Move In Date']) ? 'moved in ' + L['Move In Date'] : null, yes(L['Is Returned Missionary']) ? 'returned missionary' : null, yes(o.CAR) ? 'has a car' : (truthy(o.CAR) && /^n/i.test(o.CAR) ? 'no car' : null)].filter(Boolean).join('  ·  ')),
      (truthy(L['Individual Phone']) || truthy(L['Individual E-mail'])) ? el('p', { class: 'slide-contact' }, [
        truthy(L['Individual Phone']) ? el('a', { href: 'tel:' + L['Individual Phone'].replace(/\D/g, '') }, L['Individual Phone']) : null,
        truthy(L['Individual Phone']) && truthy(L['Individual E-mail']) ? '  ·  ' : null,
        truthy(L['Individual E-mail']) ? el('a', { href: 'mailto:' + L['Individual E-mail'] }, L['Individual E-mail']) : null,
      ]) : null,
      el('div', { class: 'badges' }, [
        el('span', { class: 'pill ' + st.k }, st.t),
        flagPill(p, { long: true }),
        p.due ? el('span', { class: 'pill due' }, 'Ready to move out') : null,
        ...p.tags.map(tg => el('span', { class: 'pill off' }, tg)),
        p.isNew ? el('span', { class: 'pill new' }, 'New · moved in ' + (p.movedDays === 0 ? 'today' : p.movedDays === 1 ? 'yesterday' : p.movedDays + ' days ago')) : null,
        (!p.onSheet && p.lcr && !p.deleted) ? el('span', { class: 'pill new' }, 'Not on the sheet yet') : null,
        sheetOnlyPill(p),
        p.deleted ? el('span', { class: 'pill warn' }, p.onSheet ? 'Removed' + (p.pending ? ' · coming off the sheet' : '') : 'Left off the sheet on purpose') : null,
        truthy(o['RECENT CONVERT (under yr)']) ? el('span', { class: 'pill recommend' }, 'Recent convert ' + (o['RECENT CONVERT (under yr)'].replace(/^yes\s*-?\s*/i, '').trim())) : null,
        p.tag ? el('span', { class: 'pill off' }, p.tag) : null,
        (!p.sheetOnly && p.member && !p.member.active) ? el('span', { class: 'pill warn' }, 'Records have moved out') : null,
      ]),
    ]);
    const calling = el('section', { class: 'slide-card calling' }, [
      el('h3', {}, ['Calling', el('span', { class: 'slide-actions' }, [
        p.deleted
          ? el('button', { class: 'chip remove-btn', type: 'button', onclick: () => setDeleted(p, false) }, p.onSheet ? 'Undo remove' : 'Back on the list')
          : (!p.onSheet && p.lcr)
            ? el('button', { class: 'chip remove-btn', type: 'button', title: 'They are on LCR\u2019s report on purpose without a sheet row: hide them from New / not on sheet and skip them in Add all', onclick: () => leaveOff(p) }, 'Leave off the sheet')
            : el('button', { class: 'chip remove-btn danger', type: 'button', title: 'Take this person off the callings list and delete their row from the Google Sheet', onclick: async () => { if (await ask(`Remove ${p.name} from the callings list?\n\nTheir row comes off the Members without Callings sheet, and they stay hidden here until LCR no longer lists them (records moved, or a calling recorded). You can undo from the “Removed / left off” filter.`)) setDeleted(p, true); } }, 'Remove'),
        (!p.deleted && !p.onSheet && p.lcr && !p.pending && C.sheetsRefreshUrl && !savingToSheet.has(p.sheetName)) ? el('button', { class: 'chip add-sheet-btn', type: 'button', title: 'Add a row for this person to the Members without Callings sheet, pre-filled from LCR and their move-in form', onclick: e => addToSheet(p, e.currentTarget) }, 'Add to sheet') : null,
        p.deleted ? null : el('button', { class: 'chip edit-btn', type: 'button', onclick: () => editCalling(p, calling) }, 'Edit'),
        p.pending && !p.deleted && C.sheetsRefreshUrl && !savingToSheet.has(p.sheetName) ? el('button', { class: 'chip save-sheet-btn', type: 'button', title: 'Write this person\u2019s edits into the Google Sheet now', onclick: e => saveToSheet(p, e.currentTarget) }, 'Save to sheet') : null,
      ])]),
      truthy(p.notes) ? el('p', { class: 'note-line' }, [el('span', { class: 'muted' }, 'Notes · '), p.notes]) : null,
      dl([['Proposed', p.proposed, { big: true }], ['Who texts', p.assignment], ['Texted', /^\s*y(es)?\s*$/i.test(p.texted) ? '✓ Yes' : p.texted], ['Answer', p.answer], ['Sustained', /^\s*y(es)?\s*$/i.test(p.sustained) ? '✓ Yes' : p.sustained]]),
      (p.deleted && !p.onSheet) ? el('p', { class: 'muted' }, 'Kept off the callings sheet on purpose — they don\u2019t count as “not on sheet” and Add all skips them. Back on the list undoes it.') : null,
      (!truthy(p.proposed) && !truthy(p.assignment) && !truthy(p.notes) && !p.deleted) ? el('p', { class: 'muted' }, p.onSheet ? 'Nothing proposed yet.' : p.pending ? 'Not on the callings sheet yet — their row goes in with Save to sheet or the next sync.' : 'Not on the callings sheet yet — Add to sheet makes their row (location, age and move-in form answers filled in), or saving an edit adds it.') : null,
      p.flag ? el('div', { class: 'flag-box ' + FLAG_CLASS[p.flag] }, [
        el('div', {}, [el('b', {}, p.flag + ': '), FLAG_MEANING[p.flag]]),
        el('div', { class: 'flag-actions' }, (() => {
          const sc = sentChannels(p), hasPhone = !!L['Individual Phone'], hasEmail = !!L['Individual E-mail'];
          const missing = truthy(p.flagSent) ? [hasPhone && !sc.text ? 'text' : null, hasEmail && !sc.email ? 'email' : null].filter(Boolean) : [];
          const avail = hasPhone && hasEmail ? ' (text + email)' : hasPhone ? ' (text)' : hasEmail ? ' (email)' : '';
          const when = p.due ? `Sent ${p.sentDays} days ago — past the ${p.dueDays}-day mark, ready to move their records`
            : p.sentDays !== null ? `Sent ${p.sentDays === 0 ? 'today' : p.sentDays === 1 ? 'yesterday' : p.sentDays + ' days ago'}${truthy(p.flagSent) && (sc.text !== sc.email) ? ` by ${sc.text ? 'text' : 'email'}` : ''} · move records after ${p.dueDays} days`
            : truthy(p.flagSent) ? 'Sent ' + p.flagSent : `Not sent yet · records move ${p.dueDays} days after sending`;
          return [
            // the channel that hasn't gone out yet gets its own button; "Send again" resends everything
            ...missing.map(ch => el('button', { class: 'chip', type: 'button', onclick: () => sendFlagMessage(p, ch) }, `Send the ${ch} too`)),
            (hasPhone || hasEmail) ? el('button', { class: 'chip' + (missing.length ? ' secondary' : ''), type: 'button', onclick: () => sendFlagMessage(p) }, (truthy(p.flagSent) ? 'Send again' : 'Send the ' + p.flag.toLowerCase() + ' message') + avail) : null,
            el('span', { class: p.due ? 'due-text' : 'muted' }, when + (missing.length ? ` · ${missing.join(' and ')} not sent yet` : '')),
          ];
        })().concat([
          (!L['Individual Phone'] && !L['Individual E-mail']) ? el('span', { class: 'muted' }, 'No phone or email in LCR') : null,
        ])),
      ]) : null,
      p.pending ? el('p', { class: 'muted small' }, savingToSheet.has(p.sheetName) ? 'Saving to the Google Sheet…' : C.sheetsRefreshUrl ? 'Edited here · not in the Google Sheet yet — Save to sheet, or it goes in with the next sync' : 'Edited here · goes into the Google Sheet on the next sync') : null,
    ]);
    const tr = truthy(L['Temple Recommend Status']) ? L['Temple Recommend Status'] + (truthy(L['Temple Recommend Type']) ? ' · ' + (/proxy/i.test(L['Temple Recommend Type']) ? 'limited-use' : L['Temple Recommend Type'].toLowerCase()) : '') : (p.lcr ? 'None' : '');
    const aboutPairs = [['Temple recommend', tr], ['Ministering brothers', L['Ministering Brothers']], ['Ministering sisters', L['Ministering Sisters']], ['Has children', yes(L['Has Children']) ? 'Yes' : ''],
      ['Length of stay', o['LENGTH OF STAY']], ['Why in Atlanta', o['PURPOSE IN ATL']], ['Mission', o.MISSION], ['Hobbies', o.HOBBIES], ['Music', o.MUSIC]];
    const about = el('section', { class: 'slide-card' }, [
      el('h3', {}, ['About', el('span', { class: 'muted', style: 'font-weight:400;font-size:13px' }, ' · from LCR and the sheet')]),
      dl(aboutPairs),
      aboutPairs.every(([, v]) => !truthy(v)) ? el('p', { class: 'muted' }, 'Nothing on the sheet yet.') : null,
    ]);
    const f = p.forms[0];
    let formCard;
    if (f) {
      const pairs = [];
      for (const [h, v] of Object.entries(f.o)) {
        if (!h || SKIP_FORM.some(re => re.test(h)) || !truthy(v)) continue;
        const label = formLabel(h);
        const opts = /phone/i.test(h) ? { tel: true } : /email/i.test(h) ? { mail: true } : /^https?:\/\//.test(v) ? { link: true } : null;
        pairs.push([label, /^timestamp/i.test(h) ? fmtShort(f.when) || v : v, opts]);
      }
      formCard = el('section', { class: 'slide-card form' }, [
        el('h3', {}, ['Move-in form', f.when ? el('span', { class: 'muted' }, ' · ' + fmtShort(f.when)) : null]),
        dl(pairs),
        p.forms.length > 1 ? el('p', { class: 'muted' }, `Also filled out ${p.forms.slice(1).map(x => fmtShort(x.when) || 'earlier').join(', ')}.`) : null,
      ]);
    } else {
      formCard = el('section', { class: 'slide-card form' }, [el('h3', {}, 'Move-in form'), el('p', { class: 'muted' }, 'No new-member form on file for this name.')]);
    }
    const a = attFor(p);
    const seen = a.filter(x => x.ss || x.prs);
    const attCard = el('section', { class: 'slide-card' }, [
      el('h3', {}, 'Attendance'),
      p.member && p.member.active ? el('div', { class: 'att-row' }, a.map(x => el('div', { class: 'att-cell' }, [
        el('i', { class: 'dot' + (x.ss && x.prs ? ' both' : (x.ss || x.prs ? ' one' : '')) }),
        el('span', { class: 'att-lbl' }, x.d.slice(5).replace('-', '/')),
        el('span', { class: 'att-cls' }, [x.ss ? 'SS' : '', x.ss && x.prs ? ' · ' : '', x.prs ? 'P/RS' : ''].join('')),
      ]))) : el('p', { class: 'muted' }, p.member ? 'Their membership record has left the ward, so the roll no longer lists them.' : 'Not on the LCR roll any more, so there are no check-ins to show.'),
      p.member && p.member.active ? el('p', { class: 'muted' }, seen.length ? `Checked in ${seen.length} of the last ${a.length} Sundays · last seen ${fmtDate(seen[seen.length - 1].d, { weekday: undefined })}` : `No check-ins in the last ${a.length} Sundays (site roll started Sept 6).`) : null,
    ]);
    return el('div', { class: 'slide' }, [head, el('div', { class: 'slide-grid' }, [el('div', { class: 'slide-col' }, [calling, about, attCard]), el('div', { class: 'slide-col' }, formCard)])]);
  }
  // ---------- editing the sheet columns ----------
  const EDIT_COLS = [['Flag', 'Flag', 'select'], ['Other Notes', 'Other notes', 'textarea'], ['Proposed calling', 'Proposed calling', 'input'], ['text assignment / calling', 'Who texts', 'input'], ['texted', 'Texted', 'checkbox'], ['answer', 'Answer', 'input'], ['sustained', 'Sustained', 'checkbox'], ['Flag sent', 'Flag message sent', 'datecheck']];
  // "texted" / "sustained" on the sheet are Y / y / yes (or a name or date); anything but blank / N counts as ticked
  // A yes/no dialog; waits a beat afterwards because Safari can drop a request fired straight after a dialog closes ("Load failed").
  async function ask(msg) { const ok = confirm(msg); if (ok) await new Promise(r => setTimeout(r, 150)); return ok; }
  const isTicked = v => truthy(v) && !/^\s*(n|no)\s*$/i.test(v);
  const todayMDY = () => new Date().toLocaleDateString('en-US', { timeZone: C.timeZone, month: 'numeric', day: 'numeric', year: 'numeric' });
  const FLAG_MEANING = {
    Warning: 'attending here is optional — if they don\'t start coming, their records go back to their home ward.',
    Magnet: 'came in without a new-member meeting — records are being sent back to their previous ward.',
  };
  function editCalling(p, card) {
    const fields = EDIT_COLS.map(([key, label, kind]) => {
      let input;
      if (kind === 'select') {
        input = el('select', { class: 'edit-field', 'data-key': key }, [el('option', { value: '' }, 'No flag'), el('option', { value: 'Warning' }, 'Warning — may be sent back if they don\'t attend'), el('option', { value: 'Magnet' }, 'Magnet — being sent back (no new-member meeting)')]);
        input.value = p.flag || '';
      } else if (kind === 'checkbox' || kind === 'datecheck') {
        // datecheck: ticking it fills in today's date (the send button does this automatically)
        input = el('input', { type: 'checkbox', class: 'edit-field edit-check', 'data-key': key, 'data-orig': p.o[key] || '', 'data-kind': kind });
        input.checked = isTicked(p.o[key]);
        const orig = p.o[key] || '';
        const hint = orig && !/^\s*y(es)?\s*$/i.test(orig) ? ' (' + orig + ')' : kind === 'datecheck' ? ' (ticking it records today\u2019s date)' : '';
        return el('label', { class: 'edit-row check' }, [el('span', {}, label), el('span', { class: 'check-wrap' }, [input, el('span', { class: 'muted' }, hint)])]);
      } else {
        input = el(kind, { class: 'edit-field', 'data-key': key, placeholder: label });
        input.value = p.o[key] || '';
      }
      return el('label', { class: 'edit-row' }, [el('span', {}, label), input]);
    });
    const msg = el('span', { class: 'muted' });
    const form = el('form', { class: 'edit-form', onsubmit: async e => {
      e.preventDefault();
      const values = {}; let changed = false;
      // a cell someone emptied on purpose is sent as null; a blank string is never written over
      // something already in the sheet, so nothing gets wiped by accident
      const set = (k, v) => { values[k] = v === '' ? null : v; changed = true; };
      for (const f of form.querySelectorAll('.edit-field')) {
        const orig = p.o[f.dataset.key] || '';
        if (f.type === 'checkbox') {
          if (f.checked === isTicked(orig)) continue;  // untouched
          // ticking keeps whatever was there (a name, a date) or becomes Y — today's date for "Flag sent"; unticking clears the cell
          set(f.dataset.key, f.checked ? (isTicked(orig) ? orig : f.dataset.kind === 'datecheck' ? todayMDY() : 'Y') : '');
        } else if (f.value.trim() !== orig) set(f.dataset.key, f.value.trim());
      }
      if (!changed) { cancel(); return; }
      msg.textContent = 'Saving…';
      try {
        await rpc('admin_callings_edit', { p_pass: ctx.getPass(), p_name: p.sheetName, p_lcr_uuid: (p.lcr && p.lcr['Person UUID']) || (p.member && p.member.lcr_uuid) || null, p_values: values, p_by: null });
        edits = await rpc('admin_callings_edits', { p_pass: ctx.getPass() });
        const keep = p.sheetName;
        build(); applyFilter();
        const at = view.findIndex(x => x.sheetName === keep);
        if (at >= 0) deckAt = at; else { filter = 'all'; applyFilter(); deckAt = Math.max(0, view.findIndex(x => x.sheetName === keep)); }
        renderList(); renderDeck();
        if (C.sheetsRefreshUrl) { toast('Saved — writing it to the Google Sheet…'); saveToSheet(p, null, true); }  // background; the slide updates when it lands
        else toast('Saved — it goes into the Google Sheet on the next sync');
      } catch (err) { msg.textContent = /admin_callings_edit/.test(err.message) ? 'Run supabase/edits.sql in Supabase first.' : 'Not saved: ' + err.message; }
    } }, [
      ...fields,
      el('div', { class: 'edit-actions' }, [el('button', { class: 'btn small', type: 'submit' }, 'Save'), el('button', { class: 'btn small secondary', type: 'button', onclick: () => cancel() }, 'Cancel'), msg]),
    ]);
    const prev = [...card.childNodes];
    function cancel() { card.innerHTML = ''; prev.forEach(n => card.appendChild(n)); }
    card.innerHTML = ''; card.appendChild(el('h3', {}, 'Calling')); card.appendChild(form);
    form.querySelector('.edit-field').focus();
  }

  // Someone on LCR's report who is deliberately not on the sheet: note why (optional), then mark
  // them the same way Remove does — hidden from the working views, skipped by Add all, undo from
  // the Removed / left off filter. No sheet row is touched because there isn't one.
  async function leaveOff(p) {
    const reason = prompt(`Keep ${p.name} off the callings sheet?\n\nWhy, in a few words (optional — it shows on their card):`, p.notes || '');
    if (reason === null) return;
    await new Promise(r => setTimeout(r, 150));
    try {
      if (reason.trim() && reason.trim() !== (p.notes || '').trim()) await rpc('admin_callings_edit', { p_pass: ctx.getPass(), p_name: p.sheetName, p_lcr_uuid: (p.lcr && p.lcr['Person UUID']) || null, p_values: { 'Other Notes': reason.trim().slice(0, 500) }, p_by: null });
    } catch (e) { toast('Could not save the note: ' + e.message, 4000); return; }
    await setDeleted(p, true);
  }
  async function setDeleted(p, del) {
    try {
      await rpc('admin_callings_delete', { p_pass: ctx.getPass(), p_name: p.sheetName, p_delete: del, p_by: null });
      edits = await rpc('admin_callings_edits', { p_pass: ctx.getPass() });
      build(); renderList(); if (!$('deck').hidden) { applyFilter(); deckAt = Math.min(deckAt, Math.max(0, view.length - 1)); if (view.length) renderDeck(); else closeDeck(); }
      toast(del ? (p.onSheet ? `${p.name} removed — coming off the sheet` : `${p.name} left off the sheet`) : `${p.name} is back on the list`);
      if (C.sheetsRefreshUrl) saveToSheet(p, null, true);
    } catch (e) { toast(/admin_callings_delete/.test(e.message) ? 'Run supabase/flags.sql in Supabase first' : 'Failed: ' + e.message, 4000); }
  }

  // Warning / Magnet message: templates live in Settings; the Apps Script web app sends the
  // text (SimpleTexting) and the email, then the sent date is written to the sheet.
  let templates = null;
  async function loadTemplates() {
    if (templates) return templates;
    const rows = await rpc('admin_get_settings', { p_pass: ctx.getPass() });
    settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    templates = Object.fromEntries(rows.filter(r => r.key.startsWith('notify_')).map(r => [r.key, r.value]));
    return templates;
  }
  function fill(tpl, p) { return String(tpl || '').replace(/\{first\}/g, p.name.split(' ')[0]).replace(/\{name\}/g, p.name); }
  // What the "Flag sent" cell says went out: "9/13/2026 (email)", "9/13/2026 (text + email)",
  // "9/13/2026 (email) · 9/16/2026 (text)" (the other channel sent later). A bare date counts as both.
  function sentChannels(p) {
    const v = String(p.flagSent || '');
    if (!v.trim()) return { text: false, email: false };
    const named = /\b(text|email)\b/i.test(v);
    return { text: !named || /\btext\b/i.test(v), email: !named || /\bemail\b/i.test(v) };
  }
  // only: 'text' | 'email' sends just that channel (the one that hasn't gone out yet); otherwise everything LCR has.
  async function sendFlagMessage(p, only) {
    const L = p.lcr || {};
    const phone = only === 'email' ? '' : (L['Individual Phone'] || '').replace(/\D/g, ''), email = only === 'text' ? '' : (L['Individual E-mail'] || '');
    if (!phone && !email) { toast(only ? `No ${only === 'text' ? 'phone' : 'email'} for them in LCR` : 'No phone or email for them in LCR'); return; }
    if (!C.sheetsRefreshUrl) { toast('Sending needs the Google script set up as a web app (steps 5–8 in scripts/announcements.gs)', 5000); return; }
    let t; try { t = await loadTemplates(); } catch (e) { toast('Run supabase/flags.sql first'); return; }
    const k = p.flag.toLowerCase();
    const sms = phone ? fill(t['notify_' + k + '_sms'], p) : '', subject = email ? fill(t['notify_' + k + '_email_subject'], p) : '', body = email ? fill(t['notify_' + k + '_email'], p) : '';
    if (!sms && !body) { toast('No message template saved yet — see Settings'); return; }
    const preview = [phone ? `TEXT to ${L['Individual Phone']}:\n${sms}` : null, email ? `EMAIL to ${email}:\n${subject}\n\n${body}` : null].filter(Boolean).join('\n\n—————\n\n');
    if (!(await ask(`Send this to ${p.name}?\n\n${preview}`))) return;
    try {
      const r = await fetch(C.sheetsRefreshUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'notify', pass: ctx.getPass(), name: p.name, phone, email, flag: p.flag, sms, subject, body, fromName: t.notify_from_name || '', fromEmail: t.notify_from_email || '', replyTo: t.notify_reply_to || '' }) });
      const j = await r.json();
      const sentSms = j.sms === 'sent', sentEmail = j.email === 'sent';
      if (!sentSms && !sentEmail) throw new Error(j.error || 'send failed');  // one channel is enough to count as sent
      const today = todayMDY(), now = today + (sentSms && sentEmail ? ' (text + email)' : sentSms ? ' (text)' : ' (email)');
      // sending the channel that was still missing keeps the first date (the move-out countdown runs from it)
      const before = sentChannels(p), addsOther = truthy(p.flagSent) && ((sentSms && !before.text && before.email) || (sentEmail && !before.email && before.text)) && !(before.text && before.email);
      await rpc('admin_callings_edit', { p_pass: ctx.getPass(), p_name: p.sheetName, p_lcr_uuid: (p.lcr && p.lcr['Person UUID']) || null, p_values: { Flag: p.flag, 'Flag sent': addsOther ? p.flagSent + ' · ' + now : now }, p_by: null });
      edits = await rpc('admin_callings_edits', { p_pass: ctx.getPass() });
      const keep = p.sheetName; build(); applyFilter(); const at = view.findIndex(x => x.sheetName === keep); if (at >= 0) deckAt = at; renderList(); renderDeck();
      saveToSheet(p, null, true);
      const what = sentSms && sentEmail ? 'Text and email sent' : sentSms ? 'Text sent' : 'Email sent';
      const miss = (!sentSms && phone ? ` · text not sent (${j.error || 'no SimpleTexting key yet'})` : !sentEmail && email ? ` · email not sent (${j.error || 'unknown'})` : '') + (sentEmail && j.note ? ` · ${j.note}` : '');
      toast(`${what} to ${p.name}${miss}`, miss ? 8000 : 3500);
    } catch (e) { toast('Not sent: ' + e.message, 5000); }
  }

  function renderDeck() {
    const p = view[deckAt]; if (!p) return;
    $('deck-pos').textContent = `${deckAt + 1} of ${view.length}`;
    $('deck-filter').textContent = FILTERS[filter].label + (query ? ` · “${query}”` : '');
    const s = $('deck-slide'); s.innerHTML = ''; s.appendChild(slide(p)); s.scrollTop = 0;
    $('deck-prev').disabled = deckAt === 0; $('deck-next').disabled = deckAt === view.length - 1;
    const jump = $('deck-jump'); jump.innerHTML = '';
    view.forEach((x, i) => jump.appendChild(el('option', { value: i, selected: i === deckAt ? 'selected' : null }, `${i + 1}. ${x.name}`)));
  }
  function openDeck(i) {
    deckAt = Math.max(0, Math.min(i, view.length - 1));
    if (!view.length) { toast('Nobody to show with this filter'); return; }
    $('deck').hidden = false; document.body.classList.add('deck-open'); renderDeck();
  }
  function closeDeck() { $('deck').hidden = true; document.body.classList.remove('deck-open'); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
  function step(n) { const to = deckAt + n; if (to < 0 || to >= view.length) return; deckAt = to; renderDeck(); }

  // ---------- data ----------
  async function load(force) {
    if (loaded && !force) return;
    if (loading) return loading;
    loading = (async () => {
      const pass = ctx.getPass();
      sundays = lastSundays(8);
      let rows = [];
      try { rows = await rpc('admin_sheets', { p_pass: pass }); }
      catch (e) { $('cal-list').innerHTML = ''; $('cal-list').appendChild(el('p', { class: 'notice' }, 'Run supabase/sheets.sql in Supabase first (' + e.message + ').')); loading = null; return; }
      sheets = Object.fromEntries(rows.map(r => [r.key, r]));
      try { edits = await rpc('admin_callings_edits', { p_pass: pass }); } catch (e) { edits = []; }
      try { settings = Object.fromEntries((await rpc('admin_get_settings', { p_pass: pass })).map(r => [r.key, r.value])); } catch (e) { settings = {}; }
      templates = null;
      attendance = new Map();
      try {
        for (const r of await rpc('admin_attendance_recent', { p_pass: pass, p_weeks: 8 })) {
          if (!attendance.has(r.member_id)) attendance.set(r.member_id, new Map());
          const m = attendance.get(r.member_id); if (!m.has(r.meeting_date)) m.set(r.meeting_date, new Set()); m.get(r.meeting_date).add(r.class);
        }
      } catch (e) { /* attendance is a bonus */ }
      build(); renderList(); loaded = true; loading = null;
      const cs = sheets.callings; $('cal-open-sheet').href = cs && cs.source_url || '#'; $('cal-open-sheet').hidden = !(cs && cs.source_url);
      const ns = sheets.newmember; $('cal-open-form').href = ns && ns.source_url || '#'; $('cal-open-form').hidden = !(ns && ns.source_url);
    })();
    return loading;
  }
  // Re-read the sheet copies + site edits (no attendance/settings) and redraw, keeping the deck on the same person.
  async function reloadEdits() {
    const pass = ctx.getPass();
    const keep = deckAt >= 0 && view[deckAt] ? view[deckAt].sheetName : null;
    const rows = await rpc('admin_sheets', { p_pass: pass }); sheets = Object.fromEntries(rows.map(r => [r.key, r]));
    edits = await rpc('admin_callings_edits', { p_pass: pass });
    build(); applyFilter();
    if (keep) { const at = view.findIndex(x => x.sheetName === keep); if (at >= 0) deckAt = at; }
    renderList();
    // don't redraw a slide someone is typing on — it picks up the new state on its next render
    if (!$('deck').hidden && !$('deck').querySelector('.edit-form')) renderDeck();
  }
  // This person's edits → the Google Sheet right now, through the web app. Runs in the
  // background after Save / Send (quiet = no toast unless something went wrong) and from the
  // "Save to sheet" button on a slide.
  async function saveToSheet(p, btn, quiet) {
    if (!C.sheetsRefreshUrl) { toast('Set up the Google script as a web app first (scripts/announcements.gs)', 4000); return; }
    if (savingToSheet.has(p.sheetName)) return;
    savingToSheet.add(p.sheetName);
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await fetch(C.sheetsRefreshUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'save', pass: ctx.getPass(), name: p.sheetName }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'save failed');
      savingToSheet.delete(p.sheetName);
      await reloadEdits();
      if (!quiet || j.written) toast(j.written ? `${p.name} is in the Google Sheet` : `Nothing new to save for ${p.name}`);
    } catch (e) {
      savingToSheet.delete(p.sheetName);
      toast(`Not in the Google Sheet yet (${e.message}) — it goes in with the next sync, or tap Save to sheet to try again`, 6000);
      if (btn) { btn.disabled = false; btn.textContent = 'Save to sheet'; }
      else if (!$('deck').hidden && !$('deck').querySelector('.edit-form')) renderDeck();
    }
  }
  // The sheet's intake columns, pre-filled from LCR and the newest move-in form for someone who
  // isn't on the sheet yet. Only filled-in values are returned (blank cells stay blank).
  const INTAKE_FROM_FORM = [['CAR', /have a car/i], ['LENGTH OF STAY', /how long do you plan/i], ['MISSION', /serve a mission/i], ['PURPOSE IN ATL', /why you.re here/i], ['HOBBIES', /hobbies/i], ['MUSIC', /sing or play/i]];
  function intakeValues(p) {
    const L = p.lcr || {}, f = p.forms[0], v = {};
    if (truthy(L['Address - City'])) v.LOCATION = L['Address - City'].trim();
    if (truthy(L.Age)) v.AGE = String(L.Age).trim();
    if (f) for (const [key, re] of INTAKE_FROM_FORM) { const x = col(f.o, re); if (truthy(x)) v[key] = String(x).trim().slice(0, 500); }
    return v;
  }
  // "Add to sheet": record the pre-filled row as a site edit, then write it into the Google Sheet
  // right away (the sheet copy comes back with them on it). Needs supabase/addrow.sql.
  async function addToSheet(p, btn) {
    const v = intakeValues(p);
    const lines = Object.entries(v).map(([k, x]) => `${k.replace(/ \(under yr\)$/, '')}: ${x.length > 70 ? x.slice(0, 70) + '…' : x}`);
    if (!(await ask(`Add ${p.name} to the Members without Callings sheet?\n\n${lines.length ? 'Their row starts with:\n' + lines.join('\n') : 'Just their name for now — nothing in LCR or the move-in form to fill in.'}`))) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      await rpc('admin_callings_edit', { p_pass: ctx.getPass(), p_name: p.sheetName, p_lcr_uuid: (p.lcr && p.lcr['Person UUID']) || (p.member && p.member.lcr_uuid) || null, p_values: v, p_by: null });
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Add to sheet'; }
      toast(/not editable/.test(e.message) ? 'Run supabase/addrow.sql in Supabase first (' + e.message + ')' : 'Not added: ' + e.message, 6000); return;
    }
    edits = await rpc('admin_callings_edits', { p_pass: ctx.getPass() });
    build(); applyFilter();
    const at = view.findIndex(x => x.sheetName === p.sheetName); if (at >= 0) deckAt = at;
    renderList();
    const q = people.find(x => x.sheetName === p.sheetName) || p;
    await saveToSheet(q, btn);
  }
  // Everyone on LCR's report who has no row yet, in one go (the chip on the "New / not on sheet" filter).
  async function addAllToSheet(btn) {
    const missing = people.filter(p => !p.onSheet && p.lcr && !p.deleted && !p.pending);
    if (!missing.length) { toast('Everyone on the LCR report already has a row.'); return; }
    if (!(await ask(`Add ${missing.length} ${missing.length === 1 ? 'person' : 'people'} to the Members without Callings sheet?\n\n${missing.map(p => p.name).join(', ')}\n\nEach row starts with their location, age and move-in form answers where we have them.`))) return;
    btn.disabled = true; btn.textContent = 'Adding…';
    let n = 0;
    try {
      for (const p of missing) { await rpc('admin_callings_edit', { p_pass: ctx.getPass(), p_name: p.sheetName, p_lcr_uuid: (p.lcr && p.lcr['Person UUID']) || null, p_values: intakeValues(p), p_by: null }); n++; }
    } catch (e) { toast(/not editable/.test(e.message) ? 'Run supabase/addrow.sql in Supabase first (' + e.message + ')' : `Stopped after ${n}: ${e.message}`, 6000); }
    if (n) {
      // one trip to the Google script writes every pending row and re-copies the sheet
      btn.textContent = 'Writing to the sheet…';
      try {
        const r = await fetch(C.sheetsRefreshUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'sheets', pass: ctx.getPass() }) });
        const j = await r.json(); if (!j.ok) throw new Error(j.error || 'write failed');
        toast(`${n} added to the Google Sheet`);
      } catch (e) { toast(`${n} queued, but the sheet write failed (${e.message}) — they go in with the next sync`, 6000); }
    }
    try { await reloadEdits(); } catch (e) { /* the list redraws on the next load */ }
    btn.disabled = false;
  }
  async function refreshFromGoogle() {
    const url = C.sheetsRefreshUrl;
    if (!url) { toast('Ask Claude to refresh the sheets, or set up the Google script (see scripts/announcements.gs)', 4500); return; }
    const btn = $('cal-refresh'); btn.disabled = true; btn.textContent = 'Refreshing…';
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'sheets', pass: ctx.getPass() }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'refresh failed');
      toast(`Sheets refreshed: ${j.callings} people, ${j.newmember} form responses`);
      await load(true);
    } catch (e) { toast('Refresh failed: ' + e.message, 4000); }
    finally { btn.disabled = false; btn.textContent = 'Refresh from Google Sheets'; }
  }

  function init(c) {
    ctx = c;
    $('cal-search').addEventListener('input', () => { query = $('cal-search').value.trim(); renderList(); });
    $('cal-start').addEventListener('click', () => { openDeck(0); });
    $('cal-refresh').addEventListener('click', refreshFromGoogle);
    $('deck-close').addEventListener('click', closeDeck);
    $('deck-prev').addEventListener('click', () => step(-1));
    $('deck-next').addEventListener('click', () => step(1));
    $('deck-jump').addEventListener('change', () => { deckAt = +$('deck-jump').value; renderDeck(); });
    $('deck-full').addEventListener('click', () => { const d = $('deck'); if (document.fullscreenElement) document.exitFullscreen(); else if (d.requestFullscreen) d.requestFullscreen().catch(() => {}); });
    document.addEventListener('keydown', e => {
      if ($('deck').hidden) return;
      if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'Home') { deckAt = 0; renderDeck(); }
      else if (e.key === 'End') { deckAt = view.length - 1; renderDeck(); }
      else if (e.key === 'Escape') closeDeck();
    });
    // swipe on phones/tablets
    let x0 = null;
    $('deck-slide').addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
    $('deck-slide').addEventListener('touchend', e => { if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1); });
  }

  // for Leaders › Overview: the merged people list + sheet copies, and a way to jump to one person's slide
  function data() { return { people, sheets, loaded }; }
  function openPerson(sheetName) {
    query = ''; if ($('cal-search')) $('cal-search').value = '';
    // whichever view has them: the main list, then the has-a-calling / not-in-LCR views, then removed
    for (const f of ['all', 'hasCalling', 'sheetOnly', 'removed']) {
      filter = f; applyFilter();
      const at = view.findIndex(x => x.sheetName === sheetName);
      if (at >= 0) { renderList(); openDeck(at); return; }
    }
    filter = 'all'; applyFilter(); renderList(); toast('Not on the list any more');
  }
  // ---- flags from Leaders › Members ----
  // The callings-list entry that is this roster member, if any: by LCR uuid, then by the member link.
  function personFor(member) {
    if (!loaded || !member) return null;
    const hit = p => (p.member && p.member.id === member.id) || (member.lcr_uuid && p.lcr && p.lcr['Person UUID'] === member.lcr_uuid);
    return people.find(p => hit(p) && !p.deleted) || people.find(hit) || null;
  }
  // Set (or clear) a member's Flag straight from the Members list. Someone who isn't on the callings
  // list gets a row of their own (named "First Last", like the sheet); a removed / left-off person
  // comes back on the list. Any change clears "Flag sent" — that date belonged to the old flag.
  async function setFlag(member, flag) {
    await load();
    let p = personFor(member);
    const [last, rest] = String(member.name || '').split(/,\s*/);
    const sheetName = p ? p.sheetName : ((rest || '').split(' ')[0] + ' ' + (last || '')).trim();
    if (p && p.deleted && flag) await rpc('admin_callings_delete', { p_pass: ctx.getPass(), p_name: p.sheetName, p_delete: false, p_by: null });
    await rpc('admin_callings_edit', { p_pass: ctx.getPass(), p_name: sheetName, p_lcr_uuid: member.lcr_uuid || (p && p.lcr && p.lcr['Person UUID']) || null, p_values: { Flag: flag || null, 'Flag sent': null }, p_by: null });
    edits = await rpc('admin_callings_edits', { p_pass: ctx.getPass() });
    build(); applyFilter(); renderList();
    p = people.find(x => x.sheetName === sheetName) || personFor(member);
    if (p && C.sheetsRefreshUrl) saveToSheet(p, null, true);     // background: into the Google Sheet
    return p;
  }

  // Settings → "Send me a test text": just the SMS leg, to check the SimpleTexting token
  async function sendTestText(phone, text) {
    if (!C.sheetsRefreshUrl) throw new Error('the Google script web app URL is not set (config.js)');
    const r = await fetch(C.sheetsRefreshUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'notify', test: true, pass: ctx.getPass(), name: 'test', phone: String(phone).replace(/\D/g, ''), email: '', flag: 'Test', sms: text, subject: '', body: '' }) });
    const j = await r.json();
    if (j.sms !== 'sent') throw new Error(j.error || 'text not sent');
    return j;
  }
  return { init, load, refresh: () => load(true), data, openPerson, isTicked, sendTestText, personFor, setFlag };
})();
