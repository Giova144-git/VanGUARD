# Borrador A. Decisiones del plan maestro de VanGUARD, enfoque "MVP ejecutable"

**Platanus Hack 26 Caracas, team-22, track AI Security. Etapa 2 de 4. Sábado 24-oct-2026, madrugada (hora de Caracas). Entrega: domingo 25 a las 12:00.**

> **Criterio de este borrador:** recortar todo lo que no haga falta para que la demo funcione de punta a punta y quede desplegada (ejecución, 20 %). Se prefiere lo determinista, con pocas piezas móviles, y se usan mocks o datos sembrados donde no da el tiempo. Lo recortado no se pierde: queda en P1 o P2 con su dueño.
> **Prioridades:** P0 = la demo lo necesita sin falta (listo el sábado a las 20:00). P1 = debe estar el domingo a las 10:00. P2 = hoja de ruta, se menciona en el pitch.
> **Marcas:** [verificado: URL] = comprobado en esa fuente (casi siempre por los informes R01 a R17 de hoy). [no verificado] = falta comprobarlo antes de prometerlo. [propuesta] = decisión o umbral nuestro, a calibrar.
> **Jerarquía:** el encargo de hoy y los cambios de última hora mandan sobre `parte5-decisiones-y-plan.md`. R17 manda sobre R13 y R16 en todo lo que es despliegue.

---

## 0. Las 12 decisiones que más pesan

| # | Decisión | Qué recorta o asegura |
|---|---|---|
| D1 | Un Worker `vanguard` en **Workers Paid** (5 USD) sirve la SPA, la API Hono, el cron por minuto y el Workflow `vg-scan`. Un segundo Worker, `vanguard-victima`, es la app atacada | Una sola pieza que desplegar. Sin Vercel, Railway, Pages ni Next.js (R17) |
| D2 | `deploy-url` = `https://vanguard.<dominio>` sobre una zona nuestra en Cloudflare. `https://vanguard.<sub>.workers.dev` queda vivo como respaldo | Permite el dogfooding del módulo Cloudflare |
| D3 | **El sensor del ataque en P0 es la ingesta firmada con HMAC** desde la víctima (`POST /ingest/v1/events`). El Tail Worker pasa a P1 | Se prueba en local con Node y no depende de la latencia sin documentar de los Tail Workers. Además es el mismo mecanismo que un cliente podría instalar en su app |
| D4 | **Sin Cloudflare Queues ni Supabase Realtime en P0.** El cron por minuto recorre los monitores en línea (hay ≤ 20 conexiones) y la UI consulta cada 3 s con TanStack Query. Realtime Broadcast entra en P1 sin cambiar las claves de consulta | Dos piezas móviles menos y nada de RLS sobre `realtime.messages` en la ruta crítica |
| D5 | **El motor de reglas decide** la alerta, la severidad y el canal. En P0 la IA tiene solo dos rutas: el prompt de corrección (Sonnet 5.5) y la síntesis de la auditoría (Opus 5.5). Los textos de alerta salen de plantillas | La alerta nunca espera al modelo y una inyección en un log no la puede apagar |
| D6 | Credenciales con **cifrado de sobre AES-256-GCM** (WebCrypto). KEK = HKDF(secreto `kek_v1` de Vault, pimienta `VG_KEK_PEPPER` del Worker). Huella HMAC-SHA256 con la pimienta `fp_pepper_v1` de Vault | Corrige el "hash" del dueño (sección 10). El código ya está escrito en R17 §11.2 |
| D7 | Supabase se conecta con **un PAT con alcance, de solo lectura y de un solo proyecto**. Nunca `service_role` ni `sb_secret_` | Coherente con la decisión de anoche |
| D8 | Cloudflare: token de lectura obligatorio y token de acciones opcional. **La única escritura en P0 es "Bloquear IP"**, siempre con confirmación y con "Deshacer" | Una sola acción que ensayar |
| D9 | GitHub: **PAT fine-grained de un solo repo** (Contents y Metadata en lectura). La GitHub App pasa a P2 | Ahorra registrar la App, el JWT RS256 y el callback |
| D10 | Alertas: **WhatsApp por el sandbox de Kapso** (mensaje interactivo) y **llamada de ElevenLabs por Twilio**, ambas en t0 cuando la severidad es crítica. El escalamiento por falta de respuesta pasa a P1 | No se depende de plantillas de Meta ni de un temporizador |
| D11 | P0: exportar a Markdown o JSON. P1: Rendimiento (PSI), subida de ZIP y servidor MCP propio | Lo que no sale en los 3 minutos de demo no compite por horas del sábado |
| D12 | **Nada de binarios en Windows:** `wrangler` y la CLI `supabase` no van en ningún `package.json`. Las migraciones se aplican con el MCP de Supabase o con el editor SQL | Regla global del equipo (Norton) |

---

## 1. Nombre del producto y one-liner

- **Nombre:** **VanGUARD**, decidido por el equipo y ya puesto en `platanus-hack-project.jsonc`.
- **One-liner (se mantiene el del jsonc):** "Conecta tu Supabase, tu Cloudflare y tu repo de GitHub: una IA audita todo tu ecosistema, detecta puntos débiles y ataques, y te avisa al instante por WhatsApp o llamada."
- **Frase de pitch, posicionada frente a Aikido y los advisors de Supabase (R15 §4.2):** "Otros te dicen qué está mal configurado. VanGUARD te avisa cuando alguien lo está aprovechando, te llama y te da el arreglo listo para tu IA."
- **Ajustes al jsonc (orquestador, domingo 09:00):** `deploy-url` = `https://vanguard.<dominio>`, o la de workers.dev si no hay dominio. La descripción promete Lighthouse, tablas hinchadas y CPU: todo eso es P1, así que se queda **solo si el domingo a las 09:00 funciona**. Si no funciona, se quita de la descripción.

---

## 2. Alcance por módulo

| Módulo | P0: la demo, sin falta | P1: domingo 10:00 | P2: hoja de ruta | Dueño |
|---|---|---|---|---|
| **Conexiones y onboarding** | Tres tarjetas grandes: Supabase (URL del proyecto y PAT con alcance), Cloudflare (token de lectura y zona; token de acciones opcional) y GitHub (PAT de 1 repo). Cada una lleva una guía de 4 pasos y el botón "Probar conexión", con una lista por permiso donde cada 403 se traduce a "te falta el permiso X" (patrón de KUADRA, R07 §7). El secreto se muestra como `••••a1b2`. Conexión `ingest` para la app propia: genera el secreto HMAC y lo muestra una sola vez | Clave publicable de Supabase para el sondeo activo de RLS (R15 idea 2) | OAuth "Conectar con Supabase", GitHub App, Vercel | FRONT (UI) y BACK (validación y cifrado) |
| **Resumen (puntaje)** | Puntaje 0-100 con la cobertura al lado ("vemos 3 de 4 fuentes"), conteo por severidad, bandeja "Ahora" (los 10 hallazgos e incidentes peores) y el botón grande "Auditar todo" | Cifras de servidor de Supabase (CPU, RAM, disco y conexiones) | Mapa de superficie | FRONT; el cálculo es del BACK (`packages/core/score.ts`) |
| **Supabase** | Advisors `security` y `performance` convertidos en hallazgos. Tres chequeos SQL propios por `/database/query/read-only`: `SB_RLS_DISABLED`, `SB_POLICY_ALLOW_ALL` y `SB_RPC_ANON_NO_LIMIT` (sección 9.2). Salud con `GET /health` cada minuto (`SB_DB_DOWN`) | Métricas Prometheus por la Management API con las reglas `SB_CPU_HIGH`, `SB_DISK_HIGH` y `SB_CONN_HIGH`; `SB_TABLE_BLOAT` (heurística DB-02 de R02); configuración de Auth por lista blanca (B01 y B03 de R04); regresión de exposición (R15 idea 3) y botón "Verificar arreglo" | Logs ClickHouse (explotación en curso, R15 idea 5), freno completo RL-02 a RL-18, `splinter.sql` 0019-0030, sesiones A01 a A06 | BACK y FRONT |
| **Cloudflare** | Conexión con sondeo de permisos. Ingesta de la víctima y reglas en vivo `CF_ADMIN_EXPOSED`, `CF_PATH_SCAN`, `CF_UA_TOOL` y `CF_IP_FLOOD`. Acción "Bloquear IP" (IP Access Rule de zona) con "Deshacer". Pulso GraphQL Q1 cada 5 minutos para las tarjetas de top IPs, user agents y rutas | Auditoría de configuración `CF_ZONE_01`, `CF_DNS_01`, `CF_TLS_01/02/03` y `CF_WAF_01`; Q3 (eventos del firewall) para confirmar el bloqueo; Under Attack con "Deshacer"; sensor `tail()`; webhook `dos_attack_l7` | Reglas de rate limit y por user agent, reputación de IP, correlación C1-C3 (R15 idea 4) | BACK y FRONT |
| **Codebase** | PAT de GitHub, `zipball` de la rama por defecto y escáner en memoria con `fflate`: `CB_ENV_COMMITTED`, `CB_GITIGNORE_NO_ENV`, `CB_SECRET_*` (12 reglas, incluido el JWT `service_role`) y `CB_DEP_VULN` (OSV `querybatch` sobre `package-lock.json` y `composer.lock`) | ZIP subido a R2 (máximo 25 MB) con el mismo escáner; `CB_SQL_NO_RLS` en migraciones; `.env` en el historial (`commits?path=`); prioridad con CISA KEV; `pnpm-lock.yaml`; `CB_KEY_REUSE` (huella HMAC, R15 idea 16) | EPSS, deps.dev, endoflife.date, SAST con 25 reglas, revisión de archivos con Claude, Dependabot como segunda opinión | BACK y FRONT |
| **Rendimiento (Lighthouse histórico)** | Pantalla con la última medición sembrada (dato real medido el sábado) | "Medir ahora" con PSI v5 (móvil y escritorio) sobre URLs de dominios de la org; histórico de score, LCP, TBT y CLS; `compareRuns` contra la medición anterior, que genera `PF_REGRESSION`; dos versiones de la víctima medidas (una sana y otra con regresión a propósito) | Tiempos de compilación de GitHub Actions, Lighthouse en Actions, Observatory, Vercel | BACK y FRONT |
| **Auditoría de un botón** | `POST /api/orgs/:org/scans {kind:'full_audit'}` lanza el Workflow `vg-scan` con los pasos `supabase`, `cloudflare`, `repo` y `resumen-ia`, más el progreso por paso y el puntaje final | Paso `psi`; re-auditoría diaria con el cron `0 10 * * *` | Batch nocturno | BACK; la UI de progreso es del FRONT |
| **Incidentes y alertas** | Un incidente por IP atacante (los eventos se agrupan), línea de tiempo con cronómetro (ataque → WhatsApp → llamada → bloqueo). WhatsApp interactivo por el sandbox de Kapso con los botones "Lo estoy viendo" y "Silenciar 1 h". Llamada saliente de ElevenLabs en crítico. Webhook de Kapso para el ack. Techos por org y plantillas fijas | Escalamiento sin ack con un Queue y `delaySeconds: 45`. Herramienta de voz `registrar_respuesta` y webhook post-llamada. Aprobar "Bloquear IP" desde WhatsApp con nonce y doble paso. Planes B de voz (Twilio `<Say>` y navegador). Redacción del aviso con Sonnet (máximo 3 s) | Telegram, Resend, plantilla de Meta (pedirla hoy de todos modos) | BACK; la UI es del FRONT; las cuentas, de Gabriel |
| **Motor IA y prompts de corrección** | IA-1: prompt de corrección por hallazgo (Sonnet 5.5), guardado en `findings.fix_prompt`. IA-2: síntesis de la auditoría (Opus 5.5). Libro de gasto, topes e interruptor | IA-3: texto de alertas; panel "Gasto IA hoy" | Chat "pregúntale a Claude", conector MCP, Batch, editor de prompts | BACK |
| **Exportar a cualquier IA y MCP propio** | Exportar en Markdown y JSON (determinista, con secretos redactados y un encabezado que marca la evidencia como dato no confiable) y botón "Copiar para mi IA" | `/mcp` con 4 herramientas de solo lectura y tokens `vgk_`; guía de los MCP oficiales (Supabase con `read_only=true`, GitHub `readonly`) | SARIF, OAuth para MCP | BACK; la UI es del FRONT |
| **Ajustes** | Contactos de alerta (nombre, teléfono E.164 y canal), estado de la IA (encendida o en pausa, leído del servidor) y cerrar sesión | Miembros y roles; factor de umbral por zona | "Qué no ves según tu plan", editor de prompts | FRONT y BACK |
| **Acceso (transversal)** | Supabase Auth con correo y contraseña, sin confirmación de correo. Botón "Ver demo": `signInAnonymously()` y luego la RPC `join_demo_org()`, que da rol `viewer` en la org de demo. El viewer no lanza auditorías ni llamadas a la IA | Login con GitHub | Invitaciones | BACK (RPC) y FRONT |

