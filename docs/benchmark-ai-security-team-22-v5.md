# Benchmark AI Security: monitoreo, frameworks y agentes para startups
**Platanus Hack 26 Caracas, team-22. Investigación al 23 de octubre de 2026.**
> **Versión 5 (23 oct). La Parte V (decisiones del equipo, producto v1 y plan de 36 horas) se agregó al final. Versión 4 (23 oct). La Parte IV (definición del producto, abogado del diablo y 20 preguntas) se agregó al final. Versión 3 (23 oct). La Parte III (conexión a Claude vía MCP/API, integraciones y licencias) se agregó al final.** Versión 2: La Parte I (secciones 1 a 5) es el benchmark inicial. La Parte II (secciones 6 a 12) agrega la comparativa global por empresa, la tabla única para startups, el diseño de la base de fallos globales y el modelo de conexión y privacidad.


Leyenda de confianza: **[V]** confirmado por 2 o más fuentes independientes · **[1F]** una sola fuente o dato del propio vendedor · **[I]** inferencia mía, no un hecho.

## Cómo entendí el tema
Una herramienta de monitoreo y respuesta para startups: vigila logs, base de datos y sistema, y sobre todo vigila los frameworks y dependencias de los que dependen (caso PHP). Avisa por voz a las 4 a.m., y la maneja igual un CTO que un CEO o un CFO, en lenguaje natural, con un cerebro de IA local, OpenRouter o la API de Claude. Prioridad actual: benchmark general.

## Resumen ejecutivo
- **[V]** PHP2Shell (21 oct) son dos fallos de ejecución remota de código en el propio motor de PHP, CVSS 9.2. Hubo intentos de ataque millones de veces en horas, pero sin compromisos confirmados hasta el 22 oct.
- **[V]** Los fallos se encontraron con ayuda de modelos de IA (OpenAI, Wiz, Calif). La ventana entre "parche público" y "exploit en la calle" se está comprimiendo, y esa es la tesis fuerte del proyecto.
- **[V]** El mercado de "AI SRE" (agentes de guardia) está lleno y financiado: Resolve AI, Cleric, Traversal, PagerDuty, Rootly, incident.io, Datadog, New Relic y el open source HolmesGPT. Casi todos están pensados para ingenieros y para Slack.
- **[V]** Seguridad de agentes en runtime ya tiene a los grandes: CrowdStrike, Palo Alto, Microsoft, HiddenLayer, Straiker, Zenity. Competir de frente ahí es mala idea para un hackathon.
- **[V]** Protección de dependencias para startups tiene dos unicornios: Socket y Aikido.
- **Vacío que veo [I]:** nadie une "salió una vulnerabilidad", "esto afecta a TU stack", "aprobá el arreglo con tu voz" y "verificamos que quedó cerrado", dicho en lenguaje de negocio para quien no es técnico.
- **Recomendación:** idea A (alerta de exposición a vulnerabilidades de frameworks con llamada de voz, PR de arreglo y verificación). Detalle en la sección 5.

---

## 1. Panorama

### 1.1 PHP2Shell (esta semana)
| Fecha (UTC) | Qué pasó | Confianza |
|---|---|---|
| 1 al 11 ago | Calif encuentra y reporta el primer fallo a PHP; Wiz lo encuentra de forma independiente y reporta el 24 ago | [V] |
| 17 oct | Honeypots de Amazon registran un intento de explotación, 4 días antes de la divulgación pública | [1F] |
| 20 oct | Se filtran los detalles; PHP adelanta el aviso y el parche | [V] |
| 21 oct, 07:43 | Cloudflare reporta los primeros ataques, antes del lanzamiento de 14:00 | [1F] |
| 21 oct, 14:00 | PHP publica 8.5.12, 8.4.27, 8.3.36 y 8.2.35 | [V] |
| 22 oct | Cloudflare habla de millones de intentos; The Hacker News dice que no hay evidencia de acceso a shell en los sitios revisados | [V] |
| 23 oct | PHP avisa de un tercer problema distinto, CVE-2026-115560, sin parche; solo afecta una configuración de sesiones poco común y no hay explotación reportada | [V] |

Puntos clave:
- Afecta a casi cualquier instalación PHP que sirva web (PHP-FPM, mod_php, php-cgi, FrankenPHP, LiteSpeed). Según PHP, no existe mitigación completa y lo único seguro es actualizar. [V]
- El impacto real está en disputa. Sansec sostiene que la explotación masiva es menos probable de lo temido porque los exploits públicos requieren condiciones específicas y no funcionan contra una instalación por defecto. Otras fuentes hablan de millones de intentos y de 34,4 millones de servicios PHP aún vulnerables (cifra reportada por The Hacker News, sin método claro). **No exageres el "70% de internet" en el pitch:** es una cifra de Wiz sobre exposición potencial, no sobre sitios comprometidos. [1F]
- Cloudflare activó protección WAF por defecto, incluso en el plan gratis, pero dice que los atacantes ya mutan los payloads y recomienda parchear igual. **Consecuencia para nosotros:** "bloquear" ya lo hacen otros gratis; el valor está en saber, arreglar y verificar. [V]
- Quién lo encontró: Calif, Wiz y OpenAI con modelos de frontera. Un análisis independiente matiza que no fue la IA sola, sino investigadores humanos usándola. [V]
- Una frase útil del CEO de Calif (citada por WSJ): alguien podría tomar los parches, correr IA contra ellos y publicar un exploit. [1F]

### 1.2 La semana anterior: Drupal
Drupal parchó el 14 oct dos fallos críticos de ejecución remota (CVE-2026-108097 en Field UI del núcleo y CVE-2026-108099 en el módulo Entity List), y avisó dos días antes de que podían aparecer exploits "en horas o días". No hay explotación reportada en las fuentes que revisé. [V] **Asumí que "la semana pasada" se refiere a esto; confírmalo.**

### 1.3 Por qué importa para startups
- La ventana de parcheo se achica: ataques 45 minutos después del anuncio, según Cloudflare. [1F]
- Los parches de hosting compartido, imágenes de contenedor y plugins de CMS van con retraso. Un startup sin equipo de seguridad ni siquiera sabe en cuántos lugares corre PHP. [I]

### 1.4 Agentes de IA como superficie de ataque
- Entre abril de 2025 y abril de 2026 se registraron al menos 16 incidentes públicos relacionados con MCP (inyección de prompts, envenenamiento de herramientas, inyección de comandos). [1F]
- Hubo más de 30 CVE contra servidores MCP en una ventana de 60 días a inicios de 2026, y una auditoría de CoSAI puntuó 17 servidores MCP con 34/100 de seguridad promedio. [1F]
- Endor Labs analizó 2.614 implementaciones MCP: 82% con operaciones de archivos propensas a path traversal. [1F]
- El CEO de Socket dice que los agentes de programación traen un 50% más de dependencias que un humano y que los modelos inventan nombres de paquetes que los atacantes registran. Es una opinión de vendedor. [1F]
- Contrapunto a tu tesis: dijiste que en 3 meses las API keys en repos estarán resueltas. Lo que encontré apunta a lo contrario: Socket reportó en mayo de 2026 una campaña activa en npm, PyPI y Crates.io que robaba tokens de GitHub, claves SSH y API keys, e incluía instrucciones ocultas para engañar a asistentes de IA como Claude y Cursor. [1F] Yo no daría por cerrado el tema de secretos; puede ser un módulo secundario, no descartado.

---

## 2. Benchmark

### 2.1 Agentes de guardia y respuesta a incidentes ("AI SRE")
| Producto | Qué hace | Precio / licencia | Tracción | Limitaciones |
|---|---|---|---|---|
| Resolve AI | Agente autónomo de investigación y resolución | Contactar ventas | Valoración de 1.500 M USD en abril de 2026, más de 190 M USD levantados (otra fuente da cifras distintas) | Enfoque enterprise, precio opaco |
| Cleric | Investigación de solo lectura, enfoque cauteloso | Hay plan gratis; el resto no se publica | Seed; las cifras de ronda difieren entre fuentes | Recomienda, no ejecuta |
| Traversal | Análisis de causa raíz con foco en precisión | No publicado | Seed + A, unos 48 M USD (una fuente) | Enterprise |
| PagerDuty SRE Agent | Resume, propone causa y puede ejecutar diagnósticos | Parte de la plataforma | Incumbente; suite lanzada en oct 2025 | Atado al ecosistema PagerDuty |
| New Relic SRE Agent | "Compañero de guardia" con análisis de causa raíz | Parte de New Relic | Incumbente | Atado a su observabilidad |
| Datadog Bits AI SRE | Investiga alertas | Para clientes Datadog | Cotiza en bolsa | Solo investiga; atado a Datadog |
| Rootly | Gestión de incidentes con IA | Essentials unos 20 USD por usuario/mes (directorio de terceros) | Financiamiento total bajo comparado | Orientado a equipos medianos de SRE |
| incident.io | Incidentes en Slack con on-call e IA | Plan Pro con on-call 45 USD por usuario/mes (precio del propio vendedor) | Unos 100 M USD levantados | Pensado para ingeniería |
| HolmesGPT (Robusta) | Agente open source, CNCF Sandbox | Apache 2.0, gratis | Unas 2,8 mil estrellas en GitHub | Por defecto envía datos a proveedores externos de LLM; mejor con Kubernetes |
| K8sGPT | Diagnóstico de clústeres Kubernetes | Open source | Unas 8 mil estrellas (un blog) | Solo Kubernetes |

Hallazgo de diseño **[1F/V]**: varias guías de práctica coinciden en que los ingenieros de guardia no quieren un agente con escritura sin revisión en producción. Quieren que haga el trabajo alrededor de la decisión. Gartner publicó su primera guía de mercado de "AI SRE" en enero de 2026 (dato reportado por un vendedor).

### 2.2 Seguridad de agentes en runtime
| Producto | Enfoque | Notas |
|---|---|---|
| CrowdStrike Falcon (AIDR y Guardian) | Descubrir, vigilar y controlar agentes en endpoints, nube, SaaS y navegador | Anunciado en marzo y septiembre de 2026 |
| Palo Alto Prisma AIRS | Protección en runtime, identidad de agentes, red teaming | Dos modos de despliegue (red y API) |
| Microsoft Defender | Descubrimiento y protección de agentes dentro de su portal | Partes en vista previa según Reco |
| HiddenLayer | Seguridad de runtime para IA agéntica | Su informe dice que uno de cada ocho brechas de IA involucra sistemas agénticos |
| Straiker, Zenity, Reco, Nightfall | Guardrails, gobierno y DLP para agentes | Todos orientados a empresas grandes |

Lectura **[I]**: es una categoría de enterprise con ventas largas. Un equipo de 5 en un hackathon no la gana por amplitud.

### 2.3 Frameworks, dependencias y vulnerabilidades (nuestro público)
| Producto | Qué hace | Precio | Tracción | Limitaciones |
|---|---|---|---|---|
| Socket | Bloquea paquetes maliciosos antes de instalarlos; Firewall y MCP | Gratis en repos públicos; privados desde unos 10 USD por dev/mes (directorio) | 60 M USD Serie C, valoración 1.000 M USD (mayo 2026); más de 27 mil organizaciones | No reemplaza parchar CVE conocidos |
| Aikido | Plataforma única para código, nube y runtime, pensada para startups | Gratis para 2 usuarios; Basic entre 300 y 350 USD/mes (10 usuarios); pentests desde 4.000 USD | 60 M USD Serie B, valoración 1.000 M USD (enero 2026) | Precio sube al escalar; nube menos madura |
| Endor Labs | Análisis de dependencias; publicó guía de PHP2Shell para clientes | No revisado | No revisado | Enterprise |
| Cloudflare WAF | Reglas gestionadas contra PHP2Shell, activas por defecto en todos los planes con WAF | Incluido, incluso en el plan gratis | Masiva | Los atacantes mutan payloads; el parche sigue siendo necesario |
| Harness (virtual patching) | Regla WAF para PHP2Shell | No revisado | No revisado | Requiere estar en línea con el tráfico |
| php2shell-scanner (Searchlight Cyber) | Herramienta open source que prueba si un host está expuesto | Gratis | Publicada el 22 oct | Hay que usarla solo en hosts propios |

### 2.4 Voz para operaciones
| Proyecto | Qué hace | Nota |
|---|---|---|
| EZ OnCall (hackathon ElevenLabs) | Llama por teléfono al ingeniero de guardia con ElevenLabs y Twilio; ejecuta rollback o reinicio por comando de voz usando n8n | Es casi exactamente la mitad de voz de nuestra idea; ya existe como demo de hackathon |
| 911 Production Incident Response (Devpost) | Agente de voz con ElevenLabs para preguntar por incidentes en curso | Tuvo problemas integrando Twilio |
| Aegis Nexus (lablab) | Llamada de voz por Twilio a un SOC | Demo de hackathon |

Dato operativo **[V]**: ElevenLabs tuvo incidencias en sus llamadas (por ejemplo, fallos de enrutamiento SIP de unas 2,4 horas el 31 jul 2026). Si el producto promete llamarte a las 4 a.m., necesita un canal de respaldo (SMS o segundo proveedor). Twilio, según una guía de terceros, pide 20 USD de depósito mínimo y 1 USD al mes por número; verifícalo antes de contar con ello.

---

## 3. Vacíos (dónde podría aportar un equipo de 5)
1. **De "salió una vulnerabilidad" a "me afecta a mí" [I].** Las herramientas de AI SRE parten de una alerta de tu propio sistema. Las de dependencias parten de tu repositorio. Nadie que revisé parte de la noticia (un aviso de PHP, Drupal, etc.), la cruza con el inventario real del startup y actúa. PHP corre en hosting compartido, contenedores, WordPress y servidores olvidados, y casi nadie tiene ese inventario.
2. **Cerrar el ciclo [I].** Muchos avisan o recomiendan; pocos abren el cambio, lo prueban y verifican que el riesgo quedó cerrado.
3. **Lenguaje para no técnicos [I].** El material que encontré de AI SRE y de seguridad de agentes es de ingeniería y de Slack. Un CEO o CFO que pregunte "¿estamos expuestos y cuánto nos costaría?" no tiene a quién preguntarle.
4. **Controles seguros por diseño [V/I].** Lo que piden los practicantes es lectura por defecto y aprobación humana para escribir. Aprobar por voz con una verificación extra es una variante natural.
5. **Cerebro local [1F].** HolmesGPT envía datos a proveedores externos por defecto. Un startup que no quiere mandar un retrato de producción a un tercero valora una opción local.
6. **Vigilar al vigilante [I].** Si nuestro agente tiene acceso a repos y servidores, es un blanco. Un diferenciador creíble es mostrar cómo se protege a sí mismo (permisos mínimos, registro de cada acción).

---

## 4. Tres ideas de proyecto

### Idea A. "Alerta de exposición": noticias de vulnerabilidad a arreglo verificado
**Qué hace.** Escucha avisos (PHP, Drupal, GitHub advisories, CISA). Cruza cada aviso con el inventario del startup (repos y Dockerfiles que se conectan en solo lectura). Si hay exposición, llama por voz y explica en lenguaje simple qué pasa y qué se propone. El dueño aprueba por voz, el agente abre un PR con la actualización, corre verificaciones y confirma que quedó cerrado.
**Demo de 2 minutos.** Un repo de demo con PHP 8.3.34 y un Dockerfile. Llega "el aviso de PHP2Shell". El panel muestra "2 de 5 servicios expuestos". Suena el teléfono, la voz explica y pide permiso. Se aprueba, aparece el PR con el cambio a 8.3.36, pasa el escáner contra el entorno de demo, y el panel pasa de rojo a verde. Cierre con una vista para el CEO ("riesgo cerrado, 0 servicios expuestos").
**Stack sugerido.** Next.js en Vercel, Supabase, ElevenLabs Agents con Twilio, Claude API u OpenRouter, GitHub API, php2shell-scanner como herramienta de verificación en entornos propios.
**En 24 a 48 horas.** Alcanzable: ingestión de 2 avisos con datos precargados, detección por lectura de Dockerfile y composer, llamada de voz, PR automático, verificación. Sin escaneo de infraestructura de terceros.
**Riesgos.** Fiabilidad de telefonía y de ElevenLabs; que el jurado vea el escáner como "otra herramienta de parches"; correr exploits solo contra nuestro propio entorno.
**Por qué impresiona.** Usa el incidente más sonado de la semana, tiene voz y muestra un antes y un después medible.

### Idea B. "Guardián de agentes": inventario y vigilancia de MCP y habilidades
**Qué hace.** Inventaría los servidores MCP, habilidades y extensiones que usan los agentes de un equipo, detecta descripciones de herramientas envenenadas, secretos expuestos y comandos peligrosos, registra cada acción y ofrece un botón de corte por voz.
**Demo.** Un agente que lee un issue de GitHub con inyección oculta; el guardián lo detecta y bloquea antes de que filtre datos.
**Stack.** Proxy MCP en TypeScript, reglas más un modelo clasificador, Supabase para el registro.
**En 24 a 48 horas.** Viable, pero el demo es más abstracto.
**Riesgos.** Competir con Straiker, Zenity, Snyk y los grandes; difícil mostrar valor en 2 minutos.
**Por qué impresionaría.** Es el centro literal de "AI Security", pero con riesgo de parecer una versión menor de lo que ya existe.

### Idea C. "Centinela de las 4 a.m.": monitoreo de logs y base de datos con triaje y voz
**Qué hace.** Vigila logs y Supabase, detecta anomalías, hace triaje con IA y llama. Incluye un panel donde el CEO pregunta en lenguaje natural.
**Demo.** Se rompe un servicio de demo, suena el teléfono, se hace rollback por voz.
**Stack.** Ingestión de logs, Supabase, ElevenLabs, Claude.
**En 24 a 48 horas.** Muy viable técnicamente.
**Riesgos.** Es el espacio más saturado (sección 2.1) y EZ OnCall ya hizo una demo casi idéntica. Sin la parte de seguridad, no es un proyecto de AI Security.
**Por qué impresionaría.** Es lo que se entiende más rápido, pero es lo que menos distingue.

---

## 5. Recomendación
**Elegiría la Idea A**, usando la C solo como capa de detección y la voz como interfaz.

Por qué, en una línea cada una:
- Encaja con tu tesis (frameworks y startups) y con el incidente más reciente.
- Está menos ocupada que el AI SRE y no compite con los grandes de runtime.
- La demo es visual, tiene un antes y un después y toca a CTO y CEO.
- Se puede construir con lo que ya tienen (Vercel, Supabase, ElevenLabs, API de Claude u OpenRouter).

**Pregunta abierta para el equipo:** ¿qué le damos de acceso al producto (solo repos en lectura, o también servidores)? Es la decisión que más cambia el alcance, el riesgo y el pitch. Y una de verificación: ¿cuántas horas tenemos y cuáles son los criterios del jurado? Con eso afino la elección.

**Dos cosas que no verifiqué:** señales concretas en logs que delaten un intento de PHP2Shell (no encontré una fuente confiable, y no las inventaría), y precios actuales de Twilio y ElevenLabs.

---

