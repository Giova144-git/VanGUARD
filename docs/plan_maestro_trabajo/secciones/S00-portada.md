# VanGUARD — Plan maestro

## 00. Portada y cómo usar este documento

**Producto:** VanGUARD (con GUARD en mayúsculas). **Equipo:** team-22 · Platanus Hack 26 Caracas · track AI Security (Carlos Bastidas, Giovanni Zarbo, Daniel Barreda, Andrés Valero, Gabriel García).
**Fecha del plan:** sábado 24 de octubre de 2026, ~02:30 (hora de Caracas, UTC−4). **Entrega:** domingo 25 de octubre a las 12:00.
**Deploy-url oficial:** `https://officialvanguard.com` (dominio comprado hoy en Squarespace Domains; zona ya gestionada por Cloudflare). La víctima de la demo vive en `https://demo.officialvanguard.com`.

> **Frase de producto.** VanGUARD es una herramienta digital que protege tu producto: analiza tu ecosistema en la nube (Supabase, Cloudflare y tu repo de GitHub) contra los puntos débiles conocidos, te avisa en tiempo real por WhatsApp o con una llamada y te da el arreglo listo para tu IA, sin pedirte nunca una clave que pueda escribir.

### 00.1 Cómo usar este documento

**Precedencia (manda de arriba abajo):** (1) la sección **15** (contrato API y esquemas zod) y la sección **05** (DDL y cifrado); (2) el **Anexo A** (decisiones canónicas, ya actualizado con las decisiones de la fusión final); (3) el resto de secciones. Marcas: `[verificado: URL]` comprobado hoy; `[no verificado]` falta comprobarlo antes de prometerlo; `[propuesta]` umbral o decisión nuestra. Prioridades: **P0** = la demo lo necesita (listo el sábado 20:00), **P1** = domingo 10:00, **P2** = hoja de ruta. Todas las horas son de Caracas.

| Chat | Pega **completa** en su chat | Lee y ejecuta | Consulta cuando lo necesite |
|---|---|---|---|
| **FRONT** (Carlos) | **Sección 14** entera y su prompt de arranque (16.12) | 15.4–15.5 (contrato y esquemas, solo lectura), 16.2, 16.3, 16.6 y el Anexo A | 01 (textos de marca), 07–10 (pantalla de cada módulo), 12 (incidentes y cronómetro), 13 (exportar y MCP), 06.6 (sesión) |
| **BACK** (Andrés y Daniel) | **Sección 15** entera y su prompt de arranque (16.12) | 05 (DDL, cifrado, migraciones), 06 (seguridad del producto), 16.3, 16.5, 16.6 y el Anexo A | 07–13 (detalle de cada módulo, IA, alertas, export), 04 (arquitectura) |
| **ORQUESTADOR** (Giovanni) | Anexo A y la sección **16** entera, con su prompt de arranque (16.12) | 03 (03.4 dominio, 03.6 variables, 03.7 despliegue), 15.5 (lo copia a `packages/contracts`), 05.3 y 05.11, 06.11–06.13, 01 (pitch y entrega), 02 (mejoras), 04 | Todas: es quien aprueba cambios de contrato y resuelve las decisiones abiertas de 00.7 |

Reglas que no cambian: un chat **nunca** edita la carpeta de otro (los campos nuevos se piden al ORQUESTADOR, que los añade como opcionales a `packages/contracts`); los contratos se congelan el sábado a las 11:00; nadie genera ejecutables (Norton) ni escribe `README.md` con IA; ningún secreto va al repo ni a un chat.

### 00.2 Resumen ejecutivo

