# R04 · KUADRA: módulos Seguridad y Sesiones → catálogo de chequeos portable

Investigación R04, etapa 1 de 4 del plan maestro (team-22, Platanus Hack 26). Fuente: lectura completa, en solo lectura, de
`KUADRA CRM/kuadra_crm/lib/modulos/seguridad/*` y `lib/modulos/sesiones/*` (12 ficheros Dart). El Dart es una capa fina:
**los chequeos viven en SQL**, así que también se leyeron las migraciones que los definen en
`KUADRA MASTER/supabase/migrations/`:

| Fichero | Qué contiene |
|---|---|
| `20261018000419_crm_ola4_b_seguridad_invariantes.sql` | Tabla `plataforma.invariante` con 59 invariantes (SQL literal, esperado, crítico, tipo) |
| `20261018001506_crm_ola4_b_seguridad_modulo.sql` | `crm_seguridad_auditar` (motor), `crm_seguridad_estado` (lectura), «Ahora», cifras, checks |
| `20261018002957_crm_ola4_b_seguridad_sesiones.sql` | `crm_sesiones_estado`, umbrales de sesión, 5 escrituras con `p_simular` |
| `20260927004717_crm_ola2b_zd1_lecturas_panel.sql` / `20260927005024_crm_ola2b_ze_invariantes_registro.sql` | Registro de aceptados con huella y `crm_invariante_aceptar` |
| `20260825120000_eventos_seguridad_para_crm.sql` | Eventos de fuerza bruta y exceso por IP (barrido cada 5 min) |

Etiquetas: **[KUADRA]** = leído en el código (en producción en KUADRA). **[verificado: URL]** = comprobado hoy en la
documentación o en el OpenAPI oficial. **[no verificado]** = no comprobado. **[propuesta]** = idea nuestra, no está en KUADRA.

---

## 1. Cómo funciona en KUADRA (lo que hay que copiar de la arquitectura)

1. **Catálogo en datos, no en código.** Cada chequeo es una fila: `numero`, `nombre` corto (1-3 palabras), `nombre_largo`,
   `explicacion` (para humanos), `tipo` (`fijo` | `registro` | `cobertura` | `crones` | `dinero_ia`), `codigo` (`I2`…),
   `critico` (bool), `esperado` (int, línea base), `sql` (texto literal), `motivos` (jsonb slug→etiqueta), `retirado`. [KUADRA]
2. **Motor genérico.** `crm_seguridad_auditar(p_numeros int[])` recorre el catálogo y por cada fila ejecuta
   `execute format('select coalesce(json_agg(q), ''[]''::json) from (%s) q', sql)`, cuenta filas `n` y decide:
   - error de SQL → `sin_mirar` (con `sqlstate + sqlerrm` recortado a 500), **nunca verde**;
   - `n = esperado` → `bien`; si no → `desviado`; sin corrida aún → `sin_comprobar`.
   - Guarda hasta **200 objetos** por chequeo (`truncado = n > 200`) y el tiempo en ms. [KUADRA]
3. **Lectura y auditoría separadas.** La pantalla lee cada 30 s (solo con el módulo visible) una función STABLE que
   **nunca corre chequeos**; la auditoría se lanza al arrancar y con el botón «Correr N», **por tandas de ≤ 10** (para
   pintar «12 de 57» y no chocar con el plazo de la llamada). Si se pulsa mientras corre, se **encola una repetición**. [KUADRA]
4. **Dos clases de chequeo.**
   - `fijo`: cuenta filas contra un número esperado (casi siempre 0; a veces 1-3 por deuda conocida).
   - `registro`: compara el conjunto vivo con un **registro de aceptados** (`invariante_aceptado`: invariante, objeto,
     huella md5, motivo de 3-120 caracteres). Cada diferencia sale como `nuevo`, `cambio` (huella distinta) o
     `ya_no_aparece`. Así «una baja y un alta el mismo día» ya no se anulan, y aceptar un riesgo es explícito y queda
     firmado con motivo. [KUADRA]
5. **«Ahora» (bandeja de triaje).** Una fila por problema, con `clave` estable, `rol` (`mal` rojo / `aviso` ámbar /
   `cola` gris), orden fijo por grupo y sus acciones. El contador del módulo es `{rojo, aviso, cola}`. [KUADRA]
6. **Acciones dirigidas por el servidor.** La base devuelve cada acción entera:
   `{id, verbo, clase: inmediata|confirmar|navegar|barra, rpc, args, principal, motivo, motivo_defecto, simula, efecto, resultado, destino}`.
   El cliente solo pinta y comprueba que la RPC está en una lista blanca (`rpc_no_permitida`). [KUADRA]
7. **Simular antes de escribir.** Todas las escrituras llevan `p_simular boolean default true`; la simulación ejecuta el
   cambio y lo revierte lanzando `raise exception using errcode = 'KSIMU'` capturado en el mismo bloque, y devuelve el
   efecto («Afecta 1 · En uso 21:40»). [KUADRA]

**Adaptación a nuestro producto:** no podemos crear funciones ni tablas en la base del cliente (solo lectura). El
catálogo, el motor, el registro de aceptados y las corridas viven en **nuestro** Supabase; las consultas se ejecutan en
la base del cliente por la Management API con el endpoint de solo lectura (sección 2).

---

## 2. Vía de ejecución contra el Supabase del cliente (sin `service_role`)

