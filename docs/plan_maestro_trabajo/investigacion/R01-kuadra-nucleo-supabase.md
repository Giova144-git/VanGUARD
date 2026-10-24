# R01 — Núcleo de KUADRA para Supabase: conexión, métricas, claves y errores (listo para portar a TypeScript)

Etapa 1 de 4 del plan maestro · team-22 · Platanus Hack 26 Caracas · 24-10-2026.
Fuente leída entera: `C:\Users\giova\Desktop\KUADRA\KUADRA CRM\kuadra_crm\lib\nucleo\` (supabase_api.dart 267 l., supabase_gestion_api.dart 287, prometheus.dart 280, salud.dart 132, config.dart 319, estado_claves.dart 87, servicios.dart 62, acciones.dart 93, errores_base.dart 52, error_red.dart 27, formato.dart 92). Hojeados: cloudflare_api.dart (REST `https://api.cloudflare.com/client/v4` + `/graphql`, lo cubre R05) y lukapay_worker_api.dart (Worker propio con cabecera `x-kuadra-crm`, no aplica). Para umbrales se miró además `lib/modulos/resumen/modelos.dart` (`UmbralesResumen`).

Convención: [KUADRA: archivo:línea] = comprobado en el código; [verificado: URL] = comprobado hoy contra la fuente; [no verificado] = no se pudo comprobar, probar en el proyecto de demo antes de prometerlo.

## 0. Lo esencial en 10 líneas

