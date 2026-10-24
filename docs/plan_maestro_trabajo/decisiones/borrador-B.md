# Borrador B — Decisiones del plan maestro de VanGUARD (enfoque: ambición y profundidad técnica)

**Platanus Hack 26 Caracas, team-22, track AI Security. Etapa 2 de 4. Sábado 24-oct-2026 (madrugada, hora de Caracas).**

> Para quién: chat orquestador, chat FRONT y chat BACK. Este borrador toma las decisiones del plan maestro maximizando aspectos técnicos (25 %), ambición (20 %) y originalidad (15 %) ante jueces técnicos que revisan con agentes, sin poner en riesgo la demo. Se apoya en los informes R01-R17 (etapa 1); donde chocan, **manda R17** (despliegue en Cloudflare) y luego el encargo de hoy. Convención: **[verificado: fuente]** = comprobado en R01-R17 contra la fuente citada; **[no verificado]** = por comprobar antes de prometerlo; **[A]** = umbral a calibrar en la demo.

---

## 1. Nombre del producto y one-liner

**VanGUARD** (así escrito, con GUARD en mayúsculas; decidido por el equipo, no se discute).

**One-liner (es, ya en `platanus-hack-project.jsonc`):** «Conecta tu Supabase, tu Cloudflare y tu repo de GitHub: una IA audita todo tu ecosistema, detecta puntos débiles y ataques, y te avisa al instante por WhatsApp o llamada.»

**Pitch de 20 s (de R15 §7):** «Conecta tu Supabase, tu Cloudflare y tu GitHub en tres minutos. Probamos lo que un atacante puede ver, te llamamos o te escribimos por WhatsApp cuando alguien lo intenta, te decimos qué deploy lo causó y te damos el arreglo listo para tu IA.»

**Posicionamiento ante el jurado (de R15 §4.2):** «Aikido y Supabase te dicen qué está mal configurado. Nosotros te decimos **cuándo alguien lo está aprovechando**, por qué pasó (el deploy de las 13:05) y cómo cerrarlo, y te llamamos para que te enteres.» Los cuatro ángulos originales que sostienen esto: (a) correlación entre capas del stack indie (borde, base, código, deploy); (b) postura continua, no una foto (re-prueba de exposición tras cada deploy/migración); (c) exposición **más** explotación en curso; (d) cierre del ciclo para no expertos (voz/WhatsApp en español + prompt de corrección + «verificar arreglo»). **Dogfooding:** VanGUARD corre detrás de Cloudflare, así que el módulo Cloudflare se demuestra sobre nuestra propia zona (ventaja del encargo de hoy).

---

## 2. Alcance por módulo (P0 demo, P1 domingo, P2 hoja de ruta)

P0 = la demo lo necesita sí o sí; P1 = debe estar el domingo 12:00; P2 = hoja de ruta (se muestra, no se promete).

| Módulo | P0 (demo) | P1 (domingo) | P2 (hoja de ruta) |
|---|---|---|---|
| **Conexiones / onboarding** | Pegar PAT de Supabase y token de Cloudflare; «Probar conexión» con sondeo de permisos que traduce cada 403 a «te falta X» (R09 §1, R10 §1.3); conectar 1 repo por fine-grained PAT (R11 §1.2) | GitHub App de solo lectura (R11 §1.3); verificación de propiedad del dominio por TXT (R15 §6.9) | OAuth app de Supabase; subida de ZIP (R11 §6) |
| **Resumen (puntaje)** | Puntaje de blindaje 0-100 **con cobertura al lado** (R15 §6.8); bandeja «Ahora» por módulo (R08 §6) | Tendencia del puntaje por auditoría | Mapa de superficie (grafo) |
| **Supabase** | Advisors security+performance (R09 §1.3); métricas CPU/RAM/disco/conexiones por Management API sin `service_role` (R09 §2); verificación **activa** de RLS con la publishable key (R15 §6.1) | SQL de catálogo (DB-01…DB-26, SEC-01…SEC-03 de R02; S01…S22 de R04); logs ClickHouse (IPs, 5xx, fuerza bruta) (R09 §1.6) | Chequeos de freno/rate-limit completos (R03); conexiones/consultas largas en vivo |
| **Cloudflare** | Pulso Q1, top IPs Q2/Q2-B, eventos Q3 (R10 §2.4); detectores CF-IP-FLOOD, CF-SPIKE, CF-SCAN-404, CF-UA-TOOL (R10 §2.5); webhook `dos_attack_l7` (R10 §5); bloquear IP con deshacer (R10 §4.1) | Auditoría de 18 chequeos (DNS sin proxy, SSL, TLS) (R10 §6); Under Attack (R10 §4.2); regla de rate limit (R10 §4.4) | Reputación de IP (AbuseIPDB, Spamhaus, Tor) (R10 §8); Bot Fight Mode |
| **Codebase (GitHub+ZIP+CVE+secretos)** | OSV.dev por lockfile (R11 §2); `.env` subido / en historial (R11 §4); secretos con reglas propias + JWT `service_role` (R11 §4.2); regla «tabla sin RLS en migraciones» cruzada con Supabase en vivo (R11 §5.2) | KEV+EPSS para P0-P3 (R11 §2.5); 25 reglas SAST (R11 §5.2); revisión con Claude de los 15 archivos de riesgo (R11 §5.3); huella HMAC de keys para detectar fugas (R15 §6.7) | ZIP con `fflate`/R2 (R17 §5); SARIF; «pregúntale a tu repo» por MCP de GitHub |
| **Rendimiento (Lighthouse histórico)** | — (opcional en demo) | PSI API v5 con `PSI_API_KEY`; `perf_runs`/`perf_findings`; gráfico por commit con Δ vs. versión anterior y «dónde está el problema» (R13) | Lighthouse en GitHub Actions; tiempos de compilación y errores por run; Vercel deployments |
| **Auditoría de un botón** | «Auditar todo» = Workflow `vg-scan` que corre Supabase+Cloudflare+repo y da puntaje + prompts (R17 §4.2) | + Lighthouse y config de auth; re-auditoría diaria por cron | PR automático de corrección |
| **Incidentes y alertas (Kapso/ElevenLabs)** | Motor de reglas abre incidente; WhatsApp interactivo por **sandbox de Kapso** (R14 §1.6); llamada ElevenLabs+Twilio con resumen (R14 §2.2); cronómetro ataque→aviso | Escalamiento in-app→WhatsApp→llamada con cooldown (R14 §4); aprobación por botón con nonce; Telegram de respaldo | Plantilla de Meta aprobada; email Resend; batch calling |
| **Motor IA y prompts de corrección** | Ruteo Haiku/Sonnet/Opus (R12 §11); prompt de corrección con «verificar arreglo» (R15 §6.5); interruptor de corte | Libro de gasto con reserva/liquidación y topes por tenant (R12 §13) | Editor de prompts con versiones (R07) |
| **Exportar a cualquier IA / MCP propio** | Export Markdown de hallazgos redactados (R16 §10) | MCP propio `/mcp` de solo lectura con 8 herramientas y tokens `vgk_` (R17 §11.5, R16 §10) | OAuth 2.1 para claude.ai |
| **Ajustes** | Ver conexiones con máscara; revocar | Contactos de alerta; horario; topes | Editor de prompts; costo de IA visible |

