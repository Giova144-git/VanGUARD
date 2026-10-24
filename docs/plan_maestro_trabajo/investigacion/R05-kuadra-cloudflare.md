# R05 — KUADRA Cloudflare: consultas, endpoints y detecciones listas para portar a TypeScript

Etapa 1 de 4 del plan maestro, team-22, Platanus Hack 26. Lectura en solo lectura de KUADRA CRM (Flutter/Dart).

**Fuentes leídas (KUADRA, completas):**
- `kuadra_crm/lib/nucleo/cloudflare_api.dart` (902 líneas): cliente REST + GraphQL.
- `kuadra_crm/lib/modulos/cloudflare/` completo: `servicio.dart`, `modelos.dart`, `controlador.dart`, `columnas.dart`, `pantalla.dart`, `modulo.dart`.
- Las detecciones NO viven en Dart: las clasifica la base. Por eso también se leyó
  `KUADRA MASTER/supabase/migrations/20261018000726_crm_ola4_b_cloudflare_ajustes_rpc.sql` (umbrales) y
  `20260829165000_cloudflare_archivo_firewall.sql` (tabla de archivo), más el fixture `test/modulos/cloudflare/soporte_cloudflare.dart`.

**Convención de marcas:** `[KUADRA: fichero:línea]` = sale del código de KUADRA (medido por ellos contra su zona real
kuadrave.com el 2026-08-29 cuando el comentario lo dice). `[verificado: URL]` = comprobado hoy en la doc oficial.
`[no verificado]` = no se pudo comprobar.

---

## 1. Cómo está montado en KUADRA (la arquitectura que vale la pena copiar)

1. **Seis "viajes" en paralelo** por ciclo, cada uno con su propio error y su última hora buena; si uno falla, se queda
   el dato anterior con su hora (`servicio.dart:63-166`). Ids: `verify`, `trafico`, `eventos`, `bloqueos`, `salud`,
   `aprobado` (`modelos.dart:18-38`).
2. **La zona se resuelve primero, una sola vez**, y se cachea (`zoneId` y `accountId`). Si el token no ve la zona, los
   cinco viajes de la zona se marcan con el error `zona` sin llamar (`servicio.dart:92-105, 149-153`).
3. **El cliente lee y la base clasifica.** El Dart arma un resumen `p_cf` (JSON) y la función SQL
   `crm_cloudflare_estado(p_rango, p_cf, p_texto, p_limite)` aplica los umbrales y devuelve cifras, filas de alerta
   ("Ahora"), checks y secciones (`modelos.dart:112-171`, SQL líneas 116-285). La base nunca tiene el token.
4. **Archivo propio de eventos del firewall** en Postgres, porque el plan Free solo deja consultar 24 h:
   `plataforma.cloudflare_firewall_archivo`, deduplicado por `(ray_id, match_index)`, con purga a 90 días
   (migración 20260829165000).
5. **Bloquear/quitar IP** es la única acción de escritura (IP Access Rules), con nota fija `"KUADRA CRM"` y registro
   en auditoría (`servicio.dart:241-285`, `modelos.dart:41`).
6. Refresco: la base se relee cada 30 s con el módulo a la vista; oculto, cada 5 min como mucho (`controlador.dart:11-13, 34`).

## 2. Token: permisos, verificación y zona

**Permisos del token que usa KUADRA** (un solo token, de usuario) [KUADRA: `KUADRA CRM/README.md:43`,
`docs/CONTRATO_TECNOLOGIA.md:285-286`, spec ola 4 línea 477]:

| Permiso (nombre en el panel) | Para qué |
|---|---|
| `Zone · Zone · Read` | `GET /zones?name=` (resolver zona y cuenta) |
| `Zone · Analytics · Read` | todo el GraphQL (`/graphql`) |
| `Zone · Firewall Services · Edit` | listar, crear y borrar IP Access Rules |

- La doc oficial de GraphQL solo nombra el permiso de cuenta `Account Analytics: Read`
  [verificado: https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/].
  KUADRA funciona con el de zona (`Zone Analytics Read`), probado en vivo. **Para nuestro producto: pedir los dos de
  analítica en la guía** (zona y cuenta, ambos de solo lectura) para que no falle según el tipo de token.
