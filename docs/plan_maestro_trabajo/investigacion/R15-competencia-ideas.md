# R15. Competencia, huecos del mercado y mejoras (etapa 1 de 4 del plan maestro)

**team-22, Platanus Hack 26 Caracas, track AI Security. Investigación del sábado 24 oct 2026, madrugada (hora de Caracas).**
Fuentes internas leídas: `docs/benchmark-ai-security-team-22-v5.md` (secciones 2, 3, 4, 7, 8, 9 y 10) y `docs/parte5-decisiones-y-plan.md`. Fuentes externas consultadas el 24 oct 2026. Código de referencia (solo lectura): KUADRA CRM (`lib/nucleo/cloudflare_api.dart`, `lib/nucleo/prometheus.dart`, `lib/nucleo/salud.dart`).

**Convención de marcas.** `[verificado: URL]` = lo leí en esa página hoy. `[verificado en KUADRA: ruta]` = está implementado y medido en el código de KUADRA. `[no verificado]` = dato de memoria, de un tercero sin fuente primaria o que no pude comprobar. `[A]` = umbral o supuesto mío, a calibrar en pruebas. Las cifras de estudios de "apps vibe-coded" son de vendedores con interés comercial: sirven para el pitch como "según X", nunca como verdad universal.

---

## 0. Lo esencial en 12 líneas

1. **La verificación activa de RLS con la anon key NO es original.** Hay al menos cinco herramientas que ya la hacen (Vibe App Scanner, SupaExplorer, un auditor MIT en GitHub, actores de Apify, el agente de pentest de Aikido). Si la vendemos como "lo nuevo", un juez técnico la tumba en un minuto.
2. **Aikido es el competidor directo**: ya conecta organizaciones de Supabase por OAuth, revisa políticas y buckets, y su agente de pentest prueba RLS. No encontré que correlacione tráfico de Cloudflare con la base ni que avise por voz o WhatsApp.
3. **Supabase ya regala lo básico**: 30 lints de seguridad y rendimiento, correo semanal, alerta por tabla creada sin RLS y revocación automática de secret keys filtradas en GitHub público. Nuestro módulo Supabase no puede ser "otro linter".
4. **Hueco real 1, la correlación entre capas del stack indie**: un pico en Cloudflare, la CPU de Supabase y un deploy reciente en GitHub, todo en un mismo incidente con causa probable. Los AI SRE (Cleric, Resolve, Datadog) lo hacen para Kubernetes y Datadog; nadie lo hace para Supabase, Cloudflare, Vercel y GitHub.
5. **Hueco real 2, la regresión de exposición**: los escáneres son de una sola pasada. Nadie vuelve a probar tras cada deploy o migración y avisa en menos de un minuto si una tabla pasó a ser legible. El incidente de Lovable de abril de 2026 fue justamente una regresión.
6. **Hueco real 3, la exposición con explotación en curso**: cruzar "esta tabla es legible por anon" con "esta IP la está leyendo ahora" (logs de la API de Supabase). Eso convierte un hallazgo estático en un incidente que justifica la llamada.
7. **Hueco real 4, el lenguaje y el canal**: todo el mercado habla a ingenieros por Slack y en inglés. Voz y WhatsApp en español, con un semáforo para no técnicos, no lo encontré en ningún competidor.
8. Hallazgo técnico clave: la Management API de Supabase tiene **consulta SQL de solo lectura** (`POST /v1/projects/{ref}/database/query/read-only`, rol `supabase_read_only_user`), advisors y logs con **permisos finos** (`database_read`, `advisors_read`, `analytics_logs_read`). Así se cubre casi todo sin `service_role`. La excepción son las métricas de CPU, RAM y disco, que exigen una secret key.
9. Los servidores MCP especializados de Cloudflare (GraphQL, observabilidad, auditoría) están **deprecados** en favor de uno solo por ejecución de código. Para el sondeo del backend conviene llamar REST y GraphQL directo; el MCP queda para la historia de "conecta tu IA".
10. Propongo **24 mejoras**. Las de mayor puntaje ponderado son la regresión de exposición, la correlación entre fuentes, la explotación en curso, los prompts de corrección con botón "verificar arreglo" y el exportador para cualquier IA.
11. Frase de pitch: "Conecta tu Supabase, tu Cloudflare y tu GitHub en tres minutos: probamos lo que un atacante puede ver, te llamamos cuando alguien lo intenta y te damos el arreglo listo para tu IA."
12. Nombres propuestos: **Blindo**, **Vigía** y **Muralla** (sección 7). Antes de elegir hay que comprobar marcas y dominios.

---

## 1. Mapa competitivo 2025-2026

Columnas: qué cubre de **nuestro** stack (SB = Supabase, CF = Cloudflare, GH = GitHub/código, RT = tráfico en vivo), si avisa en tiempo real, si sirve a no técnicos y qué lo distingue.

