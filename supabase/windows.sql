-- Check-in time windows (America/New_York), one per configured roll class.
-- Paste into the Supabase SQL editor and run once (safe to re-run). Superseded by / merged
-- into schema.sql — this file is kept for incremental installs on an older database.

insert into public.settings (key, value) values
  ('window_day', '0'),                 -- 0 = Sunday
  ('roll_enforce_window', 'true')      -- set to 'false' to allow check-in any time (testing)
on conflict (key) do nothing;

-- Public: the windows for every configured class, so the site can grey the buttons out
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
  select p_date, p_class, m.id from members m where m.id = any(p_member_ids) and m.active
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

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

-- Admin: read / change settings from the Leaders page.
create or replace function public.admin_get_settings(p_pass text)
returns setof public.settings
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select * from settings where key <> 'admin_passphrase_hash' order by key;
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
