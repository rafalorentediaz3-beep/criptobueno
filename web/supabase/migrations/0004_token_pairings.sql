-- Creator-selected Robinhood stock reference for a launch.
create table if not exists token_pairings (
  token_address text primary key,
  creator_address text not null,
  stock_symbol text not null,
  stock_name text not null,
  stock_image_url text not null,
  updated_at timestamptz not null default now()
);

create index if not exists token_pairings_creator_idx
  on token_pairings (creator_address);