| Necesidad | Endpoint exacto | Scope OAuth / permiso de PAT con alcance | Fuente |
|---|---|---|---|
| Correr SQL de catálogo | `POST https://api.supabase.com/v1/projects/{ref}/database/query/read-only` body `{"query": "...", "parameters": []}` | `database:read` / `database_read` | [verificado: https://supabase.com/docs/reference/api/v1-read-only-query] |
| Lints de Supabase (splinter) | `GET /v1/projects/{ref}/advisors/security?lint_type=...` y `/advisors/performance` | `database:read` | [verificado: https://api.supabase.com/api/v1-json] |
| Configuración de Auth | `GET /v1/projects/{ref}/config/auth` | `auth:read` | [verificado: https://api.supabase.com/api/v1-json] |
| Logs de Auth (fuerza bruta) | `GET /v1/projects/{ref}/analytics/endpoints/logs?sql=...&iso_timestamp_start=...&iso_timestamp_end=...` (ventana ≤ 24 h) | `analytics:read` | [verificado: https://api.supabase.com/api/v1-json] |
| Aplicar una corrección (opcional, con confirmación) | `POST /v1/projects/{ref}/database/query` body `{"query", "read_only": false}` / `PATCH /v1/projects/{ref}/config/auth` | `database:write` / `auth:write` | [verificado: https://api.supabase.com/api/v1-json] |

- El endpoint de solo lectura corre como `supabase_read_only_user`, está en **Beta** y exige nombres calificados con esquema
  («All entity references must be schema qualified») [verificado: https://supabase.com/docs/reference/api/v1-read-only-query].
  Qué puede leer exactamente ese rol en el esquema `auth` **no lo documenta Supabase** [no verificado]; si hereda
  `pg_read_all_data` también podría leer tablas de negocio con PII, así que **solo ejecutamos plantillas SQL de nuestra lista
  blanca** (nunca SQL generado por el modelo) y ninguna plantilla selecciona filas de tablas de negocio.
- Límite: **120 peticiones/minuto por usuario, por proyecto y por endpoint**; 429 el resto del minuto; logs de analytics más
  estrictos (30/min) [verificado: https://supabase.com/docs/reference/api/introduction].
- Credencial que pide la app: un **PAT con alcance** (proyecto concreto + permisos de lectura) o el flujo OAuth
  (`https://api.supabase.com/v1/oauth/authorize`). El PAT clásico («Legacy») tiene los privilegios de la cuenta entera: lo
  rechazamos en la guía [verificado: https://supabase.com/docs/reference/api/introduction].
- **No pedir `rest:read`**: `GET /v1/projects/{ref}/postgrest` devuelve `jwt_secret` en la respuesta
  [verificado: https://api.supabase.com/api/v1-json]. Los esquemas expuestos se leen por SQL (CTE `exp` de la sección 3).
- **Redactar `GET /config/auth` antes de guardar o mandar al modelo**: la respuesta trae campos secretos como `smtp_pass`,
  `external_*_secret`, `hook_*_secrets`, `security_captcha_secret`, `sms_twilio_auth_token`, `sms_vonage_api_secret`,
  `nimbus_oauth_client_secret` [verificado: https://api.supabase.com/api/v1-json]. Si vienen enmascarados o en claro
  [no verificado]: tratarlos como en claro y borrarlos al recibir.

### 2.1 Splinter ya cubre parte; KUADRA cubre lo que splinter no

Lints de seguridad de splinter (ficheros en `supabase/splinter/lints`): 0002 `auth_users_exposed`, 0007
`policy_exists_rls_disabled`, 0008 `rls_enabled_no_policy`, 0010 `security_definer_view`, 0011
`function_search_path_mutable`, 0013 `rls_disabled_in_public`, 0014 `extension_in_public`, 0015
`rls_references_user_metadata`, 0016-0019, 0023 `sensitive_columns_exposed`, 0024 `rls_policy_always_true`, 0025
`public_bucket_allows_listing`, 0026/0027 GraphQL, 0028 `anon_security_definer_function_executable`, 0029
`authenticated_security_definer_function_executable` [verificado: https://github.com/supabase/splinter/tree/main/lints y
https://supabase.com/docs/guides/database/database-advisors]. Además el enum del endpoint de advisors incluye lints de Auth y
plataforma: `auth_leaked_password_protection`, `auth_insufficient_mfa_options`, `auth_otp_long_expiry`,
`auth_otp_short_length`, `password_requirements_min_length`, `auth_password_policy_missing`, `ssl_not_enforced`,
`network_restrictions_not_set`, `pitr_not_enabled`, `leaked_service_key`, `vulnerable_postgres_version`
[verificado: https://api.supabase.com/api/v1-json]. **Ojo:** ese enum del OpenAPI **no** incluye 0023-0029; si la API ya los
devuelve [no verificado]. Por eso conviene correr también nuestros SQL equivalentes.

**Lo que KUADRA aporta y splinter no tiene:** IDOR en funciones SECURITY DEFINER (S17), funciones DEFINER con parámetro de
inquilino abiertas a anon (S18), funciones que escriben sin credencial (S09), privilegios por defecto que regalan a
PUBLIC (S12), canales Realtime abiertos a anon (S15), buckets públicos fuera de lista (S16), inventario de lo que solo
`service_role` alcanza (S20), sesiones dormidas/acumuladas/de usuarios bloqueados (A01-A04), el registro de aceptados con
huella y la regla «error = nunca verde».

---

## 3. Catálogo de chequeos de base de datos (portados y generalizados)

Escala nuestra: **CRÍTICA** (fuga o escalada directa) · **ALTA** · **MEDIA** · **BAJA** · **INFO**. En KUADRA
`critico=true` pinta rojo (`mal`) y `false` ámbar (`aviso`). Todas las consultas son de catálogo (`pg_catalog`), sin
filas de negocio. Generalización respecto a KUADRA: su lista fija de esquemas (`public, restaurantes, identidad…`) se
sustituye por los **esquemas expuestos por PostgREST** y por «esquemas de usuario» (todo lo que no es de sistema).

CTE común (pegar delante de cada consulta; viene de los invariantes 4, 35 y 54 de KUADRA, que caen a `public` si no
pueden leer el ajuste). Si `supabase_read_only_user` puede leer `pg_db_role_setting` [no verificado]; si no, queda `public`:

```sql
with exp as (
  select coalesce(
    (select string_to_array(replace(replace(split_part(o.opt, '=', 2), ' ', ''), '"', ''), ',')
       from pg_catalog.pg_db_role_setting r
       cross join lateral unnest(r.setconfig) o(opt)
      where r.setrole = (select x.oid from pg_catalog.pg_roles x where x.rolname = 'authenticator')
        and o.opt like 'pgrst.db\_schemas=%' limit 1),
    array['public', 'graphql_public']) as schs
), sist as (
  select array['pg_catalog','information_schema','auth','storage','realtime','vault','graphql','graphql_public',
               'extensions','pgsodium','pgsodium_masks','net','cron','supabase_migrations','supabase_functions',
               'pgbouncer','_realtime','_analytics','pgmq','pg_toast'] as schs
)
```

### Tabla resumen

| ID | Chequeo | KUADRA nº | Splinter | Esperado | Severidad |
|---|---|---|---|---|---|
| S01 | Funciones ejecutables por PUBLIC | 1 | (0028 parcial) | 0 | ALTA |
| S02 | Tabla alcanzable por anon/authenticated sin RLS efectiva | 3 | 0013 + 0008 | 0 | CRÍTICA |
| S03 | RLS apagada en tabla expuesta | 4 | 0013 | 0 | CRÍTICA |
| S04 | RLS activa sin ninguna política (registro) | 5 | 0008 | 0 nuevos | BAJA |
| S05 | Política «pase-todo» (`true`) para anon/PUBLIC | 6 | 0024 | 0 | ALTA |
| S06 | Política `true` en tabla con columna de inquilino | 7, 16 | — | 0 | CRÍTICA si hay grant; MEDIA si no |
| S07 | SECURITY DEFINER sin `search_path` fijo | 8 | 0011 | 0 | ALTA |
| S08 | Vista sin `security_invoker` alcanzable | 9 | 0010 | 0 | CRÍTICA |
| S09 | DEFINER ejecutable por anon que escribe (registro) | 10 | — | 0 nuevos | ALTA |
| S10 | Extensiones en `public` | 11 | 0014 | 0 | BAJA |
| S11 | Columnas con nombre de secreto legibles | 12 | 0023 | 0 | ALTA |
| S12 | Privilegios por defecto que regalan objetos futuros | 13 | — | ver nota | MEDIA/INFO |
| S13 | Tablas escribibles directamente por anon | 14 | — | 0 | ALTA |
| S14 | Roles con superusuario/BYPASSRLS nuevos | 15 (adaptado) | — | 0 | CRÍTICA |
| S15 | Políticas de `realtime.messages` que dejan leer a anon | 17 | — | 0 | MEDIA |
| S16 | Buckets públicos fuera de la lista aprobada | 21 | 0025 (listado) | 0 | MEDIA |
| S17 | DEFINER que recibe id de persona y no mira `auth.uid()` | 22 | — | 0 | CRÍTICA |
| S18 | DEFINER con parámetro de inquilino ejecutable por anon | 27 | — | 0 nuevos | ALTA |
| S19 | Hashes de contraseña en esquema expuesto | 25 | — | 0 | CRÍTICA |
| S20 | Inventario de lo que solo `service_role` alcanza (registro) | 2 | — | 0 nuevos | INFO |
| S21 | RPC expuestas: volátiles y estables (freno de tasa) | 28, 35, 54 | — | ver nota | MEDIA |
| S22 | Parámetros declarados que nadie usa (registro) | 19 | — | 0 nuevos | INFO |

Filtro común para no culpar al cliente de funciones de extensiones [propuesta, KUADRA no lo necesita porque controla su
base]: `and not exists (select 1 from pg_catalog.pg_depend d where d.objid = p.oid and d.deptype = 'e')`.

### S01 · Funciones SECURITY DEFINER ejecutables por PUBLIC o anon — ALTA
Origen KUADRA nº 1 (ahí: cualquier función con EXECUTE a PUBLIC, esperado 0, porque KUADRA cerró los privilegios por
defecto). En un Supabase típico **toda** función de `public` nace con EXECUTE a PUBLIC (default de Postgres), así que
filtramos a DEFINER, que es donde está el riesgo (salta RLS). Las INVOKER salen como INFO.
```sql
select n.nspname as esquema, p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as funcion,
       p.prosecdef as definer, pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace, sist
where n.nspname <> all (sist.schs) and p.prokind = 'f' and p.prosecdef
  and pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
  and not exists (select 1 from pg_catalog.pg_depend d where d.objid = p.oid and d.deptype = 'e')
order by 1, 2;
```
- Mensaje: «Esta función se salta la seguridad por filas y cualquiera en internet puede llamarla por `/rest/v1/rpc/` sin
  iniciar sesión. Si hace algo más que devolver datos públicos, es una puerta abierta.»
- Corrección: `revoke execute on function public.f(args) from public, anon; grant execute on function public.f(args) to authenticated;`
  y, para las futuras, `alter default privileges in schema public revoke execute on functions from public;` (KUADRA lo
  hizo el 2026-09-26 y lo vigila S12).

### S02 · Tabla alcanzable sin RLS efectiva — CRÍTICA
Origen nº 3. La fuga inmediata: grant a `anon`/`authenticated` en esquema expuesto y RLS apagada.
```sql
select n.nspname || '.' || c.relname as tabla,
       string_agg(distinct pg_catalog.pg_get_userbyid(a.grantee) || ':' || a.privilege_type, ' ') as grants
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace, exp,
     lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
where c.relkind in ('r', 'p') and n.nspname = any (exp.schs) and not c.relrowsecurity
  and pg_catalog.pg_get_userbyid(a.grantee) in ('anon', 'authenticated')
group by 1 order by 1;
```
- Mensaje: «Cualquiera con la clave pública de tu app (la que va en el navegador) puede leer y, según los permisos,
  modificar TODAS las filas de esta tabla.»
- Corrección: `alter table public.t enable row level security;` + política mínima
  `create policy "dueno_lee" on public.t for select to authenticated using ((select auth.uid()) = user_id);`
- Nota KUADRA: su nº 3 también cuenta «RLS activa con 0 políticas»; eso es denegar todo (seguro), por eso lo separamos en S04.

### S03 · RLS apagada en tabla expuesta o con grants — ALTA (CRÍTICA si coincide con S02)
Origen nº 4 (reescrito en KUADRA el 2026-09-26 para no contar tablas inalcanzables).
```sql
select n.nspname || '.' || c.relname as tabla,
       (n.nspname = any (exp.schs)) as expuesta,
       pg_catalog.has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as grant_anon,
       pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as grant_auth
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace, exp, sist
where c.relkind in ('r', 'p') and n.nspname <> all (sist.schs) and not c.relrowsecurity
  and (n.nspname = any (exp.schs)
       or pg_catalog.has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))
order by 1;
```
- Mensaje: «Esta tabla no tiene el candado por filas. Hoy quizá nadie llegue, pero está a un permiso de abrirse.»

### S04 · RLS activa sin políticas — BAJA (tipo registro)
Origen nº 5. `c.relrowsecurity and not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = c.oid)` en
esquemas de usuario. Es seguro (niega todo) pero «delata una intención a medias»; en KUADRA se convirtió en registro:
cada tabla se acepta con motivo y solo alertan las nuevas. Splinter 0008 (INFO).

### S05 · Política «pase-todo» para anon o PUBLIC — ALTA
Origen nº 6, esperado 1 en KUADRA (catálogo público aceptado). Splinter 0024.
```sql
select n.nspname || '.' || c.relname as tabla, pol.polname as politica, pol.polcmd::text as cmd,
       array_to_string(pol.polroles::regrole[], ',') as roles,
       coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') as using_expr,
       coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '') as check_expr
from pg_catalog.pg_policy pol
join pg_catalog.pg_class c on c.oid = pol.polrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace, sist
where n.nspname <> all (sist.schs) and pol.polpermissive
  and (pol.polroles = '{0}'::oid[] or 'anon'::regrole = any (pol.polroles))
  and (btrim(coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), ''), '() ') = 'true'
       or btrim(coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), ''), '() ') = 'true')
order by 1, 2;
```
- Severidad por `cmd`: `r` (SELECT) = MEDIA si la tabla es de catálogo público, ALTA en otro caso; `a`/`w`/`d`/`*`
  (INSERT/UPDATE/DELETE/ALL) = CRÍTICA.
- Lección de KUADRA (2026-08-29): comparar el texto exacto con `'true'` se quedó **ciego** cuando una migración añadió un
  guardián `AND (NOT plataforma.en_bloqueo_total())` a todas las políticas; el chequeo devolvía 0 y no era buena noticia.
  Normalizar la expresión (quitar paréntesis externos y guardias globales conocidos) antes de comparar.
- Corrección: sustituir `using (true)` por una condición (`(select auth.uid()) = user_id`) o restringir a `for select`.

### S06 · Política `true` en tabla multi-inquilino — CRÍTICA con grant, MEDIA sin grant
Origen nº 7 («aislamiento entre comercios») y nº 16 («bombas a un solo permiso»). KUADRA busca la columna `comercio_id`;
generalizamos a columnas de inquilino [propuesta]:
```sql
select n.nspname || '.' || c.relname as tabla, pol.polname, pol.polcmd::text as cmd,
       coalesce((select string_agg(distinct pg_catalog.pg_get_userbyid(a.grantee), ',')
                   from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                  where pg_catalog.pg_get_userbyid(a.grantee) in ('anon', 'authenticated')), 'SIN GRANT') as alcance
from pg_catalog.pg_policy pol
join pg_catalog.pg_class c on c.oid = pol.polrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace, sist
where n.nspname <> all (sist.schs) and pol.polpermissive
  and btrim(coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), ''), '() ') = 'true'
  and exists (select 1 from pg_catalog.pg_attribute at
               where at.attrelid = c.oid and at.attnum > 0 and not at.attisdropped
                 and at.attname in ('tenant_id','org_id','organization_id','team_id','workspace_id',
                                    'company_id','account_id','project_id','store_id','comercio_id'))
order by 1;
```
- Mensaje: «Esta tabla guarda datos de varios clientes tuyos y su regla deja ver los de todos a la vez: los datos de un
  cliente son visibles para su competencia.»

### S07 · SECURITY DEFINER sin `search_path` fijo — ALTA
Origen nº 8, esperado 0. Splinter 0011 (WARN, mira todas las funciones; aquí solo las DEFINER, que son las peligrosas).
```sql
select n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as funcion,
       p.proconfig::text as config
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace, sist
where p.prosecdef and n.nspname <> all (sist.schs)
  and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search\_path=%'))
  and not exists (select 1 from pg_catalog.pg_depend d where d.objid = p.oid and d.deptype = 'e')
order by 1;
```
- Mensaje: «Función con poderes de administrador a la que un atacante podría colarle código propio creando objetos con el
  mismo nombre en otro esquema (secuestro de search_path).»
- Corrección: `alter function public.f(args) set search_path = '';` y calificar todos los objetos dentro (`public.tabla`).

### S08 · Vista que puentea RLS y es alcanzable — CRÍTICA
Origen nº 9, esperado 0. Splinter 0010 / 0016.
```sql
select n.nspname || '.' || c.relname as vista, c.relkind::text as tipo,
       (select string_agg(distinct pg_catalog.pg_get_userbyid(a.grantee), ',')
          from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         where pg_catalog.pg_get_userbyid(a.grantee) in ('anon', 'authenticated')) as expuesta_a
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace, exp
where c.relkind in ('v', 'm') and n.nspname = any (exp.schs)
  and not coalesce((select true from unnest(c.reloptions) o
                     where o in ('security_invoker=true', 'security_invoker=on')), false)
  and exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
               where pg_catalog.pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
order by 1;
```
- Corrección: `alter view public.v set (security_invoker = true);` (PG ≥ 15). Las materializadas no admiten esa opción:
  `revoke select on public.mv from anon, authenticated;` o moverlas a un esquema no expuesto.

### S09 · DEFINER ejecutable por anon que escribe sin comprobar identidad — ALTA (registro)
Origen nº 10. KUADRA busca su validador de token del POS; generalizado a las funciones de identidad de Supabase:
```sql
select n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as funcion
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace, exp
where n.nspname = any (exp.schs) and p.prosecdef
  and pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
  and p.prosrc ~* '(insert\s+into|update\s+[a-z_."]+\s+set|delete\s+from)'
  and p.prosrc !~* '(auth\.uid\(\)|auth\.jwt\(\)|auth\.role\(\)|request\.jwt)'
order by 1;
```
- Heurística por regex (falsos positivos: formularios públicos legítimos como «registrar lead»). Por eso es **registro**:
  se aceptan con motivo y solo alerta una nueva. KUADRA tenía 3 aceptadas (login, logout, formulario de la landing).

### S11 · Columnas con nombre de secreto legibles por la app — ALTA
Origen nº 12 (esperado 1 en KUADRA por un falso positivo, `clave` = identificador público). Splinter 0023 parecido.
```sql
select n.nspname || '.' || c.relname || '.' || att.attname as columna, t.typname as tipo
from pg_catalog.pg_attribute att
join pg_catalog.pg_class c on c.oid = att.attrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_type t on t.oid = att.atttypid, exp
where c.relkind in ('r', 'p') and att.attnum > 0 and not att.attisdropped and n.nspname = any (exp.schs)
  and att.attname ~* '(token|password|passwd|contrasena|secret|secreto|hash|api_?key|credential|otp|^pin$|private_key|service_role)'
  and (pg_catalog.has_column_privilege('anon', c.oid, att.attnum, 'SELECT')
       or pg_catalog.has_column_privilege('authenticated', c.oid, att.attnum, 'SELECT'))
order by 1;
```
- Mensaje: «El nombre de esta columna sugiere un secreto y un usuario de tu app podría leerla (RLS decide qué filas, no
  qué columnas).» Corrección: `revoke select (col) on public.t from anon, authenticated;` o moverla a un esquema privado
  (KUADRA mudó los hashes del POS a `secretos`, esquema fuera de `pgrst.db_schemas`: «inalcanzable por construcción»).

### S13 · Escritura directa permitida a anon — ALTA si RLS apagada (ya es S02), MEDIA con RLS
Origen nº 14 (en KUADRA todo cambio pasa por funciones; queda 1 excepción aceptada).
`aclexplode(...)` con `grantee = anon` y `privilege_type in ('INSERT','UPDATE','DELETE')` en esquemas expuestos, con
número de políticas. Mensaje: «Visitantes sin sesión pueden escribir aquí; toda la protección depende de las reglas de
fila». `TRUNCATE` no pasa por RLS, pero PostgREST no lo expone [no verificado]: INFO.

### S15 · Canal en vivo abierto a anónimos — MEDIA
Origen nº 17 (esperado 2 en KUADRA, ambos del POS).
```sql
select pol.polname, pol.polcmd::text as cmd, array_to_string(pol.polroles::regrole[], ',') as roles,
       pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) as predicado
from pg_catalog.pg_policy pol
join pg_catalog.pg_class c on c.oid = pol.polrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'realtime' and c.relname = 'messages'
  and (pol.polroles = '{0}'::oid[] or 'anon'::regrole = any (pol.polroles))
order by 1;
```
- Mensaje: «Por este canal tu base puede empujar mensajes a clientes sin sesión. Que no crezca sin que alguien lo mire.»

### S16 · Buckets públicos fuera de la lista aprobada — MEDIA (registro)
Origen nº 21 (esperado 3: deuda conocida). `select id, public, created_at from storage.buckets where public` menos la
lista que el usuario apruebe en la primera conexión (cada bucket se acepta con motivo, p. ej. «logos públicos»).
- Corrección: `update storage.buckets set public = false where id = '...';` y servir con URL firmada.

### S17 · Función que se cree la identidad que le mandan (IDOR) — CRÍTICA
Origen nº 22. En KUADRA encontró `identidad.tiene_cedula_verificada` el 2026-08-29 y se demostró que cualquier comensal
podía preguntar por otro. **Es el chequeo más valioso y no existe en splinter.**
```sql
select n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as args
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace, sist
where p.prokind = 'f' and p.prosecdef and n.nspname <> all (sist.schs)
  and pg_catalog.pg_get_function_identity_arguments(p.oid)
      ~* '(user_id|usuario_id|profile_id|perfil_id|owner_id|member_id|customer_id|personal_id|invitado_id)'
  and pg_catalog.pg_get_functiondef(p.oid) !~* '(auth\.uid\(\)|auth\.jwt\(\))'
  and (pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE'))
order by 1, 2;
```
- Mejora sobre KUADRA: allí se miraba `information_schema.role_routine_grants`, que solo lista grants explícitos y no ve
  el EXECUTE heredado de PUBLIC; `has_function_privilege` sí.
- Mensaje: «La seguridad por filas te niega la fila de otro usuario, pero esta función te la contesta igual si le pasas
  su id.» Corrección: quitar el parámetro y usar `auth.uid()`, o
  `if p_user_id is distinct from auth.uid() then raise exception 'forbidden' using errcode = '42501'; end if;`

### S18 · DEFINER con parámetro de inquilino abierta a anon — ALTA (registro)
Origen nº 27. Igual que S17 pero con `~* '(tenant_id|org_id|team_id|workspace_id|company_id|account_id|comercio_id|topic|canal)'`,
sin `auth.uid()`/`auth.jwt()` en el cuerpo y `has_function_privilege('anon', p.oid, 'EXECUTE')`. Mensaje: «Sin iniciar
sesión se puede pedir a esta función datos de cualquier organización cambiando el id.»

### S19 · Hashes de contraseña en esquema expuesto — CRÍTICA
Origen nº 25 (tres formas de deshacer la protección): grant a `anon/authenticated/service_role` en el esquema privado,
columna `password_hash` en esquema expuesto, función que devuelve el hash. Generalizado:
```sql
select 'columna de contrasena en esquema expuesto' as motivo, c.table_schema || '.' || c.table_name || '.' || c.column_name as detalle
from information_schema.columns c, exp
where c.table_schema = any (exp.schs) and c.column_name ~* '^(password|passwd|password_hash|pass_hash|pwd_hash)$'
union all
select 'funcion que devuelve el hash', n.nspname || '.' || p.proname
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace, exp
where n.nspname = any (exp.schs) and p.prokind = 'f'
  and pg_catalog.pg_get_function_result(p.oid) !~* '^(boolean|void)$'
  and pg_catalog.pg_get_functiondef(p.oid) ~* 'returns?\s+(next\s+)?[a-z_.]*password_hash\M';
```
- Para apps que usan Supabase Auth, una tabla propia con contraseñas ya es mala señal: el mensaje lo dice.

### S21 · RPC expuestas y freno de tasa — MEDIA
Origen nº 28 (el gancho `pgrst.db_pre_request` sigue puesto y apunta al guardia), 35 (RPC volátiles sin techo) y 54
(STABLE/IMMUTABLE expuestas). Responde a «funciones sin freno de tasa» del encargo.
```sql
select 'sin_gancho' as motivo, coalesce(o.opt, 'pgrst.db_pre_request ausente') as detalle
from (select 1) z left join lateral (
  select o.opt from pg_catalog.pg_db_role_setting r cross join lateral unnest(r.setconfig) o(opt)
   where r.setrole = (select x.oid from pg_catalog.pg_roles x where x.rolname = 'authenticator')
     and o.opt like 'pgrst.db\_pre\_request=%' limit 1) o on true
where o.opt is null
union all
select case p.provolatile when 'v' then 'rpc_volatil' else 'rpc_estable' end,
       n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')'
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace, exp
where n.nspname = any (exp.schs) and n.nspname <> 'graphql_public' and p.prokind = 'f'
  and (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  and not exists (select 1 from pg_catalog.pg_depend d where d.objid = p.oid and d.deptype = 'e');
```
- Lectura: sin gancho, **todas** las RPC listadas carecen de freno en la base (el freno puede estar en el borde: cruzar con
  Cloudflare, R05). Con gancho, las `rpc_estable` siguen sin contarse: PostgREST las corre en transacción de solo lectura y
  un contador que escribe muere con `25006` (lección de KUADRA, nº 54).
- Corrección: regla de rate limit en Cloudflare para `/rest/v1/rpc/*` y, en la base, gancho `db_pre_request` con un
  contador por IP (`request.headers` → `cf-connecting-ip`) [propuesta, el diseño completo es de R-freno].

### Chequeos menores (una línea cada uno)

| ID | SQL núcleo | Severidad | Nota |
|---|---|---|---|
| S10 | `select e.extname from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid = e.extnamespace where n.nspname = 'public'` | BAJA | Corrección `alter extension x set schema extensions;` (algunas no se pueden mover) |
| S12 | `select coalesce(n.nspname,'(global)'), pg_get_userbyid(d.defaclrole), d.defaclobjtype, d.defaclacl::text from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace where d.defaclacl::text ~ '(^\{\|,)(anon\|authenticated)?='` | INFO; MEDIA si funciones a PUBLIC | En Supabase es el default que tablas nuevas de `public` nazcan con grant a anon/authenticated: explicar que **RLS es obligatoria al crear** |
| S14 | `select rolname from pg_catalog.pg_roles where (rolsuper or rolbypassrls) and rolname not like 'pg\_%'` | CRÍTICA si aparece uno nuevo | Registro: la primera corrida fija la base de roles de Supabase [propuesta; la lista por defecto no verificada] |
| S20 | Objetos con privilegios de `service_role` que anon/authenticated no tienen (nº 2, huella = md5 de privilegios) | INFO | Inventario de «razones para que exista la clave maestra»; útil en el informe exportable |
| S22 | Parámetros `p_%` de funciones plpgsql que no aparecen en `prosrc` (nº 19) | INFO | Calidad: suele delatar un filtro olvidado |

En la tabla, `\|` es el escape de Markdown: en el SQL real es `|`.

Fuera de alcance (específicos de KUADRA): 15 super_admin (adaptado en S14), 20 sesiones del POS sin huella, 23-24 comercio
apagado/sin filtro, 26 y 36-51 freno propio, 29-32 y 55-59 crones y auditoría propia.

---

## 4. Auth, sesiones y usuarios

### 4.1 Lo que hace el módulo Sesiones de KUADRA [KUADRA]
- Estados de sesión del personal: `activa` (uso < 24 h) · `reposo` (24 h-7 d) · `dormida` (≥ 7 d sin uso) · `huerfana`
  (persona o local desactivado). App (`auth.sessions`): `sin_perfil` (sin fila en la tabla de perfiles) · `en_mesa` ·
  `activa` (< 24 h) · `reposo` · `sin_volver` (≥ 30 d).
- «Ahora»: `huerfana` rojo (orden 10) · `app_sin_perfil` rojo (20) · `sin_huella` ámbar (30) · `acumula` ámbar (40, ≥ 3
  sesiones vivas de la misma persona en el mismo local) · `dormida` gris (50). Checks en cero al pie: Huérfanas, Sin huella,
  App sin perfil, Dormidas y **Bloqueo roto** (persona bloqueada cuya cuenta sigue activa; se muestra siempre).
- Acciones: «Cerrar» (`delete from auth.sessions where id = …` + `realtime.send(..., 'forzar_logout', ...)` para echar al
  cliente ya), «Cerrar N viejas» (conserva la de uso más reciente), «Cerrar todas» (masivo, con «Afecta N · En mesa M ·
  Pagando P»), «Bloquear» (`update auth.users set banned_until = 'infinity'` + borrar sus sesiones), «Desbloquear»
  (`banned_until = null`). Dormida = inmediata; el resto, confirmar con motivo (por defecto «Cerrada desde el CRM») y efecto.
- Privacidad: la lectura **nunca** devuelve correo, teléfono, cédula, IP ni user agent; el UA se reduce a «Android ·
  Chrome» con `_crm_sesiones_dispositivo(ua)` (regex de sistema y navegador). Una sola escritura a la vez («Otra en curso»).

### 4.2 Chequeos sobre el esquema `auth` (por el endpoint de solo lectura)
Columnas usadas por KUADRA en producción: `auth.sessions(id, user_id, created_at, updated_at, refreshed_at, user_agent)`
(`refreshed_at` es `timestamp` sin zona: KUADRA hace `refreshed_at at time zone 'UTC'`) y `auth.users(id, is_anonymous,
banned_until)` [KUADRA]. `email`, `email_confirmed_at`, `created_at` de `auth.users` y la tabla `auth.mfa_factors`
[no verificado]. Que `supabase_read_only_user` pueda leer `auth` [no verificado]: si no puede, estos chequeos salen
«Sin mirar» y la UI lo dice (nunca verde). Una sola consulta, **solo agregados e ids**:

```sql
with s as (select s.id, s.user_id,
                  greatest(s.updated_at, s.refreshed_at at time zone 'UTC', s.created_at) as uso
             from auth.sessions s)
select
  (select count(*) from s)                                                   as sesiones,
  (select count(*) from s where uso > now() - interval '24 hours')           as activas_24h,
  (select count(*) from s where uso <= now() - interval '7 days')            as dormidas_7d,
  (select count(*) from s join auth.users u on u.id = s.user_id
    where u.banned_until > now())                                            as bloqueo_roto,
  (select count(*) from (select user_id from s group by 1 having count(*) >= 5) x) as usuarios_acumulan,
  (select count(*) from auth.users u where u.is_anonymous)                   as anonimos,
  (select count(*) from auth.users u where u.is_anonymous
      and u.created_at > now() - interval '1 hour')                          as anonimos_1h,
  (select count(*) from auth.users u where u.email is not null and u.email_confirmed_at is null
      and u.created_at < now() - interval '7 days')                          as sin_confirmar_7d;
```

| ID | Chequeo | Umbral | Severidad | Mensaje humano | Corrección propuesta |
|---|---|---|---|---|---|
| A01 | Bloqueo roto: sesiones vivas de usuarios baneados | > 0 | MEDIA | «Bloqueaste a este usuario pero conserva sesiones; su token sigue valiendo hasta que caduque» | `delete from auth.sessions where user_id = '…';` (lo que hace KUADRA al bloquear) y bajar `jwt_exp` (B03) |
| A02 | Sesiones dormidas | uso ≥ 7 d (KUADRA) | BAJA; MEDIA si `sessions_inactivity_timeout` = 0 | «Sesiones abiertas que nadie usa hace una semana: si un aparato se perdió, sigue dentro» | activar caducidad por inactividad (B16) |
| A03 | Usuario acumula sesiones | ≥ 5 por usuario [propuesta; KUADRA usa 3 por persona y local en el POS] | BAJA | «Esta cuenta está abierta en muchos aparatos a la vez: cuenta compartida o robada» | `sessions_single_per_user` o cerrar las viejas |
| A04 | Sesión sin perfil | > 0 (si existe tabla de perfiles: `public.profiles` por convención, configurable) | MEDIA (rojo en KUADRA) | «Hay sesiones de usuarios que tu app no conoce: alta incompleta o cuenta creada por fuera» | revisar trigger de alta; cerrar sesión |
| A05 | Ráfaga de anónimos | `anonimos_1h` > `rate_limit_anonymous_users` × 0,8 [propuesta] | MEDIA | «Se crean cuentas anónimas al ritmo del límite: posible bot» | captcha (B13), bajar el límite |
| A06 | Correos sin confirmar viejos | > 0 con `mailer_autoconfirm` = false | INFO | «Altas que nunca confirmaron el correo» | purga periódica |

### 4.3 Configuración de Auth (`GET /v1/projects/{ref}/config/auth`)
Campos [verificado: https://api.supabase.com/api/v1-json]; umbrales: los marcados «lint» llevan el nombre del lint
oficial (nombre verificado, umbral exacto [no verificado]); el resto es [propuesta]. La corrección es el cuerpo de
`PATCH /v1/projects/{ref}/config/auth` (scope `auth:write`) o la ruta del panel; por defecto solo la proponemos.

| ID | Condición | Severidad | Mensaje humano | Corrección (`PATCH` body) |
|---|---|---|---|---|
| B01 | `refresh_token_rotation_enabled = false` | ALTA | «Un token de refresco robado sirve para siempre» | `{"refresh_token_rotation_enabled": true}` |
| B02 | `security_refresh_token_reuse_interval > 10` | MEDIA | «Ventana larga para reutilizar un refresco ya usado» | `{"security_refresh_token_reuse_interval": 10}` |
| B03 | `jwt_exp > 3600` | MEDIA | «Un token robado vale más de una hora y banear no lo corta» | `{"jwt_exp": 3600}` |
| B04 | `password_min_length < 8` (lint `password_requirements_min_length`) | MEDIA | «Se aceptan contraseñas cortas» | `{"password_min_length": 12}` |
| B05 | `password_required_characters` vacío (lint `auth_password_policy_missing`) | BAJA | «Sin reglas de composición» | valor del enum con minúsculas, mayúsculas y dígitos |
| B06 | `password_hibp_enabled = false` (lint `auth_leaked_password_protection`) | MEDIA | «Se aceptan contraseñas que ya circulan en filtraciones» | `{"password_hibp_enabled": true}` (plan requerido [no verificado]) |
| B07 | ningún `mfa_*_enroll_enabled` en true (lint `auth_insufficient_mfa_options`) | MEDIA | «Tus usuarios no pueden activar doble factor» | `{"mfa_totp_enroll_enabled": true, "mfa_totp_verify_enabled": true}` |
| B08 | `mailer_otp_exp > 3600` (lint `auth_otp_long_expiry`) | BAJA | «Los enlaces y códigos por correo valen demasiado tiempo» | `{"mailer_otp_exp": 3600}` |
| B09 | `mailer_otp_length < 6` (lint `auth_otp_short_length`) | BAJA | «Códigos adivinables» | `{"mailer_otp_length": 6}` |
| B10 | `mailer_autoconfirm = true` y `external_email_enabled = true` | MEDIA | «Cualquiera se registra con un correo ajeno sin probar que es suyo» | `{"mailer_autoconfirm": false}` |
| B11 | `sms_autoconfirm = true` | MEDIA | Igual, con teléfonos | `{"sms_autoconfirm": false}` |
| B12 | `sms_test_otp` no vacío y `sms_test_otp_valid_until` futuro | ALTA | «Hay un código SMS de prueba fijo activo en producción» | `{"sms_test_otp": ""}` |
| B13 | `disable_signup = false` y `security_captcha_enabled = false` | MEDIA | «Registro abierto sin captcha: bots y abuso de envíos» | `{"security_captcha_enabled": true, "security_captcha_provider": "turnstile"}` |
| B14 | `external_anonymous_users_enabled = true` (splinter 0012) | INFO; MEDIA con B13 | «Se permiten cuentas anónimas» | revisar políticas que usan `authenticated` sin mirar `is_anonymous` |
| B15 | `security_update_password_require_reauthentication = false` | BAJA | «Con una sesión robada se cambia la contraseña sin reautenticar» | `{"security_update_password_require_reauthentication": true}` |
| B16 | `sessions_timebox` y `sessions_inactivity_timeout` nulos o 0 | BAJA | «Las sesiones no caducan nunca» | `{"sessions_inactivity_timeout": 604800}` (7 d, umbral KUADRA; plan requerido [no verificado]) |
| B17 | `uri_allow_list` con comodín amplio (`*`, `**`) o `http://` que no sea localhost | MEDIA | «Un enlace mágico puede redirigir a un dominio ajeno y llevarse el token» | lista exacta de dominios `https://` |
| B18 | `site_url` empieza por `http://` (no localhost) | MEDIA | «Los correos de acceso apuntan a una web sin cifrar» | `https://…` |
| B19 | algún `hook_*_enabled = true` con `hook_*_uri` en `http://` | ALTA | «Un gancho de Auth viaja sin cifrar» | `https://` o `pg-functions://` |
| B20 | `rate_limit_email_sent`, `rate_limit_sms_sent`, `rate_limit_anonymous_users`, `rate_limit_verify`, `rate_limit_otp`, `rate_limit_token_refresh` | MEDIA si suben ×10 respecto a la foto anterior | «Alguien aflojó un freno de Auth» | volver al valor anterior (tipo registro con huella del valor) |

Lints de plataforma del mismo endpoint de advisors que conviene pintar en este módulo: `leaked_service_key` (CRÍTICA),
`ssl_not_enforced` (ALTA), `vulnerable_postgres_version` (ALTA), `network_restrictions_not_set` y `pitr_not_enabled` (INFO)
[nombres verificados: https://api.supabase.com/api/v1-json].

### 4.4 Fuerza bruta y cuentas con fallos (umbrales de KUADRA)
- Barrido cada 5 min (`*/5 * * * *`) que vuelca a `eventos_seguridad` agregando por (tipo, identificador, acción, **hora**)
  y quedándose con el **pico** (`greatest`), para que la purga de los contadores por minuto no encoja el dato. Retención 90 d.
- `rate_limit_ip`: ≥ **40** llamadas de una IP a una misma acción en una hora (`p_piso int default 40`, «un humano no genera
  40 llamadas a una acción de auth en una hora»). `fuerza_bruta_cuenta`: **≥ 10 fallos** o bloqueo puesto, últimas 3 h.
- «Con fallos» (ámbar): `fallos > 0` y último fallo en la última hora sin bloqueo. «Bloqueo por fallos» (rojo):
  `bloqueado_hasta > now()`. «IPs calientes»: topes + rechazos > 0 en la última hora, con identidad (`aws`, `local`,
  `aparato`, `comensal`, `sin_sesion`) que decide si es `bloqueable` (nunca se ofrece bloquear la IP de un local propio).
- Puerto genérico [propuesta]: mismos umbrales leyendo los logs de Auth por
  `GET /v1/projects/{ref}/analytics/endpoints/logs` (ventana ≤ 24 h, 30 peticiones/min). El nombre de la tabla de logs y
  los campos de «login fallido» [no verificado]: lo concreta la investigación de logs. Nada de esto requiere al modelo:
  lo decide el motor de reglas (decisión del equipo, parte 5).

---

## 5. Ideas de UX de estas pantallas que vale la pena copiar

1. **Una lectura que no audita + un botón grande «Auditar ahora (N)»** con progreso «12 de 57» por tandas; si se pulsa
   corriendo, se encola una repetición en vez de lanzar otra.
2. **Cuatro estados, y el error nunca es verde**: Bien · Desviado · Sin mirar (falló la consulta: muestra las 3 primeras
   palabras del error, «Copiar error» y «Reintentar») · Sin comprobar. KUADRA descubrió así que su chequeo de super_admin
   no había corrido nunca desde que se escribió (`42703`, columna inexistente) porque se pintaba igual que uno desviado.
3. **Problemas primero y desplegados; los sanos plegados en «Bien N ›»** por grupo. Cifras de arriba clicables que llevan
   al grupo. **«Checks en cero»** al pie: lista corta de lo que se comprobó y dio 0 (da confianza sin ruido).
4. **«Copiar SQL» en cada chequeo**: transparencia para jueces técnicos y para el módulo «conecta cualquier IA».
5. **Aceptar un riesgo con motivo (3-120 caracteres)** y huella: si el objeto cambia, vuelve a salir como «Cambió»;
   si desaparece, «Ya no está · Retirar». Las aceptaciones entran en una **barra de cambios** y se aplican en lote.
6. **Vista previa obligatoria** antes de cualquier acción que escriba: «Afecta 1 · En uso 21:40»; motivo con valor por
   defecto; resultado con hora («Cerrada · 21:41») hasta la siguiente lectura.
7. **Bandeja «Ahora»** con rojo/ámbar/gris, clave estable por fila y «Marcar visto»; el sector se abre solo cuando la firma
   de problemas cambia (no cuando solo se refresca).
8. **Saltos entre módulos con filtro y fila marcada** («Ver cuenta» de Seguridad abre Sesiones filtrado por esa persona).
9. **Historial 90 d** con vía (`crm:<funcion>`) e IP del operador; chapas «24 h N» y una por tipo.
10. **Errores en 1-3 palabras** (`traducirErrorSeguridad`: «Motivo: 3 a 120», «Ya no está», «Sin token»…), refresco cada 30 s
    solo con el módulo visible, una escritura a la vez, y la RPC de cada acción comprobada contra una lista blanca.
11. Adaptar a nuestro encargo (botones grandes, guía): cada fila con **mensaje humano + «Qué hago» + «Copiar prompt de
    corrección»**; el lenguaje técnico (SQL, nº de invariante) queda detrás de «Ver detalle».

---

## 6. Puerto a TypeScript (BACK)

```ts
// Catálogo en NUESTRA base (tabla checks); corridas y aceptados también en nuestra base.
type Tipo = 'fijo' | 'registro';
type Estado = 'bien' | 'desviado' | 'sin_mirar' | 'sin_comprobar';
type Severidad = 'critica' | 'alta' | 'media' | 'baja' | 'info';
interface Check { id: string; nombre: string; tipo: Tipo; severidad: Severidad; esperado: number;
  sql: string; mensaje: string; correccion: string; fuente: 'kuadra' | 'splinter' | 'auth_config'; }
interface Aceptado { checkId: string; objeto: string; huella: string | null; motivo: string; aceptadoEn: string; }
interface Corrida { checkId: string; estado: Estado; filas: number | null; objetos: unknown[];
  truncado: boolean; error: string | null; ms: number; corridaEn: string; }

const API = 'https://api.supabase.com/v1/projects';
async function consultaSoloLectura(ref: string, token: string, query: string): Promise<unknown[]> {
  const r = await fetch(`${API}/${ref}/database/query/read-only`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }) });
  if (r.status === 429) throw new Error('freno_api');            // 120/min por endpoint
  if (!r.ok) throw new Error(`http_${r.status}: ${(await r.text()).slice(0, 500)}`);
  return (await r.json()) as unknown[];                          // forma exacta de la respuesta [no verificado]
}

// Registro: diff vivo vs aceptados (equivale al full join de KUADRA).
function diffRegistro(vivos: { objeto: string; huella: string | null }[], acept: Aceptado[]) {
  const a = new Map(acept.map(x => [x.objeto, x]));
  const v = new Map(vivos.map(x => [x.objeto, x]));
  const out: { objeto: string; estado: 'nuevo' | 'cambio' | 'ya_no_aparece' }[] = [];
  for (const x of vivos) { const k = a.get(x.objeto);
    if (!k) out.push({ objeto: x.objeto, estado: 'nuevo' });
    else if (k.huella !== null && k.huella !== x.huella) out.push({ objeto: x.objeto, estado: 'cambio' }); }
  for (const k of acept) if (!v.has(k.objeto)) out.push({ objeto: k.objeto, estado: 'ya_no_aparece' });
  return out;
}

async function correr(ref: string, token: string, c: Check, acept: Aceptado[], prefijoCte: string): Promise<Corrida> {
  const t0 = Date.now();
  try {
    const filas = await consultaSoloLectura(ref, token, `${prefijoCte}\n${c.sql}`);
    const objetos = c.tipo === 'registro' ? diffRegistro(filas as any, acept.filter(a => a.checkId === c.id)) : filas;
    const n = objetos.length;
    return { checkId: c.id, estado: n === c.esperado ? 'bien' : 'desviado', filas: n,
      objetos: objetos.slice(0, 200), truncado: n > 200, error: null, ms: Date.now() - t0, corridaEn: new Date().toISOString() };
  } catch (e) {
    return { checkId: c.id, estado: 'sin_mirar', filas: null, objetos: [], truncado: false,   // nunca verde
      error: String(e).slice(0, 500), ms: Date.now() - t0, corridaEn: new Date().toISOString() };
  }
}

// Redacción de GET /config/auth antes de guardar o mandar a Claude.
const SECRETO = /(secret|_pass$|auth_token|api_key|access_key|_secrets$)/;
const redactar = (cfg: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(cfg).filter(([k]) => !SECRETO.test(k)));
```

- Concurrencia: 22 chequeos S + 1 de auth = 23 llamadas por auditoría, en serie o con 4 en paralelo: muy por debajo de
  120/min. No agrupar todo en una sola consulta: un error aborta la sentencia entera y se pierde el «Sin mirar» por chequeo
  (KUADRA lo resuelve con un bloque `exception` por invariante, que nosotros no podemos crear en la base del cliente).
- Coste de IA: **cero por chequeo** (SQL determinista). Claude solo redacta el prompt de corrección por hallazgo nuevo,
  cacheado por (`checkId`, huella del objeto): una auditoría repetida sin cambios no gasta créditos.

---

## Implicaciones para el plan

**Adoptar**
- El modelo de KUADRA tal cual: catálogo en datos con SQL literal, motor genérico, estados `bien/desviado/sin_mirar/
  sin_comprobar`, «error nunca verde», tope de 200 objetos, registro de aceptados con motivo y huella. Esfuerzo **M** (BACK).
- Fuentes combinadas: advisors de Supabase (gratis, oficiales) + nuestros S01-S22 (lo que splinter no ve: IDOR S17, S18,
  S09, S12, S15, S16) + `config/auth` B01-B20 + agregados de `auth` A01-A06. Demo con los cinco más vistosos: **S02, S05,
  S17, S07, B01**, sembrados a propósito en la app propia que se ataca en la demo. Esfuerzo **S** por chequeo ya escrito.
- Credencial: **PAT con alcance** (`database_read`, `auth_read`, opcional `analytics_read`) de un solo proyecto, o OAuth con
  `database:read auth:read`. Nunca `service_role`, nunca `rest:read` (devuelve `jwt_secret`).
- UX: bandeja «Ahora», «Bien N ›», «Checks en cero», «Copiar SQL», vista previa antes de escribir, barra de cambios para
  aceptar riesgos. Esfuerzo **M** (FRONT).

**Evitar**
- Ejecutar SQL generado por el modelo contra la base del cliente: solo plantillas de la lista blanca.
- Escribir en la base del cliente en el MVP: las «acciones» son prompt + SQL de corrección para copiar; el «Aplicar» con
  `database:write` queda detrás de vista previa y confirmación, y fuera del camino crítico de la demo.
- Copiar los chequeos atados al dominio de KUADRA (comercios, POS, crones propios) o sus listas fijas de esquemas.
- Guardar o enviar a Claude IPs, user agents, correos o los secretos de `config/auth`.

**Riesgos**
- El endpoint de solo lectura está en **Beta** y no documenta qué puede leer `supabase_read_only_user` (¿`auth`?,
  ¿`pg_db_role_setting`?). Mitigación: probarlo hoy mismo en nuestro proyecto de demo con S02, S21 y la consulta de 4.2;
  si `auth` no es legible, A01-A06 salen «Sin mirar» y la demo usa B01-B20 + advisors. (Primera tarea del BACK, 30 min.)
- Los advisors 0023-0029 pueden no venir por la API (el enum del OpenAPI no los lista): por eso duplicamos S05/S01/S11.
- Falsos positivos de las heurísticas por regex (S09, S11, S17, S18): se mitigan con el tipo `registro` y aceptación con
  motivo; explicarlo en la UI como «aceptar riesgo», no como error del producto.
- Ruido en proyectos Supabase por defecto (S01 invoker, S12, S13): severidad INFO y texto educativo, para no ahogar lo grave.

**Esfuerzo total estimado de este bloque**: catálogo + motor + registro (BACK) **M**; pantallas Seguridad/Sesiones (FRONT)
**M**; prompts de corrección con Claude **S**.
