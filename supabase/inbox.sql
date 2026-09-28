-- Editable announcements + "Request a meeting with the Bishop".
-- Paste into the Supabase SQL editor and run once (safe to re-run). Requires notes.sql first.

-- ---------------------------------------------------------------------------
-- 1. Announcements live in the database so leaders can edit them.
--    The site shows the newest row; announcements.json in the repo is only a fallback.
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
-- 2. Meeting requests for the Bishop (handled by the executive secretaries)
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
