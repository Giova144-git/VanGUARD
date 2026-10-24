# R10 - Cloudflare para monitorear la cuenta de un cliente (estado 2026)

Investigacion web, etapa 1 del plan maestro. Fecha de consulta: 24 oct 2026. Equipo team-22, Platanus Hack 26.

Convenciones:
- `[verificado: URL]`: comprobado hoy en la doc oficial o en la fuente citada.
- `[verificado en KUADRA: ruta]`: comprobado en produccion por el CRM KUADRA contra una zona Free real (codigo leido en solo lectura).
- `[no verificado]`: no lo pude comprobar; probar antes de depender de ello.
- `[propuesta]`: decision o umbral nuestro, no es un dato externo.

KUADRA de referencia: `C:\Users\giova\Desktop\KUADRA\KUADRA CRM\kuadra_crm\lib\nucleo\cloudflare_api.dart` (en adelante `KUADRA/cloudflare_api.dart`).

---

## 0. Lo esencial en 10 lineas

1. Todo sale de dos APIs con el mismo token Bearer: REST `https://api.cloudflare.com/client/v4/...` y GraphQL `POST https://api.cloudflare.com/client/v4/graphql`.
2. `httpRequestsAdaptiveGroups`, `httpRequestsAdaptive` y `firewallEventsAdaptive` estan disponibles en todos los planes, incluido Free [verificado: https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/]. Retencion de 31 dias en todos los planes para Security Events [verificado: https://developers.cloudflare.com/waf/analytics/security-events/].
3. En Free la ventana maxima por consulta es de 1 dia: Cloudflare rechaza ventanas "wider than 1d" [verificado en KUADRA: cloudflare_api.dart, linea 474, medido el 2026-08-29]. Hay que consultar en tramos de 24 h y guardar lo leido en Supabase, porque lo que sale de la ventana no vuelve.
4. El limite real se descubre en tiempo de ejecucion con el nodo `settings` de GraphQL (`maxDuration`, `notOlderThan`, `maxPageSize`, `availableFields`). Lo hacemos al conectar la zona y lo guardamos.
5. Cuota GraphQL: 300 consultas cada 5 minutos por usuario o token. Cada alias o nodo cuenta como una consulta [verificado: https://developers.cloudflare.com/analytics/graphql-api/limits/]. REST: 1.200 peticiones cada 5 minutos por usuario. Si se pasa, todo queda bloqueado 5 minutos con HTTP 429 [verificado: https://developers.cloudflare.com/fundamentals/api/reference/limits/].
6. Hay cuatro acciones de neutralizacion que funcionan en Free: bloquear IP (IP Access Rules), Under Attack (`security_level=under_attack`), una regla de rate limit (Free: 1 regla, periodo de 10 s, mitigacion de 10 s) y hasta 5 reglas custom del WAF (por ejemplo, contra un user agent).
7. Push en tiempo real gratis: los webhooks de Notifications existen en todos los planes, y la alerta "HTTP DDoS Attack Alert" tambien [verificado: https://developers.cloudflare.com/notifications/get-started/configure-webhooks/ y https://developers.cloudflare.com/notifications/notification-available/].
8. MCP: los servidores `graphql`, `observability`, `radar`, `auditlogs` y `dns-analytics` estan **deprecados**. Cloudflare pide migrar al servidor unico `https://mcp.cloudflare.com/mcp`, que expone `search`, `execute`, `docs` y `whoami` en Code Mode [verificado: https://github.com/cloudflare/mcp-server-cloudflare]. No tiene modo de solo lectura: lo que puede hacer lo decide el token.
9. Auditoria: Cloudflare ya trae "Security Insights" (registros sin proxy, TLS viejo, sin Always Use HTTPS, sin HSTS, sin reglas administradas), con API, en todos los planes y con escaneo semanal en Free. Nosotros hacemos los mismos chequeos al momento y lo usamos como contraste.
10. Reputacion de IP gratis: AbuseIPDB (1.000 consultas al dia), Spamhaus DROP (gratis incluso comercial, maximo una descarga por hora), lista de salidas Tor, Radar `entities/ip` (ASN y pais; licencia CC BY-NC 4.0, ojo con el uso comercial).

---

## 1. Conexion del cliente: token, zona, plan y permisos

### 1.1 Que token pedir

- **Token de usuario o token de cuenta.** Los tokens de cuenta funcionan como "service principals" y estan pensados para integraciones que deben sobrevivir a la salida de la persona que las configuro. No soportan, entre otros, Super Bot Fight Mode ni Intel Data Platform [verificado: https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/].
- **[propuesta]** Aceptar los dos tipos. En la guia recomendamos un token de usuario "Custom" limitado a la zona, porque cualquier miembro lo puede crear. Crear un token de cuenta exige rol de Super Administrator o el permiso de provisionar tokens (misma URL).
- **Dos tokens separados [propuesta]:**
  - **Token de lectura** (obligatorio): lo usan el monitoreo, la auditoria y el MCP.
  - **Token de acciones** (opcional, "Modo blindaje"): solo para neutralizar. Va cifrado aparte y nunca se le entrega al MCP ni al modelo.
- No ponerle al token filtro por IP de cliente si se va a usar con el MCP oficial, porque el MCP no lo soporta [verificado: https://github.com/cloudflare/mcp]. Para llamadas directas desde nuestro backend, el filtro solo sirve si tenemos IP de salida fija. En Vercel no la tenemos, salvo pagando aparte [no verificado].

### 1.2 Permisos minimos

Nombres de permisos [verificado: https://developers.cloudflare.com/fundamentals/api/reference/permissions/]. La referencia de la API lista sobre todo permisos de cuenta para rulesets e IP Access Rules. Para los mismos endpoints a nivel de zona, KUADRA usa "Firewall Services" [verificado en KUADRA: `lib/categorias/tecnologia/base_datos/backup/exportar_backend.dart`, lineas 937-949], y guias de terceros usan "Zone WAF" [no verificado en doc oficial]. Por eso el token de lectura lleva los dos.

**Token de lectura**

| Ambito | Permiso | Para que (endpoint) | Estado |
|---|---|---|---|
| Zone | Zone Read | `GET /zones`, `GET /zones/{id}` | [verificado: https://developers.cloudflare.com/api/resources/zones/methods/list/] |
| Zone | Zone Settings Read | `GET /zones/{id}/settings/{setting}` | [verificado: https://developers.cloudflare.com/api/resources/zones/subresources/settings/methods/get/] |
| Zone | DNS Read | `GET /zones/{id}/dns_records` | [verificado: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/] |
| Zone | Analytics Read | GraphQL `viewer.zones(...)` | nombre [verificado: permissions]; uso [verificado en KUADRA] |
| Account | Account Analytics Read | GraphQL con alcance de cuenta | [verificado: https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/] |
| Zone | Firewall Services Read | `GET /zones/{id}/firewall/access_rules/rules`, `GET /zones/{id}/rulesets` | [verificado en KUADRA] |
| Zone | Zone WAF Read | `GET /zones/{id}/rulesets/phases/{fase}/entrypoint` | [no verificado] |
| Zone | Bot Management Read | `GET /zones/{id}/bot_management` | [verificado: https://developers.cloudflare.com/api/resources/bot_management/methods/get/] |
| Account | Account Settings Read (opcional) | `GET /accounts/{id}/logs/audit` (audit logs v2) | [verificado: https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/] |

**Token de acciones** (se suma al de lectura; mismas zonas)

| Accion | Permiso | Estado |
|---|---|---|
| Under Attack, Always Use HTTPS, TLS minimo, modo SSL | Zone Settings Write | [verificado: https://developers.cloudflare.com/api/resources/zones/subresources/settings/methods/edit/] |
| Bloquear o desafiar una IP en la zona | Firewall Services Write | [verificado en KUADRA]; doc oficial solo lista "Account Firewall Access Rules Write" (alcance de cuenta) [verificado: https://developers.cloudflare.com/api/resources/firewall/subresources/access_rules/methods/create/] |
| Regla custom WAF o de rate limit | Zone WAF Write | [no verificado: la referencia lista "Account WAF Write" y "Account Rulesets Write"] |
| Bot Fight Mode | Bot Management Write | [verificado: https://developers.cloudflare.com/api/resources/bot_management/methods/update/] |
| Crear webhook y politica de alertas (opcional) | Notifications Write (cuenta) | [verificado: https://developers.cloudflare.com/api/resources/alerting/subresources/destinations/subresources/webhooks/methods/create/] |

**Regla de oro [propuesta, patron KUADRA]:** al conectar se hace un **sondeo** (un GET por permiso, con `per_page=1`) y cada 403 se traduce a "te falta el permiso X". Asi no dependemos de que la documentacion acierte con el nombre exacto.

### 1.3 Llamadas de conexion (en este orden)

```http
GET /client/v4/user/tokens/verify
Authorization: Bearer <TOKEN>
-> {"result":{"id":"...","status":"active","expires_on":"..."},"success":true}
```
`status` puede ser `active`, `disabled` o `expired` [verificado: https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/]. Para los tokens de cuenta, esta pagina no documenta otra ruta de verificacion [no verificado]. En ese caso basta con el `GET /zones` siguiente.

```http
GET /client/v4/zones?per_page=50&status=active
-> result[]: id, name, status, paused, type, account{id,name}, plan{legacy_id,name,...}, meta{...}
```
- `per_page` va de 5 a 50 [verificado: https://developers.cloudflare.com/api/resources/zones/methods/list/].
- `plan` esta marcado como deprecado pero sigue en la respuesta (misma URL). Lo usamos para saber si la zona es Free o Pro. Los valores exactos de `legacy_id` (`free`, `pro`...) estan [no verificado]. Si falla, el plan se infiere de `settings` (punto 2.2).
- `paused=true` significa que la zona solo usa el DNS, sin proteccion. Es un hallazgo critico (punto 6).

Sondeo de permisos [propuesta]:
```
GET /zones/{z}/dns_records?per_page=1                       -> DNS Read
GET /zones/{z}/settings/ssl                                 -> Zone Settings Read
GET /zones/{z}/firewall/access_rules/rules?per_page=5       -> Firewall Services Read
GET /zones/{z}/rulesets/phases/http_request_firewall_custom/entrypoint -> WAF Read (404 = sin reglas, no es falta de permiso)
GET /zones/{z}/bot_management                               -> Bot Management Read
POST /graphql  { viewer { zones(filter:{zoneTag:"z"}) { settings { httpRequestsAdaptiveGroups { enabled } } } } } -> Analytics Read
```

---

## 2. GraphQL Analytics API

### 2.1 Forma de la peticion y cuotas

- `POST https://api.cloudflare.com/client/v4/graphql`, con `Authorization: Bearer <TOKEN>`, `Content-Type: application/json` y cuerpo `{"query": "...", "variables": {...}}` [verificado: https://developers.cloudflare.com/analytics/graphql-api/getting-started/querying-basics/].
- Los errores llegan con HTTP 200 y `errors[]` no vacio. Un 502 llega como HTML [verificado en KUADRA: cloudflare_api.dart, lineas 436-449]. Siempre se mira `errors` antes que `data`.
- Formato de fecha: ISO UTC **sin milisegundos** (`2026-10-24T05:00:00Z`). KUADRA lo dejo asi porque el filtro de fechas es quisquilloso [verificado en KUADRA: lineas 453-457].
- Por consulta: hasta 10 zonas con alcance de zona, o 1 cuenta. Total de consultas por peticion = alcances x nodos. Cuota por defecto: 300 consultas cada 5 minutos [verificado: https://developers.cloudflare.com/analytics/graphql-api/limits/]. Otra pagina oficial habla de "un maximo de 320 cada 5 minutos, segun el costo" [verificado: https://developers.cloudflare.com/fundamentals/api/reference/limits/]. **Disenar para 150 como maximo (la mitad).**
- Operadores de filtro: `_gt`, `_geq`, `_lt`, `_leq`, `_neq`, `_in`, `_like` (con `%`), `_has` y `OR`/`AND`. El filtro de zonas solo acepta `zoneTag`, `zoneTag_gt` o `zoneTag_in`. No hay subconsultas [verificado: https://developers.cloudflare.com/analytics/graphql-api/features/filtering/].
- Orden: `orderBy: [count_DESC]`, `[datetime_DESC]`, `[datetimeHour_ASC]` [verificado en KUADRA].

### 2.2 Descubrir limites por zona (se ejecuta al conectar y cada 24 h)

```graphql
query Limites($zoneTag: string) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      settings {
        httpRequestsAdaptiveGroups { enabled maxDuration maxNumberOfFields maxPageSize notOlderThan availableFields }
        httpRequestsAdaptive       { enabled maxDuration maxPageSize notOlderThan }
        firewallEventsAdaptive     { enabled maxDuration maxPageSize notOlderThan }
        firewallEventsAdaptiveGroups { enabled maxDuration notOlderThan }
        httpRequests1hGroups       { enabled maxDuration notOlderThan }
        httpRequests1dGroups       { enabled maxDuration notOlderThan }
      }
    }
  }
}
```
Los campos y su significado (`maxDuration` y `notOlderThan` en segundos, `availableFields` como rutas tipo `sum_requests`) estan [verificado: https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/]. La respuesta de ejemplo de la doc trae `firewallEventsAdaptive: maxDuration 259200 (3 d), maxNumberOfFields 30, maxPageSize 10000, notOlderThan 2678400 (31 d)`, pero no dice de que plan es. **[propuesta]** Guardarlo en `cf_zona_limites` y que cada consulta recorte su ventana a `maxDuration`. Si `availableFields` no trae `dimensions_clientIP`, se usa el plan B del punto 2.5.

### 2.3 Disponibilidad y retencion

| Dataset | Que trae | Free | Retencion | Ventana por consulta |
|---|---|---|---|---|
| `httpRequestsAdaptiveGroups` | Agregados de trafico (count, sum, avg) por dimensiones | Si [verificado: settings] | 31 d en Free, Pro y Business; 90 d en Enterprise (Security Analytics) [verificado: security-events] | 1 d en planes estandar [no verificado oficialmente; reportado por terceros en https://mcpservers.org/servers/github-com-urdigitalau-mcp-integrations-tree-main-packages-cloudflare] |
| `httpRequestsAdaptive` | Peticion por peticion (muestreada) | Si; no trae `rayName`, referer ni bot score [verificado en KUADRA: lineas 637-642] | 31 d (igual que la fila anterior) | Tramos de 24 h [verificado en KUADRA] |
| `firewallEventsAdaptive` | Eventos de seguridad uno a uno (WAF, rate limit, IP rules, BFM...) | Si; el dashboard Free solo muestra "sampled logs" [verificado: security-events] | 31 d en todos los planes [verificado: security-events] | Dashboard: 30 d. GraphQL en Free: **1 d** [verificado en KUADRA: linea 474] |
| `firewallEventsAdaptiveGroups` | Agregados de eventos de seguridad | En Free lo reportan inaccesible [no verificado] | - | - |
| `httpRequests1dGroups` | Totales diarios (requests, bytes, threats, uniques) | Si [verificado en KUADRA: lineas 808-847, 7 dias] | [no verificado] | - |
| `httpRequests1hGroups` | Totales por hora | Si [no verificado] | Unas 73 h segun terceros [no verificado] | - |

**Muestreo:** los nodos `Adaptive` se muestrean con mas fuerza cuanto mas volumen hay, y con poco volumen pueden no muestrearse [verificado: https://developers.cloudflare.com/analytics/graphql-api/sampling/]. En el ejemplo oficial de intervalos de confianza, `count` = 42939 coincide con `confidence.count.estimate` = 42939, con `sampleSize` = 40054 y `avg.sampleInterval` = 1.072. O sea, **`count` ya viene extrapolado** (inferido del ejemplo) [verificado: https://developers.cloudflare.com/analytics/graphql-api/features/confidence-intervals/]. Para cifras que se muestran en una alerta, pedir:
```graphql
confidence(level: 0.95) { count { estimate lower upper sampleSize } }
```
y avisar "estimado" si `avg.sampleInterval > 1`.

### 2.4 Consultas exactas del monitoreo

Variables comunes: `{"zoneTag":"<ZONE_ID>","desde":"2026-10-24T05:00:00Z","hasta":"2026-10-24T05:05:00Z"}`.

**Q1. Pulso de 5 minutos: totales, acciones de seguridad, top user agents, top rutas y 5xx (una peticion, 5 nodos = 5 consultas de cuota)**
```graphql
query Pulso($zoneTag: string, $desde: Time, $hasta: Time) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      total: httpRequestsAdaptiveGroups(limit: 1, filter: { datetime_geq: $desde, datetime_leq: $hasta }) {
        count  avg { sampleInterval }  sum { edgeResponseBytes visits }
      }
      porAccion: httpRequestsAdaptiveGroups(limit: 12, orderBy: [count_DESC], filter: { datetime_geq: $desde, datetime_leq: $hasta }) {
        count  dimensions { securityAction }
      }
      porAgente: httpRequestsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: { datetime_geq: $desde, datetime_leq: $hasta, securityAction: "unknown" }) {
        count  dimensions { userAgent }
      }
      porRuta: httpRequestsAdaptiveGroups(limit: 15, orderBy: [count_DESC], filter: { datetime_geq: $desde, datetime_leq: $hasta }) {
        count  dimensions { clientRequestHTTPHost clientRequestPath edgeResponseStatus }
      }
      errores5xx: httpRequestsAdaptiveGroups(limit: 12, orderBy: [count_DESC], filter: { datetime_geq: $desde, datetime_leq: $hasta, edgeResponseStatus_geq: 500 }) {
        count  dimensions { cacheStatus coloCode }
      }
    }
  }
}
```
- Las dimensiones `securityAction`, `userAgent`, `clientRequestPath`, `clientRequestHTTPHost`, `edgeResponseStatus`, `cacheStatus`, `coloCode`, `clientCountryName` y `datetimeHour`, los filtros `securityAction: "unknown"` y `edgeResponseStatus_geq: 500` y las metricas `sum { edgeResponseBytes visits }` y `avg { sampleInterval }` funcionan en Free [verificado en KUADRA: lineas 544-588 y 697-740].
- Si el cliente usa Workers, conviene anadir `requestSource: "eyeball"` (solo trafico de usuarios finales) **a todos los alias por igual**, para que los porcentajes cuadren. Ese filtro aparece en un ejemplo oficial [verificado: https://developers.cloudflare.com/analytics/graphql-api/migration-guides/graphql-api-analytics/].
- `securityAction: "unknown"` significa que el borde no aplico ninguna accion de seguridad a la peticion [verificado en KUADRA: lineas 540-543].
- Leccion de KUADRA: cortar los 5xx por `cacheStatus` separa "falla el origen" (`miss`) de "falla el borde". Asi se descubrio un 504 en 1 de cada 5 cargas que ninguna alarma habia avisado [verificado en KUADRA: lineas 677-696].

**Q2. Top IPs del trafico (la senal de "IPs con muchas llamadas")**
```graphql
query TopIPs($zoneTag: string, $desde: Time, $hasta: Time) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      topIPs: httpRequestsAdaptiveGroups(limit: 20, orderBy: [count_DESC], filter: { datetime_geq: $desde, datetime_leq: $hasta }) {
        count
        dimensions { clientIP clientAsn clientASNDescription clientCountryName }
      }
    }
  }
}
```
`clientIP` como **dimension** de `httpRequestsAdaptiveGroups` esta [no verificado]: la doc no lo lista y KUADRA solo lo uso en los nodos crudos. Antes de depender de ello, mirar si `availableFields` (punto 2.2) contiene `dimensions_clientIP`, o probar la introspeccion `__type(name: "ZoneHttpRequestsAdaptiveGroupsDimensions")` [verificado (nombre del tipo, sintaxis): https://developers.cloudflare.com/analytics/graphql-api/features/discovery/introspection/].

**Q2-B (plan B si Q2 falla). Agregar en nuestro backend desde el nodo crudo:**
```graphql
query Crudo($zoneTag: string, $desde: Time, $hasta: Time, $limite: uint64) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptive(limit: $limite, orderBy: [datetime_DESC], filter: { datetime_geq: $desde, datetime_leq: $hasta }) {
        datetime clientIP clientCountryName clientRequestHTTPHost clientRequestPath
        clientRequestHTTPMethodName edgeResponseStatus cacheStatus userAgent clientDeviceType
      }
    }
  }
}
```
Campos [verificado en KUADRA: lineas 648-666]. `$limite` debe ser <= `maxPageSize` (ejemplo oficial: 10000). Es una muestra, asi que el conteo por IP se multiplica por `sampleInterval` de Q1. El tipo `uint64` de `$limite` esta [no verificado]: interpolar el numero como hace KUADRA es lo mas seguro.

**Q3. Eventos de seguridad uno a uno (bloqueos, desafios, rate limit, IP rules)**
```graphql
query Eventos($zoneTag: string, $desde: Time, $hasta: Time) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      firewallEventsAdaptive(limit: 1000, orderBy: [datetime_DESC], filter: { datetime_geq: $desde, datetime_leq: $hasta }) {
        action datetime rayName matchIndex ruleId description source
        clientIP clientCountryName clientAsn clientASNDescription
        clientRequestHTTPHost clientRequestPath clientRequestQuery
        clientRequestHTTPMethodName clientRequestScheme edgeResponseStatus userAgent
      }
    }
  }
}
```
Campos [verificado en KUADRA: lineas 482-499]. La ventana debe ser de 24 h o menos en Free. **Deduplicar por `rayName` + `matchIndex`** al archivar (KUADRA archiva y deduplica en la base: `crm_cloudflare_archivar`). Ejemplo de fila oficial: `{"action":"log","clientAsn":"5089","clientCountryName":"GB","clientIP":"203.0.113.69","clientRequestPath":"/%3Cscript%3E...","datetime":"2020-04-24T10:11:24Z","source":"waf"}` [verificado: https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-firewall-events/]. Si se pide un tramo mas viejo que la retencion, el error es `cannot request data older than 2678400s` (misma URL).

**Q4. Serie de 7 dias para la linea base (una vez por hora)**
```graphql
query Serie7d($zoneTag: string, $desdeFecha: Date) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequests1dGroups(limit: 7, orderBy: [date_ASC], filter: { date_gt: $desdeFecha }) {
        dimensions { date }  sum { requests bytes threats }  uniq { uniques }
      }
    }
  }
}
```
[verificado en KUADRA: lineas 815-831]. La linea base por hora y por minuto se arma con lo que vamos guardando de Q1, no con Cloudflare.

### 2.5 Detectores del motor de reglas (decide la regla, no el modelo)

Todos los umbrales son [propuesta] y hay que calibrarlos en la demo. Ventana base: 5 min. Se evaluan con la salida de Q1, Q2 (o Q2-B) y Q3 mas la historia guardada en Supabase.

| ID | Senal | Condicion de disparo | Severidad | Accion propuesta |
|---|---|---|---|---|
| CF-IP-FLOOD | Una IP con muchas llamadas | `count(ip) >= max(300, 10 x mediana por IP)` en 5 min **y** `count(ip)/total >= 0,20` | Alta | Bloquear la IP (4.1); si hay muchas IPs del mismo ASN, una regla custom por `ip.src.asnum` [no verificado en Free] |
| CF-UA-TOOL | User agent de herramienta | UA vacio o que contiene `sqlmap`, `nikto`, `nmap`, `masscan`, `zgrab`, `nuclei`, `wpscan`, `python-requests`, `Go-http-client`, `curl/`, `aiohttp`, `Scrapy`, `HeadlessChrome`, con `count >= 200` en 5 min | Media (alta si es un escaner) | Regla custom `managed_challenge` o `block` por UA (4.3) |
| CF-UA-INSISTENTE | UA insistente | Un UA con `>= 30 %` del trafico no mitigado y `>= 5x` su media de 7 dias | Media | Desafio por UA |
| CF-SPIKE | Pico de trafico (posible DDoS L7) | `total_5min >= 3 x p95(mismos 5 min de los ultimos 7 dias)` **y** `total_5min >= 5.000` | Alta | Proponer Under Attack (4.2) con reversion a los 30 min |
| CF-ORIGIN-5XX | El origen se cae | `errores5xx/total >= 0,05` con `total >= 200`, o 5xx de `cacheStatus=miss >= 20 %` | Alta | Avisar; no hay accion de Cloudflare que lo arregle. Revisar el origen (Supabase/Vercel) |
| CF-SCAN-404 | Escaneo de rutas | Una IP con `>= 50` respuestas 404 en 5 min, o rutas como `/.env`, `/.git/config`, `/wp-login.php`, `/phpmyadmin`, `/server-status` | Media | Bloquear la IP |
| CF-WAF-HITS | Una IP que el WAF ya frena | `>= 20` eventos de Q3 de la misma IP en 5 min | Baja (Cloudflare ya actua) | Informar; ofrecer convertirlo en bloqueo permanente |
| CF-LOGIN-BRUTE | Fuerza bruta | `>= 100` POST a la ruta de login en 5 min (desde 1 IP o desde muchas) | Alta | Regla de rate limit en esa ruta (4.4) |

Notas:
- Una IP de Cloudflare, de un bot verificado o de un webhook conocido (Stripe, GitHub, Kapso...) nunca se bloquea sin confirmacion. Se mantiene una lista de IPs y ASN permitidos por cliente [propuesta].
- En una zona con poco trafico (la demo), los minimos absolutos (300, 5.000) se bajan con un factor por zona que se guarda en ajustes [propuesta].

### 2.6 Fragmento TypeScript portable (Node 20+, sin dependencias)

```ts
// cf.ts - cliente minimo de Cloudflare para el backend (Edge Function o route handler).
const CF = 'https://api.cloudflare.com/client/v4';

export class CfError extends Error {
  constructor(public status: number, public code: string, msg: string) { super(msg); }
}

/** ISO UTC sin milisegundos: el formato verificado por KUADRA. */
export const cfIso = (d: Date) => d.toISOString().split('.')[0] + 'Z';

async function cfFetch(token: string, path: string, init: RequestInit = {}, intento = 1): Promise<any> {
  const r = await fetch(CF + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status === 429) {
    // Cloudflare bloquea 5 min. Respetar retry-after; no insistir en bucle.
    const espera = Number(r.headers.get('retry-after') ?? '60');
    throw new CfError(429, 'rate_limited', `Cloudflare pide esperar ${espera}s`);
  }
  let json: any;
  try { json = await r.json(); } catch { throw new CfError(r.status, 'no_json', `Cloudflare respondio ${r.status} sin JSON`); }
  if (r.status === 403) throw new CfError(403, 'permiso', json?.errors?.[0]?.message ?? 'Falta permiso');
  if (r.status >= 500 && intento < 3) return cfFetch(token, path, init, intento + 1);
  return json;
}

export async function cfRest<T = any>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const j = await cfFetch(token, path, { method, body: body ? JSON.stringify(body) : undefined });
  if (j?.success !== true) {
    const e = j?.errors?.[0];
    throw new CfError(400, String(e?.code ?? 'cf'), e?.message ?? 'Cloudflare rechazo la peticion');
  }
  return j.result as T;
}

export async function cfGraphql<T = any>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const j = await cfFetch(token, '/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (Array.isArray(j?.errors) && j.errors.length) {
    const m = String(j.errors[0]?.message ?? '');
    // "wider than 1d" / "older than": ventana mal recortada -> volver a leer settings.
    throw new CfError(400, /wider than|older than/.test(m) ? 'ventana' : 'graphql', m);
  }
  return j.data as T;
}

/** Parte [desde, hasta] en tramos <= maxDurationSec (24 h en Free). */
export function tramos(desde: Date, hasta: Date, maxDurationSec = 86_400): Array<[Date, Date]> {
  const out: Array<[Date, Date]> = [];
  for (let a = desde.getTime(); a < hasta.getTime(); a += maxDurationSec * 1000) {
    out.push([new Date(a), new Date(Math.min(a + maxDurationSec * 1000, hasta.getTime()))]);
  }
  return out;
}
```

### 2.7 Presupuesto de cuota por cliente [propuesta]

| Tarea | Frecuencia | Consultas GraphQL / 5 min | REST / 5 min |
|---|---|---|---|
| Q1 Pulso (5 nodos) | cada 60 s | 25 | 0 |
| Q2 o Q2-B Top IPs | cada 60 s | 5 | 0 |
| Q3 Eventos (tramo incremental desde el ultimo `datetime` leido) | cada 120 s | 2,5 | 0 |
| Q4 Serie 7 d | cada hora | 0,1 | 0 |
| Auditoria de configuracion (punto 6) | cada 6 h y bajo demanda | 0 | unas 15 por pasada |
| **Total** | | **unas 33 de 300** | **menos de 20 de 1.200** |

La cuota es por usuario o token [verificado: limits]. Cada cliente usa su propio token, asi que los clientes no se reparten la cuota entre si. El riesgo es que el cliente use el mismo token en otras herramientas.

---

## 3. REST: inventario y configuracion (solo lectura)

Base `https://api.cloudflare.com/client/v4`. Respuesta estandar: `{success, errors[], messages[], result, result_info?}`.

| Que | Llamada exacta | Campos que usamos | Fuente |
|---|---|---|---|
| Zona | `GET /zones/{z}` | `status`, `paused`, `type`, `plan`, `name_servers`, `development_mode` | [verificado: https://developers.cloudflare.com/api/resources/zones/methods/list/] |
| DNS | `GET /zones/{z}/dns_records?per_page=1000&page=1` (filtros opcionales `type=A`, `proxied=false`, `match=all`) | `id`, `name`, `type`, `content`, `proxied`, `proxiable`, `ttl`, `comment` | [verificado: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/] (`content` solo aparece expandido en una variante de la doc; KUADRA lo lee) |
| Un ajuste | `GET /zones/{z}/settings/{id}` -> `{"result":{"id":"always_use_https","value":"on","editable":true,"modified_on":"..."}}` | `value`, `editable` | [verificado: https://developers.cloudflare.com/api/resources/zones/subresources/settings/methods/get/] |
| Todos los ajustes | `GET /zones/{z}/settings` | lista de `{id, value}` | [verificado en KUADRA: exportar_backend.dart, linea 940]; la referencia vigente no lo muestra en lo que lei [no verificado] |
| Modo SSL automatico | `GET /zones/{z}/settings/ssl_automatic_mode` -> `value: auto` o `custom` | si es `auto`, Cloudflare decide el modo SSL | [verificado: https://developers.cloudflare.com/api/resources/ssl/subresources/automatic_upgrader/methods/patch/] |
| Reglas custom WAF | `GET /zones/{z}/rulesets/phases/http_request_firewall_custom/entrypoint` (404 = ninguna) | `result.id`, `rules[]{id, action, expression, description, enabled}` | [verificado: https://developers.cloudflare.com/api/resources/rulesets/subresources/phases/methods/get/] |
| Rate limit | `GET /zones/{z}/rulesets/phases/http_ratelimit/entrypoint` | `rules[].ratelimit{characteristics, period, requests_per_period, mitigation_timeout}` | misma URL |
| Reglas administradas | `GET /zones/{z}/rulesets/phases/http_request_firewall_managed/entrypoint` | regla con `action: "execute"` = ruleset desplegado | misma URL |
| Super Bot Fight Mode | `GET /zones/{z}/rulesets/phases/http_request_sbfm/entrypoint` | Pro y superiores | fase listada en la misma URL; uso [no verificado] |
| IP Access Rules | `GET /zones/{z}/firewall/access_rules/rules?per_page=100&order=mode&direction=desc` | `id`, `mode`, `configuration{target,value}`, `notes`, `created_on` | [verificado: https://developers.cloudflare.com/api/resources/firewall/subresources/access_rules/methods/list/]; ruta de zona [verificado en KUADRA: linea 386] |
| Bots | `GET /zones/{z}/bot_management` | `fight_mode`, `enable_js`, `ai_bots_protection`, `sbfm_*` | [verificado: https://developers.cloudflare.com/api/resources/bot_management/methods/get/] |
| Insights de Cloudflare | `GET /zones/{z}/security-center/insights?dismissed=false&per_page=100` | `issue_type`, `issue_class`, `severity` (`Low`, `Moderate`, `Critical`), `subject`, `resolve_text`, `resolve_link` | [verificado: https://developers.cloudflare.com/api/resources/security_center/subresources/insights/methods/list/]; permiso no documentado [no verificado] |
| Rangos IP de Cloudflare | `GET /ips` -> `ipv4_cidrs[]`, `ipv6_cidrs[]`, `etag` | para "solo aceptar trafico de Cloudflare en el origen" | [verificado: https://developers.cloudflare.com/api/resources/ips/methods/list/] |
| Audit logs | `GET /accounts/{a}/logs/audit?since=2026-10-23&before=2026-10-24` | quien cambio que (incluidas nuestras acciones). Retencion de 18 meses | [verificado: https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/] |

Valores posibles de cada ajuste [verificado: https://developers.cloudflare.com/api/resources/zones/subresources/settings/methods/get/]:
- `ssl`: `off`, `flexible`, `full`, `strict`
- `min_tls_version`: `"1.0"`, `"1.1"`, `"1.2"`, `"1.3"`
- `security_level`: `off`, `essentially_off`, `low`, `medium`, `high`, `under_attack`
- `always_use_https`, `automatic_https_rewrites`, `opportunistic_encryption`, `browser_check`, `0rtt`, `http3`, `waf`: `on` u `off`
- `tls_1_3`: `on`, `off`, `zrt`
- `security_header`: `{strict_transport_security:{enabled, max_age, include_subdomains, preload, nosniff}}`

Ojo: el nivel de seguridad ya casi no hace nada. El threat score ahora "siempre es 0", y en la API y en Terraform `security_level` sirve sobre todo para encender o apagar Under Attack [verificado: https://developers.cloudflare.com/waf/tools/security-level/]. No auditar `low`/`medium`/`high` como hallazgo.

---

## 4. Acciones de neutralizacion (llamadas exactas)

Se ejecutan solo con el token de acciones, tras confirmar en WhatsApp o en la app con un codigo de un solo uso (decision de `parte5-decisiones-y-plan.md`). Cada accion: (1) lee el estado previo, (2) actua, (3) guarda `regla_id` y el estado previo en `acciones_cf` para deshacer, (4) anota en nuestra auditoria y (5) escribe en `notes`/`description` la marca `"<Producto> #<id_accion>"`.

### 4.1 Bloquear o desafiar una IP (todos los planes)
```http
POST /zones/{z}/firewall/access_rules/rules
{"mode":"block","configuration":{"target":"ip","value":"203.0.113.7"},"notes":"Blindaje #a1b2 - CF-IP-FLOOD"}
-> result.id = "92f17202ed8bd63d69a66b86a49a8f6b"
DELETE /zones/{z}/firewall/access_rules/rules/{id}     (deshacer)
```
- `mode` puede ser `block`, `challenge`, `whitelist`, `js_challenge` o `managed_challenge`.
- `target` puede ser `ip`, `ip6`, `ip_range` (IPv4 /16 o /24; IPv6 /32, /48 o /64), `asn` o `country` [verificado: https://developers.cloudflare.com/api/resources/firewall/subresources/access_rules/methods/create/].
- El tope es de 50.000 reglas por cuenta en Free, Pro y Business. Bloquear por pais solo existe en Enterprise. Una regla `whitelist` se salta las reglas custom y el rate limit, pero no las reglas administradas [verificado: https://developers.cloudflare.com/waf/tools/ip-access-rules/].
- Ruta de zona y cuerpo con `ip`/`ip6` [verificado en KUADRA: lineas 397-421].
- Para un riesgo dudoso, preferir `managed_challenge` a `block` [propuesta].

### 4.2 Activar o desactivar Under Attack
```http
GET   /zones/{z}/settings/security_level                 -> guardar value previo
PATCH /zones/{z}/settings/security_level  {"value":"under_attack"}
PATCH /zones/{z}/settings/security_level  {"value":"<previo>"}   (deshacer; programar a los 30 min [propuesta])
```
Metodo, ruta y permiso Zone Settings Write [verificado: https://developers.cloudflare.com/api/resources/zones/subresources/settings/methods/edit/]. Under Attack muestra un Managed Challenge a todo visitante [verificado: https://developers.cloudflare.com/waf/tools/security-level/]. Rompe llamadas de API y apps moviles, asi que en la alerta se avisa del costo. Para encenderlo solo en una parte del dominio, Cloudflare indica usar una configuration rule (misma URL).

### 4.3 Regla custom del WAF (bloquear o desafiar un user agent, una ruta o un ASN)
```http
GET  /zones/{z}/rulesets/phases/http_request_firewall_custom/entrypoint
  200 -> POST /zones/{z}/rulesets/{ruleset_id}/rules
         {"description":"Blindaje #a1b2 UA sqlmap","expression":"(http.user_agent contains \"sqlmap\")","action":"block"}
  404 -> PUT  /zones/{z}/rulesets/phases/http_request_firewall_custom/entrypoint
         {"rules":[{ ...la misma regla... }]}
DELETE /zones/{z}/rulesets/{ruleset_id}/rules/{rule_id}          (deshacer)
```
- El flujo GET, luego POST o creacion, y el formato `{description, expression, action}` estan [verificado: https://developers.cloudflare.com/waf/custom-rules/create-api/].
- `PUT .../phases/{fase}/entrypoint` [verificado: https://developers.cloudflare.com/ruleset-engine/rulesets-api/endpoints/].
- La ruta de DELETE de una regla esta [no verificado; documentada en una subpagina que no lei].
- Limites [verificado: https://developers.cloudflare.com/waf/custom-rules/]: Free 5 reglas, Pro 20, Business 100. **Sin regex en Free ni en Pro** (nada de `matches`; usar `contains`, `eq`, `in`). Todas las acciones menos `log` fuera de Enterprise.
- Que `http.user_agent` este disponible en Free no lo confirma su pagina [no verificado]. Probar en la demo.
- Antes de crear una regla, contar las existentes. Si ya hay 5, ofrecer editar una nuestra (PATCH) en vez de crear otra [propuesta].

### 4.4 Regla de rate limit
```http
GET  /zones/{z}/rulesets/phases/http_ratelimit/entrypoint
  200 -> POST /zones/{z}/rulesets/{ruleset_id}/rules   (o PATCH de la nuestra si ya se uso la unica regla de Free)
  404 -> POST /zones/{z}/rulesets  {"name":"default","kind":"zone","phase":"http_ratelimit","rules":[ ... ]}
Regla para Free:
{"description":"Blindaje #a1b2 login","expression":"(http.request.uri.path eq \"/api/login\")","action":"block",
 "ratelimit":{"characteristics":["cf.colo.id","ip.src"],"period":10,"requests_per_period":20,"mitigation_timeout":10}}
```
- Flujo y forma del cuerpo; el ejemplo oficial usa `period:60`, `requests_per_period:100`, `mitigation_timeout:600` y `characteristics:["cf.colo.id","ip.src"]`. Las reglas de rate limit van al final de la lista [verificado: https://developers.cloudflare.com/waf/rate-limiting-rules/create-api/].
- El cuerpo `{"name","kind","phase"}` para crear el ruleset esta [no verificado; la pagina solo dice "POST /zones/$ZONE_ID/rulesets con la regla en rules"].
- Limites [verificado: https://developers.cloudflare.com/waf/rate-limiting-rules/]:

| Plan | Reglas | Cuenta por | Periodo | Mitigacion | Campos en la expresion |
|---|---|---|---|---|---|
| Free | 1 | IP | 10 s | 10 s | Path, Verified Bot |
| Pro | 2 | IP | hasta 1 min | hasta 1 h | Host, URI, Path, Full URI, Query, Verified Bot |
| Business | 5 | IP, IP con NAT | hasta 10 min | hasta 1 dia | lo anterior, mas Method, Source IP y User Agent |

En Free no se puede filtrar por metodo: la regla de login cuenta GET y POST a la ruta.

### 4.5 Bot Fight Mode
```http
PUT /zones/{z}/bot_management   {"fight_mode": true}
```
Ruta y permiso [verificado: https://developers.cloudflare.com/api/resources/bot_management/methods/update/]. El cuerpo lo arme con los campos del esquema [no verificado como ejemplo oficial]. **Riesgo:** Bot Fight Mode no se puede saltar con reglas custom y puede desafiar trafico de API y de apps moviles [verificado: https://developers.cloudflare.com/bots/get-started/bot-fight-mode/]. Solo se propone, nunca es automatico; y nunca en zonas que sirven APIs de webhooks.

### 4.6 Correcciones de configuracion (desde la auditoria, con confirmacion)
```http
PATCH /zones/{z}/settings/always_use_https   {"value":"on"}
PATCH /zones/{z}/settings/min_tls_version    {"value":"1.2"}
PATCH /zones/{z}/settings/ssl                {"value":"strict"}   <- solo si el origen tiene un certificado valido; si no, la web cae con error 526 [no verificado el codigo]
```
Si `ssl_automatic_mode` = `auto`, cambiar `ssl` a mano puede chocar con el modo automatico. Para fijarlo a mano, Cloudflare documenta `PATCH /zones/{z}/settings/ssl_automatic_mode {"value":"custom"}` [verificado: https://developers.cloudflare.com/api/resources/ssl/subresources/automatic_upgrader/methods/patch/].

---

## 5. Push en tiempo real desde Cloudflare (complementa al sondeo)

- Hay webhooks en todos los planes, Free incluido. Cloudflare manda nuestro secreto en la cabecera `cf-webhook-auth` y hay que rechazar la peticion si no coincide. El cuerpo generico es JSON con `text` [verificado: https://developers.cloudflare.com/notifications/get-started/configure-webhooks/].
- Que alertas puede usar cada plan [verificado: https://developers.cloudflare.com/notifications/notification-available/]:
  - Todos los planes: **HTTP DDoS Attack Alert** (`dos_attack_l7`) y Universal SSL Alert (`universal_ssl_event_type`).
  - Pro y superiores: Health Checks (`health_check_status_notification`).
  - Business y superiores: Security Events Alert.
  - Solo Enterprise: Origin Error Rate (`http_alert_origin_error`) y Traffic Anomalies (`traffic_anomalies_alert`).
- Alta por API (necesita Notifications Write; si no, el usuario lo hace a mano en el dashboard con nuestra URL y el secreto):
```http
POST /accounts/{a}/alerting/v3/destinations/webhooks  {"name":"Blindaje","url":"https://<app>/api/cf/webhook/<cliente>","secret":"<32+ bytes aleatorios>"}
-> result.id
POST /accounts/{a}/alerting/v3/policies
{"name":"Blindaje DDoS L7","alert_type":"dos_attack_l7","enabled":true,"mechanisms":{"webhooks":[{"id":"<id>"}]},"filters":{"zones":["<zone_id>"]}}
```
Rutas, campos y valores de `alert_type` [verificado: https://developers.cloudflare.com/api/resources/alerting/subresources/destinations/subresources/webhooks/methods/create/ y https://developers.cloudflare.com/api/resources/alerting/subresources/policies/methods/create/]. La forma exacta de `filters.zones` y el esquema completo del payload de la alerta DDoS estan [no verificado]: guardar el cuerpo crudo y parsearlo de forma tolerante.
- **[propuesta]** El webhook DDoS dispara la misma tuberia que CF-SPIKE (motor de reglas, WhatsApp y llamada). Es la senal mas creible de la demo, porque viene de Cloudflare y no de una heuristica nuestra.

---

## 6. Auditoria de configuracion (boton "Auditar todo")

Fuente: REST del punto 3. Se cruza con Security Insights. Cloudflare detecta, entre otros, registros A/AAAA/CNAME sin proxy ("origen expuesto"), registros colgantes, errores de SPF y DMARC, TLS viejo, sin Always Use HTTPS, sin HSTS y sin reglas administradas [verificado: https://developers.cloudflare.com/security-center/security-insights/]. Security Center existe en todos los planes y escanea cada 7 dias en Free, Pro y Business [verificado (busqueda): https://developers.cloudflare.com/learning-paths/get-started-free/security/security-center]. **Nuestra ventaja es que revisamos al momento y le damos a cada hallazgo su accion y su prompt de correccion.** Severidades [propuesta].

| ID | Chequeo | Condicion exacta | Sev. | Correccion |
|---|---|---|---|---|
| CF-ZONE-01 | Zona pausada | `zone.paused == true` | Critica | Reactivar en el dashboard |
| CF-DNS-01 | Origen expuesto | registro `A`, `AAAA` o `CNAME` con `proxiable==true && proxied==false` y nombre web (`@`, `www`, `app`, `api`, `admin`, `dashboard`...) | Alta | `PATCH /zones/{z}/dns_records/{id} {"proxied":true}` [no verificado; requiere DNS Write] |
| CF-DNS-02 | Fuga de IP de origen | el mismo `content` (IP) aparece en un registro con proxy y en otro sin proxy (tipicos: `direct.`, `origin.`, `ftp.`, `mail.`, `cpanel.`) | Critica | Poner proxy o mover el servicio a otra IP; cambiar la IP del origen si ya se filtro |
| CF-DNS-03 | MX delata el origen | el host del `MX` resuelve a una IP igual a la del origen | Alta | Correo en otro proveedor u otra IP |
| CF-DNS-04 | CNAME colgante (riesgo de takeover) | `CNAME` sin proxy cuyo destino da NXDOMAIN (`Status: 3`) en DoH `GET https://cloudflare-dns.com/dns-query?name=<destino>&type=A` con `accept: application/dns-json` | Alta | Borrar el registro | 
| CF-DNS-05 | Correo suplantable | no hay TXT `v=spf1` en `@` o no hay TXT en `_dmarc` | Media | Crear SPF y DMARC `p=quarantine` |
| CF-TLS-01 | SSL apagado o Flexible | `ssl` en `off` o `flexible` | Critica / Alta | `full` o `strict` (4.6) |
| CF-TLS-02 | TLS viejo | `min_tls_version` < `"1.2"` | Media | `"1.2"` |
| CF-TLS-03 | HTTP sin redirigir | `always_use_https == "off"` | Media | `"on"` |
| CF-TLS-04 | Sin HSTS | `security_header.strict_transport_security.enabled == false` | Baja | Activar con `max_age` >= 15552000 tras validar HTTPS |
| CF-TLS-05 | TLS 1.3 apagado | `tls_1_3 == "off"` | Baja | `"on"` |
| CF-WAF-01 | Sin reglas administradas | la fase `http_request_firewall_managed` no tiene regla `execute` habilitada | Alta | Desplegar el Free Managed Ruleset |
| CF-WAF-02 | Login sin freno | no hay regla en `http_ratelimit` y la app tiene rutas de auth (dato de Codebase) | Media | 4.4 |
| CF-WAF-03 | Lista blanca peligrosa | IP Access Rule `whitelist` con `ip_range`, `asn` o `country` | Media | Revisar: se salta las reglas custom y el rate limit |
| CF-WAF-04 | Cupo de reglas lleno | 5 de 5 reglas custom (Free) | Info | Consolidar expresiones con `or` |
| CF-BOT-01 | Bots sin freno | `fight_mode == false` y la zona no sirve una API publica | Baja | 4.5 (con advertencia) |
| CF-SEC-01 | Under Attack olvidado | `security_level == "under_attack"` desde hace mas de 24 h (`modified_on`) | Media (UX) | Volver al valor previo |
| CF-ORIG-01 | Origen accesible sin Cloudflare | peticion HTTPS a la IP de origen con cabecera `Host` que responde 2xx o 3xx | Alta | Firewall del origen que solo acepte los rangos de `GET /ips` |

CF-ORIG-01 es una peticion activa al servidor del cliente: solo con su consentimiento explicito en la conexion y solo un HEAD o GET a `/` [propuesta].

---

## 7. Servidores MCP oficiales: estado y encaje

| Servidor | URL | Estado (24 oct 2026) |
|---|---|---|
| Cloudflare API | `https://mcp.cloudflare.com/mcp` | **Recomendado**. Herramientas `search`, `execute`, `docs` y `whoami`. Code Mode: unos 1.000 a 1.100 tokens de contexto para toda la API (mas de 2.500 endpoints); cada resultado se recorta a unos 6.000 tokens |
| GraphQL, Observability, Radar, Audit Logs, DNS Analytics, Logpush, AI Gateway, AutoRAG, Bindings, Builds | `https://<nombre>.mcp.cloudflare.com/mcp` | **Deprecados**: "Please migrate to the Cloudflare API MCP Server" |
| Docs, Containers, Browser Run, DEX, CASB, Blog | `https://<nombre>.mcp.cloudflare.com/mcp` | Activos; no sirven para nuestro caso |

Fuentes: [verificado: https://github.com/cloudflare/mcp-server-cloudflare], [verificado: https://github.com/cloudflare/mcp] y [verificado: https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/].

Detalles del servidor Cloudflare API [verificado: https://github.com/cloudflare/mcp]:
- Autenticacion por OAuth o por token como Bearer, de usuario o de cuenta. Un token de cuenta necesita "Account Resources : Read" para que el servidor detecte la cuenta. Con un token de usuario se pasa `account_id` a `execute`.
- `execute` recibe JavaScript que llama a `cloudflare.request({ method, path, body })`, y puede hacer `POST /client/v4/graphql`.
- **No hay modo de solo lectura**: los unicos interruptores son `?codemode=false` y `?truncateToolResult`. Los tokens con filtro por IP no estan soportados.
- El transporte es Streamable HTTP en `/mcp`; el viejo `/sse` responde 410 [verificado: https://github.com/cloudflare/mcp-server-cloudflare].

Encaje [propuesta]:
- **Si:** en el modulo "Investiga con IA". Claude recibe el MCP de Cloudflare con el **token de lectura** del cliente y contesta preguntas abiertas ("que paso a las 3 a. m. con /api/login?"). Tambien en el modulo "Conecta cualquier IA": guia de 3 pasos para que el cliente agregue `https://mcp.cloudflare.com/mcp` a su Claude, Cursor o ChatGPT con su propio OAuth, junto con nuestro export de hallazgos.
- **No:** en el bucle de monitoreo (Q1 a Q3) ni en las acciones. Ahi va codigo determinista: es mas barato (cero tokens de Claude por minuto), reproducible y no puede escribir por accidente. **Nunca** se le entrega el token de acciones al MCP, porque `execute` puede llamar a cualquier endpoint que el token permita.
- La sintaxis del conector MCP de la API de Claude (`mcp_servers`, `authorization_token`) esta [no verificado aqui; ver R12-web-claude-api.md].

---

## 8. Reputacion de IP (enriquecer la alerta antes de proponer un bloqueo)

Se consulta con **nuestras** claves, nunca con las del cliente. Cache de 24 h en la tabla `ip_reputacion` [propuesta].

| Fuente | Llamada | Que da | Limite y costo | Licencia y notas |
|---|---|---|---|---|
| Radar | `GET /client/v4/radar/entities/ip?ip=203.0.113.7` | `asn`, `asnName`, `asnOrgName`, `location`, `ipVersion` | API gratis [verificado: https://developers.cloudflare.com/radar/]. Limite de uso [no verificado] | Datos **CC BY-NC 4.0** (no comercial; vale para la hackaton, hay que revisarlo para el producto). La referencia pide "User Details Read" [verificado: https://developers.cloudflare.com/api/resources/radar/subresources/entities/methods/get/]; la guia pide "Account > Radar > Read" [verificado: https://developers.cloudflare.com/radar/get-started/first-request/]. Se crea un token propio con los dos |
| Radar bots | `GET /client/v4/radar/bots` | directorio de bots verificados (nombre, operador, patrones de UA) | - | Solo una fuente de terceros lo documenta [no verificado] |
| Cloudflare Intel | `GET /client/v4/accounts/{a}/intel/ip?ipv4=203.0.113.7` | `risk_types[]`, `belongs_to_ref{type: hosting_provider, isp u organization}` | Permiso Intel Read [verificado: https://developers.cloudflare.com/api/resources/intel/subresources/ips/methods/get/]. Disponibilidad en Free [no verificado] | No funciona con tokens de cuenta [verificado: account-owned-tokens] |
| AbuseIPDB | `GET https://api.abuseipdb.com/api/v2/check?ipAddress=<ip>&maxAgeInDays=90`, con cabeceras `Key: <clave>` y `Accept: application/json` | `abuseConfidenceScore` (0 a 100), `totalReports`, `isTor`, `usageType`, `isp`, `countryCode`, `lastReportedAt` | Free: 1.000 consultas al dia [verificado: https://www.abuseipdb.com/pricing] | Formato [verificado: https://docs.abuseipdb.com/]. Uso comercial en Free [no verificado] |
| GreyNoise Community | API community | ruido de escaneo masivo o benigno | 50 busquedas por **semana** [verificado (busqueda): https://docs.greynoise.io/docs/using-the-greynoise-community-api] | Muy poco para monitoreo; solo para la vista de detalle |
| Spamhaus DROP | `GET https://www.spamhaus.org/drop/drop_v4.json` (tambien `drop_v6.json` y `asndrop.json`) | redes secuestradas o de spam | Gratis, **incluso para uso comercial**, citando a Spamhaus; maximo una descarga por hora, se recomienda una al dia [verificado: https://www.spamhaus.org/blocklists/do-not-route-or-peer/] | Cargar en una tabla y comparar por CIDR |
| Salidas de Tor | `GET https://check.torproject.org/torbulkexitlist` | unas 1.500 IPv4 en texto plano, una por linea | [verificado: https://check.torproject.org/torbulkexitlist] | Refrescar cada hora |

Regla de enriquecimiento [propuesta]: si `abuseConfidenceScore >= 75`, o la IP esta en DROP, la severidad sube un nivel y se propone `block`. Si `usageType` contiene "Data Center" y el UA es de navegador, se propone `managed_challenge`. Si es de Tor, `managed_challenge` y no `block`.

---

## Implicaciones para el plan

**Adoptar**
1. Cliente propio REST + GraphQL (fragmento del punto 2.6) y consultas Q1 a Q4 calcadas de KUADRA, que ya funcionan en Free. Tramos de 24 h, `settings` al conectar y archivo en Supabase (`cf_eventos` deduplicado por `rayName` + `matchIndex`, y `cf_pulso` por minuto) para tener historia y linea base. **M**
2. Onboarding de 2 tokens (lectura obligatoria, acciones opcional) con sondeo de permisos que traduce cada 403 a lenguaje claro. **S**
3. Motor de reglas con los 8 detectores del punto 2.5. Claude solo redacta la explicacion y el prompt de correccion, nunca decide disparar. **M**
4. Acciones con confirmacion OTP y boton de deshacer: bloquear IP (4.1) y Under Attack (4.2) en la demo; rate limit (4.4) y regla por UA (4.3) si hay tiempo. **M**
5. Webhook `dos_attack_l7` (gratis en todos los planes) como disparador real en tiempo real. **S**
6. Auditoria de 18 chequeos (punto 6) cruzada con Security Insights. **M**
7. MCP oficial solo para "Investiga con IA" y para la guia "Conecta tu IA", siempre con el token de lectura. **S**

**Evitar**
- Los MCP deprecados (graphql, observability, radar, auditlogs). Darle `execute` del MCP a un token con escritura.
- Ventanas de GraphQL de mas de 24 h en Free. Confiar en `firewallEventsAdaptiveGroups` en Free. Asumir que `clientIP` existe como dimension de los Groups sin el chequeo de `availableFields`.
- Activar Bot Fight Mode o `ssl=strict` de forma automatica: pueden tumbar APIs, webhooks o el sitio entero.
- Auditar `security_level` low/medium/high: el threat score ya es 0.
- Usar datos de Radar (CC BY-NC) en un producto comercial sin revisar la licencia.

**Riesgos**
- Nombres de permisos de zona para rulesets e IP Access Rules sin confirmar en la doc oficial ("Firewall Services" frente a "Zone WAF"). Mitigacion: el sondeo de 1.3 y pedir los dos.
- La cuota GraphQL (300 cada 5 min) se comparte si el cliente reutiliza el token. Mitigacion: el presupuesto de 2.7 (unas 33) y retroceder ante un 429; nunca reintentar en bucle, porque el bloqueo dura 5 min.
- Muestreo: los conteos son estimados. En la alerta decir "unas N peticiones" y usar `confidence` cuando `sampleInterval > 1`.
- La demo depende de una zona propia en Cloudflare con dominio real. Free alcanza, pero el rate limit de Free (periodo de 10 s, solo Path) es pobre para lucirse. Pro cuesta 25 USD con pago mensual o 20 USD/mes con pago anual (dato del benchmark del equipo, `docs/benchmark-ai-security-team-22-v5.md`, linea 801, citando https://www.cloudflare.com/plans/). **Decidir hoy si se paga Pro para la zona de demo.**
- Generar el ataque de la demo desde una sola IP contra la app propia es lo que dispara CF-IP-FLOOD y CF-SPIKE. Si es demasiado fuerte, la mitigacion automatica de DDoS de Cloudflare puede actuar antes que nosotros. Bueno para el webhook, malo si queremos mostrar nuestro bloqueo: ensayar con volumen moderado.

**Esfuerzo total del modulo Cloudflare:** L (lectura y detectores M, acciones M, auditoria M, webhook y MCP S). Para la entrega del domingo, el corte minimo viable es: conexion con sondeo, Q1, Q2-B, Q3, los detectores CF-IP-FLOOD, CF-SPIKE y CF-ORIGIN-5XX, la accion bloquear IP con deshacer, el webhook DDoS y la auditoria de CF-DNS-01/02 y CF-TLS-01/02/03.
