# Insumo de alineación del PLAN MAESTRO (sábado 24-oct-2026, ~03:45 Caracas)

Este archivo MANDA sobre el plan cuando choquen. Parte A: hechos ya ejecutados y verificados esta madrugada.
Parte B: criterios del jurado en su redacción oficial nueva. Parte C: cómo adaptar el plan a ambas cosas.

## A. Estado real (hecho y verificado)

### A1. Dominio y zona `officialvanguard.com` (Cloudflare)
- Registrado en Squarespace Domains el 2026-10-24. Bloqueo de transferencia de registrador hasta el 2026-12-23 (regla ICANN); no hace falta transferir: solo se movieron los nameservers.
- Nameservers `martin.ns.cloudflare.com` y `ziggy.ns.cloudflare.com`. Zona **activa**, plan **Free**. Cuenta `eda2c45921f84ec5add25f379bbdbfb5`, zona `14d12778b0249e6d6854a67876c37e72`.
- **DNSSEC activo** con Cloudflare (DS keyTag 2371, algoritmo 13, digest type 2 pegado en Squarespace; valida en Google DNS).
- Ajustes ya aplicados: SSL **Full (strict)**, **Always Use HTTPS**, **TLS mínimo 1.2**, TLS 1.3, Automatic HTTPS Rewrites, `security_level` medium, `browser_check` on. DNS: TXT `v=spf1 -all` y `_dmarc` `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s`.
- **Bot Fight Mode APAGADO a propósito**: en Free no admite excepciones y rompería los webhooks de Kapso, ElevenLabs y GitHub. Se reemplaza por una regla de rate limit en `/api`.
- Pendiente en la zona: `www` → 301 al apex (hoy `www` es Custom Domain del Worker), revisar reglas administradas del WAF, regla de rate limit en `/api/`, HSTS el domingo 07:00, DKIM nulo opcional.

