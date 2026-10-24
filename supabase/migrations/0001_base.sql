-- 0001_base.sql · literal de PLAN_MAESTRO §05.4 (+ private.sev_rank de §15.12, bloque «0001»).
create schema if not exists private;                       -- no expuesto por la Data API
grant usage on schema private to authenticated;             -- las políticas llaman a private.user_org_ids()
create extension if not exists pgcrypto with schema extensions;   -- gen_random_bytes(), digest()
-- Postgres da EXECUTE a PUBLIC en cada función nueva y Supabase suele conceder a anon/authenticated en public
-- [no verificado en el proyecto; rls.sql lo comprueba]. Se quita por defecto y, aun así, cada función hace su revoke.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke insert, update, delete, truncate on tables from authenticated;  -- solo escribe el Worker

-- Cable trampa: si redact() falla, la base rechaza la fila (error 23514) en vez de guardar un token completo.
create or replace function private.looks_like_secret(p text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p, '') ~ ('(sb_secret_[A-Za-z0-9_-]{16,}|sbp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}'
    || '|gh[pousr]_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|vg[iks]_[A-Za-z0-9_-]{20,}|cf(k|ut|at)_[A-Za-z0-9_-]{30,}'
    || '|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.)') $$;
grant execute on function private.looks_like_secret(text) to service_role;

-- Rango de severidad para parámetros text (las tablas usan la columna generada severity_rank).
create or replace function private.sev_rank(p text) returns smallint language sql immutable set search_path = '' as $$
  select (case p when 'critical' then 5 when 'high' then 4 when 'medium' then 3 when 'low' then 2 else 1 end)::smallint $$;
