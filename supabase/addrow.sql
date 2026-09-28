-- Leaders › Callings: "Add to sheet" for people on LCR's no-calling report who have no row on the
-- Members without Callings sheet yet. The site pre-fills the intake columns from LCR and the
-- new member form, so those columns become writable too (only through this function, only by a
-- signed-in leader). Paste into the Supabase SQL editor and run once (safe to re-run).
-- Requires flags.sql.

create or replace function public.admin_callings_edit(p_pass text, p_name text, p_lcr_uuid text, p_values jsonb, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_allowed text[] := array[
          -- the meeting columns (Edit on a slide)
          'Proposed calling','text assignment / calling','texted','answer','sustained','Other Notes','Flag','Flag sent',
          -- the intake columns (pre-filled by "Add to sheet")
          'LOCATION','AGE','RECENT CONVERT (under yr)','CAR','LENGTH OF STAY','MISSION','PURPOSE IN ATL','HOBBIES','MUSIC'];
        v_key text; v_clean jsonb := '{}'; v_out jsonb;
begin
  perform _check_admin(p_pass);
  if p_name is null or length(btrim(p_name)) < 2 or length(p_name) > 80 then raise exception 'bad name'; end if;
  if jsonb_typeof(p_values) <> 'object' then raise exception 'values must be an object'; end if;
  for v_key in select jsonb_object_keys(p_values) loop
    if not (v_key = any(v_allowed)) then raise exception 'column % is not editable', v_key; end if;
    if jsonb_typeof(p_values -> v_key) not in ('string', 'null') then raise exception 'values must be strings (or null to clear)'; end if;
    if length(p_values ->> v_key) > 500 then raise exception 'value too long'; end if;
    if v_key = 'Flag' and not (coalesce(btrim(p_values ->> v_key), '') in ('', 'Warning', 'Magnet')) then raise exception 'Flag must be Warning, Magnet or empty'; end if;
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

grant execute on function public.admin_callings_edit(text, text, text, jsonb, text) to anon;
