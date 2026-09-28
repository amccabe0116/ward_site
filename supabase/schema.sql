-- Ward site — roll / attendance schema
-- Paste this whole file into the Supabase SQL editor of your project and run it once.
-- Safe to re-run: everything is CREATE ... IF NOT EXISTS / CREATE OR REPLACE.
--
-- Roll classes (Primary, Young Men, Young Women, Sunday School, Elders Quorum, Relief
-- Society — whatever your ward uses) are NOT hardcoded here. They are configured on the
-- Leaders › Settings page (stored as the 'roll_classes' row in the settings table below)
-- so a ward can add, rename or remove classes at any time without touching this schema.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.members (
  id                 uuid primary key default gen_random_uuid(),
  lcr_uuid           uuid unique,            -- LCR person uuid (used when pushing attendance back)
  lcr_classes        jsonb not null default '[]'::jsonb, -- [{"orgName","classUuid","orgTypeId"}] from LCR
  name               text not null,          -- as LCR shows it: "Last, First Middle"
  display_name       text not null,          -- "First Last" for the roll
  sex                text check (sex in ('M','F')),
  org                text,                   -- optional sub-group within a class (e.g. "EQ" / "RS") — free text, ward-defined
  age                int,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists members_active_name_idx on public.members (active, display_name);

create table if not exists public.attendance (
  id             bigserial primary key,
  meeting_date   date not null,
  class          text not null,          -- a key from the ward's 'roll_classes' setting
  member_id      uuid not null references public.members(id) on delete cascade,
  created_at     timestamptz not null default now(),
  synced_to_lcr_at timestamptz,
  unique (meeting_date, class, member_id)
);
create index if not exists attendance_date_class_idx on public.attendance (meeting_date, class);

create table if not exists public.settings (
  key    text primary key,
  value  text not null
);

-- ---------------------------------------------------------------------------
-- Row Level Security: the anon key can do nothing directly. All access goes
-- through the functions below (SECURITY DEFINER), which decide what is allowed.
-- ---------------------------------------------------------------------------
alter table public.members    enable row level security;
alter table public.attendance enable row level security;
alter table public.settings   enable row level security;
revoke all on public.members, public.attendance, public.settings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public._check_admin(p_pass text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_fail int; v_at timestamptz;
begin
  if p_pass is null or length(p_pass) < 4 then raise exception 'not authorized' using errcode = '42501'; end if;
  if exists (select 1 from admin_sessions where token = p_pass and expires_at > now()) then return; end if;
  select coalesce((select value from settings where key = 'admin_fail_count'), '0')::int,
         (select value from settings where key = 'admin_fail_at')::timestamptz
    into v_fail, v_at;
  if v_fail >= 10 and v_at is not null and v_at > now() - interval '15 minutes' then
    raise exception 'Too many failed attempts — try again in 15 minutes' using errcode = '42501';
  end if;
  select value into v_hash from settings where key = 'admin_passphrase_hash';
  if v_hash is null or crypt(p_pass, v_hash) <> v_hash then
    perform pg_sleep(1);
    raise exception 'not authorized' using errcode = '42501';
  end if;
end $$;

-- Most recent Sunday (America/New_York), or today if today is Sunday.
create or replace function public.current_meeting_date() returns date
language sql stable as $$
  select (
    (now() at time zone 'America/New_York')::date
    - extract(dow from (now() at time zone 'America/New_York'))::int
  )::date
$$;

-- The ward's configured roll classes, e.g.
--   [{"key":"primary","label":"Primary","short":"Primary","orgTypeIds":[...]},
--    {"key":"sunday_school","label":"Sunday School","short":"Sunday School","orgTypeIds":[...]}, ...]
-- Stored as the 'roll_classes' setting so leaders can add/rename/remove classes at any time
-- (Leaders › Settings). Falls back to an empty list until configured.
create or replace function public.roll_classes()
returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select value::jsonb from settings where key = 'roll_classes'), '[]'::jsonb)
$$;
grant execute on function public.roll_classes() to anon;

