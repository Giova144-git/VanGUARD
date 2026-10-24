# R09 — Supabase en 2026: Management API, métricas, MCP, splinter y nuestro backend

Investigación web, etapa 1 de 4 del plan maestro. Fecha: sábado 24-oct-2026, madrugada (Caracas).
Método: descargué la especificación OpenAPI viva de la Management API (`https://api.supabase.com/api/v1-json`,
350 KB, bajada el 24-oct-2026) y la recorrí con Node. También leí la documentación oficial y los repos
`supabase/splinter`, `supabase/vault`, `supabase/supabase-grafana` y `supabase-community/supabase-mcp` (rama `main`).
Etiquetas: **[verificado: URL]** = lo leí en esa fuente hoy; **[no verificado]** = no lo pude comprobar;
**[propuesta]** = umbral o diseño nuestro, sin fuente externa.

---

## 0. Lo esencial en 12 líneas

1. Con **un solo token del cliente** (PAT con alcance o token OAuth) sacamos casi todo: advisors, SQL de solo lectura,
   logs, métricas Prometheus, salud, disco, functions y config de auth. **No hace falta pedir `service_role` ni `sb_secret_...`.**
2. Las **métricas Prometheus se pueden leer por la Management API** (`GET /v1/projects/{ref}/analytics/endpoints/metrics`,
   alcance `analytics:read`). No hace falta pedir la secret key que exige el endpoint directo `/customer/v1/privileged/metrics`.
3. Los **PAT con alcance (scoped PAT)** están en disponibilidad general desde el 6-oct-2026: se limitan a un proyecto,
   cada permiso es de lectura o de lectura y escritura, y **el SQL corre en solo lectura** si el token no tiene Database read-write.
   Es la forma más simple de conectar al cliente durante el hackatón.
4. El endpoint `logs.all` se retiró el 23-sep-2026. Ahora se usa `GET /v1/projects/{ref}/analytics/endpoints/logs`
   con **SQL de ClickHouse** sobre una tabla única `logs`, con un tope de 24 h por consulta.
5. Hay un endpoint de advisors (`/advisors/security` y `/advisors/performance`) que devuelve lints de splinter **más** lints de
   plataforma (protección de contraseñas filtradas, SSL, PITR, MFA, tasa de errores, alertas de instancia…).
6. Splinter tiene hoy **29 lints** (0001–0030, sin la 0012). El enum de la API solo nombra las 17 primeras más las de plataforma,
   así que conviene **ejecutar `splinter.sql` nosotros** por el endpoint de SQL de solo lectura para cubrir las 0019–0030.
7. Alcances que **no** hay que pedir nunca: `secrets:read` (devuelve la *root key* de pgsodium/Vault y las API keys), `rest:read`
   (la config de PostgREST trae `jwt_secret`) y cualquier `:write`. La config de auth (`auth:read`) declara campos secretos
   (`smtp_pass`, `external_*_secret`…): hay que filtrarla con lista blanca.
8. MCP oficial: `https://mcp.supabase.com/mcp?project_ref=…&read_only=true&features=database,debugging,docs`.
   Sirve para el módulo «conecta tu IA». Nuestro motor de reglas debe llamar la REST directamente.
9. Vault ya hace **cifrado autenticado (AEAD de libsodium) con la clave fuera de la base de datos**. El «hash con pimienta» del dueño
   se corrige así: los tokens se guardan en Vault (o se cifran con AES-256-GCM usando una KEK guardada en Vault), y un HMAC-SHA256
   con pimienta queda solo como huella.
10. pgsodium está «pending deprecation» y no se debe usar directamente. Vault sigue con la misma API.
11. Edge Functions: 256 MB, 2 s de CPU por petición, 150 s de reloj en Free. Bien para sondear APIs, mal para descomprimir ZIP grandes.
12. Plan Free: 500 MB de BD, 1 GB de Storage, subida máxima de 50 MB, 2 proyectos activos, pausa tras 1 semana sin actividad
    y 1 día de retención de logs.

---

## 1. Management API (`https://api.supabase.com`)

### 1.1 Base, autenticación y límites