1. **Qué es:** un CRM de seguridad por módulos, con botones grandes y una guía en cada pantalla, para startups que viven en Supabase, Cloudflare y GitHub.
2. **Qué pide al usuario:** solo tokens de **solo lectura** (PAT con alcance `sbp_fc` de un proyecto, API Token de lectura de una zona, PAT fine-grained de un repo) y rechaza con explicación cualquier clave capaz de escribir (`sb_secret_`, `service_role`, Global API Key, `ghp_`).
3. **Auditoría de un botón:** el Workflow `vg-scan` revisa Supabase (advisors y tres SQL de solo lectura: RLS apagada, políticas pase-todo, funciones sin freno), Cloudflare (zona) y el repo (`.env` subido, `.gitignore`, secretos, dependencias con CVE vía OSV) y da un puntaje 0–100 **siempre con la cobertura al lado**.
4. **Tiempo real:** la app del cliente (en la demo, nuestra víctima) firma cada petición y la manda a `/ingest`; un **motor de reglas determinista** detecta escaneos, herramientas de ataque, rutas de admin abiertas e inundaciones por IP y abre un incidente.
5. **Avisos:** WhatsApp interactivo por Kapso en `high` y llamada de voz de ElevenLabs + Twilio en `critical`, con techos por org; **la regla decide, nunca el modelo**.
6. **Neutralizar:** «Bloquear esta IP» crea una IP Access Rule en Cloudflare con simulación previa, código de un solo uso y «Deshacer», usando un segundo token de acciones opcional.
7. **Corrección:** Claude (Sonnet 5.5) escribe un prompt de corrección por hallazgo con pasos y prueba de aceptación; Opus 5.5 resume la auditoría. Si la IA falla o se apaga, salen plantillas.
8. **Llevar a cualquier IA:** export en Markdown y JSON, deterministas y redactados, con «Copiar para mi IA»; en P1, un servidor MCP propio de solo lectura en `/mcp`.
9. **Seguro por diseño:** cifrado de sobre AES-256-GCM con la KEK partida entre Supabase Vault y una pimienta del Worker; huella HMAC solo para deduplicar; evidencia cercada como dato no confiable.
10. **Despliegue:** todo en Cloudflare (un Worker con la SPA, la API Hono, el cron, la cola, el Workflow y el MCP) sobre `officialvanguard.com`; Supabase Free para datos; CI con GitHub Actions.
11. **Dogfooding:** nuestra propia zona está en Cloudflare y el módulo Cloudflare la audita en la demo; la víctima comparte zona, así que «Bloquear IP» corta en el borde de verdad.
12. **Dominio:** la mudanza a Cloudflare ya está hecha (nameservers delegados, DNSSEC activo, página provisional con 200 en el apex); falta el esqueleto real con `/api/health`, `www` → 301 y `demo.` (00.4).
13. **Demo de 3 minutos:** conexiones con rechazo de una clave peligrosa → «Auditar todo» en rojo → ataque reproducible contra `demo.` → WhatsApp → llamada → «Bloquear IP» → línea de tiempo con los tiempos medidos → exportar.
14. **IA con presupuesto cerrado:** 250 USD en dos workspaces con límite, topes diarios por org, escalera de degradación e interruptor de corte; el viewer anónimo del jurado nunca gasta.
15. **Ejecución:** tres chats (FRONT, BACK, ORQUESTADOR) que trabajan en paralelo contra fixtures validados con zod; P0 cerrado el sábado 20:00, video de respaldo a las 22:30.

### 00.3 Decisiones clave

