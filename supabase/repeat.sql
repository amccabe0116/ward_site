-- ---------------------------------------------------------------------------
-- Repeating posts (Institute every Tuesday, a monthly break-the-fast…) — run after posts.sql.
--
--   repeat       'weekly' | 'biweekly' | 'monthly' (same weekday of the month, e.g. 1st Tuesday) | null
--   repeat_until last day it repeats (optional)
--   repeat_show  how many upcoming occurrences the home page / email show at a time (1–4, default 2)
--   skip_dates   occurrences that are cancelled — the site shows them as cancelled, the .ics gets
--                an EXDATE, subscribers see them vanish
--   reminded_at  when "Text a reminder" last went to the ward text list (also in this file)
--
-- The post's event_date is the first occurrence. The site works out the upcoming dates itself
-- (posts.js occurrences()); the calendar files carry an RRULE (scripts/announcements.gs).
-- ---------------------------------------------------------------------------
alter table public.posts add column if not exists repeat text check (repeat in ('weekly', 'biweekly', 'monthly'));
alter table public.posts add column if not exists repeat_until date;
alter table public.posts add column if not exists repeat_show int not null default 2 check (repeat_show between 1 and 4);
alter table public.posts add column if not exists skip_dates date[] not null default '{}';
alter table public.posts add column if not exists reminded_at timestamptz;     -- last "Text a reminder" from the Leaders page

-- A series is live while it still has occurrences left. (Dropped first: the return type grows.)
drop function if exists public.posts_public();
create or replace function public.posts_public()
returns table (id bigint, title text, details text, event_date date, start_time time, end_time time, location text, link text, flyer_url text, created_at timestamptz,
  repeat text, repeat_until date, repeat_show int, skip_dates date[])
language sql stable security definer set search_path = public, extensions as $$
  select p.id, p.title, p.details, p.event_date, p.start_time, p.end_time, p.location, p.link, p.flyer_url, p.created_at,
    p.repeat, p.repeat_until, p.repeat_show, p.skip_dates
  from posts p
  where p.status = 'approved'
    and ((p.event_date is not null and (p.event_date >= (now() at time zone 'America/New_York')::date
                                        or (p.repeat is not null and (p.repeat_until is null or p.repeat_until >= (now() at time zone 'America/New_York')::date))))
      or (p.event_date is null and p.created_at > now() - interval '30 days'))
  order by p.event_date asc nulls last, p.start_time asc nulls last, p.created_at desc
$$;
grant execute on function public.posts_public() to anon;

