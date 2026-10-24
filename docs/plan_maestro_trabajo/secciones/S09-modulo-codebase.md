## 09. Módulo Codebase (GitHub, ZIP, CVE y secretos)

> **Qué hace.** El usuario conecta **un** repo de GitHub con un token de solo lectura (o sube un ZIP, P1). VanGUARD baja el código a memoria, lo inventaría, detecta el stack, parsea los lockfiles, cruza cada `paquete@versión` con OSV.dev (que agrega GHSA; CVE.org y NVD quedan como referencia), prioriza con CISA KEV (P1) y EPSS (P2), revisa `.gitignore`, `.env` subidos y su historial (P1), busca secretos con reglas tipo gitleaks portadas a JS y entrega hallazgos con su prompt de corrección.
> **Reglas del módulo (de las canónicas §2, §8, §9.2, §10):** (1) solo lectura: nunca se escribe en el repo del cliente; (2) **la regla decide** severidad y `confirmed`; la IA solo explica y redacta (IA-1, IA-2; la revisión IA de archivos es P2 y sus hallazgos nunca suben de `medium`); (3) un secreto encontrado **nunca** se guarda, registra ni se manda a Claude en claro: solo vista parcial + huella HMAC; (4) los hallazgos `CB_*` **no** abren incidentes ni llaman (canónicas §9.2); (5) todo corre en el Worker `vanguard` dentro del Workflow `vg-scan`, en JS puro: **prohibidos** gitleaks, osv-scanner, Semgrep y cualquier binario.
> **Remisiones:** cifrado del token, `getKeys`/`withSecret`/`createConnectionWithSecret` y `fingerprint()` → 05 (05.7); IA-1/IA-2, topes y escalera de gasto → 11; contrato exacto de rutas y esquemas → 15 (E6, E8–E16, E23; esquemas de 15.5; RPC `vg_upsert_findings` de 15.12); componentes de UI → 14; export «Copiar para mi IA» y MCP → 13; seguridad del upload ZIP → 06.10; rendimiento histórico (Lighthouse) → 10; horario → 16. **Si esta sección choca con el contrato de 15 o el DDL de 05, mandan ellos.**

### 09.1 Tareas del módulo

Prioridades de las canónicas: **P0** = la demo lo necesita (canónicas: listo el sábado 20:00; el hito de Codebase es el de las **15:00**, «auditoría con Supabase y repo + IA-1», canónicas §13), **P1** domingo 10:00, **P2** hoja de ruta. Archivos según la estructura de 15.2.

| ID | Tarea | Prio | Dueño | Archivo(s) | Hecho cuando |
|---|---|---|---|---|---|
| CB-01 | Guarda de token GitHub: `guardKey('github', …)` rechaza `gh[pousr]_` con `classic_github_pat` (15.11); la ruta E8 exige además el prefijo `github_pat_` (`422 invalid_body`, 09.2) | P0 | ORQUESTADOR (o BACK si a las 11:00 no está; 15.2) | `packages/core/src/key-guards.ts`, `apps/api/src/rutas/connections.ts` | Vitest: `ghp_…` → `classic_github_pat`; `github_pat_…` → `null`; E8 con `abc…` → 422 `invalid_body` |
| CB-02 | `probarGithub()`: validación + sondeo de permisos + `meta` (lo reusa E9) | P0 | BACK | `apps/api/src/scans/repo.ts`, `rutas/connections.ts` | `POST /connections {provider:'github'}` devuelve `checks[]` que validan con `PermCheck` (15.5) |
| CB-03 | Tarjeta GitHub en Conexiones (guía de 4 pasos, errores en español) | P0 | FRONT | `apps/web/src/modulos/conexiones/` | Funciona con fixture y con API |
| CB-04 | `leerZip()` con topes y defensas (09.3) | P0 (lo usa el paso `repo`) | BACK | `packages/core/src/zip.ts` (nuevo: la seguridad vive en core, canónicas §5; `fflate` 0.8.3 exacta pasa a ser dependencia de `packages/core`, reexportado en `src/index.ts`) | Pruebas 1–2 de 09.14 en verde |
| CB-05 | Paso `repo` del Workflow: zipball ≤ 25 MB → `analizarArchivos()` → OSV → `vg_upsert_findings` | P0 | BACK | `apps/api/src/scans/repo.ts`, `osv.ts` | Repo víctima da los hallazgos P0 de 09.13 |
| CB-06 | Inventario + detección de stack determinista | P0 | BACK | `packages/core/src/rules/codebase.ts` | Stack de la víctima = Hono + Vite + Supabase + Cloudflare Workers (+ PHP por `panel-legacy/`) |
| CB-07 | Reglas `CB_ENV_COMMITTED`, `CB_GITIGNORE_NO_ENV` | P0 | BACK | `rules/codebase.ts` | Vitest con árboles de prueba |
| CB-08 | Secretos: 9 reglas `CB_SECRET_*`, JWT `service_role`, enmascarado, huella | P0 | BACK | `packages/core/src/secrets/{rules,entropy,scan}.ts` | Ninguna salida contiene el valor en claro (prueba de fuga) |
| CB-09 | Lockfiles `package-lock.json` (v1–v3) y `composer.lock` | P0 | BACK | `packages/core/src/lockfiles/{npm,composer}.ts` | Fixtures reales parseados |
| CB-10 | OSV `querybatch` + `vulns/{id}` + dedupe por alias + severidad → `CB_DEP_VULN` | P0 | BACK | `apps/api/src/scans/osv.ts` | jquery 3.4.1 sale con CVE-2020-11023 y arreglo 3.5.0 |
| CB-11 | Escritura de hallazgos: `dedupeKey(org_id, rule_id, resource)` de 05 + RPC `vg_upsert_findings` de 15.12 (reapertura y auto-`verified`) (09.11) | P0 | BACK | `apps/api/src/scans/repo.ts` | Dos escaneos seguidos no duplican filas; un hallazgo `ignored` sigue `ignored` |
| CB-12 | `EstadoModulo` de Codebase | P0 | BACK | `apps/api/src/estado/codebase.ts` | `GET /modules/codebase/state` valida con zod |
| CB-13 | Pantalla Codebase + panel de detalle + «Analizar repo ahora» (texto de 14.12) | P0 | FRONT | `apps/web/src/modulos/codebase/` | Botones ≥ 56 px, guía visible, viewer sin escritura |
| CB-14 | Plantillas de corrección por regla `CB_*` (respaldo de IA-1) | P0 | BACK | `packages/core/src/templates/fix-prompt.ts` (envoltorio) + `templates/fix/CB_*.ts` (plantilla por regla, 15.2) | Cada `rule_id` CB tiene plantilla |
| CB-15 | Repo víctima sembrado + script de siembra (09.13) | P0 | ORQUESTADOR (Gabriel crea el repo y el PAT) | `demo/repo-vulnerable/`, `demo/sembrar-repo.mjs` | Repo privado `vanguard-demo-victima` empujado antes de las 14:00 |
| CB-16 | `CodebaseEvidence` (opcional en `Finding.evidence`) + fixture `EstadoModulo` de codebase | P0 | ORQUESTADOR | `packages/contracts/src/` | Fixtures validan en CI |
| CB-17 | Subida de ZIP a R2 (E23) + paso `zip` | P1 | BACK | `apps/api/src/scans/zip.ts`, `rutas/uploads.ts` | ZIP de la víctima da los mismos hallazgos que el repo (sin historial) |
| CB-18 | Zona «Subir un ZIP» con validación previa | P1 | FRONT | `apps/web/src/modulos/codebase/` | Rechaza > 25 MB sin subir |
| CB-19 | `CB_ENV_IN_HISTORY` (fase «historial» dentro del paso `repo`) | P1 | BACK | `repo.ts` | Detecta el `.env.production` borrado de la víctima |
| CB-20 | KEV + `urgencia` (sin tocar `severity`, 09.7) | P1 | BACK | `osv.ts`, `rules/codebase.ts` | jquery e ignition marcadas «explotada activamente» |
| CB-21 | `pnpm-lock.yaml` (v5/v6/v9) | P1 | BACK | `lockfiles/pnpm.ts` | Fixture v9 parseado |
| CB-22 | `CB_KEY_REUSE` (huella contra las de `connection_secrets` de la misma org, leídas por `credentials.ts`) | P1 | BACK | `repo.ts`, `lib/credentials.ts` | El señuelo de 09.13 dispara el hallazgo |
| CB-23 | `CB_SECRET_GENERIC` (entropía ≥ 3,5), `CB_SENSITIVE_FILE`, `CB_NO_LOCKFILE`, agravante «expuesto en el bundle», `CB_ZIP_HAS_GIT` | P1 | BACK | `secrets/*.ts`, `rules/codebase.ts` | Sin falsos positivos en el repo de VanGUARD |
| CB-24 | Modo árbol para repos con zipball > 25 MB | P1 | BACK | `repo.ts` | Repo grande termina con `coverage` parcial, no con error |
| CB-25 | EPSS, deps.dev (`CB_DEP_OUTDATED`), endoflife.date (`CB_RUNTIME_EOL`) | P2 | BACK | `osv.ts` | — |
| CB-26 | Revisión IA de archivos de riesgo (ruta `code_review`, paso `revision_ia`, 09.10) | P2 | BACK | `apps/api/src/ia/prompts/code_review.ts` | — |
| CB-27 | SAST determinista mínimo: `CB_SQL_NO_RLS`, `CB_SERVICE_KEY_IN_CLIENT`, `CB_GHA_PR_TARGET` | P2 (decidido; `CB_SQL_NO_RLS` solo sube a P1 si P0 cierra el sábado a las 19:00) | BACK | `rules/codebase.ts` | — |
| CB-28 | GitHub App de solo lectura; Dependabot como segunda opinión; yarn/pip/go/pub/cargo | P2 | BACK | — | — |

### 09.2 Conexión a GitHub y selección de repo

**Método elegido: PAT fine-grained de un solo repo** (canónicas §10.2). La OAuth App queda fuera porque no existe scope de solo lectura para repos privados (`repo` da escritura total) [verificado: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps]; la GitHub App (token de 1 h acotado a un repo) es P2 y produce el mismo `token`, así que el pipeline no cambia.

| Permiso del PAT (Repository permissions) | Nivel | Obligatorio | Para qué endpoint |
|---|---|---|---|
| Metadata | Read-only (GitHub lo pone solo) | Sí | `GET /repos/{o}/{r}` |
| Contents | Read-only | Sí | `commits`, `zipball/{ref}`, `contents/{path}`, `git/trees` |
| Dependabot alerts | Read-only | No (P2, segunda opinión) | `dependabot/alerts` |

Permisos por endpoint [verificado: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens, vía R11 §1.2]. Límite: 5000 peticiones/h por PAT; si se agota llega 403/429 con `x-ratelimit-remaining: 0` [verificado: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api, vía R11]. Una auditoría P0 gasta 4 llamadas a GitHub (`/repos`, `commits`, `zipball`, descarga de `codeload`); con historial (P1) ≤ 24.

**Una sola conexión GitHub activa por org en P0** (el encargo dice «UN repo»): si ya hay una `github` `active`, E8 responde `409 conflict` «Ya hay un repo conectado. Quítalo antes de conectar otro.». Así el `resource` de los hallazgos (09.11) no necesita llevar el nombre del repo. Varios repos por org = P2.

**Guía de la tarjeta (texto exacto de la UI, 4 pasos):**
1. «Abre GitHub y crea un token *fine-grained*.» Botón «Abrir GitHub» → `https://github.com/settings/personal-access-tokens/new?name=VanGUARD&description=Solo+lectura+para+VanGUARD&expires_in=30&contents=read` (parámetros `name` ≤ 40 car., `description`, `target_name`, `expires_in` 1–366, y permisos `<permiso>=<nivel>` como `contents=read`; el de Dependabot sería `vulnerability_alerts=read`, P2 [verificado hoy 24-oct: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens, sección «Pre-filling fine-grained personal access token details using URL parameters»]).
2. «En *Repository access* elige **Only select repositories** y marca UN solo repo.»
3. «En *Repository permissions* deja **Contents: Read-only** (Metadata se marca solo). No actives nada de escritura.»
4. «Copia el token (empieza por `github_pat_`) y pégalo aquí junto a `dueño/repo`. VanGUARD solo lee: no puede cambiar tu código.»

**Selección de repo:** un campo `owner/repo`. **El FRONT** acepta también una URL pegada y la normaliza **antes de enviar** con `^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$` → `$1/$2` (14.10). **El BACK no normaliza**: `ConnectionCreate` (15.5) valida `repo_full_name` con `^[\w.-]{1,39}\/[\w.-]{1,100}$`, así que una URL llega como `422 invalid_body`. No se listan repos (eso exigiría un token más amplio). Rama: la `default_branch` que devuelve GitHub en cada escaneo; `ScanCreate` no acepta otra rama en P0.