### A2. Worker `vanguard` y despliegue continuo
- Existe el Worker `vanguard` con Custom Domains en el apex y en `www`, y respaldo `https://vanguard.giovannizm14.workers.dev`. Hoy sirve la **página provisional** `site/` (index.html + `_headers` con CSP) desde `apps/api/wrangler.jsonc` (`assets.directory: "../../site"`, `compatibility_date 2026-10-20`, `nodejs_compat`, `workers_dev: true`, routes apex + www). Plan Workers **Free**: Workers Paid (5 USD/mes) sigue pendiente (tarjeta de Giovanni) y es necesario antes del backend.
- **CI/CD = Workers Builds, NO GitHub Actions.** El Worker está conectado al repo espejo `Giova144-git/VanGUARD`, rama `main`, root `/`, build command vacío, deploy command `npx wrangler deploy -c apps/api/wrangler.jsonc`. Probado: push → build (~15 s) → publicado en el dominio. Sustituye a `.github/workflows/deploy.yml`, al bucle `--secrets-file` y a los secretos de Actions del plan.
- `git push` desde la copia de Giovanni empuja a DOS repos: `platanus-hack/platanus-hack-26-ve-team-22` (el que ven los jueces) y el espejo `Giova144-git/VanGUARD` (el que despliega). Solo esa copia local tiene el doble push.
- Hechos de Workers Builds [verificado: https://developers.cloudflare.com/workers/ci-cd/builds/configuration/ y /build-image/]: usa **Node 24.18** por defecto; respeta `packageManager: pnpm@10.34.7`; **instala dependencias automáticamente** según el lockfile (`SKIP_DEPENDENCY_INSTALL=1` lo desactiva); inyecta `WORKERS_CI_COMMIT_SHA`, `WORKERS_CI_BRANCH` y `WORKERS_CI_BUILD_UUID` (sirven para `VG_VERSION`); las variables de build NO llegan al runtime.
- **Secretos del Worker**: se cargan en el panel (Workers & Pages → `vanguard` → Settings → Variables and Secrets) o por la API de Cloudflare; nunca en el repo ni en Actions. `IA_CORTE` sigue siendo solo de panel. **Cloudflare no deja agregar variables ni secretos de runtime a un Worker que solo tiene assets** («Variables cannot be added to a Worker that only has static assets»): los secretos del BACK se cargan cuando `apps/api` tenga `main` (hito de las 09:00–10:00) y sobreviven a los deploys siguientes.
- **Variables del FRONT (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) = variables de BUILD** de Workers Builds (Settings → Build → Build Variables and Secrets), porque Vite las incrusta en el bundle al compilar; son públicas por diseño (la publishable aplica RLS). Nunca un `sb_secret_` ahí. Sustituyen a las «vars de Actions» del plan.
- Cuando exista `apps/web`: build command `pnpm --filter @vanguard/web build`; en `apps/api/wrangler.jsonc` `assets.directory` pasa a `../web/dist` con `not_found_handling: "single-page-application"` y `run_worker_first` (03.7), y se agrega `main` (`src/worker.ts`), `vars`, crons, cola, Workflow y `RL_API`. `VG_VERSION` se pasa en el deploy command con `--var` usando `WORKERS_CI_COMMIT_SHA` [no verificado: sintaxis exacta del shell del build].

### A3. Supabase
- **Un solo proyecto** del producto: «hackaton 22», ref `accshmgmfrqrxubpuxcl`, región us-west-2, Postgres 17, `https://accshmgmfrqrxubpuxcl.supabase.co`, creado por Giovanni el 2026-10-24 con `public` vacío. Sustituye a `vanguard-prod` y `vanguard-dev` del plan: en el hackatón dev y prod son el mismo proyecto (migraciones una sola vez; las pruebas IDOR usan usuarios de prueba en ese proyecto).
- El chat BACK ya está conectado a ese proyecto (conector Supabase de claude.ai y `.mcp.json` en la raíz con el MCP de Supabase y `project_ref`).
- El proyecto **víctima** `vanguard-demo` (sembrado, con su PAT de solo lectura) sigue siendo aparte y sigue pendiente.

### A4. Chats y forma de trabajo
- Los chats FRONT, BACK y ORQUESTADOR son **sub-chats de Giovanni** en el mismo proyecto y **la misma carpeta local**. No se delegan a otras personas; todo se hace aquí.
- Reglas: commit **directo en `main`** (la rama `giova` ya no se usa); cada chat agrega **solo sus archivos** (`git add apps/web`, `git add apps/api supabase packages/core`…), **nunca `git add -A`**; push solo cuando Giovanni lo pide; quien agregue una dependencia regenera el lockfile con `pnpm install --lockfile-only` (no baja binarios) o el build de Cloudflare falla.
- Las personas del equipo (Carlos, Daniel, Andrés, Gabriel) siguen para trabajo humano: cuentas externas (Kapso, Twilio, ElevenLabs, proyecto víctima), red team, QA, README escrito a mano, video y pitch.

### A5. Monorepo ya creado por el ORQUESTADOR
- Raíz: `package.json` (03.2), `pnpm-workspace.yaml`, `.npmrc`, `tsconfig.base.json`, `.gitignore` (03.7), `.env.example` (catálogo de 03.6), `scripts/lint-imports.mjs`, `pnpm-lock.yaml` (generado con `--lockfile-only`).
- `packages/contracts` v0: `comun.ts`, `api.ts`, `estado.ts`, `ingest.ts`, `realtime.ts` (esquemas de S15 §15.5 y §15.6 con sus tipos), `index.ts`, fixtures de S14 §14.19 y `contracts.test.ts`.
- Pendiente de sus dueños: `apps/web` (FRONT), código de `apps/api` y `packages/core` y `supabase/migrations` (BACK), copias filtradas `.dev.vars.example` / `.env.example` por app.

### A6. Entorno de este equipo
- Norton **no bloquea los MCP** (corrección de Giovanni): se usan con normalidad. Sí bloquea `.exe` nuevos sin firma: se quitaron los `workerd.exe` de la CLI `cf` y los `fastlist.exe` de pnpm global. No se instala localmente nada que traiga `.exe` (wrangler, miniflare, workerd, esbuild binario). **Ya probado (sáb 03:56):** `pnpm install --frozen-lockfile` en la raíz instala 48 paquetes con 0 `.exe` (solo los addons `.node` de Rolldown y LightningCSS); `pnpm --filter @vanguard/contracts typecheck` pasa y `vitest run` corre en este equipo (24/24 pruebas): Norton deja cargar el `.node` de Rolldown. La prueba de humo del FRONT de las 08:00 queda reducida a `vite dev` con React y Tailwind.
- **Archivos locales de variables:** existe `.env` en la raíz (ignorado por git) con los 30 nombres del catálogo y valores que llena Giovanni; cada app copia su bloque a su archivo local. **Ningún chat de IA lee `.env`, `.dev.vars` ni `.env.*.local`** (lo que lee viaja al modelo): solo `.env.example`. `PLAN_MAESTRO.md` está en `.gitignore` (plan interno, 16.9).
- Herramientas disponibles: CLI `cf` (zonas, DNS, settings, builds), conector Cloudflare de claude.ai (Workers, KV, R2, D1, docs), plugin `cloudflare@cloudflare`, pnpm 10.34.7 global.

### A7. Decisión de Giovanni (sáb ~04:30): **Workers FREE, no Paid**
Límites del plan Free [verificado: https://developers.cloudflare.com/workers/platform/limits/, /workflows/reference/pricing/, changelog 2026-02-04 Queues Free]: **10 ms de CPU** por petición HTTP y por Cron (la espera de red NO cuenta); **50 subpeticiones externas** por invocación (+1.000 a servicios de Cloudflare); **100.000 peticiones/día** (los assets estáticos son gratis e ilimitados); **5 Cron Triggers** por cuenta; **Queues incluidas** (10.000 operaciones/día, retención 24 h); **Workflows incluidos** (3.000 pasos/día, 10 ms CPU por invocación, estado 100 MB, retención 3 días); `limits.cpu_ms`/`limits.subrequests` no se pueden subir en Free.
Adaptaciones obligatorias del plan:
1. **ZIP analizado en el navegador** (fflate en `apps/web`): se extraen lockfiles y se buscan secretos localmente; al API solo llega la lista de dependencias y hallazgos ya enmascarados. Sin R2. Argumento de producto: «tu código nunca sale de tu navegador».
2. **Auditoría por pasos encadenados en una Queue** (un mensaje por paso: supabase, cloudflare, repo, psi, resumen_ia), cada consumo con su propio presupuesto de ≤ 40 subpeticiones y CPU mínima; ~18 operaciones de cola por auditoría. El Workflow `vg-scan` queda como alternativa solo si la prueba de humo demuestra que cada paso corre en su propia invocación [no verificado].
3. **Repo acotado**: solo archivos de riesgo (lockfiles, `.env*`, configs, ~20 archivos con tope de tamaño), nunca el árbol entero; si no cabe en 10 ms, ese paso se mueve a una **Supabase Edge Function** (Free, CPU de segundos) a la que el Worker pasa el token descifrado por TLS en la llamada, sin guardarlo.
4. **Monitoreo por minuto directo en el Cron** (sin cola: con cola gastaría ~13.000 operaciones/día); máximo 3 crons (monitor/minuto, mantenimiento/hora, re-auditoría diaria).
5. **Menos peticiones**: polling del FRONT a 10 s y solo con la pestaña visible; **Realtime de Supabase sube a P0** (no gasta peticiones del Worker); la víctima envía la ingesta **en lotes** (≤ 100 eventos o cada 2 s), no una petición por evento.
6. **Sin Tail Workers** (hoja de ruta); sin `limits` en `wrangler.jsonc`.
7. **Prueba de humo del BACK a las 08:00**: cola con 3 pasos de 40 fetches y medir CPU en Workers Observability; si algo no cabe → Edge Function de Supabase. Workers Paid (5 USD) queda solo como último recurso y lo decide Giovanni.
8. Mensaje para el jurado (criterio técnico «eficiente»): «VanGUARD entero corre en el plan gratuito de Cloudflare: 10 ms de CPU por petición».

### A8. Presupuesto en efectivo = 0 (decisión de Giovanni, sáb ~04:40)
- Ya tienen llaves de **Kapso** y **ElevenLabs**; fuera de eso **no se gasta dinero**. Claude sale de los 250 USD de créditos (tope por workspace en la consola de Anthropic + `IA_CORTE` + topes diarios del código).
- Cloudflare Free (A7), Supabase Free, R2 eliminado (ZIP en el navegador), PSI/OSV/GHSA/KEV/EPSS gratuitos, Kapso en **sandbox** (sin recarga).
- **Twilio** (número + minutos a +58, ~21 USD en el plan) es el único gasto que quedaba: se intenta con **cuenta de prueba** (llama solo a números verificados del equipo, anuncia «trial account»; permiso a +58 [no verificado]). Si no sirve, plan B sin costo: alerta crítica por WhatsApp (sandbox de Kapso) + «llamada» dentro de la app con el agente de ElevenLabs por WebRTC (sin número). Pagar Twilio solo con aprobación explícita de Giovanni.
- Ninguna herramienta pagada nueva (web search de Anthropic, Browser Run, etc.) sin aprobación de Giovanni.
- **Prioridad de canales (decisión de Giovanni): WhatsApp primero, llamada después.** WhatsApp por Kapso es **P0** y el centro de la demo: aviso del incidente en < 30 s y **aprobación de «Bloquear IP» con botón de WhatsApp + código de un solo uso** (resuelve la decisión abierta 10 a favor de adelantarla al sábado). La **llamada de voz** (ElevenLabs) pasa a **P1**: se construye después de que WhatsApp funcione de punta a punta, con Twilio de prueba o, si no sirve, como voz dentro de la app (WebRTC, sin número). El guion de demo, el cronograma y las pruebas de humo se reordenan con esta prioridad; el recorte del BACK nunca toca WhatsApp.
- **Créditos de Claude**: los 250 USD se usan para el motor de IA (reparto del plan: ~100 desarrollo, ~60 demo, ~90 reserva), con tope por workspace en la consola de Anthropic.

### A9. Contrato v0 subido (commit `e7398f6`, sáb ~05:00) y lo que destaparon los fixtures
- En `main` (los dos repos): raíz del monorepo + `packages/contracts` (esquemas de §15.5 con la regex nueva de `repo_full_name`, realtime, 20 fixtures en `src/fixtures/` y `contracts.test.ts`: 24 pruebas en verde). `.gitignore` ahora también ignora `/PLAN_MAESTRO.md`, `package-lock.json` y `yarn.lock` (el monorepo es pnpm; alguien corrió `npm install` en la raíz a las 03:54).
- Historia de los fixtures (S14 §14.19 debe coincidir): org «Tienda Demo», auditoría 18:01–18:04Z con puntaje 20 (rojo, 4 de 4 fuentes); ataque desde 203.0.113.7 a las 19:01Z (incidente `A1F3C9`): nace high, **WhatsApp a +8,4 s**, sube a critical a **+26,1 s** (tras `--admin-desde 25`), llamada a +27,5 s (P1). El texto de S14 que dice «llamada a +20 s» queda viejo.
- `exportMd` fiel a E25 tiene ~426 líneas (12 hallazgos con su corrección): se acepta.
- **S09 debe agregar una lista de permitidos** para nuestros propios marcadores de redacción (`[SECRET:<regla>]`, `postgres://…:[REDACTADO]@`, `••••`), que hoy dispararían `CB_SECRET_GENERIC` y `CB_SECRET_POSTGRES_URL` al auditar nuestro propio repo (dogfooding).
- `FilaDato.tipo`: S07 usa `incident` y S08 `incidente`; se unifica en **`incident`**.
- `PerfRun` no tiene `version_label`: S10 lo resuelve con `PerfRunExt` (§10.9), que todavía NO está en `packages/contracts`; agregarlo es tarea del ORQUESTADOR antes del congelamiento de las 11:00.

## B. Criterios del jurado (redacción oficial nueva, textual)

- **Originalidad (15%):** ¿Están creando algo nuevo? Si le pregunto a mi agente, ¿encuentra algo muy similar que ya ha sido creado?
- **Ambición (20%):** ¿Apuntan a resolver algo grande? ¿Qué tanto se están desafiando y empujando los límites?
- **Ejecución (20%):** ¿Qué tanto lograron avanzar y crear en esta hack? ¿Es el avance esperado para un equipo talentoso, con 36 horas y herramientas de IA de frontera?
- **Impacto (20%):** ¿Qué tanto mejora la vida de las personas? ¿Es un salto importante vs el status quo?
- **Aspecto técnico (25%):** ¿Hay ingeniería real detrás de su solución? ¿Los métodos usados tienen sentido en la solución? ¿Es una solución robusta, eficiente, segura?

## C. Cómo adaptar el plan

1. **Originalidad = lo que encuentre el agente del juez.** Anticipar la búsqueda: nombrar lo parecido que existe (Aikido, Snyk, Socket, GitGuardian, Supabase Security Advisor, Cloudflare Security Center, Datadog, agentes «AI SRE», escáneres de RLS para apps hechas con IA) y escribir en 3 frases verificables en vivo qué hace VanGUARD que ninguno hace junto (p. ej. correlación entre Supabase + Cloudflare + repo en un incidente, verificación activa en vez de solo configuración, alerta por llamada/WhatsApp con aprobación de la acción, prompt de corrección para la IA del cliente y MCP propio). Un párrafo listo para el pitch y para `project-description.md`.
2. **Ambición:** dejar claro el problema grande (seguridad de la ola de apps hechas con IA por equipos sin especialistas) y qué límites empujamos en 36 h; hoja de ruta creíble (más proveedores vía MCP, Vercel, PR automáticos).
3. **Ejecución = avance esperado de un equipo talentoso con IA de frontera.** La vara es alta: maximizar superficie que FUNCIONA de verdad y se ve en el dominio, historial de commits visible, métricas medidas (cronómetro de tiempo-a-alerta), marcar qué es real y qué es simulado. Mostrar lo ya hecho de madrugada (dominio, DNSSEC, Workers Builds, monorepo, contrato) como avance real.
4. **Impacto:** cuantificar el salto vs el status quo (tiempo de detección, personas no técnicas que entienden y actúan, costo vs alternativas) y para quién.
5. **Aspecto técnico:** por cada decisión fuerte, una línea de **por qué el método tiene sentido** (reglas deterministas deciden la alerta y no el modelo; OSV en vez de solo NVD; PSI en vez de Lighthouse local; cifrado de sobre; Workflows; edge). Y evidencia de **robusto** (pruebas, reintentos, idempotencia, degradación), **eficiente** (costo por auditoría de IA, caché, edge, tiempos) y **seguro** (modelo de amenazas, mínimo privilegio, defensa de inyección, auditoría, el producto auditándose a sí mismo).
6. Reflejar los hechos de la Parte A en todo el plan: donde diga GitHub Actions / `deploy.yml` / `--secrets-file` / secretos de Actions → Workers Builds y secretos de panel; donde diga `vanguard-prod`/`vanguard-dev` → el proyecto `accshmgmfrqrxubpuxcl`; donde diga que hay que mover el dominio o crear la zona → ya hecho; donde reparta chats entre personas → los chats son de Giovanni; donde diga que Norton bloquea MCP → corregir.
