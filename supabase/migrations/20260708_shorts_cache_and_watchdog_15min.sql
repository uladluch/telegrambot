-- Кэш статуса «шортс/не шортс» + watchdog каждые 15 минут.
-- Применено в проекте unrikrqynkcfvcpyarql через MCP; локальная копия для истории.

-- Статус видео вечен — проверяем YouTube один раз и кэшируем (filterShorts в edge).
create table if not exists public.youtube_meta (
  video_id text primary key,
  is_short boolean not null,
  checked_at timestamptz not null default now()
);
alter table public.youtube_meta enable row level security;

-- Watchdog чаще: каждые 15 минут вместо раза в час. Пороги по типу задания —
-- в edge-функции (20 мин обычные, 90 мин RU-озвучка).
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'rss-bot-watchdog';
exception when others then null;
end $$;

select cron.schedule(
  'rss-bot-watchdog',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://unrikrqynkcfvcpyarql.supabase.co/functions/v1/rss-bot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', 'b57e02c1f4d98a366c2e9b0d715f4ac8de360b9271c5e884'
    ),
    body := '{"task":"watchdog"}'::jsonb
  );
  $$
);