| Tema | Decisión | Detalle |
|---|---|---|
| Hosting | **Todo en Cloudflare Workers Paid** (5 USD/mes): Worker `vanguard` con assets (SPA) + API Hono + Cron `* * * * *` → Queue `vg-monitor` + Workflow `vg-scan` + `/mcp` (P1). Sin Vercel, Railway ni Pages como hosting | §03, §04, Anexo A §3–§4 |
| Dominio y URLs | Apex `https://officialvanguard.com` (Custom Domain del Worker); API, ingesta, webhooks y MCP como **rutas** del apex (`/api/*`, `/ingest/*`, `/webhooks/*`, `/mcp`), sin `api.` ni `mcp.` y sin CORS; `www` → 301 al apex; víctima en `demo.officialvanguard.com`; respaldo `vanguard.<subdominio>.workers.dev` | §03.4, §16.5 |
| FRONT | Vite 8.3.5 + React 19.3.1 + react-router 7.18.4 + TanStack Query 5.104.5 + Tailwind 4.3.3 + shadcn 4.22.1 + Recharts 3.10.1; polling en P0, Realtime en P1 | §14 |
| BACK | Node 24 (type stripping) para desarrollo, Hono 4.13.13, zod 4.6.7, `@supabase/supabase-js` 2.118.0, `@anthropic-ai/sdk` 0.137.0, fflate 0.8.3; wrangler 4.152.0 **solo** con `pnpm dlx` en CI | §03, §15 |
| Datos | Supabase Free: `vanguard-prod` y `vanguard-dev` (RLS por `org_id`, Vault, pg_cron); víctima `vanguard-demo` en otra cuenta; R2 para ZIP (P1) | §05 |
| Credenciales | Cifrado de sobre AES-256-GCM, DEK por credencial, KEK = HKDF(Vault `kek_v1`, pimienta `VG_KEK_PEPPER`), AAD con org y conexión; huella HMAC(FPK, `org_id|token`); nunca un endpoint que devuelva un secreto | §05.6–05.7 |
| Módulos **P0** | Conexiones con guardas · Resumen con puntaje y cobertura · Supabase (advisors, SQL 1–3b, salud) · Cloudflare (ingesta + `CF_ADMIN_EXPOSED`, `CF_PATH_SCAN`, `CF_UA_TOOL`, `CF_IP_FLOOD`, Bloquear IP, pulso GraphQL, dogfooding) · Codebase (zipball, `.env`, secretos, OSV) · Rendimiento (medición sembrada) · Auditoría de un botón · Incidentes con WhatsApp y llamada · IA-1 e IA-2 · Exportar MD/JSON · Ajustes · Acceso con «Ver demo» | §07–§14 |
| Módulos **P1** | Métricas de servidor de Supabase (CPU, RAM, disco, conexiones), `SB_TABLE_BLOAT`, configuración `CF_DNS/TLS/WAF`, ZIP, KEV, «Medir ahora» con PSI e histórico, MCP propio, IA-3, aprobar desde WhatsApp, escalamiento, Realtime, `tail()`, webhook DDoS, registro de auditoría | §02, §15.14 |
| Módulos **P2** | Vercel como proveedor monitoreado, GitHub App y OAuth, correlación entre capas, SARIF, OAuth 2.1 para ChatGPT, enlaces temporales `vgs_`, EPSS, SAST con IA, tiempos de build | §02.7 |
| Modelos de Claude | IA-1 `fix_prompt`: `claude-sonnet-5-5`, effort medium (~0,033 USD); IA-2 `audit_summary`: `claude-opus-5-5`, effort medium, streaming (~0,25 USD); IA-3 `alert_text` (P1): Sonnet 5.5, effort low, 3 s; Haiku 5.5 en el nivel `minimal`. `fallbacks:"default"` en IA-1 e IA-2; salida con JSON Schema a mano + zod; sin `temperature` ni `tool_choice` | §11, Anexo A §8 |
| Presupuesto IA (250 USD) | 100 USD desarrollo (workspace `team22-dev`) · 60 USD demo y jurado + 90 USD reserva (workspace `team22-prod`, límite 150). Topes diarios: global 40, demo 10, otra org 1,50 USD y 3 auditorías; escalera < 70 % normal, 70–90 % IA-2 con Sonnet, 90–100 % solo Haiku e IA-3 apagada, 100 % sin modelo; interruptor `IA_CORTE` o `app_config.ia_habilitada` | §11.7–11.8 |
| Alertas | Kapso sandbox (interactivo con «Lo estoy viendo» y «Silenciar 1 h»; cuesta céntimos y exige saldo), ElevenLabs + Twilio para la llamada (~0,47 USD por llamada crítica de 90 s a +58); techos 2 llamadas/h y 10 WhatsApp/h (demo 6 y 30) | §12 |
| Zona propia | SSL Full (strict), Always Use HTTPS, TLS ≥ 1.2, WAF administrado, **una** regla de rate limit `/api/` de **400/10 s**, Bot Fight Mode off, SPF `-all` y DMARC `p=reject` conservados, DNSSEC activo, HSTS el domingo 07:00, BIC apagado solo en `demo.` | §03.4, §06.11, §08.11 |
| Límites del Worker | `RL_API` 300/60 s por usuario; `RL_COSTLY` e `RL_INGEST` en P1 | §06.9, §15.3 |

### 00.4 Dominio en Cloudflare: estado y pasos de la mudanza

Comprobado el sábado a las 01:56 y repetido a las 02:25 con DoH (`cloudflare-dns.com`, `dns.google`) y con `curl --resolve officialvanguard.com:443:104.21.53.192` [verificado]. Detalle y verificaciones en §03.4 y §16.5.

