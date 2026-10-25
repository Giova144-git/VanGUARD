# Modo «bajo ataque» de Cloudflare: especificación y encargos

Especificación del ORQUESTADOR (sáb 24-oct, ~19:00; revisada a las ~19:10 con las correcciones del revisor, ver §19).
Pedido (3) de Giovanni: «cambiar el tipo de token de Cloudflare también a write en momentos en los que estemos bajo
ataque, de modo que ponga Cloudflare en modo bajo ataque y solvente la situación». Giovanni dijo «no importa el tiempo,
continuemos»: entra esta noche, junto con (1) y (2), con el recorte de §13.1 si no cabe.

Qué cambia en una frase: cuando la regla ve **dos o más IPs inundando el mismo host** (incidentes `CF_IP_FLOOD` no
resueltos con el mismo `details.host`), VanGUARD ofrece «Activar modo bajo ataque» junto a «Bloquear IP». Con una sola IP
ofrece solo «Bloquear IP». Lo activa **solo en el host atacado** con una Configuration Rule de Cloudflare que **caduca
sola**, porque la caducidad va dentro de su propia expresión. Hay simulación previa (validada por Cloudflare con
`dry_run`), código de un solo uso, 30 min de vida, retirada automática y «Desactivar ahora». Nunca se activa solo.

Código leído antes de decidir: `apps/api/src/actions/{approvals,block-ip}.ts`, `rutas/{actions,connections,incidents,
index}.ts`, `scans/{cloudflare,sondeo}.ts`, `engine/{evaluar,housekeeping,timeline}.ts`, `cron.ts`, `mw/prod-host.ts`,
`wrangler.jsonc`, `apps/victima/wrangler.jsonc`, `packages/contracts/src/{api,comun,estado,index,ingest,contracts.test}.ts`,
`fixtures/{ids,incidentes,index}.ts`, `packages/core/src/engine/{edge,incidente}.ts`, `templates/whatsapp.test.ts`,
migraciones 0005, 0008, 0008h y 0009, la web (`modulos/incidentes/{BloquearIp,PaginaIncidente}.tsx`,
`modulos/conexiones/{Asistente,ActivarBlindaje}.tsx`, `modulos/cloudflare/PaginaCloudflare.tsx`,
`lib/{consultas,guias,permisos,mutaciones}.ts`), `PLAN_MAESTRO.md` §08.6–08.8 (líneas ~5080–5200), `demo/guion.md`,
`scripts/ataque.mjs`, `THREAT_MODEL.md` y `docs/PASOS_MANUALES_GIOVANNI.md` (pasos 13–15).

Documentación de Cloudflare consultada hoy (herramienta de documentación de Cloudflare y WebFetch); ver §1.

---

## 0. Decisiones en una tabla

| Tema | Decisión | Por qué (dato) |
|---|---|---|
| Alcance por defecto | **Solo el host del incidente**, con una Configuration Rule (`http_config_settings`, `set_config`, `security_level: under_attack`) y la expresión `(http.host eq "<host>" and http.request.timestamp.sec lt <epoch de expires_at>)` | La víctima (`demo.officialvanguard.com`) comparte zona con VanGUARD. El modo zonal desafiaría `officialvanguard.com`: la SPA, `/api/*`, `/ingest/*` y `/webhooks/*` (Kapso, GitHub). Esos clientes no resuelven un desafío |
| Alcance zonal | **P1**. Solo si la zona de la conexión no es la del producto. Nunca en `officialvanguard.com` (422) | Pide otro permiso (Zone Settings · Edit) y no tiene `dry_run`. Para la demo no sirve: la zona es la nuestra |
| Quién lo ofrece | La REGLA: incidente no resuelto con `CF_IP_FLOOD` en `rule_ids`, `details.host` válido y **≥ 2 incidentes `CF_IP_FLOOD` no resueltos con ese mismo host** en la org. Con uno solo: «Viene de una sola IP: con Bloquear IP basta» y sin botón | Cloudflare: «Only use Under Attack mode when a website is under a DDoS attack» (§1.5). Un escaneo o un `/admin` abierto no lo son, y una IP se resuelve con Bloquear IP. La IA no interviene |
| Quién lo activa | Un admin, con simulación y código de 6 dígitos (el mismo canje de E21). **Nunca automático** | Toda escritura en sistemas del cliente necesita confirmación explícita. Lo automático queda como decisión abierta (§18) |
| Simulación | Local (guardas puras de `core`) **más** `dry_run=true` de Cloudflare, siempre por un único helper `mutarEnSeco` que solo da por buena una respuesta 2xx con `result: null` | Cloudflare documenta `dry_run` en las «Supported Rulesets API mutation endpoints», y el API lo lista en añadir regla y en crear ruleset (§1.4). Si una escritura se colara, el helper la borra al instante |
| Vida | 30 min (`ttl_s = 1800`). **La caducidad va en la propia regla**: Cloudflare deja de aplicarla aunque VanGUARD falle. `housekeeping` la borra después (limpieza). «Desactivar ahora» = E22 | Cloudflare no caduca las Configuration Rules. Pide usar Under Attack solo mientras dure el ataque (§1.5). 30 min es la propuesta de `PLAN_MAESTRO.md` §08.8 |
| Rutas | **E55** `GET …/incidents/:id/under-attack` (oferta, solo base) y **E56** `POST …/incidents/:id/under-attack/propose`. Confirmar = **E21**, deshacer = **E22**, sin rutas nuevas | Reusa el canje, los intentos, el `kid` y la UI del código de «Bloquear IP». `ProposeAction.target` es `max(45)`: no cabe un host y no se toca |
| Host | Sale de `incidents.details.host`, **nunca del cuerpo**. Ese valor es el **nombre de la conexión de ingesta** que puso el admin (`evaluar.ts:48-54`), no algo que la regla observe. Guardas: `hostCanonico`, `fuera_de_zona` y `host_protegido` | La conexión de ingesta de «Tienda Demo» se tiene que llamar exactamente `demo.officialvanguard.com` (§16 paso 3). Con otro nombre, el incidente sale `sin_host` y la tarjeta lo explica |
| Token | El token de «Modo blindaje» gana **Zone · Config Rules · Edit** (además de Firewall Services · Edit). Es un aumento de riesgo: deja poner **cualquier** ajuste de configuración (también `ssl: off` o `security_level: off`) en cualquier host de la zona. Permanente o solo durante el ataque: **decisión 3 (§18)**; el código es el mismo | Permiso documentado (§1.1). `host_protegido` es una guarda del código de VanGUARD, no del token |
| Sonda | `probarCloudflareAcciones` añade el check `config_rules_edit` con un `dry_run` (no escribe). `required: false`. Solo un **403** guarda `config_rules_edit: false`; un fallo pasajero omite la clave | Un token antiguo sigue conectando; un fallo de red no esconde el botón |
| Mensajería | Sin cambios en `notify/kapso.ts`, el despachador ni E31. El código viaja con `enviarKapso` + `cuerpoTexto` ya existentes, como el respaldo de E20. Sin botones ok/no por WhatsApp en P0 | La mensajería la lleva otra persona. Los botones exigirían tocar E31 (P2) |
| Datos | Sin tablas nuevas: `actions` y `approvals` (0005) ya admiten `under_attack_on`. Migración **0017**: índice único parcial y un `check` reaplicable | Un modo vivo por host; toda fila sabe cómo deshacerse |
| Escritura en Cloudflare | Solo `POST …/rulesets/{id}/rules` (añade una regla) y `DELETE …/rules/{rule_id}` (borra la nuestra). Si no hay ruleset de la fase: `POST /zones/{z}/rulesets`. **Nunca `PUT` del entrypoint** | El `PUT` reemplaza todas las reglas de la fase, también las del cliente (§1.3) |
| Recorte | Si no cabe: sin B5, sin F3/F5, y dos cortes (dom 05:00 y 09:30). Este va el último en el BACK | B3 toca E21, E22 y E10, el «Bloquear IP» ya probado (§13.1) |
| `wrangler.jsonc` | Sin cambios | No hay bindings, crons ni colas nuevos |

---

## 1. Qué dice Cloudflare (verificado hoy)

### 1.1 Under Attack solo para un host (Configuration Rule)