-- Public submission: same as before plus the repeat fields (the old signature goes, or PostgREST
-- can't pick between the two).
drop function if exists public.submit_post(text, text, date, time, time, text, text, text, text, text, text);
create or replace function public.submit_post(p_title text, p_details text, p_event_date date, p_start_time time, p_end_time time,
  p_location text, p_link text, p_flyer_url text, p_name text, p_contact text, p_website text default '',
  p_repeat text default null, p_repeat_until date default null, p_repeat_show int default 2)
returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint; v_title text; v_name text; v_contact text; v_link text; v_flyer text; v_repeat text;
begin
  if coalesce(p_website, '') <> '' then return 0; end if;   -- honeypot: pretend it worked
  v_title := regexp_replace(btrim(coalesce(p_title, '')), '\s+', ' ', 'g');
  v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_contact := btrim(coalesce(p_contact, ''));
  v_link := btrim(coalesce(p_link, ''));
  v_flyer := btrim(coalesce(p_flyer_url, ''));
  v_repeat := nullif(btrim(coalesce(p_repeat, '')), '');
  if length(v_title) < 3 or length(v_title) > 120 then raise exception 'Please give the post a title (3–120 characters)'; end if;
  if length(coalesce(p_details, '')) > 3000 then raise exception 'Please keep the details under 3000 characters'; end if;
  if length(coalesce(p_location, '')) > 200 then raise exception 'Location is too long'; end if;
  if v_link <> '' and (v_link !~* '^https?://' or length(v_link) > 500) then raise exception 'The link must start with http:// or https://'; end if;
  if v_flyer <> '' and (v_flyer !~* '^https://' or length(v_flyer) > 500) then raise exception 'Bad flyer URL'; end if;
  if length(v_name) < 2 or length(v_name) > 80 then raise exception 'Please enter your name'; end if;
  if length(v_contact) < 5 or length(v_contact) > 120 then raise exception 'Please enter an email or phone number a leader can reach you at'; end if;
  if p_event_date is not null and p_event_date < (now() at time zone 'America/New_York')::date - 1 and v_repeat is null then raise exception 'That date has already passed'; end if;
  if p_start_time is not null and p_end_time is not null and p_end_time < p_start_time then raise exception 'The end time is before the start time'; end if;
  if v_repeat is not null and v_repeat not in ('weekly', 'biweekly', 'monthly') then raise exception 'bad repeat'; end if;
  if v_repeat is not null and p_event_date is null then raise exception 'A repeating post needs a first date'; end if;
  if p_repeat_until is not null and p_event_date is not null and p_repeat_until < p_event_date then raise exception 'The last date is before the first one'; end if;
  if (select count(*) from posts where source = 'public' and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many submissions right now — please try again in a little while';
  end if;
  insert into posts (title, details, event_date, start_time, end_time, location, link, flyer_url, submitted_name, submitted_contact, status, source, repeat, repeat_until, repeat_show)
  values (v_title, coalesce(p_details, ''), p_event_date, p_start_time, p_end_time, nullif(btrim(coalesce(p_location, '')), ''), nullif(v_link, ''), nullif(v_flyer, ''), v_name, v_contact, 'pending', 'public',
    v_repeat, case when v_repeat is null then null else p_repeat_until end, least(4, greatest(1, coalesce(p_repeat_show, 2))))
  returning id into v_id;
  return v_id;
end $$;
grant execute on function public.submit_post(text, text, date, time, time, text, text, text, text, text, text, text, date, int) to anon;

-- Leaders: add / edit, now with the repeat fields.
drop function if exists public.admin_post_save(text, bigint, text, text, date, time, time, text, text, text, text);
create or replace function public.admin_post_save(p_pass text, p_id bigint, p_title text, p_details text, p_event_date date, p_start_time time, p_end_time time,
  p_location text, p_link text, p_flyer_url text, p_by text default null,
  p_repeat text default null, p_repeat_until date default null, p_repeat_show int default 2)
returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint; v_title text; v_repeat text;
begin
  perform _check_admin(p_pass);
  v_title := regexp_replace(btrim(coalesce(p_title, '')), '\s+', ' ', 'g');
  v_repeat := nullif(btrim(coalesce(p_repeat, '')), '');
  if length(v_title) < 3 or length(v_title) > 120 then raise exception 'Please give the post a title (3–120 characters)'; end if;
  if length(coalesce(p_details, '')) > 3000 then raise exception 'Please keep the details under 3000 characters'; end if;
  if p_link is not null and btrim(p_link) <> '' and btrim(p_link) !~* '^https?://' then raise exception 'The link must start with http:// or https://'; end if;
  if v_repeat is not null and v_repeat not in ('weekly', 'biweekly', 'monthly') then raise exception 'bad repeat'; end if;
  if v_repeat is not null and p_event_date is null then raise exception 'A repeating post needs a first date'; end if;
  if p_repeat_until is not null and p_event_date is not null and p_repeat_until < p_event_date then raise exception 'The last date is before the first one'; end if;
  if p_id is null then
    insert into posts (title, details, event_date, start_time, end_time, location, link, flyer_url, submitted_name, status, source, reviewed_at, reviewed_by, repeat, repeat_until, repeat_show)
    values (v_title, coalesce(p_details, ''), p_event_date, p_start_time, p_end_time, nullif(btrim(coalesce(p_location, '')), ''), nullif(btrim(coalesce(p_link, '')), ''), nullif(btrim(coalesce(p_flyer_url, '')), ''), 'Leaders', 'approved', 'leaders', now(), left(p_by, 80),
      v_repeat, case when v_repeat is null then null else p_repeat_until end, least(4, greatest(1, coalesce(p_repeat_show, 2))))
    returning id into v_id;
  else
    update posts set title = v_title, details = coalesce(p_details, ''), event_date = p_event_date, start_time = p_start_time, end_time = p_end_time,
      location = nullif(btrim(coalesce(p_location, '')), ''), link = nullif(btrim(coalesce(p_link, '')), ''), flyer_url = nullif(btrim(coalesce(p_flyer_url, '')), ''),
      repeat = v_repeat, repeat_until = case when v_repeat is null then null else p_repeat_until end, repeat_show = least(4, greatest(1, coalesce(p_repeat_show, 2))),
      skip_dates = case when v_repeat is null then '{}' else skip_dates end, updated_at = now()
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'post not found'; end if;
  end if;
  return v_id;
end $$;
grant execute on function public.admin_post_save(text, bigint, text, text, date, time, time, text, text, text, text, text, date, int) to anon;

-- Leaders' list: a series stays listed while it is still running, however long ago it was created.
create or replace function public.admin_posts(p_pass text)
returns setof public.posts
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select * from posts p
    where p.status = 'pending' or p.event_date >= (now() at time zone 'America/New_York')::date - 7 or p.created_at > now() - interval '60 days'
      or (p.repeat is not null and (p.repeat_until is null or p.repeat_until >= (now() at time zone 'America/New_York')::date - 7))
    order by (p.status = 'pending') desc, p.event_date asc nulls last, p.start_time asc nulls last, p.created_at desc;
end $$;

-- Cancel (or restore) one occurrence of a repeating post.
create or replace function public.admin_post_skip(p_pass text, p_id bigint, p_date date, p_skip boolean)
returns date[]
language plpgsql security definer set search_path = public, extensions as $$
declare v_dates date[];
begin
  perform _check_admin(p_pass);
  update posts set
    skip_dates = case when p_skip then (select array_agg(distinct d order by d) from unnest(array_append(skip_dates, p_date)) d)
                      else coalesce(array_remove(skip_dates, p_date), '{}') end,
    updated_at = now()
  where id = p_id returning skip_dates into v_dates;
  if v_dates is null then raise exception 'post not found'; end if;
  return v_dates;
end $$;
grant execute on function public.admin_post_skip(text, bigint, date, boolean) to anon;

-- The Leaders page's "Text a reminder" (a SimpleTexting campaign to the ward list, sent by the
-- Apps Script) records when it went out, so the card can say so and nobody sends it twice by accident.
create or replace function public.admin_post_reminded(p_pass text, p_id bigint)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  update posts set reminded_at = now() where id = p_id;
end $$;
grant execute on function public.admin_post_reminded(text, bigint) to anon;
