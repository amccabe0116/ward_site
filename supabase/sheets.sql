-- Leadership Google Sheets ("members without callings", "new member form") mirrored into the
-- database so the Leaders page can show them per person and run the callings meeting.
-- Paste into the Supabase SQL editor and run once (safe to re-run).
-- The data is written by scripts/announcements.gs (syncMemberSheets) or by Claude on request;
-- it is only ever readable through the admin functions below.

create table if not exists public.sheets (
  key         text primary key,            -- 'callings' | 'callings_committees' | 'newmember'
  title       text,
  source_url  text,
  headers     jsonb not null default '[]',  -- ["NAME","LOCATION",…]
  rows        jsonb not null default '[]',  -- [["Aaron Besson","Acworth",…], …]  (strings, blanks as "")
  row_count   int  not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
alter table public.sheets enable row level security;
revoke all on public.sheets from anon, authenticated;

-- Admin: replace a sheet wholesale (the sync always sends the full sheet).
create or replace function public.admin_replace_sheet(p_pass text, p_key text, p_title text, p_source_url text, p_headers jsonb, p_rows jsonb, p_by text default null)
returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v int;
begin
  perform _check_admin(p_pass);
  if p_key !~ '^[a-z_]{2,40}$' then raise exception 'bad key'; end if;
  if jsonb_typeof(p_headers) <> 'array' or jsonb_typeof(p_rows) <> 'array' then raise exception 'headers and rows must be arrays'; end if;
  v := jsonb_array_length(p_rows);
  insert into sheets (key, title, source_url, headers, rows, row_count, updated_at, updated_by)
  values (p_key, p_title, p_source_url, p_headers, p_rows, v, now(), p_by)
  on conflict (key) do update
    set title = excluded.title, source_url = excluded.source_url, headers = excluded.headers,
        rows = excluded.rows, row_count = excluded.row_count, updated_at = now(), updated_by = excluded.updated_by;
  return v;
end $$;

-- Admin: every mirrored sheet.
create or replace function public.admin_sheets(p_pass text)
returns table (key text, title text, source_url text, headers jsonb, rows jsonb, row_count int, updated_at timestamptz, updated_by text)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select s.key, s.title, s.source_url, s.headers, s.rows, s.row_count, s.updated_at, s.updated_by
    from sheets s order by s.key;
end $$;

-- Admin: recent check-ins for everyone (last N Sundays), so the meeting view can show attendance.
create or replace function public.admin_attendance_recent(p_pass text, p_weeks int default 8)
returns table (member_id uuid, meeting_date date, class text)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select a.member_id, a.meeting_date, a.class from attendance a
    where a.meeting_date >= (now() at time zone 'America/New_York')::date - (7 * greatest(1, least(p_weeks, 52)))
    order by a.meeting_date desc;
end $$;

grant execute on function public.admin_replace_sheet(text, text, text, text, jsonb, jsonb, text) to anon;
grant execute on function public.admin_sheets(text) to anon;
grant execute on function public.admin_attendance_recent(text, int) to anon;
