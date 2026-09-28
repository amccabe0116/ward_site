# Ward site template

A member-facing website for a ward (Sunday roll / check-in, announcements, a calendar, meeting requests
for the Bishop, and — if the ward wants it — missionary meal sign-ups), plus a Leaders page for running
it all. Built as a generic template: nothing about a specific ward's classes, organizations, or
companionships is hardcoded — a ward configures its own roll classes and (if used) meal companionships
from the Leaders page, and can change either at any time.

```
index.html          landing: roll-class buttons + connect links + What's happening (posts) + the weekly email
roll.html            ?class=<key> — tap your name, check in (classes are ward-configured, see below)
meals.html           feed the missionaries — only shown if the ward turns meal sign-ups on
bishop.html           request a meeting with the Bishop (name, phone, email, temple-recommend checkbox)
post.html             share an announcement: anyone can submit a post (with a flyer) for leaders to approve
calendar.html         subscribe to the ward calendar (calendar.ics) — Apple / Google / Outlook / any URL
e.html                one post on its own page (?id=…); e/<id>.html = the script's copy with Open Graph tags
404.html              GitHub Pages' not-found page — renders the post for an e/<id> link not yet published
calendar.ics          every approved event, written by the Apps Script (syncCalendar); cal/<id>.ics = one each
posts.js              posts shared code: the card, the home-page list, the add/edit form, flyer resize + upload
terms.html            Text-list Terms of Service (required by SimpleTexting) — review/edit for your ward
privacy.html          Text-list Privacy Policy (required by SimpleTexting) — review/edit for your ward
keys.html             "The keys": a mini game, ward-wide high scores
admin.html            Leaders page: 12-hour login, overview, attendance, inbox, announcements, callings, members, service, settings
overview.js           Leaders › Overview: roll size, men/women, moved in last 30 days, sacrament attendance, recent converts
callings.js           Leaders › Callings: the members-without-callings list + one-person-per-slide meeting deck
pipeline.js           callings in progress for any member (proposed → contacted → accepted → sustained → set apart)
app.js                shared site code: Supabase calls, dynamic roll classes/windows, icons, small helpers
config.js             ward name, Supabase URL / anon key, links — fill this in for your ward
announcements.json    fallback copy of the weekly announcements, written by the Sunday-night job
img/                  flyers attached to the announcements email
supabase/schema.sql    database (tables, RLS, RPC functions) — paste into the SQL editor once
supabase/guests.sql    guests/visitors table + functions (part of schema.sql too)
supabase/windows.sql   check-in time windows + settings (part of schema.sql too)
supabase/notes.sql     hardened Leaders login (admin_login/admin_logout/session tokens) (part of schema.sql too)
supabase/inbox.sql     editable announcements + Bishop meeting requests (part of schema.sql too)
supabase/sheets.sql    mirrors the two leadership Google Sheets (callings doc, new-member form)
supabase/edits.sql     site-side edits to the callings sheet, written back by the Apps Script
supabase/flags.sql     lets a callings-sheet row be marked deleted (and undone) from the site
supabase/keys.sql      high-score board for the mini game
supabase/addrow.sql    Add to sheet: lets the site pre-fill the callings sheet's intake columns
supabase/posts.sql     posts (events / notices with flyers), public submission, approval, the "flyers" bucket
supabase/repeat.sql    repeating posts (weekly / every 2 weeks / monthly), cancelling one date
supabase/bishop.sql    Bishop meeting requests texted to the executive secretary
supabase/meals.sql     missionary meals: missionary_meals table + ward-configured companionships
supabase/pipeline.sql  callings in progress for any member (calling_pipeline)
scripts/lcr-sync.js       runs inside a signed-in LCR tab: roster → Supabase, check-ins → LCR
scripts/lcr-report.js     runs inside a signed-in LCR tab: members-without-callings / moved-in report → site
scripts/lcr-sacrament.js  runs inside a signed-in LCR tab: sacrament meeting headcounts → site
scripts/lcr-converts.js   runs inside a signed-in LCR tab: recent converts → site
scripts/announcements.gs  Google Apps Script: weekly announcements email → site, texting, calendar files
scripts/publish_announcements.py  same thing from a raw .eml, for manual use
scripts/sheets_to_json.py manual fallback: two .xlsx exports → the JSON the sheets functions store
```

## Roll classes and meal companionships are ward-configured, not hardcoded

This template was built to work for any ward — a family ward with Primary / Young Men / Young Women /
Sunday School / Priesthood-Relief Society, a YSA ward with two combined classes, or anything else. So
**there is no fixed list of classes in the code.** Instead:

- **Roll classes** (Leaders › Settings › Roll classes): add, rename, or remove a class any time. Each
  class has a key (used internally, e.g. `young_men`), a label and short label shown on the site, a
  check-in window (open/close time, in Eastern), and optionally an `orgs` list for a class that combines
  sub-groups (e.g. a combined "Priesthood / Relief Society" class with Elders Quorum and Relief Society
  as its two `orgs`) — attendance can then be broken out by sub-group. This is stored as a single JSON
  setting (`roll_classes`) read by every roll page and by `admin.html` through `NP.loadClasses()`, so a
  class change takes effect everywhere within seconds, with no code or database migration.
