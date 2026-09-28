/*
 * Leaders › Overview — the quick-reference page leaders land on.
 *
 *   who's on the roll          admin_members (active, men / women)
 *   moved in, last 30 days     LCR "Members Moved In" report, copied in as sheet `lcr_moved_in`
 *                              (scripts/lcr-report.js — falls back to the Move In Date column of the
 *                              members-without-callings report while that copy doesn't exist)
 *   sacrament attendance       LCR "Sacrament Meeting Attendance", copied in as sheet `lcr_sacrament`
 *                              (scripts/lcr-sacrament.js)
 *   to be sustained /          callings in progress (pipeline.js, supabase/pipeline.sql) plus the
 *   to be set apart            callings sheet (Answer says yes / Sustained ticked) for anyone not tracked there
 *   recent converts            LCR "Covenant Path Progress › New Members", copied in as sheet `lcr_converts`
 *                              (scripts/lcr-converts.js) — up to two years, filter chips
 */
window.NPOverview = (function () {
  const { C, rpc, el } = NP;
  const $ = id => document.getElementById(id);
  let ctx = null, loaded = false, loading = null;

  const DAY = 864e5;
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  // "13 Sep 2026", "9/13/2026", "2026-09-13" -> Date (local midnight) or null
  function parseDate(s) {
    s = String(s || '').trim(); let m;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return new Date(+m[1], +m[2] - 1, +m[3]);
    if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/))) { const mo = MONTHS[m[2].toLowerCase()]; return mo == null ? null : new Date(+m[3], mo, +m[1]); }
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) return new Date(+(m[3].length === 2 ? '20' + m[3] : m[3]), +m[1] - 1, +m[2]);
    return null;
  }
  const fmtShort = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: C.timeZone }).format(new Date());
  const fmtWhen = iso => new Date(iso).toLocaleString('en-US', { timeZone: C.timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const firstLast = n => { const [last, rest] = String(n).split(','); return rest ? rest.trim().split(' ')[0] + ' ' + last.trim() : n; };
  function rowsOf(sheet) { if (!sheet) return []; const h = sheet.headers; return sheet.rows.map(r => Object.fromEntries(h.map((k, i) => [k, r[i] || '']))); }

  function tile(big, label, sub) { return el('div', { class: 'stat' }, [el('b', {}, big), el('span', {}, label), sub ? el('span', { class: 'stat-sub' }, sub) : null]); }

  function render(members, sheets, people, opts) {
    opts = opts || {};
    const box = $('ov'); box.innerHTML = '';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const active = members.filter(m => m.active);
    const women = active.filter(m => m.sex === 'F').length, men = active.filter(m => m.sex === 'M').length, known = women + men;
    const pct = n => known ? Math.round(100 * n / known) + '%' : '—';

    // --- moved in, last 30 days
    const cutoff = new Date(today.getTime() - 30 * DAY);
    let movedSrc = 'LCR Members Moved In', movedAsOf = null, moved = [];
    if (sheets.lcr_moved_in) {
      movedAsOf = sheets.lcr_moved_in.updated_at;
      moved = rowsOf(sheets.lcr_moved_in).map(r => ({ name: r.Name.replace(/^Warning/, ''), age: r.Age, date: parseDate(r['Move In Date']), from: r['Prior Unit'], uuid: r['Person UUID'] }));
    } else if (sheets.lcr_callings) {
      movedSrc = 'LCR members-without-callings report (run lcr-report.js on Members Moved In for the full list)'; movedAsOf = sheets.lcr_callings.updated_at;
      moved = rowsOf(sheets.lcr_callings).map(r => ({ name: r['Preferred Name'], age: r.Age, date: parseDate(r['Move In Date']), from: '', uuid: r['Person UUID'] }));
    }
    moved = moved.filter(p => p.date && p.date >= cutoff && p.date <= today).sort((a, b) => b.date - a.date);
    const byUuid = new Map(people.filter(p => p.lcr).map(p => [p.lcr['Person UUID'], p]));

    // --- sacrament attendance, last 5 Sundays with a number
    let sac = [], sacAsOf = null;
    if (sheets.lcr_sacrament) {
      sacAsOf = sheets.lcr_sacrament.updated_at;
      sac = rowsOf(sheets.lcr_sacrament).map(r => ({ date: parseDate(r.Sunday), n: parseInt(r.Attendance, 10) })).filter(r => r.date && r.date <= today && !isNaN(r.n)).sort((a, b) => a.date - b.date).slice(-5);
    }
    const sacAvg = sac.length ? Math.round(sac.reduce((a, r) => a + r.n, 0) / sac.length) : null;
    const sacMax = Math.max(1, ...sac.map(r => r.n));

    // --- callings in progress: accepted but not sustained, sustained but not set apart
    const { toSustain, toSetApart } = NPPipeline.lists(people);
    const pipeNote = NPPipeline.data().unavailable;

    // --- recent converts (LCR Covenant Path Progress), filter chips up to two years
    const CONVERT_SPANS = [[3, '3 months'], [6, '6 months'], [12, '1 year'], [24, '2 years']];
    const convertPref = () => { try { const v = Number(localStorage.getItem('np_ov_converts')); return CONVERT_SPANS.some(x => x[0] === v) ? v : 12; } catch (e) { return 12; } };
    const convertSpan = opts.convertSpan || convertPref();
    let converts = [], convertsAsOf = null;
    if (sheets.lcr_converts) {
      convertsAsOf = sheets.lcr_converts.updated_at;
      converts = rowsOf(sheets.lcr_converts).map(r => ({ name: r.Name, since: r['Member for'], months: parseInt(r.Months, 10) || 0, dots: r['Last 6 Sundays'] || '', dates: (r['Sunday dates'] || '').split(/,\s*/), missed: r.Missed, friends: r.Friends, url: r.Details, uuid: r['Person UUID'] }));
    }
    const convertsAll = converts.length;
    converts = converts.filter(c => c.months <= convertSpan).sort((a, b) => a.months - b.months);

    box.appendChild(el('div', { class: 'stats' }, [
      tile(String(active.length), 'members on the roll'),
      tile(pct(women), 'women', women + (women === 1 ? ' sister' : ' sisters')),
      tile(pct(men), 'men', men + (men === 1 ? ' brother' : ' brothers')),
      tile(String(moved.length), 'moved in, last 30 days'),
      tile(sacAvg == null ? '—' : String(sacAvg), 'avg. sacrament, last 5 weeks'),
      tile(String(toSustain.length), 'to be sustained'),
      tile(String(toSetApart.length), 'to be set apart'),
    ]));

    const grid = el('div', { class: 'ov-grid' });
    // sacrament
    grid.appendChild(el('section', { class: 'card ov-card' }, [
      el('h3', {}, 'Sacrament meeting attendance'),
      sac.length ? el('div', { class: 'ov-bars' }, sac.map(r => el('div', { class: 'ov-bar' }, [
        el('span', { class: 'ov-bar-label' }, fmtShort(r.date)),
        el('span', { class: 'ov-bar-track' }, el('span', { class: 'ov-bar-fill', style: `width:${Math.round(100 * r.n / sacMax)}%` })),
        el('b', {}, String(r.n)),
      ]))) : el('p', { class: 'muted' }, 'Not copied from LCR yet — open Sacrament Meeting Attendance in LCR and run scripts/lcr-sacrament.js (part of the Sunday sync).'),
      el('p', { class: 'muted small' }, sacAsOf ? 'From LCR · copied ' + fmtWhen(sacAsOf) : ''),
    ]));
    // moved in
    grid.appendChild(el('section', { class: 'card ov-card' }, [
      el('h3', {}, 'Moved in the last 30 days'),
      moved.length ? el('ul', { class: 'ov-list' }, moved.map(p => {
        const cp = byUuid.get(p.uuid);
        return el('li', {}, [
          el('div', {}, [el('b', {}, firstLast(p.name)), p.age ? el('span', { class: 'muted' }, ' · ' + p.age) : null, cp ? el('button', { class: 'chip tiny', type: 'button', onclick: () => ctx.openCallings(cp.sheetName) }, cp.forms && cp.forms.length ? 'form + callings slide' : 'callings slide') : null]),
          el('div', { class: 'muted small' }, fmtShort(p.date) + (p.from ? ' · from ' + p.from : '')),
        ]);
      })) : el('p', { class: 'muted' }, 'Nobody in the last 30 days.'),
      el('p', { class: 'muted small' }, movedAsOf ? movedSrc + ' · copied ' + fmtWhen(movedAsOf) : 'Run scripts/lcr-report.js on LCR’s Members Moved In report to fill this in.'),
    ]));
    // callings in progress: two lists with one-tap steps
    const who = r => r.name;
    const openRow = r => r.sheet ? ctx.openCallings(r.person.sheetName) : (r.member_id ? ctx.openMember(r.member_id) : ctx.openCallings(r.name));
    const act = async (r, step, btn) => {
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        if (r.sheet) {
          // start tracking them here at this step; the sheet's Sustained box is ticked too when that is the step
          await NPPipeline.trackSheet(r, step === 'sustained' ? { p_sustained_at: todayIso() } : { p_set_apart_at: todayIso() });
          if (step === 'sustained' && !r.sustained_at) { try { await rpc('admin_callings_edit', { p_pass: ctx.getPass(), p_name: r.person.sheetName, p_lcr_uuid: (r.person.lcr && r.person.lcr['Person UUID']) || null, p_values: { sustained: 'Y' }, p_by: null }); } catch (e) { /* the sheet copy is a bonus */ } }
        } else await NPPipeline.step(r, step);
        NP.toast(step === 'sustained' ? who(r) + ' sustained' : who(r) + ' set apart — done');
        await NPCallings.refresh(); load(true);
      } catch (e) { btn.disabled = false; btn.textContent = step === 'sustained' ? 'Sustained ✓' : 'Set apart ✓'; NP.toast('Not saved: ' + e.message, 5000); }
    };
    const pipeTable = (list, step, cols) => el('table', { class: 'grid ov-table' }, [
      el('thead', {}, el('tr', {}, [el('th', {}, 'Name'), el('th', {}, 'Calling'), el('th', {}, 'Who contacts'), el('th', {}, cols), el('th', {}, '')])),
      el('tbody', {}, list.map(r => el('tr', { class: 'cal-row' }, [
        el('td', {}, [el('b', { class: 'ov-link', tabindex: 0, onclick: () => openRow(r) }, who(r)), r.sheet ? el('span', { class: 'muted small' }, ' · sheet') : null]),
        el('td', {}, r.calling), el('td', { class: 'muted' }, r.contact || ''),
        el('td', { class: 'muted' }, r.sheet ? (step === 'sustained' ? (r.person.answer || 'yes') : 'ticked on the sheet') : NPPipeline.fmtDay(step === 'sustained' ? r.accepted_at : r.sustained_at)),
        el('td', {}, el('button', { class: 'chip', type: 'button', onclick: e => act(r, step, e.currentTarget) }, step === 'sustained' ? 'Sustained ✓' : 'Set apart ✓')),
      ]))),
    ]);
    grid.appendChild(el('section', { class: 'card ov-card ov-wide' }, [
      el('h3', {}, 'Accepted a calling — still to be sustained'),
      toSustain.length ? pipeTable(toSustain, 'sustained', 'Accepted') : el('p', { class: 'muted' }, 'Nobody waiting — everyone who accepted has been sustained.'),
      el('p', { class: 'muted small' }, (pipeNote ? pipeNote + ' ' : '') + 'From callings tracked on Leaders › Members, plus the Members without Callings sheet where the Answer says yes. Tap Sustained ✓ once it’s done.'),
    ]));
    grid.appendChild(el('section', { class: 'card ov-card ov-wide' }, [
      el('h3', {}, 'Sustained — still to be set apart'),
      toSetApart.length ? pipeTable(toSetApart, 'set_apart', 'Sustained') : el('p', { class: 'muted' }, 'Nobody waiting — everyone sustained has been set apart.'),
      el('p', { class: 'muted small' }, 'Tap Set apart ✓ once it’s done; that closes the calling on Leaders › Members.'),
    ]));
    // recent converts
    const dots = c => el('span', { class: 'att-dots', title: c.dates.map((d, i) => d + (c.dots[i] === '✓' ? ' ✓' : ' –')).join(' · ') }, [...c.dots].map((ch, i) => el('i', { class: 'dot' + (ch === '✓' ? ' both' : ''), title: c.dates[i] || '' })));
    grid.appendChild(el('section', { class: 'card ov-card ov-wide' }, [
      el('h3', {}, ['Recent converts', el('span', { class: 'ov-chips' }, CONVERT_SPANS.map(([n, label]) => el('button', { class: 'chip tiny' + (n === convertSpan ? ' on' : ''), type: 'button', onclick: () => { try { localStorage.setItem('np_ov_converts', String(n)); } catch (e) {} render(members, sheets, people, Object.assign({}, opts, { convertSpan: n })); } }, label)))]),
      converts.length ? el('table', { class: 'grid ov-table' }, [
        el('thead', {}, el('tr', {}, [el('th', {}, 'Name'), el('th', {}, 'Member for'), el('th', {}, 'Last 6 Sundays'), el('th', {}, 'Missed'), el('th', {}, 'Friends'), el('th', {}, '')])),
        el('tbody', {}, converts.map(c => {
          const cp = byUuid.get(c.uuid);
          return el('tr', { class: 'cal-row' }, [
            el('td', {}, [el('b', {}, c.name), cp ? el('button', { class: 'chip tiny', type: 'button', onclick: () => ctx.openCallings(cp.sheetName) }, 'callings slide') : null]),
            el('td', { class: 'muted' }, c.since), el('td', {}, dots(c)),
            el('td', { class: c.missed && +c.missed >= 5 ? 'due-text' : 'muted' }, c.missed || '0'), el('td', { class: 'muted' }, c.friends === '0' ? 'none yet' : c.friends),
            el('td', {}, c.url ? el('a', { class: 'muted small', href: c.url, target: '_blank', rel: 'noopener' }, 'LCR ›') : null),
          ]);
        })),
      ]) : el('p', { class: 'muted' }, sheets.lcr_converts ? 'Nobody baptized in the last ' + CONVERT_SPANS.find(x => x[0] === convertSpan)[1] + (convertsAll ? ' (' + convertsAll + ' within two years — widen the filter).' : '.') : 'Not copied from LCR yet — open Covenant Path Progress › New Members in LCR and run scripts/lcr-converts.js (part of the Sunday sync).'),
      el('p', { class: 'muted small' }, convertsAsOf ? 'From LCR’s Covenant Path Progress (New Members) · copied ' + fmtWhen(convertsAsOf) + ' · “Missed” is LCR’s running count of sacrament meetings missed since baptism.' : ''),
    ]));
    box.appendChild(grid);
  }

  async function load(force) {
    if (loaded && !force) return;
    if (loading) return loading;
    loading = (async () => {
      $('ov').innerHTML = '<p class="muted">Loading…</p>';
      try {
        await Promise.all([NPCallings.load(force), NPPipeline.load(force)]);
        const d = NPCallings.data();
        render(ctx.getMembers(), d.sheets || {}, d.people || []);
        loaded = true;
      } catch (e) { $('ov').innerHTML = ''; $('ov').appendChild(el('p', { class: 'notice' }, 'Could not load the overview: ' + e.message)); }
      loading = null;
    })();
    return loading;
  }
  function init(c) { ctx = c; }
  return { init, load, refresh: () => load(true) };
})();
