# R06 — KUADRA: módulos «IPs bloqueadas» y «Logs y crones» → detecciones portables

Etapa 1 de 4 del plan maestro (investigación). Lectura en SOLO LECTURA de KUADRA (24-10-2026).
Cloudflare se trata a fondo en `R05-kuadra-cloudflare.md`; aquí solo entra lo que el módulo de IPs enlaza.

## 0. Resumen en 10 líneas

1. Ninguno de los dos módulos calcula nada en Dart: cada uno hace **una sola llamada RPC** (`crm_ips_estado`, `crm_logs_estado`)
   que devuelve un **sobre JSON** ya clasificado (cifras, «Ahora», checks, secciones, errores). La base decide; la UI pinta.
2. `nucleo/lukapay_worker_api.dart` **no alimenta** IPs ni Logs: es el cliente HTTP del Worker que guarda credenciales de pago.
   Lo único portable de él es su higiene de secretos (§1.3).
3. Los datos de IPs salen del **freno propio de KUADRA**: un `db_pre_request` de PostgREST (`plataforma.guardia_peticion`)
   que cuenta peticiones por identidad y por IP y deja el rastro horario en `plataforma.freno_hora`.
4. Los datos de Logs salen de **tablas de Postgres** (`cron.job`, `cron.job_run_details`, `net._http_response`, auditoría
   propia). KUADRA **no usa** el Logs Explorer ni la API de analítica de Supabase.
5. Heurísticas de IP que sí existen: techo alcanzado (topes), peticiones rechazadas (429), pico ≥ 50 % del techo, techo
   global por IP de 3000/min, «IP insistente» de Cloudflare (≥ 50 eventos de firewall en 24 h sin regla en el borde).
6. Lo que **no existe** en KUADRA: user agents sospechosos, escaneo de rutas, enumeración de tablas, fuerza bruta vía
   logs de Auth. Hay que crearlo (§4, filas marcadas N). Los datos para hacerlo sí están en Supabase Logs y Cloudflare.
7. El valor más portable son las **salvaguardas de bloqueo**: máscara mínima /16 y /32, «personas detrás», «este equipo»,
   «nunca llega», infraestructura propia no bloqueable, simulación por defecto (`p_simular = true`).
8. Para nuestro producto la fuente equivalente es la **Management API de Supabase**: logs en dialecto **ClickHouse** con
   ventana máxima de 24 h, más SQL de solo lectura contra `cron`/`net` para crones y llamadas salientes.
9. Supabase no da a sus clientes un bloqueo de IP para su API REST. La acción real de bloqueo es Cloudflare (si el dominio
   va por proxy) o un **prompt de corrección** que instale un guard `db_pre_request` estilo KUADRA en el proyecto del cliente.
10. Catálogo final: 22 detecciones de KUADRA (K) + 8 nuevas (N), con id, señal, fuente, ventana, umbral, severidad y acción.

## 1. Qué se leyó y cómo está montado

| Pieza | Ruta | Papel |
|---|---|---|
| IPs (6 ficheros, 2229 líneas) | `KUADRA CRM/kuadra_crm/lib/modulos/ips/` | `servicio.dart` (RPC), `modelos.dart` (parseo y validación IP), `controlador.dart` (ciclo 30 s, barra de cambios), `columnas.dart`, `pantalla.dart`, `modulo.dart` |
| Logs (6 ficheros, 1631 líneas) | `KUADRA CRM/kuadra_crm/lib/modulos/logs/` | `servicio.dart` (una RPC), `modelos.dart`, `controlador.dart` (filtros), `columnas.dart`, `pantalla.dart` |
| Worker LukaPay | `lib/nucleo/lukapay_worker_api.dart` (345) | No alimenta estos módulos |
| SQL de IPs | `KUADRA MASTER/supabase/migrations/20261018002407_crm_ola4_b_seguridad_ips.sql` | `crm_ips_estado`, `_crm_ips_*`, `crm_ip_bloquear`, `crm_ip_desbloquear` |
| SQL de Logs | `…/20261018001004_crm_ola4_b_datos_logs.sql` | `crm_logs_estado`, `_crm_logs_ahora`, `cron_cobertura`, `_cron_periodo` |
| Freno (rate limit) | `…/20260927171750_crm_ola2b_etapa3_guardia_nuevo.sql`, `…/20260926233228_crm_ola2b_za_motor_freno_sombra.sql`, `…/20260926232301_crm_ola2b_zc_rastro.sql`, `…/20261018000523_crm_ola4_b_freno_h8.sql` | `guardia_peticion`, `freno_catalogo`, `freno_clase`, `freno_hora`, `_crm_freno_ident` |
| IP de la petición | `…/20260926231726_crm_ola2b_zb_ip_helper_auditoria_via_y_default_privileges.sql` | `plataforma.ip_peticion(json)` |
| Cloudflare (enlace) | `lib/nucleo/cloudflare_api.dart`, `…/20261018000726_crm_ola4_b_cloudflare_ajustes_rpc.sql` | GraphQL, access rules, «insistente» |

### 1.1 Transporte

- Todo va por `POST {SUPABASE_URL}/rest/v1/rpc/<nombre>` con la clave `service_role` del CRM (`llamadaHttp` del módulo
  freno). Las RPC `crm_*` tienen `EXECUTE` solo para `service_role`; las internas `_crm_*` para nadie (asserts al final de
  cada migración lo comprueban).
- Lista blanca de RPC por módulo en el cliente: `rpcDeIps = {crm_ips_estado, crm_ip_bloquear, crm_ip_desbloquear,
  crm_freno_visto}`. Una acción que la base proponga con otro nombre no se ejecuta (`rpc_no_permitida`).
- Refresco: `CicloDatos` cada **30 s** y solo con el módulo a la vista; F5 / «Actualizar» fuerza lectura.
- La lectura es `STABLE` y **no audita**; las escrituras llevan `p_simular boolean default true` (simulando no escriben).

### 1.2 El sobre que devuelve cada módulo (contrato §1.1, portable tal cual)

```json
{
  "ok": true, "modulo": "ips", "hora": "2026-10-18T21:40:00Z",
  "rango": {"pedido": "24 h", "desde": "...", "hasta": "..."},
  "contador": {"rojo": 1, "aviso": 3, "cola": 2},
  "estado": {"texto": "Guardia encendido", "rol": "bien", "codigo": "aplica"},
  "cifras": [{"tipo": "activos", "etiqueta": "Activos", "rol": "neutra", "n": 4, "sub": "Rango 1", "siempre": true, "ancla": "activos"}],
  "ahora": [{"grupo": "bloqueables", "etiqueta": "Bloqueables", "rol": "aviso", "n": 2, "orden": 70, "filas": [
    {"clave": "ips:sugerencia_bloqueable:203.0.113.9", "tipo": "sugerencia_bloqueable", "rol": "aviso",
     "objeto": "203.0.113.9", "etiqueta": "Bloqueable", "sub": "Sin sesión · 14 topes · 3 rech. · 1 persona · 21:14",
     "dato": {"ip": "203.0.113.9"},
     "acciones": [{"id": "bloquear", "verbo": "Bloquear 24 h", "clase": "barra", "rpc": "crm_ip_bloquear",
                   "args": {"p_ip": "203.0.113.9", "p_motivo": "Topes sin sesión", "p_horas": 24},
                   "principal": true, "simula": true, "resultado": "Bloqueada"}]}]}],
  "checks": [{"nombre": "Nunca llega", "codigo": "nunca_llega", "n": 0, "comprobado": true}],
  "secciones": {"activos": {"n": 4, "filas": []}, "sugerencias": {"n": 9, "horas": 24, "filas": []}, "historial": {"n": 12, "filas": []}},
  "errores": {}
}
```

