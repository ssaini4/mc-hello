create table notes (
  id bigserial primary key,
  author text not null,
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
