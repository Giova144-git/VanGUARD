-- 0008h_revoke_public_authenticated.sql · hueco de la auditoría del FRONT, verificado por el ORQUESTADOR: 0008 dejó un
-- grant select por columnas en public.contacts a authenticated (todas menos phone_e164). Con la publishable y cualquier
-- sesión, GET /rest/v1/contacts funcionaba, y el anónimo de «Ver demo» veía nombres y banderas de los contactos del
-- equipo. Va contra la decisión (a): authenticated no lee nada de public directamente, todo pasa por /api.
-- Se quita todo lo que quedaba a anon y authenticated en public: el SELECT por columnas y los REFERENCES, TRIGGER y
-- MAINTAIN del ACL por defecto del proyecto (no se usan). El ACL por defecto también deja de dárselos a las tablas nuevas
-- (wiki_runs y siguientes): cada migración que necesite un grant lo declara y pasa por el ORQUESTADOR.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
