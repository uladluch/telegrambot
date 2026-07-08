-- Ежедневный дайджест (07:00 UTC) и watchdog зависших заданий (раз в час).
-- Оба дёргают edge-функцию rss-bot по x-cron-secret через pg_net.

create extension if not exists pg_net;

-- Пересоздаём джобы идемпотентно
do $$
begin
  perform cron.unschedule(jobid) from cron.job
    where jobname in ('rss-bot-daily-digest', 'rss-bot-watchdog');
exception when others then null;
end $$;

select cron.schedule(
  'rss-bot-daily-digest',
  '0 7 * * *',
  $$
  select net.http_post(
    url := 'https://unrikrqynkcfvcpyarql.supabase.co/functions/v1/rss-bot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', 'b57e02c1f4d98a366c2e9b0d715f4ac8de360b9271c5e884'
    ),
    body := '{"task":"digest"}'::jsonb
  );
  $$
);

select cron.schedule(
  'rss-bot-watchdog',
  '30 * * * *',
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
