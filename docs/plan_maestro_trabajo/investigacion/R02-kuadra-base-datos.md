# R02 — KUADRA «Base de datos»: catálogo de chequeos de salud de Postgres/Supabase

Investigación R02, etapa 1 del plan maestro (team-22, Platanus Hack 26). Fuente: KUADRA CRM (solo lectura).
Fecha: 24-10-2026.

## 0. Resumen

1. En KUADRA el SQL **no está en el Dart**: el módulo `lib/modulos/base_datos` solo pinta. Toda la lógica vive en
   funciones `plataforma.crm_base_*` de las migraciones de `KUADRA MASTER/supabase/migrations` (ver §1).
2. KUADRA corre esas funciones **dentro de la base del cliente** (SECURITY DEFINER, `service_role`). Nosotros NO podemos
   instalar funciones en la base del usuario: hay que portar el SQL a **consultas sueltas de solo lectura**.
3. Credencial recomendada: **PAT con permisos acotados** (`database_read` + `advisors_read`) y el endpoint
   `POST /v1/projects/{ref}/database/query/read-only`, que corre como `supabase_read_only_user`
   [verificado: https://supabase.com/docs/reference/api/v1-read-only-query]. Ni `service_role` ni contraseña de Postgres.
4. Lo más valioso de KUADRA y portable tal cual: «tablas más pesadas» con datos/índices/TOAST separados, la **estimación
   de lo recuperable** sin `pgstattuple` (índices btree y tuplas muertas), el umbral de 10 MB, la regla 80 % / 95 % del
   límite del plan, conexiones/caché/consultas lentas, crones fallidos y respuestas HTTP fallidas de `pg_net`.
5. Lo que KUADRA hace y nosotros NO debemos hacer automáticamente: `VACUUM FULL`, `REINDEX`, `DROP INDEX`, purgas.
   Encaja con la decisión previa (MCP en solo lectura): generamos el **SQL de corrección + prompt**, el dueño lo ejecuta.
6. Supabase ya expone 30 lints oficiales (splinter) por `GET /v1/projects/{ref}/advisors/{performance|security}`
   [verificado: https://supabase.com/docs/guides/database/database-advisors]. Conviene **consumirlos** y añadir encima lo
   que no cubren (tamaño frente al plan, hinchazón estimada por tabla, conexiones, consultas largas, bloqueos, crones).
7. CPU/RAM/disco del servidor NO salen por SQL: salen del endpoint Prometheus `/customer/v1/privileged/metrics`, que pide
   una clave secreta (`sb_secret_…`) [verificado: https://supabase.com/docs/guides/telemetry/metrics]. Choca con «no pedir
   service_role»: decisión abierta (§6).

---

## 1. Dónde está cada cosa en KUADRA (mapa de lectura)

| Pieza | Archivo | Qué aporta |
|---|---|---|
| Modelos de la lectura | `kuadra_crm/lib/modulos/base_datos/modelos.dart` | Forma de la respuesta (`cifras`, `ahora`, `checks`, `secciones`, `historial`, `errores`). |
| Cliente RPC | `.../base_datos/servicio.dart` | Lista blanca de 5 RPC, lotes de borrado (20.000 por llamada, 50 vueltas máx.). |
| Umbrales en Dart | `.../base_datos/sector_pesadas.dart` | `umbralHinchada = 10 MB`; rol del límite: aviso ≥ 80 %, mal ≥ 95 %; verbo sugerido. |
| Mantenimiento | `.../base_datos/mantenimiento.dart` + `categorias/.../backup/contrato_backup.dart` (líneas 1371-1478) | Sentencias exactas de VACUUM/REINDEX/DROP INDEX y la guarda en sesión. |
| Explorador/Consola | `.../base_datos/explorador.dart` | Lista de relaciones, columnas (`information_schema.columns`), página de 100 filas, detector de lectura. |
| Filas del disco | `.../base_datos/ahora_disco.dart` | Antigüedad del backup: mal ≥ 30 d o nunca, aviso 7-29 d. |
| Lectura del módulo | `KUADRA MASTER/supabase/migrations/20261018001933_crm_ola4_b_datos_base_datos.sql` | `crm_base_datos_estado`: cifras, «Ahora» (hinchada, purgable, base_limite), checks, secciones. |
| Tablas pesadas | `.../20261004162831_ola3_base_pesadas_mantenimiento.sql` (+ arreglo `20261004191259`) | `crm_base_pesadas`, `_base_tablas_criticas`, `_base_mantenimiento_motivo`, `crm_base_mantenimiento_exigir`. |
| Purgas | `.../20261004162400_ola3_auditoria_funcion_unica.sql`, `.../20261004163919_ola3_crm_base_purgar_vaciar.sql` | Retención por tabla de auditoría, borrado por lotes con `ctid`, cerrojo consultivo. |
| Resumen técnico | `.../20260825130000_crm_tecnologia_rpc.sql` (`crm_resumen`) | Conexiones por estado, `max_connections`, cache hit, commits/rollbacks, crones, `net._http_response`. |
| Inventario (backup) | `categorias/.../backup/exportar_base_inventario.dart` (líneas 478-555) | Políticas RLS con huella md5, FK `NOT VALID` con huérfanas. |

Alcance de `lib/categorias/tecnologia/base_datos` (solo hojeado, no se detalla): backup completo a un `.kuadra` (zip)
con `pg_dump`/`pg_dumpall` nativos, Storage, código de edge functions y configuración del proyecto vía Management API;
Restaurar en «mismo proyecto» o «proyecto nuevo» con corte de tráfico, registro de pasos en disco y verificación de 16
puntos contra el destino. Es un producto entero en sí mismo: **fuera de alcance del hackatón**. De ahí solo nos sirve la
regla «antes de una acción destructiva, ofrecer backup» y el chequeo de antigüedad del último backup (que en Supabase se
lee por API, no por SQL).

### 1.1 Principios de diseño de KUADRA que conviene copiar

- **La base decide, la pantalla pinta.** Cada chequeo devuelve filas con un `rol` (`mal` / `aviso` / `cola`) ya decidido
  por reglas deterministas. Equivale a nuestra decisión previa: «el motor de reglas decide la alerta, NO el modelo».
- **Clave estable por hallazgo**: `clave = '<modulo>:<tipo>:<objeto>'` (ej. `base_datos:hinchada:public.pedidos`). Sirve
  para deduplicar: solo se llama/escribe por WhatsApp cuando aparece una clave nueva o empeora su rol.
- **Una lectura = un JSON con secciones independientes**; si una sección falla, va a `errores: {"<seccion>": "fallo"}` y
  el resto se pinta. Nosotros lo replicamos con varias peticiones (§5), porque sin funciones PL/pgSQL no hay
  `exception when others` por sección.
- **Fallar cerrado**: en `_base_mantenimiento_motivo` un `guardia`/`caliente` nulo cuenta como «sí» (no se permite
  compactar si no se sabe).
- **Nunca el texto crudo del error**: se normaliza a `lock_timeout`, `statement_timeout`, `no_permitido`, `ocupado`,
  `fallo`. Útil para no filtrar datos del cliente a Claude ni a los logs.

---

## 2. Credenciales: qué necesita cada chequeo

| Código | Credencial | Cómo se usa | Notas |
|---|---|---|---|
| **C1** | PAT acotado con `database_read` | `POST https://api.supabase.com/v1/projects/{ref}/database/query/read-only`, cuerpo `{"query": "..."}` | Corre como `supabase_read_only_user`; «todas las referencias deben ir calificadas con esquema»; endpoint en beta [verificado: https://supabase.com/docs/reference/api/v1-read-only-query]. Forma de la respuesta 201 no documentada (la doc muestra `{}`) [no verificado: probar el día 1; se espera un array de filas]. |
| **C2** | PAT acotado con `advisors_read` | `GET /v1/projects/{ref}/advisors/performance` y `/advisors/security` (`lint_type` opcional) | Devuelve `{lints: [{name, title, level, facing, categories, description, detail, remediation, metadata, cache_key, observed_at}]}` [verificado: https://supabase.com/docs/reference/api/v1-get-performance-advisors y https://supabase.com/docs/reference/api/v1-get-security-advisors]. |
| **C3** | Clave secreta `sb_secret_…` (Basic Auth, usuario literal `service_role`) | `GET https://{ref}.supabase.co/customer/v1/privileged/metrics` (Prometheus, ~200 series, raspar 1/min) | Única vía para CPU/RAM/disco/IO [verificado: https://supabase.com/docs/guides/telemetry/metrics]. Nombres de series (`node_cpu_seconds_total`, `node_memory_MemAvailable_bytes`, `node_load5`) citados por Elastic [verificado: https://www.elastic.co/docs/reference/integrations/supabase]; `node_filesystem_avail_bytes` [no verificado]. |
| **C4** | Conexión Postgres con rol propio de solo lectura | `postgres://vigia_ro:...@<pooler>:5432/postgres` | Plan B si el usuario no quiere PAT. Exige que el usuario ejecute el SQL de §2.2. |
| **C5** | PAT con `database_write` | `POST /v1/projects/{ref}/database/query` (`read_only` opcional) | Solo para ejecutar correcciones. **No lo pedimos en el MVP**: VACUUM/REINDEX CONCURRENTLY no pueden ir en un bloque de transacción y no está documentado si este endpoint envuelve la consulta en una [no verificado]. |

Límites de la Management API: 120 peticiones/min por usuario, por proyecto y por endpoint; 429 con cabeceras
`X-RateLimit-Limit/Remaining/Reset`. Los PAT «scoped» se limitan a organizaciones, proyectos y permisos elegidos al
crearlos; los «classic/Legacy» tienen todos los privilegios del usuario [verificado: https://supabase.com/docs/reference/api/introduction].
Pedir **scoped**, nunca legacy.

### 2.1 Sonda de capacidades (primera consulta de cada escaneo, C1)

Privilegios de `supabase_read_only_user` sobre `pg_stat_*`, `cron` y `net` [no verificado: no hay doc pública]. Por eso
cada escaneo empieza con esta sonda y salta los chequeos que no se pueden correr (marcándolos «sin permiso», no «OK»):

```sql
select pg_catalog.jsonb_build_object(
  'version_num',        pg_catalog.current_setting('server_version_num')::int,
  'usuario',            current_user,
  'max_connections',    pg_catalog.current_setting('max_connections')::int,
  'read_all_stats',     pg_catalog.pg_has_role(current_user, 'pg_read_all_stats', 'member'),
  'pg_stat_statements', exists (select 1 from pg_catalog.pg_extension where extname = 'pg_stat_statements'),
  'pg_cron',            exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron'),
  'pg_net',             exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net'),
  'cron_legible',       pg_catalog.to_regclass('cron.job') is not null
                        and pg_catalog.has_table_privilege(pg_catalog.to_regclass('cron.job'), 'SELECT'),
  'net_legible',        pg_catalog.to_regclass('net._http_response') is not null
                        and pg_catalog.has_table_privilege(pg_catalog.to_regclass('net._http_response'), 'SELECT'),
  'stats_reset',        (select stats_reset from pg_catalog.pg_stat_database
                          where datname = pg_catalog.current_database())
) as sonda;
```

Sin `read_all_stats`, `pg_stat_activity.query` y `pg_stat_statements.query` de otros roles salen como
`<insufficient privilege>`; los conteos siguen funcionando (comportamiento estándar de Postgres; [verificado:
https://www.postgresql.org/docs/16/predefined-roles.html]).

### 2.2 Plan B (C4): rol de solo lectura que el usuario crea (SQL para pegar en su SQL Editor)

```sql
create role vigia_ro login password '<generada-por-nosotros>' nobypassrls;
grant pg_monitor to vigia_ro;            -- pg_read_all_stats + pg_read_all_settings + pg_stat_scan_tables
grant usage on schema extensions to vigia_ro;
alter role vigia_ro set default_transaction_read_only = on;
alter role vigia_ro set statement_timeout = '15s';
-- opcional, solo si quiere el chequeo de crones:
grant usage on schema cron to vigia_ro; grant select on cron.job, cron.job_run_details to vigia_ro;
```

`pg_monitor` no da acceso a datos de tablas, solo a estadística y configuración [verificado:
https://www.postgresql.org/docs/16/predefined-roles.html]. Que Supabase permita `grant pg_monitor` desde el rol
`postgres` del panel: [no verificado].

---

## 3. Catálogo de chequeos

Convenciones:
- Severidad: **crítico** (llama ElevenLabs + WhatsApp), **aviso** (WhatsApp + panel), **info** (solo panel). Mapeo con
  KUADRA: `mal` → crítico, `aviso` → aviso, `cola` → info.
- «Origen»: `KUADRA` = SQL o umbral sacado tal cual (adaptado a esquema calificado y sin funciones propias);
  `lint NNNN` = cubierto también por el advisor oficial; `propio` = SQL estándar de catálogo escrito para este informe
  (no probado contra un proyecto real todavía).
- `$EXCL` = lista de esquemas de plataforma que no son del usuario. Valor propuesto:
  `('pg_catalog','information_schema','pg_toast','auth','storage','realtime','supabase_functions','extensions','graphql','graphql_public','net','pgsodium','pgsodium_masks','vault','cron','supabase_migrations','_realtime','_analytics','pgbouncer')`
  [no verificado como lista completa; ajustar con la salida real de `pg_namespace` del proyecto de demo].
- Todas las correcciones se entregan como texto (SQL + prompt), nunca se ejecutan desde nuestro backend.

### Resumen del catálogo

| id | Detecta | Origen | Credencial | Severidad máx. |
|---|---|---|---|---|
| DB-01 | Tamaño de la base frente al límite del plan | KUADRA | C1 | crítico |
| DB-02 | Tablas más pesadas (datos/índices/TOAST, vivas/muertas) | KUADRA | C1 | info (alimenta a otros) |
| DB-03 | Crecimiento por tabla entre escaneos | KUADRA (foto) | C1 + nuestra BD | aviso |
| DB-04 | Índices btree hinchados (recuperable estimado) | KUADRA | C1 | aviso |
| DB-05 | Tabla hinchada por tuplas muertas (≥ 10 MB recuperables) | KUADRA + lint 0020 | C1 / C2 | aviso |
| DB-06 | Autovacuum atrasado (tuplas muertas por encima del disparo) | propio | C1 | aviso |
| DB-07 | Autovacuum desactivado en una tabla | propio + lint 0030 | C1 / C2 | aviso |
| DB-08 | Índices inválidos (restos `_ccnew`/`_ccold`) | KUADRA | C1 | aviso |
| DB-09 | Índices sin uso | propio + lint 0005 | C1 / C2 | info |
| DB-10 | Índices duplicados | propio + lint 0009 | C1 / C2 | aviso |
| DB-11 | Claves foráneas sin índice | propio + lint 0001 | C1 / C2 | info → aviso |
| DB-12 | Escaneos secuenciales masivos (índice faltante) | propio | C1 | aviso |
| DB-13 | Tablas sin clave primaria | propio + lint 0004 | C1 / C2 | info |
| DB-14 | Consultas más lentas (`pg_stat_statements`) | KUADRA | C1 (+stats) | aviso |
| DB-15 | Cache hit, rollbacks, deadlocks, temporales | KUADRA (+propio) | C1 | crítico |
| DB-16 | Consultas largas e `idle in transaction` | propio | C1 (+stats) | crítico |
| DB-17 | Bloqueos (quién bloquea a quién) | propio | C1 | crítico |
| DB-18 | Conexiones frente a `max_connections` | KUADRA | C1 | crítico |
| DB-19 | Conexiones por rol/aplicación | KUADRA (agrupado) | C1 | info |
| DB-20 | Crones `pg_cron` fallando | KUADRA | C1 (+cron) | aviso |
| DB-21 | Peticiones HTTP salientes fallidas (`pg_net`) | KUADRA | C1 (+net) | aviso |
| DB-22 | Tablas de log/auditoría que crecen sin retención | KUADRA (generalizado) | C1 (+cron) | aviso |
| DB-23 | Edad de transacciones (wraparound) | propio | C1 | crítico |
| DB-24 | Slots de replicación inactivos que retienen WAL | propio | C1 | crítico |
| DB-25 | FK `NOT VALID` con filas huérfanas | KUADRA | C1 | info |
| DB-26 | Tablas calientes (no compactar) | KUADRA (simplificado) | C1 | — (guarda) |
| SEC-01..03 | RLS apagada, políticas abiertas, SECURITY DEFINER ejecutable por `anon` | KUADRA (políticas) + lints | C1 / C2 | crítico |

---

### 3.1 Capacidad y disco

#### DB-01 — Tamaño de la base frente al límite del plan (KUADRA)

- **Detecta**: la base se acerca al límite del plan. KUADRA mide `sum(pg_database_size)` de TODAS las bases, «la cifra
  que Supabase compara con el límite del plan» (migración `20261004191259`, comentario de `crm_resumen`).
- **SQL** (C1):
```sql
select (select coalesce(sum(pg_catalog.pg_database_size(d.oid)), 0)
          from pg_catalog.pg_database d
         where pg_catalog.has_database_privilege(d.oid, 'CONNECT'))::bigint as todas_bytes,
       pg_catalog.pg_database_size(pg_catalog.current_database())          as base_bytes;
```
  (El filtro `has_database_privilege` es nuestro: KUADRA corre como `postgres` y no lo necesita.)
- **Umbral** (KUADRA, `sector_pesadas.dart` `rolLimite` y `crm_base_datos_estado`): `pct = round(100 * todas / límite)`;
  **aviso ≥ 80 %**, **crítico ≥ 95 %**. Límite: lo elige el usuario o se infiere del plan.
  - Free: cuota de 500 MB de base **por organización** (pasarse puede dar restricción de uso justo, HTTP 402) y disco fijo
    de 2 GB; **modo solo lectura al 95 % de disco** (`SQLSTATE 25006`). Pro: el disco crece solo al 90 % (+50 %, máx.
    4 ampliaciones en 24 h, una cada 4 h); si agota las ampliaciones y llega al 95 %, también solo lectura
    [verificado: https://supabase.com/docs/guides/platform/database-size].
  - KUADRA usa 500 MB por defecto (`baseLimiteMbPorDefecto = 500`, `nucleo/config.dart`).
- **Acción**: mostrar DB-02 (qué pesa) y DB-22 (qué se puede purgar). Prompt de corrección: purga por lotes + `VACUUM`;
  si es crecimiento legítimo, subir de plan. Para salir de solo lectura en Free: `set session characteristics as
  transaction read write;` → borrar → `vacuum;` → `set default_transaction_read_only = 'off';`
  [verificado: https://supabase.com/docs/guides/platform/database-size].

#### DB-02 — Tablas más pesadas (KUADRA `crm_base_pesadas`, portado)

- **Detecta**: las N relaciones (`relkind` r/m, no temporales) más grandes, con datos, índices y TOAST por separado, filas
  vivas/muertas y último vacuum. Solo catálogo y estadística: **no cuenta filas** (barato).
- **SQL** (C1). Incluye ya las columnas de DB-04, DB-05 y DB-08 para hacerlo en una sola pasada:
```sql
with top as (
  select c.oid, n.nspname as esquema, c.relname as nombre, c.reltoastrelid, c.reltuples,
         pg_catalog.pg_total_relation_size(c.oid) as total
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'm') and c.relpersistence <> 't'
     and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
   order by pg_catalog.pg_total_relation_size(c.oid) desc nulls last, c.oid
   limit 25
), f as (
  select t.*,
         pg_catalog.pg_relation_size(t.oid)  as datos,
         pg_catalog.pg_indexes_size(t.oid)   as indices,
         case when t.reltoastrelid <> 0
              then coalesce(pg_catalog.pg_total_relation_size(t.reltoastrelid), 0) else 0 end as toast,
         coalesce(s.n_live_tup, 0) as vivas,
         coalesce(s.n_dead_tup, 0) as muertas,
         greatest(s.last_vacuum, s.last_autovacuum)   as ultimo_vacuum,
         greatest(s.last_analyze, s.last_autoanalyze) as ultimo_analyze,
         greatest(coalesce(s.n_live_tup, 0), t.reltuples::bigint, 0) as n_est
    from top t
    left join pg_catalog.pg_stat_all_tables s on s.relid = t.oid
), g as (
  select f.*,
         (select coalesce(sum(x.tam - (f.n_est * 40 + 16384)), 0)
            from (select pg_catalog.pg_relation_size(i.indexrelid) as tam
                    from pg_catalog.pg_index i
                    join pg_catalog.pg_class ic on ic.oid = i.indexrelid
                    join pg_catalog.pg_am am on am.oid = ic.relam
                   where i.indrelid = f.oid and i.indisvalid and am.amname = 'btree') x
           where x.tam > 65536 and x.tam > 4 * (f.n_est * 40 + 16384))::bigint as rec_reindexar,
         (select coalesce(pg_catalog.jsonb_agg(i.indexrelid::regclass::text), '[]'::jsonb)
            from pg_catalog.pg_index i where i.indrelid = f.oid and not i.indisvalid) as indices_invalidos
    from f
)
select esquema, nombre, total, datos, indices, toast, vivas, muertas, ultimo_vacuum, ultimo_analyze,
       rec_reindexar,
       rec_reindexar + coalesce(round(datos::numeric * muertas / nullif(vivas + muertas, 0)), 0)::bigint as rec_compactar,
       indices_invalidos
  from g
 order by total desc nulls last;
```
- **Umbral**: ninguno (informativo). En KUADRA, `p_n` se acota a 1..100 y por defecto 25.
- **Acción**: alimenta DB-01, DB-03, DB-04, DB-05, DB-08. Ejemplo de fila (cifras ilustrativas):
  `{"esquema":"public","nombre":"eventos","total":187695104,"datos":120586240,"indices":66846720,"toast":8192,"vivas":910233,"muertas":402118,"rec_reindexar":29360128,"rec_compactar":66347008,"indices_invalidos":[]}`

#### DB-03 — Crecimiento por tabla entre escaneos (KUADRA «foto»)

- **Detecta**: tablas que crecen rápido. KUADRA guardaba una foto `{tabla: total}` en `%APPDATA%` y medía contra la
  apertura anterior (`sector_pesadas.dart`, `crecimiento()`), «sin coste de base».
- **SQL**: el de DB-02; el delta se calcula en NUESTRO backend contra la foto anterior guardada en nuestra Supabase
  (`db_fotos(proyecto_id, tomada_en, esquema, tabla, total_bytes, vivas)`).
- **Umbral** [propuesto, no de KUADRA]: aviso si una tabla crece > 25 % y > 100 MB en 24 h, o si el ritmo proyecta llegar
  al 95 % del límite en < 7 días: `dias = (limite * 0.95 - todas_bytes) / bytes_por_dia`.
- **Acción**: prompt que pide revisar si es log sin retención (→ DB-22) o carga legítima; fecha estimada de llenado.

### 3.2 Hinchazón y vacuum

#### DB-04 — Índices btree hinchados (KUADRA, heurística sin `pgstattuple`)

- **Detecta**: índices btree mucho más grandes de lo que «deberían».
- **Fórmula exacta de KUADRA** (columna `rec_reindexar` de DB-02): tamaño ideal por índice `ideal = n_est * 40 + 16384`
  bytes (40 B por entrada + 16 KB), con `n_est = greatest(n_live_tup, reltuples, 0)`. Un índice cuenta si `tam > 65536`
  (64 KB) **y** `tam > 4 * ideal`; lo recuperable es `tam - ideal`. Solo índices válidos y de método `btree`.
- **Umbral** (KUADRA, decisión 11, `umbralHinchada`): **aviso si `rec_reindexar ≥ 10 MB` (10.485.760 B)**. Etiqueta:
  «Índices hinchados» si `rec_reindexar * 2 ≥ rec_compactar`; si no, «Tabla hinchada».
- **Optimización de KUADRA**: no calcula nada si ninguna relación pesa ≥ 10 MB:
```sql
select exists (select 1 from pg_catalog.pg_class c
                where c.relkind in ('r', 'm') and c.relpersistence <> 't'
                  and pg_catalog.pg_total_relation_size(c.oid) >= 10485760) as hay_candidatas;
```
- **Límite conocido**: 40 B/entrada vale para claves pequeñas (int/uuid); con claves `text` o multicolumna sobreestima
  (falso positivo). Contrastar con el lint `0020_table_bloat` (C2) y pedir en el prompt confirmación con `pgstattuple`
  si está disponible [no verificado en Supabase].
- **Acción** (KUADRA `sentenciaMantenimiento`): `REINDEX TABLE CONCURRENTLY "esquema"."tabla";` (KUADRA lo permite
  incluso en tablas del camino crítico). Sentencia propia, fuera de transacción.

#### DB-05 — Tabla hinchada por tuplas muertas (KUADRA + lint 0020)

- **Fórmula exacta de KUADRA** (columna `rec_compactar`):
  `rec_compactar = rec_reindexar + round(datos * muertas / (vivas + muertas))` (VACUUM FULL reescribe también índices).
- **Umbral** (KUADRA): **aviso si `rec_compactar ≥ 10 MB`**, solo si la tabla admite compactar (no catálogo, no temporal,
  no camino crítico, no «caliente», ver DB-26). La cifra global «Recuperable» suma las `rec_compactar > 0` del top 25.
- **Acción** (KUADRA): «Compactar N MB» = `VACUUM (FULL, ANALYZE) "esquema"."tabla";` con efecto mostrado
  «`<total>` → `<total − rec_compactar>`». **Bloquea la tabla hasta terminar** [verificado:
  https://supabase.com/docs/guides/platform/database-size]. Si `muertas > 0`: «Limpiar N» = `VACUUM (ANALYZE)
  "esquema"."tabla";` (no devuelve disco al SO, pero deja el espacio reutilizable).
- **Guarda de KUADRA para cualquier mantenimiento** (`contrato_backup.dart`, `ordenMantenimiento`): `psql -X -q -v
  ON_ERROR_STOP=1`, un `-c` por sentencia (dos en el mismo `-c` van en transacción implícita y fallan con 25001),
  `PGAPPNAME=kuadra-mantenimiento`, plazo del proceso 16 min. Lo copiamos literal en el SQL de corrección:
```sql
SET lock_timeout = '3s';          -- si la tabla está cogida, se rinde en vez de encolar a todos
SET statement_timeout = '15min';
VACUUM (FULL, ANALYZE) "esquema"."tabla";
```
  Chequeo «ocupado» de KUADRA (no lanzar si ya corre otro mantenimiento), útil como paso previo del prompt:
```sql
select count(*) as mantenimientos_activos
  from pg_catalog.pg_stat_activity a
 where a.pid <> pg_catalog.pg_backend_pid() and a.backend_type = 'client backend'
   and a.state = 'active' and a.query ~* '^\s*(vacuum|reindex|drop\s+index)';
```

#### DB-06 — Autovacuum atrasado (propio)

- **SQL** (C1), con los ajustes vivos en lugar de suponer los valores por defecto:
```sql
with cfg as (
  select pg_catalog.current_setting('autovacuum_vacuum_threshold')::numeric    as umbral,
         pg_catalog.current_setting('autovacuum_vacuum_scale_factor')::numeric as factor
)
select n.nspname as esquema, c.relname as tabla, s.n_live_tup, s.n_dead_tup,
       round(100.0 * s.n_dead_tup / nullif(s.n_live_tup + s.n_dead_tup, 0), 1) as pct_muertas,
       round(cfg.umbral + cfg.factor * greatest(c.reltuples, 0))              as disparo,
       greatest(s.last_vacuum, s.last_autovacuum) as ultimo_vacuum,
       s.autovacuum_count, s.n_mod_since_analyze
  from pg_catalog.pg_stat_all_tables s
  join pg_catalog.pg_class c on c.oid = s.relid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 cross join cfg
 where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and n.nspname !~ '^pg_temp'
   and s.n_dead_tup > 1000
   and s.n_dead_tup > cfg.umbral + cfg.factor * greatest(c.reltuples, 0)
 order by s.n_dead_tup desc
 limit 50;
```
  (Simplificación: ignora `reloptions` por tabla que cambien umbral o factor.)
- **Umbral** [propuesto]: aviso si supera el disparo **y** `ultimo_vacuum` es nulo o > 24 h; info si solo supera el disparo.
- **Acción**: `VACUUM (ANALYZE) "esquema"."tabla";`; si se repite,
  `ALTER TABLE "esquema"."tabla" SET (autovacuum_vacuum_scale_factor = 0.05);`.

#### DB-07 — Autovacuum desactivado en una tabla (propio + lint 0030)

```sql
select n.nspname as esquema, c.relname as tabla, c.reloptions
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'm', 'p')
   and exists (select 1 from pg_catalog.unnest(c.reloptions) o(opt)
                where o.opt ilike 'autovacuum_enabled=false' or o.opt ilike 'autovacuum_enabled=off');
```
- **Umbral**: cualquier fila → **aviso** (el lint oficial dice INFO; subimos porque desemboca en hinchazón y wraparound).
- **Acción**: `ALTER TABLE "esquema"."tabla" RESET (autovacuum_enabled);`

### 3.3 Índices

#### DB-08 — Índices inválidos (KUADRA)

- **Detecta**: `indisvalid = false`, típicamente restos `_ccnew`/`_ccold` de un `REINDEX CONCURRENTLY` o un `CREATE INDEX
  CONCURRENTLY` cortado. Ocupan disco, se mantienen en cada escritura y no sirven para leer.
- **SQL** (C1; misma condición que `crm_base_mantenimiento_exigir` exige para «Reparar»):
```sql
select n.nspname as esquema, t.relname as tabla, ic.relname as indice,
       pg_catalog.pg_relation_size(i.indexrelid) as bytes,
       ic.relname ~ '_cc(new|old)[0-9]*$' as resto_de_reindex,
       i.indisunique as unico
  from pg_catalog.pg_index i
  join pg_catalog.pg_class ic on ic.oid = i.indexrelid
  join pg_catalog.pg_class t  on t.oid  = i.indrelid
  join pg_catalog.pg_namespace n on n.oid = t.relnamespace
 where not i.indisvalid;
```
- **Umbral**: cualquier fila → **aviso**.
- **Acción**: si `resto_de_reindex` (lo único que KUADRA permite «Reparar»): `DROP INDEX CONCURRENTLY
  "esquema"."indice";`. Si no: `REINDEX INDEX CONCURRENTLY "esquema"."indice";`.

#### DB-09 — Índices sin uso (propio + lint 0005)

```sql
select n.nspname as esquema, t.relname as tabla, ic.relname as indice, s.idx_scan,
       pg_catalog.pg_relation_size(i.indexrelid) as bytes
  from pg_catalog.pg_stat_all_indexes s
  join pg_catalog.pg_index i     on i.indexrelid = s.indexrelid
  join pg_catalog.pg_class ic    on ic.oid = i.indexrelid
  join pg_catalog.pg_class t     on t.oid  = i.indrelid
  join pg_catalog.pg_namespace n on n.oid  = t.relnamespace
 where s.idx_scan = 0
   and not i.indisunique and not i.indisprimary
   and not exists (select 1 from pg_catalog.pg_constraint k where k.conindid = i.indexrelid)
   and n.nspname not in ($EXCL)
 order by bytes desc;
```
- **Umbral** [propuesto]: info si `bytes ≥ 1 MB` **y** las estadísticas tienen ≥ 7 días (`stats_reset` de la sonda §2.1;
  si se reiniciaron ayer, todo sale «sin uso»). Contadores acumulados desde el último reinicio [verificado:
  https://supabase.com/docs/guides/database/inspect].
- **Acción**: `DROP INDEX CONCURRENTLY "esquema"."indice";` tras confirmar que no lo usa una réplica de lectura ni una
  consulta mensual (el prompt lo advierte).

#### DB-10 — Índices duplicados (propio + lint 0009)

```sql
with ix as (
  select i.indrelid, i.indexrelid, ic.relname, ic.relam,
         i.indkey::text as k, i.indclass::text as cl, i.indcollation::text as co,
         coalesce(pg_catalog.pg_get_expr(i.indexprs, i.indrelid), '') as ex,
         coalesce(pg_catalog.pg_get_expr(i.indpred,  i.indrelid), '') as pr,
         exists (select 1 from pg_catalog.pg_constraint k where k.conindid = i.indexrelid) as es_restriccion
    from pg_catalog.pg_index i
    join pg_catalog.pg_class ic on ic.oid = i.indexrelid
)
select n.nspname as esquema, t.relname as tabla,
       pg_catalog.array_agg(ix.relname order by ix.relname) as indices,
       sum(pg_catalog.pg_relation_size(ix.indexrelid))      as bytes,
       bool_or(ix.es_restriccion)                           as alguno_es_restriccion
  from ix
  join pg_catalog.pg_class t     on t.oid = ix.indrelid
  join pg_catalog.pg_namespace n on n.oid = t.relnamespace
 where n.nspname not in ($EXCL)
 group by n.nspname, t.relname, ix.indrelid, ix.relam, ix.k, ix.cl, ix.co, ix.ex, ix.pr
having count(*) > 1;
```
- **Umbral**: cualquier grupo → **aviso** (lint WARN).
- **Acción**: `DROP INDEX CONCURRENTLY` de los duplicados que no respaldan una restricción (PK/UNIQUE/EXCLUDE).

#### DB-11 — Claves foráneas sin índice (propio + lint 0001)

```sql
select n.nspname as esquema, t.relname as tabla, k.conname as fk,
       (select pg_catalog.array_agg(a.attname order by x.ord)
          from pg_catalog.unnest(k.conkey) with ordinality x(attnum, ord)
          join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum) as columnas,
       greatest(t.reltuples, 0)::bigint as filas_est
  from pg_catalog.pg_constraint k
  join pg_catalog.pg_class t     on t.oid = k.conrelid
  join pg_catalog.pg_namespace n on n.oid = t.relnamespace
 where k.contype = 'f' and n.nspname not in ($EXCL)
   and not exists (
     select 1 from pg_catalog.pg_index i
      where i.indrelid = k.conrelid
        and (i.indkey::int2[])[0:pg_catalog.cardinality(k.conkey) - 1] @> k.conkey
        and (i.indkey::int2[])[0:pg_catalog.cardinality(k.conkey) - 1] <@ k.conkey);
```
  (Un índice sirve si sus primeras `n` columnas son exactamente las de la FK, en cualquier orden.)
- **Umbral** [propuesto]: info; **aviso** si `filas_est > 100.000` (los `DELETE`/`UPDATE` en la tabla padre recorren la
  hija entera).
- **Acción**: `CREATE INDEX CONCURRENTLY "<tabla>_<cols>_idx" ON "esquema"."tabla" (<columnas>);`

#### DB-12 — Escaneos secuenciales masivos: índice faltante (propio)

```sql
select n.nspname as esquema, c.relname as tabla, s.seq_scan, s.seq_tup_read, coalesce(s.idx_scan, 0) as idx_scan,
       s.n_live_tup, round(s.seq_tup_read::numeric / nullif(s.seq_scan, 0)) as filas_por_seq_scan
  from pg_catalog.pg_stat_all_tables s
  join pg_catalog.pg_class c     on c.oid = s.relid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname not in ($EXCL)
   and s.n_live_tup > 10000 and s.seq_scan > coalesce(s.idx_scan, 0)
 order by s.seq_tup_read desc
 limit 20;
```
- **Umbral** [propuesto]: aviso si `n_live_tup > 10.000`, `seq_scan > idx_scan` y `filas_por_seq_scan > 1.000`.
- **Acción**: aquí sí aporta el modelo: se le pasan la tabla, sus columnas e índices actuales y las consultas de DB-14
  que la tocan, y propone el `CREATE INDEX CONCURRENTLY` concreto.

#### DB-13 — Tablas sin clave primaria (propio + lint 0004)

```sql
select n.nspname as esquema, c.relname as tabla, greatest(c.reltuples, 0)::bigint as filas_est
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p') and n.nspname not in ($EXCL)
   and not exists (select 1 from pg_catalog.pg_constraint k where k.conrelid = c.oid and k.contype = 'p');
```
- **Umbral**: info. **Acción**: `ALTER TABLE ... ADD PRIMARY KEY (...)` (o columna `id bigint generated always as identity`).

### 3.4 Rendimiento, conexiones y actividad

#### DB-14 — Consultas más lentas (KUADRA, `pg_stat_statements`)

- **SQL** (C1; requiere `pg_stat_statements` y, para ver el texto de otros roles, `read_all_stats`). Es el de KUADRA
  (`crm_base_datos_estado`, sección «consultas») con dos añadidos nuestros: excluir las consultas del propio escáner y
  traer `rows`/`shared_blks_read`:
```sql
select (select pg_catalog.to_char(i.stats_reset at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          from extensions.pg_stat_statements_info i) as desde,
       q.*
  from (select pg_catalog.left(s.query, 160)          as consulta,
               s.calls                                 as llamadas,
               round(s.total_exec_time)::bigint        as total_ms,
               round(s.mean_exec_time::numeric, 2)     as media_ms,
               s.rows                                  as filas,
               s.shared_blks_read                      as bloques_leidos_disco
          from extensions.pg_stat_statements s
         where s.userid <> (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
         order by s.total_exec_time desc
         limit 8) q;
```
  `pg_stat_statements` vive en el esquema `extensions` en Supabase (así lo lee KUADRA en vivo).
- **Umbral**: KUADRA no pone umbral (top 8 por tiempo total, informativo). [propuesto]: aviso si `media_ms > 500` y
  `llamadas > 50`; aviso si una sola consulta acumula > 50 % del `total_exec_time` global.
- **Acción**: el modelo recibe la consulta normalizada + `EXPLAIN` sugerido y propone índice o reescritura. Ojo: el texto
  puede contener literales en sentencias de utilidad: **redactar antes de enviarlo a Claude**.

#### DB-15 — Cache hit, rollbacks, deadlocks y temporales (KUADRA `crm_resumen` + propio)

```sql
select round(100.0 * sum(blks_hit) / nullif(sum(blks_hit) + sum(blks_read), 0), 2) as cache_hit_pct,
       sum(xact_commit)   as commits,
       sum(xact_rollback) as rollbacks,
       sum(deadlocks)     as deadlocks,
       sum(temp_bytes)    as temp_bytes,
       pg_catalog.pg_postmaster_start_time() as inicio_postmaster
  from pg_catalog.pg_stat_database
 where datname = pg_catalog.current_database();
```
  KUADRA suma todas las bases y solo trae `cache_hit_pct`, `commits` y `rollbacks`; `deadlocks`, `temp_bytes` y el filtro
  por base son nuestros.
- **Umbral** [propuesto; el 99 % es criterio común de la comunidad, no documentado por Supabase: no verificado]:
  cache hit **< 99 % aviso, < 95 % crítico**. Sobre deltas entre escaneos (los contadores son acumulados): rollbacks
  > 5 % de las transacciones → aviso; cualquier deadlock nuevo → aviso; `temp_bytes` > 1 GB/h → aviso (`work_mem` corto
  u ordenaciones sin índice).
- **Acción**: cache bajo → revisar DB-12/DB-14 o subir de compute; prompt con la tabla de compute (§3.4, DB-18).

#### DB-16 — Consultas largas e `idle in transaction` (propio)

```sql
select a.pid, a.usename, a.application_name, a.state, a.wait_event_type, a.wait_event,
       pg_catalog.now() - a.xact_start  as en_transaccion,
       pg_catalog.now() - a.query_start as duracion,
       pg_catalog.left(a.query, 200)    as consulta
  from pg_catalog.pg_stat_activity a
 where a.datname = pg_catalog.current_database() and a.backend_type = 'client backend'
   and a.pid <> pg_catalog.pg_backend_pid() and a.state <> 'idle'
   and (a.query_start < pg_catalog.now() - interval '5 minutes'
        or (a.state like 'idle in transaction%' and a.state_change < pg_catalog.now() - interval '2 minutes'))
 order by a.query_start;
```
- **Umbral** [propuesto]: activa > 5 min aviso, > 30 min **crítico**; `idle in transaction` > 2 min aviso, > 10 min
  crítico (retiene locks y frena vacuum).
- **Acción** (solo humano): `select pg_catalog.pg_cancel_backend(<pid>);` y, si no cede,
  `select pg_catalog.pg_terminate_backend(<pid>);`. Preventivo: `alter role <rol> set idle_in_transaction_session_timeout = '60s';`.

#### DB-17 — Bloqueos (propio)

```sql
select a.pid as bloqueado, pg_catalog.pg_blocking_pids(a.pid) as bloqueadores,
       a.wait_event_type, pg_catalog.now() - a.query_start as esperando,
       pg_catalog.left(a.query, 200) as consulta
  from pg_catalog.pg_stat_activity a
 where pg_catalog.cardinality(pg_catalog.pg_blocking_pids(a.pid)) > 0;
```
- **Umbral** [propuesto]: espera > 30 s aviso; > 2 min o > 5 sesiones bloqueadas **crítico**.
- **Acción**: identificar al bloqueador raíz (el que no está bloqueado por nadie) → DB-16.

#### DB-18 — Conexiones frente a `max_connections` (KUADRA `crm_resumen`)

```sql
select count(*)                                                as total,
       count(*) filter (where state = 'active')                as activas,
       count(*) filter (where state = 'idle')                  as inactivas,
       count(*) filter (where state like 'idle in transaction%') as idle_tx,
       pg_catalog.current_setting('max_connections')::int      as max_conexiones,
       pg_catalog.current_setting('superuser_reserved_connections')::int as reservadas
  from pg_catalog.pg_stat_activity
 where datname = pg_catalog.current_database();
```
  (KUADRA devuelve `conexiones` como objeto `{estado: n}`; aquí van en columnas.)
- **Umbral** [propuesto, reutilizando la regla 80/95 de KUADRA]: `total / max_conexiones` **≥ 80 % aviso, ≥ 95 %
  crítico**. Referencia de máximos por compute: Nano/Micro 60 conexiones directas y 200 clientes de pooler, Small 90/400,
  Medium 120/600, Large 160/800, XL 240/1.000 [verificado: https://supabase.com/docs/guides/platform/compute-and-disk].
- **Acción**: usar el pooler en modo transacción, bajar el tamaño de pool de la app, cerrar `idle`; si es carga real,
  subir de compute. Es la alerta candidata para la demo en vivo (fácil de provocar abriendo conexiones).

#### DB-19 — Conexiones por rol y aplicación (KUADRA, agrupado)

```sql
select usename, application_name, state, count(*) as n
  from pg_catalog.pg_stat_activity
 where datname = pg_catalog.current_database()
 group by 1, 2, 3
 order by n desc;
```
- **Umbral**: info. Sirve para explicar DB-18 («el 70 % son de `postgrest`» / «de una app sin pool»).

### 3.5 Tareas programadas, retención y riesgos de disco

#### DB-20 — Crones `pg_cron` fallando (KUADRA `crm_resumen`)

```sql
select j.jobname as nombre, j.schedule as horario, j.active as activo,
       d.start_time as ultima_corrida, d.status as ultimo_estado,
       round(extract(epoch from d.end_time - d.start_time) * 1000)::bigint as ultima_duracion_ms,
       f.n as fallos_24h
  from cron.job j
  left join lateral (select x.start_time, x.end_time, x.status from cron.job_run_details x
                      where x.jobid = j.jobid order by x.start_time desc limit 1) d on true
  left join lateral (select count(*) as n from cron.job_run_details x
                      where x.jobid = j.jobid and x.status <> 'succeeded'
                        and x.start_time > pg_catalog.now() - interval '24 hours') f on true
 order by f.n desc, j.jobname;
```
  **Bug encontrado en KUADRA**: usa `extract(milliseconds from end_time - start_time)`, que sobre un `interval` solo toma
  el campo de segundos (un trabajo de 1 min 2,5 s da 2.500 ms). Aquí se usa `epoch`.
- **Umbral** [propuesto]: aviso si `fallos_24h > 0` o si un trabajo activo tiene `ultimo_estado = 'failed'`.
- **Acción**: prompt con el `command` del trabajo y el `return_message` del último fallo (`cron.job_run_details`).

#### DB-21 — Peticiones HTTP salientes fallidas de `pg_net` (KUADRA `crm_resumen`)

```sql
select count(*) filter (where (status_code >= 400 or error_msg is not null)
                          and created > pg_catalog.now() - interval '24 hours') as fallidas_24h,
       count(*) as filas,
       pg_catalog.pg_total_relation_size('net._http_response'::regclass) as bytes
  from net._http_response;
```
  (KUADRA solo trae `fallidas_24h`; `filas` y `bytes` son nuestros, porque la tabla también crece.)
- **Umbral** [propuesto]: info si > 0; aviso si > 50 en 24 h (webhooks o edge functions caídas).
- **Acción**: revisar destino/secretos de los webhooks. Retención propia de `pg_net` [no verificado].

#### DB-22 — Tablas de log/auditoría que crecen sin retención (generalización de «Purgable» de KUADRA)

- **En KUADRA**: `plataforma.auditoria_tablas()` declara por tabla su retención (ej. `crm_auditoria` 90 días,
  `auditoria` 12 meses, `eventos_seguridad` 90 días, `cron.job_run_details`: éxitos de < 30 s a la hora, el resto 90 días,
  conservando siempre la última corrida y el último éxito de cada trabajo) y su cron de purga. «Purgable» = clases con
  filas fuera de retención **que ningún cron activo purga** (`not exists (select 1 from cron.job j where j.active and
  j.jobname = a.purga_cron)`), rol `cola` (info). El check «Auditoría etiquetada» cuenta tablas marcadas como auditoría
  sin retención ni cron.
- **Nosotros** no conocemos el esquema del cliente: heurística por nombre + tamaño + existencia de un cron que la mencione.
```sql
select n.nspname as esquema, c.relname as tabla,
       pg_catalog.pg_total_relation_size(c.oid) as bytes,
       greatest(c.reltuples, 0)::bigint as filas_est,
       exists (select 1 from cron.job j
                where j.active and j.command ilike '%' || c.relname || '%') as tiene_cron_de_purga
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p')
   and (c.relname ~* '(log|audit|auditoria|event|evento|historial|history|trace|traza|bitacora|webhook|notific)'
        or (n.nspname, c.relname) in (('cron', 'job_run_details'), ('net', '_http_response'), ('auth', 'audit_log_entries')))
   and pg_catalog.pg_total_relation_size(c.oid) >= 52428800
 order by bytes desc;
```
  Si la sonda dice que `cron.job` no es legible, se quita la columna `tiene_cron_de_purga` (si no, la consulta entera
  falla al analizarse).
- **Umbral** [propuesto]: aviso si `bytes ≥ 50 MB` y `tiene_cron_de_purga = false`; sube a aviso fuerte si además DB-01
  está ≥ 80 %.
- **Acción**: prompt con el patrón de purga de KUADRA (`_auditoria_borrar`), que respeta lo que se conserva y no bloquea:
```sql
-- repetir mientras borre filas (KUADRA: lote 1..50.000, por defecto 20.000 para caber en los 8 s de PostgREST)
delete from "esquema"."tabla" t
 where (t.tableoid, t.ctid) in (select t.tableoid, t.ctid from "esquema"."tabla" t
                                 where t.created_at < pg_catalog.now() - interval '90 days'
                                 limit 20000);
VACUUM (ANALYZE) "esquema"."tabla";   -- un DELETE no devuelve disco: KUADRA ofrece «Limpiar» justo después
select cron.schedule('purga-tabla', '36 4 * * *',
  $$ delete from "esquema"."tabla" where created_at < now() - interval '90 days' $$);
```
  Reglas de KUADRA a heredar en el prompt: **nunca `TRUNCATE`** (se salta filas a conservar y los `ON DELETE SET
  NULL`); vista previa por defecto (`p_simular = true`, cuenta filas y bytes con `pg_column_size(t.*)`); cerrojo
  consultivo `pg_try_advisory_xact_lock(hashtext('kuadra:base_borrar'))` → «ocupado»; conservar «lo anormal» (filas de
  error, eventos sin revisar); confirmación fuerte (teclear el nombre exacto de la tabla o la ref del proyecto); ofrecer
  backup antes.

#### DB-23 — Edad de transacciones / wraparound (propio)

```sql
select d.datname, pg_catalog.age(d.datfrozenxid) as edad_xid,
       pg_catalog.current_setting('autovacuum_freeze_max_age')::bigint as freeze_max_age
  from pg_catalog.pg_database d
 order by 2 desc;

select n.nspname as esquema, c.relname as tabla, pg_catalog.age(c.relfrozenxid) as edad_xid
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'm', 't')
 order by 3 desc
 limit 10;
```
- **Umbral** [propuesto; límite duro de Postgres ≈ 2.100 millones, no verificado en este informe]: aviso si
  `edad_xid > 1,5 × freeze_max_age`; **crítico si > 1.200.000.000**.
- **Acción**: `VACUUM (FREEZE, ANALYZE) "esquema"."tabla";` sobre las 10 más viejas; revisar DB-07 y DB-16 (transacciones
  abiertas impiden congelar).

#### DB-24 — Slots de replicación inactivos que retienen WAL (propio)

```sql
select slot_name, slot_type, active,
       pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_lsn(), restart_lsn)::bigint as wal_retenido_bytes
  from pg_catalog.pg_replication_slots;
```
- **Umbral** [propuesto]: inactivo y > 256 MB aviso; inactivo y > 1 GB **crítico** (llena el disco aunque la base no
  crezca). Supabase lo considera digno de comando propio (`inspect db replication-slots`) [verificado:
  https://supabase.com/docs/guides/database/inspect]. Legibilidad de la vista por `supabase_read_only_user` [no verificado].
- **Acción**: identificar el consumidor (Realtime, réplica, conector externo) antes de
  `select pg_catalog.pg_drop_replication_slot('<slot>');`. Nunca automático.

#### DB-25 — FK `NOT VALID` con huérfanas (KUADRA inventario, `_sqlFkNotValid`)

```sql
select cn.nspname || '.' || cc.relname as tabla, k.conname as fk, rn.nspname || '.' || rc.relname as hacia
  from pg_catalog.pg_constraint k
  join pg_catalog.pg_class cc     on cc.oid = k.conrelid
  join pg_catalog.pg_namespace cn on cn.oid = cc.relnamespace
  join pg_catalog.pg_class rc     on rc.oid = k.confrelid
  join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
 where k.contype = 'f' and not k.convalidated;
```
- **Truco de KUADRA reutilizable en todo el catálogo**: contar con SQL dinámico **dentro de un solo SELECT** (sin
  PL/pgSQL, válido en el endpoint de solo lectura) con `query_to_xml`:
  `(xpath('/row/c/text()', query_to_xml(format('select count(*) c from %I.%I x where x.%I is not null and not exists (select 1 from %I.%I t where t.%I = x.%I)', ...), false, true, '')))[1]::text::bigint`.
  Coste: un `count(*)` real por FK: solo bajo demanda, nunca en el escaneo periódico.
- **Umbral**: info (huérfanas > 0 → aviso). **Acción**: limpiar huérfanas y `ALTER TABLE ... VALIDATE CONSTRAINT <fk>;`.

#### DB-26 — Tablas críticas y calientes: guarda para las correcciones (KUADRA `_base_tablas_criticas`)

- **Qué hace KUADRA**: descubre sin listas (1) el «camino del guardia»: la función de `pgrst.db_pre_request` del rol
  `authenticator` y, recursivamente sobre `prosrc`, todas las funciones y tablas que toca; (2) tablas «calientes»: las que
  escribe una función de disparador activo no interno. Sobre ellas **nunca** `VACUUM FULL` (decisión d6).
- **SQL portable** (C1), raíz del pre-request y tablas calientes por disparador (regex escapada como en KUADRA):
```sql
select x.v as pre_request
  from pg_catalog.pg_db_role_setting s
 cross join lateral pg_catalog.unnest(s.setconfig) as x(v)
 where s.setrole = (select r.oid from pg_catalog.pg_roles r where r.rolname = 'authenticator')
   and x.v like 'pgrst.db\_pre\_request=%';

with de_disparador as materialized (
  select distinct pg_catalog.lower(p.prosrc) as src
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
   where not t.tgisinternal and t.tgenabled <> 'D'
)
select n.nspname as esquema, c.relname as tabla
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p')
   and exists (select 1 from de_disparador d
                where pg_catalog.strpos(d.src, pg_catalog.lower(c.relname)) > 0
                  and d.src ~ ('(insert\s+into|update|delete\s+from)\s+'
                               || pg_catalog.regexp_replace(pg_catalog.lower(n.nspname), '([^a-z0-9_])', '\\\1', 'g') || '\.'
                               || pg_catalog.regexp_replace(pg_catalog.lower(c.relname), '([^a-z0-9_])', '\\\1', 'g') || '\M'));
```
  Complemento nuestro: «caliente por actividad» = top 20 por delta de `n_tup_ins + n_tup_upd + n_tup_del` entre escaneos.
- **Uso**: no genera alerta. Marca hallazgos de DB-05 para que el prompt ofrezca `REINDEX CONCURRENTLY` o `pg_repack`
  [no verificado disponibilidad en Supabase] en vez de `VACUUM FULL`.

### 3.6 Seguridad de la base (lo que sale de este módulo; el detalle de RLS es de otra investigación)

Preferir los lints oficiales (C2): `0013_rls_disabled_in_public` (ERROR), `0024_permissive_rls_policy` (WARN),
`0028/0029_*_security_definer_function_executable` (WARN), `0011_function_search_path_mutable` (WARN)
[verificado: https://supabase.com/docs/guides/database/database-advisors]. Fallback SQL propio (C1):

**SEC-01 — RLS apagada en tablas a las que llegan `anon`/`authenticated`** → crítico si `anon`, aviso si solo
`authenticated`.
```sql
select n.nspname as esquema, c.relname as tabla,
       pg_catalog.has_table_privilege('anon', c.oid, 'SELECT')                        as anon_lee,
       pg_catalog.has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE')          as anon_escribe,
       pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as auth_accede
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p') and not c.relrowsecurity and n.nspname not in ($EXCL)
   and pg_catalog.has_schema_privilege('anon', n.oid, 'USAGE')
   and (pg_catalog.has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
        or pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'));
```
  Acción: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` **junto con** las políticas (sin políticas, la app deja de leer:
  el prompt debe generarlas).

**SEC-02 — Políticas abiertas** (consulta de inventario de KUADRA `_sqlPoliticasFilas`, con filtro nuestro): crítico si
`USING (true)`/`WITH CHECK (true)` para `public`/`anon` en escritura.
```sql
select n.nspname as esq, c.relname as tabla, p.polname,
       case when p.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end as permisiva,
       case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
                     when 'd' then 'DELETE' else 'ALL' end as orden,
       case when p.polroles = '{0}'::oid[] then 'public'
            else (select pg_catalog.string_agg(r.rolname, ',' order by r.rolname)
                    from pg_catalog.pg_roles r where r.oid = any (p.polroles)) end as roles,
       pg_catalog.pg_get_expr(p.polqual, p.polrelid)      as qual,
       pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) as chk
  from pg_catalog.pg_policy p
  join pg_catalog.pg_class c     on c.oid = p.polrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where not exists (select 1 from pg_catalog.pg_depend d
                    where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e');
```
  KUADRA además calcula una huella `md5` por política (con marcas `R:`/`U:`/`C:` para que un `NULL` no colisione) y una
  global: útil para **detectar cambios de políticas entre escaneos** (alerta «alguien cambió la RLS»).

**SEC-03 — SECURITY DEFINER ejecutable sin sesión / `search_path` mutable** → aviso.
```sql
select p.oid::regprocedure::text as funcion,
       pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
       not exists (select 1 from pg_catalog.unnest(coalesce(p.proconfig, '{}'::text[])) o(opt)
                    where o.opt like 'search_path=%')                         as search_path_mutable
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where p.prosecdef and n.nspname not in ($EXCL);
```
  Acción (práctica de KUADRA en cada función): `set search_path = ''` + `revoke all on function ... from public, anon,
  authenticated;` + `grant execute ... to <rol que la necesita>;`.

Fuera de alcance de este módulo: «funciones sin freno de tasa» (módulo `freno` de KUADRA, otra investigación) y uso de
CPU/RAM (C3, §6).

Rutas de la Management API que el cliente de KUADRA ya usa con su token de lectura y que sirven aquí
(`nucleo/supabase_gestion_api.dart`, mapa `permisoPorRuta`; etiquetas de permiso de KUADRA, no de la doc):
`GET /v1/projects/{ref}/postgrest` («Data API Config R»: qué esquemas expone la API, para afinar SEC-01),
`/config/database/postgres` («Database Config R»), `/config/database/pooler` («Connection Pooling R»),
`/network-restrictions`, `/ssl-enforcement`.

---

## 4. Implementación portable a TypeScript (backend Node)

### 4.1 Cliente del endpoint de solo lectura

```ts
// back/src/salud-bd/sql.ts
const API = 'https://api.supabase.com/v1';

export class ErrorChequeo extends Error {
  constructor(public codigo: 'sin_permiso' | 'rate_limit' | 'plazo' | 'forma' | `http_${number}`,
              public reintentarEn?: number) { super(codigo); }
}

export async function sqlSoloLectura<T = Record<string, unknown>>(
  ref: string, pat: string, query: string, plazoMs = 15_000,
): Promise<T[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), plazoMs);
  try {
    const r = await fetch(`${API}/projects/${ref}/database/query/read-only`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: ctl.signal,
    });
    if (r.status === 429) throw new ErrorChequeo('rate_limit', Number(r.headers.get('X-RateLimit-Reset')) || undefined);
    if (r.status === 401 || r.status === 403) throw new ErrorChequeo('sin_permiso');
    if (!r.ok) throw new ErrorChequeo(`http_${r.status}`);   // nunca propagar el cuerpo: puede traer datos del cliente
    const cuerpo: unknown = await r.json();
    if (!Array.isArray(cuerpo)) throw new ErrorChequeo('forma'); // [no verificado] se espera array de filas
    return cuerpo as T[];
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ErrorChequeo('plazo');
    throw e;
  } finally { clearTimeout(t); }
}
```

### 4.2 Tipos del catálogo y del hallazgo (forma §1.2 de KUADRA simplificada)

```ts
export type Severidad = 'critico' | 'aviso' | 'info';                // KUADRA: mal | aviso | cola
export type Requisito = 'pg_stat_statements' | 'cron_legible' | 'net_legible' | 'read_all_stats';

export interface Sonda {
  version_num: number; max_connections: number; read_all_stats: boolean; pg_stat_statements: boolean;
  pg_cron: boolean; pg_net: boolean; cron_legible: boolean; net_legible: boolean; stats_reset: string | null;
}
export interface Contexto {
  ref: string; limiteBytes: number | null; sonda: Sonda;
  calientes: Set<string>;                 // DB-26: 'esquema.tabla'
  fotoAnterior?: Map<string, number>;     // DB-03: 'esquema.tabla' -> total_bytes
}
export interface Hallazgo {
  clave: string;                 // 'base_datos:hinchada:public.eventos' -> deduplica alertas entre escaneos
  chequeo: string;               // 'DB-05'
  severidad: Severidad;
  objeto: string;                // 'public.eventos'
  etiqueta: string;              // 'Tabla hinchada'
  sub: string;                   // '179 MB · índices 64 MB · datos 115 MB'
  dato: Record<string, unknown>; // cifras crudas: van al panel y al prompt de corrección
  correccionSql?: string;        // SOLO texto para copiar; el backend nunca lo ejecuta
  riesgo?: string;               // 'Bloquea la tabla mientras dura'
}
export interface Chequeo {
  id: string; requiere: Requisito[]; sql: string;
  evaluar(filas: Record<string, any>[], ctx: Contexto): Hallazgo[];
}
```

### 4.3 Dos chequeos completos como molde

```ts
const DIEZ_MB = 10 * 1024 * 1024;                       // KUADRA umbralHinchada
const mb = (b: number) => `${Math.round(b / 1048576)} MB`;
const ident = (e: string, t: string) => `"${e.replaceAll('"', '""')}"."${t.replaceAll('"', '""')}"`;
const GUARDA = "SET lock_timeout = '3s';\nSET statement_timeout = '15min';\n";   // KUADRA ordenMantenimiento

export const DB01: Chequeo = {
  id: 'DB-01', requiere: [], sql: SQL_DB01,
  evaluar([f], ctx) {
    if (!ctx.limiteBytes) return [];
    const bytes = Number(f.todas_bytes);                 // bigint puede llegar como string [no verificado]
    const pct = Math.round((100 * bytes) / ctx.limiteBytes);
    if (pct < 80) return [];
    return [{ clave: 'base_datos:base_limite:base', chequeo: 'DB-01', severidad: pct >= 95 ? 'critico' : 'aviso',
              objeto: 'Base', etiqueta: 'Cerca del límite', sub: `${mb(bytes)} de ${mb(ctx.limiteBytes)} · ${pct} %`,
              dato: { bytes, limite: ctx.limiteBytes, pct } }];
  },
};

export const DB05: Chequeo = {
  id: 'DB-05', requiere: [], sql: SQL_DB02,               // reutiliza la consulta de tablas pesadas
  evaluar(filas, ctx) {
    return filas.filter((f) => Number(f.rec_compactar) >= DIEZ_MB).map((f) => {
      const rec = Number(f.rec_compactar), recIdx = Number(f.rec_reindexar);
      const soloIndices = recIdx * 2 >= rec;              // KUADRA: «Índices hinchados» vs «Tabla hinchada»
      const caliente = ctx.calientes.has(`${f.esquema}.${f.nombre}`);
      const id = ident(f.esquema, f.nombre);
      return {
        clave: `base_datos:hinchada:${f.esquema}.${f.nombre}`, chequeo: 'DB-05', severidad: 'aviso',
        objeto: `${f.esquema}.${f.nombre}`, etiqueta: soloIndices ? 'Índices hinchados' : 'Tabla hinchada',
        sub: `${mb(Number(f.total))} · índices ${mb(Number(f.indices))} · datos ${mb(Number(f.datos))}`,
        dato: { recuperable: rec, recuperable_indices: recIdx, muertas: Number(f.muertas), caliente },
        correccionSql: GUARDA + (soloIndices || caliente ? `REINDEX TABLE CONCURRENTLY ${id};`
                                                         : `VACUUM (FULL, ANALYZE) ${id};`),
        riesgo: soloIndices || caliente ? 'Sin bloqueo largo; usa disco extra temporal'
                                        : 'Bloquea lecturas y escrituras de la tabla mientras dura',
      };
    });
  },
};
```

### 4.4 Agrupar en pocas peticiones

Sin PL/pgSQL no hay `exception when others` por sección: una subconsulta que falle tumba la petición entera. Por eso se
agrupa por **riesgo de fallo**, envolviendo cada chequeo en
`'<id>', (select coalesce(pg_catalog.jsonb_agg(x), '[]'::jsonb) from (<sql>) x)` dentro de un `jsonb_build_object`:

| Petición | Contenido | Puede fallar por | Frecuencia propuesta |
|---|---|---|---|
| P1 | Sonda §2.1 | — | cada escaneo |
| P2 «catálogo» | DB-01, 02 (+04, 05, 08), 07, 09, 10, 11, 13, 23, 25 (lista), 26, SEC-01..03 | casi nada (solo catálogo) | cada 15 min |
| P3 «actividad» | DB-15, 16, 17, 18, 19 | nada | **cada 60 s** (modo vivo: alertas de llamada) |
| P4 «estadística» | DB-06, 12, 14 | falta `pg_stat_statements` (se saca DB-14) | cada 15 min |
| P5 «cron/net» | DB-20, 21, 22 | esquema `cron`/`net` no legible (se omite) | cada 15 min |
| P6, P7 | `advisors/performance`, `advisors/security` | permiso `advisors_read` | cada 60 min y al pulsar «Auditar» |

Carga: P3 cada minuto = 60 peticiones/h a un endpoint con límite de 120/min por proyecto: margen enorme. Un escaneo
completo son 7 peticiones. Coste en tokens de Claude de todo lo anterior: **cero**; el modelo solo entra cuando aparece
una `clave` nueva o empeora su severidad, para redactar explicación + prompt de corrección (precios y modelo: ver R12).

Histéresis [propuesta]: para crítico por umbral (DB-15, DB-18) exigir 2 lecturas seguidas por encima, y dar por resuelto
solo al bajar 5 puntos por debajo; así no se llama por teléfono por un pico de un minuto.

---

## 5. Guion de demo: cómo provocar cada alerta en una base propia

| Alerta | Cómo provocarla (proyecto de demo, nunca uno real) | Tiempo |
|---|---|---|
| DB-18 conexiones ≥ 80 % | script `node` que abre ~50 conexiones `pg` contra el pooler en modo sesión (Nano: 60 máx.) | 1 min |
| DB-16 consulta larga | `select pg_sleep(900);` desde el SQL Editor | inmediato (> 5 min) |
| DB-17 bloqueo | sesión A: `begin; lock table demo.pedidos in access exclusive mode;` sesión B: `select * from demo.pedidos;` | 30 s |
| DB-05 + DB-07 hinchazón | `alter table demo.eventos set (autovacuum_enabled = false);` insertar 1 M filas y borrar el 60 % | 2-3 min |
| SEC-01 RLS apagada | `create table public.tarjetas(...)` sin `enable row level security` y con `grant select to anon` | inmediato |
| DB-22 log sin retención | tabla `public.logs_api` > 50 MB sin cron que la mencione | 2 min |

Con autovacuum activo, las tuplas muertas pueden desaparecer antes de la demo: por eso DB-05 va con DB-07.

---

## 6. Decisión abierta: CPU, RAM y disco del servidor

El encargo pide «uso actual del servidor (CPU, RAM, disco, conexiones)». Por SQL solo salen conexiones (DB-18) y tamaño
de base (DB-01). CPU/RAM/IO/disco del sistema de ficheros salen únicamente del endpoint Prometheus
`https://{ref}.supabase.co/customer/v1/privileged/metrics`, con Basic Auth `service_role:<sb_secret_…>`, raspado 1/min,
en beta y sin plan mínimo indicado [verificado: https://supabase.com/docs/guides/telemetry/metrics]. Opciones:

1. **Pedir además la clave secreta solo para métricas** (cifrada como el resto). Rompe la regla previa «no pedir
   service_role»: la clave secreta da acceso total a los datos vía API.
2. **No pedirla**: el módulo Supabase muestra conexiones, tamaño, caché, consultas largas y bloqueos (suficiente para la
   demo de «la base está saturada») y CPU/RAM quedan como «conecta métricas (opcional)».
3. Obtener la clave con el PAT por la Management API (la doc lo menciona para automatización) [no verificado: endpoint
   y permiso exactos]; mismo problema de privilegio que la opción 1.

Recomendación de esta investigación: **opción 2 para el MVP** y la opción 1 como interruptor explícito con aviso
claro al usuario. La alerta de «CPU alta» del encargo se puede demostrar con DB-16/DB-17/DB-18, que son la causa
habitual en Postgres.

---

## Implicaciones para el plan

**Adoptar**
- Credencial única del módulo: **PAT scoped** a UN proyecto con `database_read` + `advisors_read`; endpoint
  `database/query/read-only` + `advisors/*`. Ni contraseña de Postgres ni `service_role` (coherente con la decisión
  previa). Plan B documentado: rol `vigia_ro` con `pg_monitor` (§2.2).
- El **patrón de KUADRA «la regla decide, la UI pinta»**: cada chequeo = SQL + función `evaluar` determinista con umbral;
  hallazgos con `clave` estable para deduplicar alertas; `errores` por sección en vez de fallar entero.
- El núcleo portado de KUADRA, con sus umbrales: DB-01 (80/95 %), DB-02/04/05 (heurística de recuperable, 10 MB),
  DB-08, DB-14, DB-15, DB-18, DB-20, DB-21, DB-22 y la guarda de mantenimiento (`lock_timeout 3s`,
  `statement_timeout 15min`, una sentencia por ejecución, nunca `VACUUM FULL` en tablas calientes).
- Consumir los **30 lints oficiales** (advisors) y presentarlos con la misma forma de hallazgo: cubren índices sin uso,
  duplicados, FK sin índice, RLS y SECURITY DEFINER con mantenimiento de Supabase. Nuestro SQL añade lo que no cubren.
- Correcciones como **texto** (SQL + prompt para la IA del usuario), con el riesgo explícito (bloqueo, disco extra).
- La sonda de capacidades al inicio de cada escaneo (§2.1): nunca marcar «OK» lo que no se pudo leer.

**Evitar**
- Ejecutar `VACUUM`, `REINDEX`, `DROP INDEX`, purgas o `pg_terminate_backend` desde nuestro backend en el MVP (requeriría
  `database_write` y no está documentado si el endpoint envuelve la consulta en una transacción).
- Instalar funciones, vistas o crones en la base del cliente (KUADRA puede porque es su propia base; nosotros no).
- La consola SQL libre y el explorador de filas de KUADRA (`crm_sql`): leen datos del cliente, no los necesitamos y
  serían el primer hallazgo de unos jueces que revisan seguridad.
- Copiar el backup/restaurar de KUADRA (`categorias/tecnologia/base_datos`): días de trabajo, fuera del hackatón.
- Enviar a Claude texto crudo de `pg_stat_statements`/`pg_stat_activity` sin redactar literales.

**Riesgos**
- Endpoint de solo lectura en **beta** y con forma de respuesta no documentada → probarlo en la primera hora contra el
  proyecto de demo; si falla, plan B con el paquete `pg` y el rol `vigia_ro` (C4).
- Privilegios reales de `supabase_read_only_user` desconocidos (texto de consultas, esquemas `cron`/`net`, slots) →
  la sonda los degrada a «sin permiso».
- Falsos positivos de la heurística de hinchazón (claves anchas) y de «índice sin uso» tras un reinicio de estadística →
  cruzar con lint 0020 y exigir `stats_reset` ≥ 7 días.
- Nombres de permisos de PAT tomados de la doc de la API; las etiquetas del panel pueden diferir (KUADRA usa otras:
  «Database Config R»…) → la guía de conexión del usuario necesita capturas reales.
- La lista `$EXCL` de esquemas de plataforma no está verificada contra un proyecto real.

**Esfuerzo**

| Pieza | Esfuerzo |
|---|---|
| Cliente `sqlSoloLectura` + sonda + tipos + orquestador de peticiones P1-P7 | S |
| Núcleo KUADRA (DB-01, 02, 04, 05, 08, 15, 16, 17, 18) + probarlo en el proyecto de demo | M |
| Resto del catálogo (DB-06, 07, 09-13, 19-26, SEC-01..03): SQL ya escrito aquí, falta probar | M |
| Advisors (P6/P7) mapeados a hallazgos | S |
| Fotos y deltas en nuestra Supabase (DB-03, deltas de DB-15), histéresis y deduplicación por `clave` | M |
| Métricas Prometheus CPU/RAM (si se decide la opción 1 de §6): parseo del formato de texto | M |
| Ejecutar correcciones desde el producto (no recomendado en el hackatón) | L |
