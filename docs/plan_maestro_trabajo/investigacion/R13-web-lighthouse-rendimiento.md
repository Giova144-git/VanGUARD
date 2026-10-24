# R13: Lighthouse, rendimiento histórico y métricas de compilación (investigación web)

Etapa 1 de 4 del plan maestro, team-22, Platanus Hack 26. Fecha de consulta: sábado 24-oct-2026, de madrugada (hora de Caracas).
Alcance: submódulo "Comportamiento histórico" dentro de **Codebase**: rendimiento con Lighthouse, tiempos de compilación, cantidad de errores, comparación entre versiones y "dónde está el problema".

Convención: `[verificado: URL]` = lo leí en esa fuente durante esta sesión. `[verificado: prueba propia]` = lo comprobé ejecutando `curl`/`node` (solo lectura, sin binarios). `[no verificado]` = no lo pude confirmar. `[propuesta]` = decisión de diseño mía, sin fuente externa.

---

## 0. Resumen y decisión

1. **El motor principal debe ser la PageSpeed Insights API v5 (PSI)**, llamada desde una función de Vercel (o de Supabase). PSI corre Lighthouse en la infraestructura de Google y devuelve el LHR completo en `lighthouseResult`. Así no hay Chrome que mantener, no hay riesgo SSRF contra nuestra infraestructura y el resultado no depende de la carga de nuestra máquina. Exige **API key propia**: sin ella, la cuota anónima compartida ya estaba agotada hoy (HTTP 429) [verificado: prueba propia].
2. **La librería Node `lighthouse` (13.5.0) se usa en GitHub Actions**, no en Vercel. Los runners `ubuntu-24.04` traen Google Chrome instalado. Es la vía "ambiciosa": usa la librería que pidió el dueño, permite 3 corridas con mediana, puede medir previews protegidas con cabecera y asocia cada corrida a un commit de forma nativa (`deployment_status`).
3. **No correr Lighthouse dentro de Vercel serverless** con `@sparticuz/chromium`. Técnicamente cabe en tamaño (unos 96 MB descomprimidos frente a un límite de 250 MB), pero el propio equipo de Lighthouse desaconseja FaaS. Además Hobby da 1 vCPU, y Lighthouse recomienda 2 núcleos dedicados como mínimo [verificado: https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md] [verificado: https://vercel.com/docs/functions/limitations].
4. **No desplegar un servidor de Lighthouse CI (LHCI).** `@lhci/cli` 0.15.1 (25-jun-2025) fija `lighthouse` 12.6.1. Sus IDs de audits no coinciden con los de Lighthouse 13 y sería un servicio más que operar [verificado: prueba propia, https://registry.npmjs.org/@lhci/cli]. El historial se guarda en **Supabase** con nuestro propio esquema (sección 8).
5. **Compilaciones y errores**: GitHub Actions REST API (`/actions/runs`, `/runs/{id}/jobs`, check-runs y anotaciones) y, cuando entre Vercel, la Deployments API v7 (`ready - buildingAt`) y los eventos v3 (`level: "error"`).
6. **"Dónde está el problema"**: desde Lighthouse 12/13 cada audit trae `metricSavings` (`{"LCP": 600}`, `{"TBT": 1050}`…). Con ese campo se vincula cada métrica mala a sus audits culpables y, desde ahí, a filas con `url`, `wastedMs`, `wastedBytes`, selector del nodo LCP o entidad de terceros [verificado: prueba propia sobre `sample_v2.json` de v13.5.0].

---

## 1. Librería Node `lighthouse`

### 1.1 Versión y requisitos

| Dato | Valor | Fuente |
|---|---|---|
| Última estable | **13.5.0**, publicada el 18-sep-2026; `next` = `13.5.0-dev.20261022` | [verificado: prueba propia, https://registry.npmjs.org/lighthouse] |
| Módulo | ESM puro (`"type": "module"`), sin campo `exports` (se permiten imports profundos) | [verificado: https://raw.githubusercontent.com/GoogleChrome/lighthouse/main/package.json] |
| Node | `>=22.19` ("Lighthouse 13 requires Node 22.19 or higher") | [verificado: https://developer.chrome.com/blog/lighthouse-13-0] |
| Licencia | Apache-2.0 | [verificado: package.json] |
| Tamaño desempaquetado | 19,2 MB (`lighthouse`), más `puppeteer-core` 25.16.0 (6,1 MB) | [verificado: prueba propia, registro npm] |
| Lanzador | `chrome-launcher` 1.2.2 | [verificado: prueba propia] |
| Vercel Node | 24.x (por defecto) y 22.x; Vercel aplica solo el último minor, que cumple `>=22.19` | [verificado: https://vercel.com/docs/functions/runtimes/node-js/node-js-versions] |

**Cambio de ruptura de Lighthouse 13** (oct-2025): se eliminaron los audits de rendimiento antiguos y se reemplazaron por "insights" [verificado: https://developer.chrome.com/blog/lighthouse-13-0]. Esto importa para el parser:

| ID antiguo (≤12) | ID en 13.5.0 (`default-config.js`) |
|---|---|
| `render-blocking-resources` | `render-blocking-insight` |
| `largest-contentful-paint-element` | `lcp-breakdown-insight` (el blog lo llama `lcp-phases-insight`; en 13.5.0 el ID es `lcp-breakdown-insight`) |
| `prioritize-lcp-image`, `lcp-lazy-loaded` | `lcp-discovery-insight` |
| `third-party-summary` | `third-parties-insight` |
| `layout-shifts` | `cls-culprits-insight` |
| `redirects`, `server-response-time`, `uses-text-compression` | `document-latency-insight` (`server-response-time` sigue como audit oculto) |
| `uses-long-cache-ttl` | `cache-insight` (el blog dice `use-cache-insight`) |
| `modern-image-formats`, `uses-optimized-images`, `uses-responsive-images`, `efficient-animated-content` | `image-delivery-insight` |
| `critical-request-chains`, `uses-rel-preconnect` | `network-dependency-tree-insight` |
| `legacy-javascript`, `duplicated-javascript`, `dom-size`, `font-display` | `*-insight` homónimos |

Siguen existiendo como diagnósticos: `unused-javascript`, `unused-css-rules`, `unminified-*`, `total-byte-weight`, `bootup-time`, `mainthread-work-breakdown`, `long-tasks`, `user-timings`, `non-composited-animations`, `unsized-images`, `bf-cache`. También existen `forced-reflow-insight` e `inp-breakdown-insight` [verificado: https://raw.githubusercontent.com/GoogleChrome/lighthouse/v13.5.0/core/config/default-config.js]. En 13.5.0 las categorías son `performance`, `accessibility`, `best-practices`, `seo` y `agentic-browsing` [verificado: prueba propia, sample_v2.json].

**Regla para el parser [propuesta]:** buscar siempre una lista de IDs candidatos (13.5 → 13.0 → 12), porque PSI, LHCI (12.6.1) y la librería local pueden traer versiones distintas.

### 1.2 Uso programático con `chrome-launcher` (forma oficial)

Este es el ejemplo de la documentación [verificado: https://github.com/GoogleChrome/lighthouse/blob/main/docs/readme.md]. Al LHR lo convertimos en resumen y hallazgos:

```ts
// scripts/perf/run-lighthouse.mjs  (Node >= 22.19, ESM)
import lighthouse, { desktopConfig } from 'lighthouse';           // desktopConfig exportado en core/index.js
import * as chromeLauncher from 'chrome-launcher';
import { computeMedianRun } from 'lighthouse/core/lib/median-run.js'; // export {computeMedianRun, filterToValidRuns}

export async function runLighthouse(url, { runs = 3, formFactor = 'mobile', extraHeaders } = {}) {
  const lhrs = [];
  for (let i = 0; i < runs; i++) {                 // SECUENCIAL: nunca en paralelo en la misma máquina
    const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-sandbox'] });
    try {
      const flags = { port: chrome.port, output: 'json', logLevel: 'error',
                      onlyCategories: ['performance'], extraHeaders };   // extraHeaders: setting válido (constants.js)
      const r = await lighthouse(url, flags, formFactor === 'desktop' ? desktopConfig : undefined);
      if (r?.lhr && !r.lhr.runtimeError) lhrs.push(r.lhr);
    } finally {
      await chrome.kill();
    }
  }
  if (!lhrs.length) throw new Error('Todas las corridas fallaron');
  return computeMedianRun(lhrs);                   // corrida mediana (por FCP + TTI)
}
```

- La firma es `lighthouse(url, flags = {}, config, page)`. El cuarto parámetro acepta una `page` de Puppeteer [verificado: https://raw.githubusercontent.com/GoogleChrome/lighthouse/v13.5.0/core/index.js] [verificado: https://github.com/GoogleChrome/lighthouse/blob/main/docs/puppeteer.md].
- `computeMedianRun` y `filterToValidRuns` se exportan desde `core/lib/median-run.js` en v13.5.0 [verificado: https://raw.githubusercontent.com/GoogleChrome/lighthouse/v13.5.0/core/lib/median-run.js]. La documentación dice que "la mediana de 5 corridas es el doble de estable que 1 corrida" [verificado: variability.md].
- Valores por defecto de v13.5.0: `formFactor: 'mobile'`, `throttlingMethod: 'simulate'`, `throttling: mobileSlow4G`, `maxWaitForLoad: 45000`, `maxWaitForFcp: 30000` [verificado: https://raw.githubusercontent.com/GoogleChrome/lighthouse/v13.5.0/core/config/constants.js]. El sample usa `rttMs 150`, `throughputKbps 1638.4` y `cpuSlowdownMultiplier 4` [verificado: prueba propia, sample_v2.json].
- Tamaño del LHR: el `sample_v2.json` oficial pesa **563 KB** [verificado: prueba propia]. Un LHR real con `fullPageScreenshot` puede pesar más [no verificado: cifra exacta]. **Nunca se manda el LHR crudo a Claude**: se manda el resumen de la sección 6, de 3 a 5 KB.

### 1.3 Requisitos de hardware y variabilidad (oficiales)

- Mínimo 2 núcleos dedicados (4 recomendados) y 2 GB de RAM (4 a 8 recomendados). Evitar FaaS ("AWS Lambda or Google Cloud Functions") y las instancias con CPU compartida o por ráfagas [verificado: https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md].
- "DO NOT collect multiple Lighthouse reports at the same time on the same machine" [verificado: ídem].
- Referencia de costo en VM: unos 30 s por prueba y unos USD 0,0008 por reporte en `m5.large`/`n2-standard-2` [verificado: ídem].

---

## 2. ¿Lighthouse dentro de Vercel serverless?

| Restricción | Vercel (Fluid compute) | Lighthouse necesita | Resultado |
|---|---|---|---|
| Tamaño del bundle | 250 MB descomprimidos (los "Large functions" llegan a 5 GB, en beta) [verificado: https://vercel.com/docs/functions/limitations] | `lighthouse` 19,2 MB + `puppeteer-core` 6,1 MB + `@sparticuz/chromium` 153.0.0 70,1 MB ≈ 96 MB [verificado: prueba propia, registro npm] | Cabe |
| Duración | Hobby: 300 s (máximo). Pro: 300 s por defecto, 800 s máximo [verificado: ídem] | ~30 s por corrida en VM, ×3 corridas, más el arranque en frío de Chromium | Cabe en el límite, sin margen si hay 3 corridas o varias URL |
| CPU/RAM | Hobby: 2 GB / 1 vCPU. Pro: hasta 4 GB / 2 vCPU [verificado: ídem] | ≥2 núcleos dedicados [verificado: variability.md]; Sparticuz recomienda 1600 MB o más [verificado: https://github.com/Sparticuz/chromium] | Hobby queda por debajo del mínimo |
| Respuesta | El cuerpo de respuesta máximo es 4,5 MB [verificado: limitations] | LHR de 0,5 MB o más | Hay que guardar en Storage y no devolver el LHR |
| Binario | Sparticuz es solo Linux x64 y "headless_shell". Está pensado para Lambda [verificado: https://github.com/Sparticuz/chromium] | — | Hay reportes de errores `libnspr4.so` en Node 22 en Vercel [no verificado: hilo de comunidad visto solo en el buscador] |

**Veredicto:** es posible en teoría y frágil en la práctica. Puede costar de 3 a 6 h de depuración de binarios. Además, al medir con 1 vCPU compartida el TBT se infla y varía mucho de una corrida a otra, así que la comparación histórica perdería valor [propuesta]. Tampoco encontré un ejemplo público verificado de Lighthouse 13 con Sparticuz en Vercel [no verificado]. **Se descarta para las 36 h.**

**Riesgo de seguridad (importa en el track AI Security):** un Chrome nuestro que abre cualquier URL que escriba el usuario es un vector de **SSRF**: el usuario podría pedir `http://169.254.169.254/` o hosts internos. Con PSI quien navega es Google, fuera de nuestra red [propuesta]. Si se usa la librería local o en Actions, hay que validar la URL: solo `https:`, sin IPs privadas ni loopback, y resolviendo el DNS antes.

### 2.1 Alternativas para correr la librería

| Opción | Costo y límites | Para las 36 h |
|---|---|---|
| **GitHub Actions `ubuntu-24.04`** | Gratis en repos públicos con runners estándar. Free privado: 2.000 min/mes [verificado: https://docs.github.com/en/billing/concepts/product-billing/github-actions]. Chrome preinstalado (Chrome 151 en la imagen del 04-ago-2026) [verificado: https://newreleases.io/project/github/actions/runner-images/release/ubuntu24%2F20260804.265] | **Sí** (vía secundaria) |
| Railway | Hobby USD 5/mes con USD 5 de uso incluidos. RAM USD 10/GB/mes, CPU USD 20/vCPU/mes. El plan Free tiene un máximo de 0,5 GB y 1 vCPU [verificado: https://docs.railway.com/reference/pricing/plans] | Solo como respaldo: es un servicio más |
| Render / Fly.io | No pude leer los planes vigentes [no verificado] | No |
| Máquina local del equipo | `node scripts/perf/run-lighthouse.mjs`, con el Chrome instalado | Sirve para sembrar datos de la demo, no como producto |

---

## 3. PageSpeed Insights API v5 (motor principal)

### 3.1 Contrato

- **Endpoint:** `GET https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed`. El cuerpo va vacío [verificado: https://developers.google.com/speed/docs/insights/rest/v5/pagespeedapi/runpagespeed]. El host antiguo `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` también aparece en la guía [verificado: https://developers.google.com/speed/docs/insights/v5/get-started].
- **Parámetros:** `url` (obligatorio); `category` (repetible: `PERFORMANCE`, `ACCESSIBILITY`, `BEST_PRACTICES`, `SEO`; si se omite, solo corre Performance); `strategy` (`MOBILE` | `DESKTOP`; **pasarlo siempre explícito**); `locale` (p. ej. `es`); `utm_campaign`, `utm_source`, `captchaToken`; `key` [verificado: referencia runPagespeed].
- **Versión de Lighthouse en PSI:** 13.0 desde el 20-oct-2025. "The Lighthouse version is independent and is updated regularly" [verificado: https://developers.google.com/speed/docs/insights/release_notes]. La versión exacta de hoy no la pude ver (me devolvió 429) [no verificado]. **Hay que leer `lighthouseResult.lighthouseVersion` en cada corrida y guardarla.**
- **Timeout del servidor de PSI:** 120 s (desde el 02-mar-2021) [verificado: release_notes]. La función que llame a PSI debe usar `maxDuration` ≥ 120.
- **CPU de PSI recalibrada** el 05-dic-2024: el TBT móvil de laboratorio subió [verificado: release_notes]. No hay que mezclar en una misma serie histórica corridas de PSI y corridas locales [propuesta].

### 3.2 Cuota y key

- **Sin key:** la cuota es compartida y global. Hoy respondió `429 RESOURCE_EXHAUSTED: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'"` [verificado: prueba propia, curl 24-oct-2026]. **La key es obligatoria en la práctica.**
- **Con key:** 25.000 consultas/día por proyecto de Google Cloud, gratis y sin facturación. El límite por ventana corta varía según la fuente (400 por 100 s o ~240 por minuto) [no verificado en fuente oficial; solo terceros: https://unlighthouse.dev/learn-lighthouse/pagespeed-insights-api/rate-limits]. Hay que confirmarlo en Cloud Console → APIs → PageSpeed Insights API → Quotas.
- Para nuestro uso (unas 10 URL × 2 estrategias × 3 repeticiones por despliegue) sobra cuota [propuesta].
- La key va en una variable de entorno del servidor (`PSI_API_KEY`), restringida a la PageSpeed Insights API. Nunca va al navegador.

### 3.3 Respuesta (campos que usamos)

```jsonc
{
  "id": "https://example.com/",
  "analysisUTCTimestamp": "2026-10-24T05:00:00.000Z",
  "loadingExperience": {          // CrUX de la URL (datos de campo); suele faltar en sitios con poco tráfico
    "metrics": { "LARGEST_CONTENTFUL_PAINT_MS": { "percentile": 2300, "category": "FAST", "distributions": [/*...*/] },
                 "INTERACTION_TO_NEXT_PAINT": { /*...*/ }, "CUMULATIVE_LAYOUT_SHIFT_SCORE": { /*...*/ },
                 "FIRST_CONTENTFUL_PAINT_MS": { /*...*/ } },
    "overall_category": "AVERAGE" },
  "originLoadingExperience": { /* igual, agregado por origen */ },
  "lighthouseResult": { "lighthouseVersion": "13.x", "requestedUrl": "...", "finalUrl": "...", "fetchTime": "...",
                        "configSettings": { "formFactor": "mobile" }, "audits": { /*...*/ }, "categories": { "performance": { "score": 0.72 } },
                        "runWarnings": [], "timing": { "total": 12345 } }
}
```

- Están verificados los campos de primer nivel, `loadingExperience.metrics.*.{percentile,distributions,category}` y `FIRST_CONTENTFUL_PAINT_MS` [verificado: get-started], y también que `INTERACTION_TO_NEXT_PAINT` es la clave de INP de campo [verificado: release_notes, 08-ago-2023]. Las claves `LARGEST_CONTENTFUL_PAINT_MS` y `CUMULATIVE_LAYOUT_SHIFT_SCORE` las doy de memoria [no verificado].
- Google anuncia que dejará de incluir CrUX en esta API ("We plan to discontinue including real-world data…") y recomienda la CrUX API [verificado: get-started]. **Tratar `loadingExperience` como opcional.**
- **Limitaciones:** PSI solo mide URL públicas. No acepta cabeceras: una preview de Vercel protegida solo se mide con el parámetro `?x-vercel-protection-bypass=<secreto>` [verificado: https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation], y ese secreto viajaría a Google en la URL. Para previews protegidas se usa la vía de GitHub Actions con cabecera [propuesta].

### 3.4 Cliente TypeScript (Route Handler de Next.js en Vercel)

```ts
// lib/perf/psi.ts  (en app/api/perf/run/route.ts: export const runtime = 'nodejs'; export const maxDuration = 300;
//                   Hobby permite como máximo 300 s y PSI tarda hasta 120 s por llamada. Un route.ts no puede exportar otras funciones)
const PSI = 'https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed';

export async function runPsi(url: string, strategy: 'MOBILE' | 'DESKTOP') {
  const q = new URLSearchParams({ url, strategy, category: 'PERFORMANCE', locale: 'es', key: process.env.PSI_API_KEY! });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${PSI}?${q}`, { signal: AbortSignal.timeout(125_000), cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      const lhr = body.lighthouseResult;
      if (lhr?.runtimeError) throw new Error(`Lighthouse: ${lhr.runtimeError.code}`);  // p. ej. NO_FCP, ERRORED_DOCUMENT_REQUEST
      return { lhr, field: body.loadingExperience?.metrics ?? null };
    }
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
    throw new Error(`PSI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  throw new Error('PSI: reintentos agotados');
}
```

Las 3 repeticiones de una misma URL **sí pueden ir en paralelo** (`Promise.all`), porque cada una corre en la infraestructura de Google y no en la nuestra. Que eso no meta ruido es una suposición mía [no verificado]. Hay que agruparlas con un `run_group` y guardar la mediana (sección 5.3).

---

## 4. Lighthouse CI (lhci)

| Aspecto | Dato |
|---|---|
| Versión | `@lhci/cli` 0.15.1 del 25-jun-2025. Fija `lighthouse: "12.6.1"` y `chrome-launcher ^0.13.4` [verificado: prueba propia, registro npm]. **No usa Lighthouse 13.** |
| Acción de GitHub | `treosh/lighthouse-ci-action@v12`, que audita con Lighthouse v12.6. Entradas: `urls`, `runs` (por defecto 1), `budgetPath`, `configPath`, `uploadArtifacts`, `temporaryPublicStorage` (borra a los 7 días), `serverBaseUrl`, `serverToken`. Salidas: `manifest`, `links`, `assertionResults`, `resultsPath` [verificado: https://github.com/treosh/lighthouse-ci-action] |
| Aserciones | Niveles `off`/`warn`/`error`; `minScore`, `maxNumericValue`, `maxLength`; `aggregationMethod`: `median`, `optimistic` (por defecto), `pessimistic`, `median-run`; presets `lighthouse:recommended`, `lighthouse:no-pwa`, `lighthouse:all`; `assert.budgetsFile` es excluyente con las demás aserciones; `collect.numberOfRuns` vale 3 por defecto [verificado: https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md] |
| Contexto de build | `LHCI_BUILD_CONTEXT__CURRENT_HASH`, `__ANCESTOR_HASH`, `__COMMIT_TIME`, `__CURRENT_BRANCH`, `__COMMIT_MESSAGE`, `__AUTHOR`, `__EXTERNAL_BUILD_URL`, `__GITHUB_REPO_SLUG` [verificado: ídem] |
| Servidor | `@lhci/server` con sqlite, mysql o postgres. Lo puede ver y escribir cualquiera con acceso HTTP salvo que se ponga `basicAuth`. Hay token de build y token de admin [verificado: https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/server.md]. La documentación pide Node 16 y disco persistente. |

**Decisión [propuesta]:** no usar LHCI en el producto. Hay tres motivos: (a) Lighthouse 12.6.1 frente a 13.x da IDs y métricas incomparables; (b) el servidor es otro servicio que asegurar y desplegar; (c) solo aporta ideas que reimplementamos en Supabase: build context, `median-run` y aserciones. Lo que sí copiamos es el **formato de aserciones** para nuestros presupuestos (sección 5.2).

---

## 5. Métricas, umbrales, presupuestos y comparación de corridas

### 5.1 Dónde se lee cada métrica en el LHR y umbrales oficiales

Pesos del score de Performance (Lighthouse 10+): FCP 10 %, SI 10 %, LCP 25 %, TBT 30 %, CLS 25 %. Colores: 0–49 rojo, 50–89 naranja, 90–100 verde [verificado: https://developer.chrome.com/docs/lighthouse/performance/performance-scoring]. Los mismos pesos aparecen en `default-config.js` de 13.5.0, con INP en peso 0 [verificado].

Los umbrales del score de laboratorio están en la curva log-normal de cada audit: `p10` da score 0,9 y `median` da 0,5 [verificado: https://raw.githubusercontent.com/GoogleChrome/lighthouse/v13.5.0/core/audits/metrics/]:

| Métrica | Ruta en el LHR | Móvil p10 / mediana | Escritorio p10 / mediana | Campo (CrUX, p75) "bueno / malo" |
|---|---|---|---|---|
| FCP | `audits['first-contentful-paint'].numericValue` (ms) | 1800 / 3000 | 934 / 1600 | — |
| LCP | `audits['largest-contentful-paint'].numericValue` | 2500 / 4000 | 1200 / 2400 | ≤ 2500 ms bueno [verificado: https://web.dev/articles/vitals] |
| TBT | `audits['total-blocking-time'].numericValue` | 200 / 600 | 150 / 350 | proxy de laboratorio de INP [verificado: web.dev/vitals] |
| CLS | `audits['cumulative-layout-shift'].numericValue` (sin unidad) | 0,1 / 0,25 | 0,1 / 0,25 | ≤ 0,1 bueno [verificado: web.dev/vitals] |
| Speed Index | `audits['speed-index'].numericValue` | 3387 / 5800 | 1311 / 2300 | — |
| INP | `audits['interaction-to-next-paint']` **solo existe en modo timespan**. En navegación no aparece (en el sample falta) | 200 / 500 | ídem | ≤ 200 ms bueno [verificado: web.dev/vitals] |
| TTFB | `audits.metrics.details.items[0].timeToFirstByte` (y `server-response-time.numericValue` del documento raíz) | — | — | ≤ 800 ms bueno, > 1800 ms malo [verificado: https://web.dev/articles/ttfb] |
| TTI | `audits.interactive.numericValue` (oculto, peso 0) | — | — | — |
| Peso | `audits['resource-summary'].details.items[]` → `{resourceType, requestCount, transferSize}` con los tipos `total`, `script`, `image`, `stylesheet`, `font`, `document`, `third-party`… | — | — | — |

El objeto `audits.metrics.details.items[0]` trae todo junto: `firstContentfulPaint`, `largestContentfulPaint`, `totalBlockingTime`, `cumulativeLayoutShift`, `speedIndex`, `interactive`, `timeToFirstByte`, `lcpLoadDelay`, `lcpLoadDuration`, `lcpRenderDelay`, `observedLoad`, `observedDomContentLoaded`… [verificado: prueba propia, sample_v2.json v13.5.0].

### 5.2 Presupuestos (formato propio, inspirado en las aserciones de LHCI)

En Lighthouse 13 los presupuestos dejan de ser un audit (desapareció `performance-budget`) [no verificado: la búsqueda no lo confirmó]. **No dependemos de eso**: los presupuestos viven en Supabase y se evalúan en nuestro código.

```ts
// Valores por defecto [propuesta]: "verde" de Lighthouse para móvil + presupuestos de peso razonables para una SPA/Next.js
export const DEFAULT_BUDGET = {
  mobile:  { perfScore: 0.9, lcpMs: 2500, tbtMs: 200, cls: 0.1, fcpMs: 1800, siMs: 3387, ttfbMs: 800, scriptBytes: 350_000, totalBytes: 1_600_000 },
  desktop: { perfScore: 0.9, lcpMs: 1200, tbtMs: 150, cls: 0.1, fcpMs: 934,  siMs: 1311, ttfbMs: 800, scriptBytes: 350_000, totalBytes: 1_600_000 },
} as const;
```

### 5.3 Comparar dos corridas o dos versiones sin que el ruido engañe

1. **Repeticiones:** como mínimo 3 por URL y estrategia, agrupadas por `run_group`. Se compara la **mediana por métrica** (en SQL con `percentile_cont(0.5)`) o la corrida que devuelve `computeMedianRun`, que es la más cercana a la mediana de FCP y TTI [verificado: median-run.js]. Con 1 sola corrida, la UI muestra "indicativo".
2. **Misma fuente y misma versión:** solo se comparan corridas con el mismo `source` (psi/lighthouse-node), la misma `strategy` y el mismo major de `lighthouse_version` [propuesta].
3. **Umbral de regresión = relativo Y absoluto** [propuesta, calibrar con datos de la demo]:

| Métrica | Empeora si Δ ≥ | y Δ absoluto ≥ |
|---|---|---|
| LCP | +10 % | +250 ms |
| TBT | +20 % | +100 ms |
| FCP | +10 % | +200 ms |
| Speed Index | +10 % | +300 ms |
| CLS | — | +0,05 |
| Score | — | −5 puntos |
| `script` transferSize | +10 % | +50 KB |

```ts
type Summary = { perfScore: number; lcpMs: number; tbtMs: number; fcpMs: number; siMs: number; cls: number; scriptBytes: number };
const RULES: [keyof Summary, number, number][] = [
  ['lcpMs', 0.10, 250], ['tbtMs', 0.20, 100], ['fcpMs', 0.10, 200], ['siMs', 0.10, 300], ['cls', 0, 0.05], ['scriptBytes', 0.10, 50_000],
];
export function compareRuns(base: Summary, head: Summary) {
  const regressions = RULES.flatMap(([k, rel, abs]) => {
    const d = head[k] - base[k];
    return d >= abs && (rel === 0 || d >= base[k] * rel) ? [{ metric: k as string, base: base[k], head: head[k], delta: d }] : [];
  });
  const scoreDrop = Math.round((base.perfScore - head.perfScore) * 100);
  if (scoreDrop >= 5) regressions.push({ metric: 'perfScore', base: base.perfScore, head: head.perfScore, delta: -scoreDrop / 100 });
  return { regressed: regressions.length > 0, regressions };
}
```

4. **Atribución de la regresión:** se cruzan los hallazgos (sección 6) de base y head con la clave `audit_id + url normalizada`. La normalización quita la query y los hashes de chunk, p. ej. `/_next/static/chunks/app/page-3f9a1c2b.js` → `/_next/static/chunks/app/page-*.js` con `/-[0-9a-f]{8,}(?=\.)/` [propuesta]. Las filas nuevas en head son "introducidas en esta versión" y las filas con `wastedMs`/`wastedBytes`/`total` mayores son "empeoraron". El texto resultante dice, por ejemplo: "page-*.js creció 120 KB y suma 300 ms de scripting (bootup-time)".

---

## 6. De audits a "dónde está el problema"

### 6.1 La pieza clave: `metricSavings`

Desde Lighthouse 12/13 cada audit de rendimiento expone `metricSavings`, un objeto con claves `FCP`, `LCP`, `TBT`, `CLS` (e `INP` en timespan) y el ahorro estimado. Así viene en el sample de v13.5.0 [verificado: prueba propia sobre https://raw.githubusercontent.com/GoogleChrome/lighthouse/v13.5.0/core/test/results/sample_v2.json]:

| Audit (13.5.0) | `metricSavings` en el sample | `details.type` | Columnas de cada fila (= "dónde") |
|---|---|---|---|
| `render-blocking-insight` | `{FCP:0, LCP:0}` | table | `url`, `totalBytes`, `wastedMs` |
| `lcp-breakdown-insight` | `{LCP:0}` | list → [table de subpartes, node] | subpartes `{subpart, label, duration}`: `timeToFirstByte`, `resourceLoadDelay`, `resourceLoadDuration`, `elementRenderDelay`, + nodo `{selector, snippet, nodeLabel, path, boundingRect}` |
| `lcp-discovery-insight` | `{LCP:0}` | list → [checklist, node] | checklist `priorityHinted` (fetchpriority=high), `requestDiscoverable`, `eagerlyLoaded` (sin `loading=lazy`) con `value: bool` |
| `unused-javascript` | `{FCP:0, LCP:600}` | opportunity | `url`, `totalBytes`, `wastedBytes`, `wastedPercent` (con source maps trae `subItems` por archivo fuente [no verificado: el sample no tiene]) |
| `bootup-time` | `{TBT:1050}` | table | `url`, `total`, `scripting`, `scriptParseCompile` (ms por script) |
| `long-tasks` | `{TBT:1050}` | table | `url`, `startTime`, `duration` |
| `mainthread-work-breakdown` | `{TBT:1050}` | table | `group` (`scriptEvaluation`, `styleLayout`…), `groupLabel`, `duration` |
| `third-parties-insight` | — | table | `entity`, `transferSize`, `mainThreadTime` |
| `image-delivery-insight` | `{FCP:0, LCP:1200}` | table | `node`, `url`, `totalBytes`, `wastedBytes`, `subItems[].reason` |
| `legacy-javascript-insight` | `{FCP:0, LCP:300}` | table | `url`, `wastedBytes`, `subItems[].signal` + `location{url,line,column}` |
| `cache-insight` | `{FCP:0, LCP:3100}` | table | `url`, `cacheLifetimeMs`, `totalBytes`, `wastedBytes` |
| `cls-culprits-insight` | `{CLS:0}` | list → table | `node`, `score` |
| `document-latency-insight` | `{FCP:0, LCP:0}` | checklist | redirecciones / tiempo de servidor / compresión |
| `network-dependency-tree-insight` | `{LCP:0}` | list → `network-tree` | cadena `chains{url, navStartToEndTime, transferSize, isLongest, children}` |
| `server-response-time` (oculto) | `{FCP:0, LCP:0}` | opportunity | `url`, `responseTime` |

Hay dos trampas, ambas vistas en el sample:
- `bootup-time` tenía `score: 1` y aun así `metricSavings.TBT = 1050`, y `long-tasks` es `informative` (score `null`). **No se filtra por score**: se filtra por ahorro mínimo.
- `long-tasks`, `bootup-time` y `mainthread-work-breakdown` reportan **el mismo** ahorro de TBT. Son vistas superpuestas, así que **no se suman los ahorros**.

`lhr.entities[]` → `{name, origins[], isFirstParty, isUnrecognized}` permite clasificar cada `url` como propia o de terceros [verificado: sample]. `runtimeError {code, message}` indica que el resultado debe descartarse [verificado: https://github.com/GoogleChrome/lighthouse/blob/main/docs/understanding-results.md].

### 6.2 Árbol de causas por métrica [propuesta, basada en los campos verificados]

- **LCP alto** → mirar la subparte dominante de `lcp-breakdown-insight`:
  - `timeToFirstByte` → backend o servidor lento: `document-latency-insight`, `server-response-time`. En el ecosistema: CPU de Supabase, cold start de la función, sin caché en Cloudflare.
  - `resourceLoadDelay` → el recurso LCP se descubre tarde: `lcp-discovery-insight` (falta `fetchpriority=high`, no está en el HTML inicial, `loading=lazy`) y `network-dependency-tree-insight`.
  - `resourceLoadDuration` → el recurso pesa mucho: `image-delivery-insight` (formato o tamaño) y `cache-insight`.
  - `elementRenderDelay` → render bloqueado: `render-blocking-insight` (CSS/JS en `<head>`), `bootup-time` e hidratación.
  - El selector y el snippet del nodo LCP (`body > div > h2#toppy`) se le dan a Claude para que localice el componente en el repo conectado.
- **TBT alto** → `bootup-time` (qué script cuesta más ms), `long-tasks` (cuándo), `mainthread-work-breakdown` (qué tipo de trabajo), `third-parties-insight` (qué tercero), `legacy-javascript-insight` / `duplicated-javascript-insight` / `unused-javascript` (qué recortar).
- **CLS alto** → `cls-culprits-insight` (nodos), `unsized-images`, `font-display-insight`.
- **FCP alto** → `render-blocking-insight`, `document-latency-insight`, `network-dependency-tree-insight`.

**Cruce con el resto del ecosistema (lo que nos diferencia) [propuesta]:** si `timeToFirstByte` domina el LCP y en la misma ventana el módulo Supabase ve CPU alta o el módulo Cloudflare ve un pico de peticiones de una IP o user agent, el hallazgo se une en un solo incidente: "LCP +1,2 s por TTFB; coincide con CPU 92 % en Supabase".

### 6.3 Código portable: resumen + hallazgos (compatible con LH 12 y 13)

```ts
// lib/perf/diagnose.ts
type Metric = 'FCP' | 'LCP' | 'TBT' | 'CLS' | 'INP';
export interface Finding {
  auditId: string; title: string; metric: Metric; savings: number;      // ms (CLS: sin unidad)
  resourceUrl?: string; entity?: string; firstParty?: boolean;
  selector?: string; snippet?: string;
  wastedMs?: number; wastedBytes?: number; totalBytes?: number; durationMs?: number;
}
const MIN_SAVING: Record<Metric, number> = { FCP: 100, LCP: 100, TBT: 50, INP: 50, CLS: 0.01 };   // [propuesta]
const IDS = {                                       // primero 13.5, luego 13.0, luego 12
  lcpBreakdown: ['lcp-breakdown-insight', 'lcp-phases-insight', 'largest-contentful-paint-element'],
  lcpDiscovery: ['lcp-discovery-insight', 'prioritize-lcp-image'],
};
const pick = (lhr: any, ids: string[]) => ids.map(id => lhr.audits?.[id]).find(Boolean);

function rows(audit: any): any[] {
  const d = audit?.details;
  if (!d) return [];
  if (d.type === 'table' || d.type === 'opportunity') return d.items ?? [];
  if (d.type === 'list') return (d.items ?? []).flatMap((x: any) => (x.type === 'table' ? x.items ?? [] : []));
  return [];
}

export function summarize(lhr: any) {
  const a = lhr.audits ?? {};
  const n = (id: string) => (typeof a[id]?.numericValue === 'number' ? a[id].numericValue : null);
  const m = a.metrics?.details?.items?.[0] ?? {};
  const rs: any[] = a['resource-summary']?.details?.items ?? [];
  const t = (k: string) => rs.find(r => r.resourceType === k);
  return {
    lighthouseVersion: lhr.lighthouseVersion as string, fetchedAt: lhr.fetchTime as string,
    finalUrl: (lhr.finalDisplayedUrl ?? lhr.finalUrl) as string, formFactor: lhr.configSettings?.formFactor,
    runtimeError: lhr.runtimeError?.code ?? null,
    perfScore: lhr.categories?.performance?.score ?? null,
    fcpMs: n('first-contentful-paint'), lcpMs: n('largest-contentful-paint'), tbtMs: n('total-blocking-time'),
    cls: n('cumulative-layout-shift'), siMs: n('speed-index'), ttiMs: n('interactive'),
    ttfbMs: m.timeToFirstByte ?? n('server-response-time'),
    totalBytes: t('total')?.transferSize ?? n('total-byte-weight'), scriptBytes: t('script')?.transferSize ?? null,
    requestCount: t('total')?.requestCount ?? null,
  };
}

export function diagnose(lhr: any, maxRowsPerAudit = 5) {
  const entities: any[] = lhr.entities ?? [];
  const entityOf = (url?: string) => {
    if (!url) return undefined;
    try { const o = new URL(url).origin; return entities.find(e => e.origins?.includes(o)); } catch { return undefined; }
  };
  const findings: Finding[] = [];
  for (const [auditId, au] of Object.entries<any>(lhr.audits ?? {})) {
    for (const [metric, saving] of Object.entries<number>(au.metricSavings ?? {})) {
      if (!(saving >= MIN_SAVING[metric as Metric])) continue;
      const list = rows(au).slice(0, maxRowsPerAudit);
      if (!list.length) { findings.push({ auditId, title: au.title, metric: metric as Metric, savings: saving }); continue; }
      for (const r of list) {
        const url = typeof r.url === 'string' ? r.url : undefined;
        const e = entityOf(url);
        findings.push({ auditId, title: au.title, metric: metric as Metric, savings: saving,
          resourceUrl: url, entity: e?.name ?? (typeof r.entity === 'string' ? r.entity : r.entity?.text),
          firstParty: e?.isFirstParty, selector: r.node?.selector, snippet: r.node?.snippet,
          wastedMs: r.wastedMs, wastedBytes: r.wastedBytes, totalBytes: r.totalBytes,
          durationMs: r.duration ?? r.total });
      }
    }
  }
  // Subpartes de LCP + nodo LCP
  const lcpA = pick(lhr, IDS.lcpBreakdown);
  const parts = rows(lcpA).filter(r => r.subpart);                       // [{subpart,label,duration}]
  const lcpNode = (lcpA?.details?.items ?? []).find((x: any) => x.type === 'node');
  const dominant = parts.reduce((x: any, y: any) => (!x || y.duration > x.duration ? y : x), undefined);
  const discovery = pick(lhr, IDS.lcpDiscovery)?.details?.items?.find((x: any) => x.type === 'checklist')?.items ?? null;
  findings.sort((x, y) => y.savings - x.savings);
  return { summary: summarize(lhr), lcp: { parts, dominant: dominant?.subpart ?? null,
           selector: lcpNode?.selector, snippet: lcpNode?.snippet, discovery }, findings };
}
```

Probé este código (y `compareRuns`) con Node 24 sobre el `sample_v2.json` de v13.5.0. Devuelve `dominant: "resourceLoadDelay"`, `selector: "body > div > h2#toppy"`, 24 hallazgos encabezados por `cache-insight` (LCP 3100) e `image-delivery-insight` (LCP 1200), y pesa 6,8 KB en JSON con 5 filas por audit [verificado: prueba propia]. Con `maxRowsPerAudit = 3` baja a unos 4 KB. El resultado de `diagnose()` es lo **único** que va a Claude. Con eso, más el árbol de archivos del repo y el `package.json`, Claude genera el "prompt de corrección" y, si hay repo conectado, propone el archivo probable: a partir del nodo LCP (busca el `id` o el texto del snippet) o del nombre del chunk (`app/dashboard/page-*.js` → `app/dashboard/page.tsx`) [propuesta]. Sin source maps públicos, el mapeo chunk → archivo es heurístico y la UI lo marca como "probable".

---

## 7. Tiempos de compilación y cantidad de errores

### 7.1 GitHub Actions (vertical GitHub, prioridad alta)

| Necesidad | Endpoint | Campos |
|---|---|---|
| Corridas | `GET /repos/{owner}/{repo}/actions/runs` (`per_page` ≤ 100, `page`, `branch`, `event`, `status`, `created`, `head_sha`, `exclude_pull_requests`). Con filtros devuelve **como máximo 1000 resultados** por búsqueda | `id`, `name`, `head_branch`, `head_sha`, `run_number`, `run_attempt`, `event`, `status`, `conclusion`, `workflow_id`, `check_suite_id`, `created_at`, `updated_at`, `run_started_at`, `html_url`, `display_title` [verificado: https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28] |
| Por workflow | `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id\|archivo.yml}/runs` | ídem [verificado: ídem] |
| Duración exacta | `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs?filter=latest&per_page=100` | `jobs[].{name,status,conclusion,started_at,completed_at,runner_name,steps[].{name,number,conclusion,started_at,completed_at}}` [verificado: https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28] |
| Errores | `GET /repos/{owner}/{repo}/commits/{sha}/check-runs?per_page=100` → `output.annotations_count`; `GET /repos/{owner}/{repo}/check-runs/{id}/annotations?per_page=100` → `annotation_level` (`failure`/`warning`/`notice`), `path`, `start_line`, `message` | [verificado: https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28]. **Límite:** Actions crea como máximo 10 anotaciones de error y 10 de warning por step, así que el conteo es una cota inferior [verificado: ídem] |
| Logs (opcional) | `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` → 302 a un texto plano que caduca en 1 minuto | [verificado: workflow-jobs] |
| **No usar** | `GET /actions/runs/{run_id}/timing` "is in the process of closing down" | [verificado: workflow-runs, https://github.blog/changelog/2025-02-02-actions-get-workflow-usage-and-get-workflow-run-usage-endpoints-closing-down] |

- **Límites de tasa:** PAT 5.000 req/h; `GITHUB_TOKEN` en Actions 1.000 req/h por repo; GitHub App de 5.000 a 12.500 req/h. Cabeceras `x-ratelimit-remaining` y `x-ratelimit-reset` [verificado: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28].
- **Permisos:** con PAT clásico, el scope `repo` para repos privados [verificado: workflow-runs]. Con token fine-grained, en solo lectura: "Actions", "Checks", "Contents" y "Metadata" [no verificado: no pude leer la sección de tokens fine-grained]. Coherente con la decisión previa del equipo de pedir solo lectura.
- **Definiciones [propuesta]:** duración = `max(jobs.completed_at) − min(jobs.started_at)`; si no se piden los jobs, se aproxima con `updated_at − run_started_at` en runs `completed`. Tasa de fallos = `failure / (success + failure)`, sin contar `cancelled` ni `skipped`. Hay que guardar `run_attempt` para no contar dos veces un re-run.

```ts
// lib/builds/github.ts
const GH = 'https://api.github.com';
const hdr = (t: string) => ({ Authorization: `Bearer ${t}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });

export async function syncGithubRuns(owner: string, repo: string, token: string, sinceDate: string /* YYYY-MM-DD */) {
  const out: any[] = [];
  for (let page = 1; page <= 10; page++) {                                     // 10 × 100 = tope de 1000 con filtros
    const q = new URLSearchParams({ per_page: '100', page: String(page), created: `>=${sinceDate}`, exclude_pull_requests: 'true' });
    const r = await fetch(`${GH}/repos/${owner}/${repo}/actions/runs?${q}`, { headers: hdr(token) });
    if (!r.ok) throw new Error(`GitHub ${r.status} (quedan ${r.headers.get('x-ratelimit-remaining')})`);
    const { workflow_runs } = await r.json();
    out.push(...workflow_runs);
    if (workflow_runs.length < 100) break;
  }
  return out.map(w => ({
    provider: 'github_actions', external_id: `${w.id}#${w.run_attempt}`, workflow_name: w.name, commit_sha: w.head_sha,
    branch: w.head_branch, event: w.event, status: w.status, conclusion: w.conclusion,
    started_at: w.run_started_at, finished_at: w.status === 'completed' ? w.updated_at : null, url: w.html_url,
  }));
}

export async function countCheckErrors(owner: string, repo: string, sha: string, token: string) {
  const r = await fetch(`${GH}/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`, { headers: hdr(token) });
  const { check_runs } = await r.json();
  let errors = 0, warnings = 0;
  for (const cr of check_runs) {
    if (!cr.output?.annotations_count) continue;
    const anns = await (await fetch(`${GH}/repos/${owner}/${repo}/check-runs/${cr.id}/annotations?per_page=100`, { headers: hdr(token) })).json();
    for (const a of anns) { if (a.annotation_level === 'failure') errors++; else if (a.annotation_level === 'warning') warnings++; }
  }
  return { errors, warnings, failedChecks: check_runs.filter((c: any) => c.conclusion === 'failure').length };
}
```

### 7.2 Vercel (vertical posterior, P2)

- **Lista:** `GET https://api.vercel.com/v7/deployments?projectId=…&limit=…&target=production&state=READY&sha=…&branch=…&teamId=…` con `Authorization: Bearer <token>`. La paginación es por timestamp (`pagination.next` → `until`) [verificado: https://vercel.com/docs/rest-api/reference/endpoints/deployments/list-deployments].
- **Campos:** `uid`, `url`, `state`/`readyState` (`BUILDING`, `ERROR`, `INITIALIZING`, `QUEUED`, `READY`, `CANCELED`, `BLOCKED`, `DELETED`), `created`, `buildingAt`, `ready` (ms epoch), `target` (`production`/`staging`/`null`), `source` (`git`, `cli`…), `errorCode` (p. ej. `BUILD_FAILED`), `errorMessage`, `oomReport`, `inspectorUrl`, `meta` [verificado: ídem]. Las claves de `meta` (`githubCommitSha`, `githubCommitRef`, `githubCommitMessage`) las doy de memoria [no verificado]. La documentación solo dice "Metadata information from the Git provider".
- **Duración de build [propuesta]:** `ready − buildingAt` (si `readyState = READY`); en `ERROR`, el `created` del último evento menos `buildingAt`.
- **Errores de build:** `GET /v3/deployments/{idOrUrl}/events?limit=-1&builds=1` → contar los elementos con `level === "error"` o `type` en `stderr`/`fatal` (`level` ∈ `error`/`warning`; `type` ∈ `command`, `stdout`, `stderr`, `exit`, `fatal`, `deployment-state`…) [verificado: https://vercel.com/docs/rest-api/reference/endpoints/deployments/get-deployment-events].
- **Disparador:** webhook `deployment.succeeded` con `payload.deployment.{id,url,meta}`, `payload.target`, `payload.project.id` [verificado: https://vercel.com/docs/webhooks/webhooks-api]. La verificación de firma no la pude leer [no verificado].

---

## 8. Asociar cada corrida a un commit o despliegue (esquema Supabase)

**Claves de unión:** `commit_sha` (GitHub `head_sha` / `GITHUB_SHA` / Vercel `meta`), `deployment_id` (Vercel `uid`) y `deployment_url`. Disparadores, de mejor a peor:
1. **GitHub `deployment_status`** (Vercel con integración de GitHub): `GITHUB_SHA` = "Commit to be deployed" [verificado: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows]; la URL de la preview está en `github.event.deployment_status.target_url`; se filtra con `state == 'success'` y `environment == 'Preview'` o `'Production'` [verificado: https://vercel.com/kb/guide/github-actions-vercel]. Los estados `inactive` no disparan nada [verificado: events-that-trigger-workflows].
2. Webhook de Vercel `deployment.succeeded` (sección 7.2).
3. Botón "Medir ahora" o el cron diario de Vercel (Hobby: 1 vez al día, ±59 min; Pro: cada minuto) [verificado: https://vercel.com/docs/cron-jobs/usage-and-pricing]. En ese caso el commit se resuelve con el último deploy `READY` de producción (o queda `null`, y la UI lo muestra como "sin versión").

```sql
-- Tablas de rendimiento (RLS por org_id igual que el resto del esquema)
create table perf_targets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null, url text not null, strategy text not null check (strategy in ('mobile','desktop')),
  label text, budget jsonb, created_at timestamptz not null default now(),
  unique (org_id, url, strategy)
);
create table perf_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null, target_id uuid not null references perf_targets(id) on delete cascade,
  run_group uuid not null,                         -- agrupa las N repeticiones de una misma medición
  source text not null check (source in ('psi','lighthouse-node')),
  lighthouse_version text, strategy text not null,
  commit_sha text, branch text, deployment_id text, deployment_url text, environment text,
  fetched_at timestamptz not null, status text not null default 'done' check (status in ('pending','done','error')),
  runtime_error text,
  perf_score numeric(4,3), fcp_ms int, lcp_ms int, tbt_ms int, cls numeric(6,4), si_ms int, ttfb_ms int, tti_ms int,
  total_bytes bigint, script_bytes bigint, request_count int,
  lcp_dominant text, lcp_selector text,             -- de diagnose().lcp
  field jsonb,                                      -- loadingExperience.metrics recortado (opcional)
  lhr_path text,                                    -- Storage: lhr/{org_id}/{id}.json.gz (opcional)
  created_at timestamptz not null default now()
);
create index perf_runs_target_time on perf_runs (target_id, fetched_at desc);
create index perf_runs_commit on perf_runs (org_id, commit_sha);
create table perf_findings (
  id bigint generated always as identity primary key,
  run_id uuid not null references perf_runs(id) on delete cascade,
  audit_id text not null, metric text not null, savings numeric, resource_url text, resource_key text, -- url normalizada sin hash
  entity text, first_party boolean, selector text, wasted_ms numeric, wasted_bytes bigint, total_bytes bigint, duration_ms numeric
);
create index perf_findings_run on perf_findings (run_id);
create table build_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null, provider text not null check (provider in ('github_actions','vercel')),
  external_id text not null, workflow_name text, commit_sha text, branch text, event text, target text,
  status text, conclusion text, started_at timestamptz, finished_at timestamptz, duration_ms int,
  error_count int, warning_count int, url text, created_at timestamptz not null default now(),
  unique (provider, external_id)
);
create index build_runs_commit on build_runs (org_id, commit_sha);

-- Mediana por medición (una fila por run_group = un punto del gráfico)
create view perf_points with (security_invoker = true) as
select run_group, target_id, org_id, max(commit_sha) commit_sha, max(deployment_id) deployment_id, min(fetched_at) at,
       max(lighthouse_version) lighthouse_version, max(source) source, count(*) n,
       percentile_cont(0.5) within group (order by perf_score) perf_score,
       percentile_cont(0.5) within group (order by lcp_ms) lcp_ms,
       percentile_cont(0.5) within group (order by tbt_ms) tbt_ms,
       percentile_cont(0.5) within group (order by cls) cls,
       percentile_cont(0.5) within group (order by fcp_ms) fcp_ms,
       percentile_cont(0.5) within group (order by si_ms) si_ms,
       percentile_cont(0.5) within group (order by script_bytes) script_bytes
from perf_runs where status = 'done' and runtime_error is null
group by run_group, target_id, org_id;
```

```sql
-- Histórico + delta contra la versión anterior (gráfico de líneas y tabla comparativa)
select at, commit_sha, n, perf_score, lcp_ms, tbt_ms, cls,
       lcp_ms - lag(lcp_ms) over w as d_lcp_ms,
       tbt_ms - lag(tbt_ms) over w as d_tbt_ms,
       round(((perf_score - lag(perf_score) over w) * 100)::numeric) as d_score_pts
from perf_points
where target_id = $1 and source = 'psi'
window w as (order by at)
order by at desc limit 30;

-- Compilación: tasa de fallos y duración p50/p90 por workflow, últimos 30 días
select workflow_name,
       count(*) filter (where conclusion = 'failure')::float
         / nullif(count(*) filter (where conclusion in ('success','failure')), 0) as fail_rate,
       percentile_cont(0.5) within group (order by duration_ms) as p50_ms,
       percentile_cont(0.9) within group (order by duration_ms) as p90_ms,
       sum(coalesce(error_count, 0)) as errors
from build_runs
where org_id = $1 and provider = 'github_actions' and started_at > now() - interval '30 days'
group by workflow_name order by fail_rate desc nulls last;

-- Vista "por versión": build + rendimiento del mismo commit
select b.commit_sha, b.finished_at, b.conclusion, b.duration_ms, b.error_count, p.perf_score, p.lcp_ms, p.tbt_ms
from build_runs b left join perf_points p on p.commit_sha = b.commit_sha and p.org_id = b.org_id
where b.org_id = $1 order by b.finished_at desc limit 20;
```

---

## 9. Arquitectura recomendada para 36 h

```
 [Botón "Medir ahora"] ──┐
 [Cron diario Vercel]  ──┼──> POST /api/perf/run  (Vercel, Node, maxDuration 300)
 [Webhook de deploy]   ──┘        │ inserta perf_runs status='pending' (la UI escucha por Realtime)
                                  │ Promise.all(3 × runPsi(url, MOBILE)) ──> PSI v5 (Google corre Lighthouse 13)
                                  │ summarize() + diagnose() ──> perf_runs 'done' + perf_findings
                                  └ compareRuns(punto anterior, punto nuevo) ──> si hay regresión: motor de reglas ──> alerta
 [GitHub Actions del repo: on deployment_status] ── lighthouse 13.5.0 ×3 + computeMedianRun
                                  └──> POST /api/perf/ingest (HMAC sha256) ──> mismo summarize/diagnose/compare
 [POST /api/builds/sync]  ──> GitHub REST (runs, jobs, check-runs) [+ Vercel v7/v3 en P2] ──> build_runs
 [Botón "Generar prompt de corrección"] ──> Claude recibe diagnose() compacto + package.json ──> prompt para la IA del usuario
```

- **Vía A (P0, motor): PSI.** Es lo único que tiene que funcionar sí o sí en la demo. Una invocación mide 1 URL × 1 estrategia × 3 repeticiones en paralelo, unos 120 s como máximo, dentro de los 300 s de Hobby. Varias URL = varias invocaciones (una por target), nunca un bucle secuencial dentro de una sola invocación [propuesta].
- **Vía B (P1, ambición técnica): librería Node en GitHub Actions**, sobre la app de demo del equipo. Cumple el pedido literal ("usando la librería Node de Lighthouse"), da la serie más estable y asocia el commit de forma nativa.
- **Datos sembrados (P0 de demo):** dos commits de la app de demo, uno sano y otro con una regresión deliberada (imagen de varios MB sin `width/height` + script de terceros bloqueante en `<head>` + polyfill legado). Así el gráfico baja y el "dónde" señala `image-delivery-insight`, `render-blocking-insight`, `legacy-javascript-insight` y `cls-culprits-insight` [propuesta].

### 9.1 Workflow de la vía B

```yaml
# .github/workflows/perf.yml  (en la app de demo o en el repo del usuario)
name: perf-lighthouse
on:
  deployment_status:
  workflow_dispatch:
    inputs:
      url: { description: 'URL a medir', required: true }
jobs:
  lighthouse:
    if: github.event_name == 'workflow_dispatch' || github.event.deployment_status.state == 'success'
    runs-on: ubuntu-24.04            # trae Google Chrome instalado
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v4  # [no verificado: confirmar el major vigente de setup-node]
        with: { node-version: 24 }
      - working-directory: .github/perf     # package.json propio: no instala las deps de la app
        run: npm install lighthouse@13.5.0 chrome-launcher@1.2.2 && node ci-run.mjs
        env:
          TARGET_URL: ${{ github.event.deployment_status.target_url || inputs.url }}
          COMMIT_SHA: ${{ github.sha }}
          ENVIRONMENT: ${{ github.event.deployment_status.environment || 'manual' }}
          CRM_INGEST_URL: ${{ secrets.CRM_INGEST_URL }}
          CRM_INGEST_SECRET: ${{ secrets.CRM_INGEST_SECRET }}
          CRM_REPO_ID: ${{ secrets.CRM_REPO_ID }}
```

```js
// .github/perf/ci-run.mjs
import crypto from 'node:crypto';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { computeMedianRun } from 'lighthouse/core/lib/median-run.js';

const { TARGET_URL, COMMIT_SHA, ENVIRONMENT, CRM_INGEST_URL, CRM_INGEST_SECRET, CRM_REPO_ID } = process.env;
const runs = [];
for (let i = 0; i < 3; i++) {                                    // secuencial (variability.md)
  const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-sandbox'] });
  try {
    const r = await lighthouse(TARGET_URL, { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance'] });
    if (r?.lhr && !r.lhr.runtimeError) runs.push(r.lhr);
  } finally { await chrome.kill(); }
}
if (!runs.length) { console.error('Sin corridas válidas'); process.exit(1); }
const lhr = computeMedianRun(runs);
delete lhr.fullPageScreenshot; delete lhr.i18n;                  // recorta el peso (límite de 4,5 MB por request en Vercel)
for (const k of ['screenshot-thumbnails', 'final-screenshot']) delete lhr.audits[k];
const body = JSON.stringify({ source: 'lighthouse-node', commitSha: COMMIT_SHA, environment: ENVIRONMENT, url: TARGET_URL, runCount: runs.length, lhr });
const sig = 'sha256=' + crypto.createHmac('sha256', CRM_INGEST_SECRET).update(body).digest('hex');
const res = await fetch(CRM_INGEST_URL, { method: 'POST', body,
  headers: { 'content-type': 'application/json', 'x-signature': sig, 'x-repo-id': CRM_REPO_ID } });
console.log('ingest', res.status);
if (!res.ok) process.exit(1);
```

```ts
// app/api/perf/ingest/route.ts  (verificación HMAC en tiempo constante; el secreto por repo se guarda cifrado, ver informe de seguridad)
import crypto from 'node:crypto';
export const runtime = 'nodejs';
export async function POST(req: Request) {
  const raw = await req.text();
  const secret = await getIngestSecret(req.headers.get('x-repo-id'));          // descifra desde Supabase; null si no existe
  const got = Buffer.from(req.headers.get('x-signature') ?? '');
  const exp = Buffer.from('sha256=' + crypto.createHmac('sha256', secret ?? crypto.randomBytes(32)).update(raw).digest('hex'));
  if (!secret || got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) return new Response('firma inválida', { status: 401 });
  const { lhr, commitSha, environment, url, source } = JSON.parse(raw);
  const d = diagnose(lhr);                                                     // misma función que la vía A
  // insert perf_runs (+ perf_findings) con commit_sha, environment, source; luego compareRuns contra el punto anterior
  return Response.json({ ok: true, score: d.summary.perfScore });
}
```

**Previews protegidas:** la cabecera `x-vercel-protection-bypass` [verificado: protection-bypass-automation] se podría pasar con `extraHeaders` de Lighthouse. Pero creo que `extraHeaders` se envía a **todas** las peticiones de la página, terceros incluidos, y el secreto se filtraría [no verificado]. Para la demo: medir producción o dejar sin protección la preview de la app de demo [propuesta].

**Uso eficiente de Claude [propuesta]:** solo se llama a Claude cuando hay una regresión o cuando el usuario pulsa el botón. Se le manda el `diagnose()` recortado (unos 4 KB) más los datos del stack (`package.json`, framework) y la respuesta se cachea por `run_group`. El ranking y la detección los hace el código (`metricSavings` + `compareRuns`), no el modelo. Es coherente con la decisión previa de que las reglas deciden y el modelo solo redacta.

---

## Implicaciones para el plan

**Adoptar**
| # | Qué | Dueño | Esfuerzo |
|---|---|---|---|
| 1 | PSI v5 con `PSI_API_KEY` (crear proyecto en Google Cloud **hoy**, habilitar la API, restringir la key) + `runPsi()` con reintentos y `maxDuration 300` | BACK | S |
| 2 | Tablas `perf_targets`, `perf_runs`, `perf_findings`, `build_runs` y la vista `perf_points` (sección 8) con RLS por `org_id` | BACK | S |
| 3 | `summarize()` / `diagnose()` / `compareRuns()` (secciones 5.3 y 6.3, ya probadas sobre el LHR 13.5.0) | BACK | M |
| 4 | UI de "Comportamiento histórico": líneas de score/LCP/TBT/CLS por punto = commit (tooltip con sha y deploy), barra Δ contra la versión anterior, lista de hallazgos "dónde" (archivo/URL, selector LCP, tercero) y botón grande "Medir ahora" con estado `pending` vía Realtime | FRONT | M |
| 5 | Sincronización de GitHub Actions: runs + jobs + anotaciones → `build_runs`; tarjetas "duración p50/p90", "tasa de fallos" y "errores en el último build" | BACK + FRONT | M |
| 6 | Vía B: `perf.yml` + `ci-run.mjs` + `/api/perf/ingest` con HMAC, en la app de demo | BACK | M |
| 7 | Sembrar dos versiones de la app de demo (sana y con regresión deliberada) y medir ambas antes del ensayo del sábado por la noche | Orquestador | S |
| 8 | Vercel Deployments v7 + events v3 (duración del build y errores) | BACK | S (P2) |

**Evitar**
- Lighthouse dentro de una función de Vercel con `@sparticuz/chromium`: desaconsejado por Lighthouse (FaaS, 1 vCPU), frágil y con riesgo SSRF.
- Servidor LHCI, o `treosh/lighthouse-ci-action@v12` mezclado con PSI: es Lighthouse 12.6 y da IDs y métricas incomparables.
- PSI sin key (429 comprobado hoy).
- Mandar el LHR crudo a Claude (más de 500 KB): solo `diagnose()`.
- Comparar 1 corrida contra 1 corrida sin umbral absoluto, o mezclar `source` o versiones mayores de Lighthouse en una misma serie.
- El endpoint `/actions/runs/{id}/timing` (en cierre).
- Prometer INP de laboratorio: en navegación no existe. Se muestra TBT como proxy y el INP de campo solo si CrUX lo trae.

**Riesgos y mitigación**
- PSI responde 429/500 o tarda hasta 120 s → reintentos con backoff, UI asíncrona y datos sembrados como respaldo del video.
- Variabilidad entre corridas → 3 repeticiones + mediana + umbral doble. En la UI, "indicativo" cuando `n < 3`.
- PSI cambia de versión de Lighthouse (13.x → 14) → guardar `lighthouse_version`, IDs candidatos en el parser, y cortar la serie si cambia el major.
- URL que pone el usuario → validar `https:` y bloquear IPs privadas antes de enviarla (aunque PSI navegue desde Google).
- Previews protegidas o páginas con login → fuera de alcance en las 36 h; se mide la URL pública.
- `loadingExperience` (CrUX) vacío en sitios con poco tráfico y en vías de retiro en PSI → opcional y nunca bloqueante.
- Permisos del token de GitHub → documentar en la guía del módulo el token fine-grained de solo lectura (los nombres exactos de los permisos están por verificar).

**Esfuerzo total estimado** [propuesta]: vía A + esquema + UI básica ≈ 6–8 h-persona (P0). Vía B ≈ 3 h (P1). Compilaciones de GitHub ≈ 3 h (P1). Vercel ≈ 2 h (P2).