- Cabecera: `Authorization: Bearer <token>`. Tipos de token: **PAT** (con alcance o *legacy*, con todos los permisos de la cuenta)
  y **OAuth2** (de vida corta y con los alcances aprobados) [verificado: https://supabase.com/docs/reference/api/introduction].
- Límite general: **120 peticiones/min por usuario, por proyecto u organización y por endpoint**. Al pasarse responde `429`.
  Cabeceras: `X-RateLimit-Limit`, `X-RateLimit-Remaining` y `X-RateLimit-Reset` (segundos) [verificado: misma URL].
- Límites más estrictos: 30/min para `usage.api-counts` y `usage.api-requests-count` (y el antiguo `logs.all`); 10/min
  (ráfaga de 1/s) para `GET /database/context` [verificado: misma URL]. El límite del nuevo `/analytics/endpoints/logs`
  no aparece publicado [no verificado].
- El `ref` del proyecto tiene 20 letras minúsculas: `^[a-z]+$` [verificado: OpenAPI v1-json].

### 1.2 Cómo conectar la organización del cliente

| Vía | Qué hace el usuario | A qué da acceso | Veredicto hackatón |
|---|---|---|---|
| **PAT con alcance** | Dashboard → Access Tokens → elige 1 proyecto y permisos de **lectura** → pega el token | Solo ese proyecto y lo elegido. SQL en solo lectura salvo Database read-write. Revelar secret keys exige el permiso «API Key Secrets». Caduca a como mucho 1 año y no se puede editar (hay que borrarlo y crear otro) [verificado: https://supabase.com/changelog/scoped-personal-access-tokens-ga] | **Adoptar** (S) |
| PAT legacy | Pega un token de cuenta | Todo lo que puede la cuenta, en todas sus orgs | Evitar. Si llega uno, avisar en la UI |
| **OAuth app** («Conectar con Supabase») | Botón → consentimiento → elige org | Los alcances fijados **al crear la app** (el parámetro `scope` está obsoleto) [verificado: https://supabase.com/docs/guides/integrations/build-a-supabase-integration] | v2 o *stretch* (M) |
| MCP con OAuth DCR | El cliente MCP abre el navegador | Lo que permita el token | Solo para el módulo «conecta tu IA» |
| «Supabase for Platforms» | — | Pensado para plataformas que **crean** proyectos en su propia org y luego los traspasan (*project claim*). Para proyectos que ya son del usuario remite a la guía OAuth [verificado: https://supabase.com/docs/guides/integrations/supabase-for-platforms] | **No aplica** a monitorear orgs ajenas |

**Flujo OAuth (para cuando toque)** [verificado: guía de integración + OpenAPI]:
- Registro: Org settings → OAuth Apps (`https://supabase.com/dashboard/org/_/apps`). La guía no dice qué rol de la org hace falta [no verificado].
- `GET https://api.supabase.com/v1/oauth/authorize?client_id=…&redirect_uri=…&response_type=code&state=…&code_challenge=…&code_challenge_method=S256&organization_slug=<opcional>`
  (`redirect_uri` + `state` ≤ 4 kB).
- `POST https://api.supabase.com/v1/oauth/token` (`application/x-www-form-urlencoded`, Basic `client_id:client_secret`):
  `grant_type=authorization_code&code=…&redirect_uri=…&code_verifier=…`. Para refrescar: `grant_type=refresh_token&refresh_token=…`.
  Respuesta: `{access_token, refresh_token, expires_in, token_type:"Bearer"}`. La duración concreta no está publicada [no verificado].
- Revocación: `POST /v1/oauth/revoke` con cuerpo `{client_id, client_secret, refresh_token}` [verificado: OpenAPI].
- Alcances disponibles: `analytics`, `analytics_config`, `auth`, `database`, `domains`, `edge_functions`, `environment`,
  `organizations`, `projects`, `rest`, `secrets` y `storage`, cada uno `:read` o `:write` [verificado: OpenAPI `components.securitySchemes.oauth2`].

**Alcances mínimos para nuestro producto [propuesta, basada en el `x-oauth-scope` de cada endpoint del OpenAPI]:**
`organizations:read`, `projects:read`, `database:read`, `analytics:read`, `edge_functions:read`, `storage:read` (opcional)
y `auth:read` (opcional, con filtro). **Nunca** `secrets:read`: `GET /v1/projects/{ref}/pgsodium` devuelve `root_key`
(32 bytes en hex), que descifra Vault, y `GET /api-keys?reveal=true` revela las claves. **Nunca** `rest:read`: la respuesta de
`GET /postgrest` incluye `jwt_secret`. Nunca un `:write`.
Pendiente: en los PAT con alcance, el permiso de «analytics» no aparece con ese nombre en el changelog, que solo cita
«projects, database, auth, storage» como ejemplos [no verificado]. Hay que probarlo creando un token a las 08:00.

### 1.3 Endpoints que usaremos (todos verificados en el OpenAPI v1-json del 24-oct-2026)

| Método y ruta | Alcance | Para qué | Frecuencia [propuesta] |
|---|---|---|---|
| `GET /v1/projects` · `GET /v1/projects/{ref}` | projects:read | Validar el token, nombre, región y `status` (`ACTIVE_HEALTHY`, `INACTIVE`, `RESTARTING`, `RESIZING`…) | Al conectar y cada 5 min |
| `GET /v1/projects/{ref}/health?services=auth,db,pooler,realtime,rest,storage&timeout_ms=2000` | projects:read | `[{name, status: COMING_UP\|ACTIVE_HEALTHY\|UNHEALTHY, info, error}]` | 1 min |
| `GET /v1/projects/{ref}/analytics/endpoints/metrics` | analytics:read | Texto Prometheus (CPU, RAM, disco, red, Postgres, GoTrue, Supavisor) | 1 min |
| `GET /v1/projects/{ref}/config/disk/util` | bearer | `{timestamp, metrics:{fs_size_bytes, fs_avail_bytes, fs_used_bytes}}` | 5 min |
| `GET /v1/projects/{ref}/advisors/security` (`?lint_type=sql` opcional) | database:read | Lints de seguridad. **Experimental** | 15 min y con el botón «Auditar» |
| `GET /v1/projects/{ref}/advisors/performance` | database:read | Lints de rendimiento. **Experimental** | 15 min y con el botón «Auditar» |
| `POST /v1/projects/{ref}/database/query/read-only` | database:read | SQL como `supabase_read_only_user`. **Beta**. Exige nombres con esquema | Con la auditoría y cada 5 min para conexiones |
| `POST /v1/projects/{ref}/database/query` | **database:write** | SQL arbitrario (acepta `read_only: true`). **Experimental** | **No usar** |
| `GET /v1/projects/{ref}/analytics/endpoints/logs?sql=…&iso_timestamp_start=…&iso_timestamp_end=…` | analytics:read | Logs unificados (ClickHouse). Rango ≤ 24 h, redondeado al minuto. Sin fechas solo mira el último minuto | 1–5 min |
| `GET /v1/projects/{ref}/analytics/endpoints/usage.api-counts?interval=15min\|30min\|1hr\|3hr\|1day\|3day\|7day` | bearer | `result[{timestamp, total_auth_requests, total_realtime_requests, total_rest_requests, total_storage_requests}]` | 5 min (límite 30/min) |
| `GET /v1/projects/{ref}/functions` | edge_functions:read | `[{id, slug, name, status: ACTIVE\|REMOVED\|THROTTLED, version, verify_jwt, entrypoint_path, …}]` | 15 min |
| `GET /v1/projects/{ref}/functions/{slug}/body` | edge_functions:read | Código de la función, para el módulo Codebase (secretos incrustados) | Con la auditoría |
| `GET /v1/projects/{ref}/analytics/endpoints/functions.combined-stats?interval=15min\|1hr\|3hr\|1day&function_id=…` | bearer | Estadísticas por función (`result: []` sin esquema) | 5 min |
| `GET /v1/projects/{ref}/config/auth` | auth:read | 238 campos. Leer solo la lista blanca de 1.7 | 15 min |
| `GET /v1/projects/{ref}/config/database/postgres` | database:read | `max_connections`, `statement_timeout`, `log_connections`… | Al auditar |
| `GET /v1/projects/{ref}/ssl-enforcement` · `GET /network-restrictions` · `POST /network-bans/retrieve` | database:read / projects:read | SSL forzado, CIDR permitidos, IPs baneadas | Al auditar |
| `GET /v1/projects/{ref}/api-keys/legacy` | **secrets:read** | Saber si siguen activas las claves JWT `anon`/`service_role` | **No**: exige secrets:read |
| `GET /v1/projects/{ref}/database/backups` | database:read | PITR y backups (en Free no hay backups diarios) | Al auditar |

La página de introducción cita un «Run project advisors (`v2-run-project-advisors`)», pero no aparece en `v1-json` [no verificado].

### 1.4 Advisors: forma de la respuesta

Esquema (de `GET /advisors/security` y `/performance`) [verificado: OpenAPI]:
`{ lints: [{ name, title, level: "ERROR"|"WARN"|"INFO", facing: "EXTERNAL", categories: ["PERFORMANCE"|"SECURITY"|"HEALTH"],
description, detail, remediation, metadata: {schema, name, entity, type, fkey_name, fkey_columns}, cache_key, observed_at }] }`.

El enum de `name` incluye los lints de splinter 0001–0018 y además lints de plataforma: `auth_otp_long_expiry`,
`auth_otp_short_length`, `ssl_not_enforced`, `log_connections_not_enabled`, `network_restrictions_not_set`,
`password_requirements_min_length`, `pitr_not_enabled`, `auth_leaked_password_protection`, `auth_insufficient_mfa_options`,
`auth_password_policy_missing`, `leaked_service_key`, `no_backup_admin`, `vulnerable_postgres_version`, `db_not_reachable`,
`db_connection_failing`, `db_connection_limit_reached`, `instance_telemetry_lost`, `instance_db_down`, `instance_alert_firing`,
`log_data_api_error_rate_high`, `log_auth_error_rate_high`, `log_storage_error_rate_high`, `log_edge_function_error_rate_high`,
`realtime_authorization_timeouts`, `realtime_postgres_changes_spike`, `project_not_active` y `advisor_check_unavailable`.
**No** incluye `insecure_queue_exposed_in_api`, `table_bloat`, `sensitive_columns_exposed`, `rls_policy_always_true`,
`public_bucket_allows_listing` ni `*_security_definer_function_executable`, que sí están en splinter (ver §4).

Ejemplo ilustrativo, construido con el esquema y el formato de splinter (no es una respuesta capturada):
```json
{ "lints": [ {
  "name": "rls_disabled_in_public", "title": "RLS Disabled in Public", "level": "ERROR", "facing": "EXTERNAL",
  "categories": ["SECURITY"],
  "description": "Detects cases where row level security (RLS) has not been enabled on tables in schemas exposed to PostgREST",
  "detail": "Table `public.pedidos` is public, but RLS has not been enabled.",
  "remediation": "https://supabase.com/docs/guides/database/database-linter?lint=0013_rls_disabled_in_public",
  "metadata": { "schema": "public", "name": "pedidos", "type": "table" },
  "cache_key": "rls_disabled_in_public_public_pedidos" } ] }
```
`cache_key` es estable, así que sirve de clave natural de deduplicación del hallazgo en nuestra tabla `hallazgos`.

### 1.5 SQL de solo lectura

Cuerpo: `{"query": "<sql>", "parameters": [ ... ]}` (con `query` obligatorio). Responde `201` [verificado: OpenAPI].
El esquema de la respuesta no está declarado. Lo habitual es un array de filas JSON [no verificado: probar a las 08:00].

```ts
// lib/supabase-mgmt.ts — sirve en Node (Vercel) y en Deno (Edge Functions)
const MGMT = 'https://api.supabase.com';
export async function mgmt<T = unknown>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  for (let intento = 1; intento <= 3; intento++) {
    const r = await fetch(MGMT + path, { ...init, headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
    if (r.status === 429) {                       // respetar X-RateLimit-Reset
      const s = Number(r.headers.get('X-RateLimit-Reset') ?? '5');
      await new Promise((ok) => setTimeout(ok, Math.min(Math.max(s, 1), 30) * 1000)); continue;
    }
    if (r.status === 401 || r.status === 403) throw new Error(`TOKEN_INVALIDO_O_SIN_ALCANCE ${r.status} ${path}`);
    if (!r.ok) throw new Error(`MGMT ${r.status} ${path}: ${(await r.text()).slice(0, 300)}`);
    return ((r.headers.get('content-type') ?? '').includes('json') ? r.json() : r.text()) as Promise<T>;
  }
  throw new Error(`MGMT 429 persistente ${path}`);
}
export const sqlLectura = <F = Record<string, unknown>>(token: string, ref: string, query: string, parameters: unknown[] = []) =>
  mgmt<F[]>(token, `/v1/projects/${ref}/database/query/read-only`, { method: 'POST', body: JSON.stringify({ query, parameters }) });
export const metricasProm = (token: string, ref: string) => mgmt<string>(token, `/v1/projects/${ref}/analytics/endpoints/metrics`);
export const advisors = (token: string, ref: string, tipo: 'security' | 'performance') =>
  mgmt<{ lints: Lint[] }>(token, `/v1/projects/${ref}/advisors/${tipo}`);
export type Lint = { name: string; title: string; level: 'ERROR' | 'WARN' | 'INFO'; categories: string[];
  description: string; detail: string; remediation: string; metadata?: Record<string, unknown>; cache_key: string };
```

### 1.6 Logs (ClickHouse, tabla única `logs`)

- `logs.all` se retiró el **23-sep-2026** (se anunció el 23-jul-2026). Las consultas antiguas (BigQuery con `unnest(metadata)`)
  hay que reescribirlas [verificado: https://supabase.com/changelog/48235-migration-of-supabase-management-api-logs-all-analytics-endpoint-to-logs-endpoint].
- Fuentes (columna `source`): `edge_logs`, `postgres_logs`, `postgrest_logs`, `auth_logs`, `auth_audit_logs`, `storage_logs`,
  `realtime_logs`, `function_edge_logs`, `function_logs`, `supavisor_logs`, `pgbouncer_logs`, `pg_upgrade_logs` y `multigres_logs`
  [verificado: https://supabase.com/docs/guides/observability/log-field-reference].
  Discrepancia: el changelog filtra por `source_name` y la guía de SQL y el OpenAPI por `source`. **Probar las dos.**
- Los campos anidados están en el mapa `log_attributes['clave']`, y **todos los valores son String**: hay que convertirlos
  (`toInt32OrZero`). `select *` y `count(*)` se rechazan (usar `count()`). Conviene poner siempre `limit`
  [verificado: https://supabase.com/docs/guides/observability/advanced-log-filtering].
- Claves en `edge_logs`: `request.headers.cf_connecting_ip`, `request.headers.x_real_ip`, `request.path`, `request.method`,
  `response.status_code`, `request.cf.country`, `response.origin_time`. **No hay user agent en `edge_logs`.** Sí lo hay en
  `function_edge_logs` (`request.headers.user_agent`). En `auth_logs`: `remote_addr`, `path`, `status`, `auth_event.action`,
  `auth_event.actor_id`. En `postgres_logs`: `parsed.error_severity`, `parsed.sql_state_code`, `parsed.user_name` y
  `parsed.connection_from` [verificado: log-field-reference].
- Retención: 1 día en Free y 7 días en Pro [verificado: https://supabase.com/pricing].

Consultas listas para usar. Están escritas con la sintaxis documentada, pero no las probé contra un proyecto real:
```sql
-- L1. IPs más insistentes contra la API (rango por parámetros: últimos 15 min)
select log_attributes['request.headers.cf_connecting_ip'] as ip,
       count() as peticiones,
       countIf(toInt32OrZero(log_attributes['response.status_code']) >= 400) as errores
from logs where source = 'edge_logs'
group by ip order by peticiones desc limit 20

-- L2. Rutas con 5xx
select log_attributes['request.path'] as ruta, count() as n
from logs where source = 'edge_logs'
  and toInt32OrZero(log_attributes['response.status_code']) between 500 and 599
group by ruta order by n desc limit 20

-- L3. Posible fuerza bruta en Auth (logins fallidos por IP)
select log_attributes['remote_addr'] as ip, count() as fallos
from logs where source = 'auth_logs'
  and log_attributes['path'] = '/token' and toInt32OrZero(log_attributes['status']) >= 400
group by ip order by fallos desc limit 20

-- L4. Errores de Postgres, sin los códigos de plataforma (25006, 53100, 57P03 según la guía oficial)
select timestamp, log_attributes['parsed.sql_state_code'] as sqlstate, event_message
from logs where source = 'postgres_logs' and log_attributes['parsed.error_severity'] = 'ERROR'
  and log_attributes['parsed.sql_state_code'] not in ('25006','53100','57P03')
order by timestamp desc limit 50
```
Umbrales [propuesta]: L1 con más de 600 peticiones en 15 min desde una IP, o más de un 30 % de errores → alerta media.
L3 con más de 20 fallos en 15 min → alerta alta. Estos datos alimentan el motor de reglas, no el modelo.

### 1.7 Config de auth: lista blanca y reglas

De los 238 campos de `GET /config/auth` solo leer estos [nombres verificados en el OpenAPI; umbrales: propuesta]:
`disable_signup`, `external_anonymous_users_enabled`, `password_min_length` (menos de 8 → WARN), `password_required_characters`
(vacío → INFO), `password_hibp_enabled` (false → WARN), `mfa_totp_enroll_enabled`/`mfa_totp_verify_enabled` (false → INFO),
`mailer_otp_exp` (más de 3600 s → WARN), `mailer_otp_length` (menos de 6 → WARN), `security_captcha_enabled` (false con registro
abierto → WARN), `refresh_token_rotation_enabled` (false → ERROR), `security_refresh_token_reuse_interval`, `jwt_exp`
(más de 3600 → INFO), `sessions_timebox`, `sessions_inactivity_timeout`, `rate_limit_email_sent`, `rate_limit_sms_sent`,
`rate_limit_verify`, `rate_limit_token_refresh`, `rate_limit_otp`, `rate_limit_anonymous_users`, `site_url` y `uri_allow_list`
(comodines `*` → WARN).
**Descartar al instante** (el esquema los declara y no verifiqué si vienen enmascarados): `smtp_pass`, `security_captcha_secret`,
`external_*_secret`, `hook_*_secrets`, `sms_twilio_auth_token`, `sms_vonage_api_secret` y similares. Nunca se guardan
ni se envían a Claude.

---

## 2. Métricas Prometheus

### 2.1 Dos maneras de leerlas

| | Endpoint directo | Vía Management API (**recomendada**) |
|---|---|---|
| URL | `https://<ref>.supabase.co/customer/v1/privileged/metrics` | `https://api.supabase.com/v1/projects/<ref>/analytics/endpoints/metrics` |
| Credencial | HTTP Basic, usuario `service_role` y contraseña = **secret key** `sb_secret_...` [verificado: https://supabase.com/docs/guides/telemetry/metrics] | `Bearer` con alcance `analytics:read` [verificado: OpenAPI] |
| Riesgo | La secret key se salta RLS y da acceso total a los datos | Solo lectura de analítica |
| Estado | Beta, «Metric names and labels might evolve». No existe en self-hosted | Igual (es el mismo feed) [no verificado que sea idéntico byte a byte] |

Supabase recomienda raspar **una vez por minuto**, porque cada respuesta trae el conjunto completo, unas 200 series
[verificado: misma URL]. KUADRA usa el endpoint directo (`lib/nucleo/salud.dart` y `lib/nucleo/prometheus.dart`). Nosotros
cambiamos a la Management API para no pedir la secret key.

### 2.2 Métricas útiles (nombres verificados en `supabase-grafana`)

Fuente: https://github.com/supabase/supabase-grafana (`docs/metrics.md`, `grafana/dashboard.json` y `docs/example-alerts.md`).
Etiquetas comunes: `supabase_project_ref` y `service_type` (`db`, …).
- CPU: `node_cpu_seconds_total{cpu,mode}` (counter; modos `idle`, `iowait`, `user`, `system`, `steal`…), `node_load1`/`5`/`15`.
- RAM: `node_memory_MemTotal_bytes`, `node_memory_MemAvailable_bytes`, `node_memory_Cached_bytes`, `node_memory_SwapTotal_bytes`.
- Disco: `node_filesystem_size_bytes`, `node_filesystem_avail_bytes` (etiquetas `mountpoint` y `fstype`),
  `node_filesystem_readonly`, `node_disk_io_time_seconds_total`, `node_disk_read_bytes_total` y `node_disk_written_bytes_total`.
- Red: `node_network_receive_bytes_total` y `node_network_transmit_bytes_total` (por `device`; excluir `lo`).
- Postgres: `pg_up`, `pg_database_size_mb`, `pg_stat_database_num_backends`, `pg_stat_database_deadlocks_total`,
  `pg_stat_database_xact_commit_total`, `pg_stat_database_xact_rollback_total`, `pg_stat_statements_total_queries`,
  `pg_stat_statements_total_time_seconds`, `pg_status_in_recovery`, `postgresql_restarts_total`,
  `pg_settings_default_transaction_read_only` (que valga 1 = modo solo lectura es una [inferencia]; el estado oficial se lee
  con `GET /v1/projects/{ref}/readonly`, verificado en el OpenAPI),
  `replication_realtime_lag_bytes` y `supabase_usage_metrics_user_queries_total`.
- Auth (GoTrue): `gotrue_running`, `http_status_codes_total` y `http_server_duration_milliseconds` (histograma).
- Pooler: `supavisor_connections_active`, `supavisor_client_queries_count` y `supavisor_client_query_duration_*`.

### 2.3 Fórmulas y umbrales

Las fórmulas siguen las del `dashboard.json` oficial. Los umbrales son [propuesta], salvo `pg_up` (alerta oficial de ejemplo:
`pg_up == 0` durante 5 min, crítica) y el crecimiento de BD (ejemplo oficial: más del 20 % en 12 h).
- **CPU %** = `1 − Δidle / Δtotal` entre dos raspados (guardar el anterior en `metricas_snapshot`). Más del 80 % durante 5 min → media;
  más del 90 % durante 5 min → **alta, con llamada**.
- **RAM %** = `1 − MemAvailable / MemTotal`. Más del 85 % → media; más del 95 % → alta.
- **Disco %** = `1 − avail / size` en el *mount* más grande que no sea `tmpfs` ni `overlay` (como hace KUADRA), o directamente
  `fs_used_bytes / fs_size_bytes` de `/config/disk/util`. Más del 80 % → media; más del 90 % → alta, porque al llenarse el disco
  la BD pasa a solo lectura.
- **Conexiones %** = `Σ pg_stat_database_num_backends / max_connections` (el máximo sale de `show max_connections` por SQL).
  Más del 80 % → alta.
- **Deadlocks**: si `rate(pg_stat_database_deadlocks_total[5m]) > 0` → media. **Reinicio**: si `postgresql_restarts_total` sube → alta.
- **Tamaño de BD en Free**: `pg_database_size_mb` > 400 (el tope es 500 MB) → media.

```ts
type Muestra = { etiquetas: Record<string, string>; valor: number };
export function parsearProm(texto: string): Map<string, Muestra[]> {
  const m = new Map<string, Muestra[]>();
  for (const linea of texto.split('\n')) {
    if (!linea || linea.startsWith('#')) continue;
    const r = /^([a-zA-Z_:][\w:]*)(?:\{([^}]*)\})?\s+(\S+)/.exec(linea);
    if (!r) continue;
    const valor = Number(r[3]); if (!Number.isFinite(valor)) continue;
    const etiquetas: Record<string, string> = {};
    for (const p of (r[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) etiquetas[p[1]] = p[2];
    if (!m.has(r[1])) m.set(r[1], []);
    m.get(r[1])!.push({ etiquetas, valor });
  }
  return m;
}
const suma = (xs: Muestra[] = []) => xs.reduce((a, x) => a + x.valor, 0);
export function cpuPct(prev: Map<string, Muestra[]>, act: Map<string, Muestra[]>): number | null {
  const tot = (m: Map<string, Muestra[]>) => suma(m.get('node_cpu_seconds_total'));
  const idle = (m: Map<string, Muestra[]>) => suma(m.get('node_cpu_seconds_total')?.filter((x) => x.etiquetas.mode === 'idle'));
  const dT = tot(act) - tot(prev), dI = idle(act) - idle(prev);
  return dT > 0 ? Math.min(1, Math.max(0, 1 - dI / dT)) : null;
}
```

---

## 3. Servidor MCP oficial de Supabase

- URL remota: `https://mcp.supabase.com/mcp`. Con la CLI local está en `http://localhost:54321/mcp`, con menos herramientas
  y sin OAuth [verificado: https://github.com/supabase-community/supabase-mcp (README)].
- Parámetros de consulta [verificado: https://supabase.com/docs/guides/getting-started/mcp y https://supabase.com/mcp]:
  - `project_ref=<ref>`: limita el servidor a un proyecto y **desactiva las herramientas de cuenta**.
  - `read_only=true`: «Execute all queries as a read-only Postgres user». En el código, las herramientas de escritura quedan
    ocultas (`hidden: true`) [verificado: `packages/mcp-server-supabase/src/server.ts`].
  - `features=<grupos>`. Identificadores válidos: `docs`, `account`, `database`, `debugging`, `development`, `functions`,
    `branching`, `storage`, `notebooks` y `feedback` (`debug` está obsoleto). **Por defecto** van todos menos `storage` y
    `notebooks` [verificado: `src/types.ts` y `src/server.ts`; paquete `@supabase/mcp-server-supabase` en la versión 0.14.0 de `main`].
  - `skip_elicitations=<herramientas>`: solo en el remoto. Se salta la confirmación por formulario de `create_project`,
    `create_branch`, `execute_sql` y `apply_migration`.
- Herramientas por grupo: database → `list_tables`, `list_extensions`, `list_migrations`, `apply_migration`, `execute_sql`;
  debugging → `query_logs`, `get_advisors` (el antiguo `get_logs` usaba `logs.all`); development → `get_project_url`,
  `get_publishable_keys`, `generate_typescript_types`; functions → `list_edge_functions`, `get_edge_function`,
  `deploy_edge_function`, `create_edge_function_secret`; account → `list_projects`, `get_project`, `create_project`,
  `pause_project`, `restore_project`, `list_organizations`, `get_organization`, `get_cost`, `confirm_cost`;
  docs → `search_docs`; storage → `list_storage_buckets`, `get_storage_config`, `update_storage_config` [verificado: https://supabase.com/mcp].
- Autenticación: por defecto OAuth con *dynamic client registration* (el navegador pide elegir la org). En CI se usa un PAT con
  alcance en `Authorization: Bearer <token>`. Si el cliente exige `client_id`/`secret`, hace falta una OAuth app propia.
  Con PAT con alcance, «cada herramienta comprueba los permisos del token» [verificado: guía MCP y changelog de PAT con alcance].
- Riesgos que documenta Supabase: inyección de instrucciones a través de los datos. El MCP envuelve los resultados SQL con
  avisos, pero dice que eso «no es infalible». Recomienda solo lectura para monitoreo desatendido, un solo proyecto,
  grupos mínimos y **no dar el servidor a clientes finales** [verificado: guía MCP].
- Desde TypeScript, `createToolSchemas({ features, projectScoped, readOnly })` exporta los esquemas para el cliente MCP del
  Vercel AI SDK [verificado: README].

**Uso recomendado [propuesta].** Nuestro motor de reglas y los *pollers* llaman a la REST (§1). Es determinista, barato y no
gasta tokens de Claude. El MCP se usa solo en dos sitios:
1. Módulo «Conecta tu IA»: mostrar al cliente la URL que tiene que pegar en su Claude/Cursor:
   `https://mcp.supabase.com/mcp?project_ref=<ref>&read_only=true&features=database,debugging,docs`.
2. Opcional: el «cerebro» con Claude, para preguntas abiertas del dueño sobre su BD. Si se conecta el MCP remoto desde la
   Messages API, el token del cliente pasa por Anthropic: hay que avisarlo en la UI. Ver R12 [no verificado aquí].

---

## 4. Splinter (linter de Postgres de Supabase)

Repositorio: https://github.com/supabase/splinter. Hay un `.sql` por lint en `lints/` y un único `splinter.sql`
(1 876 líneas) que las une con `union all`. Este fichero empieza con `set local search_path = ''` y un bloque `do $$ … $$`
que guarda los buckets públicos con `set_config('splinter.public_buckets', …, true)`. La GitHub API no declara licencia
(`"license": null`) [verificado: api.github.com/repos/supabase/splinter]. Si se incrusta el SQL, hay que citarlo
[no verificado el estado legal].

Todas las lints devuelven la misma interfaz: `name, title, level, facing, categories, description, detail, remediation,
metadata, cache_key`. Las que miran exposición a la API usan `current_setting('pgrst.db_schemas', 't')` y, si no está
definido, **solo revisan `public`**. Antes de ejecutarlas por SQL hay que hacer `set pgrst.db_schemas = 'public, …'`
[verificado: README de splinter].

| # | name | Nivel | Cat. | Qué detecta (núcleo del SQL) |
|---|---|---|---|---|
| 0001 | unindexed_foreign_keys | INFO | PERF | FK (`pg_constraint.contype='f'`) sin índice válido que cubra sus columnas |
| 0002 | auth_users_exposed | ERROR | SEC | Vista o matview en un esquema expuesto que referencia `auth.users` y es legible por `anon`/`authenticated` |
| 0003 | auth_rls_initplan | WARN | PERF | Política con `auth.uid()`, `auth.jwt()`, `auth.role()`, `auth.email()` o `current_setting()` **sin** `(select …)`, que se reevalúa en cada fila |
| 0004 | no_primary_key | INFO | PERF | Tabla sin PK |
| 0005 | unused_index | INFO | PERF | `pg_stat_user_indexes.idx_scan = 0` y el índice no es único ni PK |
| 0006 | multiple_permissive_policies | WARN | PERF | Más de una política PERMISSIVE para el mismo rol y la misma acción en una tabla |
| 0007 | policy_exists_rls_disabled | ERROR | SEC | Hay `pg_policy` sobre la tabla pero `relrowsecurity = false` |
| 0008 | rls_enabled_no_policy | INFO | SEC | RLS activa sin ninguna política |
| 0009 | duplicate_index | WARN | PERF | `pg_indexes` agrupado por `replace(indexdef, indexname, '')` con `count(*) > 1` |
| 0010 | security_definer_view | ERROR | SEC | Vista expuesta y legible por `anon`/`authenticated` sin `security_invoker=on` (PG ≥ 15) |
| 0011 | function_search_path_mutable | WARN | SEC | Función sin `search_path=` en `proconfig` |
| 0013 | rls_disabled_in_public | ERROR | SEC | Tabla en un esquema expuesto, legible por `anon`/`authenticated`, con `relrowsecurity = false` |
| 0014 | extension_in_public | WARN | SEC | Extensión instalada en `public` |
| 0015 | rls_references_user_metadata | ERROR | SEC | Política que usa `user_metadata` del JWT, que el propio usuario puede editar |
| 0016 | materialized_view_in_api | WARN | SEC | Matview expuesta (las matviews no tienen RLS) |
| 0017 | foreign_table_in_api | WARN | SEC | Tabla foránea expuesta (sin RLS) |
| 0018 | unsupported_reg_types | WARN | SEC | Columnas `reg*` que impiden `pg_upgrade` |
| 0019 | insecure_queue_exposed_in_api | ERROR | SEC | Tablas de cola `pgmq` expuestas sin RLS |
| 0020 | table_bloat | WARN | PERF | Estimación de hinchazón con `pg_stats`: `bloat > 70.0` **y** `raw_waste > 20*1024*1024` (el comentario del código dice «200 MB», pero la cuenta da 20 MB) |
| 0021 | fkey_to_auth_unique | ERROR | SEC | FK hacia una restricción única de `auth.*` |
| 0022 | extension_versions_outdated | WARN | SEC | Extensiones con versiones desactualizadas |
| 0023 | sensitive_columns_exposed | ERROR | SEC | Columnas con nombres sensibles (credenciales, identificadores personales, datos financieros o de salud, claves) en tablas expuestas sin RLS |
| 0024 | rls_policy_always_true | WARN | SEC | `USING`/`WITH CHECK` igual a `true` o `1=1` en UPDATE, DELETE o ALL (SELECT con `true` no se marca) |
| 0025 | public_bucket_allows_listing | WARN | SEC | Bucket público con una política que permite listar `storage.objects` |
| 0026 / 0027 | pg_graphql_anon/authenticated_table_exposed | WARN | SEC | Objeto visible en el esquema GraphQL para anon o para usuarios con sesión |
| 0028 / 0029 | anon/authenticated_security_definer_function_executable | WARN | SEC | Función `SECURITY DEFINER` en un esquema expuesto con `EXECUTE` para anon o authenticated |
| 0030 | autovacuum_disabled | INFO | PERF | Tabla con autovacuum desactivado |

Fuente de niveles, categorías y lógica: los ficheros `lints/00NN_*.sql` [verificado: https://github.com/supabase/splinter/tree/main/lints].

**SQL literal de las tres lints de seguridad clave** (solo los filtros; la lista larga de esquemas excluidos se abrevia como
`<EXCL>` = `auth, cron, extensions, graphql, graphql_public, information_schema, net, pgmq, pgsodium, pgsodium_masks, pgbouncer,
pg_catalog, realtime, storage, supabase_functions, supabase_migrations, vault`, además de timescaledb, pgroonga, pgtle, repack,
tiger y topology):
```sql
-- 0013 rls_disabled_in_public
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on c.relnamespace = n.oid
where c.relkind = 'r' and not c.relrowsecurity
  and (pg_catalog.has_table_privilege('anon', c.oid, 'SELECT')
       or pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT'))
  and n.nspname = any(array(select trim(unnest(string_to_array(
        coalesce(current_setting('pgrst.db_schemas', 't'), 'public'), ',')))))
  and n.nspname not in (<EXCL>);

-- 0007 policy_exists_rls_disabled
from pg_catalog.pg_policy p join pg_catalog.pg_class c on p.polrelid = c.oid
  join pg_catalog.pg_namespace n on c.relnamespace = n.oid
  left join pg_catalog.pg_depend dep on c.oid = dep.objid and dep.deptype = 'e'
       and dep.classid = 'pg_catalog.pg_class'::regclass
where c.relkind = 'r' and n.nspname not in (<EXCL>) and not c.relrowsecurity and dep.objid is null
group by n.nspname, c.relname;

-- 0011 function_search_path_mutable
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on p.pronamespace = n.oid
  left join pg_catalog.pg_depend dep on p.oid = dep.objid and dep.deptype = 'e'
       and dep.classid = 'pg_catalog.pg_proc'::regclass
where n.nspname not in (<EXCL>) and dep.objid is null
  and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) as config where config like 'search_path=%');
```

**Cómo usarlo en el producto [propuesta]:**
1. Para lo básico, usar `/advisors/security` y `/advisors/performance`: ya incluyen las lints de plataforma.
2. Completar con `splinter.sql` por `POST /database/query/read-only`, precedido de `set pgrst.db_schemas = …`. Para leer el valor
   real de `db_schema` haría falta `GET /postgrest` (rest:read, que **no** pedimos), así que se usa el valor por defecto
   `public, graphql_public`. Unir por `cache_key`. No está verificado que el endpoint de solo lectura acepte varias sentencias
   con `do $$` [no verificado]. Si falla, quitar el bloque `do` (solo afecta a la 0025) y mandar cada lint como una consulta.
3. Cada `remediation` apunta a `https://supabase.com/docs/guides/database/database-linter?lint=…`. Claude genera el *prompt*
   de corrección a partir de `detail` y `metadata`, sin volver a analizar el esquema completo, lo que ahorra tokens.

**SQL propio para lo que splinter no cubre** (PostgreSQL estándar, sin probar contra `supabase_read_only_user`; que ese rol
pueda ver `pg_stat_activity` y `pg_stat_statements` de otros roles está [no verificado]):
```sql
-- S1. Conexiones frente al máximo
select count(*) as total, count(*) filter (where state = 'active') as activas,
       current_setting('max_connections')::int as max_conn,
       round(100.0 * count(*) / current_setting('max_connections')::int, 1) as pct
from pg_catalog.pg_stat_activity;

-- S2. Tablas grandes recorridas sin índice (seq scans dominantes) y tuplas muertas
select schemaname, relname, seq_scan, coalesce(idx_scan, 0) as idx_scan, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) as pct_muertas,
       pg_catalog.pg_total_relation_size(relid) as bytes
from pg_catalog.pg_stat_user_tables
where n_live_tup > 10000 and (seq_scan > coalesce(idx_scan, 0) or n_dead_tup > 0.2 * n_live_tup)
order by seq_scan desc limit 20;

-- S3. Consultas más caras (pg_stat_statements está en el esquema extensions en Supabase)
select queryid, calls, round(total_exec_time::numeric, 1) as total_ms, round(mean_exec_time::numeric, 2) as media_ms,
       rows, left(query, 200) as consulta
from extensions.pg_stat_statements order by total_exec_time desc limit 10;

-- S4. Tasa de aciertos de caché (menos de 0.99 → INFO; menos de 0.95 → WARN) [umbral propuesta]
select round(sum(heap_blks_hit)::numeric / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0), 4) as hit_ratio
from pg_catalog.pg_statio_user_tables;

-- S5. Funciones RPC que anon puede ejecutar: candidatas a «sin freno de tasa»
select n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer, p.provolatile
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'
  and pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
order by security_definer desc, p.proname;

-- S6. Resumen de RLS por tabla (para el semáforo de la UI)
select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as rls_forzada,
       (select count(*) from pg_catalog.pg_policy p where p.polrelid = c.oid) as politicas,
       pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') as anon_lee
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') order by rls, c.relname;
```
Sobre el «freno de tasa»: PostgREST y las RPC no traen un límite de peticiones por función configurable desde la Management API.
Solo existen los `rate_limit_*` de Auth [no verificado de forma exhaustiva]. Por eso el hallazgo honesto es «RPC pública ejecutable
por anon (S5) y además con N llamadas por minuto en `edge_logs` (L1 filtrando `request.path like '/rest/v1/rpc/%'`)».

---

## 5. Nuestro backend en Supabase

### 5.1 Vault: qué es, quién lo lee y cómo guardar las keys de los clientes

**API** [verificado: https://supabase.com/docs/guides/database/vault]:
```sql
select vault.create_secret('valor', 'nombre_unico', 'descripcion');             -- devuelve uuid
select vault.update_secret('<uuid>', 'nuevo_valor', 'nuevo_nombre', 'nueva_desc');
select decrypted_secret from vault.decrypted_secrets where name = 'nombre_unico'; -- descifra al leer
delete from vault.secrets where id = '<uuid>';
```
- Cifrado: es **autenticado** (AEAD de libsodium) y las columnas de la fila entran como datos asociados, así que un valor copiado a
  otra fila no se puede descifrar. **La clave no está en la BD**: Supabase guarda una por proyecto en su backend
  [verificado: misma URL]. En el código de la extensión 0.3.x, `vault.secrets` tiene `key_id`, un `nonce` por fila
  (`_crypto_aead_det_noncegen()`) y usa `pgsodium_crypto_aead_det_encrypt_by_id` [verificado: https://github.com/supabase/vault/blob/main/sql/supabase_vault--0.3.0.sql].
- Quién lo lee: la extensión hace `REVOKE ALL … FROM PUBLIC` sobre `create_secret`, `update_secret` y las funciones de cifrado.
  La 0.3.2 fija `search_path = pg_catalog, pg_temp` [verificado: SQL del repo]. La doc avisa de que **quien acceda a
  `vault.decrypted_secrets` lee los secretos** y pone `postgres` como ejemplo de rol con acceso. No dice nada de `service_role`
  [verificado: doc de Vault]. Comprobación obligatoria en nuestro proyecto antes de diseñar sobre ello:
  ```sql
  select has_table_privilege('service_role',  'vault.decrypted_secrets', 'select') as sr_lee,
         has_table_privilege('authenticated', 'vault.decrypted_secrets', 'select') as auth_lee,
         has_function_privilege('postgres', 'vault.create_secret(text,text,text,uuid)', 'execute') as pg_crea;
  ```
- Riesgos documentados: si un secreto descifrado se usa en `pg_net`, queda en claro en `net.http_request_queue` mientras la
  petición está en cola, y cualquier rol que pueda iniciar sesión lo puede leer [verificado: https://supabase.com/docs/guides/functions/schedule-functions].
  `GET /v1/projects/{ref}/pgsodium` (alcance `secrets:read`) devuelve la *root key* [verificado: OpenAPI].
- Un `pg_dump`/`pg_restore` manual a otro proyecto crea una clave nueva y los secretos copiados ya no se pueden descifrar
  [verificado: doc de Vault].
- **pgsodium**: está en «pending deprecation», no se recomienda ningún uso nuevo y tampoco Server Key Management ni Transparent
  Column Encryption. Vault dejará de depender de pgsodium por dentro, pero mantendrá la interfaz [verificado:
  https://supabase.com/docs/guides/database/extensions/pgsodium]. Conclusión: **no tocar pgsodium; usar solo la API de Vault.**

**Corrección del «hash + pimienta» del dueño (validada).** Un hash es irreversible, así que no permite volver a llamar a
Cloudflare/Supabase/GitHub con la key. Hace falta cifrado reversible y autenticado. Hay dos opciones; las dos dejan la clave
fuera de la tabla:

| | **A. Vault por credencial (recomendada para 36 h)** | B. Sobre (*envelope*) AES-256-GCM con KEK en Vault |
|---|---|---|
| Dónde está el texto cifrado | En `vault.secrets` (una fila por credencial) | En nuestra tabla (`iv`, `ct`, `version_kek`) |
| Dónde está la clave | En el backend de Supabase, fuera de la BD | La KEK está en Vault y viaja a la memoria del servidor al descifrar |
| Huella (dedupe, detectar fugas) | `HMAC-SHA256(pimienta_vault, token)` calculado en SQL | Igual, calculado en TS |
| Ventajas | El token nunca sale de Postgres salvo al leerlo; menos código | AAD propio (`org:conexion:proveedor`), rotación con versión de KEK, descifrado sin ir a la BD |
| Riesgos | Las sentencias con el token podrían acabar en `postgres_logs` (ver abajo) | La KEK queda en la memoria y los logs de Vercel/Edge; más código de cripto |
| Esfuerzo | **S** | M |

En los dos casos el límite de confianza es el mismo (quien tenga el rol `postgres` lo puede leer todo). B añade agilidad
criptográfica, no más seguridad real frente a un atacante con acceso a la BD. **Recomendación: A en el MVP. B solo si sobra
tiempo, para lucirlo ante el jurado.**

Opción A, migración propuesta (sin probar; `extensions.hmac` y `extensions.gen_random_bytes` son de pgcrypto, que en Supabase
vive en el esquema `extensions` [no verificado en nuestro proyecto]):
```sql
-- 1) Pimienta generada en el servidor: el valor no aparece en el texto de la sentencia
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'base64'), 'pimienta_v1', 'HMAC de huellas de credenciales');

-- 2) Tabla sin secretos en claro
create table public.conexiones (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  proveedor text not null check (proveedor in ('supabase', 'cloudflare', 'github')),
  vault_secret_id uuid not null,
  huella text not null,              -- hex de HMAC-SHA256(pimienta_v1, token)
  ultimos4 text not null,            -- solo para mostrarlo en la UI
  alcances jsonb not null default '{}',
  creado_en timestamptz not null default now(),
  unique (proveedor, huella)
);
alter table public.conexiones enable row level security;   -- políticas por org_id (las define el BACK)

-- 3) RPC de escritura y lectura, SOLO para service_role (servidor)
create or replace function public.kc_guardar_credencial(p_org uuid, p_proveedor text, p_token text, p_alcances jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_secret uuid; v_pim text;
begin
  select decrypted_secret into v_pim from vault.decrypted_secrets where name = 'pimienta_v1';
  v_secret := vault.create_secret(p_token, 'conn_' || v_id::text, p_proveedor);
  insert into public.conexiones (id, org_id, proveedor, vault_secret_id, huella, ultimos4, alcances)
  values (v_id, p_org, p_proveedor, v_secret,
          encode(extensions.hmac(p_token, v_pim, 'sha256'), 'hex'), right(p_token, 4), p_alcances);
  return v_id;
end $$;
create or replace function public.kc_leer_credencial(p_conexion uuid)
returns text language sql security definer set search_path = '' as $$
  select s.decrypted_secret from vault.decrypted_secrets s
  join public.conexiones c on c.vault_secret_id = s.id where c.id = p_conexion;
$$;
revoke all on function public.kc_guardar_credencial(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.kc_leer_credencial(uuid) from public, anon, authenticated;
grant execute on function public.kc_guardar_credencial(uuid, text, text, jsonb) to service_role;
grant execute on function public.kc_leer_credencial(uuid) to service_role;
```
Con esto splinter no se queja: las funciones tienen `search_path` fijado (0011) y `anon`/`authenticated` no pueden ejecutar las
`SECURITY DEFINER` (0028/0029). Riesgo por comprobar: si Postgres registra una sentencia lenta con sus parámetros, el token podría
aparecer en `postgres_logs` [inferencia, no verificado en Supabase]. Prueba a las 08:00: guardar un token falso `test_LEAK_123`
y buscarlo con la consulta L4 o en el Logs Explorer.

Opción B (WebCrypto estándar, sirve igual en Deno Edge y en Node ≥ 20) [conocimiento general, no verificado en esta investigación]:
```ts
const te = new TextEncoder(), td = new TextDecoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const de64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const importarKek = (kekB64: string) =>
  crypto.subtle.importKey('raw', de64(kekB64), 'AES-GCM', false, ['encrypt', 'decrypt']);
export async function cifrar(kek: CryptoKey, plano: string, aad: string) {          // aad = `${org}:${conexion}:${proveedor}`
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, kek, te.encode(plano));
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)), v: 1 };
}
export async function descifrar(kek: CryptoKey, d: { iv: string; ct: string }, aad: string) {
  return td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: de64(d.iv), additionalData: te.encode(aad) }, kek, de64(d.ct)));
}
export async function huella(pimientaB64: string, token: string) {
  const k = await crypto.subtle.importKey('raw', de64(pimientaB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, te.encode(token)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

### 5.2 Edge Functions: límites

[verificado: https://supabase.com/docs/guides/functions/limits]
- Memoria máxima de **256 MB**. Reloj: **150 s en Free**, 400 s en planes de pago. **2 s de CPU por petición** (la espera de E/S
  asíncrona no cuenta). Si no hay respuesta en 150 s, el llamante recibe `504`.
- Tamaño: 20 MB empaquetada con la CLI y 5 MB si se empaqueta en el servidor (API o Dashboard). Funciones por proyecto: 100 en Free
  y 1 000 en Pro. Logs: mensajes de hasta 10 000 caracteres y 100 eventos cada 10 s. Llamadas anidadas: 30 por traza en 60 s.
- Secretos: 100 por proyecto, de hasta 48 KiB cada uno, y el nombre no puede empezar por `SUPABASE_`. Los puertos 25 y 587 de salida
  están bloqueados. No hay Web Workers, ni el `vm` de Node, ni librerías multihilo (sharp, libvips).
- Tareas en segundo plano: `EdgeRuntime.waitUntil(promesa)`, con un evento `beforeunload` (`ev.detail?.reason`) al apagarse.
  Siguen sujetas a los límites anteriores [verificado: https://supabase.com/docs/guides/functions/background-tasks].
- Invocaciones: 500 000 al mes en Free y 2 M en Pro (luego 2 USD por millón) [verificado: https://supabase.com/pricing].
- Consecuencia: **sondear las APIs sí cabe** (casi todo es E/S, y parsear unas 200 series cuesta muy poca CPU).
  **Descomprimir y analizar un ZIP de varios MB no cabe con seguridad en 2 s de CPU**: eso va en una función Node de Vercel
  o en el worker de análisis (ver R13/R12) [propuesta].

### 5.3 pg_cron + pg_net: el latido de los *pollers*

- Supabase Cron = `pg_cron`. Admite desde «cada segundo» hasta una vez al año. Recomienda **no más de 8 jobs concurrentes y que
  cada uno dure 10 min como mucho**. El historial está en `cron.job_run_details` [verificado: https://supabase.com/docs/guides/cron].
- La sintaxis de menos de un minuto es `'[1-59] seconds'` (por ejemplo `'30 seconds'`). `cron.job_run_details` **no se limpia
  sola** [verificado: https://github.com/citusdata/pg_cron].
- Patrón oficial para invocar una Edge Function: guardar `project_url` y `secret_key` en Vault y llamar a `net.http_post` con la
  cabecera `apikey`. La función debe tener `verify_jwt` desactivado y aceptar `auth: 'secret'` [verificado: https://supabase.com/docs/guides/functions/schedule-functions].

```sql
select vault.create_secret('https://<nuestro-ref>.supabase.co', 'project_url');
select vault.create_secret('<NUESTRA_SECRET_KEY>', 'secret_key');   -- SOLO en nuestro proyecto, nunca la del cliente
select cron.schedule('latido-monitores', '30 seconds', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/latido',
    headers := jsonb_build_object('Content-Type', 'application/json',
               'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'secret_key')),
    body := jsonb_build_object('t', now())
  ) as request_id;
$$);
select cron.schedule('limpiar-cron', '0 * * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '1 day'$$);
```
La función `latido` reparte el trabajo: cada conexión tiene su `proximo_sondeo_en` y en cada tic solo se procesan las vencidas,
con métricas cada 1 min, logs cada 1–5 min y advisors cada 15 min [propuesta]. Cálculo: un tic cada 30 s son unas 86 400
invocaciones al mes, dentro de las 500 000 de Free.

### 5.4 Queues (pgmq)

- Cola nativa de Postgres sobre `pgmq`, con entrega garantizada y «exactly once» dentro de la ventana de visibilidad. Se puede
  archivar. El acceso desde el cliente se controla con permisos de API y RLS [verificado: https://supabase.com/docs/guides/queues].
- Funciones expuestas en `pgmq_public` (no crean ni borran colas): `send(queue_name text, message jsonb, sleep_seconds integer default 0)`,
  `send_batch(queue_name text, messages jsonb[], sleep_seconds integer default 0)`, `read(queue_name text, sleep_seconds integer, n integer)`,
  `pop(queue_name text)`, `archive(queue_name text, message_id bigint)` y `delete(queue_name text, message_id bigint)`
  [verificado: https://supabase.com/docs/guides/queues/api]. Crear colas: `pgmq.create('nombre')` [no verificado en la doc leída].
- Si se exponen colas sin RLS, splinter lo marca con la 0019 (ERROR).
- Uso [propuesta]: **no hace falta en el MVP** (pocas conexiones y un solo latido). Encaja como cola `alertas_salientes`
  (WhatsApp/llamada con reintentos) si da tiempo, consumida por `read(…, 60, 10)` + `archive`.

### 5.5 Realtime

- Límites Free / Pro: 200 / 500 conexiones concurrentes, 100 / 500 mensajes por segundo, 100 / 500 *joins* de canal por segundo,
  100 canales por conexión, *broadcast* de 256 KB / 3 000 KB y *postgres changes* de 1 024 KB (por encima, solo llegan los campos
  de 64 bytes o menos) [verificado: https://supabase.com/docs/guides/realtime/limits]. En Free hay 2 M de mensajes al mes
  [verificado: pricing].
- Uso [propuesta]: el FRONT se suscribe con `postgres_changes` (INSERT) a `public.alertas` y `public.metricas_vivas`, filtrando
  por `org_id`, con RLS activa: el panel se pone rojo sin recargar. Mantener las filas pequeñas, con la serie histórica en otra tabla.

### 5.6 Storage: subir ZIP de proyectos

- Límite global por archivo: **50 MB en Free** (no se puede subir más) y 500 GB en Pro/Team. Cada bucket puede tener su propio
  límite, siempre menor, y tipos MIME permitidos [verificado: https://supabase.com/docs/guides/storage/uploads/file-limits].
- La subida estándar es «ideal» hasta 6 MB. A partir de ahí conviene **TUS** (subida reanudable). Por defecto no se sobrescribe
  (responde `400 Asset Already Exists` salvo con `upsert: true`) [verificado: https://supabase.com/docs/guides/storage/uploads/standard-uploads].
- Storage en Free: 1 GB [verificado: pricing].
- Diseño [propuesta]: bucket privado `zips` con `file_size_limit` de 50 MB y MIME `application/zip`. La ruta lleva el `org_id`
  (`<org_id>/<uuid>.zip`) y la RLS de `storage.objects` usa `(storage.foldername(name))[1] = org_id`. El FRONT sube con TUS si
  pesa más de 6 MB. Al terminar el análisis se borra el ZIP: guardar código ajeno es un riesgo.

### 5.7 Planes (nuestro proyecto y el de demo)

| | Free | Pro |
|---|---|---|
| Precio | 0 | desde 25 USD/mes, con 10 USD de crédito de cómputo (1 Micro) |
| Proyectos activos | **2**; **se pausan tras 1 semana** sin actividad | — |
| Cómputo | CPU compartida y 500 MB de RAM | Micro y superiores |
| BD | 500 MB por proyecto | 8 GB de disco, luego 0,125 USD/GB |
| Egress | 5 GB + 5 GB en caché | 250 GB + 250 GB |
| Storage / máx. por archivo | 1 GB / 50 MB | 100 GB / 500 GB |
| MAU | 50 000 | 100 000 |
| Edge invocations | 500 000 | 2 M |
| Realtime | 200 concurrentes, 2 M de mensajes | 500 concurrentes, 5 M de mensajes |
| Retención de logs | **1 día** | 7 días |
| Backups diarios | no | 7 días |

[verificado: https://supabase.com/pricing]. Encaja para la demo: un proyecto para **nuestro backend** y otro para la **app víctima**
que atacamos en vivo. Con eso se agotan los 2 proyectos activos de la cuenta Free: si hace falta un tercero, usar otra cuenta del equipo.

---

## Implicaciones para el plan

**Adoptar**
1. **Conectar con un PAT con alcance, solo lectura y un proyecto** (S). La UI explica en 4 pasos cómo crearlo y valida al momento
   con `GET /v1/projects/{ref}` + `GET /advisors/security`. Mostrar los alcances detectados y rechazar o avisar si el token puede escribir.
2. **REST de la Management API como fuente principal** (M): métricas por `/analytics/endpoints/metrics` (sin secret key), `health`,
   `disk/util`, advisors, SQL con `/database/query/read-only` y logs ClickHouse. Un único cliente `mgmt()` con reintentos por 429.
3. **Motor de reglas determinista** con los umbrales de §1.6, §1.7 y §2.3. Claude solo **explica** y **redacta el *prompt* de
   corrección** a partir de `detail`, `metadata` y `remediation` del lint (M).
4. **Auditoría de un botón** = advisors (security + performance) + `splinter.sql` (lints 0019–0030) + S1–S6 + config de auth filtrada,
   deduplicado por `cache_key` (M).
5. **Credenciales en Vault (opción A)** con huella HMAC y pimienta en Vault, RPC `SECURITY DEFINER` solo para `service_role` (S).
6. **pg_cron cada 30 s → Edge Function `latido`**, con limpieza de `cron.job_run_details` (S). Realtime sobre `alertas` para el panel (S).
7. Módulo «Conecta tu IA»: mostrar la URL del MCP con `read_only=true&project_ref=…&features=database,debugging,docs` y exportar los
   hallazgos en JSON o Markdown (S).

**Evitar**
- Pedir `service_role`, `sb_secret_...` o PAT legacy. No usar el endpoint directo `/customer/v1/privileged/metrics` con los clientes.
- Alcances `secrets:read` (root key de Vault y API keys), `rest:read` (`jwt_secret`) y cualquier `:write`.
  `POST /database/query` (exige `database:write`).
- `logs.all` y las consultas BigQuery con `unnest(metadata)`: están retirados.
- pgsodium directo, Transparent Column Encryption y Server Key Management.
- Guardar la respuesta cruda de `GET /config/auth` o mandarla a Claude: trae campos de secretos.
- Procesar ZIP en Edge Functions (2 s de CPU). Guardar ZIP después del análisis.
- Usar el MCP en el bucle de monitoreo (gasta tokens, no es determinista y abre la puerta a la inyección de instrucciones).

**Riesgos y mitigación**
| Riesgo | Prob. | Mitigación |
|---|---|---|
| Los endpoints *experimental*/*beta* (advisors, query read-only, metrics) cambian o fallan | Media | Envolverlos en `try` y degradar a `splinter.sql` por SQL o a «sin dato». Probarlos todos a las 08:00 con nuestro proyecto de demo |
| El PAT con alcance no ofrece el permiso de «analytics» | Media | Probarlo primero. Plan B: secret key dedicada **solo en nuestro proyecto de demo**, documentado como excepción |
| `source` frente a `source_name` en logs | Media | Probar las dos. Encapsularlo en un solo helper `sqlLogs()` |
| `supabase_read_only_user` sin permiso sobre `pg_stat_statements`/`pg_stat_activity` | Media | Ocultar la tarjeta y mostrar «requiere permiso». Los advisors siguen funcionando |
| El token del cliente acaba en `postgres_logs` al guardarlo | Baja | Prueba con un token falso, como en §5.1 |
| El proyecto Free se pausa o se queda sin los 2 proyectos activos | Baja | Actividad diaria. Proyecto víctima en otra cuenta si hace falta |
| Muchas peticiones por cliente (120/min por endpoint) | Baja | Con la cadencia propuesta salen unas 6 peticiones/min por conexión |

**Esfuerzo por pieza:** cliente `mgmt()` y validación de token (S) · *poller* de métricas, salud y disco con snapshots (M) ·
auditoría de advisors + splinter + SQL propio (M) · logs ClickHouse L1–L4 (S–M) · lista blanca de auth (S) · Vault y RPC de
credenciales (S) · cron + latido + Realtime (S) · Storage de ZIP con RLS (S) · OAuth app «Conectar con Supabase» (M, *stretch*) ·
opción B AES-GCM (M, *stretch*).
