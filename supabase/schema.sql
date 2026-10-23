-- OpenInstinct Supabase schema — the shared ledger + encrypted vault.
-- Run once in the Supabase SQL editor. Only the service key touches these tables
-- (RLS enabled, no anon policies): the Vercel webhook and the Render worker both use it.

create table if not exists tasks (
  id           bigint generated always as identity primary key,
  phone_number text,
  goal         text,
  status       text default 'pending',   -- pending|running|approved|denied|done|failed|cancelled
  gate         text,                     -- what the chat is being asked for: approval|code|location|captcha
  gate_domain  text,
  pid          bigint,                   -- the worker's runner process (informational)
  created_at   timestamptz default now()
);

create table if not exists pending_codes (
  id         bigint generated always as identity primary key,
  task_id    bigint,
  domain     text,
  code       text,
  created_at timestamptz default now()
);

create table if not exists pending_locations (
  id         bigint generated always as identity primary key,
  task_id    bigint,
  location   text,
  created_at timestamptz default now()
);

create table if not exists retries (
  id         bigint generated always as identity primary key,
  task_id    bigint,
  created_at timestamptz default now()
);

-- same columns as the Fernet-era vault.db account rows; ciphertext blobs are
-- AES-256-GCM (dashboard/Node) or Fernet (local python) under OI_VAULT_KEY
create table if not exists accounts (
  id           bigint generated always as identity primary key,
  domain       text not null,
  label        text not null default 'account',
  kind         text not null default 'custom',
  enc_username text,
  enc_password text,
  enc_totp     text,
  enc_address  text,
  enc_upi      text,
  enc_pan      text,
  enc_cvv      text,
  enc_expiry   text,
  is_default   int not null default 1,
  created_at   timestamptz default now()
);

alter table tasks enable row level security;

-- ---- multi-tenant BYOK -------------------------------------------------------------------
-- One row per user bot. token / api_key are AES-256-GCM ciphertext in the same vault
-- format (dashboard encrypts with OI_VAULT_KEY, the Render worker decrypts). token_hash
-- is sha256(token) so the /api/telegram/webhook/[token] route resolves the bot without
-- decrypting every row, and Telegram itself echoes the plaintext in the webhook URL.
create table if not exists bot_credentials (
  id           bigint generated always as identity primary key,
  token        text not null,
  token_hash   text not null unique,
  api_key      text,                     -- model-provider key (may be null)
  model        text not null,            -- LiteLLM model string, e.g. "openrouter/auto"
  api_base     text,                     -- openai-compatible endpoint (custom providers)
  created_at   timestamptz default now()
);
alter table bot_credentials enable row level security;

-- chat_id alone is ambiguous once several bots share the ledger — every task carries its bot
alter table tasks add column if not exists bot_id bigint;
alter table pending_codes enable row level security;
alter table pending_locations enable row level security;
alter table retries enable row level security;
alter table accounts enable row level security;