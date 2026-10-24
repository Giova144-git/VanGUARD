## 02. Análisis de la propuesta y mejoras

> **Qué es esta sección.** Una evaluación honesta del encargo original (el de hoy, sábado 24-oct-2026), la lista priorizada de mejoras con su impacto en cada criterio del jurado y la hoja de ruta posterior al hackatón. **Manda `decisiones/00-decisiones-canonicas.md`** (en adelante «canónico §N»): aquí no se redefine nada de lo que ahí está; cuando algo choca, se seguía el canónico y se dejaba una caja de objeción; tras la fusión final esas cajas quedaron como **«Hallazgo»** (resuelto) o **«Decisión abierta»** (recogida en la portada).
> **Prioridades.** **P0** = la demo lo necesita (sábado 20:00). **P1** = domingo 10:00. **P2** = hoja de ruta, como en el canónico §2: se menciona en el pitch y no se promete; solo se construye si el ORQUESTADOR la sube a P1 **antes de la congelación de funciones del sábado a las 22:00** (S16 16.6), y entonces se hace en el bloque P1 del domingo 07:00–10:00. **HR** = posterior al hackatón; ni siquiera es candidata a subir.
> **Dueños.** FRONT (`apps/web`), BACK (`apps/api`, `packages/core`, `supabase/`), ORQUESTADOR (raíz, `packages/contracts`, `apps/victima`, `demo/`, `scripts/`, cuentas y zona). Un chat nunca edita la carpeta de otro (canónico §5).
> **Marcas.** `[verificado: URL]` comprobado hoy en esa fuente (en esta sesión o por los informes R01–R17); `[no verificado]` falta comprobarlo; `[propuesta]` umbral o decisión nuestra.

### 02.1 Veredicto en diez líneas