- La doc de crear access rules lista `Account Firewall Access Rules Write` como permiso aceptado
  [verificado: https://developers.cloudflare.com/api/resources/firewall/subresources/access_rules/methods/create/];
  KUADRA usa `Zone Firewall Services Edit` sobre la variante de zona, también probado en vivo.
- **Decisión previa del equipo: MCP y lectura en solo lectura.** Para la demo, el token del cliente debería ser
  **solo lectura** (Zone Read + Analytics Read). El permiso `Firewall Services Edit` pasa a ser opcional, solo si el
  usuario activa "acciones de un clic". Sin él, la acción "Bloquear IP" se entrega como **instrucción o prompt**, no
  como llamada.

**Verificar token:**
- `GET /user/tokens/verify` → `result.status ∈ {active, disabled, expired}`
  [verificado: https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/].
- Los tokens **de cuenta** se verifican en otra ruta: `GET /accounts/{account_id}/tokens/verify`; un token de cuenta
  contra `/user/tokens/verify` responde `Invalid API Token` (código 1000)
  [verificado: https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify].
  KUADRA solo prueba la ruta de usuario (`cloudflare_api.dart:357-360`). **Mejora para portar:** probar `/user/...` y,
  si da 401/1000 y tenemos `account_id`, probar `/accounts/{id}/tokens/verify`.

**Errores de permiso en GraphQL:** GraphQL responde HTTP 200 con `errors[]`. KUADRA detecta "falta de permiso" por
texto (`modelos.dart:567-581`):

```ts
const MARCAS_PERMISO = ['unauthorized','not authorized','unauthenticated','forbidden','permission',
  'access denied','cannot request data','unable to authenticate','authentication error'];
export const esErrorDePermisos = (m: string) => MARCAS_PERMISO.some(x => m.toLowerCase().includes(x));
```

Ojo: `cannot request data` también es el texto del error de ventana demasiado antigua ("cannot request data older
than 2678400s") [verificado: https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-firewall-events/].
Conviene separar ese caso antes de llamarlo "sin permiso".

## 3. Endpoints REST (literales)

Base `https://api.cloudflare.com/client/v4`, cabeceras `Authorization: Bearer <token>`, `Content-Type: application/json`,
tiempo límite 20 s. Toda respuesta REST se valida con `json.success === true`; si no, el mensaje es
`errors[0].message` (`cloudflare_api.dart:298-349`).

| Uso | Método y ruta | Notas KUADRA |
|---|---|---|
| Verificar token | `GET /user/tokens/verify` | `result.status` (`:357-360`) |
| Resolver zona | `GET /zones?name={dominio}` | toma `result[0].id` y `result[0].account.id`; si vacío: "El token no ve la zona" (`:363-379`) |
| Listar bloqueos | `GET /zones/{zone}/firewall/access_rules/rules?per_page=100&order=created_on&direction=desc` | **no pagina**: con 100 reglas la lista está cortada → alerta `bloqueos_al_tope` (`:383-391`, SQL `c_bloq = 100`) |
| Bloquear IP | `POST /zones/{zone}/firewall/access_rules/rules` cuerpo `{"mode":"block","configuration":{"target":"ip"\|"ip6","value":"<ip>"},"notes":"KUADRA CRM"}` | valida IPv4/IPv6 antes; duplicado → `firewallaccessrules.api.duplicate_of_existing` (fixture) (`:397-416`) |
| Quitar bloqueo | `DELETE /zones/{zone}/firewall/access_rules/rules/{rule_id}` | (`:418-421`) |
| GET genérico | `GET {ruta}` | lo usa el backup (`:354`) |

Modos válidos de access rule: `block`, `challenge`, `whitelist`, `js_challenge`, `managed_challenge`; targets `ip`,
`ip6`, `ip_range`, `asn`, `country`
[verificado: https://developers.cloudflare.com/api/resources/firewall/subresources/access_rules/methods/create/].
KUADRA solo usa `block` + `ip`/`ip6`.

Respuesta de una regla (forma que parsea KUADRA, `cloudflare_api.dart:25-31`):
`{ "id": "...", "mode": "block", "notes": "KUADRA CRM", "created_on": "2026-...Z", "configuration": { "target": "ip", "value": "1.2.3.4" } }`.

Acción extra que el plan previo del equipo menciona ("modo bajo ataque"): `PATCH /zones/{zone}/settings/security_level`
con `{"value":"under_attack"}`. La ruta `PATCH /zones/{zone_id}/settings/{setting_id}` y el permiso `Zone Settings Write`
están [verificado: https://developers.cloudflare.com/api/resources/zones/subresources/settings/methods/edit/]; que el
valor `under_attack` sea aceptado por `security_level` queda [no verificado] (la página se cortó antes). KUADRA no lo usa.

## 4. GraphQL: cómo llama KUADRA

- `POST https://api.cloudflare.com/client/v4/graphql` con cuerpo `{"query": "<texto>"}` y el mismo Bearer (`:425-451`).
- Si `errors[]` no está vacío, falla con `errors[0].message`. Si la respuesta no es JSON (un 502 llega como HTML),
  error "respondió {status} sin datos utilizables" (`:436-444`).
- Datos en `data.viewer.zones[0]`; si `zones` viene vacío, el token no ve la zona (se devuelve vacío, no error) (`:460-464`).
- **Formato de fecha sin milisegundos**, porque así se verificó contra la zona viva y "el filtro de fechas es
  quisquilloso" (`:453-457`):

```ts
export const isoCf = (d: Date) => d.toISOString().split('.')[0] + 'Z'; // 2026-10-24T05:00:00Z
```

- KUADRA **interpola** `zoneTag` y fechas en el texto (no usa variables). Es seguro porque ningún valor viene del
  usuario. Al portar: validar `zoneTag` con `/^[a-f0-9]{32}$/` antes de interpolar. La doc oficial admite variables
  (`$zoneTag: string`, `$filter: FirewallEventsAdaptiveFilter_InputObject`)
  [verificado: https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-firewall-events/].
- **Agrupación por alias**: varios agregados en una sola petición HTTP (7 y 9 alias), probado en vivo.

## 5. Las cinco consultas GraphQL, copiadas literalmente

Texto GraphQL idéntico al de KUADRA. Lo único cambiado es la sintaxis de interpolación: Dart `$zona` /
`${_iso(desde)}` / `$limite` pasa a TS `${zona}` / `${isoCf(desde)}` / `${limite}`. Donde KUADRA usa sus variables
`$v`, `$paso` y `$err`, aquí son `${V}`, `${PASO}` y `${ERR}`:

```ts
const V    = `datetime_geq: "${isoCf(desde)}", datetime_leq: "${isoCf(hasta)}"`; // ventana; en Free <= 24 h
const PASO = `securityAction: "unknown"`;     // "aprobado" = el borde no aplicó NINGUNA acción
const ERR  = `edgeResponseStatus_geq: 500`;   // 5xx
```

Todas usan `hasta = ahora (UTC)` y `desde = hasta - horas` con `horas = 24` por defecto.

### 5.1 `eventosFirewall`: eventos del WAF/firewall uno por uno (`cloudflare_api.dart:477-513`)

Comentario KUADRA: `horas` no puede pasar de 24 en Free, "Cloudflare rechaza cualquier ventana «wider than 1d»
(verificado contra la zona el 2026-08-29)". `limite = 1000` por defecto. Si `eventos.length >= limite`, el lote está
**recortado** (`recortado`, `:154`).

```graphql
query {
  viewer {
    zones(filter: {zoneTag: "${zona}"}) {
      firewallEventsAdaptive(
        filter: {datetime_geq: "${isoCf(desde)}", datetime_leq: "${isoCf(hasta)}"},
        limit: ${limite},
        orderBy: [datetime_DESC]
      ) {
        action datetime rayName matchIndex ruleId description
        clientIP clientCountryName clientAsn clientASNDescription
        clientRequestHTTPHost clientRequestPath clientRequestQuery
        clientRequestHTTPMethodName clientRequestScheme
        edgeResponseStatus userAgent source
      }
    }
  }
}
```

Qué es cada campo (`:87-106`): `rayName` = Ray ID (clave para deduplicar); `matchIndex` (una petición puede coincidir
con varias reglas; en kuadrave.com siempre fue 0, "no está garantizado"); `ruleId`; `description` = **nombre legible de
la regla** ("Rutas de escaner", "Manage AI bots"), que es lo que explica por qué se frenó la petición; `clientAsn` +
`clientASNDescription` ("Oracle Corporation", "DigitalOcean"); `source` (waf, ratelimit, firewallCustom,
firewallManaged…); `clientRequestQuery` (sin `?`).

Lo que midió KUADRA (migración 20260829165000, líneas 46-59): en 24 h hubo 393 eventos, todos `block` (356
`firewallCustom` + 37 `firewallManaged`), 393 `rayName` distintos, 30 IPs y un UA de 148 caracteres como máximo.
**En Free viene muestreado:** las mismas 24 h en `httpRequestsAdaptiveGroups` daban 2.192 peticiones bloqueadas
(muestreo medio 4,14), así que los 393 eran una muestra de unas 2.192.

### 5.2 `traficoAprobado`: siete agregados en una petición (`cloudflare_api.dart:544-635`)

```graphql
query {
  viewer {
    zones(filter: {zoneTag: "${zona}"}) {
      total: httpRequestsAdaptiveGroups(filter: {${V}}, limit: 1) {
        count avg { sampleInterval }
      }
      porAccion: httpRequestsAdaptiveGroups(
          filter: {${V}}, limit: 12, orderBy: [count_DESC]) {
        count sum { edgeResponseBytes visits }
        dimensions { securityAction }
      }
      porHora: httpRequestsAdaptiveGroups(
          filter: {${V}, ${PASO}}, limit: 30, orderBy: [datetimeHour_ASC]) {
        count sum { visits }
        dimensions { datetimeHour }
      }
      porPais: httpRequestsAdaptiveGroups(
          filter: {${V}, ${PASO}}, limit: 12, orderBy: [count_DESC]) {
        count sum { edgeResponseBytes visits }
        dimensions { clientCountryName }
      }
      porRuta: httpRequestsAdaptiveGroups(
          filter: {${V}, ${PASO}}, limit: 15, orderBy: [count_DESC]) {
        count sum { edgeResponseBytes }
        dimensions { clientRequestPath clientRequestHTTPHost }
      }
      porEstado: httpRequestsAdaptiveGroups(
          filter: {${V}, ${PASO}}, limit: 15, orderBy: [count_DESC]) {
        count dimensions { edgeResponseStatus }
      }
      porAgente: httpRequestsAdaptiveGroups(
          filter: {${V}, ${PASO}}, limit: 10, orderBy: [count_DESC]) {
        count dimensions { userAgent }
      }
    }
  }
}
```

Notas: `total` y `porAccion` van **sin** el filtro `PASO` (cuentan todo el tráfico); los demás alias cuentan solo el
aprobado. `total` con `limit: 1` y sin `dimensions` da el conteo global. `avg.sampleInterval` es el muestreo medio: 1 =
sin muestreo; 2,3 = "Cloudflare miró una de cada 2,3 y extrapoló". En la pantalla se ve como la chapa "Muestreo 1:2,29".

Respuesta de ejemplo (fixture sintético de KUADRA, `soporte_cloudflare.dart:219-246`):

```json
{ "data": { "viewer": { "zones": [ {
  "total": [ { "count": 15160, "avg": { "sampleInterval": 1 } } ],
  "porAccion": [
    { "count": 14554, "sum": { "edgeResponseBytes": 1610612736, "visits": 3904 }, "dimensions": { "securityAction": "unknown" } },
    { "count": 606,   "sum": { "edgeResponseBytes": 1024, "visits": 0 },          "dimensions": { "securityAction": "block" } } ],
  "porHora": [ { "count": 400, "sum": { "visits": 10 }, "dimensions": { "datetimeHour": "2026-10-02T00:00:00Z" } } ]
} ] } } }
```

### 5.3 `peticionesAprobadas`: detalle de cada petición que pasó (`cloudflare_api.dart:643-674`)

Comentario KUADRA: "en plan Free `httpRequestsAdaptive` da detalle por petición (medido el 2026-08-29)". No trae
`rayName`, ni el referente, ni el puntaje de bot, y viene muestreado ("una muestra de las últimas peticiones").
`limite = 100`.

```graphql
query {
  viewer {
    zones(filter: {zoneTag: "${zona}"}) {
      httpRequestsAdaptive(
        filter: {
          datetime_geq: "${isoCf(desde)}", datetime_leq: "${isoCf(hasta)}",
          securityAction: "unknown"
        },
        limit: ${limite},
        orderBy: [datetime_DESC]
      ) {
        datetime clientIP clientCountryName clientRequestHTTPHost
        clientRequestPath clientRequestHTTPMethodName edgeResponseStatus
        cacheStatus userAgent clientDeviceType
      }
    }
  }
}
```

### 5.4 `saludOrigen`: 5xx del origen en nueve agregados (`cloudflare_api.dart:697-806`)

Por qué existe, según el comentario (`:677-696`): el 2026-08-29 **una de cada cinco cargas de app.kuadrave.com moría
con 504** y ninguna alarma lo avisó. El corte que importa es `cacheStatus`: `miss` fallaba el 50,6 % mientras `hit`,
`revalidated`, `dynamic` y `none` estaban en 0. Es decir, fallaba justo lo que hay que ir a buscar al origen. El dato
global era 2,6 % y "parece ruido". El corte por `coloCode` separa "se cayó Cloudflare en Miami" de "lo rompimos
nosotros".

```graphql
query {
  viewer {
    zones(filter: {zoneTag: "${zona}"}) {
      total: httpRequestsAdaptiveGroups(filter: {${V}}, limit: 1) { count }
      errores: httpRequestsAdaptiveGroups(filter: {${V}, ${ERR}}, limit: 1) { count }
      cacheTotal: httpRequestsAdaptiveGroups(
          filter: {${V}}, limit: 12, orderBy: [count_DESC]) {
        count dimensions { cacheStatus }
      }
      cacheErr: httpRequestsAdaptiveGroups(
          filter: {${V}, ${ERR}}, limit: 12, orderBy: [count_DESC]) {
        count dimensions { cacheStatus }
      }
      coloTotal: httpRequestsAdaptiveGroups(
          filter: {${V}}, limit: 25, orderBy: [count_DESC]) {
        count dimensions { coloCode }
      }
      coloErr: httpRequestsAdaptiveGroups(
          filter: {${V}, ${ERR}}, limit: 25, orderBy: [count_DESC]) {
        count dimensions { coloCode }
      }
      rutaErr: httpRequestsAdaptiveGroups(
          filter: {${V}, ${ERR}}, limit: 15, orderBy: [count_DESC]) {
        count dimensions { clientRequestHTTPHost clientRequestPath }
      }
      estadoErr: httpRequestsAdaptiveGroups(
          filter: {${V}, ${ERR}}, limit: 10, orderBy: [count_DESC]) {
        count dimensions { edgeResponseStatus }
      }
      horaErr: httpRequestsAdaptiveGroups(
          filter: {${V}, ${ERR}}, limit: 30, orderBy: [datetimeHour_ASC]) {
        count dimensions { datetimeHour }
      }
    }
  }
}
```

### 5.5 `traficoPorDia`: 7 días agregados (`cloudflare_api.dart:808-847`)

Es la única consulta que pasa de 24 h. `desde` es la fecha (YYYY-MM-DD) de hace `dias` días, con `dias = 7`.

```graphql
query {
  viewer {
    zones(filter: {zoneTag: "${zona}"}) {
      httpRequests1dGroups(
        filter: {date_gt: "${desde}"},
        limit: ${dias},
        orderBy: [date_ASC]
      ) {
        dimensions { date }
        sum { requests bytes threats }
        uniq { uniques }
      }
    }
  }
}
```

No comprobé en la doc que `sum.threats` y `uniq.uniques` sigan vigentes en 2026 [no verificado]. KUADRA los usa en
producción.

## 6. Cómo agrupa KUADRA (dimensión → dónde)

| Agrupa por | Dónde | Dataset / campo | Límite | Filtro |
|---|---|---|---|---|
| **IP** | **en SQL sobre el archivo**, no en GraphQL (§8.2) | `firewallEventsAdaptive.clientIP` | 1.000 eventos/lote | ninguno |
| IP (sin agregar) | tabla "Últimas 100" | `httpRequestsAdaptive.clientIP` | 100 | aprobado |
| **User agent** | `porAgente` | `httpRequestsAdaptiveGroups dimensions{userAgent}` | top 10 | aprobado |
| País | `porPais` | `dimensions{clientCountryName}` + bytes + visits | top 12 | aprobado |
| Ruta (+host) | `porRuta` / `rutaErr` | `dimensions{clientRequestPath clientRequestHTTPHost}` | 15 | aprobado / 5xx |
| Estado HTTP | `porEstado` / `estadoErr` | `dimensions{edgeResponseStatus}` | 15 / 10 | aprobado / 5xx |
| Hora | `porHora` / `horaErr` | `dimensions{datetimeHour}` orden `datetimeHour_ASC` | 30 | aprobado / 5xx |
| Acción de seguridad | `porAccion` | `dimensions{securityAction}` | 12 | todo |
| Caché | `cacheTotal` / `cacheErr` | `dimensions{cacheStatus}` | 12 | todo / 5xx |
| Centro de datos | `coloTotal` / `coloErr` | `dimensions{coloCode}` | 25 | todo / 5xx |
| Día | `httpRequests1dGroups` | `dimensions{date}` | 7 | ninguno |

**Hueco importante:** KUADRA **no** agrupa por IP ni por user agent sobre *todo* el tráfico. Solo cuenta IPs dentro de
los eventos que el firewall ya frenó (muestreados) y saca el top de UAs del tráfico aprobado sin aplicar ningún umbral.
Lo que pide el encargo ("IPs con muchas llamadas", "user agents insistentes") hay que añadirlo (§10).

## 7. Cálculos (fórmulas exactas)

```ts
// Aprobado / frenado (cloudflare_api.dart:212-224)
const aprobadas = porAccion.filter(g => g.securityAction === 'unknown').reduce((a, g) => a + g.count, 0);
const frenadas  = total - aprobadas;            // todo lo que tuvo alguna acción del borde
const fraccionAprobada = total > 0 ? aprobadas / total : null;

// Salud del origen (:749-805, :852-901)
const tasa = (errores: number, total: number) => total === 0 ? 0 : errores / total;   // "sin tráfico es 0, no infinito"
// cruzar(): une totales y errores por la misma dimensión (cacheStatus, coloCode) y ordena por TASA desc,
// desempate por errores desc ("un colo con 10 de 14 es más señal que uno con 129 de 1.809").
// soloErrores(): rutaErr/estadoErr/horaErr, sin total, orden por errores desc; etiqueta = dims unidas por ' '.
// peorCache = primer corte de caché (ya ordenado por tasa) con errores > 0, o null.
const gravedad5xx = (t: number) => t >= 0.05 ? 'mal' : t >= 0.005 ? 'aviso' : 'neutra';
```

Por qué el rojo está en 5 % (`:896-901`): el 2026-08-29 la app estaba al 4,6 % global y al 21,7 % en su portada, "ya
era una de cada cinco cargas caída".

Etiquetas de caché (`modelos.dart:538-548`): `hit` servido desde el borde, `miss` buscado en el origen, `revalidated`,
`expired`, `dynamic` no cacheable, `none` sin caché aplicable, `bypass`, `unknown`. Valores de `securityAction`
(`:551-564`): `unknown` (pasó sin acción), `allow`, `log`, `block`, `challenge`/`managedChallenge`/`jschallenge`,
`*Solved`, `*Failed`, `connectionClose`/`forceConnectionClose`. Valores de `source` (`:511-524`): `waf`, `ratelimit`,
`firewallrules`/`firewallCustom`, `firewallManaged`, `securitylevel`, `badbrowser`, `bic`, `l7ddos`, `botfight`,
`ip`/`iprules`.

## 8. Detecciones y umbrales (de la base, `_crm_cloudflare_medir` y `_crm_cloudflare_filas`)

Constantes literales (SQL líneas 123-129):

```sql
c_viejo   constant int     := 12;     -- h: archivo viejo (aviso)
c_hueco   constant int     := 24;     -- h: hueco (mal); la ventana del plan Free
c_insist  constant int     := 50;     -- eventos en 24 h sin regla en el borde
c_5xx_av  constant numeric := 0.5;    -- %
c_5xx_mal constant numeric := 5;      -- %
c_lote    constant int     := 1000;   -- tope de firewallEventsAdaptive
c_bloq    constant int     := 100;    -- tope de la lista de access_rules (no pagina)
```

### 8.1 Tabla de alertas ("Ahora"), en el orden en que salen

| Orden | Tipo | Rol | Se dispara si | Acción ofrecida |
|---|---|---|---|---|
| 10 | `archivo_viejo` / `archivo_hueco` | aviso / mal | horas desde el último archivado ≥ 12 / > 24 | Reintentar archivar |
| 20 | `sin_token` / `token_mal` | mal | sin token, o `verify.status ≠ active` ("Token caducado" si `expired`) | Ir a Ajustes |
| 30 | `sin_permiso_analytics` | mal | algún GraphQL falló con texto de permisos (§2) | Ir a Ajustes |
| 40 | `fuente_caida` (una por viaje) | mal | el viaje falló; enseña "datos de hh:mm" | Reintentar ese viaje |
| 50 | `origen_5xx` | aviso / mal | tasa 5xx ≥ 0,5 % / ≥ 5 % (24 h). Texto: "2,6 % · 31 de 15.204 · Buscado en el origen 50,6 %" | Ver N rutas |
| 60 | `eventos_tope` | aviso | lote de eventos 24 h con n ≥ min(tope, 1000): hay más que no se ven | Ver eventos |
| 70 | `bloqueos_al_tope` | aviso | ≥ 100 reglas de acceso: la lista está cortada | Ver bloqueos |
| 80 | `ip_insistente` (una por IP, máximo 50) | cola | ≥ 50 eventos del firewall en 24 h **y sin regla de bloqueo** | **Bloquear** (toda la zona · 403) |

Checks "en cero" (se muestran en verde solo si valen 0): `huecos_7d`, `lotes_tope_7d`, `reglas_sin_nota` (reglas de
acceso con nota vacía).

### 8.2 SQL de "IPs insistentes" (SQL líneas 189-204, literal)

```sql
select pg_catalog.count(*)::int,
       pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('ip', x.ip, 'n', x.n, 'regla', x.regla) order by x.n desc, x.ip)
         filter (where x.orden <= 50)
  into v_ins_n, v_ins
  from (select y.*, pg_catalog.row_number() over (order by y.n desc, y.ip) as orden
          from (select a.ip, pg_catalog.count(*)::int as n,
                       pg_catalog.mode() within group (order by coalesce(nullif(a.regla_nombre, ''), a.fuente)) as regla
                  from plataforma.cloudflare_firewall_archivo a
                 where a.momento > pg_catalog.now() - interval '24 hours' and a.ip <> ''
                 group by a.ip
                having pg_catalog.count(*) >= c_insist) y
         where not ((case when pg_catalog.pg_input_is_valid(y.ip, 'inet') then pg_catalog.host(y.ip::inet) else y.ip end)
                    = any (v_bloq_ips))) x;
```

`regla` es la regla más frecuente (`mode()`) de esa IP: sirve para explicar la alerta ("312 eventos · Rutas de escaner ·
sin regla"). Si no se pudo leer la lista de bloqueos, no se calcula ("sin la lista de reglas, no se sabe").

En TS, sin archivo (por ejemplo, solo con el lote vivo de 24 h):

```ts
export function insistentes(eventos: EventoFw[], ipsBloqueadas: Set<string>, umbral = 50) {
  const m = new Map<string, { n: number; reglas: Map<string, number> }>();
  for (const e of eventos) {
    if (!e.clientIP) continue;
    const x = m.get(e.clientIP) ?? { n: 0, reglas: new Map() };
    x.n++; const r = e.description || e.source; x.reglas.set(r, (x.reglas.get(r) ?? 0) + 1);
    m.set(e.clientIP, x);
  }
  return [...m].filter(([ip, x]) => x.n >= umbral && !ipsBloqueadas.has(ip))
    .map(([ip, x]) => ({ ip, n: x.n, regla: [...x.reglas].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '' }))
    .sort((a, b) => b.n - a.n || a.ip.localeCompare(b.ip)).slice(0, 50);
}
```

Ojo: el umbral de 50 se aplica sobre eventos **muestreados**. Con un muestreo de 4,14, 50 eventos equivalen a unas 200
peticiones reales.

### 8.3 Archivo y huecos

- **Hueco cerrado** = entre dos `archivado_en` consecutivos pasaron más de 24 h; `perdidas = horas - 24`.
  `huecos_7d` cuenta los de 7 días, más 1 si ahora mismo llevamos más de 24 h sin archivar.
- **Lote al tope en 7 d** = archivados cuya ventana de 24 h trae 1.000 eventos o más.
- `crm_cloudflare_archivar(p_eventos jsonb, p_simular boolean default true)`: rechaza más de 2.000 eventos
  (`lote_grande`), deduplica dentro del lote con `distinct on (ray_id, match_index)`, recorta cada campo con `left()`
  porque "el User-Agent y la ruta los escribe quien ataca" (ray_id 32, accion 40, fuente 40, regla_id 64, regla_nombre
  200, ip 45, pais 8, asn 16, asn_nombre 120, host 253, ruta 512, consulta 512, metodo 10, esquema 10, user_agent 512) e
  inserta con `on conflict (ray_id, match_index) do nothing`. Antes de escribir, el modo simulado devuelve cuántos
  eventos serían `nuevos`.
- Solo se archivan eventos con `rayId` y `momento` (`modelos.dart:256-259`). El lote viaja como **un único JSON**
  desarmado con `jsonb_to_recordset`, nunca concatenado en SQL (migración 20260829165000, líneas 35-44).

Tabla portable a Supabase (columnas de la migración 20260829165000, líneas 62-112; esquema `public` y nombre propio
para nuestro producto, multi-cliente):

```sql
create table public.cf_eventos_firewall (
  conexion_id   uuid not null references public.conexiones(id) on delete cascade, -- NUESTRO: multi-tenant
  ray_id        text not null,
  match_index   int  not null default 0,
  momento       timestamptz not null,
  accion        text not null,
  fuente        text not null default '',
  regla_id      text,
  regla_nombre  text,
  ip            text not null default '',
  pais          text not null default '',
  asn           text,
  asn_nombre    text,
  host          text not null default '',
  ruta          text not null default '',
  consulta      text,
  metodo        text,
  esquema       text,
  user_agent    text,
  estado_http   int,
  archivado_en  timestamptz not null default now(),
  primary key (conexion_id, ray_id, match_index)
);
create index on public.cf_eventos_firewall (conexion_id, momento desc);
create index on public.cf_eventos_firewall (conexion_id, ip, momento desc);
alter table public.cf_eventos_firewall enable row level security;
```

Tamaño medido por KUADRA: unos 590 bytes por fila con índices, unos 21 MB a 90 días con ~400 eventos al día; la
purga corre con `pg_cron` a las 04:39 (`delete ... where momento < now() - interval '90 days'`).

## 9. Límites por plan y de la API

| Límite | Valor | Fuente |
|---|---|---|
| Ventana máxima de `firewallEventsAdaptive` en Free | **1 día** ("cannot request a time range wider than 1d" con 48 h) | [KUADRA: migración 20260829165000:5-9, `cloudflare_api.dart:474-476`] |
| Ventana de `httpRequestsAdaptive*` en Free | ≤ 24 h (todas las consultas de KUADRA usan 24 h) | [KUADRA: `:536-539`]. Un tercero dice "rejects any query window wider than 1 day on standard plans" [no verificado] |
| Retención de los datasets adaptativos | al menos 31 días en todos los planes | [verificado: https://developers.cloudflare.com/analytics/graphql-api/limits/] |
| Ejemplo oficial de `settings.firewallEventsAdaptive` | `maxDuration 259200` (3 d), `maxPageSize 10000`, `maxNumberOfFields 30`, `notOlderThan 2678400` (31 d); "may differ by plan" | [verificado: https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/] |
| Security Events en el dashboard | Free: "Sampled logs only"; ventana máxima de consulta 30 d (Free/Pro/Business) | [verificado: https://developers.cloudflare.com/waf/analytics/security-events/] |
| Cuota GraphQL | 300 consultas cada 5 min por usuario, además del límite general | [verificado: https://developers.cloudflare.com/analytics/graphql-api/limits/] |
| Consultas por petición | "scopes × nodes" (cada alias cuenta); no hay número publicado | [verificado: misma URL]; KUADRA hace 9 alias sin problema |
| Límite general de la API | 1.200 peticiones cada 5 min por usuario; si se pasa, HTTP 429 y 5 min bloqueado; cabeceras `retry-after`, `Ratelimit`, `Ratelimit-Policy` | [verificado: https://developers.cloudflare.com/fundamentals/api/reference/limits/] |
| Lista de access rules | KUADRA lee 1 página de 100 | [KUADRA: `:386`] |
| Capacidades fuera de Free (lista de KUADRA) | WAF OWASP, límite de tasa multirregla y alertas webhook (Pro); Logpush, Bot Management, retención 30 d y API Shield (Enterprise) | [KUADRA: `modelos.dart:480-488`]; precios y planes exactos [no verificado] |

**Hay un choque:** el dashboard dice 30 días en Free y KUADRA midió 1 día en la API GraphQL. **Regla para portar: no
fijar la ventana a mano.** Hay que leer el nodo `settings` de la zona una vez por conexión y usar
`min(maxDuration, 86400)` como ventana por defecto:

```graphql
query { viewer { zones(filter: {zoneTag: "${zona}"}) { settings {
  firewallEventsAdaptive      { enabled maxDuration maxPageSize notOlderThan }
  httpRequestsAdaptiveGroups  { enabled maxDuration maxPageSize notOlderThan availableFields }
  httpRequestsAdaptive        { enabled maxDuration maxPageSize notOlderThan }
} } } }
```

La forma del nodo `settings` está [verificado: URL de settings]. Que `httpRequestsAdaptiveGroups` y
`httpRequestsAdaptive` acepten exactamente esos subcampos queda [no verificado]: hay que probarlo con el token de la
demo en la primera hora.

**Presupuesto de cuota:** un ciclo completo al estilo KUADRA cuesta 19 consultas GraphQL contando alias (1 + 7 + 1 + 9
+ 1) y 2 llamadas REST (verify y access_rules; `zones` solo la primera vez). Si se refresca cada 60 s salen unas 95 por
cada 5 min, holgado frente a 300. La cuota es por usuario de Cloudflare, así que cada cliente gasta la suya. Coste en
dinero de la API de Cloudflare: 0 [no verificado como política escrita; ninguna página consultada cobra por llamada].

## 10. Lo que KUADRA no hace y el encargo pide (propuestas)

Todo lo de esta sección es diseño nuestro sobre los mismos datasets; los campos marcados se deben validar con
`availableFields` del §9 antes de construir.

1. **IPs con muchas llamadas sobre TODO el tráfico** (no solo lo que frenó el firewall):
   ```graphql
   topIps: httpRequestsAdaptiveGroups(filter: {${V}}, limit: 20, orderBy: [count_DESC]) {
     count sum { edgeResponseBytes } dimensions { clientIP clientCountryName clientAsn }
   }
   ```
   [no verificado] que `clientIP` y `clientAsn` sean dimensión agrupable en Free. **Plan B** verificado en KUADRA: pedir
   `httpRequestsAdaptive` con `limit` alto (hasta `maxPageSize`) y agrupar en TS (es una muestra).
   Umbral propuesto: IP con más del 10 % del total de la ventana, o más de 50 por la misma regla que KUADRA.
2. **User agents insistentes:** el mismo alias con `dimensions { userAgent }` y sin el filtro `PASO` (KUADRA ya usa
   `userAgent` como dimensión, `:581-584`). Marcar: UA vacío, UAs de herramientas (`curl`, `python-requests`, `Go-http-client`,
   `sqlmap`, `nikto`, `masscan`, `zgrab`) o un UA con más del 20 % de las peticiones. Lista y umbrales: diseño nuestro.
3. **Eventos agregados sin el tope de 1.000:** `firewallEventsAdaptiveGroups` existe como dataset
   [verificado: https://developers.cloudflare.com/analytics/graphql-api/features/data-sets/]. Con él se cuenta por
   `clientIP`, `ruleId`/`description` y `action` en el servidor. Que esas dimensiones estén disponibles en Free queda
   [no verificado].
4. **Pico de tráfico (posible DDoS L7):** KUADRA solo tiene `datetimeHour`. Propuesta: comparar la última hora contra
   la mediana de las 23 anteriores (`porHora` sin `PASO`) y alertar si es 5 veces mayor. Una dimensión de 5 minutos
   (`datetimeFiveMinutes`) queda [no verificado] en este dataset.
5. **Tasa de 4xx y ataques de ruta:** `porEstado` sin `PASO`, más rutas de escáner frecuentes (`/.env`, `/wp-login.php`,
   `/.git/config`) en `rutaErr`/`porRuta`. Diseño nuestro.

## 11. Esqueleto TypeScript portable (sin dependencias; `fetch` vale en Node 18+, Deno/Supabase Edge y Vercel)

```ts
// lib/cloudflare/cliente.ts — port de cloudflare_api.dart. El token llega YA descifrado desde el backend; nunca al navegador.
const CF = 'https://api.cloudflare.com/client/v4';
const TIEMPO_MS = 20_000;
export type CodigoCf = 'red' | 'http' | 'api' | 'permiso' | 'zona' | 'limite';
export class CfError extends Error { constructor(public codigo: CodigoCf, msg: string) { super(msg); } }
export const isoCf = (d: Date) => d.toISOString().split('.')[0] + 'Z';
const ZONA_RE = /^[a-f0-9]{32}$/;

async function llamar(token: string, metodo: string, ruta: string, cuerpo?: unknown) {
  let r: Response;
  try {
    r = await fetch(CF + ruta, { method: metodo, signal: AbortSignal.timeout(TIEMPO_MS),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  } catch (e) { throw new CfError('red', `No se pudo llegar a Cloudflare: ${(e as Error).message}`); }
  if (r.status === 429) throw new CfError('limite', `429, reintentar en ${r.headers.get('retry-after') ?? '?'} s`);
  let j: any;
  try { j = await r.json(); } catch { throw new CfError('http', `Cloudflare respondió ${r.status} sin datos utilizables`); }
  return j;
}

export async function rest<T = any>(token: string, metodo: 'GET' | 'POST' | 'DELETE' | 'PATCH', ruta: string, cuerpo?: unknown) {
  const j = await llamar(token, metodo, ruta, cuerpo);
  if (j.success !== true) throw new CfError('api', `Cloudflare: ${j.errors?.[0]?.message ?? 'error'}`);
  return j as { result: T; result_info?: unknown };
}

export async function gql<T = any>(token: string, query: string): Promise<T> {
  const j = await llamar(token, 'POST', '/graphql', { query });
  if (Array.isArray(j.errors) && j.errors.length) {
    const m = String(j.errors[0].message ?? '');
    throw new CfError(esErrorDePermisos(m) && !/older than|wider than/i.test(m) ? 'permiso' : 'api', `Cloudflare GraphQL: ${m}`);
  }
  return (j.data ?? {}) as T;
}
export const primeraZona = (d: any) => (d?.viewer?.zones?.[0] ?? null) as Record<string, any> | null;

export async function verificarToken(token: string, cuentaId?: string) {
  try { return (await rest<{ status: string }>(token, 'GET', '/user/tokens/verify')).result.status; }
  catch (e) { if (!cuentaId) throw e; return (await rest<{ status: string }>(token, 'GET', `/accounts/${cuentaId}/tokens/verify`)).result.status; }
}
export async function resolverZona(token: string, dominio: string) {
  const { result } = await rest<any[]>(token, 'GET', `/zones?name=${encodeURIComponent(dominio)}`);
  if (!result.length) throw new CfError('zona', `El token no ve la zona ${dominio}. Revisa sus permisos.`);
  const zoneId = result[0].id as string;
  if (!ZONA_RE.test(zoneId)) throw new CfError('zona', 'id de zona inesperado');
  return { zoneId, accountId: (result[0].account?.id ?? '') as string };
}
export const listarBloqueos = (t: string, z: string) =>
  rest<any[]>(t, 'GET', `/zones/${z}/firewall/access_rules/rules?per_page=100&order=created_on&direction=desc`)
    .then(r => r.result.map(x => ({ id: x.id, ip: x.configuration?.value ?? '', modo: x.mode, notas: x.notes ?? null, creada: x.created_on })));
// bloquearIp / quitarBloqueo: copiar el POST/DELETE del §3. Detrás de confirmación explícita (decisión del equipo).

export function ventana(horas = 24, ahora = new Date()) {
  const hasta = ahora, desde = new Date(ahora.getTime() - horas * 3_600_000);
  return { desde, hasta, V: `datetime_geq: "${isoCf(desde)}", datetime_leq: "${isoCf(hasta)}"` };
}
// Las 5 consultas del §5 van aquí como funciones (zona, horas) => string, pegando el texto tal cual.
// Orquestación (port de servicio.dart:63-166): resolver zona, luego Promise.allSettled de los 6 viajes;
// guardar por viaje { ok, error, hora } y conservar el último dato bueno si uno falla.
```

Tipos de salida que el FRONT puede consumir tal cual (equivalen a las clases Dart): `EventoFw` (campos del §5.1),
`GrupoTrafico { etiqueta, detalle, peticiones, bytes, visitas }`, `FilaSalud { etiqueta, total, errores, tasa }`,
`SaludOrigen { total, errores, tasa, porCache, porColo, porRuta, porEstado, porHora, peorCache }`,
`TraficoAprobado { totalPeticiones, muestreoMedio, porAccion, porHora, porPais, porRuta, porEstado, porAgente }`,
`TraficoDia { fecha, solicitudes, bytes, amenazas, visitantesUnicos }`, `ReglaBloqueo { id, ip, modo, notas, creada }`.
Todas llevan `desde`/`hasta`: "sin ella la pantalla dice «últimas 24 horas» sin poder decir desde cuándo"
(`cloudflare_api.dart:134-137`).

## 12. MCP de Cloudflare (la intención del dueño es "todo por MCP")

- El servidor MCP **GraphQL** (`https://graphql.mcp.cloudflare.com/mcp`), y también Observability, Audit Logs, DNS
  Analytics y Radar, figuran como **Deprecated** en el README oficial, que recomienda migrar al **Cloudflare API MCP
  Server** `https://mcp.cloudflare.com/mcp`
  [verificado: https://github.com/cloudflare/mcp-server-cloudflare].
- El API MCP Server expone 4 herramientas: `docs`, `search` (JS sobre `spec.paths`), `execute` (JS que llama a
  `cloudflare.request()`) y `whoami`. Admite OAuth o **API token como Bearer**, tanto de usuario como de cuenta; los de
  cuenta necesitan `Account Resources: Read`, y no se admiten tokens con filtro de IP. Las llamadas GraphQL pasan por
  `execute` con POST a `/client/v4/graphql`
  [verificado: https://github.com/cloudflare/mcp].
- **Conclusión práctica:** el MCP ejecuta código arbitrario contra la API con los permisos del token. Para el
  **monitoreo periódico** (cada 60 s, umbrales deterministas) conviene más el cliente directo del §11: es más barato,
  predecible y no gasta tokens de Claude. El MCP queda para la **investigación de un incidente por el agente IA**
  ("¿qué hizo esta IP en la última hora?") con un token de **solo lectura**, así un `execute` no puede escribir.

## Implicaciones para el plan

**Adoptar (tal cual):**
- Las 5 consultas del §5 y los 3 endpoints REST del §3, en un único `lib/cloudflare/cliente.ts` (§11) que corre en el
  BACK (Edge Function de Supabase o ruta de servidor de Vercel). **Esfuerzo S** (2-3 h con los textos ya copiados).
- El patrón de los 6 viajes con `Promise.allSettled`, error por viaje y conservación del último dato bueno con su hora.
  **S.**
- Los umbrales del §8 como **motor de reglas determinista** (concuerda con la decisión del equipo: las reglas deciden
  la alerta, no el modelo): 5xx 0,5 %/5 %, insistente ≥ 50 eventos/24 h sin regla, lote al tope 1.000, reglas al tope
  100, token ≠ active, sin permiso. **S.** Las alertas `origen_5xx` (con el corte por caché) e `ip_insistente` son las
  dos con mejor relato para la demo: "detectamos que el 50 % de lo que va a tu origen falla" y "esta IP te martilla y no
  tiene regla: ¿la bloqueo?".
- La tabla de archivo `cf_eventos_firewall` con deduplicación `(conexion_id, ray_id, match_index)`, los `left()`
  anti-basura y el lote como un único JSON (`jsonb_to_recordset`). Le da histórico más allá de las 24 h de Free.
  **M** (tabla + RPC + cron de archivado cada ≤ 12 h).
- Enseñar el muestreo (`avg.sampleInterval`) y la ventana `desde/hasta` junto a cada cifra. Para un jurado técnico es
  honestidad de ingeniería y cuesta poco.

**Añadir (no está en KUADRA y el encargo lo pide):** top de IPs y UAs sobre todo el tráfico, picos por hora (posible
DDoS) y `firewallEventsAdaptiveGroups` (§10). **M.** Antes de construir hay que validar con `settings.availableFields`
y con el token real de la zona de demo: **primera tarea del BACK, S (30 min)**.

**Evitar:**
- Fijar la ventana en 48 h o 7 d para los datasets adaptativos: en Free devuelve error. Leer `maxDuration` de `settings`.
- Creer que `firewallEventsAdaptive` es un log completo: es una muestra (393 de unas 2.192 en el caso medido).
- Pedir `Firewall Services Edit` por defecto. El token básico de solo lectura es Zone Read + Analytics Read, y bloquear
  pasa a ser opcional con confirmación (el plan previo pide código de un solo uso por WhatsApp o en la app).
- Paginar mal las access rules: KUADRA lee solo 100. Si el cliente tiene más, hay que paginar (`page=`) o avisar.
- Usar el servidor MCP GraphQL: está deprecado.
- Interpolar cualquier valor que venga del usuario en el texto GraphQL. Solo se interpolan `zoneTag` validado y fechas
  generadas en el servidor.

**Riesgos:**
- La cuota de 300 consultas GraphQL por 5 min y usuario cuenta cada alias. Hay que refrescar como mucho cada 60 s y
  cachear en la base. Con una demo de varias pestañas abiertas se puede agotar: un solo poller en el BACK, nunca uno
  por navegador.
- En una zona Free con poco tráfico, la demo sale "vacía". **Hay que generar tráfico de ataque contra nuestra propia
  app** (como decidió el equipo) unas horas antes, porque no hay histórico más allá de 24 h.
- El token de cuenta y el de usuario se verifican en rutas distintas (§2). Si no se maneja, la UI dirá "token
  inválido" con un token válido.
- Hay campos que KUADRA usa sin verificación externa (`threats`, `uniques`, `clientDeviceType`, `coloCode`): funcionan
  en su zona, pero hay que probarlos en la nuestra.

**Esfuerzo total del módulo Cloudflare en el BACK:** cliente + reglas + archivo + 2 detecciones nuevas = **M**
(unas 6-8 h de un chat BACK). Las pantallas del FRONT (cifras, alertas "Ahora", tablas de reparto, gráfico por hora,
tabla de eventos con "Bloquear") = **M**.
