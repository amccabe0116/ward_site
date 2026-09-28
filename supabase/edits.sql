-- Leaders › Callings: edits made on the site to the "Members without Callings" Google Sheet.
-- Only the columns leaders update in meetings are editable (proposed calling, who texts, texted,
-- answer, sustained, other notes). Edits are saved here immediately, shown on the site at once,
-- and written into the Google Sheet by scripts/announcements.gs (syncMemberSheets) on its next
-- run — after which the sheet copy carries them and the row here is marked synced.
-- Paste into the Supabase SQL editor and run once (safe to re-run). Requires sheets.sql.

create table if not exists public.callings_edits (
  name        text primary key,            -- NAME exactly as on the sheet (or "First Last" for a new row)
  lcr_uuid    text,
  edits       jsonb not null default '{}', -- {"Proposed calling": "...", "texted": "Y", ...}
  updated_at  timestamptz not null default now(),
  updated_by  text,
  synced_at   timestamptz                  -- when the Apps Script wrote it into the sheet
);
alter table public.callings_edits enable row level security;
revoke all on public.callings_edits from anon, authenticated;

-- Admin: save (merge) an edit for one person. Unknown columns are rejected.
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
    if jsonb_typeof(p_values -> v_key) <> 'string' then raise exception 'values must be strings'; end if;
    if length(p_values ->> v_key) > 500 then raise exception 'value too long'; end if;
    v_clean := v_clean || jsonb_build_object(v_key, btrim(p_values ->> v_key));
  end loop;
  insert into callings_edits (name, lcr_uuid, edits, updated_at, updated_by, synced_at)
  values (btrim(p_name), nullif(p_lcr_uuid, ''), v_clean, now(), p_by, null)
  on conflict (name) do update
    set edits = callings_edits.edits || excluded.edits,
        lcr_uuid = coalesce(excluded.lcr_uuid, callings_edits.lcr_uuid),
        updated_at = now(), updated_by = excluded.updated_by, synced_at = null
  returning edits into v_out;
  return v_out;
end $$;

-- Admin: every edit (the site overlays the pending ones on the sheet copy).
create or replace function public.admin_callings_edits(p_pass text)
returns table (name text, lcr_uuid text, edits jsonb, updated_at timestamptz, updated_by text, synced_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select e.name, e.lcr_uuid, e.edits, e.updated_at, e.updated_by, e.synced_at from callings_edits e order by e.updated_at desc;
end $$;

-- Admin (Apps Script): edits not yet written into the Google Sheet.
create or replace function public.admin_callings_pending(p_pass text)
returns table (name text, lcr_uuid text, edits jsonb, updated_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select e.name, e.lcr_uuid, e.edits, e.updated_at from callings_edits e where e.synced_at is null order by e.updated_at;
end $$;

-- Admin (Apps Script): mark edits as written into the sheet (only if not edited again since).
create or replace function public.admin_callings_mark_synced(p_pass text, p_names text[], p_as_of timestamptz default now())
returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v int;
begin
  perform _check_admin(p_pass);
  update callings_edits set synced_at = now() where name = any(p_names) and updated_at <= p_as_of;
  get diagnostics v = row_count;
  return v;
end $$;

grant execute on function public.admin_callings_edit(text, text, text, jsonb, text) to anon;
grant execute on function public.admin_callings_edits(text) to anon;
grant execute on function public.admin_callings_pending(text) to anon;
grant execute on function public.admin_callings_mark_synced(text, text[], timestamptz) to anon;