**Flujo de `POST /api/orgs/:org/connections {provider:'github', repo_full_name, pat}`** (contrato en 15, E8):
1. `guardKey('github', pat)` de `key-guards.ts` (15.11): `trim()`; `^gh[pousr]_` → `422 key_rejected` con `details.reason:'classic_github_pat'` y el mensaje de 15.11. Después, en la ruta: si `pat` no empieza por `github_pat_` → `422 invalid_body` con `details.field_errors.pat = ['No parece un token fine-grained de GitHub (empieza por github_pat_).']` (no se inventa otro `reason`: el enum de E8 no lo tiene). La clave rechazada no se registra.
2. Si ya hay una conexión `github` `active` en la org → `409 conflict` (arriba).
3. `probarGithub()` (abajo). Obligatorios: `metadata:read` y `contents:read`; si falla uno → `422 provider_rejected` con `details.missing_permissions` (`['metadata:read']` si `/repos` dio 401/403/404, `['contents:read']` si `commits` dio 403/404) y `error.message` = el texto de la tabla de abajo. Un 5xx/timeout de GitHub → `502 provider_unavailable`. Dependabot (`required:false`) nunca bloquea.
4. `createConnectionWithSecret()` de `lib/credentials.ts` (05.7: cifrado de sobre + huella en una transacción); `label` = `GitHub · <owner/repo>` (15, E8); `connections.meta = {repo_full_name, default_branch, private, repo_id}`; `scopes = ['metadata:read','contents:read']` (+ `'dependabot_alerts:read'` si pasó); `capabilities = {metadata: true, contents: true, dependabot_alerts: <bool>}` (`record<string, boolean>` de `ConnectionPublic`); `expires_at` si llega la cabecera de caducidad y `Date.parse` la entiende (si no, `null`).

E9 (`POST …/connections/:id/test`) reusa `probarGithub()` con el token de `withSecret()` y actualiza `status` (`401` → `revoked`), `capabilities`, `last_checked_at` y `last_error` (código corto: `http_401`, `http_404`…).

```ts
// apps/api/src/scans/repo.ts (P0) — en el código real cada fetch va por lib/http.ts (plazos y reintentos de 15.3)
import type { PermCheck } from '@vanguard/contracts';
const GH = 'https://api.github.com';
const UA = 'VanGUARD/1.0 (+https://officialvanguard.com)';   // GitHub exige User-Agent [verificado: https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api]
export const ghHeaders = (t: string) => ({ Authorization: `Bearer ${t}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': UA });
// PermCheck.error_code es el enum ProviderErrorCode de 15.5: nunca el número HTTP en texto
const codigo = (s: number) => s === 401 ? 'unauthorized' : s === 403 ? 'forbidden' : s === 404 ? 'not_found'
  : s === 429 ? 'rate_limited' : s >= 500 ? 'unavailable' : 'invalid';

export async function probarGithub(token: string, repo: string) {
  const checks: PermCheck[] = [];
  const r = await fetch(`${GH}/repos/${repo}`, { headers: ghHeaders(token), signal: AbortSignal.timeout(10_000) });
  checks.push({ permission: 'metadata:read', ok: r.ok, required: true, ...(r.ok ? {} : { error_code: codigo(r.status) }) });
  if (!r.ok) return { ok: false as const, status: r.status, checks };
  const j = await r.json() as { id: number; full_name: string; default_branch: string; private: boolean };
  const c = await fetch(`${GH}/repos/${repo}/commits?sha=${encodeURIComponent(j.default_branch)}&per_page=1`,
    { headers: ghHeaders(token), signal: AbortSignal.timeout(10_000) });
  checks.push({ permission: 'contents:read', ok: c.ok, required: true, ...(c.ok ? {} : { error_code: codigo(c.status) }) });
  const d = await fetch(`${GH}/repos/${repo}/dependabot/alerts?per_page=1`, { headers: ghHeaders(token), signal: AbortSignal.timeout(10_000) });
  checks.push({ permission: 'dependabot_alerts:read', ok: d.ok, required: false, ...(d.ok ? {} : { error_code: codigo(d.status) }) });
  const exp = r.headers.get('github-authentication-token-expiration');           // [no verificado: cabecera y formato]
  return { ok: c.ok, status: c.status, checks, expires_at: exp && !Number.isNaN(Date.parse(exp)) ? new Date(exp).toISOString() : null,
    meta: { repo_full_name: j.full_name, default_branch: j.default_branch, private: j.private, repo_id: j.id } };
}
```

| Respuesta | `missing_permissions` | `error.message` (texto de la UI) |
|---|---|---|
| 401 en `/repos` | `['metadata:read']` | «El token no es válido o caducó.» |
| 404 (o 403) en `/repos` | `['metadata:read']` | «Tu token no ve `owner/repo`. Revisa que lo marcaste en *Only select repositories*. Si el repo es de una organización, puede que un admin tenga que aprobar el token.» (los PAT de orgs con aprobación quedan *pending* y solo leen lo público [verificado hoy: managing-your-personal-access-tokens]) |
| 403/404 en `commits` | `['contents:read']` | «Falta el permiso *Contents: Read-only*.» |
| 403/404 en `dependabot/alerts` | — | No bloquea; la tarjeta pinta «Dependabot no disponible (opcional)» desde `checks` |

### 09.3 Subida de ZIP (P1): límites y defensas

**Flujo** (E11 y E23 de 15; endurecimientos de 06.10): (1) el FRONT comprueba extensión `.zip` y `file.size ≤ 26 214 400`; si no, avisa sin subir. (2) `POST /api/orgs/:org/scans {kind:'zip', filename, size_bytes}` → `scan_runs` `queued` con `step:'waiting_upload'`, `requested_by` y `params:{filename, size_bytes}` (`filename` ya viene validado por `ScanCreate`: `^[\w .()-]{1,120}\.zip$`); **no** lanza el Workflow. **No** cuenta para el tope de 3 auditorías/día (E11 solo cuenta `full_audit`); sí aplica el 409 de «mismo `kind` en curso hace < 15 min», salvo que el `zip` en curso sea un `waiting_upload` del mismo usuario: ese se marca `failed` con `error:'ZIP_NOT_FOUND'` y se crea el nuevo (si no, una subida fallida bloquearía 15 min; ya en E11 de S15). (3) `PUT /api/orgs/:org/uploads/zip/:scan_run_id` con el `File` como cuerpo. El BACK (`rutas/uploads.ts`): busca el `scan_run` con `.eq('org_id', ctx.orgId)` y exige `kind:'zip'`, `status:'queued'`, `step:'waiting_upload'`, `requested_by = userId` y `created_at` < 15 min (si no existe, 404; si no espera subida, 409); `Content-Length` presente (411) y ≤ 26 214 400 (413) e igual a `params.size_bytes` (422 `invalid_body`); lee `arrayBuffer()` (cabe: 25 MB), exige `byteLength === Content-Length` y los bytes mágicos `50 4B 03 04` (si no, `422 invalid_body` «No es un ZIP válido»); `UPLOADS.put('zips/<org_id>/<scan_run_id>.zip', buf)`; `step = null`; `SCAN_WF.create({ id: scan_run_id, params:{scanRunId, orgId, kind:'zip', zipKey} })` (si `create` falla: `UPLOADS.delete`, `status:'failed'` y 502); `201 {key}`. (4) Paso `zip` sin reintentos (`{limit: 0}`, 15.8): `UPLOADS.get` → `leerZip(buf, {origen:'zip'})` → `analizarArchivos()` → OSV → hallazgos; en `finally`, `UPLOADS.delete(key)`. (5) Regla de ciclo de vida del bucket `vanguard-uploads` a 1 día como respaldo (R17 §5; la configura el ORQUESTADOR en el panel de R2).

| Tope | Valor | Si se supera |
|---|---|---|
| ZIP comprimido | 25 MB (26 214 400 B) | 413 antes de tocar R2; en el paso `repo`, `REPO_TOO_BIG` |
| Entradas en el directorio central | 20 000 | `ZIP_TOO_MANY_ENTRIES` |
| Archivo leído para análisis | 1 MB (de memoria reservada, ver «coste» abajo) | se lista en el inventario, no se lee |
| Suma del **coste** de los archivos seleccionados | **40 MB** (41 943 040 B), alineado con 06.10 | `ZIP_TOO_BIG_UNCOMPRESSED` |
| Proporción sospechosa (solo ZIP subido) | `originalSize > 1 MB` y `originalSize / size > 100` (06.10) | `ZIP_RATIO`; en el zipball de GitHub la entrada solo se omite |
| Largo de ruta / profundidad | 512 car. / 32 niveles | la entrada se descarta |
| Métodos de compresión | 0 (stored) y 8 (deflate) | la entrada se descarta |
| Memoria del isolate | 128 MB [verificado: https://developers.cloudflare.com/workers/platform/limits/, vía R17] | 25 MB del ZIP + ≤ 40 MB descomprimidos + textos y JSON de lockfiles: cabe, **con poco margen**; por eso el búfer del ZIP se suelta (`zip = null`) en cuanto `leerZip` termina y los archivos se decodifican uno a uno. Con 60 MB (cifra de R17) no quedaba margen |

**Coste de memoria de una entrada** (lo que fflate reserva de verdad, según el código de `unzipSync` e `inflateSync` [verificado hoy: https://unpkg.com/fflate@0.8.3/esm/browser.js]): con deflate (8) reserva `new u8(originalSize)` y, con búfer dado, `inflateSync` no lo agranda; con stored (0) **copia `size` bytes** (`slc(data, b, b + sc)`), sin mirar `originalSize`. Por eso `coste = compression === 0 ? size : originalSize`, y el `filter` recibe ambos campos (`{name, size, originalSize, compression}`) [verificado: mismo archivo].

| Amenaza | Defensa |
|---|---|
| Zip slip (`../../x`, `/etc/x`, `C:\x`) | **Nada se escribe a disco** (no hay disco en Workers). Además `normalizarRuta()` cambia `\` por `/` y descarta rutas absolutas, con unidad, con segmento `..` o con caracteres de control (06.10 descarta las que llevan `\`; aquí se normalizan para no perder el `.env` de un ZIP hecho en Windows: es igual de seguro porque no hay disco) |
| Zip bomb (ratio enorme, tamaño declarado falso) | El total se suma con el **coste** real de cada entrada (arriba), así que el tamaño declarado no engaña: si un deflate miente, el archivo sale truncado; si un stored declara `originalSize` pequeño y `size` grande, cuenta `size`. ZIP subido con proporción > 100 en un archivo > 1 MB → `ZIP_RATIO` (06.10) |
| Entradas solapadas (bomba de Fifield) / miles de entradas | Cada entrada suma su coste al total aunque apunte a los mismos bytes; tope de 20 000 entradas |
| ZIP dentro del ZIP | Extensiones de archivo comprimido se omiten; nunca se abren anidados |
| Symlinks | fflate no expone los atributos externos; un symlink llega como un archivo pequeño con la ruta destino. Inofensivo: no hay sistema de archivos |
| Cifrado o método raro | Solo métodos 0/8 pasan el filtro; cualquier excepción de fflate → `ZIP_INVALID` |
| Nombres con control o RTL (`U+202E`) para engañar en la UI | Se descartan las rutas con `[\u0000-\u001f\u202a-\u202e\u2066-\u2069]` |
| Content-Type falso | Se ignora; se comprueban bytes mágicos |
| Nombre de archivo del usuario | Nunca se usa como clave: `zips/<org_id>/<scan_run_id>.zip` |
| IDOR sobre `scan_run_id` | El `scan_run` se busca con `.eq('org_id', ctx.orgId)` (canónicas §7) |
| Contenido hostil para la IA (README con «ignora tus instrucciones») | Solo va a la IA redactado y dentro de `<datos_no_confiables>` (09.10, 11) |
| `.git/` incluido en el ZIP | P1: hallazgo `CB_ZIP_HAS_GIT` (low): «tu ZIP lleva el historial de git; si lo compartes, viaja con él» |

```ts
// packages/core/src/zip.ts (P0: lo usan el paso repo y el paso zip)
import { unzipSync } from 'fflate';
export const LIM = { zip: 26_214_400, entradas: 20_000, archivo: 1_000_000, total: 41_943_040, ruta: 512, prof: 32, ratio: 100 } as const;
const SALTAR = /(^|\/)(node_modules|vendor|dist|build|\.next|\.nuxt|coverage|\.git)\//;
// Lista blanca (06.10: «solo se descomprime lo que el escáner usa»), ampliada con .jsonc (wrangler.jsonc de la víctima), .md,
// Dockerfile y configuraciones donde suelen filtrarse claves. Lo demás se lista en el inventario y no se descomprime.
const LEER = /(^|\/)(\.gitignore|\.env(\.[\w-]+)?|\.npmrc|\.pypirc|Dockerfile|Gemfile|go\.mod|requirements[\w-]*\.txt|[\w.-]+\.lock|pnpm-lock\.yaml)$|\.(m?[jt]sx?|cjs|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|properties|xml|php|py|rb|go|java|kts?|cs|rs|dart|swift|vue|svelte|astro|sql|sh|ps1|tf|tfvars|pem|md|txt)$/i;
const NO_LEER = /\.(min\.js|map)$/i;
export class ZipError extends Error {}
export type Inventario = { entradas: number; leidos: number; omitidos: number; tiene_git: boolean; rutas: { p: string; s: number }[] };