- `rol` de fila: `mal` (rojo) · `aviso` (ámbar) · `cola` (pendiente sin urgencia). El contador cuenta filas por rol.
- Clases de acción: `inmediata` (ejecuta ya), `confirmar` (vista previa simulada en la fila y luego aplica), `barra`
  (va a una cola de cambios que se simula entera contra la base antes de escribir), `navegar` (lleva a otro módulo).
- Cada sección falla por separado: si una consulta revienta, la sección va `null` y su `sqlstate` a `errores`; el resto llega.
- Este sobre es directamente el contrato que el chat FRONT puede pintar y que el motor de reglas del BACK puede producir.

### 1.3 `lukapay_worker_api.dart`: lo único aprovechable

No toca IPs ni logs. Patrones de higiene que sí sirven para nuestro manejo de API keys de clientes:
- Las credenciales van del CRM al Worker por HTTPS y **no pasan por la base**; el Worker las prueba contra el proveedor
  antes de guardarlas cifradas y el CRM las olvida.
- Cabecera de secreto propia (`x-kuadra-crm`), timeout de **10 s**, y un `404` sin cuerpo a quien no trae el secreto (no
  revela que el servicio existe).
- **Nunca** registra cuerpos, cabeceras ni el texto de una excepción de red (puede llevar el secreto): solo códigos cortos
  (`sin_configurar`, `secreto_invalido`, `no_desplegado`, `tiempo`, `red`, `forma`, `http_<n>`).
- «Comprobar» sondea con un id nulo (`00000000-…`) para saber si el Worker contesta sin tocar datos reales.

## 2. De dónde salen los datos

### 2.1 IPs: el freno dentro de la base

```
petición → PostgREST → db_pre_request = plataforma.guardia_peticion()
   0) IP bloqueada?  ip_peticion(headers) → ip_esta_bloqueada(ip) → PT403 (HTTP 403)
   1) techo de la ruta por identidad (uid > aparato POS > IP) → contar_objetivo(...) en ventana
   2) techo GLOBAL por IP ('@ip') siempre
   conteo = techo  → _freno_anotar_tope() → plataforma.freno_hora (topes)
   conteo > techo  → PT429 + nextval(secuencia de rechazos de la clase) → rechazadas
freno_barrer() (cron) → agrega rate_limits_objetivo → freno_hora: pico = max(conteo) por hora y ruta
```

- **Extracción de IP** (`plataforma.ip_peticion`): primero `cf-connecting-ip`; si falta, es inválida o trae máscara,
  `sb-forwarded-for`; si no, el **último** valor de `x-forwarded-for`. `::ffff:a.b.c.d` se reduce a `a.b.c.d`.
- **Exentos**: `service_role` (CRM y edge functions) nunca se frena ni se bloquea. **Falla abierta**: cualquier error o
  `statement_timeout` deja pasar (salvo un corte de ruta ya decidido tras una lectura correcta).
- **Alcance del bloqueo** (texto literal de la base): «Solo la API de Supabase (tablas y RPC). NO cubre login, Storage,
  Realtime ni edge functions, ni Cloudflare.»
- Rechazos de forma (señales de evasión o escaneo): ruta con `%` → **PT400 `ruta_no_canonica`**; `GET/HEAD` a una RPC que
  no es `STABLE/IMMUTABLE` → **PT405 `get_volatil`**.

Tabla `plataforma.freno_hora` (grano: hora × ruta × IP; PK `(hora, ruta, ip)`):

| Campo | Tipo | Significado |
|---|---|---|
| `hora` | timestamptz | en punto (`date_bin('1 hour', …)`) |
| `ruta` | text | `/rpc/x`, `/tabla`, `@ip`, `edge:…`, `clase:…` |
| `ip` | text | IP, o `*` (total de la ruta), `otras`, `sin_ip` |
| `clase`, `techo` | text, int | clase del catálogo y techo efectivo |
| `topes` | int | veces que se alcanzó el techo |
| `rechazadas` | int | peticiones cortadas con 429 |
| `pico` | int | máximo conteo en una ventana dentro de la hora |
| `muestra` | text[] ≤ 5 | identidades vistas (`uid:`, `pos:`, `ip`) — base de «personas detrás» |
| `revisado` | bool | «Marcar visto» |
| `primera`, `ultima` | timestamptz | primer y último tope |
| `ident_local`, `ident_aws`, `ident_legitimo` | — | identidad congelada al anotar el tope (`freno_barrer`) |

Otras fuentes de IPs: `plataforma.ip_bloqueadas` (`ip inet` normalizada con `network()`, `motivo`, `hasta` null =
indefinido, `origen` manual/sugerencia/evento, `creado_por`), `plataforma.eventos_seguridad` (`tipo`, `identificador`,
`detalle->>'ip'`, `ultima_vez`; tipos vistos: `fuerza_bruta_cuenta`, `qr_mesa_fallos_ip`, `qr_mesa_fallos_global`,
`login_pos_ok`, `invitado_recuperado_otra_ip`), `plataforma.auditoria` (rastro de cambios con `via` e `ip_address`) y
`comercios.sesiones_personal` (IP de sesiones legítimas del POS).

### 2.2 Techos del freno (los números de KUADRA)

Techos por defecto (`freno_clase`, todos por minuto y **por identidad**, no por cliente):

| Clase | Techo/min | | Clase | Techo/min |
|---|---|---|---|---|
| `irreversible` | 3 | | `pos_dinero` | 60 |
| `envio` | 5 | | `comensal_dinero` | 12 |
| `export` | 6 | | `pos_escritura` | 300 |
| `credencial_critica` | 5 | | `comensal_escritura` | 60 |
| `credencial` | 10 | | `publico_escritura` | 10 |
| `login` | 50 | | `tabla_escritura` (REST) | 120 |
| `pos_dinero_critico` | 20 | | `sistema` | 600 |
| `pos_lectura` / `comensal_lectura` | 600 | | `edge_publica` | 30 |
| `publico_lectura` | 60 | | `edge_envio` / `edge_credencial` | 10 |
| `edge_interna` | 60 | | `*` (ruta sin catálogo) | 120 |
| `@ip` (global por IP, todas las rutas) | **3000** | | `servicio`, `exenta`, `no_contable` | sin techo |

Criterio documentado en la migración: «generoso por defecto, apretado en pago, facturación e identidad»; `*` = 120/min
(«2 por segundo sostenidos es muchísimo para una pantalla y ridículo para un script») y nunca por debajo de 120;
`@ip` alto a propósito porque detrás de una IP puede haber un local entero con su wifi.

### 2.3 Logs: tablas de Postgres, no el Logs Explorer

