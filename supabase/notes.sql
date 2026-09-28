-- Hardened Leaders login (short-lived sessions + brute-force lockout).
-- Paste into the Supabase SQL editor and run once (safe to re-run).

-- ---------------------------------------------------------------------------
-- Leaders login: short-lived session tokens + brute-force lockout
-- ---------------------------------------------------------------------------
create table if not exists public.admin_sessions (
  token       text primary key,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  label       text
);
alter table public.admin_sessions enable row level security;
revoke all on public.admin_sessions from anon, authenticated;

-- Accepts either an active session token or the passphrase itself (the sync scripts use the
-- passphrase). Wrong passphrase costs 1 s and is refused entirely while locked out.
create or replace function public._check_admin(p_pass text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_fail int; v_at timestamptz;
begin
  if p_pass is null or length(p_pass) < 4 then raise exception 'not authorized' using errcode = '42501'; end if;
  if exists (select 1 from admin_sessions where token = p_pass and expires_at > now()) then return; end if;
  select coalesce((select value from settings where key = 'admin_fail_count'), '0')::int,
         (select value from settings where key = 'admin_fail_at')::timestamptz
    into v_fail, v_at;
  if v_fail >= 10 and v_at is not null and v_at > now() - interval '15 minutes' then
    raise exception 'Too many failed attempts — try again in 15 minutes' using errcode = '42501';
  end if;
  select value into v_hash from settings where key = 'admin_passphrase_hash';
  if v_hash is null or crypt(p_pass, v_hash) <> v_hash then
    perform pg_sleep(1);
    raise exception 'not authorized' using errcode = '42501';
  end if;
end $$;

-- Login: returns {ok, token} or {ok:false, error}. Failures are counted here (this function never
-- raises, so the count commits) and the lockout applies to every admin function.
create or replace function public.admin_login(p_pass text, p_label text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_fail int; v_at timestamptz; v_token text;
begin
  delete from admin_sessions where expires_at < now();
  select coalesce((select value from settings where key = 'admin_fail_count'), '0')::int,
         (select value from settings where key = 'admin_fail_at')::timestamptz
    into v_fail, v_at;
  if v_at is not null and v_at < now() - interval '15 minutes' then v_fail := 0; end if;
  if v_fail >= 10 then
    return jsonb_build_object('ok', false, 'error', 'Too many failed attempts — try again in 15 minutes');
  end if;
  select value into v_hash from settings where key = 'admin_passphrase_hash';
  if v_hash is null or p_pass is null or crypt(p_pass, v_hash) <> v_hash then
    insert into settings (key, value) values ('admin_fail_count', (v_fail + 1)::text)
      on conflict (key) do update set value = excluded.value;
    insert into settings (key, value) values ('admin_fail_at', now()::text)
      on conflict (key) do update set value = excluded.value;
    perform pg_sleep(1);
    return jsonb_build_object('ok', false, 'error', 'Wrong passphrase', 'attempts_left', 10 - (v_fail + 1));
  end if;
  insert into settings (key, value) values ('admin_fail_count', '0') on conflict (key) do update set value = '0';
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into admin_sessions (token, expires_at, label) values (v_token, now() + interval '12 hours', left(p_label, 80));
  return jsonb_build_object('ok', true, 'token', v_token, 'expires_in_hours', 12);
end $$;

create or replace function public.admin_logout(p_token text) returns void
language sql security definer set search_path = public, extensions as $$
  delete from admin_sessions where token = p_token
$$;

-- Passphrase hashing: stronger cost from now on (re-run set_admin_passphrase to upgrade).
create or replace function public.set_admin_passphrase(p_pass text) returns void
language sql security definer set search_path = public, extensions as $$
  insert into settings (key, value)
  values ('admin_passphrase_hash', crypt(p_pass, gen_salt('bf', 10)))
  on conflict (key) do update set value = excluded.value
$$;
revoke execute on function public.set_admin_passphrase(text) from anon, authenticated, public;

grant execute on function public.admin_login(text, text) to anon;
grant execute on function public.admin_logout(text)      to anon;

-- Settings the Leaders page may read: hide the internal ones too.
create or replace function public.admin_get_settings(p_pass text)
returns setof public.settings
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  return query select * from settings where key not in ('admin_passphrase_hash','admin_fail_count','admin_fail_at') order by key;
end $$;
