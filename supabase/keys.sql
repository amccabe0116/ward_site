-- "The Keys" mini game (keys.html): a ward-wide high score board.
-- Paste into the Supabase SQL editor and run once (safe to re-run).

create table if not exists public.keys_scores (
  id         bigserial primary key,
  name       text not null check (length(name) between 1 and 20),
  score      int  not null check (score between 0 and 1000000),
  level      int  not null default 1 check (level between 1 and 999),
  created_at timestamptz not null default now()
);
alter table public.keys_scores enable row level security;
revoke all on public.keys_scores from anon, authenticated;

-- Public: add a score. Name is letters / numbers / spaces, up to 20 characters; a light
-- rate limit so nobody can flood the board.
create or replace function public.keys_submit(p_name text, p_score int, p_level int default 1)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_name text;
begin
  v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  if length(v_name) < 1 or length(v_name) > 20 or v_name !~ '^[[:alnum:]][[:alnum:] ''.-]*$' then
    raise exception 'Name: letters, numbers and spaces, up to 20 characters';
  end if;
  if p_score is null or p_score < 0 or p_score > 1000000 then raise exception 'bad score'; end if;
  if (select count(*) from keys_scores where created_at > now() - interval '1 minute') >= 30 then
    raise exception 'The board is busy — try again in a minute';
  end if;
  insert into keys_scores (name, score, level) values (v_name, p_score, greatest(1, least(999, coalesce(p_level, 1))));
end $$;

-- Public: the top of the board.
create or replace function public.keys_top(p_limit int default 10)
returns table (id bigint, name text, score int, level int, played_at timestamptz)
language sql stable security definer set search_path = public, extensions as $$
  select s.id, s.name, s.score, s.level, s.created_at
  from keys_scores s
  order by s.score desc, s.created_at asc
  limit least(greatest(coalesce(p_limit, 10), 1), 50)
$$;

-- Leaders: take a score off the board (a name that shouldn't be there).
create or replace function public.admin_keys_delete(p_pass text, p_id bigint)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  delete from keys_scores where id = p_id;
end $$;

-- A score to beat: the Bishop's.
insert into public.keys_scores (name, score, level)
select 'Bishop M.', 2000, 8
where not exists (select 1 from public.keys_scores where name = 'Bishop M.' and score = 2000);

grant execute on function public.keys_submit(text, int, int) to anon;
grant execute on function public.keys_top(int)              to anon;
grant execute on function public.admin_keys_delete(text, bigint) to anon;
