-- 0023_cloudflare_por_url.sql · Cloudflare sin zona (asignaciones/cloudflare-por-url.md): una conexión cloudflare en modo
-- sitio (meta.mode = 'url': un sitio de Pages o Workers o su dominio propio) no tiene zone_id. El check de 0003 que lo
-- exigía a toda conexión cloudflare se relaja a «zone_id o modo url». Sin columnas nuevas. Las conexiones de acciones
-- (bloquear IP, bajo ataque) siguen necesitando zona: el BACK solo las crea en modo zona.
alter table public.connections drop constraint if exists connections_check2;
alter table public.connections add constraint connections_check2
  check (provider <> 'cloudflare' or meta ? 'zone_id' or (coalesce(meta->>'mode', '') = 'url' and kind = 'read'));
-- coalesce: sin meta.mode, «null = 'url'» es null y un check null PASA; así una cloudflare sin zona ni modo se rechaza.
-- Probada en una transacción deshecha: url read ok · sin zona ni modo rechazada · url action rechazada · zona y github ok.