| Sección | Fuente | Ventana | Qué se lee |
|---|---|---|---|
| Crones | `cron.job` + `plataforma.cron_clase` | actual | `jobname`, `schedule`, `active`, clase (`producto`/`higiene`/`anormal`), pausa con motivo, impacto |
| Última corrida | `cron.job_run_details` (solo la **última** por job) | — | `status`, `start_time`, `return_message` |
| Corridas no exitosas | `cron.job_run_details` (`status <> 'succeeded'`) | 90 d (purga) | nombre, estado, inicio, ms, mensaje |
| HTTP saliente | `net._http_response` | `pg_net.ttl` leído en vivo (defecto **6 h**) | `id`, `status_code`, `timed_out`, `error_msg`, `created`; **nunca** `content` ni `headers` |
| Auditoría CRM | `plataforma.crm_auditoria` | 90 d; «Ahora» 24 h | SQL manual ejecutado desde el CRM, éxito, filas, ms, error |

El horario cron lo entiende la base: `_cron_periodo(schedule)` devuelve el **hueco mayor** entre dos corridas
(«0 4,10,16,22 * * *» → 8 h; acepta «N seconds»), `_cron_proxima` la siguiente ejecución.

### 2.4 Cloudflare (lo que IPs enlaza; detalle en R05)

- `POST https://api.cloudflare.com/client/v4/graphql` con `firewallEventsAdaptive` (campos `clientIP`, `userAgent`,
  `clientRequestPath`, `clientRequestQuery`, `edgeResponseStatus`, `action`, `source`, `ruleId`, `rayName`, ASN, país),
  límite 1000, y `httpRequestsAdaptiveGroups` con alias `porAgente { dimensions { userAgent } }`, `porRuta`, `porEstado`,
  `porPais`, `porHora`, `porAccion` en una sola consulta.
- Bloqueo en el borde: `POST /zones/{zone}/firewall/access_rules/rules` con
  `{"mode":"block","configuration":{"target":"ip"|"ip6","value":"<ip>"},"notes":"…"}`; `GET …?per_page=100&order=created_on&direction=desc`;
  `DELETE …/rules/{id}`. [verificado en código KUADRA en uso; documentación no revisada en esta sesión]
- En plan Free la ventana de `firewallEventsAdaptive` no puede pasar de **1 día** (KUADRA lo midió el 2026-08-29); por eso
  KUADRA archiva los eventos en `plataforma.cloudflare_firewall_archivo` (dedup `ray_id + match_index`).
