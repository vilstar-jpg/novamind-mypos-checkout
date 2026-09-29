create extension if not exists pgcrypto;

create table if not exists public.payment_intents (
  id uuid primary key default gen_random_uuid(),
  mypos_order_id text not null unique,
  product_key text not null,
  product_title text not null,
  shopify_variant_id text not null,
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null check (currency = 'EUR'),
  status text not null default 'PENDING' check (status in ('PENDING','PAID_VERIFIED','SHOPIFY_PENDING','SHOPIFY_CREATED','FAILED')),
  mypos_transaction_ref text unique,
  shopify_order_id text unique,
  customer_email text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  shopify_created_at timestamptz,
  last_error text,
  retry_count integer not null default 0 check (retry_count >= 0)
);

create index if not exists payment_intents_status_idx on public.payment_intents(status);
create index if not exists payment_intents_created_at_idx on public.payment_intents(created_at);

alter table public.payment_intents enable row level security;
