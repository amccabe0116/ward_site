/*
 * Callings in progress — for anyone on the members list (supabase/pipeline.sql).
 *
 * The steps, in the order they happen:
 *   proposed → contacted → accepted (yes / no) → sustained → set apart
 * ("who contacts" is recorded alongside, as information — not a step of its own.)
 *
 * Leaders › Members shows each member's open row as its current step + who contacts, and opens
 * an editor in that column. Leaders › Overview lists who still needs sustaining and who still
 * needs setting apart, with one-tap buttons. People on the Members without Callings sheet who
 * have a proposed calling there but no row here show the sheet's state (read-only) until someone
 * starts tracking them here — "Track" copies the sheet values over.
 *
 * admin.html calls NPPipeline.init({ getPass, getMembers }); everything else loads on demand.
 */
window.NPPipeline = (function () {
  const { C, rpc, el, toast } = NP;
  let ctx = null, rows = [], loaded = false, loading = null, unavailable = '';

  const truthy = v => !!String(v || '').trim();
  const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: C.timeZone }).format(new Date());
  const fmtDay = iso => iso ? new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const firstLast = n => { const [last, rest] = String(n || '').split(/,\s*/); return rest ? (rest.split(' ')[0] + ' ' + last).trim() : String(n || ''); };
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z' -]/g, ' ').replace(/\s+/g, ' ').trim();

  // ---------- where a row is ----------
  // { key, label, k (pill class), next (what happens next, for the editor) }
  function stage(r) {
    if (r.status === 'dropped') return { key: 'dropped', label: r.accepted === 'no' ? 'Declined' : 'Withdrawn', k: 'off' };
    if (r.set_apart_at) return { key: 'set_apart', label: 'Set apart', k: 'ok' };
    if (r.sustained_at) return { key: 'sustained', label: 'Sustained', k: 'ok', next: 'to be set apart' };
    if (r.accepted === 'yes') return { key: 'accepted', label: 'Accepted', k: 'ok', next: 'to be sustained' };
    if (r.accepted === 'no') return { key: 'declined', label: 'Declined', k: 'need' };
    if (r.sheet && truthy(r.answer)) return { key: 'answered', label: 'Answered: ' + (r.answer.length > 24 ? r.answer.slice(0, 22) + '…' : r.answer), k: 'need' };
    if (r.contacted_at) return { key: 'contacted', label: 'Contacted', k: 'wait', next: 'waiting on an answer' };
    // "who contacts" is information, not a step: assigned or not, the calling is still just proposed
    return { key: 'proposed', label: 'Proposed', k: 'wait', next: truthy(r.contact) ? r.contact + ' contacts them' : 'nobody assigned to contact them yet' };
  }
  // The same for someone tracked only on the Members without Callings sheet (callings.js person).
  function sheetState(p) {
    if (!p || p.deleted) return null;
    // the sheet's "text assignment / calling" column doubles as the calling on older rows
    const calling = String(p.proposed || p.assignment || '').trim();
    if (!calling) return null;
    const isTicked = NPCallings.isTicked;
    // the sheet's Answer is free text: yes-ish → accepted, a clear no → declined, anything else stays "answered" (shown as written)
    const answer = String(p.answer || '').trim();
    const accepted = /accept|^\s*y(es)?\s*$/i.test(answer) ? 'yes' : /declin|not at this time|moved|not in ward|undeliverable|^\s*n(o)?\s*$/i.test(answer) ? 'no' : null;
    return { sheet: true, person: p, name: p.name, calling, contact: p.proposed ? p.assignment : '', contacted_at: isTicked(p.texted) ? 'y' : null, accepted, answer, accepted_at: null, sustained_at: isTicked(p.sustained) ? 'y' : null, set_apart_at: null, status: 'open', notes: p.notes };
  }

  // ---------- lookups ----------
  const isMine = (r, m) => (r.member_id && r.member_id === m.id) || (r.lcr_uuid && m.lcr_uuid && r.lcr_uuid === m.lcr_uuid);
  function openFor(m) { return rows.find(r => r.status === 'open' && isMine(r, m)) || null; }
  function historyFor(m) { return rows.filter(r => r.status !== 'open' && isMine(r, m)); }
  // a callings-sheet person's pipeline row, if any (by LCR uuid, member link, or name)
  function rowForPerson(p) {
    const uuid = (p.lcr && p.lcr['Person UUID']) || (p.member && p.member.lcr_uuid) || null;
    return rows.find(r => r.status === 'open' && ((uuid && r.lcr_uuid === uuid) || (p.member && r.member_id === p.member.id) || norm(r.name) === norm(p.name) || norm(r.name) === norm(p.sheetName))) || null;
  }

  // ---------- data ----------
  async function load(force) {
    if (loaded && !force) return;
    if (loading) return loading;
    loading = (async () => {
      try { rows = (await rpc('admin_pipeline', { p_pass: ctx.getPass(), p_include_closed: true })) || []; unavailable = ''; }
      catch (e) { rows = []; unavailable = /admin_pipeline/.test(e.message) ? 'Run supabase/pipeline.sql in Supabase first.' : e.message; }
      loaded = true; loading = null;
    })();
    return loading;
  }
  async function save(values) {
    const id = await rpc('admin_pipeline_save', Object.assign({ p_pass: ctx.getPass(), p_id: null, p_member_id: null, p_lcr_uuid: null, p_contact: null, p_contacted_at: null, p_accepted: null, p_accepted_at: null, p_sustained_at: null, p_set_apart_at: null, p_notes: null, p_status: null, p_by: null }, values));
    await load(true);
    return rows.find(r => r.id === id) || null;
  }
  async function step(r, which, date) {
    await rpc('admin_pipeline_step', { p_pass: ctx.getPass(), p_id: r.id, p_step: which, p_date: date || todayIso(), p_by: null });
    await load(true);
  }
  async function remove(r) { await rpc('admin_pipeline_delete', { p_pass: ctx.getPass(), p_id: r.id }); await load(true); }
  // Start tracking a callings-sheet person here, copying what the sheet says; `extra` can add a step.
  async function trackSheet(s, extra) {
    const p = s.person;
    const v = { p_member_id: p.member ? p.member.id : null, p_lcr_uuid: (p.lcr && p.lcr['Person UUID']) || (p.member && p.member.lcr_uuid) || null, p_name: p.name, p_calling: s.calling, p_contact: s.contact || null,
      p_contacted_at: s.contacted_at ? todayIso() : null, p_accepted: s.accepted, p_accepted_at: s.accepted ? todayIso() : null, p_sustained_at: s.sustained_at ? todayIso() : null, p_notes: null };
    return save(Object.assign(v, extra || {}));
  }

  // Where a member is, for the Members tab's filter chips: the open row here, else the sheet's state.
  // { key, label, src: 'site' | 'sheet' } or null when nothing is in progress.
  function stageFor(m) {
    const r = openFor(m);
    if (r) return Object.assign({ src: 'site', calling: r.calling, contact: r.contact || '' }, stage(r));
    const s = NPCallings.personFor ? sheetState(NPCallings.personFor(m)) : null;
    if (s) return Object.assign({ src: 'sheet', calling: s.calling, contact: s.contact || '' }, stage(s));
    return null;
  }
  // One line per person for pasting into a text or meeting notes: "First Last — calling — who contacts".
  function copyLines(members, stageOf) {
    return members.map(m => [m, stageOf.get(m.id)]).filter(([, st]) => st)
      .map(([m, st]) => `${m.display_name || firstLast(m.name)} — ${st.calling} — ${st.contact || 'nobody assigned'}`);
  }
  // The chips, in process order. `test` gets the member and their stage (or null).
  const GROUPS = [
    ['all', 'Everyone', () => true],
    ['proposed', 'Proposed', (m, st) => !!st && st.key === 'proposed'],
    ['contacted', 'Waiting on an answer', (m, st) => !!st && (st.key === 'contacted' || st.key === 'answered')],
    ['accepted', 'Accepted · to be sustained', (m, st) => !!st && st.key === 'accepted'],
    ['sustained', 'Sustained · to be set apart', (m, st) => !!st && st.key === 'sustained'],
    ['declined', 'Declined', (m, st) => !!st && st.key === 'declined'],
    ['done', 'Set apart recently', m => historyFor(m).some(h => h.status === 'done' && h.set_apart_at && (Date.now() - new Date(h.set_apart_at + 'T00:00:00').getTime()) < 90 * 864e5)],
  ];

  // ---------- the Members column ----------
  // A compact line: calling · step pill · who contacts. Tapping it opens the editor (onOpen).
  function cell(m, onOpen) {
    if (unavailable) return el('span', { class: 'muted small', title: unavailable }, '—');
    const r = openFor(m);
    if (r) {
      const st = stage(r);
      return el('button', { class: 'pipe-cell', type: 'button', title: 'Edit this calling', onclick: () => onOpen(r, null) }, [
        el('b', {}, r.calling), el('span', { class: 'pill ' + st.k }, st.label),
        truthy(r.contact) && st.key !== 'set_apart' ? el('span', { class: 'muted' }, r.contact) : null,
      ]);
    }
    const s = NPCallings.personFor ? sheetState(NPCallings.personFor(m)) : null;
    if (s) {
      const st = stage(s);
      return el('button', { class: 'pipe-cell sheet', type: 'button', title: 'From the Members without Callings sheet — tap to track it here', onclick: () => onOpen(null, s) }, [
        el('b', {}, s.calling), el('span', { class: 'pill ' + st.k }, st.label), truthy(s.contact) ? el('span', { class: 'muted' }, s.contact) : null, el('span', { class: 'muted small' }, '· sheet'),
      ]);
    }
    const hist = historyFor(m)[0];
    return el('button', { class: 'pipe-cell empty', type: 'button', title: 'Propose a calling', onclick: () => onOpen(null, null) }, hist && hist.status === 'done' ? [el('span', { class: 'muted small' }, hist.calling + ' · set apart ' + fmtDay(hist.set_apart_at)), el('span', { class: 'muted' }, '+')] : el('span', { class: 'muted' }, '+ propose'));
  }

  // ---------- the editor ----------
  // r: an existing row (or null), pre: a sheet state to start from (or null). onDone(changed) closes it.
  function editor(m, r, pre, onDone) {
    const v = r || pre || {};
    const date = (id, label, val, hint) => {
      const chk = el('input', { type: 'checkbox', class: 'pipe-chk', id: 'pc-' + id });
      const inp = el('input', { type: 'date', class: 'edit-field pipe-date', id: 'pd-' + id });
      const has = !!val; chk.checked = has; inp.value = has ? (String(val).length === 10 ? val : todayIso()) : ''; inp.hidden = !has;
      chk.addEventListener('change', () => { inp.hidden = !chk.checked; if (chk.checked && !inp.value) inp.value = todayIso(); });
      return { chk, inp, row: el('label', { class: 'edit-row check pipe-step' }, [el('span', {}, label), el('span', { class: 'check-wrap' }, [chk, inp, hint ? el('span', { class: 'muted small' }, hint) : null])]) };
    };
    const calling = el('input', { class: 'edit-field', placeholder: 'e.g. Ward missionary', maxlength: 120 }); calling.value = v.calling || '';
    const contact = el('input', { class: 'edit-field', placeholder: 'e.g. Bishop Dancy', maxlength: 120 }); contact.value = v.contact || '';
    const contacted = date('contacted', 'Contacted', v.contacted_at);
    const accepted = el('select', { class: 'edit-field' }, [el('option', { value: '' }, 'Not answered yet'), el('option', { value: 'yes' }, 'Yes — accepted'), el('option', { value: 'no' }, 'No — declined')]); accepted.value = v.accepted || '';
    const acceptedAt = el('input', { type: 'date', class: 'edit-field pipe-date' }); acceptedAt.value = v.accepted_at && String(v.accepted_at).length === 10 ? v.accepted_at : (v.accepted ? todayIso() : ''); acceptedAt.hidden = !v.accepted;
    accepted.addEventListener('change', () => { acceptedAt.hidden = !accepted.value; if (accepted.value && !acceptedAt.value) acceptedAt.value = todayIso(); });
    const sustained = date('sustained', 'Sustained', v.sustained_at);
    const setApart = date('setapart', 'Set apart', v.set_apart_at, 'closes it');
    const notes = el('textarea', { class: 'edit-field', rows: 2, placeholder: 'Anything worth remembering', maxlength: 1000 }); notes.value = v.notes || '';
    const msg = el('span', { class: 'muted' });
    const hist = historyFor(m);
    const form = el('form', { class: 'edit-form pipe-form', onsubmit: async e => {
      e.preventDefault();
      if (calling.value.trim().length < 2) { msg.textContent = 'Name the proposed calling.'; calling.focus(); return; }
      msg.textContent = 'Saving…';
      try {
        await save({ p_id: r ? r.id : null, p_member_id: m.id, p_lcr_uuid: m.lcr_uuid || null, p_name: m.display_name || firstLast(m.name), p_calling: calling.value.trim(), p_contact: contact.value.trim() || null,
          p_contacted_at: contacted.chk.checked ? contacted.inp.value || todayIso() : null, p_accepted: accepted.value || null, p_accepted_at: accepted.value ? acceptedAt.value || todayIso() : null,
          p_sustained_at: sustained.chk.checked ? sustained.inp.value || todayIso() : null, p_set_apart_at: setApart.chk.checked ? setApart.inp.value || todayIso() : null, p_notes: notes.value.trim() || null,
          p_status: r && r.status === 'dropped' && accepted.value !== 'no' ? 'open' : null });
        toast(r ? 'Saved' : 'Tracking ' + (m.display_name || firstLast(m.name)) + '’s calling'); onDone(true);
      } catch (err) { msg.textContent = /admin_pipeline/.test(err.message) ? 'Run supabase/pipeline.sql in Supabase first.' : 'Not saved: ' + err.message; }
    } }, [
      el('p', { class: 'muted small pipe-intro' }, pre ? 'Copied from the Members without Callings sheet — save to track it here (the sheet is not changed).' : 'In order: proposed → contacted → accepted → sustained → set apart. Ticking a later step fills in the earlier ones.'),
      el('label', { class: 'edit-row' }, [el('span', {}, 'Proposed calling'), calling]),
      el('label', { class: 'edit-row' }, [el('span', {}, 'Who contacts'), contact]),
      contacted.row,
      el('label', { class: 'edit-row' }, [el('span', {}, 'Accepted'), el('span', { class: 'check-wrap' }, [accepted, acceptedAt])]),
      sustained.row,
      setApart.row,
      el('label', { class: 'edit-row' }, [el('span', {}, 'Notes'), notes]),
      el('div', { class: 'edit-actions' }, [
        el('button', { class: 'btn small', type: 'submit' }, r ? 'Save' : 'Start tracking'),
        r && r.status === 'open' ? el('button', { class: 'btn small secondary', type: 'button', title: 'The calling was withdrawn or they said no — keeps the row, closes it', onclick: async () => { if (!confirm('Close this without finishing it (withdrawn / not going ahead)?')) return; try { await rpc('admin_pipeline_save', { p_pass: ctx.getPass(), p_id: r.id, p_member_id: null, p_lcr_uuid: null, p_name: r.name, p_calling: r.calling, p_contact: r.contact, p_contacted_at: r.contacted_at, p_accepted: r.accepted, p_accepted_at: r.accepted_at, p_sustained_at: r.sustained_at, p_set_apart_at: null, p_notes: r.notes, p_status: 'dropped', p_by: null }); await load(true); toast('Closed'); onDone(true); } catch (err) { msg.textContent = 'Failed: ' + err.message; } } }, 'Withdraw') : null,
        r ? el('button', { class: 'btn small secondary danger', type: 'button', onclick: async () => { if (!confirm('Delete this calling record for ' + r.name + '?')) return; try { await remove(r); toast('Deleted'); onDone(true); } catch (err) { msg.textContent = 'Failed: ' + err.message; } } }, 'Delete') : null,
        el('button', { class: 'btn small secondary', type: 'button', onclick: () => onDone(false) }, 'Cancel'),
        msg,
      ]),
      hist.length ? el('p', { class: 'muted small' }, 'Before: ' + hist.map(h => h.calling + ' — ' + (h.status === 'done' ? 'set apart ' + fmtDay(h.set_apart_at) : stage(h).label.toLowerCase() + (h.updated_at ? ' ' + fmtDay(h.updated_at) : ''))).join(' · ')) : null,
    ]);
    setTimeout(() => calling.focus(), 0);
    return form;
  }

  // ---------- for Leaders › Overview ----------
  // Open rows by stage, plus callings-sheet people at the same stage who have no row here.
  function lists(people) {
    const open = rows.filter(r => r.status === 'open');
    const toSustain = open.filter(r => stage(r).key === 'accepted'), toSetApart = open.filter(r => stage(r).key === 'sustained');
    for (const p of people || []) {
      const s = sheetState(p); if (!s || rowForPerson(p)) continue;
      if (s.sustained_at) toSetApart.push(s); else if (s.accepted === 'yes') toSustain.push(s);
    }
    // oldest first; people known only from the sheet (no dates) at the end, in sheet order
    const when = r => r.sheet ? '9999' : (r.sustained_at || r.accepted_at || '');
    const byDate = (a, b) => String(when(a)).localeCompare(String(when(b)));
    return { toSustain: toSustain.sort(byDate), toSetApart: toSetApart.sort(byDate), open };
  }

  function init(c) { ctx = c; }
  function data() { return { rows, loaded, unavailable }; }
  return { init, load, refresh: () => load(true), data, stage, sheetState, stageFor, GROUPS, copyLines, openFor, historyFor, rowForPerson, cell, editor, save, step, remove, trackSheet, lists, fmtDay };
})();