| # | Paso | Estado | Cómo se comprueba |
|---|---|---|---|
| 1 | Añadir `officialvanguard.com` a Cloudflare (plan Free) y cambiar los nameservers en Squarespace Domains a los dos de Cloudflare | **Hecho**: `martin.ns.cloudflare.com` y `ziggy.ns.cloudflare.com` | `curl -s "https://cloudflare-dns.com/dns-query?name=officialvanguard.com&type=NS" -H "accept: application/dns-json"` |
| 2 | DNSSEC | **Hecho y activo**: DS `2371 13 2 …` publicado en `.com`, `AD=true`. **No tocar** NS, DS ni DNSSEC (apagarlo con el DS publicado deja el dominio en SERVFAIL). La transferencia de registrador no se hace (60 días de bloqueo) y no hace falta | `curl -s "https://dns.google/resolve?name=officialvanguard.com&type=DS"` |
| 3 | Página provisional en el apex (por si el validador del hackatón comprueba la URL) | **Hecho**: el Worker `vanguard` sirve `site/` con 200; `http://` → 301; desde las 02:25, `/.env` y `/api/health` dan 404 (sin fallback de SPA) | `curl -sI https://officialvanguard.com` (si sale `Server: Squarespace`, es caché local: `ipconfig /flushdns`) |
| 4 | Correo sin envío | **Hecho**: `v=spf1 -all` y `_dmarc` `p=reject; sp=reject; adkim=s; aspf=s`; falta solo el DKIM nulo `*._domainkey "v=DKIM1; p="` | DNS › Records |
| 5 | Esqueleto real en el **mismo** Worker `vanguard` con `GET /api/health` en JSON, `routes` del apex y `workers_dev: true` | **Pendiente** · ORQ + BACK · sáb 09:00–10:00 | `curl -s https://officialvanguard.com/api/health` → `{"ok":true,…}` |
| 6 | `www` → 301 al apex (Redirect Rule `https://www.*` → `https://${1}`, sin duplicar registros) | **Pendiente** · ORQ · siguiente tarea P0 | `curl -sI "https://www.officialvanguard.com/x?y=1"` → 301 a `https://officialvanguard.com/x?y=1` |
| 7 | Ajustes de seguridad de la zona (SSL Full strict, TLS 1.2, WAF administrado, rate limit 400/10 s en `/api/`, Bot Fight Mode off) | **Pendiente** · ORQ · sáb 09:00–10:00 | Tabla de §03.4; auditoría de nuestra zona en verde (P1) |
| 8 | `demo.officialvanguard.com` como Custom Domain de `vanguard-victima` + Configuration Rule `bic: false` solo para ese host | **Pendiente** · ORQ · sáb 15:00 | `curl -s -A "sqlmap/1.8" -o /dev/null -w "%{http_code}" https://demo.officialvanguard.com/` → 200 (sin error 1010) |
| 9 | HSTS (`max_age=15552000`, `includeSubDomains`, sin preload) | **Pendiente** · ORQ · dom 07:00, solo si todo pasó la noche sano por HTTPS | cabecera `strict-transport-security` |
| 10 | URLs registradas fuera con el dominio: Site URL y Redirect URLs **exactas** de Supabase Auth, webhook de Kapso, webhooks y herramienta de ElevenLabs, callback de GitHub (P1), MCP | Pendiente según §16.5 | §03.4 (tabla de URLs canónicas) |

### 00.5 Correcciones hechas a la propuesta original

| # | Planteamiento original | Decisión del plan | Por qué |
|---|---|---|---|
| 1 | «Pasar las keys por una función hash y guardar la pimienta en el Vault» | **Cifrado de sobre reversible y autenticado (AES-256-GCM)** con la KEK partida entre Supabase Vault y una pimienta del Worker; el **HMAC con pimienta queda como huella** (deduplicar, verificar sin descifrar, detectar la propia key filtrada en el repo) | Un hash es irreversible y VanGUARD necesita el token en claro cada minuto para llamar a las APIs; con el sobre, robar la base no basta |
| 2 | Hosting en Vercel (y Railway) | **Todo en Cloudflare**; Vercel solo como proveedor que VanGUARD monitorea (P2) | Cambio del equipo; además permite el dogfooding sobre nuestra propia zona |
| 3 | `*.workers.dev` / `*.pages.dev` como URL | **`https://officialvanguard.com`**, con `*.workers.dev` de respaldo | Dominio comprado y ya delegado a Cloudflare |
| 4 | El modelo podría decidir qué alertar | **La severidad y el canal los decide un motor de reglas determinista**; el modelo solo redacta | Una inyección en un log no puede apagar una alerta |
| 5 | Conectar con `service_role` | **Prohibido**: solo PAT con alcance de solo lectura; se rechazan `sb_secret_`, JWT `service_role`, Global API Key y `ghp_` | Es justo lo que mira un jurado de seguridad |
| 6 | MCP de Supabase dentro del monitoreo | Monitoreo por **REST y GraphQL deterministas**; MCP solo para «conecta tu IA» | Sin tokens de modelo, sin no-determinismo, sin superficie de inyección |
| 7 | Librería Node de Lighthouse | **PageSpeed Insights API v5** (mismo Lighthouse 13 y mismo informe); la librería queda como plantilla de CI para el repo del cliente (P2) | Lighthouse necesita lanzar Chrome, imposible en un Worker y prohibido en las laptops (Norton) |
| 8 | `k6`/`autocannon` para el ataque | `node scripts/ataque.mjs` (fetch de Node, `--admin-desde 25`) | Ningún ejecutable nuevo |
| 9 | Plantilla de WhatsApp aprobada por Meta | **Sandbox de Kapso** con interactivos (la plantilla es P1) | Las plantillas tardan en aprobarse |
| 10 | Realtime desde el arranque · `pgmq` como cola | Polling en P0 y Realtime en P1 · Cloudflare Queues + Workflows | Menos piezas móviles en la ruta crítica de la demo |
| 11 | Canónico: Custom Domain «antes de que la zona propague», DMARC `p=quarantine`, apagar `always_use_https` en la víctima, `tail()` en P0 como sensor, regla de rate limit de 150/10 s, «vemos 3 de 4 fuentes» | Zona ya activa; se conserva DMARC `p=reject`; `always_use_https` nunca se apaga (es de zona); `tail()` vacío en P0 y sensor en P1 (nunca escribe `edge_hits`); **400/10 s**; «vemos N de 4» leído de la pantalla (con la siembra, 4 de 4) | Corregido en la fusión final contra lo comprobado hoy |