export function normalizarRuta(n: string): string | null {
  const p = n.replace(/\\/g, '/');
  if (p.length > LIM.ruta || /[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const seg = p.split('/');
  return seg.includes('..') || seg.length > LIM.prof ? null : p;
}

export function leerZip(buf: Uint8Array, opts: { origen: 'repo' | 'zip' }): { archivos: Map<string, string>; inventario: Inventario } {
  if (buf.byteLength > LIM.zip) throw new ZipError('ZIP_TOO_BIG');
  if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) throw new ZipError('ZIP_BAD_MAGIC');   // código de 06.10
  const inv: Inventario = { entradas: 0, leidos: 0, omitidos: 0, tiene_git: false, rutas: [] };
  let total = 0, crudo: Record<string, Uint8Array>;
  try {
    crudo = unzipSync(buf, { filter(f) {
      if (++inv.entradas > LIM.entradas) throw new ZipError('ZIP_TOO_MANY_ENTRIES');
      const p = normalizarRuta(f.name);
      if (!p || p.endsWith('/')) { inv.omitidos++; return false; }
      if (/(^|\/)\.git\//.test(p)) inv.tiene_git = true;
      inv.rutas.push({ p, s: f.originalSize });
      const coste = f.compression === 0 ? f.size : f.originalSize;            // lo que fflate reserva de verdad (arriba)
      if (opts.origen === 'zip' && f.originalSize > LIM.archivo && f.originalSize / Math.max(f.size, 1) > LIM.ratio)
        throw new ZipError('ZIP_RATIO');
      if (SALTAR.test(p) || !LEER.test(p) || NO_LEER.test(p) || coste > LIM.archivo
          || (f.compression !== 0 && f.compression !== 8)) { inv.omitidos++; return false; }
      if ((total += coste) > LIM.total) throw new ZipError('ZIP_TOO_BIG_UNCOMPRESSED');
      inv.leidos++; return true;
    } });
  } catch (e) { throw e instanceof ZipError ? e : new ZipError('ZIP_INVALID'); }
  // Raíz común: el zipball de GitHub mete todo bajo "owner-repo-<sha7>/"; muchos ZIP de usuario, bajo "proyecto/".
  const primeros = new Set(inv.rutas.map((r) => r.p.split('/')[0]));
  const raiz = primeros.size === 1 && inv.rutas.every((r) => r.p.includes('/')) ? [...primeros][0] + '/' : '';
  inv.rutas = inv.rutas.map((r) => ({ p: r.p.slice(raiz.length), s: r.s }));
  const td = new TextDecoder('utf-8', { fatal: false }), archivos = new Map<string, string>();
  for (const k of Object.keys(crudo)) {
    const p = normalizarRuta(k)!.slice(raiz.length), b = crudo[k];
    delete crudo[k];                                                  // libera memoria archivo a archivo
    if (b.subarray(0, 8192).includes(0)) { inv.omitidos++; continue; } // binario: byte NUL en los primeros 8 KB
    archivos.set(p, td.decode(b));
  }
  return { archivos, inventario: inv };
}
```

**Códigos de error del módulo.** El paso que falla escribe el código en `steps[i].error_code` (`ScanStep`, 15.5); si falla la auditoría entera (en `kind:'zip'` o `kind:'repo'` es el único paso con datos), el mismo código va a `scan_runs.error` (≤ 200 car.). El BACK guarda **solo el código**; el FRONT lo traduce con este mapa (`lib/errores-escaneo.ts`) y, si no lo conoce, pinta «No pudimos analizar el código» con el código en la ayuda: `ZIP_INVALID` «El archivo no es un ZIP válido o está dañado»; `ZIP_BAD_MAGIC` «El archivo no es un ZIP»; `ZIP_TOO_BIG` «El ZIP pesa más de 25 MB»; `ZIP_TOO_MANY_ENTRIES` «El ZIP tiene más de 20 000 archivos»; `ZIP_TOO_BIG_UNCOMPRESSED` «Descomprimido supera 40 MB (posible bomba zip)»; `ZIP_RATIO` «Un archivo del ZIP se comprime de forma sospechosa (posible bomba zip)»; `ZIP_NOT_FOUND` «No llegó el archivo; vuelve a subirlo»; `ZIP_REJECTED` (cualquier otro fallo del paso `zip`, p. ej. el isolate sin memoria; es el `zip_rejected` de 06.10) «No pudimos abrir el ZIP; prueba con uno más pequeño»; `REPO_TOO_BIG` «El repo pesa más de 25 MB comprimido»; `repo_not_found` «Tu token ya no ve el repo: reconéctalo»; `repo_unauthorized` «El token de GitHub caducó o fue revocado»; `github_unavailable` «GitHub no respondió; reintenta en unos minutos».

### 09.4 Pipeline de escaneo

```mermaid
flowchart TD
  A["POST scans kind=repo o full_audit"] --> B["Workflow vg-scan, paso repo"]
  Z["PUT uploads/zip (P1) a R2"] --> BZ["paso zip"]
  B --> C["GitHub: /repos da la rama; commits?per_page=1 da el sha; zipball 302 a codeload; tope 25 MB"]
  BZ --> C2["R2 get + bytes mágicos"]
  C --> D["leerZip: fflate en memoria con topes"]
  C2 --> D
  D --> E["Inventario de rutas"]
  E --> F["Stack determinista"]
  E --> G["Rutas: .env subido, .gitignore, archivos sensibles"]
  E --> H["Secretos: palabra clave, regex, JWT, entropía, huella"]
  E --> I["Lockfiles a lista de dependencias"]
  I --> J["OSV querybatch + vulns por id, dedupe por alias"]
  J --> K["KEV (P1) y EPSS (P2): urgencia"]
  H --> L["CB_KEY_REUSE (P1): huella contra las de connection_secrets"]
  G --> N["fase historial (P1, dentro del paso repo): commits?path="]
  N --> M["vg_upsert_findings: redact, dedupe_key, reabre, auto-verified"]
  H --> M
  K --> M
  L --> M
  M --> O["paso revision_ia (P2): code_review con Sonnet"]
  O --> P["paso resumen_ia: IA-2; IA-1 bajo demanda por hallazgo"]
```

**Pasos de Codebase dentro de `vg-scan`** (la clase `ScanWorkflow` es la de R17 §11.1 con los nombres y reintentos de 15.8; cada paso escribe en Supabase y devuelve solo conteos, máx. 1 MiB [verificado: https://developers.cloudflare.com/workflows/reference/limits/, vía R17]). **`ScanStep.name` (15.5) solo admite `repo` y `zip` para este módulo**: el historial es una fase dentro de `repo`, no un `step.do` aparte.

| Paso (`step.do`) | Prio | Corre si | Reintentos (15.8) | `scan_runs.step` que va escribiendo (texto libre ≤ 40 car.) | Devuelve |
|---|---|---|---|---|---|
| `repo` | P0 | `kind:'repo'`, o `full_audit` con una conexión `github` `active` | `{limit: 1, delay: '10 seconds'}` | `repo:descargando` → `repo:analizando` → `repo:dependencias` → (P1) `repo:historial` → `repo:guardando` | `{ok, findings, deps, archivos}` |
| `zip` | P1 | `kind:'zip'` | `{limit: 0}` | `zip:leyendo` → `zip:analizando` → `zip:dependencias` → `zip:guardando` | igual que `repo` |
| `revision_ia` | P2 | tras `repo`/`zip`, IA encendida y nivel `normal` (gasto del día < 70 %) | `{limit: 1}` | `repo:revision_ia` | `{findings, cost_usd}`. Exige añadir `revision_ia` a `ScanStep.name` (15.5): P2 |

Sin conexión GitHub, `full_audit` salta el paso (`steps[i].status:'skipped'`) y `codebase` entra en `coverage.missing` («vemos 3 de 4 fuentes»). Si el paso falla, `steps[i] = {status:'failed', error_code}` (códigos de 09.3), el módulo entra en `missing` y la auditoría sigue (15, E12). Nunca se pinta verde lo que no se miró. **El paso solo lanza (para que el Workflow reintente) ante errores transitorios** de GitHub (red, 429, 5xx, timeout); 401/404 de GitHub y cualquier `ZipError` terminan el paso como `failed` sin lanzar (15.8, regla 2). **Si OSV cae** tras sus 3 intentos (15.10), el paso **no** falla: guarda secretos y `.env`, deja `miradas.osv:false`, `steps[i].error_code:'osv_unavailable'` con `status:'done'`, y no auto-verifica nada (09.11).

```ts
// apps/api/src/scans/repo.ts (P0) — esqueleto del paso. Nombres de 05.7: getKeys, activeKid, withSecret, fingerprint.
import { getKeys, activeKid } from '../lib/keyring.ts';
import { withSecret } from '../lib/credentials.ts';
import { fingerprint } from '@vanguard/core/crypto';
import { leerZip } from '@vanguard/core';                // core/src/index.ts reexporta zip.ts (fflate es dependencia de core)
export async function scanRepo(env: CloudflareBindings, p: ScanParams) {
  const admin = db(env);
  let q = admin.from('connections').select('id, meta').eq('org_id', p.orgId).eq('provider', 'github')
    .eq('kind', 'read').eq('status', 'active');
  if (p.connectionId) q = q.eq('id', p.connectionId);
  const { data: conn } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!conn) return { ok: false as const, skipped: 'no_connection' as const };
  const ctx = { orgId: p.orgId, connectionId: conn.id, provider: 'github', kind: 'read' } as const;
  const repo = (conn.meta as { repo_full_name: string }).repo_full_name;
  await setStep(env, p.scanRunId, 'repo:descargando');
  // El token solo existe dentro de withSecret (05.7): no sale en el valor devuelto ni en errores.
  let { sha, zip } = await withSecret(env, admin, ctx, async (token) => {
    const rama = await ramaPorDefecto(token, repo);                            // GET /repos → default_branch (401/404 → failed)
    const sha = await ultimoSha(token, repo, rama);                            // commits?sha=<rama>&per_page=1 → [0].sha
    return { sha, zip: await bajarZipball(token, repo, sha) as Uint8Array | null };
  });
  const { archivos, inventario } = leerZip(zip!, { origen: 'repo' });          // 09.3
  zip = null;                                                                  // suelta los 25 MB antes de analizar
  await setStep(env, p.scanRunId, 'repo:analizando');
  const keys = await getKeys(env, admin, await activeKid(admin));             // la FPK es la misma para cualquier kid
  const huella = (v: string) => fingerprint(keys, p.orgId, v);                 // MISMA función que connection_secrets (05.7)
  const a = await analizarArchivos(archivos, inventario, { huella });          // core: stack, reglas, secretos, deps
  await setStep(env, p.scanRunId, 'repo:dependencias');
  const osv = await consultarOsv(a.deps);                                      // osv.ts (09.7); {ok:false} si OSV cae
  const reuse = await claveReutilizada(env, admin, p.orgId, a.huellas);         // P1 (09.9)
  const historia = await historialEnv(env, admin, ctx, repo, sha, inventario); // P1 (09.8); {ok:false} si falla
  await setStep(env, p.scanRunId, 'repo:guardando');
  const filas = await construirHallazgos({ ...a, osv, reuse, historia, orgId: p.orgId, connectionId: conn.id,
    fuente: { tipo: 'github', repo, sha } });                                  // dedupeKey() de 05 dentro
  const completo = osv.ok && historia.ok;                                     // 09.11 (P0: historia.ok = true)
  const { data: n } = await admin.rpc('vg_upsert_findings', { p_org: p.orgId, p_scan: p.scanRunId, p_module: 'codebase',
    p_conn: conn.id, p_rows: filas, p_complete: completo });                   // 15.12, argumentos con nombre; p_conn fija connection_id y acota la auto-verificación
  await guardarDetalle(env, p.scanRunId, a.detalle);                           // scan_runs.coverage.detail.codebase (09.5)
  return { ok: true as const, findings: n ?? 0, deps: a.deps.length, archivos: inventario.leidos };
}

async function bajarZipball(token: string, repo: string, sha: string): Promise<Uint8Array> {
  const r1 = await fetch(`${GH}/repos/${repo}/zipball/${sha}`, { headers: ghHeaders(token), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const loc = r1.headers.get('location');
  if (r1.status !== 302 || !loc) throw new ProviderError(r1.status === 404 ? 'not_found' : r1.status === 401 ? 'unauthorized' : 'unavailable', r1.status);
  const u = new URL(loc);
  if (u.protocol !== 'https:' || u.hostname !== 'codeload.github.com') throw new ProviderError('invalid');  // lista de salida de 06 (GitHub)
  // sin Authorization: la URL ya es temporal. 'manual' también aquí: otro salto no se sigue (r2.ok sería false → error)
  const r2 = await fetch(u, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (!r2.ok || !r2.body) throw new ProviderError('unavailable', r2.status);
  const rd = r2.body.getReader(), trozos: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    if ((n += value.byteLength) > LIM.zip) { await rd.cancel(); throw new ZipError('REPO_TOO_BIG'); }  // P1: modo árbol
    trozos.push(value);
  }
  const out = new Uint8Array(n); let o = 0; for (const t of trozos) { out.set(t, o); o += t.byteLength; }
  return out;
}
```

`zipball/{ref}` responde **302** a una URL temporal que en repos privados caduca a los **5 minutos** [verificado: https://docs.github.com/en/rest/repos/contents]. Se pide con `redirect:'manual'` para no reenviar el `Authorization` a otro host: en Workers, con `manual` «the 3xx redirect response will be returned to the caller as-is», y `redirect:'error'` no existe (lanza `TypeError`) [verificado hoy: https://developers.cloudflare.com/workers/runtime-apis/request/]; que la cabecera `Location` sea legible no lo dice esa página explícitamente [no verificado]: si llega vacía, plan B `redirect:'follow'` (la URL temporal no necesita el token; 15.10 ya describe ese modo). La `Location` solo se acepta si es `https://codeload.github.com/…` (lista de salida de 06: GitHub = `api.github.com` y, solo para el zipball, `codeload.github.com`). Se descarga por **sha** (no por rama, que es lo que dice la tabla de 15.7) para que «Ver en GitHub» apunte exactamente a lo escaneado. Errores del paso: 401 → `repo_unauthorized` y la conexión pasa a `status:'revoked'`, `last_error:'http_401'`; 404 → `repo_not_found` y `status:'error'`, `last_error:'http_404'`; `REPO_TOO_BIG` (P0) termina el paso con «El repo pesa más de 25 MB comprimido» (P1: modo árbol).

**Modo árbol (P1, repo > 25 MB comprimido):** `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` (tope 100 000 entradas y 7 MB; con `truncated:true` la cobertura queda parcial [verificado: https://docs.github.com/en/rest/git/trees, vía R11]) para inventario y reglas de rutas, y `GET /repos/{o}/{r}/contents/{path}?ref={sha}` con `Accept: application/vnd.github.raw+json` (≤ 1 MB por archivo [verificado: https://docs.github.com/en/rest/repos/contents, vía R11]) solo para lockfiles (≤ 10), `.gitignore` y `.env*` (≤ 10). `coverage.detail.codebase.modo = 'arbol'`; los secretos del resto del código quedan «sin mirar».

### 09.5 Inventario y detección de stack

**Inventario** (`inventario.rutas`, ya sin la raíz común): entradas, leídas, omitidas y bytes por extensión. Alimenta las reglas de rutas (09.8), la elección de parsers (09.6) y la cobertura.

**Detección determinista** (`detectarStack()` en `packages/core/src/rules/codebase.ts`; sin red ni IA):

| Señal en el árbol o en el manifiesto | Campo | Valor |
|---|---|---|
| Extensiones por bytes (`.ts/.tsx`, `.js`, `.php`, `.py`, `.go`, `.rs`, `.dart`, `.rb`, `.java/.kt`) | `lenguajes[]` | top 5 `{nombre, archivos, bytes}` |
| `package.json` (`dependencies`/`devDependencies`): `react`, `next`, `vite`, `hono`, `express`, `vue`, `svelte`, `@supabase/supabase-js`, `stripe`, `@anthropic-ai/sdk`, `openai` | `frameworks[]`, `servicios[]` | p. ej. `["vite","react","hono"]`, `["supabase"]` |
| `composer.json` (`laravel/framework`, `symfony/*`), `requirements.txt`/`pyproject.toml` (`django`, `flask`, `fastapi`), `go.mod`, `Cargo.toml`, `pubspec.yaml` (`flutter`), `Gemfile` (`rails`) | `frameworks[]` | — |
| `wrangler.toml`/`.json`/`.jsonc` · `supabase/config.toml` o `supabase/migrations/` · `vercel.json` o `.vercel/` · `netlify.toml` · `firebase.json` · `Dockerfile` | `plataformas[]` | `cloudflare_workers`, `supabase`, `vercel`, `netlify`, `firebase`, `docker` |
| `.github/workflows/*.yml` | `ci[]` | `github_actions` |
| Lockfiles presentes | `gestores[]` | `npm`, `pnpm`, `yarn`, `composer`, `pip`, `go`, `pub`, `cargo` |

**Dónde se guarda:** en `scan_runs.coverage.detail.codebase` (jsonb de 05; la columna no tiene `check` de forma). El esquema `Coverage` de 15.5 no declara `detail` y zod lo **quita** al responder E12, así que el contrato no cambia; lo leen `estado/codebase.ts` (E6) y `stackDe()` de 11 (`package_manager` = primer valor de `stack.gestores` del último `scan_run` con `detail.codebase`). **Requisito para 15:** el paso `fin` debe escribir la cobertura **mezclando** (`coverage = coalesce(coverage, '{}'::jsonb) || jsonb_build_object('seen', …, 'total', …, 'missing', …)`) y no sustituyéndola, o borraría `detail` (ya en el paso `puntaje` de S15 15.8). `guardarDetalle()` hace lo mismo con `jsonb_set`.

```json
{ "fuente": "github", "repo": "gabriel/vanguard-demo-victima", "sha": "9f1c2ab…", "modo": "zip",
  "archivos": { "entradas": 41, "leidos": 23, "omitidos": 18 },
  "stack": { "lenguajes": [{"nombre":"TypeScript","archivos":9,"bytes":18234},{"nombre":"PHP","archivos":3,"bytes":2210}],
             "frameworks": ["hono","vite"], "servicios": ["supabase"], "plataformas": ["cloudflare_workers","supabase"],
             "ci": [], "gestores": ["npm","composer"] },
  "lockfiles": [{"ruta":"package-lock.json","deps":63},{"ruta":"panel-legacy/composer.lock","deps":2}],
  "deps_truncadas": false,
  "miradas": { "secretos": true, "dependencias": true, "osv": true, "kev": true, "historial": true, "ia": false } }
```

(Los números son de ejemplo; los reales de la víctima se anotan tras el primer escaneo.)

**Dónde entra la IA:** en P0 no hay llamada aparte. El stack viaja a IA-1 con la forma de 11 (`datos.stack = {provider, framework, package_manager, repo_full_name}`; `framework` = `null` en P0 según 11, P1: primer valor de `stack.frameworks`) y a IA-2, que relaciona módulos (p. ej. `CB_SECRET_SUPABASE_SERVICE_ROLE` + `SB_RLS_DISABLED`: «la clave que salta RLS está en tu repo **y** hay tablas sin RLS»). P2: si `frameworks` y `gestores` salen vacíos, una llamada a Haiku 5.5 (`effort:'low'`, ≤ 2000 tokens: 200 primeras rutas + conteo por extensión) propone el stack con `stack.origen:'ia'`; nunca cambia qué reglas corren. Necesita una ruta nueva en `RutaIA` y en el `check` de `vg_ai_reserve` (11); por eso es P2.

### 09.6 Lockfiles por ecosistema

Descubrimiento por nombre exacto de archivo en el inventario (fuera de `node_modules/` y `vendor/`, ya omitidos). Cada `Dep` guarda su `manifest` (monorepos con varios lockfiles). Si hay lockfile y manifiesto en la misma carpeta, manda el lockfile. Se deduplica por `(ecosystem, name, version)` antes de consultar (si el mismo paquete aparece en dos lockfiles, `manifest` = el primero por orden de ruta). Tope P0: **2000** dependencias distintas por escaneo (2 lotes de OSV; cifra de 15.10 [propuesta]); si hay más, se consultan primero las directas de runtime, luego las directas de dev y luego el resto, y `detail.codebase.deps_truncadas = true` (la UI dice «revisamos 2000 de N dependencias»).

```ts
// packages/core/src/lockfiles/types.ts — cadenas de ecosistema de OSV, con mayúsculas exactas [verificado: https://ossf.github.io/osv-schema/, vía R11]
export type Ecosistema = 'npm' | 'Packagist' | 'PyPI' | 'Go' | 'Pub' | 'crates.io';
export type Dep = { ecosystem: Ecosistema; name: string; version: string; dev: boolean; direct: boolean; manifest: string };
```

| Archivo | Ecosistema OSV | Prio | Cómo se lee | Directa / dev |
|---|---|---|---|---|
| `package-lock.json` v2/v3 | `npm` | P0 | `JSON.parse`; claves de `packages` con `node_modules/`; nombre = `v.name` si existe (alias `npm:`) y, si no, lo que va tras el **último** `node_modules/`; saltar `""` y `link:true` | `dev:true`; directas = claves de `packages[""].dependencies`/`devDependencies` |
| `package-lock.json` v1 | `npm` | P0 | `dependencies` recursivo (`version`, `dev`) | igual |
| `composer.lock` | `Packagist` | P0 | `packages[]` y `packages-dev[]` → `name`, `version` sin `v` inicial; saltar `dev-*` | `packages-dev` = dev; directas = `require` del `composer.json` hermano |
| `pnpm-lock.yaml` v5/v6/v9 | `npm` | P1 | `yaml` 2.9.1; claves de `packages`: quitar `/` inicial y sufijo `(...)` de peers, partir por el último `@` tras el índice 0 (v5: por la última `/`) [no verificado contra la especificación de pnpm] | `importers["."]` |
| `requirements.txt` (solo `==`), `go.mod`, `pubspec.lock` | `PyPI`, `Go`, `Pub` | P2 | regex / `yaml` (R11 §3) | — |
| `yarn.lock`, `poetry.lock`, `Cargo.lock` | `npm`, `PyPI`, `crates.io` | P2 | exigen `@yarnpkg/lockfile` o `smol-toml`, fuera del stack congelado: los agrega el orquestador si se adoptan | — |
| `package.json` sin lockfile | — | P1 | no se consulta OSV; `CB_NO_LOCKFILE` (low): «sin lockfile las versiones no son reproducibles» | — |

```ts
// packages/core/src/lockfiles/npm.ts (P0)
export function fromPackageLock(txt: string, manifest: string): Dep[] {
  const j = JSON.parse(txt);
  if (j.packages) {
    const root = j.packages[''] ?? {};
    const direct = new Set([...Object.keys(root.dependencies ?? {}), ...Object.keys(root.devDependencies ?? {})]);
    return Object.entries<any>(j.packages).filter(([k, v]) => k.includes('node_modules/') && v?.version && !v.link)
      .map(([k, v]) => { const clave = k.slice(k.lastIndexOf('node_modules/') + 13), name = v.name ?? clave;   // alias npm:
        return { ecosystem: 'npm' as const, name, version: v.version, dev: !!v.dev, direct: direct.has(clave), manifest }; });
  }
  const out: Dep[] = [];                                             // lockfileVersion 1
  const walk = (deps: Record<string, any> = {}, top: boolean) => { for (const [name, v] of Object.entries(deps)) {
    if (v?.version && !String(v.version).startsWith('file:')) out.push({ ecosystem: 'npm', name, version: v.version, dev: !!v.dev, direct: top, manifest });
    walk(v?.dependencies, false); } };
  walk(j.dependencies, true);
  return out;
}
// packages/core/src/lockfiles/composer.ts (P0)
export function fromComposerLock(txt: string, manifest: string, composerJson?: string): Dep[] {
  const j = JSON.parse(txt) as { packages?: { name: string; version: string }[]; 'packages-dev'?: { name: string; version: string }[] };
  const req = composerJson ? Object.keys(JSON.parse(composerJson).require ?? {}) : [];
  const m = (a: { name: string; version: string }[] = [], dev: boolean) => a.filter((p) => p.name && p.version && !p.version.startsWith('dev-'))
    .map((p) => ({ ecosystem: 'Packagist' as const, name: p.name, version: p.version.replace(/^v/, ''), dev, direct: req.includes(p.name), manifest }));
  return [...m(j.packages, false), ...m(j['packages-dev'], true)];
}
```

Un lockfile que no parsea no rompe el paso: queda `lockfiles[].error = 'parse'` en la cobertura y esa carpeta, «sin mirar».

### 09.7 Vulnerabilidades: OSV/GHSA, referencia CVE.org/NVD, KEV y EPSS

**Fuente principal: OSV.dev** (gratis, sin key; agrega GHSA, PYSEC, GO, RUSTSEC y paquetes maliciosos `MAL-*`; ya resuelve rangos `introduced/fixed`) [verificado: https://google.github.io/osv.dev/post-v1-querybatch/, vía R11]. NVD **no** se consulta por API (5 peticiones/30 s sin key; desde abr-2026 NIST solo enriquece KEV y software crítico [verificado: R11 §0]); CVE.org queda como enlace de referencia.

| Llamada | Endpoint | Límite / dato |
|---|---|---|
| Lote | `POST https://api.osv.dev/v1/querybatch` `{queries:[{package:{ecosystem,name},version}]}` → `results[i].vulns[{id,modified}]` | ≤ 1000 consultas por petición [verificado en vivo, R11]; respondió hoy con ids GHSA [verificado en vivo 24-oct] |
| Detalle | `GET https://api.osv.dev/v1/vulns/{id}` → `aliases`, `summary`, `affected[].ranges[].events`, `database_specific.severity` | caché en memoria por escaneo; máx. **300** ids distintos por escaneo, 5 en paralelo (15.3) |
| KEV (P1) | `GET https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json` (1,8 MB) | hoy `catalogVersion 2026.10.23`, `count 1756` [verificado en vivo 24-oct] |
| EPSS (P2) | `GET https://api.first.org/data/v1/epss?cve=CVE-A,CVE-B` (≤ 2000 car., ~100 CVE) | `epss` y `percentile` como texto, con `date` [verificado en vivo 24-oct] |
| Texto canónico (P2, bajo demanda en el panel) | `GET https://cveawg.mitre.org/api/cve/{CVE-ID}` | respondió 200 [verificado en vivo, R11] |

**Proceso (`apps/api/src/scans/osv.ts`):**
1. `querybatch` en trozos de 1000 → ids por dep. `next_page_token` (solo con > 1000 vulns por paquete) se registra y se ignora.
2. Detalle de cada id distinto (≤ 300 por escaneo, como 15.10; el resto entra sin detalle con `severity:'medium'` y `sin_detalle:true`). Presupuesto de subpeticiones del paso: ~4 a GitHub + 2 lotes + ≤ 300 detalles + 1 KEV (+ ≤ 20 de historial en P1) ≈ 330, con paralelismo máximo 5 (15.3).
3. **Dedupe por alias** dentro de cada dep: ids que comparten `id ∪ aliases` son un solo aviso (p. ej. `GO-2021-0113` y `GHSA-ppp9-7jff-5vj2` comparten `CVE-2021-38561` [verificado en vivo, R11]). Id visible: `CVE-*` si existe; si no, `GHSA-*`.
4. **Severidad** (canónicas §9.2): `database_specific.severity` `CRITICAL`→`critical`, `HIGH`→`high`, `MODERATE`→`medium`, `LOW`→`low`; `MAL-*`→`critical`. Sin ese campo (PYSEC/GO): si un alias es `GHSA-*` se pide ese registro; si no, `medium` con `severidad_por_defecto:true`. El vector CVSS se guarda como texto; no se calcula puntaje.
5. **Versión de arreglo**: `fixed` del rango (tipo `SEMVER` o `ECOSYSTEM`; los `GIT` se ignoran) cuyo `affected.package` coincide en nombre y ecosistema y contiene la versión actual (`introduced ≤ v < fixed`, comparación numérica por segmentos). Un rango que solo trae `last_affected` no da arreglo (`arreglo: null`). Ojo: un mismo aviso trae rangos de **otros paquetes** (`lodash-es`, `lodash-rails`…): solo cuenta el del paquete escaneado. Ejemplo: `facade/ignition` trae 4 rangos (arreglos 2.5.2, 2.4.2, 1.16.14, 1.6.15); para 2.5.1 el arreglo es **2.5.2** [verificado en vivo hoy: https://api.osv.dev/v1/vulns/GHSA-4qwp-7c67-jmcc].
6. **Un hallazgo `CB_DEP_VULN` por `ecosystem:name@version`** (no uno por aviso): severidad = la mayor de sus avisos; `version_arreglo` = la mayor de las `fixed` (si algún aviso no tiene arreglo, `version_arreglo` sigue siendo la mayor conocida y el panel lo avisa); `evidence.avisos[]` con hasta **10** (los más graves; el total va en `evidence.n_avisos`), para que la evidencia quede bajo el `check` de 16 KB de `findings.evidence` (05). «Sube lodash a 4.18.0» resuelve sus 6 avisos de una vez y la bandeja no se llena de filas repetidas. (S15 15.8 ya describe así el `resource` de dependencias.)

**Priorización** — `evidence.urgencia`, que el BACK usa para ordenar las filas del `EstadoModulo` (umbrales [propuesta], adaptados de R11 §2.5; el nombre evita chocar con P0/P1/P2 del plan). **KEV y EPSS no cambian `severity`**: canónicas §9.2 fija la severidad «según aviso» (15.7: KEV «sube prioridad»). Decidido en la fusión final: KEV **no** sube la severidad (canónicas §9.2, «según aviso»); solo pone la urgencia «ahora».

| `urgencia` | Regla | Texto UI |
|---|---|---|
| `ahora` | `MAL-*`; o (P1) un CVE del paquete en KEV; o (P2) `critical` con EPSS ≥ 0,10 | «Se explota en la vida real» / «Paquete malicioso» |
| `hoy` | `critical`/`high` en dependencia de runtime; o (P2) percentil EPSS ≥ 0,90 | «Alta, con arreglo disponible» si hay arreglo |
| `semana` | resto de runtime con arreglo | — |
| `backlog` | solo dev; o sin arreglo y (P2) EPSS < 0,01 | — |

KEV no lleva tabla: el paso lo baja con `fetch(KEV_URL, { cf: { cacheTtl: 21600, cacheEverything: true } })` y arma un `Set` de `cveID`, guardado también en una variable de módulo 24 h (15.7) (la caché de subpeticiones con `cf.cacheTtl` está [no verificado hoy]; sin caché son 1,8 MB por escaneo [verificado hoy: 1 807 090 bytes], aceptable). Si falla: `miradas.kev:false` y la UI dice «KEV sin mirar». Un CVE **no** dispara alertas: los `CB_*` solo crean hallazgos (canónicas §9.2).

**Referencias (`evidence.avisos[].refs`, solo enlaces, ≤ 4):** `https://osv.dev/vulnerability/<id>`, `https://nvd.nist.gov/vuln/detail/<CVE>`, `https://www.cve.org/CVERecord?id=<CVE>` y, si está en KEV, `https://www.cisa.gov/known-exploited-vulnerabilities-catalog`.

Datos de la demo consultados hoy en vivo (OSV `querybatch` + `vulns/{id}`, KEV y EPSS, 24-oct, re-verificados en esta revisión):

| Paquete | Avisos OSV | CVE | Severidad (canónicas §9.2) | Arreglo | KEV | EPSS (percentil) |
|---|---|---|---|---|---|---|
| npm `jquery@3.4.1` | `GHSA-jpcq-cgw6-v4j6` + `GHSA-gxr4-xjj5-5px2` (2) | CVE-2020-11023 y CVE-2020-11022 | MODERATE → `medium` (urgencia `ahora` por KEV, P1) | 3.5.0 | **sí** (solo CVE-2020-11023) | 0,849 (0,997) |
| Packagist `facade/ignition@2.5.1` | `GHSA-4qwp-7c67-jmcc` (1) | CVE-2021-3129 | CRITICAL → `critical` | 2.5.2 | **sí** | 0,999 (0,9997) |
| npm `lodash@4.17.15` | 6 GHSA (p. ej. `GHSA-35jh-r3h4-6jhm`) | HIGH: CVE-2021-23337, CVE-2020-8203, CVE-2026-4800; MODERATE: CVE-2020-28500, CVE-2025-13465, CVE-2026-2950 | `high` (la mayor) | 4.18.0 arregla los 6 | no (ninguno de los 6) | — |

### 09.8 `.gitignore`, `.env` subido e historial

| Regla | Prio | Condición exacta | Severidad | `confirmed` | `evidence` |
|---|---|---|---|---|---|
| `CB_ENV_COMMITTED` | P0 | ruta del inventario que casa `(^\|/)\.env(\.[\w-]+)?$` y **no** `\.env\.(example\|sample\|template)$` (canónicas §9.2) | critical | sí | `path`, `variables` (solo **nombres**, ≤ 30, de `^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=`), `gitignore_lo_lista`, (P1) `primer_commit` |
| `CB_GITIGNORE_NO_ENV` | P0 | no hay `.gitignore` en la raíz, o ninguna línea (sin comentarios `#` ni negaciones `!`) casa `^/?\.env` | medium | sí | `path:'.gitignore'`, `existe_gitignore` |
| `CB_ENV_IN_HISTORY` | P1 | `commits?path=` devuelve commits para una ruta `.env*` candidata que **no** está en HEAD | critical | sí | `path`, `commits[{sha7, fecha}]` (≤ 5; sin mensaje ni autor) |
| `CB_SENSITIVE_FILE` | P1 | `(^\|/)(id_rsa\|id_dsa\|id_ecdsa\|id_ed25519)$`, `\.(pem\|key\|p12\|pfx\|jks\|keystore)$`, `(^\|/)(credentials\|service[-_]?account[\w-]*\|firebase-adminsdk[\w-]*)\.json$`, `terraform\.tfstate(\.backup)?$`, `(^\|/)\.(npmrc\|pypirc)$` → high; `\.(sqlite3?\|db)$`, `(^\|/)(dump\|backup)[\w-]*\.sql$` → medium (R11 §4.1) | high/medium | sí | `path`, `tamano` |
| `CB_ZIP_HAS_GIT` | P1 | `inventario.tiene_git` en un ZIP | low | sí | — |

Si `.env` está commiteado **y** el `.gitignore` lo lista, el hallazgo lo dice: «el `.gitignore` no saca del repo lo que ya se commiteó: hace falta `git rm --cached .env`». Un `.env` subido también pasa por el escáner de secretos (09.9): la clave `service_role` dentro de él da además su `CB_SECRET_*`.

> **Decidido:** la condición canónica `^/?\.env` acepta una línea `.env.local` como si cubriera `.env` (falso negativo). Se implementa tal cual en P0; en P1 se comprueba que `.env` queda ignorado con un emparejador de patrones sencillo (`.env`, `/.env`, `.env*`, `*.env`, `**/.env`), sin dependencia nueva.

**Historial (P1, fase `repo:historial` dentro del paso `repo`; el token se vuelve a abrir con `withSecret`):** rutas candidatas = `.env`, `.env.local`, `.env.production`, `.env.development`, `.env.staging`, `backend/.env`, `server/.env`, `api/.env`, `supabase/.env`, `config/secrets.yml`, `credentials.json`, `serviceAccountKey.json`, más el `.env` hermano de cada `.env.example`/`.env.sample` del inventario; máximo 20 rutas → 20 llamadas `GET /repos/{o}/{r}/commits?sha={sha}&path={ruta}&per_page=5`. El filtro `path` devuelve commits aunque el archivo ya no exista en HEAD [verificado en vivo, R11 §4.1: `facebook/react`, `path=.travis.yml`]. Si la ruta está en HEAD, se agrega `evidence.primer_commit` al `CB_ENV_COMMITTED`. Mensaje: «Estuvo en tu repo desde el commit `a1b2c3d`. Borrarlo no basta: **rota** cada clave que tuvo.» Si una llamada falla (salvo 404 de ruta inexistente, que es «sin commits»), la fase devuelve `ok:false`, `miradas.historial:false` y el paso no auto-verifica (09.11). En P0 la fase no existe: `miradas.historial:false` y el `check` «Historial sin .env» sale «sin mirar». P2: barrer los `patch` de los últimos 100 commits aplicando las reglas de 09.9 solo a líneas `+` (R11 §4.1).

### 09.9 Secretos: reglas, entropía, enmascarado y huella

**Recorrido por archivo** (`packages/core/src/secrets/scan.ts`, puro): (1) archivos de texto leídos en 09.3 **menos** lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `composer.lock`, `*.lock`: sus hashes de integridad solo dan ruido); sí `.env*`, código, config, `.github/workflows/*`, `Dockerfile`, `*.md`. (2) **Prefiltro por palabra clave** como gitleaks: la regex de una regla solo corre si el archivo contiene alguna de sus `claves` (`includes`, barato; acota la CPU del paso). (3) `matchAll` con bandera `g`; línea = saltos de línea antes del índice. (4) Validación: JWT decodificado, lista de permitidos, entropía mínima. (5) Enmascarado + huella. (6) Agrupado por `(rule_id, huella)`: **un hallazgo por secreto** con hasta 20 `ubicaciones`.

| `rule_id` | Prio | Claves (prefiltro) | Regex JS (de R11 §4.2, origen gitleaks MIT salvo las de Supabase) | Severidad |
|---|---|---|---|---|
| `CB_SECRET_SUPABASE_SERVICE_ROLE` | P0 | `eyJ` | `/\b(ey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9\/\\_-]{17,}\.[a-zA-Z0-9\/\\_-]{10,}={0,2})/g` y el payload decodificado trae `role === 'service_role'`; `anon` se ignora (pública por diseño); otro rol: nada en P0 | critical |
| `CB_SECRET_SB_SECRET` | P0 | `sb_secret_` | `/\b(sb_secret_[A-Za-z0-9_-]{20,})/g` (prefijo [verificado: https://supabase.com/docs/guides/api/api-keys, vía R11]; longitud [no verificado]) | critical |
| `CB_SECRET_AWS` | P0 | `AKIA`, `ASIA`, `ABIA`, `ACCA`, `A3T` | `/\b((?:A3T[A-Z0-9]\|AKIA\|ASIA\|ABIA\|ACCA)[A-Z2-7]{16})\b/g`, entropía ≥ 3 | critical |
| `CB_SECRET_STRIPE_LIVE` | P0 | `_live_`, `_prod_` | `/\b((?:sk\|rk)_(?:live\|prod)_[a-zA-Z0-9]{10,99})/g` (`sk_test_` no cuenta) | critical |
| `CB_SECRET_ANTHROPIC` | P0 | `sk-ant-` | `/\b(sk-ant-(?:api03\|admin01)-[a-zA-Z0-9_\-]{93}AA)/g` | critical |
| `CB_SECRET_OPENAI` | P0 | `T3BlbkFJ` | `/\b(sk-(?:proj\|svcacct\|admin)-(?:[A-Za-z0-9_-]{74}\|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}\|[A-Za-z0-9_-]{58})\b\|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})/g`, entropía ≥ 3 | critical |
| `CB_SECRET_GITHUB_PAT` | P0 | `ghp_`, `github_pat_` | `/\b(ghp_[0-9a-zA-Z]{36}\|github_pat_\w{82})/g`, entropía ≥ 3 | critical |
| `CB_SECRET_PRIVATE_KEY` | P0 | `PRIVATE KEY` | `/-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----/gi` | critical |
| `CB_SECRET_POSTGRES_URL` | P0 | `postgres` | `/\b(postgres(?:ql)?:\/\/[^:\s\/]+:([^@\s\/]{6,})@[^\s'"\x60]+)/g`; se ignora si la contraseña está en la lista de permitidos o el host (sin puerto) es **exactamente** `localhost`, `127.0.0.1`, `db` o `postgres` (`db.<ref>.supabase.co` **no** se ignora). Una contraseña con `/` o `@` sin codificar no casa: la de la víctima va en hex (09.13) | critical si el host contiene `supabase.co` o `pooler.supabase.com`; si no, high |
| `CB_SECRET_GENERIC` | P1 | `secret`, `token`, `key`, `passw`, `auth`, `credential` | asignación `(access\|auth\|api\|credential\|creds\|key\|passw(?:or)?d\|secret\|token)[\w.-]{0,20}\s*[:=]\s*['"]?([A-Za-z0-9_\-+/=.]{16,150})` con bandera `i` y entropía ≥ **3,5** sobre el grupo | medium |

> **Decidido (canónicas §9.2 ya corregidas):** las canónicas decían «regex de R11 §4.2 (bandera `i`)». La bandera `i` se pone **solo** donde gitleaks trae `(?i)` (clave privada, genérica): ponerla en todas haría casar `akia…` en minúsculas y dispararía falsos positivos. JS no acepta el `(?i)` inicial de Go [verificado en vivo con Node 24, R11 §4.2].

**Lista de permitidos** (se descarta): valores que casan `/(example|sample|dummy|placeholder|changeme|your[_-]?(api[_-]?)?key|x{6,}|<[^>]+>|\$\{[^}]+\}|process\.env|import\.meta\.env)/i`. Rutas `__tests__/`, `fixtures/`, `*.test.*`, `*.spec.*`: **no** se descartan, bajan a `low` con `en_pruebas:true` (R11 §4.3). **Agravante (P1):** si en la misma línea la variable casa `\b(VITE|NEXT_PUBLIC|EXPO_PUBLIC|REACT_APP|PUBLIC)_[A-Z0-9_]*` o el archivo está bajo `src/`, `app/`, `pages/`, `components/` o `public/` de un stack con `vite`/`react`/`next`, `agravante:'expuesto_en_bundle'` y el título añade «(se publica en el navegador)».

```ts
// packages/core/src/secrets/{entropy,scan}.ts (P0)
export const entropia = (s: string) => { const f = new Map<string, number>(); for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let h = 0; for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); } return h; };   // Shannon por carácter
export const enmascarar = (v: string, rule: string) =>
  rule === 'CB_SECRET_PRIVATE_KEY' ? '-----BEGIN … PRIVATE KEY-----'
  : rule === 'CB_SECRET_POSTGRES_URL' ? v.replace(/:\/\/([^:\s\/]+):[^@\s\/]+@/, '://$1:••••@')
  : v.length >= 24 ? `${v.slice(0, 4)}…${v.slice(-4)}`                 // 4+4 como 15.10 (JWT, PAT, sb_secret_…)
  : v.length >= 12 ? `${v.slice(0, 4)}…` : '…';                        // corto: 4+4 revelaría media clave
export function rolJwt(tok: string): string | null {             // solo clasifica; no verifica firma
  try { const b = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return (JSON.parse(atob(b + '='.repeat((4 - b.length % 4) % 4))) as { role?: string }).role ?? null; } catch { return null; }
}
export type Coincidencia = { rule_id: string; valor: string; path: string; line: number; snippet: string };
// scanArchivo(path, texto) → Coincidencia[]; luego, por cada valor: huella = await opts.huella(valor), donde opts.huella es
// (v) => fingerprint(keys, orgId, v) de @vanguard/core/crypto (05.7): HMAC(FPK, `${orgId}|${v.trim()}`), la MISMA que guarda
// connection_secrets.fingerprint (si se usara otra entrada, CB_KEY_REUSE nunca casaría). preview = enmascarar(...),
// snippet = línea con el valor sustituido por [SECRET:<rule_id>], recortada a 160 car. y pasada por redact().
// El objeto `Coincidencia` (con `valor`) NUNCA sale de la función analizarArchivos().
```

**Qué se guarda de un secreto:** `preview`, `fingerprint_short` (8 primeros hex de la huella, como en el ejemplo de 15 E13), `ubicaciones[{path, line, origen:'head'|'historial'}]`, `snippet` redactado. La huella completa solo existe en memoria del paso (para agrupar ubicaciones y para `CB_KEY_REUSE`); **no** se guarda en `evidence` (15.10 dice guardarla y quitarla al responder; aquí ni se guarda, que es más simple y cubre también export y MCP; S15 15.10 ya lo hace así). **Nunca** se verifica contra el proveedor si la clave sigue viva (usar credenciales ajenas encontradas es un problema legal; solo se pide rotarla, R11 §4.4).

**`CB_KEY_REUSE` (P1, critical, confirmado):** candidatas = todas las coincidencias de las reglas anteriores más cualquier valor de 20–200 car. asignado a una clave que contenga `SECRET|TOKEN|KEY|PAT`, también en JSON/JSONC/YAML (`/["']?([A-Za-z0-9_.-]*(?:SECRET|TOKEN|KEY|PAT)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([^"'\s,;]{20,200})/gi`; máx. 1000 por escaneo). **Comparación en memoria, sin mandar huellas a la base:** `credentials.ts` (única puerta a `connection_secrets`, 05.7/15.2) gana una función de solo lectura `fingerprintsOfOrg(env, admin, orgId): Promise<Map<string, string>>` (huella → `connection_id`) = `select connection_id, fingerprint from connection_secrets where org_id = $1` (una org tiene pocas conexiones); luego `connections` da `provider` y `label`. Nunca entre orgs (la huella lleva el `org_id` dentro, 05.7). `resource` = la primera ubicación (09.11); `evidence.conexion = {id, provider, label}`.

Título: «El token de Cloudflare que cargaste en VanGUARD está en `wrangler.jsonc`». Es la idea de «hash con pimienta» del dueño en el lugar donde sí sirve.

### 09.10 Revisión IA de archivos de riesgo (P2) con presupuesto

| Aspecto | Decisión |
|---|---|
| Selección (determinista) | Puntaje = coincidencias de reglas + ruta que casa `/(api\|route\|middleware\|auth\|login\|session\|admin\|webhook\|upload\|payment\|checkout\|supabase\/functions\|migrations)/i` + configuración del framework. Los **15** primeros, cada uno recortado a 400 líneas, con secretos ya sustituidos por `[SECRET:<rule_id>]` |
| Modelo y ajustes | `claude-sonnet-5-5`, `output_config.effort:'medium'`, `max_tokens` 4000, sin herramientas, system congelado ≥ 512 tokens con `cache_control` (11) |
| Presupuesto | Entrada recortada a **180 000 caracteres** (≈ 60 000 tokens con la cota `ceil(caracteres / 3)` que usa `llamarIA` para el peor caso, 15.10; `count_tokens` solo en pruebas); peor caso 60k × 2 + 4k × 10 USD/MTok = **0,16 USD** por auditoría [cálculo propio con precios de canónicas §8]. 1 llamada por auditoría; nunca para el viewer; solo en nivel `normal` (gasto del día < 70 %, escalera de 11); en la org de demo se corre una vez y queda guardado |
| Entrada | Cada archivo en `<file path="…" lines="1-400">` dentro de `<datos_no_confiables>` (`bloqueNoConfiable()` de R12 §14) junto con las coincidencias de reglas para confirmar o descartar |
| Salida (`zodOutputFormat`) | `{hallazgos:[{path, line, cwe:/^CWE-\d{1,4}$/, titulo≤120, linea_evidencia≤300, por_que≤600, severidad_sugerida:'high'\|'medium'\|'low', texto_sospechoso_de_instrucciones:boolean}]≤15}` |
| Antialucinación | Se descarta todo hallazgo cuyo `path` no se envió o cuyo `linea_evidencia.trim()` no aparezca literal en las líneas `line−3 … line+3` del archivo enviado |
| Cómo se guarda | `rule_id:'CB_AI_REVIEW'`, `origin:'ai'`, `confirmed:false`, **`severity = min(severidad_sugerida, 'medium')`** (la regla decide, canónicas §8), `suspected_injection` desde la bandera; la UI lo marca «IA — revisar» |
| `resource` / dedupe | `path:line#CWE-n` (dos CWE en la misma línea no chocan) |
| Requisito de otras secciones (P2) | Agregar `code_review` al tipo `RutaIA`, a la tabla `RUTAS` y al `check` de rutas de `vg_ai_reserve` (11); agregar `revision_ia` a `ScanStep.name` (15.5). Con `p_complete:true`, `vg_upsert_findings` marcaría `verified` los `CB_AI_REVIEW` de una auditoría donde la IA no corrió: el paso `revision_ia` debe llamar a la RPC con `p_complete:false` |

### 09.11 Formato de hallazgo, deduplicación y prompts de corrección

| Columna de `findings` (canónicas §6) | Valor en Codebase |
|---|---|
| `module` | `codebase` |
| `rule_id` / `severity` / `confirmed` | de la regla (09.7–09.10); `confirmed:false` solo en `CB_AI_REVIEW` y en deps con `sin_detalle` |
| `origin` | `rule`; `ai` en `CB_AI_REVIEW`; `provider` (P2, Dependabot) |
| `connection_id` | no va en la fila: lo fija la RPC con `p_conn` (la conexión `github`; `null` en ZIP) |
| `title` | `templates/titles.ts`, español, ≤ 120 car. (la columna admite 200) |
| `resource` (único dentro de `rule_id`, porque de él sale el `dedupe_key`) | Secretos y `CB_KEY_REUSE`: `path:line` de la **ubicación principal** del secreto = la primera tras ordenar (archivos que no son `.env*` antes que `.env*`; luego `path` y `line`), así el mismo secreto en `.env` y en el código es **un** hallazgo · `.env`, sensibles, historial: `path` · `.gitignore` · deps: `npm:jquery@3.4.1` · IA: `path:line#CWE-n`. **ZIP:** se antepone `zip:<filename>/` (`zip:proyecto.zip/src/a.ts:4`), para que un ZIP nunca pise ni auto-verifique los hallazgos del repo y volver a subir el mismo archivo actualice los suyos. Si pasa de 300 car. (límite de la columna, 05), se recorta por la izquierda con `…` y la ruta completa queda en `evidence.path` |
| `evidence` | `CodebaseEvidence` (abajo), siempre pasada por `redact()`; ≤ 12 KB serializada (el `check` de 05 es 16 KB): si se pasa, se recortan `avisos` y `ubicaciones` |
| `dedupe_key` | **`dedupeKey(org_id, rule_id, resource)`** de `packages/core/src/crypto.ts` = `sha256hex(org_id\|rule_id\|resource)` (05.7; fórmula única para todos los módulos) |

```ts
// packages/contracts/src/codebase.ts (ORQUESTADOR; todo opcional: se puede agregar tras el congelamiento de las 11:00,
// porque Finding.evidence es record<string, unknown> en 15.5; este esquema valida la evidencia CB_* en BACK y fixtures)
export const CodebaseEvidence = z.object({
  fuente: z.enum(['github', 'zip']).optional(), sha: z.string().max(40).optional(),
  path: z.string().max(512).optional(), line: z.number().int().min(1).optional(),     // 13 los usa para `location` (SARIF/export)
  preview: z.string().max(48).optional(), fingerprint_short: z.string().regex(/^[0-9a-f]{8}$/).optional(), snippet: z.string().max(200).optional(),
  ubicaciones: z.array(z.object({ path: z.string().max(512), line: z.number().int().min(1), origen: z.enum(['head', 'historial']) })).max(20).optional(),
  agravante: z.enum(['expuesto_en_bundle']).optional(), en_pruebas: z.boolean().optional(),
  variables: z.array(z.string().max(64)).max(30).optional(), gitignore_lo_lista: z.boolean().optional(), existe_gitignore: z.boolean().optional(),
  primer_commit: z.string().length(7).optional(), tamano: z.number().int().optional(),
  commits: z.array(z.object({ sha7: z.string().length(7), fecha: z.string() })).max(5).optional(),
  paquete: z.object({ ecosystem: z.string(), name: z.string(), version: z.string(), manifest: z.string(), direct: z.boolean(), dev: z.boolean() }).optional(),
  version_arreglo: z.string().nullable().optional(), urgencia: z.enum(['ahora', 'hoy', 'semana', 'backlog']).optional(),
  n_avisos: z.number().int().optional(), sin_detalle: z.boolean().optional(),
  avisos: z.array(z.object({ id: z.string(), aliases: z.array(z.string()).max(5), severidad: Severity, resumen: z.string().max(200),
    arreglo: z.string().nullable(), kev: z.boolean().optional(), epss: z.number().optional(), refs: z.array(z.string()).max(4) })).max(10).optional(),
  conexion: z.object({ id: z.string(), provider: z.string(), label: z.string() }).optional(),
  cwe: z.string().optional(), por_que: z.string().max(600).optional(),
});
```

En dependencias, `path` = `paquete.manifest` (sin `line`), para que 13 tenga `location` en todo hallazgo `CB_*`.

```json
{ "module": "codebase", "rule_id": "CB_DEP_VULN", "severity": "medium", "confirmed": true, "origin": "rule",
  "title": "jquery 3.4.1 tiene 2 vulnerabilidades; una se explota en la vida real (CVE-2020-11023)",
  "resource": "npm:jquery@3.4.1",
  "evidence": { "fuente": "github", "sha": "9f1c2ab…", "path": "package-lock.json", "urgencia": "ahora", "version_arreglo": "3.5.0", "n_avisos": 2,
    "paquete": { "ecosystem": "npm", "name": "jquery", "version": "3.4.1", "manifest": "package-lock.json", "direct": true, "dev": false },
    "avisos": [{ "id": "CVE-2020-11023", "aliases": ["GHSA-jpcq-cgw6-v4j6"], "severidad": "medium", "kev": true, "arreglo": "3.5.0",
      "resumen": "XSS al pasar HTML no confiable a métodos de manipulación del DOM",
      "refs": ["https://osv.dev/vulnerability/GHSA-jpcq-cgw6-v4j6", "https://nvd.nist.gov/vuln/detail/CVE-2020-11023",
               "https://www.cve.org/CVERecord?id=CVE-2020-11023", "https://www.cisa.gov/known-exploited-vulnerabilities-catalog"] },
      { "id": "CVE-2020-11022", "aliases": ["GHSA-gxr4-xjj5-5px2"], "severidad": "medium", "kev": false, "arreglo": "3.5.0",
      "resumen": "XSS al pasar HTML no confiable a métodos de manipulación del DOM",
      "refs": ["https://osv.dev/vulnerability/GHSA-gxr4-xjj5-5px2", "https://nvd.nist.gov/vuln/detail/CVE-2020-11022"] }] } }
```

El hallazgo de secreto sigue la forma de 15 (E13): `{"rule_id":"CB_SECRET_SUPABASE_SERVICE_ROLE","severity":"critical","resource":"src/lib/supabaseAdmin.ts:4","evidence":{"fuente":"github","preview":"eyJh…Xk9Q","path":"src/lib/supabaseAdmin.ts","line":4,"fingerprint_short":"7f3a91c2","ubicaciones":[{"path":"src/lib/supabaseAdmin.ts","line":4,"origen":"head"},{"path":".env","line":2,"origen":"head"}],"agravante":"expuesto_en_bundle","snippet":"const KEY = import.meta.env.VITE_SB_ADMIN ?? \"[SECRET:CB_SECRET_SUPABASE_SERVICE_ROLE]\""}}` (`ubicaciones` incluye la principal; `agravante` es P1).

**Escritura (P0): una sola llamada a la RPC `vg_upsert_findings` de 15.12 con argumentos con nombre** — `rpc('vg_upsert_findings', {p_org, p_scan, p_module:'codebase', p_conn: <conexión github, o null en ZIP>, p_rows, p_complete})` (no un `upsert` propio): inserta o actualiza por (`org_id`, `dedupe_key`) conservando `status`, `first_seen_at` y `fix_prompt`; respeta `ignored`; reabre `fixed`/`verified` con `status_reason = 'reapareció'`; y con `p_complete = true` marca `verified` (con `verified_at`) los hallazgos `codebase` abiertos o `fixed` que esta auditoría ya no vio. Cada fila de `p_rows` = `{rule_id, severity, confirmed, origin, title, resource, evidence, dedupe_key, suspected_injection}` (sin `connection_id`, que lo fija la función); tope 200 filas por escaneo, por severidad (el resto se cuenta en `detail.codebase.hallazgos_omitidos`). **Cuándo `p_complete = true`:** solo en el paso `repo`, y solo si OSV respondió y (P1) el historial también; **nunca** en el paso `zip` ni en `revision_ia`. La auto-verificación de la RPC solo toca hallazgos de esa misma conexión (`connection_id is not distinct from p_conn`, 15.12), así que una auditoría de repo ya no puede marcar `verified` los hallazgos de un ZIP. Si el `check` `looks_like_secret` tumba el lote, se reintenta fila a fila y la que falla se descarta como `tripwire` (15.8, regla 7).

**Prompts de corrección.** IA-1 (`POST /findings/:id/fix-prompt`, Sonnet 5.5, ruta `fix_prompt` de 11) recibe dentro de `<datos_no_confiables>` exactamente la forma de 11: `{hallazgo: {rule_id, severity, confirmed, title, resource, module, evidence}, stack: {provider, framework, package_manager, repo_full_name}}` (09.5); nunca un valor secreto (no existe guardado). Si la IA está apagada, sin presupuesto, rechaza o el filtro de `untrusted.ts` tumba la salida, se sirve la **plantilla fija** de `templates/fix-prompt.ts` con el mismo esquema `{contexto, pasos[], prompt_para_tu_ia, prueba_de_aceptacion}`:

| `rule_id` | `pasos[]` de la plantilla (resumen) | `prueba_de_aceptacion` |
|---|---|---|
| `CB_SECRET_*` | 1) **Rotar** la clave en el proveedor (Supabase: *Settings → API keys*; GitHub: revocar el token); 2) sacar el valor del código a una variable de entorno de servidor (`wrangler secret put`, nunca `VITE_`/`NEXT_PUBLIC_`); 3) cambiar el código para leerla del entorno; 4) (opcional) limpiar el historial: no sustituye a rotar | «VanGUARD re-escanea y `CB_SECRET_*` pasa a verificado; la clave vieja da 401» |
| `CB_ENV_COMMITTED` | 1) `git rm --cached <path>`; 2) añadir `.env` y `.env.*` (salvo `.env.example`) al `.gitignore`; 3) crear `.env.example` con las mismas variables vacías: `{variables}`; 4) rotar las que sean secretas | «`.env` ya no está en el repo y `CB_GITIGNORE_NO_ENV` desaparece» |
| `CB_DEP_VULN` | 1) subir `{name}` de `{version}` a `{version_arreglo}` en `{manifest}` (`npm install {name}@{version_arreglo}` / `composer require {name}:^{version_arreglo}`); 2) correr las pruebas; 3) revisar cambios rotos en el changelog | «OSV no devuelve avisos para `{name}@{nueva}`» |

