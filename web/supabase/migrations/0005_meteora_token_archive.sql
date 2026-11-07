-- Append-only archive of Meteora DBC tokens. Historical token and fee fields
-- live in data (JSONB); later syncs only enrich that object with verified links.
create table if not exists public.meteora_tokens (
  mint            text primary key,
  pool_created_at bigint not null,
  fees_usd        numeric not null,
  first_seen_at   timestamptz not null,
  data            jsonb not null
);

create index if not exists meteora_tokens_created_idx
  on public.meteora_tokens (pool_created_at desc);

alter table public.meteora_tokens enable row level security;
revoke all on table public.meteora_tokens from anon, authenticated;
grant all on table public.meteora_tokens to service_role;

create table if not exists public.meteora_sync_state (
  id           integer primary key check (id = 1),
  scan_page    integer not null default 1,
  last_poll_at timestamptz,
  last_error   text
);

alter table public.meteora_sync_state enable row level security;
revoke all on table public.meteora_sync_state from anon, authenticated;
grant all on table public.meteora_sync_state to service_role;

insert into public.meteora_sync_state (id, scan_page)
values (1, 1)
on conflict (id) do nothing;
