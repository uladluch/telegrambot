-- Кэш file_id Telegram: тот же контент, уже загруженный ботом, повторно отправляется
-- по file_id без скачивания/заливки — мгновенно.
-- Ключи: "yt:<videoId>:<v|a|rv|ra>", "pod:<guid>".
-- Применено в проекте unrikrqynkcfvcpyarql через MCP; локальная копия для истории.

create table if not exists public.tg_files (
  cache_key text primary key,
  file_id text not null,
  file_type text not null,       -- video | audio
  caption text,
  created_at timestamptz not null default now()
);
alter table public.tg_files enable row level security;