- Cuota GraphQL: 300 consultas por ventana de 5 min por usuario; los datasets adaptativos guardan ≥ 31 días.
  [verificado: https://developers.cloudflare.com/analytics/graphql-api/limits/]

## 3. Heurísticas y umbrales tal como están en KUADRA

### 3.1 Sugerencias de bloqueo (`_crm_ips_sugerencias(p_horas)`)

- Ventana: `p_horas` ∈ {24, 168} (selector «24 h / 7 d»). «Ahora» y las cifras usan siempre 24 h fijas.
- Filas candidatas: `freno_hora` con `ip` real (no `*`, `otras`, `sin_ip`), `ultima > now() - ventana` y
  `topes + rechazadas + pico > 0`; se agregan por IP: `sum(topes)`, `sum(pico)`, `sum(rechazadas)`, `array_agg(ruta)`,
  `rutas_sin_ver` (rutas con topes o rechazos no revisados), `min(primera)`, `max(ultima)`.
- Orden: `topes + pico desc, rechazadas desc, ultima_vez desc`.
- Tipos por IP: `tope` si topes > 0, `rechazo` si rechazadas > 0, `volumen` si pico > 0.
- **Quién hay detrás** (`_crm_seguridad_quien`, gana la primera regla que case):

| `quien` | Regla | ¿Bloqueable? |
|---|---|---|
| `aws` | la IP llamó en 7 d a edge functions o a RPC públicas con parámetro `p_secreto` (= infraestructura propia) | no |
| `local` | la IP tiene una sesión del POS o un `login_pos_ok` en la hora del tope o en los 7 d siguientes | no |
| `aparato` | hay huellas de aparato POS (`pos:<uuid>`) en la muestra | no |
| `comensal` | hay un usuario legítimo (sesión no anónima) detrás | no |
| `sin_sesion` | nada de lo anterior | **sí** |

- Además no es bloqueable si ya está cubierta por un bloqueo vigente (`motivo_sin_bloqueo = 'ya_bloqueada'`).
- Motivo propuesto: «Topes sin sesión» si `quien = sin_sesion`, si no «Topes».
- Pasa a «Ahora» (grupo `bloqueables`, rol `aviso`, orden 70) solo si es bloqueable **y** tiene rutas sin ver en 24 h.

### 3.2 Pico

`freno_barrer` registra una fila horaria de ruta cuando `max(conteo) * 2 >= techo` (el minuto más cargado llegó al
**50 % del techo**) o cuando la ruta no está en el catálogo. `pico = max(conteo)`; topes = minutos con `conteo >= techo`.
Se guardan como máximo 500 rutas por hora, ordenadas por `pico / techo desc`.

### 3.3 «Personas detrás» (`_crm_ips_personas(red)`, ventana 7 d)

`count(distinct ident)` de la muestra de `freno_hora` (identidades `uid:`, `pos:` o la IP) cuyas IPs caen dentro de la red,
más los `identificador` de `eventos_seguridad` con esa IP. Si `> 1`: aviso «puede ser el wifi de un local: al bloquearla se
quedan fuera TODAS». Es la defensa contra falsos positivos por NAT.

### 3.4 Salvaguardas de un bloqueo (`crm_ip_bloquear`, también en la validación en vivo del campo)

| Regla | Umbral | Resultado |
|---|---|---|
| IP vacía / no es inet | — | error `falta_ip` / `ip_invalida` |
| IPv4 mapeada en IPv6 (`::ffff:0:0/96`) | — | error `ip_mapeada` («así no bloquearía nada») |
| Máscara demasiado ancha | IPv4 `< /16`, IPv6 `< /32` | error `mascara_demasiado_ancha` (también un CHECK en la tabla) |
| Motivo | obligatorio, ≤ 300 caracteres | `falta_motivo` / `motivo_largo` |
| Plazo | 1…8760 h; `null` = indefinido; atajos 1 h · 24 h · 7 d · indefinido | `horas_invalidas` |
| Rango amplio | IPv4 `< /24`, IPv6 `< /48` | aviso `rango_amplio` + «Rango · N direcciones» |
| IPv6 suelta | máscara `> /64` | aviso `ipv6_64` («bloquea el /64») |
| Personas detrás | `> 1` en 7 d | aviso `personas` + «Cortaría N» en la vista previa |
| Este equipo | la IP del operador cae dentro | aviso `este_equipo` |
| Nunca llega | IPv6, o dentro de `0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4` | aviso `nunca_llega` (la API solo ve IPv4 públicas) |
| Re-bloqueo | ya vigente | `ya_estaba`; si el nuevo plazo es más corto: `caducidad_acortada` |
| Normalización | bits de host ≠ 0 (`1.2.3.77/24`) | se guarda `network()` y aviso `normalizada` |

Respuesta de una simulación (forma §1.8): `{ok, simulado, resultado, en, efecto: "Afecta 256 · Personas 3", chapas[],
avisos[] (códigos), aviso (texto), ip, direcciones, personas_detras, cubierta_por[], este_equipo, nunca_llega, acorta}`.
`crm_ip_desbloquear` por id «vence» la fila (`hasta = now()`, queda en historial) y por IP levanta por contención (`<<=`);
nunca dice «desbloqueada» si sigue cubierta por un rango (`sigue_bloqueada`, `cubierta_por`, `quedan_dentro`).

### 3.5 «Ahora» de IPs: un problema por bloqueo vigente (el primero que case)

| Orden | Tipo | Condición | Rol | Acción principal |
|---|---|---|---|---|
| 10 | `guardia_no_aplica` | el `db_pre_request` no está activo, no apunta a `guardia_peticion` o la comprobación de IP va después del filtro de métodos | mal | Abrir Freno |
| 20 | `bloqueo_de_local` | el bloqueo cubre la IP de un cliente legítimo (local) | mal | Desbloquear |
| 30 | `bloqueo_este_equipo` | cubre la IP del operador | aviso | Desbloquear |
| 40 | `sin_fin_30d` | indefinido y creado hace > 30 d | aviso | Poner 7 días |
| 50 | `personas_detras` | > 1 persona en 7 d | aviso | Desbloquear / Poner 1 h |
| 60 | `nunca_llega` | IPv6 o red no enrutable | aviso | Desbloquear |
| 70 | `sugerencia_bloqueable` | §3.1 | aviso | Bloquear 24 h / Marcar visto |
| 80 | `caduca_pronto` | `hasta < now() + 1 h` | cola | Alargar 24 h |
| 90 | `cubierto_por_rango` | otro bloqueo vigente más ancho lo contiene | cola | Quitar |

Checks al pie (se muestran solo los que están en 0): «De locales», «Sin fin 30 d», «Nunca llega».
Historial 30 d: `fin = levantado` si la auditoría tiene un UPDATE de la fila en ±1 s de `hasta`, si no `vencido`.

### 3.6 «Ahora» de Logs (`_crm_logs_ahora`)

| Orden | Tipo | Condición exacta | Rol |
|---|---|---|---|
| 10 | `cron_fallo` | `active` y la última corrida `status = 'failed'` | mal |
| 20 | `cron_atrasado` | `active`, última no fallida y (nunca corrió **o** `start_time < now() - least(2 × periodo, periodo + 2 h)`); diario → 26 h | aviso |
| 30 | `cron_apagado` (G3) | `not active` sin pausa con motivo vigente | mal |
| 40 | `cron_cobertura` | G1 job sin clase · G2 **huella cambiada** (`md5` de schedule+command+username+database distinta de la registrada) · G4 job cuyo comando llama a `crm_*(`, `freno_sincronizar` o se llama `*sincroniz*`/`*monitor*` · G6 falta el cron que re-enciende el guardia | mal |
| 50 | `clase_sobrante` (G5) | clase registrada sin cron | aviso |
| 70 | `http_fallo` | `net._http_response` en `pg_net.ttl` con `timed_out` o `error_msg` o `status_code >= 400` | cola |
| 80 | `consulta_fallida` | SQL manual del CRM fallido en 24 h | cola |

Acciones de Logs: solo `Ver corridas` (navegar con filtro), `Copiar error`, `Copiar nombre`, `Copiar SQL`. El módulo no
escribe nada.

### 3.7 Lo que KUADRA NO tiene (verificado por búsqueda en `lib/` y en las migraciones)

No hay heurísticas de user agent (no aparece `sqlmap`, `nikto`, `python-requests`, `bot_score`…), ni de escaneo de rutas
(`/.env`, `wp-login`…), ni de proporción de 404 por IP. Cloudflare trae `userAgent` y `clientRequestPath` pero KUADRA solo
los muestra (top 10 agentes, top 15 rutas). Las filas N del catálogo son propuesta nuestra, con umbrales a calibrar.

## 4. Catálogo de detecciones portables

Severidad propuesta → canal (decisión previa del equipo: decide el motor de reglas, no el modelo):
**crítica** = WhatsApp + llamada ElevenLabs · **alta** = WhatsApp · **media** = panel + resumen diario · **baja** = panel.
Equivalencia con KUADRA: crítica/alta ≈ `mal`, media ≈ `aviso`, baja ≈ `cola`.
Origen: **K** = existe en KUADRA (umbral de KUADRA) · **N** = nueva (umbral propuesto, calibrar con la demo).
Fuentes: **SL** = Supabase Logs API (§5.1) · **PG** = SQL de solo lectura en la base del cliente (§5.2) ·
**CF** = Cloudflare GraphQL/REST (§5.3, R05) · **INT** = estado interno de nuestro producto.

| id | Señal | Fuente | Ventana | Umbral | Sev. | Acción ofrecida | Orig. |
|---|---|---|---|---|---|---|---|
| IP-01 | IP alcanza techo de una ruta (topes) | SL `edge_logs` (conteo por IP+ruta) | 1 min, agregado 24 h | conteo ≥ techo de la clase (§2.2); ruta sin clase 120/min | media | Bloquear 24 h (si bloqueable) · Marcar visto | K |
| IP-02 | Techo global por IP | SL `edge_logs` | 1 min | ≥ 3000 peticiones/min sumando todas las rutas | alta | Bloquear 1 h en CF · prompt guard | K |
| IP-03 | Peticiones rechazadas por rate limit | SL `edge_logs` `status = 429` por IP | 24 h | > 0 (alta si ≥ 100) | media | Ver · Bloquear 24 h | K |
| IP-04 | Pico de volumen | SL `edge_logs` | minuto más cargado de 1 h | ≥ 50 % del techo | baja | Ver | K |
| IP-05 | IP sugerida bloqueable | IP-01..04 + «quién» (§3.1) | 24 h / 7 d | bloqueable y con rutas sin ver | alta | Bloquear 24 h · Marcar visto | K |
| IP-06 | Bloqueo que corta a un usuario legítimo | INT (bloqueos) + SL (peticiones autenticadas) | 7 d | IP bloqueada con usuario autenticado detrás | crítica | Desbloquear | K |
| IP-07 | Bloqueo con varias personas detrás | INT + SL | 7 d | > 1 identidad distinta | alta | Desbloquear · Poner 1 h | K |
| IP-08 | Bloqueo cubre la IP del operador | INT | actual | IP del operador dentro de la red bloqueada | alta | Desbloquear | K |
| IP-09 | Bloqueo indefinido olvidado | INT / CF access rules | 30 d | indefinido y creado hace > 30 d | media | Poner 7 días | K |
| IP-10 | Bloqueo que nunca llega | INT | actual | IPv6 en un origen que solo ve IPv4, o red reservada (§3.4) | media | Desbloquear | K |
| IP-11 | Bloqueo caduca pronto | INT | 1 h | `hasta < now + 1 h` | baja | Alargar 24 h | K |
| IP-12 | Bloqueo redundante | INT | actual | contenido en un rango vigente | baja | Quitar | K |
| IP-13 | Rate limit de la base apagado | PG `pg_db_role_setting` (`pgrst.db_pre_request` de `authenticator`) | actual | sin guard, o guard que no mira la IP antes de filtrar métodos | alta | Prompt de corrección (instalar guard) | K |
| IP-14 | Ruta codificada / GET a RPC volátil | SL `edge_logs` | 1 h | ≥ 5 paths con `%` en `/rest/v1/`, o `GET /rest/v1/rpc/*` a función VOLATILE | media | Bloquear 24 h | K |
| CF-01 | IP insistente en el borde | CF `firewallEventsAdaptive` archivado | 24 h | ≥ 50 eventos y sin access rule | media | Bloquear en Cloudflare | K |
| CF-02 | Errores 5xx del origen | CF `httpRequestsAdaptiveGroups` | 24 h | ≥ 0,5 % aviso · ≥ 5 % mal | alta / crítica | Ver ruta peor · prompt | K |
| CF-03 | Archivo de eventos atrasado | INT | — | último archivado > 12 h aviso · > 24 h hueco (en Free se pierden) | media | Archivar ahora | K |
| LOG-01 | Cron fallando | PG `cron.job_run_details` | última corrida | `active` y `status = 'failed'` | alta | Ver corridas · Copiar error | K |
| LOG-02 | Cron atrasado | PG `cron.job` + `job_run_details` | — | `start_time < now - least(2p, p + 2 h)` o nunca corrió | media | Ver corridas | K |
| LOG-03 | Cron apagado sin motivo | PG `cron.job.active = false` | actual | sin pausa registrada | alta | Copiar nombre · prompt | K |
| LOG-04 | **Cron modificado** (huella) | PG `cron.job` vs huella guardada al conectar | cada lectura | `md5(schedule‖command‖username‖database)` ≠ huella de alta, o cron nuevo sin aprobar | crítica | Revisar · prompt | K |
| LOG-05 | HTTP saliente fallando (pg_net) | PG `net._http_response` | `pg_net.ttl` (6 h) | `timed_out` o `error_msg` o `status ≥ 400` | baja (alta si ≥ 10 en 1 h) | Copiar error | K |
| N-01 | UA de herramienta de ataque | SL `edge_logs`/`auth_logs`; CF | 1 h | UA contiene `sqlmap`, `nikto`, `nuclei`, `masscan`, `zgrab`, `wpscan`, `dirbuster`, `gobuster`, `ffuf`, `hydra`, `acunetix`, `nessus` (≥ 1 petición) | crítica | Bloquear IP en CF · prompt | N |
| N-02 | UA de script contra la API | SL; CF | 1 h | UA vacío o con `python-requests`, `curl/`, `Go-http-client`, `Wget`, `aiohttp`, `axios/`, `node-fetch`, `okhttp`, `libwww-perl`, `Scrapy`; ≥ 300 peticiones/h desde < 5 IPs | alta | Bloquear 24 h · regla CF por UA | N |
| N-03 | UA insistente | SL; CF | 1 h | un UA no-navegador > 30 % del tráfico y ≥ 1000 peticiones/h | media | Ver · regla CF | N |
| N-04 | Escaneo de rutas | SL `edge_logs`; CF | 10 min | misma IP: ≥ 30 rutas distintas y ≥ 20 respuestas 400/401/403/404 | alta | Bloquear 24 h | N |
| N-05 | Sondeo de ficheros sensibles | SL; CF | 1 h | ≥ 3 peticiones a `/.env`, `/.git/`, `/wp-login.php`, `/phpmyadmin`, `/actuator`, `/server-status`, `/.aws/`, `/config.json`, `/backup` | crítica | Bloquear IP en CF | N |
| N-06 | Enumeración de tablas por REST | SL `edge_logs` | 10 min | misma IP: ≥ 15 tablas distintas `/rest/v1/<tabla>` (crítica si alguna no tiene RLS) | alta | Bloquear 24 h · prompt RLS | N |
| N-07 | Fuerza bruta en Auth | SL `auth_logs` | 10 min | misma IP: ≥ 10 respuestas 400/401/422/429 en `/token` (KUADRA lo hace por cuenta: `fuerza_bruta_cuenta`) | crítica | Bloquear IP en CF · prompt captcha | N |
| N-08 | Ráfaga de 401/403 en la API | SL `edge_logs` | 10 min | ≥ 50 respuestas 401/403 desde una IP | media | Ver · Bloquear 1 h | N |

**Reglas de no-bloqueo** (port de §3.1 y §3.4) que el motor aplica antes de proponer «Bloquear»: no proponer si la IP es
infraestructura del propio cliente (IPs de sus funciones, crones o servidores, lista que el usuario confirma al conectar),
si hay usuarios autenticados detrás en 7 d, si hay > 1 identidad distinta, si es la IP del operador o si es no enrutable.
En esos casos la fila sale con «Ver» y el motivo («Con sesión», «Infra propia», «Personas 3»), nunca con «Bloquear».

## 5. Cómo obtener cada señal en nuestro producto

### 5.1 Supabase Logs (Management API, dialecto ClickHouse)

- `GET https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs?sql=<urlencoded>&iso_timestamp_start=<UTC>&iso_timestamp_end=<UTC>`
  con `Authorization: Bearer <token>`. Rango **≤ 24 h** (si no, error de validación); sin parámetros solo mira el último
  minuto; respuesta `{ "result": [...], "error": "..." }`; códigos 200/401/402/403/429.
  Permiso: OAuth scope `analytics:read` o token de grano fino con `analytics_logs_read`.
  [verificado: https://supabase.com/docs/reference/api/v1-get-project-logs]
- Tabla única `logs`; columnas de primer nivel `id`, `timestamp`, `event_message`, `source`; todo lo demás en el mapa
  `log_attributes` (valores `String`: castear con `toInt32OrZero`). Filtrar por `source = 'edge_logs' | 'auth_logs' |
  'postgres_logs' | 'function_edge_logs' | …`. `select *` y `count(*)` están **rechazados**: listar columnas y usar `count()`.
  Los ejemplos antiguos con `cross join unnest(metadata)` (BigQuery) ya no valen.
  [verificado: https://supabase.com/docs/guides/telemetry/advanced-log-filtering]
- Claves verificadas: `edge_logs` → `request.headers.cf_connecting_ip`, `request.headers.x_real_ip`, `request.path`,
  `request.method`, `request.host`, `request.headers.cf_ipcountry`, `response.status_code`, `response.origin_time`;
  `auth_logs` → `remote_addr`, `path`, `status`. [verificado: https://supabase.com/docs/guides/telemetry/log-field-reference]
  `request.headers.user_agent` aparece en la guía de errores de API
  [verificado: https://supabase.com/docs/guides/troubleshooting/discovering-and-interpreting-api-errors-in-the-logs-7xREI9.md],
  pero no en la referencia de campos: comprobarlo contra el proyecto de la demo antes de depender de él.
- No hay campo documentado con el rol o el `sub` del JWT en `edge_logs`: «personas detrás» hay que aproximarlo
  (UAs distintos por IP, o peticiones con cabecera `authorization` de usuario si aparece). [no verificado]
- MCP: `query_logs` con SQL y rango explícito, conectado con `project_ref` y `read_only=true`. [verificado: misma guía]
- Retención: API y Database logs 1 día en Free, 7 en Pro, 28 en Team, 90 en Enterprise; si se pasa la cuota de consultas,
  la retención baja a 1 h (Free) o 24 h (pagos). [verificado: https://supabase.com/docs/guides/platform/manage-your-usage/logs-query
  y https://supabase.com/pricing] → **hay que archivar agregados en nuestra base** (lección de KUADRA con Cloudflare).
- Límite de peticiones del endpoint de logs: no publicado (solo aparece el 429). [no verificado] Proponer 1 ciclo cada
  2 min por proyecto con 3 consultas y ventana de 2–10 min.

Consultas (construidas sobre los campos verificados; **no ejecutadas**, validar en la primera hora contra el proyecto demo):

```sql
-- C1 · IPs con más peticiones a la API (IP-01..04, N-04, N-08). Ventana: iso_timestamp_start/end = últimos 10 min
select log_attributes['request.headers.cf_connecting_ip'] as ip,
       count() as peticiones,
       uniqExact(log_attributes['request.path']) as rutas,
       countIf(toInt32OrZero(log_attributes['response.status_code']) in (400, 401, 403, 404)) as fallos_4xx,
       countIf(toInt32OrZero(log_attributes['response.status_code']) = 429) as rechazadas,
       countIf(position(log_attributes['request.path'], '%') > 0) as rutas_codificadas,
       max(timestamp) as ultima
from logs
where source = 'edge_logs'
group by ip
having peticiones >= 300 or rutas >= 30 or fallos_4xx >= 20 or rechazadas > 0
order by peticiones desc
limit 100;
```

```sql
-- C2 · User agents (N-01, N-02, N-03) y ficheros sensibles (N-05). Ventana: última hora
select log_attributes['request.headers.user_agent'] as ua,
       log_attributes['request.headers.cf_connecting_ip'] as ip,
       count() as peticiones,
       countIf(match(log_attributes['request.path'],
               '(?i)(/\\.env|/\\.git/|wp-login|phpmyadmin|/actuator|server-status|/\\.aws/|config\\.json|/backup)')) as sensibles
from logs
where source = 'edge_logs'
group by ua, ip
order by peticiones desc
limit 200;
```

```sql
-- C3 · Fuerza bruta en Auth (N-07). Ventana: últimos 10 min
select log_attributes['remote_addr'] as ip,
       count() as fallos
from logs
where source = 'auth_logs'
  and toInt32OrZero(log_attributes['status']) in (400, 401, 422, 429)
  and match(log_attributes['path'], '^/token')
group by ip
having fallos >= 10
order by fallos desc
limit 50;
```

```sql
-- C4 · Enumeración de tablas por REST (N-06). Ventana: últimos 10 min
select log_attributes['request.headers.cf_connecting_ip'] as ip,
       uniqExact(extract(log_attributes['request.path'], '^/rest/v1/([A-Za-z0-9_]+)')) as tablas
from logs
where source = 'edge_logs'
  and match(log_attributes['request.path'], '^/rest/v1/[A-Za-z0-9_]+')
  and not match(log_attributes['request.path'], '^/rest/v1/rpc/')
group by ip
having tablas >= 15
order by tablas desc
limit 50;
```

La clasificación de UA (listas A y B de N-01/N-02) se hace en TypeScript sobre el resultado de C2, no en SQL: así la lista
vive en una tabla nuestra y se puede editar sin tocar consultas.

### 5.2 SQL de solo lectura en la base del cliente (crones, pg_net, guard)

Vía MCP `execute_sql` en modo `read_only` o con un rol Postgres de solo lectura con `USAGE` en `cron`/`net`. Requisito:
extensiones `pg_cron` / `pg_net` instaladas (si no, el módulo dice «sin crones» y no falla).

```sql
-- LOG-01..04: un renglón por job con su última corrida (port de _crm_logs_ahora)
select j.jobid, j.jobname, j.schedule, j.active, j.username, j.database,
       md5(coalesce(j.schedule,'') || '|' || coalesce(j.command,'') || '|' || coalesce(j.username,'') || '|' || coalesce(j.database,'')) as huella,
       u.status, u.start_time, u.end_time,
       left(regexp_replace(coalesce(u.return_message, ''), '\s+', ' ', 'g'), 300) as mensaje
from cron.job j
left join lateral (select d.status, d.start_time, d.end_time, d.return_message
                     from cron.job_run_details d
                    where d.jobid = j.jobid
                    order by d.start_time desc nulls last
                    limit 1) u on true
order by j.jobname;
```

```sql
-- LOG-05: llamadas salientes fallidas (nunca leer content ni headers: pueden llevar secretos)
select r.id, r.status_code, r.timed_out, left(r.error_msg, 200) as error, r.created
from net._http_response r
where r.created > now() - coalesce(nullif(current_setting('pg_net.ttl', true), ''), '6 hours')::interval
  and (r.timed_out or r.error_msg is not null or r.status_code >= 400)
order by r.id desc
limit 100;
```

```sql
-- IP-13: ¿hay rate limit / guard en la base? (db_pre_request de authenticator)
select split_part(o.opt, '=', 2) as db_pre_request
from pg_catalog.pg_db_role_setting s
cross join lateral unnest(s.setconfig) o(opt)
where s.setrole = 'authenticator'::regrole and o.opt like 'pgrst.db\_pre\_request=%';
```

El cálculo de LOG-02 (periodo del cron) se hace en TypeScript con un parser cron (ver §7): hueco mayor entre dos
ejecuciones; atrasado si `ultima < ahora - min(2·p, p + 2 h)`.

### 5.3 Cloudflare (resumen; detalle y consultas completas en R05)

- `firewallEventsAdaptive` (consulta literal en `cloudflare_api.dart` §2.4) da IP, UA, ruta y estado por evento: sirve
  para CF-01, N-01, N-04, N-05 sobre lo que el firewall ya marcó.
- Para tráfico **no** marcado: `httpRequestsAdaptive` (detalle por petición, muestreado; en Free funciona con `clientIP`,
  `userAgent`, `clientRequestPath`, `edgeResponseStatus`: medido por KUADRA el 2026-08-29) y agregar en TypeScript.
  `clientIP` como dimensión de `httpRequestsAdaptiveGroups` no está confirmado en la documentación. [no verificado]
  Multiplicar los conteos por `avg { sampleInterval }` (los datasets adaptativos vienen muestreados).

## 6. Acciones que ofrecen los módulos y su equivalente en el producto

| Acción KUADRA | Clase | Mecanismo en KUADRA | Equivalente en nuestro producto |
|---|---|---|---|
| Bloquear IP/rango (1 h · 24 h · 7 d · indefinido, motivo ≤ 300) | barra (simula → aplica) | `crm_ip_bloquear(p_ip, p_motivo, p_horas, p_evento_id, p_simular)` → `ip_bloqueadas`; lo aplica el guard con PT403 | **Cloudflare access rule** `mode: block` (si el dominio va por proxy de CF) con nota «Kuadra-AI · <detección> · hasta <fecha>» y caducidad gestionada por nosotros (CF no caduca reglas: un cron nuestro las quita) |
| Bloquear en el borde | confirmar | `POST /zones/{z}/firewall/access_rules/rules` | igual; mostrar «Toda la zona · 403» como efecto |
| Alargar 24 h / Poner 7 días / Poner 1 h | barra | re-bloqueo = upsert de `hasta` (aviso si acorta) | cambiar la caducidad en nuestra tabla `bloqueos` (la regla CF sigue) |
| Desbloquear / Quitar | confirmar con vista previa | `crm_ip_desbloquear(p_id \| p_ip, p_simular)`; por id vence la fila, por IP contención | `DELETE …/access_rules/rules/{id}` + marcar `fin = levantado` |
| Marcar visto | inmediata | `crm_freno_visto(p_tipo='tope', p_clave=<ruta>)` por cada ruta sin ver | `detecciones.revisado = true` (silencia la alerta, no la borra) |
| Ver corridas / Abrir Freno | navegar | `Destino(modulo, ancla, filtro)` | navegación entre módulos con filtro |
| Copiar IP / error / SQL / nombre | inmediata | portapapeles | igual, y además «Copiar para mi IA» (contexto + prompt de corrección) |
| — (no existe en KUADRA) | — | — | **Prompt de corrección**: instalar guard `db_pre_request` con techo por IP y lista de bloqueo (patrón de §2.1), activar captcha de Auth, ajustar RLS, arreglar cron |

Supabase no ofrece a sus clientes un bloqueo de IP para la API REST desde la Management API. Sus «Network Restrictions»
limitan conexiones directas a Postgres/pooler, no las peticiones HTTP a PostgREST. [no verificado en esta sesión] Por eso
la acción sobre Supabase es el prompt de corrección; la acción inmediata es Cloudflare.

Reglas de ejecución que conviene copiar de KUADRA:
- Toda escritura tiene **simulación por defecto** y devuelve `efecto` («Afecta 256 · Personas 3»), `chapas` y `avisos`
  antes de confirmar. El botón grande dice el efecto, no solo el verbo.
- Lista blanca de acciones por módulo en el BACK; el modelo de IA nunca elige ni ejecuta acciones.
- Cada escritura deja rastro (quién, cuándo, vía, IP del operador) y el historial distingue «venció» de «levantado».
- Respuestas honestas: nunca «desbloqueada» si sigue cubierta por otra regla.

## 7. Fragmentos portables a TypeScript

```ts
// 7.1 IP de la petición (port de plataforma.ip_peticion). Para nuestras propias rutas Next.js / Edge.
import { isIP } from 'node:net';

export function ipDePeticion(h: Headers): string | null {
  const ok = (v: string | null) => (v && !v.includes('/') && isIP(v.trim()) ? v.trim() : null);
  let ip = ok(h.get('cf-connecting-ip')) ?? ok(h.get('sb-forwarded-for'));
  if (!ip) {
    const xff = h.get('x-forwarded-for');
    ip = ok(xff ? xff.split(',').at(-1)!.trim() : null); // KUADRA toma el ÚLTIMO valor
  }
  if (ip?.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return ip;
}
```

```ts
// 7.2 Salvaguardas de bloqueo (port de crm_ip_bloquear en modo simulación)
import { BlockList, isIP } from 'node:net';

const NO_ENRUTABLES: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const reservadas = new BlockList();
for (const [red, m] of NO_ENRUTABLES) reservadas.addSubnet(red, m, 'ipv4');

export type Simulacion =
  | { ok: false; error: 'falta_ip' | 'ip_invalida' | 'ip_mapeada' | 'mascara_demasiado_ancha' | 'falta_motivo' | 'motivo_largo' | 'horas_invalidas' }
  | { ok: true; ip: string; familia: 4 | 6; mascara: number; direcciones: bigint; avisos: string[]; chapas: string[] };

export function simularBloqueo(
  entrada: string, motivo: string, horas: number | null,
  ctx: { ipOperador?: string; personasDetras: number; bloqueosVigentes: string[]; soloIpv4: boolean },
): Simulacion {
  const t = entrada.trim();
  if (!t) return { ok: false, error: 'falta_ip' };
  const [dir, m] = t.split('/');
  const familia = isIP(dir);
  if (!familia || t.split('/').length > 2) return { ok: false, error: 'ip_invalida' };
  const bits = familia === 4 ? 32 : 128;
  const mascara = m === undefined ? bits : Number(m);
  if (!Number.isInteger(mascara) || mascara < 0 || mascara > bits) return { ok: false, error: 'ip_invalida' };
  if (familia === 6 && dir.toLowerCase().startsWith('::ffff:')) return { ok: false, error: 'ip_mapeada' };
  if ((familia === 4 && mascara < 16) || (familia === 6 && mascara < 32)) return { ok: false, error: 'mascara_demasiado_ancha' };
  if (!motivo.trim()) return { ok: false, error: 'falta_motivo' };
  if (motivo.trim().length > 300) return { ok: false, error: 'motivo_largo' };
  if (horas !== null && (horas <= 0 || horas > 8760)) return { ok: false, error: 'horas_invalidas' };

  const direcciones = 1n << BigInt(bits - mascara);
  const red = new BlockList();
  red.addSubnet(dir, mascara, familia === 4 ? 'ipv4' : 'ipv6');
  const nuncaLlega = (familia === 6 && ctx.soloIpv4) || (familia === 4 && reservadas.check(dir, 'ipv4'));
  const esteEquipo = !!ctx.ipOperador && isIP(ctx.ipOperador) === familia
    && red.check(ctx.ipOperador, familia === 4 ? 'ipv4' : 'ipv6');
  const avisos = [
    ctx.personasDetras > 1 && 'personas',
    familia === 6 && mascara > 64 && 'ipv6_64',
    ((familia === 4 && mascara < 24) || (familia === 6 && mascara < 48)) && 'rango_amplio',
    esteEquipo && 'este_equipo',
    nuncaLlega && 'nunca_llega',
    ctx.bloqueosVigentes.includes(t) && 'ya_estaba',
  ].filter(Boolean) as string[];
  const chapas = [
    mascara < bits && `Rango · ${direcciones}`,
    esteEquipo && 'Este equipo', nuncaLlega && 'Nunca llega',
    ctx.personasDetras > 1 && `Personas ${ctx.personasDetras}`,
  ].filter(Boolean) as string[];
  return { ok: true, ip: t, familia: familia as 4 | 6, mascara, direcciones, avisos, chapas };
}
```
(`net.BlockList` existe desde Node 15.0. [no verificado en esta sesión]) Nota: no normaliza bits de host; para eso usar
`ipaddr.js` o calcular la red con BigInt como `IpValidada.red` de `modelos.dart`.

```ts
// 7.3 Detección como dato: el motor evalúa filas, la IA solo redacta la explicación y el prompt de corrección
export type Severidad = 'critica' | 'alta' | 'media' | 'baja';
export interface Deteccion {
  id: string;                 // 'IP-01', 'N-04', 'LOG-04'…
  fuente: 'SL' | 'PG' | 'CF' | 'INT';
  consulta: string;           // id de la consulta (C1…C4, PG-crones…) que produce las filas
  ventanaMin: number;         // 10, 60, 1440…
  umbral: Record<string, number>;  // { rutas: 30, fallos_4xx: 20 }
  severidad: Severidad;
  acciones: ('bloquear_cf' | 'marcar_visto' | 'prompt' | 'ver' | 'copiar')[];
  bloqueoRequiereChequeos: boolean; // aplica reglas de no-bloqueo (§4)
}
export interface Hallazgo {
  clave: string;              // `${id}:${objeto}` → dedupe y «visto», como `clave` de KUADRA
  deteccionId: string; objeto: string; rol: 'mal' | 'aviso' | 'cola';
  etiqueta: string; sub: string; dato: unknown; vistoEn?: string;
}
const ROL: Record<Severidad, Hallazgo['rol']> = { critica: 'mal', alta: 'mal', media: 'aviso', baja: 'cola' };

export function evaluar(d: Deteccion, filas: Record<string, number | string>[]): Hallazgo[] {
  return filas
    .filter((f) => Object.entries(d.umbral).every(([k, v]) => Number(f[k] ?? 0) >= v))
    .map((f) => ({
      clave: `${d.id}:${f.ip ?? f.jobname ?? f.ua}`, deteccionId: d.id, objeto: String(f.ip ?? f.jobname ?? f.ua),
      rol: ROL[d.severidad], etiqueta: d.id, sub: Object.keys(d.umbral).map((k) => `${f[k]} ${k}`).join(' · '), dato: f,
    }));
}
```

```ts
// 7.4 Cron atrasado (port de _crm_logs_ahora): periodo = hueco mayor entre ejecuciones (usar cron-parser u otro)
export function cronAtrasado(ultimaInicio: Date | null, periodoMs: number | null, ahora = new Date()): boolean {
  if (!ultimaInicio) return true;                       // «Sin correr»
  if (!periodoMs) return false;                         // horario no entendido: no se acusa
  const margen = Math.min(2 * periodoMs, periodoMs + 2 * 3600_000);
  return ultimaInicio.getTime() < ahora.getTime() - margen;
}
```

```ts
// 7.5 Llamada a Supabase Logs (Management API). El token sale descifrado del Vault solo en memoria del servidor.
export async function consultarLogs(ref: string, token: string, sql: string, desde: Date, hasta: Date) {
  if (hasta.getTime() - desde.getTime() > 24 * 3600_000) throw new Error('ventana_mayor_24h');
  const u = new URL(`https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs`);
  u.searchParams.set('sql', sql);
  u.searchParams.set('iso_timestamp_start', desde.toISOString());
  u.searchParams.set('iso_timestamp_end', hasta.toISOString());
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (r.status === 429) return { ok: false as const, error: 'limite' };
  if (!r.ok) return { ok: false as const, error: `http_${r.status}` };   // nunca registrar cuerpo ni cabeceras
  const j = (await r.json()) as { result?: Record<string, string | number>[]; error?: string | null };
  return j.error ? { ok: false as const, error: 'consulta' } : { ok: true as const, filas: j.result ?? [] };
}
```

## 8. Datos que hay que guardar en nuestra base (mínimo para que el catálogo funcione)

| Tabla | Para qué | Campos clave |
|---|---|---|
| `detecciones` | el catálogo de §4 como datos editables | `id`, `fuente`, `consulta`, `ventana_min`, `umbral jsonb`, `severidad`, `acciones text[]`, `activa` |
| `hallazgos` | lo que el motor encontró (dedupe por `clave`) | `proyecto_id`, `clave`, `deteccion_id`, `objeto`, `rol`, `primera`, `ultima`, `n`, `dato jsonb`, `visto_en`, `alertado_en` |
| `agregados_ip_hora` | sustituto de `freno_hora`: sobrevive a la retención de 1 día | `proyecto_id`, `hora`, `ip`, `ruta`, `peticiones`, `fallos_4xx`, `rechazadas`, `pico`, `uas text[] ≤ 5` |
| `bloqueos` | bloqueos que pusimos (CF) con caducidad propia | `proyecto_id`, `ip inet`, `motivo`, `hasta`, `origen` (manual/sugerencia/hallazgo), `cf_regla_id`, `fin`, `operador_ip` |
| `cron_huellas` | LOG-04 | `proyecto_id`, `jobname`, `huella`, `aprobada_en` |
| `infra_propia` | reglas de no-bloqueo | `proyecto_id`, `red inet`, `nota` |

Con RLS por organización del usuario y sin guardar nunca el contenido de respuestas HTTP ni cabeceras completas.

## Implicaciones para el plan

**Adoptar**
- El **sobre único por módulo** (§1.2: `ok, hora, contador, cifras, ahora[grupos→filas→acciones], checks, secciones,
  errores`) como contrato BACK→FRONT. El FRONT pinta sin lógica; cada sección falla por separado. Esfuerzo **S** (definir
  tipos TS compartidos) y desbloquea el trabajo en paralelo de los dos chats.
- El **catálogo de §4 como datos** y un evaluador determinista (§7.3). La IA (Claude) no detecta: recibe los hallazgos
  ya decididos y redacta la explicación y el prompt de corrección. Ahorra créditos y cumple la decisión previa «el motor de
  reglas decide la alerta». Esfuerzo **M**.
- Las **salvaguardas de bloqueo** (§3.4) y las **reglas de no-bloqueo** (§4): son la parte más madura de KUADRA y la que
  evita el falso positivo que más duele (dejar fuera a usuarios legítimos tras un NAT). Esfuerzo **S** (§7.2 ya escrito).
- **Simulación por defecto** en toda acción y botón grande que dice el efecto («Afecta 1 · Personas 0 · Toda la zona 403»).
- **LOG-04 «cron modificado»** (huella md5 de cada job): barato, original y muy demostrable (persistencia de un atacante en
  `pg_cron`). Esfuerzo **S**.
- Higiene de secretos del Worker (§1.3): timeout 10 s, nunca registrar cuerpos/cabeceras/excepciones, códigos cortos.

**Evitar**
- Reimplementar el freno de KUADRA (pre-request + 20 clases + secuencias + barrido) dentro del producto: es **L** y no
  hace falta para la demo. Ofrecerlo como **prompt de corrección** «instala este guard en tu proyecto» (S como plantilla).
- Consultas en dialecto BigQuery (`cross join unnest(metadata)`): la API de logs ya es ClickHouse; `select *` y
  `count(*)` fallan.
- Ventanas > 24 h contra Supabase Logs o Cloudflare Free: dan error. Para «7 d» o «30 d» leer de `agregados_ip_hora`.
- Prometer «bloqueo en Supabase»: no existe para la API REST; decir «bloqueo en Cloudflare» o «corrección en tu proyecto».
- Leer `net._http_response.content`/`headers` o `return_message` completos sin recortar: pueden llevar secretos.

**Riesgos**
- **Credencial**: la API de logs pide token de Management (OAuth `analytics:read` o token de grano fino
  `analytics_logs_read`), no las API keys del proyecto. Choca con «el usuario solo carga sus keys»: el onboarding debe
  pedir ese token con instrucciones paso a paso, guardarlo cifrado (AES-256-GCM, clave en Vault) y probarlo al guardarlo.
- `request.headers.user_agent` no figura en la referencia de campos (sí en una guía): si no llega, N-01..N-03 solo
  funcionan con Cloudflare. Probarlo en la primera hora con el proyecto atacado de la demo.
- Límite de peticiones del endpoint de logs sin publicar (429): espaciar ciclos (2 min) y unir señales en 3–4 consultas.
- Retención Free de 1 día (1 h si se pasa la cuota de consultas): sin el archivo propio, el historial desaparece.
- Muestreo de Cloudflare: contar con `sampleInterval` o los umbrales mienten.
- Umbrales N sin calibrar: riesgo de falsos positivos en la demo. Calibrar contra tráfico real del proyecto demo y dejar
  N-01/N-05 (firmas inequívocas) como las únicas que llaman por teléfono.

**Esfuerzo por pieza**

| Pieza | Esfuerzo |
|---|---|
| Tipos del sobre + tabla `detecciones` + evaluador | M |
| Conector Supabase Logs (C1–C4) + `agregados_ip_hora` | M |
| Conector PG (crones, pg_net, guard) + `cron_huellas` | S |
| Acciones Cloudflare (bloquear/quitar con simulación, caducidad propia) | M (reutiliza R05) |
| Salvaguardas y reglas de no-bloqueo | S |
| Plantilla de prompt de corrección (guard `db_pre_request`, captcha Auth, RLS, cron) | S |
| Freno completo en la base del cliente | L (fuera del alcance de la hackatón) |
