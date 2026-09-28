-- ---------------------------------------------------------------------------
-- Bishop meeting requests → a text to the executive secretary / Bishop the moment one comes in.
-- Run after inbox.sql (safe to re-run).
--
-- bishop.html submits the request (submit_meeting_request) and then pokes the Apps Script web app
-- (action "bishop", just the request id — no secret, the page is public). The script, which holds
-- the Leaders passphrase, CLAIMS the request here: the claim only succeeds once, for a real request
-- from the last day, so a stray or repeated poke can never send a second text. The number it texts
-- is the site setting `bishop_notify_phone` (Leaders › Settings). syncMemberSheets sweeps for any
-- request that was never texted (the page's poke got lost) every 6 hours.
-- ---------------------------------------------------------------------------
alter table public.meeting_requests add column if not exists notified_at timestamptz;

-- p_claim = true: mark the request as being texted and return it — only if nobody has claimed it
-- yet and it is recent. Returns nothing the second time. p_claim = false: release it (the text
-- failed to send), so the next sweep tries again.
create or replace function public.admin_meeting_request_claim(p_pass text, p_id bigint, p_claim boolean default true)
returns setof public.meeting_requests
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _check_admin(p_pass);
  if p_claim then
    return query update meeting_requests set notified_at = now()
      where id = p_id and notified_at is null and created_at > now() - interval '2 days'
      returning *;
  else
    return query update meeting_requests set notified_at = null where id = p_id returning *;
  end if;
end $$;
grant execute on function public.admin_meeting_request_claim(text, bigint, boolean) to anon;

insert into public.settings (key, value) values
  ('bishop_notify_phone', '3852425474')     -- who gets the text: digits only; blank = no texts
on conflict (key) do nothing;
