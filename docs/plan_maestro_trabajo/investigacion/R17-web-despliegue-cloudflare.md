# R17. Despliegue de VanGUARD en Cloudflare (etapa 1 de 4 del plan maestro)

**Platanus Hack 26 Caracas, team-22, track AI Security. Investigación del sábado 24 de octubre de 2026 (madrugada, hora de Caracas).**

> Para quién: chat orquestador, chat FRONT y chat BACK. Qué decide: cómo y dónde se publica VanGUARD ahora que **el despliegue es en Cloudflare y no en Vercel**. Donde R13 o R16 suponen Vercel o Railway, **manda este informe** (tabla de cambios en la sección 10).
> Convención: **[verificado: URL]** = lo leí hoy en esa fuente. **[no verificado]** = conocimiento propio o fuente secundaria; comprobar antes de prometerlo. Las versiones salen del registro de npm consultado hoy (`curl https://registry.npmjs.org/-/package/<paquete>/dist-tags` y el campo `time`) y las de las acciones de GitHub de `GET /repos/<repo>/releases/latest`.

---

## 0. Decisión en una tabla (la recomendación única)

| Tema | Decisión | Por qué en una línea |
|---|---|---|
| Plataforma | **Un solo Worker `vanguard` con assets estáticos** (no Pages) | La doc de Pages abre con "Start new projects with Workers" y llama a Workers "Cloudflare's primary platform" [verificado: https://developers.cloudflare.com/pages/] |
| URL | `https://vanguard.<subdominio-de-cuenta>.workers.dev` desde la hora 1; **dominio propio `vanguard.<dominio>` como `deploy-url` final** (Custom Domain sobre una zona nuestra) | workers.dev "is treated as a Free website" y Cloudflare recomienda ruta o dominio propio para producción [verificado: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/]; además la zona propia es la que permite el dogfooding del módulo Cloudflare (sección 9) |
| Frontend | **SPA Vite 8.3.5 + React 19.3.1** servida como assets; **sin Next.js ni OpenNext** | El `proxy.ts` de Next 16 (lo que pide Supabase SSR) tiene bugs abiertos en OpenNext (#1400, #1373) y OpenNext no garantiza Windows [verificado: GitHub issues y https://opennext.js.org/cloudflare] |
| API | **Hono 4.13.13** dentro del mismo Worker, en `/api/*`, `/mcp` y `/webhooks/*` (`run_worker_first`) | Mismo origen (sin CORS ni cookies cruzadas); un despliegue |
| Plan | **Workers Paid (5 USD/mes) desde el sábado temprano** | Free da 10 ms de CPU por invocación y 50 subpeticiones; un escaneo de repo o parsear un JSON de Lighthouse no cabe [verificado: https://developers.cloudflare.com/workers/platform/limits/] |
| Monitores cada 60 s | **Cron Trigger `* * * * *` → Cloudflare Queue `vg-monitor`** | Cron nativo por minuto en UTC; la cola da reintentos y DLQ [verificado: cron-triggers y queues/platform/limits] |
| Escaneos y "Auditar todo" | **Cloudflare Workflow `vg-scan`** (pasos con reintento y estado durable) | 30 s de CPU por paso (hasta 5 min) y reloj ilimitado por paso en Paid [verificado: https://developers.cloudflare.com/workflows/reference/limits/] |
| Lighthouse | **PageSpeed Insights API v5** desde un paso del Workflow; Observatory de Cloudflare sobre nuestra zona como extra | Lighthouse no corre dentro de un Worker (necesita lanzar Chrome; `child_process` es un stub) [verificado: https://developers.cloudflare.com/workers/runtime-apis/nodejs/] |
| ZIP subidos | **R2, bucket `vanguard-uploads`**, subida en streaming a través del Worker | Binding nativo, 10 GB-mes gratis, egreso gratis [verificado: https://developers.cloudflare.com/r2/pricing/] |
| Tiempo real a la UI | **Se mantiene Supabase Realtime Broadcast** (R16 §5.4) | No hace falta Durable Objects |
| MCP propio | **`@modelcontextprotocol/server@2.3.1` con `WebStandardStreamableHTTPServerTransport` sin estado, montado en Hono (`app.all('/mcp')`)**. Sustituye a `mcp-handler`, que es para Next | Los tipos del paquete traen literalmente los ejemplos "Hono.js" y "Cloudflare Workers" [verificado: https://unpkg.com/@modelcontextprotocol/server@2.3.1/dist/index.d.mts]. La envoltura de Cloudflare (`agents@0.30.1`, `createMcpHandler`, "the recommended approach for new MCP servers") arrastra `esbuild` y 4 dependencias par [verificado: registro npm; https://developers.cloudflare.com/agents/model-context-protocol/transport/] |
| Despliegue | **GitHub Actions (ubuntu) con `pnpm dlx wrangler@4.152.0 deploy --secrets-file`** desde el repo de la organización; nadie despliega desde Windows | Cloudflare no exige integración Git ni repo propio: basta un token de API. Evita el problema de Norton con `workerd`/`esbuild` (sección 7) |
| CLI | **wrangler 4.152.0** (22-oct-2026), solo vía `pnpm dlx` en CI o Codespaces; **no va en ningún `package.json`**. **No usar el nuevo CLI `cf`** | `cf` está en beta abierta desde el 28-sep-2026 y Wrangler se mantendrá 18 meses después del final de esa beta [no verificado en la fuente primaria; https://infoq.com/news/2026/10/cloudflare-cf-cli] |

**Costo total de infraestructura para el hackatón:** 5 USD (Workers Paid) + ~10,46 USD si se compra un `.com` en Cloudflare Registrar [no verificado: precio de terceros, https://costgoat.com/pricing/cloudflare-domains] + Supabase Free (R16). Railway ya no hace falta.

---

## 1. Workers con assets estáticos frente a Pages, y formato de URL

### 1.1 Qué recomienda Cloudflare hoy

- Callout en la portada de Pages: "Start new projects with Workers"; "Workers supports most Pages use cases and offers a broader feature set" [verificado: https://developers.cloudflare.com/pages/]. No hay fecha de deprecación de Pages.
- Funciones que **solo tiene Workers** (guía de migración): Cron Triggers, Queue consumers, Rate Limiting binding, Workers Logs, Tail Workers, Gradual Deployments, `--remote`, Vite plugin, assets en una ruta, rutas que no son raíz. Durable Objects en Pages solo con un Worker aparte. Lo único que Pages tiene y Workers no: dominios propios fuera de zonas de Cloudflare [verificado: https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/].
- Las peticiones a assets estáticos son "free and unlimited"; las que llegan al script se cobran como Workers. Con `run_worker_first`, las rutas que coinciden siempre invocan el Worker, y en Free, al pasar el cupo, reciben 429 en vez de caer a los assets [verificado: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/].
- Assets por versión: 20.000 archivos en Free y 100.000 en Paid; 25 MiB por archivo [verificado: https://developers.cloudflare.com/workers/platform/limits/].

**Conclusión:** VanGUARD necesita Cron, Queues y Workflows, que en Pages no existen o piden un Worker aparte. **Workers con assets, sin discusión.**

### 1.2 Formatos de URL

| Tipo | Formato | Notas |
|---|---|---|
| Producción en workers.dev | `https://<worker>.<subdominio-de-cuenta>.workers.dev` | El subdominio de cuenta se cambia en Workers & Pages → "Your subdomain" → Change [verificado: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/] |
| Preview de versión | `https://<prefijo-de-versión>-<worker>.<subdominio>.workers.dev` | `wrangler versions upload` [verificado: https://developers.cloudflare.com/workers/configuration/previews/] |
| Preview con alias | `https://<alias>-<worker>.<subdominio>.workers.dev` | `wrangler versions upload --preview-alias pr-12` (misma URL) |
| Dominio propio | `https://vanguard.<dominio>` | Requiere "An active Cloudflare zone"; no se puede sobre un hostname que ya tenga CNAME; genera un certificado avanzado [verificado: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/] |
| `*.pages.dev` | No aplica | Descartado (1.1) |

Detalles que muerden:
- Si se agrega `routes` sin poner `workers_dev`, Wrangler lo infiere como `false` en el siguiente deploy: **poner `"workers_dev": true` explícito** para no perder la URL de respaldo [verificado: workers-dev].
- **Las Version URLs no se generan para Workers que implementan un Durable Object** (incluye Containers) [verificado: previews]. Por eso el Worker principal **no** declara Durable Objects.
- Lo que entra por workers.dev **no pasa por nuestra zona**: ni WAF de zona ni analítica de zona. Para el dogfooding hay que entrar por el dominio propio (sección 9).

### 1.3 `deploy-url` (decisión)

1. Hora 1: el orquestador fija el subdominio de cuenta y despliega `vanguard` → `https://vanguard.<subdominio>.workers.dev`. Esta URL queda viva siempre como respaldo.
2. Antes del sábado a las 12:00: dominio en Cloudflare (comprarlo en Cloudflare Registrar deja la zona activa al momento; mover uno externo depende de la propagación de los nameservers [no verificado: tiempo]). Custom Domain `vanguard.<dominio>` para el producto y `demo.<dominio>` para la app víctima.
3. En `platanus-hack-project.jsonc`: `"deploy-url": "https://vanguard.<dominio>"`. Si al domingo 09:00 no hay dominio, se pone la de workers.dev.

---

## 2. Frontend: Next.js con OpenNext frente a SPA Vite + Hono

| Criterio | Next.js 16.4.3 + `@opennextjs/cloudflare` 1.20.13 | **SPA Vite 8.3.5 + React 19.3.1, API Hono 4.13.13** |
|---|---|---|
| Compatibilidad | Dependencia par `next >=15.5.28 <16 \|\| >=16.4.1`, `wrangler ^4.148.0` [verificado: registro npm]. "All minor and patch versions of Next.js 16" [verificado: https://opennext.js.org/cloudflare] | Vite 8 y Hono no dependen del runtime: el SPA es HTML/JS estático y Hono habla `fetch` |
| Tamaño del bundle | Ya no es problema: desde el 4-sep-2026 el límite es **64 MiB sin comprimir en Free y en Paid**, "There is no compressed size limit" [verificado: https://developers.cloudflare.com/workers/platform/limits/; fecha según https://dev.classmethod.jp/en/articles/cloudflare-workers-64mib-size-limit/]. La doc de OpenNext todavía dice 3 MiB / 10 MiB comprimidos (desactualizada) [verificado: https://opennext.js.org/cloudflare/troubleshooting] | Irrelevante: los assets no cuentan como script |
| CPU por petición | Cada página SSR consume CPU del Worker; con 10 ms en Free no es viable [verificado: límites; inferencia propia sobre SSR] | Las páginas son assets gratis; solo `/api/*` gasta CPU |
| Supabase Auth | Necesita `proxy.ts` (Next 16), que es middleware de Node. Issues abiertos hoy: **#1400** "proxy.ts (Node middleware) bundling fails with Could not resolve @opentelemetry/api" y **#1373** "proxy.ts bundles ~4.6MB even for a no-op handler" [verificado: https://github.com/opennextjs/opennextjs-cloudflare/issues?q=proxy.ts] | `supabase-js` en el navegador (PKCE) y `Authorization: Bearer <access_token>` al API, que valida con `getClaims` |
| Windows | "Windows full support is not guaranteed"; recomiendan WSL, VM o CI Linux [verificado: https://opennext.js.org/cloudflare] | Vite 8.3.5 depende de `rolldown` y `lightningcss` (addons `.node`), **no de esbuild** (es dependencia par opcional) [verificado: registro npm de vite 8.3.5] |
| FRONT y BACK en paralelo | Un solo build y un solo artefacto: si uno rompe el build, se cae el despliegue del otro | `apps/web` (FRONT) y `apps/api` (BACK) se compilan por separado; solo los une `@vanguard/contracts` |
| SEO | Sí | No hace falta: el CRM vive detrás de login |

**Veredicto: SPA Vite + React con API Hono en el mismo Worker.** Es lo más seguro para dos chats en paralelo y lo único que el FRONT puede correr en Windows sin binarios de Cloudflare.

Versiones del FRONT (registro npm, 24-oct-2026): `vite` 8.3.5 (21-oct), `@vitejs/plugin-react` 6.1.2 (par `vite ^8.0.0`), `react`/`react-dom` 19.3.1, **`react-router` 7.18.4** (la 8.5.0 salió el 19-oct; no subir de versión mayor en medio del hackatón, misma regla que R16), `@tanstack/react-query` 5.104.5, `tailwindcss` + `@tailwindcss/vite` 4.3.3, `shadcn` 4.22.1 y `recharts` 3.10.1 (R16), `@supabase/supabase-js` 2.118.0, `zod` 4.6.7, `typescript` 6.0.3 (R16: no 7.0.2).

Configuración mínima de `apps/web/vite.config.ts` (proxy al API local en desarrollo):

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // API local en Node (sección 7) o la preview desplegada: VITE_API_PROXY=https://pr-12-vanguard.<sub>.workers.dev
    proxy: { '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:8787', changeOrigin: true },
             '/mcp': { target: process.env.VITE_API_PROXY ?? 'http://localhost:8787', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
```

Variables públicas del FRONT (se hornean en el build): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`. Nada más con prefijo `VITE_`.

---

## 3. Compatibilidad en Workers

**`nodejs_compat`:** con `compatibility_date` igual o posterior a `2026-08-04`, Workers activa `nodejs_compat` y `nodejs_compat_v2` por defecto [verificado: https://developers.cloudflare.com/workers/configuration/compatibility-flags/]. Igual se declara el flag de forma explícita (no estorba y documenta la intención). `node:crypto`, `buffer`, `zlib`, `stream`, `fs` y `net` tienen implementación nativa; **`child_process` y `worker_threads` son stubs que se importan pero no funcionan** [verificado: https://developers.cloudflare.com/workers/runtime-apis/nodejs/].

| Pieza | ¿Funciona en Workers? | Cómo usarla |
|---|---|---|
| `@supabase/supabase-js` 2.118.0 | Sí: "Cloudflare Workers runtime environments are supported" [verificado: https://github.com/supabase/supabase-js] | Cliente admin (`sb_secret_`) en ámbito de módulo con `auth: { persistSession: false, autoRefreshToken: false }`; cliente de usuario por petición con el Bearer. Realtime solo en el navegador |
| `@anthropic-ai/sdk` | Sí: "Cloudflare Workers" está en la lista de runtimes [verificado: https://github.com/anthropics/anthropic-sdk-typescript] | **Se mantiene 0.137.0** (R16/R12). Hoy `latest` es 1.3.0, publicada el 23-oct (1.0.0 el 21-oct) [verificado: registro npm]: no subir |
| WebCrypto: AES-GCM, HKDF, HMAC, SHA-256 | Sí, las cuatro en la tabla oficial; además `crypto.subtle.timingSafeEqual` (extensión no estándar) [verificado: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/] | Cifrado de sobre en 11.2: el mismo código corre en el Worker y en Node 24 |
| ZIP en memoria: `fflate` 0.8.3 | JS puro, sin dependencias [verificado: registro npm]. `unzipSync(datos, { filter(file) {...} })` con `file.name` y `file.originalSize`; clase `Unzip` en streaming [verificado: https://github.com/101arrowz/fflate] | Memoria: **128 MB por isolate**, no por invocación [verificado: límites]. Topes en 11.3: ZIP ≤ 25 MB, archivo ≤ 1 MB, total descomprimido ≤ 60 MB |
| Lockfiles | JSON nativo (`package-lock.json`, `composer.lock`); `yaml` 2.9.1 (`pnpm-lock.yaml`); `smol-toml` 1.9.1 (`Cargo.lock`, `poetry.lock`, `uv.lock`) | JS puro según el registro; no probados en Workers [no verificado] |
| GitHub App (token de instalación) | `@octokit/auth-app` 8.3.1 (R16) firma el JWT con WebCrypto [no verificado] | Guardar la clave privada en **PKCS#8** (`openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem`, con el openssl de Git Bash): WebCrypto no importa PKCS#1 [no verificado para esta librería] |
| `lighthouse` npm | **No**: necesita lanzar Chrome | PSI API (4.3) |
| Postgres por TCP | Existe `connect()` y `net` nativo, pero no hace falta | Todo va por HTTP (PostgREST, Management API de Supabase) |

**Límites que el BACK debe tener a mano (Paid):** CPU 30 s por defecto, configurable hasta 300.000 ms con `limits.cpu_ms`; 10.000 subpeticiones por invocación (Free: 50); **6 conexiones a la vez esperando cabeceras**, la séptima espera en cola; el ámbito global debe ejecutarse en menos de 1 s; 64 variables de entorno en Free y 128 en Paid, de 5 KB cada una [verificado: https://developers.cloudflare.com/workers/platform/limits/]. Cuerpo de petición: 100 MB en zonas Free y Pro (depende del plan de la zona, no del de Workers) [verificado: mismo enlace].

---

## 4. Trabajos largos y programados

### 4.1 Opciones comparadas

| Opción | Límites verificados | ¿Sirve para VanGUARD? |
|---|---|---|
| **Cron Triggers** | Free 5 por cuenta, Paid 250; duración 15 min; CPU en Paid 30 s si el intervalo es menor de 1 h y 15 min si es de 1 h o más [verificado: https://developers.cloudflare.com/workers/platform/limits/]. UTC; `* * * * *` = cada minuto; cambios "may take several minutes (up to 15 minutes) to propagate"; prueba local en `/cdn-cgi/local/scheduled` [verificado: https://developers.cloudflare.com/workers/configuration/cron-triggers/] | **Sí**: reloj de los monitores. Desplegar los crons el sábado temprano por la demora de propagación |
| **Queues** | Disponible en Free con los mismos límites salvo la retención (24 h fija; Paid hasta 14 días); mensaje 128 KB; lote 100; espera máx. del lote 60 s; consumidor 15 min de reloj; 100 reintentos; `delaySeconds` hasta 24 h; 250 consumidores concurrentes; 5.000 msg/s [verificado: https://developers.cloudflare.com/queues/platform/limits/]. Precio: Free 10.000 operaciones/día; Paid 1 millón/mes y luego 0,40 USD por millón [verificado: https://developers.cloudflare.com/workers/platform/pricing/] | **Sí**: un mensaje por conexión activa cada minuto |
| **Workflows** | CPU por paso: Free 10 ms, Paid 30 s (configurable a 5 min); reloj por paso ilimitado; 1.024 pasos (Free) / 10.000 (Paid); resultado de un paso máx. 1 MiB; estado por instancia 100 MB / 1 GB; 100 / 50.000 instancias concurrentes; retención del estado 3 / 30 días [verificado: https://developers.cloudflare.com/workflows/reference/limits/]. Pasos: Free 3.000/día; Paid 500.000/mes incluidos [verificado: pricing] | **Sí**: "Auditar todo", escaneo de repo, ZIP, Lighthouse |
| Durable Objects | Free solo con backend SQLite [verificado: pricing] | **No** en el Worker principal: anula las Version URLs (1.2). Supabase Realtime ya cubre el tiempo real |
| Browser Run (antes Browser Rendering) | Free: 10 min de navegador al día, 3 navegadores concurrentes, uno nuevo cada 20 s, timeout de 60 s (con `keep_alive` hasta 20 min); Paid: sin tope de horas, 200 concurrentes [verificado: https://developers.cloudflare.com/browser-rendering/limits/]. No encontré guía de Lighthouse sobre Browser Run [búsqueda sin resultado] | **No** para Lighthouse: Lighthouse lanza su propio Chrome con `chrome-launcher`. Además, sus peticiones "are always identified as bots" [no verificado: FAQ vista solo en el buscador] |
| Containers | Solo Workers Paid; incluye 25 GiB-h de memoria, 375 vCPU-min y 200 GB-h de disco al mes; `standard-1` = 1/2 vCPU, 4 GiB, 8 GB [verificado: https://developers.cloudflare.com/containers/pricing/]. No dice si es GA o beta | Solo si sobra tiempo (Docker con Chromium como el de R16). El build de la imagen corre en CI. Un Worker con Containers pierde las Version URLs (1.2): iría en un Worker aparte |
| PageSpeed Insights API v5 | `GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed`; funciona "with or without an API key, although a key is recommended"; el resultado viene en `lighthouseResult` [verificado: https://developers.google.com/speed/docs/insights/v5/get-started]. Cuota: 25.000 consultas/día por proyecto [no verificado: solo terceros, https://unlighthouse.dev/learn-lighthouse/pagespeed-insights-api/rate-limits]; sin clave se comparte un pozo global con 429 frecuentes [no verificado] | **Sí**: Lighthouse real en la infraestructura de Google, cero binarios. Solo URLs públicas |
| Observatory de Cloudflare (Speed API) | `GET/POST /zones/{zone_id}/speed_api/pages/{url}/tests`, `/pages/{url}/trend`, `/schedule/{url}` [verificado (buscador): https://developers.cloudflare.com/api/node/resources/speed]. Cuotas en Free [no verificado] | **Extra** para el dogfooding: Lighthouse de nuestra propia zona hecho por Cloudflare |
| GitHub Actions | Linux con Chrome; minutos gratis según el plan del repo [no verificado aquí] | Para medir **tiempos de compilación del repo del cliente**, leer sus runs de Actions con la GitHub App (R13), no correr Lighthouse nuestro |
| Supabase Edge Functions | 256 MB, 2 s de CPU, 150 s de reloj en Free (R16 §1) | **No** |

### 4.2 Reparto (reemplaza la tabla 4.2 de R16)

| Trabajo | Dónde corre | Detalle |
|---|---|---|
| Guardar o probar una conexión, encolar, explicar con IA (streaming), exportar, MCP, webhooks | `fetch` del Worker (Hono) | Paid: CPU de sobra; el tiempo esperando `fetch` no cuenta como CPU |
| Monitores cada 60 s (Supabase métricas, Cloudflare GraphQL) | `scheduled` (`* * * * *`) lee de Supabase las conexiones activas y hace `MONITOR_Q.sendBatch` (máx. 100 por llamada) → `queue` | El consumidor evalúa las reglas puras de `@vanguard/core`, abre el incidente y notifica (Kapso/ElevenLabs) en el mismo paso. **El modelo no decide la alerta** (decisión previa) |
| "Auditar todo", repo, ZIP, Lighthouse | Workflow `vg-scan`, un paso por subtrabajo | Cada paso guarda sus hallazgos en Supabase y **devuelve solo ids o conteos** (máx. 1 MiB por paso). `scan_runs.progress` se actualiza por paso y el trigger de R16 emite el Broadcast |
| Sensor en tiempo real de la app víctima | `tail()` del Worker `vanguard` (sección 9) | Tail Workers: solo Paid, se cobran por CPU [verificado: https://developers.cloudflare.com/workers/observability/logs/tail-workers/] |
| Re-auditoría diaria | Cron `0 10 * * *` (06:00 en Caracas, UTC-4) → `SCAN_WF.create` por org | |
| Limpieza de `metric_samples` (>7 días) | `pg_cron` en Supabase (R16 §5.5) | Sin cambios |

**Consecuencia para R16 §5:** la cola `pgmq` (`enqueue_scan`, `claim_scan_jobs`) **ya no hace falta**: no hay proceso permanente que la sondee. `scan_runs` se queda como estado visible y fuente del Broadcast. `POST /api/scans` inserta la fila `scan_runs` y luego llama `SCAN_WF.create`; si `create` falla, marca la fila como `failed`.

### 4.3 Lighthouse con PSI (paso del Workflow)

```ts
// apps/api/src/scans/psi.ts: corre en un paso del Workflow (reloj ilimitado; esperar a Google no gasta CPU)
type Strategy = 'mobile' | 'desktop';
export async function runPsi(url: string, strategy: Strategy, apiKey: string) {
  const q = new URLSearchParams({ url, strategy, key: apiKey });          // `key=` es la forma documentada
  for (const c of ['performance', 'accessibility', 'best-practices', 'seo']) q.append('category', c);
  const r = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`);
  if (r.status === 429) throw new Error('PSI_429');                       // el Workflow reintenta con backoff
  if (!r.ok) throw new Error(`PSI_${r.status}`);
  const j: any = await r.json();
  const lhr = j.lighthouseResult, a = lhr.audits;
  return {
    final_url: lhr.finalDisplayedUrl ?? lhr.finalUrl,
    lighthouse_version: lhr.lighthouseVersion,
    scores: Object.fromEntries(Object.entries(lhr.categories).map(([k, c]: any) => [k, c.score])),
    metrics: {
      lcp_ms: a['largest-contentful-paint']?.numericValue, cls: a['cumulative-layout-shift']?.numericValue,
      tbt_ms: a['total-blocking-time']?.numericValue, fcp_ms: a['first-contentful-paint']?.numericValue,
      si_ms: a['speed-index']?.numericValue, ttfb_ms: a['server-response-time']?.numericValue,
    },
    field: j.loadingExperience?.metrics ?? null,                          // datos reales de CrUX si el sitio tiene tráfico
  };
}
```

Los parámetros `strategy` y `category` y los ids de auditoría son los de siempre de PSI/Lighthouse, pero la página de inicio no los lista [no verificado hoy]. Antes de llamar: la URL debe pertenecer a un dominio de la org (zona conectada o dominio declarado), para que VanGUARD no sirva de escáner de sitios ajenos. Crear una clave de PSI en un proyecto de Google Cloud del equipo (`PSI_API_KEY`, secreto). PSI tarda decenas de segundos por URL [no verificado]: correr móvil y escritorio como dos pasos. El JSON de respuesta pesa del orden de 1 MB [no verificado]: parsearlo ya supera los 10 ms de CPU de Free, otra razón para Paid.

---

## 5. Almacenamiento de ZIP: R2 frente a Supabase Storage

| Criterio | **R2** | Supabase Storage |
|---|---|---|
| Gratis | 10 GB-mes, 1 M operaciones clase A y 10 M clase B al mes, egreso gratis; solo clase Standard [verificado: https://developers.cloudflare.com/r2/pricing/] | 1 GB en Free (R16 §1) |
| Acceso desde el Worker | Binding nativo (`env.UPLOADS.get/put`), sin claves ni firma | HTTP con `sb_secret_`; descarga = 1 subpetición más |
| Subida | `PUT /api/uploads/zip` del Worker, en streaming a R2 (`env.UPLOADS.put(key, request.body)`) | URL firmada desde el navegador |
| Aislamiento por org | Lo hace el Worker (clave `zips/<org_id>/<scan_id>.zip`, verificada contra el JWT) | Políticas RLS de Storage |
| Requisito | Activar R2 en la cuenta; probablemente pide un medio de pago aunque se quede en el plan gratis [no verificado] (con Workers Paid ya habrá tarjeta) | Ninguno |

**Decisión: R2.** Todo el procesamiento ocurre en el Worker y el binding evita firmas y egreso. Bucket `vanguard-uploads`, regla de ciclo de vida que borra los objetos a 1 día (crearla en el dashboard: R2 → bucket → Settings → Object lifecycle rules [no verificado: ruta exacta]). Tope propio: **25 MB por ZIP** (memoria de 128 MB por isolate). `Content-Length` obligatorio: si falta o supera el tope, 411/413 antes de tocar R2.

---

## 6. Configuración, secretos, entornos y despliegue

### 6.1 `apps/api/wrangler.jsonc` (dueño: orquestador; el BACK agrega bindings)

```jsonc
{
  "$schema": "https://unpkg.com/wrangler@4.152.0/config-schema.json",   // wrangler NO está en ningún package.json (sección 7)
  "name": "vanguard",
  "main": "src/worker.ts",
  "compatibility_date": "2026-10-20",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,                       // explícito: con `routes` se inferiría false
  "preview_urls": true,
  "routes": [ { "pattern": "vanguard.<dominio>", "custom_domain": true } ],   // quitar hasta tener zona
  "assets": {
    "directory": "../web/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/mcp", "/mcp/*", "/webhooks/*"]
  },
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "upload_source_maps": true,
  "limits": { "cpu_ms": 300000 },            // solo Paid; máximo documentado
  "triggers": { "crons": ["* * * * *", "0 10 * * *"] },
  "queues": {
    "producers": [ { "binding": "MONITOR_Q", "queue": "vg-monitor" } ],
    "consumers": [ { "queue": "vg-monitor", "max_batch_size": 10, "max_batch_timeout": 5,
                     "max_retries": 3, "dead_letter_queue": "vg-monitor-dlq" } ]
  },
  "workflows": [ { "name": "vg-scan", "binding": "SCAN_WF", "class_name": "ScanWorkflow" } ],
  "r2_buckets": [ { "binding": "UPLOADS", "bucket_name": "vanguard-uploads" } ],
  "ratelimits": [ { "name": "RL_API", "namespace_id": "1001", "simple": { "limit": 120, "period": 60 } } ],
  "vars": { "VG_ENV": "production", "SUPABASE_URL": "https://<ref>.supabase.co", "APP_ORIGIN": "https://vanguard.<dominio>" }
}
```

Fuentes de cada bloque: `assets`, `not_found_handling`, `run_worker_first` y `upload_source_maps` [verificado: https://developers.cloudflare.com/workers/framework-guides/web-apps/react/]; `workflows` [verificado: https://developers.cloudflare.com/workflows/get-started/guide/]; `ratelimits` (`period` solo 10 o 60, wrangler ≥ 4.36.0, límite aproximado y por ubicación) [verificado: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/]; `observability` [verificado: https://developers.cloudflare.com/workers/observability/logs/workers-logs/]; `limits.cpu_ms` [verificado: límites]; `routes` con `custom_domain` [verificado: custom-domains]. Los nombres de campos de `queues.consumers` (`max_batch_size`, `max_batch_timeout`, `max_retries`, `dead_letter_queue`) son los de la doc de Queues que conozco [no verificado hoy]. Workers Logs: Free 200.000 eventos/día con 3 días de retención; Paid 20 M/mes con 7 días; desde el 1-dic-2026 cambia el precio [verificado: workers-logs].

Recursos que se crean una sola vez (desde CI con `workflow_dispatch`, o desde Codespaces; ver 6.4 y 7):

```sh
# en apps/api, con CLOUDFLARE_API_TOKEN y CLOUDFLARE_ACCOUNT_ID en el entorno (CI o Codespaces, nunca Windows)
pnpm dlx wrangler@4.152.0 queues create vg-monitor
pnpm dlx wrangler@4.152.0 queues create vg-monitor-dlq
pnpm dlx wrangler@4.152.0 r2 bucket create vanguard-uploads
pnpm dlx wrangler@4.152.0 types --env-interface CloudflareBindings
```

Los Workflows se crean solos al desplegar [no verificado]. `wrangler types --env-interface CloudflareBindings` genera la interfaz de bindings y evita chocar con el tipo `Env` de Hono [verificado: https://hono.dev/docs/getting-started/cloudflare-workers]. El archivo generado (`worker-configuration.d.ts`) se versiona en el repo, para que el Windows de nadie tenga que correr wrangler.

### 6.2 Secretos y variables

- **Secretos** (cifrados, nunca en el repo): `wrangler secret put <NOMBRE>` crea una versión nueva y la despliega al momento; `wrangler secret delete <NOMBRE>`. Se leen como `env.NOMBRE` o con `import { env } from "cloudflare:workers"` [verificado: https://developers.cloudflare.com/workers/configuration/secrets/].
- **Local:** `.dev.vars` **o** `.env` (uno de los dos, no ambos); por entorno, `.dev.vars.<entorno>`. Agregar `.dev.vars*` y `.env*` a `.gitignore` [verificado: mismo enlace]. Hoy el `.gitignore` del repo solo tiene `/docs` (R16 §11.4).
- **Variables no secretas:** bloque `vars` del `wrangler.jsonc`.
- **Secrets Store** (secretos a nivel de cuenta) existe como binding [verificado: secrets]; no hace falta con un solo Worker.

| Nombre | Tipo | Dónde | Nota |
|---|---|---|---|
| `SUPABASE_URL`, `VG_ENV`, `APP_ORIGIN` | var | `wrangler.jsonc` | |
| `SUPABASE_SECRET_KEY` (`sb_secret_...`) | secreto | Worker | Salta RLS; solo servidor |
| `VG_KEK_PEPPER` (32 bytes base64) | secreto | Worker | Mitad de la KEK (11.2); la otra mitad en Supabase Vault |
| `VG_FP_PEPPER` | secreto | Worker | HMAC de huellas |
| `ANTHROPIC_API_KEY`, `AI_BUDGET_USD` | secreto / var | Worker | Tope de gasto en R12 |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY_B64` (PKCS#8), `GITHUB_WEBHOOK_SECRET` | secreto | Worker | |
| `KAPSO_*`, `ELEVENLABS_*` | secreto | Worker | Nombres exactos en R14 |
| `PSI_API_KEY` | secreto | Worker | 4.3 |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | variable de Actions (`vars`) | build del FRONT | Públicas |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | secreto de Actions | CI | Token de despliegue (plantilla "Edit Cloudflare Workers" + permisos de Queues y R2 para el bootstrap [no verificado: lista exacta]). **Distinto** del token de solo lectura con el que VanGUARD monitorea nuestra zona (R10 §1.2) |

**Entornos:** no se usan bloques `env.*` (crean Workers separados con bindings que hay que repetir [no verificado]). Producción = la versión desplegada de `vanguard`; previews = Version URLs con alias por PR. Las previews comparten bindings y secretos con producción, es decir, la misma base. Los crons y los consumidores de cola solo corren en la versión desplegada [no verificado: la página de previews no menciona cron ni colas], así que una preview no dispara notificaciones. Aun así, `POST /api/notifications/test` responde 403 si `new URL(req.url).hostname` no es el de producción.

### 6.3 GitHub Actions: `.github/workflows/deploy.yml` (reemplaza el trabajo `mirror` de R16 §11.5)

```yaml
name: deploy
on:
  push: { branches: [main] }
  pull_request:
  workflow_dispatch:
concurrency: { group: deploy-${{ github.ref }}, cancel-in-progress: true }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck && pnpm test
      - run: pnpm --filter @vanguard/web build
        env:
          VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}
          VITE_SUPABASE_PUBLISHABLE_KEY: ${{ vars.VITE_SUPABASE_PUBLISHABLE_KEY }}
      - name: Producción (main)
        if: github.event_name != 'pull_request'
        working-directory: apps/api
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          SUPABASE_SECRET_KEY: ${{ secrets.SUPABASE_SECRET_KEY }}
          VG_KEK_PEPPER: ${{ secrets.VG_KEK_PEPPER }}
          VG_FP_PEPPER: ${{ secrets.VG_FP_PEPPER }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          PSI_API_KEY: ${{ secrets.PSI_API_KEY }}
        run: |
          umask 077
          f="$RUNNER_TEMP/secrets.env"
          for k in SUPABASE_SECRET_KEY VG_KEK_PEPPER VG_FP_PEPPER ANTHROPIC_API_KEY PSI_API_KEY; do
            printf '%s=%s\n' "$k" "${!k}" >> "$f"
          done
          pnpm dlx wrangler@4.152.0 deploy --secrets-file "$f"
          rm -f "$f"
      - name: Preview por PR
        if: github.event_name == 'pull_request'
        working-directory: apps/api
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: pnpm dlx wrangler@4.152.0 versions upload --preview-alias pr-${{ github.event.number }}
```

Por qué `pnpm dlx` y no una dependencia: **wrangler no va en ningún `package.json`**, así ningún `pnpm install` en Windows descarga `workerd` ni `esbuild` (sección 7). `--secrets-file` funciona en `wrangler deploy` y en `wrangler versions upload`, acepta JSON o `.env` (hasta 100 secretos) y "Secrets not included in the file are preserved from the previous version" [verificado: https://developers.cloudflare.com/workers/configuration/secrets/]. Los valores con saltos de línea van en base64 (p. ej. `GITHUB_APP_PRIVATE_KEY_B64`). El resto de secretos (GitHub App, Kapso, ElevenLabs) se agrega al `env` y al `for`. Bootstrap de 6.1: un segundo job con `if: github.event_name == 'workflow_dispatch'` que corre los cuatro comandos una sola vez.

Alternativa equivalente: `cloudflare/wrangler-action@v4.1.3` (24-sep-2026), con `apiToken`, `accountId`, `workingDirectory: apps/api`, `packageManager: pnpm`, `command: deploy`, `secrets:` (lista de nombres que deben estar en `env`) y `wranglerVersion: "4.152.0"`; v4 usa Wrangler v4 por defecto y, si se omite `wranglerVersion` y Wrangler ya está instalado, usa esa instalación [verificado: https://github.com/cloudflare/wrangler-action]. Cómo instala Wrangler dentro de un workspace pnpm que no lo declara [no verificado]: por eso el camino principal es `pnpm dlx`. Versiones de acciones: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `pnpm/action-setup` v6.1.0 [verificado: API de GitHub].

### 6.4 Desde dónde se despliega

| Camino | Requisito | Estado |
|---|---|---|
| **A. Actions en el repo de la organización** (recomendado) | Que algún integrante pueda crear **secretos de Actions a nivel de repo** en el repo de `platanus-hack` | [no verificado: permisos que dio Platanus]. Cloudflare no pide integración Git: solo el token |
| B. Repo espejo personal + el mismo `deploy.yml` | Espejo como en R16 §11.1 (opción B manual: `git push deploy main`) | Siempre funciona |
| C. Workers Builds (integración Git de Cloudflare) | Instalar la GitHub App "Cloudflare Workers & Pages"; en una organización, el usuario "must be an owner or have the appropriate role" (p. ej. GitHub Apps Manager). Comenta el estado del build en los PR; una cuenta de GitHub debería apuntar a una sola cuenta de Cloudflare [verificado: https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/] | Sobre el repo de la org casi seguro **no** (nadie del equipo es owner); sobre el espejo personal sí. Respaldo de B |
| D. `wrangler deploy` a mano | Máquina Linux/macOS o Codespaces (sección 7) | Emergencia |

---

## 7. Windows con Norton: cómo trabajar sin `workerd` ni `esbuild` locales

**De dónde salen los ejecutables:** `wrangler` 4.152.0 depende de `esbuild` y `workerd`; `@cloudflare/vite-plugin` 1.65.0 depende de `wrangler` y `miniflare`; `agents` 0.30.1 depende de `esbuild`; `@opennextjs/cloudflare` depende de `@ast-grep/napi` (addon nativo) [verificado: registro npm]. En Windows, `esbuild` y `workerd` se instalan como `.exe` sin firma conocida [no verificado: firma]. Vite 8.3.5 **no** necesita esbuild [verificado: registro npm]; usa `rolldown` y `lightningcss`, que son addons `.node` cargados por `node.exe`, no ejecutables sueltos (si Norton también los bloquea, avisar al orquestador) [no verificado contra Norton].

**Reglas para el equipo:**
1. **Ningún `package.json` del repo declara `wrangler`, `@cloudflare/vite-plugin`, `miniflare`, `agents` ni `@cloudflare/vitest-pool-workers`.** Wrangler solo existe en CI o Codespaces vía `pnpm dlx wrangler@4.152.0`. Los tipos vienen de `@cloudflare/workers-types` 5.20261024.1 (solo `.d.ts`) y del `worker-configuration.d.ts` generado y versionado.
2. **FRONT** (`apps/web`): `pnpm --filter @vanguard/web dev` → Vite en `http://localhost:5173`, con proxy de `/api` y `/mcp` al API local (punto 3) o a la preview del PR (`VITE_API_PROXY=https://pr-12-vanguard.<sub>.workers.dev`).
3. **BACK** (`apps/api`): el mismo `app` de Hono corre en Node 24 con `@hono/node-server` 2.1.5: `node --env-file=.dev.vars --watch src/dev-node.ts`. Node 24 quita los tipos de TypeScript sin compilar: activo por defecto desde 22.18/23.6 y estable desde 24.12; solo sintaxis "borrable" y **nunca** dentro de `node_modules` [verificado (buscador): changelog de https://nodejs.org/download/nightly/v27.0.0-nightly202609268812357aff/docs/api/typescript.md]. Así no hace falta `tsx` (que usa esbuild). `tsconfig` del API: `"erasableSyntaxOnly": true`, `"allowImportingTsExtensions": true`, `"noEmit": true`, `"verbatimModuleSyntax": true`, e imports relativos con extensión `.ts`. Los paquetes del workspace (`@vanguard/core`, `@vanguard/contracts`) exportan `./src/index.ts`; pnpm los enlaza con symlink y Node resuelve la ruta real fuera de `node_modules` [no verificado: probar en la hora 1; si falla, `tsc -b`, que es JavaScript puro].
4. En Node los bindings se reemplazan por dobles simples (11.4): la cola llama al consumidor en línea, R2 es un `Map`, el Workflow ejecuta los pasos seguidos y el rate limit siempre deja pasar. La clase `ScanWorkflow` (que importa `cloudflare:workers`) vive en `src/workflow.ts` y solo la importa `src/worker.ts`; la lógica de cada paso vive en funciones puras de `src/scans/*.ts`.
5. **Pruebas:** Vitest 4.1.12 en Node para `core`, `contracts` y `scans` (R16 §11.6). Nada de `@cloudflare/vitest-pool-workers` (necesita `workerd`).
6. **Integración real:** cada PR publica una Version URL con alias (6.3). Logs en el dashboard (Workers & Pages → `vanguard` → Observability), no con `wrangler tail`.
7. **Si alguien necesita `wrangler dev` de verdad:** GitHub Codespaces (Linux) sobre el **repo espejo personal**. GitHub Free incluye 120 h de cómputo y 15 GB-mes al mes; en repos de una organización paga la org o el creador, según la configuración de la org [verificado: https://docs.github.com/en/billing/concepts/product-billing/github-codespaces]. WSL2 es otra opción [no verificado: si Norton escanea dentro del disco de WSL].
8. **Ningún agente toca la configuración de Norton** (exclusiones, listas blancas): es un ajuste de seguridad del dueño del equipo. Si el dueño decide excluir una carpeta, lo hace él.

---

## 8. Qué exige pagar Workers Paid (5 USD/mes) y qué cabe en Free

| Necesidad de VanGUARD | Free | Paid | ¿Hace falta Paid? |
|---|---|---|---|
| CPU por invocación (escaneo, parseo de JSON de PSI y de GraphQL, reglas) | 10 ms | 30 s por defecto, hasta 5 min | **Sí** |
| Subpeticiones por invocación (auditoría que llama a muchas APIs) | 50 | 10.000 | **Sí** |
| CPU por paso de Workflow | 10 ms | 30 s a 5 min | **Sí** |
| Tail Workers (sensor de la víctima, sección 9) | No | Sí | **Sí** para el dogfooding en tiempo real |
| Containers (Lighthouse propio, opcional) | No | Sí | Solo si se usa |
| Peticiones | 100.000/día | 10 M/mes incluidos, luego 0,30 USD por millón | No |
| Assets estáticos | Gratis e ilimitados | Igual | No |
| Cron Triggers | 5 por cuenta | 250 | No (usamos 2) |
| Queues | 10.000 operaciones/día; retención 24 h | 1 M/mes; hasta 14 días | No, pero un cron por minuto con N conexiones gasta ~3 operaciones por mensaje [no verificado: cuántas operaciones cuenta un mensaje] |
| Workers Logs | 200.000 eventos/día, 3 días | 20 M/mes, 7 días | No |
| R2 | 10 GB-mes gratis | Igual | No |
| Dominio propio y Custom Domain | Sí (zona Free) | Igual | No |

Fuentes: [verificado: https://developers.cloudflare.com/workers/platform/limits/, https://developers.cloudflare.com/workers/platform/pricing/, https://developers.cloudflare.com/workflows/reference/limits/, https://developers.cloudflare.com/workers/observability/logs/tail-workers/, https://developers.cloudflare.com/containers/pricing/]. CPU incluida en Paid: 30 M ms/mes, luego 0,02 USD por millón de ms: el hackatón no llega a pagar nada aparte de los 5 USD [cálculo propio]. **Decisión que toma hoy el orquestador:** quién pone la tarjeta para los 5 USD (y el dominio). La página de límites de Queues dice que Free tiene "los mismos límites salvo la retención", lo que incluiría 30 s de CPU para consumidores; la de Workers dice 10 ms en Free. Contradicción sin resolver: se asume lo peor.

---

## 9. Dogfooding: VanGUARD vigila su propia zona en la demo

**Por qué funciona:** el módulo Cloudflare (R10) lee la analítica GraphQL de una **zona** (`httpRequestsAdaptiveGroups`, `firewallEventsAdaptive`) y actúa con IP Access Rules y reglas custom del WAF. Si nuestra app y la víctima cuelgan de una zona nuestra, todo se demuestra en vivo sin tocar cuentas ajenas.

### 9.1 Montaje (una sola cuenta de Cloudflare)

| Pieza | Qué es | Detalle |
|---|---|---|
| Zona `<dominio>` | Plan Free | Comprada en Cloudflare Registrar o con los nameservers ya en Cloudflare |
| `vanguard.<dominio>` | Custom Domain del Worker `vanguard` (el producto) | sección 6.1 |
| `demo.<dominio>` | Custom Domain de un **segundo Worker `vanguard-victima`** (Hono, ~80 líneas: `/`, `/login`, `/api/productos`, sin rate limit a propósito, contra el proyecto Supabase de demo de R16) | Su `wrangler.jsonc` lleva `"tail_consumers": [{ "service": "vanguard" }]` |
| Conexión "Cloudflare" en VanGUARD | Token de **solo lectura** de la zona (permisos de R10 §1.2) + token aparte con permiso de escritura para la acción, que se pide al confirmar | Lo carga el jurado o el equipo desde la UI, igual que un cliente |
| Sensor en tiempo real | `tail()` en `vanguard`: recibe cada petición de la víctima con `event.request.url`, `method`, `headers` y `cf`, más `outcome`, `logs` y `exceptions` [verificado: https://developers.cloudflare.com/workers/observability/logs/tail-workers/] | Cuenta por IP (cabecera `cf-connecting-ip` [no verificado que llegue sin redactar]) y por user agent en ventanas de 10 s, y escribe en `metric_samples`. Así la regla dispara en segundos sin esperar a GraphQL. Solo sirve para Workers de **nuestra** cuenta (`tail_consumers` apunta a un `service` de la misma cuenta [inferencia]); para clientes se usa GraphQL (R10) |
| Hosting propio | GraphQL `workersInvocationsAdaptive` (filtros `scriptName`, `datetime_geq`/`datetime_leq`; `sum { requests subrequests errors }`, `quantiles { cpuTimeP50 cpuTimeP99 }`, dimensiones `datetime scriptName status`) [verificado: https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/] | Tarjeta "Salud de tus Workers" (errores y CPU p99 de `vanguard` y `vanguard-victima`): adelanto del módulo de hosting que después cubrirá Vercel |
| Lighthouse propio | Observatory (`/zones/{zone_id}/speed_api/...`) sobre `vanguard.<dominio>` + PSI | Contraste "Lighthouse de Google contra Lighthouse de Cloudflare" en la pestaña Rendimiento |

### 9.2 Guion de la demo (2 minutos)

1. Panel de VanGUARD con la zona en verde. Un integrante lanza desde su laptop, **conectado al hotspot de un teléfono** (si se bloquea la IP del wifi del evento, se cae todo el equipo), `node scripts/ataque.mjs https://demo.<dominio> --rps 20 --segundos 90 --ua "sqlmap/1.8"` (fetch de Node; sin binarios).
2. El `tail()` cuenta y la regla CF-IP-FLOOD / UA insistente (umbrales de R10 §2.5) abre el incidente en menos de 10 s [objetivo propio]. El Broadcast pinta la línea de tiempo y llegan el WhatsApp de Kapso y la llamada de ElevenLabs (R14).
3. Botón grande "Bloquear esta IP" → confirmación → `POST /zones/{zone_id}/firewall/access_rules/rules` (R10 §4.1). El atacante empieza a recibir 403. Que el WAF actúe antes que el Worker es lo esperado [no verificado: la página de Custom Domains no lo dice; **probarlo el sábado**].
4. La pestaña Cloudflare muestra el bloqueo en `firewallEventsAdaptive` y el pico en `httpRequestsAdaptiveGroups`, con 1 a 3 minutos de retraso [no verificado: latencia de la analítica]. Si no llegó a tiempo, se muestra la vista del sensor.
5. Claude genera el prompt de corrección ("agrega una regla de rate limit a `/login`") y se exporta el informe.
6. Al terminar: `DELETE` de la regla de IP.

Sin dominio, la demo se queda con el sensor `tail()` y con `workersInvocationsAdaptive` sobre workers.dev; el bloqueo pasaría a ser una lista negra dentro de la víctima (menos vistoso). Sobre pruebas de carga contra zonas propias no encontré una política oficial de Cloudflare [búsqueda sin resultado]: tráfico moderado (≤ 20 peticiones/s durante ≤ 2 min) y solo contra `demo.<dominio>`.

---

## 10. Qué cambia respecto de R16 (manda R17)

| Tema | R16 | R17 |
|---|---|---|
| Web | Next.js 16.4 en Vercel (`vanguard-sec.vercel.app`) | SPA Vite 8.3.5 + React 19.3.1 + `react-router` 7.18.4 como assets del Worker `vanguard` |
| BFF | Route handlers de Next + `@supabase/ssr` + `proxy.ts` | Hono 4.13.13 en el mismo Worker. La sesión vive en el navegador (`supabase-js`, PKCE) y el API recibe `Authorization: Bearer`, que valida con `supabase.auth.getClaims(token)` (R16 §4.3 sigue valiendo: primero claims y rol, después el cliente admin) |
| Trabajos largos | Railway (Docker con Node 24 y Chromium) | Cron → Queue (monitores) y Workflow `vg-scan` (escaneos). **Sin Railway** |
| Cola | `pgmq` + `enqueue_scan` / `claim_scan_jobs` | Cloudflare Queues y Workflows; `scan_runs` se queda en Supabase como estado y fuente del Broadcast |
| Lighthouse | `lighthouse` + `chrome-launcher` en Docker | PSI API v5 (+ Observatory de nuestra zona). El anti-SSRF de R16 pasa a ser una "lista de dominios de la org" |
| ZIP | Supabase Storage con URL firmada | R2 `vanguard-uploads` a través del Worker, tope de 25 MB |
| MCP | `mcp-handler` 2.3.0 en `/api/mcp` | `@modelcontextprotocol/server` 2.3.1 + `WebStandardStreamableHTTPServerTransport` en `/mcp` (mismas herramientas y tokens `vgk_` de R16 §10) |
| Cifrado | `node:crypto` | WebCrypto (11.2), mismo esquema: sobre AES-256-GCM, KEK = HKDF(secreto de Vault, pimienta), HMAC como huella. Corre igual en el Worker y en Node 24 |
| Despliegue | Vercel Hobby + Railway desde el espejo personal | GitHub Actions + `pnpm dlx wrangler@4.152.0` desde el repo de la org; el espejo queda como plan B |
| Costo | Railway 5 USD | Workers Paid 5 USD (+ dominio ~10,46 USD) |
| **Se mantiene** | Supabase (RLS por `org_id`, Vault, Realtime Broadcast, `pg_cron`, claves `sb_publishable_`/`sb_secret_`), `@vanguard/contracts` con zod 4.6.7, `@vanguard/core` con reglas puras, Node 24, pnpm 10.34.7, TypeScript 6.0.3, Tailwind 4.3.3, shadcn 4.22.1, Recharts 3.10.1, Vitest 4.1.12, `@anthropic-ai/sdk` 0.137.0, GitHub App de solo lectura | |

Árbol del monorepo (ajuste de R16 §9.1):

```
apps/web        (FRONT)  Vite + React; sin dependencias de Cloudflare
apps/api        (BACK)   src/app.ts (Hono), src/worker.ts (fetch/scheduled/queue/tail), src/workflow.ts,
                         src/scans/*.ts, src/dev-node.ts, wrangler.jsonc, worker-configuration.d.ts
apps/victima    (BACK)   Worker de demo con tail_consumers -> vanguard (sección 9)
packages/contracts, packages/core   (sin cambios de dueño)
supabase/       (BACK)   migraciones; se quitan las de pgmq
scripts/ataque.mjs (orquestador)
.github/workflows/deploy.yml (orquestador)
```

---

## 11. Código portable (TypeScript)

### 11.1 `apps/api/src/worker.ts` (entrada del Worker)

```ts
import { app } from './app.ts';                        // Hono: rutas /api/*, /mcp, /webhooks/*
import { fanOutMonitors, runMonitor, type MonitorMsg } from './monitors.ts';
import { ingestTail } from './sensor.ts';
import { startScheduledAudits } from './scans/schedule.ts';
export { ScanWorkflow } from './workflow.ts';          // la clase debe exportarse desde el módulo principal [no verificado]

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    if (controller.cron === '* * * * *') ctx.waitUntil(fanOutMonitors(env));      // lee conexiones activas y hace MONITOR_Q.sendBatch
    if (controller.cron === '0 10 * * *') ctx.waitUntil(startScheduledAudits(env));
  },
  async queue(batch, env) {
    for (const m of batch.messages) {
      try { await runMonitor(env, m.body); m.ack(); }
      catch { m.retry({ delaySeconds: 30 }); }
    }
  },
  async tail(events, env, ctx) { ctx.waitUntil(ingestTail(env, events)); },
} satisfies ExportedHandler<CloudflareBindings, MonitorMsg>;
```

`app.fetch` exportado junto a `scheduled` sigue el patrón de Hono [verificado: https://hono.dev/docs/getting-started/cloudflare-workers]; `scheduled(controller, env, ctx)` [verificado: cron-triggers]; `queue`, `tail`, `m.ack()` y `m.retry()` siguen las firmas de la doc de Workers que conozco [no verificado hoy]; `tail(events)` [verificado: tail-workers].

`apps/api/src/workflow.ts`:

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { auditSupabase, auditCloudflare, scanRepo, scanZip, lighthouse, summarize, setProgress } from './scans/index.ts';

type ScanParams = { scanRunId: string; orgId: string; kind: 'full_audit' | 'supabase' | 'cloudflare' | 'repo' | 'zip' | 'lighthouse'; zipKey?: string };
const R = { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' as const } };

export class ScanWorkflow extends WorkflowEntrypoint<CloudflareBindings, ScanParams> {
  async run(event: WorkflowEvent<ScanParams>, step: WorkflowStep) {
    const p = event.payload, env = this.env, all = p.kind === 'full_audit';
    if (all || p.kind === 'supabase')   await step.do('supabase', R, () => auditSupabase(env, p));     // devuelve {findings: n}
    if (all || p.kind === 'cloudflare') await step.do('cloudflare', R, () => auditCloudflare(env, p));
    if (all || p.kind === 'repo')       await step.do('repo', R, () => scanRepo(env, p));             // zipball de GitHub, mismo escáner que ZIP
    if (p.kind === 'zip')               await step.do('zip', { retries: { limit: 0, delay: '1 second' } }, () => scanZip(env, p.zipKey!, p));
    if (all || p.kind === 'lighthouse') {
      await step.do('psi-mobile', R, () => lighthouse(env, p, 'mobile'));
      await step.do('psi-desktop', R, () => lighthouse(env, p, 'desktop'));
    }
    await step.do('resumen-ia', R, () => summarize(env, p));   // Claude: resumen y prompts de corrección (R12)
    await step.do('fin', () => setProgress(env, p.scanRunId, 100, 'done'));
  }
}
```

Firma de clase, `run(event, step)`, `step.do` con `retries { limit, delay, backoff }` y el bloque `workflows` [verificado: https://developers.cloudflare.com/workflows/get-started/guide/]. Desde `POST /api/scans`: `await c.env.SCAN_WF.create({ id: scanRunId, params })` (la forma `{ id, params }` [no verificado: la guía muestra `create()` sin argumentos]) y `await (await c.env.SCAN_WF.get(id)).status()` [verificado: misma guía]. Cada paso escribe en Supabase y actualiza `scan_runs.progress` él mismo; ningún paso devuelve más de 1 MiB.

### 11.2 Cifrado de sobre con WebCrypto (`packages/core/src/crypto.ts`, reemplaza R16 §7.4)

```ts
const te = new TextEncoder(), td = new TextDecoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));          // solo para valores cortos
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export type Box = { v: 1; kid: string; iv: string; ct: string; ivk: string; wdek: string };

/** KEK = HKDF-SHA256(ikm = secreto de Vault, salt = pimienta de entorno, info = "vanguard/kek/<kid>"). Cachear 10 min por isolate. */
export async function deriveKek(vaultB64: string, pepperB64: string, kid = 'v1'): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', unb64(vaultB64), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: unb64(pepperB64), info: te.encode(`vanguard/kek/${kid}`) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
/** aad = `${orgId}|${connectionId}|${provider}`: descifrar con otra org o conexión falla. */
export async function seal(kek: CryptoKey, plaintext: string, aad: string, kid = 'v1'): Promise<Box> {
  const ad = te.encode(aad), dekRaw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12)), ivk = crypto.getRandomValues(new Uint8Array(12));
  const dek = await crypto.subtle.importKey('raw', dekRaw, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, dek, te.encode(plaintext)));
  const wdek = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivk, additionalData: ad }, kek, dekRaw));
  dekRaw.fill(0);
  return { v: 1, kid, iv: b64(iv), ct: b64(ct), ivk: b64(ivk), wdek: b64(wdek) };
}
export async function open(kek: CryptoKey, box: Box, aad: string): Promise<string> {
  const ad = te.encode(aad);
  const dekRaw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.ivk), additionalData: ad }, kek, unb64(box.wdek)));
  const dek = await crypto.subtle.importKey('raw', dekRaw, 'AES-GCM', false, ['decrypt']);
  dekRaw.fill(0);
  return td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: ad }, dek, unb64(box.ct)));
}
/** Huella: HMAC-SHA256(pimienta de huellas, secreto) en hex. Para deduplicar y detectar fugas; nunca para descifrar. */
export async function fingerprint(fpPepperB64: string, secret: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', unb64(fpPepperB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, te.encode(secret)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}
```

Usa solo AES-GCM, HKDF, HMAC y `getRandomValues`, todos soportados en Workers [verificado: web-crypto] y presentes como `globalThis.crypto` en Node 24 [no verificado hoy]. El secreto de Vault se lee con la RPC de solo servidor de R16 §7.3 y la KEK derivada se guarda en una variable de módulo durante 10 minutos (un isolate atiende muchas peticiones). Prueba obligatoria (R16 §11.6): cambiar 1 byte de `ct` o usar otro `aad` debe lanzar.

### 11.3 Subida y escaneo de ZIP (`apps/api/src/scans/zip.ts`)

```ts
import { unzipSync } from 'fflate';
const MAX_ZIP = 25 * 1024 * 1024, MAX_FILE = 1_000_000, MAX_TOTAL = 60 * 1024 * 1024, MAX_ENTRIES = 20_000;
const SKIP = /(^|\/)(node_modules|\.git|dist|build|vendor|\.next|coverage)\//;

// Hono: app.put('/api/uploads/zip/:scanRunId', auth, async (c) => {...})
export async function putZip(env: CloudflareBindings, req: Request, orgId: string, scanRunId: string) {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (!len) return new Response('falta Content-Length', { status: 411 });
  if (len > MAX_ZIP) return new Response('ZIP mayor de 25 MB', { status: 413 });
  const key = `zips/${orgId}/${scanRunId}.zip`;
  await env.UPLOADS.put(key, req.body, { httpMetadata: { contentType: 'application/zip' } });
  return Response.json({ key }, { status: 201 });
}

export async function readZip(env: CloudflareBindings, key: string) {
  const obj = await env.UPLOADS.get(key);
  if (!obj) throw new Error('ZIP_NOT_FOUND');
  const buf = new Uint8Array(await obj.arrayBuffer());
  let entries = 0, total = 0;
  const files = unzipSync(buf, {
    filter(f) {
      if (++entries > MAX_ENTRIES) throw new Error('ZIP_TOO_MANY_ENTRIES');
      if (f.name.startsWith('/') || f.name.split('/').includes('..')) return false;   // rutas hostiles
      if (SKIP.test(f.name) || f.originalSize > MAX_FILE) return false;
      if ((total += f.originalSize) > MAX_TOTAL) throw new Error('ZIP_TOO_BIG_UNCOMPRESSED');
      return true;
    },
  });
  return files;   // Record<ruta, Uint8Array>: aquí corren .gitignore, .env subido, secretos y lockfiles (R11)
}
```

`unzipSync` con `filter(file)` y `file.originalSize` [verificado: README de fflate]. `env.UPLOADS.put(key, req.body)` con un cuerpo de longitud conocida es el patrón de la API de R2 en Workers [no verificado hoy]. `originalSize` lo declara el propio ZIP y puede mentir: el peor caso es que el isolate se quede sin memoria y el paso falle (por eso el paso `zip` no reintenta).

### 11.4 Servidor local en Node (`apps/api/src/dev-node.ts`, solo desarrollo)

```ts
import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { runMonitor } from './monitors.ts';
import { runScanInline } from './scans/index.ts';

const r2 = new Map<string, Uint8Array>();
const env = {
  ...process.env,                                                       // .dev.vars cargado con --env-file
  MONITOR_Q: { send: async (m: unknown) => runMonitor(env as any, m as any), sendBatch: async (ms: { body: unknown }[]) => { for (const m of ms) await runMonitor(env as any, m.body as any); } },
  SCAN_WF: { create: async ({ id, params }: any) => { queueMicrotask(() => runScanInline(env as any, params)); return { id }; } },
  UPLOADS: { put: async (k: string, body: ReadableStream) => { r2.set(k, new Uint8Array(await new Response(body).arrayBuffer())); },
             get: async (k: string) => (r2.has(k) ? new Response(r2.get(k)) : null) },
  RL_API: { limit: async () => ({ success: true }) },
};
serve({ fetch: (req) => app.fetch(req, env as any), port: 8787 });
console.log('API local en http://localhost:8787');
```

`serve({ fetch, port })` de `@hono/node-server` [no verificado hoy para la 2.1.5]. Se corre con `node --env-file=.dev.vars --watch src/dev-node.ts`.

### 11.5 MCP en Hono (`apps/api/src/mcp.ts`)

```ts
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
// app.all('/mcp', mcpTokenAuth, (c) => handleMcp(c.req.raw, c.env, c.get('orgId')))
export async function handleMcp(req: Request, env: CloudflareBindings, orgId: string) {
  const server = new McpServer({ name: 'vanguard', version: '1.0.0' });
  registerVanguardTools(server, env, orgId);           // las herramientas de R16 §10, filtradas por org
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });   // sin estado
  await server.connect(transport);
  return transport.handleRequest(req);
}
```

Calcado del ejemplo "Hono.js" de los tipos del paquete [verificado: https://unpkg.com/@modelcontextprotocol/server@2.3.1/dist/index.d.mts]. La opción `enableJsonResponse` también existe [verificado: mismo archivo].

---

## Implicaciones para el plan

**Adoptar**
1. Un Worker `vanguard` con assets (SPA) y API Hono en el mismo origen; `run_worker_first` para `/api/*`, `/mcp` y `/webhooks/*`; `not_found_handling: "single-page-application"`.
2. **Workers Paid desde el sábado temprano** (5 USD) y, si se puede, un dominio en Cloudflare Registrar (~10,46 USD) para `vanguard.<dominio>` y `demo.<dominio>`.
3. Cron `* * * * *` → Queue `vg-monitor` para los monitores; Workflow `vg-scan` para auditoría, repo, ZIP y Lighthouse; Tail Worker como sensor de la víctima.
4. PSI API v5 (con clave) para Lighthouse; Observatory sobre nuestra zona como contraste.
5. R2 `vanguard-uploads` (25 MB por ZIP, ciclo de vida de 1 día).
6. Deploy solo desde GitHub Actions (ubuntu) con `pnpm dlx wrangler@4.152.0`; previews por PR con `versions upload --preview-alias`; secretos con `--secrets-file`.
7. Windows: FRONT con Vite puro; BACK con Hono en Node 24 (type stripping); wrangler fuera de todo `package.json`.
8. Dogfooding en la demo: atacar `demo.<dominio>`, detectar con `tail()`, bloquear con IP Access Rule, confirmar en GraphQL.

**Evitar**
- Pages, Next.js/OpenNext (bugs abiertos de `proxy.ts`), `@cloudflare/vite-plugin` y `agents` en el workspace (traen `workerd`/`esbuild`), el CLI `cf` (beta).
- Durable Objects o Containers en el Worker principal (se pierden las Version URLs).
- Lighthouse dentro de un Worker o con Browser Run; Supabase Edge Functions para escaneos; `pgmq` (ya no hace falta).
- Devolver más de 1 MiB desde un paso de Workflow; ZIP de más de 25 MB; confiar en los 10 ms de Free.
- Bloquear la IP del wifi del evento en la demo (usar hotspot).
- Pedir a un agente que toque Norton.

**Riesgos**

| Riesgo | Prob. | Mitigación |
|---|---|---|
| Nadie paga Workers Paid y todo corre con 10 ms de CPU | Media | Decidirlo antes de las 10:00 del sábado; sin Paid no hay escaneos, Workflows útiles ni Tail Workers |
| La org no deja crear secretos de Actions | Media | Espejo personal (R16 §11.1 opción B) con el mismo `deploy.yml`; o Workers Builds sobre el espejo |
| Norton bloquea también los addons `.node` de Vite/rolldown | Baja | El FRONT desarrolla contra la preview desplegada o en Codespaces |
| Type stripping de Node no resuelve los paquetes del workspace | Media | `tsc -b` de `core` y `contracts` (JS puro) |
| Crons tardan hasta 15 min en propagarse | Alta en el primer deploy | Desplegar los crons temprano, no la mañana del domingo |
| Sin dominio a tiempo | Media | workers.dev como `deploy-url`; la demo usa el sensor `tail()` |
| PSI con 429 o lento | Baja | Clave propia; reintento con backoff en el Workflow; mostrar la última medición guardada |
| La analítica GraphQL llega con retraso en la demo | Media | El incidente sale del `tail()`; GraphQL solo confirma |
| `create({ id, params })` de Workflows o los nombres de campos de `queues.consumers` difieren | Baja | Validar con `wrangler deploy --dry-run` en CI [no verificado el flag] en la hora 1 |

**Esfuerzo (S = pocas horas, M = medio día, L = más de un día)**

| Pieza | Dueño | Esfuerzo |
|---|---|---|
| Cuenta de Cloudflare, Workers Paid, subdominio, dominio y zona, tokens | Orquestador | S |
| Esqueleto `apps/web` + `apps/api` + `wrangler.jsonc` + `deploy.yml` + bootstrap de cola y bucket | Orquestador | S |
| Hono: auth por Bearer, conexiones con cifrado WebCrypto, scans, export, MCP | BACK | M |
| Cron → Queue → monitores y reglas | BACK | M |
| Workflow `vg-scan` (Supabase, Cloudflare, repo, ZIP, PSI, resumen IA) | BACK | M |
| R2 + escáner de ZIP | BACK | S |
| Víctima + `tail()` + `scripts/ataque.mjs` + ensayo de bloqueo | BACK + orquestador | S |
| `dev-node.ts` y dobles de bindings | BACK | S |
| SPA (shell, módulos, gráficos, Realtime, guías) | FRONT | L (dos personas) |
| Observatory y tarjeta de salud de Workers (dogfooding extra) | BACK | S, solo si sobra tiempo |

---

## Fuentes consultadas (24-oct-2026)

- Workers y Pages: https://developers.cloudflare.com/pages/ · https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/ · https://developers.cloudflare.com/workers/static-assets/ · https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ · https://developers.cloudflare.com/workers/framework-guides/web-apps/react/
- Límites y precios: https://developers.cloudflare.com/workers/platform/limits/ · https://developers.cloudflare.com/workers/platform/pricing/ · https://dev.classmethod.jp/en/articles/cloudflare-workers-64mib-size-limit/ (fecha del cambio de 64 MiB)
- Rutas y URLs: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/ · https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ · https://developers.cloudflare.com/workers/configuration/previews/
- Runtime: https://developers.cloudflare.com/workers/runtime-apis/nodejs/ · https://developers.cloudflare.com/workers/configuration/compatibility-flags/ · https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ · https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Trabajos: https://developers.cloudflare.com/workers/configuration/cron-triggers/ · https://developers.cloudflare.com/queues/platform/limits/ · https://developers.cloudflare.com/workflows/reference/limits/ · https://developers.cloudflare.com/workflows/get-started/guide/ · https://developers.cloudflare.com/browser-rendering/limits/ · https://developers.cloudflare.com/containers/pricing/
- Observabilidad: https://developers.cloudflare.com/workers/observability/logs/workers-logs/ · https://developers.cloudflare.com/workers/observability/logs/tail-workers/ · https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
- Almacenamiento: https://developers.cloudflare.com/r2/pricing/
- Secretos y CI: https://developers.cloudflare.com/workers/configuration/secrets/ · https://github.com/cloudflare/wrangler-action · https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/ · https://docs.github.com/en/billing/concepts/product-billing/github-codespaces
- MCP: https://developers.cloudflare.com/agents/model-context-protocol/transport/ · https://unpkg.com/@modelcontextprotocol/server@2.3.1/dist/index.d.mts
- OpenNext: https://opennext.js.org/cloudflare · https://opennext.js.org/cloudflare/troubleshooting · https://github.com/opennextjs/opennextjs-cloudflare/issues?q=proxy.ts
- Librerías: https://github.com/supabase/supabase-js · https://github.com/anthropics/anthropic-sdk-typescript · https://github.com/101arrowz/fflate · https://hono.dev/docs/getting-started/cloudflare-workers · registro de npm (`wrangler`, `@opennextjs/cloudflare`, `@cloudflare/vite-plugin`, `vite`, `hono`, `agents`, `@modelcontextprotocol/server`, `fflate`, `react-router`, `@anthropic-ai/sdk`, etc.)
- Lighthouse: https://developers.google.com/speed/docs/insights/v5/get-started · https://unlighthouse.dev/learn-lighthouse/pagespeed-insights-api/rate-limits (tercero) · https://developers.cloudflare.com/api/node/resources/speed
- Otros: https://infoq.com/news/2026/10/cloudflare-cf-cli (CLI `cf`) · https://costgoat.com/pricing/cloudflare-domains (precio del `.com`) · changelog de type stripping en la doc de Node (https://nodejs.org/download/nightly/v27.0.0-nightly202609268812357aff/docs/api/typescript.md)