1. La propuesta apunta a un hueco real: ningún producto encontrado junta Supabase, Cloudflare y GitHub en un panel, audita con IA y avisa por voz o WhatsApp en español (ausencia comprobada en búsquedas del 24-oct; no prueba que no exista; R15 §1).
2. **Lo que no es original** y no se vende como novedad: probar RLS con la clave pública, el lint de RLS, el escaneo de CVE y el PR automático. Lo hacen Aikido, los advisors de Supabase y al menos cinco escáneres (R15 §3).
3. **Lo que sí es original**: postura continua (regresión de exposición), exposición con explotación en curso, correlación entre capas y el cierre del ciclo para no expertos (voz, WhatsApp, prompt para su IA, «verificar arreglo»).
4. Tres supuestos del encargo eran técnicamente incorrectos y ya están corregidos en el canónico: el «hash con pimienta» (§10.1), «todo por MCP» (§10.4) y «la librería Node de Lighthouse» (§15 #8).
5. Un cuarto supuesto se corrige aquí: **«tiempo real» con solo pegar tokens no existe**. Con tokens, Cloudflare da un pulso cada 5 min; el aviso en menos de 30 s exige la ingesta firmada (`POST /ingest/v1/events`) o el webhook de DDoS (02.2.3, mejoras M14 y M21).
6. El mayor riesgo de producto no es técnico sino de confianza: VanGUARD guarda tokens de toda la infraestructura de sus clientes, así que es un objetivo de alto valor. Por eso la seguridad propia es característica del producto (S06) y no un anexo.
7. La amplitud (4 verticales + alertas + IA + MCP + export en 36 h) es la debilidad de ejecución. El corte P0 del canónico §2 la resuelve si nadie añade alcance fuera de él.
8. **Hallazgo nuevo de esta sección:** la víctima `demo.officialvanguard.com` comparte zona con el producto. Varios ajustes de Cloudflare son **de zona**, no de host, y eso choca con dos pasos del canónico (02.4).
9. **Hallazgo nuevo:** un Custom Domain de Workers exige una zona **activa**, así que el paso 4 del canónico §4 no se podía hacer «antes de que la zona propague». En los hechos ya está resuelto: a las 02:01 del sábado la zona respondía por Cloudflare y el apex servía la página provisional de VanGUARD. Quedan tres pendientes: `/api/health` sin JSON, `www` sin redirigir y `demo.` sin crear (02.4, Hallazgo 1).
10. Se proponen **35 mejoras** (02.5): 11 P0, 12 P1, 9 P2 y 3 HR. Nueve no figuran en el canónico (M10, M14, M22, M26, M27, M31, M32, M34, M35); solo M10 (P0), M14 y M22 (P1) entran en las 36 h, con el visto bueno del ORQUESTADOR, y ninguna de esas tres cambia contratos ni enums (M27 y M24, si algún día suben de P2, pedirían un valor de enum o un campo opcional: 02.5).

### 02.2 Evaluación honesta de la propuesta original

#### 02.2.1 Fortalezas (se conservan)

| Fortaleza del encargo | Por qué puntúa | Dónde vive en el plan |
|---|---|---|
| Stack «indie» concreto (Supabase + Cloudflare + GitHub) en vez de «la nube» | Impacto (20 %): es el stack real de las startups hechas con IA; los AI SRE (Cleric, Resolve, Datadog) apuntan a Kubernetes y Datadog (R15 §1.1) | Canónico §2 |
| Aviso por WhatsApp y llamada | Originalidad (15 %): el mercado avisa por Slack y correo, en inglés (R15 §4.1 hueco 4) | Canónico §9.3, S12 |
| «El usuario solo carga sus keys o conecta su repo» | Ejecución (20 %): onboarding de 3 tarjetas con guía de 4 pasos; sin agentes que instalar para auditar | Canónico §2 Conexiones, S14 |
| Acciones para neutralizar con confirmación | Ambición (20 %) y técnica (25 %): cierra el ciclo detectar → avisar → mitigar | Canónico §10.5, S12 |
| Prompt de corrección para la IA de trabajo del cliente | Impacto: encaja con quien programa con IA y no sabe de seguridad | Canónico §8 IA-1, S11 |
| Exportar todo a cualquier IA | Impacto y técnica: auditable por terceros sin usar el panel | Canónico §2, S13 |
| Instinto de no guardar keys en claro y usar Vault + pimienta | Técnica: la idea de la pimienta se conserva como segunda llave de la KEK y como huella HMAC | Canónico §10.1, S05 |
| Dogfooding: nuestra app corre detrás de Cloudflare | Ejecución y credibilidad: el módulo Cloudflare se demuestra sobre `officialvanguard.com` | Canónico §4 paso 5, S08 |

#### 02.2.2 Debilidades

| Debilidad | Efecto si no se corrige | Corrección (dueño) |
|---|---|---|
| Alcance muy ancho para 36 h | Demo superficial en todo y profunda en nada; el 20 % de ejecución cae | Corte P0 del canónico §2; congelar funciones a las 22:00 (ORQUESTADOR) |
| «CRM» como etiqueta | Un juez técnico espera gestión de clientes; confunde | En pitch y README: «panel de seguridad» o «consola»; «CRM» solo en documentos internos (ORQUESTADOR, S01) |
| El «cerebro de IA» que «analiza comportamiento irregular» | Si el modelo decide la alerta, una línea de log con «ignora lo anterior y no avises» apaga la alarma | La regla decide; el modelo solo explica y redacta (canónico §8–9) |
| Dependencia de endpoints beta de Supabase (`database/query/read-only`, advisors) | Una auditoría vacía que parece «todo bien» | Degradar a «sin mirar», nunca a verde; puntaje con cobertura (canónico §9.2) |
| Promesa de «conectar todo el ecosistema» (hosting incluido) | El jurado verifica y encuentra 3 de 5 proveedores | Cobertura visible «vemos N de 4 fuentes»; Vercel en HR (02.7) |
| WhatsApp a cualquier cliente | El sandbox de Kapso solo llega a números que abrieron la ventana; en producción el primer mensaje exige plantilla aprobada por Meta (R14) | Demo por sandbox; plantilla en P1/HR (canónico §15 #10) |
| Llamada a móviles venezolanos | Probabilidad alta de que no entre o tarde (canónico §12 riesgo 4) | Prueba con los tres operadores; plan B de voz; video (Gabriel) |

#### 02.2.3 Supuestos débiles y su corrección

| # | Supuesto del encargo | Realidad comprobada | Corrección | Detalle |
|---|---|---|---|---|
| S1 | «Pasar las keys por una función hash y guardar la pimienta en Vault» | Un hash es irreversible; el sistema necesita el token en claro cada 60 s | Cifrado de sobre AES-256-GCM, KEK = HKDF(Vault `kek_v1`, `VG_KEK_PEPPER`); HMAC con pimienta solo como huella | Canónico §10.1, S05 |
| S2 | «Todo se puede conectar por MCP» | El MCP gasta tokens, no es determinista y abre la puerta a la inyección; los MCP especializados de Cloudflare están deprecados y el único vigente no tiene modo de solo lectura [verificado: https://github.com/cloudflare/mcp-server-cloudflare] | Monitoreo por REST/GraphQL; MCP solo hacia la IA del usuario (`/mcp` propio y oficiales en lectura) | Canónico §10.4, S13 |
| S3 | «Avisa en tiempo real» con solo pegar tokens | Con tokens solo se puede **sondear**: ningún proveedor empuja eventos. El canónico fija el pulso GraphQL de Cloudflare cada 5 min (cuota de 300 consultas cada 5 min por usuario o token [verificado: https://developers.cloudflare.com/analytics/graphql-api/limits/]); a Supabase solo se le pregunta (nuestro monitor lee `/health` cada minuto, S07) y sus logs se consultan con una ventana máxima de 24 h por consulta [verificado: https://supabase.com/docs/reference/api/v1-get-project-logs] | Con tokens: pulso cada 5 min (aviso en minutos). Menos de 30 s: ingesta firmada desde la app del cliente (M14) o webhook `dos_attack_l7` (M21). La UI lo dice | Canónico §2 Cloudflare, 02.5.2 |
| S4 | «Detectar ataques DDoS» | Cloudflare ya mitiga DDoS L3/L4/L7 solo; nuestro valor es explicar y avisar, no mitigar. `CF_IP_FLOOD` detecta una IP, no un ataque distribuido | Vender «te explicamos qué pasó y te llamamos»; DDoS distribuido por el webhook (P1) | Canónico §9.1, S08 |
| S5 | «Librería Node de Lighthouse» | Necesita lanzar Chrome: imposible en un Worker | PageSpeed Insights v5 (corre Lighthouse en Google); la librería queda para GitHub Actions (HR) | Canónico §15 #8, S10 |
| S6 | «Buscar CVE en cve.org según versiones» | cve.org no cruza paquete + versión; NVD sin key permite 5 peticiones / 30 s (R11 §0) y desde el 15-abr-2026 solo enriquece una parte de los CVE [verificado: https://socket.dev/blog/nist-officially-stops-enriching-most-cves] | OSV.dev `querybatch` como fuente; KEV para priorizar; cve.org solo para el texto canónico | Canónico §9.2, S09 |
| S7 | «CPU de Supabase alta → acción para neutralizar» | Con token de solo lectura no escribimos en la base del cliente | La acción sobre Supabase es un prompt o SQL para copiar; las únicas acciones ejecutables son de Cloudflare (bloquear IP, P1 Under Attack) | Canónico §10.5, S07 |
| S8 | «Funciones sin freno de tasa» se detectan con certeza | Es una heurística: un freno fuera de Postgres (Cloudflare, Upstash, gateway) da falso positivo (R03, riesgos) | Severidad con «sospecha por nombre», evidencia visible y «aceptar con motivo» (`status='ignored'` + `reason`) | Canónico §9.2 `SB_RPC_ANON_NO_LIMIT`, M31 |
| S9 | «Redundancia» de la base | Término ambiguo: copias, PITR, réplicas. Los advisors de plataforma incluyen PITR (R09 §0 punto 5); en Free no hay PITR [no verificado] | Se interpreta como «respaldo»: se muestra lo que traigan los advisors; nada más en las 36 h | S07 |
| S10 | «El usuario solo carga keys; nada más» | Vale para auditar. Las acciones necesitan un segundo token de Cloudflare; el tiempo real, la ingesta; PSI, verificar el dominio | Tres niveles visibles en Conexiones: «Auditar» (keys), «Vigilar en vivo» (ingesta), «Blindar» (token de acciones) [propuesta; lo decide S14] | S14 |

#### 02.2.4 Riesgos del producto (no de la demo; los de la demo están en canónico §12)

| Riesgo | Por qué | Mitigación de diseño |
|---|---|---|
| VanGUARD como objetivo de alto valor | Un robo de nuestra base expone tokens de todos los clientes | Tokens de solo lectura por diseño; sobre con KEK partida en dos sistemas; guardas que rechazan claves de escritura (canónico §10) |
| Falsos positivos que hunden la credibilidad | Jueces técnicos revisan con agentes | `confirmed` pesa ×1,5; heurísticas marcadas como sospecha; «sin mirar» nunca suma verde |
| Herramienta usable para atacar a terceros | Sondeos activos y PSI sobre URLs ajenas | Verificación de dominio por TXT antes de cualquier prueba activa (P1); el sondeo no baja filas ni prueba escrituras |
| Costo de IA descontrolado | Bucle o abuso del deploy público | Topes por org y globales, viewer sin IA, interruptor de dos llaves (canónico §8) |
| Ruido de internet en la víctima | Los bots escanean `/.env` y `/wp-login.php` de cualquier host nuevo; el certificado del Custom Domain aparece en los registros públicos de Certificate Transparency [no verificado: plazo exacto] | M10: ventana de alertas reales para la org de demo; fuera de ella el ruido real queda en la app como evidencia |

### 02.3 Originalidad: qué no vender como nuevo y qué sí

| Pieza | Quién ya la tiene | Cómo se presenta |
|---|---|---|
| Probar RLS con la clave pública | Vibe App Scanner, SupaExplorer, Perufitlife/supabase-security, Aikido (R15 §1) | «Como cualquier escáner, probamos; además re-probamos cada día y tras cada cambio» |
| Lints de RLS, funciones expuestas | Supabase Security Advisor (gratis) [verificado: https://supabase.com/docs/guides/database/database-advisors] | Los consumimos por API; aportamos explicación, prioridad y verificación |
| CVE de dependencias | Dependabot, Snyk, Socket, Semgrep | OSV + KEV («se explota hoy») y lenguaje para no técnicos |
| PR automático | Aikido AutoFix, Copilot Autofix | HR; el diferencial de hoy es el prompt con prueba de aceptación |
| **Regla decide, modelo redacta** | No encontrado documentado en competidores de este segmento | Argumento central de AI Security en el pitch (S01) |
| **Voz + WhatsApp en español con acción confirmable** | No encontrado | Momento central de la demo (canónico §11) |
| **Correlación entre capas y explotación en curso** | AI SRE solo para Datadog/Kubernetes | P2 en las 36 h (decisión abierta en 02.5), estrella de la hoja de ruta |

La respuesta ensayada a «¿no es esto Aikido?» está en S01 (de R15 §4.3).

### 02.4 Dominio propio y zona compartida: hallazgos nuevos

El producto (`officialvanguard.com`) y la víctima (`demo.officialvanguard.com`) viven en **la misma zona** de Cloudflare (canónico §4), y esa zona se activó en la madrugada del sábado. Contrastando con la documentación de Cloudflare (consultada hoy), salieron dos hallazgos sobre el canónico (ya resueltos en la fusión final) y cinco ajustes (Z1–Z5) que el plan no recogía.

> **Hallazgo 1 (canónico §4, paso 4) — resuelto en los hechos; queda la regla.** El canónico pedía el Custom Domain del apex «**antes** de que la zona termine de propagar», pero Cloudflare exige «an active Cloudflare zone» para añadirlo [verificado: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/]. **Estado comprobado el sábado 24 a las 02:01 (Caracas)** [verificado: DoH en `cloudflare-dns.com` y `dns.google`, y `curl` contra el borde de Cloudflare]: NS = `martin.ns.cloudflare.com` y `ziggy.ns.cloudflare.com`; el apex resuelve a IPs de Cloudflare (`104.21.53.192`, `172.67.217.242`) y sirve **200** con la página provisional «VanGUARD»; `http://` → **301** a `https://`; `www` responde **200** con la misma página (todavía no redirige al apex); `demo.officialvanguard.com` da NXDOMAIN; `/api/health` devuelve el HTML de la página, no JSON; TXT `v=spf1 -all` y `_dmarc` `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s` ya publicados. **Trampa al comprobar desde el portátil:** la caché DNS de Windows todavía daba las IPs de Squarespace (`198.185.159.x`) y `curl https://officialvanguard.com` devolvía la página «Próximamente» de Squarespace. Para ver lo que sirve Cloudflare: `ipconfig /flushdns` o `curl -sI --resolve officialvanguard.com:443:104.21.53.192 https://officialvanguard.com`. **Pendientes** (ORQUESTADOR, P0, tarea T02-01): (1) que `GET /api/health` responda `{"ok":true,...}` en JSON (canónico §7): llega solo cuando el Worker `vanguard` real reemplace la página provisional; (2) `www` → apex con la Redirect Rule 301 y el A/AAAA proxied de relleno (canónico §4; S03 03.4 paso 4). Si `www` tiene hoy un Custom Domain propio, se quita antes; (3) desplegar el producto real **en el mismo Worker que ya tiene el Custom Domain del apex**. Si la página provisional vive en otro Worker, el dominio se mueve en el panel (Domains & Routes) en el mismo minuto, sin borrar antes nada del DNS del apex; (4) declarar `routes: [{ "pattern": "officialvanguard.com", "custom_domain": true }]` y `"workers_dev": true` en `apps/api/wrangler.jsonc` (S03 03.7) para que el deploy por Actions no lo quite; (5) Custom Domain `demo.officialvanguard.com` para `vanguard-victima` (la zona ya está activa). El `*.workers.dev` sigue de respaldo en el README.

> **Hallazgo 2 (canónico §4 paso 5 frente a §11) — decidido.** El §4 pide que nuestra zona salga en verde (Always Use HTTPS activado, TLS mínimo 1.2, WAF administrado: dogfooding, P0). El §11 pide `always_use_https` **apagado en la víctima** para sembrar `CF_TLS_03` (P1). Always Use HTTPS redirige «all subdomains and hosts» de la zona [verificado: https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/] y el TLS mínimo por host exige Advanced Certificate Manager, de pago [verificado: https://developers.cloudflare.com/use-cases/solutions/encrypt-all-keep-site-secure/]. Las dos cosas no pueden ser ciertas a la vez. **Recomendación:** gana el §4 (es P0 y es el argumento de dogfooding). La auditoría de configuración de `officialvanguard.com` (`CF_DNS_*`, `CF_TLS_*`, `CF_WAF_01`) debe salir **en verde**, y el sembrado de `CF_TLS_03` se quita del guion. El rojo de la demo sale de Supabase, de Codebase y de las reglas en vivo, que sí distinguen el host porque llegan por la ingesta de la víctima. Alternativa descartada: un segundo dominio para la víctima (costo y otra propagación). S06 (06.11) y S08 (08.11) llegan a la misma conclusión. **Decisión del orquestador en la fusión final:** gana el §4; el canónico §11 y S12 12.11 ya no piden el sembrado (T02-02).

| # | Consecuencia comprobada | Efecto en la demo | Qué hacer (dueño, prioridad) |
|---|---|---|---|
| Z1 | El rate limit de Free solo admite los campos **Path** y Verified Bot en la expresión, no el host; característica fija IP, periodo y mitigación de 10 s, acción Block, 1 regla [verificado: https://developers.cloudflare.com/waf/rate-limiting-rules/] | La regla única de `/api/*` del canónico §4 también corta `demo.officialvanguard.com/api/*` | Valor único del plan, igual que S08 08.11: expresión `(http.request.uri.path contains "/api/")`, `characteristics` `["cf.colo.id","ip.src"]` (en el panel: «IP»), `requests_per_period` **400**, `period` 10, `mitigation_timeout` 10, acción `block` [propuesta]. Valor único del plan (S15 15.3, S06 06.9, S03 03.4, S08 08.11): 400/10 s deja pasar el simulacro (20 req/s = 200/10 s) y unas 40 pestañas del panel tras el mismo NAT del wifi del evento (3 consultas cada 3 s ≈ 1 req/s por pestaña). El simulacro no pide nada bajo `/api/` (usa `/`, `/login`, `/admin` y las rutas de sondeo) (ORQUESTADOR, P0, T02-03) |
| Z2 | Browser Integrity Check está **activado por defecto** y desafía user agents no estándar [verificado: https://developers.cloudflare.com/waf/tools/browser-integrity-check/]. Lo que bloquea el WAF u otra función de seguridad no llega al Worker: sus métricas no lo cuentan [verificado: https://developers.cloudflare.com/workers/observability/metrics-and-analytics/] | Si el borde desafía `sqlmap/1.8`, la víctima no ve la petición: no hay `tail()` ni ingesta, y `CF_UA_TOOL` no salta. El Free Managed Ruleset podría cortar sondas como `/.env` [no verificado] | Configuration Rule solo para la víctima: expresión `http.host eq "demo.officialvanguard.com"`, ajuste `bic: false` [verificado: https://developers.cloudflare.com/rules/configuration-rules/settings/]. Medir con la cabecera `x-vg-victima` (fragmento abajo). Si el borde sigue cortando el UA `sqlmap/1.8` (hoy lo corta con 403 y error 1010, comprobado), el simulacro usa `--ua "nikto/2.5.0"` o `python-requests/2.32`, que pasan BIC y casan `CF_UA_TOOL` (S16 16.5). Si el ruleset corta las sondas de ruta, `CF_PATH_SCAN` salta igual por `paths_4xx ≥ 20` pidiendo 25 rutas inexistentes no sensibles (`/backup-01` … `/backup-25`) (ORQUESTADOR, P0, T02-04) |
| Z3 | Una IP Access Rule se aplica a la zona entera o a toda la cuenta [verificado: https://developers.cloudflare.com/waf/tools/ip-access-rules/create/] | «Bloquear IP» sobre la víctima también corta `officialvanguard.com` para esa IP | El portátil que proyecta el panel **nunca** usa el hotspot del simulacro (lista de comprobación del guion). Cloudflare recomienda custom rules en lugar de IP Access Rules [verificado: misma fuente]; migrar a una custom rule con `http.host` queda en HR (Free: 5 custom rules [verificado: https://developers.cloudflare.com/waf/custom-rules/]) (ORQUESTADOR, P0, T02-05) |
| Z4 | Email Routing añade en el apex el TXT `v=spf1 include:_spf.mx.cloudflare.net ~all` (más 3 MX y un DKIM `cf2024-1._domainkey`), y solo puede haber un registro SPF [verificado: https://developers.cloudflare.com/email-service/configuration/domains/] | Si algún día se activa Email Routing, choca con el `v=spf1 -all` ya publicado (comprobado 02:01) | Por defecto **Email Routing apagado** (S06 06.11; S03 lo deja en P2): queda `v=spf1 -all` y el `_dmarc` existente `p=reject; sp=reject; adkim=s; aspf=s` (más estricto que el `p=quarantine` del canónico; S03 y S16 lo conservan). Si se activa: se borra `v=spf1 -all` y queda un único SPF, el de Cloudflare; el `_dmarc` no se toca. `CF_DNS_05` sale en verde en los dos casos (ORQUESTADOR, P2) |
| Z5 | Un host nuevo recibe escaneos automáticos de `/.env` y `/wp-login.php` [no verificado: frecuencia] | `CF_PATH_SCAN` (high) dispararía WhatsApp reales a cualquier hora, gastando crédito de Kapso y los topes de la org de demo | M10, ventana de alertas reales (BACK, P0) |

Fragmento para medir lo que corta el borde (ORQUESTADOR: `apps/victima` y `scripts/ataque.mjs`):

```ts
// apps/victima/src/worker.ts (el `main` de S03 03.7) — marca cada respuesta que SÍ llegó a la víctima
app.use('*', async (c, next) => { await next(); c.header('x-vg-victima', '1'); });
```

```js
// scripts/ataque.mjs — por cada petición del simulacro
const r = await fetch(url, { headers: { 'user-agent': ua }, redirect: 'manual' });
if (r.headers.get('x-vg-victima') === '1') stats.victima++;
else stats.borde[r.status] = (stats.borde[r.status] ?? 0) + 1; // 403/429/503 puestos por Cloudflare
// Hecho cuando: en 10 ensayos, stats.borde está vacío ANTES de «Bloquear IP» y solo tiene 403 DESPUÉS.
```

### 02.5 Mejoras priorizadas (35)

**Cómo leer la tabla.** Cada criterio del jurado va de 0 a 3: **O** originalidad (15 %), **A** ambición (20 %), **E** ejecución y despliegue (20 %; alto si hace más robusta la demo, bajo si la arriesga), **I** impacto (20 %), **T** aspectos técnicos (25 %). **Pond.** = (O·15 + A·20 + E·20 + I·20 + T·25) / 3, de 0 a 100 (fórmula de R15 §5). **Esf.** S < 3 h, M 3–8 h, L > 8 h de persona con un chat de IA. El **destino** respeta el canónico §2: si R15 proponía otra prioridad, manda el canónico. **Nuevo** = idea de esta sección; **†** = no figura en el canónico. Ninguna de las P0/P1 cambia contratos congelados ni enums (M27, en P2, pediría un valor de enum: ver 02.5.4). Las tres con † y destino P0 o P1 (M10, M14, M22) amplían el alcance del canónico §2, así que necesitan el visto bueno del ORQUESTADOR antes de asignarse: M10 antes de las 16:00 del sábado (toca `engine/dispatch.ts`, en la ruta crítica de las 17:30); M14 y M22 antes de las 22:00 del sábado (se construyen en el bloque P1 del domingo).

| # | Mejora o idea | Origen | O | A | E | I | T | Pond. | Esf. | Destino | Dueño | Detalle |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| M01 | Guardas de entrada: rechazar `sb_secret_`, JWT `service_role`, PAT sin `sbp_fc`, `gh[pousr]_`, Global API Key, con motivo en español | canónico §10.3 | 2 | 1 | 3 | 3 | 3 | **82** | S | P0 | BACK (+FRONT el mensaje) | S05, S06 |
| M02 | Prompt de corrección por hallazgo (IA-1) con prueba de aceptación fijada por el sistema; «Verificar arreglo» en P1 | R15 #8 | 2 | 2 | 3 | 3 | 2 | **80** | S | P0 (verificar: P1) | BACK + FRONT | S11 |
| M03 | La regla decide la alerta, la severidad y el canal; el modelo solo redacta (corrige el «cerebro de IA que analiza») | canónico §8–9 | 2 | 1 | 3 | 2 | 3 | **75** | S | P0 | BACK | S12 |
| M04 | Exportar MD/JSON redactado, evidencia marcada como dato no confiable, botón «Copiar para mi IA» | R15 #14 | 2 | 2 | 2 | 2 | 3 | **75** | S | P0 | BACK + FRONT | S13 |
| M05 | Simulacro reproducible con cronómetro (ataque → WhatsApp → llamada → bloqueo) | R15 #6 | 1 | 2 | 3 | 2 | 2 | **68** | S | P0 | ORQUESTADOR | S16 |
| M06 | «Bloquear IP»: simulación, código de un uso, ejecución idempotente y «Deshacer» | R15 #19 | 1 | 2 | 2 | 3 | 2 | **68** | M | P0 | BACK + FRONT | S08, S12 |
| M07 | Puntaje 0–100 siempre con la cobertura al lado | R15 #1 | 1 | 2 | 3 | 3 | 1 | **67** | S | P0 | BACK (`score.ts`) + FRONT | S14, S15 |
| M08 | Cifrado de sobre AES-256-GCM con KEK partida (Vault + pimienta del Worker); HMAC solo como huella | corrección S1 | 1 | 1 | 2 | 2 | 3 | **63** | M | P0 | BACK | S05 |
| M09 | Topes de IA por org y globales, escalera de degradación e interruptor de dos llaves | R07 §9.1 | 1 | 1 | 3 | 1 | 3 | **63** | M | P0 | BACK | S11 |
| M10 | **Ventana de alertas reales para la org de demo**: fuera de ella, WhatsApp y voz se registran como omitidos y el incidente queda en la app | **nuevo** † (Z5) | 1 | 1 | 3 | 2 | 2 | **62** | S | P0 | BACK | 02.5.1 |
| M11 | Modo no técnico: botones ≥ 56 px, una frase y un botón por hallazgo, guía de 4 pasos por módulo | R15 #13 | 2 | 1 | 3 | 3 | 0 | **57** | S | P0 | FRONT | S14 |
| M12 | Regresión de exposición `SB_EXPOSURE_REGRESSION` + re-auditoría diaria `0 10 * * *` (R15 la ponía en P0) | R15 #3 | 3 | 2 | 2 | 3 | 3 | **87** | M | P1 | BACK | S07 |
| M13 | Servidor `/mcp` propio de solo lectura con tokens `vgk_` | R15 #14 | 2 | 2 | 2 | 2 | 3 | **75** | M | P1 | BACK | S13 |
| M14 | **Fragmento de ingesta para copiar** (Worker o Node): hace verdad el «tiempo real» para cualquier cliente, no solo para nuestra víctima | **nuevo** † (S3) | 2 | 2 | 2 | 3 | 2 | **73** | S | P1 | FRONT (tarjeta) + BACK (prueba) | 02.5.2 |
| M15 | Sondeo activo de RLS con la clave publicable (`HEAD` + `Prefer: count=exact`, sin bajar filas) | R15 #2 | 1 | 1 | 3 | 3 | 2 | **68** | S | P1 | BACK | S07 |
| M16 | Huella HMAC para detectar la propia key del cliente en su repo (`CB_KEY_REUSE`) | R15 #16 | 3 | 1 | 2 | 1 | 3 | **67** | S | P1 | BACK | S09 |
| M17 | Verificación de propiedad del dominio por TXT (DoH) antes de PSI o sondeos activos | R15 #7 | 2 | 1 | 2 | 1 | 3 | **62** | S | P1 | BACK + FRONT | S06 |
| M18 | Rendimiento con PSI v5 (móvil y escritorio) y `PF_REGRESSION` | R15 #18 | 1 | 2 | 2 | 2 | 2 | **62** | M | P1 | BACK + FRONT | S10 |
| M19 | Prioridad de CVE con CISA KEV | R15 #20 | 1 | 1 | 3 | 2 | 2 | **62** | S | P1 | BACK | S09 |
| M20 | Registro de auditoría encadenado por hash («vigilar al vigilante») | R15 #21 | 2 | 1 | 2 | 1 | 3 | **62** | S | P1 | BACK | S06 |
| M21 | Webhook `dos_attack_l7` de Cloudflare Notifications para DDoS distribuido | R10 §5 | 1 | 2 | 2 | 2 | 2 | **62** | S | P1 | BACK | S08 |
| M22 | **Paquete para los agentes del jurado**: `/llms.txt`, sección «Evalúanos en 5 minutos» del README y nuestra zona auditada en verde (el `/.well-known/security.txt` ya es de S06, SEG-22) | **nuevo** † | 2 | 1 | 3 | 1 | 2 | **60** | S | P1 | ORQUESTADOR (texto) + FRONT (archivo en `apps/web/public`) | 02.5.3 |
| M23 | Panel «Gasto IA hoy» | R15 #22 | 2 | 1 | 2 | 1 | 2 | **53** | S | P1 | FRONT + BACK | S11 |
| M24 | Correlación entre capas (borde + base + deploy) con causa probable | R15 #4 | 3 | 3 | 2 | 2 | 3 | **87** | M | P2 (decisión abierta) | BACK | S12 |
| M25 | Exposición con explotación en curso (logs ClickHouse de Supabase) | R15 #5 | 3 | 2 | 1 | 3 | 3 | **80** | M | P2 | BACK | S07 |
| M26 | Resumen ejecutivo por voz bajo demanda («Llámame con el estado») | R15 #11 † | 2 | 2 | 2 | 3 | 2 | **73** | S | P2 | BACK | S12 |
| M27 | **Llaves en el bundle ya publicado** de dominios verificados (`CB_BUNDLE_SECRET_<ID>`) | R15 #15 † | 1 | 1 | 3 | 3 | 2 | **68** | S | P2 | BACK | 02.5.4 |
| M28 | Cuadro «qué no ves según tu plan» | R15 #10 | 3 | 1 | 3 | 2 | 1 | **63** | S | P2 | FRONT | S14 |
| M29 | Mapa de superficie (grafo coloreado por riesgo) | R15 #24 | 2 | 2 | 2 | 2 | 1 | **58** | M | P2 | FRONT | S14 |
| M30 | Reputación de IP (Spamhaus DROP, salidas de Tor) que sube la severidad | R10 §8 | 1 | 1 | 2 | 2 | 2 | **55** | S | P2 | BACK | S08 |
| M31 | **Huella de aceptación**: un hallazgo `ignored` vuelve a abrirse si la función cambia | R03, **nuevo** † | 1 | 1 | 2 | 2 | 2 | **55** | S | P2 | BACK | 02.5.5 |
| M32 | Mapa a OWASP Top 10:2025 y CWE en el export y en el prompt | R15 #12 † | 0 | 1 | 3 | 1 | 2 | **50** | S | P2 | BACK | 02.5.5 |
| M33 | PR automático de corrección (GitHub App con `contents:write`, aparte de la de lectura) | R15 #9 | 1 | 3 | 1 | 2 | 3 | **70** | L | HR | — | 02.7 |
| M34 | Guardia de migraciones para el CI del cliente (falla el PR si crea tabla sin RLS) | R15 #23 † | 1 | 2 | 2 | 2 | 3 | **70** | M | HR | — | 02.7 |
| M35 | Línea base adaptativa (EWMA por ruta) en lugar de umbrales fijos | R15 #17 † | 1 | 2 | 1 | 1 | 3 | **57** | M | HR | — | 02.7 |

**Lectura.** El núcleo P0 (M01–M11) es casi todo S y protege la demo. El salto técnico y original (M12, M24, M25) puntúa más alto, pero el canónico deja M24 y M25 en P2 porque arriesgan la ejecución. M12 es la P1 mejor puntuada; en el bloque P1 del domingo (S16 #18) va **después** de la auditoría de configuración de Cloudflare, que el cierre del pitch necesita para mostrar nuestra zona en verde. Si no se llega, se cuenta como hoja de ruta, tal como ya hace el guion (canónico §11, 2:40–3:00).

> **Decisión abierta (Giovanni, sáb 19:00) — canónico §2, «correlación entre capas» en P2.** M24 es, con M12, la idea mejor puntuada y la que ningún competidor muestra (R15 §4.1, hueco 1). Una versión mínima no añade reglas ni cambia severidades: cuando `vg_upsert_incident` devuelve `is_new = true` en un incidente de borde, guardar en `incidents.details.contexto` lo que ya tenemos en ese minuto, es decir, las muestras de salud de Supabase (`sb_service_ok` con `labels.service` = `db`/`rest` en `metric_samples`, S15 15.7) y el último commit del repo conectado (`GET /repos/{o}/{r}/commits?per_page=1`, que cubre el permiso Contents: Read-only del PAT). Solo el SHA corto de 7 caracteres. La tarjeta del incidente diría: «En ese minuto: Supabase sano; último commit `a1b2c3d` hace 2 h». Esfuerzo S y, si algo falla, se omite. Dos detalles: (1) `vg_upsert_incident` de S15 15.12 ya conserva `details.contexto` al renovar `details` (resuelto en la fusión final); (2) si el esquema zod de `Incident.details` es estricto, el ORQUESTADOR añade `contexto` como campo **opcional** (permitido tras la congelación). **Se sigue el canónico (P2)**. Recomendación al ORQUESTADOR: si el núcleo de la demo sale de punta a punta en el ensayo de las 19:00 del sábado, subirla a P1 **antes de la congelación de las 22:00** para hacerla el domingo a las 07:00 (T02-10).

```ts
// apps/api/src/engine/incidents.ts (BACK, solo si M24 sube a P1) — contexto de Supabase; db = cliente admin (lib/db.ts)
const desde = new Date(Date.parse(inc.started_at) - 5 * 60_000).toISOString();
const { data: salud } = await db.from('metric_samples').select('metric, value, labels, ts')
  .eq('org_id', ctx.orgId).eq('metric', 'sb_service_ok').in('labels->>service', ['db', 'rest'])   // nombres de S15 15.7
  .gte('ts', desde).lte('ts', inc.started_at).order('ts', { ascending: false }).limit(4);
```

#### 02.5.1 M10 · Ventana de alertas reales para la org de demo (P0, BACK)

Desde que la víctima publica su certificado, internet la escanea sola (Z5). Sin ventana, cada sonda a `/.env` dispara un WhatsApp real (`CF_PATH_SCAN`, high) y agota los topes de la org de demo (6 llamadas y 30 WhatsApp por hora, canónico §9.3) antes del pitch. Fuera de la ventana el incidente se abre igual: el jurado ve tráfico hostil **real** en la app, lo que suma como evidencia.

- Clave nueva en `app_config` (no cambia el esquema; casa el `check` `^[a-z_]{2,40}$` de S05): `demo_alertas_hasta` = cadena ISO UTC en jsonb. Si falta, la ventana está cerrada. Solo afecta a la org con `is_demo = true` (la única, índice `orgs_one_demo` de S05), que es la dueña de las conexiones de la víctima.
- Dónde: en el despachador `apps/api/src/engine/dispatch.ts` (S15 15.1), justo antes de llamar a `planNotifications` de `packages/core/src/rules/notify-plan.ts` (S15 15.9). No hace falta tocar la función pura: con topes 0, ella misma marca cada envío `skipped_cap: true`.

```ts
// apps/api/src/engine/dispatch.ts (BACK) — leerConfig = el helper de app_config que ya use el BACK (null si no existe)
const hasta = org.is_demo ? await leerConfig<string>(env, 'demo_alertas_hasta') : null;
const fueraDeVentana = org.is_demo && !(hasta !== null && Date.now() < Date.parse(hasta));
const plan = planNotifications(inc, contactos, used1h, fueraDeVentana ? { whatsapp: 0, voice: 0 } : capsDeLaOrg, tormenta);
// Cada Planned con skipped_cap se guarda en notifications con status 'skipped_cap' (enum sin cambios) y, si
// fueraDeVentana, error = 'fuera_de_ventana_demo'. No se llama a Kapso ni a ElevenLabs. El in-app no cambia.
```

- `used1h` **no** cuenta las filas `skipped_cap` (S15 15.9 ya usa `status not in ('failed','skipped_cap')`): si las contara, el ruido omitido de la noche agotaría los 30 WhatsApp/h de la org de demo y, al abrir la ventana, el aviso real también saldría `skipped_cap`.
- `POST /api/orgs/:org/notifications/test` no pasa por el despachador ni mira la ventana (es una prueba explícita de un admin).
- El ORQUESTADOR abre la ventana antes de cada ensayo y del pitch y cierra los incidentes abiertos. El `resolved_at` se **atrasa 11 minutos** a propósito: `vg_upsert_incident` reabre **sin llamada** un incidente resuelto hace menos de 10 min (S12 12.3, S15 15.9). Como el hotspot del simulacro suele conservar la IP entre ensayos, un `resolved_at = now()` dejaría el siguiente ensayo sin su llamada.

```sql
insert into public.app_config (key, value)
values ('demo_alertas_hasta', to_jsonb(to_char((now() + interval '45 minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
on conflict (key) do update set value = excluded.value, updated_at = now();
update public.incidents set status = 'resolved', resolved_at = now() - interval '11 minutes'
where org_id in (select id from public.orgs where is_demo) and status <> 'resolved';
-- Cerrar la ventana al terminar: delete from public.app_config where key = 'demo_alertas_hasta';
```

**Hecho cuando:** (1) con la ventana cerrada, `curl https://demo.officialvanguard.com/.env` abre un incidente `CF_PATH_SCAN` en la app y su fila de WhatsApp en `notifications` queda en `skipped_cap` con `error = 'fuera_de_ventana_demo'`; (2) tras correr el SQL de arriba (que resuelve ese incidente con el `resolved_at` atrasado), el mismo `curl` abre un incidente nuevo y llega el WhatsApp.

#### 02.5.2 M14 · Fragmento de ingesta para cualquier app (P1, FRONT + BACK)

Hoy solo nuestra víctima manda eventos firmados. Con este fragmento, cualquier cliente con un Worker obtiene las reglas en vivo de canónico §9.1 sin cambiar el contrato: `POST /ingest/v1/events` (E30 de S15: cuerpo ≤ 64 KB, ventana de ±300 s), cabeceras `x-vg-conn`, `x-vg-ts`, `x-vg-sig` = hex(HMAC-SHA256(secreto, `${ts}.${cuerpo}`)), lote de 1 a 100 `EdgeEvent` (canónico §7). El FRONT lo muestra tal cual en el panel que ya abre la tarjeta «Tu app (ingesta)» tras el `201` (S14, fila «Tu app (ingesta)»), junto al secreto `vgi_…` (que se ve una sola vez), al `connection.id`, al endpoint y a las cabeceras. El texto vive en `apps/web/src/modulos/conexiones/fragmento-ingesta.ts`.

```ts
// Pegar en el Worker de tu app. Secreto VG_INGEST_SECRET y vars VG_INGEST_CONN_ID y VG_INGEST_URL (nombres del catálogo de S03 03.6).
interface Env { VG_INGEST_SECRET: string; VG_INGEST_CONN_ID: string; VG_INGEST_URL: string }  // URL: https://officialvanguard.com/ingest/v1/events
const te = new TextEncoder();

async function firmar(secreto: string, ts: string, cuerpo: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', te.encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, te.encode(`${ts}.${cuerpo}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function conVanguard<E extends Env>(h: ExportedHandler<E>): ExportedHandler<E> {
  return { ...h, async fetch(req, env, ctx) {
    const t0 = Date.now();
    const res = await h.fetch!(req, env, ctx);
    const ip = req.headers.get('cf-connecting-ip');
    if (!ip) return res;                                               // sin IP (p. ej. wrangler dev): no se envía; edge_hits.ip es inet
    const ev = { ts: new Date(t0).toISOString(), ip,
      method: req.method.slice(0, 10), path: new URL(req.url).pathname.slice(0, 300), status: res.status, // sin query
      ua: (req.headers.get('user-agent') ?? '').slice(0, 200), latency_ms: Date.now() - t0,
      auth: req.headers.has('authorization') };                       // ajústalo a cómo autentica tu app
    const cuerpo = JSON.stringify({ events: [ev] });
    const ts = String(Math.floor(Date.now() / 1000));
    ctx.waitUntil(firmar(env.VG_INGEST_SECRET, ts, cuerpo)
      .then((sig) => fetch(env.VG_INGEST_URL, { method: 'POST', body: cuerpo, headers: { 'content-type': 'application/json',
        'x-vg-conn': env.VG_INGEST_CONN_ID, 'x-vg-ts': ts, 'x-vg-sig': sig } }))
      .catch(() => {}));                                               // nunca rompe la respuesta de tu app
    return res;
  } };
}
// Uso: export default conVanguard({ async fetch(req, env, ctx) { /* tu app */ return new Response('ok'); } });
```

- Pestaña Node (Express, Hono): mismo cuerpo y cabeceras, firma con ``createHmac('sha256', process.env.VG_INGEST_SECRET!).update(`${ts}.${cuerpo}`).digest('hex')`` de `node:crypto`.
- BACK añade un caso a `apps/api/src/rutas/ingest.test.ts` (pruebas junto a cada archivo, S15 15.1, con `app.request()` de Hono): copia la función `firmar` del fragmento (el BACK no importa nada de `apps/web`), comprueba que da el mismo hex que `createHmac` y que la ruta responde `202` con esa firma.
- Límite honesto, escrito en la tarjeta: un evento por petición equivale a una invocación nuestra por petición del cliente. Sirve para tráfico bajo o medio; la versión por lotes con Tail Worker queda en HR.

#### 02.5.3 M22 · Paquete para los agentes del jurado (P1, ORQUESTADOR + FRONT)

Los jueces revisan con agentes: se les da un mapa legible por máquina. Archivo estático en `apps/web/public/` (Vite copia `public/` «to the root of the dist directory as-is» [verificado: https://vite.dev/guide/assets]); `/llms.txt` no casa ningún patrón de `run_worker_first` (ni siquiera el `"/.*"` que añade S06 SEG-04, porque no empieza por punto), así que se sirve como asset sin invocar el Worker.

`apps/web/public/llms.txt` (formato de llmstxt.org: H1 obligatorio, resumen en cita, secciones H2 con enlaces [verificado: https://llmstxt.org/]). Los enlaces apuntan al repo de la organización, que es el que recibe el jurado (`git remote` del repo; el espejo personal solo despliega):

```markdown
# VanGUARD

> Panel de seguridad para startups sobre Supabase, Cloudflare y GitHub. Audita el ecosistema con un botón, detecta ataques en vivo y avisa por WhatsApp y llamada. Un motor de reglas decide las alertas; Claude solo explica y redacta prompts de corrección. Las integraciones son de solo lectura salvo «Bloquear IP», que exige confirmación.

- Producto: https://officialvanguard.com (botón «Ver demo»: rol viewer, sin gasto de IA)
- Salud: https://officialvanguard.com/api/health
- `demo.officialvanguard.com` es nuestra app víctima, sembrada con fallas simuladas y secretos falsos.

## Documentación
- [README](https://github.com/platanus-hack/platanus-hack-26-ve-team-22/blob/main/README.md): qué hace y cómo evaluarlo en 5 minutos
- [ARQUITECTURA](https://github.com/platanus-hack/platanus-hack-26-ve-team-22/blob/main/ARQUITECTURA.md): Worker único, cola, Workflow, Supabase
- [SECURITY](https://github.com/platanus-hack/platanus-hack-26-ve-team-22/blob/main/SECURITY.md): cifrado de sobre, guardas de claves, topes de IA
- [THREAT_MODEL](https://github.com/platanus-hack/platanus-hack-26-ve-team-22/blob/main/THREAT_MODEL.md): amenazas y mitigaciones

## Optional
- [Descripción del proyecto](https://github.com/platanus-hack/platanus-hack-26-ve-team-22/blob/main/project-description.md)
```

- **`security.txt` no se duplica aquí:** lo define S06 06.11 (P1 · FRONT, `apps/web/public/.well-known/security.txt`, `Contact` a los avisos de seguridad del repo, sin Email Routing) y lo comprueba la prueba J26 de S06. Un dato para S06: RFC 9116 exige `Contact` y `Expires` y recomienda que `Expires` quede a menos de un año, así que S06 ya usa `Expires: 2027-04-25T12:00:00.000Z` [verificado: https://www.rfc-editor.org/rfc/rfc9116].
- **Hecho cuando:** `curl -s https://officialvanguard.com/llms.txt` empieza por `# VanGUARD` y `curl -sI https://officialvanguard.com/llms.txt` da `200` con `content-type: text/plain` (si diera `text/html`, el archivo no llegó a `dist/` y lo está sirviendo el respaldo de la SPA).
- README, sección «Evalúanos en 5 minutos»: (1) «Ver demo»; (2) Resumen con puntaje y cobertura; (3) un hallazgo crítico y su prompt (en caché); (4) Incidentes con la línea de tiempo del último simulacro; (5) Exportar Markdown; (6) Cloudflare: nuestra zona `officialvanguard.com` en verde; (7) dónde mirar el código: `packages/core/src/rules/`, `packages/core/src/crypto.ts`, `supabase/tests/rls.sql` (rutas de S15 15.1).

#### 02.5.4 M27 · Llaves en el bundle publicado (P2, BACK)

Hueco real: la revocación automática de Supabase cubre GitHub público, no el JavaScript ya publicado [verificado: https://supabase.com/blog/supabase-security-2025-retro] (caso Moltbook, R15 §2). Solo sobre dominios verificados (M17); reutiliza las regex de `CB_SECRET_*`.

```ts
// packages/core/src/secrets/bundle.ts — nunca guarda el valor encontrado
export async function scriptsDelMismoOrigen(dominio: string): Promise<string[]> {
  const base = new URL(`https://${dominio}/`);
  const r = await fetch(base, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  if (r.status >= 300) return [];                                           // un 3xx se aborta: no seguimos a otros hosts
  const html = (await r.text()).slice(0, 2_000_000);
  return [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
    .filter((m) => URL.canParse(m[1], base))                                // un src roto no tumba el paso
    .map((m) => new URL(m[1], base))
    .filter((u) => u.protocol === 'https:' && u.hostname === base.hostname)
    .slice(0, 30).map((u) => u.origin + u.pathname);                          // sin query ni fragmento
}
// Por script: mismo timeout, cortar a 5 MB, pasar las regex de CB_SECRET_* (secrets/rules.ts). Hallazgo: module 'codebase',
// rule_id `CB_BUNDLE_SECRET_${id}` (id en mayúsculas, como CB_SECRET_SUPABASE_SERVICE_ROLE), evidence con la forma de
// S09 (`CodebaseEvidence`): {fuente:'bundle', path:<URL del script>, preview (4+4), fingerprint_short}. La huella completa
// solo entra en el dedupe_key (S09). Un JWT con role 'anon' es info. Si se construye, el ORQUESTADOR añade 'bundle' al
// enum `CodebaseEvidence.fuente` (hoy 'github' | 'zip').
```

#### 02.5.5 M31 y M32 · Huella de aceptación y mapa OWASP (P2, BACK)

- **M31:** a la SQL 3 del canónico §9.2 (o a la 3b de S07 07.5.4, si se aprueba) se le agrega la columna `md5(p.prosrc) as cuerpo_md5`, y el `dedupe_input` del `FindingDraft` de `SB_RPC_ANON_NO_LIMIT` (S15 15.9) pasa de `esquema.funcion` a `esquema.funcion|cuerpo_md5`. El `resource` que ve el usuario no cambia y `dedupeKey()` de `core/crypto.ts` tampoco. Si el dueño marcó `ignored` y luego cambia la función, la clave cambia, `vg_upsert_findings` inserta una fila nueva `open` y la vieja queda `ignored` como historial. `pg_proc` se puede leer con cualquier rol en Postgres estándar; que `supabase_read_only_user` reciba `prosrc` por el endpoint read-only está [no verificado] (R03, riesgos). Si no lo recibe, se queda el `dedupe_input` actual.
- **M32:** un mapa estático, sin columna nueva, que usan el export (M04) y el prompt (M02). Categorías de la lista oficial [verificado: https://top10.owasp.org/2025]; la asignación es [propuesta]:

```ts
// packages/core/src/rules/owasp.ts — se resuelve por rule_id exacto o por prefijo
export const OWASP_2025: Array<[prefijo: string, categoria: string]> = [
  ['SB_RLS_DISABLED', 'A01:2025 Broken Access Control'], ['SB_POLICY_ALLOW_ALL', 'A01:2025 Broken Access Control'],
  ['CF_ADMIN_EXPOSED', 'A01:2025 Broken Access Control'], ['CB_ENV_COMMITTED', 'A02:2025 Security Misconfiguration'],
  ['CB_GITIGNORE_NO_ENV', 'A02:2025 Security Misconfiguration'], ['CF_WAF_', 'A02:2025 Security Misconfiguration'],
  ['CB_DEP_VULN', 'A03:2025 Software Supply Chain Failures'], ['CF_TLS_', 'A04:2025 Cryptographic Failures'],
  ['SB_RPC_ANON_NO_LIMIT', 'A06:2025 Insecure Design'], ['CB_SECRET_', 'A07:2025 Authentication Failures'],
  ['CB_BUNDLE_SECRET_', 'A07:2025 Authentication Failures'], ['CB_KEY_REUSE', 'A07:2025 Authentication Failures'],
  ['SB_ADVISOR_RLS_DISABLED_IN_PUBLIC', 'A01:2025 Broken Access Control'],   // rule_id de S07 07.5.1 (nombre del lint en mayúsculas)
];
export const owaspDe = (ruleId: string) => OWASP_2025.find(([p]) => ruleId.startsWith(p))?.[1] ?? null;
```

### 02.6 Tareas que salen de esta sección

Las tareas de las mejoras que ya están en el canónico viven en su sección (columna «Detalle» de 02.5). Aquí solo las nuevas o las que resuelven los hallazgos de 02.4.

| ID | Tarea | Prio | Dueño | Hecho cuando |
|---|---|---|---|---|
| T02-01 | Cerrar el dominio (Hallazgo 1; el «primer deploy sin routes» ya no aplica porque la zona está activa): la zona ya está activa y el apex sirve la página provisional (02:01). Falta que `/api/health` dé JSON, `www` → 301 al apex, Custom Domain de `demo.`, `routes` + `workers_dev: true` en `wrangler.jsonc`, y desplegar el producto en el Worker que ya tiene el apex sin borrar antes el DNS | P0 | ORQUESTADOR | `curl -s https://officialvanguard.com/api/health` → JSON con `"ok":true`; `curl -sI "https://www.officialvanguard.com/x?y=1"` → 301 a `https://officialvanguard.com/x?y=1`; `curl -sI https://demo.officialvanguard.com` → 200; `https://vanguard.<subdominio>.workers.dev/api/health` → 200. Comprobar tras `ipconfig /flushdns` (trampa de la caché local, Hallazgo 1) |
| T02-02 | Zona compartida (Hallazgo 2, decidido): quitar el sembrado de `CF_TLS_03` de `demo/guion.md` y dejar `always_use_https` en `on` | P0 (la auditoría en verde, P1) | ORQUESTADOR | P0: `GET /zones/{zone_id}/settings/always_use_https` → `"value":"on"`. P1, cuando exista la auditoría de configuración (domingo): ningún hallazgo `CF_DNS_*`/`CF_TLS_*`/`CF_WAF_01` sobre `officialvanguard.com`, salvo `CF_TLS_04` mientras HSTS no esté activo (S06 06.11) |
| T02-03 | Regla de rate limit de Free (Z1): `http.request.uri.path contains "/api/"`, 400 peticiones / 10 s por IP, `block` 10 s; el simulacro no pide nada bajo `/api/` | P0 | ORQUESTADOR | 10 ensayos sin 429 de Cloudflare antes de «Bloquear IP» |
| T02-04 | Configuration Rule `bic: false` para `http.host eq "demo.officialvanguard.com"`; cabecera `x-vg-victima` en la víctima y contador de borde en `scripts/ataque.mjs` (Z2) | P0 | ORQUESTADOR | `stats.borde` vacío antes del bloqueo y solo 403 después |
| T02-05 | Lista de comprobación del guion: portátil del panel fuera del hotspot (Z3), regla de bloqueo anterior borrada, y el SQL de 02.5.1 (abre la ventana M10 y resuelve con `resolved_at` atrasado) antes de cada ensayo y del pitch | P0 | ORQUESTADOR | La lista está en `demo/guion.md` y se usa en los 3 ensayos seguidos; en los 3, la llamada suena |
| T02-06 | M10: ventana de alertas reales en `engine/dispatch.ts` y `used1h` sin las filas `skipped_cap` | P0 | BACK | Las dos pruebas del «Hecho cuando» de 02.5.1 en verde |
| T02-07 | M14: fragmento de ingesta en el panel de la tarjeta «Tu app (ingesta)» (pestañas Worker y Node) + prueba de firma | P1 | FRONT + BACK | `pnpm test` en verde con el caso del fragmento en `apps/api/src/rutas/ingest.test.ts`; el texto copiado del panel funciona contra producción (`202`) |
| T02-08 | M22: `llms.txt` y sección «Evalúanos en 5 minutos» del README (el `security.txt` es SEG-22 de S06) | P1 | ORQUESTADOR (texto) + FRONT (archivo) | Los dos `curl` de 02.5.3 pasan |
| T02-09 | Email Routing, solo si se decide activarlo: un único SPF (Z4) | P2 | ORQUESTADOR | `curl -s "https://cloudflare-dns.com/dns-query?name=officialvanguard.com&type=TXT" -H "accept: application/dns-json"` muestra un único `v=spf1` |
| T02-10 | M24 mínima (contexto del incidente): el ORQUESTADOR decide subirla a P1 tras el ensayo de las 19:00 y antes de las 22:00 del sábado; si sube, se hace el domingo 07:00 | P2 → P1 condicional | BACK | La tarjeta del incidente muestra la salud de Supabase y el último commit, y siguen ahí tras 10 eventos más del mismo incidente |
| T02-11 | Textos públicos honestos: «panel de seguridad» y no «CRM»; tiempo real = pulso de 5 min con tokens o menos de 30 s con ingesta; «Lighthouse vía PageSpeed Insights» en `project-description.md` (hoy dice «mediciones con Lighthouse», promete «tiempos de compilación y errores por versión», que es hoja de ruta, y «vigila en tiempo real» sin matiz; además le falta decir que corre en Cloudflare con dominio propio, S16 16.9). El jsonc no se toca (canónico §1) | P1 | ORQUESTADOR | README, `project-description.md` y pitch sin «CRM» ni promesas de tiempo real sin ingesta |
| T02-12 | M27, M31, M32, solo si el ORQUESTADOR las sube antes de las 22:00 del sábado; si no, quedan como hoja de ruta | P2 | BACK | Pruebas de `packages/core` en verde |

### 02.7 Hoja de ruta posterior al hackatón

**Criterio de entrada para cualquier proveedor nuevo:** (1) token de solo lectura con alcance; (2) API determinista para monitorear, sin MCP en el bucle; (3) al menos una acción reversible con confirmación. Si falta (3), el proveedor entra solo como fuente de hallazgos.

```mermaid
flowchart LR
  subgraph H1["Semanas 1 a 4"]
    A1["Cerrar P2 del plan"] --> A2["GitHub App de solo lectura"] --> A3["OAuth Conectar con Supabase"] --> A4["Ingesta por lotes con Tail Worker"]
  end
  subgraph H2["Meses 2 y 3"]
    B1["Proveedor Vercel"] --> B2["Correlación C1 a C4 y explotación en curso"] --> B3["PR automático y guardia de CI"]
  end
  subgraph H3["Meses 4 a 6"]
    C1["Más proveedores"] --> C2["MCP con OAuth 2.1"] --> C3["Línea base adaptativa"]
  end
  H1 --> H2 --> H3
```

| Horizonte | Entregable | Qué hace falta | Estado del dato |
|---|---|---|---|
| Semanas 1–4 | GitHub App de solo lectura (token de 1 h acotado a un repo) en lugar del PAT | Registro de la App, JWT, verificación del `installation_id` | R11 §1.3 |
| Semanas 1–4 | OAuth «Conectar con Supabase» en lugar de pegar el PAT | App OAuth de Supabase con alcances de lectura | R09 §1.2 |
| Semanas 1–4 | Bloqueo con custom rule acotada por `http.host` en lugar de IP Access Rule (Z3) | Permiso de escritura de reglas; 5 custom rules en Free | [verificado: https://developers.cloudflare.com/waf/custom-rules/] |
| Semanas 1–4 | Ingesta por lotes con Tail Worker del cliente (menos invocaciones que M14) | Tail Worker que agrupa y firma | Tamaño de lote [no verificado] |
| Semanas 1–4 | Plantilla de WhatsApp aprobada por Meta; Telegram y correo | Aprobación de Meta; canales P1 del enum | R14 |
| Semanas 1–4 | Catálogo SQL completo (R02–R04), EPSS, deps.dev, endoflife.date, SARIF 2.1.0 | Lo descrito en R11 y R02–R04 | Endpoint de subida de SARIF [no verificado] |
| Meses 2–3 | **Proveedor `vercel`** (ya reservado en el enum `provider`): tiempos de build y errores por deployment; user agents insistentes e IPs con muchas llamadas desde los logs de runtime; acción propuesta «Attack Challenge Mode» | Deployments API (R13 §7.2); logs de runtime; Attack Challenge Mode es gratis en todos los planes | [verificado: https://vercel.com/kb/attack-challenge-mode]; BotID [verificado: https://vercel.com/docs/botid]; endpoint para activarlo por API y retención de logs en Hobby [no verificado] |
| Meses 2–3 | Correlación completa C1–C4 (M24) y explotación en curso (M25) | Pulso de Cloudflare guardado por minuto + logs ClickHouse de Supabase | Columnas del esquema ClickHouse [no verificado] (R15 §6.4) |
| Meses 2–3 | PR automático de un solo tipo (M33): `.env*` a `.gitignore` y migración que activa RLS | GitHub App aparte con `contents:write` y `pull_requests:write` | R15 §6.14 |
| Meses 2–3 | Guardia de migraciones como GitHub Action (M34) y Lighthouse en Actions (3 corridas, mediana, tiempos de build) | Action publicada; vía B de R13 §9 | R13 |
| Meses 4–6 | Más proveedores según demanda (Netlify, Render, Railway, Firebase, AWS) | Pasar el criterio de entrada | Ninguno investigado [no verificado] |
| Meses 4–6 | `/mcp` con OAuth 2.1 para claude.ai y otros clientes; Batch nocturno (−50 %) para re-auditorías | Servidor de autorización; Batches API | Descuento de Batch [verificado: https://platform.claude.com/docs/en/about-claude/pricing, vía canónico §8] |
| Meses 4–6 | Línea base adaptativa por ruta (M35), editor de prompts con núcleo fijo y versiones (R07 §9.2), miembros, invitaciones y facturación | 24 h o más de datos por ruta; tablas de R07 | [propuesta] |

### 02.8 Qué no hacer en las 36 horas

- Vender como novedad la prueba con la clave pública, el lint de RLS, el escaneo de CVE o el PR automático (02.3).
- Probar escrituras o ejecutar RPC en la base de un cliente; los permisos de escritura se infieren por SQL (R15 §6.1).
- Prometer métricas de CPU y RAM si el PAT con alcance no trae el permiso de analytics: se muestra «sin métricas de servidor» en la cobertura (canónico §10.2).
- Sembrar fallas de configuración **de zona** en la víctima mientras comparta zona con el producto (Hallazgo 2).
- Borrar registros DNS del apex o de `www`, o soltar el Custom Domain del apex, sin tener ya listo el Worker que lo reemplaza: hoy el validador recibe 200 en `https://officialvanguard.com` (Hallazgo 1).
- Dejar que la org de demo mande WhatsApp o llamadas reales fuera de una ventana abierta a mano (M10).
- Pagar Cloudflare Pro para la zona: el canónico asume Free y nada del P0 lo necesita.
- Añadir alcance después de las 22:00 del sábado, aunque sea una mejora de esta lista.