### 00.6 Conflictos resueltos en la fusión final

Los revisores reportaron **184 conflictos** entre secciones; todos quedaron resueltos editando las secciones afectadas (manda la 15, luego la 05, luego las decisiones canónicas). Los cambios con más efecto:

- **Dominio:** todas las secciones describen el estado real (delegación, DNSSEC, provisional, `/.env` → 404) y los pasos que faltan; nadie pide ya mover nameservers ni tocar DS/DNSSEC.
- **Valores únicos:** regla de rate limit de zona `contains "/api/"` a **400/10 s**; `RL_API` **300/60 s**; Redirect URLs de Supabase **exactas** (sin `**`); ZIP ≤ **40 MB** descomprimidos; zipball por **sha** con `redirect:'manual'`; métricas sin punto (`cf_req_5m`, `sb_service_ok`), sin fila `cf.pulse`.
- **Contrato (15):** `ActionKind` ampliado; `ProposeAction` con `mode`/`connection_id`; `TimelineItem` con `edge_confirmed`; `ActionPublic.approval_id`; `publishable_key` y `purpose` opcionales en `ConnectionCreate`; `version_label` en `lighthouse`; E10 deshace bloqueos antes de borrar; E11 libera ZIP abandonados; E8 un solo repo por org y `same_token`; E20 con `cloudflare_ip` y código en la respuesta **solo** en la org de demo; E21 con pre-lectura por org y `wrong_code`/`attempts_left`; E25 con `ips`, `module`, `status`; E36 (webhook de Cloudflare) y E37 (registro de auditoría) aceptadas en P1; `export-links` a P2; E15 mantiene 403 al viewer sin caché.
- **Seguridad:** el código de 6 dígitos se guarda como `HMAC(FPK, 'otp|'+id+'|'+código)`; la huella con alcance de org; `vg_replace_contacts` conserva `verified_at`; `vg_ai_reserve` con `coalesce` (sin tope configurado = sin IA); `redact()` tapa `cfk_/cfut_/cfat_`, `AIza…` y `key=`; Global API Key = `cfk_…` o 37–45 hex; `run_worker_first` con `/.*` y `/.well-known/*` salvo `security.txt`.
- **Motor y demo:** `tail()` vacío desde el primer deploy (lo exige `tail_consumers`); `edge_hits` solo por `/ingest`; puntaje escrito antes de IA-2 (paso `puntaje`); `ingest_factor` separado de `threshold_factor`; plantillas `incident_up_v1` y `reopened_v1`; ataque con `--admin-desde 25`; Configuration Rule `bic: false` en `demo.`; ventana de alertas M10 y SQL de limpieza antes del pitch; papeles y redes de la demo fijados; «Vánguard» fonético en la voz.
- **Autoría:** las primitivas de `packages/core` (`crypto`, `key-guards`, `redact`, `untrusted`, `otp`) las escribe Daniel (BACK) y las revisa el ORQUESTADOR; `packages/core/src/perf/` es del ORQUESTADOR hasta el sábado 18:30.
- **IA:** salida con JSON Schema a mano + zod; `fallbacks:"default"` también en IA-1; costo de IA-2 ≈ 0,25 USD; `ai_usage.model` guarda el modelo que respondió.