Que Supabase permita inicios de sesión anónimos y que el JWT lleve el claim `is_anonymous` está [no verificado]: comprobarlo en la hora 1. Si no funciona, se usa una cuenta de demo `viewer` cuya contraseña nunca va en el bundle; se entrega al jurado en el README.

---

## 3. Stack definitivo (versiones exactas)

Las versiones salen del registro de npm consultado hoy en R16 §1 y R17 §2 [verificado: https://registry.npmjs.org]. **No se sube de versión mayor durante el hackatón.** Todas se fijan sin `^`.

| Capa | Pieza | Versión | Por qué |
|---|---|---|---|
| Runtime | Node | 24.x, ≥ 24.12 | Quita los tipos de TypeScript sin compilar, de forma estable desde 24.12; así el BACK corre sin `tsx` ni esbuild [verificado: changelog de typescript.md en nodejs.org, citado en R17 §7]. La versión exacta de cada laptop está [no verificado] |
| Monorepo | pnpm | 10.34.7 | Workspaces sin Turborepo (R16) |
| Lenguaje | typescript | 6.0.3 | La 7.0.2 no trae la API de compilador en JS (R16 §1) |
| FRONT | vite + @vitejs/plugin-react | 8.3.5 + 6.1.2 | Vite 8 no usa esbuild (usa rolldown y lightningcss, que son addons `.node`) [verificado: registro npm, R17 §2] |
| FRONT | react, react-dom | 19.3.1 | |
| FRONT | react-router | 7.18.4 | La 8.5.0 tiene 5 días; no se cambia de versión mayor (R17) |
| FRONT | @tanstack/react-query | 5.104.5 | Polling de 3 s en P0 e invalidación por Realtime en P1 |
| FRONT | tailwindcss + @tailwindcss/vite | 4.3.3 | |
| FRONT | shadcn (CLI, solo con `pnpm dlx`) | 4.22.1 | Sidebar con Ctrl+B y Chart sobre Recharts v3 [verificado: https://ui.shadcn.com/docs/components/sidebar] |
| FRONT | recharts | 3.10.1 | La instala `shadcn add chart`. Tremor queda fuera: exige React 18 (R16 §3.1) |
| Compartido | zod | 4.6.7 | Contratos en `@vanguard/contracts` |
| Compartido | @supabase/supabase-js | 2.118.0 | Soporta Workers [verificado: https://github.com/supabase/supabase-js] |
| BACK | hono | 4.13.13 | La API va en el mismo Worker; el mismo `app` corre en Node para desarrollo |
| BACK (solo dev) | @hono/node-server | 2.1.5 | `dev-node.ts` (R17 §11.4) |
| BACK | @anthropic-ai/sdk | 0.137.0 | Última 0.x. La 1.0.0 salió el 21-oct: no se adopta (R16, R17) |
| BACK | fflate | 0.8.3 | ZIP en memoria, JS puro [verificado: https://github.com/101arrowz/fflate] |
| BACK (P1) | yaml | 2.9.1 | `pnpm-lock.yaml` |
| BACK (P1) | @modelcontextprotocol/server | 2.3.1 | `WebStandardStreamableHTTPServerTransport` sin estado, montado en Hono [verificado: https://unpkg.com/@modelcontextprotocol/server@2.3.1/dist/index.d.mts] |
| BACK (tipos) | @cloudflare/workers-types | 5.20261024.1 | Solo `.d.ts` |
| Pruebas | vitest | 4.1.12 | Corre en Node; nada de `@cloudflare/vitest-pool-workers` (necesita workerd) |
| CI | wrangler | 4.152.0, **solo** `pnpm dlx` en Actions o Codespaces | No va en ningún `package.json` (R17 §7) |
| CI | actions/checkout, setup-node, pnpm/action-setup | v7, v7, v6 | [verificado: API de GitHub, R17 §6.3] |
| Datos | Supabase Free | Postgres, Auth, Vault y pg_cron (Realtime en P1) | 2 proyectos activos: producto y víctima [verificado: https://supabase.com/pricing] |
| Datos (P1) | Cloudflare R2 | bucket `vanguard-uploads` | ZIP de hasta 25 MB; 10 GB-mes gratis [verificado: https://developers.cloudflare.com/r2/pricing/] |

**Lo que no se usa, y por qué:** Next.js con OpenNext (bugs abiertos en `proxy.ts`, #1400 y #1373, según R17); Vercel y Railway (el despliegue es en Cloudflare); Pages (no tiene Cron ni Workflows) [verificado: https://developers.cloudflare.com/pages/]; `pgmq` y, en P0, Queues; Durable Objects (hacen perder las Version URLs) [verificado: https://developers.cloudflare.com/workers/configuration/previews/]; la librería `lighthouse` (necesita Chrome; se usa PSI); la CLI `supabase` (instala un binario); `osv-scanner`, gitleaks y Semgrep (son binarios, y la licencia de las reglas de Semgrep no permite usarlas en un SaaS, R11); el SDK de Kapso (basta con `fetch`); un triaje con Haiku (el motor de reglas ya decide); MCP dentro del bucle de monitoreo.

---

## 4. Topología de despliegue

```
 Navegador (SPA Vite)  ── HTTPS, mismo origen ──►  Worker "vanguard"  (Workers Paid, vanguard.<dominio>)
   supabase-js (sesión, PKCE)                       ├─ assets: apps/web/dist (gratis, sin CPU)
                                                    ├─ fetch → Hono: /api/*, /ingest/*, /webhooks/*, /mcp (P1)
 Clientes de IA (P1) ── Bearer vgk_ ──► /mcp         ├─ scheduled "* * * * *": monitores (salud, métricas P1, pulso CF cada 5 min)
                                                    ├─ scheduled "0 10 * * *": re-auditoría (P1)
 Worker "vanguard-victima" (demo.<dominio>)          └─ Workflow "vg-scan": auditoría, repo, ZIP (P1), PSI (P1), resumen IA
   cada petición → ctx.waitUntil(POST /ingest/v1/events, HMAC)
          │                                               │ sb_secret_ (solo servidor)
          ▼                                               ▼
 Supabase "vanguard-victima" (sembrado vulnerable)   Supabase "vanguard" (RLS por org_id, Vault, pg_cron)
 APIs de clientes (solo lectura): api.supabase.com, api.cloudflare.com (REST y GraphQL), api.github.com, api.osv.dev
 Salidas: api.kapso.ai (WhatsApp), api.elevenlabs.io → Twilio (voz), api.anthropic.com, googleapis PSI (P1)
```

| Pieza | Dónde corre | URL o identificador | Notas |
|---|---|---|---|
| Producto (SPA, API, cron, Workflow) | Worker `vanguard`, Workers Paid | `https://vanguard.<dominio>` y `https://vanguard.<sub>.workers.dev` | Poner `"workers_dev": true` explícito: si se agregan `routes` sin él, se pierde la URL de respaldo [verificado: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/]. `run_worker_first: ["/api/*","/ingest/*","/webhooks/*","/mcp"]` y `not_found_handling: "single-page-application"` (R17 §6.1) |
| App víctima | Worker `vanguard-victima` (Hono, unas 100 líneas) | `https://demo.<dominio>` | Va detrás del WAF de la zona, para que "Bloquear IP" corte en el borde |
| Base del producto | Supabase Free, proyecto `vanguard` | `https://<ref>.supabase.co` | La clave `sb_secret_` solo vive en el Worker |
| Base de la víctima | Supabase Free, proyecto `vanguard-victima` | otro `<ref>` | Si choca con el límite de 2 proyectos, se crea en la cuenta de otro integrante |
| Repo de la víctima | GitHub **privado** `vanguard-demo-shop` | PAT fine-grained de ese repo | Privado y con secretos **falsos**: Supabase revoca las claves que aparecen en repos públicos (R15) |
| CI/CD | GitHub Actions (ubuntu) con `pnpm dlx wrangler@4.152.0 deploy --secrets-file` | `.github/workflows/deploy.yml` (R17 §6.3) | **Camino A:** repo de la org, si se pueden crear secretos de Actions [no verificado]. **Camino B:** espejo personal con el mismo yaml. Se decide en la hora 1 con una prueba de 5 minutos |

**Dominio (decisión del orquestador antes de las 10:00):** comprar un `.com` en Cloudflare Registrar (~10,46 USD [no verificado: precio de un tercero]), con lo que la zona queda activa al momento, y crear los Custom Domains `vanguard.` y `demo.` (exigen "an active Cloudflare zone" [verificado: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/]). Lo que entra por workers.dev **no** pasa por el WAF de la zona (R17 §1.2). Si a las 14:00 del sábado no hay zona, la víctima consulta una lista de bloqueo propia en Supabase y la demo lo dice.

**Entornos:**
- **Producción:** la versión desplegada desde `main`.
- **Previews por PR:** `wrangler versions upload --preview-alias pr-N`. Comparten base y secretos con producción, y los crons no corren en ellas [no verificado]. `POST /notifications/test` responde 403 fuera del host de producción.
- **Local:** Vite en `:5173` con proxy de `/api` a `:8787` (Hono en Node, `node --env-file=.dev.vars --watch src/dev-node.ts`). La víctima corre en Node en `:8788`. Con `VITE_USE_FIXTURES=1` el FRONT trabaja sin BACK.

**Costo de infraestructura:** Workers Paid 5 USD + dominio ~10,46 USD + Supabase Free + alertas por menos de 40 USD (ElevenLabs Starter 1 USD, recarga de Twilio unos 20 USD, número de EE. UU. unos 1,15 USD/mes, Kapso Free [verificado en R14 §0 con las páginas de precios citadas allí]). **Hay que decidir hoy quién pone la tarjeta.**

---

## 5. Estructura del monorepo

```
/                         ORQUESTADOR  package.json, pnpm-workspace.yaml, tsconfig.base.json, README.md, ARQUITECTURA.md,
                                       .gitignore (.dev.vars*, .env*, node_modules, dist), .github/workflows/deploy.yml
apps/web/                 FRONT        Vite + React. src/{app,modulos,componentes,lib}/**; sin dependencias de Cloudflare
apps/api/                 BACK         src/app.ts (Hono), src/worker.ts (fetch y scheduled), src/workflow.ts (ScanWorkflow),
                                       src/rutas/*.ts, src/scans/{supabase,cloudflare,repo,zip,psi,resumen}.ts,
                                       src/notify/{kapso,elevenlabs}.ts, src/ia/claude.ts, src/dev-node.ts,
                                       wrangler.jsonc (bloque base del orquestador; BACK agrega bindings), worker-configuration.d.ts
apps/victima/             CARLOS (zona del orquestador)  Worker de demo: /, /login, /api/productos, /api/admin/usuarios (sin auth a propósito)
packages/contracts/       COMPARTIDO   src/*.ts (zod) + src/fixtures/*.ts. Solo cambia por PR que aprueba el orquestador
packages/core/            BACK         rules/*.ts (reglas puras), score.ts, crypto.ts, redact.ts, secrets/*.ts, lockfiles/*.ts, templates/*.ts
supabase/migrations/      BACK         único escritor del esquema; numeradas 0001_..., aplicadas con el MCP de Supabase o el editor SQL
scripts/ataque.mjs        CARLOS       generador de ataque con fetch de Node, sin binarios
demo/                     CARLOS       seed-victima.sql, repo-vulnerable/ (contenido del repo privado), guion.md
```

Reglas:
1. **Un chat nunca edita la carpeta de otro.** Si el FRONT necesita un campo, lo pide al orquestador, que cambia `packages/contracts`, avisa a los dos y actualiza los fixtures.
2. **Los contratos se congelan el sábado a las 11:00.** Después solo se agregan campos opcionales.
3. `packages/contracts` y `packages/core` exportan `./src/index.ts`. El `tsconfig` del API usa `erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit` y `verbatimModuleSyntax`, e importa con extensión `.ts` (R17 §7). Si Node no resuelve los paquetes del workspace, el plan B es `tsc -b`, que es JS puro.
4. Scripts raíz: `dev:web`, `dev:api`, `dev:victima`, `typecheck`, `test`, `build`. `pnpm test` corre las pruebas de `core` (reglas, score, crypto, secretos, lockfiles) y de `contracts` (los fixtures validan contra sus esquemas).
5. `docs/` está en `.gitignore`. Lo que el jurado debe leer (arquitectura y modelo de amenazas) va en `README.md` y `ARQUITECTURA.md` en la raíz.

---

## 6. Modelo de datos (Supabase `vanguard`, multi-tenant por `org_id`)

**Enums:** se escriben como `text` con `check`, porque son más fáciles de migrar que `create type` en 36 h. Los mismos valores se repiten en zod dentro de `@vanguard/contracts`.

| Enum | Valores |
|---|---|
| `role` | `owner`, `admin`, `viewer` |
| `provider` | `supabase`, `cloudflare`, `github`, `ingest` (P2: `vercel`) |
| `module` | `supabase`, `cloudflare`, `codebase`, `performance` |
| `severity` | `critical`, `high`, `medium`, `low`, `info` |
| `scan_kind` / `scan_status` | `full_audit`, `supabase`, `cloudflare`, `repo`, `zip`, `lighthouse` / `queued`, `running`, `succeeded`, `failed` |
| `finding_status` / `incident_status` | `open`, `fixed`, `ignored` / `open`, `ack`, `mitigated`, `resolved` |
| `channel` / `notification_status` | `in_app`, `whatsapp`, `voice` / `queued`, `sent`, `delivered`, `read`, `failed`, `skipped_cap` |
| `action_kind` / `action_status` | `block_ip`, `unblock_ip` (P1: `under_attack_on`, `under_attack_off`) / `done`, `undone`, `failed` |

| Tabla | Columnas clave | Quién escribe |
|---|---|---|
| `orgs` | `id`, `name`, `slug` único, `is_demo`, `daily_audit`, `created_at` | API (`service_role`) |
| `org_members` | PK (`org_id`, `user_id`), `role`; índice en `user_id` | API y RPC `join_demo_org()` |
| `connections` | `id`, `org_id`, `provider`, `label`, `status` (`active`, `error`, `revoked`), `meta` jsonb (`project_ref`; `zone_id`, `zone_name`, `account_id`, `plan`; `repo_full_name`, `default_branch`), `last4`, `scopes` text[], `last_checked_at`, `last_error` (código corto) | API |
| `connection_secrets` | PK `connection_id`, `org_id`, `sealed` jsonb (objeto `Box` de R17 §11.2), `kid`, `fingerprint` (HMAC en hex), único (`org_id`, `fingerprint`). **RLS activa y ninguna política** | Solo `service_role` |
| `scan_runs` | `id`, `org_id`, `kind`, `status`, `progress` 0-100, `step`, `params`, `summary` jsonb (salida de IA-2), `score`, `coverage` jsonb, `error`, `requested_by`, tiempos | API y Workflow |
| `findings` | `id`, `org_id`, `scan_run_id`, `connection_id`, `module`, `rule_id` (`^(SB\|CF\|CB\|PF)_[A-Z0-9_]+$`), `severity`, `confirmed` bool, `title`, `resource`, `evidence` jsonb (siempre redactada), `fix_prompt`, `fix_model`, `status`, `dedupe_key`, `first_seen_at`, `last_seen_at`; único (`org_id`, `dedupe_key`) | Workflow; el admin solo cambia `status` vía API |
| `incidents` | `id`, `org_id`, `connection_id`, `rule_ids` text[], `severity`, `title`, `resource` (`ip:203.0.113.7`, `supabase:<ref>:db`), `status`, `event_count`, `details` jsonb, `dedupe_key`, `started_at` (primer evento), `last_event_at`, `notified_at`, `acked_at`, `acked_via`, `mitigated_at`, `resolved_at`. Índice único parcial (`org_id`, `dedupe_key`) `where status <> 'resolved'` | Motor de reglas |
| `notifications` | `id`, `org_id`, `incident_id`, `channel`, `recipient_masked`, `template`, `status`, `provider_id` (`wamid`, `conversation_id`, `callSid`), `error`, `created_at`, `sent_at`, `delivered_at`; único (`incident_id`, `channel`, `recipient_masked`, `template`), así reintentar no duplica | Notificador y webhooks |
| `actions` | `id`, `org_id`, `incident_id`, `kind`, `target`, `status`, `provider_ref` (id de la regla de Cloudflare), `previous` jsonb, `requested_by`, `created_at`, `undone_at` | API |
| `contacts` | `id`, `org_id`, `name`, `phone_e164`, `whatsapp` bool, `voice` bool, `priority` | API |
| `edge_hits` | `id` identity, `org_id`, `connection_id`, `ts`, `ip` inet, `method`, `path` (sin query), `status`, `ua` (máx. 200), `latency_ms`, `auth` bool; índice (`org_id`, `ts desc`); se borra a las 24 h con pg_cron. Sin políticas | Ingesta |
| `edge_eval_state` | PK `org_id`, `last_eval_at` (limita la evaluación a una cada 5 s por org) | Ingesta |
| `metric_samples` | `id`, `org_id`, `connection_id`, `metric`, `ts`, `value`, `labels`; índice (`connection_id`, `metric`, `ts desc`); retención de 7 días | Cron |
| `perf_runs` (P1) | `id`, `org_id`, `url`, `strategy`, `source` (`psi`), `lighthouse_version`, `scores` jsonb, `metrics` jsonb (`lcp_ms`, `tbt_ms`, `cls`, `fcp_ms`, `si_ms`, `ttfb_ms`), `created_at` | Workflow |
| `mcp_tokens` (P1) | `id`, `org_id`, `name`, `token_hash` (SHA-256), `scopes`, `last_used_at`, `revoked_at` | API |
| `ai_usage` | `id`, `org_id`, `route`, `model`, `input_tokens`, `cache_read`, `cache_write`, `output_tokens`, `cost_usd` numeric(12,6), `stop_reason`, `refusal_category`, `created_at`. Sin políticas | `ia/claude.ts` |
| `app_config` | PK `key`, `value` jsonb: `ia_habilitada`, `topes` = `{global_usd_day:40, demo_usd_day:10, org_usd_day:1.5, org_audits_day:3}` | Orquestador, a mano |
| `webhook_events` | `provider`, `external_id` (`X-Idempotency-Key` de Kapso, `conversation_id` de ElevenLabs), único (`provider`, `external_id`), `payload_redacted` | Webhooks |

**RLS:** es el patrón de R16 §8, que ya está escrito. Las funciones `private.user_org_ids()` y `private.user_admin_org_ids()` son `security definer` con `search_path = ''`. Cada tabla con `org_id` tiene una política `for select to authenticated using (org_id in (select private.user_org_ids()))`. Todas las escrituras las hace el Worker con `sb_secret_` después de comprobar el rol. `revoke all` a `anon` y `authenticated` sobre `connection_secrets`, `edge_hits`, `ai_usage` y `webhook_events`. Prueba en CI (VanGUARD se audita a sí mismo): `select tablename from pg_tables where schemaname = 'public' and not rowsecurity` debe devolver 0 filas, y `has_function_privilege('authenticated','public.vg_crypto_material(int)','execute')` debe ser `false` [verificado el patrón: https://supabase.com/docs/guides/database/postgres/row-level-security].

**Ventana del motor en vivo (migración del BACK):**

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
         count(distinct h.path) filter (where h.status in (403, 404)),
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

Si `vg_try_eval` no devuelve filas, la ingesta no evalúa (ya se evaluó hace menos de 5 s). Que `returning` en un `on conflict ... do update ... where` falso devuelva cero filas es comportamiento estándar de Postgres [no verificado en esta sesión: cubrirlo con una prueba].

---

## 7. Contrato API

**Convenciones:**
- JSON en `snake_case`, igual que la base. Tipos y esquemas en `PascalCase` en `@vanguard/contracts`. Rutas en minúsculas con guiones. Todo lo que es org va bajo `/api/orgs/:org/...`.
- **Excepción deliberada:** el modelo de vista `EstadoModulo` conserva los nombres en español de R08 (`cifras`, `ahora`, `filas`, `acciones`), porque los componentes del FRONT se construyen sobre él.
- Cada respuesta se valida con zod en el BACK antes de salir, y los fixtures del FRONT con el mismo esquema.
- **Errores:** `{ "error": { "code": "...", "message": "texto para el usuario", "details": {...} } }`. Códigos fijos: `unauthorized` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `invalid_body` 422, `provider_rejected` 422 (con `details.missing_permissions[]`), `rate_limited` 429, `budget_exceeded` 429, `provider_unavailable` 502, `internal` 500. Nunca se devuelven cuerpos de terceros, tokens ni trazas.
- **Tipos de autenticación:** `user` = `Authorization: Bearer <access_token de Supabase>`, validado con `supabase.auth.getClaims(token)` (R17 §10); `admin` = `user` con rol `owner` o `admin` en la org; `hmac` = firma de ingesta; `kapso` y `eleven` = firmas de webhook; `vgk` = token MCP; `public`.

| Método y ruta | Auth | Request (resumen) | Response (resumen) | Prioridad |
|---|---|---|---|---|
| `GET /api/health` | public | — | `{ok, version, time}` | P0 |
| `GET /api/me` | user | — | `{user:{id,email,is_anonymous}, orgs:[{id,name,role,is_demo}]}` | P0 |
| `POST /api/orgs` | user | `{name}` | `201 Org` (crea la membresía `owner`) | P0 |
| `POST /api/demo/join` | user (anónimo) | — | `{org_id}`, rol `viewer` en la org de demo | P0 |
| `GET /api/orgs/:org/overview` | user | — | `Overview` (ejemplo abajo) | P0 |
| `GET /api/orgs/:org/modules/:module/state` | user | `module ∈ supabase\|cloudflare\|codebase\|performance` | `EstadoModulo` | P0 |
| `GET /api/orgs/:org/connections` | user | — | `ConnectionPublic[]` = `{id, provider, label, status, last4, scopes, meta, last_checked_at}` | P0 |
| `POST /api/orgs/:org/connections` | admin | `ConnectionCreate`, unión por `provider`: supabase `{project_ref, pat}`; cloudflare `{zone_id, read_token, action_token?}`; github `{repo_full_name, pat}`; ingest `{label}` | `201 {connection: ConnectionPublic, checks: PermCheck[], ingest_secret?}` (el secreto de ingesta se muestra una vez) o `422 provider_rejected` | P0 |
| `POST /api/orgs/:org/connections/:id/test` | admin | — | `{ok, checks:[{permission, ok, error_code?}], checked_at}` | P0 |
| `DELETE /api/orgs/:org/connections/:id` | admin | — | `204` (borra en cascada la fila y el secreto) | P0 |
| `POST /api/orgs/:org/scans` | admin | `ScanCreate` (unión por `kind`, R16 §9.3) | `202 {scan_run_id}`; `429 budget_exceeded` si pasa 3 auditorías al día | P0 |
| `GET /api/orgs/:org/scans/:id` | user | — | `ScanRun {id, kind, status, progress, step, score, coverage, summary, error}` | P0 |
| `GET /api/orgs/:org/findings?module=&severity=&status=` | user | — | `Finding[]` | P0 |
| `PATCH /api/orgs/:org/findings/:id` | admin | `{status: open\|fixed\|ignored}` | `Finding` | P0 |
| `POST /api/orgs/:org/findings/:id/fix-prompt` | admin | — | `{prompt, model, cached}`. Al viewer de la demo se le devuelve solo lo que ya esté en caché | P0 |
| `POST /api/orgs/:org/findings/:id/verify` | admin | — | `202 {scan_run_id}` (vuelve a correr solo esa regla) | P1 |
| `GET /api/orgs/:org/incidents?status=` · `GET .../incidents/:id` | user | — | `Incident[]` · `Incident & {notifications[], actions[], timeline[]}` | P0 |
| `GET /api/orgs/:org/traffic?seconds=300` | user | — | `{buckets:[{t, n, n4xx, n5xx}], top_ips:[{ip, n, ua_top}]}` para la gráfica en vivo (cubetas de 10 s) | P0 |
| `POST /api/orgs/:org/incidents/:id/ack` | admin | — | `Incident` | P0 |
| `POST /api/orgs/:org/incidents/:id/actions` | admin | `{kind:'block_ip'\|'unblock_ip', target, simulate?:boolean}` | `RespuestaEscritura` (R08 §6). Con `simulate`, devuelve el efecto sin ejecutar | P0 |
| `PUT /api/orgs/:org/uploads/zip/:scan_run_id` | admin | cuerpo binario con `Content-Length` ≤ 25 MB | `201 {key}`; si falta la longitud, 411; si se pasa, 413 | P1 |
| `GET /api/orgs/:org/perf/runs?url=` | user | — | `PerfRun[]` | P1 |
| `GET /api/orgs/:org/export?format=md\|json` | user | — | archivo redactado | P0 |
| `GET` y `PUT /api/orgs/:org/contacts` | admin | `[{name, phone_e164, whatsapp, voice, priority}]` | `Contact[]` | P0 |
| `POST /api/orgs/:org/notifications/test` | admin | `{channel:'whatsapp'\|'voice'}` | `{ok, provider_id}`; 403 fuera del host de producción | P0 |
| `GET /api/orgs/:org/ai/usage` | user | — | `{today_usd, cap_usd, enabled}` | P1 |
| `POST /api/orgs/:org/mcp-tokens` · `DELETE .../:id` | admin | `{name}` | `{id, token}` (se muestra una vez) · `204` | P1 |
| `POST /ingest/v1/events` | hmac | `IngestBatch` (abajo) | `202 {accepted}` | P0 |
| `POST /webhooks/kapso` | kapso | evento `whatsapp.message.*` | `200` inmediato; el proceso sigue en `ctx.waitUntil` | P0 |
| `POST /webhooks/elevenlabs` | eleven | `post_call_transcription` o `call_initiation_failure` | `200` | P1 |
| `POST /api/voz/respuesta` | Bearer `secret__token_llamada` | `{incidente_id, respuesta: ack\|snooze\|pide_aprobar, conversation_id}` | `200` | P1 |
| `GET` y `POST /mcp` | vgk | MCP Streamable HTTP sin estado | herramientas `get_overview`, `list_findings`, `get_finding`, `list_incidents` | P1 |

**Ingesta (contrato con la víctima o con la app de cualquier cliente):**

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

La víctima toma la IP de `cf-connecting-ip` (orden de R03 §6: `cf-connecting-ip`, `sb-forwarded-for` y el último valor de `x-forwarded-for`). Que `z.iso.datetime()` exista con ese nombre en zod 4.6 está [no verificado]: si no existe, se usa `z.string()`.

**`Overview` (ejemplo):**

```json
{ "score": 38, "band": "red", "coverage": { "seen": 3, "total": 4, "missing": ["performance"] },
  "counts": { "critical": 2, "high": 3, "medium": 4, "low": 1 }, "open_incidents": 1,
  "last_scan": { "id": "…", "status": "succeeded", "finished_at": "2026-10-24T18:04:11Z" },
  "ahora": [ { "kind": "finding", "id": "…", "module": "supabase", "rule_id": "SB_RLS_DISABLED", "severity": "critical",
               "title": "RLS desactivada en public.pedidos y legible por anon", "resource": "public.pedidos" } ] }
```

**`EstadoModulo` (R08 §6, recortado para P0):** `{ok, error?, hora, contador:{rojo, aviso, cola}, cifras: CifraDato[], ahora: GrupoDato[], checks: CheckDato[]}`. En P0 solo se usan cuatro clases de `AccionDato.clase`: `prompt` (abre IA-1), `copiar`, `navegar` y `confirmar` (Bloquear IP). Con esto, Supabase, Cloudflare y Codebase usan **una sola página genérica** `<PantallaModulo/>` en el FRONT. El BACK decide filas, roles (`mal`, `aviso`, `cola`, `bien`, `neutra`) y verbos con cifra ("Bloquear 203.0.113.7", "Copiar SQL").

**Tiempo real:** en P0, TanStack Query consulta `overview`, `incidents` y `traffic` cada 3 s mientras la pestaña está visible, y `scans/:id` cada 2 s mientras corre una auditoría. En P1 se agrega Realtime: canal privado `org:<org_id>`, triggers con `realtime.broadcast_changes` sobre `scan_runs`, `findings`, `incidents` y `notifications`, y una política sobre `realtime.messages` (SQL ya escrito en R16 §5.4) [verificado: https://supabase.com/docs/guides/realtime/subscribing-to-database-changes]. El payload trae `{table, operation, record, old_record}` [no verificado: forma exacta]. Al recibirlo, el FRONT solo invalida la clave de consulta correspondiente, así que no cambia ningún componente.

---

## 8. Motor IA (Claude API)

**Principio:** el modelo explica y redacta; **nunca** decide si se alerta, con qué severidad ni por qué canal. Si la IA está apagada o falla, las alertas salen igual con plantillas.

| Ruta | Para qué | Modelo (ID exacto) | Ajustes | Salida | Costo estimado | Prioridad |
|---|---|---|---|---|---|---|
| IA-1 `fix_prompt` | Prompt de corrección de un hallazgo, bajo demanda, guardado en `findings.fix_prompt` | `claude-sonnet-5-5` | `output_config.effort: "medium"`, `max_tokens` 6.000, system congelado con caché | JSON `{contexto, pasos[], prompt_para_tu_ia, prueba_de_aceptacion}` | ~0,033 USD | P0 |
| IA-2 `audit_summary` | Síntesis de la auditoría: resumen en llano, top 5 y relaciones entre módulos | `claude-opus-5-5` | `effort: "medium"`, `max_tokens` 16.000, `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) | JSON `{resumen, top:[{finding_id, por_que}], relaciones:[{finding_ids[], explicacion}]}` | ~0,31 USD | P0 |
| IA-3 `alert_text` | Reescribir el texto de WhatsApp y voz a partir de los hechos en JSON (máximo 300 caracteres) | `claude-sonnet-5-5` | `effort: "low"`, `thinking: {type:"between_tools"}`, `max_tokens` 800, **3 s como máximo** y si no, plantilla | JSON `{whatsapp, voz}` | ~0,006 USD | P1 |
| Fuera del MVP | Triaje con Haiku, chat, conector MCP, Batch nocturno, `web_fetch` de CVE | — | — | — | — | P2 |

IDs, precios y comportamiento [verificado: https://platform.claude.com/docs/en/about-claude/pricing y https://platform.claude.com/docs/en/build-with-claude/effort, en R12]: Sonnet 5.5 cuesta 2/10 USD por millón de tokens (lectura de caché 0,10); Opus 5.5, 4/20 (lectura 0,20); Haiku 5.5, 0,10/0,50. Batch rebaja un 50 %. El mínimo cacheable es de 512 tokens. En Opus 5.5 el thinking siempre está activo y se cobra como salida. `budget_tokens`, `temperature`, `top_p` y `top_k` dan 400, y forzar `tool_choice` da 400 en Opus y Sonnet 5.5. Los costos por operación son estimaciones de R12 §12: **medirlos con `count_tokens` el sábado**. Fable 5.1 queda fuera (precio y clasificadores contra contenido de ciberseguridad, R12).

**Salida estructurada:** `client.messages.parse({ ..., output_config: { format: zodOutputFormat(Esquema) } })` [verificado: https://platform.claude.com/docs/en/build-with-claude/structured-outputs, en R12]. Que el SDK 0.137.0 traiga en sus tipos `fallbacks` y el helper de zod 4 está [no verificado]: si el compilador se queja, se usa `jsonSchemaOutputFormat()` y se valida con zod a mano.

**Presupuesto de los 250 USD:**

| Bolsa | USD | Dónde se impone |
|---|---|---|
| Desarrollo y ensayos | 100 | Workspace `team22-dev` de la Console con límite de 100 USD. Su API key va solo en `.dev.vars` |
| Demo y jurado | 60 | Workspace `team22-prod` con límite de 150 USD. Su key es el secreto `ANTHROPIC_API_KEY` del Worker |
| Reserva bloqueada | 90 | Dentro de `team22-prod`. La app la protege con un tope de 40 USD al día; solo Giovanni lo sube |

El workspace por defecto no admite límite de gasto y la caché no se comparte entre workspaces [verificado: https://platform.claude.com/docs/en/api/rate-limits, en R12 §13.2]. Antes del pitch hay que calentar la caché de producción.

**Topes en la app (`app_config.topes` + `ai_usage`):**
- Antes de cada llamada se calcula el gasto de hoy (`sum(cost_usd)`) más el peor caso estimado (`max_tokens` × precio de salida + entrada). Si supera el tope, responde `429 budget_exceeded` y la UI muestra "análisis IA en pausa".
- Topes diarios: global 40 USD, org de demo 10 USD, cualquier otra org 1,50 USD y 3 auditorías. El viewer anónimo no gasta: solo ve los prompts ya generados.
- Interruptor de corte con dos llaves: `app_config.ia_habilitada = false` o el secreto `IA_CORTE=1`. Apaga el modelo, **no** las alertas.
- El patrón de reserva y liquidación bajo candado de R12 §13.4 queda en P2. Con un solo Worker y poco tráfico, el riesgo de pasarse por concurrencia es bajo.

**Caché y prompt:** el orden es `system` congelado (≥ 512 tokens: rol defensivo, catálogo de reglas, formato) → datos del tenant en el mensaje de usuario. La fecha, el tenant y los IDs nunca van en `system`, porque rompen la caché. Se marca con `cache_control: {type: "ephemeral"}`, que dura 5 minutos. Cada ruta usa un solo `effort` fijo, porque cambiarlo invalida la caché (R12 §2 y §7).

**Rechazos y defensas contra inyección (resumen de R12 §10 y §15):**
1. Hay que comprobar `stop_reason === "refusal"` antes de leer `content` (llega con HTTP 200). Si hay rechazo, se registra `refusal_category` y se muestra "no se pudo generar; usa la plantilla".
2. El encuadre siempre es defensivo: "el dueño audita su propio sistema; propone remediación, nunca exploits".
3. La evidencia pasa por `redact()` (JWT, `sb_secret_`, `sb_publishable_`, `sk-ant-`, `github_pat_`, `Bearer …` y correos se cambian por `[REDACTADO]`) y va dentro de `<datos_no_confiables>…</datos_no_confiables>`, truncada a 2.000 caracteres por campo.
4. Ninguna ruta tiene herramientas. Salida con esquema estricto.
5. Filtro determinista del prompt de corrección: se rechaza si contiene URLs fuera de una lista permitida (supabase.com, cloudflare.com, github.com, osv.dev, nvd.nist.gov), `curl … | sh`, o instrucciones de borrar o desactivar. En ese caso se usa la plantilla fija de la regla.

Todas las llamadas pasan por un único módulo, `apps/api/src/ia/claude.ts`, con esta firma:

```ts
export async function llamarIA<T>(env: Env, p: { org_id: string; ruta: 'fix_prompt' | 'audit_summary' | 'alert_text';
  sistema: string; datos: unknown; esquema: z.ZodType<T>; timeoutMs?: number }): Promise<{ ok: true; data: T } | { ok: false; code: 'disabled' | 'budget' | 'refusal' | 'timeout' | 'invalid' }>
```

---

## 9. Reglas de alerta, severidades y canales

### 9.1 Reglas en vivo (abren incidentes)

La ingesta corre `vg_try_eval` y, si toca, `vg_edge_window(org, 60)`. Los umbrales son [propuesta] para la demo (unos 20 req/s desde una IP durante 60 a 90 s) y siguen a la Parte V, R1 a R5, y a R10 §2.5. Se guardan como constantes en `packages/core/rules/edge.ts`, con pruebas.

| Regla | Condición (ventana de 60 s, por IP) | Severidad | Acción propuesta | Prioridad |
|---|---|---|---|---|
| `CF_ADMIN_EXPOSED` | `admin_ok ≥ 1`: una ruta de administración responde 2xx o 3xx sin sesión | **critical** | Bloquear IP y prompt "protege `/api/admin/*`" | P0 |
| `CF_PATH_SCAN` | `paths_4xx ≥ 20`, o `probe_hits ≥ 1` (`/.env`, `/.git/config`, `/wp-login.php`, `/phpmyadmin`, `/server-status`) | high | Bloquear IP | P0 |
| `CF_UA_TOOL` | `ua_top` vacío o que casa `/(sqlmap\|nikto\|nmap\|masscan\|zgrab\|nuclei\|wpscan\|python-requests\|go-http-client\|curl\/\|aiohttp\|scrapy\|headlesschrome)/i`, con `n ≥ 20` | high | Bloquear IP (P1: regla custom por UA) | P0 |
| `CF_IP_FLOOD` | `n ≥ 100` y `n/total ≥ 0,20`. Sube a **critical** si `n5xx/n ≥ 0,05` o `p95_ms ≥ 2000` (saturación con degradación) | high o critical | Bloquear IP (P1: Under Attack) | P0 |
| `SB_DB_DOWN` | `GET /health`: `db` o `rest` distinto de `ACTIVE_HEALTHY` en 2 minutos seguidos | critical | Avisar y revisar el proyecto | P0 |
| `SB_CPU_HIGH` | CPU ≥ 90 % en 3 muestras seguidas (critical si ≥ 97 %); CPU = 1 − Δidle/Δtotal (R01 §4.2) | high o critical | Prompt con las consultas lentas | P1 |
| `SB_DISK_HIGH` / `SB_CONN_HIGH` | Disco ≥ 80 % high y ≥ 90 % critical (KUADRA, R01) / conexiones ≥ 80 % de `max_connections` | high o critical | Prompt de corrección | P1 |
| `SB_EXPOSURE_REGRESSION` | Una tabla que en la foto anterior no era legible por `anon` ahora sí lo es (R15 idea 3) | critical | Prompt y "Verificar arreglo" | P1 |

**Agrupación:** las cuatro reglas `CF_*` comparten un incidente por IP atacante: `dedupe_key = sha256(org_id|edge|ip)`, se acumulan en `rule_ids`, la severidad es la máxima y `event_count` suma. **Solo se vuelve a notificar si la severidad sube** (de high a critical dispara la llamada). Si un incidente resuelto reaparece antes de 10 minutos, se reabre sin llamada (R14 §4.3).

### 9.2 Reglas de auditoría (crean hallazgos, no llaman)

| Regla | Fuente y condición | Severidad | `confirmed` |
|---|---|---|---|
| `SB_ADVISOR_<name>` | `GET /v1/projects/{ref}/advisors/security` y `/performance` → `lints[]` (`name`, `level`, `detail`, `remediation`, `metadata`, `cache_key`) [verificado: https://supabase.com/docs/reference/api/v1-get-security-advisors]. `ERROR` → high, `WARN` → medium, `INFO` → low; `rls_disabled_in_public` → critical. Dedupe por `cache_key` | según el lint | no |
| `SB_RLS_DISABLED` | SQL 1 (abajo): `rls_activa = false` y `anon_select = true` | critical | sí |
| `SB_POLICY_ALLOW_ALL` | SQL 2: política con `qual = 'true'` o `with_check = 'true'` para `anon` o `public` | high | sí |
| `SB_RPC_ANON_NO_LIMIT` | SQL 3: función de `public` ejecutable por `anon`, `VOLATILE`, y `authenticator` sin `pgrst.db_pre_request` | high; critical si el nombre casa `/(otp\|login\|pass\|reset\|email\|sms\|pago\|pay\|delete\|borrar)/i` | no |
| `CB_ENV_COMMITTED` | Archivo que casa `(^\|/)\.env(\.[\w-]+)?$` y no `\.env\.(example\|sample\|template)$` | critical | sí |
| `CB_GITIGNORE_NO_ENV` | No hay `.gitignore` en la raíz, o ninguna línea casa `^/?\.env` | medium | sí |
| `CB_SECRET_<id>` | Regex de R11 §4.2, con la bandera `i` en lugar de `(?i)`: `supabase-service-role` (JWT cuyo payload trae `role = service_role`), `sb_secret_`, AWS, Stripe live, Anthropic, OpenAI, `github_pat_`/`ghp_`, clave privada, cadena de conexión a Postgres. Se guarda solo una vista parcial y la huella HMAC | critical (la regla genérica con entropía ≥ 3,5 es medium y P1) | sí |
| `CB_DEP_VULN` | OSV `POST https://api.osv.dev/v1/querybatch` en lotes de ≤ 1.000 y `GET /v1/vulns/{id}` con caché; dedupe por alias [verificado en vivo en R11 §2.4]. `CRITICAL` → critical, `HIGH` → high, `MODERATE` → medium, `LOW` → low; `MAL-*` → critical | según el aviso | sí |
| `CF_*` de configuración y `PF_REGRESSION` | R10 §6 y R13 §5.3 (`compareRuns`: LCP +10 % y +250 ms, TBT +20 % y +100 ms, CLS +0,05, score −5) | ver fuente | — |

SQL de solo lectura que el BACK manda en `POST /v1/projects/{ref}/database/query/read-only` con cuerpo `{"query":"..."}` (endpoint en beta, corre como `supabase_read_only_user`, exige nombres con esquema) [verificado: https://supabase.com/docs/reference/api/v1-read-only-query]:

```sql
-- SQL 1 · SB_RLS_DISABLED (R15 §6.1)
select n.nspname as esquema, c.relname as tabla, c.relrowsecurity as rls_activa,
       pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') as anon_select, coalesce(s.n_live_tup, 0) as filas_estimadas
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_stat_user_tables s on s.relid = c.oid
where c.relkind in ('r','p') and n.nspname = 'public';
-- SQL 2 · SB_POLICY_ALLOW_ALL
select schemaname, tablename, policyname, cmd, roles from pg_catalog.pg_policies
where schemaname = 'public' and (qual = 'true' or with_check = 'true') and ('anon' = any(roles) or 'public' = any(roles));
-- SQL 3 · SB_RPC_ANON_NO_LIMIT (versión mínima de RL-01 y RL-02, R03)
select n.nspname as esquema, p.proname as funcion, p.prosecdef as definer,
       exists (select 1 from pg_catalog.pg_roles r, unnest(r.rolconfig) cfg
               where r.rolname = 'authenticator' and cfg like 'pgrst.db_pre_request=%') as hay_pre_request
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f' and p.provolatile = 'v'
  and pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE');
```

Que `supabase_read_only_user` pueda evaluar `has_table_privilege('anon', …)` y leer `pg_roles.rolconfig` está [no verificado] (R03, R15). Es la prueba de humo n.º 1 del BACK. Si falla, la regla sale como "sin mirar" y la auditoría se apoya en los advisors (0013 RLS desactivada, 0028 función definer ejecutable por anon).

**Puntaje (`packages/core/score.ts`, R15 §6.8):** pesos critical 25, high 10, medium 4 y low 1, por 1,5 si `confirmed`. Cada módulo resta como máximo 40. Con un critical confirmado, el tope es 49. Bandas: 0-49 rojo, 50-79 ámbar y 80-100 verde. **Siempre se muestra con la cobertura al lado** (fuentes con lectura correcta en la última auditoría, sobre 4).

### 9.3 Canales por severidad y topes

| Severidad | Canales en t0 (P0) | P1 |
|---|---|---|
| critical | in-app + WhatsApp a todos los contactos con `whatsapp` + **llamada** al contacto de mayor prioridad con `voice` | Llamada solo si no hay ack en 45 s (Queue `vg-escalate` con `delaySeconds: 45`); si nadie contesta, segundo contacto |
| high | in-app + WhatsApp | Llamada de 07:00 a 22:00 si no hay ack en 15 min |
| medium, low, info | in-app | Resumen por correo (P2) |

- **Topes por org:** 2 llamadas por hora y 10 WhatsApp por hora (R14 §4.3). La org de demo tiene 6 y 30, para los ensayos. Al superarlos, `notifications.status = skipped_cap` y se muestra un banner.
- **Tormenta:** más de 5 incidentes nuevos de una org en 2 minutos generan un solo WhatsApp de resumen.
- **"Leído" no es "confirmado".** El ack llega por el botón "Lo estoy viendo" (webhook de Kapso), por la app o, en P1, por la herramienta de voz. "Silenciar 1 h" pone `muted_until`.
- **WhatsApp (plantilla determinista, interactivo por el sandbox):** `POST https://api.kapso.ai/meta/whatsapp/v24.0/{PHONE_NUMBER_ID}/messages` con `X-API-Key` y `type: interactive` de tipo `button` (máximo 3 botones, `body` de hasta 1.024 caracteres) [verificado: https://docs.kapso.ai/docs/whatsapp/send-messages/buttons.md]. Cuerpo: `"ALERTA {SEVERIDAD} · {servicio}\n{titulo}. IP {ip/24}. {n} peticiones en 60 s. Acción propuesta: {accion}. Ver: {url}"`. Botones: `ack:{codigo}:{nonce}` "Lo estoy viendo" y `snz:{codigo}:{nonce}` "Silenciar 1 h". De cada nonce solo se guarda su SHA-256 (R14 §4.4).
- **Voz:** `POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call` con `agent_id`, `agent_phone_number_id`, `to_number` y `conversation_initiation_client_data.dynamic_variables` = `{empresa, incidente_id, severidad, servicio, resumen, accion_propuesta}` [verificado: https://elevenlabs.io/docs/eleven-agents/api-reference/integrations/twilio/outbound-call.md]. El resumen va con los números en palabras, sin IPs completas, claves ni correos, en 90 s como máximo. **La voz nunca aprueba acciones.** El agente se crea a mano en el panel con el prompt de R14 §2.3, cambiando "Centinela" por "VanGUARD".
- **Webhooks:** Kapso firma con `X-Webhook-Signature`, un HMAC-SHA256 en hex del cuerpo crudo, y deduplica con `X-Idempotency-Key` [verificado: https://docs.kapso.ai/docs/platform/webhooks/security.md]. ElevenLabs firma con `ElevenLabs-Signature: t=…,v0=…` (P1). Siempre se responde 200 al momento y se procesa en `ctx.waitUntil`.

---

## 10. Credenciales: cifrado, almacenamiento y conexión por integración

### 10.1 Corrección del "hash con pimienta"

Un hash es de una sola vía: sirve para comprobar que alguien conoce un valor, no para recuperarlo. VanGUARD necesita el token **en claro** cada minuto para llamar a Cloudflare o a Supabase, así que hace falta **cifrado reversible y autenticado**. Lo bueno de la propuesta del dueño se conserva: la llave maestra vive en Supabase Vault, hay una pimienta, y el HMAC con pimienta sirve como **huella**. La huella permite deduplicar, buscar sin descifrar y detectar si una key cargada en VanGUARD aparece filtrada en el repo del mismo cliente (`CB_KEY_REUSE`, P1). Coinciden R01, R09, R11, R15, R16 y R17.

**Diseño (código listo en R17 §11.2, WebCrypto, corre igual en el Worker y en Node 24):**
- **DEK aleatoria de 32 bytes por credencial.** El token se cifra con AES-256-GCM (IV de 12 bytes) y la DEK se envuelve con la KEK. Se guarda `Box {v, kid, iv, ct, ivk, wdek}` en `connection_secrets.sealed`.
- **KEK = HKDF-SHA256(ikm = secreto `kek_v1` de Vault, salt = `VG_KEK_PEPPER` del Worker, info = "vanguard/kek/v1").** Para descifrar hay que robar **dos** sistemas: la base y el Worker. Vault cifra con una llave que no se guarda junto a los datos [verificado: https://supabase.com/docs/guides/database/vault].
- **AAD = `${org_id}|${connection_id}|${provider}`.** Si se copia el cifrado a otra fila u otra org, descifrar falla.
- **Huella = HMAC-SHA256(`fp_pepper_v1` de Vault, token.trim())**, en hex.
- Los dos secretos de Vault se crean una vez con `vault.create_secret(encode(extensions.gen_random_bytes(32),'base64'), 'kek_v1', …)`. El Worker los lee con la RPC `public.vg_crypto_material(1)`, que es `security definer` y ejecutable solo por `service_role` (SQL en R16 §7.3). La KEK derivada se guarda en memoria del isolate 10 minutos.
- **Nunca** existe un endpoint que devuelva el secreto: la UI ve `last4` y `scopes`. El logger pasa todo por `redact()`. Pruebas obligatorias: cambiar 1 byte de `ct` u otro AAD hace que `open()` lance, y la huella es estable.
- Plan B solo si a las 13:00 el sobre no funciona: un secreto de Vault por credencial (opción A de R09 §5.1, esfuerzo S). Se pierde que la base nunca vea el token en claro.

### 10.2 Qué pide cada integración (todo en solo lectura salvo lo marcado)

| Integración | Qué pega el usuario | Permisos mínimos | Validación al conectar | Nunca pedir |
|---|---|---|---|---|
| **Supabase** | `project_ref` (o la URL) y un **PAT con alcance** limitado a ese proyecto (GA desde el 6-oct-2026) [verificado: https://supabase.com/changelog/scoped-personal-access-tokens-ga] | Lectura de proyecto, base de datos y advisors; **analytics opcional** para métricas y logs (P1). El nombre exacto del permiso de analytics en el PAT con alcance está [no verificado]: probarlo a las 08:00 | `GET /v1/projects/{ref}`, `GET /v1/projects/{ref}/health`, `GET /advisors/security` y un `select 1` por `/database/query/read-only`; cada 403 se traduce en un permiso que falta | `service_role`, `sb_secret_`, PAT legacy, `secrets:read` (devuelve la root key de Vault), `rest:read` (trae `jwt_secret`), cualquier escritura. `/config/auth` solo con lista blanca (P1) |
| **Cloudflare, lectura** | Token "Custom" de la zona y `zone_id` | Zone Read, Zone Settings Read, DNS Read, Analytics Read, Firewall Services Read [verificado: https://developers.cloudflare.com/fundamentals/api/reference/permissions/; "Firewall Services" verificado en KUADRA] | `GET /client/v4/user/tokens/verify` (`status: active`) [verificado: https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/], `GET /zones/{z}` y el sondeo de R10 §1.3 | Token global (Global API Key) |
| **Cloudflare, acciones (opcional)** | Segundo token, aparte | Firewall Services Write (P1: Zone Settings Write para Under Attack). Que el permiso de zona se llame así está [no verificado] en la doc oficial: se descubre con el sondeo | Un `GET` de access rules. La escritura real solo ocurre al confirmar | Darlo al MCP o al modelo |
| **GitHub** | `owner/repo` y un PAT fine-grained (`github_pat_…`) de **un** repo | Contents: Read-only y Metadata: Read-only (Dependabot alerts opcional) [verificado: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens] | `GET /repos/{o}/{r}`. Un `ghp_` (clásico) se rechaza explicando por qué | PAT clásico, OAuth `repo` (no existe un scope de solo lectura para repos privados, R11) |
| **Ingesta (app propia)** | Nada: VanGUARD genera el secreto | — | Se muestra una vez para ponerlo como secreto `VG_INGEST_SECRET` en la app | — |
| **PSI (P1)** | Nada: es nuestra clave `PSI_API_KEY` | — | Solo se miden URLs de dominios de la org (zona conectada) | — |

**Papel del MCP:** el bucle de monitoreo y las auditorías **nunca** usan MCP: van por REST y GraphQL directos, deterministas y sin tokens de modelo (R05, R09, R10, R12). El MCP aparece en dos sitios. Primero, nuestro servidor `/mcp` (P1) de solo lectura, con tokens `vgk_` por org de los que solo se guarda el SHA-256, para "audita con tu IA". Segundo, la pantalla "Llevar a tu IA" muestra cómo conectar los MCP oficiales con permisos de lectura: `https://mcp.supabase.com/mcp?project_ref=…&read_only=true&features=database,debugging,docs` [verificado en R09 §3] y el MCP de GitHub en modo `readonly` (R11 §1.6). Del MCP de Cloudflare (`https://mcp.cloudflare.com/mcp`) se advierte que no tiene modo de solo lectura, así que se usa solo con el token de lectura (R10 §7).

---

## 11. Guion de demo de 3 minutos (solo sobre lo nuestro)

**Regla:** todo pasa sobre activos del equipo: la app víctima `demo.<dominio>`, su proyecto Supabase y el repo privado `vanguard-demo-shop`. Nunca se toca un tercero, ni Cuadra ni SAGA. El tráfico del simulacro es moderado, dura menos de 2 minutos, va solo contra `demo.<dominio>` y sale desde el hotspot de un teléfono, para no bloquear la IP del wifi del evento (R17 §9.2). No encontré una política oficial de Cloudflare sobre pruebas de carga contra zonas propias [no verificado].

**Preparación (Carlos y Gabriel, sábado antes de las 16:00; todo en `demo/`):**
- **Proyecto Supabase de la víctima, sembrado a propósito:** una tabla con RLS apagada y legible por `anon`, una política "pase-todo" y una función pública sin freno de tasa. Así salen `SB_RLS_DISABLED`, `SB_POLICY_ALLOW_ALL` y `SB_RPC_ANON_NO_LIMIT`, más los advisors.
- **Repo privado de la víctima:** un `.env` subido con valores **falsos**, un `.gitignore` que no lo ignora, una clave con forma de `service_role` (falsa) en el código y un lockfile con una dependencia que tenga un aviso en OSV. Antes de sembrarla, se confirma con `POST https://api.osv.dev/v1/query` que el aviso existe.
- **Zona de Cloudflare:** `always_use_https` apagado (P1, para `CF_TLS_03`).
- **App víctima:** una ruta de administración que responde sin sesión, sembrada a propósito para `CF_ADMIN_EXPOSED`.
- **Simulacro reproducible:** lo prepara Carlos en `scripts/` y se ensaya 10 veces igual. Debe disparar, en este orden, `CF_PATH_SCAN`/`CF_UA_TOOL` (high, WhatsApp), `CF_ADMIN_EXPOSED` (critical, llamada) y `CF_IP_FLOOD`. Al terminar se borra la regla de bloqueo.
- **Antes del pitch:** auditoría corrida una vez para calentar la caché de IA; el teléfono de la demo vuelve a escribir al sandbox de Kapso 30 minutos antes; pantalla del teléfono duplicada en el proyector.

| Tiempo | Qué se ve | Qué lo respalda | Si falla |
|---|---|---|---|
| 0:00-0:20 | Problema en una frase. Pantalla Conexiones: Supabase, Cloudflare y GitHub conectados, con "solo lectura" y `••••last4` | Sección 10 | Captura |
| 0:20-1:00 | Botón grande **"Auditar todo"**. El progreso avanza por pasos, el puntaje cae a rojo (por ejemplo 38) con "vemos 3 de 4 fuentes". En "Ahora": RLS desactivada (critical), `.env` subido con `service_role` (critical), dependencia con CVE (high), función sin freno (high). Clic en **"Generar prompt de corrección"** y "Copiar para mi IA" | Workflow `vg-scan`, IA-1 | Auditoría previa ya guardada; prompt en caché |
| 1:00-2:10 | Un integrante lanza el simulacro. En Incidentes corre el cronómetro y se mueve la gráfica de tráfico. Llega el **WhatsApp** (objetivo: menos de 30 s), luego **suena el teléfono** y la voz de ElevenLabs explica el incidente en dos frases. Botón **"Bloquear esta IP"**, confirmar: el simulacro empieza a recibir 403 y el incidente pasa a "mitigado" | Ingesta, reglas 9.1, Kapso, ElevenLabs, IP Access Rule | Plan B de voz (Twilio `<Say>` o navegador), banner in-app, video |
| 2:10-2:40 | Línea de tiempo con los tiempos medidos (ataque → WhatsApp → llamada → bloqueo). "Exportar para tu IA" en Markdown | Tabla `notifications`, exportador | — |
| 2:40-3:00 | Seguro por diseño: la regla decide y no el modelo, tokens de solo lectura, cifrado de sobre con Vault, topes de gasto de IA. Hoja de ruta: Vercel, correlación entre capas, regresión de exposición | — | — |

**Respaldo:** video grabado el sábado a las 22:30 con la llamada real; capturas de cada paso; teléfono con datos móviles.

---

## 12. Riesgos top 10

| # | Riesgo | Prob. | Mitigación |
|---|---|---|---|
| 1 | Nadie paga Workers Paid y todo queda con 10 ms de CPU y 50 subpeticiones [verificado: https://developers.cloudflare.com/workers/platform/limits/] | Media | Decisión de Giovanni antes de las 09:00; tarjeta para Workers Paid y dominio |
| 2 | Los endpoints beta o experimentales de Supabase (SQL de solo lectura, advisors, métricas con PAT con alcance) fallan o cambian | Media | Prueba de humo a las 08:00 en el proyecto víctima. Envolver cada uno en `try` y degradar a "sin mirar". Plan B: solo advisors |
| 3 | La llamada a móviles +58 no entra o tarda | Media | Probar el sábado con Movistar, Digitel y Movilnet; número extranjero de respaldo; Twilio `<Say>`; voz en el navegador; video |
| 4 | El sandbox de Kapso exige ventana abierta, caduca o no tiene crédito (los mensajes de servicio se cobran desde el 1-oct-2026, R14) | Media | Reactivar 30 minutos antes; recargar 5 USD; el banner in-app siempre funciona |
| 5 | No hay dominio o zona a tiempo | Media | `workers.dev` como `deploy-url`; la víctima usa una lista de bloqueo propia en Supabase |
| 6 | Los dos chats se pisan o el contrato se desalinea | Alta | Carpetas con dueño, contratos congelados a las 11:00, fixtures validados con zod en CI |
| 7 | La org no deja crear secretos de Actions | Media | Espejo personal con el mismo `deploy.yml` (camino B), decidido en la hora 1 |
| 8 | Rechazos `cyber` o latencia de la IA en plena demo | Media | Encuadre defensivo, `fallbacks: "default"`, plantillas, caché caliente. La IA nunca está en la ruta de la alerta |
| 9 | Los agentes del jurado gastan crédito en el deploy público | Alta | El viewer anónimo no llama a la IA; topes diarios; límites de workspace en la Console |
| 10 | Norton bloquea los addons `.node` de Vite o la resolución de TypeScript en Node falla | Baja-media | El FRONT trabaja contra la preview del PR o en Codespaces; plan B `tsc -b`; ningún agente toca Norton |

Otros a vigilar: los crons tardan hasta 15 minutos en propagarse [verificado: https://developers.cloudflare.com/workers/configuration/cron-triggers/], así que se despliegan el sábado temprano; `SCAN_WF.create({ id, params })` está [no verificado] y se valida en el primer deploy (si falla, el paso corre en `ctx.waitUntil`).

---

## 13. Reparto: 5 personas, 3 chats

| Persona | Chat o rol | Responsable de |
|---|---|---|
| **Giovanni** | Chat ORQUESTADOR (dueño) | Raíz del monorepo, `packages/contracts` y fixtures, `wrangler.jsonc` base, `deploy.yml`, merges, cuentas que piden tarjeta (Workers Paid, dominio), workspaces de Anthropic, decisiones, guion y pitch |
| **Andrés** | Conduce el chat BACK | `apps/api`, `packages/core`, `supabase/migrations`: auth, conexiones y cifrado, auditoría, reglas, notificador, IA |
| **Daniel** | Conduce el chat FRONT | `apps/web`: cascarón con módulos, Conexiones, Resumen, `PantallaModulo` genérica, Incidentes con cronómetro, Exportar, Ajustes |
| **Carlos** | Zona del orquestador | `apps/victima`, `demo/` (seeds del Supabase víctima y del repo privado), `scripts/` del simulacro, ensayos |
| **Gabriel** | Integraciones y QA | Cuentas: Kapso sandbox, Twilio, agente de ElevenLabs, tokens de Cloudflare, clave PSI. Prueba de llamada con los tres operadores. Luego QA de punta a punta, README, logo y video |

**Hora 1 (sábado 08:00-09:00), pruebas de humo en paralelo:**
- BACK: SQL de solo lectura y advisors con un PAT con alcance sobre el proyecto víctima, permiso de analytics e inicio de sesión anónimo.
- Orquestador: deploy "hola mundo" del Worker por Actions (camino A o B), cron desplegado y Workflow creado.
- Gabriel: Kapso sandbox con un mensaje interactivo y una llamada de ElevenLabs a +58.
- FRONT: Vite corre en Windows sin bloqueos de Norton.

**Hitos y dependencias:**

| Hora (sábado) | Hito | Depende de |
|---|---|---|
| 10:00 | Esqueleto desplegado en workers.dev; contratos v0 y fixtures publicados | Pruebas de humo |
| 11:00 | Contratos congelados; migraciones 0001 a 0003 aplicadas | Esqueleto |
| 13:00 | Conexiones con cifrado funcionando de punta a punta; FRONT con Conexiones y Resumen sobre fixtures | Contratos |
| 15:00 | Auditoría (`vg-scan`) con Supabase y repo; IA-1 | Conexiones |
| 16:00 | Víctima desplegada en `demo.<dominio>` con ingesta; seeds listos | Dominio, contratos de ingesta |
| 17:30 | Reglas en vivo, incidente, WhatsApp y llamada; "Bloquear IP" | Ingesta, cuentas de Gabriel |
| 19:00 | Primera prueba de punta a punta con el guion | Todo lo anterior |
| 22:00 | Congelar funciones nuevas | — |
| 22:30 | Video de respaldo | Ensayo correcto |
| Dom 07:00-10:00 | P1 (Rendimiento, ZIP, MCP, configuración de Cloudflare), README, `ARQUITECTURA.md`, logo, jsonc con `deploy-url` | P0 cerrado |
| Dom 10:00-12:00 | Entrega y revisión; no se programa nada nuevo | — |

**Hecho cuando:**
- **BACK:** `pnpm test` en verde (reglas, puntaje, cifrado, secretos, lockfiles); ninguna tabla de `public` sin RLS; ningún secreto en logs.
- **FRONT:** todas las pantallas P0 funcionan con fixtures y con la API real, con botones de al menos 56 px y una guía en cada módulo.
- **Orquestador:** `deploy-url` responde, el guion sale 3 veces seguidas y el video está grabado.
