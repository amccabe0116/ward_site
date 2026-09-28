-- ---------------------------------------------------------------------------
-- Callings in progress, for anyone on the members list (not just the members-without-callings
-- sheet): proposed calling (who contacts noted) → contacted → accepted (yes / no) → sustained → set apart.
-- Run after schema.sql (safe to re-run).
--
--   calling_pipeline   one row per calling being extended. status: open while it moves along,
--                      done once set apart, dropped when declined or withdrawn.
--
-- The steps happen in that order, so recording a later one fills in the earlier ones (marking
-- someone set apart also marks them sustained and accepted). Leaders › Members shows the open
-- row's current step and who contacts; Leaders › Overview lists who still needs sustaining and
-- who still needs setting apart.
-- ---------------------------------------------------------------------------
create table if not exists public.calling_pipeline (
  id            bigserial primary key,
  member_id     uuid references public.members (id) on delete set null,
  lcr_uuid      uuid,                        -- LCR person uuid, so the row follows a re-imported member
  name          text not null,               -- "First Last", as shown
  calling       text not null,               -- the proposed calling
  contact       text,                        -- who contacts / extends it
  contacted_at  date,                        -- they have been reached
  accepted      text check (accepted in ('yes', 'no')),
  accepted_at   date,
  sustained_at  date,
  set_apart_at  date,
  notes         text,
  status        text not null default 'open' check (status in ('open', 'done', 'dropped')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    text
);
create index if not exists calling_pipeline_member on public.calling_pipeline (member_id, status);
create index if not exists calling_pipeline_status on public.calling_pipeline (status, updated_at desc);
alter table public.calling_pipeline enable row level security;
revoke all on public.calling_pipeline from anon, authenticated;

-- Open rows, plus (p_include_closed) anything finished or dropped in the last 90 days.
create or replace function public.admin_pipeline(p_pass text, p_include_closed boolean default true)
returns setof public.calling_pipeline
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select * from calling_pipeline p
    where p.status = 'open' or (p_include_closed and p.updated_at > now() - interval '90 days')
    order by (p.status = 'open') desc, p.updated_at desc;
end $$;

-- Create (p_id null) or update one row. Later steps fill in the earlier ones; status follows the
-- steps unless p_status says otherwise (dropped = declined or withdrawn; open = reopen).
create or replace function public.admin_pipeline_save(p_pass text, p_id bigint, p_member_id uuid, p_lcr_uuid uuid, p_name text, p_calling text,
  p_contact text default null, p_contacted_at date default null, p_accepted text default null, p_accepted_at date default null,
  p_sustained_at date default null, p_set_apart_at date default null, p_notes text default null, p_status text default null, p_by text default null)
returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint; v_name text; v_calling text; v_accepted text; v_accepted_at date; v_contacted date; v_sustained date; v_set_apart date; v_status text;
begin
  perform _check_admin(p_pass);
  v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_calling := regexp_replace(btrim(coalesce(p_calling, '')), '\s+', ' ', 'g');
  if length(v_name) < 2 or length(v_name) > 120 then raise exception 'Whose calling is this?'; end if;
  if length(v_calling) < 2 or length(v_calling) > 120 then raise exception 'Please name the proposed calling'; end if;
  if p_accepted is not null and p_accepted not in ('yes', 'no') then raise exception 'accepted is yes or no'; end if;
  if p_status is not null and p_status not in ('open', 'done', 'dropped') then raise exception 'bad status'; end if;
  if length(coalesce(p_notes, '')) > 1000 then raise exception 'Please keep the notes under 1000 characters'; end if;
  -- the order: set apart ⇒ sustained ⇒ accepted ⇒ contacted
  v_set_apart := p_set_apart_at;
  v_sustained := coalesce(p_sustained_at, v_set_apart);
  v_accepted  := case when v_sustained is not null then 'yes' else p_accepted end;
  v_accepted_at := case when v_accepted is null then null else coalesce(p_accepted_at, v_sustained, current_date) end;
  v_contacted := coalesce(p_contacted_at, v_accepted_at);
  v_status := coalesce(p_status, case when v_set_apart is not null then 'done' when v_accepted = 'no' then 'dropped' else 'open' end);
  if p_id is null then
    insert into calling_pipeline (member_id, lcr_uuid, name, calling, contact, contacted_at, accepted, accepted_at, sustained_at, set_apart_at, notes, status, updated_by)
    values (p_member_id, p_lcr_uuid, v_name, v_calling, nullif(btrim(coalesce(p_contact, '')), ''), v_contacted, v_accepted, v_accepted_at, v_sustained, v_set_apart, nullif(btrim(coalesce(p_notes, '')), ''), v_status, left(p_by, 80))
    returning id into v_id;
  else
    update calling_pipeline set member_id = coalesce(p_member_id, member_id), lcr_uuid = coalesce(p_lcr_uuid, lcr_uuid), name = v_name, calling = v_calling,
      contact = nullif(btrim(coalesce(p_contact, '')), ''), contacted_at = v_contacted, accepted = v_accepted, accepted_at = v_accepted_at,
      sustained_at = v_sustained, set_apart_at = v_set_apart, notes = nullif(btrim(coalesce(p_notes, '')), ''), status = v_status,
      updated_at = now(), updated_by = left(p_by, 80)
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'not found'; end if;
  end if;
  return v_id;
end $$;

-- One step from the Overview: sustained today / set apart today (the date can be given).
create or replace function public.admin_pipeline_step(p_pass text, p_id bigint, p_step text, p_date date default current_date, p_by text default null)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare d date := coalesce(p_date, current_date);   -- an explicit null still means today
begin
  perform _check_admin(p_pass);
  if p_step = 'sustained' then
    update calling_pipeline set sustained_at = coalesce(sustained_at, d), accepted = 'yes', accepted_at = coalesce(accepted_at, d), contacted_at = coalesce(contacted_at, d),
      status = case when status = 'dropped' then 'open' else status end, updated_at = now(), updated_by = left(p_by, 80) where id = p_id;
  elsif p_step = 'set_apart' then
    update calling_pipeline set set_apart_at = coalesce(set_apart_at, d), sustained_at = coalesce(sustained_at, d), accepted = 'yes', accepted_at = coalesce(accepted_at, d), contacted_at = coalesce(contacted_at, d),
      status = 'done', updated_at = now(), updated_by = left(p_by, 80) where id = p_id;
  else raise exception 'bad step';
  end if;
  if not found then raise exception 'not found'; end if;
end $$;

create or replace function public.admin_pipeline_delete(p_pass text, p_id bigint)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  delete from calling_pipeline where id = p_id;
end $$;

grant execute on function public.admin_pipeline(text, boolean)                                                                          to anon;
grant execute on function public.admin_pipeline_save(text, bigint, uuid, uuid, text, text, text, date, text, date, date, date, text, text, text) to anon;
grant execute on function public.admin_pipeline_step(text, bigint, text, date, text)                                                    to anon;
grant execute on function public.admin_pipeline_delete(text, bigint)                                                                    to anon;
