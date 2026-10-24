-- 0008_rls_retention.sql · literal de PLAN_MAESTRO §05.5 (RLS, políticas y privilegios) y §05.10 (retención con pg_cron).
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop      -- 0 tablas de public sin RLS
    execute format('alter table public.%I enable row level security', t);
  end loop;
  revoke all on all tables in schema public from anon;                           -- anon no lee ni escribe nada
  revoke insert, update, delete, truncate on all tables in schema public from authenticated;   -- solo escribe el Worker
  foreach t in array array['connections','scan_runs','findings','incidents','notifications','actions',
                           'contacts','metric_samples','perf_runs'] loop          -- patrón canónico §6
    execute format('drop policy if exists %I on public.%I', t || '_sel', t);
    execute format('create policy %I on public.%I for select to authenticated using (org_id in (select private.user_org_ids()))',
                   t || '_sel', t);
  end loop;
  foreach t in array array['connection_secrets','approvals','edge_hits','edge_eval_state','ai_usage','app_config',
                           'webhook_events'] loop                                 -- solo servidor: RLS sin políticas
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
drop policy if exists orgs_sel on public.orgs;
create policy orgs_sel on public.orgs for select to authenticated using (id in (select private.user_org_ids()));
drop policy if exists org_members_sel on public.org_members;
create policy org_members_sel on public.org_members for select to authenticated using (org_id in (select private.user_org_ids()));
-- [propuesta, decisión abierta 14 de 00.7; NO aplicada en este DDL] Excluir a los anónimos de las políticas *_sel salvo en la
-- org is_demo, para que el advisor de «políticas accesibles a anónimos» no marque al proyecto (06.12 D4).
-- El viewer anónimo de la org de demo (el jurado) ve la fila del contacto, pero NO el teléfono del equipo:
revoke select on public.contacts from authenticated;
grant select (id, org_id, name, whatsapp, voice, priority, verified_at, created_at) on public.contacts to authenticated;

-- §05.10 · retención
create extension if not exists pg_cron;   -- si falla, activarlo en el panel (Integrations → Cron)
-- Una sola sentencia por trabajo (los ejemplos de Supabase son así): la purga diaria va dentro de una función.
create or replace function private.vg_purge_daily() returns void
language plpgsql set search_path = '' as $$
begin
  delete from public.metric_samples where ts < now() - interval '7 days';
  delete from public.webhook_events where received_at < now() - interval '7 days';
  delete from public.approvals where expires_at < now() - interval '7 days';
  delete from public.notifications where created_at < now() - interval '30 days';
  delete from public.scan_runs where created_at < now() - interval '90 days';
  delete from public.findings where status <> 'open' and last_seen_at < now() - interval '90 days';
  delete from public.incidents where status = 'resolved' and resolved_at < now() - interval '90 days';
  delete from public.ai_usage where created_at < now() - interval '90 days';
  delete from auth.users where is_anonymous is true and created_at < now() - interval '7 days';
  delete from cron.job_run_details where end_time < now() - interval '7 days';
end $$;
revoke all on function private.vg_purge_daily() from public, anon, authenticated;
select cron.schedule('vg-purge-edge-hits', '7 * * * *',
  $$delete from public.edge_hits where ts < now() - interval '24 hours'$$);
select cron.schedule('vg-purge-daily', '15 7 * * *', $$select private.vg_purge_daily()$$);   -- 07:15 UTC = 03:15 en Caracas
select cron.schedule('vg-expire-connections', '*/10 * * * *',
  $$update public.connections set status = 'expired' where status = 'active' and expires_at < now()$$);
