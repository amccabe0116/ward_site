/*
 * Announcements as posts — shared by the home page (index.html: the list), the public
 * submission page (post.html) and Leaders › Announcements (admin.html: approve / edit / add).
 *
 *   NPPosts.card(post)                    -> <article class="post"> for one post
 *   NPPosts.renderPublic(box, posts)      -> the home-page list: dated events soonest first, then notices
 *   NPPosts.form(initial, opts)           -> { el, values(), validate(), busy() } the add/edit form
 *   NPPosts.compressImage(file)           -> Promise<Blob>  (JPEG, longest side 1600px)
 *   NPPosts.uploadFlyer(blob)             -> Promise<url>   (Supabase storage bucket "flyers")
 *   NPPosts.calendarLinks(post)           -> { google, ics }  "Add to calendar" links for a dated post
 *   NPPosts.occurrences(post, n)          -> [{ date, cancelled? }] the next n dates of a (repeating) post
 *   NPPosts.expand(posts)                 -> the list with repeating posts turned into their upcoming dates
 *
 * Database side: supabase/posts.sql.
 */
window.NPPosts = (function () {
  const { C, el, linkify, icons } = NP;
  const TZ = C.timeZone || 'America/New_York';
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const pin = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  const clock = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const link = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>';
  const image = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>';
  const calendar = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
  const share = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
  const SITE = (typeof location !== 'undefined' && location.origin) || '';

  // ---- dates & times ----
  function dateParts(iso) {           // 'YYYY-MM-DD' -> { dow, day, mon, long } (no time-zone shift)
    if (!iso) return null;
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return { y, m, d, dow: DAYS[dt.getUTCDay()], mon: MONTHS[m - 1], long: `${DAYS[dt.getUTCDay()]}, ${MONTHS[m - 1]} ${d}` };
  }
  function todayIso() {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  function fmtTime(t) {               // '19:00:00' | '19:00' -> '7:00 PM'
    if (!t) return '';
    const [h, m] = String(t).split(':').map(Number);
    const hh = ((h + 11) % 12) + 1;
    return `${hh}${m ? ':' + String(m).padStart(2, '0') : ''} ${h >= 12 ? 'PM' : 'AM'}`;
  }
  function timeRange(p) {
    if (!p.start_time) return '';
    const a = fmtTime(p.start_time), b = p.end_time ? fmtTime(p.end_time) : '';
    if (!b) return a;
    // "7 – 9 PM" when both share the same meridiem
    const same = a.slice(-2) === b.slice(-2);
    return same ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`;
  }
  function relativeDay(iso) {         // 'Today' / 'Tomorrow' / '' for the date chip
    const t = todayIso(); if (iso === t) return 'Today';
    const [y, m, d] = t.split('-').map(Number); const tm = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    return iso === tm ? 'Tomorrow' : '';
  }

  // ---- repeats ----
  // A post can repeat (weekly / every 2 weeks / monthly on the same weekday, e.g. 1st Tuesday) from
  // its event_date. The site works out the upcoming dates here and shows only the next few
  // (repeat_show, 1–4); a date in skip_dates is cancelled — shown as such, not silently dropped.
  const ORD = ['1st', '2nd', '3rd', '4th', 'last'], BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  function nthWeekday(y, m, dow, ord) {       // m 1–12, ord 1–4 or 5 = last -> 'YYYY-MM-DD'
    if (ord === 5) { const last = new Date(Date.UTC(y, m, 0)); return new Date(Date.UTC(y, m, 0 - ((last.getUTCDay() - dow + 7) % 7))).toISOString().slice(0, 10); }
    const first = new Date(Date.UTC(y, m - 1, 1));
    return new Date(Date.UTC(y, m - 1, 1 + ((dow - first.getUTCDay() + 7) % 7) + (ord - 1) * 7)).toISOString().slice(0, 10);
  }
  function repeatInfo(p) {                    // the series' weekday + ordinal-in-month, from the first date
    const dp = dateParts(p.event_date); if (!dp || !p.repeat) return null;
    return { dow: new Date(Date.UTC(dp.y, dp.m - 1, dp.d)).getUTCDay(), dowName: dp.dow, ord: Math.min(5, Math.ceil(dp.d / 7)) };
  }
  function repeatLabel(p) {                   // 'Every Tuesday' / 'Every other Tuesday' / 'Every 1st Tuesday'
    const r = repeatInfo(p); if (!r) return '';
    return p.repeat === 'weekly' ? 'Every ' + r.dowName : p.repeat === 'biweekly' ? 'Every other ' + r.dowName : 'Every ' + ORD[r.ord - 1] + ' ' + r.dowName;
  }
  // Upcoming dates from `from` (today): the next `count` real ones, plus any cancelled ones met on
  // the way, flagged. [{ date, cancelled? }]. A one-off post is its own single occurrence.
  function occurrences(p, count, from) {
    if (!p.event_date) return [];
    from = from || todayIso(); count = count || p.repeat_show || 2;
    const start = String(p.event_date).slice(0, 10);
    if (!p.repeat) return start >= from ? [{ date: start }] : [];
    const skip = new Set((p.skip_dates || []).map(d => String(d).slice(0, 10)));
    const until = p.repeat_until ? String(p.repeat_until).slice(0, 10) : null;
    const r = repeatInfo(p), dp = dateParts(start);
    const nth = k => p.repeat === 'weekly' ? addDays(start, 7 * k) : p.repeat === 'biweekly' ? addDays(start, 14 * k)
      : nthWeekday(dp.y + Math.floor((dp.m - 1 + k) / 12), ((dp.m - 1 + k) % 12) + 1, r.dow, r.ord);
    const out = []; let real = 0;
    for (let k = 0; k < 2000 && real < count; k++) {
      const d = nth(k);
      if (until && d > until) break;
      if (d < from) continue;
      if (skip.has(d)) out.push({ date: d, cancelled: true }); else { out.push({ date: d }); real++; }
    }
    return out;
  }
  // The list to show: every dated post becomes its upcoming occurrence(s) — copies of the post with
  // that date, `series` pointing back, `nth` (0 = the first shown) and `cancelled` — sorted by date;
  // undated notices keep their place at the end.
  function expand(posts, from) {
    const dated = [], undated = [];
    for (const p of posts) {
      if (!p.event_date) { undated.push(p); continue; }
      occurrences(p, p.repeat_show, from).forEach((o, i) => dated.push(Object.assign({}, p, { event_date: o.date, series: p, nth: i, cancelled: !!o.cancelled })));
    }
    dated.sort((a, b) => (a.event_date + (a.start_time || '')) < (b.event_date + (b.start_time || '')) ? -1 : 1);
    return dated.concat(undated);
  }
  function rrule(p) {                         // RFC 5545 rule for the series (Google's template link and the .ics both take it)
    const r = repeatInfo(p); if (!r) return '';
    let rule = p.repeat === 'monthly' ? `FREQ=MONTHLY;BYDAY=${r.ord === 5 ? -1 : r.ord}${BYDAY[r.dow]}` : `FREQ=WEEKLY;${p.repeat === 'biweekly' ? 'INTERVAL=2;' : ''}BYDAY=${BYDAY[r.dow]}`;
    if (p.repeat_until) { const u = String(p.repeat_until).slice(0, 10); rule += ';UNTIL=' + (p.start_time ? stampUtc(zonedToUtc(u, '23:59')) : u.replace(/-/g, '')); }
    return rule;
  }

  // ---- calendars ----
  // Times are Eastern wall-clock (config.js timeZone); calendars want UTC instants. Two ways in:
  // a Google Calendar "template" link (opens the event pre-filled, no file needed) and the .ics
  // file the Apps Script publishes for every dated post (cal/<id>.ics — Apple, Outlook, everything
  // else). calendar.html offers the whole ward calendar as a subscription (calendar.ics).
  const DEFAULT_HOURS = 2;                    // an event with a start and no end
  function zonedToUtc(iso, time) {            // '2026-09-26', '18:00[:00]' -> Date, the instant in TZ
    const [y, m, d] = iso.split('-').map(Number); const [hh, mm] = String(time || '00:00').split(':').map(Number);
    const naive = Date.UTC(y, m - 1, d, hh, mm || 0);
    const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const q = Object.fromEntries(f.formatToParts(new Date(naive)).map(x => [x.type, x.value]));
    const asTz = Date.UTC(+q.year, q.month - 1, +q.day, q.hour % 24, +q.minute, +q.second);
    return new Date(naive - (asTz - naive));
  }
  const stampUtc = dt => dt.toISOString().replace(/[-:]|\.\d{3}/g, '');       // 20260926T220000Z
  function eventSpan(p) {                     // -> { allDay, start, end } in calendar syntax, or null
    if (!p.event_date) return null;
    const iso = String(p.event_date).slice(0, 10);
    if (!p.start_time) { const [y, m, d] = iso.split('-').map(Number); return { allDay: true, start: iso.replace(/-/g, ''), end: new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10).replace(/-/g, '') }; }
    const start = zonedToUtc(iso, p.start_time);
    let end = p.end_time ? zonedToUtc(iso, p.end_time) : new Date(start.getTime() + DEFAULT_HOURS * 36e5);
    if (end <= start) end = new Date(end.getTime() + 864e5);                    // runs past midnight
    return { allDay: false, start: stampUtc(start), end: stampUtc(end) };
  }
  function calendarLinks(p, site) {          // -> { google, ics } or null for an undated notice
    const span = eventSpan(p); if (!span) return null;
    site = site || SITE;
    const details = [String(p.details || '').trim(), p.link ? linkLabel(p.link).replace(/ · .*$/, '') + ': ' + p.link : '', 'Everything, always up to date: ' + site].filter(Boolean).join('\n');
    const q = new URLSearchParams({ action: 'TEMPLATE', text: p.title, dates: span.start + '/' + span.end, details, ctz: TZ });
    if (p.location) q.set('location', p.location);
    const rule = rrule(p); if (rule) q.set('recur', 'RRULE:' + rule);
    return { google: 'https://calendar.google.com/calendar/render?' + q.toString(), ics: `${site}/cal/${p.id}.ics` };
  }

  // ---- one post ----
  function card(p, opts) {
    opts = opts || {};
    // a repeating post that hasn't been expanded (leaders' list, the preview) shows its next date
    if (p.repeat && !p.series && p.event_date) { const next = occurrences(p, 1).find(o => !o.cancelled); if (next) p = Object.assign({}, p, { event_date: next.date, series: p, nth: 0 }); }
    const series = p.series && p.series.repeat ? p.series : null;
    const compact = !!series && (p.nth > 0 || p.cancelled);     // later occurrences: one line each
    const dp = dateParts(p.event_date);
    const when = dp ? [relativeDay(p.event_date) || dp.dow, `${dp.mon} ${dp.d}`, timeRange(p)].filter(Boolean).join(' · ') : '';
    const details = String(p.details || '').trim();
    const cal = p.id && !p.cancelled ? calendarLinks(p) : null;      // the preview on post.html has no id yet
    const canShare = !!p.id && !p.cancelled;
    const body = el('div', { class: 'post-body' }, [
      dp ? el('div', { class: 'post-when-row' }, [
        el('div', { class: 'post-when' + (p.cancelled ? ' cancelled' : relativeDay(p.event_date) ? ' soon' : '') }, [el('span', { class: 'ic', html: clock }), p.cancelled ? 'Cancelled · ' + when : when]),
        series ? el('span', { class: 'post-repeat', title: 'This post repeats' }, repeatLabel(series)) : null,
      ]) : null,
      el('h3', { class: 'post-title' }, p.title),
      p.location && !p.cancelled ? el('div', { class: 'post-where' }, [el('span', { class: 'ic', html: pin }), p.location]) : null,
      details && !compact ? el('div', { class: 'post-details', html: linkify(details) }) : null,
      p.link && !compact ? el('a', { class: 'post-link', href: p.link, target: '_blank', rel: 'noopener' }, [el('span', { class: 'ic', html: link }), linkLabel(p.link)]) : null,
      cal || canShare ? el('div', { class: 'post-foot' }, [
        cal ? el('div', { class: 'post-cal' }, [el('span', { class: 'ic', html: calendar }), 'Add to calendar: ', el('a', { href: cal.google, target: '_blank', rel: 'noopener' }, 'Google'), ' · ', el('a', { href: cal.ics }, 'Apple / Outlook')]) : null,
        canShare ? el('button', { class: 'post-share', type: 'button', title: 'Share this post', onclick: () => sharePost(p) }, [el('span', { class: 'ic', html: share }), 'Share']) : null,
      ]) : null,
      opts.footer || null,
    ]);
    const art = el('article', { class: 'post' + (p.flyer_url && !compact ? ' has-flyer' : '') + (compact ? ' compact' : '') + (p.cancelled ? ' is-cancelled' : ''), 'data-id': p.id, 'data-date': p.event_date || null }, [
      p.flyer_url && !compact ? el('a', { class: 'post-flyer', href: p.flyer_url, target: '_blank', rel: 'noopener', title: 'Open the flyer' }, el('img', { src: p.flyer_url, alt: p.title + ' flyer', loading: 'lazy' })) : null,
      body,
    ]);
    // long details start folded
    if (!compact && (details.length > 260 || details.split('\n').length > 5)) {
      const d = body.querySelector('.post-details'); d.classList.add('folded');
      const more = el('button', { class: 'post-more', type: 'button', onclick: () => { d.classList.toggle('folded'); more.textContent = d.classList.contains('folded') ? 'Read more' : 'Show less'; } }, 'Read more');
      d.after(more);
    }
    return art;
  }
  function linkLabel(url) {
    try { const u = new URL(url); const h = u.hostname.replace(/^www\./, ''); return /forms\.gle|docs\.google\.com\/forms|signup|sign-up|rsvp|cleaning\.html|meals\.html/i.test(url) ? 'Sign up' : /eventbrite|meetup/i.test(h) ? 'Tickets & details' : 'More info · ' + h; }
    catch (e) { return 'More info'; }
  }

  // Share: the phone's share sheet where there is one (Messages, WhatsApp…), otherwise the link is
  // copied. The link is the post's own page (e/<id>), which carries the preview tags — flyer,
  // title and date show under it in most messaging apps.
  async function sharePost(p) {
    const src = p.series || p;
    const url = `${SITE}/e/${src.id}`;
    const text = [p.title, whenLine(p), p.location].filter(Boolean).join(' · ');
    if (navigator.share) {
      try { await navigator.share({ title: p.title, text, url }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); NP.toast('Link copied — paste it anywhere'); }
    catch (e) { window.prompt('Copy this link', url); }
  }

  // ---- the home page list ----
  // How far ahead to show: a row of chips above the list, 2 months by default (general conference
  // next spring shouldn't crowd out this week's FHE). The choice sticks on this phone. Anything past
  // the cutoff is counted under the list with a one-tap "show everything".
  const HORIZONS = [[31, '1 month'], [62, '2 months'], [184, '6 months'], [0, 'All']];
  const HORIZON_DEFAULT = 62, HORIZON_KEY = 'np_horizon';
  function horizonPref() { try { const s = localStorage.getItem(HORIZON_KEY), v = Number(s); return s !== null && HORIZONS.some(h => h[0] === v) ? v : HORIZON_DEFAULT; } catch (e) { return HORIZON_DEFAULT; } }
  function setHorizon(days) { try { localStorage.setItem(HORIZON_KEY, String(days)); } catch (e) { /* private mode: just this render */ } }
  function plusDays(iso, n) { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
  function renderPublic(box, posts, opts) {
    opts = opts || {};
    box.innerHTML = '';
    const all = expand(posts), dated = all.filter(p => p.event_date), undated = all.filter(p => !p.event_date);
    if (!posts.length) { box.appendChild(el('p', { class: 'empty' }, 'Nothing posted yet — check back soon, or add something below.')); return; }
    const horizon = opts.horizon != null ? opts.horizon : horizonPref();
    const today = todayIso();
    const beyond = days => dated.filter(p => days && p.event_date > plusDays(today, days));
    const hidden = beyond(horizon), shown = dated.filter(p => !hidden.includes(p));
    const pick = days => { setHorizon(days); renderPublic(box, posts, Object.assign({}, opts, { horizon: days })); };
    // the chips only matter once something sits past the shortest window
    if (beyond(HORIZONS[0][0]).length) {
      box.appendChild(el('div', { class: 'post-filter' }, [
        el('span', { class: 'lbl' }, 'Show'),
        ...HORIZONS.map(([days, label]) => el('button', { class: 'chip' + (days === horizon ? ' on' : ''), type: 'button', 'data-days': days, onclick: () => pick(days) }, label)),
      ]));
    }
    if (shown.length) {
      const list = el('div', { class: 'post-list' });
      let lastMonth = '';
      for (const p of shown) {
        const dp = dateParts(p.event_date); const key = `${dp.y}-${dp.m}`;
        if (key !== lastMonth) { list.appendChild(el('h4', { class: 'post-month' }, `${MONTHS[dp.m - 1]} ${dp.y}`.replace(/^(\w+) (\d+)$/, (s, mo, y) => y === String(new Date().getFullYear()) ? mo : s))); lastMonth = key; }
        list.appendChild(card(p));
      }
      box.appendChild(list);
    }
    if (hidden.length) {
      const next = dateParts(hidden[0].event_date);
      box.appendChild(el('p', { class: 'post-later' }, [
        `${hidden.length} more later on (next: ${hidden[0].title}, ${next.mon} ${next.d}${next.y !== Number(today.slice(0, 4)) ? ', ' + next.y : ''}). `,
        el('button', { class: 'post-more', type: 'button', onclick: () => pick(0) }, 'Show everything'),
      ]));
    }
    if (undated.length) {
      box.appendChild(el('h4', { class: 'post-month' }, 'Announcements'));
      const list = el('div', { class: 'post-list' }); undated.forEach(p => list.appendChild(card(p))); box.appendChild(list);
    }
  }

  // ---- images ----
  // Shrink a photo/flyer in the browser: longest side 1600px, JPEG. Keeps uploads small and strips
  // EXIF. Falls back to the original file if the browser can't decode it.
  async function compressImage(file, maxPx, quality) {
    maxPx = maxPx || 1600; quality = quality || 0.86;
    if (!/^image\//.test(file.type)) throw new Error('Please choose an image (JPEG, PNG or HEIC from your camera roll).');
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) {
      // Safari < 17 / HEIC: go through an <img>
      bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('That image could not be read — try a JPEG or PNG.')); im.src = URL.createObjectURL(file); });
    }
    const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
    const scale = Math.min(1, maxPx / Math.max(w, h));
    const cw = Math.round(w * scale), ch = Math.round(h * scale);
    const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); ctx.drawImage(bmp, 0, 0, cw, ch);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob) throw new Error('Could not process that image');
    return blob;
  }
  async function uploadFlyer(blob) {
    const name = 'uploads/' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)) + '.jpg';
    const r = await fetch(`${C.supabaseUrl}/storage/v1/object/flyers/${name}`, {
      method: 'POST', body: blob,
      headers: { apikey: C.supabaseAnonKey, Authorization: `Bearer ${C.supabaseAnonKey}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'false', 'cache-control': '31536000' },
    });
    if (!r.ok) { let m = `${r.status}`; try { const j = await r.json(); m = j.message || j.error || m; } catch (e) {} throw new Error(/bucket|not found|row-level|policy/i.test(m) ? 'Flyer uploads are not set up yet (run supabase/posts.sql) — ' + m : 'Upload failed: ' + m); }
    return `${C.supabaseUrl}/storage/v1/object/public/flyers/${name}`;
  }

  // ---- the add / edit form (public submission and leaders share it) ----
  // initial: a post row (or {}); opts.askWho: show name + contact fields (public form);
  // opts.submitLabel; values() returns the RPC-ready fields; validate() returns an error string or ''.
  function form(initial, opts) {
    initial = initial || {}; opts = opts || {};
    const $f = {};
    const field = (key, label, input, hint) => el('div', { class: 'field' }, [el('label', { for: 'pf-' + key }, [label, hint ? el('span', { class: 'opt' }, ' ' + hint) : null]), input]);
    const inp = (key, attrs) => { const n = el('input', Object.assign({ id: 'pf-' + key }, attrs)); $f[key] = n; return n; };
    const ta = (key, attrs) => { const n = el('textarea', Object.assign({ id: 'pf-' + key }, attrs)); $f[key] = n; return n; };
    const sel = (key, options, value) => { const n = el('select', { id: 'pf-' + key }, options.map(([v, t]) => el('option', { value: v, selected: String(v) === String(value) ? '' : null }, t))); $f[key] = n; return n; };
    const t5 = t => t ? String(t).slice(0, 5) : '';

    // flyer picker with preview
    let flyerUrl = initial.flyer_url || '', flyerBlob = null, flyerBusy = false;
    const preview = el('img', { class: 'flyer-preview', alt: '', hidden: flyerUrl ? null : '', src: flyerUrl || '' });
    const flyerMsg = el('span', { class: 'muted small' }, flyerUrl ? 'Flyer attached.' : 'Optional — a photo or image of the flyer. Portrait works best.');
    const fileIn = el('input', { type: 'file', accept: 'image/*', id: 'pf-flyer-file', style: 'display:none' });
    const pickBtn = el('button', { class: 'btn small secondary', type: 'button', onclick: () => fileIn.click() }, [el('span', { class: 'ic', html: image }), flyerUrl ? 'Change flyer' : 'Add a flyer']);
    const removeBtn = el('button', { class: 'btn small secondary', type: 'button', hidden: flyerUrl ? null : '', onclick: () => { flyerUrl = ''; flyerBlob = null; preview.hidden = true; preview.src = ''; removeBtn.hidden = true; pickBtn.lastChild.textContent = 'Add a flyer'; flyerMsg.textContent = 'Flyer removed.'; } }, 'Remove');
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files && fileIn.files[0]; if (!f) return;
      flyerBusy = true; flyerMsg.textContent = 'Preparing the image…';
      try {
        flyerBlob = await compressImage(f);
        preview.src = URL.createObjectURL(flyerBlob); preview.hidden = false; removeBtn.hidden = false; pickBtn.lastChild.textContent = 'Change flyer';
        flyerUrl = '';   // uploaded on submit
        flyerMsg.textContent = `Ready (${Math.round(flyerBlob.size / 1024)} KB) — it uploads when you ${opts.submitLabel ? opts.submitLabel.toLowerCase() : 'submit'}.`;
      } catch (e) { flyerBlob = null; flyerMsg.textContent = e.message; }
      flyerBusy = false; fileIn.value = '';
    });

    const root = el('div', { class: 'post-form' }, [
      field('title', 'Title', inp('title', { type: 'text', maxlength: 120, placeholder: 'FHE at the park', value: initial.title || '', autocomplete: 'off' })),
      field('date', 'Date', inp('date', { type: 'date', value: initial.event_date ? String(initial.event_date).slice(0, 10) : '' }), '(leave blank for a general notice)'),
      el('div', { class: 'inline wrap2' }, [
        field('start', 'Starts', inp('start', { type: 'time', value: t5(initial.start_time) }), '(optional)'),
        field('end', 'Ends', inp('end', { type: 'time', value: t5(initial.end_time) }), '(optional)'),
      ]),
      el('div', { class: 'inline wrap2 repeat-row' }, [
        field('repeat', 'Repeats', sel('repeat', [['', 'Doesn’t repeat'], ['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Every month, same weekday']], initial.repeat || '')),
        field('show', 'Show the next', sel('show', [[1, '1'], [2, '2'], [3, '3'], [4, '4']], initial.repeat_show || 2), '(dates at a time)'),
        field('until', 'Until', inp('until', { type: 'date', value: initial.repeat_until ? String(initial.repeat_until).slice(0, 10) : '' }), '(optional)'),
      ]),
      field('location', 'Where', inp('location', { type: 'text', maxlength: 200, placeholder: 'Roswell building · 500 Norcross St', value: initial.location || '' }), '(optional)'),
      field('details', 'Details', ta('details', { rows: 5, maxlength: 3000, placeholder: 'What, who it’s for, what to bring…' }), '(optional)'),
      field('link', 'Link', inp('link', { type: 'url', maxlength: 500, placeholder: 'https://… sign-up form or more info', value: initial.link || '', inputmode: 'url' }), '(optional)'),
      el('div', { class: 'field' }, [
        el('label', {}, 'Flyer'),
        el('div', { class: 'flyer-box' }, [preview, el('div', { class: 'flyer-controls' }, [el('div', { class: 'inline' }, [pickBtn, removeBtn]), flyerMsg]), fileIn]),
      ]),
      opts.askWho ? el('div', { class: 'inline wrap2' }, [
        field('name', 'Your name', inp('name', { type: 'text', maxlength: 80, autocomplete: 'name', value: initial.submitted_name || '' })),
        field('contact', 'Your email or phone', inp('contact', { type: 'text', maxlength: 120, autocomplete: 'email', placeholder: 'So a leader can reach you with questions', value: initial.submitted_contact || '' })),
      ]) : null,
      // honeypot — hidden from people, filled by bots
      opts.askWho ? el('div', { style: 'position:absolute;left:-9999px;top:-9999px', 'aria-hidden': 'true' }, inp('website', { type: 'text', tabindex: -1, autocomplete: 'off', placeholder: 'Leave this empty' })) : null,
    ]);
    $f.details.value = initial.details || '';
    // "show the next" and "until" only matter for a repeating post
    const repeatExtras = () => { const on = !!$f.repeat.value; $f.show.closest('.field').hidden = !on; $f.until.closest('.field').hidden = !on; };
    $f.repeat.addEventListener('change', repeatExtras); repeatExtras();

    function values() {
      const v = k => ($f[k] ? $f[k].value : '').trim();
      const repeat = v('repeat') || null;
      return {
        title: v('title'), details: $f.details.value.trim(), event_date: v('date') || null, start_time: v('start') || null, end_time: v('end') || null,
        location: v('location'), link: v('link'), flyer_url: flyerUrl, name: v('name'), contact: v('contact'), website: v('website'),
        repeat, repeat_until: repeat ? v('until') || null : null, repeat_show: repeat ? +v('show') || 2 : 2,
      };
    }
    function validate() {
      const x = values();
      if (x.title.length < 3) return 'Please give it a title.';
      if (x.link && !/^https?:\/\//i.test(x.link)) return 'The link needs to start with http:// or https://';
      if (x.start_time && x.end_time && x.end_time < x.start_time) return 'The end time is before the start time.';
      if (x.repeat && !x.event_date) return 'A repeating post needs its first date.';
      if (x.repeat && x.repeat_until && x.repeat_until < x.event_date) return 'The “until” date is before the first date.';
      if (opts.askWho && x.name.length < 2) return 'Please add your name.';
      if (opts.askWho && x.contact.length < 5) return 'Please add an email or phone number so a leader can reach you.';
      if (flyerBusy) return 'The flyer is still being prepared — one moment.';
      return '';
    }
    // upload the picked flyer (if any) and return the values with flyer_url filled in
    async function finalize() {
      if (flyerBlob) { flyerMsg.textContent = 'Uploading the flyer…'; flyerUrl = await uploadFlyer(flyerBlob); flyerBlob = null; flyerMsg.textContent = 'Flyer uploaded.'; }
      return values();
    }
    return { el: root, values, validate, finalize, focus: () => $f.title.focus(), fields: $f };
  }

  // ---- the weekly email, built from the posts ----
  // o: { header, footer, site } — header/footer are plain text (URLs get linked in the HTML version).
  // Dated posts further out than SAVE_DATE_DAYS (general conference next spring, a devotional in
  // November) go in a "Save the date" section as one line each, so the email stays about this
  // month; the home page still shows them in full under their month.
  const SAVE_DATE_DAYS = 45;
  function emailSections(posts) {
    const all = expand(posts), dated = all.filter(p => p.event_date), undated = all.filter(p => !p.event_date);
    const t = todayIso(); const [y, m, d] = t.split('-').map(Number);
    const horizon = new Date(Date.UTC(y, m - 1, d + SAVE_DATE_DAYS)).toISOString().slice(0, 10);
    const near = dated.filter(p => p.event_date <= horizon), far = dated.filter(p => p.event_date > horizon).map(p => Object.assign({}, p, { brief: true }));
    return [['Coming up', near], ['Save the date', far], ['Announcements', undated]].filter(([, l]) => l.length);
  }
  const seriesNote = p => p.series && p.series.repeat ? ' (' + repeatLabel(p.series).replace(/^Every/, 'every') + ')' : '';
  function whenLine(p) {
    const dp = dateParts(p.event_date); if (!dp) return '';
    const yr = p.brief && dp.y !== Number(todayIso().slice(0, 4)) ? ', ' + dp.y : '';
    return `${dp.dow}, ${dp.mon} ${dp.d}${yr}` + (timeRange(p) ? ' · ' + timeRange(p) : '');
  }
  function emailPlain(posts, o) {
    o = o || {}; const site = o.site || SITE;
    const out = [];
    if (o.title) out.push(o.title, '');
    if (o.header) out.push(o.header.trim(), '');
    for (const [name, list] of emailSections(posts)) {
      out.push(name.toUpperCase(), '');
      for (const p of list) {
        const w = whenLine(p);
        if (p.cancelled) { out.push((w ? w + ' — ' : '') + p.title + ': CANCELLED this time', ''); continue; }
        if (p.nth > 0 || p.brief) { out.push((w ? w + ' — ' : '') + p.title + (p.location ? ' · ' + p.location : ''), ''); continue; }
        out.push((w ? w + ' — ' : '') + p.title + seriesNote(p));
        if (p.location) out.push('  ' + p.location);
        if (p.details) out.push(...String(p.details).trim().split('\n').map(l => '  ' + l));
        if (p.link) out.push('  ' + linkLabel(p.link).replace(/ · .*$/, '') + ': ' + p.link);
        if (p.flyer_url) out.push('  Flyer: ' + p.flyer_url);
        const cal = calendarLinks(p, site); if (cal) out.push('  Add to calendar: ' + cal.ics);
        out.push('');
      }
    }
    if (o.footer) out.push(o.footer.trim(), '');
    out.push('Everything, always up to date: ' + site);
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }
  // Plain tags on purpose (h1 / h2 / p / strong / br / a): LCR's Send a Message editor keeps exactly
  // those when you paste (checked 2026-09-18) and drops everything else, images included — so each
  // post carries a "Flyer:" link instead, and the tool offers the flyers as downloads to attach.
  function emailHtml(posts, o) {
    o = o || {}; const site = o.site || SITE;
    const esc = s => NP.escapeHtml(String(s || ''));
    const para = t => linkify(String(t || '').trim()).replace(/\n/g, '<br>');
    const h = [];
    if (o.title) h.push(`<h1>${esc(o.title)}</h1>`);
    if (o.header) h.push(`<p>${para(o.header)}</p>`);
    for (const [name, list] of emailSections(posts)) {
      h.push(`<h2>${esc(name)}</h2>`);
      for (const p of list) {
        const w = whenLine(p);
        if (p.cancelled) { h.push(`<p><strong>${esc((w ? w + ' — ' : '') + p.title + ': cancelled this time')}</strong></p>`); continue; }
        if (p.nth > 0 || p.brief) { h.push(`<p><strong>${esc((w ? w + ' — ' : '') + p.title)}</strong>${p.location ? ' · ' + esc(p.location) : ''}</p>`); continue; }
        const lines = [`<strong>${esc(w ? w + ' — ' + p.title : p.title)}</strong>${esc(seriesNote(p))}`];
        if (p.location) lines.push(esc(p.location));
        if (p.details) lines.push(para(p.details));
        if (p.link) lines.push(`<a href="${esc(p.link)}">${esc(linkLabel(p.link).replace(/ · .*$/, ''))}: ${esc(p.link)}</a>`);
        if (p.flyer_url) lines.push(`<a href="${esc(p.flyer_url)}">Flyer: ${esc(p.flyer_url)}</a>`);
        const cal = calendarLinks(p, site); if (cal) lines.push(`Add to calendar: <a href="${esc(cal.google)}">Google</a> · <a href="${esc(cal.ics)}">Apple / Outlook</a>`);
        h.push(`<p>${lines.join('<br>')}</p>`);
      }
    }
    if (o.footer) h.push(`<p>${para(o.footer)}</p>`);
    h.push(`<p>Everything, always up to date: <a href="${site}">${site.replace(/^https?:\/\//, '')}</a></p>`);
    return h.join('\n');
  }
  // ---- flyers as email attachments ----
  const fileNameFor = (p, i, ext) => String(i).padStart(2, '0') + '-' + p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '.' + ext;
  async function fetchFlyer(p, i) {
    const r = await fetch(p.flyer_url); if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob(); const ext = /png/.test(blob.type) ? 'png' : /pdf/.test(blob.type) ? 'pdf' : 'jpg';
    return { name: fileNameFor(p, i, ext), blob };
  }
  function saveBlob(blob, name) { const a = el('a', { href: URL.createObjectURL(blob), download: name }); document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
  // A tiny ZIP writer (store only — flyers are JPEGs, already compressed), so all the attachments
  // arrive as ONE download that unzips to a folder: select all, drag onto LCR's Attachments box.
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  async function zipFiles(files) {           // files: [{ name, blob }]
    const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
    const now = new Date(); const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const u16 = v => [v & 255, (v >> 8) & 255], u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    for (const f of files) {
      const data = new Uint8Array(await f.blob.arrayBuffer()), name = enc.encode(f.name), crc = crc32(data);
      const head = new Uint8Array([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x800), ...u16(0), ...u16(dosTime), ...u16(dosDate), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...name]);
      parts.push(head, data);
      central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x800), ...u16(0), ...u16(dosTime), ...u16(dosDate), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name]));
      offset += head.length + data.length;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const end = new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }
  // Download the given posts' flyers as one .zip (or one file at a time when zip is false).
  async function downloadFlyers(posts, opts) {
    opts = opts || {}; const seen = new Set(); const withFlyer = posts.filter(p => p.flyer_url && !seen.has(p.flyer_url) && seen.add(p.flyer_url)); const files = []; const failed = [];
    for (let i = 0; i < withFlyer.length; i++) { try { files.push(await fetchFlyer(withFlyer[i], i + 1)); } catch (e) { failed.push(withFlyer[i].title); } }
    if (opts.zip === false) { for (const f of files) { saveBlob(f.blob, f.name); await new Promise(r => setTimeout(r, 400)); } }
    else if (files.length) saveBlob(await zipFiles(files), (opts.name || 'flyers') + '.zip');
    return { count: files.length, failed };
  }
  const EMAIL_DEFAULTS = {
    header: `Ward text list: text your name and “please add me” to ${(C.links && C.links.textList && C.links.textList.number) || '(set the ward text-list number in config.js)'}
WhatsApp chat: ${C.links && C.links.whatsapp || ''}
Facebook group: ${C.links && C.links.facebook || ''}
Meet with the Bishop: ${SITE}/bishop.html
Ward calendar: subscribe once at ${SITE}/calendar.html and every activity shows up in your own calendar by itself`.replace(/^(WhatsApp chat|Facebook group): \n/gm, ''),
    footer: `Have something for the announcements? Post it at ${SITE}/post.html — a leader approves it and it goes on the site and into this email.`,
  };

  return { card, renderPublic, form, compressImage, uploadFlyer, fmtTime, timeRange, dateParts, todayIso, emailPlain, emailHtml, downloadFlyers, zipFiles, calendarLinks, eventSpan, occurrences, expand, repeatLabel, rrule, sharePost, EMAIL_DEFAULTS, icons: { pin, clock, calendar, share } };
})();
