# VanGUARD — Decisiones canónicas del plan maestro (fuente de verdad única)

**Platanus Hack 26 Caracas · team-22 · track AI Security · etapa 2 de 4 (síntesis).** Sábado 24-oct-2026, madrugada (Caracas). Entrega: domingo 25 a las 12:00.

> **Actualizado en la fusión final (sáb 24-oct, ~02:30 Caracas).** Este anexo ya incorpora las decisiones que el orquestador tomó al resolver los conflictos entre secciones (estado real del dominio, regla de rate limit única, DMARC, DNSSEC, `tail()`, guion de la demo, presupuesto de IA, formato de claves). Si algo de aquí choca con el contrato de la sección 15 o con el DDL de la sección 05, **mandan la 15 y la 05**.
>
> **Qué es este documento.** La única fuente de verdad que siguen los 16 redactores y luego los chats FRONT, BACK y orquestador. Sintetiza los borradores A (MVP ejecutable), B (ambición técnica) y C (seguridad y confianza) y los informes R01–R17. Donde algo choque: manda el **encargo de hoy** y los **cambios de última hora del equipo**, luego **R17** (despliegue en Cloudflare) sobre R13/R16, luego el resto.
> **Prioridades.** **P0** = la demo lo necesita sin falta (listo el sábado 20:00). **P1** = debe estar el domingo 10:00. **P2** = hoja de ruta (se menciona en el pitch, no se promete).
> **Marcas.** `[verificado: URL]` = comprobado hoy en esa fuente (por los informes R01–R17 o en esta sesión). `[no verificado]` = falta comprobarlo antes de prometerlo. `[propuesta]` = umbral o decisión nuestra, a calibrar.
> **Idioma del código.** Identificadores (tablas, columnas, rutas, enums, canales) en **inglés snake_case**; textos de UI, WhatsApp y voz en **español**. Única excepción deliberada: el modelo de vista `EstadoModulo` conserva los nombres en español de R08.

---

## 1. Nombre del producto y one-liner

- **Nombre:** **VanGUARD** (con GUARD en mayúsculas). Decidido por el equipo, ya en `platanus-hack-project.jsonc`. No se proponen otros nombres.
- **One-liner (el del jsonc, no se cambia):** «Conecta tu Supabase, tu Cloudflare y tu repo de GitHub: una IA audita todo tu ecosistema, detecta puntos débiles y ataques, y te avisa al instante por WhatsApp o llamada.»
- **Frase de posicionamiento (pitch, de R15 §4.2):** «Aikido y los advisors de Supabase te dicen qué está mal configurado. VanGUARD te avisa cuándo alguien lo está aprovechando, te llama, y te da el arreglo listo para tu IA — sin pedirte nunca una clave que pueda escribir.»
- **`deploy-url` (definitiva):** `https://officialvanguard.com`. Ya está en `platanus-hack-project.jsonc`; no se toca.

---

## 2. Alcance por módulo (P0 / P1 / P2)

Doce módulos canónicos. IDs de módulo (enum `module`, los únicos que puntúan): `supabase`, `cloudflare`, `codebase`, `performance`. Los demás son pantallas transversales (conexiones, resumen, auditoría, incidentes, IA, exportar, ajustes).

| Módulo | P0 (demo, sin falta) | P1 (domingo 10:00) | P2 (hoja de ruta) | Dueño |
|---|---|---|---|---|
| **Conexiones / onboarding** | Tres tarjetas grandes (Supabase, Cloudflare, GitHub) con guía de 4 pasos y botón «Probar conexión». **Guardas de entrada** (§10.3): rechaza `sb_secret_`, JWT `role=service_role`, PAT de Supabase que no empiece por `sbp_fc`, PAT clásico `ghp_`, Global API Key de Cloudflare. Sondeo por permiso: cada 403 → «te falta el permiso X». Muestra solo `••••a1b2`, alcances y caducidad. Conexión `ingest` para la app propia: genera el secreto HMAC y lo muestra **una sola vez** | Rotar token sin perder historial; verificación de dominio por TXT (DoH); clave publicable para el sondeo activo de RLS | OAuth «Conectar con Supabase»; GitHub App de solo lectura; proveedor Vercel | FRONT (UI) + BACK (validación y cifrado) |
| **Resumen (puntaje)** | Puntaje de blindaje 0–100 **siempre con la cobertura al lado** («vemos N de 4 fuentes», N del servidor); conteo por severidad; bandeja «Ahora» (los 10 peores hallazgos e incidentes); botón grande «Auditar todo» | Cifras de servidor de Supabase (CPU/RAM/disco/conexiones); tendencia del puntaje por auditoría | Mapa de superficie (grafo) | FRONT; cálculo en `packages/core/score.ts` (BACK) |
| **Supabase** | Advisors `security` y `performance` → hallazgos. Tres chequeos SQL de solo lectura por `/database/query/read-only`: `SB_RLS_DISABLED`, `SB_POLICY_ALLOW_ALL`, `SB_RPC_ANON_NO_LIMIT` (§9.2). Salud con `GET /health` cada minuto (`SB_DB_DOWN`) | Métricas Prometheus por Management API (`SB_CPU_HIGH`, `SB_DISK_HIGH`, `SB_CONN_HIGH`); `SB_TABLE_BLOAT`; config de Auth por lista blanca; `SB_EXPOSURE_REGRESSION`; botón «Verificar arreglo» | Catálogo SQL completo (DB/SEC/RL/S/A/B de R02–R04); logs ClickHouse (explotación en curso) | BACK + FRONT |
| **Cloudflare** | Conexión con sondeo de permisos. Ingesta de la víctima + reglas en vivo `CF_ADMIN_EXPOSED`, `CF_PATH_SCAN`, `CF_UA_TOOL`, `CF_IP_FLOOD`. Acción «Bloquear IP» (IP Access Rule) con simulación + «Deshacer». Pulso GraphQL cada 5 min para top IPs/UA/rutas. **Dogfooding:** audita nuestra propia zona `officialvanguard.com` | Auditoría de configuración `CF_DNS_*`, `CF_TLS_*`, `CF_WAF_01`; eventos de firewall para confirmar el bloqueo; Under Attack con «Deshacer»; sensor `tail()`; webhook `dos_attack_l7` | Rate limit y regla por UA; reputación de IP; correlación entre capas | BACK + FRONT |
| **Codebase (GitHub + ZIP + CVE + secretos)** | PAT fine-grained de 1 repo; `zipball` de la rama por defecto; escáner en memoria con `fflate`: `CB_ENV_COMMITTED`, `CB_GITIGNORE_NO_ENV`, `CB_SECRET_*` (incluye JWT `service_role`), `CB_DEP_VULN` (OSV `querybatch` sobre `package-lock.json` y `composer.lock`) | ZIP subido a R2 (≤ 25 MB) con el mismo escáner; `.env` en el historial (`commits?path=`); prioridad con CISA KEV; `pnpm-lock.yaml`; `CB_KEY_REUSE` (huella HMAC) | EPSS, deps.dev, endoflife.date; SAST con Claude sobre 15 archivos con filtro antialucinación; GitHub App | BACK + FRONT |
| **Rendimiento (Lighthouse histórico)** | Pantalla con la última medición **sembrada** (dato real medido el sábado) | «Medir ahora» con PSI v5 (móvil y escritorio) **solo sobre dominios verificados de la org**; histórico de score/LCP/TBT/CLS; `compareRuns` → `PF_REGRESSION`; dos versiones de la víctima (sana y con regresión) | Tiempos de build por GitHub Actions; Observatory de nuestra zona | BACK + FRONT |
| **Auditoría de un botón** | `POST /api/orgs/:org/scans {kind:'full_audit'}` lanza el Workflow `vg-scan` con pasos `supabase`, `cloudflare`, `repo`, `resumen_ia`, progreso por paso y puntaje final | Paso `psi`; re-auditoría diaria por cron `0 10 * * *` | Batch nocturno; PR automático de corrección | BACK; UI de progreso en FRONT |
| **Incidentes y alertas (Kapso/ElevenLabs)** | Un incidente por IP atacante (eventos agrupados); línea de tiempo con cronómetro (ataque → WhatsApp → llamada → bloqueo). WhatsApp interactivo por **sandbox de Kapso** (botones «Lo estoy viendo» / «Silenciar 1 h»). Llamada ElevenLabs+Twilio en crítico. Webhook de ack de Kapso. Techos por org y plantillas fijas | Escalamiento sin ack con Queue y `delaySeconds`; herramienta de voz `registrar_respuesta` + webhook post-llamada; aprobar «Bloquear IP» desde WhatsApp con nonce; planes B de voz; redacción del aviso con Sonnet (≤ 3 s) | Telegram; email Resend; plantilla de Meta aprobada | BACK; UI en FRONT; cuentas de Gabriel |
| **Motor IA y prompts de corrección** | IA-1: prompt de corrección por hallazgo (Sonnet 5.5), guardado en `findings.fix_prompt`. IA-2: síntesis de la auditoría (Opus 5.5). Libro de gasto, topes e interruptor de corte | IA-3: texto de alertas; panel «Gasto IA hoy»; «Verificar arreglo» | Chat «pregúntale a Claude»; conector MCP opcional; Batch; editor de prompts | BACK |
| **Exportar a cualquier IA / MCP propio** | Exportar en Markdown y JSON (determinista, secretos redactados, encabezado que marca la evidencia como dato no confiable) + botón «Copiar para mi IA» | Servidor `/mcp` propio con 4–8 herramientas de solo lectura y tokens `vgk_`; guía de los MCP oficiales (Supabase `read_only=true`, GitHub `readonly`) | SARIF; OAuth 2.1 para ChatGPT (claude.ai ya admite cabeceras fijas con `vgk_`) | BACK; UI en FRONT |
| **Ajustes** | Contactos de alerta (nombre, teléfono E.164, canal); estado de la IA (encendida/en pausa, leído del servidor); cerrar sesión | Miembros y roles; factor de umbral por zona; registro de auditoría encadenado | «Qué no ves según tu plan»; editor de prompts | FRONT + BACK |
| **Acceso (transversal)** | Supabase Auth con correo y contraseña, sin confirmación de correo. Botón «Ver demo»: `signInAnonymously()` + RPC `join_demo_org()` que da rol `viewer` en la org de demo. El viewer no lanza auditorías ni gasta IA | Login con GitHub | Invitaciones | BACK (RPC) + FRONT |

**Núcleo de la demo (lo que no puede faltar):** Conexiones con guardas → «Auditar todo» (puntaje rojo + hallazgos) → ataque reproducible contra `demo.officialvanguard.com` → incidente en vivo → WhatsApp + llamada → «Bloquear IP» con confirmación → prompt de corrección y exportar.

Que Supabase permita `signInAnonymously()` y que el JWT lleve `is_anonymous` está [no verificado]: comprobarlo en la hora 1. Plan B: cuenta de demo `viewer` cuya contraseña se entrega al jurado en el README y nunca va en el bundle.

---

## 3. Stack definitivo (versiones exactas)

