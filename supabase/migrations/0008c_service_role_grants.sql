-- 0008c_service_role_grants.sql · el Worker (sb_secret_, rol service_role, salta RLS) necesita DML en public.
-- Este proyecto NO da por defecto lectura ni escritura a service_role en las tablas nuevas de public (privilegios por
-- defecto de postgres: service_role=Dxtm). El plan (§05.5) daba por hecho los grants por defecto de Supabase: sin esto,
-- toda consulta del cliente admin que no sea una RPC security definer falla con 42501 (encontrado por test:fuga).
-- Solo service_role: anon y authenticated siguen SIN SELECT directo (decisión (a) del ORQUESTADOR; los datos van por la API).
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;