## Fuentes
- [PHP2Shell, Sansec](https://sansec.io/research/php2shell)
- [PHP2Shell exploit attempts hit millions, The Hacker News (23 oct)](https://thehackernews.com/2026/10/php2shell-exploit-attempts-hit-millions.html)
- [PHP2Shell FAQ, watchTowr](https://watchtowr.com/intelligence/php-cve-2026-109618-faq/)
- [PHP2Shell: critical PHP vulnerabilities patched, Help Net Security](https://www.helpnetsecurity.com/2026/10/21/php2shell-php-vulnerabilities-patched-cve-2026-109618-cve-2026-109619/)
- [PHP issues emergency patches, The Hacker News](https://thehackernews.com/2026/10/php-issues-emergency-patches-for-two.html)
- [PHP warns of another unpatched RCE (CVE-2026-115560), The Hacker News](https://thehackernews.com/2026/10/urgent-php-warns-of-another-unpatched.html)
- [PHP shares mitigation for new RCE, BleepingComputer](https://www.bleepingcomputer.com/news/security/php-shares-mitigation-for-new-and-unpatched-rce-vulnerability/)
- [PHP ships emergency patches, BleepingComputer](https://bleepingcomputer.com/news/security/php-ships-emergency-patches-for-critical-php2shell-flaws)
- [PHP2Shell, Wiz](https://wiz.io/blog/php2shell-php-rce)
- [Análisis de roles de la IA en PHP2Shell, SmartScope](https://smartscope.blog/en/blog/php2shell-ai-really-find-php-vulnerability-roles-openai-2026/)
- [WSJ vía To Vima: AI found a bug](https://www.tovima.com/wsj/ai-just-found-a-bug-that-puts-up-to-70-of-the-worlds-websites-at-risk/)
- [Cloudflare WAF y PHP2Shell, ppc.land](https://ppc.land/cloudflare-blocks-php2shell-exploits-9-hours-before-php-flaws-went-public/)
- [Harness: virtual patching](https://www.harness.io/blog/php2shell-the-flaw-hiding-all-across-the-web)
- [Endor Labs: PHP2Shell](https://www.endorlabs.com/learn/php2shell-critical-vulnerabilities-in-php-cve-2026-109618-cve-2026-109619)
- [Drupal: dos RCE críticos, SecurityWeek](https://www.securityweek.com/drupal-warns-of-fast-exploitation-risk-for-critical-core-rce-flaw/)
- [Drupal, BleepingComputer](https://bleepingcomputer.com/news/security/drupal-patches-critical-rce-flaws-warns-exploits-may-emerge-soon)
- [CSA: Drupal Field UI RCE](https://labs.cloudsecurityalliance.org/research/csa-research-note-drupal-field-ui-rce-cve-2026-108097-202610/)
- [Guía AI SRE, Augment Code](https://augmentcode.com/guides/ai-sre-incident-management)
- [AI SRE agents, ClickHouse](https://clickhouse.com/ar/resources/engineering/ai-sre-agents)
- [Guía AI SRE, Xurrent](https://www.xurrent.com/blog/ai-sre-guide)
- [Resolve AI a 1.500 M USD, Beri](https://www.beri.net/article/resolve-ai-190m-ai-sre-production-incidents-2026)
- [Comparativa Resolve AI, Cleric, Traversal](https://wetheflywheel.com/en/comparisons/resolve-ai-alternatives/)
- [PagerDuty SRE Agent](https://www.businesswire.com/news/home/20251008279706/en/PagerDuty-Launches-Industry%E2%80%99s-First-End-to-End-AI-Agent-Suite-Slashing-Incident-Response-Times-and-Empowering-Teams-to-Innovate)
- [New Relic SRE Agent](https://docs.newrelic.com/docs/agentic-ai/sre-agent/overview/)
- [Rootly vs incident.io, incident.io (fuente del vendedor)](https://incident.io/blog/rootly-incident-management-review-2026)
- [HolmesGPT, CNCF](https://www.cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era/)
- [HolmesGPT, ficha de proyecto](https://dev.co/devops/open-source/holmesgpt)
- [Agent runtime security, Reco (21 oct)](https://www.reco.ai/compare/best-agent-runtime-security-platforms)
- [Top 7 AI runtime security, Straiker (fuente del vendedor)](https://www.straiker.ai/blog/top-7-ai-runtime-security-platforms)
- [CrowdStrike Falcon Guardian](https://www.cyberdaily.au/security/14134-crowdstrike-puts-ai-agents-under-runtime-security-with-falcon-guardian)
- [HiddenLayer, runtime agéntico](https://hiddenlayer.com/news/hiddenlayer-unveils-new-agentic-runtime-security-capabilities-for-securing-autonomous-ai-execution)
- [Socket Serie C](https://socket.dev/blog/series-c)
- [Entrevista con el CEO de Socket](https://app.dealroom.co/news/note/the-ai-supply-chain-nightmare-socket-s-feross-aboukhadijeh-on-why-coding-agents-break-software-security)
- [Campaña de cadena de suministro de mayo, Forklog](https://forklog.com/en/?p=97438)
- [Precios de Aikido, CodeAnt](https://www.codeant.ai/blogs/aikido-security-pricing)
- [Aikido, ficha EveryDev](https://www.everydev.ai/developers/aikido-security)
- [Estadísticas de seguridad MCP, Practical DevSecOps](https://www.practical-devsecops.com/mcp-security-statistics-2026-report/)
- [Índice de brechas MCP, Zealynx](https://www.zealynx.io/research/adversarial-security/mcp-breach-index-2025-2026)
- [EZ OnCall, AI Tinkerers](https://nyc.aitinkerers.org/hackathons/h_1de1QREJyuU/entries/ht_5YOesV-FSpY)
- [911 Production Incident Response, Devpost](https://devpost.com/software/911-production-incident-response)
- [Incidencia SIP de ElevenLabs](https://isdown.app/status/elevenlabs/incidents/631524-sip-call-failures)
- [Guía de agentes ElevenLabs con Twilio, Growwstacks](https://growwstacks.com/blog/elevenlabs-agents-guide/)


---

# PARTE II. Comparativa global por empresa
**Investigación al 23 de octubre de 2026.**

## Cómo leer esta parte
- **[P]** dato publicado por la propia empresa o en resultados oficiales de una empresa que cotiza.
- **[R]** reportado por un tercero (prensa, directorios, estimaciones de analistas). Las cifras de ARR de empresas privadas son estimaciones, no balances.
- **[A] ASUMIDO.** Es una hipótesis mía, sin dato que la respalde. Las empresas privadas no publican pérdidas ni márgenes, así que casi todo lo que digo sobre "dónde pierden dinero" en ellas es [A] y hay que validarlo antes de apoyarse en eso.
- **[I]** inferencia mía sobre capacidades o mercado.

**Límites de la investigación.** Cubrí unas 55 empresas, no "todas". No encontré precios de pago de GitGuardian ni de Huntress (se vende por MSP), ni cotizaciones de Sprinto, Resolve AI o Intruder Cloud. No probé ningún producto: las capacidades salen de documentación pública. Para Asia y Latinoamérica la información en línea es más delgada que para EE. UU. y Europa.

---

## 6. Mapa por región
| Región | Quiénes (ejemplos) | Patrón dominante | Qué implica para nosotros |
|---|---|---|---|
| EE. UU. | Vanta, Drata, Snyk, Socket, Huntress, Arctic Wolf, CrowdStrike, SentinelOne, Chainguard, Semgrep, Coalition | Financiadas por capital de riesgo, venta por plataforma, freemium en dev y canal MSP en pymes | Es el mercado más competido; la seguridad de IA ya se consolida por compras |
| Israel y EE. UU. | Wiz (Google), Check Point con Lakera, Cato con Aim, Noma, Zenity | Seguridad de nube y de IA para empresas grandes | Salidas altas, pero producto pensado para grandes |
| Europa | Aikido (Bélgica), GitGuardian y Sekoia.io (Francia), Detectify (Suecia), Intruder (Reino Unido), Hornetsecurity (Alemania, hoy de Proofpoint), Darktrace (Reino Unido, hoy de Thoma Bravo) | Startups "dev-first" y pymes por MSP; la regulación NIS2 empuja la demanda | Aikido es el espejo más cercano a lo que queremos hacer para startups |
| Latinoamérica | Tempest, ISH y Axur (Brasil), Hackmetrix (México y Chile), Unxpose (Brasil), Delta Protect (México), NESS (Colombia) | Mucho servicio y consultoría; pocas plataformas SaaS con precio bajo; rondas pequeñas | Espacio abierto en español y con precio de startup [I] |
| Asia | Trend Micro (Japón), AhnLab (Corea), Quick Heal/Seqrite, CloudSEK, Indusface, Sprinto (India y Singapur) | Antivirus y plataformas clásicas, WAF y cumplimiento de bajo costo | India compite por precio; nadie vende un "centro de mando" ejecutivo |
| Global y bajo costo | Cloudflare (WAF gratis), HostedScan, Coro, HolmesGPT, OSV y otras fuentes abiertas | Gratis o muy barato | Es la línea de base de precio contra la que se nos va a comparar |

Dato de contexto: Kaspersky reporta que el malware disfrazado de aplicaciones de IA (falsos ChatGPT, DeepSeek y Claude) contra pymes creció casi cinco veces en el mundo y casi siete veces en el Sudeste Asiático en los primeros cuatro meses de 2026 [1F, dato del vendedor].

---

## 7. Fichas por empresa
Columnas: propuesta de valor, cliente ideal, cómo vende, dónde pierde dinero, ventaja única.

### 7.1 Cumplimiento y confianza para startups
| Empresa | Propuesta de valor | Cliente ideal | Cómo vende | Dónde pierde dinero | Ventaja única |
|---|---|---|---|---|---|
| **Vanta** (EE. UU.) | Automatiza la evidencia y el monitoreo continuo para certificarse (SOC 2, ISO 27001 y más) | Startups SaaS y mid-market que necesitan un certificado para cerrar ventas B2B | Demos y cotización a medida; entrada hacia 10 mil USD/año y 19 a 30 mil con extras [R]; red de auditores aliados | [R] ARR de unos 300 M en abril de 2026, +69% anual. [A] Sin márgenes públicos; asumo costo alto de ventas y soporte, y presión de precio de rivales 20 a 40% más baratos [R] | La mayor red de integraciones y auditores; domina el mid-market según YipitData [R] |
| **Drata** (EE. UU.) | Gestión de confianza con agentes: cumplimiento, riesgo, Trust Center y gobierno de agentes de IA (acceso temprano, junio de 2026) | Equipos de ingeniería y empresas más grandes; 8.500+ organizaciones [P] | Cotización; de 7,5 mil a 80 mil USD o más por año [R] | [R] Retención de 75 a 80% según YipitData; compró SafeBase por unos 250 M [P, portavoz]. [A] Costo de integrar la compra y de reposicionarse hacia agentes mientras Vanta lidera el mid-market | Automatización profunda de CI/CD y salto temprano a gobierno de agentes |
| **Secureframe** (EE. UU.) | Cumplimiento con implementación guiada y precio agresivo | Startups con presupuesto ajustado | Cotización desde unos 7,5 mil USD/año [R]; sirve de ancla para negociar con Vanta y Drata | [R] Su última ronda conocida es una Serie B de 56 M en febrero de 2022. [A] Sin ronda reciente, asumo presión de caja y retención más variable (YipitData lo sugiere) | Acompañamiento humano en la implementación |
| **Sprinto** (India y EE. UU.) | Cumplimiento "autónomo" con agentes de IA y la entrada más baja del grupo | Startups pequeñas e internacionales; precios en rupias y auditores locales [R] | Demo; sin precio público; entrada de 4 a 5 mil USD [R] | [A] Márgenes finos por precio bajo; no hay datos financieros | Precio y operación local en India |

### 7.2 Código, dependencias y cadena de suministro
| Empresa | Propuesta de valor | Cliente ideal | Cómo vende | Dónde pierde dinero | Ventaja única |
|---|---|---|---|---|---|
| **Snyk** (EE. UU. y Reino Unido) | Escaneo de código, dependencias, contenedores y configuración dentro del flujo del dev; compró Invariant Labs para seguridad de IA | Equipos de ingeniería de cualquier tamaño | Freemium; Team 25 USD por dev al mes (mínimo 5 devs); Ignite 1.260 USD por dev al año [R] | [R] ARR de unos 326 M en febrero de 2026, solo +7%; cuarta ronda de despidos (unos 90 en junio; otra fuente habla de más de 200); el CEO salió en febrero. [A] Crecimiento lento frente a una estructura de costos y valoración (7.400 M en 2022) de otra época | Marca, base instalada y un plan gratis generoso |
| **Socket** (EE. UU.) | Bloquea paquetes maliciosos antes de instalarlos; MCP para asistentes de IA | Startups y empresas con agentes de código y npm, PyPI, Maven o Go | Freemium (gratis en repos públicos; privados desde unos 10 USD por dev [R]), app de GitHub, marketplace de AWS | [P] Serie C de 60 M a 1.000 M de valoración (mayo de 2026); más de 27 mil organizaciones. El CEO admite que todavía hay mucho análisis humano de hallazgos. [A] Costo de cómputo y de analistas sube con el volumen de ataques; el plan gratis es un centro de costo | Detección por comportamiento, no solo por CVE conocido |
| **Aikido** (Bélgica) | Una plataforma para código, nube, contenedores y runtime con triaje automático para equipos sin especialista | Startups y scale-ups sin equipo de seguridad | Autoservicio: gratis para 2 usuarios; Basic de 300 a 350 USD/mes (10 usuarios); pentests desde 4.000 USD [R] | [R] Serie B de 60 M a 1.000 M (enero de 2026, lidera DST); ARR de unos 13 M reportado sin verificar. [A] Con ese ARR, la valoración exige crecimiento muy alto; las reseñas dicen que el precio sube rápido al escalar | Reemplaza 16 o más herramientas con foco en startups |
| **GitGuardian** (Francia) | Secretos expuestos e identidades no humanas (agentes, llaves) | Equipos dev con muchos repos | Freemium y ventas | [R] 106 M levantados (Serie C de 50 M en febrero de 2026); ingresos en el rango de 1 a 10 M según Dealroom. [A] Quema alta frente a ingresos; la detección de secretos tiende a comoditizarse por funciones nativas de las plataformas [I] | Foco en identidades no humanas y monitoreo de repos públicos |
| **Chainguard** (EE. UU.) | Imágenes de contenedor mínimas "cero CVE" y librerías endurecidas | Empresas con contenedores y exigencias regulatorias | Venta enterprise | [R] Unos 892 M captados (incluye 280 M de deuda), valoración de 3.500 M, ARR de 40 M con meta de superar 100 M en su año fiscal 2026. [A] Costo alto de reconstruir y parchear imágenes de forma continua | Líder en el cuadrante de Gartner 2026 de cadena de suministro |
| **Semgrep** (EE. UU.) | Análisis estático con IA "multimodal" | Equipos de seguridad de aplicaciones | Motor abierto más plataforma de pago | [R] 204 M levantados; valoración cercana a 800 M en mercado secundario (febrero de 2025); ingresos de 10 a 50 M. [A] Monetizar sobre un motor abierto es caro | Reglas abiertas y comunidad |

### 7.3 Superficie externa y escáneres baratos
| Empresa | Propuesta de valor | Cliente ideal | Cómo vende | Dónde pierde dinero | Ventaja única |
|---|---|---|---|---|---|
| **Intruder** (Reino Unido) | Escaneo de exposición externa y nube con priorización; plan gratis | Startups que deben mantener cumplimiento | Autoservicio: Essential desde 149 USD/mes, Cloud desde 299 [R] | [A] Sin datos financieros públicos; negocio pequeño de escala limitada | Simplicidad y precio publicado |
| **Detectify** (Suecia) | Monitoreo continuo de aplicaciones web con investigación de hackers externos | Equipos web | Desde unos 89 USD/mes; típico de 2 mil a 30 mil USD/año [R] | [R] Unos 35 a 39 M levantados. [A] Un solo foco frente a plataformas amplias | Investigación colaborativa de hackers |
| **HostedScan, Astra** | Escaneo de vulnerabilidades ultra barato | Micro-empresas | Precio publicado: unos 39 y 69 USD/mes [R] | [A] Margen por volumen | Precio |
| **Indusface** (India) | WAF, seguridad de aplicaciones y API, con servicio gestionado | Pymes y mid-market; más de 6.500 clientes en más de 95 países [R] | SaaS más servicio gestionado | [R] Inversión de 5 M de Tata Capital (dato antiguo). [A] El WAF se vuelve guerra de precios frente a Cloudflare | Gestionado y homologado por CERT-In |

### 7.4 Seguridad gestionada para pymes y low cost
| Empresa | Propuesta de valor | Cliente ideal | Cómo vende | Dónde pierde dinero | Ventaja única |
|---|---|---|---|---|---|
| **Huntress** (EE. UU.) | Seguridad gestionada (EDR, identidad, SIEM, capacitación) con SOC 24/7 | Pymes atendidas por proveedores de TI (MSP) | Canal MSP/MSSP | [R] ARR de más de 250 M, +65%, 270 mil negocios; planea ronda en 2027. [A] Un SOC humano pesa en el margen; el presupuesto limitado de la pyme y la dependencia del canal | Retorno rápido y precio pensado para pyme |
| **Arctic Wolf** (EE. UU.) | MDR/SOC como servicio | Mid-market | Solo por canal; base de unos 15 mil USD/año; mediana de 40 mil para ≤100 usuarios [R, confianza baja] | [A] Privada, sin datos; costo de SOC humano y márgenes del canal | Servicio completo "llave en mano" |
| **Coro** | Plataforma modular para pymes desde unos 9 USD por usuario al mes [R] | Pymes de hasta unas 100 personas | Autoservicio y prueba gratis | [A] Precios bajos exigen volumen; sin datos financieros | Precio y modularidad |
| **Hornetsecurity** (Alemania; Proofpoint la compró por 1.800 M, cierre en diciembre de 2025) | Seguridad de Microsoft 365 vía MSP | 12 mil MSP y 125 mil pymes en Europa [P] | Canal MSP | [P] ARR de casi 200 M, +20%. [A] Margen y costo de integración desconocidos | Red de MSP en Europa |
| **Quick Heal / Seqrite** (India, cotiza) | Antivirus y seguridad empresarial; expansión a Sudeste Asiático y Medio Oriente | Pymes y consumo en India | Canal y marca local | [R] Su presidente describió el año fiscal 2026 como "mixto". [A] Declive del antivirus de consumo | Precio y canal en India |

### 7.5 Plataformas grandes
| Empresa | Propuesta de valor | Cliente ideal | Cómo vende | Dónde pierde dinero | Ventaja única |
|---|---|---|---|---|---|
| **Wiz** (EE. UU. e Israel; Google) | Visibilidad de código a nube en multinube, ahora con foco en IA | Empresas grandes (más de la mitad de las Fortune 100) | Ventas enterprise | [P] Más de 1.000 M de ARR; Google la compró por 32.000 M (cerró el 11 de marzo de 2026). [A] El precio de compra exige crecer dentro de Google sin perder neutralidad multinube | Investigación propia (PHP2Shell) y datos de nube |
| **CrowdStrike** (EE. UU.) | Plataforma Falcon: endpoint, nube, identidad, SIEM y protección de agentes en runtime | Mid-market y enterprise; pymes vía socios | Ventas, modelo Flex y socios | [P] ARR de 5.250 M (+24%); utilidad GAAP positiva en el cuarto trimestre del año fiscal 2026, pero pérdidas GAAP en el primero (110 M) y segundo (78 M) por compensación en acciones | Plataforma única y datos de telemetría |
| **SentinelOne** (EE. UU.) | Plataforma Singularity con IA | Mid-market y enterprise | Ventas y socios | [P] Ingresos de 1.001 M (+22%) en el año fiscal 2026; pérdida neta GAAP de 45% de los ingresos; margen operativo GAAP de −32% (no-GAAP +3%); caja de 770 M | Compró Prompt Security para seguridad de IA |
| **Trend Micro** (Japón) | Plataforma Vision One y paquete de seguridad de IA, alianza con NVIDIA | Empresas y gobiernos en Asia y el mundo | Ventas y socios | Publica resultados trimestrales (Q2 de 2026 el 13 de agosto); no verifiqué su rentabilidad | Presencia en Asia |
| **AhnLab** (Corea) | Plataforma de operaciones de seguridad con IA | Corea y Asia-Pacífico | Ventas y socios | [A] Mercado doméstico concentrado; sin datos revisados | Reconocida por Frost & Sullivan en Asia-Pacífico 2026 |
| **Darktrace** (Reino Unido; Thoma Bravo la compró por 5.300 M en 2024) | Detección de anomalías con IA en red y correo | Empresas medianas y grandes; más de 9.400 clientes al momento de la compra | Ventas directas | [R] Cambió de CEO en enero de 2026 y de nuevo en marzo. [A] Un dueño de capital privado empuja márgenes sobre crecimiento | Marca de "IA autónoma" |

### 7.6 Seguridad de IA y de agentes
| Empresa | Qué hace | Estado | Dónde pierde dinero | Ventaja única |
|---|---|---|---|---|
| **Protect AI** (EE. UU., hoy de Palo Alto) | Seguridad de modelos y agentes (Prisma AIRS) | Adquirida; precio estimado entre 650 y 700 M [R] | [A] Perdió independencia; el producto se vende dentro de una suite | Plataforma de Palo Alto |
| **Lakera** (Suiza, hoy de Check Point) | Guardrails contra inyección de prompts y fugas | Adquirida por unos 300 M (septiembre de 2025) [R] | [A] Igual que arriba | Comunidad creada con el juego Gandalf |
| **Prompt Security, Aim, CalypsoAI, SlashNext** | Seguridad de IA | Compradas por SentinelOne, Cato, F5 y Varonis [R] | [A] Igual | Compra por plataformas |
| **Noma Security** (Israel y EE. UU.) | Descubre y vigila lo que hacen los agentes y a qué acceden | 132 M levantados, Serie B de 100 M (julio de 2025); valoración de unos 400 M según fuentes anónimas [R] | [A] Sin datos de ingresos | Foco en agentes |
| **HiddenLayer, Straiker, Zenity, Reco** | Seguridad en runtime y gobierno de agentes | Independientes; no revisé finanzas | [A] Ventas largas con empresas grandes | Especialización |

Dato de mercado: se contaron entre 11 y 12 adquisiciones de startups de seguridad de IA por unos 2.780 M [R, un analista]. **Lectura [I]:** para una startup cliente, la oferta de seguridad de IA se está metiendo dentro de suites de empresas grandes; lo que casi nadie hace es pensar en el CEO.

### 7.7 Seguros "activos" (seguro más seguridad)
| Empresa | Propuesta de valor | Cliente ideal | Cómo vende | Dónde pierde dinero | Ventaja única |
|---|---|---|---|---|---|
| **Coalition** (EE. UU.) | Póliza con escaneo continuo, alertas personalizadas y respuesta a incidentes | Pymes y mid-market tecnológicas; hoy también enterprise con Allianz | Corredores y venta directa; pólizas desde unos 1.500 USD/año [R] | [A] Una aseguradora pierde cuando los reclamos superan la prima; su apuesta es prevenir. Afirma 70% menos reclamos que el mercado [P, propio] | Distribución por seguros y datos de reclamos |
| **At-Bay, Cowbell** (EE. UU.) | Póliza más MDR y escaneo (At-Bay); pyme con precio adaptativo (Cowbell) | Empresas con controles documentados; pymes | Corredores | [A] Misma lógica de siniestralidad | Seguro y seguridad en un solo producto |

**Por qué importa [I]:** el que paga el seguro suele ser el CFO. Es un canal de distribución real hacia el cargo que queremos alcanzar.

### 7.8 Guardia con IA (ver también la sección 2.1)
| Empresa | Propuesta de valor | Cliente ideal | Cómo vende | Dónde pierde dinero | Ventaja única |
|---|---|---|---|---|---|
| **Resolve AI** | Agente autónomo de investigación y resolución | Enterprise | Ventas; precio no publicado | [R] Más de 190 M levantados, valoración de 1.500 M. [A] Costo de inferencia por cada investigación | Mayor autonomía |
| **Cleric** | Investigación de solo lectura | Equipos de Kubernetes | Plan gratis y ventas | [R] Ronda semilla. [A] Sin datos | Seguridad por diseño (solo lectura) |
| **incident.io, Rootly** | Gestión de incidentes en Slack con IA | Equipos de ingeniería | Precio por usuario publicado (45 y unos 20 USD/mes) [R] | [R] Unos 100 M levantados (incident.io). [A] Competencia de incumbentes | Flujo de trabajo en Slack |
| **PagerDuty, New Relic, Datadog** | Agentes dentro de su plataforma | Sus clientes actuales | Venta cruzada | [A] Costo de IA absorbido por la plataforma | Datos y base instalada |
| **HolmesGPT** (Robusta) | Agente abierto para investigar incidentes | Equipos de Kubernetes | Gratis (Apache 2.0) | [A] Se monetiza por servicios y la nube de Robusta | Código abierto y neutral |

### 7.9 Latinoamérica
| Empresa | Propuesta de valor | Cliente ideal | Cómo vende | Dónde pierde dinero | Ventaja única |
|---|---|---|---|---|---|
| **Tempest** (Brasil; Embraer) | Servicios gestionados, consultoría y antifraude | Bancos y comercio electrónico | Equipo técnico y ventas directas | [R] Ingresos de unos 100 millones de reales (cerca de 30 M USD) y unos 300 empleados en un dato antiguo; hoy unos 400 empleados y más de 300 clientes. [A] Negocio de servicios: el margen lo limitan las horas de analistas | La mayor firma independiente de Brasil |
| **ISH Tecnologia** (Brasil) | Servicios de ciberseguridad | Empresas medianas y grandes; unos 900 empleados y más de 600 clientes [R] | Ventas directas | [A] Igual que Tempest | Escala local |
| **Axur** (Brasil; Infoblox) | Monitoreo de riesgo digital y protección de marca | Empresas con marca expuesta | Venta enterprise | [R] Había captado solo 2,7 M; Infoblox la compró (anunciada en enero de 2026) | Inteligencia de amenazas regional |
| **Hackmetrix** (México y Chile) | Plataforma de seguridad y cumplimiento para pymes de la región | Pymes que necesitan certificarse | Venta directa y eventos | [R] 1,3 M levantados. [A] Capital escaso para competir con Vanta | En español y pensada para la región |
| **Unxpose** (Brasil) | Herramientas con IA para que las startups automaticen buenas prácticas sin presupuesto enterprise | Startups | Autoservicio [I] | [A] Sin datos | Nacida de ex-Tempest, foco en startups |
| **Delta Protect** (México), **NESS** (Colombia) | Seguridad y cumplimiento; monitoreo de infraestructura | Empresas de la región | No revisado | [A] Sin datos | Parte de la cohorte de Google for Startups 2025 (11 startups de Brasil, Chile, Colombia y México) |

Contexto, con baja confianza: un estudio dice que el 68% de las empresas de la región sufrió un ataque en 2025 [1F], y un informe de mercado estima el sector en unos 23.500 M USD en 2025 [R].

**Vacío en la región [I]:** casi no hay una plataforma para startups, en español, con precio bajo y que hable con el CEO.

### 7.10 Asia
| Empresa | Propuesta de valor | Cliente ideal | Cómo vende | Dónde pierde dinero | Ventaja única |
|---|---|---|---|---|---|
| **CloudSEK** (Singapur e India) | Inteligencia de amenazas y riesgo digital | Empresas del sudeste asiático e India | Venta directa | [R] Unos 19 M levantados según un titular. [A] Sin datos de ingresos | Inteligencia de amenazas |
| **Indusface** (India) | Ver 7.3 | | | | |
| **Sprinto** (India) | Ver 7.1 | | | | |
| **Trend Micro, AhnLab, Quick Heal** | Ver 7.4 y 7.5 | | | | |

---

## 8. Tabla única comparativa, aplicada a startups
Escenario: startup de unas 10 personas, 5 a 10 devs, en cualquier rama que use el stack habitual (web o móvil, Node o Python, a veces PHP o WordPress, Postgres o Supabase, nube o Vercel, GitHub). Las columnas de capacidad son mi evaluación **[I]** a partir de documentación pública.

| Opción | Qué resuelve | Entrada aproximada (USD/año) | Aviso de fallo global que llega a "mi stack" | Arreglo y verificación | Usable por CEO o CFO sin técnico | Voz o lenguaje natural | Veredicto para startups |
|---|---|---|---|---|---|---|---|
| **Cloudflare** (WAF y programa de startups) | Bloqueo en el borde | 0 (WAF gratis); créditos de 5 mil a 250 mil | Parcial (reglas administradas, sin mapa a tu stack) | No (bloquea, no parchea) | Medio | No | Base gratuita obligatoria |
| **Aikido** | Código, nube y contenedores | 0 (2 usuarios); unos 3.600 a 4.200 (10 usuarios) | Parcial | Parcial (triaje y sugerencias) | Medio | No | El mejor ajuste hoy para startups técnicas |
| **Snyk** | Código y dependencias | Unos 1.500 (5 devs, Team) | Parcial | Parcial (propone arreglos) | Bajo | No | Fuerte para devs; caro al escalar |
| **Socket** | Paquetes maliciosos | Unos 1.200 (10 devs, estimado) | Parcial (paquetes, no el motor PHP) | Bloquea instalación | Bajo | Parcial (MCP) | Complemento clave en la era de agentes |
| **GitGuardian** | Secretos | Gratis; pago sin dato | Parcial | Parcial | Bajo | No | Complemento |
| **Intruder** | Exposición externa | Unos 1.800 (Essential) | Parcial | No | Medio | No | Barato y claro |
| **Detectify** | Aplicaciones web | Unos 1.100 en adelante | Parcial | No | Medio | No | Alternativa a Intruder |
| **Vanta, Drata, Secureframe, Sprinto** | Cumplimiento y certificados | De 4 mil a 12 mil o más | No (controlan evidencia, no avisan de un CVE) | No | Alto (paneles para auditoría) | No | Se compra por ventas B2B, no por seguridad |
| **Coro** | Endpoint y correo | Unos 1.100 (10 usuarios) | No | No | Medio | No | Pyme tradicional |
| **Huntress** (por MSP) | Seguridad gestionada | Sin dato | No | Parcial | Medio | No | Pensado para pymes con MSP |
| **Arctic Wolf** | SOC gestionado | Unos 40 mil (mediana ≤100 usuarios, confianza baja) | No | Parcial | Medio | No | Fuera del presupuesto de una startup |
| **Coalition** (seguro más escaneo) | Riesgo financiero y alertas | Desde unos 1.500 | Sí (alertas personalizadas) | No (guía) | Alto (lo compra el CFO) | Parcial (evaluación conversacional) | Cierra el riesgo, no el parche |
| **HolmesGPT** | Investigar incidentes | 0 más costo del LLM | No | Parcial (puede abrir PR con GitHub) | Bajo | Parcial (preguntas en lenguaje natural) | Útil, pero solo para técnicos |
| **Resolve AI, Cleric** | Guardia con IA | Cotización | No | Parcial | Bajo | No | Para equipos de infraestructura |
| **Wiz** | Seguridad de nube | Enterprise | Sí | Parcial | Bajo | No | No es para startups pequeñas |
| **Nuestro concepto** (objetivo, aún no existe) | Aviso, mapeo, arreglo, verificación y voz | A definir [A] | Sí | Sí (PR con aprobación y verificación) | Alto | Sí | Hueco a ocupar |

**Lectura [I]:** nadie reúne las cuatro cosas a la vez (aviso que llega a mi stack, arreglo verificado, lenguaje ejecutivo y voz). Lo más cercano en cada eje: Coalition (alerta y lenguaje de negocio), Aikido (arreglo para devs), Socket y HolmesGPT (algo de lenguaje natural).

---

## 9. Cómo se vende hoy y por dónde podríamos llegar a CEO, CFO y COO
| Modelo | Quiénes lo usan | Lección para nosotros [I] |
|---|---|---|
| Autoservicio y gratis, el dev instala solo | Snyk, Socket, Aikido, Intruder | Sirve para llegar al CTO, no al CEO |
| Ventas con demo y cotización | Vanta, Drata, Resolve AI | Funciona cuando hay un dolor de negocio (un certificado para cerrar una venta) |
| Canal de proveedores de TI | Huntress, Arctic Wolf, Hornetsecurity | Funciona en pymes sin equipo de TI; lento y con margen compartido |
| Seguro y seguridad juntos | Coalition, At-Bay, Cowbell | Llega al CFO; vale la pena explorar una alianza |
| Programas de nube y aceleradoras | Cloudflare, Vercel | Distribución barata hacia startups; Platanus puede ser el primer canal |

Hipótesis de embudo **[A]**: (1) chequeo gratis de exposición solo con información declarada, (2) monitoreo continuo con avisos por voz, (3) acciones con aprobación. Hay que validarla con entrevistas, no está probada.

---

## 10. Repositorio de fallos globales (la base que retroalimenta al sistema)
**Idea:** una base propia que se actualiza sola con lo que pasa en el mundo y se cruza con lo que cada cliente conecta. Esto es lo que permite pasar de "salió PHP2Shell" a "esto afecta a tu servicio X".

### 10.1 Fuentes que encontré
| Fuente | Qué aporta | Acceso y límites |
|---|---|---|
| **OSV.dev** (Google) | Vulnerabilidades por paquete y versión en npm, PyPI, Go, Maven, crates, RubyGems, NuGet y más; incluye avisos de GitHub | API gratuita sin llave |
| **GitHub Advisory Database** | Avisos revisados por GitHub | Licencia CC BY 4.0 |
| **CISA KEV** | Lista de lo que ya se explota en la vida real | Archivo JSON público |
| **FIRST EPSS** | Probabilidad de explotación en 30 días | API gratuita; hay que citar según sus términos |
| **NVD (NIST)** | Detalle y puntaje de cada CVE | Límite de 5 consultas por 30 segundos (50 con llave gratuita). **Ojo:** desde el 15 de abril de 2026 NIST dejó de enriquecer la mayoría de los CVE nuevos, según una sola fuente [1F]; no depender de su puntaje |
| **Programa CVE (MITRE)** | Numeración de los CVE | Su contrato federal se prorrogó hasta marzo de 2026 y no verifiqué qué pasó después |
| **Alternativas** | Base europea de vulnerabilidades (ENISA), GCVE (iniciativa europea), bases de Japón y China | Útiles como respaldo si falla la fuente de EE. UU. |
| **Avisos de proveedores** | PHP, Drupal, Cloudflare, Wiz, etc. | Aquí aparecen primero los fallos de motores y runtimes. Es probable que OSV no cubra el PHP del sistema operativo, así que habría que usar rastreadores de distribuciones y avisos del proveedor **[I, por verificar]** |
| **Incidentes de agentes y MCP** | OWASP Top 10 de aplicaciones agénticas (diciembre de 2025: secuestro de objetivo, mal uso de herramientas, identidad, cadena de suministro, ejecución de código, memoria, comunicación entre agentes, fallos en cascada, confianza humano-agente y agentes rebeldes) y bases públicas de incidentes MCP | Marco de referencia para clasificar |

### 10.2 Diseño mínimo [I]
1. **Ingesta:** cada fuente se normaliza a un registro común (identificador, componente afectado, versiones, fecha, señal de explotación, enlace al aviso).
2. **Inventario del cliente:** de lockfiles, Dockerfiles o un SBOM se saca "qué corre y en qué versión".
3. **Cruce y prioridad:** exposición confirmada, más "se explota hoy" (KEV), más EPSS, más criticidad del servicio para el negocio.
4. **Acción:** tarjeta ejecutiva (qué pasó, a quién afecta, qué decidir, cuánto tarda), PR con el arreglo y verificación.
5. **Aprendizaje:** qué arreglos funcionaron, cuánto tardaron y qué falsos positivos hubo. Con consentimiento, y anonimizado, esto alimenta a los demás clientes.

Dos advertencias: los textos de los avisos son datos de terceros y pueden contener instrucciones maliciosas para un agente (ya hubo ataques de inyección de prompts por issues de GitHub), así que se tratan como no confiables. Y la base de datos propia hay que construirla pensando en que sus fuentes pueden fallar o retrasarse.

---

## 11. ¿Qué tanto conectar? Privacidad y seguridad de nuestro propio servicio
**Principio:** conectar lo mínimo para entregar valor, y subir de nivel solo con permiso explícito. Un producto de seguridad con acceso excesivo es el mejor blanco.

### 11.1 Niveles de conexión propuestos [I]
| Nivel | Qué se conecta | Permiso concreto | Qué no se toca | Cuándo usarlo |
|---|---|---|---|---|
| **0. Declarativo** | Nada: el cliente declara su stack o sube un SBOM | Ninguno | Todo | Chequeo gratis; el CEO puede hacerlo solo |
| **1. Manifiestos** | Repos elegidos | GitHub App con Metadata en lectura y Contents en lectura, solo en repos seleccionados. **Ojo:** Contents en lectura expone todo el código; mitigar leyendo solo manifiestos en un proceso efímero, o mejor aún con una acción de CI del cliente que genere el SBOM y suba solo ese resumen | Código fuente completo, secretos | Monitoreo continuo base |
| **2. Superficie externa** | Dominios que el cliente verifica como suyos (registro DNS) | Sondeos externos no intrusivos | Nunca explotar; nunca escanear lo que no sea del cliente | Avisos de exposición |
| **3. Salud interna en lectura** | Métricas y logs agregados | Rol de solo lectura sobre vistas de metadatos | Contenido de usuarios y datos de negocio | Monitoreo de las 4 a. m. |
| **4. Acción con aprobación** | Pull requests | Pull requests y Contents en escritura solo para ramas propuestas | Nunca merge a la rama principal ni despliegue automático | Plan de pago, con aprobación humana |
| **5. Nunca** | Credenciales de producción, contenido de bases de datos, llaves de pago, acceso root | | | Nunca |

Regla de oro: **sin aprobación humana no hay escritura**, y la aprobación por voz sola es débil (las voces se pueden clonar), así que para acciones de escritura se pide además un segundo factor (código o confirmación en la app) **[I]**.

### 11.2 A quién le llegan los datos
| Pieza | Qué dicen las fuentes | Qué hacer |
|---|---|---|
| **API de Claude** | Los términos comerciales prohíben entrenar con contenido de clientes; retención estándar de unos 30 días; retención cero por acuerdo con aprobación previa y con funciones excluidas. Una fuente de terceros dice que los modelos más nuevos exigen 30 días de retención y quedan fuera de retención cero **[1F, verificar con Anthropic]** | Enviar solo datos mínimos, enmascarar secretos antes de llamar al modelo y guardar la elección de modelo por cliente |
| **OpenRouter** | Es un intermediario: añade otra capa con sus propias políticas | Revisar políticas por proveedor antes de usarlo con datos de clientes **[I]** |
| **ElevenLabs** | Retención por defecto de 2 años, configurable; existe modo de retención cero por agente (la documentación lo lista como función de enterprise, confirmar el plan); los resultados de las llamadas se recuperan por webhook | Apagar la grabación de audio, acortar retención y no decir datos sensibles en voz |
| **GitHub** | Permisos finos por repositorio y por app | Una app por cliente, tokens de corta duración, revisión periódica |

### 11.3 Controles mínimos de nuestro lado
- Aislamiento por cliente (cada cliente ve solo lo suyo) y cifrado de los inventarios.
- Registro de cada acción del agente y botón de corte inmediato (por voz y en pantalla).
- Tratar como no confiable todo texto que viene de avisos, issues o páginas.
- Usar el OWASP Top 10 agéntico como lista de chequeo propia.
- Para el hackathon: solo entorno de demostración y datos sintéticos; ningún dato real de clientes.
- No soy abogado: escanear dominios de terceros sin autorización puede ser ilegal; por eso el nivel 2 exige verificar la propiedad.

---

## 12. Qué cambia respecto a la Parte I
1. **La recomendación se mantiene** (Idea A: aviso, mapeo, arreglo, verificación y voz), pero ahora tiene un posicionamiento claro: **capa de decisión y acción para el ejecutivo, que se apoya en lo que ya existe** (Cloudflare, Aikido, Socket, escáneres abiertos) en lugar de reemplazarlo.
2. **El diferencial real** no es detectar mejor que Wiz o Aikido, sino cerrar el circuito para alguien que no es técnico: avisar a tiempo, explicar el impacto, pedir una decisión y comprobar que quedó resuelto.
3. **Precio de referencia a vencer** para una startup: entre gratis (Cloudflare) y unos 4 mil USD/año (Aikido Basic o un cumplimiento básico). Un precio por encima de eso necesita un argumento financiero claro (por ejemplo, la prima del seguro).
4. **Riesgos nuevos:** la compra de startups de seguridad de IA por parte de grandes puede aplastar a un proyecto nuevo; y el costo de inferencia por investigación puede comerse el margen **[A]**.

**Preguntas para el equipo:**
1. ¿Mercado inicial: LatAm en español o global? Cambia canales, precio y competidores.
2. ¿Qué nivel de conexión aceptamos en la primera versión (hasta el nivel 1 o 2 para la demo)?
3. ¿Entrevistamos a 5 CEO o CFO de startups para validar que el embudo (sección 9) y el precio (punto 3) tienen sentido? Esto es lo que más reduce el riesgo.

**Lo que no verifiqué:** precios de pago de GitGuardian y Huntress, finanzas de Trend Micro y AhnLab, qué pasó con el contrato del programa CVE después de marzo de 2026, si OSV cubre el PHP del sistema operativo, y los términos exactos de retención de modelos nuevos de Anthropic.

---

## Fuentes de la Parte II
- [Vanta, ARR estimado (Sacra)](https://sacra.com/research/vanta-at-300m-year/)
- [YipitData: Vanta frente a Drata](https://www.yipitdata.com/resources/vanta-vs-drata-compliance-software-2026)
- [Comparador de precios de cumplimiento (Cipherssecurity)](https://cipherssecurity.com/?p=15597)
- [Alternativas a Vanta (Strac)](https://www.strac.io/blog/vanta-alternatives)
- [Drata: gobierno de agentes de IA](https://securitybrief.co.uk/story/drata-launches-ai-agent-governance-for-enterprises)
- [Drata compra SafeBase (Dark Reading)](https://www.darkreading.com/cyber-risk/drata-acquires-safebase-strengthen-grc-portfolio)
- [Snyk: ARR (Sacra)](https://sacra.com/c/snyk/)
- [Snyk: despidos (Tech.eu)](https://tech.eu/2026/10/01/snyk-laid-off-over-200-employees-revenues-top-300m/)
- [Snyk: precios](https://cipherssecurity.com/snyk-pricing-explained-2026/)
- [Socket: Serie C](https://socket.dev/blog/series-c)
- [Socket: análisis humano (GovInfoSecurity)](https://www.govinfosecurity.com/socket-raises-60m-for-wider-software-supply-chain-defense-a-31785)
- [Aikido: Serie B (Sifted)](https://www.sifted.eu/articles/aikido-security-hits-unicorn-valuation-with-60m-series-b-raise/)
- [GitGuardian: Serie C](https://www.cbinsights.com/company/gitguardian/financials)
- [Chainguard: financiamiento (Crunchbase News)](https://news.crunchbase.com/?p=91546)
- [Semgrep: financiamiento](https://stockanalysis.com/private/semgrep/)
- [Intruder: planes](https://external.pi.gpi.aws.gartner.com/reviews/product/intruder-297105307)
- [Alternativas a Intruder, precios (TheGuideX)](https://theguidex.com/resources/best-intruder-alternatives.md)
- [Detectify: precios](https://www.spendflo.com/vendors/detectify)
- [Huntress: ARR (StockAnalysis)](https://stockanalysis.com/private/huntress/)
- [Huntress: iniciación (MVP.vc)](https://mvp.vc/company-initations/huntress-a-premier-go-to-cybersecurity-platform-for-smbs)
- [Arctic Wolf: precios (UnderDefense)](https://underdefense.com/blog/arctic-wolf-pricing-guide)
- [Coro frente a Arctic Wolf (G2)](https://www.g2.com/compare/arctic-wolf-vs-coro-cybersecurity)
- [Proofpoint cierra la compra de Hornetsecurity](https://www.proofpoint.com/node/144802)
- [Quick Heal: resultados del año fiscal 2026](https://cxotoday.com/media-coverage/quick-heal-technologies-limited-reports-q4-fy26-results/)
- [Google cierra la compra de Wiz](https://nationalcioreview.com/articles-insights/extra-bytes/google-finalizes-32b-acquisition-of-wiz-to-strengthen-cloud-and-ai-security/)
- [CrowdStrike: resultados del año fiscal 2026](https://www.sec.gov/Archives/edgar/data/1535527/000153552726000007/crwd-20260303xex991.htm)
- [CrowdStrike: primer trimestre del año fiscal 2026](https://www.businesswire.com/news/home/20250603580778/en/CrowdStrike-Reports-First-Quarter-Fiscal-Year-2026-Financial-Results)
- [SentinelOne: año fiscal 2026](https://www.businesswire.com/news/home/20260312383715/en/)
- [SentinelOne: cuarto trimestre](https://www.sec.gov/Archives/edgar/data/1583708/000158370826000014/sentineloneq426exhibit991.htm)
- [Trend Micro: resultados del segundo trimestre de 2026](https://newsroom.trendmicro.com/2026-08-13-Trend-Micro-Reports-Earnings-Results-for-Q2-2026)
- [AhnLab y Frost & Sullivan](https://www.digitaltoday.co.kr/en/view/89256/ahnlab-named-frost-sullivan-asia-pacific-endpoint-security-competitive-strategy-leadership)
- [Darktrace](https://en.wikipedia.org/wiki/Darktrace)
- [Compras de startups de seguridad de IA (Lakera, Protect AI)](https://tech-insider.org/lakera-vs-prisma-airs-vs-cisco-ai-defense-2026/)
- [Lakera, compra por Check Point (VentureLab)](https://www.venturelab.swiss/Lakera-acquired-by-Checkpoint-in-USD-300-million-deal)
- [Compras de IA en seguridad (CyberScoop)](https://cyberscoop.com/?p=85993)
- [Panorama de compras (Stiennon)](https://stiennon.substack.com/p/state-of-ai-security)
- [Noma Security: finanzas](https://www.cbinsights.com/company/noma-security/financials)
- [Coalition: seguro activo](https://www.coalitioninc.com/blog/cyber-insurance/active-insurance-protection-reduces-risks)
- [Seguro cibernético para pymes (QuoteSweep)](https://www.quotesweep.com/blog/best-cyber-insurance-small-business)
- [At-Bay (QuoteSweep)](https://www.quotesweep.com/insurtech/at-bay)
- [Startups de IA para ciberseguridad en Latinoamérica (Google)](https://blog.google/company-news/outreach-and-initiatives/entrepreneurs/google-for-startups-ai-for-cybersecurity-cohort/)
- [Hackmetrix levanta 1,3 M](https://ecosistemastartup.com/hackmetrix-levanta-us13m-para-expandir-ciberseguridad-con-ia-en-latam/)
- [Mejores MSSP de Brasil (SOCRadar)](https://socradar.io/blog/top-mssps-in-brazil/)
- [Axur: perfil](https://www.cbinsights.com/company/axur)
- [Tempest: ingresos](https://www.cbinsights.com/company/ez-security)
- [Startups de seguridad de India (Analytics Insight)](https://www.analyticsinsight.net/cybersecurity/top-10-security-service-startups-in-india-for-businesses-in-2026)
- [CloudSEK: financiamiento](https://inc42.com/buzz/cybersecurity-startup-cloudsek-bags-19-mn-from-massmutual-ventures-others/)
- [Kaspersky: malware con tema de IA contra pymes del Sudeste Asiático](https://vietnamnews.vn/advertisement/1796496/kaspersky-reports-sharp-rise-in-ai-themed-malware-attacks-on-sea-smbs.html)
- [Sekoia.io: Serie B](https://seedtable.com/companies/sekoiaio/funding-rounds/series-b-2025-04)
- [Cloudflare para startups: comparación (Better Stack)](https://betterstack.com/community/comparisons/cloudflare-vs-vercel-startups/)
- [Programa de startups de Cloudflare: niveles](https://blog.cloudflare.com/expanding-cloudflares-startup-program)
- [Cloudflare y PHP2Shell](https://ppc.land/cloudflare-blocks-php2shell-exploits-9-hours-before-php-flaws-went-public/)
- [NVD: cambio de enriquecimiento](https://www.gblock.app/articles/nist-nvd-cve-enrichment-policy-change)
- [Programa CVE: financiamiento (SecurityWeek)](https://www.securityweek.com/mitre-cve-program-gets-last-hour-funding-reprieve/)
- [Alternativas al CVE (ITPro)](https://www.itpro.com/security/the-cve-system-isnt-working-what-next)
- [APIs gratuitas de vulnerabilidades (DEV)](https://dev.to/0012303/8-free-cve-vulnerability-apis-with-no-key-2026-57b9)
- [OWASP Top 10 de aplicaciones agénticas](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026)
- [OWASP agéntico, análisis (Cycode)](https://cycode.com/blog/owasp-top-10-agentic-applications/)
- [Incidentes MCP (PolicyLayer)](https://policylayer.com/mcp-incidents)
- [Anthropic: retención de datos de la API](https://platform.claude.com/docs/build-with-claude/api-and-data-retention)
- [Claude API: retención y términos comerciales (guía de terceros)](https://www.getvoibe.com/resources/claude-api-data-retention/)
- [Retención cero y OpenRouter (Captain Compliance)](https://captaincompliance.com/education/what-is-zero-data-retention-zdr-explained/)
- [ElevenLabs: retención](https://elevenlabs.io/docs/eleven-agents/customization/privacy/retention)
- [ElevenLabs: modo de retención cero](https://elevenlabs.io/docs/eleven-agents/customization/privacy/zrm)
- [Permisos mínimos de GitHub para agentes](https://docs.qoder.com/cloud-agents/github-repositories.md)
- [Permisos de GitHub Apps y mínimo privilegio](https://www.c-sharpcorner.com/article/github-updates-github-app-permissions-for-least-privilege-access)
# Parte III. Conexión a Claude, integraciones y licencias
**Platanus Hack 26 Caracas, team-22. Investigación al 23 de octubre de 2026.**

> Esta parte complementa el benchmark (Partes I y II). Tiene dos frentes: el Frente 1 explica cómo conectar el producto a Claude para que un CEO pregunte en lenguaje natural. El Frente 2 explica cómo conectar las herramientas del cliente con permisos mínimos. Precios y políticas consultados el 23 oct 2026. Casi todo está marcado [1F] (una sola fuente oficial) o [I] (inferencia); revisar lo "no verificado" antes del pitch.

---

# Frente 1: Conexión del producto a Claude vía MCP/API (team-22, Platanus Hack 26 Caracas, AI Security)
Fecha: 23 oct 2026. Etiquetas: [V] 2+ fuentes, [1F] una fuente, [I] inferencia. Fuentes numeradas al final [S#].

## 0. Resumen ejecutivo
- MVP: construir UNA capa de herramientas (lógica en Next.js/Supabase) y exponerla de dos maneras: (1) un endpoint MCP remoto de solo lectura (para demo en claude.ai/Desktop/Code) y (2) la misma lógica como tools del Claude API (tool use propio en la app web del CEO) y como server tools/MCP para ElevenLabs Agents (voz). Evitar tres implementaciones distintas: una sola fuente de verdad (funciones de dominio), tres adaptadores.
- Recomendación MVP: app propia con Claude API + tool use (control total, sin depender de plan del cliente) + ElevenLabs Agent con tools webhook/MCP; MCP remoto como "bonus de demo" porque impresiona al jurado (el CEO ya usa Claude). Producción: MCP remoto con OAuth multi-tenant + app propia; OpenRouter solo como fallback/multi-modelo.
- Alertas de diseño: el MCP connector de la API NO es elegible para ZDR [S3]; ElevenLabs MCP no está disponible con Zero Retention Mode [S6]; ElevenLabs retiene 2 años por defecto [S9]. Esto condiciona qué datos sensibles se envían.
- PHP2Shell parece real (varios medios: BleepingComputer, Dark Reading, TechTarget, SentinelOne) [1F por buscador; no pude abrir el artículo, verificar CVE/fechas antes del pitch].

## 1. Opciones de conexión

### (a) Servidor MCP remoto propio, usable desde Claude (claude.ai, Desktop, Code)
- Qué es: endpoint HTTPS público (Streamable HTTP o SSE) que expone tools. Anthropic documenta conectores personalizados vía MCP remoto [S2].
- Plan/licencia: custom connectors disponibles en Free, Pro, Max, Team y Enterprise; Free limitado a 1 conector; en Team solo Owners/Primary Owners los añaden, luego cada miembro se conecta; Enterprise: Owners o rol con permiso "Manage access to Libraries" [S2][1F]. Precios: Pro $17-20/mes, Max desde $100, Team $20 o $100/seat/mes (anual; mínimo 2 seats), Enterprise mínimo 20 seats [S12][1F] (la página de pricing lista conectores en todos los planes).
- Requisitos/límites: servidor accesible desde internet público desde IPs de Anthropic; las conexiones salen de la nube de Anthropic, no del dispositivo (por tanto no sirve localhost ni VPN sin allowlist) [S2][1F]. Auth: OAuth, credencial fija en header, o ninguna [S2]. Transportes y URL de callback: la página que obtuve no los especifica; no pude abrir el artículo 11503834 (error). [I] La práctica común es Streamable HTTP y callback de claude.ai; confirmar en el artículo antes de integrar.
- Pros: el CEO usa su propio Claude (UI, voz móvil de Claude, historial, razonamiento); cero frontend; funciona en Claude Code para el CTO. Contras: depende de que el cliente tenga plan y admin; los datos pasan por Anthropic bajo los términos del plan del cliente (planes consumer/Team tienen retención y entrenamiento distintos a la API; verificar por plan); el MCP solo da texto, sin control de UI de aprobación humana propia (la aprobación depende del cliente); conectar para escritura es riesgoso.
- Uso recomendado: SOLO LECTURA + "preparar propuesta" (nunca ejecutar merge/despliegue desde aquí).

### (b) Claude API con tool use y/o MCP connector
- Tool use propio (función definida por ti, ejecutas en tu backend): máximo control; bucle agente en Next.js route handler/Vercel. [I]
- MCP connector de la API: beta, header actual `mcp-client-2025-11-20`; existe `mcp-client-2026-09-15` con fijado (pinning) de la lista de tools para evitar rug pulls; el antiguo 2025-04-04 está deprecado. Solo tools (no resources/prompts), solo remoto HTTP (Streamable HTTP o SSE), URL https. Parámetros: `mcp_servers[{type:"url",url,name,authorization_token}]` y `tools:[{type:"mcp_toolset", mcp_server_name, default_config, configs}]` con allowlist/denylist por tool [S3][1F].
- Limitación clave: tú gestionas OAuth y refresco del token (el conector solo acepta Bearer) [S3]. NO es elegible para ZDR [S3] (Anthropic lo lista junto a Files API, Batch, Code execution).
- Retención API: por defecto Anthropic borra inputs/outputs en 30 días desde la recepción (artículo fechado 1 jul 2026); mensajes marcados por seguridad hasta 2 años y scores 7 años [S4][1F]; la página de data retention de la plataforma dice que por defecto el contenido no se retiene salvo "Covered Models" (30 días) y modos específicos [S3]. Las dos páginas no coinciden del todo: [I] tratar como "hasta 30 días" y pedir confirmación contractual/ZDR si hay clientes regulados. Los términos comerciales dicen que Anthropic "may not train models on Customer Content from Services" [S5][1F].
- ZDR: se pide a ventas, por organización [S3]. Para el hackathon no hace falta.
- Pros: control de modelo, system prompt, caché, allowlist de tools, aprobación propia. Contras: pagas tokens; tu código maneja bucle y seguridad.
- Nota modelos: la doc muestra ids tipo `claude-opus-5-5`; verificar el id vigente en la consola antes de codificar. [I]

### (c) Vía OpenRouter
- Qué es: gateway multi-modelo con API compatible; usa créditos que ya tienen el equipo.
- Privacidad: cada proveedor tiene su política; en ajustes de cuenta se elige si se permite enrutar a proveedores que entrenan con datos; se puede restringir por petición y poner `"zdr": true` para enrutar solo a endpoints con retención cero; si OpenRouter no puede confirmar la política de un endpoint, asume que retiene y entrena [S7][S8]. OpenRouter dice que no retiene prompts salvo que actives el logging [S7][1F]. No pude verificar retención de metadatos [S8].
- Para MCP: OpenRouter no sustituye al MCP connector de Anthropic. [I] Debes ejecutar tú el bucle de tools (tu cliente MCP o tus funciones) y pasar el resultado al modelo. Hay que verificar la compatibilidad de tool calling por modelo.
- Pros: créditos disponibles, fallback entre modelos, ZDR por petición. Contras: un salto más con datos, tool use menos uniforme, features beta de Anthropic (connector, caching avanzado) pueden no estar disponibles. [I]
- Uso: fallback y pruebas baratas (modelos pequeños para clasificación/resumen), no para el camino crítico de datos sensibles sin `zdr:true`.

### (d) ElevenLabs Agents con MCP / herramientas propias (voz)
- MCP: soporta servidores SSE y HTTP streamable; apagado por defecto; un miembro acepta los "MCP Server Terms" para todo el workspace; se añade en el dashboard (URL, token secreto, headers) y se adjunta al agente; modos de aprobación: Always Ask (recomendado), Fine-Grained (auto/requiere aprobación/deshabilitado por tool), No Approval; NO disponible con Zero Retention Mode ni HIPAA; la responsabilidad de asegurar el servidor es del cliente [S6][V: dos páginas coincidentes, ambas de ElevenLabs].
- Agentes: autenticación por signed URL (expira a los 15 min; no identifica usuarios, hay que autenticar antes) o allowlist de hasta 10 hosts, uno de los dos por agente [S10][1F].
- Retención: por defecto 2 años de transcripción y audio; configurable (días, -1 ilimitado, 0 borrado programado), por separado transcripción y audio [S9][1F].
- Precios agentes: Free 15 min/4 concurrentes; Starter 75 min; Creator 275; Pro $99/1.238 min/20 conc.; Scale $299/3.738/30; Business $990/12.375/40; sobreuso aprox. $0,08/min; el costo del LLM se factura aparte; telefonía a costo vía proveedor externo [S11][1F, lectura parcial]. Llamadas salientes: la página no las menciona; verificar plan, número y proveedor (Twilio/SIP) antes de prometer "te llamamos".
- Pros: voz natural, MCP de solo lectura reutiliza el mismo servidor de (a). Contras: latencia por tool, retención de 2 años por defecto, riesgo de que la voz ejecute acciones sin aprobación.
- Recomendación: tools de SOLO LECTURA vía MCP/webhook con "Always Ask" o Fine-Grained; las acciones (crear PR, merge) NO se ejecutan por voz: la voz solo "solicita" y la aprobación ocurre en la app con login + segundo factor.

### Matriz de recomendación
| Fase | Cerebro | Superficie CEO | Voz | Escritura |
|---|---|---|---|---|
| MVP hackathon | Claude API tool use propio (créditos OpenRouter como respaldo con zdr) | Chat web Next.js + MCP remoto read-only para demo en Claude | ElevenLabs Agent + 3-4 tools read-only (webhook o MCP) | Solo "proponer PR" -> aprobación en la app |
| Producción | Claude API (ZDR/retención ajustada por cliente) | MCP remoto OAuth multi-tenant + app | ElevenLabs con retención corta y tools por rol | PR con aprobación humana, 2FA, auditoría |

## 2. Autenticación y autorización
Base normativa (spec MCP draft, página de autorización) [S1][1F]:
- El MCP remoto es un OAuth 2.1 resource server; DEBE implementar Protected Resource Metadata (RFC 9728); los clientes DEBEN usar `resource` (RFC 8707) en autorización y token; PKCE; el servidor DEBE validar que el token fue emitido para él (audience) y NO aceptar/pasar otros tokens; tokens solo en header Authorization, nunca en query; registro de cliente: Client ID Metadata Documents (SHOULD), DCR (deprecado, compatibilidad), preregistro; se recomienda `iss` (RFC 9207); respuestas 401/403 con `WWW-Authenticate` y `scope`; step-up de scopes ante `insufficient_scope`.
- Implementación para hackathon [I]: no escribir un servidor OAuth desde cero. Usar Supabase Auth como IdP (Supabase soporta OAuth 2.1 server según docs recientes; verificar) o un IdP gestionado (Clerk/WorkOS/Auth0) y que el MCP valide JWT (aud = URL del MCP, tenant_id y rol en claims). Si falta tiempo: bearer token fijo por tenant (permitido en conectores personalizados [S2]) SOLO para demo, nunca producción.
- Roles y scopes (mínimo privilegio, progresivo [S1][S13]):
  - `viewer` (CEO/CFO/COO): scopes `risk:read`, `inventory:read`, `findings:read`, `report:generate`. Sin acceso a código, secretos, logs crudos ni a escritura.
  - `engineer` (CTO): + `logs:read_redacted`, `pr:propose`.
  - `approver` (CTO/owner): + `pr:approve`, solo en la app (no en el MCP), con segundo factor.
  - `admin`: gestión de conectores/tenants.
  - Aplicar el rol del TOKEN, no lo que dice el modelo. Autorización por tool en servidor + RLS de Supabase por `tenant_id` (el servicio nunca usa `service_role` con datos del cliente sin filtro; ver incidente Supabase/Cursor abajo).
- Multi-tenant [I]: `tenant_id` derivado del token verificado, nunca de un argumento del tool; handles (finding_id, scan_id) son aleatorios y se verifican contra el tenant (la spec lo exige: "state handle hijacking") [S13].
- Aprobación humana para acciones: patrón proponer -> aprobar. El tool `propose_fix_pr` solo crea un borrador/PR en rama protegida; el merge lo hace una persona con rol approver en la app; en la API usar denylist/allowlist del toolset para que el conector nunca vea tools de escritura en sesiones de CEO [S3]. En ElevenLabs usar "Fine-Grained" para que cualquier tool que no sea de lectura requiera aprobación o esté deshabilitada [S6].
- Segundo factor para voz [I]: la llamada saliente al número registrado + código de un solo uso enviado a la app/WhatsApp o pasarela, o passkey/TOTP en la app para cualquier "aprobar". La voz NO es autenticación (clonación de voz). ElevenLabs aclara que signed URLs no identifican usuarios [S10]. Para llamadas salientes de alerta: la persona confirma identidad con PIN/OTP antes de que el agente revele detalles; sin OTP solo dice "hay una alerta crítica, abre la app".
- Auditoría: registrar cada tool call (quién, rol, args, resultado, hash), incluyendo escalaciones de scope con correlation id [S13].

## 3. Riesgos de seguridad MCP/agentes y controles
Marco: OWASP Top 10 for Agentic Applications 2026 (publicado 9 dic 2025): ASI01 Agent Goal Hijack, ASI02 Tool Misuse, ASI03 Identity & Privilege Abuse, ASI04 Supply Chain, ASI05 Unexpected Code Execution, ASI06 Memory & Context Poisoning, ASI07 Insecure Inter-Agent Comms, ASI08 Cascading Failures, ASI09 Human-Agent Trust Exploitation, ASI10 Rogue Agents [S14][1F por lista completa, fecha de publicación según la propia página; verificar en genai.owasp.org].

Incidentes reales (UpGuard recopilación [S15][1F]; datos que ya conocía coinciden con la cobertura pública):
- GitHub MCP (mayo 2025, Invariant Labs): una issue maliciosa en repo público hizo que el agente filtrase repos privados. Lección: datos no confiables + datos privados + canal de salida.
- Supabase + Cursor (jul 2025): ticket de soporte con instrucciones; el agente con `service_role` leyó tabla de tokens y la publicó en el ticket. Lección directa para nosotros (Supabase + logs).
- CVE-2025-6514 mcp-remote (jul 2025, CVSS 9.6): URL de autorización maliciosa -> RCE en cliente. La spec ahora exige validar esquemas de URL [S13].
- Postmark MCP falso en npm (sep 2025): BCC oculto de todos los correos.
- SmartLoader / MCP de Oura clonado (feb 2026): infostealer vía registro de MCP.
- Amazon Q VS Code (2025): prompt destructivo vía PR.
- Tool poisoning, rug pull, shadowing (Invariant Labs, 1 abr 2025) [S16][1F].

Controles concretos para el producto:
1. Prompt injection por logs/datos (ASI01, ASI06): todo texto proveniente de logs, advisories, nombres de repos, mensajes de commit, issues es "dato no confiable". Envolverlo en delimitadores (`<untrusted_data>`), instruir al modelo a no obedecerlo, truncar y quitar HTML/markdown con enlaces/imágenes (vector de exfiltración por render), y NO dejar que el modelo emita URLs arbitrarias en la UI. El modelo que lee datos crudos no debe tener tools de escritura ni de red (patrón "lethal trifecta": datos privados + contenido no confiable + comunicación externa; romper al menos una pata). [I, basado en los incidentes]
2. Aislamiento de capacidades: el agente de lectura/resumen (CEO) y el agente de acción (PR) son distintos; el segundo solo recibe campos estructurados validados (CVE id, paquete, versión objetivo), nunca texto libre de logs.
3. Tool poisoning/rug pull (ASI04): no conectar MCP de terceros en el camino del CEO; si se usa el connector de la API, fijar la lista con `mcp-client-2026-09-15` (pinning) y allowlist de tools [S3]; versionar descripciones de tools y firmarlas en CI.
4. Exfiltración: egress allowlist en el backend; sin tool que envíe emails/HTTP libre; redactar secretos antes de cualquier respuesta (ver sección 4); límites de volumen por tool (paginación, máximo de filas); rate limiting por tenant.
5. Confused deputy/token passthrough (ASI03): el MCP es resource server propio; valida audience; llama a GitHub con credenciales propias de GitHub App por instalación (permisos mínimos: contents read, pull_requests write sobre ramas de arreglo), NUNCA reenvía el token del usuario; si algún día hay proxy OAuth con client id estático + DCR, aplicar consentimiento por cliente, cookies `__Host-`, `state` y redirect_uri exacta (spec) [S13].
6. Permisos excesivos (ASI02/03): tools de solo lectura por defecto; lecturas con rol de DB de solo lectura y RLS; separar la clave de escritura de PR en otro servicio.
7. SSRF: si el servidor actúa de cliente OAuth o Client ID Metadata, bloquear rangos privados, HTTPS obligatorio, proxy de egreso [S13].
8. Confianza humano-agente (ASI09): el resumen para el CEO debe citar la evidencia (finding_id, versión detectada, fuente del aviso) y declarar nivel de confianza; las aprobaciones muestran el diff y el motivo, no solo "aprobar".
9. Cascada (ASI08): kill switch por tenant, límite de PRs abiertos, ramas protegidas, CI obligatorio antes del merge.
10. Logs/auditoría y pruebas: suite de pruebas de inyección (incluir en el repo un log "envenenado" como demo de defensa; buen pitch en track AI Security).

## 4. Privacidad: qué viaja y qué redactar
Qué viaja:
- A Anthropic (API): system prompt, mensajes, resultados de tools (todo lo que devuelva tu MCP/tool). Retención hasta 30 días (borrado automático) o ZDR si se contrata; marcados por seguridad hasta 2 años [S3][S4]. No se entrena con contenido de clientes de servicios comerciales (términos) [S5]. MCP connector no es ZDR [S3].
- A OpenRouter: igual más el proveedor final; políticas por proveedor; usar `zdr:true` y desactivar logging de prompts [S7][S8].
- A ElevenLabs: audio de la persona, transcripción, y lo que el agente lea/diga; 2 años por defecto; se puede poner días o 0 [S9]. Ojo: el LLM del agente de ElevenLabs también recibe el texto (según el LLM elegido; verificar proveedor del LLM en la configuración del agente). [I]
- A GitHub: metadatos de PR.
Qué redactar o no enviar nunca [I]:
- Secretos: API keys, tokens, `.env`, cadenas de conexión, claves privadas (escáner de secretos + patrones; reemplazar por `[SECRET:tipo]`).
- PII de usuarios finales del cliente (emails, teléfonos, IDs) en logs: hashear o enmascarar.
- Código fuente completo: enviar solo fragmentos mínimos del manifiesto/lockfile y rutas; para PR, solo el diff necesario.
- IPs internas, nombres de hosts y topología: seudonimizar (`host-3`) y mantener tabla de reversión en tu lado.
- Para voz: leer solo resúmenes de alto nivel; nunca pronunciar secretos ni rutas; sin OTP no dar detalles.
- Modo cliente regulado: contratar ZDR en Anthropic [S3], retención 0 o corta en ElevenLabs [S9], y notar que ElevenLabs MCP no funciona con Zero Retention Mode [S6] (decisión de producto: elegir tools webhook propios si el cliente exige ZRM, [I]).
Legal: al llamar a una persona con voz IA, avisar que es una IA y pedir consentimiento de grabación; revisar leyes locales (Venezuela, EE. UU.). La nueva Usage Policy de Anthropic exige informar que se usó IA en decisiones de alto riesgo [S17][1F]; nuestro caso es mayormente informativo.

## 5. Diseño mínimo de tools MCP (10 tools)
Todas validan tenant y rol desde el token. Salidas estructuradas + campo `evidence` con ids. `readOnlyHint: true` en anotaciones para las de lectura.
1. `get_security_overview` (lectura): puntaje de riesgo del tenant, conteo por severidad, tendencias 30 días, top 3 acciones.
2. `list_findings` (lectura): hallazgos filtrables (severidad, estado, activo, fecha); paginado.
3. `get_finding` (lectura): detalle por id: advisory, CVSS/KEV/EPSS, activos afectados, explotabilidad, estado de arreglo.
4. `list_assets` (lectura): inventario (servicios, repos, dominios, dependencias clave, dueño, criticidad de negocio).
5. `get_stack_inventory` (lectura): versiones de runtimes/frameworks/paquetes por servicio (SBOM resumido).
6. `list_advisories` (lectura): avisos externos recientes (ej. PHP2Shell) con "¿aplica a nosotros?" (resultado del cruce).
7. `check_exposure` (lectura): dado un advisory_id, devuelve activos expuestos, internet-facing o no, y confianza del cruce.
8. `get_business_impact` (lectura): traduce un hallazgo a impacto (qué servicio, qué ingresos/clientes, estimación cualitativa), con supuestos explícitos.
9. `get_remediation_status` (lectura): PRs propuestos, estado CI, quién aprobó, tiempo medio de arreglo (MTTR).
10. `get_activity_timeline` (lectura): qué cambió en 24h/7d (nuevos hallazgos, cerrados, despliegues), logs ya redactados.
11. `propose_fix_pr` (ESCRITURA limitada, solo rol engineer/CTO; no expuesta a sesiones CEO): crea rama + PR borrador con el arreglo; devuelve URL y diff; no hace merge.
12. `request_approval` (ESCRITURA limitada): crea una solicitud de aprobación y notifica al approver; la aprobación en sí ocurre fuera del MCP (app, con 2FA).
13. (opcional) `schedule_voice_alert` (ESCRITURA limitada): programa llamada de alerta a un contacto del tenant, solo para severidad >= umbral y con OTP previo.

### 10 preguntas de CEO y respuesta esperada
1. "¿Qué está pasando en mi sistema hoy?" -> `get_security_overview` + `get_activity_timeline`: "Riesgo medio-alto. 2 críticos abiertos, 1 nuevo desde ayer (PHP2Shell afecta el servicio de pagos). Nada indica explotación activa en tu infraestructura. Acción recomendada: aprobar el PR de parche (propuesto hace 20 min)." Con ids.
2. "¿Nos afecta la vulnerabilidad PHP2Shell de la que hablan?" -> `list_advisories` + `check_exposure`: "Sí en 1 de 14 servicios: el sitio de marketing en PHP X.Y (versión vulnerable, expuesto a internet). No afecta tu API principal (Node)." + confianza y fuente.
3. "Explícame qué es en palabras simples" -> `get_finding`: analogía sin jerga, qué podría hacer un atacante, por qué importa para el negocio, sin pasos de explotación.
4. "¿Cuánto riesgo hay para el negocio?" -> `get_business_impact`: impacto cualitativo + supuestos ("si cae el servicio de pagos, se pierden ventas; no hay evidencia de datos filtrados"); aclara que no es estimación financiera exacta.
5. "¿Estamos mejor o peor que el mes pasado?" -> `get_security_overview`: tendencia, MTTR, cuántos críticos cerrados.
6. "¿Quién es responsable de arreglarlo y cuánto tarda?" -> `get_remediation_status` + `list_assets`: dueño, estado del PR, ETA basada en MTTR histórico.
7. "¿Hay algo que deba decidir yo hoy?" -> `request_approval` pendientes: "1 decisión: aprobar ventana de mantenimiento de 15 min para el parche. Recomendado esta noche."
8. "¿Se filtró información de clientes?" -> `list_findings` + `get_activity_timeline`: "No hay evidencia de acceso a datos en los registros que monitoreamos; limitación: solo vemos X fuentes." Nunca afirmar 'seguro' sin evidencia.
9. "Como CFO: ¿qué inversión de seguridad pedirías este trimestre?" -> `get_security_overview` + `get_stack_inventory`: 3 prioridades con costo/beneficio cualitativo y dependencias; marca que es recomendación, no auditoría.
10. "Arréglalo ahora" (acción) -> el sistema NO ejecuta: llama `propose_fix_pr` solo si el rol lo permite; para CEO responde "Ya hay un PR propuesto; necesita aprobación del CTO. Te envío la solicitud" y llama `request_approval`. Nunca hace merge por voz.

## 6. Licencias/términos a revisar y plan recomendado
- Anthropic Usage Policy: nueva versión efectiva el 12 nov 2026; prohíbe descubrir/explotar vulnerabilidades sin autorización del dueño del sistema, malware, ataques a escala, y prompt injection/jailbreak sin autorización; permite investigación y defensa sobre sistemas propios/autorizados; existe el Cyber Verification Program para acceso ajustado [S17][1F]. Implicación: nuestro producto es defensivo y sobre sistemas del cliente con consentimiento; no incluir funciones de explotación activa/PoC; documentar autorización del cliente (T&C con "tengo autoridad sobre estos activos"). Si el modelo rechaza temas de exploits, considerar solicitar el Cyber Verification Program. Alto riesgo con intervención humana: PR con revisión humana cumple el espíritu [S17].
- Anthropic Commercial Terms (vigentes desde 17 jun 2025 en la página): el cliente es dueño de outputs, sin entrenamiento con Customer Content, DPA incorporado, prohibido construir producto competidor o revender sin aprobación (D.4), suspensión por violaciones [S5][1F]. Revisar si "revender acceso" afecta nuestro modelo (somos app con valor agregado, no reventa del modelo [I]; confirmar con ventas si escala).
- Consumer/Team de Claude: términos de retención/entrenamiento distintos a la API; si el CEO usa su propia suscripción para el conector, sus datos caen bajo los términos de su plan, no los nuestros. Revisar y decirlo en el onboarding. [I]
- ElevenLabs: aceptar MCP Server Terms; revisar términos de uso de agentes de voz, licencia comercial (Starter+ incluye licencia comercial), políticas de llamadas salientes/consentimiento, telefonía de terceros [S6][S11]; retención 2 años por defecto [S9].
- OpenRouter: términos + política de cada proveedor; ZDR por petición/cuenta [S7][S8].
- GitHub: usar GitHub App con permisos mínimos; revisar términos de la API.
- Qué plan necesita Andrés:
  - Hackathon: API de Anthropic con créditos (ya los tienen); ElevenLabs Starter/Creator o Free para probar (Free: 15 min y 4 concurrentes; Creator $11/mes: 275 min) [S11]; para llamadas salientes confirmar disponibilidad y número telefónico (no verificado).
  - Demo del MCP en claude.ai: una cuenta Pro ($17-20/mes) basta para añadir 1 conector personalizado (Free también permite uno) [S2][S12]; si el jurado/cliente usa Team, el Owner debe añadirlo.
  - Producción: Anthropic API con acuerdo comercial (ZDR opcional por contacto con ventas) [S3]; ElevenLabs Pro/Scale ($99-$299) o Enterprise si hace falta ZRM/SSO; cuenta empresarial de Claude del cliente (Team/Enterprise) es decisión del cliente.

## 7. Qué NO pude verificar (reabrir)
- Transportes exactos y URL(s) de callback OAuth de claude.ai para conectores personalizados (artículo 11503834 no cargó).
- Detalle técnico de PHP2Shell (CVE, versiones, fechas): artículo de BleepingComputer no cargó; solo resultados de búsqueda.
- Retención de metadatos y logging por defecto de OpenRouter.
- Disponibilidad de llamadas salientes en ElevenLabs por plan y LLM por defecto del agente.
- Que Supabase Auth actúe como servidor OAuth 2.1 para MCP (no verificado).
- Inconsistencia entre la página de privacidad (30 días) y la de plataforma (no retención por defecto salvo Covered Models): confirmar con Anthropic o en Console > Data retention.

## Fuentes
[S1] Spec MCP, Authorization (draft): https://modelcontextprotocol.io/specification/draft/basic/authorization
[S2] Claude Help, custom connectors con MCP remoto: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
[S3] Claude API docs, MCP connector: https://platform.claude.com/docs/en/agents-and-tools/mcp-connector ; API and data retention: https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
[S4] Anthropic Privacy Center, retención org data (1 jul 2026): https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
[S5] Commercial Terms: https://www.anthropic.com/legal/commercial-terms
[S6] ElevenLabs, MCP en agentes: https://elevenlabs.io/docs/agents-platform/customization/tools/mcp ; https://elevenlabs.io/docs/eleven-agents/customization/tools/mcp
[S7] OpenRouter ZDR: https://openrouter.ai/docs/guides/features/zdr
[S8] OpenRouter logging/privacy: https://openrouter.ai/docs/guides/privacy/logging
[S9] ElevenLabs retención: https://elevenlabs.io/docs/eleven-agents/customization/privacy/retention
[S10] ElevenLabs autenticación: https://elevenlabs.io/docs/eleven-agents/customization/authentication
[S11] ElevenLabs precios agentes: https://elevenlabs.io/pricing/agents
[S12] Claude pricing: https://claude.com/pricing
[S13] Spec MCP, Security Best Practices: https://modelcontextprotocol.io/specification/draft/basic/security_best_practices
[S14] OWASP Agentic Top 10 (resumen Cycode): https://cycode.com/blog/owasp-top-10-agentic-applications/ ; original: https://genai.owasp.org
[S15] UpGuard, incidentes MCP: https://www.upguard.com/blog/mcp-security-incidents
[S16] Invariant Labs, tool poisoning: https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks
[S17] Anthropic Usage Policy: https://www.anthropic.com/legal/aup
[S18] PHP2Shell (solo resultados de búsqueda): https://bleepingcomputer.com/news/security/php-ships-emergency-patches-for-critical-php2shell-flaws ; https://www.darkreading.com/application-security/php2shell-bugs-red-alert-security-industry


---

# Frente 2: Integraciones de solo lectura para la capa de monitoreo (team-22, Platanus Hack 26 Caracas, track AI Security)

Fecha de consulta de TODOS los precios y planes: **23 oct 2026**. Verificar en vivo antes de cotizar a un cliente.

Leyenda: **[V]** verificado en 2+ fuentes. **[1F]** una sola fuente (casi siempre la doc oficial). **[I]** inferencia mía. **NO VERIFICADO** = no pude confirmarlo.

Aviso de rigor: en esta sesión la mayoría de los datos vienen de una sola página oficial por dato, así que abundan los [1F]. Marqué [V] solo cuando hay dos fuentes independientes (por ejemplo doc oficial + lista de herramientas del MCP real, o dos páginas distintas del proveedor). Los hallazgos más importantes para el diseño están en la sección 0.

---

## 0. Hallazgos que cambian el diseño (leer primero)

1. **No existe un "solo lectura" uniforme.** Solo algunos proveedores lo ofrecen de forma nativa:
   - Supabase MCP: `read_only=true` en la URL ejecuta todo con un usuario Postgres de solo lectura, y `project_ref` limita a un proyecto [1F]. La propia doc recomienda read-only para rutinas de monitoreo sin supervisión.
   - GitHub MCP local: flag `--read-only` [1F]. GitHub Apps: permisos finos por repo [V].
   - MongoDB Atlas: roles de proyecto de solo lectura [1F].
   - Cloudflare: tokens de API con permisos "Read" [1F].
   - **Sin solo lectura nativo documentado**: Vercel MCP (da "el mismo acceso que tu usuario") [1F], Render MCP (soporta operaciones destructivas) [1F], MCP de Cloud Logging de Google (pide `logging.admin`) [1F], Firebase MCP (sin modo read-only documentado) [1F], ElevenLabs (solo restricción por scope, sin read-only descrito) [1F].
2. **Regla de diseño que propongo [I]:** NO usar los MCP de terceros como canal de producción de nuestro producto. Para el producto, usar APIs REST/GraphQL con tokens de mínimo privilegio, o mejor aún **empujar datos hacia nosotros** (log drains, webhooks) para que el cliente nunca nos entregue una credencial con poder de escritura. Los MCP sirven para el desarrollo del hackathon y para el flujo de PR con aprobación humana.
3. **Vercel: el rol Viewer de Pro NO puede ver logs ni observabilidad** [1F, doc de roles]. Solo el Enterprise Viewer lo ve. Por tanto, en Pro, leer logs por API exigiría un rol con escritura (viola mínimo privilegio). Salida: pedir al cliente que cree un **Drain** (Pro/Enterprise, $0.50/GB) hacia nuestro endpoint [V: doc de Drains + pricing].
4. **Render: no hay clave de API de solo lectura documentada** [1F: la doc de API dice solo "toda petición requiere API key"; no describe scopes]. Salida: **log stream** (syslog TLS o HTTPS) hacia nosotros. Los logs de Render se retienen 7/14/30 días según plan [1F, pricing].
5. **Cloudflare: "Logpush en todos los planes" según la doc, pero no pude confirmar qué datasets (http_requests, firewall_events) exigen Enterprise.** La página de Logpush dice que está disponible en Free/Pro/Business/Enterprise [1F]; otra página dice que "la disponibilidad de campos depende del plan" [1F]. Históricamente, los logs HTTP de zona eran Enterprise. **NO VERIFICADO** por dataset: preguntar al cliente su plan y probar en vivo. La GraphQL Analytics API es la alternativa de lectura (ver ficha).
6. **GitHub: Code scanning y Secret scanning en repos privados requieren compra (GitHub Code Security / Secret Protection)**; Dependabot alerts figura entre las funciones disponibles en todos los planes [1F]. No encontré el precio por committer en las páginas consultadas: NO VERIFICADO.
7. **"Capso" casi seguro NO es una herramienta de infraestructura.** Ver ficha 9. El candidato real que encaja con el contexto es **Kapso** (WhatsApp, con MCP y API).
8. **Google Cloud Security Command Center (SCC) Premium tiene mínimo de US$15,000/año en suscripción** [1F]; el modo pay-as-you-go existe. Para una startup, usar **SCC Standard (gratis, solo a nivel de organización)** o saltarse SCC y leer Cloud Logging/Monitoring/Asset Inventory.

---

## 1. Tabla resumen comparativa

| Herramienta | Señales clave | API/MCP oficial | Solo lectura real | Plan/licencia mínimo para leer | Esfuerzo MVP | Prioridad |
|---|---|---|---|---|---|---|
| GitHub | Dependabot, code scanning, secret scanning, PRs, Actions, config repos | API REST + MCP oficial (`github/github-mcp-server`) | Sí, vía GitHub App con permisos `read` | Free sirve para Dependabot; scanning en privados requiere compra | M | 1 (núcleo del producto: SBOM/stack + PR) |
| Supabase/Postgres | Logs (Postgres, Auth, API, Edge), advisors (seguridad/rendimiento), tablas, RLS | MCP oficial + Management API | Sí (`read_only=true`, `project_ref`) | Free = 1 día de logs; Pro 7 días | S | 2 |
| Vercel | Deploys, build/runtime logs, errores, firewall/WAF, env var (nombres), drains | MCP oficial `mcp.vercel.com` + REST | Parcial; MCP sin read-only documentado | Drains: Pro ($0.50/GB) o Enterprise | M | 3 |
| Cloudflare | Eventos WAF, tráfico (GraphQL), audit logs, config DNS/SSL | MCP oficial (API MCP) + REST/GraphQL | Sí, vía token con permisos Read | Audit logs en todos los planes; retención 18 meses | M | 3 |
| Render | Deploys, logs, métricas, Postgres (SQL read-only en MCP) | MCP oficial + REST | No documentado; usar log stream | Log retention 7/14/30 días según plan | M | 4 |
| Google Cloud | Cloud Logging, Monitoring, Audit logs, SCC, IAM | MCPs remotos oficiales (Logging, Monitoring, SCC en Preview) | Sí, con roles `*.viewer`; MCP de Logging exige admin | Logging: 50 GiB/proyecto gratis; SCC Standard gratis | L | 5 |
| ElevenLabs | Uso/créditos, historial de conversaciones, webhooks | API REST; (MCP: ver ficha) | Parcial (scope restriction) | Planes desde Free; llamadas salientes requieren número Twilio/SIP | S-M | 1 como **salida** (la llamada), no como entrada |
| MongoDB Atlas / Firebase | Métricas, alertas, logs (Atlas); reglas y auth (Firebase) | Atlas: MCP oficial + Admin API; Firebase: MCP oficial local | Atlas sí (roles); Firebase no documentado | Atlas: logs requieren rol Data Access Read Only | M | 5 (mención) |
| "Capso"/Kapso | Mensajes WhatsApp, webhooks | Kapso: API + MCP propios | Parcial | 2,000 mensajes gratis/mes | S | 6 (canal opcional) |

---

## 2. Fichas por herramienta

### 2.1 GitHub (GitHub App vs OAuth vs PAT)

**(1) Señales:** alertas de Dependabot, code scanning, secret scanning, advisories de seguridad, ejecuciones de Actions, configuración de repos (rulesets, permisos de Actions), commits, manifiestos de dependencias (para cruzar el stack con la vulnerabilidad) [1F: tabla de permisos de GitHub Apps].

**(2) API/MCP:** API REST oficial. MCP oficial `github/github-mcp-server` [1F]: modo `--read-only` local, toolsets (`dependabot`, `code_security`, `secret_protection`, `security_advisories`), servidor remoto `https://api.githubcopilot.com/mcp/`, autenticación OAuth, PAT o GitHub App. La doc no muestra un encabezado de solo lectura para el remoto.

**(3) Permisos mínimos (GitHub App), todo en `read`:**
- Metadata (obligatorio), Contents, Dependabot alerts, Code scanning alerts, Secret scanning alerts, Actions (lectura de runs), Administration solo si se quiere auditar rulesets (opcional) [1F para los nombres/niveles verificados: Dependabot, Code scanning, Contents, Metadata, Actions, Administration; Secret scanning no se pudo ver en la página truncada].
- Para el PR con aprobación humana (Nivel 4): `Contents: write` + `Pull requests: write` en un **segundo App o un segundo token separado**, nunca en el de lectura [I].
- **Nunca pedir:** `Administration: write`, `Workflows: write` (permite alterar CI), `Secrets`/`Environments` write, acceso a todos los repos de la organización "por comodidad", scope `repo` clásico, scope `admin:org`, `delete_repo`.

**Comparación [1F salvo lo indicado]:**
| | GitHub App | OAuth App | PAT |
|---|---|---|---|
| Identidad | Propia (actúa sin usuario) o en nombre de usuario [1F] | Usuario | Usuario |
| Permisos | Finos por permiso, instalable en repos elegidos [1F] | Scopes gruesos | Fine-grained o clásico [I] |
| Token | Instalación expira en **1 hora**, se puede acotar a repos y permisos en cada emisión (hasta 500 repos) [1F] | Largo | Largo, atado a una persona |
| Rate limit | 5,000/h mínimo, hasta 12,500 o 15,000 (Enterprise Cloud) [1F] | Compartido con el usuario | 5,000/h compartido con el usuario [1F] |
| Revocación | El cliente desinstala el App (un clic) [I] | Revocar autorización | Borrar token |
**Recomendación: GitHub App** (solo lectura) como único método para el producto. PAT solo como plan B del hackathon.

**(4) Plan/costo:** Free $0, Team $4/usuario/mes (primeros 12 meses), Enterprise $21/usuario/mes (primeros 12 meses) [1F, github.com/pricing]. Dependabot alerts: disponible en todos los planes [1F]. Code scanning y secret scanning: gratis en repos públicos; en privados requieren comprar GitHub Code Security / Secret Protection en Team y Enterprise Cloud [1F]; precio por committer: NO VERIFICADO.

**(5) Riesgos:** un token de PAT con scope `repo` da escritura completa; un App mal configurado con "todos los repos" amplía el radio de daño; contenido de PRs/issues es entrada no confiable (inyección de prompts hacia nuestro agente) [I]. El webhook del App debe verificarse con firma [I].

**(6) Trabajo:** M. Registrar el App, flujo de instalación, generación de token de instalación acotado, ingesta de manifiestos (package.json, composer.json, requirements, lockfiles) y de alertas. **Prioridad 1**: es el eje del cruce "vulnerabilidad vs stack" y del PR final.

---

### 2.2 Supabase / Postgres (+ mención MongoDB y Firebase)

**(1) Señales:** logs por servicio (API Gateway, Postgres, Auth, Storage, PostgREST, Edge Functions, Realtime, pooler) [1F]; **advisors** de seguridad y rendimiento (RLS faltante, etc.) [1F: herramienta `get_advisors`]; lista de tablas, extensiones, migraciones; configuración de Edge Functions.

**(2) API/MCP:** MCP oficial hospedado (OAuth con registro dinámico) [1F] y su listado de herramientas (`query_logs`, `get_advisors`, `list_tables`, `execute_sql`, `apply_migration`, etc.), que además pude ver en mi propio entorno [V: doc + herramientas reales]. Solo lectura posible con `read_only=true`; `project_ref=<id>` limita a un proyecto y desactiva herramientas de cuenta; `features=` limita grupos de herramientas [1F]. La doc advierte inyección de prompts y que "el servidor corre con tus permisos de desarrollador" [1F]. Para CI: PAT acotado al proyecto, enviado como Bearer [1F].

**(3) Permisos mínimos:** conexión MCP con `read_only=true` + `project_ref` + `features=debugging,database` (o solo lo necesario) [I sobre la combinación; cada parámetro es 1F]. Para consultas SQL propias, crear un **rol Postgres dedicado** con `SELECT` solo en vistas/metadata (`pg_catalog`, `information_schema`), no en tablas de negocio [I].
**Nunca pedir:** clave `service_role` / secret key (`sb_secret_...`, que salta RLS [1F]); contraseña del usuario `postgres`; cadena de conexión directa con superusuario; PAT de organización con acceso a todos los proyectos. Nota: Supabase retira las claves legacy `anon`/`service_role` a fines de 2026 [1F].

**(4) Plan/costo (consulta 23 oct 2026) [1F, supabase.com/pricing]:** retención de logs API/BD: Free 1 día, Pro 7 días, Team 28 días, Enterprise 90 días. Pro desde $25/mes; Team desde $599/mes. **Log drains**: solo Pro/Team/Enterprise [V: pricing + doc de log drains]; costo Pro/Team $60 por drain al mes + $0.20 por millón de eventos + $0.09/GB de salida [1F]. Destinos: endpoint HTTP, OTLP, Datadog, Loki, S3, Sentry, Axiom, Last9, Syslog [1F]. Audit logs de plataforma: Team y Enterprise [1F].

**(5) Riesgos:** `execute_sql` en el MCP puede leer datos de clientes finales (PII); mitigar con read-only y rol sin acceso a tablas de negocio. Con Free solo hay 1 día de logs: la señal histórica es pobre [I].

**(6) Trabajo:** S para MCP read-only + advisors; M si se hace rol Postgres propio. **Prioridad 2** (los advisors dan hallazgos accionables y demostrables en una demo).

**MongoDB Atlas (mención):** MCP oficial existe (modos "Local MCP" y "Atlas Managed MCP") [1F]; no pude leer su flag de solo lectura: NO VERIFICADO. Roles de proyecto: `Project Read Only` (metadatos, métricas; **no** da logs), `Project Observability Viewer` (rendimiento), `Project Data Access Read Only` (único que descarga logs de proceso y auditoría, **pero también ve documentos**) [1F]. Para señales de salud sin datos de negocio usar Read Only u Observability Viewer; no dar Data Access salvo que se necesiten logs [I]. Nunca pedir Project Owner/Organization Owner ni usuarios de base con `readWrite`.

**Firebase (mención):** MCP oficial local (`npx firebase-tools mcp`), usa las credenciales del CLI, sin modo read-only documentado; se puede acotar con `--only` [1F]. Herramientas como `firestore_delete_document` existen [1F]. Para el producto: usar APIs de Google Cloud con roles viewer en lugar de este MCP [I]. Monitoreo de reglas de seguridad/App Check: no documentado en la página consultada, NO VERIFICADO.

---

### 2.3 Cloudflare

**(1) Señales:** eventos de seguridad del WAF (Free: solo muestreados [1F]); analítica de tráfico por GraphQL (`https://api.cloudflare.com/client/v4/graphql` [1F]); **audit logs** de cuenta, 18 meses de retención, todos los planes [1F]; configuración de DNS, SSL, reglas WAF (para detectar mal configuración) [I]; Logpush (envío continuo, sin backfill: lo perdido se pierde para siempre [1F]).

**(2) API/MCP:** MCP oficial: servidor "Cloudflare API" (`https://mcp.cloudflare.com/mcp`, herramientas `search`, `execute`, `docs`) más servidores por producto (docs, containers, browser, DEX, CASB, etc.) [1F]. Autenticación OAuth con selección de permisos, o token de API como Bearer [1F]. La doc no dice si es de solo lectura; como `execute` llama a la API completa, el límite real lo pone el token [I]. La lista que yo esperaba (observability, audit logs) NO aparece en la página consultada.

**(3) Permisos mínimos (token de API personalizado, solo Read) [1F para los nombres vistos]:** `Logs Read`, `Account Analytics Read`, `Access: Audit Logs Read`, `Account Settings Read`, `Account: SSL and Certificates Read`; más Zone Read / DNS Read / permisos de firewall de zona (no pude ver el nombre exacto en la parte truncada de la página; NO VERIFICADO el nombre). Limitar el token a **las zonas concretas** del cliente y poner **IP allowlist** a nuestras salidas [I].
**Nunca pedir:** Global API Key; tokens con `Edit` en Zone/DNS/WAF/Workers; "Account: Edit"; permisos de Access/Zero Trust de escritura. (Las acciones de Nivel 4, como activar "Under Attack" o crear regla WAF, van en un token distinto, creado solo cuando el cliente apruebe [I].)

**(4) Plan/costo (consulta 23 oct 2026) [1F, cloudflare.com/plans]:** Free $0; Pro $20/mes anual ($25 mensual); Business $200/mes anual ($250 mensual); Enterprise por contrato. WAF listado en todos los planes; Free Managed Ruleset en todos [V: página de planes + doc WAF]; reglas custom en todos [1F]. Logpush: la doc dice todos los planes [1F] pero con dudas por dataset (ver sección 0, punto 5). Workers Trace Events Logpush exige Workers Paid [1F] ($0.05 por millón de peticiones [1F]).

**(5) Riesgos:** un token con permisos de edición permite derribar el sitio del cliente (DNS); el OAuth del MCP puede otorgar más de lo necesario si el usuario no revisa los permisos [I]. Los eventos WAF en Free son muestreados, así que la ausencia de eventos no prueba ausencia de ataque [I].

**(6) Trabajo:** M (crear plantilla de token con permisos preseleccionados vía enlace de creación de token, consultas GraphQL, normalizar eventos). **Prioridad 3.**

---

### 2.4 Vercel

**(1) Señales:** deploys y su estado, build logs, runtime logs y errores, firewall/WAF (config y eventos), dominios, nombres de variables de entorno, drains, eventos de cuenta/audit [1F + herramientas del MCP real que pude ver: `get_runtime_errors`, `get_runtime_logs`, `list_deployments`, `get_firewall_config`, `list_drains`, `list_user_events`, etc.: V].

**(2) API/MCP:** MCP oficial remoto `https://mcp.vercel.com` con OAuth; disponible en todos los planes; solo clientes aprobados por Vercel [1F]. Más de 200 herramientas, incluidas de escritura (`update_firewall_config`, `create_deployment`, `request_rollback`, `create_project_env`, etc.) [V: doc + lista real de herramientas en mi entorno]. La doc dice: "conectar da al sistema de IA el mismo acceso que tu usuario" y recomienda confirmación humana [1F]. Modo read-only documentado: **ninguno**. Existe una guía de "Vercel Connect" para dar acceso de solo lectura a datos de deploy a un agente [1F, mencionada, no verificada en detalle]. REST API oficial también.

**(3) Permisos mínimos:** crear un **usuario de servicio/seat dedicado** con el rol más bajo que alcance:
- Enterprise: **Enterprise Viewer** (lectura de logs, observabilidad, configuración) o Security (lectura de proyectos + firewall) [1F].
- Pro: **Pro Viewer es gratis pero NO ve logs/observabilidad ni configuración de equipo** [1F]. Para logs en Pro, usar **Drains** en lugar de rol [I].
- Token de acceso con alcance de un solo equipo [I].
**Nunca pedir:** rol Owner/Member; permiso Full Production Deployment; Environment Variable Manager; tokens de equipo sin expiración; Vercel Connect "Connector Manager" [1F para nombres de permisos].

**(4) Plan/costo (consulta 23 oct 2026) [1F, vercel.com/pricing]:** Hobby $0; Pro $20/mes + $20 por asiento Developer, con asientos Viewer ilimitados (gratis según la doc de roles [1F]); Enterprise custom. Retención de runtime logs: Hobby 1 hora, Pro 1 día (30 con Observability Plus), Enterprise 3 días (30 con Observability Plus) — la asignación de columnas fue por posición en el texto extraído, verificar en vivo [1F]. **Drains: Pro y Enterprise, $0.50 por GB** [V: doc de Drains + tabla de precios]; Hobby debe subir a Pro [1F]. Tipos de dato de drain: logs, trazas OTel, Speed Insights (requiere Speed Insights Plus), Web Analytics, audit logs (solo Enterprise) [1F]. WAF en todos los planes: Hobby 3 reglas custom, Pro 40, Enterprise 250 [1F]; DDoS básico gratis [V: doc firewall + pricing]. Ataque activo: herramienta `get_active_attack_status` en el MCP [1F-herramienta].

**(5) Riesgos:** MCP con acciones destructivas y sin read-only; los logs de runtime pueden contener secretos/PII impresos por la app (aplicar redacción antes de enviar al LLM) [I]; los drains envían volumen (costo por GB) [1F]. Los drains deben verificarse con firma [1F: la doc de Drains remite a una sección de seguridad con firma].

**(6) Trabajo:** M (receptor de drain con verificación de firma + normalización; guía de creación del drain para el cliente). **Prioridad 3.**

---

### 2.5 Render

**(1) Señales:** deploys, logs (con filtros), métricas (CPU, memoria, conexiones, respuestas; tiempos de respuesta requieren workspace Pro o mayor), Postgres (consulta SQL de solo lectura) [1F, doc MCP].

**(2) API/MCP:** MCP oficial hospedado `https://mcp.render.com/mcp` (código en `render-oss/render-mcp-server`), OAuth o API key como Bearer [1F]. **No es solo lectura**: puede crear servicios, disparar deploys y editar variables de entorno; la doc advierte que "no garantiza" que no se expongan secretos. Solo la consulta SQL es de solo lectura [1F]. REST API oficial (`api.render.com/v1`, spec OpenAPI) [1F]; la página de API no describe scopes ni rate limits: NO VERIFICADO.

**(3) Permisos mínimos:** no documentados para la API key (parece de acceso a la cuenta/espacio de trabajo) [1F, ausencia de evidencia]. Por eso: **preferir Log Stream** (el cliente configura un destino syslog TLS o HTTPS hacia nuestro receptor) [1F]. Si hay que usar API key: crearla desde un usuario de cuenta dedicado con el menor rol posible del workspace (los roles de workspace de Render NO se verificaron: NO VERIFICADO).
**Nunca pedir:** API key de un Owner/Admin para uso permanente; la cadena de conexión de Postgres; variables de entorno.

**(4) Plan/costo (consulta 23 oct 2026) [1F, render.com/pricing]:** Hobby $0, Pro $25/mes, Scale $499/mes (más cómputo), Enterprise custom; retención de logs 7 / 14 / 30 / 30 días; audit logs: ninguno en Hobby, workspace en Pro, workspace+organización en Scale/Enterprise. Log streams: la disponibilidad por plan no quedó clara en el texto extraído; la doc de log streams no restringe por plan el destino por defecto (override por servicio: Scale/Enterprise) [1F]. Destinos soportados explícitos: Datadog y Loggly por HTTPS; Better Stack, Coralogix, Mezmo, New Relic, Papertrail, SolarWinds, Sumo Logic, LaunchDarkly por syslog; cualquier otro endpoint se trata como syslog TLS [1F]. Los sitios estáticos no emiten logs [1F].

**(5) Riesgos:** la API key amplia + MCP con escritura es el peor caso del conjunto; sin audit logs en Hobby no hay trazabilidad [1F].

**(6) Trabajo:** M (receptor syslog TLS es más trabajo que un webhook HTTPS [I]). **Prioridad 4** (solo si el cliente piloto está en Render).

---

### 2.6 ElevenLabs (canal de salida: la llamada de voz)

Aquí el rol es distinto: es la **salida** de nuestro producto (llamar al CTO/CEO), no una fuente de señales del cliente. Aun así hay dos ángulos: (a) nuestra propia cuenta ElevenLabs para llamar; (b) si el cliente usa ElevenLabs en su producto, monitorear su consumo/seguridad.

**(1) Señales (si es del cliente):** créditos/uso, historial de conversaciones y transcripciones, configuración de agentes, webhooks post-llamada (`post_call_transcription`, `post_call_audio`, `call_initiation_failure`) [1F].

**(2) API/MCP:** API REST oficial. Existe un MCP de ElevenLabs en su ecosistema; no lo verifiqué en esta sesión: NO VERIFICADO. Webhooks firmados con HMAC (cabecera `ElevenLabs-Signature`, verificar con SDK `constructEvent`/`construct_event`) [1F].

**(3) Permisos mínimos:** claves de API con **restricción de scope**, **cuota de créditos por clave** y **lista blanca de IP** (peticiones desde IP no permitidas reciben 403) [1F]. No hay modo "solo lectura" descrito [1F]. Para nuestra cuenta: una clave solo con el scope de iniciar llamadas y un tope de créditos bajo [I].
**Nunca pedir al cliente:** su clave de ElevenLabs sin restricciones; no necesitamos tocar su cuenta para el MVP.

**(4) Plan/costo (consulta 23 oct 2026) [1F, elevenlabs.io/pricing/agents]:** Free $0 (15 min, 4 llamadas simultáneas), Starter $6 (75 min, 6), Creator $22 (275 min, 10), Pro $99 (1,238 min, 20), Scale $299 (3,738 min, 30), Business $990 (12,375 min, 40), Enterprise custom. Tarifa por minuto adicional: la página parece indicar $0.08 por minuto adicional y $0.16 en ráfaga, pero la lectura no es concluyente (ver nota en la propia fuente). LLM y telefonía se facturan al costo del proveedor. Retención por defecto de conversaciones: 2 años, configurable por agente (días, ilimitado o 0) para transcripciones y audio por separado [1F]; **Zero Retention Mode es Enterprise** [1F, solo aparece el título]. **Llamadas salientes** requieren un número Twilio (o caller ID verificado, solo saliente) importado con SID y token de Twilio; Twilio recomienda API keys con permisos limitados [1F]; también existe SIP trunk [1F, solo título]. El endpoint exacto de llamada saliente no aparece en las páginas consultadas: NO VERIFICADO (ver "Outbound call via twilio" en la referencia de API).

**(5) Riesgos:** una llamada a un humano con contenido de vulnerabilidad es información sensible: transcripción y audio quedan 2 años por defecto; cumplir con la retención mínima. Riesgo de ingeniería social si alguien devuelve la llamada o suplanta al agente [I]. Llamadas automáticas a números móviles pueden tener restricciones regulatorias locales (Venezuela/LatAm): NO VERIFICADO.

**(6) Trabajo:** S-M (Twilio + agente + webhook post-llamada). **Prioridad 1 para la demo** (es el "wow"); es salida, no integración con el cliente.

---

### 2.7 Google Cloud Console (Logging, Monitoring, SCC, IAM)

**(1) Señales:** Cloud Logging (incluye audit logs de Admin Activity), Cloud Monitoring (métricas, alertas), Security Command Center (hallazgos), IAM (quién tiene qué), Cloud Asset Inventory, Error Reporting, Cloud Run/GKE.

**(2) API/MCP:** servidores MCP remotos oficiales de Google Cloud: Cloud Logging (`https://logging.googleapis.com/mcp`), Cloud Monitoring, Resource Manager, IAM sin etiqueta Preview; **Security Command Center en Preview**; Cloud Asset Inventory y SCC Management en Preview; además Error Reporting, Cloud Run, Cloud SQL, Firestore, Policy Analyzer, etc. [1F, lista de productos soportados]. El MCP de Logging requiere roles `roles/mcp.toolUser` + `roles/logging.admin` y scopes `logging.admin`/`logging.write` [1F]: **no es de mínimo privilegio**. La doc recomienda identidad separada para agentes [1F].

**(3) Permisos mínimos:** NO usar el MCP de Logging tal cual. Usar una **cuenta de servicio dedicada** vía APIs directas con roles de solo lectura. Roles que propongo (nombres conocidos de GCP; su detalle NO fue verificado en esta sesión porque la página de roles no cargó el contenido): `roles/logging.viewer` (lee logs de actividad de administración; **NO** `logging.privateLogViewer`, que incluye logs de acceso a datos), `roles/monitoring.viewer`, `roles/securitycenter.findingsViewer`, `roles/cloudasset.viewer`, `roles/iam.securityReviewer` [I / NO VERIFICADO en detalle]. Mejor aún: que el cliente nos dé acceso mediante **impersonación de cuenta de servicio** (Workload Identity Federation), sin claves JSON de larga vida [I].
**Nunca pedir:** claves JSON de cuenta de servicio de larga duración; `roles/owner`, `roles/editor`, `logging.admin`, `iam.securityAdmin`, `resourcemanager.organizationAdmin`.

**(4) Plan/costo (consulta 23 oct 2026):** Cloud Logging: primeros 50 GiB/proyecto/mes gratis; $0.50/GiB de ingestión; retención `_Default` 30 días sin costo adicional (más allá: $0.01/GiB/mes); bucket `_Required` 400 días sin costo [1F, cloud.google.com/logging/pricing]. **SCC**: Standard gratis; Premium por suscripción = 5% del gasto anual proyectado en Google Cloud, **mínimo $15,000/año**, o pago por uso (Compute $0.0057/vCPU-hora a nivel organización; BigQuery $0.80/TiB) [1F, pricing]. Standard solo se activa a **nivel de organización** y Security Health Analytics no está disponible en nuevas activaciones de Standard [1F, service-tiers] ⇒ para startups sin organización GCP, SCC puede no aplicar [I].

**(5) Riesgos:** la mayor superficie de ataque del conjunto (una cuenta de servicio mal dimensionada = control de la nube del cliente); las claves JSON filtradas son el vector clásico [I].

**(6) Trabajo:** L. **Prioridad 5** (después del hackathon), salvo que el cliente piloto sea GCP-céntrico.

---

### 2.8 (Mención) Capas de base de datos
Ver 2.2: Supabase (S), MongoDB Atlas (M), Firebase (usar Google Cloud APIs, M).

---

### 2.9 "Capso": qué es y qué no

- **Capso (con "c" y "p")**: aplicación nativa de macOS, gratuita y de código abierto, para capturas y grabación de pantalla con anotaciones [1F, listado de Toolradar; fuente citada awesomemacapp.com]. **No es una herramienta de infraestructura ni de monitoreo.** Fabricante: no identificado en la fuente.
- **Kapso**: plataforma para agregar WhatsApp oficial (Meta Business Partner) a productos [1F, kapso.com + docs.kapso.ai: coherente]. Tiene API REST (base `api.kapso.ai/meta/whatsapp`, clave `KAPSO_API_KEY`), SDK TypeScript, webhooks con firma HMAC, CLI, **servidor MCP** (leer conversaciones, enviar mensajes, gestionar plantillas y webhooks), sync opcional con Supabase, 2,000 mensajes gratis al mes [1F]. Cómo se obtienen y acotan las claves: no documentado en las páginas consultadas. Fundadores: no figuran.
- **Conclusión:** [I] el cliente probablemente dijo "Kapso" (o un nombre parecido). **NO VERIFICADO** que sea lo que usa el cliente: confirmarlo con él. Si es Kapso, es un canal (WhatsApp) y fuente de PII (conversaciones). Si se conecta: lectura de estado de webhooks y logs de API, nunca de contenido de conversaciones; nunca pedir la clave con permiso de envío. Prioridad 6 (alternativa o complemento a la llamada de voz: aviso por WhatsApp). Esfuerzo S.

---

## 3. Niveles de conexión recomendados (coherente con "primero solo lectura")

| Nivel | Nombre | Qué se conecta | Credencial | Ejemplo |
|---|---|---|---|---|
| 0 | Declarativo | Nada se conecta. El cliente declara su stack (formulario, `package.json` pegado, URL pública) | Ninguna | "Usamos Next.js 14, Supabase, Vercel, PHP 8" → cruce con el aviso tipo PHP2Shell. Funciona en la demo sin riesgo. |
| 1 | Inspección pública/pasiva | Huellas externas: cabeceras HTTP, DNS, certificados, versiones expuestas | Ninguna (solo dominio) | Detectar versión de PHP/servidor visible. [I] |
| 2 | Lectura del código | GitHub App en `read` (Metadata, Contents, Dependabot) en repos elegidos | Token de instalación de 1 h | SBOM real y alertas de dependencias |
| 3 | Lectura operativa | Supabase read-only, Vercel Drain, Cloudflare token Read, Render log stream, GCP viewer | Tokens de solo lectura / canales "push" | Logs, errores, WAF, advisors |
| 4 | Acciones con aprobación humana | PR automático (App con `pull_requests: write` + `contents: write` en rama propia); acciones de mitigación | Credencial distinta, de vida corta, emitida solo tras aprobación del CTO | PR de actualización de dependencia; el CTO aprueba, nunca se hace merge automático |

Regla: no se pasa de nivel sin consentimiento explícito y registrado del CTO; los CEO/CFO/COO ven el estado (tablero y llamada) pero no manejan credenciales [I].

---

## 4. Checklist de seguridad de la conexión

**Gestión de secretos**
- [ ] Ningún secreto en el repo, en prompts ni en logs; uso de bóveda/gestor de secretos o variables cifradas [I].
- [ ] Cifrado en reposo con clave por cliente (aislamiento multi-tenant) [I].
- [ ] Un token por herramienta y por cliente; nunca reutilizar.
- [ ] El LLM nunca ve el secreto: el backend inyecta credenciales; el modelo solo ve resultados redactados [I].
- [ ] Redacción automática de PII/secretos en logs antes de enviarlos al modelo (los logs de Vercel/Render pueden contener secretos impresos por la app) [I].

**Rotación y vida útil**
- [ ] Preferir credenciales efímeras: token de instalación de GitHub (1 h) [1F], OAuth con refresh, impersonación en GCP [I].
- [ ] Para tokens largos (Cloudflare, Supabase PAT, Render): expiración fijada y rotación cada 30-90 días con recordatorio [I].
- [ ] Supabase: crear claves nuevas no revoca las antiguas; desactivar las legacy aparte [1F].

**Mínimo privilegio y alcance**
- [ ] Alcance por proyecto/repo/zona, nunca a nivel de organización completa por defecto.
- [ ] IP allowlist hacia nuestras IPs de salida donde exista (Cloudflare, ElevenLabs lo soporta [1F]).
- [ ] Separar credencial de lectura (Nivel 3) de la de escritura (Nivel 4).

**Auditoría**
- [ ] Registro interno inmutable de cada llamada a API del cliente (qué, cuándo, quién aprobó).
- [ ] Usar los audit logs del proveedor para que el cliente verifique lo que hicimos (Cloudflare 18 meses [1F]; GitHub y Vercel Enterprise; Render Pro+ [1F]).
- [ ] Aprobación humana registrada para cada acción de Nivel 4.

**Revocación en un clic**
- [ ] Botón "Desconectar" en nuestro panel que borre el secreto y llame a la revocación del proveedor.
- [ ] Instrucción de revocación del lado del cliente por herramienta: GitHub (desinstalar el App), Cloudflare (borrar token), Vercel (borrar drain y seat), Supabase (revocar PAT/OAuth app), Render (borrar API key y log stream), ElevenLabs (borrar clave) [I].
- [ ] Prueba periódica de que la revocación funciona.

**Contra inyección de prompts (crítico)**
- [ ] Todo contenido de logs, issues, PRs y tickets es entrada no confiable [1F: advertido por Supabase y Vercel].
- [ ] El agente de lectura no tiene herramientas de escritura; el agente que abre PRs no lee datos crudos del cliente [I].
- [ ] Confirmación humana obligatoria antes de cualquier escritura; las confirmaciones del MCP son "guardarraíles, no garantías" [1F: Supabase].

**Cumplimiento y datos**
- [ ] Declarar al cliente qué datos salen y dónde se almacenan; retención mínima (ElevenLabs conserva 2 años por defecto [1F]).
- [ ] No almacenar contenido de bases de datos de negocio; solo metadatos y hallazgos [I].

---

## 5. Qué conectar en el hackathon (24-48 h) vs. después

**Hackathon (realista, orden sugerido):**
1. **Nivel 0** (declarativo) como camino principal de la demo: el cliente "declara" su stack; ya cubre el flujo aviso, cruce, llamada. (S, ~2 h)
2. **ElevenLabs + Twilio** para la llamada saliente con transcripción y webhook; usar nuestra cuenta con clave restringida y tope de créditos. (S-M, ~6-8 h)
3. **GitHub App en solo lectura** sobre 1-2 repos de demo (manifiestos + Dependabot) y flujo de **PR con aprobación humana** hacia un repo de demostración. (M, ~8-10 h)
4. **Supabase MCP en modo `read_only=true` + `project_ref`** con `get_advisors` y `query_logs`, sobre un proyecto de demo propio. (S, ~2-3 h)
5. Opcional si sobra tiempo: **un receptor de Vercel Drain** (webhook HTTPS con verificación de firma) con un proyecto de demo en Pro, o un token de **Cloudflare con permisos Read** sobre una zona de prueba. (M)

Consejo de demo [I]: usar cuentas y proyectos de demostración propios, no del cliente real; mostrar la pantalla de permisos (solo lectura) como argumento de venta ("ni el CTO ni el CEO nos dan poder de escritura").

**Después del hackathon:**
- Cloudflare completo (GraphQL + audit logs + alertas), Vercel Drains en producción, Render log stream.
- Google Cloud con cuentas de servicio por impersonación (L), SCC si el cliente tiene organización.
- MongoDB Atlas, Firebase, Kapso/WhatsApp como canal alterno.
- Endurecimiento: bóveda de secretos, panel de desconexión, auditoría inmutable, pruebas de inyección de prompts, revisión legal de llamadas automáticas.

---

## 6. Brechas y cosas NO VERIFICADAS (confirmar antes de prometer)

1. Qué datasets de Cloudflare Logpush exigen Enterprise (la doc dice "todos los planes", con salvedades).
2. Nombres exactos de permisos de Cloudflare para Zone/DNS/Firewall de solo lectura.
3. Precio por committer de GitHub Code Security / Secret Protection en repos privados.
4. Roles de workspace de Render y si hay API keys limitadas.
5. Endpoint de llamada saliente de ElevenLabs y existencia/estado de su MCP; restricciones regulatorias de llamadas automáticas en Venezuela.
6. Flag de solo lectura del MCP de MongoDB; nombres/detalles de roles IAM de GCP citados (propuestos por conocimiento general).
7. Qué herramienta es exactamente "Capso" para el cliente (¿Kapso?).
8. Retención de runtime logs de Vercel por plan: la asignación de columnas se hizo por posición del texto extraído.
9. Disponibilidad por plan de los log streams de Render (el texto extraído no mostró las marcas).

---

## 7. Fuentes (consultadas el 23 oct 2026)

- Supabase MCP: https://supabase.com/docs/guides/getting-started/mcp
- Supabase precios: https://supabase.com/pricing
- Supabase log drains: https://supabase.com/docs/guides/telemetry/log-drains
- Supabase logs: https://supabase.com/docs/guides/telemetry/logs
- Supabase API keys: https://supabase.com/docs/guides/api/api-keys
- Vercel MCP: https://vercel.com/docs/mcp/vercel-mcp (redirige a /docs/agent-resources/vercel-mcp)
- Vercel Drains: https://vercel.com/docs/drains
- Vercel roles: https://vercel.com/docs/rbac/access-roles
- Vercel Firewall: https://vercel.com/docs/vercel-firewall
- Vercel precios: https://vercel.com/pricing
- Cloudflare MCP: https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/
- Cloudflare permisos de API: https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- Cloudflare Logpush: https://developers.cloudflare.com/logs/logpush/
- Cloudflare datasets Logpush: https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/
- Cloudflare GraphQL: https://developers.cloudflare.com/analytics/graphql-api/
- Cloudflare audit logs: https://developers.cloudflare.com/fundamentals/account/account-security/review-audit-logs/
- Cloudflare WAF: https://developers.cloudflare.com/waf/
- Cloudflare planes: https://www.cloudflare.com/plans/
- Render MCP: https://render.com/docs/mcp-server
- Render API: https://render.com/docs/api
- Render log streams: https://render.com/docs/log-streams
- Render precios: https://render.com/pricing
- ElevenLabs autenticación/claves: https://elevenlabs.io/docs/api-reference/authentication
- ElevenLabs precios agentes: https://elevenlabs.io/pricing/agents
- ElevenLabs Twilio: https://elevenlabs.io/docs/agents-platform/phone-numbers/twilio-integration/native-integration
- ElevenLabs webhooks post-llamada: https://elevenlabs.io/docs/agents-platform/workflows/post-call-webhooks
- ElevenLabs retención: https://elevenlabs.io/docs/agents-platform/customization/privacy/retention
- Google Cloud Logging MCP: https://docs.cloud.google.com/logging/docs/use-logging-mcp
- Google Cloud productos con MCP: https://docs.cloud.google.com/mcp/supported-products
- Google Cloud Logging precios: https://cloud.google.com/logging/pricing
- SCC precios: https://cloud.google.com/security-command-center/pricing
- SCC niveles: https://docs.cloud.google.com/security-command-center/docs/service-tiers
- GitHub Apps: https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps
- GitHub permisos de Apps: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
- GitHub token de instalación: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- GitHub rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- GitHub MCP: https://github.com/github/github-mcp-server
- GitHub funciones de seguridad: https://docs.github.com/en/code-security/getting-started/github-security-features
- GitHub precios: https://github.com/pricing
- MongoDB MCP: https://www.mongodb.com/docs/mcp-server/
- MongoDB roles de Atlas: https://www.mongodb.com/docs/atlas/reference/user-roles/
- Firebase MCP: https://firebase.google.com/docs/cli/mcp-server
- Kapso: https://kapso.com/ y https://docs.kapso.ai/docs/whatsapp/introduction
- Capso (app macOS): https://toolradar.com/tools/capso


---

# Parte IV. Definición del producto, abogado del diablo y preguntas para el equipo
**Platanus Hack 26 Caracas, team-22. 23 de octubre de 2026.**

> Qué se cuestiona: el documento completo (Partes I a III), el archivo de tu compañero ("Investigación de SaaS de Ciberseguridad", que propone UAGSO) y las tres definiciones del equipo. Quién lo consume: Andrés y el equipo, para decidir qué construir.

---

## 1. Las definiciones del equipo, con ajustes

| | Versión del equipo | Versión ajustada | Por qué cambia |
|---|---|---|---|
| **¿Qué somos?** | Una herramienta que protege tu producto. | El equipo de seguridad que tu startup no tiene: vigilamos lo que tu producto usa y te avisamos, en lenguaje claro, cuando algo te expone. | "Protege" promete un resultado que nadie puede garantizar. Si hay un incidente, la promesa se vuelve contra nosotros. |
| **¿Qué hacemos?** | Analizamos tu sistema entre los puntos débiles y los corregimos. | Cuando sale una falla que afecta tu stack, la detectamos, te decimos cuánto te afecta y preparamos el arreglo para que lo apruebes. | "Corregimos" a solas choca con el principio de solo lectura (Parte III). Con aprobación humana sí es coherente. |
| **¿Cómo lo hacemos?** | Evaluando tu ecosistema, con IA, blindamos tu producto en tiempo real y te mantenemos al tanto. | Nos conectamos en solo lectura a tu código y tu infraestructura, cruzamos lo que usas con una base global de fallas, priorizamos las explotables y proponemos correcciones que una persona aprueba. Te informamos por texto, voz y Claude. | "Blindamos" y "en tiempo real" son promesas que la demo no podrá cumplir. "En minutos" sí se puede demostrar. |

---

## 2. Qué tomar y qué dejar del archivo de tu compañero

**Lo bueno [I]:** está bien estructurado y las cuatro fichas (Snyk, Socket, GitGuardian, Semgrep) sirven como referencia de competidores. Tres ideas valen la pena para nuestro producto:
1. **Alcanzabilidad:** no alertar si la función vulnerable nunca se usa. Reduce el ruido y evita llamar al CEO por nada.
2. **Verificar si un secreto está vivo o muerto** antes de avisar.
3. **Defensa contra paquetes inventados por IA** (confusión de dependencias). Es un nicho real y encaja con el track.

**Lo que no encaja:**
- **UAGSO es una plataforma de AppSec para desarrolladores y CISOs.** Nuestro cliente es la startup y su CEO, CFO o COO. Es otro comprador, otro lenguaje y otro producto.
- **Pide construir en un hackathon lo que cuatro empresas con años y mucho capital ya hicieron:** un parser en Rust, un grafo de código, dependencias e identidades, un motor de alcanzabilidad y un agente de reparación. Las metas "menos de 3 segundos" y "menos de 5 segundos" son aspiraciones sin evidencia.
- **Las fuentes son débiles.** Casi todas son blogs secundarios (rafter.so, appsecsanta, devtune.ai, genosdb.com, dev.to, medium). La cita 5 es una página de ingresos y valoración (multiples.vc) usada para respaldar afirmaciones técnicas sobre cómo funciona Socket. El dato "reduce hasta 90% el ruido" viene de un sitio de rankings de búsqueda con IA. Hay que tratarlo todo como [1F] hasta verificarlo.
- **Confunde el caso que nos motivó.** La Capa 3 habla de "un paquete de PHP" con comportamiento malicioso. Pero PHP2Shell es una falla en el propio intérprete, no un paquete de un registro. El análisis conductual de paquetes no la detecta. Lo que la detecta es cruzar el aviso con la versión que corre el cliente, que es la Idea A.
- **Aislar paquetes de forma preventiva y automática** puede romper producción. El propio Socket reconoce falsos positivos. Con aprobación humana está bien; automático no.

**Recomendación:** no adoptar UAGSO como arquitectura. Tomar las tres ideas de arriba como mejoras posteriores de la Idea A y mantener a Snyk, Socket, GitGuardian y Semgrep como los competidores o aliados que ya tenemos en la tabla de la Parte II.

---

## 3. Abogado del diablo (nivel 2)

**Supuestos no verificados**
- Que un CEO, CFO o COO de startup quiere gestionar seguridad y pagaría por ello. [A] No hay una sola entrevista.
- Que el ejemplo PHP2Shell representa a nuestros clientes. Un stack típico de startup es Next.js, Vercel y Supabase (Parte III). En ese mundo el equivalente es React2Shell (CVE-2025-55182), una ejecución remota de código en React Server Components y Next.js [V: [Rapid7](https://careers.rapid7.com/blogs/Rapid7-Blogs/react2shell-cve-2025-55182-critical-unauthenticated-rce-affecting-react-server-components), [Wiz](https://www.wiz.io/es-es/blog/critical-vulnerability-in-react-cve-2025-55182), [Tenable](https://www.tenable.com/blog/react2shell-cve-2025-55182-react-server-components-rce)]. Si la demo muestra solo PHP, un jurado con stack JS pensará que no aplica a su caso.
- Que la voz aporta valor y no es un truco. Falta evidencia de que un ejecutivo no técnico atenderá y aprobará algo por llamada.
- Que la base de fallas globales es una ventaja. Sus fuentes (OSV, GitHub Advisory, CISA KEV, EPSS) son públicas y gratuitas; cualquiera las usa.

**Qué podría fallar (pre-mortem: es el día del pitch y salió mal)**
1. **Un jurado pregunta "¿esto no lo hace ya Dependabot o Aikido gratis?"** y no tenemos una respuesta de una frase. Dependabot, la protección por defecto de Cloudflare y el plan gratuito de Aikido ya cubren parte del problema.
2. **Pregunta "¿cómo aseguran su propia herramienta?".** Estamos en el track AI Security y tenemos acceso de lectura a repos e infraestructura de varios clientes. Somos un blanco muy valioso y no tenemos todavía una respuesta defendible.
3. **Inyección de instrucciones.** El agente lee avisos, logs y repos que pueden contener texto malicioso. Si ese texto manipula al agente que abre PRs o llama al CEO, el producto se ataca a sí mismo.
4. **Suplantación por voz.** Un atacante llama al CEO haciéndose pasar por nuestro agente, o clona una voz para aprobar un cambio. Aprobar solo por voz es un punto débil, no una ventaja.
5. **Fatiga de alertas.** Llamar a las 4 a. m. por una falla que no es explotable en ese stack nos quita la confianza del cliente en la segunda semana.
6. **Un PR "arreglado" rompe producción**, y la startup nos culpa. Sin pruebas ni vuelta atrás, no es defendible.
7. **Alcance.** Cinco personas, horas desconocidas y 1.000 líneas de documentación sin una decisión de qué construir. El riesgo es entregar cinco cosas a medias.

**Alternativas no consideradas**
- **Foco en el 4 a. m.** (monitoreo, caídas, salud del sistema), como dijiste al inicio. Es un producto distinto a "exposición a vulnerabilidades". Las definiciones nuevas lo dejaron fuera sin que se decidiera.
- **Solo la capa de explicación:** un servidor MCP que conecta lo que ya existe (GitHub, Cloudflare, Vercel, Supabase) y deja que el CEO pregunte a Claude. Es barato, pero Claude ya tiene conectores propios, así que la diferencia es pequeña.
- **Apuntar a un solo stack** (Next.js, Vercel, Supabase) en vez de "cualquier vertical". Es menos ambicioso, pero la demo es creíble.

**El caso contrario más fuerte:** "Esto es una función, no un producto. Un CEO ya puede conectar GitHub y Cloudflare a Claude y preguntar. Aikido y Cloudflare regalan lo básico. Lo único que ustedes agregan es una llamada de voz." Respuesta honesta [I]: lo que nadie hace es **avisar primero** (empuje, no consulta), cruzar el aviso con *tu* inventario, y entregar el arreglo listo para aprobar. Esa es la diferencia, y la demo tiene que mostrarla en menos de dos minutos.

**Veredicto:** se sostiene con matices. La Idea A sigue siendo el mejor camino, pero antes de construir hay que decidir tres cosas: monitoreo (4 a. m.) o exposición, qué stack mostramos en la demo, y cómo protegemos la herramienta misma.

### Hallazgos por gravedad
| Gravedad | Hallazgo | Corrección |
|---|---|---|
| Crítico | Producto sin definir: monitoreo (4 a. m.) contra exposición a vulnerabilidades | Decidir hoy (pregunta 1) |
| Crítico | No hay respuesta a "¿cómo aseguran su propia herramienta?" | Solo lectura, secretos rotables, auditoría y revocación en un clic; incluirlo en el pitch |
| Crítico | Aprobación solo por voz | Segundo factor (código en la app o en un mensaje) para cualquier acción |
| Importante | Demo con PHP en un stack que usa JS | Mostrar un caso tipo React2Shell sobre Next.js; PHP2Shell queda como contexto |
| Importante | Promesas de las definiciones ("blindamos", "tiempo real") | Usar las versiones ajustadas del punto 1 |
| Importante | Falta de evidencia de cliente | Hablar con 5 ejecutivos antes de construir más |
| Importante | Alcance de UAGSO | No adoptarlo; tomar solo las tres ideas útiles |
| Menor | Llamadas por fallas no explotables | Llamar solo si es explotable y afecta tu stack; el resto va por mensaje |

---

## 4. Las 20 preguntas clave para el equipo

**A. Foco del producto**
1. ¿Somos monitoreo (se cayó todo a las 4 a. m.) o exposición a vulnerabilidades (salió una falla que te afecta)? Si son las dos, ¿cuál se ve en la demo y cuál va en el pitch como visión?
2. ¿Cuál es la frase de una línea que nos distingue de Dependabot, Cloudflare y Aikido, que ya dan parte de esto gratis?
3. ¿Qué es lo único que debe funcionar de punta a punta en la demo? Propongo: aviso, cruce con el stack, llamada, PR, verificación.
4. ¿Qué ideas del archivo de UAGSO entran en la primera versión y cuáles quedan fuera?
5. ¿Competimos con herramientas de seguridad o las usamos como fuente de datos y las orquestamos?

**B. Cliente**
6. ¿Quién es nuestro primer cliente concreto, con nombre y apellido? ¿Conocemos a 5 CEO, CFO o COO a quienes entrevistar esta semana?
7. ¿Qué stack mostramos en la demo? Propongo Next.js, Vercel y Supabase. ¿Lo usa el cliente real?
8. ¿A quién llamamos: al CEO, al CTO o a ambos? ¿Qué debe poder hacer cada uno?
9. ¿Qué cuenta como "urgente" para llamar a alguien a las 4 a. m.? ¿Y qué se manda solo por mensaje?

**C. Técnica y demo**
10. ¿Cuántas horas reales tenemos y cuáles son los criterios del jurado? Aún no los tengo.
11. ¿Quién construye qué? ¿Hay un responsable de la voz, del cruce de inventario, del PR y del pitch?
12. ¿Qué conectamos en la demo: declaración manual del stack, GitHub App de solo lectura, Supabase solo lectura? ¿Aceptamos dejar Cloudflare, Vercel y Render para después?
13. ¿Con qué datos reales o simulados hacemos la demo? ¿Una falla real y reciente o una simulada y etiquetada como tal?
14. ¿Qué pasa en la demo si falla el internet, la llamada o la API? ¿Tenemos un video de respaldo?

**D. Seguridad propia y legal**
15. ¿Cómo protegemos el producto mismo? Tiene lectura sobre repos de clientes: ¿qué pasa si nos hackean a nosotros?
16. ¿Cómo evitamos que texto malicioso en un aviso, un log o un repo manipule al agente?
17. ¿Cómo confirma el ejecutivo una acción sin que un atacante pueda suplantar la voz? ¿Qué segundo factor usamos?
18. ¿Qué datos del cliente viajan a Claude, OpenRouter y ElevenLabs, y cuáles redactamos antes? ¿Aceptamos que ElevenLabs guarde 2 años por defecto?

**E. Negocio**
19. ¿Cuánto cuesta cada análisis y cada llamada (modelo, voz, telefonía)? ¿Cuál sería el precio mensual y a quién se lo cobramos?
20. ¿Qué evidencia nos haría cambiar de opinión (por ejemplo, que 3 de 5 ejecutivos digan que no pagarían)? ¿Qué pasa después del hackathon: producto, consultoría o se acaba?

---

## 5. Qué sigue
1. Responder las preguntas 1, 2, 3, 7 y 17 esta noche. Con eso se define el producto y la demo.
2. Entrevistar a 5 ejecutivos antes de construir más.
3. Reescribir el pitch con las definiciones ajustadas del punto 1.
4. Verificar antes del pitch lo marcado como "no verificado" en la Parte III y los detalles de PHP2Shell.


---

# Parte V. Decisiones del equipo, producto v1 y plan de 36 horas
**Platanus Hack 26 Caracas, team-22. Viernes 23 de octubre de 2026, 23:16 (hora de Caracas).**

> Esta parte recoge tus respuestas por voz a las 20 preguntas, el producto v1 que se desprende de ellas, la lista de lo que hay que conectar y construir, y el plan hasta el domingo a las 12:00. Lo que dijiste tal cual está marcado **Decidido**. Lo que completé yo está marcado **Propuesta** y hay que confirmarlo. Lo que dejaste para después queda **Pendiente**. Cuando la corrección cambia algo de lo que dijiste, lo digo en la sección 2.

---

## 1. Registro de decisiones

| # | Pregunta | Respuesta | Estado |
|---|---|---|---|
| 1 | ¿Monitoreo o exposición? | **Monitoreo.** El sistema debe estar construido el domingo, con voz de ElevenLabs para llamadas y WhatsApp (Kapso, "Capso" en tu audio; "Cernio" no lo pude identificar) para mensajes. | Decidido |
| 2 | Frase que nos distingue | "Avisamos en tiempo real, por llamada y WhatsApp, cuando tu servicio está bajo ataque, y cubrimos npm y PHP." Ver la corrección en 2.2. | Decidido, con ajuste |
| 3 | Lo único que debe funcionar de punta a punta | Detectar un ataque en tiempo real: saturar un servidor montado en Supabase y que el sistema llame o mande un mensaje. | Decidido |
| 4 | Ideas de UAGSO en la v1 | Se responde después. | **Pendiente** |
| 5 | ¿Competimos u orquestamos? | **Orquestamos**, conectando MCP con Claude y manejándolo en lenguaje natural. | Decidido |
| 6 | Primer cliente | Cuadra y SAGA: startups venezolanas de SaaS que operan con software y hardware. | Decidido. Las entrevistas a 5 ejecutivos siguen sin hacerse. |
| 7 | Stack de la demo | Lo define Andrés con Carlos. | **Pendiente** |
| 8 | A quién llamamos y qué puede hacer cada uno | La app es para desarrolladores y para personas no técnicas. Borrador en 3.4. | Propuesta |
| 9 | Qué es urgente (llamada) y qué va por mensaje | Escaneo de rutas, saturación, accesos sin autorización a rutas de administrador, bypasses, IPs insistentes y rate limit superado. Reglas y umbrales en 3.2. | Decidido, con propuesta de umbrales |
| 10 | Horas y criterios del jurado | Unas 36 horas. Originalidad 15 %, ambición 20 %, ejecución y despliegue 20 %, impacto 20 % (deducido: no lo dijiste, pero los demás suman 80), técnico 25 %. | Decidido |
| 11 | Quién construye qué | "Se define durante el rumbo." Ver el riesgo en 2.4. | **Pendiente** |
| 12 | Qué conectamos en la demo | Todo lo que haga falta, y nada se deja para después del domingo a las 12:00. Lista en la sección 4. | Decidido |
| 13 | Falla real o simulada | Real (PHP de la última semana) y simulada, etiquetada como tal. | Decidido |
| 14 | Plan B si falla internet o la llamada | Todavía no hay video de respaldo. Se complementa con el pitch. | **Pendiente**, ver 2.5 |
| 15 | Cómo protegemos el producto | Por módulos: documentación de configuraciones correctas de Supabase, revisión de las configuraciones actuales, token de `service_role` o autenticación, MCP de Supabase y repositorio de GitHub conectado. | Decidido, con una corrección crítica en 2.1 |
| 16 | Cómo evitamos la inyección de instrucciones | Control de prompts: lo que salga del ámbito lo rechaza la IA que procesa todo. | Decidido, con refuerzo en 2.3 |
| 17 | Segundo factor para confirmar acciones | No respondiste. | **Propuesta** en 3.4 |
| 18 | Qué datos viajan a Claude, OpenRouter y ElevenLabs | Ecosistema de la base de datos, configuraciones de Cloudflare, reglas custom, DNS y protección del plan Hobby. Hay que detallar más. | Parcial. Tabla en la sección 5. |
| 19 | Costo por análisis y por llamada | Negocio, se deja para después. | **Pendiente** |
| 20 | Evidencia para cambiar de opinión y qué pasa después | Se ve el domingo. Idea de Nicolás: módulo que compare el rendimiento actual con el de la versión anterior. | **Pendiente**. Idea de Nicolás en 6. |

---

## 2. Abogado del diablo sobre las respuestas (nivel 2)

**Veredicto:** el producto está bien enfocado y la demo es buena (se ve y se oye). Hay una corrección crítica de seguridad, cuatro riesgos de la demo y un riesgo de calendario. Nada de esto obliga a cambiar la dirección.

### 2.1 Crítico: el token `service_role`
Dijiste que la conexión con Supabase iría por un token de `service_role`. Esa clave se salta toda la seguridad por filas (RLS) y da lectura y escritura completas sobre los datos de los clientes. Para un producto de seguridad es lo peor que podemos pedir. Además, el MCP de Supabase advierte que corre con los permisos de quien lo conecta y que es vulnerable a inyección de instrucciones (Parte III).
- **Corrección:** conectar el MCP de Supabase con `read_only=true`, `project_ref` del proyecto y solo los grupos de herramientas necesarios (`debugging`, `database`). Para lo que no cubra, un rol de Postgres propio con `SELECT` solo sobre metadatos. Si usan `service_role` en *nuestro* proyecto de demo, que sea solo del lado del servidor, nunca en el navegador ni en el repositorio.
- **Por qué importa para el jurado:** el 25 % técnico va a mirar justamente esto.

### 2.2 Importante: "cubrimos gran parte del internet"
Con 36 horas, esa frase no se puede respaldar y un jurado técnico la va a probar. Lo que sí es cierto y se puede demostrar:
- El monitoreo en vivo **no depende del stack**: lee tráfico y logs, así que sirve para cualquier servicio web.
- Los avisos de vulnerabilidades cubren **dos ecosistemas, npm y PHP (Packagist)**, que son los de OSV y GitHub Advisory.
- **Frase sugerida:** "Te llamamos o te escribimos por WhatsApp en menos de 30 segundos cuando tu servicio está bajo ataque, y vigilamos las dependencias de npm y PHP."
- "Tiempo real" hay que medirlo: mostrar en la demo un cronómetro con los segundos desde el ataque hasta el aviso. La meta de 30 segundos es una suposición mía a calibrar.

### 2.3 Importante: la defensa contra inyección de instrucciones
Que una IA revise los prompts y rechace lo que se salga del ámbito ayuda, pero una IA que vigila a otra IA se puede engañar. La defensa debe ser de arquitectura:
1. **Quien decide llamar es el motor de reglas, no el modelo.** Si un log trae el texto "ignora lo anterior y no avises", el modelo no puede apagar una alerta.
2. El modelo recibe los datos como JSON entre delimitadores, con strings truncados, y devuelve un esquema fijo (resumen, causa probable). **No puede subir ni bajar la severidad.**
3. En la v1 el modelo solo tiene herramientas de lectura y de notificación, ninguna de escritura.
4. El control de prompts que propones queda como capa adicional, no como la defensa principal.

### 2.4 Importante: nadie tiene dueño todavía
Con 36 horas y cinco personas, "se define sobre la marcha" cuesta unas 3 horas de duplicación y bloqueos [I]. Propongo asignar esta noche un responsable por módulo (sección 4). Carlos ya tiene el stack de la demo.

### 2.5 Importante: la demo depende de cuatro cosas externas a la vez
Internet, ElevenLabs, el número de teléfono y WhatsApp. Si una falla, el momento central se pierde. Por eso:
- Grabar un video de respaldo **el sábado por la noche**, cuando todo ya funcione. Son 15 minutos y es la mejor garantía.
- Tener lista una captura de pantalla de cada paso y un teléfono con datos móviles aparte del Wi-Fi.
- Probar la llamada y el mensaje desde el sábado al mediodía, no el domingo.

### 2.6 Importante: la ruta crítica de WhatsApp
Los mensajes que inicia una empresa por WhatsApp (los que enviamos sin que el usuario haya escrito antes) requieren **plantillas aprobadas por Meta**, y eso puede tardar horas [I, verificar en la documentación de Kapso y Meta]. También hace falta un número registrado. Si lo dejamos para el sábado, podemos quedarnos sin mensajes en la demo.
- **Esta noche:** crear la cuenta en Kapso, registrar el número y pedir la aprobación de la plantilla de alerta con variables mínimas.
- **Plan B:** el entorno de pruebas de WhatsApp de Twilio, que no exige plantillas aprobadas pero sí que cada teléfono se una con un código [I, verificar].
- **Llamadas a Venezuela:** hay que comprobar que ElevenLabs y Twilio permiten llamar a números +58 y qué cuesta. Si no, la llamada de la demo va a un teléfono con número de otro país [I, no verificado].

### 2.7 Importante: la demo del ataque
- **Ataquen un servidor propio, no la plataforma.** Supabase aloja base de datos y funciones, no servidores arbitrarios. Saturar el proyecto de Supabase o una cuenta de un tercero puede violar sus políticas de uso o generar costos. Montemos una app de demo del equipo (Next.js en Vercel con base de datos en Supabase) y ataquémosla desde una máquina propia con una herramienta de carga (por ejemplo `k6` o `autocannon`) a un ritmo moderado. Verificar antes las reglas de Supabase y Vercel sobre pruebas de carga [no verificado].
- **No usar a Cuadra ni a SAGA como blanco** sin su autorización por escrito.
- **El ataque debe ser reproducible:** un script fijo, con rutas de administrador sembradas a propósito, que se pueda correr 10 veces igual.
- **Errores de tipeo no son vulnerabilidades.** Para la demo del repositorio, sembrar fallas reales y etiquetadas: un secreto falso en el código, una consulta SQL sin parametrizar, una dependencia con CVE conocido. Se ve más convincente que comas mal puestas.

### 2.8 Menor
- **Cuadra y SAGA:** SAGA es tu propio producto. Sirve como primer usuario, pero no valida que otros paguen. Las 5 entrevistas siguen siendo necesarias.
- **"Software y hardware":** si hay dispositivos (IoT) en el monitoreo, queda fuera de la v1. Confirmar.
- **Llamar demasiado:** poner un tiempo de espera entre llamadas del mismo incidente y agrupar eventos (sección 3.2) para no llamar diez veces por el mismo ataque.

---

## 3. Producto v1 (para el domingo)

### 3.1 Qué es
Un vigilante que mira el tráfico y la configuración de tu servicio, detecta señales de ataque en segundos, te avisa por llamada de voz o WhatsApp en lenguaje claro, y permite preguntarle a Claude qué pasó. En segundo plano, vigila las dependencias de npm y PHP y avisa si una falla nueva te afecta.

Cinco módulos:
- **A. Detección en vivo** (el centro de la demo): recibe eventos de tráfico, aplica reglas, crea incidentes.
- **B. Notificación:** llamada con ElevenLabs y mensaje por WhatsApp.
- **C. Exposición de dependencias:** avisos de OSV y GitHub Advisory para npm y Packagist cruzados con `package.json`, `composer.json` y `composer.lock` del repositorio conectado.
- **D. Auditoría de configuración:** advisors de seguridad de Supabase, reglas de Cloudflare, DNS, y un cuadro de qué señales no se ven según el plan del cliente.
- **E. Capa conversacional:** servidor MCP de solo lectura para preguntarle a Claude (claude.ai, Desktop o Code).

### 3.2 Reglas de detección (umbrales iniciales, todos [A], se calibran en pruebas)

| Regla | Señal | Umbral inicial | Canal |
|---|---|---|---|
| R1. Acceso a ruta de administrador sin autorización, con éxito | Respuesta 2xx o 3xx en `/admin`, `/wp-admin`, `/phpmyadmin`, `/.env`, `/api/admin` sin sesión válida | 1 evento | **Llamada** (crítico) |
| R2. Saturación con degradación | Peticiones por segundo sobre el umbral **y** (latencia p95 alta **o** errores 5xx sobre el umbral) | Por definir con pruebas de carga | **Llamada** |
| R3. Escaneo de rutas | Muchas rutas distintas con 404 o 403 desde la misma IP | Más de 20 rutas en 60 s | WhatsApp (alto). Sube a llamada si después ocurre R1 |
| R4. IP insistente | Muchas peticiones desde la misma IP | Más de 100 por minuto | WhatsApp |
| R5. Rate limit superado | El servicio responde 429 | 1 evento sostenido 30 s | WhatsApp (medio) |
| R6. Dependencia vulnerable | Aviso de OSV o GitHub que afecta una versión del repositorio | Cualquier aviso crítico o alto | WhatsApp. Llamada si está en el catálogo de explotadas activamente (CISA KEV) [I] |

**Reglas de aviso:** una sola llamada por incidente cada 15 minutos; los eventos del mismo atacante se agrupan en un incidente; todo queda registrado con la hora para medir el tiempo de respuesta.

### 3.3 Guion de la demo (3 minutos)
1. Panel con el servicio sano.
2. Se lanza el script de ataque. Empieza un cronómetro.
3. Escaneo de rutas: llega el **WhatsApp** en menos de 30 segundos.
4. El ataque prueba la ruta de administrador sembrada: **suena el teléfono** y la voz de ElevenLabs explica qué pasó y qué se recomienda.
5. El CEO le pregunta a Claude: "¿qué pasó y qué hago?", y Claude responde con datos reales del incidente.
6. Repositorio conectado: aparece el aviso real de PHP de la semana y una falla sembrada en npm, cada una con su etiqueta (real o simulada).
7. Cierre: cuadro "qué no puedes ver según tu plan" y el comparativo antes y después de un despliegue, si alcanzó.

### 3.4 Quién puede hacer qué (propuesta, falta confirmar)

| Rol | Puede hacer con lenguaje natural | No puede hacer |
|---|---|---|
| **CEO, CFO, COO** | Preguntar "¿estamos bien?", pedir un resumen en palabras simples, ver el costo o riesgo de un incidente, aprobar o rechazar acciones predefinidas | Ver logs crudos, cambiar umbrales, tocar credenciales |
| **CTO, desarrollador** | Todo lo anterior, más ver eventos y logs filtrados, ajustar umbrales, conectar y desconectar fuentes, ver por qué se disparó cada regla | Dar permisos de escritura a la plataforma sin una aprobación aparte |

**Confirmación de acciones (pregunta 17, propuesta):** en la v1, la **voz solo informa**. Cualquier acción (por ejemplo activar el modo de ataque de Cloudflare) se confirma en WhatsApp o en la app con un código de un solo uso. Así un atacante que imite la voz del agente no puede lograr que se apruebe nada.

---

## 4. Lista de todo lo que hay que conectar y construir

Orden por ruta crítica. **P0** es lo que la demo necesita sí o sí; **P1** debe estar el domingo; **P2** solo si sobra tiempo. Esfuerzo: S (pocas horas), M (medio día), L (más de un día).

| # | Tarea | Prioridad | Esfuerzo | Dueño |
|---|---|---|---|---|
| 1 | Cuentas y claves: ElevenLabs, Twilio o telefonía, Kapso/Meta, Anthropic, Vercel, Supabase, GitHub. Pedir **ya** la plantilla de WhatsApp y el número | P0 | S | Por asignar |
| 2 | Repositorio del equipo con estructura, `.env.example`, secretos fuera del código | P0 | S | Por asignar |
| 3 | App de demo (blanco del ataque) con rutas de administrador sembradas | P0 | S | Carlos |
| 4 | Ingesta de eventos de tráfico (middleware que envía a nuestro endpoint, firmado con HMAC) y tabla en Supabase | P0 | M | Por asignar |
| 5 | Motor de reglas R1 a R5 con ventanas deslizantes y creación de incidentes | P0 | M | Por asignar |
| 6 | Llamada con ElevenLabs (agente + telefonía) con resumen redactado por Claude | P0 | M | Por asignar |
| 7 | Mensaje por WhatsApp con plantilla aprobada | P0 | M | Por asignar |
| 8 | Script de ataque reproducible (escaneo, administrador, saturación) | P0 | S | Por asignar |
| 9 | Panel web (Next.js en Vercel) con incidentes, línea de tiempo y cronómetro | P0 | M | Por asignar |
| 10 | Servidor MCP de solo lectura (incidentes, estado, reglas, avisos) | P1 | M | Por asignar |
| 11 | Módulo de dependencias: OSV para npm y Packagist, lectura del manifiesto vía GitHub App de solo lectura | P1 | M | Por asignar |
| 12 | Auditoría de Supabase con `get_advisors` y MCP en solo lectura | P1 | S | Por asignar |
| 13 | Lectura de logs de Supabase (consulta de logs, o ingesta propia si el plan gratis no alcanza) | P1 | M | Por asignar |
| 14 | Cuadro "qué no ves según tu plan" (Hobby, Free, Pro) | P1 | S | Por asignar |
| 15 | Controles de seguridad propios: redacción de secretos, límites, registro de auditoría, revocar acceso | P1 | M | Por asignar |
| 16 | Pruebas automáticas de las reglas, CI en GitHub Actions | P1 | S | Por asignar |
| 17 | Documentación: README, arquitectura, modelo de amenazas, guía de configuración segura de Supabase | P1 | M | Por asignar |
| 18 | Archivos del hackathon (descripción del proyecto, logo y metadatos que pida el README del repositorio team-22) | P1 | S | Por asignar |
| 19 | Lectura de eventos de Cloudflare (analítica GraphQL, reglas, DNS) | P2 | M | Por asignar |
| 20 | Comparativo de rendimiento antes y después de un despliegue (idea de Nicolás) | P2 | M | Por asignar |
| 21 | Receptor de drains de Vercel y de logs de Render | P2 | L | Por asignar |
| 22 | Google Cloud (Logging y Monitoring) | P2 | L | Por asignar |
| 23 | Video de respaldo de la demo | P1 | S | Por asignar |

Las tareas 21 y 22 son grandes y la demo no las necesita. Si de verdad "no se deja nada para después del domingo", conviene decidir ya cuáles de las P2 se prometen y cuáles se muestran como hoja de ruta.

---

## 5. Qué datos viajan y cuáles se redactan (respuesta detallada a la pregunta 18)

| Dato | A Claude u OpenRouter | A ElevenLabs | A WhatsApp | Regla |
|---|---|---|---|---|
| Resumen del incidente (tipo, ruta, conteos, severidad, hora) | Sí | Sí, texto corto | Sí, en la plantilla | Sin cargas útiles de las peticiones |
| Direcciones IP de atacantes | Sí | Enmascaradas (último bloque) | No | Completas solo en el panel |
| Rutas y URL | Sí, sin parámetros | Solo el nombre de la ruta | Solo el nombre | Los parámetros pueden traer tokens |
| Logs crudos | Muestras truncadas y con secretos redactados | No | No | Redactar JWT, claves `sk-`, `Bearer`, correos |
| Configuración de Supabase (advisors, RLS, nombres de tablas) | Sí | No | No | Nunca filas de datos |
| Configuración de Cloudflare, reglas custom y DNS | Sí | No | No | Nunca tokens |
| Código del repositorio | Solo manifiestos (`package.json`, `composer.json`, `composer.lock`) | No | No | Sin código fuente en la v1 |
| Claves, `service_role`, contraseñas | **Nunca** | **Nunca** | **Nunca** | Almacenar cifradas, rotables, revocables en un clic |
| Datos de usuarios finales | **Nunca** | **Nunca** | **Nunca** | Fuera del alcance |

**Retención:** ElevenLabs guarda los datos 2 años por defecto y su modo de retención cero no funciona con MCP. Como por voz solo viaja un resumen corto y sin datos sensibles, es aceptable para la demo. Anthropic borra a 30 días con excepciones, y su conector MCP de la API no admite retención cero (Parte III). Dos páginas de Anthropic sobre retención no coinciden del todo: verificar antes del pitch.

### Planes: lo que cada nivel deja ver (consulta del 23 oct, Parte III)

| Servicio | Plan gratis o Hobby | Plan que desbloquea más señal |
|---|---|---|
| Supabase | Free: 1 día de logs; sin envío de logs a destinos externos | Pro desde 25 USD al mes: 7 días de logs y envío de logs (60 USD por destino al mes más uso) |
| Vercel | Hobby: 1 hora de logs, 3 reglas custom de firewall, sin drains | Pro 20 USD al mes: 1 día de logs, 40 reglas, drains a 0,50 USD por GB |
| Cloudflare | Free: eventos del WAF solo muestreados, reglas administradas y custom disponibles | Pro 20 USD al mes anual |

**Idea para el producto:** como las startups cambian de plan muy rápido, el sistema detecta en qué plan está el cliente y le dice qué no puede ver ("con Hobby no ves el tráfico de la última hora"). Eso es el cuadro de la tarea 14. Los números salen de una sola fuente oficial por dato y hay que revisarlos antes de mostrarlos.

---

## 6. Idea de Nicolás: rendimiento antes y después de un despliegue
Un módulo que compare el rendimiento actual del producto con el de la versión anterior a los cambios, para saber si el código nuevo es más o menos eficiente y qué falló.
- **Cómo encaja:** ya recibimos eventos con hora. Si la app marca cada petición con el identificador de despliegue, se calcula latencia p95, tasa de errores y rutas más lentas antes y después, y se avisa si empeoró.
- **Estado:** P2. Es una buena segunda demostración si el módulo A queda sólido; no debe quitarle horas al P0.

---

## 7. Plan de 36 horas (desde el viernes a las 23:16 hasta el domingo a las 12:00)

| Bloque | Qué se hace |
|---|---|
| **Vie 23:15 a 01:00** | Responder lo pendiente mínimo (stack con Carlos, dueños por módulo). Crear cuentas. **Pedir la plantilla de WhatsApp y el número.** Crear el repositorio |
| **Sáb 08:00 a 14:00** | App de demo, ingesta de eventos, tablas, motor de reglas R1 a R5. Primera llamada de prueba con ElevenLabs |
| **Sáb 14:00 a 20:00** | WhatsApp, panel, script de ataque. Primera prueba de punta a punta. MCP y dependencias en paralelo |
| **Sáb 20:00 a 24:00** | Ensayo completo de la demo, medir el tiempo de aviso, **grabar el video de respaldo**. Congelar funciones nuevas a las 22:00 |
| **Dom 00:00 a 07:00** | Dormir. Una demo hecha con cansancio extremo es la causa más común de fallas [I] |
| **Dom 07:00 a 10:00** | Documentación, pruebas, CI, logo y archivos del hackathon, despliegue final |
| **Dom 10:00 a 11:00** | Entrega y revisión de que todo el material cumple lo que pide el README |
| **Dom 11:00 a 12:00** | Margen. No se programa nada nuevo |

### Lista para el 25 % técnico (repositorio)
- README con qué es, cómo se instala y cómo se corre la demo en menos de 5 comandos.
- Diagrama de arquitectura y una página de modelo de amenazas ("cómo asegura el producto su propia seguridad").
- `.env.example`, sin ningún secreto en el historial de Git.
- Pruebas automáticas de las reglas de detección y un flujo de integración continua.
- Una guía de configuración segura de Supabase (lo que dijiste en la pregunta 15).
- Para el 20 % de despliegue: la aplicación publicada y accesible con un enlace.

---

## 8. Pendientes que quedan abiertos en el documento
1. Pregunta 4: qué ideas de UAGSO entran (propuesta: ninguna en la v1; se retoma la alcanzabilidad y la verificación de secretos después).
2. Pregunta 7: stack de la demo (Andrés con Carlos).
3. Pregunta 11: dueños por módulo (propuesta: asignarlos esta noche).
4. Pregunta 14: video de respaldo (propuesta: sábado por la noche).
5. Pregunta 19: costo por análisis y por llamada.
6. Pregunta 20: evidencia para cambiar de opinión y qué pasa después del hackathon.
7. Confirmar: peso del impacto (20 %), significado de "software y hardware" para Cuadra y SAGA, y qué es "Cernio".
8. Verificar: llamadas a números +58, plantillas de WhatsApp, política de pruebas de carga de Supabase y Vercel, y los detalles de PHP2Shell antes del pitch.