-- True if p_class is one of the ward's configured roll class keys.
create or replace function public._valid_class(p_class text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from jsonb_array_elements(roll_classes()) c where c->>'key' = p_class)
$$;

-- Admin: replace the whole roll-classes list in one call (validated shape).
create or replace function public.admin_set_roll_classes(p_pass text, p_classes jsonb)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  if jsonb_typeof(p_classes) <> 'array' then raise exception 'roll classes must be a list'; end if;
  if exists (select 1 from jsonb_array_elements(p_classes) c where coalesce(c->>'key','') = '' or coalesce(c->>'label','') = '') then
    raise exception 'each class needs a key and a label';
  end if;
  insert into settings (key, value) values ('roll_classes', p_classes::text)
  on conflict (key) do update set value = excluded.value;
end $$;
grant execute on function public.admin_set_roll_classes(text, jsonb) to anon;

-- ---------------------------------------------------------------------------
-- Public (anon) functions used by the roll pages
-- ---------------------------------------------------------------------------

-- Active members for the roll. Only the fields the page needs.
create or replace function public.roll_members()
returns table (id uuid, display_name text, org text)
language sql stable security definer set search_path = public, extensions as $$
  select id, display_name, org
  from members
  where active
  order by lower(name)
$$;

-- Who is already checked in for a given meeting/class (ids only).
create or replace function public.checked_in(p_date date, p_class text)
returns setof uuid
language sql stable security definer set search_path = public, extensions as $$
  select member_id from attendance where meeting_date = p_date and class = p_class
$$;

