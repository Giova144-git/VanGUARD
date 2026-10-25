-- 0014b_mcp_tokens_guardas.sql · cable trampa del name de mcp_tokens (revisión adversarial del MCP propio, S13 §13.7).
-- E29 ya rechaza con 422 un name que parezca un secreto o lleve vgk_ (rutas/mcp-tokens.ts); esto es la red de la base,
-- como en findings, incidents o connections: quien pega su token como nombre no lo deja en claro en la lista de E29b.
-- NOT VALID primero (no recorre la tabla con el lock fuerte) y VALIDATE después: falla si alguna fila existente no lo
-- cumple, así que antes de aplicarla se comprueba con
--   select count(*) from public.mcp_tokens where private.looks_like_secret(name);   -- debe dar 0
-- Idempotente: el add solo si la restricción no existe; validar una ya válida no hace nada. Prueba: tests/mcp-tokens.sql.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'mcp_tokens_name_no_secreto' and conrelid = 'public.mcp_tokens'::regclass) then
    alter table public.mcp_tokens add constraint mcp_tokens_name_no_secreto
      check (not private.looks_like_secret(name)) not valid;
  end if;
end $$;
alter table public.mcp_tokens validate constraint mcp_tokens_name_no_secreto;
