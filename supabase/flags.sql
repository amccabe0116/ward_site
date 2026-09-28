-- Leaders › Callings, round 2: lets a sheet row be marked deleted (and undone) from the site,
-- instead of only from the Google Sheet directly.
-- Paste into the Supabase SQL editor and run once (safe to re-run). Requires edits.sql.

alter table public.callings_edits add column if not exists deleted boolean not null default false;

-- A value of null means "clear this cell on purpose"; a blank string is never written over
-- something already in the sheet (see writePendingEdits_).
create or replace function public.admin_callings_edit(p_pass text, p_name text, p_lcr_uuid text, p_values jsonb, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_allowed text[] := array['Proposed calling','text assignment / calling','texted','answer','sustained','Other Notes'];
        v_key text; v_clean jsonb := '{}'; v_out jsonb;
begin
  perform _check_admin(p_pass);
  if p_name is null or length(btrim(p_name)) < 2 or length(p_name) > 80 then raise exception 'bad name'; end if;
  if jsonb_typeof(p_values) <> 'object' then raise exception 'values must be an object'; end if;
  for v_key in select jsonb_object_keys(p_values) loop
    if not (v_key = any(v_allowed)) then raise exception 'column % is not editable', v_key; end if;
    if jsonb_typeof(p_values -> v_key) not in ('string', 'null') then raise exception 'values must be strings (or null to clear)'; end if;
    if length(p_values ->> v_key) > 500 then raise exception 'value too long'; end if;
    v_clean := v_clean || jsonb_build_object(v_key, btrim(p_values ->> v_key));
  end loop;
  insert into callings_edits (name, lcr_uuid, edits, updated_at, updated_by, synced_at, deleted)
  values (btrim(p_name), nullif(p_lcr_uuid, ''), v_clean, now(), p_by, null, false)
  on conflict (name) do update
    set edits = callings_edits.edits || excluded.edits,
        lcr_uuid = coalesce(excluded.lcr_uuid, callings_edits.lcr_uuid),
        deleted = false,
        updated_at = now(), updated_by = excluded.updated_by, synced_at = null
  returning edits into v_out;
  return v_out;
end $$;

-- Admin: mark a sheet row for deletion (or undo it). The Apps Script removes the row on its next run.
create or replace function public.admin_callings_delete(p_pass text, p_name text, p_delete boolean default true, p_by text default null)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  if p_name is null or length(btrim(p_name)) < 2 then raise exception 'bad name'; end if;
  insert into callings_edits (name, edits, updated_at, updated_by, synced_at, deleted)
  values (btrim(p_name), '{}', now(), p_by, null, p_delete)
  on conflict (name) do update
    set deleted = excluded.deleted, updated_at = now(), updated_by = excluded.updated_by, synced_at = null;
end $$;

drop function if exists public.admin_callings_edits(text);
create function public.admin_callings_edits(p_pass text)
returns table (name text, lcr_uuid text, edits jsonb, updated_at timestamptz, updated_by text, synced_at timestamptz, deleted boolean)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select e.name, e.lcr_uuid, e.edits, e.updated_at, e.updated_by, e.synced_at, e.deleted from callings_edits e order by e.updated_at desc;
end $$;

drop function if exists public.admin_callings_pending(text);
create function public.admin_callings_pending(p_pass text)
returns table (name text, lcr_uuid text, edits jsonb, updated_at timestamptz, deleted boolean)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select e.name, e.lcr_uuid, e.edits, e.updated_at, e.deleted from callings_edits e where e.synced_at is null order by e.updated_at;
end $$;

grant execute on function public.admin_callings_edit(text, text, text, jsonb, text) to anon;
grant execute on function public.admin_callings_delete(text, text, boolean, text) to anon;
grant execute on function public.admin_callings_edits(text) to anon;
grant execute on function public.admin_callings_pending(text) to anon;
