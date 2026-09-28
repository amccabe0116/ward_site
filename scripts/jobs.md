# Scheduled jobs (Claude scheduled tasks)

Both run on Sunday evenings (America/New_York). Prompts below are what each task fires with.

## 1. Publish announcements — Google Apps Script, Sundays 9–10 PM ET

Runs in Joseph's Google account, not in Claude: `scripts/announcements.gs`. It reads the
"Northpoint YSA Ward Weekly Announcements" email (attachments included, Trash included), writes
`announcements.json` + `img/ann-*` to the repo through the GitHub API, then labels and archives
the email. Setup steps are at the top of that file. Re-running it is safe (it skips an email it
already published). If it ever breaks, `scripts/publish_announcements.py` does the same job
from a raw `.eml`.

## 1b. The weekly email now comes from the posts

Leaders › Announcements → Email version builds it from the live posts. Send it from LCR's
Send a Message (https://lcr.churchofjesuschrist.org/mlt/messaging?lang=eng): its editor keeps
h1/h2/bold/links/lists from a formatted paste and drops images, so tick the flyers, Download
selected (.zip), unzip and drop the set into Attachments (jpg/png/pdf/docx/xlsx only — no .ics,
25 MB each). The Apps Script import of that email keeps running but the home page hides the
imported text whenever there are posts.

Calendars: every dated post in the email has "Add to calendar: Google · Apple / Outlook" links
(a calendar.google.com template link, and cal/<id>.ics on the site), and the header invites people
to subscribe once at calendar.html (calendar.ics — Apple hourly, Google about daily). The .ics files
are committed by `syncCalendar` in announcements.gs — on every 6-hour sheet sync and straight
from the Leaders page when a dated post is approved / edited / taken down / deleted (web app
action `calendar`; "Rebuild calendar files" on the Email version panel does it by hand). An email
can't put an event into someone's calendar on its own (only registered senders like airlines get
that from Gmail), so links + the subscription are the whole story.

Repeats: a post can repeat weekly / every 2 weeks / monthly (supabase/repeat.sql); the lineup and
the email show its next 1–4 dates, leaders cancel a single date from the card. Text a reminder on a
card sends a SimpleTexting campaign to the ward list with the post's short link (e.html?id=…) —
same Apps Script deployment, action `remind`.

## 2. The weekly LCR sync (needs Joseph's Mac + desktop app) — Sundays 9:30 PM ET

One run does four things, in this order: refresh the roster (this is the ONLY thing that marks a
member active/inactive — there is no switch on the Leaders page), push the day's check-ins into
LCR, copy the four LCR reports the Leaders page reads, and report back. LCR's page blocks calls
to Supabase (CSP), so it is two halves you shuttle between: `scripts/db-sync.js` (Supabase, runs
in a site tab) and the LCR scripts (run in the LCR tab). All are on the site:
https://northpointysa.com/scripts/<name>.js — fetch them with curl in the cloud shell, paste the
body into the tab with javascript_exec (turn the IIFE into `window.__fn = async function (cfg) {…}`
so it can be called more than once).

```
You maintain the North Point YSA ward site (northpointysa.com). Task: the weekly LCR sync —
roster, today's check-ins into LCR, the LCR report copies for the Leaders page, and closing out
tracked callings that LCR now has.
Config: SUPABASE_URL=<url>, ANON_KEY=<publishable key>, PASS=<admin passphrase or a leaders token>.
Runbook: https://northpointysa.com/scripts/jobs.md §2 — follow it; the steps are:

A. Open https://lcr.churchofjesuschrist.org/mlt/report/class-and-quorum-attendance?lang=eng in
   the built-in browser pane. Wait ~5 s, get_page_text. If it shows the Church "Sign In" page
   instead of "Class and Quorum Attendance", stop and tell Joseph the LCR session expired: sign
   in in the browser pane and say "sync". Never type credentials.
B. Open a second tab at https://northpointysa.com/admin.html (the site tab).
C. ROSTER — LCR tab: lcr-sync { mode: 'roster', week, from: 0, to: 140 } then { from: 140, to: 400 };
   site tab: collect both slices, then ONE db-sync { action: 'roster', classes, members: <all>,
   deactivateMissing: true }. (Sending slices with deactivateMissing:true would deactivate
   everyone not in that slice.) If it would deactivate more than ~10 people, first check
   https://lcr.churchofjesuschrist.org/mlt/report/members-moved-out?lang=eng — they should all
   be on it; if not, stop and ask.
D. CHECK-INS — site tab: db-sync { action: 'pending' } → `pending`, `week`. If empty, note
   "nothing to push" and carry on with E. LCR tab: lcr-sync { mode: 'push', week, pending,
   clickDelayMs: 350 } (in two batches of ~60 if there are more). Site tab: db-sync
   { action: 'mark', ids: <synced ids> }. Retry `failed` once; `noCell` = the record left the
   ward or arrived after the roster refresh — list them by name. Guests are NOT sent to LCR
   (LCR's Visitors tab only takes totals); if a guest's name matches a roster member, add them as
   that member on the Leaders page and remove the guest row.
E. REPORTS — each: run the LCR script in the LCR tab, then db-sync { action: 'sheet', key, title,
   sourceUrl, headers, rows } in the site tab.
   1. Members without Callings (Leaders › Callings):
      https://lcr.churchofjesuschrist.org/mlt/report/create-a-report/custom-reports-details/186530a9-e9f3-46ab-9981-df0e4789315e
      wait for "Count: N", run lcr-report.js { key: 'lcr_callings', title: 'LCR: Members without Callings' }.
   2. Members Moved In (Overview): https://lcr.churchofjesuschrist.org/mlt/report/members-moved-in?lang=eng,
      set "Show for past" to 3 Months (a React select: set the value through the native setter and
      dispatch change; wait ~15 s for the row count to change), run lcr-report.js
      { key: 'lcr_moved_in', title: 'LCR: Members Moved In (past 3 months)' }; store only the
      columns Person UUID, Name, Age, Move In Date, Prior Unit, and strip a leading "Warning" off
      a name (LCR's record-warning icon leaks into the text).
   3. Sacrament attendance (Overview): https://lcr.churchofjesuschrist.org/report/sacrament-attendance?lang=eng,
      run lcr-sacrament.js (current year; in January also run it with year: <last year> and merge).
   4. Recent converts (Overview): https://lcr.churchofjesuschrist.org/one-work/progress-record?lang=eng
      (Covenant Path Progress, "New Members" tab — converts from the last two years), wait for the
      cards, run lcr-converts.js → key 'lcr_converts'.
   5. Members WITH callings — closes out the callings tracked on Leaders › Members:
      https://lcr.churchofjesuschrist.org/mlt/report/member-callings?lang=eng, wait for "Count: N",
      run lcr-report.js { key: 'lcr_with_callings', title: 'LCR: Members with Callings' }, then in
      the site tab db-sync { action: 'callings', headers, rows, sourceUrl } (NOT 'sheet'): it stores
      the copy and removes every tracked calling that has reached "set apart" and now shows in LCR
      (same person, a calling sustained on/after the tracked date). It returns `removed` (with
      whether LCR shows them set apart) and `waiting` (set apart on the site, not in LCR yet —
      mention those to the clerk).
   The leaders' Google Sheet (notes / flags) is NOT copied here — the Apps Script does that
   every 6 hours and from "Refresh from Google Sheets" on the Callings tab.
F. Report in one paragraph: roster (size, added / removed by name), check-ins (week, pushed /
   already marked / no cell by name, guests), the five report row counts, and the callings closed
   out (removed) or still waiting on the clerk. Mention if LCR's sacrament headcount for the day
   differs from the site's check-ins.
```

Notes:
- The LCR sign-in lasts under an hour; the run has to start right after Joseph signs in.
- The push clicks LCR's own buttons: ~1 s per person; 110 people ≈ 2 minutes per batch.
- Callings in progress (Leaders › Members / Overview, supabase/pipeline.sql) live only on the
  site. Sustaining and setting apart are recorded by hand on the Overview; step E.5 is what
  retires a tracked calling once the clerk has it in LCR.

(The SimpleTexting text list is NOT fed from LCR: the Apps Script's `syncTextList` adds only the
 people who ticked "agree" on the New Member Form's texting question, every 6 hours or from
 Settings → Sync now. Nothing to do here for it.)

Notes from the 2026-09-27 run (first with step E.5): LCR's Member Callings report comes out with
the columns "", Name, Gender, Age, Birth Date, Phone Number, Organizations, Calling, Sustained,
Set Apart; "Set Apart" was blank for everyone, so the close-out goes by the Sustained date.
db-sync's 'callings' action now drops Birth Date and Phone Number (and the unnamed icon column)
before storing the copy — the site never needed them. Roster 246 (+1), 111 check-ins pushed
111/111 in two batches of ~56 (about a minute each), LCR's sacrament count for the day (55) was
still a partial when the run happened at ~2 PM.

Notes from the 2026-09-17 run: LCR rendered the custom report's column headers as untranslated
keys ("record.preferred.name"); lcr-report.js now maps those back to the labels the site expects.
The attendance report listed 243 members vs 273 on the site — all 30 were on LCR's Members Moved
Out report (mostly processed that day), so deactivateMissing:true was right; check that report
(https://lcr.churchofjesuschrist.org/mlt/report/members-moved-out?lang=eng) before deactivating
a large batch. The Members Moved In page needs ~15 s to render its table; after switching
"Show for past" to 3 Months wait for the row count to change.

First real run (2026-09-14, from Joseph's Mac): Sept 6 → 116 of 119 check-ins into LCR, Sept 13 →
105 of 105; 112 + 104 clicks took about 2 minutes each. Three Sept 6 rows stay "pending" forever
because those two records moved out of the ward before the sync (Makayla Blair, Trey Gaul). The
LCR sign-in lasted under an hour, so the run has to start right after Joseph signs in.
