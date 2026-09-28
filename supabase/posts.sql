-- Announcements as posts: one row per event / notice, ordered by when it happens, with an
-- optional flyer. Anyone can submit a post from the site (post.html); it sits in "pending"
-- until a leader approves it under Leaders › Announcements. Leaders' own posts publish at once.
-- Paste into the Supabase SQL editor and run once (safe to re-run). Requires notes.sql
-- (_check_admin) and inbox.sql (announcements, admin_notes_count).

-- ---------------------------------------------------------------------------
-- 1. Posts
-- ---------------------------------------------------------------------------
create table if not exists public.posts (
  id            bigserial primary key,
  title         text not null,
  details       text not null default '',
  event_date    date,                      -- null = a general notice (shown for 30 days)
  start_time    time,
  end_time      time,
  location      text,
  link          text,                      -- sign-up / more-info URL
  flyer_url     text,                      -- public URL in the "flyers" storage bucket
  submitted_name    text,
  submitted_contact text,                  -- email or phone, so a leader can follow up
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  source        text not null default 'public' check (source in ('public', 'leaders')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  reviewed_at   timestamptz,
  reviewed_by   text
);
create index if not exists posts_status_date on public.posts (status, event_date);
alter table public.posts enable row level security;
revoke all on public.posts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Public: what the home page shows — approved posts whose day hasn't passed
--    (undated notices stay up for 30 days), soonest first, undated last.
-- ---------------------------------------------------------------------------
create or replace function public.posts_public()
returns table (id bigint, title text, details text, event_date date, start_time time, end_time time, location text, link text, flyer_url text, created_at timestamptz)
language sql stable security definer set search_path = public, extensions as $$
  select p.id, p.title, p.details, p.event_date, p.start_time, p.end_time, p.location, p.link, p.flyer_url, p.created_at
  from posts p
  where p.status = 'approved'
    and ((p.event_date is not null and p.event_date >= (now() at time zone 'America/New_York')::date)
      or (p.event_date is null and p.created_at > now() - interval '30 days'))
  order by p.event_date asc nulls last, p.start_time asc nulls last, p.created_at desc
$$;
grant execute on function public.posts_public() to anon;

-- ---------------------------------------------------------------------------
-- 3. Public: submit a post for approval. Light rate limit; the honeypot (p_website) must be
--    empty — bots fill every field.
-- ---------------------------------------------------------------------------
create or replace function public.submit_post(p_title text, p_details text, p_event_date date, p_start_time time, p_end_time time,
  p_location text, p_link text, p_flyer_url text, p_name text, p_contact text, p_website text default '')
returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint; v_title text; v_name text; v_contact text; v_link text; v_flyer text;
begin
  if coalesce(p_website, '') <> '' then return 0; end if;   -- honeypot: pretend it worked
  v_title := regexp_replace(btrim(coalesce(p_title, '')), '\s+', ' ', 'g');
  v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_contact := btrim(coalesce(p_contact, ''));
  v_link := btrim(coalesce(p_link, ''));
  v_flyer := btrim(coalesce(p_flyer_url, ''));
  if length(v_title) < 3 or length(v_title) > 120 then raise exception 'Please give the post a title (3–120 characters)'; end if;
  if length(coalesce(p_details, '')) > 3000 then raise exception 'Please keep the details under 3000 characters'; end if;
  if length(coalesce(p_location, '')) > 200 then raise exception 'Location is too long'; end if;
  if v_link <> '' and (v_link !~* '^https?://' or length(v_link) > 500) then raise exception 'The link must start with http:// or https://'; end if;
  if v_flyer <> '' and (v_flyer !~* '^https://' or length(v_flyer) > 500) then raise exception 'Bad flyer URL'; end if;
  if length(v_name) < 2 or length(v_name) > 80 then raise exception 'Please enter your name'; end if;
  if length(v_contact) < 5 or length(v_contact) > 120 then raise exception 'Please enter an email or phone number a leader can reach you at'; end if;
  if p_event_date is not null and p_event_date < (now() at time zone 'America/New_York')::date - 1 then raise exception 'That date has already passed'; end if;
  if p_start_time is not null and p_end_time is not null and p_end_time < p_start_time then raise exception 'The end time is before the start time'; end if;
  if (select count(*) from posts where source = 'public' and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many submissions right now — please try again in a little while';
  end if;
  insert into posts (title, details, event_date, start_time, end_time, location, link, flyer_url, submitted_name, submitted_contact, status, source)
  values (v_title, coalesce(p_details, ''), p_event_date, p_start_time, p_end_time, nullif(btrim(coalesce(p_location, '')), ''), nullif(v_link, ''), nullif(v_flyer, ''), v_name, v_contact, 'pending', 'public')
  returning id into v_id;
  return v_id;
end $$;
grant execute on function public.submit_post(text, text, date, time, time, text, text, text, text, text, text) to anon;

-- ---------------------------------------------------------------------------
-- 4. Leaders
-- ---------------------------------------------------------------------------
-- Everything recent: pending first, then upcoming approved, then the rest (rejected / past, last 60 days).
create or replace function public.admin_posts(p_pass text)
returns setof public.posts
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select * from posts p
    where p.status = 'pending' or p.event_date >= (now() at time zone 'America/New_York')::date - 7 or p.created_at > now() - interval '60 days'
    order by (p.status = 'pending') desc, p.event_date asc nulls last, p.start_time asc nulls last, p.created_at desc;
end $$;

-- Add (p_id null) or edit a post. Leaders' new posts go straight to approved.
create or replace function public.admin_post_save(p_pass text, p_id bigint, p_title text, p_details text, p_event_date date, p_start_time time, p_end_time time,
  p_location text, p_link text, p_flyer_url text, p_by text default null)
returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint; v_title text;
begin
  perform _check_admin(p_pass);
  v_title := regexp_replace(btrim(coalesce(p_title, '')), '\s+', ' ', 'g');
  if length(v_title) < 3 or length(v_title) > 120 then raise exception 'Please give the post a title (3–120 characters)'; end if;
  if length(coalesce(p_details, '')) > 3000 then raise exception 'Please keep the details under 3000 characters'; end if;
  if p_link is not null and btrim(p_link) <> '' and btrim(p_link) !~* '^https?://' then raise exception 'The link must start with http:// or https://'; end if;
  if p_id is null then
    insert into posts (title, details, event_date, start_time, end_time, location, link, flyer_url, submitted_name, status, source, reviewed_at, reviewed_by)
    values (v_title, coalesce(p_details, ''), p_event_date, p_start_time, p_end_time, nullif(btrim(coalesce(p_location, '')), ''), nullif(btrim(coalesce(p_link, '')), ''), nullif(btrim(coalesce(p_flyer_url, '')), ''), 'Leaders', 'approved', 'leaders', now(), left(p_by, 80))
    returning id into v_id;
  else
    update posts set title = v_title, details = coalesce(p_details, ''), event_date = p_event_date, start_time = p_start_time, end_time = p_end_time,
      location = nullif(btrim(coalesce(p_location, '')), ''), link = nullif(btrim(coalesce(p_link, '')), ''), flyer_url = nullif(btrim(coalesce(p_flyer_url, '')), ''), updated_at = now()
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'post not found'; end if;
  end if;
  return v_id;
end $$;

-- Approve / reject / put back to pending.
create or replace function public.admin_post_status(p_pass text, p_id bigint, p_status text, p_by text default null)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  if p_status not in ('pending', 'approved', 'rejected') then raise exception 'bad status'; end if;
  update posts set status = p_status, reviewed_at = case when p_status = 'pending' then null else now() end, reviewed_by = case when p_status = 'pending' then null else left(p_by, 80) end, updated_at = now()
  where id = p_id;
end $$;

create or replace function public.admin_post_delete(p_pass text, p_id bigint)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  delete from posts where id = p_id;
end $$;

-- Badge on the Announcements tab.
create or replace function public.admin_posts_pending_count(p_pass text)
returns int
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return (select count(*) from posts where status = 'pending')::int;
end $$;

grant execute on function public.admin_posts(text) to anon;
grant execute on function public.admin_post_save(text, bigint, text, text, date, time, time, text, text, text, text) to anon;
grant execute on function public.admin_post_status(text, bigint, text, text) to anon;
grant execute on function public.admin_post_delete(text, bigint) to anon;
grant execute on function public.admin_posts_pending_count(text) to anon;

-- ---------------------------------------------------------------------------
-- 5. Flyers: a public storage bucket. Anyone can upload an image (JPEG/PNG/WebP, 3 MB) into
--    uploads/…; nobody can overwrite or delete through the public key. The site resizes
--    images in the browser before uploading, so most flyers land well under 500 KB.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('flyers', 'flyers', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "flyers public read" on storage.objects;
create policy "flyers public read" on storage.objects for select to anon, authenticated using (bucket_id = 'flyers');
drop policy if exists "flyers anon upload" on storage.objects;
create policy "flyers anon upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'flyers' and (storage.foldername(name))[1] = 'uploads');
