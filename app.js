// Shared helpers for the ward site.
(function () {
  const C = window.NP_CONFIG;

  // Call a Postgres function through Supabase's REST API. A request that never reached the
  // server (Safari's "Load failed", Chrome's "Failed to fetch" — e.g. right after a confirm()
  // dialog, or a flaky phone connection) is tried once more before giving up.
  async function rpc(fn, args) {
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: C.supabaseAnonKey,
        Authorization: `Bearer ${C.supabaseAnonKey}`,
      },
      body: JSON.stringify(args || {}),
    };
    let res;
    try { res = await fetch(`${C.supabaseUrl}/rest/v1/rpc/${fn}`, opts); }
    catch (e) {
      if (!(e instanceof TypeError)) throw e;
      await new Promise(r => setTimeout(r, 400));
      try { res = await fetch(`${C.supabaseUrl}/rest/v1/rpc/${fn}`, opts); }
      catch (e2) { throw new Error(`Couldn't reach the database (${e2.message}) — check the connection and try again`); }
    }
    if (!res.ok) {
      let msg = `${res.status}`;
      try { const j = await res.json(); msg = j.message || j.hint || j.details || msg; } catch (e) {}
      const err = new Error(msg); err.status = res.status; throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // Today's date parts in the ward's time zone.
  function nowInTz() {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: C.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
    return { y: +parts.year, m: +parts.month, d: +parts.day, dow: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday) };
  }

  // Most recent Sunday (today if Sunday) as YYYY-MM-DD, in the ward's time zone.
  function currentMeetingDate() {
    const t = nowInTz();
    const dt = new Date(Date.UTC(t.y, t.m - 1, t.d));
    dt.setUTCDate(dt.getUTCDate() - t.dow);
    return dt.toISOString().slice(0, 10);
  }

  function fmtDate(iso, opts) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }, opts || {}));
  }

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
      if (c === null || c === undefined) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }

  let toastTimer;
  function toast(msg, ms) {
    let t = document.querySelector('.toast');
    if (!t) { t = el('div', { class: 'toast' }); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2200);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Turn plain text into safe HTML with clickable links / emails / phone numbers.
  function linkify(text) {
    let h = escapeHtml(text);
    h = h.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:)\]'"]/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
    h = h.replace(/\b([\w.+-]+@[\w-]+\.[\w.-]+)\b/g, (m, e) => `<a href="mailto:${e}">${e}</a>`);
    h = h.replace(/(?<![\d-])(\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4})(?!\d)/g, (m, p) => `<a href="tel:${p.replace(/\D/g, '')}">${p}</a>`);
    return h;
  }

  // ---- roll classes (Primary, Young Men, Sunday School, … — configured by the ward, not
  // hardcoded here) and check-in windows (America/New_York) ----
  let classes = [];
  async function loadClasses() {
    try { const c = await rpc('roll_classes'); if (Array.isArray(c)) classes = c; } catch (e) {}
    return classes;
  }
  let windows = [];
  async function loadWindows() {
    try { const w = await rpc('roll_windows'); if (Array.isArray(w)) windows = w; } catch (e) {}
    return windows;
  }

  // The ward's name, set on Leaders › Settings (not hardcoded in config.js). Updates C.wardName
  // in place, so anything reading NP.C.wardName after this resolves sees the real name; falls
  // back silently to whatever config.js has (usually 'Your Ward') if the database isn't reachable.
  let siteSettingsLoaded = null;
  function loadSiteSettings() {
    if (!siteSettingsLoaded) siteSettingsLoaded = rpc('site_settings')
      .then(s => { if (s && typeof s.ward_name === 'string' && s.ward_name.trim()) C.wardName = s.ward_name.trim(); })
      .catch(() => {});
    return siteSettingsLoaded;
  }
  function tzNowParts() {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: C.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
    return { dow: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday), minutes: (+p.hour % 24) * 60 + (+p.minute) };
  }
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const fmtTime = t => { const [h, m] = t.split(':').map(Number); const hh = ((h + 11) % 12) + 1; return `${hh}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  // Returns { open, label } for a class right now. label describes when it opens (or that it closed).
  function windowState(cls) {
    const w = windows.find(x => x.class === cls);
    if (!w || w.enforced === false) return { open: true, label: '' };
    const now = tzNowParts(), start = toMin(w.start_time), end = toMin(w.end_time);
    const day = DAYS[w.day_of_week] || 'Sunday';
    if (now.dow === w.day_of_week) {
      if (now.minutes < start) return { open: false, label: `Opens today at ${fmtTime(w.start_time)}` };
      if (now.minutes < end) return { open: true, label: `Open until ${fmtTime(w.end_time)}` };
      return { open: false, label: `Closed for today · opens ${day} at ${fmtTime(w.start_time)}` };
    }
    return { open: false, label: `Opens ${day} at ${fmtTime(w.start_time)}` };
  }
  // Re-run fn now and every 15 s (and when the tab comes back), so buttons flip without a reload.
  function everyTick(fn) {
    fn();
    const id = setInterval(fn, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) fn(); });
    return id;
  }

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  const icons = {
    broom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 3l-7.5 7.5M11 10l3 3M6.5 21c-1.5 0-3-1.5-3-3l1-3.5c.5-1.5 2-2.5 3.5-2.5h2c1.5 0 3 1 3.5 2.5l1 3.5c0 1.5-1.5 3-3 3z"/><path d="M8 15v6M12 15v6"/></svg>',
    meal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v7a3 3 0 0 0 6 0V3M8 3v18M17 3c-2 1-3 4-3 8h3v10"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    chevron: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    sms: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM7 11a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>',
    handshake: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-3"/><rect x="8" y="1" width="8" height="4" rx="1"/><path d="M8 12h8M8 16h5"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    facebook: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 22v-8.2h2.8l.4-3.3h-3.2V8.4c0-.9.3-1.6 1.6-1.6h1.7V3.9c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3v2.4H7.3v3.3h2.8V22h3.4z"/></svg>',
    whatsapp: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 1.8a8.2 8.2 0 1 1-4.2 15.3l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 0 1 12 3.8zm-3.3 4.4c-.2 0-.5.1-.7.3-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.2 5 4.4 2.5 1 3 .8 3.5.7.5-.1 1.7-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.1-.3-.2-.6-.3l-2-1c-.3-.1-.5-.2-.7.2l-.9 1.1c-.2.2-.3.2-.6.1-.3-.2-1.3-.5-2.4-1.5-.9-.8-1.5-1.8-1.7-2.1-.2-.3 0-.5.1-.6l.5-.5.3-.5c.1-.2 0-.4 0-.5L9.5 8.6c-.2-.5-.4-.4-.6-.4h-.2z"/></svg>',
  };

  window.NP = { C, rpc, currentMeetingDate, fmtDate, el, toast, escapeHtml, linkify, store, icons, loadClasses, loadWindows, loadSiteSettings, windowState, everyTick, fmtTime, getClasses: () => classes };
})();