`prompt_para_tu_ia` de `CB_DEP_VULN` (texto exacto de plantilla): «Soy el dueño de este repo y quiero corregir una dependencia vulnerable. En `{manifest}` uso `{name}` `{version}`, afectada por `{ids}` (detalle: https://osv.dev/vulnerability/{id}). Actualízala a `{version_arreglo}` o superior, ajusta el código que rompa por el cambio de versión, y dime qué pruebas correr. No toques otras dependencias.» Prompt de todo el módulo de una vez: «Exportar» con `module=codebase` (13).

> **Nota (filtro de salida):** (1) el filtro determinista `checkFixPrompt` de 15.10 ya usa patrones concretos (`rm -rf`, `drop table|database`, desactivar RLS, `curl … | sh`…), así que **no** tumba `git rm --cached .env` ni `git filter-repo` de los prompts de Codebase; si alguien lo amplía a «borrar» por palabra suelta, se rompen estas plantillas (añadir esa prueba a `untrusted.test.ts`). (2) La lista permitida de URLs no incluye `www.cve.org` ni `www.cisa.gov`; los prompts usan solo `osv.dev` y `nvd.nist.gov` (permitidos) y los enlaces a CVE.org/CISA quedan en el panel, fuera del prompt.

### 09.12 Pantallas y botones (FRONT)

**A. Conexiones › tarjeta GitHub (P0).** Asistente `/o/:orgId/connections/github` de 14.10. Campos «Repositorio (`dueño/repo` o URL)» (el FRONT normaliza a `owner/repo` antes de enviar, 09.2) y «Token fine-grained» (`type=password`, sin autocompletar; pre-guarda de 14.10 para `gh[pousr]_`), la guía de 4 pasos de 09.2 desplegada por defecto, botón principal «Conectar GitHub». Tras conectar, la tarjeta de 14.10: repo y rama en mono, privado sí/no, permisos de `checks`/`capabilities` (✓ Contents, ✓ Metadata, — Dependabot), `••••a1b2`, caducidad, «Probar conexión» y «Quitar» (`ConfirmarEnSitio`; tras el `204`, enlace de `X-VG-Revoke-Url` para revocar el token en GitHub).

**B. Módulo Codebase (P0)** = `<PantallaModulo modulo="codebase"/>` sobre `GET /api/orgs/:org/modules/codebase/state` (15, E6) + sección propia «Repositorio» (14.12: `repo_full_name` en mono, `default_branch`, sha corto y hora del último análisis, `BotonGrande` «Analizar repo ahora»). El BACK (`estado/codebase.ts`) lee los hallazgos `codebase` abiertos y el `detail.codebase` del último `scan_run` con ese detalle (09.5), y arma:

| Parte de `EstadoModulo` | Contenido |
|---|---|
| `cifras` | `cb_archivos` «Archivos revisados» (n leídos, `de` = entradas) · `cb_deps` «Dependencias» (n, `sub` = «en 2 lockfiles»; «2000 de N» si `deps_truncadas`) · `cb_vulnerables` «Con vulnerabilidades» (paquetes con aviso, `rol:'mal'` si > 0) · `cb_secretos` «Secretos en el código» (`rol:'mal'` si > 0) · `cb_kev` «Explotadas activamente» (P1). Sin escaneo: `n:null` |
| `ahora` (grupos) | `secretos` «Secretos y archivos .env» · `dependencias` «Dependencias con vulnerabilidades» (orden por `urgencia` y luego severidad) · `config` «Configuración del repo» (`.gitignore`, archivos sensibles) · `ia` «Revisión IA — revisar» (P2) |
| `FilaDato` de ejemplo (P1, con KEV) | `{clave:<finding.id>, modulo:'codebase', tipo:'finding', rol:'mal', etiqueta:'jquery 3.4.1 → 3.5.0', objeto:'npm:jquery@3.4.1', chips:['CVE-2020-11023','KEV'], sub:'2 avisos · se explota en la vida real', severidad_cve:'medium', acciones:[{verbo:'Generar prompt', clase:'prompt', principal:true, args:{finding_id:<finding.id>}}]}` (`etiqueta` ≤ 40 car. por `FilaDato` de 15.5; «Copiar para mi IA» vive en el panel, 13.6, no en la fila: la clase `copiar` exige un texto `copiar` que la fila no tiene) |
| `checks` (`ChecksEnCero`) | `CB_ENV_COMMITTED` «.env fuera del repo» · `CB_GITIGNORE_NO_ENV` «.gitignore cubre .env» · `CB_SECRET` «Sin secretos en el código» · `CB_DEP_VULN` «Dependencias sin CVE conocidos» · `CB_ENV_IN_HISTORY` «Historial sin .env» (P1) · `CB_KEV` «Nada explotado activamente» (P1). `comprobado:false` y `n:null` si `miradas.*` es `false` (P0: historial y KEV): se pinta «sin mirar», nunca verde |

**C. Panel de detalle (P0, `PanelDetalle`).** Según `rule_id`: deps → tabla de avisos (ID, CVE, severidad, chapa «Explotada activamente» si `kev`, EPSS % en P2, versión de arreglo) y enlaces; secretos → `preview`, ubicaciones, chapa «Se publica en el navegador» si hay agravante, lista «Qué hacer ya: 1. Rótala…»; `.env` → nombres de variables; historial → commits (`sha7`, fecha). Enlaces externos como `<a target="_blank" rel="noopener noreferrer">` solo a `github.com`, `osv.dev`, `nvd.nist.gov`, `www.cve.org`, `www.cisa.gov`; «Ver en GitHub» = `https://github.com/{repo}/blob/{sha}/{path}#L{line}` con cada segmento de `path` pasado por `encodeURIComponent` (no existe en ZIP). Debajo, `DialogoPrompt` de 13 con lo que devuelva E15 y su «Copiar para mi IA». Origen visible en cada fila: «Regla» o «IA — revisar».

**D. Subir un ZIP (P1).** Zona de arrastre + `<input type="file" accept=".zip,application/zip">`; antes de subir comprueba extensión y ≤ 25 MB; `POST /scans {kind:'zip', filename, size_bytes}` → `PUT …/uploads/zip/{scan_run_id}` con `fetch(url, {method:'PUT', body: file})` (el navegador pone `Content-Length`, 14.12; sin barra de progreso de subida en P1) → página de progreso `/audit/{scan_run_id}`. `filename` se sanea en el FRONT para que case `^[\w .()-]{1,120}\.zip$` (los demás caracteres pasan a `_`). Aviso fijo: «Borramos el ZIP al terminar el análisis (como mucho en 24 h). Solo guardamos los hallazgos.»

**Progreso:** `scan_runs.step` del módulo es `repo:<fase>` o `zip:<fase>`; el FRONT lo traduce en `/audit/:scanId` (14.14): `descargando` «Descargando el repo», `leyendo` «Abriendo el ZIP», `analizando` «Buscando secretos y .env», `dependencias` «Consultando vulnerabilidades (OSV)», `historial` «Revisando el historial», `guardando` «Guardando hallazgos»; otro valor → se pinta tal cual.

| Botón (texto exacto) | Dónde | Llamada | Quién | Estados |
|---|---|---|---|---|
| «Conectar GitHub» | A | `POST /connections` | admin | «Probando permisos…» → éxito o el `error.message` de 09.2 |
| «Abrir GitHub» | guía | enlace de pre-relleno de 09.2 | todos | — |
| «Analizar repo ahora» (`BotonGrande`, ≥ 56 px) | B | `POST /scans {kind:'repo'}` → `/audit/{scan_run_id}` (sondeo de `GET /scans/:id` cada 2 s, 14.14) | admin; viewer: deshabilitado «Modo demo: solo lectura» | `409 conflict` → «Ya hay un análisis en curso» y enlace a él (`details.scan_run_id`); `429 rate_limited` → «Demasiados intentos; espera un minuto». (El tope de 3/día y su `429 budget_exceeded` son solo de `full_audit`, E11) |
| «Subir ZIP» | B/D | `POST /scans {kind:'zip'}` + E23 | admin | P1; errores de 09.3 |
| «Generar prompt de corrección» | fila y C | `POST /findings/:id/fix-prompt` | admin; viewer solo caché | «Redactando…» (≤ 10 s) o plantilla con aviso «IA en pausa» |
| «Copiar para mi IA» | C (`DialogoPrompt`, 13.6) | portapapeles | todos | «Copiado» |
| «Marcar como corregido» / «Ignorar» (pide motivo 3–300) | C | `PATCH /findings/:id` | admin | — |
| «Verificar arreglo» | C | `POST /findings/:id/verify` (E16: baja el zipball de nuevo, corre solo `params.rule_id` y llama a `vg_upsert_findings` con `p_rule`) | admin | P1; en ZIP no aplica (hay que volver a subirlo) |

**Vacíos y errores:** sin conexión → `Vacio` «Conecta GitHub para ver este módulo» con `BotonGrande` «Conectar GitHub» (y «o sube un ZIP», P1). El código de `steps[i].error_code`/`scan_runs.error` se traduce con el mapa de 09.3 y se ofrece «Reintentar».

### 09.13 Repo vulnerable sembrado para la demo

Activo nuestro (canónicas §11): repo **privado** `vanguard-demo-victima` en la cuenta personal de Gabriel; PAT fine-grained solo de ese repo, *Contents: Read-only*, 30 días, pegado por Gabriel en la org de demo (nunca en el chat ni en el repo). Privado y con valores **falsos**: Supabase revoca claves que aparecen en repos públicos (canónicas §4).

```
vanguard-demo-victima/
├─ .gitignore                         node_modules/ y dist/ — NO ignora .env           → CB_GITIGNORE_NO_ENV
├─ .env                               (generado) línea 1 SUPABASE_URL, línea 2 SUPABASE_SERVICE_ROLE_KEY (JWT falso role=service_role),
│                                     línea 3 DATABASE_URL=postgresql://postgres:<falsa, 32 hex>@db.<ref-victima>.supabase.co:5432/postgres
│                                                                                       → CB_ENV_COMMITTED + 2 × CB_SECRET_*
├─ package.json / package-lock.json   hono, vite, @supabase/supabase-js, jquery 3.4.1, lodash 4.17.15, versiones exactas
│                                     (lockfile real: npm install --package-lock-only) → 2 × CB_DEP_VULN; stack «supabase»
├─ src/index.ts                       copia de apps/victima (Hono): /admin sin auth (lo usa la demo en vivo)
├─ src/lib/supabaseAdmin.ts           import.meta.env.VITE_SB_ADMIN ?? "<mismo JWT falso>" → CB_SECRET_SUPABASE_SERVICE_ROLE con agravante (P1)
├─ wrangler.jsonc                     name, main, compatibility_date (→ stack cloudflare_workers) y, en P1,
│                                     vars.VG_INGEST_SECRET = secreto de la conexión ingest «señuelo»  → CB_KEY_REUSE
├─ panel-legacy/composer.json + composer.lock   solo facade/ignition 2.5.1 (lock escrito a mano, sin composer) → CB_DEP_VULN critical (KEV)
└─ supabase/migrations/0001_pedidos.sql         create table public.pedidos sin RLS     → (P2) CB_SQL_NO_RLS, espejo de SB_RLS_DISABLED
Historial: commit 2 añade .env.production; commit 3 lo borra                           → (P1) CB_ENV_IN_HISTORY
```

**Script `demo/sembrar-repo.mjs` (ORQUESTADOR):** `node demo/sembrar-repo.mjs <ruta-del-clon> --ref <ref-victima> [--ingest-secret-file <ruta>]`. Copia `demo/repo-vulnerable/` (que **no** contiene ningún valor falso), genera los valores con `crypto.randomBytes` armando cada cadena por concatenación dentro del script (la contraseña de `DATABASE_URL` en **hex**, para que no lleve `/` ni `@` y la regex de 09.9 la case; el JWT = cabecera `{"alg":"HS256","typ":"JWT"}` + payload `{"iss":"supabase","ref":<ref>,"role":"service_role","iat":1729700000,"exp":2045276000}` firmado con una clave aleatoria que se descarta), escribe los archivos y hace los commits en orden con `execFileSync('git', …)` (git ya está instalado; ningún binario nuevo): c1 base, c2 `.env.production`, c3 `git rm .env.production`, c4 `.env` + `supabaseAdmin.ts` + `wrangler.jsonc`; luego `git push`. **Nunca** imprime los valores (solo «sembrado: CB_ENV_COMMITTED…»). Así ni nuestro monorepo ni sus pruebas contienen literales con forma de secreto: no disparan el propio escáner de VanGUARD al auditarse (06, D3). La conexión ingest «señuelo» se crea en la org de demo solo para esto (no la usa la víctima, que tiene la suya) y su secreto llega al script por archivo, nunca por el chat.

| Hallazgo esperado tras «Analizar repo ahora» | Severidad | Prio |
|---|---|---|
| `CB_ENV_COMMITTED` `.env` (variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`) | critical | P0 |
| `CB_SECRET_SUPABASE_SERVICE_ROLE` (un solo hallazgo, `resource` `src/lib/supabaseAdmin.ts:4`, ubicaciones `src/lib/supabaseAdmin.ts:4` y `.env:2`) | critical | P0 |
| `CB_SECRET_POSTGRES_URL` `.env:3` (host `supabase.co`) | critical | P0 |
| `CB_DEP_VULN` `facade/ignition@2.5.1` → 2.5.2 | critical | P0 (urgencia «ahora» por KEV en P1) |
| `CB_DEP_VULN` `jquery@3.4.1` → 3.5.0 (2 avisos) | medium (KEV en P1 solo cambia la urgencia, 09.7) | P0 |
| `CB_DEP_VULN` `lodash@4.17.15` → 4.18.0 (6 avisos) | high | P0 |
| `CB_GITIGNORE_NO_ENV` | medium | P0 |
| `CB_ENV_IN_HISTORY` `.env.production` · `CB_KEY_REUSE` `wrangler.jsonc` | critical | P1 |

Con un critical confirmado el puntaje queda en ≤ 49 (rojo) y el módulo resta su máximo (40) (canónicas §9.2). Conteos de OSV comprobados hoy 24-oct en vivo: jquery 2 avisos, ignition 1, lodash 6 (09.7). Antes de las 14:00 del sábado, Gabriel repite `POST https://api.osv.dev/v1/querybatch` con los tres paquetes **más** las versiones exactas de `hono`, `vite` y `@supabase/supabase-js` del lockfile (para que no aparezcan hallazgos sorpresa) y anota en `demo/guion.md` los conteos reales; el guion dice «dependencia con CVE explotado activamente», no un número inventado. La dependencia «high» del momento 0:20–1:00 del guion (canónicas §11) es `lodash@4.17.15`.

### 09.14 Pruebas, riesgos y verificaciones pendientes

**Pruebas Vitest (`packages/core`, Node, sin red; los literales con forma de secreto se arman por concatenación dentro del test; los ZIP se generan con `zipSync` de fflate, como en 06.10). Las de ZIP viven en `packages/core/src/zip.test.ts`, no en `apps/api` (la seguridad vive en core):**
1. `normalizarRuta`: `../x`, `/etc/x`, `C:\x`, `a/../../b`, nombre con `\u202e` → `null`; `src/a.ts` → igual; `a\b.ts` → `a/b.ts`.
2. `leerZip`: total de costes > 40 MB → `ZIP_TOO_BIG_UNCOMPRESSED`; 20 001 entradas vacías → `ZIP_TOO_MANY_ENTRIES`; bytes que empiezan por `GIF8` → `ZIP_BAD_MAGIC`; ZIP truncado → `ZIP_INVALID`; archivo de 5 MB de ceros con `origen:'zip'` → `ZIP_RATIO` y con `origen:'repo'` → solo omitido; **entrada stored (método 0) que declara `originalSize` 10 B y ocupa 2 MB → omitida por coste** (el hueco que tenía el filtro por `originalSize`); zipball con raíz `o-r-abc1234/` → rutas sin raíz; `.git/config` dentro → `tiene_git`; `wrangler.jsonc` → leído.
3. Secretos: cada regla P0 con un positivo y un negativo; JWT `anon` no genera hallazgo, `service_role` sí; `sk_test_` no; `postgres://postgres:postgres@localhost` no, pero `@db.abc.supabase.co` sí; valor con `example` descartado; `__tests__/` baja a `low`; preview de un valor de 16 car. no muestra más de 4.
4. **Fuga:** escanear un árbol con un JWT `service_role` armado en el test y comprobar que `JSON.stringify(hallazgos)` no contiene el valor ni su payload decodificado ni la huella completa.
5. Lockfiles: fixtures reales mínimos de `package-lock.json` v3 (con un alias `npm:`) y v1, `composer.lock` con `v8.0.0` → `8.0.0`, y `pnpm-lock.yaml` v9 (P1).
6. OSV (con `fetch` doble y los JSON reales de `GHSA-4qwp-7c67-jmcc` y de los 6 avisos de lodash guardados como fixtures): dedupe por alias; arreglo elegido por rango y solo del paquete escaneado (`ignition` 2.5.1 → 2.5.2; lodash → 4.18.0 ignorando `lodash-es`); `MAL-*` → critical; KEV pone `urgencia:'ahora'` **sin** cambiar `severity`; OSV caído → `ok:false` y ningún `CB_DEP_VULN` nuevo.
7. `dedupeKey(org, rule, resource)` estable entre dos escaneos; el mismo secreto en `.env` y en `src/` da **un** hallazgo con `resource` en `src/`; un ZIP con los mismos archivos da `resource` con prefijo `zip:` (otro `dedupe_key`); `opts.huella` de un valor = `fingerprint(keys, orgId, valor)` (lo que guarda `connection_secrets`) y distinta entre orgs.
8. `CB_GITIGNORE_NO_ENV`: sin `.gitignore`; con `# .env` comentado; con `!.env` → hallazgo; con `.env` → no.
9. `probarGithub` (con `fetch` doble): 401 en `/repos` → `checks[0].error_code === 'unauthorized'`; los `checks` validan con `PermCheck` de 15.5.

| Riesgo | Mitigación |
|---|---|
| Falsos positivos que restan credibilidad ante jueces técnicos | Prefiltro por palabra clave, lista de permitidos, entropía solo como filtro, la genérica en P1 y `medium`; probar el escáner sobre nuestro propio monorepo (0 hallazgos esperados) |
| PAT de una org que exige aprobación (queda *pending*) | Mensaje de 09.2; la demo usa un repo personal |
| Repo > 25 MB | P0: error claro; P1: modo árbol |
| OSV o KEV caídos | `miradas.osv/kev = false` → «sin mirar», nunca verde; OSV ya reintenta 3 veces dentro de `lib/http.ts` (15.10) y el paso `repo` tiene 1 reintento más (15.8); sin OSV el paso guarda lo demás y no auto-verifica |
| Memoria del isolate (128 MB) con un repo grande | Total descomprimido 40 MB, coste real por entrada, `zip = null` tras `leerZip`, decodificación archivo a archivo; si en el ensayo con nuestro propio monorepo aparece `Exceeded Memory Limit`, bajar `LIM.total` a 25 MB |
| Inyección desde README, código o `details` de avisos hacia IA-1/IA-2 | Redacción, `<datos_no_confiables>`, sin herramientas, filtro de salida, hallazgos IA con techo `medium` |
| CPU del paso con repos grandes | Prefiltro por palabra clave; lista blanca de 09.3; topes de 09.3; si hiciera falta, `limits.cpu_ms` en `wrangler.jsonc` (PR al orquestador) [no verificado: que aplique a pasos de Workflow] |
| Secreto en logs | `redact()` en el logger; la `Coincidencia` con `valor` no sale de `analizarArchivos()`; el token de GitHub solo vive dentro de `withSecret`; prueba 4 |
| Hallazgos sorpresa en la demo (otra dependencia de la víctima con aviso) | Versiones exactas en `package.json` y consulta previa a OSV de todas las directas (09.13) |

**Verificar antes de depender de ello:** (1) que la cabecera `Location` del 302 de `zipball` sea legible con `redirect:'manual'` en Workers (que el 3xx llega tal cual ya está verificado hoy); (2) cabecera `github-authentication-token-expiration` y su formato en respuestas a PAT fine-grained; (3) `cf.cacheTtl` cachea la descarga de KEV; (4) 404 frente a 403 de GitHub para un PAT sin acceso al repo; (5) longitud real de `sb_secret_`; (6) que `limits.cpu_ms` aplique a pasos de Workflow; (7) que los conteos de OSV de la tabla de 09.7 sigan iguales el día de la demo (OSV se actualiza: `lodash` recibió avisos en 2026 y sus registros se modificaron el 17-oct). Ya verificado hoy en esta revisión: parámetros de pre-relleno del PAT, `redirect:'manual'` y `'error'` en Workers, campos `size`/`originalSize` del `filter` y reserva de memoria de `unzipSync` en fflate 0.8.3, y los datos de OSV/KEV/EPSS de 09.7.