| Actor | Qué hace hoy (2025-2026) | Cubre | Tiempo real / canal | No técnicos | Precio de entrada | Fuente |
|---|---|---|---|---|---|---|
| **Aikido Security** | Plataforma única de código, nube y runtime para startups. **Integración Supabase por OAuth**: detecta políticas demasiado permisivas, autenticación débil y buckets mal configurados, con monitoreo continuo. Su agente de pentest usa esa conexión y **prueba RLS y buckets** (puede crear datos de prueba). AutoFix abre PR revisables. Zen es un firewall dentro de la app | SB, GH, parte de RT (Zen) | Alertas de plataforma; voz o WhatsApp no encontrado | Medio | Plan gratis con 2 usuarios, 10 repos y 2 AutoFix al mes; Basic unos 300 USD/mes (reseña de terceros) | [verificado: https://help.aikido.dev/cloud-scanning/connect-your-cloud/connect-supabase-organization], [verificado: https://help.aikido.dev/docs/docs-ja/pentesuto/integrate-your-supabase-projects], precio [no verificado: https://makerstack.co/reviews/aikido-security-review/] |
| **Snyk** | Giro a la seguridad de código generado por IA: Agent Security y Evo AI-SPM (RSAC, 23 mar 2026); Evo Agentic Development Security (23 jun 2026) vigila MCP, skills y acciones de agentes de código; Evo MCP server (sep 2026); pentesting autónomo GA. CEO interino y recortes | GH | No | Bajo | Team unos 25 USD por dev/mes (benchmark) | [verificado: https://securityboulevard.com/2026/03/snyk-launches-agent-security-solution-and-ships-evo-ai-spm-at-rsac-2026/], [verificado: https://snyk.io/blog/so-i-asked-my-agent-instead/] |
| **Socket.dev** | Bloqueo de paquetes maliciosos por comportamiento, no solo por CVE. Serie C de 60 M a 1.000 M de valoración (mayo 2026) | GH (cadena de suministro) | Bloquea en la instalación | Bajo | Gratis en repos públicos | Benchmark 7.2. Firewall y MCP 2026 [no verificado: la búsqueda no devolvió páginas de Socket] |
| **Semgrep** | SAST, Supply Chain y Secrets. El plan gratis pasó a llamarse "Free Edition" (Code y Supply Chain gratis hasta 10 contribuidores); Teams bajó a unos 30 USD/contribuidor/mes; la IA se rebautizó "Semgrep Multimodal" y hay plugin MCP para agentes de código | GH | No | Bajo | 0 hasta 10 contribuidores | [no verificado: https://pricingsaas.com/companies/semgrep/diffs/2026Q1, tracker de terceros] |
| **GitGuardian** | Secretos e identidades no humanas. Informe 2026: 28,65 a 29 M de secretos nuevos en GitHub público en 2025 (+34 %); filtraciones ligadas a IA +81 %; **Supabase +992 %**; commits hechos con Claude Code con 3,2 % de fuga frente a 1,5 % de base; 24.008 secretos en archivos de configuración MCP; 64 % de los secretos válidos de 2022 siguen activos | GH | Alertas de repos | Bajo | Freemium | [verificado: https://thehackernews.com/2026/03/the-state-of-secrets-sprawl-2026-9.html] |
| **Wiz (Google)** | Enterprise. Su equipo de investigación encontró la base de **Moltbook** abierta: llave de Supabase en el JavaScript del cliente, sin protección en la base, unos 1,5 M de tokens de API y decenas de miles de correos expuestos | Nube enterprise | Sí, enterprise | Bajo | Enterprise | [verificado: https://securitybrief.co.uk/story/moltbook-vibe-coded-flaw-exposed-ai-chats-keys] |
| **Datadog** | Bits AI Security Analyst, GA el 23 mar 2026 dentro de Cloud SIEM: investiga señales de forma autónoma (dice "unos 30 s" frente a horas). También Bits AI SRE | RT si ya usas Datadog | Sí, dentro de Datadog | Bajo | Cliente Datadog | [verificado: https://securityboulevard.com/2026/03/datadog-launches-ai-security-agent-to-combat-machine-speed-cyberattacks/] |
| **Vercel Firewall / BotID** | DDoS mitigado por defecto. **Attack Challenge Mode gratis en todos los planes** (lo bloqueado no cuenta en el uso). BotID: modo Basic gratis; Deep Analysis a 1 USD por cada 1.000 llamadas a `checkBotId()` en Pro | RT (solo si hospedas en Vercel) | Mitigación, no aviso explicado | Medio | 0 | [verificado: https://vercel.com/kb/attack-challenge-mode], [verificado: https://vercel.com/docs/botid] |
| **Supabase Security Advisor** | Linter Splinter con **30 lints** (0001 a 0030: `rls_disabled_in_public`, `security_definer_view`, `sensitive_columns_exposed`, `permissive_rls_policy`, `public_bucket_allows_listing`, `anon_security_definer_function_executable`, `table_bloat`, `unused_index`, etc.) más 4 "health advisors" de tasa de errores. API: `GET /v1/projects/{ref}/advisors/security` (experimental, permiso `advisors_read`). Correo semanal a los dueños; alerta por tabla creada sin RLS; RLS activada por defecto en tablas creadas desde el dashboard; secret keys filtradas en GitHub público se revocan solas | SB | Correo semanal y alerta puntual | Medio | Gratis | [verificado: https://supabase.com/docs/guides/database/database-advisors], [verificado: https://supabase.com/docs/reference/api/v1-get-security-advisors], [verificado: https://supabase.com/blog/supabase-security-2025-retro] |
| **Cloudflare Security Center** | "Security Insights": lista de hallazgos por cuenta o zona (DNS colgantes, errores de DMARC, etc.): `GET /{accounts_or_zones}/{id}/security-center/insights` | CF | No (panel) | Medio | Incluido | [verificado: https://developers.cloudflare.com/security-center/security-insights], endpoint [verificado: https://developers.cloudflare.com/api/go/resources/security_center/subresources/insights/methods/list] |
| **Cleric** | AI SRE de solo lectura que aprende solo y entrega hallazgos en Slack. Semilla de 5,5 M (dic 2025), unos 9,8 M en total | Infra (K8s, observabilidad) | Slack | Bajo | Cotización | [verificado: https://businesswire.com/news/home/20251209625361/en/Cleric-Launches-the-First-Self-Learning-AI-SRE] |
| **Resolve AI** | Agente autónomo de investigación y resolución. Serie A de 125 M a 1.000 M de valoración con unos 4 M de ARR reportados | Infra enterprise | Slack y herramientas | Bajo | Ventas | [verificado: https://techcrunch.com/2025/12/19/ex-splunk-execs-startup-resolve-ai-hits-1-billion-valuation-with-series-a] |
| **incident.io** | Gestión de incidentes con AI SRE (acceso temprano desde jul 2025); Serie B de 62 M (abr 2025) | Flujo de incidentes | Slack y on-call | Bajo | Unos 45 USD por usuario/mes con on-call (benchmark) | [verificado: https://incident.io/blog/introducing-ai-sre] |
| **Escáneres "vibe coding"** | **Vibe App Scanner** (externo: RLS, buckets, RPC, edge functions sin auth; primer escaneo gratis), **vibecheck**, **SupaExplorer** (extensión de Chrome que enumera tablas y prueba la anon key), actores de **Apify** (cuentan filas sin bajar datos), **Perufitlife/supabase-security** (MIT, 23 estrellas, alfa: linter de migraciones, prueba anónima activa, SQL de arreglo, GitHub Action), **database-sentinel** (MCP de solo lectura, MIT, unas 49 estrellas) | SB (puntual) | No, escaneo de una pasada | Medio | 0 a pago por uso | [verificado: https://vibeappscanner.com/supabase-row-level-security], [verificado: https://github.com/Perufitlife/supabase-security-skill], [verificado: https://chromewebstore.google.com/detail/fggagnanncngmpachliaplleicdjdplp], [no verificado: https://enterprisedna.co/directories/mcp/farenhytee-database-sentinel] |
| **Lovable (plataforma)** | "Security Scan" antes de publicar (incluye el Security Advisor de Supabase) y "Security Reviewer" con IA para toda la app (post de jun 2025) | SB y código dentro de Lovable | Antes de publicar | Alto (dentro de Lovable) | Incluido | [verificado: https://lovable.dev/blog/secure-vibe-coding] |
| **Pluto Security** | Salió de stealth el 13 oct 2026 con 42 M: vigila las herramientas que los empleados hacen con IA ("shadow AI"); dice que el 60 % de sus hallazgos vienen de apps vibe-coded. Puede frenar acciones de agentes | Enterprise (endpoints) | Sí, enterprise | Bajo | Enterprise | [verificado: https://aiweekly.co/alerts/pluto-security-exits-stealth-with-42m-to-monitor-enterprise-ai-agents-and-vibe] |

**Lo que no encontré** (dos búsquedas dirigidas): ningún producto que conecte Supabase, Cloudflare y GitHub en un mismo panel, audite con IA y avise por voz o WhatsApp [verificado como ausencia en los resultados de búsqueda del 24 oct; no prueba que no exista]. Lo más parecido es un tutorial de agentes de código con conectores a GitHub, Supabase y Vercel que abren PR, que es flujo de desarrollo y no monitoreo de seguridad [no verificado: https://www.developersdigest.tech/tutorials/Uq3zqaQrDik].

### 1.1 Lectura por eje

| Eje | Quién lo hace bien | Hueco que queda |
|---|---|---|
| Lint de configuración de Supabase | Supabase (gratis), Aikido | Explicarlo en llano, priorizarlo con el tráfico real y verificar el arreglo |
| Prueba activa de RLS | 5 o más escáneres, Aikido pentest | Hacerla **continua** y disparada por cada deploy o migración |
| Dependencias y CVE | Snyk, Socket, Semgrep, Dependabot | Priorizar con KEV y EPSS, y hablarle al CEO |
| Secretos en el repo | GitHub push protection (gratis en públicos), GitGuardian, Supabase auto-revocación | Secretos en el **bundle del front ya publicado** y en repos privados pequeños |
| Tráfico y ataques en el borde | Cloudflare y Vercel mitigan solos | Explicar qué pasó, cruzarlo con la base y el deploy, y avisar por un canal que despierte |
| Investigación de incidentes con IA | Cleric, Resolve, Datadog, incident.io | Todos para equipos de SRE con Slack y Kubernetes; nada para una startup de 3 personas con Supabase |
| Canal de aviso | Slack, correo, PagerDuty | Llamada de voz y WhatsApp en español |

---

## 2. Incidentes 2025-2026 que justifican el producto (material de pitch)

| Caso | Qué pasó | Por qué nos sirve | Fuente |
|---|---|---|---|
| **CVE-2025-48757** (Lovable y Supabase) | Matt Palmer revisó 1.645 apps del escaparate de Lovable: 170 (cerca del 10 %) tenían tablas de Supabase legibles con la anon key, 303 endpoints expuestos. Se publicó el 29 may 2025 al vencer los 45 días sin arreglo. El escáner que sacó Lovable después **solo comprobaba que RLS existiera, no que funcionara**. CVSS 8,26 en un resumen y 9,3 en otros | Demuestra que "RLS activada" no basta: hay que **probar** la política. Nuestro diferencial no es probar una vez, sino probar siempre | [verificado: https://superblocks.com/blog/lovable-vulnerabilities], [verificado: https://cvemon.intruder.io/cves/CVE-2025-48757] |
| **Lovable, abril de 2026** | Entre el 3 feb y el 20 abr 2026 el historial de chat y el código de proyectos públicos podían verse con el enlace, por una **regresión** del backend que reactivó el acceso público (versión de Lovable). El investigador afirma un alcance mayor. Lovable lo negó primero y luego lo reconoció | Las regresiones existen y duran semanas. Argumento directo para la "regresión de exposición" (idea 3) | [verificado: https://www.techloy.com/lovable-walks-back-initial-statement-that-it-wasnt-breached-offers-what-happened-on-april-2/], [verificado: https://assets.theregister.com/2026/04/20/lovable_denies_data_leak/] |
| **Moltbook** (Wiz, inicios de 2026) | Llave de Supabase en el JavaScript del cliente con lectura y escritura, sin protección en la base | El escaneo del bundle publicado (idea 15) lo habría detectado | [verificado: https://securitybrief.co.uk/story/moltbook-vibe-coded-flaw-exposed-ai-chats-keys] |
| **Symbiotic Security** (abr 2026) | 1.072 sitios con Supabase: 98 % con al menos una falla; **172 permitían borrar registros sin autenticación** | Escribir sin login es peor que leer: hay que revisar los permisos de INSERT, UPDATE y DELETE (por SQL, nunca probando a escribir) | [verificado: https://www.symbioticsec.ai/blog/we-scanned-1-072-vibe-coded-apps-98-had-security-flaws] |
| **Escape.tech** (oct 2025) | 5.600 apps vibe-coded: más de 2.000 vulnerabilidades de alto impacto, más de 400 secretos expuestos y 175 casos de datos personales | Volumen de secretos en los bundles | [verificado: https://escape.tech/blog/methodology-how-we-discovered-vulnerabilities-apps-built-with-vibe-coding/] (cifras vía terceros) |
| **Vibe App Scanner** (2026) | 141 de 359 apps hechas con IA sobre Supabase (39,3 %) con al menos un problema de RLS o exposición | Cifra simple para el pitch, citada como "según un escáner comercial" | [no verificado: https://vibeappscanner.com/blog/vibe-coded-app-security-report-2026] |

**Frase de pitch con datos** (solo con fuentes citables): "Una de cada diez apps de Lovable dejaba leer su base con la llave pública (CVE-2025-48757), y el escáner que salió después solo miraba si RLS estaba encendida, no si funcionaba."

---

## 3. Lo que NO es original (se construye, pero no se vende como novedad)

| Pieza | Quién ya la tiene | Cómo presentarla |
|---|---|---|
| Probar RLS con la anon key | Vibe App Scanner, SupaExplorer, Perufitlife/supabase-security, Apify, agente de pentest de Aikido | "Como cualquier escáner, probamos; a diferencia de ellos, **re-probamos tras cada deploy y cruzamos con quién está leyendo ahora**" |
| Lint de RLS, vistas `security definer`, funciones expuestas | Supabase Security Advisor (gratis, 30 lints) | Lo **consumimos** por la API (`advisors/security`) en vez de reimplementarlo; aportamos la explicación, la prioridad y la verificación |
| CVE de dependencias | Dependabot, Snyk, Socket, Semgrep, Aikido | Consumir OSV; aportar KEV y EPSS ("se explota hoy") y el lenguaje ejecutivo |
| Secretos en el repo | GitHub push protection, GitGuardian, revocación automática de Supabase | Aportar el bundle publicado y la huella HMAC de **las llaves del propio cliente** (idea 16) |
| PR automático de arreglo | Aikido AutoFix, Copilot Autofix (gratis en repos públicos para alertas de CodeQL), Snyk | Opcional y de un solo tipo en 36 h; el diferencial es el prompt con prueba de verificación |
| Agente que investiga incidentes | Cleric, Resolve, Datadog Bits, incident.io | Nuestro agente no decide: el motor de reglas decide; el modelo explica |
| Llamada de voz al de guardia | EZ OnCall (demo de hackathon con ElevenLabs y Twilio, benchmark 2.4) | La voz no es el invento; lo es **qué** se dice (incidente correlacionado y explicado en llano) |

Copilot Autofix gratis en repos públicos: [verificado: https://github.blog/changelog/2024-09-18-now-available-for-free-on-all-public-repositories-copilot-autofix-for-codeql-code-scanning-alerts]. Push protection gratis en repos públicos: [verificado: https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security].

---

## 4. El ángulo de originalidad real

### 4.1 Los cuatro huecos que sí podemos ocupar

1. **Correlación entre capas del stack indie** (borde, base, código y deploy). Un incidente se arma con eventos de Cloudflare, Supabase y GitHub dentro de una ventana de tiempo, y el motor de reglas lo clasifica en "ataque", "regresión de despliegue" o "crecimiento legítimo". Los AI SRE lo hacen sobre Datadog y Kubernetes; los escáneres no ven el tiempo.
2. **Postura continua, no una foto**: cada `push`, deploy o migración dispara de nuevo las pruebas de exposición y compara contra la foto anterior. Lo que cambió de "protegido" a "expuesto" es un incidente, no un renglón más del informe.
3. **Exposición más explotación**: "la tabla `pedidos` es legible por anon" (prueba activa) **y** "la IP 203.0.113.7 hizo 400 lecturas a `/rest/v1/pedidos` en 10 minutos" (logs de la API de Supabase). Esa conjunción es la que justifica despertar a alguien.
4. **Cerrar el ciclo para quien no es experto**: explicación en llano y en español, por WhatsApp y voz; prompt de corrección listo para su IA de trabajo; botón "verificar arreglo" que vuelve a correr la prueba exacta y marca "cerrado, verificado a las 14:32".

A eso se suma lo que ya estaba en el trabajo previo y sigue siendo raro en el mercado: el cuadro de "qué no ves según tu plan" y la seguridad propia como característica (solo lectura, el modelo no decide alertas, llaves cifradas).

### 4.2 Posicionamiento en una línea

> "Aikido y Supabase te dicen qué está mal configurado. Nosotros te decimos **cuándo alguien lo está aprovechando**, por qué pasó (el deploy de las 13:05) y cómo cerrarlo, y te llamamos para que te enteres."

### 4.3 Respuesta preparada para el jurado: "¿en qué se diferencian de Aikido?"

- Aikido parte del código y la configuración y entrega hallazgos para devs. Nosotros partimos del **tiempo real** (tráfico de Cloudflare, logs y métricas de Supabase) y usamos la configuración para priorizar.
- Aikido no correlaciona un pico en el borde con la CPU de la base y el último commit (no lo encontré documentado).
- Nuestro canal es voz y WhatsApp, en español, con un modo para no técnicos.
- Nuestro motor de reglas decide la alerta y el modelo solo redacta, lo que nos hace resistentes a la inyección de instrucciones desde los logs.

---

## 5. Mejoras e ideas nuevas (24), con puntaje por criterio del jurado

**Cómo leer la tabla.** Cada criterio va de 0 a 3. O = originalidad (15 %), A = ambición (20 %), E = ejecución y despliegue (20 %; alto si suma a una demo robusta, bajo si la pone en riesgo), I = impacto (20 %), T = aspectos técnicos (25 %). **Pond.** = (O·15 + A·20 + E·20 + I·20 + T·25) / 3, de 0 a 100. Esfuerzo: S (menos de 3 h), M (3 a 8 h), L (más de 8 h). **36 h**: P0 = la demo lo necesita, P1 = debe estar el domingo, P2 = solo si sobra tiempo, No = hoja de ruta.

| # | Idea | O | A | E | I | T | Pond. | Esf. | 36 h |
|---|---|---|---|---|---|---|---|---|---|
| 3 | Regresión de exposición tras cada deploy o migración | 3 | 2 | 2 | 3 | 3 | **87** | M | P0 |
| 4 | Correlación entre fuentes (borde, base, deploy) con causa probable | 3 | 3 | 2 | 2 | 3 | **87** | M | P1 (3 reglas) |
| 5 | Exposición con explotación en curso (logs de la API de Supabase) | 3 | 2 | 1 | 3 | 3 | **80** | M | P1 |
| 8 | Prompts de corrección listos para copiar más botón "verificar arreglo" | 2 | 2 | 3 | 3 | 2 | **80** | S | P0 |
| 14 | Exportador "audita con tu IA": MCP de solo lectura, SARIF y Markdown | 2 | 2 | 2 | 2 | 3 | **75** | M | P1 |
| 11 | Reporte ejecutivo por voz bajo demanda ("¿cómo estamos?") | 2 | 2 | 2 | 3 | 2 | **73** | S | P1 |
| 9 | PR automático de corrección (un solo tipo, opcional) | 1 | 3 | 1 | 2 | 3 | **70** | M | P2 |
| 23 | Guardia de migraciones en CI (falla el PR si crea tabla sin RLS) | 1 | 2 | 2 | 2 | 3 | **70** | M | P2 |
| 2 | Verificación activa de RLS con la anon o publishable key | 1 | 1 | 3 | 3 | 2 | **68** | S | P0 |
| 6 | Ataque simulado reproducible ("simulacro") con cronómetro | 1 | 2 | 3 | 2 | 2 | **68** | S | P0 |
| 15 | Llaves expuestas en el bundle del front ya publicado | 1 | 1 | 3 | 3 | 2 | **68** | S | P0 |
| 19 | Acciones de neutralización con un clic y código de un solo uso | 1 | 2 | 2 | 3 | 2 | **68** | M | P1 |
| 1 | Puntaje de blindaje del ecosistema (0 a 100) con cobertura | 1 | 2 | 3 | 3 | 1 | **67** | S | P0 |
| 16 | Huella HMAC de las llaves del cliente para detectar sus fugas | 3 | 1 | 2 | 1 | 3 | **67** | S | P1 |
| 10 | Cuadro "qué no ves según tu plan" | 3 | 1 | 3 | 2 | 1 | **63** | S | P1 |
| 7 | Verificación de propiedad del dominio antes de cualquier prueba activa | 2 | 1 | 2 | 1 | 3 | **62** | S | P1 |
| 18 | Rendimiento por deploy con PageSpeed Insights o Lighthouse | 1 | 2 | 2 | 2 | 2 | **62** | M | P1/P2 |
| 20 | Prioridad de CVE con KEV y EPSS ("se explota hoy") | 1 | 1 | 3 | 2 | 2 | **62** | S | P1 |
| 21 | Registro de auditoría encadenado por hash (vigilar al vigilante) | 2 | 1 | 2 | 1 | 3 | **62** | S | P1 |
| 24 | Mapa de superficie del ecosistema (grafo coloreado por riesgo) | 2 | 2 | 2 | 2 | 1 | **58** | M | P2 |
| 13 | Modo para no técnicos (semáforo y un solo botón) | 2 | 1 | 3 | 3 | 0 | **57** | S | P0 (es parte de la UI) |
| 17 | Línea base adaptativa por ruta en vez de umbrales fijos | 1 | 2 | 1 | 1 | 3 | **57** | M | P2 |
| 22 | Costo de IA visible por auditoría | 2 | 1 | 2 | 1 | 2 | **53** | S | P2 |
| 12 | Mapeo a OWASP Top 10:2025, ASVS y CWE | 0 | 1 | 3 | 1 | 2 | **50** | S | P1 |

Lectura: el núcleo de la demo es **2 + 3 + 15 + 8 + 1 + 6** (todo S o M), con **4 y 5** como el salto técnico y original. La idea 2 sola puntúa bajo en originalidad, pero es la base de la 3 y la 5: se construye primero.

---

## 6. Fichas técnicas de las ideas

### 6.0 Base común: leer Supabase sin `service_role`

Un token de acceso personal (PAT) de la Management API con **permisos finos de solo lectura** cubre casi todo. Lo pide la pantalla de conexión con una guía paso a paso.

| Necesidad | Endpoint | Permiso fino / scope OAuth | Estado | Fuente |
|---|---|---|---|---|
| SQL de inventario (RLS, grants, políticas, tamaños) | `POST /v1/projects/{ref}/database/query/read-only`, cuerpo `{"query": "..."}`; corre como `supabase_read_only_user`; toda referencia con esquema (`public.tabla`, `pg_catalog.pg_class`) | `database_read` / `database:read` | Experimental, beta | [verificado: https://supabase.com/docs/reference/api/v1-read-only-query] |
| Lints de seguridad | `GET /v1/projects/{ref}/advisors/security` → `lints[]` con `name, title, level, facing, categories, description, detail, remediation, metadata{schema,name,entity,type}, cache_key` | `advisors_read` / `database:read` | Experimental | [verificado: https://supabase.com/docs/reference/api/v1-get-security-advisors] |
| Lints de rendimiento | `GET /v1/projects/{ref}/advisors/performance` | Igual | Experimental | Ruta [no verificado: solo vi el enlace en el índice de la documentación] |
| Logs (API, Postgres, auth) | `GET /v1/projects/{ref}/analytics/endpoints/logs?sql=...&iso_timestamp_start=...&iso_timestamp_end=...`; SQL en **dialecto ClickHouse**; filtrar por la columna `source` (`edge_logs`, `postgres_logs`); **máximo 24 h por consulta**, sin fechas solo trae el último minuto | `analytics_logs_read` / `analytics:read` | Estable según la página | [verificado: https://supabase.com/docs/reference/api/v1-get-project-logs] |
| CPU, RAM, disco, red | `GET https://{ref}.supabase.co/customer/v1/privileged/metrics`, Basic Auth con usuario literal `service_role` y contraseña una **secret key** `sb_secret_...`; unas 200 series, raspar cada minuto; beta | Secret key (no hay permiso fino) | Beta | [verificado: https://supabase.com/docs/guides/telemetry/metrics]; métricas `node_cpu_seconds_total`, `node_memory_MemTotal_bytes`, `node_memory_MemAvailable_bytes`, `node_filesystem_avail_bytes`, `node_filesystem_size_bytes`, `node_load*` [verificado en KUADRA: lib/nucleo/prometheus.dart, lib/nucleo/salud.dart] |

**Decisión que hay que tomar:** las métricas de servidor son lo único que obliga a pedir una secret key. Supabase permite **varias secret keys revocables** [verificado: https://supabase.com/blog/supabase-security-2025-retro], así que la guía debe pedir una **dedicada** ("crea una llave llamada `blindo-metricas`"), que solo use el lector de métricas en el servidor, cifrada y revocable en un clic. Si el usuario no quiere darla, el módulo muestra "sin métricas de servidor" en el cuadro de cobertura (idea 10) y sigue con todo lo demás.

**Formatos de llave:** las llaves heredadas `anon` y `service_role` (JWT) **se eliminan a finales de 2026** y con las publishable keys el esquema OpenAPI deja de ser público [verificado: https://supabase.com/blog/supabase-security-2025-retro]. Hay que aceptar `sb_publishable_...` y `sb_secret_...` desde el primer día, y sacar la lista de tablas por SQL, no del OpenAPI.

### 6.1 Idea 2. Verificación activa de RLS (la base de las ideas 3 y 5)

**Paso 1, inventario por SQL** (endpoint de solo lectura):

```sql
select n.nspname as esquema, c.relname as tabla,
       c.relrowsecurity as rls_activa, c.relforcerowsecurity as rls_forzada,
       coalesce(s.n_live_tup, 0) as filas_estimadas,
       pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
       pg_catalog.has_table_privilege('anon', c.oid, 'INSERT') as anon_insert,
       pg_catalog.has_table_privilege('anon', c.oid, 'UPDATE') as anon_update,
       pg_catalog.has_table_privilege('anon', c.oid, 'DELETE') as anon_delete,
       (select count(*) from pg_catalog.pg_policies p
         where p.schemaname = n.nspname and p.tablename = c.relname) as politicas
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_stat_user_tables s on s.relid = c.oid
where c.relkind in ('r', 'p') and n.nspname = 'public'
order by anon_select desc, rls_activa asc;
```

```sql
-- Políticas abiertas para anon (lo que el lint 0024 permissive_rls_policy marca en general)
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'public'
  and (qual = 'true' or with_check = 'true')
  and ('anon' = any(roles) or 'public' = any(roles));

-- Columnas sensibles (sube la severidad); pg_attribute porque information_schema filtra por privilegios
select c.relname as tabla, a.attname as columna
from pg_catalog.pg_attribute a
join pg_catalog.pg_class c on c.oid = a.attrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  and a.attname ~* '(email|correo|phone|telefono|password|clave|token|secret|cedula|dni|rif|iban|tarjeta|card|direccion|address)';
```

Que `supabase_read_only_user` pueda llamar `has_table_privilege` sobre el rol `anon` es esperable en Postgres, pero [no verificado en Supabase]: probarlo en el proyecto de demo antes de construir encima.

**Paso 2, prueba de lectura sin bajar filas** (PostgREST: `HEAD` con `Prefer: count=exact`; el total viene en `Content-Range`, por ejemplo `0-24/3573458`) [verificado: https://docs.postgrest.org/en/stable/references/api/pagination_count.html]:

```ts
export async function probarLecturaAnon(urlProyecto: string, llavePublica: string, tabla: string) {
  const r = await fetch(`${urlProyecto}/rest/v1/${encodeURIComponent(tabla)}?select=*`, {
    method: 'HEAD',
    headers: {
      apikey: llavePublica,
      // La anon heredada es un JWT y va también como Bearer; la publishable no es JWT.
      ...(llavePublica.startsWith('eyJ') ? { Authorization: `Bearer ${llavePublica}` } : {}),
      Prefer: 'count=exact',
      'Range-Unit': 'items',
      Range: '0-0',
    },
  });
  const total = Number((r.headers.get('content-range') ?? '').split('/')[1]);
  return { estado: r.status, filasVisibles: Number.isFinite(total) ? total : null };
}
```

| Resultado | Lectura |
|---|---|
| 200 o 206 y `filasVisibles > 0` | **Expuesta, confirmada.** Severidad crítica si hay columnas sensibles |
| 200 y 0 filas, pero `filas_estimadas > 0` | Protegida: RLS filtra todo (RLS no da 401, da conjunto vacío) |
| 200 y 0 filas, tabla vacía | Indeterminada: decide el SQL (`rls_activa = false` y `anon_select = true` es exposición latente, severidad alta) |
| 401 o 403 | Sin GRANT para anon: protegida |
| 404 | La tabla no está expuesta por la Data API |

Reglas de seguridad propias: nunca se baja una fila, **nunca se prueba a escribir** (los permisos de escritura se infieren de `anon_insert/update/delete` más políticas con `cmd in ('INSERT','UPDATE','DELETE','ALL')` y `qual = 'true'`), nunca se ejecutan RPC (las funciones expuestas salen del lint 0028 `anon_security_definer_function_executable`), máximo 2 peticiones por segundo y 200 tablas por corrida [A]. Si la publishable key debe ir también como `Authorization` está [no verificado].

### 6.2 Idea 3. Regresión de exposición (la estrella de la demo)

**Disparadores:** webhook de GitHub `push` a la rama por defecto y `deployment_status` con `state = success`; espera de 90 s [A] y se corre la idea 2 más `advisors/security`. Si el push toca `supabase/migrations/**` (campos `commits[].added` y `commits[].modified` del payload), se marca como "migración". Además, una corrida cada 10 min [A] desde `pg_cron` y `pg_net` en nuestro Supabase [no verificado en esta sesión]. Que Vercel publique sus deploys como `deployments` de GitHub es lo habitual pero está [no verificado].

```sql
create table public.exposicion_foto (
  id bigint generated always as identity primary key,
  proyecto_id uuid not null references public.proyectos(id) on delete cascade,
  tabla text not null,
  legible_anon boolean not null,
  filas_visibles bigint,
  escribible_anon boolean not null,
  rls_activa boolean not null,
  disparador text not null check (disparador in ('cron', 'push', 'deploy', 'migracion', 'manual')),
  commit_sha text,
  medido_en timestamptz not null default now()
);
create index exposicion_foto_ultima on public.exposicion_foto (proyecto_id, tabla, medido_en desc);
alter table public.exposicion_foto enable row level security;
```

**Regla R7 (nueva, se suma a R1-R6 de la Parte V):** si en la foto anterior `legible_anon = false` (o `escribible_anon = false`) y en la actual es `true`, se crea el incidente "regresión de exposición" con `commit_sha`, archivos cambiados (`GET /repos/{owner}/{repo}/compare/{base}...{head}` [no verificado en esta sesión]) y la tabla. Crítico (llamada y WhatsApp) si hay columnas sensibles o `filas_visibles > 0`; si no, alto (WhatsApp).

**Demo de 40 s:** commit con la migración `alter table public.pedidos disable row level security;` → el panel pasa de verde a rojo con el SHA → llega el WhatsApp → se pega el prompt de corrección (idea 8) → "verificar arreglo" → verde.

### 6.3 Idea 4. Correlación entre fuentes

Todo se normaliza a un evento común; el modelo nunca clasifica, solo redacta.

```ts
type Fuente = 'cloudflare' | 'supabase' | 'github' | 'vercel' | 'sondeo';
interface Evento { fuente: Fuente; tipo: string; ts: string; entidad: string; valor: number; extra?: Record<string, unknown> }
// ejemplos de tipo: 'cf.req_min', 'cf.top_ip_share', 'cf.5xx_rate', 'sb.cpu_pct', 'sb.conexiones',
// 'gh.deploy', 'gh.push_migracion', 'sondeo.tabla_expuesta', 'sb.lecturas_anon_ip'
```

| Regla | Condición en ventana de 10 min [A] | Clasificación | Canal |
|---|---|---|---|
| C1 | `cf.req_min` > 3 × mediana de 24 h **y** (IP principal > 30 % o ASN principal > 50 % del tráfico) | Ataque o abuso | Llamada si además `sb.cpu_pct` > 85 % durante 3 min o 5xx > 5 %; si no, WhatsApp. Acción propuesta: bloquear IP/ASN o modo de ataque |
| C2 | `gh.deploy` en los últimos 30 min **y** (`sb.cpu_pct` > 80 % 5 min o 5xx > 5 %) **y** tráfico dentro de ±30 % de la mediana | Regresión de despliegue | WhatsApp con SHA, archivos cambiados y sugerencia de rollback |
| C3 | `cf.req_min` > 3 × mediana **y** IP principal < 5 % **y** 2xx > 95 % | Crecimiento legítimo | Solo panel |
| C4 | `sondeo.tabla_expuesta` **y** `sb.lecturas_anon_ip` sobre umbral (idea 5) | Exposición explotada | Llamada |

Deduplicación: misma clave `(regla, entidad)` dentro de 15 min agrega eventos al incidente y no vuelve a llamar (Parte V, 3.2).

**Datos de Cloudflare:** en plan Free `httpRequestsAdaptiveGroups` y `httpRequestsAdaptive` funcionan, y `firewallEventsAdaptive` rechaza ventanas de más de 1 día [verificado en KUADRA: lib/nucleo/cloudflare_api.dart, medido 2026-08-29]. Dimensiones probadas en KUADRA: `datetimeHour`, `securityAction`, `clientCountryName`, `clientRequestPath`, `clientRequestHTTPHost`, `edgeResponseStatus`, `userAgent`; `clientIP` probado en `httpRequestsAdaptive` y `firewallEventsAdaptive`. `datetimeMinute` y `clientIP` como dimensión de `...Groups` están [no verificado: confirmar por introspección]; si fallan, se agrega en el servidor desde `httpRequestsAdaptive`. Límite: 300 consultas GraphQL cada 5 min por usuario y al menos 31 días de retención en todos los planes [verificado: https://developers.cloudflare.com/analytics/graphql-api/limits/]. El detalle de consultas está en R05.

**Datos de Supabase:** CPU % = 1 − Δ`node_cpu_seconds_total{mode="idle"}` / Δ(suma de todos los modos) entre dos raspados a 60 s; RAM % = 1 − `MemAvailable/MemTotal`; disco % = 1 − `avail/size` [verificado en KUADRA]. Conexiones por SQL: `select count(*) from pg_catalog.pg_stat_activity;` y `select current_setting('max_connections');` (alerta a más del 80 % [A]).

### 6.4 Idea 5. Exposición con explotación en curso

Con la tabla `X` marcada como expuesta, se consulta cada 2 min [A] el endpoint de logs (`source = 'edge_logs'`, últimos 10 min) y se agrupa por IP las peticiones `GET` a `/rest/v1/X` con estado 200. Umbral [A]: 50 o más lecturas de una misma IP a una tabla expuesta en 10 min, o 5 o más tablas expuestas distintas desde una IP. **El nombre exacto de las columnas en ClickHouse (ruta, IP, estado, rol) está [no verificado]**: escribir la consulta en el Logs Explorer del proyecto de demo el sábado por la mañana y copiarla al código. Plan B si el esquema se complica: la herramienta `get_logs` del MCP oficial de Supabase en `read_only=true` (servicio `api`) [verificado: https://github.com/supabase/mcp, vía espejos del README].

### 6.5 Idea 8. Prompt de corrección más "verificar arreglo"

Plantilla fija (el modelo solo rellena "contexto" y "pasos"; la prueba de aceptación la pone el sistema):

```text
Eres el asistente de código de este proyecto. Corrige UNA falla de seguridad.
Falla: {titulo} ({id_hallazgo}, OWASP {owasp}, {cwe}).
Evidencia: {evidencia_redactada}   // ej.: "HEAD /rest/v1/pedidos con la llave pública devuelve 1.204 filas visibles"
Stack detectado: {stack}           // ej.: "Next.js 15 en Vercel, Supabase, migraciones en supabase/migrations"
Qué cambiar: {pasos}               // ej.: "nueva migración que active RLS y cree una política por auth.uid() = user_id"
Restricciones: no desactives RLS en otras tablas, no uses la service_role en el cliente, no borres datos.
Prueba de aceptación: después del cambio, `HEAD /rest/v1/pedidos?select=*` con la llave pública
debe devolver 0 filas visibles y las consultas autenticadas del dueño deben seguir funcionando.
```

"Verificar arreglo" vuelve a correr exactamente la prueba que generó el hallazgo (idea 2 o el lint por su `cache_key`) y guarda `verificado_en`. Tres sabores del mismo prompt: Claude Code o Cursor (rutas de archivos), Lovable o Bolt (lenguaje de producto) y "a mano" (SQL listo para el editor de Supabase).

### 6.6 Idea 15. Llaves en el bundle publicado

Solo sobre dominios verificados (idea 7). Se baja el HTML, se siguen hasta 30 `<script src>` del mismo origen (máximo 5 MB cada uno) y se buscan patrones:

| Patrón | Severidad | Estado del formato |
|---|---|---|
| `sb_secret_[A-Za-z0-9_-]{20,}` | Crítica | Prefijo `sb_secret_` [verificado: https://supabase.com/docs/guides/telemetry/metrics]; largo [no verificado] |
| JWT `eyJ...\.eyJ...\..+` con `role: "service_role"` al decodificar el payload | Crítica | `anon` es esperable e informativo |
| `sk-ant-`, `sk-proj-`, `sk_live_`, `ghp_`/`gho_`/`ghs_`, `AKIA[0-9A-Z]{16}` | Crítica | [no verificado: prefijos de memoria; confirmar con la documentación de cada proveedor] |

Nunca se guarda el valor encontrado: solo su huella HMAC (idea 16), los últimos 4 caracteres y el archivo. La revocación automática de Supabase cubre GitHub público, **no el bundle publicado** [verificado: https://supabase.com/blog/supabase-security-2025-retro]: ese es el hueco.

### 6.7 Idea 16. Huella HMAC (lo bueno de la propuesta del dueño, en su sitio)

La llave del cliente se guarda **cifrada** (AES-256-GCM con cifrado de sobre y la clave maestra en Supabase Vault), porque hay que volver a usarla. Aparte se guarda `huella = HMAC-SHA256(pimienta, llave)`. Usos: deduplicar conexiones, verificar sin descifrar y **detectar la llave del propio cliente** en un commit, en el bundle o en un log: cada candidato encontrado se pasa por el mismo HMAC y se compara, sin descifrar nada ni registrar el valor.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
export const huella = (pimienta: Buffer, valor: string) => createHmac('sha256', pimienta).update(valor, 'utf8').digest();
export const coincide = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
```

La pimienta vive en Vault y solo la lee una función del servidor. El diseño del cifrado completo va en el documento de seguridad propia del plan; aquí solo importa que el hash no sustituye al cifrado.

### 6.8 Idea 1. Puntaje de blindaje (siempre junto a la cobertura)

```ts
type Sev = 'critico' | 'alto' | 'medio' | 'bajo';
const PESO: Record<Sev, number> = { critico: 25, alto: 10, medio: 4, bajo: 1 };
export function puntajeBlindaje(h: { sev: Sev; confirmado: boolean; modulo: string }[]) {
  const porModulo = new Map<string, number>();
  for (const x of h) {
    const p = PESO[x.sev] * (x.confirmado ? 1.5 : 1);           // probado en vivo pesa más que inferido
    porModulo.set(x.modulo, Math.min(40, (porModulo.get(x.modulo) ?? 0) + p)); // un módulo no hunde todo
  }
  const castigo = [...porModulo.values()].reduce((a, b) => a + b, 0);
  const tope = h.some((x) => x.sev === 'critico' && x.confirmado) ? 49 : 100; // con un crítico confirmado nunca hay verde
  return Math.max(0, Math.min(tope, Math.round(100 - castigo)));
}
```

Bandas [A]: 0-49 rojo ("expuesto"), 50-79 ámbar, 80-100 verde. Al lado, **siempre**, la cobertura: "vemos 3 de 5 fuentes (falta métricas de servidor y Vercel)". Un 95 con 20 % de cobertura no es un 95, y decirlo es parte de la credibilidad ante un jurado técnico.

### 6.9 Ideas 6 y 7. Simulacro reproducible y propiedad del dominio

- **Simulacro**: botón que dispara un script fijo contra **nuestra** app de demo (ya planeado en la Parte V, tareas 3 y 8): fase 1, escaneo de 40 rutas con 404 en 30 s; fase 2, ruta de administrador sembrada; fase 3, 50 peticiones por segundo durante 60 s [A]; fase 4, lectura repetida de la tabla expuesta con la llave pública. El panel muestra un cronómetro desde el primer paquete hasta cada aviso. Las políticas de pruebas de carga de Supabase y Vercel siguen [no verificado] (pendiente de la Parte V).
- **Propiedad del dominio** antes de cualquier prueba activa (simulacro, bundle, sondeo): registro TXT `_blindo.{dominio}` con `blindo-verify={32 bytes aleatorios en base64url}`, comprobado por DNS sobre HTTPS (`GET https://cloudflare-dns.com/dns-query?name=_blindo.ejemplo.com&type=TXT` con `accept: application/dns-json` [no verificado en esta sesión]). Si el usuario ya conectó Cloudflare, basta con que la zona aparezca en su token. Así la herramienta no sirve para atacar sitios ajenos, que es lo primero que un juez de AI Security va a preguntar.

### 6.10 Idea 10. "Qué no ves según tu plan" (valores con fuente)

| Servicio y plan | Lo que no ves | Fuente |
|---|---|---|
| Cloudflare Free | Eventos del firewall de más de 1 día atrás (hay que archivarlos nosotros) | [verificado en KUADRA: lib/nucleo/cloudflare_api.dart] |
| Cloudflare, todos los planes | Datasets adaptativos con al menos 31 días; GraphQL a 300 consultas cada 5 min | [verificado: https://developers.cloudflare.com/analytics/graphql-api/limits/] |
| Supabase Free | 1 día de logs; sin envío a destinos externos | Parte V, sección 5 [no verificado hoy] |
| Supabase, API de logs | 24 h por consulta como máximo | [verificado: https://supabase.com/docs/reference/api/v1-get-project-logs] |
| Supabase, cualquier plan | Métricas de servidor sin secret key dedicada | [verificado: https://supabase.com/docs/guides/telemetry/metrics] |
| Vercel Hobby | 1 hora de logs, 3 reglas custom, sin drains | Parte V, sección 5 [no verificado hoy] |

### 6.11 Idea 19. Neutralizar con un clic

| Acción | Llamada | Estado |
|---|---|---|
| Bloquear IP en Cloudflare | `POST /zones/{zone_id}/firewall/access_rules/rules` con `{"mode":"block","configuration":{"target":"ip","value":"203.0.113.7"},"notes":"..."}` (`"ip6"` para IPv6); deshacer con `DELETE .../rules/{id}` | [verificado en KUADRA: lib/nucleo/cloudflare_api.dart] |
| Modo "bajo ataque" en Cloudflare | `PATCH /zones/{zone_id}/settings/security_level` con `{"value":"under_attack"}` | [no verificado en esta sesión] |
| Attack Challenge Mode en Vercel | Gratis en todos los planes; se activa desde el panel | [verificado: https://vercel.com/kb/attack-challenge-mode]; endpoint de API [no verificado] |
| Supabase | No escribimos: entregamos el SQL y el prompt (idea 8) | Decisión de diseño |

Toda acción exige un código de un solo uso por WhatsApp o en la app (6 dígitos, 5 min, un uso, guardado como hash), nunca por voz (Parte V, 3.4). El token de Cloudflare con escritura es **opcional** y se pide aparte del de lectura.

### 6.12 Idea 14. "Audita con tu IA"

- **Servidor MCP propio, solo lectura** (Streamable HTTP, token por usuario): `estado_ecosistema`, `listar_hallazgos(severidad?, modulo?)`, `obtener_incidente(id)`, `prompt_correccion(id_hallazgo)`, `explicar_puntaje()`. Ninguna herramienta escribe ni devuelve llaves.
- **SARIF 2.1.0** para los hallazgos de código (subible a GitHub code scanning con `POST /repos/{owner}/{repo}/code-scanning/sarifs` [no verificado en esta sesión]).
- **`auditoria.md`** con todo redactado (IPs enmascaradas, sin filas, sin llaves) más un prompt inicial: "Eres auditor de seguridad; con estos hallazgos y su evidencia, prioriza y propón un plan de 7 días".
- Los MCP especializados de Cloudflare (GraphQL, observabilidad, auditoría, Radar) están **deprecados** en favor de `https://mcp.cloudflare.com/mcp` [verificado: https://github.com/cloudflare/mcp-server-cloudflare]. No conviene construir el backend sobre ellos.

### 6.13 Idea 18. Rendimiento por deploy

En vez de correr Chrome dentro de una función de Vercel (pesado y frágil), usar **PageSpeed Insights API v5**: `GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url={url}&strategy=mobile&category=performance&key={key}`; la llave es opcional pero recomendada; campos `lighthouseResult.categories.performance.score` y `lighthouseResult.audits['largest-contentful-paint' | 'total-blocking-time' | 'first-contentful-paint' | 'speed-index' | 'interactive']` [verificado: https://developers.google.com/speed/docs/insights/v5/get-started]; los parámetros `strategy` y `category` y la cuota están [no verificado]. Se corre por cada `deployment_status = success`, se guarda con el SHA y se avisa si el puntaje cae más de 0,05, el LCP sube más del 20 % o el TBT sube más de 100 ms [A]. Para "dónde está el problema", se comparan los `audits[*].numericValue` entre el deploy actual y el anterior y se listan los tres que más empeoraron. Lighthouse en Node dentro de GitHub Actions queda como alternativa para builds y tiempos de compilación.

### 6.14 Resto de ideas, en corto

- **20. KEV y EPSS**: catálogo KEV en `https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json` y EPSS en `https://api.first.org/data/v1/epss?cve=CVE-A,CVE-B` (varios separados por coma) [no verificado: ambos vistos en fuentes secundarias]. Crítico si está en KEV; alto si EPSS ≥ 0,1 [A].
- **21. Registro encadenado**: tabla `auditoria(id, actor, accion, objetivo, datos jsonb, hash_prev bytea, hash bytea)` con `hash = sha256(hash_prev || datos)` (por ejemplo con `extensions.digest` de pgcrypto) y un botón "verificar integridad". Muestra que el vigilante también es vigilado.
- **11. Voz ejecutiva**: guion de 45 a 60 s generado desde el estado estructurado (puntaje, incidentes abiertos, una acción recomendada) y leído por ElevenLabs; mismas reglas de datos de la Parte V, sección 5.
- **12. OWASP Top 10:2025**: A01 Broken Access Control (RLS, vistas `security definer`), A02 Security Misconfiguration (`.env` subido, bucket listable), A03 Software Supply Chain Failures (dependencias con CVE), A04 Cryptographic Failures, A05 Injection, A06 Insecure Design (sin freno de tasa), A07 Authentication Failures (llaves en el código, registro sin confirmar correo), A08 Software or Data Integrity Failures, A09 Security Logging and Alerting Failures, A10 Mishandling of Exceptional Conditions [lista verificada: https://top10.owasp.org/2025]; el mapeo hallazgo → categoría es propio y hay que revisarlo. La versión vigente de ASVS está [no verificado].
- **9 y 23. PR automático y guardia de CI**: en 36 h, un solo tipo: agregar `.env*` a `.gitignore` más una migración que active RLS. Requiere una GitHub App con `contents:write` y `pull_requests:write`, opcional y separada de la de lectura. La guardia de CI imita a Perufitlife/supabase-security (`fail-on: high` sobre `supabase/migrations`).
- **13. Modo no técnico**: tres estados, una frase y un botón por hallazgo ("Tu tabla de pedidos se puede leer sin iniciar sesión. Botón: Arreglar"). El detalle técnico va detrás de "ver más".
- **17. Línea base adaptativa**: EWMA por ruta con α = 0,1 y alerta si el valor supera la media más 4 desviaciones durante 3 minutos [A]; requiere 24 h de datos, así que en la demo se usan umbrales fijos.
- **22. Costo de IA visible**: precios por millón de tokens (entrada/salida): Haiku 5.5 0,10/0,50 USD, Sonnet 5.5 2/10, Opus 5.5 4/20; lecturas de caché de Sonnet y Opus a 0,20; Batch con 50 % de descuento [verificado: tabla de precios del skill claude-api, en caché al 2026-10-06]. Una auditoría con Sonnet 5.5 de 30.000 tokens de entrada (20.000 de ellos en caché) y 4.000 de salida cuesta unos 0,064 USD: los 250 USD alcanzan para unas 3.900. El detalle está en R12.
- **24. Mapa de superficie**: grafo dominio → Cloudflare → Vercel → Supabase → tablas, coloreado por severidad. Atractivo visual, pero no suma al núcleo.

---

## 7. Pitch y nombre

**Frase de pitch (larga, 20 s):** "Conecta tu Supabase, tu Cloudflare y tu GitHub en tres minutos. Probamos lo que un atacante puede ver, te llamamos o te escribimos por WhatsApp cuando alguien lo intenta, te decimos qué deploy lo causó y te damos el arreglo listo para tu IA."

**Frase corta (para la portada):** "Probamos tu app como un atacante, te avisamos cuando alguien lo intenta y te damos el arreglo."

**Frase con dato (para abrir el pitch):** "Una de cada diez apps de Lovable dejaba leer su base con la llave pública, y el escáner que salió después solo miraba si RLS estaba encendida, no si funcionaba. Nosotros lo probamos en cada deploy."

| Nombre | Por qué | Riesgo |
|---|---|---|
| **Blindo** | Viene de "blindar", el verbo de las tres frases del equipo ("blindamos tu producto"). Corto y pronunciable en inglés y español | Marca y dominios [no verificado] |
| **Vigía** | El que vigila desde la torre: encaja con monitoreo continuo y aviso temprano. Muy claro para no técnicos | La tilde complica dominios y handles ("vigia"); nombre común, posible choque de marcas [no verificado] |
| **Muralla** | Defensa del ecosistema completo, no de una pieza; da una buena metáfora para el puntaje ("tu muralla está al 62 %") | Suena a firewall pasivo, y nuestro diferencial es detectar y avisar [no verificado: marcas] |

Recomendación: **Blindo**, porque sale de las palabras del propio equipo. Comprobar el sábado temprano que no haya un producto de seguridad con ese nombre ni un conflicto de dominio.

---

## Implicaciones para el plan

### Qué adoptar

1. **Reposicionar la originalidad**: el mensaje no es "escaneamos tu Supabase" (hay cinco o más que lo hacen, Aikido incluido), sino **postura continua más explotación en curso más correlación entre capas**, explicada en español por voz y WhatsApp. Eso va en el README, en `project-description.md` y en el primer minuto del pitch.
2. **Núcleo de la demo** (todo S o M): idea 2 (sondeo RLS) → idea 3 (regresión tras commit de migración, con R7 como nueva regla) → idea 15 (llave en el bundle) → idea 8 (prompt más "verificar arreglo") → idea 1 (puntaje con cobertura) → idea 6 (simulacro con cronómetro). Se suma a R1-R5 de la Parte V, no las reemplaza.
3. **Salto técnico para el 25 %**: idea 4 con las reglas C1 a C3 e idea 5 (C4). Son las que ningún competidor muestra.
4. **Conexión a Supabase sin `service_role`**: PAT con permisos finos `database_read`, `advisors_read` y `analytics_logs_read`, más una secret key **dedicada y opcional** solo para métricas. Consumir `advisors/security` en lugar de reimplementar lints.
5. **Soportar `sb_publishable_` y `sb_secret_` desde el primer día** y sacar la lista de tablas por SQL, no del OpenAPI.
6. **Backend con APIs directas** (Supabase Management API, GraphQL y REST de Cloudflare, GitHub REST y webhooks) y **MCP como cara hacia la IA del usuario** (servidor propio de solo lectura, idea 14). Esto cumple la intención del dueño de "todo por MCP" donde aporta y evita depender de MCP de terceros deprecados o con OAuth interactivo para el sondeo de cada minuto.
7. **Verificación de propiedad del dominio** (idea 7) antes de cualquier prueba activa, y escribirlo en el modelo de amenazas.
8. **Corrección del hash**: llaves cifradas con AES-256-GCM (sobre) y clave maestra en Vault; HMAC con pimienta solo como huella, y reutilizarla para detectar fugas de las llaves del propio cliente (idea 16).

### Qué evitar

- Vender como novedad la prueba con anon key, el lint de RLS, el escaneo de CVE o el PR automático.
- Probar escrituras o ejecutar RPC en la base del cliente: los permisos de escritura se infieren por SQL.
- Prometer métricas de CPU y RAM "solo con tu API key": exigen una secret key.
- Construir sobre los MCP especializados de Cloudflare (GraphQL, observabilidad, auditoría), que están deprecados.
- Correr Lighthouse con Chrome dentro de funciones de Vercel: usar PageSpeed Insights API.
- Citar cifras de estudios de vendedores como verdades: siempre "según X".
- Usar el puntaje sin la cobertura al lado.

### Riesgos

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| Un juez pregunta "¿esto no es Aikido?" | Alta | Respuesta de la sección 4.3, ensayada; mostrar la correlación y la regresión en vivo |
| Los endpoints `database/query/read-only` y `advisors/security` son experimentales y pueden cambiar | Media | Probarlos el sábado a primera hora en el proyecto de demo; plan B: MCP oficial de Supabase con `read_only=true` |
| El esquema ClickHouse de los logs no es el esperado | Media | Escribir la consulta en el Logs Explorer antes de programar; plan B con `get_logs` del MCP |
| `has_table_privilege` sobre `anon` no funciona con `supabase_read_only_user` | Baja a media | Probar primero; plan B: inferir por la prueba activa y por los lints 0013 y 0024 |
| Dimensiones `datetimeMinute` o `clientIP` no existen en `...Groups` | Media | Introspección; plan B: agregar desde `httpRequestsAdaptive` (verificado en KUADRA) |
| Falsos positivos de la correlación en la demo | Media | Umbrales fijos [A] calibrados con el simulacro; el modelo nunca decide la alerta |
| El sondeo se percibe como herramienta de ataque | Media | Propiedad del dominio, solo `HEAD`, sin filas, límite de 2 peticiones por segundo, registro encadenado |

### Esfuerzo total estimado

| Bloque | Ideas | Esfuerzo |
|---|---|---|
| Núcleo de la demo | 2, 3, 15, 8, 1, 6, 13 | M + M + S + S + S + S + S ≈ 14 a 18 h de persona, repartibles entre FRONT y BACK |
| Salto técnico | 4 (C1 a C3), 5 (C4) | M + M ≈ 8 a 12 h de persona (BACK) |
| Completar el domingo | 7, 10, 11, 12, 14, 16, 19, 20, 21 | Todas S salvo 14 y 19 (M) ≈ 12 a 16 h de persona |
| Solo si sobra | 9, 17, 18, 22, 23, 24 | M cada una; quedan como hoja de ruta en el pitch |