### 00.7 Decisiones abiertas (quién decide y cuándo)

| # | Decisión | Quién | Cuándo | Dónde |
|---|---|---|---|---|
| 1 | Quién pone la tarjeta de Workers Paid (sin ella: 10 ms de CPU, sin Tail Workers ni escaneos) | Giovanni | Antes de las 10:00 del sábado | Anexo A §4, §16.11 riesgo 1 |
| 2 | Camino A (Actions en el repo de la organización) o B (espejo personal con el mismo `deploy.yml`) | Giovanni | Hora 1 (sáb 08:00–09:00) | §16.5 |
| 3 | Reparto final de personas en los chats BACK y FRONT | Giovanni | Antes de la hora 1 | Anexo A §13, §16.4 |
| 4 | Subir a P1 la versión mínima de «correlación entre capas» (M24) | Giovanni | Sáb 19:00, tras el ensayo de punta a punta | §02.5 (T02-10) |
| 5 | Hacer de `SB_EXPOSURE_REGRESSION` el primer P1 del domingo | Giovanni | Dom 07:00 | §01.5 |
| 6 | Subir `CB_SQL_NO_RLS` a P1 si P0 cierra a tiempo | Giovanni | Sáb 19:00 | §09 (CB-27) |
| 7 | Tiempos de build de GitHub Actions como «P1 opcional» | Giovanni | Dom 09:00 | §10.8 |
| 8 | Aprobar las extensiones P1 aún sin número (`connections/:id/rotate`, `metrics`, `verified-domains`, `force` en E15) | Giovanni | Antes de que el BACK las empiece (dom 07:00) | §15.4 |
| 9 | Activar el plan B de envío por cola (`'notify'` en `MonitorMsg.kind`) si evaluar y enviar en `waitUntil` pasa de 20 s | BACK propone, Giovanni aprueba | Sáb 17:30, tras medir | §15.7, §04 |
| 10 | Adelantar al sábado la aprobación de «Bloquear IP» desde WhatsApp (`ok`/`no`) | Giovanni | Sáb 17:30, si el webhook ya canjea `ack`/`snz` | §15.4 (E20), §12.9 |

### 00.8 Índice

0. [00. Portada y cómo usar este documento](#00-portada-y-cómo-usar-este-documento)
1. [01. Visión, propuesta de valor y pitch](#01-visión-propuesta-de-valor-y-pitch)
2. [02. Análisis de la propuesta y mejoras](#02-análisis-de-la-propuesta-y-mejoras)
3. [03. Stack tecnológico](#03-stack-tecnológico)
4. [04. Arquitectura del sistema](#04-arquitectura-del-sistema)
5. [05. Modelo de datos y cifrado de credenciales](#05-modelo-de-datos-y-cifrado-de-credenciales)
6. [06. Seguridad del propio producto](#06-seguridad-del-propio-producto)
7. [07. Módulo Supabase](#07-módulo-supabase)
8. [08. Módulo Cloudflare](#08-módulo-cloudflare)
9. [09. Módulo Codebase (GitHub, ZIP, CVE y secretos)](#09-módulo-codebase-github-zip-cve-y-secretos)
10. [10. Módulo Rendimiento histórico (Lighthouse)](#10-módulo-rendimiento-histórico-lighthouse)
11. [11. Motor de IA (Claude API) y presupuesto](#11-motor-de-ia-claude-api-y-presupuesto)
12. [12. Alertas en tiempo real, incidentes y acciones](#12-alertas-en-tiempo-real-incidentes-y-acciones)
13. [13. Exportar a cualquier IA y servidor MCP propio](#13-exportar-a-cualquier-ia-y-servidor-mcp-propio)
14. [14. Especificación para el chat FRONT](#14-especificación-para-el-chat-front)
15. [15. Especificación para el chat BACK y contrato API](#15-especificación-para-el-chat-back-y-contrato-api)
16. [16. Plan de ejecución de 36 horas, demo y entrega](#16-plan-de-ejecución-de-36-horas-demo-y-entrega)
17. [Anexo A. Decisiones canónicas](#anexo-a-decisiones-canónicas)
18. [Anexo B. Fuentes verificadas](#anexo-b-fuentes-verificadas)

En el Anexo A, sus apartados se numeran **A1–A15**: cuando una sección cita «canónicas §N» o «Canon §N», se refiere a **A N** (por ejemplo, «canónicas §9.1» = A9.1).