- **Missionary meal companionships** (Leaders › Service, if the ward uses `meals.html`): add or remove a
  companionship (Elders, a Sisters' companionship, more than one at once) any time an assignment changes.
  Each one has a label, whether it's Elders or Sisters, an area description, and a phone number. Stored
  the same way, as settings the `admin_set_meal_companionship` function manages.

If the ward doesn't use missionary meal sign-ups at all, just leave Leaders › Service's companionship
list empty and the "Feed the missionaries" card never appears on the home page.

## How it fits together

1. **QR code → the ward's site.** People pick their roll class on the home page, find their name, tap
   Check in. Check-ins go to Supabase through `check_in()`; the anon key can only call the roll functions
   (see the grants in `schema.sql`).
2. **Sunday night — announcements.** A Google Apps Script (`scripts/announcements.gs`) reads the ward's
   weekly announcements email (sent from LCR), commits any flyers to `img/` and a fallback
   `announcements.json`, and publishes the text into the `announcements` table. Leaders can edit the
   current week on the Leaders page; the home page reads the database first and falls back to the JSON.
3. **Sunday night — LCR.** A sync (run from a signed-in LCR tab, `scripts/lcr-sync.js`) refreshes the
   roster from LCR's Class and Quorum Attendance report (the only thing that marks a member active or
   inactive) and clicks the attendance buttons for everyone who checked in on the site, then pulls the
   reports the Leaders page reads (members without callings, moved-in, sacrament headcounts, converts).
   Rows show as *synced* on the admin page once LCR has them.
4. **Leaders › Callings** and **Leaders › Overview** track callings in progress for any member
   (`pipeline.js`, `calling_pipeline` table) alongside the leadership's own "members without callings"
   Google Sheet and the new-member form responses, with a meeting-deck view for handing out assignments
   and an Overview landing page (roll size, men/women split, moved-in, sacrament attendance, recent converts).
5. **Announcements as posts** (`supabase/posts.sql`, `posts.js`). The home page's *What's happening*
   list is built from posts — events or notices, soonest first — that anyone can submit via `post.html`
   (with a flyer) for leaders to approve, or that leaders post directly. Posts can repeat
   (`supabase/repeat.sql`), carry Add-to-calendar links, and drive both the subscribable ward calendar
   and a "Text a reminder" SimpleTexting campaign from a post's card. The weekly email is built from the
   same live posts (Leaders › Announcements › *Email version*).
6. **Bishop meeting requests.** `bishop.html` stores a request and pokes the Apps Script web app, which
   texts the ward's designated number (Leaders › Settings › Bishop meeting requests) with the details.
   Requests also show in Leaders › Inbox until marked handled.
7. **Feed the missionaries** (optional — `supabase/meals.sql`). `meals.html` lets someone pick a
   companionship the ward is currently feeding and an open day on a rolling calendar (`meals_days_ahead`
   days ahead, 42 by default). A brother taking a sisters' companionship out names the sister coming
   along. Leaders › Service configures which companionships exist right now, turns sign-ups on or off,
   and manages bookings (Done / Cancel / Delete, phone sign-ups).

## Security model

- The public key in `config.js` can only call the functions granted to `anon` — roll lookups, check-ins,
  post/meeting-request submission. Every table has RLS on and no anon policies, so nothing is readable
  directly.
- Everything under **Leaders** goes through `_check_admin()`: a 12-hour session token from
  `admin_login()` (bcrypt-checked passphrase; 10 failures lock the page for 15 minutes; a wrong
  passphrase costs a full second), or the passphrase itself for the sync scripts.
- Pick a long passphrase and keep HTTPS enforced on GitHub Pages.

## Setup (one time)

1. **Supabase:** new project → SQL editor → run `supabase/schema.sql`, then run each other
   `supabase/*.sql` file you want (posts, repeat, bishop, meals, keys, pipeline, sheets, edits, flags,
   addrow) → `select set_admin_passphrase('…');`.
2. **Roll classes:** either use the example `admin_set_roll_classes(...)` call at the bottom of
   `schema.sql` as a starting point (edit the class list for your ward first), or just open the Leaders
   page → Settings › Roll classes and add them there — no SQL needed either way.
3. **Meal companionships** (only if the ward feeds missionaries): Leaders page → Service, add a
   companionship for each one currently assigned.
4. **`config.js`:** fill in `wardName`, `supabaseUrl`, `supabaseAnonKey`, `timeZone`, and any community
   links (Facebook group, WhatsApp, text list).
5. **GitHub Pages:** Settings → Pages → deploy from `main` / root; add a custom domain if the ward has
   one.
6. **`scripts/announcements.gs`:** deploy as its own Apps Script project bound to the Google account
   running the weekly announcements email; edit the `SITE` constant near the top to the ward's real site
   URL (Apps Script has no browser `location`, so this one has to stay a hand-edited constant), and set
   the script properties it expects (SimpleTexting token/list, etc., if used).
7. **`privacy.html` / `terms.html`:** required only if the ward uses the text-list feature (SimpleTexting
   requires a public privacy policy and terms page) — review and edit the ward name, stake, and
   description before publishing; this template intentionally does not auto-generate that legal text.

## Local preview

`python3 -m http.server 8000` and open http://localhost:8000 — the roll pages need a real Supabase
project (or a mocked `/rest/v1/rpc/*`).
