-- Guests / visitors who are not on the LCR roll: they type their name on the roll page.
-- Paste into the Supabase SQL editor and run once (safe to re-run).

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
  if to_regprocedure('public._valid_class(text)') is not null then
    if not _valid_class(p_class) then raise exception 'bad class'; end if;
  end if;
  if to_regprocedure('public._window_open(text)') is not null then
    if not _window_open(p_class) then raise exception 'Check-in is closed right now' using errcode = 'P0001'; end if;
  end if;
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

-- Sundays list should count guests too. Per-class counts come back as one jsonb object
-- keyed by class, e.g. {"primary":12,"young_men":6,...}.
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
