-- Применено в проекте unrikrqynkcfvcpyarql через MCP (миграция rss_bot_schema).
-- Локальная копия для справки.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create table public.subscriptions (
  id bigint generated always as identity primary key,
  feed_url text not null unique,
  title text,
  created_at timestamptz not null default now()
);

create table public.sent_episodes (
  id bigint generated always as identity primary key,
  subscription_id bigint not null references public.subscriptions(id) on delete cascade,
  guid text not null,
  title text,
  sent_at timestamptz not null default now(),
  unique (subscription_id, guid)
);

create table public.bot_state (
  key text primary key,
  value text not null
);

alter table public.subscriptions enable row level security;
alter table public.sent_episodes enable row level security;
alter table public.bot_state enable row level security;

-- Ежедневная проверка фидов (создано отдельно, job "rss-bot-daily-check"):
-- select cron.schedule(
--   'rss-bot-daily-check',
--   '0 7 * * *',  -- 07:00 UTC
--   $$
--   select net.http_post(
--     url := 'https://unrikrqynkcfvcpyarql.supabase.co/functions/v1/rss-bot',
--     headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET из index.ts>'),
--     body := '{}'::jsonb,
--     timeout_milliseconds := 10000
--   );
--   $$
-- );