-- Check in one or more members. Only allows dates within the last 8 days
-- (so a stale phone can't write to a random week). Duplicates are ignored.
create or replace function public.check_in(p_date date, p_class text, p_member_ids uuid[])
returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v_count int;
begin
  if not _valid_class(p_class) then raise exception 'bad class'; end if;
  if not _window_open(p_class) then raise exception 'Check-in is closed right now' using errcode = 'P0001'; end if;
  if p_date > (now() at time zone 'America/New_York')::date + 1
     or p_date < (now() at time zone 'America/New_York')::date - 8 then
    raise exception 'date out of range';
  end if;
  insert into attendance (meeting_date, class, member_id)
  select p_date, p_class, m.id
  from members m
  where m.id = any(p_member_ids) and m.active
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Undo a check-in (someone tapped the wrong name).
create or replace function public.check_out(p_date date, p_class text, p_member_id uuid)
returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v_count int;
begin
  delete from attendance
  where meeting_date = p_date and class = p_class and member_id = p_member_id
    and created_at > now() - interval '3 hours';   -- only recent mistakes
  get diagnostics v_count = row_count;
  return v_count;
end $$;

grant execute on function public.roll_members()                    to anon;
grant execute on function public.checked_in(date, text)            to anon;
grant execute on function public.check_in(date, text, uuid[])      to anon;
grant execute on function public.check_out(date, text, uuid)       to anon;
grant execute on function public.current_meeting_date()            to anon;

-- ---------------------------------------------------------------------------
-- Admin functions (passphrase-gated). Used by admin.html and the LCR sync.
-- ---------------------------------------------------------------------------

-- Set / change the admin passphrase. Run this once from the SQL editor:
--   select set_admin_passphrase('CHOOSE-A-PASSPHRASE');
-- (Only callable from the SQL editor / service role — not granted to anon.)
create or replace function public.set_admin_passphrase(p_pass text) returns void
language sql security definer set search_path = public, extensions as $$
  insert into settings (key, value)
  values ('admin_passphrase_hash', crypt(p_pass, gen_salt('bf')))
  on conflict (key) do update set value = excluded.value
$$;
revoke execute on function public.set_admin_passphrase(text) from anon, authenticated, public;

-- Attendance for one Sunday, with names, for every class.
create or replace function public.admin_attendance(p_pass text, p_date date)
returns table (
  attendance_id bigint, class text, member_id uuid, display_name text, name text,
  org text, lcr_uuid uuid, lcr_classes jsonb, created_at timestamptz, synced_to_lcr_at timestamptz
)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query
    select a.id, a.class, m.id, m.display_name, m.name, m.org, m.lcr_uuid, m.lcr_classes,
           a.created_at, a.synced_to_lcr_at
    from attendance a join members m on m.id = a.member_id
    where a.meeting_date = p_date
    order by a.class, lower(m.display_name);
end $$;

-- Sundays that have any attendance, newest first (for the admin date picker). Per-class
-- counts (including guests) come back as one jsonb object keyed by class, e.g. {"primary":12,...}.
create or replace function public.admin_meeting_dates(p_pass text)
returns table (meeting_date date, counts jsonb)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query
    with x as (
      select a.meeting_date, a.class from attendance a
      union all
      select g.meeting_date, g.class from attendance_guests g
    )
    select x.meeting_date, coalesce(jsonb_object_agg(x.class, x.n), '{}'::jsonb)
    from (select meeting_date, class, count(*) as n from x group by meeting_date, class) x
    group by x.meeting_date
    order by x.meeting_date desc
    limit 52;
end $$;

-- Full member list for the admin page.
create or replace function public.admin_members(p_pass text)
returns setof public.members
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select * from members order by active desc, lower(name);
end $$;

-- Import / refresh members from LCR. p_members is a JSON array of objects:
--   { "lcr_uuid": "…", "name": "Last, First", "display_name": "First Last",
--     "sex": "M"|"F", "org": "EQ"|"RS"|…, "age": 24,
--     "lcr_classes": [{"orgName":"Adult Sunday School","classUuid":"…","orgTypeId":1255}, …] }
-- Existing rows are matched on lcr_uuid (fallback: exact name).
-- If p_deactivate_missing is true, members not in the list are marked inactive.
create or replace function public.admin_upsert_members(p_pass text, p_members jsonb, p_deactivate_missing boolean default true)
returns table (inserted int, updated int, deactivated int)
language plpgsql security definer set search_path = public, extensions as $$
declare v_ins int := 0; v_upd int := 0; v_deact int := 0; r record;
begin
  perform _check_admin(p_pass);
  create temp table _incoming on commit drop as
    select (x->>'lcr_uuid')::uuid as lcr_uuid,
           coalesce(x->'lcr_classes', '[]'::jsonb) as lcr_classes,
           x->>'name' as name,
           coalesce(x->>'display_name', x->>'name') as display_name,
           x->>'sex' as sex,
           x->>'org' as org,
           (x->>'age')::int as age
    from jsonb_array_elements(p_members) x;

  for r in select * from _incoming loop
    update members m set
      lcr_classes = case when jsonb_array_length(r.lcr_classes) > 0 then r.lcr_classes else m.lcr_classes end,
      name = r.name, display_name = r.display_name,
      sex = coalesce(r.sex, m.sex), org = coalesce(r.org, m.org), age = coalesce(r.age, m.age),
      active = true, updated_at = now()
    where (r.lcr_uuid is not null and m.lcr_uuid = r.lcr_uuid)
       or (r.lcr_uuid is null and m.name = r.name);
    if found then
      v_upd := v_upd + 1;
    else
      insert into members (lcr_uuid, lcr_classes, name, display_name, sex, org, age)
      values (r.lcr_uuid, r.lcr_classes, r.name, r.display_name, r.sex, r.org, r.age);
      v_ins := v_ins + 1;
    end if;
  end loop;

  if p_deactivate_missing then
    update members m set active = false, updated_at = now()
    where m.active
      and not exists (
        select 1 from _incoming i
        where (i.lcr_uuid is not null and i.lcr_uuid = m.lcr_uuid)
           or (i.lcr_uuid is null and i.name = m.name));
    get diagnostics v_deact = row_count;
  end if;

  return query select v_ins, v_upd, v_deact;
end $$;

-- Mark attendance rows as pushed to LCR.
create or replace function public.admin_mark_synced(p_pass text, p_attendance_ids bigint[])
returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v int;
begin
  perform _check_admin(p_pass);
  update attendance set synced_to_lcr_at = now() where id = any(p_attendance_ids);
  get diagnostics v = row_count;
  return v;
end $$;

-- Manually toggle a member active/inactive (moved out, etc.).
create or replace function public.admin_set_member_active(p_pass text, p_member_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  update members set active = p_active, updated_at = now() where id = p_member_id;
end $$;

-- Admin-side check-in/out (fixing the roll after the fact, any date).
create or replace function public.admin_set_attendance(p_pass text, p_date date, p_class text, p_member_id uuid, p_present boolean)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  if p_present then
    insert into attendance (meeting_date, class, member_id) values (p_date, p_class, p_member_id)
    on conflict do nothing;
  else
    delete from attendance where meeting_date = p_date and class = p_class and member_id = p_member_id;
  end if;
end $$;

grant execute on function public.admin_attendance(text, date)                         to anon;
grant execute on function public.admin_meeting_dates(text)                            to anon;
grant execute on function public.admin_members(text)                                  to anon;
grant execute on function public.admin_upsert_members(text, jsonb, boolean)           to anon;
grant execute on function public.admin_mark_synced(text, bigint[])                    to anon;
grant execute on function public.admin_set_member_active(text, uuid, boolean)         to anon;
grant execute on function public.admin_set_attendance(text, date, text, uuid, boolean) to anon;

-- ---------------------------------------------------------------------------
-- Guests / visitors who are not on the LCR roll: they type their name on the roll page.
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_guests (
  id             bigserial primary key,
  meeting_date   date not null,
  class          text not null,
  name           text not null,
  created_at     timestamptz not null default now(),
  synced_to_lcr_at timestamptz
);
create unique index if not exists attendance_guests_unique_idx
  on public.attendance_guests (meeting_date, class, lower(name));
alter table public.attendance_guests enable row level security;
revoke all on public.attendance_guests from anon, authenticated;

-- Public: a guest checks in by typing a name (2–60 chars, letters/spaces/'-. only).
create or replace function public.check_in_guest(p_date date, p_class text, p_name text)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_name text;
begin
  if not _valid_class(p_class) then raise exception 'bad class'; end if;
  if not _window_open(p_class) then raise exception 'Check-in is closed right now' using errcode = 'P0001'; end if;
  if p_date > (now() at time zone 'America/New_York')::date + 1
     or p_date < (now() at time zone 'America/New_York')::date - 8 then
    raise exception 'date out of range';
  end if;
  v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  if length(v_name) < 2 or length(v_name) > 60 or v_name !~ '^[[:alpha:]][[:alpha:] ''.-]*$' then
    raise exception 'Please enter a first and last name';
  end if;
  insert into attendance_guests (meeting_date, class, name) values (p_date, p_class, v_name)
  on conflict do nothing;
  return v_name;
end $$;

-- Public: guest names already checked in for a meeting/class.
create or replace function public.guests_checked_in(p_date date, p_class text)
returns setof text
language sql stable security definer set search_path = public, extensions as $$
  select name from attendance_guests where meeting_date = p_date and class = p_class order by lower(name)
$$;

grant execute on function public.check_in_guest(date, text, text) to anon;
grant execute on function public.guests_checked_in(date, text)   to anon;

-- Admin: guests for a Sunday.
create or replace function public.admin_guests(p_pass text, p_date date)
returns table (guest_id bigint, class text, name text, created_at timestamptz, synced_to_lcr_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select g.id, g.class, g.name, g.created_at, g.synced_to_lcr_at
    from attendance_guests g where g.meeting_date = p_date order by g.class, lower(g.name);
end $$;

create or replace function public.admin_remove_guest(p_pass text, p_guest_id bigint)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  delete from attendance_guests where id = p_guest_id;
end $$;

create or replace function public.admin_mark_guests_synced(p_pass text, p_guest_ids bigint[])
returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v int;
begin
  perform _check_admin(p_pass);
  update attendance_guests set synced_to_lcr_at = now() where id = any(p_guest_ids);
  get diagnostics v = row_count;
  return v;
end $$;

grant execute on function public.admin_guests(text, date)                 to anon;
grant execute on function public.admin_remove_guest(text, bigint)         to anon;
grant execute on function public.admin_mark_guests_synced(text, bigint[]) to anon;

-- ---------------------------------------------------------------------------
-- Check-in time windows (America/New_York). One window per class, keyed
-- 'window_<class key>' in settings, e.g. "12:50-14:30". A class with no window
-- setting is always open. Leaders › Settings edits these per class.
-- ---------------------------------------------------------------------------
insert into public.settings (key, value) values
  ('window_day', '0'),                 -- 0 = Sunday
  ('roll_enforce_window', 'true')      -- set to 'false' to allow check-in any time (testing)
on conflict (key) do nothing;

-- Public: the windows for every configured class, so the site can grey buttons out
-- without a reload. A class with no 'window_<key>' setting comes back unenforced (always open).
create or replace function public.roll_windows()
returns table (class text, start_time text, end_time text, day_of_week int, enforced boolean)
language sql stable security definer set search_path = public, extensions as $$
  select c->>'key',
         split_part(s.value, '-', 1), split_part(s.value, '-', 2),
         coalesce((select value from settings where key = 'window_day'), '0')::int,
         coalesce((select value from settings where key = 'roll_enforce_window'), 'true') = 'true' and s.value is not null
  from jsonb_array_elements(roll_classes()) c
  left join settings s on s.key = 'window_' || (c->>'key')
$$;
grant execute on function public.roll_windows() to anon;

-- Is the window for p_class open right now (ET)? Always true when unconfigured or enforcement is off.
create or replace function public._window_open(p_class text) returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
declare v text; v_day int; v_now timestamp; v_t time;
begin
  if coalesce((select value from settings where key = 'roll_enforce_window'), 'true') <> 'true' then return true; end if;
  select value into v from settings where key = 'window_' || p_class;
  if v is null then return true; end if;
  v_day := coalesce((select value from settings where key = 'window_day'), '0')::int;
  v_now := now() at time zone 'America/New_York';
  v_t := v_now::time;
  return extract(dow from v_now)::int = v_day
     and v_t >= split_part(v, '-', 1)::time
     and v_t <  split_part(v, '-', 2)::time;
end $$;

-- Admin: read / change settings from the Leaders page.
create or replace function public.admin_get_settings(p_pass text)
returns setof public.settings
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select * from settings where key not in ('admin_passphrase_hash','admin_fail_count','admin_fail_at') order by key;
end $$;

create or replace function public.admin_set_setting(p_pass text, p_key text, p_value text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  if p_key = 'admin_passphrase_hash' then raise exception 'not allowed'; end if;
  if p_key like 'window_%' and p_key <> 'window_day' and p_value !~ '^\d{1,2}:\d{2}-\d{1,2}:\d{2}$' then
    raise exception 'window must look like 12:50-14:30';
  end if;
  insert into settings (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value;
end $$;

grant execute on function public.admin_get_settings(text)              to anon;
grant execute on function public.admin_set_setting(text, text, text)    to anon;

-- Public: settings safe to show on the site itself (no passphrase needed), such as the ward's
-- name — set on Leaders › Settings, used everywhere on the site instead of being hardcoded in
-- config.js, so a ward can rename itself without editing any files.
create or replace function public.site_settings()
returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('ward_name', coalesce((select value from settings where key = 'ward_name'), ''))
$$;
grant execute on function public.site_settings() to anon;

-- ---------------------------------------------------------------------------
-- Leaders login: short-lived session tokens + brute-force lockout
-- ---------------------------------------------------------------------------
create table if not exists public.admin_sessions (
  token       text primary key,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  label       text
);
alter table public.admin_sessions enable row level security;
revoke all on public.admin_sessions from anon, authenticated;

-- Login: returns {ok, token} or {ok:false, error}. Failures are counted here (this function never
-- raises, so the count commits) and the lockout applies to every admin function.
create or replace function public.admin_login(p_pass text, p_label text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_fail int; v_at timestamptz; v_token text;
begin
  delete from admin_sessions where expires_at < now();
  select coalesce((select value from settings where key = 'admin_fail_count'), '0')::int,
         (select value from settings where key = 'admin_fail_at')::timestamptz
    into v_fail, v_at;
  if v_at is not null and v_at < now() - interval '15 minutes' then v_fail := 0; end if;
  if v_fail >= 10 then
    return jsonb_build_object('ok', false, 'error', 'Too many failed attempts — try again in 15 minutes');
  end if;
  select value into v_hash from settings where key = 'admin_passphrase_hash';
  if v_hash is null or p_pass is null or crypt(p_pass, v_hash) <> v_hash then
    insert into settings (key, value) values ('admin_fail_count', (v_fail + 1)::text)
      on conflict (key) do update set value = excluded.value;
    insert into settings (key, value) values ('admin_fail_at', now()::text)
      on conflict (key) do update set value = excluded.value;
    perform pg_sleep(1);
    return jsonb_build_object('ok', false, 'error', 'Wrong passphrase', 'attempts_left', 10 - (v_fail + 1));
  end if;
  insert into settings (key, value) values ('admin_fail_count', '0') on conflict (key) do update set value = '0';
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into admin_sessions (token, expires_at, label) values (v_token, now() + interval '12 hours', left(p_label, 80));
  return jsonb_build_object('ok', true, 'token', v_token, 'expires_in_hours', 12);
end $$;

create or replace function public.admin_logout(p_token text) returns void
language sql security definer set search_path = public, extensions as $$
  delete from admin_sessions where token = p_token
$$;

grant execute on function public.admin_login(text, text) to anon;
grant execute on function public.admin_logout(text)      to anon;

-- ---------------------------------------------------------------------------
-- Announcements (editable by leaders) + "Request a meeting with the Bishop"
-- ---------------------------------------------------------------------------
create table if not exists public.announcements (
  id          bigserial primary key,
  subject     text,
  text        text not null default '',
  images      jsonb not null default '[]'::jsonb,   -- [{"path":"img/ann-…","name":"…"}]
  files       jsonb not null default '[]'::jsonb,   -- PDFs, same shape
  sent_at     timestamptz,                          -- when the email went out
  source      text,                                 -- 'email' | 'leaders'
  message_id  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  text
);
alter table public.announcements enable row level security;
revoke all on public.announcements from anon, authenticated;

-- Public: what the home page shows.
create or replace function public.current_announcements()
returns table (id bigint, subject text, text text, images jsonb, files jsonb, sent_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = public, extensions as $$
  select id, subject, text, images, files, sent_at, updated_at
  from announcements order by created_at desc limit 1
$$;
grant execute on function public.current_announcements() to anon;

-- Admin / Apps Script: publish a new week (skips if that email was already published).
create or replace function public.admin_publish_announcements(p_pass text, p_text text, p_images jsonb default '[]', p_files jsonb default '[]', p_subject text default null, p_sent_at timestamptz default null, p_message_id text default null, p_source text default 'email')
returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint;
begin
  perform _check_admin(p_pass);
  if p_message_id is not null then
    select id into v_id from announcements where message_id = p_message_id;
    if v_id is not null then return v_id; end if;
  end if;
  insert into announcements (subject, text, images, files, sent_at, source, message_id)
  values (p_subject, coalesce(p_text, ''), coalesce(p_images, '[]'), coalesce(p_files, '[]'), p_sent_at, p_source, p_message_id)
  returning id into v_id;
  return v_id;
end $$;

-- Admin: edit the current announcements in place.
create or replace function public.admin_update_announcements(p_pass text, p_id bigint, p_text text, p_images jsonb, p_files jsonb, p_by text default null)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  update announcements set text = coalesce(p_text, text), images = coalesce(p_images, images), files = coalesce(p_files, files),
    updated_at = now(), updated_by = left(p_by, 80)
  where id = p_id;
end $$;

create or replace function public.admin_announcements_history(p_pass text)
returns setof public.announcements
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select * from announcements order by created_at desc limit 12;
end $$;

grant execute on function public.admin_publish_announcements(text, text, jsonb, jsonb, text, timestamptz, text, text) to anon;
grant execute on function public.admin_update_announcements(text, bigint, text, jsonb, jsonb, text) to anon;
grant execute on function public.admin_announcements_history(text) to anon;

-- ---------------------------------------------------------------------------
-- Meeting requests for the Bishop (handled by the executive secretaries)
-- ---------------------------------------------------------------------------
create table if not exists public.meeting_requests (
  id                bigserial primary key,
  name              text not null,
  phone             text not null,
  email             text not null,
  temple_recommend  boolean not null default false,
  note              text,
  created_at        timestamptz not null default now(),
  handled_at        timestamptz,
  handled_by        text
);
alter table public.meeting_requests enable row level security;
revoke all on public.meeting_requests from anon, authenticated;

create or replace function public.submit_meeting_request(p_name text, p_phone text, p_email text, p_temple_recommend boolean default false, p_note text default null)
returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint; v_name text; v_phone text; v_email text;
begin
  v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_phone := btrim(coalesce(p_phone, ''));
  v_email := lower(btrim(coalesce(p_email, '')));
  if length(v_name) < 2 or length(v_name) > 80 then raise exception 'Please enter your name'; end if;
  if length(regexp_replace(v_phone, '\D', '', 'g')) < 7 or length(v_phone) > 40 then raise exception 'Please enter a phone number we can reach you at'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 120 then raise exception 'Please enter a valid email address'; end if;
  if length(coalesce(p_note, '')) > 1000 then raise exception 'Please keep the note under 1000 characters'; end if;
  if (select count(*) from meeting_requests where created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many requests right now — please try again in a little while';
  end if;
  insert into meeting_requests (name, phone, email, temple_recommend, note)
  values (v_name, v_phone, v_email, coalesce(p_temple_recommend, false), nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return v_id;
end $$;
grant execute on function public.submit_meeting_request(text, text, text, boolean, text) to anon;

create or replace function public.admin_meeting_requests(p_pass text, p_include_handled boolean default false)
returns setof public.meeting_requests
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select * from meeting_requests m where p_include_handled or m.handled_at is null
    order by m.handled_at is not null, m.created_at desc;
end $$;

create or replace function public.admin_meeting_handled(p_pass text, p_id bigint, p_handled boolean, p_by text default null)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  update meeting_requests set handled_at = case when p_handled then now() end, handled_by = case when p_handled then left(p_by, 80) end where id = p_id;
end $$;

create or replace function public.admin_meeting_delete(p_pass text, p_id bigint)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  delete from meeting_requests where id = p_id;
end $$;

grant execute on function public.admin_meeting_requests(text, boolean)                to anon;
grant execute on function public.admin_meeting_handled(text, bigint, boolean, text)   to anon;
grant execute on function public.admin_meeting_delete(text, bigint)                   to anon;

-- Inbox badge: open meeting requests.
create or replace function public.admin_notes_count(p_pass text)
returns int
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return (select count(*) from meeting_requests where handled_at is null)::int;
end $$;
grant execute on function public.admin_notes_count(text) to anon;

-- ---------------------------------------------------------------------------
-- After running:
--   1. set the admin passphrase:       select set_admin_passphrase('replace-me');
--   2. set your ward's roll classes from the Leaders › Settings page, or directly:
--        select admin_set_roll_classes('replace-me', '[
--          {"key":"primary","label":"Primary","short":"Primary","orgTypeIds":[]},
--          {"key":"young_men","label":"Young Men","short":"YM","orgTypeIds":[]},
--          {"key":"young_women","label":"Young Women","short":"YW","orgTypeIds":[]},
--          {"key":"sunday_school","label":"Sunday School","short":"Sunday School","orgTypeIds":[]},
--          {"key":"priesthood_rs","label":"Priesthood / Relief Society","short":"Priesthood / RS","orgTypeIds":[]}
--        ]'::jsonb);
-- ---------------------------------------------------------------------------