Versiones del registro de npm consultado hoy (R16 §1, R17 §2) [verificado: https://registry.npmjs.org]. **Regla: versiones exactas sin `^`, `pnpm install --frozen-lockfile` en CI, nunca subir de versión mayor durante el hackatón.**

| Capa | Pieza | Versión | Por qué |
|---|---|---|---|
| Runtime | Node | 24.x (≥ 24.12) | Quita tipos de TS sin compilar, estable desde 24.12: el BACK corre sin `tsx`/esbuild [verificado: changelog typescript.md de nodejs.org, R17 §7]. Versión exacta por laptop [no verificado] |
| Producción | Cloudflare Workers **Paid** (5 USD/mes) | `compatibility_date` `2026-10-20`, flag `nodejs_compat` | Free da 10 ms CPU y 50 subpeticiones: no caben escaneos ni Tail Workers [verificado: https://developers.cloudflare.com/workers/platform/limits/] |
| Monorepo | pnpm | 10.34.7 | Workspaces sin Turborepo (R16) |
| Lenguaje | typescript | 6.0.3 | La 7.0.2 no trae la API de compilador en JS (R16 §1) |
| FRONT | vite + @vitejs/plugin-react | 8.3.5 + 6.1.2 | Vite 8 usa rolldown + lightningcss (addons `.node`), **no esbuild** [verificado: registro npm, R17 §2] |
| FRONT | react, react-dom | 19.3.1 | |
| FRONT | react-router | 7.18.4 | No subir a la 8.x (R17) |
| FRONT | @tanstack/react-query | 5.104.5 | Polling de 3 s en P0; invalidación por Realtime en P1 |
| FRONT | tailwindcss + @tailwindcss/vite | 4.3.3 | |
| FRONT | shadcn (CLI, solo `pnpm dlx`) | 4.22.1 | Sidebar (Ctrl+B) + Chart sobre Recharts v3 [verificado: https://ui.shadcn.com/docs/components/sidebar] |
| FRONT | recharts | 3.10.1 | La instala `shadcn add chart`. Tremor fuera: exige React 18 (R16 §3.1) |
| Compartido | zod | 4.6.7 | Contratos en `@vanguard/contracts` |
| Compartido | @supabase/supabase-js | 2.118.0 | Soporta Workers [verificado: https://github.com/supabase/supabase-js] |
| BACK | hono | 4.13.13 | API en el mismo Worker; el mismo `app` corre en Node para desarrollo |
| BACK (solo dev) | @hono/node-server | 2.1.5 | `dev-node.ts` (R17 §11.4) |
| BACK | @anthropic-ai/sdk | 0.137.0 | Última 0.x; la 1.x salió esta semana, no se adopta (R16, R17) |
| BACK | fflate | 0.8.3 | ZIP en memoria, JS puro [verificado: https://github.com/101arrowz/fflate] |
| BACK (P1) | yaml | 2.9.1 | `pnpm-lock.yaml` |
| BACK (P1) | @modelcontextprotocol/server | 2.3.1 | `WebStandardStreamableHTTPServerTransport` sin estado, montado en Hono [verificado: https://unpkg.com/@modelcontextprotocol/server@2.3.1/dist/index.d.mts] |
| BACK (tipos) | @cloudflare/workers-types | 5.20261024.1 | Solo `.d.ts`. Convive con `wrangler types --env-interface CloudflareBindings --include-runtime=false` (solo bindings, sin duplicar los tipos del runtime); tsconfig de `apps/api` con `"types": ["@cloudflare/workers-types", "node"]` |
| Datos | Supabase Free | Postgres, Auth, Vault, Realtime Broadcast, pg_cron | 2 proyectos activos por cuenta (producto + dev); víctima en otra cuenta [verificado: https://supabase.com/pricing] |
| Archivos (P1) | Cloudflare R2 | bucket `vanguard-uploads` | ZIP ≤ 25 MB; 10 GB-mes gratis [verificado: https://developers.cloudflare.com/r2/pricing/] |
| Cripto | WebCrypto (AES-256-GCM, HKDF, HMAC) | nativo | Mismo código en Worker y Node 24 [verificado: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/] |
| Pruebas | vitest | 4.1.12 | Corre en Node; nada de `@cloudflare/vitest-pool-workers` (necesita workerd) |
| CI | wrangler | 4.152.0, **solo** `pnpm dlx` | No va en ningún `package.json` (R17 §7) |
| CI | actions/checkout, setup-node, pnpm/action-setup | v7, v7, v6 | [verificado: API de GitHub, R17 §6.3] |

**Prohibido en el producto:** `service_role`/`sb_secret_` del cliente, PAT legacy de Supabase, OAuth scope `repo` de GitHub, Global API Key de Cloudflare, Next.js/OpenNext (bugs `proxy.ts` #1400/#1373), Vercel y Railway como hosting, Cloudflare Pages (sin Cron ni Workflows), Durable Objects en el Worker principal (anulan las Version URLs), la librería `lighthouse` (necesita Chrome; se usa PSI), la CLI `supabase` y wrangler/miniflare/agents en un `package.json` (binarios que Norton bloquea), osv-scanner/gitleaks/Semgrep como binarios, Fable 5.1 (2,5× Opus y clasificadores contra ciberseguridad), `temperature`/`top_p`/`top_k` (400 en todos los modelos desde el 2026-10-21), `tool_choice` forzado en Opus/Sonnet 5.5 (400), MCP dentro del bucle de monitoreo.

---

## 4. Topología de despliegue

```
 Navegador (SPA Vite)  ── HTTPS, mismo origen ──►  Worker "vanguard"  (Workers Paid, https://officialvanguard.com)
   supabase-js (PKCE, publishable key)              ├─ assets: apps/web/dist (gratis, sin CPU) + _headers (CSP)
                                                     ├─ run_worker_first → Hono: /api/*, /ingest/*, /webhooks/*, /mcp (P1)
 Clientes de IA (P1) ── Bearer vgk_ ──► /mcp         ├─ scheduled "* * * * *" → Queue vg-monitor (monitores)
                                                     ├─ scheduled "0 10 * * *": re-auditoría (P1)
 Worker "vanguard-victima" (demo.officialvanguard.com) ├─ /ingest → motor en vivo en ctx.waitUntil: reglas + incidente + aviso
   cada petición → ctx.waitUntil(POST /ingest, HMAC)  ├─ queue consumer: monitores (sb_health, cf_pulse; P1 escalate)
          │   (tail() de "vanguard": stub en P0, P1 salud) └─ Workflow "vg-scan": auditoría, repo, ZIP (P1), PSI (P1), resumen IA
          │                                                  │ sb_secret_ (solo servidor)
          ▼                                                  ▼
 Supabase "vanguard-demo" (otra cuenta, sembrado)    Supabase "vanguard-prod" (RLS por org_id, Vault, pg_cron)  ·  R2 vanguard-uploads
 APIs de clientes (solo lectura): api.supabase.com, api.cloudflare.com (REST+GraphQL), api.github.com, api.osv.dev
 Salidas: api.kapso.ai, api.elevenlabs.io → Twilio, api.anthropic.com, www.googleapis.com (PSI, P1)
```

| Pieza | Dónde corre | URL / identificador | Notas |
|---|---|---|---|
| Producto (SPA + API + cron + Workflow + MCP) | Worker `vanguard`, Workers Paid | **`https://officialvanguard.com`** (apex, Custom Domain) + respaldo `https://vanguard.<subdominio-de-cuenta>.workers.dev` | `"workers_dev": true` explícito (si se añaden `routes` se inferiría `false` y se pierde el respaldo) [verificado: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/]. `run_worker_first: ["/api/*","/ingest/*","/webhooks/*","/mcp","/mcp/*","/.*","/.well-known/*","!/.well-known/security.txt"]` (`/.env`, `/.git/config` y `/.well-known/oauth-*` reciben 404 JSON de Hono en vez de la portada; `security.txt` lo sirven los assets), `not_found_handling: "single-page-application"` (R17 §6.1, S03 03.7, S06 SEG-04) |
| App víctima | Worker `vanguard-victima` (Hono, ~80 líneas) | **`https://demo.officialvanguard.com`** (Custom Domain) | `tail_consumers: [{service:"vanguard"}]` (por eso `vanguard` exporta un `tail()` vacío desde el primer deploy). Detrás del WAF de la zona para que «Bloquear IP» corte en el borde. **Configuration Rule** `http.host eq "demo.officialvanguard.com"` → Browser Integrity Check off: sin ella el borde corta `User-Agent: sqlmap/1.8` con 403 y error 1010 (comprobado) |
| Base del producto | Supabase Free, proyecto `vanguard-prod` | `https://<ref>.supabase.co` | `sb_secret_` solo en el Worker |
| Base de desarrollo | Supabase Free, proyecto `vanguard-dev` | otro `<ref>` | Ningún desarrollo local toca la Vault de producción |
| Base de la víctima | Supabase Free, proyecto `vanguard-demo` (cuenta de Gabriel) | otro `<ref>` | Sembrado vulnerable, secretos **falsos** |
| Repo de la víctima | GitHub **privado** `vanguard-demo-victima` | PAT fine-grained de ese repo | Privado y con secretos falsos (Supabase revoca claves que aparecen en repos públicos) |
| CI/CD | GitHub Actions (ubuntu) con `pnpm dlx wrangler@4.152.0 deploy --secrets-file` | `.github/workflows/deploy.yml` (R17 §6.3) | **Camino A:** repo de la org, si se pueden crear secretos de Actions [no verificado]. **Camino B:** espejo personal con el mismo yaml. Se decide en la hora 1 |

**Decisión de subdominios (única, usada en todo el plan):** el producto y la API viven en el **apex** `officialvanguard.com` (API, webhooks e ingesta como rutas bajo el apex gracias a `run_worker_first`, mismo origen, sin CORS); **no** se crean `api.` ni `mcp.` (el MCP es la ruta `/mcp`). `www.officialvanguard.com` redirige al apex con una Redirect Rule 301 (`https://www.*` → `https://${1}`, preserva query), con un registro A/AAAA proxied para `www` (se reutiliza el que exista; si no queda ninguno, placeholder `192.0.2.0` / `100::`) [verificado: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/]. La víctima vive en `demo.officialvanguard.com`. El Worker `vanguard` puede llamar por `fetch()` a la víctima en la misma zona y la invoca [verificado: misma fuente].

**Migración del dominio a Cloudflare — estado real y pasos que quedan** (comprobado sáb 24-oct 01:56 y 02:25 de Caracas por DoH y `curl --resolve officialvanguard.com:443:104.21.53.192`; detalle en S03 03.4 y S16 16.5):
1. **Hecho — sitio en Cloudflare (plan Free) y nameservers delegados:** `NS` = `martin.ns.cloudflare.com` y `ziggy.ns.cloudflare.com`, cambiados en Squarespace Domains («Use Custom Nameservers»). La transferencia de registrador **no** se hace (bloqueo de 60 días tras el registro) y **no hace falta**.
2. **Hecho — DNSSEC activo de punta a punta:** el `.com` publica el DS de Cloudflare (`2371 13 2 …`) y los resolutores validan (`AD=true`). **Regla:** no tocar NS, DS ni DNSSEC; apagar DNSSEC en Cloudflare sin quitar antes el DS en Squarespace deja el dominio en SERVFAIL.
3. **Hecho — página provisional en el apex:** el Worker `vanguard` (el único de la cuenta, creado ~01:30) sirve `site/` con 200 en `https://officialvanguard.com`; `http://` → 301; desde las 02:25 todo lo que no es un asset (`/.env`, `/api/health`) da 404 (sin fallback de SPA). El validador del hackatón ya recibe 200. **Trampa:** la caché DNS de Windows puede seguir dando las IPs de Squarespace (`198.185.159.x`, página «Próximamente»): `ipconfig /flushdns` o `curl --resolve`.
4. **Pendiente (ORQUESTADOR, sáb 09:00–10:00):** (a) desplegar el esqueleto en **el mismo** Worker `vanguard` (reemplaza la provisional sin tocar el Custom Domain; no borrar antes el DNS del apex) con `routes: [{pattern:"officialvanguard.com", custom_domain:true}]` y `"workers_dev": true`, para que `GET /api/health` dé `{ok:true,…}`; (b) `www` → 301: quitar `www` del Worker si figura como Custom Domain, mirar en DNS › Records qué lo sirve sin duplicar, y crear la Redirect Rule; (c) a las 15:00, Custom Domain `demo.officialvanguard.com` para `vanguard-victima` y su Configuration Rule `bic: false`.
5. **Configuración de seguridad de nuestra zona** (que el módulo Cloudflare audite en verde — dogfooding): **SSL Full (strict)**; **Always Use HTTPS = on** (ya responde 301; **nunca** se apaga «para la víctima»: es un ajuste de zona); **TLS mínimo 1.2** y TLS 1.3; **HSTS** con `max_age ≥ 15552000` solo cuando todo funcione en HTTPS (dom 07:00, R10 CF-TLS-04); **Free Managed Ruleset** del WAF (CF-WAF-01); **una regla de rate limit** de Free: `(http.request.uri.path contains "/api/")`, **400 peticiones / 10 s** por IP (`cf.colo.id` + `ip.src`), bloqueo 10 s — Free no filtra por host y el umbral queda por encima del simulacro (200/10 s) y de ~40 pestañas tras el mismo NAT [verificado: https://developers.cloudflare.com/waf/rate-limiting-rules/]; **Bot Fight Mode off** (servimos API y webhooks, R10 §4.5); **correo**: se **conservan** el `v=spf1 -all` y el `_dmarc` `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s` ya publicados (más estrictos que `p=quarantine`) y se añade DKIM nulo `*._domainkey "v=DKIM1; p="`; **Email Routing** apagado (P2: si se activa, queda un único SPF, el de Cloudflare). El certificado de cada Custom Domain se emite solo [verificado: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/].
6. El Custom Domain **no** se puede crear sobre un hostname con un CNAME existente ni sin zona activa: borrar antes cualquier CNAME de `www`/`demo` que quede de Squarespace [verificado: misma fuente].

**Entornos:** sin bloques `env.*` (crearían Workers separados). **Producción** = la versión desplegada de `vanguard` desde `main`. **Previews por PR** = `wrangler versions upload --preview-alias pr-N` (comparten base y secretos con producción; los crons y consumidores de cola **no** corren en ellas, pero una preview **sí** puede producir a la cola de producción y crear instancias del Workflow [verificado: https://developers.cloudflare.com/workers/previews/resources/], así que todo productor de la cola distinto del cron aplica la guarda de host). `POST /api/orgs/:org/notifications/test`, el envío real de WhatsApp/llamada y `confirm` de acciones responden **403 salvo que `VG_ENV === 'production'` y el hostname sea el de `APP_ORIGIN`** (`officialvanguard.com`; S15 15.3). **Local:** Vite en `:5173` con proxy de `/api`, `/ingest`, `/mcp` a `:8787` (Hono en Node, `node --env-file=.dev.vars --watch src/dev-node.ts`); la víctima en `:8788`; `VITE_USE_FIXTURES=1` permite al FRONT trabajar sin BACK.

**Costo de infraestructura:** Workers Paid 5 USD/mes + dominio ya comprado en Squarespace (gestión DNS en Cloudflare, gratis) + Supabase Free + alertas por menos de 40 USD (ElevenLabs Starter, recarga de Twilio ~20 USD, número de EE. UU. ~1,15 USD/mes, Kapso Free) [verificado en R14 §0]. **Giovanni decide hoy quién pone la tarjeta de Workers Paid antes de las 10:00.**

---

## 5. Estructura del monorepo

```
/                         ORQUESTADOR  package.json, pnpm-workspace.yaml, tsconfig.base.json, README.md, ARQUITECTURA.md,
                                       SECURITY.md, THREAT_MODEL.md, CODEOWNERS, .gitignore, .github/workflows/deploy.yml
apps/web/                 FRONT        Vite + React. src/{app,modulos,componentes,lib}/**; sin dependencias de Cloudflare
apps/api/                 BACK         src/app.ts (Hono), src/worker.ts (fetch/scheduled/queue/tail), src/workflow.ts (ScanWorkflow),
                                       src/rutas/*.ts, src/scans/{supabase,cloudflare,repo,zip,psi,resumen}.ts,
                                       src/notify/{kapso,elevenlabs}.ts, src/ia/claude.ts, src/mcp.ts, src/dev-node.ts,
                                       wrangler.jsonc (base del orquestador; BACK agrega bindings), worker-configuration.d.ts (generado y versionado)
apps/victima/             BACK (zona del orquestador)  Worker de demo: /, /login, /api/productos, /admin (sin auth a propósito); tail_consumers → vanguard
packages/contracts/       COMPARTIDO   src/*.ts (zod 4.6.7) + src/fixtures/*.ts + src/database.types.ts (generado). Solo cambia por PR que aprueba el orquestador
packages/core/            BACK         rules/*.ts (reglas puras), score.ts, crypto.ts, redact.ts, untrusted.ts, key-guards.ts, otp.ts, zip.ts, secrets/*.ts,
                                       lockfiles/*.ts, templates/*.ts; perf/ es del ORQUESTADOR hasta el sáb 18:30 (S10). Las primitivas las escribe Daniel y las revisa el ORQUESTADOR
supabase/migrations/      BACK         único escritor del esquema; numeradas 0001_..., aplicadas con el MCP de Supabase o el editor SQL
supabase/tests/rls.sql    BACK         pruebas de RLS en CI (VanGUARD se audita a sí mismo)
scripts/ataque.mjs        ORQUESTADOR  generador de ataque con fetch de Node, sin binarios (--rps, --segundos, --ua, --admin-desde)
demo/                     ORQUESTADOR  seed-victima.sql, repo-vulnerable/, guion.md, seed-perf.sql
site/ · provisional/      ORQUESTADOR  TEMPORALES y sin versionar (.gitignore): página provisional que hoy sirve el apex; se borran
                                       cuando el primer deploy de CI sustituya al Worker "vanguard" provisional
```

**Reglas:**
1. **Un chat nunca edita la carpeta de otro.** Si el FRONT necesita un campo, lo pide al orquestador, que cambia `packages/contracts`, avisa a los dos y actualiza los fixtures.
2. **Los contratos se congelan el sábado a las 11:00.** Después solo se agregan campos opcionales.
3. `packages/contracts` y `packages/core` exportan `./src/index.ts`. El `tsconfig` del API usa `erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`, `verbatimModuleSyntax` e imports con extensión `.ts` (R17 §7). Plan B si Node no resuelve los paquetes del workspace: `tsc -b` (JS puro).
4. **La seguridad vive en `@vanguard/core`**, no en `apps/api`: se prueba con Vitest en Node sin bindings; `apps/web` tiene prohibido importar `@vanguard/core/crypto` (regla de lint).
5. Scripts raíz: `dev:web`, `dev:api`, `dev:victima`, `typecheck`, `test`, `build`. `pnpm test` corre las pruebas de `core` (reglas, score, crypto, secretos, lockfiles, inyección) y de `contracts` (los fixtures validan contra sus esquemas).
6. `docs/` está en `.gitignore`. Lo que el jurado debe leer va en `README.md`, `ARQUITECTURA.md`, `SECURITY.md` y `THREAT_MODEL.md` en la raíz.

---

## 6. Modelo de datos (proyecto `vanguard-prod`, multi-tenant por `org_id`)

**Enums** (como `text` con `check` — más fáciles de migrar que `create type` en 36 h; los mismos valores se repiten en zod dentro de `@vanguard/contracts`):

| Enum | Valores |
|---|---|
| `role` | `owner`, `admin`, `viewer` |
| `provider` | `supabase`, `cloudflare`, `github`, `ingest` (P2: `vercel`) |
| `connection_kind` | `read`, `action` |
| `module` | `supabase`, `cloudflare`, `codebase`, `performance` |
| `severity` | `critical`, `high`, `medium`, `low`, `info` (orden ascendente = gravedad, para `greatest()`) |
| `scan_kind` | `full_audit`, `supabase`, `cloudflare`, `repo`, `zip`, `lighthouse` |
| `scan_status` | `queued`, `running`, `succeeded`, `failed` |
| `finding_status` | `open`, `fixed`, `verified`, `ignored` |
| `incident_status` | `open`, `ack`, `mitigated`, `resolved` |
| `channel` | `in_app`, `whatsapp`, `voice` (P1: `telegram`, `email`) |
| `notification_status` | `queued`, `sent`, `delivered`, `read`, `failed`, `skipped_cap` |
| `action_kind` | `block_ip`, `unblock_ip` (P1: `under_attack_on`, `under_attack_off`, `rate_limit`). `approvals.action_kind` admite además `ack` y `mute` (botones de WhatsApp) |
| `action_status` | `proposed`, `executed`, `undone`, `failed` |

| Tabla | Columnas clave | Quién escribe |
|---|---|---|
| `orgs` | `id`, `name`, `slug` único, `is_demo`, `daily_audit`, `ai_daily_cap_usd numeric default 1.5`, `created_at` | API (service_role) |
| `org_members` | PK (`org_id`, `user_id`), `role`; índice en `user_id` | API y RPC `join_demo_org()` |
| `connections` | `id`, `org_id`, `provider`, `kind`, `label`, `status` (`active`/`error`/`revoked`/`expired`), `meta` jsonb (`project_ref`; `zone_id`, `zone_name`, `account_id`, `plan`; `repo_full_name`, `default_branch`), `last4`, `scopes` text[], `capabilities` jsonb (resultado del sondeo), `expires_at`, `last_checked_at`, `last_error` | API |
| `connection_secrets` | PK `connection_id`, `org_id`, `sealed` jsonb (objeto `Box` de §10), `kid`, `fingerprint` (HMAC hex), único (`org_id`, `fingerprint`). **RLS activa, ninguna política** | Solo service_role |
| `scan_runs` | `id`, `org_id`, `kind`, `status`, `progress` 0–100, `step`, `steps` jsonb (progreso por paso), `params` jsonb, `summary` jsonb (salida de IA-2), `score`, `coverage` jsonb, `error`, `requested_by`, tiempos | API y Workflow |
| `findings` | `id`, `org_id`, `scan_run_id`, `connection_id`, `module`, `rule_id` (`^(SB\|CF\|CB\|PF)_[A-Z0-9_]+$`), `severity`, `confirmed` bool, `origin` (`rule`/`ai`/`provider`), `title`, `resource`, `evidence` jsonb (siempre redactada), `fix_prompt`, `fix_model`, `status`, `status_reason`, `suspected_injection` bool, `dedupe_key`, `first_seen_at`, `last_seen_at`, `verified_at`; único (`org_id`, `dedupe_key`) | Workflow; el admin solo cambia `status` vía API |
| `incidents` | `id`, `code` (6 car.), `org_id`, `connection_id`, `rule_ids` text[], `severity`, `title`, `resource` (`ip:203.0.113.7`, `supabase:<ref>:db`), `status`, `event_count`, `details` jsonb (sin secretos ni PII), `dedupe_key`, `started_at`, `last_event_at`, `notified_at`, `acked_at`, `acked_via`, `muted_until`, `mitigated_at`, `resolved_at`, `suspected_injection`. Índice único parcial (`org_id`, `dedupe_key`) `where status <> 'resolved'` | Motor de reglas |
| `notifications` | `id`, `org_id`, `incident_id`, `channel`, `recipient_masked`, `template`, `status`, `provider_id` (`wamid`, `conversation_id`, `callSid`), `error`, tiempos; único (`incident_id`, `channel`, `recipient_masked`, `template`) | Notificador y webhooks |
| `actions` | `id`, `org_id`, `incident_id`, `approval_id`, `kind`, `target`, `status`, `provider_ref` (id de la regla de Cloudflare), `previous` jsonb, `requested_by`, `created_at`, `undone_at`, `expires_at` | API |
| `approvals` | `id`, `org_id`, `incident_id`, `action_kind`, `params` jsonb, `channel`, `recipient`, `nonce_hash` bytea único (botones: `sha256(nonce)`; código de la app: `HMAC(FPK, 'otp|'+id+'|'+código)`), `attempts` (al 5.º fallo queda quemada), `expires_at` (10 min), `used_at`, `result` jsonb. **Sin política** | Solo service_role |
| `contacts` | `id`, `org_id`, `name`, `phone_e164` (check E.164), `whatsapp` bool, `voice` bool, `priority`, `verified_at` | API |
| `edge_hits` | `id` identity, `org_id`, `connection_id`, `ts`, `ip` inet, `method`, `path` (sin query), `status`, `ua` (≤ 200), `latency_ms`, `auth` bool; índice (`org_id`, `ts desc`); se borra a las 24 h por pg_cron. **Sin política** | Ingesta |
| `edge_eval_state` | PK `org_id`, `last_eval_at` (limita la evaluación a una cada 5 s por org) | Ingesta |
| `metric_samples` | `id`, `org_id`, `connection_id`, `metric`, `ts`, `value`, `labels`; índice (`connection_id`, `metric`, `ts desc`); retención 7 días | Cron |
| `perf_runs` (P1) | `id`, `org_id`, `url`, `strategy`, `source` (`psi`), `lighthouse_version`, `scores` jsonb, `metrics` jsonb (`lcp_ms`, `tbt_ms`, `cls`, `fcp_ms`, `si_ms`, `ttfb_ms`), `created_at` | Workflow |
| `mcp_tokens` (P1) | `id`, `org_id`, `name`, `token_hash` (SHA-256 del `vgk_`), `scopes` text[], `last4`, `expires_at`, `last_used_at`, `revoked_at`; política solo owner/admin | API |
| `ai_usage` | `id`, `org_id`, `route` (+ `triage` reservada), `model` (cualquier `claude-*`, para registrar el modelo de respaldo), `input_tokens`, `cache_read`, `cache_write`, `output_tokens`, `cost_usd` numeric(12,6), `stop_reason`, `refusal_category`, `request_id`, `created_at`. **Sin política** | `ia/claude.ts` |
| `app_config` | PK `key`, `value` jsonb: `ia_habilitada`, `topes` = `{global_usd_day:40, demo_usd_day:10, org_usd_day:1.5, org_audits_day:3}` | Orquestador, a mano |
| `webhook_events` | `provider`, `external_id` (`X-Idempotency-Key` de Kapso, `conversation_id` de ElevenLabs), único (`provider`, `external_id`), `payload_redacted`. **Sin política** | Webhooks |

**RLS** (patrón de R16 §8, ya escrito): funciones `private.user_org_ids()` y `private.user_admin_org_ids()` `security definer` con `search_path = ''`. Cada tabla con `org_id` lleva `for select to authenticated using (org_id in (select private.user_org_ids()))`. Todas las escrituras las hace el Worker con `sb_secret_` tras comprobar el rol. `revoke all` a `anon` y `authenticated` sobre `connection_secrets`, `approvals`, `edge_hits`, `ai_usage`, `webhook_events`.

**VanGUARD se audita a sí mismo en CI** (`supabase/tests/rls.sql`, todo debe dar `false` o 0 filas): `select tablename from pg_tables where schemaname='public' and not rowsecurity` = 0 filas; `has_function_privilege('authenticated','public.vg_crypto_material(int)','execute')` = `false`; `has_table_privilege('authenticated','vault.decrypted_secrets','select')` = `false`; funciones `security definer` sin `search_path` fijado = 0 filas [verificado el patrón: https://supabase.com/docs/guides/database/postgres/row-level-security].

**Ventana del motor en vivo** (migración del BACK; `vg_try_eval` evita evaluar si ya se evaluó hace < 5 s, y `vg_edge_window` agrega por IP en 60 s):

```sql
create or replace function public.vg_try_eval(p_org uuid) returns boolean
language sql security definer set search_path = '' as $$
  insert into public.edge_eval_state as s (org_id, last_eval_at) values (p_org, now())
  on conflict (org_id) do update set last_eval_at = now()
    where s.last_eval_at < now() - interval '5 seconds'
  returning true $$;

create or replace function public.vg_edge_window(p_org uuid, p_seconds int default 60)
returns table (ip inet, n bigint, paths_4xx bigint, probe_hits bigint, admin_ok bigint, n5xx bigint,
               p95_ms double precision, ua_top text, total bigint)
language sql stable security definer set search_path = '' as $$
  select h.ip, count(*),
         count(distinct h.path) filter (where h.status in (403,404)),
         count(*) filter (where h.path ~ '^/(\.env|\.git/config|wp-login\.php|phpmyadmin|server-status)'),
         count(*) filter (where h.status between 200 and 399 and not h.auth
                            and h.path ~ '^/(admin|api/admin|wp-admin)(/|$)'),
         count(*) filter (where h.status >= 500),
         percentile_cont(0.95) within group (order by h.latency_ms),
         mode() within group (order by h.ua),
         sum(count(*)) over ()
  from public.edge_hits h
  where h.org_id = p_org and h.ts > now() - make_interval(secs => p_seconds)
  group by h.ip order by 2 desc limit 20 $$;

revoke all on function public.vg_try_eval(uuid), public.vg_edge_window(uuid, int) from public, anon, authenticated;
grant execute on function public.vg_try_eval(uuid), public.vg_edge_window(uuid, int) to service_role;
```

---

## 7. Contrato API

**El contrato vigente y completo es el de la sección 15.4–15.5 (manda):** esta tabla es el resumen inicial; allí están además E12b, E13b, E29b, E35 (JSON Schema del export), E36 (webhook de Cloudflare, P1) y E37 (registro de auditoría, P1).

**Convenciones:**
- JSON en `snake_case` (igual que la base). Tipos y esquemas en `PascalCase` en `@vanguard/contracts`. Rutas en minúsculas con guiones. Todo lo de org va bajo `/api/orgs/:org/...`.
- **Excepción deliberada:** el modelo de vista `EstadoModulo` conserva los nombres en español de R08 (`cifras`, `ahora`, `filas`, `acciones`), porque los componentes del FRONT se construyen sobre él.
- Cada respuesta se valida con zod en el BACK antes de salir; los fixtures del FRONT usan el mismo esquema.
- El `org_id` **nunca** sale del cuerpo: cada consulta con el cliente admin lleva `.eq('org_id', ctx.orgId)` y los ids de ruta se verifican contra esa org (anti-IDOR; prueba `test:idor` con dos orgs sembradas).
- **Errores:** `{ "error": { "code": "...", "message": "texto para el usuario", "request_id": "..." } }`. Códigos fijos: `unauthorized` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `invalid_body` 422, `key_rejected` 422 (clave peligrosa pegada), `provider_rejected` 422 (con `details.missing_permissions[]`), `rate_limited` 429, `budget_exceeded` 429, `ai_disabled` 503, `provider_unavailable` 502, `internal` 500. **Nunca** se devuelven cuerpos de terceros, cabeceras, tokens ni trazas; los logs pasan por `redact()`.
- **Tipos de auth:** `user` = `Authorization: Bearer <access_token de Supabase>`, validado **lo primero** con `supabase.auth.getClaims(token)` (nunca `getSession()` en servidor, R17 §10), luego el rol en la org; `admin` = `user` con rol `owner`/`admin`; `hmac` = firma de ingesta; `kapso`/`eleven` = firmas de webhook; `vgk` = token MCP; `public`.

| Método y ruta | Auth | Request (resumen) | Response (resumen) | Prio |
|---|---|---|---|---|
| `GET /api/health` | public | — | `{ok, version, time}` | P0 |
| `GET /api/me` | user | — | `{user:{id,email,is_anonymous}, orgs:[{id,name,role,is_demo}]}` | P0 |
| `POST /api/orgs` | user | `{name}` | `201 Org` (crea membresía `owner`) | P0 |
| `POST /api/demo/join` | user (anónimo) | — | `{org_id}`, rol `viewer` en la org de demo | P0 |
| `GET /api/orgs/:org/overview` | user | — | `Overview` (ejemplo abajo) | P0 |
| `GET /api/orgs/:org/modules/:module/state` | user | `module ∈ supabase\|cloudflare\|codebase\|performance` | `EstadoModulo` | P0 |
| `GET /api/orgs/:org/connections` | user | — | `ConnectionPublic[]` = `{id, provider, kind, label, status, last4, scopes, meta, last_checked_at}` | P0 |
| `POST /api/orgs/:org/connections` | admin | `ConnectionCreate` (unión por `provider`): supabase `{project_ref, pat}`; cloudflare `{zone_id, read_token, action_token?}`; github `{repo_full_name, pat}`; ingest `{label}` | `201 {connection, checks: PermCheck[], ingest_secret?}` (secreto de ingesta una sola vez) o `422 key_rejected` / `422 provider_rejected` | P0 |
| `POST /api/orgs/:org/connections/:id/test` | admin | — | `{ok, checks:[{permission, ok, error_code?}], checked_at}` | P0 |
| `DELETE /api/orgs/:org/connections/:id` | admin | — | `204` (borra en cascada fila y secreto; cabecera `X-VG-Revoke-Url`) | P0 |
| `POST /api/orgs/:org/scans` | admin | `ScanCreate` (unión por `kind`) | `202 {scan_run_id}`; `429 budget_exceeded` tras 3 auditorías/día | P0 |
| `GET /api/orgs/:org/scans/:id` | user | — | `ScanRun {id, kind, status, progress, step, score, coverage, summary, error}` | P0 |
| `GET /api/orgs/:org/findings?module=&severity=&status=` | user | — | `Finding[]` | P0 |
| `PATCH /api/orgs/:org/findings/:id` | admin | `{status, reason?}` | `Finding` (audita) | P0 |
| `POST /api/orgs/:org/findings/:id/fix-prompt` | admin | `{flavor?}` | `{prompt, model, cached, injection_flags[]}`. Al viewer se le devuelve solo lo que ya esté en caché | P0 |
| `POST /api/orgs/:org/findings/:id/verify` | admin | — | `202 {scan_run_id}` (re-corre solo esa regla) | P1 |
| `GET /api/orgs/:org/incidents?status=` · `GET .../incidents/:id` | user | — | `Incident[]` · `Incident & {notifications[], actions[], timeline[]}` | P0 |
| `GET /api/orgs/:org/traffic?seconds=300` | user | — | `{buckets:[{t,n,n4xx,n5xx}], top_ips:[{ip,n,ua_top}]}` (cubetas de 10 s) | P0 |
| `POST /api/orgs/:org/incidents/:id/ack` · `/mute` | admin | `{minutes?}` | `Incident` | P0 |
| `POST /api/orgs/:org/actions/propose` | admin | `{incident_id, kind:'block_ip', target}` | **simulación** `{approval_id, efecto, avisos[], expires_at}`; envía el código por WhatsApp | P0 |
| `POST /api/orgs/:org/actions/:approvalId/confirm` | admin | `{code}` o canje por botón vía webhook | `RespuestaEscritura {ok, resultado, en}` (403 fuera del host de producción) | P0 |
| `POST /api/orgs/:org/actions/:actionId/undo` | admin | — | `RespuestaEscritura` | P0 |
| `PUT /api/orgs/:org/uploads/zip/:scan_run_id` | admin | binario con `Content-Length` ≤ 25 MB | `201 {key}`; 411 sin longitud; 413 si excede | P1 |
| `GET /api/orgs/:org/perf/runs?url=` | user | — | `PerfRun[]` | P1 |
| `GET /api/orgs/:org/export?format=md\|json` | user | — | archivo redactado | P0 |
| `GET` y `PUT /api/orgs/:org/contacts` | admin | `[{name, phone_e164, whatsapp, voice, priority}]` | `Contact[]` | P0 |
| `POST /api/orgs/:org/notifications/test` | admin | `{channel:'whatsapp'\|'voice'}` | `{ok, provider_id}`; 403 fuera del host de producción | P0 |
| `GET /api/orgs/:org/ai/usage` | user | — | `{today_usd, cap_usd, enabled, level}` | P1 |
| `POST /api/orgs/:org/mcp-tokens` · `DELETE .../:id` | admin | `{name}` | `{id, token}` (una vez) · `204` | P1 |
| `POST /ingest/v1/events` | hmac | `IngestBatch` (abajo) | `202 {accepted}` | P0 |
| `POST /webhooks/kapso` | kapso | evento `whatsapp.message.*` | `200` inmediato; proceso en `ctx.waitUntil` | P0 |
| `POST /webhooks/elevenlabs` | eleven | `post_call_transcription` / `call_initiation_failure` | `200` | P1 |
| `POST /api/voz/respuesta` | Bearer `secret__token_llamada` | `{incidente_id, respuesta:'ack'\|'snooze'\|'pide_aprobar', conversation_id}` | `200` | P1 |
| `GET` y `POST /mcp` | vgk | MCP Streamable HTTP sin estado | herramientas `get_overview`, `list_findings`, `get_finding`, `list_incidents` (P1: 4 más) | P1 |

**Ingesta** (contrato con la víctima o con la app de cualquier cliente):

```ts
// packages/contracts/src/ingest.ts
export const EdgeEvent = z.object({
  ts: z.iso.datetime(), ip: z.string().max(45), method: z.string().max(10), path: z.string().max(300), // sin query
  status: z.number().int().min(100).max(599), ua: z.string().max(200), latency_ms: z.number().int().min(0), auth: z.boolean(),
});
export const IngestBatch = z.object({ events: z.array(EdgeEvent).min(1).max(100) });
// Cabeceras: x-vg-conn: <connection_id>, x-vg-ts: <unix s>, x-vg-sig: hex(HMAC-SHA256(secreto, `${ts}.${cuerpo_crudo}`))
// Se rechaza si |ahora - ts| > 300 s o si la firma no coincide (comparación en tiempo constante). Org = la de la conexión.
```

La víctima toma la IP de `cf-connecting-ip` (orden de R03 §6). Que `z.iso.datetime()` exista con ese nombre en zod 4.6 está [no verificado]: si no, `z.string()`.

**`Overview` (ejemplo):**

```json
{ "score": 38, "band": "red", "coverage": { "seen": 3, "total": 4, "missing": ["performance"] },
  "counts": { "critical": 2, "high": 3, "medium": 4, "low": 1, "info": 0 }, "open_incidents": 1,
  "last_scan": { "id": "…", "status": "succeeded", "finished_at": "2026-10-25T18:04:11Z" },
  "ahora": [ { "kind": "finding", "id": "…", "module": "supabase", "rule_id": "SB_RLS_DISABLED", "severity": "critical",
               "title": "RLS desactivada en public.pedidos y legible por anon", "resource": "public.pedidos" } ] }
```

**`EstadoModulo` (R08 §6, recortado para P0):** `{ok, error?, hora, contador:{rojo, aviso, cola}, cifras: CifraDato[], ahora: GrupoDato[], checks: CheckDato[]}`. En P0 se usan cuatro clases de `AccionDato.clase`: `prompt` (abre IA-1), `copiar`, `navegar` y `confirmar` (Bloquear IP). Con esto, Supabase, Cloudflare y Codebase usan **una sola página genérica** `<PantallaModulo/>`; el BACK decide filas, roles (`mal`, `aviso`, `cola`, `bien`, `neutra`) y verbos con cifra.

**Tiempo real:** en **P0**, TanStack Query consulta `overview`, `incidents` y `traffic` cada 3 s con la pestaña visible, y `scans/:id` cada 2 s mientras corre una auditoría. En **P1** se agrega Realtime: canal privado `org:<org_id>`, triggers `realtime.broadcast_changes` sobre `scan_runs`, `findings`, `incidents`, `notifications`, y política sobre `realtime.messages` (SQL en R16 §5.4) [verificado: https://supabase.com/docs/guides/realtime/subscribing-to-database-changes]. El FRONT solo invalida la clave de consulta correspondiente, así que no cambia ningún componente. «Allow public access» de Realtime **desactivado**.

---

## 8. Motor IA (Claude API)

**Principio inamovible:** el modelo **explica, resume y redacta**; **nunca** decide si se alerta, con qué severidad ni por qué canal. Lo decide el motor de reglas (§9). Si la IA está apagada o falla, las alertas salen igual con plantillas.

IDs, precios y comportamiento [verificado: skill `claude-api` (modelos cacheados 2026-10-06) y https://platform.claude.com/docs/en/about-claude/pricing, vía R12]: **tres modelos, no cuatro** (Fable 5.1 fuera). Precios por millón de tokens (MTok): Haiku 5.5 `claude-haiku-5-5` 0,10 / 0,50 (lectura caché 0,01; sube de tarifa a 0,50 / 2,50 si el prompt pasa de 100K tokens); Sonnet 5.5 `claude-sonnet-5-5` 2,00 / 10,00 (lectura caché **0,10** — R12 resuelve la discrepancia a favor del 0,10 de la página oficial); Opus 5.5 `claude-opus-5-5` 4,00 / 20,00 (lectura caché 0,20). Batch −50 %. Mínimo cacheable **512 tokens** en los tres [verificado: skill `shared/prompt-caching.md`]. `effort` por defecto: **Opus 5.5 = `medium`, Haiku 5.5 = `medium`, Sonnet 5.5 = `high`** — fijarlo explícito. `temperature`/`top_p`/`top_k` dan 400 en todos los modelos desde el 2026-10-21; `tool_choice` forzado (`any`/`tool`) da 400 en Opus/Sonnet 5.5. IDs **sin** sufijo de fecha.

| Ruta | Para qué | Modelo | Ajustes | Salida | Costo/op | Prio |
|---|---|---|---|---|---|---|
| **IA-1 `fix_prompt`** | Prompt de corrección por hallazgo, bajo demanda, guardado en `findings.fix_prompt` | `claude-sonnet-5-5` | `output_config.effort:"medium"`, `max_tokens` 6000, system congelado con caché | JSON `{contexto, pasos[], prompt_para_tu_ia, prueba_de_aceptacion}` | ~0,033 USD | P0 |
| **IA-2 `audit_summary`** | Síntesis de la auditoría: resumen llano, top 5, relaciones entre módulos | `claude-opus-5-5` | `effort:"medium"`, `max_tokens` 16000 (streaming), fallback de servidor (ver abajo) | JSON `{resumen, top:[{finding_id, por_que}], relaciones:[{finding_ids[], explicacion}]}` | ~0,25 USD (S11: 0,248 en caché caliente; medir con `count_tokens`) | P0 |
| **IA-3 `alert_text`** | Reescribir WhatsApp/voz desde hechos en JSON (≤ 300 car.) | `claude-sonnet-5-5` | `effort:"low"`, `thinking:{type:"between_tools"}`, `max_tokens` 800, **3 s máx** y si no, plantilla | JSON `{whatsapp, voz}` | ~0,006 USD | P1 |
| Fuera del MVP | Triaje con Haiku, chat, MCP connector, Batch nocturno | — | — | — | — | P2 |

Los costos son estimaciones de R12 §12: **medirlos con `count_tokens` el sábado.**

**Salida estructurada (decidido en la fusión final):** las tres rutas piden `output_config: { effort, format: { type: "json_schema", schema } }` con el **JSON Schema escrito a mano** de S11 y validan con zod después. El helper `zodOutputFormat` sí existe en el SDK 0.137.0 [verificado por S03 03.1 en `helpers/zod.d.ts`], pero IA-2 va por `client.beta.messages.stream` con `fallbacks` y su uso ahí no está verificado: un solo camino para las tres rutas (S11 11.5, S15 15.10). Todas las llamadas pasan por un único módulo `apps/api/src/ia/claude.ts`:

```ts
export async function llamarIA<T>(env: Env, p: { org_id: string; ruta: 'fix_prompt' | 'audit_summary' | 'alert_text';
  sistema: string; datos: unknown; esquema: z.ZodType<T>; timeoutMs?: number }):
  Promise<{ ok: true; data: T } | { ok: false; code: 'disabled' | 'budget' | 'refusal' | 'timeout' | 'invalid' }>
```

**Fallback de servidor (IA-2 y, por decisión de la fusión final, también IA-1; nunca IA-3, que tiene 3 s):** forma recomendada `fallbacks: "default"` con beta `server-side-fallback-2026-07-01` (rutea por categoría de rechazo); la forma de lista `fallbacks: [{model:"claude-opus-4-8"}]` usa la beta `server-side-fallback-2026-06-01`; **mezclar forma y beta da 400** [verificado: skill `claude-api`]. No funciona en Batches. Sonnet 5.5 solo admite la forma `"default"` y solo en el Claude API; **Haiku 5.5 no tiene fallback de servidor** (el cliente escala a Sonnet). Se adopta `"default"` + beta `-2026-07-01`. En IA-1 (Sonnet 5.5) cae a Sonnet 5 al mismo precio por token; el peor caso reservado pasa de ≈ 0,07 a ≈ 0,15 USD.

**Presupuesto de los 250 USD:**

| Bolsa | USD | Dónde se impone |
|---|---|---|
| Desarrollo y ensayos | 100 | Workspace `team22-dev` (límite 100 USD en la Console). Su API key solo en `.dev.vars` |
| Demo y jurado | 60 | Workspace `team22-prod` (límite 150 USD). Su key es el secreto `ANTHROPIC_API_KEY` del Worker |
| Reserva bloqueada | 90 | Dentro de `team22-prod`. La app la protege con un tope de 40 USD/día; solo Giovanni lo sube |

El workspace por defecto no admite límite de gasto y la caché no se comparte entre workspaces [verificado: R12 §13.2]. Calentar la caché de producción antes del pitch.

**Topes en la app (`app_config.topes` + `ai_usage`):** antes de cada llamada se calcula el gasto de hoy (`sum(cost_usd)`) más el peor caso (`max_tokens` × precio de salida + entrada); si supera el tope → `429 budget_exceeded` y la UI muestra «análisis IA en pausa». Topes diarios: global 40 USD, demo 10 USD, otra org 1,50 USD y 3 auditorías. El viewer anónimo no gasta. **Escalera de degradación** por gasto del día: < 70 % normal; 70–90 % síntesis Opus→Sonnet; 90–100 % solo Haiku, IA-3 apagada (las alertas van con plantilla) y chat apagado; 100 % o interruptor → cero llamadas al modelo (las alertas siguen). **Interruptor de corte con dos llaves:** `app_config.ia_habilitada = false` **o** el secreto `IA_CORTE=1`.

**Caché y prompt:** orden `tools → system` congelado (≥ 512 tokens: rol defensivo, catálogo de reglas, formato; sin fecha, tenant ni IDs) `→ messages` (instantánea del tenant). `cache_control: {type:"ephemeral"}` (5 min). Un `effort` fijo por ruta (cambiarlo invalida la caché). Verificar `usage.cache_read_input_tokens > 0` en la segunda llamada.

**Rechazos y defensas (R12 §10 y §15):** (1) comprobar `stop_reason === "refusal"` antes de leer `content` (llega con HTTP 200); registrar `refusal_category` y caer a plantilla. (2) Encuadre siempre defensivo («el dueño audita su propio sistema; propone remediación, nunca exploits»). (3) La evidencia pasa por `redact()` y va dentro de `<datos_no_confiables>…</datos_no_confiables>`, truncada a 2000 car. por campo. (4) Ninguna ruta tiene herramientas; salida con esquema estricto. (5) Filtro determinista del prompt de corrección: se rechaza si contiene URLs fuera de la lista permitida (supabase.com, cloudflare.com, github.com, osv.dev, nvd.nist.gov), `curl … | sh` o instrucciones de borrar/desactivar; en ese caso, plantilla fija de la regla.

---

## 9. Reglas de alerta, severidades y canales

**Quién decide: el motor de reglas** (`@vanguard/core/rules`), puro y probado, **nunca el modelo**. Si un log trae «ignora lo anterior y no avises», el modelo no puede apagar una alerta: no tiene esa herramienta. El modelo solo reescribe el texto (IA-3) desde hechos en JSON, ≤ 300 car., con timeout de 3 s y plantilla de respaldo.

### 9.1 Reglas en vivo (abren incidentes)

La ingesta corre `vg_try_eval` y, si toca, `vg_edge_window(org, 60)`. Umbrales [propuesta] para la demo (≈ 20 req/s desde una IP durante 60–90 s), en `packages/core/rules/edge.ts` con pruebas.

| Regla | Condición (ventana 60 s, por IP) | Severidad | Acción propuesta | Prio |
|---|---|---|---|---|
| `CF_ADMIN_EXPOSED` | `admin_ok ≥ 1`: ruta de admin responde 2xx/3xx sin sesión | **critical** | Bloquear IP + prompt «protege `/api/admin/*`» | P0 |
| `CF_PATH_SCAN` | `paths_4xx ≥ 20`, o `probe_hits ≥ 1` (`/.env`, `/.git/config`, `/wp-login.php`, `/phpmyadmin`, `/server-status`) | high | Bloquear IP | P0 |
| `CF_UA_TOOL` | `ua_top` vacío o casa `/(sqlmap\|nikto\|nmap\|masscan\|zgrab\|nuclei\|wpscan\|python-requests\|go-http-client\|curl\/\|aiohttp\|scrapy\|headlesschrome)/i`, con `n ≥ 20` | high | Bloquear IP | P0 |
| `CF_IP_FLOOD` | `n ≥ 100` y `n/total ≥ 0,20`. Sube a **critical** si `n5xx/n ≥ 0,05` o `p95_ms ≥ 2000` | high/critical | Bloquear IP (P1: Under Attack) | P0 |
| `SB_DB_DOWN` | `GET /health`: `db`/`rest` ≠ `ACTIVE_HEALTHY` en 2 min seguidos | critical | Avisar y revisar el proyecto | P0 |
| `SB_CPU_HIGH` | CPU ≥ 90 % en 3 muestras (critical si ≥ 97 %); CPU = 1 − Δidle/Δtotal | high/critical | Prompt con consultas lentas | P1 |
| `SB_DISK_HIGH` / `SB_CONN_HIGH` | disco ≥ 80 % high, ≥ 90 % critical / conexiones ≥ 80 % de `max_connections` | high/critical | Prompt de corrección | P1 |
| `SB_EXPOSURE_REGRESSION` | una tabla que antes no era legible por `anon` ahora sí | critical | Prompt + «Verificar arreglo» | P1 |

**Agrupación:** las cuatro `CF_*` comparten un incidente por IP: `dedupe_key = sha256(org_id|edge|ip)`, se acumulan en `rule_ids`, severidad máxima, `event_count` suma. **Solo se vuelve a notificar si la severidad sube** (high→critical dispara la llamada). Un incidente resuelto que reaparece antes de 10 min se reabre sin llamada.

### 9.2 Reglas de auditoría (crean hallazgos, no llaman)

| Regla | Fuente y condición | Severidad | `confirmed` |
|---|---|---|---|
| `SB_ADVISOR_<name>` | `GET /v1/projects/{ref}/advisors/security` y `/performance` → `lints[]` [verificado: https://supabase.com/docs/reference/api/v1-get-security-advisors]. `ERROR`→high, `WARN`→medium, `INFO`→low; `rls_disabled_in_public`→critical. Dedupe por `cache_key` | según lint | no |
| `SB_RLS_DISABLED` | SQL 1 (abajo): `rls_activa=false` y `anon_select=true` | critical | sí |
| `SB_POLICY_ALLOW_ALL` | SQL 2: política con `qual='true'` o `with_check='true'` para `anon`/`public` | high | sí |
| `SB_RPC_ANON_NO_LIMIT` | SQL 3b (SQL 3 + argumentos + sin funciones de extensiones, aprobado; texto en S07 07.5.4): función de `public` ejecutable por `anon`, `VOLATILE`, y `authenticator` sin `pgrst.db_pre_request` | high; critical si el nombre casa `/(otp\|login\|pass\|reset\|email\|sms\|pago\|pay\|delete\|borrar)/i` | no |
| `CB_ENV_COMMITTED` | archivo que casa `(^\|/)\.env(\.[\w-]+)?$` y no `\.env\.(example\|sample\|template)$` | critical | sí |
| `CB_GITIGNORE_NO_ENV` | no hay `.gitignore` en la raíz, o ninguna línea casa `^/?\.env` | medium | sí |
| `CB_SECRET_<id>` | regex de R11 §4.2 (bandera `i` **solo** donde gitleaks trae `(?i)`: clave privada y genérica; S09): JWT `role=service_role`, `sb_secret_`, AWS, Stripe live, Anthropic, OpenAI, `github_pat_`/`ghp_`, clave privada, cadena Postgres. Se guarda solo vista parcial + huella HMAC | critical (genérica por entropía ≥ 3,5 es medium, P1) | sí |
| `CB_DEP_VULN` | OSV `POST https://api.osv.dev/v1/querybatch` en lotes ≤ 1000 + `GET /v1/vulns/{id}` con caché; dedupe por alias [verificado: R11 §2.4]. `CRITICAL`→critical, `HIGH`→high, `MODERATE`→medium, `LOW`→low; `MAL-*`→critical | según aviso | sí |
| `CF_*` config y `PF_REGRESSION` | R10 §6 (CF-DNS/TLS/WAF) y R13 §5.3 (`compareRuns`) | ver fuente | — |

SQL de solo lectura por `POST /v1/projects/{ref}/database/query/read-only` con cuerpo `{"query":"..."}` (beta, corre como `supabase_read_only_user`, exige nombres con esquema) [verificado: https://supabase.com/docs/reference/api/v1-read-only-query]:

```sql
-- SQL 1 · SB_RLS_DISABLED
select n.nspname as esquema, c.relname as tabla, c.relrowsecurity as rls_activa,
       pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') as anon_select, coalesce(s.n_live_tup,0) as filas_estimadas
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_stat_user_tables s on s.relid = c.oid
where c.relkind in ('r','p') and n.nspname = 'public';
-- SQL 2 · SB_POLICY_ALLOW_ALL
select schemaname, tablename, policyname, cmd, roles from pg_catalog.pg_policies
where schemaname = 'public' and (qual = 'true' or with_check = 'true') and ('anon' = any(roles) or 'public' = any(roles));
-- SQL 3 · SB_RPC_ANON_NO_LIMIT
select n.nspname as esquema, p.proname as funcion, p.prosecdef as definer,
       exists (select 1 from pg_catalog.pg_roles r, unnest(r.rolconfig) cfg
               where r.rolname = 'authenticator' and cfg like 'pgrst.db_pre_request=%') as hay_pre_request
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f' and p.provolatile = 'v'
  and pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE');
```

Que `supabase_read_only_user` pueda evaluar `has_table_privilege('anon', …)` y leer `pg_roles.rolconfig` está [no verificado]: es la prueba de humo n.º 1 del BACK (08:00). Si falla, la regla sale como «sin mirar» y la auditoría se apoya en los advisors.

**Puntaje (`packages/core/score.ts`):** pesos critical 25, high 10, medium 4, low 1, × 1,5 si `confirmed`. Cada módulo resta como máximo 40. Con un critical confirmado, el tope es 49. Bandas: 0–49 rojo, 50–79 ámbar, 80–100 verde. **Siempre con la cobertura al lado** (fuentes con lectura correcta sobre 4).

### 9.3 Canales por severidad y topes

| Severidad | Canales en t0 (P0) | P1 |
|---|---|---|
| critical | in-app + WhatsApp a todos los contactos con `whatsapp` + **llamada** al contacto de mayor prioridad con `voice` | Llamada solo si no hay ack en 45 s (Queue `vg-monitor` con `delaySeconds:45`); si nadie contesta, segundo contacto |
| high | in-app + WhatsApp | Llamada de 07:00 a 22:00 si no hay ack en 15 min |
| medium, low, info | in-app | Resumen por correo (P2) |

- **Costo real de un aviso:** el WhatsApp de servicio del sandbox de Kapso **no es gratis** desde el 1-oct-2026: cuesta céntimos y exige saldo positivo (R14 §1.1). Una llamada crítica de 90 s a un móvil +58 ≈ **0,47 USD** (ElevenLabs ≈ 0,12 + Twilio 2 × 0,1739, porque Twilio redondea al minuto) más el LLM del agente.
- **Topes por org:** 2 llamadas/h y 10 WhatsApp/h. La org de demo tiene 6 y 30 para ensayos. Al superarlos, `notifications.status = skipped_cap` y banner. **Tormenta:** > 5 incidentes de una org en 2 min → un solo WhatsApp de resumen. **«Leído» ≠ «confirmado»:** el ack llega por el botón «Lo estoy viendo» (webhook de Kapso), por la app o (P1) por la voz. «Silenciar 1 h» pone `muted_until`.
- **WhatsApp (sandbox, interactivo):** `POST https://api.kapso.ai/meta/whatsapp/v24.0/{KAPSO_PHONE_NUMBER_ID}/messages` con `X-API-Key` y `type:"interactive"` de tipo `button` (máx. 3 botones, `body` ≤ 1024 car., `title` ≤ 20 car.) [verificado: https://docs.kapso.ai/docs/whatsapp/send-messages/buttons.md]. Botones `ack:{code}:{nonce}` «Lo estoy viendo» y `snz:{code}:{nonce}` «Silenciar 1 h»; de cada nonce solo se guarda su SHA-256.
- **Voz:** `POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call` con `agent_id`, `agent_phone_number_id`, `to_number` y `conversation_initiation_client_data.dynamic_variables` = `{empresa, incidente_id, severidad, servicio, resumen, accion_propuesta}` [verificado: https://elevenlabs.io/docs/eleven-agents/api-reference/integrations/twilio/outbound-call.md]. `max_duration_seconds` 90 por override. Resumen con números en palabras, **sin IPs completas, claves ni correos**. **La voz nunca aprueba acciones** (solo `ack`/`snooze`/`pide_aprobar` por la herramienta `registrar_respuesta`). El agente se crea a mano con el prompt de R14 §2.3, cambiando «Centinela» por «Vánguard» (grafía fonética en el texto fijo, para que el TTS no deletree «GUARD»; S12 §12.7).
- **Webhooks:** Kapso firma con `X-Webhook-Signature` (HMAC-SHA256 hex del cuerpo crudo) y deduplica con `X-Idempotency-Key` [verificado: https://docs.kapso.ai/docs/platform/webhooks/security.md]. ElevenLabs `ElevenLabs-Signature: t=…,v0=…` (P1). Se verifica con `crypto.subtle.timingSafeEqual` **antes** de parsear el JSON; siempre 200 inmediato y proceso en `ctx.waitUntil`.

---

## 10. Credenciales: cifrado, almacenamiento y conexión por integración

### 10.1 Corrección del «hash con pimienta» → cifrado de sobre reversible y autenticado

Un hash, con o sin pimienta, es irreversible: sirve para comprobar que alguien conoce un valor, no para recuperarlo. VanGUARD necesita el token **en claro** cada 60 s para llamar a Cloudflare o Supabase, así que hace falta **cifrado reversible y autenticado (AES-256-GCM)**. Se conserva lo bueno de la propuesta del dueño: la clave maestra y la pimienta viven en Supabase Vault, y el **HMAC con pimienta se queda como huella** (deduplicar, verificar sin descifrar, detectar la propia key del cliente filtrada en su repo). Coinciden R01, R09, R11, R15, R16, R17.

**Decisión: opción de sobre con KEK partida en dos sistemas** (R16/R17 §11.2), no un secreto de Vault por credencial (R09 §5.1). Motivos: (1) con un secreto por credencial el token viaja como literal SQL en `vault.create_secret('<token>')` y podría quedar en `postgres_logs`; con el sobre la base solo recibe texto cifrado. (2) Quien robe `sb_secret_` con la opción de Vault lo ve todo; con el sobre además necesita la pimienta, que vive en Cloudflare.

**Diseño (WebCrypto, mismo código en Worker y Node 24; `packages/core/src/crypto.ts` = R17 §11.2):**
- **DEK aleatoria de 32 bytes por credencial.** El token se cifra con AES-256-GCM (IV de 12 bytes) y la DEK se envuelve con la KEK. Se guarda `Box {v, kid, iv, ct, ivk, wdek}` en `connection_secrets.sealed`.
- **KEK = HKDF-SHA256(ikm = secreto `kek_v1` de Vault, salt = `VG_KEK_PEPPER` del Worker, info = "vanguard/kek/v1")**. Para descifrar hay que robar **dos** sistemas: la base y el Worker [verificado: https://supabase.com/docs/guides/database/vault]. La KEK derivada se cachea en memoria del isolate ≤ 10 min.
- **AAD = `vanguard|v1|${org_id}|${connection_id}|${provider}|${kind}`.** Copiar el cifrado a otra fila u otra org hace fallar el descifrado.
- **Huella = HMAC-SHA256(FPK, `org_id|token.trim()`)** en hex (con alcance de org, decisión 1 de S05 05.14: así la huella es distinta entre orgs), con `FPK = HKDF(ikm = `fp_pepper_v1` de Vault, salt = `VG_FP_PEPPER`, info = "vanguard/fp/v1")`. Único por org.
- Los secretos de Vault se crean una vez (`select vault.create_secret(encode(extensions.gen_random_bytes(32),'base64'),'kek_v1',…)`). El Worker los lee con `public.vg_crypto_material(1)`: `security definer`, `search_path=''`, `revoke all from public, anon, authenticated`, `grant execute to service_role`.
- **Nunca** existe un endpoint que devuelva el secreto: la UI ve `last4` y `scopes`. El logger pasa todo por `redact()`. **Pruebas obligatorias (Vitest):** cambiar 1 byte de `ct` o `wdek` lanza; otro AAD lanza; un `Box` de la org A en una fila de la org B lanza; la huella es estable y distinta entre orgs. **Prueba de fuga (hito de las 13:00, al cerrar Conexiones; antes no existe el cifrado):** guardar el token falso `vg_test_LEAK_7Q2X`, buscarlo en Workers Logs, `postgres_logs` y todas las rutas → 0 apariciones.
- Plan B solo si a las 13:00 el sobre no funciona: un secreto de Vault por credencial (esfuerzo S). Se pierde que la base nunca vea el token en claro.

### 10.2 Qué pide cada integración (todo en solo lectura salvo lo marcado)

| Integración | Qué pega el usuario | Permisos mínimos | Validación al conectar | Nunca pedir |
|---|---|---|---|---|
| **Supabase** | `project_ref` (o URL) + **PAT con alcance** `sbp_fc…` de un proyecto (GA desde 6-oct-2026) [verificado: https://supabase.com/changelog/scoped-personal-access-tokens-ga; el prefijo `sbp_fc`, en https://supabase.com/docs/guides/platform/personal-access-tokens] | Lectura de proyecto, base de datos y advisors; **analytics opcional** para métricas y logs (P1; nombre exacto [no verificado], probar 08:00) | `GET /v1/projects/{ref}`, `/health`, `/advisors/security` y un `select 1` por `/database/query/read-only`; cada 403 → permiso que falta | `service_role`, `sb_secret_`, PAT legacy (que no empiece por `sbp_fc`), `secrets:read` (root key de Vault), `rest:read` (trae `jwt_secret`), cualquier escritura |
| **Cloudflare, lectura** | API Token personalizado de la zona + `zone_id` | Zone Read, Zone Settings Read, DNS Read, Analytics Read, Firewall Services Read, Zone WAF Read [verificado: https://developers.cloudflare.com/fundamentals/api/reference/permissions/] | `GET /client/v4/user/tokens/verify` (`status:active`) [verificado: https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/], `GET /zones/{z}` y sondeo de R10 §1.3 | Global API Key |
| **Cloudflare, acciones (opcional, «Modo blindaje»)** | Segundo token, aparte | Firewall Services Write (P1: Zone Settings Write para Under Attack). Nombre exacto [no verificado]: se descubre con el sondeo | Un `GET` de access rules; la escritura real solo al confirmar | Dárselo al MCP o al modelo |
| **GitHub** | `owner/repo` + PAT fine-grained (`github_pat_…`) de **un** repo | Contents: Read-only, Metadata: Read-only (Dependabot alerts opcional) [verificado: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens] | `GET /repos/{o}/{r}`; un `ghp_` clásico se rechaza explicando por qué | PAT clásico, OAuth `repo` (no hay scope de solo lectura para repos privados) |
| **Ingesta (app propia)** | Nada: VanGUARD genera el secreto | — | Se muestra una vez para ponerlo como `VG_INGEST_SECRET` en la app | — |
| **PSI (P1)** | Nada: nuestra clave `PSI_API_KEY` | — | Solo mide URLs de dominios verificados de la org | — |

### 10.3 Guardas de entrada (`packages/core/src/key-guards.ts`)

VanGUARD **rechaza antes de guardar** (nunca registra la clave rechazada): `sb_secret_` o JWT con `role=service_role`; PAT de Supabase que no empiece por `sbp_fc` [verificado: https://supabase.com/docs/guides/platform/personal-access-tokens]; PAT clásico de GitHub `gh[pousr]_`; Global API Key de Cloudflare (`cfk_…` o, la antigua, 37–45 hex en minúscula [verificado: https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/]). Tras la guarda, el sondeo: si `GET /v1/projects` de Supabase devuelve más de un proyecto, se rechaza («token no limitado a un proyecto») [no verificado]. Cada rechazo → `422 key_rejected` con motivo en español.

### 10.4 Papel del MCP

El bucle de monitoreo y las auditorías **nunca** usan MCP: van por REST y GraphQL directos, deterministas y sin tokens de modelo. El MCP aparece en dos sitios: (1) nuestro servidor `/mcp` (P1) de solo lectura, con tokens `vgk_` por org (solo se guarda el SHA-256), para «audita con tu IA»; (2) la pantalla «Llevar a tu IA» muestra cómo conectar los MCP oficiales en lectura: `https://mcp.supabase.com/mcp?project_ref=…&read_only=true&features=database,debugging,docs` [verificado: R09 §3] y el MCP de GitHub `readonly`. Del MCP de Cloudflare (`https://mcp.cloudflare.com/mcp`) se advierte que no tiene modo de solo lectura, así que solo se usa con el token de lectura y **nunca** con el de acciones.

### 10.5 Acciones de escritura (confirmación de dos pasos)

«Bloquear IP» (P0) y Under Attack/rate limit (P1) solo con conexión `kind='action'`: (1) **proponer** devuelve una **simulación** (máscara /32, aviso si el rango es amplio, error si la IP es privada, de documentación `192.0.2/24`/`198.51.100/24`/`203.0.113/24`, está en la lista de permitidas, o es la del propio operador); (2) **código de un solo uso** (`nonce` de 16 bytes por botón de WhatsApp o 6 dígitos en la app; solo se guarda `sha256(nonce)`, caduca a 10 min; canje atómico y `from` del webhook = `recipient` verificado); (3) **ejecutar** con idempotencia `approval_id`, guardando `previous` y `provider_ref`; (4) **deshacer siempre disponible** (bloqueo de IP 1 h por defecto). La voz nunca aprueba.

---

## 11. Guion de demo de 3 minutos (solo sobre lo nuestro)

**Regla:** todo pasa sobre activos del equipo: la app víctima `demo.officialvanguard.com`, su proyecto Supabase `vanguard-demo` y el repo privado `vanguard-demo-victima`. **Nunca** un tercero (ni Cuadra ni SAGA). El tráfico del simulacro es moderado (≤ 20 req/s, ≤ 2 min, solo contra `demo.officialvanguard.com`) y sale del **hotspot de un teléfono** (Andrés ataca desde su laptop por el hotspot del teléfono de Daniel), no del wifi del evento (para no bloquear la IP del wifi, R17 §9.2); la laptop del proyector va por el wifi del evento y el teléfono de alertas lo tiene Gabriel (S01 §01.8). No hay política oficial de Cloudflare sobre pruebas de carga contra zonas propias [no verificado].

**Preparación (Carlos y Gabriel, sábado antes de las 16:00; todo en `demo/`):**
- **Supabase víctima sembrado:** tabla `public.pedidos` con RLS apagada y legible por `anon` (→ `SB_RLS_DISABLED`), política «pase-todo» en `public.perfiles` (→ `SB_POLICY_ALLOW_ALL`), función pública sin freno (→ `SB_RPC_ANON_NO_LIMIT`), más los advisors. Fallas **etiquetadas «simulada»**.
- **Repo víctima:** `.env` subido con valores **falsos**, `.gitignore` que no lo ignora, clave con forma `service_role` (falsa) en el código, y un lockfile con una dependencia que tenga aviso en OSV (confirmado antes con `POST https://api.osv.dev/v1/query`; mejor si está en KEV).
- **Zona de Cloudflare:** ruta `/admin` de la víctima que responde sin sesión (para `CF_ADMIN_EXPOSED`) y Configuration Rule `bic: false` solo para `demo.`. **No** se apaga `always_use_https`: es un ajuste de zona y pondría en rojo nuestra propia zona; el rojo sale de Supabase, de Codebase y de las reglas en vivo.
- **Simulacro reproducible:** `node scripts/ataque.mjs https://demo.officialvanguard.com --rps 20 --segundos 90 --ua "sqlmap/1.8" --admin-desde 25` (fetch de Node, sin binarios; `/admin` empieza a los 25 s para que el WhatsApp llegue antes que la llamada; plan B de UA si el borde corta: `nikto/2.5.0`), ensayado 10 veces igual. Dispara en orden `CF_PATH_SCAN`/`CF_UA_TOOL` (high, WhatsApp), `CF_ADMIN_EXPOSED` (critical, llamada) y `CF_IP_FLOOD`. Al terminar se borra la regla de bloqueo.
- **Antes del pitch:** auditoría corrida una vez para calentar la caché de IA; el teléfono vuelve a escribir al sandbox de Kapso 30 min antes; SQL de S02 02.5.1 (abre la ventana de alertas de la org de demo y resuelve los incidentes de ensayos con `resolved_at` atrasado 11 min); «Deshacer» de cualquier bloqueo de ensayo; pantalla del teléfono duplicada en el proyector.

| Tiempo | Qué se ve | Respaldo si falla |
|---|---|---|
| 0:00–0:20 | Problema en una frase. Conexiones: Supabase, Cloudflare y GitHub conectados, con «solo lectura» y `••••last4`. Se pega una `sb_secret_` falsa → **rechazo con explicación** | Captura |
| 0:20–1:00 | Botón **«Auditar todo»**: progreso por pasos, puntaje a rojo (p. ej. 38) con «vemos {N} de 4 fuentes» (se lee de la pantalla: con la medición de Rendimiento sembrada serán 4 de 4). En «Ahora»: RLS desactivada (critical), `.env` con `service_role` (critical), dependencia con CVE (high: `lodash@4.17.15`), función sin freno (critical: `enviar_otp` casa la regex de §9.2). «Generar prompt de corrección» + «Copiar para mi IA» | Auditoría previa guardada; prompt en caché |
| 1:00–2:10 | Un integrante lanza el simulacro. Cronómetro e incidente en vivo; se mueve la gráfica de tráfico. Llega el **WhatsApp** (< 30 s), luego **suena el teléfono** y la voz de ElevenLabs explica en dos frases. **«Bloquear esta IP»** → simulación → confirmar: el simulacro recibe 403 y el incidente pasa a «mitigado» | Plan B de voz (Twilio `<Say>` o navegador), banner in-app, video |
| 2:10–2:40 | Línea de tiempo con los tiempos medidos (ataque → WhatsApp → llamada → bloqueo). «Exportar para tu IA» en Markdown | — |
| 2:40–3:00 | Seguro por diseño: la regla decide y no el modelo, tokens de solo lectura, cifrado de sobre con Vault + pimienta en Cloudflare, topes de IA, nuestra propia zona auditada en verde. Hoja de ruta: Vercel, correlación entre capas, regresión de exposición | — |

**Respaldo:** video grabado el sábado a las 22:30/23:00 con la llamada real; capturas de cada paso; teléfono con datos móviles.

---

## 12. Riesgos top 10 con mitigación

| # | Riesgo | Prob. | Mitigación |
|---|---|---|---|
| 1 | Nadie paga Workers Paid y todo queda con 10 ms de CPU y 50 subpeticiones [verificado: límites de Workers] | Media | Decisión de Giovanni antes de las 10:00; tarjeta para Workers Paid |
| 2 | El dominio falla (ya **no** es la propagación: la zona está activa desde la madrugada) — alguien apaga DNSSEC o toca NS/DS, o se rompe el Custom Domain al desplegar el Worker real | Baja | Regla «no tocar NS, DS ni DNSSEC»; desplegar sobre el mismo Worker y comprobar con `curl` en el mismo minuto; respaldo `*.workers.dev` (cambiando `APP_ORIGIN`); si la víctima quedara sin zona, la ingesta HMAC sigue funcionando y el bloqueo cae a una lista negra dentro de la víctima |
| 3 | Endpoints beta de Supabase (SQL read-only, advisors, métricas con PAT con alcance) fallan o cambian | Media | Prueba de humo 08:00 en la víctima; envolver cada uno en `try` y degradar a «sin mirar» (nunca a verde); plan B: solo advisors |
| 4 | La llamada a móviles +58 no entra o tarda | Alta | Probar el sábado con Movistar, Digitel y Movilnet; número extranjero de respaldo; Twilio `<Say>`; voz en el navegador; video |
| 5 | El sandbox de Kapso exige ventana abierta, caduca o no tiene crédito (servicio se cobra desde el 1-oct-2026) | Media | Reactivar 30 min antes; recargar 5 USD; el banner in-app siempre funciona |
| 6 | Los dos chats se pisan o el contrato se desalinea | Alta | Carpetas con dueño, contratos congelados a las 11:00, fixtures validados con zod en CI |
| 7 | La org no deja crear secretos de Actions | Media | Espejo personal con el mismo `deploy.yml` (camino B), decidido en la hora 1 |
| 8 | Rechazos `cyber` o latencia de la IA en plena demo | Media | Encuadre defensivo, `fallbacks:"default"`, plantillas, caché caliente. La IA nunca está en la ruta de la alerta |
| 9 | Los agentes del jurado gastan crédito en el deploy público | Alta | El viewer anónimo no llama a la IA; topes diarios por org; límites de workspace en la Console; PSI y pruebas activas solo en dominios verificados; rate limit `RL_API` |
| 10 | Inyección desde logs/repo/UA hacia el prompt de corrección | Media | La regla decide, no el modelo; evidencia cercada y marcada como no confiable; filtro determinista `untrusted.ts`; el modelo sin herramientas de escritura; pruebas de inyección en CI |

Otros a vigilar: los crons tardan hasta 15 min en propagarse → desplegarlos temprano; que la mitigación DDoS de Cloudflare actúe antes que nuestro bloqueo (ensayar con volumen moderado; si pasa, lista negra dentro de la víctima, consultada en cada petición y con 403); Norton bloquea addons `.node` de Vite (plan B `tsc -b`, preview del PR o Codespaces; ningún agente toca Norton).

---

## 13. Reparto: 5 personas, 3 chats

| Persona | Chat / rol | Responsable de |
|---|---|---|
| **Giovanni** | ORQUESTADOR (dueño) | Raíz del monorepo, `packages/contracts` y fixtures, `wrangler.jsonc` base, `deploy.yml`, merges; cuentas y tarjeta (Workers Paid, dominio ya comprado y zona ya activa en Cloudflare, workspaces de Anthropic); **revisión** de las primitivas de seguridad de `packages/core` (las escribe Daniel); `packages/core/src/perf/` hasta el sáb 18:30; `apps/victima`, `demo/`, `scripts/ataque.mjs`; SECURITY.md, THREAT_MODEL.md, README, logo, jsonc; guion, pitch y video |
| **Andrés** | Conduce BACK | `apps/api`, `supabase/migrations`: auth, worker (cron/queue/tail), Workflow `vg-scan`, reglas CF y sensor, acciones con aprobación, notificador, IA |
| **Daniel** | Conduce BACK | `supabase/` (esquema §6, RLS, Vault, pruebas SQL), `crypto.ts`, conexiones y sondeo, conector Supabase + catálogo SQL, auditoría; luego escáner de Codebase |
| **Carlos** | Conduce FRONT | `apps/web`: cascarón con módulos, Conexiones con guías, Resumen, `PantallaModulo` genérica, Incidentes con cronómetro, Auditoría, Exportar, Ajustes, Realtime (P1) |
| **Gabriel** | Integraciones, cuentas y red team | Kapso sandbox, Twilio (número EE. UU. + Venezuela), agente de ElevenLabs, tokens de Cloudflare, clave PSI; prueba de llamada con los tres operadores; proyecto y repo víctima; **red team interno** desde las 18:00 (claves prohibidas, inyección, IDOR, abuso de cuotas); QA, README y video |

*(El encargo nombra a Daniel Barreda y Andrés Valero conduciendo BACK y a Carlos Bastidas en FRONT; si el equipo prefiere otro reparto de los dos BACK/FRONT, lo decide Giovanni antes de la hora 1. Lo fijo es: 1 chat orquestador, 1 BACK, 1 FRONT, y las cuentas externas en Gabriel.)*

**Hora 1 (sábado 08:00–09:00), pruebas de humo en paralelo:**
- BACK: SQL de solo lectura y advisors con un PAT con alcance sobre la víctima (Gabriel crea `vanguard-demo`, aplica el sembrado de S07 07.9 a las 08:00 y entrega el PAT de 30 días antes de las 08:15); permiso de analytics; `signInAnonymously()`.
- Orquestador: la zona `officialvanguard.com` **ya está** en Cloudflare con DNSSEC y la provisional en el apex: no se tocan NS, DS ni DNSSEC; Workers Paid; deploy del esqueleto por Actions (camino A o B) sobre el mismo Worker `vanguard`; cron desplegado; Workflow creado; `www` → 301.
- Gabriel: Kapso sandbox con un interactivo y una llamada de ElevenLabs a +58.
- FRONT: Vite corre en Windows sin bloqueos de Norton.

**Hitos y dependencias:**

| Hora (sáb) | Hito | Depende de |
|---|---|---|
| 10:00 | Esqueleto `vanguard` en el apex con `/api/health` en JSON (y `tail()` vacío) y `www` → 301; contratos v0 y fixtures publicados | Pruebas de humo, tarjeta |
| 11:00 | Contratos congelados; migraciones 0001–0003 aplicadas | Esqueleto |
| 13:00 | Conexiones con cifrado de punta a punta; FRONT con Conexiones y Resumen sobre fixtures | Contratos |
| 15:00 | Auditoría (`vg-scan`) con Supabase y repo; IA-1 | Conexiones |
| 16:00 | Víctima en `demo.officialvanguard.com` con ingesta y Configuration Rule `bic: false`; seeds listos; `PSI_API_KEY` (15:00) | Zona activa, contratos de ingesta |
| 17:30 | Reglas en vivo, incidente, WhatsApp y llamada; «Bloquear IP» | Ingesta, cuentas de Gabriel |
| 18:00 | Empieza el red team interno | G2 de punta a punta |
| 19:00 | Primera prueba de punta a punta con el guion | Todo lo anterior |
| 22:00 | Congelar funciones nuevas | — |
| 22:30 | Video de respaldo | Ensayo correcto |
| Dom 07:00–10:00 | P1 (Rendimiento, ZIP, MCP, config de Cloudflare), arreglos del red team, README, ARQUITECTURA.md, logo | P0 cerrado |
| Dom 10:00–12:00 | Entrega y revisión; nada nuevo | — |

**Hecho cuando:** BACK: `pnpm test` en verde y 0 tablas de `public` sin RLS; FRONT: todas las pantallas P0 funcionan con fixtures y con la API real, botones ≥ 56 px y guía en cada módulo; Orquestador: `https://officialvanguard.com` responde, el guion sale 3 veces seguidas y el video está grabado.

---

## 14. Glosario de nombres canónicos

| Concepto | Nombre canónico (código) | En la UI (español) |
|---|---|---|
| Dominio y deploy-url | `officialvanguard.com` | officialvanguard.com |
| App víctima | `demo.officialvanguard.com` | demo |
| Worker del producto | `vanguard` | — |
| Worker víctima | `vanguard-victima` | — |
| Proyectos Supabase | `vanguard-prod`, `vanguard-dev`, `vanguard-demo` | — |
| Repo víctima | `vanguard-demo-victima` | — |
| Módulos (enum `module`) | `supabase`, `cloudflare`, `codebase`, `performance` | Supabase, Cloudflare, Codebase, Rendimiento |
| Entidades | `orgs`, `org_members`, `connections`, `connection_secrets`, `scan_runs`, `findings`, `incidents`, `notifications`, `actions`, `approvals`, `contacts`, `metric_samples`, `edge_hits` | organización, conexión, auditoría, hallazgo, incidente, notificación, acción, contacto |
| Severidades (enum `severity`) | `critical`, `high`, `medium`, `low`, `info` | crítica, alta, media, baja, info |
| Estado de hallazgo | `open`, `fixed`, `verified`, `ignored` | abierto, corregido, verificado, ignorado |
| Estado de incidente | `open`, `ack`, `mitigated`, `resolved` | abierto, confirmado, mitigado, resuelto |
| Canales (enum `channel`) | `in_app`, `whatsapp`, `voice` | en app, WhatsApp, llamada |
| Rutas IA | `fix_prompt`, `audit_summary`, `alert_text` | — |
| Patrón de `rule_id` | `^(SB\|CF\|CB\|PF)_[A-Z0-9_]+$` | — |
| Canal Realtime (P1) | `org:<org_id>` | — |
| Worker trabajos | Cron `* * * * *` → Queue `vg-monitor`; Workflow `vg-scan` | — |
| IDs de modelo | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` | — |
| Token MCP | prefijo `vgk_` | — |
| Secreto de ingesta (lo genera VanGUARD) | prefijo `vgi_` | — |
| Enlace temporal de export (P2) | prefijo `vgs_` | — |
| Secreto de ingesta (en la app del cliente) | `VG_INGEST_SECRET` | — |

Secretos del Worker (nombres exactos): `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `VG_KEK_PEPPER`, `VG_FP_PEPPER`, `ANTHROPIC_API_KEY`, `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_WABA_ID`, `KAPSO_WEBHOOK_SECRET`, `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, `ELEVENLABS_WEBHOOK_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_FROM`, `PSI_API_KEY`, `IA_CORTE`. Variables del build FRONT: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`. Secretos de Actions: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (distintos de los tokens con los que VanGUARD vigila nuestra zona).

---

## 15. Correcciones al planteamiento original y discrepancias con el trabajo previo

| # | Tema | Planteamiento original / anoche | Decisión canónica | Por qué |
|---|---|---|---|---|
| 1 | Guardado de keys | «pasarlas por una función hash y guardar la pimienta en el Vault» | **Cifrado de sobre AES-256-GCM** (KEK partida: Vault + pimienta del Worker); el HMAC con pimienta queda solo como **huella** (§10.1) | Un hash es irreversible y el sistema necesita el token en claro cada 60 s para llamar a las APIs; coinciden R01, R09, R11, R15, R16, R17 |
| 2 | Hosting | Vercel (`vanguard-sec.vercel.app`) + Railway (R13, R16) | **Todo en Cloudflare**: Worker con assets + API Hono + Cron/Queue/Workflow; Vercel solo como proveedor **monitoreado** en la hoja de ruta | Cambio de última hora del equipo; manda R17 |
| 3 | deploy-url | `*.workers.dev` o `*.pages.dev` (R17 §1.3) | **`https://officialvanguard.com`** (dominio comprado hoy en Squarespace; nameservers ya delegados a Cloudflare y DNSSEC activo), con `*.workers.dev` de respaldo | Cambio de última hora; el dominio permite el dogfooding del módulo Cloudflare sobre nuestra propia zona |
| 4 | Decisión de severidad | parte5 dejaba abierto si el modelo clasificaba | **La severidad y la decisión de alertar son del motor de reglas, nunca del modelo** (§8, §9) | Una inyección en un log no puede apagar una alerta; criterio del jurado (25 % técnico) |
| 5 | `service_role` | parte5 §2.1 mencionaba `service_role` como opción de conexión | **Prohibido** pedir `service_role`/`sb_secret_` al cliente: solo PAT con alcance de solo lectura; si nuestra demo necesita una secret key, es solo del servidor | R01, R09, R15; el jurado mira justo esto |
| 6 | MCP en el monitoreo | parte5 §2.1 proponía conectar el MCP de Supabase en el bucle | El monitoreo va por **REST/GraphQL deterministas**; el MCP solo en «conecta tu IA» (nuestro `/mcp` y los oficiales en lectura) | El MCP gasta tokens, no es determinista y abre la puerta a inyección (R12 §0, R10 §7) |
| 7 | Herramienta de ataque | parte5 §2.7 sugería `k6`/`autocannon` | **`node scripts/ataque.mjs`** (fetch de Node, sin binarios) | Regla global del equipo: Norton bloquea ejecutables sin firma |
| 8 | Lighthouse | Librería `lighthouse` en Docker/Railway (R13, R16) | **PageSpeed Insights API v5** desde un paso del Workflow, solo sobre dominios verificados | Lighthouse necesita lanzar Chrome, imposible dentro de un Worker; PSI = cero binarios (R17 §4.3) |
| 9 | Realtime en la demo | Realtime desde el arranque (R16) | **P0 por polling** (TanStack Query cada 2–3 s); Realtime Broadcast en **P1** sin cambiar componentes | Dos piezas móviles menos y nada de RLS sobre `realtime.messages` en la ruta crítica de la demo (borrador A) |
| 10 | Plantilla de WhatsApp | parte5 pedía la plantilla de Meta aprobada | **Demo por sandbox de Kapso** (interactivos sin plantilla); la plantilla de Meta es mejora P1, no dependencia | Las plantillas tardan en aprobarse y pueden no llegar a tiempo (R14) |
| 11 | Cola de trabajos | `pgmq` + `enqueue_scan`/`claim_scan_jobs` (R16) | **Cloudflare Queues + Workflows**; `scan_runs` queda como estado visible | No hay proceso permanente que sondee la cola (R17 §4.2) |

---

*Fin de las decisiones canónicas. Cualquier cambio posterior lo aprueba el orquestador (Giovanni) y se refleja aquí antes de que los chats lo adopten.*