1. KUADRA usa **dos credenciales** de Supabase: la **service_role** (REST/RPC, Storage y el endpoint Prometheus por Basic Auth) y un **PAT acotado `sbp_fc…`** de solo lectura para la Management API. Nosotros **no** vamos a pedir la service_role (decisión 2.1 de parte5).
2. **Hallazgo clave:** la Management API tiene `GET /v1/projects/{ref}/analytics/endpoints/metrics`, que devuelve **el mismo texto Prometheus** con un PAT que solo tenga **Logs: Read**. Con eso CPU, RAM, disco, red y conexiones salen **sin service_role** [verificado: https://api.supabase.com/api/v1-json, https://supabase.com/docs/guides/platform/personal-access-tokens].
3. Las fórmulas de KUADRA son correctas y portables: CPU = `1 − Δidle/Δtotal` entre dos lecturas; RAM = `(MemTotal − MemAvailable)/MemTotal`; disco = `(size − avail)/size` del filesystem de datos; red = `Δbytes/Δt` sin `lo`.
4. KUADRA guarda la lectura anterior **en memoria** (app de escritorio). En Vercel (serverless) hay que **persistir la muestra anterior** por proyecto o no habrá CPU ni red.
5. El núcleo **no tiene reintentos**: un intento con plazo (8/20/30/60 s) y el refresco periódico hace de reintento implícito. Hay que añadir reintento con espera exponencial para 429/5xx/red.
6. El patrón de errores de KUADRA es bueno y se copia: códigos cortos (`sin_token`, `ref`, `red`, `plazo`, `http_<n>`, `forma`), **nunca** el cuerpo de la respuesta ni el texto de la excepción (puede llevar el secreto).
7. KUADRA guarda las claves **en claro** en `%APPDATA%\KUADRA CRM\config.json`. No se porta: diseño de cifrado de sobre AES-256-GCM + KEK y pimienta en Supabase Vault en §8.
8. "Probar conexión" de KUADRA: un GET por permiso; un 403 en esa ruta = falta ESE permiso. Se porta tal cual como checklist verde/rojo (botón grande).
9. Con PAT + **Database: Read** se puede correr SQL por `POST /database/query/read-only`, pero ese rol es `supabase_read_only_user` con **BYPASSRLS + pg_read_all_data** (lee todos los datos). Solo consultas fijas de catálogo en servidor, nunca SQL escrito por el modelo.
10. Los **advisors** de Supabase (`/advisors/security` y `/advisors/performance`) ya traen `rls_disabled_in_public`, `unindexed_foreign_keys`, `db_connection_limit_reached`, `leaked_service_key`… Primera fuente de hallazgos, la más barata.

## 1. Arquitectura del núcleo de KUADRA

| Pieza | Qué hace | Credencial | Se porta |
|---|---|---|---|
| `Servicios` (servicios.dart) | Localizador único: crea `SupabaseApi`, `CloudflareApi`, `SupabaseGestionApi`, `LukaPayWorkerApi` con la misma `ConfigCrm` | — | Como fábrica de clientes por tenant (`clientesDe(orgId)`) |
| `SupabaseApi` (supabase_api.dart) | RPC `POST {url}/rest/v1/rpc/{nombre}` con `Content-Profile: plataforma`; subida a Storage; `metricasCrudas()` | service_role | Solo `metricasCrudas` (cambiando de endpoint) |
| `SupabaseGestionApi` (supabase_gestion_api.dart) | Management API `https://api.supabase.com/v1/projects/{ref}{ruta}`; mapa ruta→permiso; `comprobarPermisos()` | PAT `sbp_fc…` | **Sí, entero** |
| `prometheus.dart` | Parser de texto Prometheus + `FotoMetricas` + `CalculadoraMetricas` (deltas, historia de 60 puntos) | — | **Sí, entero** (§4, §9) |
| `salud.dart` | 4 sondas en paralelo con latencia: `base`, `rest`, `auth`, `metricas` | service_role | Sustituir por `GET /health` (§5) |
| `estado_claves.dart` | Último resultado de cada validación `{ok, hora, error}` en memoria, nunca el valor | — | Sí, persistido en tabla (§8) |
| `acciones.dart` | `ejecutarAccion`: la base propone `{rpc, args, por_cada}`; el cliente añade `p_simular` y `p_motivo`; nunca lanza | — | El patrón (vista previa + motivo) |
| `errores_base.dart` | Código de candado SQL → frase corta; lo desconocido se muestra crudo | — | El patrón |
| `error_red.dart` | `motivoDeRed(e)`: tipo de excepción → 1-4 palabras, sin texto de la excepción | — | **Sí** |
| `formato.dart` | Bytes base 1024, `%` con coma, "hace 5 min", duraciones | — | Trivial con `Intl` |
| `config.dart` | Config local JSON, escritura atómica, validación y máscara de tokens | — | Validación y máscara sí; almacenamiento no |

Nota: `SupabaseApi.sql()` llama a `plataforma.crm_sql`, una RPC que ejecuta **cualquier** SQL con service_role [KUADRA: supabase_api.dart:113-123]. Es útil para el dueño de KUADRA sobre su propia base y **no tiene equivalente** en un producto multi-cliente.

## 2. Cómo se conecta KUADRA a Supabase (rutas, cabeceras, plazos)

### 2.1 Plano de datos (service_role) — referencia, no se adopta

| Uso | Método y URL | Cabeceras | Plazo |
|---|---|---|---|
| RPC del CRM | `POST https://{ref}.supabase.co/rest/v1/rpc/{nombre}` | `apikey: <sr>`, `Authorization: Bearer <sr>`, `Content-Type: application/json`, `Content-Profile: plataforma` | 20 s |
| Subir imagen | `POST /storage/v1/object/{bucket}/{ruta}` | `apikey`, `Authorization: Bearer`, `Content-Type: <mime>`, `x-upsert: true` | 60 s |
| Métricas | `GET /customer/v1/privileged/metrics` | `Authorization: Basic base64("service_role:" + <sr>)` | 20 s |
| Sonda REST | `GET /rest/v1/` | `apikey`, `Authorization: Bearer` | 20 s |
| Sonda Auth | `GET /auth/v1/health` | `apikey` | 20 s |

Fuente: [KUADRA: supabase_api.dart:68-111, 147-203, 247-266; salud.dart:86-114]. La doc oficial confirma el endpoint de métricas y la Basic Auth `service_role:<sb_secret_…>`, unas ~200 series, beta, **no disponible en self-hosted**, y recomienda raspar **una vez por minuto** [verificado: https://supabase.com/docs/guides/telemetry/metrics]. KUADRA usa la service_role heredada (JWT); la doc ya pide la secret key `sb_secret_…`. Supabase retira `anon`/`service_role` heredadas **a fines de 2026** [verificado: https://supabase.com/docs/guides/getting-started/api-keys]. Ambas llevan `BYPASSRLS` (misma página).

### 2.2 Management API (PAT de solo lectura) — se adopta

- Base: `https://api.supabase.com/v1/projects/{ref}{ruta}`, `Authorization: Bearer <token>`, `Accept: application/json` [KUADRA: supabase_gestion_api.dart:136-177].
- `ref` sale de la URL del proyecto con `^https?://([a-z0-9]{20})\.supabase\.co/?$` [KUADRA: :40-42]. El OpenAPI declara `ref` con 20 caracteres y patrón `^[a-z]+$` [verificado: https://api.supabase.com/api/v1-json]; validar con `/^[a-z]{20}$/` y aceptar dígitos solo si aparece un caso real.
- Ruta saneada antes de salir a la red: segmentos `^(/[A-Za-z0-9._\-]+)*$`, se rechaza `.` y `..`; la consulta va aparte [KUADRA: :47, 138-152].
- Plazo por defecto **8 s** (cliente "de hoy") y **30 s** (cliente explícito de backup/restaurar) [KUADRA: :54, 66]. Se lee el cuerpo entero con el mismo plazo.
- No lanza por estado HTTP en `_enviar`; quien llama decide. `leerJson` lanza `ErrorGestion('http', estado)` fuera de 2xx y `ErrorGestion('forma')` si el JSON no decodifica [KUADRA: :179-208].
- Límite de tasa: **120 peticiones/minuto por usuario, por proyecto u organización, por endpoint**; al pasarse, `429` hasta que acabe el minuto [verificado: https://supabase.com/docs/reference/api/introduction]. Con PAT el límite es del usuario: **todos sus tokens lo comparten** (misma página).
- Tokens: un PAT **acotado** empieza por `sbp_fc` y solo alcanza los proyectos y permisos elegidos; el "clásico" (Legacy) tiene los privilegios de la cuenta entera [verificado: https://supabase.com/docs/guides/platform/personal-access-tokens]. KUADRA **rechaza** todo token que no empiece por `sbp_fc` [KUADRA: config.dart:23, 51-57], así obliga a usar uno acotado. Lo copiamos.
- Alternativa OAuth2 ("Conectar con Supabase"): `GET https://api.supabase.com/v1/oauth/authorize` + `POST /v1/oauth/token`, PKCE recomendado, tokens de vida corta con refresh; los scopes se configuran en la app OAuth (el parámetro `scope` está obsoleto) [verificado: https://supabase.com/docs/guides/integrations/build-a-supabase-integration]. Scopes disponibles: `analytics:read`, `database:read`, `projects:read`, `edge_functions:read`, `auth:read`, `rest:read`, `secrets:read`, `storage:read`… [verificado: OpenAPI `components.securitySchemes.oauth2`].

## 3. Mapa "dato → endpoint → credencial necesaria"

Todos son `GET https://api.supabase.com/v1/projects/{ref}…` salvo indicación. "Permiso PAT" = nombre que ve el usuario al crear el token; "fga" = identificador interno del OpenAPI (`x-fga-permissions`); "OAuth" = `x-oauth-scope`. Todo [verificado: https://api.supabase.com/api/v1-json y https://supabase.com/docs/guides/platform/personal-access-tokens] salvo lo marcado.

| Dato para nuestro producto | Endpoint | Permiso PAT (Read) | fga | OAuth | Usado en KUADRA |
|---|---|---|---|---|---|
| **CPU, RAM, disco, red, conexiones, IO, tamaño BD (Prometheus)** | `/analytics/endpoints/metrics` → `text/plain` | **Logs** | `analytics_logs_read` | `analytics:read` | No (usa `/customer/v1/privileged/metrics` con service_role) |
| Estado de servicios (auth, db, pooler, realtime, rest, storage) | `/health?services=auth,db,pooler,realtime,rest,storage&timeout_ms=2000` | Project Settings | `project_admin_read` | `projects:read` | No (sondas propias) |
| Proyecto: nombre, región, `status`, `database.version` | `/v1/projects/{ref}` (sin sufijo) | Project Settings | `project_admin_read` | `projects:read` | Sí (`''` → "Project Settings R") |
| Hallazgos de seguridad (RLS, claves filtradas, MFA…) | `/advisors/security` (experimental) | Advisors | `advisors_read` | `database:read` | No |
| Hallazgos de rendimiento (índices, FK sin índice…) | `/advisors/performance` (experimental) | Advisors | `advisors_read` | `database:read` | No |
| SQL de catálogo (RLS, funciones, bloat, conexiones) | `POST /database/query/read-only` body `{query, parameters?}` (Beta) | Database | `database_read` | `database:read` | No (usa `crm_sql`) |
| Uso de disco exacto | `/config/disk/util` → `{timestamp, metrics:{fs_size_bytes, fs_avail_bytes, fs_used_bytes}}` | Disk Config | `infra_disk_config_read` | — (sin scope declarado) | No |
| Tipo/tamaño/IOPS del disco | `/config/disk` → `{attributes:{type:gp3\|io2, size_gb, iops, throughput_mibps?}}` | Disk Config | `infra_disk_config_read` | — | No |
| `max_connections`, `statement_timeout`, `work_mem`… | `/config/database/postgres` | Database Config | `database_config_read` | `database:read` | Sí |
| Config del pooler | `/config/database/pooler` | Connection Pooling | `database_pooling_config_read` | `database:read` | Sí |
| Edge functions y `verify_jwt` (funciones públicas) | `/functions` → `[{id, slug, name, status, version, verify_jwt, entrypoint_path, …}]` | Edge Functions | `edge_functions_read` | `edge_functions:read` | Sí (inventario del freno) |
| Esquemas expuestos por la Data API (`db_schema`) | `/postgrest` | Data API Config | `data_api_config_read` | `rest:read` | Sí |
| Política de contraseñas, MFA, OTP | `/config/auth` | Auth Config | `auth_config_read` | `auth:read` | Sí |
| Restricciones de red / SSL obligatorio | `/network-restrictions` · `/ssl-enforcement` | Network Restrictions · SSL Enforcement | `database_network_restrictions_read` · `database_ssl_config_read` | `projects:read` · `database:read` | Sí |
| Picos de peticiones REST/Auth/Storage/Realtime | `/analytics/endpoints/usage.api-counts?interval=15min\|30min\|1hr\|3hr\|1day\|3day\|7day` | Usage Analytics | `analytics_usage_read` | — | No |
| Logs (edge, postgres, auth…) | `/analytics/endpoints/logs?sql=…&iso_timestamp_start=…&iso_timestamp_end=…` (SQL **dialecto ClickHouse**, rango ≤ 24 h; sin fechas = último minuto) | Logs | `analytics_logs_read` | `analytics:read` | No |
| Copias de seguridad (¿PITR?) | `/database/backups` | Backups | `backups_read` | `database:read` | No |

Notas del mapa:
- `/analytics/endpoints/logs.all` **ya no existe**: responde `410 Gone` [verificado: OpenAPI]. Usar `/logs`.
- Los endpoints sin `x-oauth-scope` (`/config/disk*`, `usage.api-counts`) quizá no acepten tokens OAuth [no verificado: es inferencia del OpenAPI]. Razón extra para empezar con PAT.
- `/secrets` (Edge Function Secrets) y `/api-keys` existen, pero **no los pedimos**: no necesitamos valores secretos del cliente.
- **Cuidado con dos lecturas "inocentes":** el esquema de respuesta de `/config/auth` declara campos secretos (`external_github_secret`, `external_google_secret`, `security_captcha_secret`, `sms_vonage_api_secret`, `hook_*_secrets`…), y el de `/postgrest` declara `jwt_secret`; este último solo con el permiso extra `data_api_config_secret_read` [verificado: OpenAPI]. Si con Read llegan en claro o enmascarados es [no verificado]. Regla: parsear con **lista blanca** de campos (de `/config/auth`: `disable_signup`, `password_min_length`, `password_required_characters`, `password_hibp_enabled`, `mfa_totp_enroll_enabled`, `mfa_totp_verify_enabled`, `mailer_otp_exp`, `mailer_otp_length`, `security_captcha_enabled`, `rate_limit_*`, `refresh_token_rotation_enabled`, `jwt_exp`; de `/postgrest`: `db_schema`, `max_rows`, `db_pool`) [verificado: nombres en OpenAPI], descartar el resto **antes** de guardar, registrar o mandar nada a Claude, y no conceder nunca "Data API JWT Secret".
- La herramienta MCP `execute_sql` también exige **Database: Read**, y `get_advisors` exige **Advisors: Read** [verificado: PAT doc, tabla "MCP tools"]. MCP y Management API tienen la misma exposición.

**PAT mínimo recomendado** (todo Read, acotado a UN proyecto): Project Settings, Logs, Advisors, Disk Config, Database Config, Edge Functions, Data API Config, Auth Config, Usage Analytics. **Opcional, con aviso:** Database (habilita SQL de catálogo, pero ver §6.0).

### 3.1 Mapa de permisos de KUADRA (para portar `permisoPorRuta`)

[KUADRA: supabase_gestion_api.dart:83-97]. Los nombres coinciden con los del panel de Supabase [verificado: PAT doc].

```ts
// Ruta bajo /v1/projects/{ref} → permiso que la abre. Un 403 aquí = falta ESE permiso, nunca "token roto".
export const PERMISO_POR_RUTA: Record<string, string> = {
  '': 'Project Settings',
  '/health?services=db': 'Project Settings',
  '/analytics/endpoints/metrics': 'Logs',
  '/advisors/security': 'Advisors',
  '/config/disk/util': 'Disk Config',
  '/config/database/postgres': 'Database Config',
  '/functions': 'Edge Functions',
  '/postgrest': 'Data API Config',
  '/config/auth': 'Auth Config',
  '/analytics/endpoints/usage.api-counts?interval=1hr': 'Usage Analytics',
  // Database: Read se prueba con POST /database/query/read-only {"query":"select 1"}
};
```

## 4. Métricas Prometheus: parser, fórmulas exactas y umbrales

### 4.1 Formato y parser de KUADRA

Texto de exposición Prometheus: `nombre{et1="v1",et2="v2"} valor [timestamp]` o `nombre valor`. KUADRA [KUADRA: prometheus.dart:17-83]:
- ignora líneas vacías y `#` (HELP/TYPE), ignora el timestamp, descarta valores no numéricos y `NaN` (p. ej. `replication_slots_max_lag_bytes ... NaN` sale en la muestra oficial [verificado: https://github.com/supabase/supabase-grafana/blob/main/metrics.md]);
- recorre las etiquetas a mano para respetar comas y comillas escapadas dentro de valores;
- agrupa en `Map<nombre, List<{etiquetas, valor}>>`.

Al portar a JS hay una trampa: `Number('+Inf')` es `NaN` en JS (JS espera `Infinity`). Hay que traducir `+Inf`/`-Inf` a mano. En Dart no se notaba porque solo se miran gauges y counters.

Todas las series llevan `supabase_project_ref`, `supabase_identifier` y `service_type` (`db`, `postgresql`, `gotrue`, `pooler`, `postgrest`) [verificado: metrics.md del repo supabase-grafana].

### 4.2 Fórmulas de KUADRA (portables 1:1)

| Métrica | Series | Fórmula exacta | Fuente |
|---|---|---|---|
| CPU % | `node_cpu_seconds_total{cpu,mode}` (counter) | `total = Σ todas las series` (todas las CPU y modos); `idle = Σ series con mode="idle"`; entre dos fotos con `Δt > 0,5 s`: `cpu = clamp(1 − Δidle/Δtotal, 0, 1)` | prometheus.dart:132-136, 235-241 |
| RAM % | `node_memory_MemTotal_bytes`, `node_memory_MemAvailable_bytes` (gauges, 1.ª serie) | `clamp((MemTotal − MemAvailable)/MemTotal, 0, 1)`; null si falta o total ≤ 0 | :115-119, 182-183 |
| Disco % | `node_filesystem_size_bytes`, `node_filesystem_avail_bytes` | Se elige el filesystem **más grande** cuyo `fstype` no contenga `tmpfs` ni sea `overlay`; `avail` del mismo `mountpoint`; `clamp((size − avail)/size, 0, 1)` | :121-125, 144-168 |
| Red bajada / subida (B/s) | `node_network_receive_bytes_total`, `node_network_transmit_bytes_total` | `Σ series con device ≠ "lo"`; `Δbytes/Δt` | :170-176, 242-245 |
| Carga 1 min | `node_load1` | valor crudo (1.ª serie) | :188 |
| Reinicio de contadores | — | si `Δ < 0` (reinicio del servidor) se descarta ese delta (null), nunca se pinta una tasa absurda | :270-274 |
| Historia | — | 60 puntos por serie (con sondeo cada 10 s = 10 min) | :219, 276-279; resumen/controlador.dart:45 |

Sondeo en KUADRA: métricas cada **10 s**, estado general cada **30 s** [KUADRA: modulos/resumen/controlador.dart:44-45]. La doc oficial pide **60 s** [verificado: telemetry/metrics]. Con el límite de 120 req/min por endpoint, 1 lectura cada 30-60 s por proyecto sobra.

Mejoras al portar:
- **Disco:** preferir `mountpoint="/data"`; el panel oficial lo usa (`node_filesystem_size_bytes{mountpoint="/data",fstype!="rootfs"}`) y en la muestra conviven `/` y `/data` [verificado: grafana/dashboard.json y metrics.md de supabase-grafana]. Usar la heurística de KUADRA solo como respaldo. Para confirmar, `GET /config/disk/util` da `fs_used_bytes/fs_size_bytes` directamente.
- **CPU:** el modo `iowait` cuenta como ocupado en la fórmula de KUADRA (igual que "CPU Busy" del panel oficial: `100 − avg(rate(idle))·100`). Conviene sacar aparte `iowait% = Δiowait/Δtotal`: separa "CPU real" de "esperando disco".
- **Serverless:** guardar la foto anterior (contadores crudos + `ts`) por proyecto en la tabla `metricas_ultima_foto`. Sin eso, cada invocación es "primera foto" y CPU y red salen null.

### 4.3 Catálogo "métrica → fuente → fórmula → umbral sugerido"

Fuente por defecto: Prometheus vía `GET /analytics/endpoints/metrics` (PAT Logs: Read). "Δ" = diferencia entre dos fotos; "rate" = Δ/Δt. Umbrales: los de KUADRA donde existen; los de Supabase donde los publica; el resto son **heurísticas nuestras** (marcadas H) para calibrar en la demo. "Durante" = la condición debe sostenerse ese tiempo antes de alertar; lo decide el motor de reglas, no el modelo (decisión de parte5).

| # | Métrica | Series / fuente | Fórmula | Aviso | Crítico | Origen del umbral |
|---|---|---|---|---|---|---|
| M1 | CPU % | `node_cpu_seconds_total` | `1 − Δidle/Δtotal` | ≥ 80 % durante 5 min | ≥ 95 % durante 5 min | H |
| M2 | CPU iowait % | ídem, `mode="iowait"` | `Δiowait/Δtotal` | ≥ 20 % durante 5 min | ≥ 40 % | H |
| M3 | Núcleos | ídem | `count(distinct label cpu)` | — | — | panel oficial "CPU Cores" |
| M4 | Carga normalizada | `node_load5` | `node_load5 / núcleos × 100` | ≥ 100 % durante 10 min | ≥ 200 % | H (fórmula del panel oficial) |
| M5 | RAM % | `node_memory_MemTotal_bytes`, `..._MemAvailable_bytes` | `(Total − Available)/Total` | ≥ 85 % | ≥ 95 % | H |
| M6 | Swap usado | `node_memory_SwapTotal_bytes − node_memory_SwapFree_bytes` | bytes | > 0 creciendo 15 min | > 50 % del swap | H |
| M7 | Disco % | `node_filesystem_*{mountpoint="/data"}` o `/config/disk/util` | `(size − avail)/size` | ≥ 80 % | ≥ 90 % | **KUADRA** `UmbralesResumen(discoAviso 0.8, discoMal 0.9)` |
| M8 | Tamaño BD vs plan | `pg_database_size_mb` | `MB / límite_plan` (Nano/Free: 500 MB recomendado) | ≥ 80 % | ≥ 95 % | KUADRA `baseLimiteMb=500`; tabla de cómputo [verificado: https://supabase.com/docs/guides/platform/compute-and-disk] |
| M9 | Crecimiento BD | `pg_database_size_mb` | `(ahora − hace 12 h)/hace 12 h` | > 20 % en 12 h | — | **Supabase** alerta de ejemplo [verificado: https://github.com/supabase/supabase-grafana/blob/main/docs/example-alerts.md] |
| M10 | WAL | `pg_wal_size_mb` | MB | > 1024 (supera `max_wal_size` por defecto de 1 GB) | > 2048 | doc tamaño BD [verificado: https://supabase.com/docs/guides/platform/database-size] + H |
| M11 | Conexiones % | `connection_stats_connection_count{username}` (Σ) / `max_connections_connection_count` | Σ/max | ≥ 80 % | ≥ 95 % | H; tope por cómputo: Nano/Micro 60, Small 90, Medium 120, Large 160, XL 240 [verificado: compute-and-disk] |
| M12 | Conexiones por rol | `connection_stats_connection_count{username="authenticator"\|"other"…}` | serie por `username` | `authenticator` > 50 % del max | — | H (PostgREST acaparando) |
| M13 | Backends | `pg_stat_database_num_backends` | gauge | igual que M11 | | panel oficial "Client connections" |
| M14 | Clientes esperando en pooler | `pgbouncer_pools_client_waiting_connections` (Σ) / `supavisor_connections_active` | gauge | > 0 durante 2 min | > 10 | H |
| M15 | Pool PostgREST | `pgrst_db_pool_waiting`, `pgrst_db_pool_timeouts_total` | gauge / rate | waiting > 0 durante 2 min | rate(timeouts) > 0 | H |
| M16 | Base caída | `pg_up` | `== 0` | — | durante 5 min | **Supabase** alerta de ejemplo [verificado] |
| M17 | Réplica atrasada | `physical_replication_lag_physical_replication_lag_seconds` | `> 600 y creciendo` | durante 5 min | — | **Supabase** alerta de ejemplo [verificado] |
| M18 | Cache hit % | `pg_stat_database_blks_hit_total`, `..._blks_read_total` | `Δhit/(Δhit+Δread)` | < 99 % | < 95 % | H [no verificado: el 99 % es costumbre del sector] |
| M19 | Deadlocks | `pg_stat_database_deadlocks_total` | rate | > 0 | > 1/min | H |
| M20 | Tasa de rollback | `pg_stat_database_xact_rollback_total`, `..._xact_commit_total` | `Δrb/(Δrb+Δcommit)` | > 5 % | > 20 % | H |
| M21 | Ficheros temporales | `pg_stat_database_temp_bytes_total` | rate B/s | > 0 sostenido 10 min | > 10 MB/s | H (consultas sin índice o `work_mem` corto) |
| M22 | Throughput de disco | `node_disk_read_bytes_total` + `node_disk_written_bytes_total`, `device=~"[a-z]+\|nvme[0-9]+n[0-9]+\|mmcblk[0-9]+"` | rate B/s vs base por cómputo | ≥ 80 % de la base durante 10 min | ≥ 100 % (se gasta el presupuesto de ráfaga) | base: Nano 5, Micro 11, Small 22, Medium 39, Large 79 MB/s [verificado: compute-and-disk] |
| M23 | IOPS | `node_disk_reads_completed_total` + `node_disk_writes_completed_total` | rate | ≥ 80 % de la base | ≥ 100 % | base: Nano 250, Micro 500, Small 1000, Medium 2000, Large 3600 IOPS [verificado] |
| M24 | Disco ocupado | `node_disk_io_time_seconds_total` | rate (fracción de tiempo) | ≥ 0,8 | ≥ 0,95 | H (panel oficial "I/O Utilization") |
| M25 | Consultas por segundo | `supabase_usage_metrics_user_queries_total` | rate | > 3× la media móvil de 1 h | > 10× | H, **señal de abuso o DDoS contra la BD** |
| M26 | Registros de usuarios | `auth_users_user_count` | Δ en 10 min | > 5× la media horaria | > 20× | H, **señal de bots creando cuentas** |
| M27 | Suscripciones Realtime | `realtime_postgres_changes_total_subscriptions` | gauge | > 3× la media de 1 h | — | H |
| M28 | Reinicios de Postgres | `postgresql_restarts_total` | Δ | > 0 | > 1 en 1 h | H |
| M29 | Peticiones por servicio | `usage.api-counts` → `total_rest_requests`, `total_auth_requests`, `total_storage_requests`, `total_realtime_requests` (intervalo 15 min) | serie temporal | > 3× la mediana de 24 h | > 10× | H (complementa a Cloudflare, R05) |

Las series M11-M15 y M25-M28 aparecen en la lista oficial de series exportadas [verificado: https://github.com/supabase/supabase-grafana/blob/main/metrics.md]. Las `supavisor_*` solo aparecen en el panel oficial (`grafana/dashboard.json`) [verificado] y no en esa lista: comprobar en el proyecto de demo si salen [no verificado]. El endpoint está en beta, así que nombres y etiquetas pueden cambiar [verificado: telemetry/metrics].

### 4.4 Respuesta de ejemplo (recortada, formato real)

```text
# TYPE node_cpu_seconds_total counter
node_cpu_seconds_total{supabase_project_ref="abcdefghijklmnopqrst",service_type="db",cpu="0",mode="idle"} 81234.5
node_cpu_seconds_total{supabase_project_ref="abcdefghijklmnopqrst",service_type="db",cpu="0",mode="iowait"} 312.1
node_memory_MemTotal_bytes{supabase_project_ref="abcdefghijklmnopqrst",service_type="db"} 1.0213e+09
node_filesystem_size_bytes{...,device="/dev/nvme1n1",fstype="ext4",mountpoint="/data"} 8.4e+09
connection_stats_connection_count{...,service_type="postgresql",server="localhost:5432",username="authenticator"} 7
max_connections_connection_count{...,service_type="postgresql",server="localhost:5432"} 60
pg_database_size_mb{...,service_type="postgresql",server="localhost:5432"} 143
```
Nombres y etiquetas tomados de la muestra oficial; los valores son ilustrativos.

## 5. Salud de servicios (sustituto de `salud.dart`)

KUADRA mide 4 sondas en paralelo con `Stopwatch`; nunca lanza; cada fallo queda como código (`sin_clave`, `red`, `http_503`); 20 s de plazo [KUADRA: salud.dart:49-117]. Las tres sondas HTTP necesitan service_role. Equivalente sin service_role:

`GET /v1/projects/{ref}/health?services=auth,db,pooler,realtime,rest,storage&timeout_ms=2000` (Project Settings: Read). Devuelve `[{name, status: "COMING_UP"|"ACTIVE_HEALTHY"|"UNHEALTHY", healthy (obsoleto), info?, error?}]`; para `realtime` `info` trae `db_connected`, `replication_connected`, `connected_cluster`, y para `auth` trae `{name:"GoTrue", version, description}` [verificado: OpenAPI `V1ServiceHealthResponse_Output`]. `timeout_ms` máx. 10000. Medimos además nuestra latencia de ida y vuelta (como `SondaServicio.ms`) y guardamos `{servicio, ms, status, error, hora}`.

Regla: `UNHEALTHY` en `db` o `rest` 2 lecturas seguidas → crítico (llamada); `COMING_UP` → informativo; `GET /v1/projects/{ref}` con `status` ≠ `ACTIVE_HEALTHY` (`INACTIVE`, `PAUSING`, `RESTORING`…) → aviso [verificado: enum de `status` en OpenAPI]. Si el proyecto no está activo y sano, métricas devuelve 400 ("Project must be active and healthy, or metrics are not available for this project") [verificado: OpenAPI, respuestas de `/analytics/endpoints/metrics`]. Se muestra como "proyecto pausado o sin métricas", no como error de token.

## 6. SQL de catálogo (módulo Supabase: RLS, funciones sin freno, bloat, conexiones)

### 6.0 Advertencia: qué rol ejecuta esto

`POST /v1/projects/{ref}/database/query/read-only` ejecuta "como `supabase_read_only_user`", está en Beta y exige que **toda referencia a entidades lleve esquema** [verificado: OpenAPI]. Ese rol se crea con `login bypassrls` y `grant pg_read_all_data` [verificado: https://github.com/supabase/postgres/blob/develop/migrations/db/init-scripts/00000000000000-initial-schema.sql]. Además tiene `pg_monitor` [verificado: .../migrations/db/migrations/20251001204436_predefined_role_grants.sql] y `default_transaction_read_only = on` [verificado: .../20250710151649_supabase_read_only_user_default_transaction_read_only.sql]. Es decir: **no escribe, pero lee TODOS los datos saltándose RLS** y ve todo `pg_stat_activity` y `pg_stat_statements`.

Reglas para nuestro backend:
1. Solo las consultas fijas de esta sección (lista blanca en servidor, con id). **El modelo nunca escribe SQL** que llegue a este endpoint, porque una inyección de instrucciones podría sacar datos.
2. Solo catálogo y estadísticas, nunca `select` sobre tablas del cliente.
3. El texto de las consultas (`pg_stat_activity.query`, `pg_stat_statements.query`) puede llevar literales con datos personales. Antes de guardarlo o mandarlo a Claude, sustituir los literales por `?` (regex sobre `'…'` y números).
4. Sin Database: Read, el módulo funciona con los **advisors** (§7), que cubren RLS, índices y claves filtradas.

Respuesta: `201` sin esquema declarado en el OpenAPI; se espera un array de filas JSON [no verificado: confirmar con `select 1 as ok`]. El cuerpo admite `parameters: []` [verificado: esquema `V1ReadOnlyQueryBody`], pero no está documentado cómo enlaza arrays [no verificado]. Para la lista de esquemas, validar cada nombre con `/^[a-z_][a-z0-9_]{0,62}$/` e insertarlo como literal. `pg_catalog` se busca siempre de forma implícita, así que sus vistas y funciones no necesitan prefijo [verificado: https://www.postgresql.org/docs/current/ddl-schemas.html#DDL-SCHEMAS-CATALOG]; aun así se prefija para cumplir la regla del endpoint.

`{{esquemas}}` = esquemas expuestos por la Data API, de `GET /postgrest` → `db_schema` (string separado por comas, p. ej. `public,graphql_public`) [verificado: OpenAPI `PostgrestConfigWithJWTSecretResponse_Output`; el mismo objeto trae `max_rows`, `db_pool` y `jwt_secret`], convertidos a `'public','graphql_public'`.

### 6.1 Tablas sin RLS y expuestas a `anon` (crítico)

```sql
select n.nspname as esquema, c.relname as tabla,
       c.relrowsecurity as rls_activa, c.relforcerowsecurity as rls_forzada,
       (select count(*) from pg_catalog.pg_policies p
         where p.schemaname = n.nspname and p.tablename = c.relname) as politicas,
       pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') as anon_lee,
       pg_catalog.has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE') as anon_escribe,
       c.reltuples::bigint as filas_estimadas
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r','p') and n.nspname in ({{esquemas}})
order by c.relrowsecurity, anon_lee desc, n.nspname, c.relname;
```
Severidad: `rls_activa=false` y `anon_lee` → **CRÍTICO** (lint `rls_disabled_in_public`); `rls_activa=false` y solo `authenticated` → ALTO; `rls_activa=true` y `politicas=0` → INFO (todo bloqueado, lint `rls_enabled_no_policy`).

### 6.2 Políticas permisivas de más

```sql
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_catalog.pg_policies
where schemaname in ({{esquemas}})
  and (qual = 'true' or with_check = 'true')
  and roles && array['anon','public']::name[];
```
`using (true)` para `anon` en una tabla con datos de usuarios = ALTO. Que la tabla sea de catálogo público lo confirma el dueño ("aceptar con motivo", como hace KUADRA con `crm_invariante_aceptar`).

### 6.3 Funciones RPC expuestas ("funciones sin freno de tasa")

```sql
select n.nspname as esquema, p.proname as funcion,
       pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer,
       case p.provolatile when 'v' then 'volatile' when 's' then 'stable' else 'immutable' end as volatilidad,
       pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_ejecuta,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_ejecuta,
       p.proconfig as config
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname in ({{esquemas}}) and p.prokind = 'f'
  and not exists (select 1 from pg_catalog.pg_depend d where d.objid = p.oid and d.deptype = 'e')
order by anon_ejecuta desc, security_definer desc, funcion;
```
Reglas: `anon_ejecuta` + `volatile` → "RPC pública que puede escribir, sin freno" (ALTO); + `security_definer` → CRÍTICO; `security_definer` sin `search_path` en `config` → lint `function_search_path_mutable`. Se suma `GET /functions` con `verify_jwt=false` → "edge function pública". Supabase no trae freno de tasa nativo por RPC ni por edge function [no verificado]. La corrección propuesta es un prompt para añadir un freno: una tabla de contadores por IP o usuario, como el `freno` de KUADRA, que es suyo y vive en su base [KUADRA: modulos/freno/servicio.dart:1-15].

### 6.4 Conexiones (complementa M11)

```sql
select coalesce(usename::text, '(sistema)') as usuario, coalesce(application_name, '') as app,
       coalesce(state, '') as estado, count(*) as n,
       max(now() - state_change) filter (where state = 'idle in transaction') as max_idle_tx,
       max(now() - query_start) filter (where state = 'active') as max_activa
from pg_catalog.pg_stat_activity
where backend_type = 'client backend'
group by 1, 2, 3 order by n desc;
```
`idle in transaction` > 5 min → aviso (retiene bloqueos y frena el vacuum) [H].

### 6.5 Consultas largas (cuello de botella en vivo)

```sql
select pid, usename, state, now() - query_start as duracion, wait_event_type, wait_event,
       left(query, 200) as consulta
from pg_catalog.pg_stat_activity
where backend_type = 'client backend' and state <> 'idle'
  and now() - query_start > interval '30 seconds'
order by duracion desc limit 20;
```

### 6.6 Tablas hinchadas (bloat por tuplas muertas)

```sql
select schemaname as esquema, relname as tabla, n_live_tup as vivas, n_dead_tup as muertas,
       round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) as pct_muertas,
       pg_catalog.pg_total_relation_size(relid) as bytes_total,
       last_autovacuum, last_autoanalyze, seq_scan, idx_scan
from pg_catalog.pg_stat_user_tables
order by n_dead_tup desc limit 25;
```
Aviso: `pct_muertas > 20` y `muertas > 10000`; alto: `pct_muertas > 50` o `last_autovacuum` nulo con muchas escrituras [H]. Hay estimación de bloat más fina con `supabase inspect db bloat` [verificado: https://supabase.com/docs/guides/database/inspect], pero exige conexión directa: no la usamos.

### 6.7 Índices: faltantes, sin uso y duplicados

```sql
-- Escaneos secuenciales en tablas grandes (índice que falta)
select schemaname, relname, seq_scan, seq_tup_read, idx_scan, n_live_tup,
       round(seq_tup_read::numeric / nullif(seq_scan, 0)) as filas_por_seq
from pg_catalog.pg_stat_user_tables
where n_live_tup > 10000 and seq_scan > coalesce(idx_scan, 0)
order by seq_tup_read desc limit 20;

-- Índices que nunca se usan (ocupan disco y frenan escrituras)
select s.schemaname, s.relname as tabla, s.indexrelname as indice, s.idx_scan,
       pg_catalog.pg_relation_size(s.indexrelid) as bytes
from pg_catalog.pg_stat_user_indexes s
join pg_catalog.pg_index i on i.indexrelid = s.indexrelid
where s.idx_scan = 0 and not i.indisunique and not i.indisprimary
order by bytes desc limit 20;
```
Duplicados y FK sin índice ya los da el advisor de rendimiento (`duplicate_index`, `unindexed_foreign_keys`, `unused_index`): no se reimplementan.

### 6.8 Cache hit, tamaño y consultas más caras

```sql
select round(100.0 * sum(heap_blks_hit) / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2) as pct_cache_tablas,
       round(100.0 * sum(idx_blks_hit)  / nullif(sum(idx_blks_hit)  + sum(idx_blks_read), 0), 2)  as pct_cache_indices,
       pg_catalog.pg_database_size(current_database()) as bytes_bd
from pg_catalog.pg_statio_user_tables;

select queryid, calls, round(total_exec_time::numeric, 1) as total_ms,
       round(mean_exec_time::numeric, 1) as media_ms, rows, left(query, 300) as consulta
from extensions.pg_stat_statements
order by total_exec_time desc limit 15;
```
Que `pg_stat_statements` viva en el esquema `extensions` en todo proyecto es [no verificado]. Si falla, leer `pg_catalog.pg_extension` + `pg_namespace` para saber dónde está. KUADRA tiene un panel "Consultas más lentas" sobre `pg_stat_statements` [KUADRA: modulos/base_datos/modelos.dart:67]; el detalle lo cubre R02.

## 7. Advisors: hallazgos gratis de Supabase

`GET /advisors/security` y `GET /advisors/performance` (experimentales; Advisors: Read). Respuesta `{lints: [{name, title, level: ERROR|WARN|INFO, facing: EXTERNAL, categories: [PERFORMANCE|SECURITY|HEALTH], description, detail, remediation, metadata: {schema, name, entity, type, fkey_name, fkey_columns}, cache_key, observed_at}]}` [verificado: OpenAPI `V1ProjectAdvisorsResponse_Output`]. `remediation` trae enlace o texto de arreglo: lo pasamos a Claude para generar el prompt de corrección.

Valores de `name` en el enum, agrupados por módulo nuestro [verificado: OpenAPI]:

| Módulo | Lints |
|---|---|
| RLS y exposición | `rls_disabled_in_public`, `rls_enabled_no_policy`, `policy_exists_rls_disabled`, `multiple_permissive_policies`, `auth_rls_initplan`, `rls_references_user_metadata`, `auth_users_exposed`, `security_definer_view`, `materialized_view_in_api`, `foreign_table_in_api` |
| Funciones | `function_search_path_mutable`, `extension_in_public` |
| Índices y rendimiento | `unindexed_foreign_keys`, `unused_index`, `duplicate_index`, `no_primary_key` |
| Auth | `auth_otp_long_expiry`, `auth_otp_short_length`, `password_requirements_min_length`, `auth_leaked_password_protection`, `auth_insufficient_mfa_options`, `auth_password_policy_missing` |
| Infra y red | `ssl_not_enforced`, `network_restrictions_not_set`, `log_connections_not_enabled`, `pitr_not_enabled`, `no_backup_admin`, `vulnerable_postgres_version` |
| Secretos | `leaked_service_key` |
| Salud en vivo (categoría HEALTH) | `db_not_reachable`, `db_connection_failing`, `db_connection_limit_reached`, `instance_telemetry_lost`, `instance_db_down`, `instance_alert_firing`, `log_data_api_error_rate_high`, `log_auth_error_rate_high`, `log_storage_error_rate_high`, `log_edge_function_error_rate_high`, `realtime_authorization_timeouts`, `realtime_postgres_changes_spike`, `project_not_active`, `advisor_check_unavailable` |

Los lints de HEALTH (`db_connection_limit_reached`, `log_auth_error_rate_high`, `realtime_postgres_changes_spike`…) son **detecciones de tiempo real que hace Supabase** y que podemos convertir en alerta sin calcular nada. Deduplicar por `cache_key`.

## 8. Claves: cómo las valida y guarda KUADRA, y qué hacemos nosotros

### 8.1 Lo que hace KUADRA (y si se porta)

| Mecanismo | Detalle | Fuente | ¿Portar? |
|---|---|---|---|
| Prefijo obligatorio | `prefijoTokenLectura = 'sbp_fc'`; `validarTokenLectura` → `null` (vale; vacío = sin token), `'espacios'` o `'prefijo'` | config.dart:23, 51-57 | **Sí** |
| Caracteres prohibidos | `caracterNoValidoEnSecreto = /[^\x21-\x7E]/`: todo lo que no sea ASCII visible (blancos, CR/LF, tab, U+200B, U+FEFF, acentos). Única fuente para todos los validadores | config.dart:29-33 | **Sí** (evita inyección de cabeceras y fugas) |
| Máscara | `'sbp_fc…' + últimos 4`; sin prefijo o corto → `'…' + últimos 4`; ≤ 4 caracteres → `'…'` | config.dart:37-47 | **Sí** (campo `pista`) |
| `toString` seguro | La config nunca imprime contraseña, conexión ni token; solo URL y máscara | config.dart:203-208 | Sí (serializadores con lista blanca) |
| Prueba de permisos | `comprobarPermisos()`: un GET por permiso distinto (primera ruta de cada uno) → `{permiso: código HTTP \| null}`; descarta el cuerpo; sin token lanza `sin_token` sin salir a la red | supabase_gestion_api.dart:267-286 | **Sí** (botón "Probar conexión") |
| Prueba rápida | `probarLectura()` = `GET /functions`; error → `http_<estado>` o el código | modulos/ajustes/servicio.dart:95-108 | Sí, con `GET /` del proyecto |
| Estado de validación | `ResultadoClave{ok, hora, error}` por credencial; en memoria, nunca el valor; `olvidar()` al cambiar claves | estado_claves.dart:17-86 | Sí, **persistido** (tabla) |
| Almacenamiento | `%APPDATA%\KUADRA CRM\config.json` **en claro**; escritura atómica (`.tmp` + `rename`), cola para no pisar escrituras concurrentes, `danada` impide sobrescribir un JSON ilegible, conserva claves desconocidas (`_crudo`) | config.dart:98-318 | **No** el almacenamiento; sí la idea de "no pisar lo que no entiendo" |

### 8.2 Corrección del orquestador: validada

Un hash (SHA-256, bcrypt, argon2) es **irreversible**: el sistema no podría recuperar el token para llamar a `api.supabase.com` o a Cloudflare. Hace falta **cifrado reversible autenticado**, y el HMAC con pimienta queda solo como **huella**. Supabase Vault ya cifra con AEAD (libsodium), y su clave la gestiona Supabase fuera de la base: un volcado de la base no la contiene [verificado: https://supabase.com/docs/guides/database/vault]. API: `vault.create_secret(secreto, nombre_unico, descripcion)` → uuid; `vault.update_secret(id, …)`; lectura por la vista `vault.decrypted_secrets` (misma página).

Diseño recomendado (cifrado de sobre en Node, KEK y pimienta en Vault):

1. En Vault de **nuestro** proyecto, dos secretos: `kek_v1` (32 bytes aleatorios en base64) y `pimienta_v1` (32 bytes). Los lee solo el servidor (route handler o función de Vercel) con nuestra service_role, que vive en variables de entorno del servidor y nunca en el navegador. Esto encaja con parte5 §2.1: service_role solo en nuestro proyecto y solo del lado del servidor. Se cachean en memoria del proceso mientras dura la instancia.
2. Por credencial: DEK aleatoria de 32 bytes → `AES-256-GCM(DEK, iv 12 B, AAD)` sobre el token. La DEK se envuelve con `AES-256-GCM(KEK, iv 12 B, AAD)`. **AAD** = `${org_id}:${proveedor}:${credencial_id}`: ata el cifrado a su fila, y un cifrado copiado a otro tenant no descifra.
3. Huella = `HMAC-SHA256(pimienta, token_normalizado)` en hex. Sirve para deduplicar (`unique(org_id, proveedor, huella)`), para comprobar "¿es la misma clave?" sin descifrar y para que el escáner de repos detecte "esta clave filtrada en tu código es la que nos diste".
4. Rotación: columna `version_kek`; rotar = reenvolver DEKs, sin tocar los tokens.
5. El token **nunca vuelve al navegador**: tras guardarlo, la UI solo ve `pista` (`sbp_fc…a1b2`), permisos y estado. Se descifra solo dentro de la función que llama a la API y no se registra jamás.
6. RLS en `credenciales`: ningún `select` para `authenticated` sobre columnas cifradas; el cliente ve una vista sin ellas.

Tabla (columnas base64 en `text` para no pelear con `bytea` desde supabase-js):

```sql
create table public.credenciales (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizaciones(id) on delete cascade,
  proveedor text not null check (proveedor in ('supabase','cloudflare','github','vercel')),
  ref_recurso text,                 -- project ref, zone id, repo
  cifrado text not null,            -- base64(iv | tag | ct)
  dek_envuelta text not null,       -- base64(iv | tag | dek_ct)
  version_kek int not null default 1,
  huella text not null,             -- hex HMAC-SHA256(pimienta, token)
  pista text not null,              -- 'sbp_fc…a1b2'
  permisos jsonb not null default '{}'::jsonb,  -- {"Logs":200,"Database":403,...}
  ultimo_ok_en timestamptz, ultimo_error text,  -- 'http_403','red','plazo'
  creada_en timestamptz not null default now(),
  unique (org_id, proveedor, huella)
);
alter table public.credenciales enable row level security;
```

Atajo de esfuerzo S, si el tiempo aprieta: guardar cada token directamente con `vault.create_secret` y en nuestra tabla solo el `secret_id`. Tiene un coste: el descifrado ocurre en SQL (el token sale en el resultado de una consulta) y el aislamiento por tenant depende solo de RLS y de funciones `security definer`. El de sobre es M y se defiende mejor ante un jurado técnico.

## 9. Errores de red y reintentos

### 9.1 Qué hace KUADRA

- **Sin reintentos** en el núcleo: cada llamada es un intento con `timeout`. El "reintento" es el refresco periódico (`Refresco` cada 10 s las métricas y cada 30 s el resto) [KUADRA: modulos/resumen/controlador.dart:44-45, 113-123].
- Plazos: Management 8 s (cliente diario) o 30 s (cliente explícito); REST/RPC 20 s; subida 60 s; sondas 20 s [KUADRA: supabase_gestion_api.dart:54,66; supabase_api.dart:68,72; salud.dart:54].
- Códigos de `ErrorGestion`: `sin_token` · `ref` · `red` · `plazo` · `http` (+ `estado`) · `forma`. **Nunca** llevan el cuerpo ni el token [KUADRA: supabase_gestion_api.dart:21-35].
- `motivoDeRed(e)` traduce el **tipo** de excepción: `TimeoutException`→"tiempo agotado", `FormatException`→"clave o token no válidos", TLS→"fallo de TLS", Socket/Http/ClientException→"sin conexión". Motivo: `dart:io` rechaza una cabecera con un carácter invisible lanzando un error **cuyo mensaje lleva el valor de la cabecera, es decir, el secreto** [KUADRA: error_red.dart:1-27].
- Lo que no se reconoce se muestra crudo: "un código feo es mejor que una explicación inventada" [KUADRA: errores_base.dart:6-8].
- Storage: traducción 415/413/401-403/404/409 a frases accionables [KUADRA: supabase_api.dart:206-243].
- Sondas y acciones **nunca lanzan**: el fallo queda como `{ok:false, error:código}` [KUADRA: salud.dart:47-48; acciones.dart:16-19].
- 403 en la Management API = "falta ESE permiso", nunca "token roto" [KUADRA: supabase_gestion_api.dart:80-82].

### 9.2 Política para nuestro backend (TypeScript)

| Situación | Acción |
|---|---|
| Error de red, `AbortError`/`TimeoutError`, 500, 502, 503, 504 | Reintentar hasta 3 veces: espera `500 ms · 2^i` + azar 0-250 ms |
| 429 | Esperar `Retry-After` si viene [no verificado que Supabase lo mande]; si no, hasta el próximo minuto (el límite se reinicia por minuto [verificado: Management API intro]) |
| 400 en métricas | Estado `proyecto_no_activo`, sin reintento |
| 401 | Token revocado o caducado: marcar credencial `invalida`, avisar una vez y no reintentar |
| 403 | Falta permiso: guardar en `permisos` y mostrar cuál falta |
| 410 | Endpoint retirado (p. ej. `logs.all`): error de programación, registrar |
| N fallos seguidos (p. ej. 5) | Integración `degradada`: el motor de reglas decide si alerta; no se reintenta en bucle |

Plazos: 8 s para la Management API (lecturas JSON), 15 s para métricas, 20 s para SQL de solo lectura. En Node, **no interpolar `err.message`**: decidir por `err.name` y `err.cause?.code` (`ECONNREFUSED`, `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`, `ENOTFOUND`). Si undici incluye el valor de la cabecera en el mensaje cuando la cabecera es inválida es [no verificado]: se trata como si lo incluyera. La validación `/[^\x21-\x7E]/` al guardar evita llegar a ese caso.

## 10. Fragmentos portados a TypeScript (Node 20+, sin dependencias)

### 10.1 Parser Prometheus (port de `parsearPrometheus`)

```ts
export type Muestra = { etiquetas: Record<string, string>; valor: number };
export type Prom = Map<string, Muestra[]>;

function numero(s: string): number | null {
  if (s === '+Inf') return Infinity;            // JS: Number('+Inf') === NaN
  if (s === '-Inf') return -Infinity;
  const v = Number(s);
  return Number.isNaN(v) ? null : v;            // KUADRA descarta NaN
}

function etiquetas(cuerpo: string): Record<string, string> {
  const r: Record<string, string> = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;   // respeta \" y comas dentro
  for (const m of cuerpo.matchAll(re)) {
    r[m[1]] = m[2].replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
  }
  return r;
}

export function parsearPrometheus(texto: string): Prom {
  const out: Prom = new Map();
  for (const cruda of texto.split('\n')) {
    const l = cruda.trim();
    if (!l || l.startsWith('#')) continue;
    let nombre: string, resto: string, et: Record<string, string> = {};
    const a = l.indexOf('{');
    if (a > 0) {
      const c = l.lastIndexOf('}');
      if (c < a) continue;
      nombre = l.slice(0, a); et = etiquetas(l.slice(a + 1, c)); resto = l.slice(c + 1).trim();
    } else {
      const e = l.indexOf(' ');
      if (e < 0) continue;
      nombre = l.slice(0, e); resto = l.slice(e + 1).trim();
    }
    const v = numero(resto.split(/\s+/)[0] ?? '');
    if (v === null) continue;
    (out.get(nombre) ?? out.set(nombre, []).get(nombre)!).push({ etiquetas: et, valor: v });
  }
  return out;
}
```

### 10.2 Foto y cálculo (port de `FotoMetricas` + `CalculadoraMetricas`, con estado persistido)

```ts
export type Foto = {
  ts: number; cpuTotal?: number; cpuIdle?: number; cpuIowait?: number; nucleos?: number;
  ramTotal?: number; ramDisp?: number; discoTotal?: number; discoLibre?: number;
  rx?: number; tx?: number; conexiones?: number; maxConexiones?: number;
  blksHit?: number; blksRead?: number; bdMb?: number; walMb?: number; consultas?: number; usuarios?: number;
};
const suma = (xs?: Muestra[], f: (m: Muestra) => boolean = () => true) =>
  xs && xs.some(f) ? xs.filter(f).reduce((s, m) => s + m.valor, 0) : undefined;
const primera = (p: Prom, n: string) => p.get(n)?.[0]?.valor;

export function foto(p: Prom, ts = Date.now()): Foto {
  const cpu = p.get('node_cpu_seconds_total');
  const fs = p.get('node_filesystem_size_bytes') ?? [];
  const datos = fs.find(f => f.etiquetas.mountpoint === '/data')
    ?? fs.filter(f => !(f.etiquetas.fstype ?? '').includes('tmpfs') && f.etiquetas.fstype !== 'overlay')
         .sort((a, b) => b.valor - a.valor)[0];                      // respaldo KUADRA
  const libre = p.get('node_filesystem_avail_bytes')?.find(f => f.etiquetas.mountpoint === datos?.etiquetas.mountpoint);
  const noLo = (m: Muestra) => m.etiquetas.device !== 'lo';
  return {
    ts, cpuTotal: suma(cpu), cpuIdle: suma(cpu, m => m.etiquetas.mode === 'idle'),
    cpuIowait: suma(cpu, m => m.etiquetas.mode === 'iowait'),
    nucleos: cpu ? new Set(cpu.map(m => m.etiquetas.cpu)).size : undefined,
    ramTotal: primera(p, 'node_memory_MemTotal_bytes'), ramDisp: primera(p, 'node_memory_MemAvailable_bytes'),
    discoTotal: datos?.valor, discoLibre: libre?.valor,
    rx: suma(p.get('node_network_receive_bytes_total'), noLo), tx: suma(p.get('node_network_transmit_bytes_total'), noLo),
    conexiones: suma(p.get('connection_stats_connection_count')), maxConexiones: primera(p, 'max_connections_connection_count'),
    blksHit: suma(p.get('pg_stat_database_blks_hit_total')), blksRead: suma(p.get('pg_stat_database_blks_read_total')),
    bdMb: primera(p, 'pg_database_size_mb'), walMb: primera(p, 'pg_wal_size_mb'),
    consultas: primera(p, 'supabase_usage_metrics_user_queries_total'), usuarios: primera(p, 'auth_users_user_count'),
  };
}

const delta = (a?: number, b?: number) => (a == null || b == null || a - b < 0 ? undefined : a - b); // reinicio → descarta
const frac = (x: number) => Math.min(1, Math.max(0, x));

/** `ant` sale de la tabla metricas_ultima_foto (serverless: no hay memoria entre invocaciones). */
export function calcular(f: Foto, ant?: Foto) {
  const r: Record<string, number | undefined> = {
    ram: f.ramTotal && f.ramDisp != null ? frac((f.ramTotal - f.ramDisp) / f.ramTotal) : undefined,
    disco: f.discoTotal && f.discoLibre != null ? frac((f.discoTotal - f.discoLibre) / f.discoTotal) : undefined,
    conexiones: f.conexiones != null && f.maxConexiones ? f.conexiones / f.maxConexiones : undefined,
  };
  const dt = ant ? (f.ts - ant.ts) / 1000 : 0;
  if (ant && dt > 0.5) {
    const dT = delta(f.cpuTotal, ant.cpuTotal), dI = delta(f.cpuIdle, ant.cpuIdle), dW = delta(f.cpuIowait, ant.cpuIowait);
    if (dT && dI != null) r.cpu = frac(1 - dI / dT);
    if (dT && dW != null) r.iowait = frac(dW / dT);
    const dRx = delta(f.rx, ant.rx), dTx = delta(f.tx, ant.tx);
    if (dRx != null) r.bajadaBps = dRx / dt;
    if (dTx != null) r.subidaBps = dTx / dt;
    const dH = delta(f.blksHit, ant.blksHit), dR = delta(f.blksRead, ant.blksRead);
    if (dH != null && dR != null && dH + dR > 0) r.cacheHit = dH / (dH + dR);
    const dQ = delta(f.consultas, ant.consultas);
    if (dQ != null) r.qps = dQ / dt;
  }
  return r;
}
```

### 10.3 Cliente de la Management API con permisos, reintento y códigos (port de `SupabaseGestionApi`)

```ts
const REF = /^[a-z]{20}$/;
const CAMINO = /^(\/[A-Za-z0-9._\-]+)*$/;
export const PREFIJO_PAT = 'sbp_fc';
export const NO_VALIDO = /[^\x21-\x7E]/;

export function validarPat(t: string): null | 'vacio' | 'espacios' | 'prefijo' {
  const s = t.trim();
  if (!s) return 'vacio';
  if (NO_VALIDO.test(s)) return 'espacios';
  return s.startsWith(PREFIJO_PAT) ? null : 'prefijo';
}
export const pista = (t: string) => {
  const s = t.trim();
  if (s.startsWith(PREFIJO_PAT) && s.length - PREFIJO_PAT.length > 4) return `${PREFIJO_PAT}…${s.slice(-4)}`;
  return s.length <= 4 ? '…' : `…${s.slice(-4)}`;
};
export const refDeUrl = (url: string) => /^https?:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url.trim())?.[1] ?? null;

export class ErrorGestion extends Error {
  constructor(public codigo: 'sin_token' | 'ref' | 'red' | 'plazo' | 'http' | 'forma', public estado?: number) {
    super(`ErrorGestion(${codigo}${estado ? ' ' + estado : ''})`);   // nunca cuerpo ni token
  }
}

export async function gestion(ref: string, token: string, ruta: string,
  { accept = 'application/json', plazoMs = 8000, intentos = 3, metodo = 'GET', cuerpo }:
  { accept?: string; plazoMs?: number; intentos?: number; metodo?: 'GET' | 'POST'; cuerpo?: unknown } = {}) {
  if (validarPat(token) !== null) throw new ErrorGestion('sin_token');
  if (!REF.test(ref)) throw new ErrorGestion('ref');
  const [camino, consulta] = ruta.split('?');
  if (!CAMINO.test(camino) || camino.split('/').some(s => s === '.' || s === '..')) throw new Error('ruta');
  const url = `https://api.supabase.com/v1/projects/${ref}${camino}${consulta ? '?' + consulta : ''}`;
  for (let i = 0; ; i++) {
    let r: Response;
    try {
      r = await fetch(url, {
        method: metodo, signal: AbortSignal.timeout(plazoMs),
        headers: { Authorization: `Bearer ${token}`, Accept: accept, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      });
    } catch (e: any) {
      const codigo = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'plazo' : 'red';
      if (i + 1 < intentos) { await espera(i); continue; }
      throw new ErrorGestion(codigo);
    }
    if ([429, 500, 502, 503, 504].includes(r.status) && i + 1 < intentos) {
      const ra = Number(r.headers.get('retry-after'));
      await espera(i, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined); continue;
    }
    if (r.status < 200 || r.status >= 300) throw new ErrorGestion('http', r.status);
    if (accept !== 'application/json') return await r.text();       // métricas: texto Prometheus
    const t = await r.text();
    if (!t) return null;
    try { return JSON.parse(t); } catch { throw new ErrorGestion('forma', r.status); }
  }
}
const espera = (i: number, ms?: number) =>
  new Promise(res => setTimeout(res, ms ?? 500 * 2 ** i + Math.random() * 250));

/** "Probar conexión": un GET por permiso; 403 = falta ESE permiso (port de comprobarPermisos). */
export async function comprobarPermisos(ref: string, token: string) {
  const salida: Record<string, number | null> = {};
  const porPermiso = new Map<string, string>();
  for (const [ruta, permiso] of Object.entries(PERMISO_POR_RUTA)) if (!porPermiso.has(permiso)) porPermiso.set(permiso, ruta);
  await Promise.all([...porPermiso].map(async ([permiso, ruta]) => {
    try {
      await gestion(ref, token, ruta, { intentos: 1, accept: ruta.includes('/metrics') ? 'text/plain' : 'application/json' });
      salida[permiso] = 200;
    } catch (e) { salida[permiso] = e instanceof ErrorGestion ? (e.estado ?? null) : null; }
  }));
  try { await gestion(ref, token, '/database/query/read-only', { metodo: 'POST', cuerpo: { query: 'select 1 as ok' }, intentos: 1 }); salida['Database'] = 200; }
  catch (e) { salida['Database'] = e instanceof ErrorGestion ? (e.estado ?? null) : null; }
  return salida;   // se guarda en credenciales.permisos y se pinta como checklist
}
```
`Promise.all` cabe en el límite (un endpoint distinto por permiso, 120/min cada uno). KUADRA lo hace en serie; aquí en paralelo para que el botón responda en ~1 s.

### 10.4 Cifrado de sobre y huella (§8.2)

```ts
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const gcm = (clave: Buffer, datos: Buffer, aad: string) => {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', clave, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(datos), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);                 // iv(12) | tag(16) | ct
};
const ungcm = (clave: Buffer, blob: Buffer, aad: string) => {
  const d = createDecipheriv('aes-256-gcm', clave, blob.subarray(0, 12));
  d.setAAD(Buffer.from(aad, 'utf8')); d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]); // lanza si se manipuló
};

export function sellar(token: string, kek: Buffer, aad: string) {
  const dek = randomBytes(32);
  return { cifrado: gcm(dek, Buffer.from(token.trim(), 'utf8'), aad).toString('base64'),
           dek_envuelta: gcm(kek, dek, aad).toString('base64') };
}
export function abrir(fila: { cifrado: string; dek_envuelta: string }, kek: Buffer, aad: string) {
  const dek = ungcm(kek, Buffer.from(fila.dek_envuelta, 'base64'), aad);
  return ungcm(dek, Buffer.from(fila.cifrado, 'base64'), aad).toString('utf8');
}
export const huella = (token: string, pimienta: Buffer) =>
  createHmac('sha256', pimienta).update(token.trim(), 'utf8').digest('hex');
// aad = `${org_id}:${proveedor}:${credencial_id}`; kek y pimienta: vault.decrypted_secrets (solo servidor)
```

### 10.5 Acciones con vista previa (patrón de `acciones.dart`)

`ejecutarAccion(llamar, {rpc, args, por_cada}, {simular, motivo})`: si falta `rpc` devuelve `{ok:false, error:'sin_rpc'}`; añade `p_simular` (vista previa, **simular por defecto en la base**) y `p_motivo`; con `por_cada: {arg: [v1, v2…]}` hace una llamada por valor **en serie** y para en el primer `ok:false`; nunca lanza (fallo → `{ok:false, error:codigo|'red', simulado}`); junta las `chapas` de todas las llamadas [KUADRA: acciones.dart:19-82]. Para nosotros: toda acción propuesta (bloquear IP en Cloudflare, aplicar el SQL de corrección…) pasa por **vista previa → motivo → confirmación → auditoría**. Con Supabase en solo lectura, la acción típica es "copiar prompt o SQL de corrección", no ejecutarla.

## 11. Límites, planes y costos que afectan al diseño

| Tema | Dato | Fuente |
|---|---|---|
| Management API | 120 req/min por usuario × proyecto × endpoint; 429 hasta fin del minuto; los PAT del mismo usuario comparten límite | [verificado: https://supabase.com/docs/reference/api/introduction] |
| Metrics API | Beta, ~200 series, raspado recomendado 60 s, no disponible en self-hosted | [verificado: https://supabase.com/docs/guides/telemetry/metrics] |
| Logs | `/logs`: rango máx. 24 h por consulta, redondeado al minuto; SQL ClickHouse | [verificado: OpenAPI] |
| Retención de logs | Free 1 día, Pro 7 días | benchmark v5 l. 729 (fuente 1F del equipo) [no verificado hoy] |
| Conexiones máx. | Nano/Micro 60 · Small 90 · Medium 120 · Large 160 · XL 240 · 2XL 380 · 4XL 480; pooler: 200/200/400/600/800/1000/1500/3000 | [verificado: compute-and-disk] |
| RAM / BD recomendada | Nano ≤ 0,5 GB / 500 MB · Micro 1 GB / 10 GB · Small 2 GB / 50 GB · Medium 4 GB / 100 GB · Large 8 GB / 200 GB | [verificado: compute-and-disk] |
| IO base | Nano 5 MB/s, 250 IOPS · Micro 11/500 · Small 22/1000 · Medium 39/2000 · Large 79/3600; ráfaga hasta 2XL | [verificado: compute-and-disk] |
| Claves heredadas | `anon`/`service_role` se retiran a fines de 2026 | [verificado: https://supabase.com/docs/guides/getting-started/api-keys] |
| Coste de sondeo | 1 métrica/min + 1 health/min por proyecto = 2.880 llamadas/día, gratis para la cuenta del cliente | cálculo propio; tamaño de la respuesta Prometheus [no verificado: medir en la demo] |

## Implicaciones para el plan

**Adoptar**
- PAT acotado `sbp_fc…` por proyecto como **única** credencial de Supabase en el MVP; el usuario pega URL del proyecto + token. Validación de KUADRA (`/[^\x21-\x7E]/`, prefijo, máscara) y botón **"Probar conexión"** con checklist por permiso (port de `comprobarPermisos`). Esfuerzo **S**.
- Métricas por `GET /analytics/endpoints/metrics` (Logs: Read) con el parser y las fórmulas de KUADRA (§10.1-10.2), disco por `/data`, más `iowait`, conexiones, cache hit y QPS. Persistir la foto anterior en una tabla. Esfuerzo **M**.
- `GET /health` cada 60 s en lugar de las 4 sondas con service_role. **S**.
- Advisors (`/advisors/security` + `/performance`) como primera fuente de hallazgos del botón "Auditar todo": cero SQL propio, `remediation` incluida, deduplicado por `cache_key`. **S**.
- SQL de catálogo (§6) en lista blanca, solo si el usuario concede Database: Read (opcional y con aviso). **M**.
- Errores con códigos cortos y sin cuerpo ni secretos; reintento exponencial para red/429/5xx; 401/403 sin reintento (§9.2). **S**.
- Cifrado de sobre AES-256-GCM con AAD por fila, KEK y pimienta en Vault, huella HMAC (§8.2, §10.4). **M** (S con el atajo de Vault directo).
- Catálogo M1-M29 como semilla del motor de reglas, con "durante X min" para no alertar por picos sueltos; la decisión la toma la regla, no el modelo.

**Evitar**
- Pedir service_role / `sb_secret_…` al cliente (KUADRA la usa para métricas y sondas): ya no hace falta.
- Un `crm_sql` o cualquier vía para que el modelo ejecute SQL arbitrario en la base del cliente: el rol de solo lectura **salta RLS y lee todo**.
- Guardar claves en claro (como `config.json` de KUADRA) o devolverlas al navegador.
- Interpolar mensajes de excepción en textos visibles o logs.
- `logs.all` (410) y depender de campos experimentales sin `try/catch` (advisors y read-only query están en beta).
- PAT "Legacy" de cuenta completa: rechazarlo por prefijo.

**Riesgos**
- Endpoints beta o experimentales (metrics, advisors, read-only query) pueden cambiar de forma: parseo tolerante y validación con un "contrato" mínimo (zod) que degrade a "sin dato".
- Serverless sin estado: sin la tabla de última foto no hay CPU ni red. Necesita un cron (Vercel Cron o pg_cron + Edge Function) que dispare la lectura; frecuencia y límites de Vercel Cron [no verificado], los cubre otra investigación.
- Las respuestas de `/config/auth` y `/postgrest` pueden traer secretos: lista blanca obligatoria antes de guardar o mandar a Claude.
- El límite de 120/min es **por usuario**: si el cliente usa el mismo PAT en otras herramientas, compartimos cupo. Sondear como máximo cada 30-60 s.
- `supavisor_*`, `pg_stat_statements` en `extensions` y la forma de la respuesta de read-only query están [no verificado]: probarlos en el proyecto de demo la primera hora.
- La demo atacando una app propia necesita un proyecto Supabase de prueba con RLS desactivada a propósito y una RPC `volatile` abierta a `anon` para que §6.1 y §6.3 den hallazgos visibles.

**Esfuerzo total del módulo Supabase (backend):** M-L. Orden recomendado: (1) credencial + probar conexión, S; (2) advisors, S; (3) métricas + health + reglas, M; (4) SQL de catálogo, M; (5) cifrado de sobre, M.