- La regla va en la fase `http_config_settings` de la zona, con `"action": "set_config"` y los ajustes en
  `action_parameters` [verificado: https://developers.cloudflare.com/rules/configuration-rules/create-api/].
- El ajuste «I'm Under Attack» se llama `"security_level"` y admite `"off"`, `"essentially_off"` y `"under_attack"`
  [verificado: https://developers.cloudflare.com/rules/configuration-rules/settings/].
- Cloudflare trae este mismo ejemplo: `"expression": "http.host eq \"admin.example.com\""`, `"action": "set_config"`,
  `"action_parameters": {"security_level": "under_attack"}` [verificado: misma URL de create-api].
- **Permiso del token** para gestionar Configuration Rules: *Zone › Config Rules › Edit* [verificado: create-api,
  «Required API token permissions»]. En la tabla genérica del API figura como `Config Settings Write`.
- **Lo que también permite ese permiso** (misma URL de settings): `ssl` admite `"off"` y `"flexible"`; `security_level`
  admite `"off"` y `"essentially_off"`; `bic: false` apaga Browser Integrity Check; `email_obfuscation: false`. Con el
  token, cualquiera de esos ajustes se puede poner en cualquier host de la zona. Va a §11 y a la decisión 3 (§18).
- **Cupo:** Free 10 reglas, Pro 25, Business 50, Enterprise 300
  [verificado: https://developers.cloudflare.com/rules/configuration-rules/]. En `officialvanguard.com` ya hay 1
  (`T02-04 victima sin BIC`, paso 14): quedan 9.
- Orden: «for non-terminating actions the last change made by rules in the same phase will win»
  [verificado: https://developers.cloudflare.com/rules/configuration-rules/]. Nuestra regla se añade al final: gana sobre
  un `security_level` que el cliente haya puesto antes para ese host. No choca con `T02-04` (es otro ajuste, BIC).
- Cloudflare avisa: los desafíos junto con Rules pueden causar bucles de desafío (misma URL). Va a los avisos.

### 1.2 Under Attack de toda la zona

- `PATCH /zones/{zone_id}/settings/{setting_id}` con `{"value": …}`; permiso **`Zone Settings Write`** (Zone › Zone
  Settings › Edit) [verificado: https://developers.cloudflare.com/api/resources/zones/subresources/settings/methods/edit/].
- El id `security_level` con `"under_attack"` ya está verificado en `PLAN_MAESTRO.md` §08.8 (misma URL). La página de
  Security Level confirma que el API usa «security level» para encender o apagar Under Attack
  [verificado: https://developers.cloudflare.com/waf/tools/security-level/]. El threat score ya es siempre 0 (misma URL).
- No hay `dry_run` para los ajustes de zona: la simulación del zonal es solo local.

### 1.3 Añadir y borrar UNA regla sin tocar las del cliente

- Añadir: `POST /zones/{zone_id}/rulesets/{ruleset_id}/rules`. «By default, the rule will be added to the end». La
  respuesta trae el ruleset completo, cada regla con su `id`
  [verificado: https://developers.cloudflare.com/ruleset-engine/rulesets-api/add-rule/].
- Borrar: `DELETE /zones/{zone_id}/rulesets/{ruleset_id}/rules/{rule_id}` → `200` con el ruleset completo
  [verificado: https://developers.cloudflare.com/ruleset-engine/rulesets-api/delete-rule/]. Qué devuelve con un
  `rule_id` que ya no existe: [no verificado]; se trata 404 como «ya no está», igual que en `block-ip.ts`.
- Si la fase no tiene ruleset: «create it using the Create a zone ruleset operation» con `kind: zone` y
  `phase: http_config_settings`, y se puede incluir la regla en esa misma petición (create-api, paso 2–3). Ruta:
  `POST /zones/{zone_id}/rulesets` [verificado: https://developers.cloudflare.com/api/resources/rulesets/methods/create/].
  Qué responde si otro lo creó a la vez: [no verificado]; se relee el entrypoint y se añade la regla.
- Leer: `GET /zones/{z}/rulesets/phases/http_config_settings/entrypoint` (404 = sin ruleset), verificado para otras
  fases en `PLAN_MAESTRO.md` §08.7.
- **El `PUT` del entrypoint reemplaza todas las reglas** de la fase (ejemplo de custom errors: «replaces any existing
  rules in the … phase entry point ruleset», https://developers.cloudflare.com/rules/custom-errors/create-rules/). Por
  eso no se usa nunca.
- Cloudflare pide no actualizar a la vez el mismo ruleset muchas veces (límite de ritmo por ruleset)
  [verificado: https://developers.cloudflare.com/ruleset-engine/rulesets-api/]. Una regla por activación y 10/min de
  `RL_COSTLY` quedan muy lejos.
- Campo `ref`: «The reference of the rule (the rule's ID by default)»
  [verificado: https://developers.cloudflare.com/api/resources/rulesets/subresources/rules/methods/create/]. Formato
  admitido: [no verificado]; lo valida el `dry_run` de la simulación y la prueba de humo (B6).

### 1.4 `dry_run`: la simulación la valida Cloudflare

- «Supported Rulesets API mutation endpoints accept the `dry_run=true` query parameter», con `POST`, `PUT`, `PATCH` y
  `DELETE`, de zona o de cuenta. «performs the same authorization and server-side validation checks», incluye permisos,
  plan y **cupos de reglas**, y «does not create, update, delete, or publish any configuration». Una operación que
  normalmente devuelve `200` devuelve `result: null`; un fallo da los mismos errores y códigos que la escritura
  [verificado: https://developers.cloudflare.com/ruleset-engine/rulesets-api/dry-run/; changelog del 17-sep-2026:
  https://developers.cloudflare.com/changelog/post/2026-09-17-rulesets-dry-run-validation/].
- No son «todas» las mutaciones: la página no da la lista. Los dos endpoints que usamos sí listan `dry_run` («Validates
  the request without persisting changes when set to `true`») [verificado: create de rules
  https://developers.cloudflare.com/api/resources/rulesets/subresources/rules/methods/create/ y create de rulesets
  https://developers.cloudflare.com/api/resources/rulesets/methods/create/].
- Una escritura real de añadir regla devuelve el ruleset completo (§1.3). Por eso `mutarEnSeco` (§8) trata un 2xx con
  `result` no nulo como una escritura colada y la deshace.

### 1.5 Qué hace Under Attack

- Muestra un desafío intersticial; decide en unos 5 s; quien pasa no lo vuelve a ver hasta que vence el Challenge
  Passage. Necesita JavaScript. Cloudflare lo llama un último recurso y pide apagarlo al terminar el ataque
  [verificado: https://developers.cloudflare.com/fundamentals/reference/under-attack-mode/]. Muestra un Managed
  Challenge y «Only use Under Attack mode when a website is under a DDoS attack»
  [verificado: https://developers.cloudflare.com/waf/tools/security-level/].
- Que rompe API, webhooks y apps móviles es inferencia (no ejecutan JavaScript), ya anotada en §08.8 del plan.
- Que también desafía a un Worker con Custom Domain en la zona (la víctima): [no verificado]. Lo comprueba la prueba de
  humo con `curl -sI https://demo.officialvanguard.com/` (se espera un 403 de Cloudflare en lugar del 200 de la tienda).

### 1.6 Caducidad dentro de la regla

- `http.request.timestamp.sec`: «The timestamp when Cloudflare received the request, expressed as UNIX time in
  seconds», tipo `Integer`, 10 dígitos [verificado:
  https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/http.request.timestamp.sec/].
- Que la fase `http_config_settings` admita ese campo: [no verificado]; la página no habla de fases. Lo validan el
  `dry_run` de la sonda (§16 paso 2, «Probar conexión»), el de E56 y la prueba de humo (B6), que mandan la misma
  expresión. Si Cloudflare la rechaza, el BACK pone `CADUCIDAD_EN_REGLA = false` (una línea de `core`): la regla vuelve
  a ser solo de host y la retirada depende otra vez solo de `housekeeping` (y §11 y el pitch lo dicen así).

---

## 2. Decisiones con su porqué

**D1 · Host por defecto, zonal solo fuera de la zona del producto.** El incidente de la demo viene de
`demo.officialvanguard.com` y la conexión de Cloudflare de «Tienda Demo» es la zona `officialvanguard.com` (paso 15).
El zonal desafiaría la app, la API, la ingesta de la víctima (que llama a `officialvanguard.com/ingest`) y los webhooks
de Kapso y GitHub: VanGUARD se cortaría a sí mismo en medio de un ataque. La Configuration Rule lo limita al host. En
un cliente cuya zona no es la nuestra, el zonal es útil (ataque repartido entre varios hosts): P1, con su aviso «afecta a
todos los hosts de tu zona».

**D2 · De dónde sale el host y qué lo protege.** `details.host` lo escribe el motor con el **nombre (label) de la
conexión de ingesta** (`evaluar.ts:48-54`: «connections.label es el {host}»; `edge.ts:139` y `:171`). El evento de
ingesta no trae Host (`EdgeEvent`, `ingest.ts:5`) y `meta.hostname` nunca se rellena (E8 crea la ingesta con meta `{}`).
O sea: **el host lo fija el admin al nombrar la conexión, la regla no lo observa.** Las guardas reales son tres:
`hostCanonico` (un nombre como «Tienda Demo» no es un host → `sin_host`), `fuera_de_zona` (el host tiene que ser de la
zona de la conexión de Cloudflare) y `host_protegido` (`core` rechaza el host de `APP_ORIGIN`, `officialvanguard.com`, y
su `www.`). Y activar sigue exigiendo el código del admin. P1 (B9): un `meta.hostname` validado al dar de alta la
ingesta, o el Host en el evento.

**D3 · La regla ofrece, el humano decide, y solo ante una inundación de varias IPs.** `ofreceBajoAtaque()` (puro, en
`core`) solo mira `CF_IP_FLOOD`: escaneo (`CF_PATH_SCAN`) y `/admin` abierto (`CF_ADMIN_EXPOSED`, critical por sí sola)
no son un DDoS, y Cloudflare pide Under Attack solo ante un DDoS (§1.5). Los incidentes son por IP (dedupe
`org|edge|ip`, `edge.ts:160`): con un solo incidente de inundación para ese host, basta Bloquear IP y la UI lo dice sin
botón. Con **≥ 2** incidentes `CF_IP_FLOOD` no resueltos del mismo host (una lectura más en E55 y E56, sin
Cloudflare), se ofrece. Límite conocido: `CF_IP_FLOOD` exige que cada IP tenga ≥ 20 % del tráfico (`r.n * 5 >= r.total`,
`edge.ts:36`), así que detecta de 2 a 5 IPs; un ataque repartido entre muchas más IPs no abre ningún incidente. Una
regla de inundación de toda la org va a la hoja de ruta (B10, P1).

**D4 · `dry_run` en la simulación, por un solo camino.** E56 llama a Cloudflare con el token de acciones solo para
validar (`GET` del entrypoint y la mutación con `dry_run=true`). Toda mutación de prueba (E56 y la sonda de E8/E9) pasa
por `mutarEnSeco`, que pone `dry_run=true` con `URL.searchParams` (no se puede olvidar ni escribir mal) y solo da por
buena una respuesta 2xx con `result === null`. Si Cloudflare devolviera un ruleset, se escribió por error: el helper
borra al instante la regla con nuestro `ref` y deja un `log('error')`. Así «propose nunca escribe» no depende de que cada
llamada se acuerde del parámetro. Si Cloudflare dice 403, el admin lo sabe antes de pedir el código. Si no responde, la
simulación sale con `validado: false` y el aviso «se comprobará al confirmar».

**D5 · Confirmar y deshacer por E21 y E22.** El canje (`vg_redeem_approval`, HMAC con la FPK, 5 intentos, 10 min) y el
`kid` en `params` ya están probados. Se despacha por `approvals.action_kind` y `actions.kind` en la primera línea, con la
rama `block_ip` idéntica. El FRONT reusa `useBloqueo().confirmar/deshacer` y el componente `<Propuesta/>`.

**D6 · Sin botones de WhatsApp en P0.** El código va por WhatsApp como texto (misma comprobación de contacto verificado
y ventana de 24 h que E20). En la org de demo sin WhatsApp utilizable, el código viaja en la respuesta (como E20). Los
botones ok/no para bajo ataque obligan a tocar E31: P2.

**D7 · Un modo vivo por host.** Índice único parcial en `actions` (0017) sobre `executed` y **cualquier** `proposed`.
Dos aprobaciones confirmadas a la vez no crean dos reglas: la segunda inserción da 23505 y devuelve la primera. E55 y
E56 tratan cualquier `proposed` de ese host como `en_curso`, y `housekeeping` limpia la huérfana a los 2 min
(`EN_CURSO_MS`, el mismo de `block-ip.ts`), así el índice y lo que ve el admin dicen lo mismo.

**D8 · Toda fila sabe deshacerse desde que nace, y la regla caduca sola.** La fila `proposed` ya lleva en `previous` la
conexión, la zona, el alcance, el `ref` y la descripción. Si el Worker muere entre el `POST` y el `UPDATE`,
`housekeeping` encuentra la regla por su `ref` a los 2 min, la borra y deja la fila `failed`. Si VanGUARD no puede borrar
la regla (token revocado, permiso quitado, Supabase caído o sin cron), la caducidad de la expresión (§1.6) la desactiva
igual a los 30 min: queda inerte en la lista de reglas, ocupando una del plan, hasta que alguien la borre. E55 enseña
esa fila (`retirada_fallida`) con los pasos para borrarla a mano. Ya no se afirma «nunca queda huérfano»: se afirma
«nunca queda activo más de 30 min», y solo si §1.6 se confirma.

**D9 · No tocar las reglas del cliente.** Solo se añade y se borra por id la regla propia. Nunca `PUT`. Si la fase no
tenía ruleset y lo creamos, no se borra el ruleset al deshacer (pudo ganar reglas del cliente después).

**D10 · E10 y `housekeeping` distinguen el tipo.** Hoy E10 (borrar la conexión de acciones) pasa a `deshacerBloqueos`
toda fila `executed` de esa conexión. Con una fila de bajo ataque haría `DELETE …/access_rules/rules/<id de la regla
de configuración>`, recibiría 404, la daría por deshecha y **la regla seguiría en Cloudflare**. Por eso E10,
`housekeeping` y `deshacerBloqueos` se cambian en el mismo push que crea las primeras aprobaciones (B2–B4).

**D11 · El permiso nuevo es un riesgo nuevo y se decide.** Config Rules · Edit no es «activar bajo ataque»: deja poner
cualquier ajuste de §1.1 en cualquier host de la zona, también en `officialvanguard.com`. Hoy, con el token de acciones,
un atacante con el token solo puede bloquear IPs (`THREAT_MODEL.md`, A1). Con el permiso nuevo podría poner `ssl: off`
o `security_level: off`. El pedido literal es «write en momentos en los que estemos bajo ataque»: por eso §18 plantea
la decisión 3 (permanente o solo durante el ataque), y `SECURITY.md` y `THREAT_MODEL.md` A1 pasan a P0 (O3a).

---

## 3. Flujo

```mermaid
sequenceDiagram
  participant M as Motor (ingesta)
  participant U as Admin (app)
  participant API as Worker vanguard
  participant DB as Supabase
  participant CF as API Cloudflare
  M->>DB: 2 incidentes CF_IP_FLOOD (2 IPs), details.host = nombre de la ingesta = demo.officialvanguard.com
  U->>API: GET incidents/:id/under-attack (E55)
  API->>DB: incidente; luego conexión action, actions del host y conteo de CF_IP_FLOOD del host (0 llamadas a Cloudflare)
  API-->>U: ofrece:true, ips:2, scopes ['host'], permiso 'ok'
  U->>API: POST incidents/:id/under-attack/propose (E56)
  API->>CF: GET …/phases/http_config_settings/entrypoint + mutarEnSeco: POST …/rules?dry_run=true
  CF-->>API: 200 result:null (válida, sin publicar)
  API->>DB: approvals in_app (HMAC del código, 10 min)
  API-->>U: efecto, avisos, validado:true; código por WhatsApp (o en la respuesta en la org de demo)
  U->>API: POST actions/:approvalId/confirm {code} (E21)
  API->>DB: actions proposed (previous: conexión, zona, scope, ref, descripción)
  API->>CF: POST /zones/{z}/rulesets/{id}/rules (host eq … and timestamp.sec lt <epoch>, under_attack)
  CF-->>API: ruleset con la regla nueva (id)
  API->>DB: actions executed (provider_ref = id de la regla, expires_at = +30 min); incidente mitigated
  Note over U,CF: Visitantes de demo.officialvanguard.com: desafío. officialvanguard.com: igual. A los 30 min la regla deja de actuar sola.
  U->>API: POST actions/:actionId/undo (E22), o housekeeping al vencer
  API->>CF: DELETE /zones/{z}/rulesets/{id}/rules/{rule_id}
  API->>DB: actions undone
```

---

## 4. Modelo de datos

### 4.1 Migración `supabase/migrations/0017_bajo_ataque.sql`

```sql
-- 0017_bajo_ataque.sql · «Modo bajo ataque» (asignaciones/modo-bajo-ataque.md §4). Sin tablas nuevas: reusa actions y
-- approvals (0005), cuyos check ya admiten under_attack_on y under_attack_off. Sin grants nuevos: 0008 dejó RLS en
-- actions y 0008h quitó todo a anon y authenticated en public; el Worker usa service_role (0008c). Reaplicable.

-- D7: un solo modo bajo ataque vivo (en curso o activo) por org y objetivo (host o zona). Dos aprobaciones confirmadas a
-- la vez no crean dos reglas en Cloudflare: la segunda inserción da 23505 y executeUnderAttack devuelve la primera.
-- Cuenta CUALQUIER proposed: E55 y E56 la tratan como en_curso y housekeeping limpia la huérfana a los 2 min (EN_CURSO_MS).
create unique index if not exists actions_bajo_ataque_vivo_uq on public.actions (org_id, target)
  where kind = 'under_attack_on' and status in ('proposed', 'executed');

-- D8: una fila de bajo ataque nace sabiendo deshacerse (conexión, zona y alcance en previous, ya en proposed).
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'actions_bajo_ataque_previous_chk' and conrelid = 'public.actions'::regclass) then
    alter table public.actions add constraint actions_bajo_ataque_previous_chk check (
      kind <> 'under_attack_on'
      or (previous is not null and previous ? 'connection_id' and previous ? 'zone_id'
          and previous->>'scope' in ('host', 'zone')));
  end if;
end $$;
```

- Hoy no hay filas `under_attack_on`: el `check` valida al instante. `actions` es pequeña: el índice no necesita
  `concurrently`.
- `database.types.ts` no cambia (ni columnas ni tablas nuevas).
- La aplica el BACK (B0) después de que el ORQUESTADOR la revise (O2). Es `0017` porque `0015` es de la función (1)
  (`evolucion-entre-revisiones.md`) y `0016` de la (2) (`bloqueo-merge-criticos.md`).

### 4.2 Forma de `approvals.params` (`action_kind = 'under_attack_on'`, `channel = 'in_app'`)

```json
{ "scope": "host", "target": "demo.officialvanguard.com", "zone_id": "14d12778b0249e6d6854a67876c37e72",
  "zone_name": "officialvanguard.com", "connection_id": "…", "incident_id": "…", "incident_code": "A1F3C9",
  "ttl_s": 1800, "group": "<approval_id>", "kid": "v1", "requested_by": "<user_id>",
  "ref": "vg_ua_<approval_id sin guiones>", "ruleset_id": "<id o null si la fase no tenía ruleset>" }
```

`ruleset_id` es una pista de la simulación: al confirmar se vuelve a leer el entrypoint (pudo cambiar en 10 min). El
`epoch` de la expresión no va aquí: E21 lo calcula al ejecutar (`expires_at = ahora + ttl_s`).

### 4.3 Forma de `actions` (`kind = 'under_attack_on'`)

| Columna | Host (P0) | Zona (P1) |
|---|---|---|
| `target` | el host (≤ 120) | el nombre de la zona |
| `provider_ref` | id de la regla de configuración | `null` |
| `previous` | `{connection_id, zone_id, scope:'host', ref, descripcion, caduca_en_regla, ruleset_id, creo_ruleset}` | `{connection_id, zone_id, scope:'zone', security_level:'<valor previo>'}` |
| `expires_at` | ahora + `ttl_s` (el mismo instante que la expresión) | igual |

`descripcion` es la de la regla (`notasBajoAtaque`, ≤ 120): E55 la usa en los pasos para borrarla a mano.
`caduca_en_regla` = el valor de `CADUCIDAD_EN_REGLA` al crearla. `housekeeping` añade `intentos`, `reintento_en` y
`deshacer_error` como hoy.

`connections.capabilities` (jsonb ya existente) gana el booleano `config_rules_edit` (y `zone_settings_edit` en P1).
Sin migración.

---

## 5. Rutas

Numeración: E55 y E56 (E45–E50 son de la revisión de código; E51–E52 de la función (1) y E53–E54 de la (2)).
Archivo nuevo `apps/api/src/rutas/bajo-ataque.ts`, registrado en `rutas/index.ts` después de `actions`. Esa línea de
registro es también el interruptor del corte de §13.1: sin ella, E55 da 404 y la tarjeta no se pinta.

### E55 · `GET /api/orgs/:org/incidents/:id/under-attack` · miembro (viewer y anónimo de demo incluidos) · P0

- Solo lee la base, en dos tiempos: (1) el incidente por `id` **y** `org_id` (otra org → 404) con
  `COLUMNAS_INCIDENTE_BLOQUEO`; `host = hostCanonico(details.host)`. (2) En paralelo: conexiones Cloudflare
  `kind:'action'` `status:'active'` (como `elegirConexion`); las filas de `actions` de ese host (`kind
  'under_attack_on'`, `status in ('proposed','executed','failed')`, las 3 más recientes); y el conteo de incidentes
  `CF_IP_FLOOD` no resueltos de la org con el mismo `details.host` (`select('id', { count: 'exact', head: true })
  .neq('status','resolved').contains('rule_ids',['CF_IP_FLOOD']).eq('details->>host', <details.host tal cual>)`). Sin
  host, (2) solo lee las conexiones. 0 llamadas a Cloudflare.
- Respuesta `200 UnderAttackOffer` (§6). Cómo se arma:
  - `ofreceBajoAtaque(incidente, ips)` → `ofrece`, o `motivo` `no_aplica` | `cerrado` | `sin_host` | `una_ip`. `ips` =
    el conteo (0 sin host).
  - `simularBajoAtaque` sin cupo (solo guardas) → `host_protegido` | `fuera_de_zona`.
  - Sin conexión de acciones → `sin_conexion`. `capabilities.config_rules_edit === true` → `permiso: 'ok'`;
    `=== false` (un 403 de la sonda) → `permiso: 'falta'` y `motivo: 'sin_permiso'`; sin la clave → `permiso:
    'sin_probar'` y sí se deja proponer (E56 lo valida con `dry_run`).
  - Cualquier fila `proposed` de ese host → `en_curso`.
  - `activo`: la fila `executed` de ese host (aunque ya haya vencido: hasta que se retira, ocupa el host y «Desactivar
    ahora» la retira ya), con `retirada_fallida: false`. Si no la hay, la última `failed` con
    `previous.deshacer_error` de las últimas 24 h, con `retirada_fallida: true`. También con el incidente ya resuelto.
  - `copiar`: `pasosManualesBajoAtaque(host, zona)` con `sin_conexion` o `sin_permiso`; `pasosRetirarBajoAtaque(
    previous.descripcion, zona, caducoEn)` con `retirada_fallida` (`caducoEn = expires_at` si `caduca_en_regla`).
  - `scopes`: `['host']` si `motivo` es null; `'zone'` se añade en P1 cuando la zona no es la del producto.
- Errores: `401` sin sesión · `403` sin acceso a la org · `404` incidente no encontrado · `500 internal`.

### E56 · `POST /api/orgs/:org/incidents/:id/under-attack/propose` · admin · solo `officialvanguard.com` · P0

- Middlewares: `requireAdmin`, `requireProdHost`, `RL_COSTLY` con la clave `u:<user_id>` (la misma de E20).
- Cuerpo `UnderAttackPropose`: `{ scope?: 'host' | 'zone' (defecto 'host'), connection_id?: uuid }`. El host **no**
  viaja en el cuerpo.
- Pasos:
  1. Lee el incidente (`COLUMNAS_INCIDENTE_BLOQUEO`) por `id` y `org_id`; `host = hostCanonico(details.host)`.
  2. En paralelo: conexiones de acciones, filas de `actions` de ese host, conteo de `CF_IP_FLOOD` del host (como E55),
     contacto prioritario con WhatsApp y `orgs.is_demo` (como `proponerBloqueo`).
  3. `ofreceBajoAtaque(incidente, ips)` → si no, 422 o 409 (tabla). Fila `executed` → 409 `already_active`; cualquier
     `proposed` → 409 `in_progress`.
  4. `elegirConexion(filas, connection_id, host)`. `simularBajoAtaque({scope, host, zona, protegidos, zonaProducto,
     plan, reglasUsadas: null, ttl_s: 1800})`.
  5. Alcance host: con el token de acciones (`withSecret`), `GET …/phases/http_config_settings/entrypoint`. 200 →
     cuenta reglas (`reglasUsadas`) y repite la simulación con el cupo; `mutarEnSeco(token, zona,
     '/rulesets/{id}/rules', regla, ref)`. 404 → `mutarEnSeco(token, zona, '/rulesets', {name:'default', kind:'zone',
     phase:'http_config_settings', rules:[regla]}, ref)`. La regla es la misma que mandará E21:
     `reglaBajoAtaque(host, ref, notas, hasta)` con `hasta = ahora + 10 min + ttl_s` (solo para validar). Resultado:
     `valida` → `validado: true` y el aviso «Cloudflare validó la regla sin publicarla». `sin_permiso` (403) → 409
     `sin_permiso`. `rechazada` (otro 4xx) → 422 `rechazada_por_cloudflare` (el mensaje dice «revisa tus reglas de
     configuración: tu plan admite N»). `sin_respuesta` (red, plazo, 429 o 5xx) → `validado: false` y el aviso «No
     pudimos validarla con Cloudflare: se comprobará al confirmar». `escrita` (Cloudflare devolvió un ruleset: el
     helper ya borró la regla) → 500 `internal` sin crear la aprobación.
  6. Crea la aprobación `in_app` (`id = group = approval_id`, `recipient = user_id`, `nonce_hash = otpHashParam(keys,
     id, code)`, `params` de §4.2) y entrega el código: WhatsApp de texto con `textoCodigoBajoAtaque` si el contacto
     está verificado, la ventana de 24 h abierta y Kapso configurado; si no, solo la org `is_demo` recibe `code` en la
     respuesta (`delivery: 'in_app'`); las demás → 502 sin crear nada. Es la misma regla que E20.
- Respuesta `200 UnderAttackProposal` (§6).
- Errores:

| Código | `details.reason` | Cuándo | Mensaje |
|---|---|---|---|
| 403 `forbidden` | — | no admin, o fuera de `officialvanguard.com` | «Solo disponible en officialvanguard.com» |
| 404 `not_found` | — | incidente de otra org o inexistente | «Incidente no encontrado» |
| 422 `invalid_body` | `no_aplica` | el incidente no es de inundación (`CF_IP_FLOOD`) | «El modo bajo ataque es solo para inundaciones de tráfico» |
| 422 | `una_ip` | solo un incidente `CF_IP_FLOOD` no resuelto para ese host | «Viene de una sola IP: bloquéala con «Bloquear IP»» |
| 422 | `sin_host` / `host_invalido` | `details.host` (el nombre de la conexión de ingesta) no es un host | «No sabemos qué host atacan: ponle a tu conexión de ingesta el nombre del host (por ejemplo, demo.officialvanguard.com)» |
| 422 | `host_protegido` | host de VanGUARD | «Ese host es VanGUARD: ponerlo bajo ataque cortaría tu panel y tus avisos» |
| 422 | `fuera_de_zona` | el host no es de la zona de la conexión | «Ese host no es de tu zona <zona>» |
| 422 | `zona_del_producto` | `scope: 'zone'` sobre la zona de VanGUARD | «En esta zona solo se puede por host» |
| 422 | `alcance_no_disponible` | `scope: 'zone'` mientras sea P1 | «Por ahora solo por host» |
| 422 | `sin_cupo` | reglas usadas ≥ cupo del plan | «Tu plan admite N reglas de configuración y ya las usas» |
| 422 | `rechazada_por_cloudflare` | el `dry_run` dio otro 4xx | «Cloudflare no aceptó la regla (código N)» |
| 409 `conflict` | `no_action_connection` | sin Modo blindaje | «Activa el Modo blindaje con un token de acciones» |
| 409 | `sin_permiso` | `dry_run` 403 | «Te falta el permiso Zone · Config Rules · Edit en el token de Modo blindaje» + `details.copiar` |
| 409 | `already_active` | fila `executed` de ese host | «El modo bajo ataque ya está activo en <host>» + `details.action_id` |
| 409 | `in_progress` | cualquier fila `proposed` de ese host | «Se está activando ahora mismo» |
| 409 | `resolved` | incidente resuelto | «El incidente ya se cerró» |
| 429 `rate_limited` | — | `RL_COSTLY` | «Demasiados intentos seguidos. Espera un minuto.» |
| 502 `provider_unavailable` | `sin_contacto` … `kapso` | sin entrega del código (fuera de la demo) | los textos de `MENSAJE_ENTREGA` de `rutas/actions.ts` |
| 500 `internal` | — | la base falla, o el `dry_run` devolvió un ruleset (ya borrado) | — |

### E21 · `POST /api/orgs/:org/actions/:approvalId/confirm` · cambio

- Primera línea tras la pre-lectura: `if (action_kind === 'under_attack_on') return confirmarBajoAtaque(…)`. La rama
  `block_ip` queda idéntica (sin cambios en su diff). Cualquier otro `action_kind` → 404, como hoy.
- `executeUnderAttack(env, fila, {rid})` calcula `expires_at = ahora + ttl_s` y manda la regla con ese mismo instante en
  la expresión (`reglaBajoAtaque(host, ref, notas, CADUCIDAD_EN_REGLA ? expires_at : null)`).
- Respuestas `under_attack_on`:
  - `200 {ok:true, resultado:'Modo bajo ataque activo 30 min en demo.officialvanguard.com', en, action_id}`.
  - `200 {ok:false, error:'Te falta el permiso Zone · Config Rules · Edit en el token de Modo blindaje', action_id}` (403
    de Cloudflare), o `'Cloudflare no aceptó la regla (código N)'` (otro 4xx), o `'Tu plan ya usa sus N reglas de
    configuración'`.
  - `409 in_progress` (otra ejecución de la misma aprobación o del mismo host) · `502 provider_unavailable` (red o 5xx;
    la aprobación queda usada).
- `motivoSinCanje`: los textos «Vuelve a proponer el bloqueo» pasan a «Vuelve a proponerlo» (sirven a los dos tipos).

### E22 · `POST /api/orgs/:org/actions/:actionId/undo` · cambio

- Primera línea tras leer la acción: `kind === 'under_attack_on'` → `deshacerBajoAtaque`. La rama `block_ip` queda
  idéntica. Admite también una fila `failed` con `previous.deshacer_error` (reintento manual), como hoy.
- `200 {ok:true, resultado:'Modo bajo ataque desactivado', en}` · `200 {ok:false, error}` (permiso, token) ·
  `502` (Cloudflare caído) · `409 undone` · `409 not_executed`. Igual que hoy; cambia el texto.

### E10 · `DELETE /api/orgs/:org/connections/:id` · cambio (P0, D10)

- La lectura de acciones vivas de la conexión añade `kind` y se separan en memoria: `block_ip` → `deshacerBloqueos`
  (la llamada de hoy, sin cambios); `under_attack_on` → `deshacerBajoAtaque`. Si alguna no se retira → 409, como hoy.
- Ojo: la función (2) también toca E8, E9 y E10 en `rutas/connections.ts` (`bloqueo-merge-criticos.md` §2.8, su B4).
  Se hacen en serie en la misma sesión del BACK, nunca en paralelo (§13.1).

### E9 · `POST /api/orgs/:org/connections/:id/test` y alta de conexión · cambio de la sonda

`probarCloudflareAcciones(token, zoneId, lectura)` (`scans/cloudflare.ts`):

```ts
// En paralelo con el GET de access rules de hoy:
const ep = await pedir(`${CF}/zones/${zoneId}/rulesets/phases/http_config_settings/entrypoint`, { headers }, PLAZO);
// 403 → config_rules_edit 'forbidden'
// 200 → mutarEnSeco(token, zoneId, `/rulesets/${id}/rules`, reglaBajoAtaque('vanguard-sonda.<zona>', 'vg_ua_sonda', …, hasta), 'vg_ua_sonda')
// 404 → mutarEnSeco(token, zoneId, '/rulesets', {name:'default', kind:'zone', phase, rules:[…]}, 'vg_ua_sonda')
// valida → ok:true · sin_permiso → 'forbidden' · rechazada o token_invalido → 'invalid' · sin_respuesta o escrita → 'unavailable'
// capabilities: { firewall_read, ...('forbidden' → {config_rules_edit:false} | ok → {config_rules_edit:true} | si no → {}) }
```

- `required: false`: un token con solo Firewall Services · Edit sigue conectando. El mensaje de `rechazado` no cambia.
- **Solo un 403** guarda `config_rules_edit: false`. Con `invalid` o `unavailable` se omite la clave: E55 dice
  `sin_probar` y deja proponer (E56 valida). Motivo: E9 guarda `capabilities` en cuanto hay más de un check y la
  conexión no está caída (`connections.ts:210-215`), y un check `required: false` caído no hace caer el veredicto
  (`sondeo.ts:27-34`); sin esta regla, un fallo de red escondería el botón.
- La sonda manda la misma expresión con `http.request.timestamp.sec` que E21: «Probar conexión» ya dice si Cloudflare la
  admite (§1.6). `invalid` con un token que sí tiene el permiso es la pista para poner `CADUCIDAD_EN_REGLA = false`.

---

## 6. Contrato (`packages/contracts`, lo escribe el ORQUESTADOR)

Comprobado a las 19:03 en una copia limpia del scratchpad
(`C:\Users\giova\AppData\Local\Temp\claude\C--Users-giova-Desktop-hackaton-platanus-hack-26-ve-team-22\b43c26ea-98fb-4aed-9147-7144cc4051aa\scratchpad\bajo-ataque-zod`),
hecha desde el `packages/contracts/src` de `main` (`2460162`): el `tsc` del repo (6.0.3) da 0 errores; un error puesto a
propósito en el fixture (`motivo: 'una_sola_ip'`) lo detecta (TS2322); `vitest` del contrato pasa 55/55 (los 47 de
`main`, 4 casos y 4 pruebas nuevas). Los bloques listos para pegar están en
`C:\Users\giova\AppData\Local\Temp\claude\C--Users-giova-Desktop-hackaton-platanus-hack-26-ve-team-22\b43c26ea-98fb-4aed-9147-7144cc4051aa\scratchpad\bajo-ataque-bloques`
(`api.bloque.ts`, `bajo-ataque.ts`, `test.describe.ts`, y `aplicar.mjs`, que los aplica a una copia). `comun.ts` no
cambia: `ActionKind` ya trae `under_attack_on`. Las funciones (1) y (2) añaden sus propias claves a los mismos archivos:
se suman, no se pisan.

### 6.1 `packages/contracts/src/api.ts` (añadir al final)

```ts

// ── Modo bajo ataque (E55–E56; asignaciones/modo-bajo-ataque.md) ───────────────────────────────────────────────────
// host: una Configuration Rule (set_config, security_level under_attack) solo para el host del incidente, con la
// caducidad dentro de la expresión. zone: el ajuste security_level de toda la zona (P1; nunca en la zona del producto).
// Confirmar y deshacer: E21 y E22 de siempre.
export const UnderAttackScope = z.enum(['host', 'zone']);
export type UnderAttackScope = z.infer<typeof UnderAttackScope>;
// Por qué no se puede activar ahora (null = se puede). no_aplica: el incidente no es de inundación (CF_IP_FLOOD) ·
// una_ip: solo una IP inunda ese host (basta Bloquear IP) · cerrado: incidente resuelto · sin_host: el nombre de la
// conexión de ingesta no es un host · host_protegido: es un host de VanGUARD · fuera_de_zona: el host no es de la zona
// de la conexión · sin_conexion: falta el Modo blindaje · sin_permiso: la sonda vio un 403 de Config Rules · Edit ·
// en_curso: otra activación de ese host se está aplicando.
export const UnderAttackMotivo = z.enum(['no_aplica', 'una_ip', 'cerrado', 'sin_host', 'host_protegido', 'fuera_de_zona',
  'sin_conexion', 'sin_permiso', 'en_curso']);
export type UnderAttackMotivo = z.infer<typeof UnderAttackMotivo>;
const HostOZona = z.string().min(3).max(120); // actions.target admite ≤ 120 (0005)
// retirada_fallida: housekeeping no pudo borrar la regla (fila failed con previous.deshacer_error). Con la caducidad en
// la expresión ya no actúa desde expires_at, pero sigue ocupando una regla del plan: la UI pide borrarla a mano.
export const UnderAttackActivo = z.object({ action_id: Id, scope: UnderAttackScope, target: HostOZona, created_at: Ts,
  expires_at: Ts.nullable(), retirada_fallida: z.boolean() });
export type UnderAttackActivo = z.infer<typeof UnderAttackActivo>;
// E55 (solo lee la base). ofrece: lo decide la regla (≥ 2 incidentes CF_IP_FLOOD no resueltos con el mismo host en la
// org, es decir, varias IPs inundan ese host). ips: cuántos hay, este incluido. permiso: lo que vio la última sonda del
// token de acciones (falta: un 403 del dry_run; sin_probar: sin sonda de este permiso, lo valida E56).
// copiar: pasos para hacerlo a mano en el panel de Cloudflare (sin_conexion, sin_permiso o retirada_fallida), sin secretos.
export const UnderAttackOffer = z.object({ ofrece: z.boolean(), motivo: UnderAttackMotivo.nullable(),
  hostname: HostOZona.nullable(), zone_name: z.string().max(253).nullable(), connection_id: Id.nullable(),
  ips: z.number().int().min(0).max(1000), scopes: z.array(UnderAttackScope).max(2),
  permiso: z.enum(['ok', 'falta', 'sin_probar']).nullable(), ttl_s: z.number().int().min(300).max(3600),
  activo: UnderAttackActivo.nullable(), copiar: z.string().max(1500).nullable() });
export type UnderAttackOffer = z.infer<typeof UnderAttackOffer>;
// E56. El host sale del incidente (details.host, que es el nombre de la conexión de ingesta), nunca del cuerpo.
export const UnderAttackPropose = z.object({ scope: UnderAttackScope.default('host'), connection_id: Id.optional() });
export type UnderAttackPropose = z.infer<typeof UnderAttackPropose>;
// validado: Cloudflare respondió 2xx con result null a la regla enviada con dry_run=true (permiso, cupo y expresión) y
// no publicó nada; false: no se pudo comprobar (red, o alcance zone, que no tiene dry_run) y se comprueba al confirmar.
export const UnderAttackProposal = ProposeResponse.extend({ scope: UnderAttackScope, target: HostOZona,
  zone_name: z.string().max(253), ttl_s: z.number().int().min(300).max(3600), validado: z.boolean() });
export type UnderAttackProposal = z.infer<typeof UnderAttackProposal>;
```

`UnderAttackProposal` extiende `ProposeResponse`: `<Propuesta/>` de `BloquearIp.tsx` la pinta sin cambios de tipo.

### 6.2 Fixtures

`packages/contracts/src/fixtures/ids.ts` (añadir debajo de `APPROVAL_BLOQUEO`; ni `ab…002` ni `ac…001` existen hoy ni
los usan las funciones (1) y (2)):

```ts
export const APPROVAL_BAJO_ATAQUE = 'ab000000-0000-4000-8000-000000000002';
export const ACTION_BAJO_ATAQUE = 'ac000000-0000-4000-8000-000000000001';
```

`ACTION_BAJO_ATAQUE` es el id que el router de fixtures del FRONT pone a la fila `under_attack_on` tras confirmar.

`packages/contracts/src/fixtures/bajo-ataque.ts` (nuevo):

```ts
// «Modo bajo ataque» (E55 oferta y E56 simulación; asignaciones/modo-bajo-ataque.md). La regla lo ofrece cuando 2 o más
// IPs inundan el mismo host (incidentes CF_IP_FLOOD no resueltos con el mismo details.host, que es el nombre de la
// conexión de ingesta: demo.officialvanguard.com). La zona es la del producto: el alcance zone no se ofrece nunca.
import type { UnderAttackOffer, UnderAttackProposal } from '../api.ts';
import { APPROVAL_BAJO_ATAQUE, CONN_CF_ACTION, HOST_VICTIMA, T_PROPUESTA, ZONA } from './ids.ts';

export const underAttackOffer = {
  ofrece: true, motivo: null, hostname: HOST_VICTIMA, zone_name: ZONA, connection_id: CONN_CF_ACTION, ips: 2,
  scopes: ['host'], permiso: 'ok', ttl_s: 1800, activo: null, copiar: null,
} satisfies UnderAttackOffer;

// Una sola IP inunda el host: basta «Bloquear IP» y la tarjeta no ofrece el botón.
export const underAttackOfferUnaIp = {
  ...underAttackOffer, ofrece: false, motivo: 'una_ip', ips: 1, scopes: [],
} satisfies UnderAttackOffer;

// Token de Modo blindaje sin Config Rules · Edit: el botón no sirve; se ofrecen los pasos para el panel de Cloudflare.
export const underAttackOfferSinPermiso = {
  ...underAttackOffer, motivo: 'sin_permiso', scopes: [], permiso: 'falta',
  copiar: [
    `Para activarlo a mano en Cloudflare (zona ${ZONA}):`,
    '1. Rules → Configuration Rules → Create rule.',
    `2. If incoming requests match: Hostname · equals · ${HOST_VICTIMA}.`,
    '3. Then the settings are: I\'m Under Attack → On. Deploy.',
    '4. Cuando pase el ataque, borra la regla.',
    'Para hacerlo desde VanGUARD: añade Zone · Config Rules · Edit al token de Modo blindaje y pulsa «Probar conexión».',
  ].join('\n'),
} satisfies UnderAttackOffer;

// OJO: expires_at FIJA (T_PROPUESTA + 10 min), como actionProposal: el router de fixtures la reescribe con Date.now().
export const underAttackProposal = {
  approval_id: APPROVAL_BAJO_ATAQUE,
  efecto: `Modo bajo ataque solo en ${HOST_VICTIMA} durante 30 min: cada visitante pasará un desafío de Cloudflare`,
  avisos: [
    `El resto de ${ZONA} no cambia: tu app, tu API y tus webhooks siguen igual`,
    `Rompe las llamadas de API, webhooks y apps móviles a ${HOST_VICTIMA}: no resuelven el desafío`,
    'Usa 1 de las 10 reglas de configuración de tu plan Free',
    'Cloudflare validó la regla sin publicarla',
  ],
  expires_at: new Date(Date.parse(T_PROPUESTA) + 10 * 60_000).toISOString(), delivery: 'whatsapp', code: null,
  scope: 'host', target: HOST_VICTIMA, zone_name: ZONA, ttl_s: 1800, validado: true,
} satisfies UnderAttackProposal;
```

`fixtures/index.ts`: `import { underAttackOffer, underAttackOfferSinPermiso, underAttackOfferUnaIp, underAttackProposal }
from './bajo-ataque.ts';` y las cuatro claves al final de `fixtures`.

`contracts.test.ts`: las cuatro claves en `CLAVES_ESPERADAS`; en `casos`:

```ts
  ['underAttackOffer', c.UnderAttackOffer, fx.underAttackOffer],
  ['underAttackOfferUnaIp', c.UnderAttackOffer, fx.underAttackOfferUnaIp],
  ['underAttackOfferSinPermiso', c.UnderAttackOffer, fx.underAttackOfferSinPermiso],
  ['underAttackProposal', c.UnderAttackProposal, fx.underAttackProposal],
```

y al final:

```ts
describe('modo bajo ataque', () => {
  it('UnderAttackPropose: host por defecto y sin campo hostname', () => {
    expect(c.UnderAttackPropose.parse({})).toEqual({ scope: 'host' });
    expect(c.UnderAttackPropose.safeParse({ scope: 'zona' }).success).toBe(false);
    expect('hostname' in c.UnderAttackPropose.parse({ hostname: 'evil.example.com' })).toBe(false);
  });
  it('UnderAttackProposal rechaza un target de más de 120 caracteres o un ttl fuera de 300..3600', () => {
    const p = fx.underAttackProposal;
    expect(c.UnderAttackProposal.safeParse({ ...p, target: 'a'.repeat(115) + '.test1' }).success).toBe(false);
    expect(c.UnderAttackProposal.safeParse({ ...p, ttl_s: 7200 }).success).toBe(false);
  });
  it('la propuesta sigue siendo un ProposeResponse (la pinta <Propuesta/> de BloquearIp)', () => {
    expect(c.ProposeResponse.safeParse(fx.underAttackProposal).success).toBe(true);
  });
  it('UnderAttackOffer: activo exige retirada_fallida e ips es obligatorio', () => {
    const activo = { action_id: 'ac000000-0000-4000-8000-000000000001', scope: 'host', target: 'demo.officialvanguard.com',
      created_at: '2026-10-24T19:12:00.000Z', expires_at: '2026-10-24T19:42:00.000Z', retirada_fallida: true };
    expect(c.UnderAttackOffer.safeParse({ ...fx.underAttackOffer, activo }).success).toBe(true);
    const { retirada_fallida: _, ...sinCampo } = activo;
    expect(c.UnderAttackOffer.safeParse({ ...fx.underAttackOffer, activo: sinCampo }).success).toBe(false);
    const { ips: __, ...sinIps } = fx.underAttackOffer;
    expect(c.UnderAttackOffer.safeParse(sinIps).success).toBe(false);
  });
});
```

---

## 7. Cambios en `packages/core` (puro, sin red)

Archivo nuevo `packages/core/src/bajo-ataque.ts` (exportado desde `index.ts`) y `bajo-ataque.test.ts`:

```ts
export const TTL_BAJO_ATAQUE_S = 1800;
/** Configuration Rules por plan [verificado: developers.cloudflare.com/rules/configuration-rules/]. */
export const CUPO_REGLAS_CONFIG: Readonly<Record<string, number>> = { free: 10, pro: 25, business: 50, enterprise: 300 };
/** Solo la inundación: Cloudflare pide Under Attack solo ante un DDoS (§1.5). Escaneo y /admin abierto no lo son. */
export const REGLAS_QUE_OFRECEN: readonly string[] = ['CF_IP_FLOOD'];
/** Con una sola IP basta Bloquear IP: se ofrece con ≥ 2 incidentes CF_IP_FLOOD no resueltos del mismo host. */
export const MIN_IPS_BAJO_ATAQUE = 2;
/** true: la caducidad va en la expresión (http.request.timestamp.sec, §1.6). Si la sonda, E56 o B6 muestran que
 *  Cloudflare no la admite en http_config_settings, el BACK la pone en false y la retirada depende solo de housekeeping. */
export const CADUCIDAD_EN_REGLA = true;
export type MotivoBajoAtaque = 'host_invalido' | 'host_protegido' | 'fuera_de_zona' | 'zona_del_producto' | 'sin_cupo';

/** trim, minúsculas, sin punto final; 3..120 car.; ≥ 2 etiquetas /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/; la última con
 *  alguna letra (una IPv4 no pasa); sin '*', comillas, espacios, barras ni puerto. null si no. «Tienda Demo» → null. */
export function hostCanonico(s: unknown): string | null;

/** La REGLA, en este orden: no_aplica (sin CF_IP_FLOOD en rule_ids) → cerrado (status 'resolved') → sin_host
 *  (details.host no pasa hostCanonico) → una_ip (ips < MIN_IPS_BAJO_ATAQUE). ips = incidentes CF_IP_FLOOD no resueltos
 *  de la org con el mismo details.host, este incluido. No mira module ni severity: CF_IP_FLOOD ya es de Cloudflare y
 *  `module` no es columna de incidents (incidente.ts:77). */
export function ofreceBajoAtaque(inc: { status: string; rule_ids: readonly string[]; details: Record<string, unknown> },
  ips: number): { ofrece: true; host: string }
  | { ofrece: false; motivo: 'no_aplica' | 'cerrado' | 'sin_host' | 'una_ip'; host: string | null };

/** Guardas y textos de la simulación. protegidos = [host de APP_ORIGIN, 'www.' + ese host]. host: debe ser la zona o
 *  terminar en '.' + zona. zone: zona ≠ zonaProducto y zonaProducto no termina en '.' + zona. sin_cupo: reglasUsadas ≥
 *  CUPO_REGLAS_CONFIG[plan]. Avisos en español, listos para pintar (ProposeResponse.avisos). */
export function simularBajoAtaque(o: { scope: 'host' | 'zone'; host: string; zona: string; protegidos: readonly string[];
  zonaProducto: string | null; plan: string | null; reglasUsadas: number | null; ttl_s: number })
  : { ok: true; target: string; efecto: string; avisos: string[] } | { ok: false; reason: MotivoBajoAtaque };

/** Sin fecha: `http.host eq "<host>"`. Con fecha: `(http.host eq "<host>" and http.request.timestamp.sec lt <epoch>)`,
 *  epoch = Math.floor(hasta / 1000). El host ya pasó hostCanonico (sin comillas): la expresión no admite inyección. */
export function expresionBajoAtaque(host: string, hasta: Date | null): string;
export const refBajoAtaque = (approvalId: string) => 'vg_ua_' + approvalId.replace(/-/g, '');
/** «VanGUARD #A1F3C9 · bajo ataque · 5f2c9a10 · hasta 2026-10-24T23:42:00Z» (≤ 120; 8 hex del approval_id para
 *  reconciliar sin depender del ref; nada personal). */
export function notasBajoAtaque(code: string | null, approvalId: string, hasta: Date): string;
export function reglaBajoAtaque(host: string, ref: string, description: string, hasta: Date | null): {
  ref: string; description: string; expression: string; action: 'set_config';
  action_parameters: { security_level: 'under_attack' }; enabled: true };
/** Texto de UnderAttackOffer.copiar (≤ 1500) para activarlo a mano, como el fixture underAttackOfferSinPermiso. */
export function pasosManualesBajoAtaque(host: string, zona: string): string;
/** Texto de copiar cuando la retirada falló: «En Cloudflare (zona …): Rules → Configuration Rules → borra la regla
 *  «<descripcion>».» Con caducoEn añade «Ya no actúa desde <hora UTC>; solo ocupa una regla de tu plan.»; sin ella,
 *  «Sigue activa hasta que la borres.» (≤ 1500). */
export function pasosRetirarBajoAtaque(descripcion: string, zona: string, caducoEn: Date | null): string;
/** WhatsApp: «Código 483920 para activar el modo bajo ataque en demo.officialvanguard.com durante 30 min. Vence en 10
 *  min.» Lanza si el código no son 6 dígitos (como textoCodigoBloqueo). */
export function textoCodigoBajoAtaque(code: string, host: string): string;
```

Textos de la simulación (host): efecto `Modo bajo ataque solo en <host> durante 30 min: cada visitante pasará un desafío
de Cloudflare`; avisos `El resto de <zona> no cambia: tu app, tu API y tus webhooks siguen igual`, `Rompe las llamadas
de API, webhooks y apps móviles a <host>: no resuelven el desafío`, `Usa 1 de las <N> reglas de configuración de tu
plan <Plan>` (si se conoce el plan). Zona (P1): efecto `Modo bajo ataque en toda la zona <zona> durante 30 min`; aviso
`Afecta a todos los hosts de <zona>, también a tu web principal y a tu API`.

`textoCodigoBajoAtaque` va en este archivo, no en `templates/whatsapp.ts`: no se toca nada de la mensajería.

---

## 8. Cambios en `apps/api`

| Archivo | Cambio | Prio |
|---|---|---|
| `src/actions/cf-seco.ts` (nuevo) | `mutarEnSeco` (abajo): el único camino de las mutaciones de prueba | P0 |
| `src/actions/under-attack.ts` (nuevo) | `leerParamsBajoAtaque`, `proponerBajoAtaque`, `executeUnderAttack`, `deshacerBajoAtaque`, `reconciliarHuerfana`, `leerOfertaBajoAtaque` (lecturas de E55/E56) | P0 |
| `src/rutas/bajo-ataque.ts` (nuevo) | E55 y E56 | P0 |
| `src/rutas/index.ts` | `rutas.route('/', bajoAtaque)` (interruptor del corte, §13.1) | P0 |
| `src/rutas/actions.ts` | E21 y E22 despachan por tipo en la primera línea (§5) | P0 |
| `src/rutas/connections.ts` | E10 por tipo (D10) | P0 |
| `src/actions/block-ip.ts` | `deshacerBloqueos`: una fila con `previous.scope` (bajo ataque) → `'invalido'` sin tocar Cloudflare (defensa). Nada más | P0 |
| `src/engine/housekeeping.ts` | caducidad por tipo, presupuesto por subpeticiones y propuesta huérfana (abajo) | P0 |
| `src/scans/cloudflare.ts` | sonda `config_rules_edit` con `mutarEnSeco` (§5, E9) | P0 (recortable) |
| `src/estado/modulo.ts` | nada en P0 | — |

`mutarEnSeco` (`actions/cf-seco.ts`):

```ts
export type ResultadoSeco =
  | { tipo: 'valida' }                                   // 2xx con result === null
  | { tipo: 'sin_permiso' }                              // 403
  | { tipo: 'token_invalido' }                           // 401
  | { tipo: 'rechazada'; status: number; codigo: number | null }   // otro 4xx (codigo = errors[0].code de Cloudflare)
  | { tipo: 'sin_respuesta' }                            // red, plazo, 429 o 5xx
  | { tipo: 'escrita'; retirada: boolean };              // 2xx con result NO nulo: Cloudflare escribió
/** Única vía de las mutaciones de prueba (E56 y la sonda de E8/E9). Siempre POST a `${CF}/zones/${zoneId}${ruta}` con
 *  `dry_run=true` puesto con URL.searchParams.set. Un 2xx con result no nulo es una escritura colada: busca en
 *  result.rules la regla con `ref`, hace DELETE de esa regla en result.id, log('error', 'bajo_ataque.dry_run_escribio',
 *  {status, retirada}) sin cuerpo ni token, y devuelve 'escrita'. Nunca lanza. ≤ 2 subpeticiones. */
export async function mutarEnSeco(token: string, zoneId: string, ruta: string, cuerpo: unknown, ref: string)
  : Promise<ResultadoSeco>;
```

`proponerBajoAtaque` es una función propia y **no** refactoriza `proponerBloqueo` (E20 está probado y congela pronto).
Reusa lo ya exportado: `elegirConexion`, `leerIncidenteBloqueo`, `otpHashParam`, `sixDigitCode`, `getKeys`,
`activeKid`, `ventanaAbierta`, `kapsoConfigurado`, `enviarKapso`, `cuerpoTexto`, `enmascararTelefono`. Son ~30 líneas
duplicadas de la rama `app` de `proponerBloqueo`; se apunta como deuda.

`executeUnderAttack(env, approval, {rid, ahora?}) → ResultadoBajoAtaque` (`'ejecutado' | 'rechazado' | 'caido' |
'en_curso' | 'invalido'`, como `ResultadoBloqueo`):

1. `leerParamsBajoAtaque(params)`; inválido → `invalido`.
2. Fila por `approval_id` → `desdeFila` (idempotencia, igual que `executeBlock`).
3. `hasta = ahora + ttl_s`; `descripcion = notasBajoAtaque(incident_code, approval_id, hasta)`. Inserta `actions
   {kind:'under_attack_on', target, status:'proposed', approval_id, incident_id, requested_by, expires_at: hasta,
   previous:{connection_id, zone_id, scope:'host', ref, descripcion, caduca_en_regla: CADUCIDAD_EN_REGLA}}`. 23505 →
   lee la fila viva de ese host (o la de esa aprobación): `executed` → `ejecutado` con `repetido: true` y «El modo bajo
   ataque ya estaba activo en <host>»; `proposed` → `en_curso`.
4. `marcarHermanas` (el `group` es el propio id: sin hermanas en P0).
5. `withSecret(action)`:
   - `GET` del entrypoint. Si una regla trae nuestro `ref` → se adopta su id (reintento tras una caída).
   - 200 → `POST /zones/{z}/rulesets/{id}/rules` con `reglaBajoAtaque(host, ref, descripcion, CADUCIDAD_EN_REGLA ?
     hasta : null)`. La respuesta trae el ruleset completo: el id es el de la regla con nuestro `ref`.
   - 404 → `POST /zones/{z}/rulesets` con `{name:'default', kind:'zone', phase:'http_config_settings', rules:[regla]}`
     → `result.id` y `result.rules[0].id`; `creo_ruleset: true`. Un 4xx aquí → se repite el `GET` una vez y se añade.
   - Red, plazo, 429 o 5xx → reconciliar: `GET` del entrypoint y buscar el `ref`. Si está → creada.
6. `executed` con `provider_ref`, `previous` completo (§4.3) y `expires_at`; incidente `mitigated` si estaba `open` o
   `ack`. Si el `UPDATE` falla → se borra la regla recién creada antes de responder 500 (como `retirarHuerfana`).
7. 403 → `failed` y `rechazado` con el texto de permiso; otro 4xx → `failed` y `rechazado`; caído → `failed` y `caido`.

`deshacerBajoAtaque(env, acciones, {rid, ahora?}) → {resultados: Map<id, ResultadoDeshacer>, subpeticiones}`: un sobre
por conexión; host → `DELETE /zones/{z}/rulesets/{ruleset_id}/rules/{provider_ref}` (2xx o 404 = `deshecho`; 403 =
`sin_permiso` con «Te falta el permiso Zone · Config Rules · Edit…»; 401 = `token_invalido`; 408/429/5xx = `caido`;
otro 4xx = `rechazado`); zona (P1) → `GET …/settings/security_level`: si ya no es `under_attack`, `deshecho` sin
tocar (alguien lo cambió); si lo es, `PATCH {"value": previous.security_level}`. Las deshechas pasan a `undone` en una
escritura. Reusa `PERMANENTES` y la forma de `MENSAJE_DESHACER`.

`housekeeping` (`caducarBloqueos`), presupuesto contado **por subpeticiones** (`r.subpeticiones`), no por filas:
- La lectura pasa de `.eq('kind','block_ip')` a `.in('kind', ['block_ip','under_attack_on'])`; se separan en memoria.
  `LIMITE_CADUCIDAD` (5) cuenta las dos, y de ellas como mucho `LIMITE_CADUCIDAD_BAJO_ATAQUE = 2` son `under_attack_on`
  (con la caducidad en la regla, no corre prisa). Mismas esperas y reintentos.
- Un fallo permanente al retirar un `under_attack_on` deja `failed` con `previous.deshacer_error` (como hoy) y
  `log('error', 'bajo_ataque.caducidad_fallida', {action_id, motivo, intentos})`. E55 la enseña (`retirada_fallida`).
- Propuesta huérfana (D8): **solo si la caducidad de este minuto gastó ≤ 15 subpeticiones**. Una lectura, `kind =
  'under_attack_on'`, `status = 'proposed'`, `created_at < now() - EN_CURSO_MS` (2 min, el de `block-ip.ts`), `limit
  1`. Con su conexión: `GET` del entrypoint; si una regla trae `previous.ref` → `DELETE`; la fila queda `failed` con
  `previous.huerfana: 'retirada' | 'no_estaba'` (con `.eq('status','proposed')`). Sin `VG_ENV=production`, no corre
  (como hoy).
- Actualizar el comentario de cabecera de `housekeeping.ts` con la cifra nueva (§12).

---

## 9. Cambios en `apps/web`

| Archivo | Cambio | Prio |
|---|---|---|
| `lib/consultas.ts` | `useOfertaBajoAtaque(org, incidentId)` → E55 con `esquema: UnderAttackOffer`, clave **`['org', org, 'under-attack', incidentId]`** (el esquema de todas las consultas) | P0 |
| `lib/mutaciones.ts` | `useBajoAtaque(org)`: `proponer(incidentId)` → E56 con `UnderAttackProposal`; `confirmar` y `deshacer` = los de `useBloqueo` (E21/E22); `fin()` = `invalidar('incident', 'incidents', 'overview', 'module', 'under-attack')`. `useInvalidar` llega a la consulta porque invalida por el prefijo `['org', org, k]` | P0 |
| `modulos/incidentes/BajoAtaque.tsx` (nuevo) | Componente (abajo) | P0 |
| `modulos/incidentes/BloquearIp.tsx` | `<Propuesta/>` gana props opcionales `verbo` (defecto «Confirmar bloqueo»), `icono` (defecto `Ban`) y `conBotonWhatsapp` (defecto `true`; con `false` dice solo «Te lo enviamos por WhatsApp.») | P0 |
| `modulos/incidentes/PaginaIncidente.tsx` | En `Acciones`, debajo de Bloquear IP: `{i.rule_ids.includes('CF_IP_FLOOD') \|\| ejecutada ? <BajoAtaque …/> : null}` | P0 |
| `lib/permisos.ts` | `config_rules_edit: 'Zone · Config Rules · Edit'`, `zone_settings_edit: 'Zone · Zone Settings · Edit'` | P0 |
| `lib/guias.ts` | Paso de «Modo blindaje»: «un segundo token con Zone · Firewall Services · Edit sobre la misma zona, y Zone · Config Rules · Edit si quieres activar el modo bajo ataque desde VanGUARD (puedes añadirlo cuando estés bajo ataque y quitarlo después). Firewall Services bloquea una IP; Config Rules activa el modo bajo ataque solo en el host atacado. Solo se usan cuando confirmas con tu código y nunca se entregan a la IA.» Y la frase de la portada: «…que solo bloquea una IP o activa el modo bajo ataque cuando tú lo confirmas». El texto vale para las dos opciones de la decisión 3 | P0 (recortable) |
| `modulos/conexiones/Asistente.tsx`, `ActivarBlindaje.tsx` | Los textos «solo Firewall Services · Edit» → «Firewall Services · Edit (y Config Rules · Edit para el modo bajo ataque)» | P0 (recortable) |
| `modulos/cloudflare/PaginaCloudflare.tsx` | Texto del Modo blindaje: «Puedes bloquear una IP o activar el modo bajo ataque en el host atacado, con simulación previa y «Deshacer».» | P1 |
| `lib/fixtures/router.ts` | E55 → `fx.underAttackOffer` (o con `activo` tras confirmar); E56 → `{ ...fx.underAttackProposal, expires_at: now + 10 min }`; confirm de `APPROVAL_BAJO_ATAQUE` → `ok:true` y añade a `incidentDetail.actions` un `under_attack_on` `executed` con id `ACTION_BAJO_ATAQUE` y `expires_at: now + 30 min`; undo → `undone` | P0 |

`BajoAtaque.tsx` (misma máquina de estados que `BloquearIp`, sin modal, botones de 56 px):
- Props: `org`, `incidentId`, `puedeEscribir`, `ejecutada` (el `under_attack_on` `executed` de `i.actions`).
- **Bandera del servidor**: si E55 da error (404 porque el BACK no registró la ruta o la quitó en el corte, o cualquier
  otro), no pinta nada. Así el FRONT entra antes de su congelación sin depender de B6 (el mismo patrón que la función 2).
- No pinta nada con `motivo` `no_aplica`, `cerrado` (sin `activo`) o `sin_conexion` (el bloque de Bloquear IP ya ofrece
  activar el Modo blindaje).
- `una_ip`: una línea en neutro, sin botón: «Viene de una sola IP: con «Bloquear IP» basta.»
- `sin_permiso`: tarjeta «Para activarlo desde aquí, añade Zone · Config Rules · Edit a tu token de Modo blindaje»,
  botón «Copiar pasos para hacerlo a mano» (copia `copiar`) y enlace a Conexiones. `en_curso`: «Se está activando…».
  `host_protegido` / `fuera_de_zona` / `sin_host`: una línea en neutro con el motivo (`sin_host`: «Ponle a tu conexión
  de ingesta el nombre del host atacado, por ejemplo demo.officialvanguard.com»).
- Reposo: botón secundario «Activar modo bajo ataque» (icono `ShieldAlert`) y debajo, en 12,5 px: «Llega tráfico de
  {ips} IPs a la vez: bloquearlas una a una no basta. Cada visitante de <host> pasa un desafío de Cloudflare durante
  30 min.» Viewer: deshabilitado con «Modo demo: solo lectura».
- Vista: `<Propuesta p={…} verbo="Activar bajo ataque" icono={ShieldAlert} conBotonWhatsapp={false} …/>`.
- Hecho: `Etiqueta` «Bajo ataque · <host> · hasta <hora>» (rol `aviso`) y botón «Desactivar ahora» (E22). Si
  `expires_at` ya pasó: «Venció a las <hora>; lo estamos retirando» y el mismo botón.
- `activo.retirada_fallida`: `Etiqueta` «No pudimos retirar la regla de Cloudflare» (rol `mal`), el texto de `copiar`
  y «Copiar pasos». El botón «Reintentar» llama a E22 (admite la fila `failed`).
- Errores por `details.reason` con un mapa cerrado y texto por defecto (`mensajeDe`); todo texto del servidor pasa por
  `sinBidi`, como en `BloquearIp`.

---

## 10. Pruebas mínimas

**core** (`bajo-ataque.test.ts`):
- `hostCanonico`: acepta `Demo.OfficialVanguard.com.` → `demo.officialvanguard.com`; rechaza `Tienda Demo`, `*.x.com`,
  `a"b.com`, `x.com:443`, `x.com/a`, `203.0.113.7`, `localhost`, 121 caracteres, etiqueta de 64.
- `ofreceBajoAtaque`: `CF_IP_FLOOD` con `ips: 2` → ofrece; `ips: 1` → `una_ip`; `CF_ADMIN_EXPOSED` critical sin
  inundación → `no_aplica`; `CF_PATH_SCAN` → `no_aplica`; `['CF_UA_TOOL','CF_IP_FLOOD']` con `ips: 3` → ofrece;
  `resolved` → `cerrado`; `details.host: 'Tienda Demo'` → `sin_host`.
- `simularBajoAtaque`: `officialvanguard.com` y `www.officialvanguard.com` → `host_protegido`; `demo.otra.com` en la
  zona `officialvanguard.com` → `fuera_de_zona`; `scope:'zone'` en la zona del producto → `zona_del_producto`; 10 de 10
  en Free → `sin_cupo`; avisos exactos del caso de la demo (los del fixture, salvo el de `dry_run`).
- `expresionBajoAtaque(host, new Date('2026-10-24T23:42:00Z'))` → `(http.host eq "demo.officialvanguard.com" and
  http.request.timestamp.sec lt 1792885320)`; con `null` → solo el host. `notasBajoAtaque` (≤ 120, formato),
  `refBajoAtaque` (38 car.), `pasosRetirarBajoAtaque` (con y sin fecha), `textoCodigoBajoAtaque` (lanza con 5 dígitos).

**api**:
- `actions/cf-seco.test.ts`: la URL lleva siempre `dry_run=true` y el método es `POST`; 200 con `result: null` →
  `valida`; **200 con `result` = ruleset que trae nuestro `ref` → `DELETE` de esa regla y `escrita`**; 403 →
  `sin_permiso`; 401 → `token_invalido`; 400 → `rechazada` con el código; 5xx y red → `sin_respuesta`.
- `actions/under-attack.test.ts` con `fetch` simulado: entrypoint 200 → `POST …/rules` y `executed` con el id de la
  regla del `ref`; la expresión del `POST` lleva `http.request.timestamp.sec lt <epoch de expires_at>`; 404 →
  `POST /rulesets` y `creo_ruleset`; 403 → `failed` y `ok:false` con el texto de permiso; 5xx en el `POST` y la regla
  aparece en el `GET` → `executed`; 23505 → devuelve la fila viva sin llamar a Cloudflare. Nunca un `PUT` (se comprueba
  el método de cada llamada).
- `deshacerBajoAtaque`: 200 y 404 → `undone`; 403 → `sin_permiso` y la fila no cambia.
- `rutas/bajo-ataque.test.ts`: E55 para viewer (200) y otra org (404); E55 con un solo `CF_IP_FLOOD` → `una_ip`; E55
  con una `proposed` de 3 min → `en_curso`; E55 con una `failed` con `deshacer_error` → `activo.retirada_fallida` y
  `copiar`; E56 sin admin (403), fuera del host (403), sin conexión (409), host protegido (422), `una_ip` (422), ya
  activo (409 con `action_id`), `proposed` de 3 min (409 `in_progress`), `dry_run` 403 (409 `sin_permiso` con
  `copiar`), org de demo sin WhatsApp (`delivery:'in_app'` y `code`), otra org sin WhatsApp (502, sin filas creadas).
  **Todo `fetch` no GET de E56 lleva `dry_run=true` en la URL.**
- `rutas/actions.test.ts`: E21 con una aprobación `under_attack_on` llama a `executeUnderAttack`; E22 con una acción
  `under_attack_on` llama a `deshacerBajoAtaque`; el caso existente «`under_attack_on` en E20 → 422» sigue verde; todos
  los casos `block_ip` de hoy, sin tocar, en verde.
- `connections.test.ts`: E10 con un `under_attack_on` vivo llama a `deshacerBajoAtaque`, no a `deshacerBloqueos`; los
  casos de hoy en verde. `block-ip.test.ts` en verde.
- `housekeeping.test.ts`: un `under_attack_on` vencido se retira; con 3 vencidos solo se procesan 2; una propuesta
  huérfana de 3 min con la regla presente → `DELETE` y `failed`; si la caducidad gastó más de 15 subpeticiones, no se
  lee la huérfana; el total del minuto en el peor caso ≤ 29.
- `scans/cloudflare.test.ts`: entrypoint 403 → `config_rules_edit: false`; 200 + `dry_run` 200 (`result: null`) →
  `true`; 404 + `dry_run` en `/rulesets` → `true`; **`dry_run` 5xx o red → `capabilities` sin la clave
  `config_rules_edit`**; todo `fetch` no GET de E8 y E9 lleva `dry_run=true`.

**web**: `BajoAtaque` no se pinta con `no_aplica` ni con E55 en 404; `una_ip` enseña la línea sin botón; viewer
deshabilitado; recorrido reposo → vista → hecho → desactivado con el router de fixtures, y **tras confirmar la tarjeta
pasa a «Hecho» sin recargar** (la clave `['org', org, 'under-attack', id]` se invalida); `sin_permiso` muestra «Copiar
pasos»; `retirada_fallida` muestra la etiqueta y «Copiar pasos»; el arnés de XSS pasa el `efecto` y los `avisos` con
controles bidi.

**contracts**: §6.2 (ya comprobado en la copia: 55/55).

---

## 11. Seguridad

- **Confirmación explícita**: admin, host de producción, código de 6 dígitos (HMAC con la FPK, un solo uso, 10 min, 5
  intentos), `RL_COSTLY`. Nunca automático.
- **Simulación previa** real: guardas puras y `dry_run` de Cloudflare por un solo helper (`mutarEnSeco`) que exige
  `result: null` y deshace al instante cualquier escritura colada. Las pruebas comprueban `dry_run=true` en cada
  mutación de E56, E8 y E9.
- **TTL y Deshacer**: 30 min con la caducidad **dentro de la regla** (§1.6): Cloudflare deja de aplicarla aunque el
  token se revoque, se quite el permiso, Supabase caiga o el cron no corra. `housekeeping` la borra al vencer (limpieza),
  «Desactivar ahora» la borra antes, y la huérfana se limpia a los 2 min (D8). Una retirada fallida queda visible en
  E55 con los pasos para borrarla a mano. Al borrar el token de acciones, E10 retira antes sus modos vivos (D10). Si
  §1.6 no se confirma, este punto vuelve a «depende de `housekeeping`» y así se dice.
- **Sin inyección en la expresión**: `details.host` pasa `hostCanonico` (sin comillas ni espacios) y la expresión la
  arma el código. Ese host no lo observa la regla: es el nombre que el admin dio a la conexión de ingesta (D2). Lo
  acotan `fuera_de_zona`, `host_protegido` y el código del admin.
- **VanGUARD nunca se pone bajo ataque**: `host_protegido` (host de `APP_ORIGIN` y su `www.`) y `zona_del_producto`
  para el zonal. Es crítico porque «Tienda Demo» usa la zona `officialvanguard.com`.
- **Reglas del cliente intactas**: solo `POST` de una regla y `DELETE` por id; nunca `PUT` del entrypoint (D9).
- **Mínimo privilegio y riesgo nuevo**: el permiso nuevo va en el token de acciones, que solo se descifra dentro de
  `withSecret` en E56 (validación), E21, E22, E10, la sonda y `housekeeping`, y nunca se entrega a la IA ni sale en logs.
  Pero Config Rules · Edit deja poner `ssl: off`, `security_level: off` u otros ajustes en cualquier host de la zona
  (§1.1): un token filtrado haría más daño que hoy. Mitigación: token acotado a la zona y con fecha de fin (§16), y la
  decisión 3 (§18) de tenerlo solo durante el ataque. `SECURITY.md` y `THREAT_MODEL.md` A1 lo dicen en P0 (O3a).
- **Logs**: código del incidente, `action_id`, resultado y códigos HTTP. Nunca el token, el cuerpo de Cloudflare ni el
  código de 6 dígitos.
- **Abuso**: un atacante que provoca un incidente solo consigue que se **ofrezca** el modo (y solo si inunda desde ≥ 2
  IPs); activarlo exige el código del admin. Si alguien lo activa sin necesidad, los humanos pasan el desafío y vence a
  los 30 min.
- **Anti-IDOR**: incidente, aprobación y acción se leen siempre por id **y** `org_id`.
- **T02-14**: no se afirma en el pitch hasta pasar la prueba de humo (B6). El fixture no se cita como medida.
- Documentar en `SECURITY.md` (nueva acción de escritura, permiso nuevo y su alcance real) y en `THREAT_MODEL.md` (A1:
  con el token de acciones, bloqueos de IP **y cualquier ajuste de configuración de la zona**; activación provocada,
  regla huérfana, host protegido): O3a, P0.

---

## 12. Costo en Workers Free (10 ms de CPU, 50 subpeticiones; tope del equipo 40)

| Invocación | Subpeticiones | CPU |
|---|---|---|
| E55 | 4 (incidente; luego conexiones, acciones y conteo en paralelo); 0 a Cloudflare | < 1 ms |
| E56 | ≈ 14–15: incidente 1 + 5 en paralelo + claves 2 + sobre 2 + `GET` entrypoint 1 + `dry_run` 1 (+ `DELETE` 1 si se coló una escritura) + aprobación 1 + Kapso 1 | ~2 ms (un ruleset de ≤ 10 reglas en Free pesa pocos KB) |
| E21 (bajo ataque) | ≈ 14–16: pre-lectura 1 + claves 2 + canje 1 + fila previa 1 + insert 1 + hermanas 1 + sobre 2 + `GET` 1 + `POST` 1 (+ `GET` de reconciliación o reintento 1–2) + update 1 + incidente 1 | ~2 ms |
| E22 | 5 (zona P1: 6) | < 1 ms |
| Sonda | +2 (`GET` entrypoint y `dry_run`; +1 si se colara una escritura) | < 1 ms |
| `housekeeping` | incidentes ≤ 2 + vigilante ≤ 2 + caducidad ≤ 25 (1 lectura + por cada función de deshacer 2 por conexión + 1 por regla + ≤ 2 escrituras, + 1 por fila no retirada; 5 filas, ≤ 2 de bajo ataque) + huérfana ≤ 6 (1 lectura + sobre 2 + `GET` + `DELETE` + update) **solo si la caducidad gastó ≤ 15** | peor caso **≤ 29 de 40** (P1 zonal, `GET` + `PATCH` por fila: ≤ 31) |

La cifra anterior («≤ 33») se quedaba corta: con dos funciones de deshacer cada una abre su propio sobre por conexión y
hace su propia escritura, y la huérfana suma 6, no 5. Sin límites nuevos el peor caso eran ≈ 35 (≈ 40 en P1). Los dos
límites de §8 (≤ 2 de bajo ataque y huérfana condicionada) lo dejan en ≤ 29.

Ni cola ni crons nuevos. `RL_COSTLY` limita E56 a 10 por minuto y usuario.

---

## 13. Encargo al BACK (por pasos)

Orden: B0 → B1 → B2 → B3 → B4, con B2+B3+B4 **en el mismo push** (D10) → B5 → B6. P0 total ≈ **4 h 45 min** (4 h 20 min sin B5).

| Paso | Qué | Archivos | Prio | Tiempo |
|---|---|---|---|---|
| B0 | Aplicar `0017_bajo_ataque.sql` (§4.1) tras la revisión del ORQUESTADOR | `supabase/migrations/0017_bajo_ataque.sql` | P0 · primero | 5 min |
| B1 | `core/bajo-ataque.ts` y su test (§7, §10): regla de 2 IPs, caducidad en la expresión, pasos para retirar | `packages/core/src/bajo-ataque.ts`, `index.ts` | P0 | 45 min |
| B2 | `actions/cf-seco.ts` (`mutarEnSeco`) y `actions/under-attack.ts`: proponer con `dry_run` y entrega del código, ejecutar, deshacer, huérfana, lecturas de E55/E56 (§8) | `apps/api/src/actions/{cf-seco,under-attack}.ts` + tests | P0 | 1 h 45 min |
| B3 | E55 y E56; E21, E22 y E10 despachando por `kind` en la primera línea con la rama `block_ip` idéntica; `deshacerBloqueos` defensivo. **Antes del push: `actions.test`, `connections.test` y `block-ip.test` en verde** | `rutas/bajo-ataque.ts`, `rutas/index.ts`, `rutas/actions.ts`, `rutas/connections.ts`, `actions/block-ip.ts` + tests | P0 | 55 min |
| B4 | `housekeeping`: caducidad por tipo, ≤ 2 de bajo ataque, presupuesto por subpeticiones, huérfana a los 2 min y condicionada | `engine/housekeeping.ts` + test | P0 | 30 min |
| B5 | Sonda `config_rules_edit` con `mutarEnSeco`; solo un 403 guarda `false` | `scans/cloudflare.ts` + test | P0 · recortable | 25 min |
| B6 | Prueba de humo en producción con Giovanni (§17.3) y dejar el resultado en el chat del ORQUESTADOR | — | P0 | 20 min |
| B7 | Alcance `zone` (§5, §8) con la guarda `zona_del_producto` | los mismos | P1 | 45 min |
| B8 | Botones ok/no de WhatsApp para bajo ataque (generalizar `canjearBotonBloqueo`; toca E31: coordinar con quien lleva la mensajería) | `actions/approvals.ts` | P2 | — |
| B9 | `meta.hostname` validado al dar de alta la ingesta (o el Host en el evento), para que el host no dependa del nombre de la conexión (D2) | `rutas/connections.ts`, `engine/evaluar.ts`, `packages/contracts` | P1 | — |
| B10 | Regla de inundación de toda la org (muchas IPs, ninguna con ≥ 20 %), que hoy no abre incidente (D3) | `packages/core/src/engine/edge.ts` | P1 | — |

No tocar: `notify/kapso.ts`, `notify/despachador.ts`, `rutas/webhooks-kapso.ts`, `wrangler.jsonc`.

### 13.1 Esta noche con las otras dos funciones, y qué se corta

| Sesión | (1) Evolución | (2) Bloqueo de merge | (3) Bajo ataque | Total P0 |
|---|---|---|---|---|
| BACK | ≈ 1 h 45 (`evolucion-entre-revisiones.md` §9.2) | ≈ 4 h 25 (`bloqueo-merge-criticos.md` §10.2) | ≈ 4 h 45 (4 h 20 sin B5) | **≈ 10 h 55** |
| FRONT | ≈ 2 h 30 (§9.3) | ≈ 2 h 30 (§10.3) | ≈ 2 h 25 (2 h 05 sin F3) | **≈ 7 h 25** |

1. **Orden en el BACK**: esta función va la **última**. Las otras dos no tocan «Bloquear IP» y esta sí (E21, E22, E10).
   Su B3 va después del B4 de la función (2), que también cambia E8, E9 y E10 en `rutas/connections.ts`: en serie y en
   la misma sesión, nunca en paralelo. Con las dos primeras desde las 19:15, B0–B2 de esta acaban hacia las 04:00.
2. **Recorte, por este orden**: (a) sin B5: E55 dirá siempre `permiso: 'sin_probar'` y el 403 lo detecta el `dry_run`
   de E56 (409 `sin_permiso` con `copiar`); (b) sin F3 ni F5: los textos de la guía siguen diciendo «Firewall Services ·
   Edit», que coincide con la opción (b) de la decisión 3; (c) B7–B10 ya son P1/P2.
3. **B3 sin riesgo para Bloquear IP**: despacho por `kind` en la primera línea de E21, E22 y E10; el diff de la rama
   `block_ip` vacío; `actions.test`, `connections.test` y `block-ip.test` en verde antes del push.
4. **Corte 1 · dom 05:00**: si B2 no está en verde, no se empieza B3. B1 y B2 se quedan en `main` (nadie los llama) y
   la función pasa a la hoja de ruta. E21, E22 y E10 no se tocan.
5. **Corte 2 · dom 09:30**: si B6 no pasó, el BACK quita la línea `rutas.route('/', bajoAtaque)` (E55 → 404, la tarjeta
   no se pinta) y el pitch no lo menciona (T02-14). E21, E22 y E10 siguen despachando por tipo: sin aprobaciones
   `under_attack_on` no hay nada que despachar.

## 14. Encargo al FRONT (por pasos)

Empieza en cuanto O1 esté en `main`. P0 total ≈ **2 h 25 min** (2 h 05 min sin F3). Tiene que entrar antes de la
congelación del domingo; la tarjeta solo se pinta si E55 responde (bandera del servidor, §9), así que puede entrar
aunque el BACK vaya detrás.

| Paso | Qué | Archivos | Prio | Tiempo |
|---|---|---|---|---|
| F1 | Consulta E55 con la clave `['org', org, 'under-attack', id]`, mutaciones E56/E21/E22 con `fin()` que invalida `under-attack`, y router de fixtures | `lib/consultas.ts`, `lib/mutaciones.ts`, `lib/fixtures/router.ts` | P0 | 25 min |
| F2 | `BajoAtaque.tsx` (con `una_ip`, `retirada_fallida` y nada si E55 falla), props nuevas de `<Propuesta/>` y montaje en el incidente | `modulos/incidentes/{BajoAtaque,BloquearIp,PaginaIncidente}.tsx` | P0 | 1 h 10 min |
| F3 | Textos del token y del permiso | `lib/{guias,permisos}.ts`, `modulos/conexiones/{Asistente,ActivarBlindaje}.tsx` | P0 · recortable | 20 min |
| F4 | Pruebas (§10, web) | `modulos/incidentes/*.test.tsx` | P0 | 30 min |
| F5 | Texto de `PaginaCloudflare.tsx` | `modulos/cloudflare/PaginaCloudflare.tsx` | P1 | 5 min |

## 15. Lo que hace el ORQUESTADOR

| Paso | Qué | Prio | Tiempo |
|---|---|---|---|
| O1 | Contrato y fixtures de §6 en `main` (bloques listos en el scratchpad, §6); `pnpm --filter @vanguard/contracts test` y `typecheck` en verde | P0 · primero | 20 min |
| O2 | Revisar `0017` y pasársela al BACK | P0 | 5 min |
| O3a | `SECURITY.md` (acción nueva, permiso nuevo y lo que deja hacer: `ssl: off`, `security_level: off` en la zona) y `THREAT_MODEL.md` A1 («con el token de acciones, bloqueos de IP y cualquier ajuste de configuración de la zona») | P0 | 15 min |
| O3b | `PLAN_MAESTRO.md` §08.8 (fila `under_attack_on`: P0 por host, la tabla de permisos), §15.4 (E55–E56); `ARQUITECTURA.md`; paso nuevo en `PASOS_MANUALES_GIOVANNI.md` (§16) | P1 | 25 min |
| O4 | `demo/guion.md`: tramo de §17 si Giovanni lo aprueba (§18, decisión 2); «Estado de la entrega» solo tras B6 | P1 | 15 min |

`wrangler.jsonc`: sin cambios.

## 16. Lo que hace Giovanni (o Gabriel)

1. **Token de Modo blindaje** (5 min), según la decisión 3 (§18): Cloudflare → My Profile → API Tokens → el token de
   Modo blindaje → *Edit* → añadir **Zone · Config Rules · Edit**. *Zone Resources*: Include · Specific zone ·
   `officialvanguard.com` (nunca «All zones»). *TTL*: una fecha de fin posterior al pitch (por ejemplo, 27-oct). Ojo:
   la fecha es del token entero (`expires_on` es un campo del token, no del permiso [verificado:
   https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/update/]): al vencer se corta
   también Bloquear IP. Con la opción (b), el permiso se añade antes de la prueba de humo y se quita cuando VanGUARD ya
   retiró la regla (la tarjeta deja de decir «Bajo ataque»). Si al editar cambia el valor del token [no verificado; el
   update del API no devuelve un valor nuevo, y rotarlo es otra operación], volver a conectarlo con «Activar modo
   blindaje». No pegues el token en ningún chat.
2. **Probar** (1 min, si B5 entró): VanGUARD → «Tienda Demo» → Conexiones → Cloudflare → «Probar conexión» en el token
   de acciones → tiene que salir ✓ Zone · Config Rules · Edit. Si sale «inválido» con el permiso puesto, avisa al BACK:
   Cloudflare no admite la caducidad en la expresión (§1.6). Sin B5 no se ve aquí; lo comprueba E56.
3. **Nombre de la conexión de ingesta** (1 min, al desplegar la víctima): la conexión de ingesta de «Tienda Demo» se
   tiene que llamar **exactamente** `demo.officialvanguard.com` (campo «Nombre de tu app»). Ese nombre es el host que
   VanGUARD pone bajo ataque. Con otro nombre («Tienda Demo»), la tarjeta dice «Ponle a tu conexión de ingesta el
   nombre del host» y no ofrece el botón. Si ya existe con otro nombre: bórrala y créala de nuevo (el secreto de
   ingesta cambia: hay que volver a ponerlo en la víctima).
4. **No hace falta** Zone · Zone Settings · Edit: el zonal nunca se ofrece en `officialvanguard.com`.
5. **Víctima** (10 min, si el tramo va en vivo): paso 13 de `PASOS_MANUALES_GIOVANNI.md`. La regla del paso 14 ya
   existe y no choca con esta (§1.1).
6. **Protección de rama**: no aplica a esta función (es de la función 2).
7. Responder las tres decisiones de §18.

---

## 17. Guion de demo

### 17.1 Plan A: víctima desplegada (~60 s, después del incidente en vivo)

Necesita **dos IPs** atacando a la vez: el portátil del atacante por el hotspot y un segundo equipo en otra red (por
ejemplo, otro móvil con datos de otra operadora), las dos distintas de la red del panel. Cada una con
`node scripts/ataque.mjs https://demo.officialvanguard.com --rps 5 --segundos 90` basta para `CF_IP_FLOOD` (≥ 100
peticiones en 60 s y ≥ 20 % del tráfico cada una). Si solo hay una IP, el tramo es «Bloquear IP» y la tarjeta enseña
«Viene de una sola IP: con Bloquear IP basta» (también es una buena frase: la regla elige la acción proporcional).

1. Pantalla de uno de los dos incidentes de inundación. «Una IP la bloqueo. Cuando son varias a la vez, pongo solo este
   host en modo bajo ataque.»
2. «Activar modo bajo ataque». La simulación dice: solo `demo.officialvanguard.com`, 30 min; «El resto de
   officialvanguard.com no cambia»; «Cloudflare validó la regla sin publicarla».
3. Código (WhatsApp, o en pantalla en la org de demo) → «Activar bajo ataque» → «Bajo ataque · demo.officialvanguard.com
   · hasta 19:42».
4. **Qué ve el jurado**: una pestaña de incógnito abre `https://demo.officialvanguard.com/` y sale el desafío de
   Cloudflare. Las terminales del atacante reciben 403. En el panel de Cloudflare (Rules → Configuration Rules)
   aparece «VanGUARD #A1F3C9 · bajo ataque · … · hasta …», con la hora de fin dentro de la propia regla. El panel de
   VanGUARD sigue funcionando: está en otro host.
5. «Desactivar ahora» → se recarga la pestaña de incógnito y vuelve la tienda; la regla desaparece del panel. «Y si
   nadie lo apaga, la propia regla deja de actuar a los 30 minutos, aunque VanGUARD se cayera.» (Esta frase solo si
   §1.6 se confirmó en B6.)

Red: el portátil del panel va por el wifi del evento y el ataque por el hotspot y la segunda red (paso 15.3). Un humano
pasa el desafío; el script no.

### 17.2 Plan B: sin víctima desplegada

El host no resuelve y no hay incidente en vivo: no hay nada honesto que enseñar en pantalla. Si B6 pasó, una frase en
el pitch: «también pone en modo bajo ataque solo el host atacado, con código y 30 minutos de vida; lo probamos en
producción contra un host de prueba». Sin pantallas de fixtures (T02-14).

### 17.3 Prueba de humo (B6, con o sin víctima; 20 min)

Ojo con el reloj: `vg_resolve_idle_incidents` (0009) cierra a los 15 min de `last_event_at` un incidente `CF_` sin
peticiones de su IP en `edge_hits`, y los de ensayo no tienen ninguna. Los pasos 2–5 tienen que caber en 15 min, o se
refresca `last_event_at` antes del paso 5 (abajo).

1. El BACK inserta por SQL en «Tienda Demo» **dos** incidentes de ensayo (dos IPs de documentación, mismo host). Ese
   host no tiene DNS: el efecto es nulo y nadie queda bajo desafío. `incidents` no tiene columna `module` (se deriva de
   `rule_ids`), y `title`, `resource` y `dedupe_key` son obligatorios:

   ```sql
   insert into public.incidents (org_id, rule_ids, severity, title, resource, dedupe_key, details)
   select '00000000-0000-4000-a000-00000000de00'::uuid, '{CF_IP_FLOOD}', 'critical',
          'Ensayo: inundación de peticiones desde 198.51.x.x', 'ip:' || x.ip,
          encode(sha256(convert_to('00000000-0000-4000-a000-00000000de00|edge|' || x.ip, 'UTF8')), 'hex'),
          jsonb_build_object('ip', x.ip, 'host', 'prueba-ataque.officialvanguard.com', 'ensayo', true)
     from (values ('198.51.100.7'), ('198.51.100.8')) as x(ip)
   returning id, code;
   ```

2. Giovanni abre uno de los dos en `officialvanguard.com`: la tarjeta dice «2 IPs» y ofrece «Activar modo bajo
   ataque». Comprueba `validado: true`.
3. Confirma con el código. En el panel de Cloudflare aparece la regla con su descripción y la expresión con
   `http.request.timestamp.sec lt …`. Si el `dry_run` la rechazó, ver el final.
4. «Desactivar ahora». La regla desaparece.
5. Caducidad: el BACK refresca los dos incidentes (`update public.incidents set last_event_at = now() where org_id =
   '00000000-0000-4000-a000-00000000de00' and details->>'ensayo' = 'true' and status <> 'resolved';`); se activa otra
   vez; el BACK pone `expires_at = now()` a esa fila por SQL; al minuto la regla ya no está y la fila es `undone`.
6. Una IP: el BACK resuelve uno de los dos (`update public.incidents set status = 'resolved', resolved_at = now() where
   code = '<code del segundo>';`). El otro enseña «Viene de una sola IP» sin botón.
7. Con la víctima desplegada, además (es el camino real, el host sale del nombre de la conexión de ingesta, §16 paso
   3): un ataque desde dos IPs contra `demo.officialvanguard.com` abre dos incidentes de la ingesta real; la tarjeta
   ofrece el modo; activarlo y `curl -sI https://demo.officialvanguard.com/` → 403 de Cloudflare (confirma §1.5, [no
   verificado] hasta entonces).
8. El BACK resuelve los incidentes de ensayo y lo dice en el chat del ORQUESTADOR. Si `ref` falla en el `dry_run`, se
   quita `ref` y se reconcilia solo por los 8 hex de la descripción. Si el `dry_run` rechaza
   `http.request.timestamp.sec`, `CADUCIDAD_EN_REGLA = false`, redeploy, se repiten los pasos 2–4, y el pitch y §11 no
   dicen que caduca sola.

---

## 18. Decisiones abiertas para Giovanni

1. **¿Activación automática?** Hoy nunca se activa sin código. Alternativa: un interruptor por org que lo active solo
   ante una inundación de varias IPs, con 10 min de vida y aviso por el WhatsApp existente. Va contra «toda escritura
   con confirmación explícita» y no cabe esta noche. **Recomendación: no.** Queda en la hoja de ruta.
2. **¿Tramo en vivo en el guion?** Necesita la víctima (paso 13), la conexión de ingesta con el nombre del host (§16
   paso 3), dos IPs atacando y el permiso nuevo en el token (§16) antes de las 22:00, y suma ~60 s.
   **Recomendación: sí, si la víctima está desplegada a las 22:00**; si no, solo la frase del Plan B, y solo si la
   prueba de humo pasó.
3. **¿Config Rules · Edit permanente o solo durante el ataque?** Es lo literal del pedido («write en momentos en los
   que estemos bajo ataque»). El código es el mismo en los dos casos; cambian §16 y los textos de F3.
   - (a) **Permanente** en el token de Modo blindaje, acotado a la zona y con fecha de fin: el botón funciona al
     instante en un ataque. Riesgo: un token filtrado puede poner `ssl: off` o `security_level: off` en toda la zona,
     también en `officialvanguard.com` (D11).
   - (b) **Solo durante el ataque**: el token sigue con solo Firewall Services · Edit. En un ataque, E56 detecta el 403
     con `dry_run` y la tarjeta `sin_permiso` da «Copiar pasos» (hacerlo a mano en el panel) o explica cómo añadir el
     permiso; se quita cuando VanGUARD retiró la regla. Cloudflare no tiene caducidad por permiso: `expires_on` es del
     token entero y cortaría también Bloquear IP. Cuesta 1–2 min en medio del ataque.
   - **Recomendación: (a) para la demo** (zona del equipo, fecha de fin 27-oct, y es lo que hace el botón vistoso), y
     la guía de F3 explica (b) a los clientes («puedes añadirlo cuando estés bajo ataque y quitarlo después»).

---

## 19. Correcciones del revisor (sáb 24-oct, ~19:05)

### 19.1 Integradas (cada una comprobada contra el código o la documentación)

| # | Corrección | Comprobación | Dónde quedó |
|---|---|---|---|
| 1 | El host del incidente es el nombre libre de la conexión de ingesta; «nadie puede poner bajo ataque un host que la regla no vio» era falso | `evaluar.ts:48-54` (`host = o.label`), `edge.ts:139,171`, `connections.ts:116` (meta `{}`), `EdgeEvent` sin Host (`ingest.ts:5`), «Nombre de tu app» en `Asistente.tsx:194`, `label` 2–40 en `api.ts:30` | §0 Host, D2, E56 (`sin_host`), §9, §11, §16 paso 3, §17.3 paso 7, B9 |
| 2 | `incidents` no tiene `module`; la prueba de humo no corría; el ensayo se cierra a los 15 min | 0005 (sin `module`; `title`, `resource`, `dedupe_key` not null con `^[0-9a-f]{64}$`); `incidents.ts:40` lo deriva; `COLUMNAS_INCIDENTE_BLOQUEO` sin él; 0009 cierra a los 15 min | `ofreceBajoAtaque` sin `module` (con `CF_IP_FLOOD` ya es Cloudflare: más simple que derivarlo con `moduloDeRegla`), §17.3 con el INSERT completo y el aviso del reloj |
| 3 | Se ofrecía en escaneos, `/admin` abierto y con una sola IP; el caso de muchas IPs no lo detecta ninguna regla | `edge.ts:31-36,160`; Cloudflare «Only use Under Attack mode when a website is under a DDoS attack» | `REGLAS_QUE_OFRECEN = ['CF_IP_FLOOD']`, ≥ 2 incidentes del mismo host, motivo `una_ip` en el contrato, D3, §17.1 con dos IPs, B10 |
| 4 | El TTL dependía solo del cron; una fila `failed` dejaba de verse | `housekeeping.ts:167-176`; `http.request.timestamp.sec` existe (§1.6) | Caducidad en la expresión con `CADUCIDAD_EN_REGLA` y vuelta atrás, D8, §11, `retirada_fallida` en el contrato y en E55 |
| 5 | Config Rules · Edit da más de lo que decía; faltaba decidir permanente o puntual | settings de Configuration Rules (`ssl`, `security_level`, `bic`…); `THREAT_MODEL.md:38` | §1.1, D11, §11, O3a en P0, §16 (zona y fecha de fin), decisión 3 |
| 6 | «Propose no escribe» dependía de acordarse de `dry_run` | dry-run: éxito = `result: null`; la página dice «Supported … endpoints», no todas | `mutarEnSeco` único, `escrita` → `DELETE`, pruebas de `dry_run=true` en E56, E8 y E9; §1.4 corregido |
| 7 | Sin tiempos de las otras funciones ni recorte; B3 arriesga Bloquear IP | `evolucion-entre-revisiones.md` §9.2–9.3 y `bloqueo-merge-criticos.md` §10.2–10.3 (la 2 también toca `connections.ts`) | §13.1 (tabla de la noche, orden, recorte, B3 por `kind`, dos cortes) |
| 8 | Un fallo pasajero de la sonda guardaba `config_rules_edit: false` | `connections.ts:210-215`, `sondeo.ts:27-34` | E9: solo un 403 escribe `false`; prueba en `scans/cloudflare.test.ts` |
| 9 | La clave `['under-attack', org, id]` no la invalida `useInvalidar` | `mutaciones.ts:9-12`, `consultas.ts` (todo `['org', org, …]`) | §9 y F1: `['org', org, 'under-attack', id]` y `fin()` con `'under-attack'` |
| 10 | El presupuesto de `housekeeping` estaba por debajo (≈ 35; ≈ 39–40 en P1) | `housekeeping.ts:30`, `block-ip.ts:336-367` | §8 y §12: por subpeticiones, ≤ 2 de bajo ataque, huérfana solo si caducidad ≤ 15 → ≤ 29 (≤ 31 en P1) |
| 11 | El índice de 0017 contaba toda `proposed` y E55/E56 solo las de < 2 min; el `add constraint` no era reaplicable | §4.1 anterior; `EN_CURSO_MS = 2 min` en `block-ip.ts:19` | E55/E56: toda `proposed` es `en_curso`; huérfana a `EN_CURSO_MS`; `do $$ … if not exists … $$` |

### 19.2 Correcciones descartadas (o aplicadas de otra forma)

- **#5, «pide añadir Config Rules · Edit con caducidad (`expires_on` del token)»**: no se aplica tal cual. `expires_on`
  y `not_before` son campos del token entero; las políticas solo tienen `id`, `effect`, `permission_groups` y
  `resources` [verificado: https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/update/].
  Una caducidad en el token de Modo blindaje apagaría también Bloquear IP. Queda como «añadir el permiso y quitarlo
  después» en la opción (b), y como fecha de fin posterior al pitch en §16.
- **#7, «hora de corte, por ejemplo 01:00»**: no se aplica esa hora. Con las funciones (1) y (2) antes en el BACK
  (≈ 6 h 10 min desde las 19:15), B2 de esta acaba hacia las 04:00: un corte a la 01:00 la mataría sin haber empezado.
  Se fijan dos cortes que sí miden algo: dom 05:00 (B2 en verde o no se toca E21, E22 ni E10) y dom 09:30 (B6 pasado o
  E55 se desregistra y no va al pitch).
- **#1, P1 «añadir a B6 un incidente nacido de la ingesta real»**: entra solo con la víctima desplegada (§17.3 paso 7).
  Sin víctima, fabricarlo exige firmar lotes de ingesta a mano (`x-vg-sig`, `rutas/ingest.ts:34-36`) y dispararía el
  aviso real del despachador a los contactos de «Tienda Demo», que lleva otra persona.

Nota para el ORQUESTADOR (fuera de esta función): `evolucion-entre-revisiones.md` (`CR_REV_JUEVES`) y
`bloqueo-merge-criticos.md` (`CR_REV_PR_BLOQUEADO`) usaban el mismo id de fixture, `c4000000-0000-4000-8000-000000000013`.
Resuelto en la reconciliación del contrato (`RECONCILIACION-CONTRATO.md`): `CR_REV_JUEVES` = `…021` y
`CR_REV_PR_BLOQUEADO` = `…022`.