**Núcleo de la demo (lo que no puede faltar):** verificación activa de RLS (idea 2) + regresión de exposición (idea 3) + ataque reproducible contra `demo.<dominio>` detectado por `tail()` + llamada/WhatsApp + prompt de corrección + «verificar arreglo». Las ideas 4 (correlación entre fuentes) y 5 (explotación en curso) son el salto técnico y original que impresiona al jurado.

---

## 3. Stack definitivo (versiones exactas y por qué)

Runtime **Node 24 LTS** en todo (mínimo 22.19: Lighthouse 13.5 y Vitest exigen ≥22.19) [verificado: R16 §0]. Gestor **pnpm 10.34.7** con workspaces, **sin Turborepo** [verificado: R16]. **TypeScript 6.0.3**, no 7.0.2 (la 7 no trae la API de compilador en JS que usan editores y herramientas) [verificado: R16 §1].

**Frontend (chat FRONT):** SPA **Vite 8.3.5** + **React 19.3.1**, servida como assets estáticos del Worker. **Sin Next.js ni OpenNext** (el `proxy.ts` de Next 16 tiene bugs abiertos en OpenNext #1400/#1373 y OpenNext no garantiza Windows; Vite 8 usa `rolldown`+`lightningcss`, no `esbuild`) [verificado: R17 §2]. `react-router` 7.18.4, `@tanstack/react-query` 5.104.5, `tailwindcss` + `@tailwindcss/vite` 4.3.3, `shadcn` 4.22.1, gráficos con el chart de shadcn (**Recharts 3.10.1**), `@supabase/supabase-js` 2.118.0, `zod` 4.6.7 [verificado: R17 §2, R16 §1]. Evitar `@tremor/react` (exige React 18) [verificado: R16 §0].

**Backend (chat BACK):** API **Hono 4.13.13** dentro del **mismo Worker** `vanguard` que sirve el SPA, en `/api/*`, `/mcp` y `/webhooks/*` (mismo origen, sin CORS) [verificado: R17 §0]. En desarrollo la misma app Hono corre en Node 24 con `@hono/node-server` 2.1.5 y type stripping (`node --env-file=.dev.vars --watch`), así ningún Windows descarga `workerd`/`esbuild` (regla anti-ejecutables de Norton) [verificado: R17 §7].

**Trabajos:** **Cron Trigger `* * * * *` → Cloudflare Queue `vg-monitor`** para los monitores de 60 s; **Cloudflare Workflow `vg-scan`** (pasos con reintento) para «Auditar todo», repo, ZIP y Lighthouse [verificado: R17 §4]. **Sin Railway, sin `pgmq`** (R16 los usaba; R17 los elimina).

**Datos y tiempo real:** **Supabase** (Postgres con RLS por `org_id`, Vault, Realtime Broadcast privado, pg_cron) [verificado: R16 §5, R17 §10]. Solo claves nuevas `sb_publishable_` y `sb_secret_` (las legacy se retiran a fines de 2026) [verificado: R09 §0].

**IA:** **Claude API** con `@anthropic-ai/sdk` **0.137.0** (no subir a 1.x en medio del hackatón) [verificado: R16 §1, R12]. IDs exactos: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` [verificado: R12 §1].

**Lighthouse:** **PageSpeed Insights API v5** desde un paso del Workflow (Lighthouse no corre dentro de un Worker; necesita Chrome) [verificado: R17 §4.3].

**Almacenamiento de ZIP:** **R2** bucket `vanguard-uploads`, tope 25 MB, ciclo de vida 1 día [verificado: R17 §5].

**MCP propio:** `@modelcontextprotocol/server` **2.3.1** con `WebStandardStreamableHTTPServerTransport` sin estado, montado en Hono (sustituye a `mcp-handler`, que es para Next) [verificado: R17 §0].

**Cifrado:** WebCrypto (AES-GCM, HKDF, HMAC), mismo código en el Worker y en Node 24 [verificado: R17 §3, §11.2].

**Contrato FRONT↔BACK:** paquete `@vanguard/contracts` con zod 4.6.7; lógica pura en `@vanguard/core` [verificado: R16 §9]. **CLI wrangler 4.152.0** solo vía `pnpm dlx` en CI/Codespaces, **nunca en un `package.json`** [verificado: R17 §6]. Pruebas con **Vitest 4.1.12** [verificado: R16 §1]. CI con `actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6` [verificado: R16 §11.5].

---

## 4. Topología de despliegue

**El despliegue es en Cloudflare, no en Vercel** (cambio de última hora del equipo; manda R17). Vercel solo existe como proveedor que VanGUARD **monitorea** en la hoja de ruta.

| Pieza | Dónde corre | Detalle |
|---|---|---|
| **Worker `vanguard`** (producto) | Cloudflare Workers Paid | Sirve el SPA (assets) y la API Hono en el mismo origen; `run_worker_first` para `/api/*`, `/mcp`, `/webhooks/*`; `not_found_handling: single-page-application` [verificado: R17 §6.1] |
| **Worker `vanguard-victima`** (demo) | Cloudflare Workers | App víctima en `demo.<dominio>`, con `tail_consumers: [vanguard]` para el sensor en tiempo real [verificado: R17 §9.1] |
| Monitores 60 s | `scheduled` (`* * * * *`) → Queue `vg-monitor` | El consumidor evalúa reglas puras y notifica; el modelo no decide la alerta [verificado: R17 §4.2] |
| Escaneos | Workflow `vg-scan` | Un paso por subtrabajo; cada paso devuelve solo ids/conteos (≤1 MiB) y actualiza `scan_runs.progress` [verificado: R17 §4.2] |
| Sensor de la víctima | `tail()` del Worker | Cuenta por IP/UA en ventanas de 10 s y escribe `metric_samples`; dispara en segundos sin esperar a GraphQL [verificado: R17 §9.1] |
| Datos, Vault, Realtime, cron de limpieza | Supabase Free (2 proyectos: VanGUARD + app víctima) | 500 MB BD, 1 día de logs, pausa tras 1 semana [verificado: R09 §0] |
| ZIP | R2 `vanguard-uploads` | 25 MB por ZIP, ciclo de vida 1 día [verificado: R17 §5] |
| Lighthouse | PSI API v5 (infra de Google) | Cero binarios; solo URLs de dominios de la org [verificado: R17 §4.3] |

**URL / `deploy-url`:** desde la hora 1, `https://vanguard.<subdominio-de-cuenta>.workers.dev` (respaldo permanente). Final: `https://vanguard.<dominio>` sobre una zona propia en Cloudflare (Custom Domain), que además habilita el dogfooding del módulo Cloudflare [verificado: R17 §1.3]. Si al domingo 09:00 no hay dominio, la `deploy-url` queda en workers.dev.

**Entornos:** sin bloques `env.*` (crearían Workers separados). Producción = la versión desplegada de `vanguard`; previews = Version URLs con alias por PR (`wrangler versions upload --preview-alias pr-N`), que comparten bindings y base con producción pero no disparan cron ni colas [verificado: R17 §6.2]. El Worker principal **no** declara Durable Objects (anularían las Version URLs) [verificado: R17 §1.2].

**Despliegue:** solo desde **GitHub Actions (ubuntu)** con `pnpm dlx wrangler@4.152.0 deploy --secrets-file`; nadie despliega desde Windows [verificado: R17 §6.3]. Camino A: Actions en el repo de la org (si Platanus deja crear secretos de Actions); camino B de respaldo: repo espejo personal con el mismo `deploy.yml` [verificado: R17 §6.4].

**Costo de infraestructura:** Workers Paid **5 USD/mes** (imprescindible: Free da 10 ms de CPU y 50 subpeticiones, no caben escaneos ni Tail Workers) + ~10,46 USD si se compra un `.com` en Cloudflare Registrar [no verificado: precio de terceros] + Supabase Free + créditos de Claude. **Decisión de hoy del orquestador: quién pone la tarjeta** antes de las 10:00 del sábado.

---

## 5. Estructura del monorepo

pnpm 10.34.7 con workspaces (`apps/*`, `packages/*`), sin Turborepo. Árbol (ajuste de R16 §9.1 según R17 §10):

```
/                          (ORQUESTADOR) package.json, pnpm-workspace.yaml, tsconfig.base.json, .github/, README
apps/web/                  FRONT  Vite + React; src/, components/, lib/; SIN dependencias de Cloudflare
apps/api/                  BACK   src/app.ts (Hono), src/worker.ts (fetch/scheduled/queue/tail),
                                  src/workflow.ts (ScanWorkflow), src/scans/*.ts (funciones puras),
                                  src/monitors.ts, src/sensor.ts, src/mcp.ts, src/dev-node.ts,
                                  wrangler.jsonc, worker-configuration.d.ts (generado y versionado)
apps/victima/              BACK   Worker de demo con tail_consumers -> vanguard
packages/contracts/        COMPARTIDO (cambios por PR que aprueba el orquestador): esquemas zod 4.6.7,
                                  src/database.types.ts (generado por BACK con `supabase gen types`, no se edita a mano)
packages/core/             BACK   rules/ (reglas puras), crypto.ts (WebCrypto), redact.ts, severity.ts, prompts/
supabase/                  BACK (único escritor del esquema): migrations/, seed.sql, config.toml
scripts/ataque.mjs         ORQUESTADOR  ataque reproducible (fetch de Node, sin binarios)
.github/workflows/deploy.yml  ORQUESTADOR
```

**Dueño de cada carpeta entre paréntesis. Regla de oro: un chat nunca edita la carpeta del otro.** Si FRONT necesita un campo nuevo, lo pide al orquestador, que cambia `packages/contracts` y avisa a los dos [verificado: R16 §9.1]. Los paquetes internos exportan `./src/index.ts`; en el Worker los une el bundler y en Node los resuelve el type stripping (si falla, `tsc -b` de `core` y `contracts`, que es JS puro) [verificado: R17 §7]. `@vanguard/contracts` es la **única fuente de verdad** que importan FRONT y BACK.

---

## 6. Modelo de datos (multi-tenant por `org_id`)

RLS por `org_id` en todas las tablas; funciones de membresía `security definer` en el esquema `private`; `connection_secrets` **sin ninguna política** (solo `service_role` la lee) [verificado: R16 §8]. Tablas clave (de R16 §8, R14 §4.5, R11 §7, R13, R12 §13.4):

| Tabla | Columnas clave | Nota |
|---|---|---|
| `orgs` | `id, name, slug, daily_audit, created_at` | Tenant raíz |
| `org_members` | `org_id, user_id, role('owner'\|'admin'\|'viewer')` | PK compuesta + índice en `user_id` |
| `connections` | `id, org_id, provider('supabase'\|'cloudflare'\|'github'\|'vercel'\|'ingest'), label, status('active'\|'error'\|'revoked'), meta jsonb, last4, scopes text[]` | `meta`: project_ref, zone_id, repo_full_name, installation_id… |
| `connection_secrets` | `connection_id, org_id, sealed jsonb (Box de §10), fingerprint text (HMAC hex), unique(org_id,fingerprint)` | Sin RLS policy: solo `service_role` |
| `scan_runs` | `id, org_id, kind('full_audit'\|'supabase'\|'cloudflare'\|'repo'\|'zip'\|'lighthouse'), status('queued'\|'running'\|'succeeded'\|'failed'\|'canceled'), progress int, step, summary jsonb, score int` | Estado visible y fuente del Broadcast |
| `findings` | `id, org_id, scan_run_id, connection_id, module('supabase'\|'cloudflare'\|'codebase'\|'performance'), rule_id, severity('critical'…'info'), title, resource, evidence jsonb (redactada), status('open'\|'fixed'\|'ignored'), fix_prompt, dedupe_key, unique(org_id,dedupe_key)` | `rule_id` ej. `SB_RLS_DISABLED`, `CF_IP_FLOOD`, `CB_ENV_COMMITTED` |
| `incidents` | `id, org_id, rule_id, severity, title, status('open'\|'ack'\|'resolved'), event_count, details jsonb, dedupe_key, notified_at` | Índice único parcial `(org_id,dedupe_key) where status<>'resolved'` |
| `metric_samples` | `id, org_id, connection_id, metric, ts, value, labels jsonb` | Índice `(connection_id,metric,ts desc)`; limpieza >7 días por pg_cron |
| `mcp_tokens` | `id, org_id, name, token_hash unique, scopes text[], revoked_at` | Solo se guarda el SHA-256 del token `vgk_` |
| `exposicion_foto` | `proyecto_id, tabla, legible_anon, filas_visibles, escribible_anon, rls_activa, disparador('cron'\|'push'\|'deploy'\|'migracion'\|'manual'), commit_sha, medido_en` | Base de la regresión de exposición (R15 §6.2) |
| `codebase_findings` | `tenant_id, audit_id, source('github'\|'zip'), kind('dependency'\|'secret'\|'sast'\|'config'\|'outdated'\|'runtime_eol'), origin('regla'\|'ia'\|'github_alert'), priority('P0'…'P3'), vuln_id, in_kev, epss, secret_preview, secret_fingerprint` | Nunca el secreto en claro (R11 §7) |
| `perf_runs`, `perf_findings`, `build_runs` | score/LCP/CLS/TBT por commit; vista `perf_points` | Lighthouse histórico (R13 §8) |
| `kev`, `epss`, `vuln_cache` | caché de CVE (R11 §2.5) | Sin RLS policy: lectura solo por backend |
| `ia_gasto`, `ia_precios`, `ia_topes`, `app_config` | libro de gasto de IA (R12 §13.4) | `ia_reservar`/`ia_liquidar` con `pg_advisory_xact_lock` |
| Alertas: `contactos_alerta`, `notificaciones`, `aprobaciones`, `webhook_eventos` | nonce con TTL 10 min (solo hash), huella `sha256(org\|regla\|recurso)` | R14 §4.5 |

Enums: `severity(critical,high,medium,low,info)`, `module(supabase,cloudflare,codebase,performance)`, `severidad(baja,media,alta,critica)`, `estado_incidente(abierto,confirmado,silenciado,resuelto)`, `canal(inapp,whatsapp,llamada,telegram,email,slack)`. Escriben solo `service_role` (route handler tras comprobar rol, o el worker); el navegador solo lee salvo el cambio de estado de un hallazgo. **VanGUARD se audita a sí mismo** en CI: `select tablename from pg_tables where schemaname='public' and not rowsecurity` debe dar 0 filas [verificado: R16 §8].

---

## 7. Contrato API

Base: el Worker `vanguard`. Autenticación: la sesión vive en el navegador (`supabase-js`, PKCE); el API recibe `Authorization: Bearer <access_token>` y **lo primero** en cada ruta es `supabase.auth.getClaims(token)` (nunca `getSession()` en servidor), luego el rol en la org, y solo entonces el cliente admin [verificado: R16 §4.3]. Errores: `ApiError {error:{code,message}}` con códigos fijos `unauthorized`, `forbidden`, `invalid_body`, `provider_rejected`, `not_found`, `rate_limited` [verificado: R16 §9.3].

| Método y ruta | Auth | Request (zod) | Response |
|---|---|---|---|
| `POST /api/orgs` | Bearer | `OrgCreate {name}` | `Org` |
| `POST /api/connections` | Bearer (admin) | `ConnectionCreate {provider, label, credentials}` | `201 ConnectionPublic {id,provider,label,last4,scopes,status,meta}` (valida contra el proveedor antes de guardar; nunca devuelve el secreto) |
| `POST /api/connections/:id/test` | Bearer | — | `{ok, scopes, checked_at}` (sondeo por permiso; 403→«te falta X») |
| `DELETE /api/connections/:id` | Bearer (admin) | — | `204` (borra fila y secreto en cascada) |
| `GET /api/github/install` · `GET /api/github/setup` | Bearer | query `installation_id,setup_action` | `302` (verifica `account.login` contra la sesión, R16 §6.3) |
| `POST /api/webhooks/github` | firma `X-Hub-Signature-256` | eventos `installation`, `push` | `204` (push a rama por defecto dispara regresión de exposición) |
| `PUT /api/uploads/zip/:scanRunId` | Bearer | cuerpo en streaming a R2, `Content-Length` obligatorio | `201 {key}` o 411/413 |
| `POST /api/scans` | Bearer | `ScanCreate {kind, params}` | `202 {scan_run_id}` (inserta `scan_runs` y llama `SCAN_WF.create`) |
| `GET /api/scans/:id` | Bearer | — | `{status, progress, step, score}` |
| `POST /api/findings/:id/fix-prompt` | Bearer | — | `{prompt, model, cached}` (cachea en `findings.fix_prompt`) |
| `POST /api/findings/:id/verify` | Bearer | — | `{verified_at, estado}` (re-corre la prueba exacta: idea «verificar arreglo», R15 §6.5) |
| `POST /api/ai/explain` | Bearer | `{finding_id}` o `{incident_id}` | stream de texto |
| `GET /api/export?format=json\|md` | Bearer | — | archivo con hallazgos redactados |
| `POST /api/mcp-tokens` · `DELETE /api/mcp-tokens/:id` | Bearer (admin) | `{name, scopes}` | `{token}` una sola vez (se guarda el SHA-256) |
| `GET`/`POST /api/mcp` o `/mcp` | Bearer `vgk_` | MCP Streamable HTTP sin estado | §10, 8 herramientas de solo lectura |
| `POST /api/notifications/test` | Bearer | `{channel:'whatsapp'\|'voice'}` | `{ok}` (403 si el host no es el de producción) |
| `POST /api/voz/respuesta` | `Bearer {{secret__token_llamada}}` | `{incidente_id, respuesta:'ack'\|'snooze'\|'pide_aprobar', conversation_id}` | `{ok}` (herramienta de la llamada ElevenLabs) |
| `POST /api/webhooks/kapso` · `/elevenlabs` · `/cloudflare` | HMAC por canal | eventos firmados | `200` inmediato, proceso asíncrono |

**Realtime (Broadcast privado):** canal `org:<org_id>`, emitido por triggers `realtime.broadcast_changes` sobre `scan_runs`, `incidents`, `findings` [verificado: R16 §5.4]. Payload: `{op, table, record}`. La UI consume el avance de la auditoría y los incidentes sin recargar; `metric_samples` no se difunde (la UI lo consulta cada 30 s) [verificado: R16 riesgos]. Convenciones: rutas y eventos en inglés para el código, textos de UI en español; `rule_id` con el patrón `^[A-Z]{2}_[A-Z0-9_]+$` (`SB_`, `CF_`, `CB_`, `PF_`).

**Contrato de pantalla `EstadoModulo` (de R08 §6):** una sola lectura por módulo devuelve `{ok, error, hora, contador, cifras[], ahora: GrupoDato[], checks[]}`, y una página genérica `<PantallaModulo estado={EstadoModulo}/>` sirve a Supabase, Cloudflare y Codebase. El BACK decide filas, roles (`mal`→rojo, `aviso`→ámbar, `bien`→verde, resto neutro) y verbos; el FRONT solo pinta. Clase de acción nueva para VanGUARD: `prompt` (pide el prompt de corrección y lo abre). Es lo que más tiempo ahorra entre los dos chats.

---

## 8. Motor IA (ruteo, presupuesto, caché, topes)

**Principio inamovible: el modelo nunca decide si se alerta ni con qué severidad.** Lo decide el motor de reglas; el modelo resume, explica, prioriza y redacta [verificado: R12 §11, decisión del equipo]. Tres modelos, no cuatro (Fable 5.1 fuera: 2,5× Opus y clasificadores contra contenido de ciberseguridad) [verificado: R12 §0].

**Ruteo (IDs exactos, de R12 §11):**

| Ruta | Modelo | effort | max_tokens | Por qué |
|---|---|---|---|---|
| Cuarentena de texto no confiable (logs, UA, README) sin herramientas | `claude-haiku-5-5` | low | 1.000 | Barato; aísla el texto hostil |
| Triage de incidente | `claude-haiku-5-5` | low | 2.000 | Volumen alto, latencia <30 s |
| Escalado del triage (rechazo, JSON inválido, crítico) | `claude-sonnet-5-5` | medium | 4.000 | Mejor juicio; Haiku no tiene fallback de servidor |
| Guion de voz (ElevenLabs) y texto de WhatsApp | `claude-sonnet-5-5` | low + `thinking:between_tools` | 800 | Español natural, sin thinking por latencia |
| Análisis por módulo | `claude-sonnet-5-5` | medium | 8.000 | Calidad a mitad de precio de Opus |
| **Síntesis de la auditoría completa** | `claude-opus-5-5` | high | 32.000 (streaming) | El «cerebro» que razona entre módulos |
| Prompt de corrección | `claude-sonnet-5-5` | medium | 6.000 | Opus solo para críticos multiarchivo |
| Explicar CVE con `web_fetch` | `claude-sonnet-5-5` | low | 2.000 | Bajo demanda, `allowed_domains: cve.org, nvd.nist.gov, osv.dev, github.com` |
| Interpretar diferencias de Lighthouse | `claude-haiku-5-5` | medium | 2.000 | Los números los da Lighthouse |
| Exportar para cualquier IA | **ninguno** | — | — | Plantilla determinista, costo 0 |

**Precios (USD/MTok, verificado R12 §1):** Haiku 5.5 0,10/0,50 (lectura caché 0,01); Sonnet 5.5 2/10 (caché 0,10); Opus 5.5 4/20 (caché 0,20). Batch −50 %. Costo por operación: triage ~0,0005; prompt de corrección ~0,033; voz+WhatsApp ~0,006; **auditoría completa ~0,59 (0,30 por Batch)** [verificado: R12 §12].

**Caché:** mínimo 512 tokens; disposición `tools → system (congelado, sin fecha/tenant/IDs) → messages[A=instantánea del tenant, B=evento volátil]`; TTL 5 min para triage/alertas, 1 h para la sesión de auditoría; aislado **por workspace** (dev y prod no comparten) [verificado: R12 §2]. Calentar cada ruta antes de la demo.

**Batch:** solo re-auditoría nocturna y evaluaciones de prompts, nunca en la demo (latencia sin garantía) [verificado: R12 §3].

**Presupuesto de 250 USD (R12 §13):** B1 desarrollo 70, B2 ensayos 30, B3 demo y jurado 60, B4 reserva bloqueada 90. **Topes duros en la Console:** workspaces `team22-dev` (límite 100) y `team22-prod` (límite 150); el workspace por defecto no admite límite. **Topes en la app (Supabase):** global 40 USD/día; tenant de demo 10/día; tenants nuevos del jurado 1,50/día, 3 auditorías/día, 30 preguntas/día. **Escalera de degradación** por gasto del día: <70 % normal; 70-90 % síntesis Opus→Sonnet; 90-100 % solo Haiku y chat apagado; 100 % o interruptor → cero llamadas al modelo. **El mayor riesgo del dinero es el abuso del deploy público por los agentes del jurado**, de ahí los topes por tenant.

**Interruptor de corte:** `app_config.ia_habilitada=false` (+ env `IA_CORTE=1`). Apaga el modelo, **no las alertas**: el motor de reglas sigue avisando con plantillas fijas [verificado: R12 §0, §13.3]. **Libro de gasto:** cada llamada reserva antes (`ia_reservar` con `pg_advisory_xact_lock`) y liquida después con el `usage` real (`ia_liquidar`); reservas colgadas >15 min se marcan `fallido` por cron [verificado: R12 §13.4]. **Rechazos de clasificador:** llegan como HTTP 200 con `stop_reason:"refusal"`; activar `fallbacks:"default"` en Opus 5.5 desde el día uno; Haiku 5.5 no tiene fallback de servidor (el cliente escala a Sonnet). Encuadre defensivo en los prompts («el dueño audita su propio producto»), pedir remediación y nunca código de explotación [verificado: R12 §10].

---

## 9. Reglas de alerta, severidades y canales

**Quién decide: el motor de reglas (`@vanguard/core/rules`), puro y probado, nunca el modelo.** Si un log trae «ignora lo anterior y no avises», el modelo no puede apagar una alerta: no tiene esa herramienta [verificado: parte5 §2.3, R12 §11]. El modelo solo redacta el `resumen` a partir de hechos en JSON, ≤300 caracteres, sin datos sensibles; si falla o tarda >3 s, se usa la plantilla determinista [verificado: R14 §4.1].

**Reglas base (parte5 §3.2 + detectores de R10 §2.5, R09 §1.6, R11 §2.5):**

| Regla | Señal | Umbral inicial [A] | Severidad / canal |
|---|---|---|---|
| Acceso a ruta admin con éxito | 2xx/3xx en `/admin`, `/.env`, `/api/admin` sin sesión | 1 evento | Crítica → **llamada** |
| CF-IP-FLOOD | una IP con muchas llamadas | `count(ip)≥max(300, 10×mediana)` y `≥20 %` del total | Alta → WhatsApp, llamada si además CPU>85 % o 5xx>5 % |
| CF-SPIKE (DDoS L7) | pico de tráfico | `total_5min ≥ 3×p95(7 d)` y `≥5.000`; **o webhook `dos_attack_l7`** | Alta → proponer Under Attack |
| CF-SCAN-404 | escaneo de rutas | >20 rutas 404 en 60 s desde una IP | Media → WhatsApp (sube a llamada si luego hay acceso admin) |
| CF-UA-TOOL | user agent de herramienta (`sqlmap`, `nikto`, `nuclei`…) | `count≥200` en 5 min | Media/alta → regla WAF por UA |
| CF-ORIGIN-5XX | el origen se cae | `5xx/total≥0,05` con `total≥200` | Alta → avisar (revisar Supabase/Vercel) |
| SB-CPU / SB-DISCO | CPU>90 % 5 min / disco>90 % | de las métricas Prometheus | Alta → llamada / WhatsApp |
| Regresión de exposición (R7) | tabla pasa de `legible_anon=false` a `true` tras push/deploy | 1 cambio | Crítica si columnas sensibles o filas visibles → llamada |
| Exposición explotada (C4) | tabla expuesta **y** ≥50 lecturas anon de una IP en 10 min | logs de Supabase | Crítica → llamada |
| Correlación (C1-C3) | pico borde + CPU base + deploy en ventana de 10 min | clasifica «ataque» / «regresión de deploy» / «crecimiento legítimo» | según clase |
| Dependencia vulnerable | aviso OSV que afecta una versión | cualquier crítico/alto | WhatsApp; llamada si está en CISA KEV |

**Escalamiento por severidad (R14 §4.2):** crítica → in-app + WhatsApp (+Telegram) al instante, sin ack a los 3 min (**demo: 45 s**) → llamada contacto 1 → +2 min contacto 2. Alta → in-app + WhatsApp, llamada a los 15 min (07:00-22:00). Media → in-app + resumen por email. Baja → resumen diario. **«Leído» ≠ «confirmado»**: el escalamiento solo se detiene con ack explícito (botón, clic, herramienta de voz). **Deduplicación** por huella `sha256(org\|regla\|recurso)`: un incidente abierto por huella; solo se renotifica si sube la severidad. **Cooldown** 10/30/120 min por severidad; **modo tormenta** (>5 incidentes en 2 min → un solo mensaje). **Techos por org** (2 llamadas/h, 10 WhatsApp/h) contra el abuso. **La voz nunca aprueba acciones**; las acciones de escritura (bloquear IP, Under Attack) exigen token opcional de escritura + código de un solo uso por WhatsApp/app (nonce 128 bits, TTL 10 min, solo se guarda el hash, canje atómico) [verificado: R14 §4.4, parte5 §3.4].

---

## 10. Credenciales: cifrado, almacenamiento y conexión por integración

**Corrección del «hash con pimienta» (validada por R01, R09, R16, R17):** un hash es irreversible y el worker necesita los tokens **en claro** para llamar a las APIs cada 60 s. Lo correcto es **cifrado reversible y autenticado**; el HMAC con pimienta se conserva solo como **huella** (deduplicar, verificar sin descifrar, detectar la propia key del cliente filtrada en su repo/bundle/logs).

**Diseño (cifrado de sobre AES-256-GCM con WebCrypto, R17 §11.2, R16 §7):**
- **KEK** = `HKDF-SHA256(ikm = secreto de Supabase Vault, salt = pimienta en secreto del Worker `VG_KEK_PEPPER`, info = "vanguard/kek/v1")`. Hacen falta **las dos mitades** (robar Vault no basta sin la pimienta del entorno, y viceversa). Se cachea 10 min por isolate.
- Por credencial se genera una **DEK** aleatoria; el texto se cifra con la DEK y la DEK se envuelve con la KEK. `aad = "${orgId}|${connectionId}|${provider}"`: descifrar con otra org o conexión falla. Se guarda el `Box {v,kid,iv,ct,ivk,wdek}` en `connection_secrets.sealed`.
- **Huella** = `HMAC-SHA256(VG_FP_PEPPER, secreto)` en hex, en `connection_secrets.fingerprint` (único por org). Nunca descifra.
- El secreto de Vault se lee con una RPC `security definer` que solo puede ejecutar `service_role` (`vg_crypto_material`), con `revoke` explícito a `public`, `anon`, `authenticated`; prueba automática de que `authenticated` no puede ejecutarla ni leer `vault.decrypted_secrets` [verificado: R16 §7.3]. Mismo código corre en el Worker y en Node 24. Prueba obligatoria: cambiar 1 byte de `ct` o usar otro `aad` debe lanzar.

**Qué token pide cada integración (permisos mínimos de solo lectura):**

| Integración | Token | Permisos mínimos | Papel del MCP |
|---|---|---|---|
| **Supabase** | PAT con alcance, 1 proyecto, solo lectura (GA desde 6-oct-2026) | `database_read`/`database:read`, `analytics:read` (métricas y logs), `advisors_read` | MCP oficial `mcp.supabase.com/mcp?read_only=true&features=database,debugging,docs` **solo** para «conecta tu IA»; el monitoreo va por REST [verificado: R09 §0, §3] |
| | **Nunca:** `secrets:read` (root key de Vault + API keys), `rest:read` (`jwt_secret`), ningún `:write`. `config/auth` se lee con lista blanca (trae `smtp_pass`, `*_secret`) | | |
| | **Métricas CPU/RAM/disco sin `service_role`:** por `GET /v1/projects/{ref}/analytics/endpoints/metrics` con `analytics:read` [verificado: R09 §2] | | |
| **Cloudflare** | Dos tokens: **lectura** (obligatorio) + **acciones** (opcional, «Modo blindaje») | Lectura: Zone Read, Zone Settings Read, DNS Read, Analytics Read, Firewall Services Read + Zone WAF Read (los dos, por la duda del nombre). Acciones: Zone Settings Write, Firewall Services Write | MCP `mcp.cloudflare.com/mcp` (sin modo solo lectura) **solo** para «investiga con IA», siempre con el token de lectura; **nunca** se le entrega el token de acciones [verificado: R10 §7] |
| **GitHub** | MVP: fine-grained PAT de 1 repo; producción: GitHub App de solo lectura | `Contents: Read`, `Metadata: Read`; opcionales `Dependabot alerts: Read`, `Secret scanning alerts: Read` | MCP de GitHub en `/readonly` solo para «pregúntale a tu repo» [verificado: R11 §1] |

**Regla de oro del onboarding:** al conectar se hace un sondeo (un GET por permiso) y cada 403 se traduce a «te falta el permiso X» [verificado: R09, R10 §1.3]. Las acciones de escritura de Cloudflare son opcionales, con confirmación por código de un solo uso. Nada de `service_role` al cliente; si en nuestro proyecto de demo hace falta una secret key (métricas de servidor), es solo del lado del servidor, dedicada y revocable [verificado: R15 §6.0]. El MCP en el bucle de monitoreo está **prohibido** (gasta tokens, no es determinista y abre la puerta a la inyección de instrucciones): ahí va código fijo [verificado: R12 §0, R10 §7].

---

## 11. Guion de demo de 3 minutos (app propia vulnerable, nunca un tercero)

Se ataca **`demo.<dominio>`** (Worker `vanguard-victima` de nuestra cuenta), nunca a un tercero ni a Cuadra/SAGA. Ataque desde el **hotspot de un teléfono**, no el wifi del evento (si se bloquea esa IP, se cae todo el equipo). Script fijo `node scripts/ataque.mjs` (fetch de Node, sin binarios), reproducible 10 veces igual. Umbrales de la zona de demo bajados por un factor de ajuste [verificado: R10 §2.5, R17 §9.2].

1. **(0:00) Estado sano.** Panel de VanGUARD con la zona en verde, puntaje de blindaje alto y la cobertura al lado («vemos 4 de 5 fuentes»). Un integrante arranca el ataque desde el hotspot; empieza un **cronómetro** en pantalla.
2. **(0:20) Escaneo de rutas + UA de herramienta.** `--ua "sqlmap/1.8" --rps 20`. El `tail()` cuenta por IP/UA en ventanas de 10 s, el motor de reglas abre el incidente CF-SCAN-404 / CF-UA-TOOL en <10 s [objetivo propio] y llega el **WhatsApp interactivo** (sandbox de Kapso) en menos de 30 s. El cronómetro marca el tiempo real.
3. **(0:50) Ruta de administrador sembrada.** El ataque toca `/api/admin`: la regla sube a crítica y **suena el teléfono**; la voz de ElevenLabs en español explica en dos frases qué pasó y la acción propuesta. La voz solo informa, no aprueba.
4. **(1:30) Regresión de exposición (la estrella).** Se aplica una migración sembrada `alter table public.pedidos disable row level security;`. VanGUARD re-prueba con la publishable key (HEAD con `count=exact`), la foto pasa de «protegida» a «expuesta» con el `commit_sha`, y el panel pasa de verde a rojo. Cruce en vivo: «esta tabla es legible **y** una IP la está leyendo» (idea 5).
5. **(2:10) Neutralizar y verificar.** Botón grande «Bloquear esta IP» → confirmación con código de un solo uso → `POST /zones/{id}/firewall/access_rules/rules`; el atacante empieza a recibir 403. Claude genera el **prompt de corrección** («nueva migración que active RLS y una política por `auth.uid()`»); el dueño lo pega en su IA, y **«verificar arreglo»** re-corre la prueba exacta y marca «cerrado, verificado a las 14:32».
6. **(2:40) Cierre.** El repo conectado muestra el aviso real de una dependencia con CVE y un `.env` sembrado (cada uno etiquetado real/simulado); el cuadro «qué no ves según tu plan»; y «Exportar para tu IA» (Markdown redactado) para que cualquiera audite con su propia IA. Al terminar: `DELETE` de la regla de IP.

**Respaldos:** video grabado el sábado por la noche cuando todo funcione; capturas de cada paso; si la analítica GraphQL llega con retraso, se muestra la vista del sensor `tail()`; plan B de voz en el navegador y Telegram como plan B de mensajería [verificado: R14 §0, R17 §9.2]. **Probar el sábado** que el WAF de Cloudflare no actúa antes que nuestro Worker (si lo hace, no se luce nuestro bloqueo): tráfico moderado ≤20 rps, ≤2 min.

---

## 12. Riesgos top 10 con mitigación

| # | Riesgo | Prob. | Mitigación |
|---|---|---|---|
| 1 | Nadie paga Workers Paid (5 USD) y todo corre con 10 ms de CPU: sin escaneos, Workflows ni Tail Workers | Media | Decidir quién pone la tarjeta **antes de las 10:00 del sábado** (orquestador) |
| 2 | La llamada a móviles +58 no entra o tarda (operador) | Alta | Probar hoy con Movistar, Digitel y Movilnet; número extranjero de respaldo; plan B voz en navegador; video [R14 §0] |
| 3 | La plantilla de WhatsApp no la aprueba Meta a tiempo | Alta | **La demo va por sandbox de Kapso** (mensajes interactivos sin plantilla); la plantilla es mejora, no dependencia [R14 §1.6] |
| 4 | Endpoints beta de Supabase (read-only query, advisors, metrics, logs) cambian o fallan | Media | Probarlos a las 08:00 en el proyecto de demo; `try/catch` que degrada a «sin dato»; `splinter.sql` como respaldo [R09 riesgos] |
| 5 | La mitigación automática de DDoS de Cloudflare actúa antes que nuestro bloqueo | Media | Ensayar con volumen moderado; si pasa, se usa el sensor `tail()` y un bloqueo dentro de la víctima [R10 riesgos, R17 §9.2] |
| 6 | La org de GitHub/Platanus no deja crear secretos de Actions para el deploy | Media | Repo espejo personal con el mismo `deploy.yml` (camino B); o Codespaces [R17 §6.4] |
| 7 | Abuso del deploy público por los agentes del jurado gasta los créditos de Claude | Media | Topes por tenant (1,50 USD/día, 3 auditorías), global 40/día, escalera de degradación, interruptor de corte [R12 §13] |
| 8 | Inyección de instrucciones desde logs/repo hacia el prompt de corrección que el dueño pega en su IA | Media | El motor de reglas decide, no el modelo; evidencia citada entre delimitadores marcada como no confiable; filtro determinista; el modelo sin herramientas de escritura [R12 §15, R11] |
| 9 | Norton bloquea `.exe`/addons; type stripping no resuelve los paquetes del workspace | Media | wrangler fuera de todo `package.json`; FRONT con Vite puro; `tsc -b` de `core`/`contracts` (JS puro); nadie toca Norton [R17 §7] |
| 10 | Falsos positivos (regla genérica de secretos, umbrales sin calibrar) hunden la credibilidad ante jueces técnicos | Media | Severidad media + lista de permitidos; ordenar por P0/P1; «confirmado en vivo» pesa más que «inferido»; mostrar siempre la cobertura junto al puntaje [R11 riesgos, R15 §6.8] |

Riesgos secundarios: PSI con 429 o lento (clave propia + backoff + última medición guardada); analítica GraphQL con retraso (el incidente sale del `tail()`, GraphQL solo confirma); crons tardan hasta 15 min en propagar (desplegarlos temprano); sin dominio a tiempo (`deploy-url` queda en workers.dev).

---

## 13. Reparto propuesto: 5 personas, 3 chats, con dependencias

Cinco integrantes: Carlos Bastidas, Giovanni Zarbo (orquestador/PM), Daniel Barreda, Andrés Valero, Gabriel García. Tres chats de IA construyen en paralelo.

| Chat / persona | Responsabilidad | Carpetas | Depende de |
|---|---|---|---|
| **Orquestador** (Giovanni + 1) | Esqueleto del monorepo, `@vanguard/contracts` inicial, `wrangler.jsonc`, `deploy.yml`, bootstrap de cola/bucket, cuentas y tokens (Cloudflare Paid, dominio, PSI, Anthropic workspaces), app víctima + `scripts/ataque.mjs`, ensayo de la demo, README y archivos del hackatón | `/`, `.github/`, `apps/victima/`, `scripts/` | Nada (arranca primero) |
| **Chat BACK** (Daniel + Andrés) | Migraciones (tablas, RLS, Vault, Broadcast, cron), API Hono (auth por Bearer, conexiones con cifrado WebCrypto, scans, export, MCP), Cron→Queue→monitores y reglas, Workflow `vg-scan` (Supabase, Cloudflare, repo, ZIP, PSI, síntesis IA), escáner de secretos/CVE, `tail()` sensor, libro de gasto, notificador Kapso/ElevenLabs | `apps/api/`, `packages/core/`, `supabase/`, parte de `packages/contracts/` | Contrato del orquestador (hora 1); tokens de las cuentas |
| **Chat FRONT** (Gabriel + 1) | SPA (shell con Sidebar, páginas por módulo con `PantallaModulo`+`EstadoModulo`, onboarding de conexiones con guía, puntaje de blindaje + cobertura, bandeja «Ahora», gráficos Recharts del histórico, banner/botones de incidentes por Realtime, botones grandes, export) | `apps/web/` | `@vanguard/contracts` + fixtures (un `EstadoModulo` falso por vertical para avanzar sin BACK) |

**Orden y dependencias (ruta crítica):**
1. **Hora 1 (orquestador):** estructura del monorepo, contrato inicial, `wrangler.jsonc`, deploy a workers.dev de respaldo, cuentas. Sin esto nadie arranca.
2. **08:00 (BACK):** probar en el proyecto de demo los endpoints beta de Supabase (read-only query, advisors, metrics, logs), los campos de Cloudflare (`clientIP`, `datetimeMinute`) y las columnas de logs. 30 min que destraban todo lo demás.
3. **Paralelo:** FRONT contra fixtures; BACK migraciones + API + reglas; orquestador app víctima + ataque.
4. **Integración:** cada PR publica una Version URL con alias; FRONT apunta su proxy a la preview.
5. **Sábado noche:** ensayo completo, medir el tiempo de aviso, grabar el video de respaldo, congelar funciones nuevas a las 22:00.
6. **Domingo mañana:** documentación, `test:rls` y autoauditoría en CI, logo y metadatos, despliegue final; margen 11:00-12:00 sin nada nuevo.

**Ingeniería visible para el 25 % técnico (lo que el jurado revisa con agentes):** README con instalación y demo en <5 comandos; diagrama de arquitectura y página de modelo de amenazas («cómo VanGUARD asegura su propia seguridad»); `.env.example` sin secretos en el historial; pruebas Vitest de las reglas (`core/rules`), del cifrado (`core/crypto`: ida y vuelta, alteración, contexto) y de la redacción (`core/redact`); `test:rls` contra el proyecto real (usuario B lee 0 filas de la org A, `connection_secrets` da permiso denegado, 0 tablas sin RLS); CI en GitHub Actions; y **VanGUARD auditándose a sí mismo** en el pipeline. Es la prueba, no la promesa, de las decisiones de este borrador.



