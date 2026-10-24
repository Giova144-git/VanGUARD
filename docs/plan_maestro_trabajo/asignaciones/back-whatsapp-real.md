# WhatsApp real con Kapso: plantilla, encargo al BACK y decisiones

Investigación del ORQUESTADOR (sáb 24-oct, workflow con revisión adversarial). Decisiones de Giovanni y del ORQUESTADOR al final. Estado al cierre: Meta frenó el alta del número real (cuenta restringida y después rate limit 1675004), así que la demo va por el sandbox de la cuenta nueva de Kapso (`KAPSO_SANDBOX=1`) y el número real entra cuando Meta lo permita.

# ENCARGO_BACK

**Contexto**
- `KAPSO_PHONE_NUMBER_ID` pasa al número real.
- Fuera de la ventana de 24 h, cualquier mensaje que no sea una plantilla aprobada falla con **131047**. El fallo llega después del 200, como `whatsapp.message.failed` en `message.kapso.statuses[].errors[]` (https://docs.kapso.ai/docs/platform/webhooks/message-events.md).
- Meta avisa de que un error puede llegar en la respuesta síncrona, por webhook o por los dos (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes).

**Ya hecho (no tocar)**
- FRONT: «Verificar por WhatsApp» en Ajustes (b3f859c).
- Contrato: `Contact.verificacion` = `{codigo: /^[0-9A-F]{6}$/, enlace: https://wa.me/…}` (7a1b258; packages/contracts/src/api.ts:155-157).
- Script: `kapso-config.mjs --real`.
- `idBoton()` de `rutas/webhooks-kapso.ts:46` ya lee `interactive.button_reply.id` y también `button.payload`. No hay que confundirlo con el `idBoton()` de core, que arma los ids.

**Lo que falta, por prioridad**

| # | Qué | Archivos | Prioridad | Estimación |
|---|---|---|---|---|
| B1 | E26 devuelve `verificacion` | `rutas/contacts.ts`, `worker-configuration.d.ts` | P0 · sáb 12:00 | 30 min |
| B2 | Migración: última entrada y opt-in del contacto | `supabase/migrations/0008i_…sql` | P0 | 15 min |
| B3 | E31: `VERIFICAR <código>`, `BAJA` y registro de la última entrada | `rutas/webhooks-kapso.ts` (+ binding `RL_WA`: lo pone el ORQUESTADOR en `wrangler.jsonc`) | P0 | 1 h |
| B4 | `kapso.ts`: plantilla con quick replies y errores de saldo | `notify/kapso.ts` | P0 | 45 min |
| B5 | E27 no envía si la ventana está cerrada (salvo `KAPSO_SANDBOX=1`) | `rutas/notifications.ts`, `worker-configuration.d.ts` | P0 | 20 min |
| B6 | Despachador: interactivo con la ventana abierta; plantilla con la ventana cerrada | `engine/dispatch.ts` (nuevo), `core/templates/whatsapp.ts` | P0 tardío · sáb 19:00 o cuando esté APPROVED | 1 h |
| B7 | Códigos de fallo de entrega | `rutas/webhooks-kapso.ts`, `notify/kapso.ts` | P0 tardío | 30 min |
| B8 | Respaldo por `context.id` si el payload no vuelve | `rutas/webhooks-kapso.ts` | P1, solo si la prueba real lo pide | 30 min |
| B9 | `kapso-prueba.mjs --plantilla`; `kapso-config.mjs --real` sin `meta_app_id` | `apps/api/scripts/`, `scripts/` (este último es del ORQUESTADOR) | P0 | 20 min |

Total: P0 ≈ 3 h. Con el P0 tardío, ≈ 4,5 h.

**B1 · E26**
- Devuelve `verificacion` solo si se cumplen tres cosas: `whatsapp`, `verified_at` nulo y `env.KAPSO_DISPLAY_NUMBER` presente (`/^\d{8,15}$/`). Va en el GET y en la respuesta del PUT.
- `codigo` = los 6 primeros caracteres hex, en mayúsculas, de `HMAC-SHA256(keys.fpk, 'contact|' + id)`.
  - Usa un **kid fijo** (`getKeys(env, admin, 'v1')`, apps/api/src/lib/keyring.ts:9), no el activo, para que rotar `kek_active` no invalide los códigos ya mostrados.
  - Si el teléfono cambia, `vg_replace_contacts` borra la fila e inserta otra. Sale un id nuevo, y con él un código nuevo: es lo correcto.
- `enlace` = `https://wa.me/${KAPSO_DISPLAY_NUMBER}?text=` + `encodeURIComponent(texto)`, con un texto de 140 caracteres o menos.
  - El texto depende de la DUDA 3.
  - El límite sale del prellenado oficial (https://developers.facebook.com/documentation/business-messaging/whatsapp/qr-codes). Que `?text=` tenga ese mismo tope está [no verificado].
- Añadir `KAPSO_DISPLAY_NUMBER?: string` y `KAPSO_SANDBOX?: string` a `worker-configuration.d.ts`. El ORQUESTADOR pone los dos en `vars` de `wrangler.jsonc`.

**B2 · Migración `0008i`**
- Columnas nuevas en `contacts`:
  - `wa_last_inbound_at timestamptz`: última vez que ese teléfono nos escribió;
  - `optin_at timestamptz`: evidencia del consentimiento.
- `vg_replace_contacts` **no necesita cambios**: su upsert solo toca name, whatsapp, voice y priority (0005_incidents_alerts.sql:160-174), así que conserva las columnas nuevas igual que `verified_at`. Añadir un test que lo confirme.
- P1: `wa_bsuid text`. Kapso recomienda casar al usuario por su BSUID, porque el teléfono puede faltar si usa nombre de usuario (https://docs.kapso.ai/docs/whatsapp/business-scoped-user-ids.md).

**B3 · E31, en `procesarKapso` para `whatsapp.message.received`**
1. Con **cualquier** mensaje entrante: `update contacts set wa_last_inbound_at = now() where phone_e164 = '+' || dígitos(message.from ?? conversation.phone_number)`, en todas las orgs. La ventana es por usuario y número de VanGUARD, no por org.
2. Si trae `idBoton`, sigue el camino actual (`registrarBoton` y el canje del hito 5).
3. Si `message.type === 'text'`, se toma `body = message.text.body.slice(0, 300)` y:
   - **`/^\s*VERIFICAR\s+([0-9A-F]{6})\b/i`**
     - Candidatos: contactos con ese `phone_e164`, `whatsapp = true` y `verified_at is null`.
     - Se recalcula el código de cada uno y se compara con `igualesCt` (apps/api/src/lib/hmac.ts:5).
     - Si casa: `update … set verified_at = now(), optin_at = now() where id = $1 and phone_e164 = $2 and verified_at is null returning org_id`.
     - Respuesta (mensaje de servicio, dentro de los 1.000 gratis): «Listo: este WhatsApp recibirá alertas de seguridad de VanGUARD para "<org, ≤ 40 car., pasada por textoSeguro y sin URL>". Para dejar de recibirlas escribe BAJA.»
   - **El código no casa:** una respuesta genérica que no revela si ese teléfono existe en alguna org.
     - Tope con un binding nuevo `RL_WA` (`simple: {limit: 3, period: 60}`) y la clave `wa:<dígitos>`.
     - El binding de Workers solo admite periodos de 10 o 60 s y cuenta de forma aproximada por ubicación (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). Por eso el tope es por minuto, no por hora.
   - **`/^\s*(BAJA|STOP|SALIR)\b/i`:** `verified_at = null` en todas las filas con ese teléfono, y se confirma.
     - La política exige respetar cualquier baja (https://whatsappbusiness.com/policy/).
   - **Cualquier otro texto:** no se responde, porque cada respuesta gasta cupo.
4. **Sin `from`** (usuario con nombre de usuario): no se verifica y se registra `kapso.sin_telefono`. Kapso avisa de que `from` y `phone_number` pueden faltar (https://docs.kapso.ai/docs/platform/webhooks/message-events.md; https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids).
5. **Logs:** solo `enmascararTelefono`. Nunca el texto ni el código.
6. **Seguridad:** quien demuestra ser dueño del teléfono es el `from`, que autentica Meta. El código solo indica qué contacto se verifica.

**B4 · `kapso.ts`**
- Nuevos `MensajePlantilla` (que se suma a `MensajeKapso`), `cuerpoPlantilla(e164, { nombre, idioma: 'es', params, payloads })` y `enviarPlantilla`.
- El cuerpo tiene que salir exactamente así (https://docs.kapso.ai/docs/whatsapp/templates/buttons.md):
  ```json
  {"messaging_product":"whatsapp","to":"58414…","type":"template","template":{"name":"alerta_seguridad_v1","language":{"code":"es"},"components":[{"type":"body","parameters":[{"type":"text","text":"CRÍTICA"},{"type":"text","text":"Cloudflare"},{"type":"text","text":"<título>"},{"type":"text","text":"INC-A1F3C9"}]},{"type":"button","sub_type":"quick_reply","index":"0","parameters":[{"type":"payload","payload":"ack:A1F3C9:<nonce>"}]},{"type":"button","sub_type":"quick_reply","index":"1","parameters":[{"type":"payload","payload":"snz:A1F3C9:<nonce>"}]}]}}
  ```
- `name` viene de un argumento, no fijo, para admitir una `_v2`.
- `index` va como **string** y sigue el orden de los botones en la plantilla.
- **Saneado de los parámetros:** reutilizar `textoSeguro()` (core/templates/whatsapp.ts:33). Ya quita caracteres de control y saltos de línea, colapsa espacios y redacta. Añadir la eliminación de URL y {{3}} ≤ 80.
  - Desde v23, un parámetro mal formado da 132018 (https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management).
  - Las reglas exactas que aplica Meta están [no verificado].
- **Payloads:** el más largo mide unos 54 caracteres. Meta no documenta un máximo (https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components) [no verificado]. Se lanza error si pasa de 256.
- **`codigoMeta`:** que acepte también códigos de texto (`/^[a-z][a-z0-9_]{2,40}$/`), como `service_credits_exhausted` y otros `service_*`.
  - La forma del cuerpo de error de Kapso no está documentada [no verificado]: leer `error.code`, `code` y `error` cuando sea string.
  - `unsupported_currency` es un error al conectar la facturación, no al enviar (https://docs.kapso.ai/docs/whatsapp/meta-message-billing.md).
- **Respuesta 402:** detalle `saldo`, no `invalid`, y log de nivel error `kapso.sin_saldo`.
- **Opcional:** `estadoPlantilla(env, nombre)`, que hace `GET {KAPSO_BASE}/{KAPSO_WABA_ID}/message_templates?name=…&language=es` y devuelve `status` y `category` (https://docs.kapso.ai/api/meta/whatsapp/templates/list-message-templates.md).

**B5 · E27**
- Si `wa_last_inbound_at` es nulo o tiene más de 23 h 50 min, no se envía nada. Excepción: `env.KAPSO_SANDBOX === '1'`, porque en el sandbox no está garantizado que el código de unión llegue como `message.received` a nuestro webhook [no verificado].
- Responde 409 con `details.reason: 'window_closed'` (cambio aditivo) y el mensaje «Escribe cualquier mensaje a VanGUARD desde ese teléfono y vuelve a probar».
- Así se evita el `ok:true` falso seguido de un `failed 131047`.

**B6 · Despachador (`engine/dispatch.ts`, que ya estaba previsto)**
- **Destinatarios:** contactos con `whatsapp = true` y `verified_at` no nulo.
  - No se exige `optin_at`: los verificados a mano (7F.4) no lo tienen.
- **Ventana abierta** (`wa_last_inbound_at` de hace menos de 23 h 50 min, o `KAPSO_SANDBOX='1'`): el interactivo `incident_v1` de siempre, con `ack`, `snz` y `blk` si aplica. Es un mensaje de servicio y no cuesta.
- **Ventana cerrada:** la plantilla cuyo nombre esté en `app_config`.
  - Fila `key = 'kapso_plantilla_alerta'`, `value = '"alerta_seguridad_v1"'::jsonb` (o `_v2`); la tabla está en 0007_ai_config_perf.sql:16.
  - El ORQUESTADOR la escribe por SQL cuando vea APPROVED y UTILITY. Así el Worker no tiene que consultar el estado.
  - La fila de `notifications` se escribe con `template: 'incident_tpl_v1'`, que respeta el `unique (incident_id, channel, recipient_masked, template)` y el check `^[a-z0-9_]{3,40}$` (0005_incidents_alerts.sql:43-48).
  - Sin plantilla configurada: fila `failed` con `error: 'window_closed'`, sin llamar a Kapso; la alerta queda solo en la app.
- **Parámetros**, desde `core/templates/whatsapp.ts`:
  - {{1}} `severidadMayus(severity)`;
  - {{2}} `servicioDeReglas(rule_ids)`;
  - {{3}} `textoSeguro(incident.title, 80)` sin URL, nunca texto de la IA;
  - {{4}} `'INC-' + code`, el código de 6 caracteres en mayúsculas.
  - Nonces nuevos para `ack` y `snz`; se guarda su sha256, como hoy.
- **Tras un toque en la plantilla** (`ack` o `snz`): si el incidente admite `blk`, se manda un interactivo de seguimiento con «Bloquear IP».
  - Que el toque abra la ventana es una inferencia, porque llega como mensaje entrante [no verificado]. Hay que confirmarlo en la prueba.
  - E31 registra `wa_last_inbound_at` también con el toque.

**B7 · Códigos de fallo** (en el webhook `failed` y en la respuesta síncrona; fuente: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)

| Código | Qué hacer |
|---|---|
| `131047` (y `470` como alias de la API antigua; no figura en la página de Cloud API) | Un solo reintento con `incident_tpl_v1` si hay plantilla configurada; el `unique` evita bucles |
| `132000`, `132001`, `132005`, `132007`, `132012`, `132015`, `132016`, `132018` | Error de configuración o de plantilla: log de nivel error, sin reintento, la alerta queda en la app |
| `131026` | Destinatario no entregable |
| `131049` | No reintentar en 24 h |
| `131056` | Esperar antes de reenviar |
| `368`, `131031` | WABA restringida: log de nivel error `kapso.cuenta_restringida`, sin reintento, visible para el equipo |
| `133010` | Número no registrado (WABA en revisión): sin reintento, visible para el equipo |
| `131042`, `402`, `service_*` | `kapso.sin_saldo`, visible para el equipo |

**B8 · Respaldo por `context.id`** (P1)
- Cuándo hace falta:
  - la referencia de Meta describe `button.payload` como «Quick-reply button label text», y en su ejemplo vale lo mismo que el texto del botón (https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/button);
  - el webhook v2 de Kapso no documenta ni `type: 'button'` ni `message.context` (https://docs.kapso.ai/docs/platform/webhooks/message-events.md). Que Kapso pase `context.id` está [no verificado].
- Si el payload no casa con `BOTON`:
  - buscar la notificación con `notifications.provider_id = message.context.id`;
  - mapear `button.text`: «Lo estoy viendo» → `ack`, «Silenciar 1 h» → `snz`;
  - validar el `from` contra un contacto de esa org con el mismo `recipient_masked`.
- Así solo se permiten `ack` y `snz`, nunca `blk`, `ok` ni `no`.

**B9 · Scripts**
- `apps/api/scripts/kapso-prueba.mjs --plantilla[=nombre]`: manda la plantilla con datos ficticios a `KAPSO_TEST_TO`. Solo con el OK de Giovanni, porque cuesta 0,0113 incluso dentro de la ventana: una utility dentro de la ventana se cobra desde el 1-oct-2026 (https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing).
- `scripts/kapso-config.mjs --real` (lo hace el ORQUESTADOR): si ningún número del listado trae `meta_app_id` (está en el esquema, nullable, pero no en el ejemplo), hacer `GET /whatsapp/phone_numbers/{id}` por cada uno o aceptar `--id=<phone_number_id>` (https://docs.kapso.ai/api/platform/v1/phone-numbers/list-phone-numbers.md).
- Cambiar el mensaje final y el 7H para que el orden sea `--real` → subir al Worker → `--webhook`.

**Pruebas (vitest, sin red)**
- **`kapso.test.ts`**
  - forma exacta de `cuerpoPlantilla`, `index` como string y `name` como argumento;
  - saneado de `\n`, `\t`, 5 espacios seguidos y URL;
  - payload de más de 256 caracteres → lanza error;
  - `codigoMeta` con `service_credits_exhausted`, con `131047` y con el error como string;
  - 402 → detalle `saldo`.
- **`webhooks-kapso.test.ts`**
  - VERIFICAR con código y `from` correctos → `verified_at` y `optin_at`;
  - código correcto desde otro teléfono → nada;
  - código malo → una respuesta; la 4.ª en el mismo minuto, ninguna (doble de `RL_WA`);
  - `verificar 7c2a9f` en minúsculas → funciona;
  - BAJA, STOP y SALIR;
  - cualquier entrante actualiza `wa_last_inbound_at`;
  - `type: 'button'` con `button.payload` y `context.id`;
  - `failed 131047` → plan de reintento;
  - `failed 368` → `kapso.cuenta_restringida`;
  - sin `from` → solo log.
- **`contacts.test.ts`**
  - `verificacion` solo cuando toca;
  - el mismo código entre llamadas;
  - el kid fijo;
  - `vg_replace_contacts` conserva `wa_last_inbound_at` y `optin_at`.
- **`notifications.test.ts`**
  - ventana cerrada → 409 `window_closed` sin llamar a fetch;
  - `KAPSO_SANDBOX='1'` → envía.
- **Despachador**
  - ventana abierta → `incident_v1`;
  - cerrada y con plantilla configurada → `incident_tpl_v1` con el nombre leído de `app_config`;
  - cerrada sin plantilla → `failed`/`window_closed`;
  - repetido → `23505` y no se envía.
- **Prueba real** (1 teléfono, con OK de Giovanni):
  1. VERIFICAR desde Ajustes → la chapa pasa a «Verificado» en menos de 10 s.
  2. Interactivo → toque → aparece `kapso.boton` en el log.
  3. Con la plantilla APPROVED: `kapso-prueba.mjs --plantilla` dentro de la ventana → toque → comprobar en `webhook_events` que llega `type: 'button'` con el payload propio y si trae `context.id`.


---

## Plantilla `alerta_seguridad_v1` y costos (para Giovanni)

**7G.4 · Pedir la plantilla `alerta_seguridad_v1` (10 min, antes de las 11:00)**
Hace falta para avisar a quien no nos haya escrito en las últimas 24 h.
- Meta tarda **hasta 24 h** en revisarla, y más en cuentas nuevas [13][9].
- El sandbox no puede mandar plantillas [26].

Ruta: Kapso → **WhatsApp** → **Templates** → **Create template** [9].

| Campo | Valor exacto |
|---|---|
| Nombre | `alerta_seguridad_v1` |
| Categoría | **Utility** |
| Idioma | **Spanish** (`es`) [28] |
| Variables | Posicionales (`{{1}}`…) |
| Encabezado (texto) | `Alerta de seguridad de VanGUARD` (31 caracteres; máximo 60 [14]) |
| Cuerpo | El de abajo |
| Pie | `Recibes esto porque activaste las alertas` (41 caracteres; máximo 60 [14]) |
| Botones (Quick reply) | 1: `Lo estoy viendo` · 2: `Silenciar 1 h` |
| Validez del mensaje (TTL), si el panel la ofrece | 1 hora (3.600 s). Por defecto una utility vive 30 días; se puede poner entre 30 s y 12 h [29]. El nombre del campo en Kapso está [no verificado] |

Cuerpo, tal cual y con los saltos de línea:
```
Detectamos un incidente de seguridad de severidad {{1}} en {{2}}, un servicio que conectaste a tu cuenta de VanGUARD.

Qué pasó: {{3}}
Referencia: {{4}}

Revisa el detalle en tu panel de VanGUARD. Toca un botón para avisar que lo estás atendiendo o para pausar los avisos de este incidente durante 1 hora.
```

Meta exige un ejemplo por variable:
- {{1}} `CRÍTICA`
- {{2}} `Cloudflare`
- {{3}} `Escaneo de rutas de administración desde una misma IP`
- {{4}} `INC-A1F3C9`

**Por qué está escrita así**
- **Utility** («Account Alerts or Updates»): no es promocional y trata de un servicio del propio usuario [12].
- Si el contenido sonara a promoción o quedara poco claro, Meta la aprobaría como **Marketing**: desde el 9-abr-2025 ya no la rechaza [12]. A +58, Marketing cuesta 6,5 veces más [16].
- Va sin URL ni emojis para que se lea inequívoca, aunque Meta no los prohíbe en utility [12].
- Empieza y termina con texto fijo: una variable en el borde es motivo de rechazo [13].
- No muestra ningún código: un código de un solo uso solo se permite en plantillas de autenticación [12]. El nonce del botón viaja oculto, en el payload de cada envío [23].
- Los botones tienen 25 caracteres o menos, y el máximo es 10 respuestas rápidas [14].
- No puede repetir el mismo cuerpo y pie de otra plantilla; ojo con una futura v2 [13].
- Si el panel no te deja poner algo, escríbeme «crea la plantilla». La creo por la API de Kapso (`POST …/{KAPSO_WABA_ID}/message_templates`) leyendo el `.env`, sin mostrar la key [10]. Probaré a incluir `message_send_ttl_seconds: 3600`, y si Kapso lo rechaza lo quito [29][no verificado].

**Cómo saber que quedó aprobada**
- En Kapso → WhatsApp → Templates tiene que decir **APPROVED** con categoría **UTILITY** [9][11].
- Kapso no documenta un aviso por webhook del estado [9]. Míralo cada 15–30 min, o escríbeme «estado plantilla» y la consulto por API [11].
- **REJECTED:** mándame el motivo. En Kapso no se edita una plantilla ya enviada a revisión: «New version» crea `alerta_seguridad_v2` [9]. Dime el nombre nuevo.
- Aprobada pero como **MARKETING**: **no se usa**; avísame [12].
- Aprobada como UTILITY: avísame y activo su envío en el BACK.
- **Nunca la borres:** su nombre quedaría bloqueado 30 días [24].

**Costo con 2 USD**
Tarifa oficial de Meta para +58 («Rest of Latin America»), en USD por mensaje **entregado**, vigente desde el 1-oct-2026 y hasta al menos el 31-dic-2026 [15][16]:

| Mensaje | Precio | Cuántos caben en 2 USD |
|---|---|---|
| Lo que te escriben («VERIFICAR», «hola», botones) | 0 | Meta no lo cobra (sí cuenta para los 2.000 del plan Free) |
| Interactivo dentro de la ventana de 24 h (de servicio) | 0 los primeros 1.000 al mes por número; después 0,0113 | — |
| Plantilla utility fuera de la ventana | 0,0113 | ~176 |
| Plantilla utility **dentro** de la ventana (se cobra desde el 1-oct-2026) | 0,0113 | ~176 |
| Plantilla marketing (si Meta la recategoriza) | 0,0740 | ~27 |
| Cualquier mensaje entregado desde el **sandbox** | 0,0113 (sin los 1.000 gratis) | ~176 |

- Con la WABA en USD, Kapso no cobra margen [7].
- Conectar el número y crear la plantilla cuesta 0.
- Una demo con interactivos dentro de la ventana cuesta **0 USD**. Veinte alertas con plantilla costarían unos **0,23 USD**.

**Qué vigilar del saldo**
- Míralo antes de cada ensayo.
- Si llega a **0 o menos** y ya hay algún cargo de servicio liquidado, Kapso pausa los envíos que podrían cobrarse en **todos** los números de la WABA (`service_credits_exhausted`) [7].
  - Rechaza incluso los mensajes de servicio que habrían salido gratis.
  - Solo las reacciones siguen saliendo.
- Las plantillas pasan su propia comprobación de saldo, con un umbral no documentado [7][no verificado].
- El plan Free admite **2.000 mensajes al mes**, contando también los que te escriben [3][8].
- En cuanto funcione el número real, deja de ensayar con el sandbox: allí cada mensaje gasta.
- Cualquier recarga la decides tú.

**Domingo y respaldo**
- Cada teléfono que vaya a recibir alertas en el pitch escribe al número **el domingo temprano** y otra vez **30 min antes**. Cada mensaje renueva la ventana de 24 h [15].
- **Plan B:** el sandbox del mismo proyecto. Que el plan Free lo mantenga junto al número conectado no está documentado [3][26][no verificado]. Para cambiar:
  1. Pon su id en `KAPSO_PHONE_NUMBER_ID` y súbelo con el script.
  2. Une el teléfono (7A).
  3. Corre `--webhook`; si el webhook ya existe, no lo duplica.
  4. Avísame para poner `KAPSO_SANDBOX=1`, así el BACK no exige la ventana.
  - Cada mensaje del sandbox gasta 0,0113 [7].
- **No desconectes ni borres** el número real: el número gratis no se vuelve a dar. Además, Kapso lo libera si pasa 30 días sin mensajes de producción [2].
- Un portfolio nuevo puede escribir fuera de la ventana a 250 personas distintas en 24 h móviles [17]. Sobra para el hackatón.
- Meta exige el permiso del destinatario, que nombre al negocio [27], y que se respete cualquier baja, dentro o fuera de WhatsApp [30]. Por eso solo avisamos a contactos verificados y E31 atiende BAJA.
- Bloqueos y reportes bajan la calidad y pueden limitar los envíos [27].

## Decisiones tomadas
- Botones de la plantilla: 2 («Lo estoy viendo», «Silenciar 1 h»); «Bloquear IP» va como interactivo después del toque.
- Texto del enlace wa.me: «VERIFICAR <código>. Acepto recibir alertas de seguridad de VanGUARD en este WhatsApp. BAJA para salir» (opt-in de Meta: dice qué acepta y nombra al negocio).
- Código de verificación: HMAC con el org_id dentro (propuesta del BACK, mejor que la original).
- Saldo: 20 USD en la cuenta nueva; la demo dentro de la ventana de 24 h cuesta 0.

## Fuentes
**Fuentes**
- [1] https://docs.kapso.ai/docs/how-to/whatsapp/connect-whatsapp.md
- [2] https://docs.kapso.ai/docs/platform/phone-numbers/instant-setup.md
- [3] https://kapso.com/pricing (kapso.ai/pricing redirige con un 301)
- [4] https://docs.kapso.ai/docs/how-to/whatsapp/instant-setup-troubleshooting.md
- [5] https://docs.kapso.ai/api/platform/v1/phone-numbers/list-phone-numbers.md
- [6] https://docs.kapso.ai/docs/platform/webhooks/overview.md
- [7] https://docs.kapso.ai/docs/whatsapp/meta-message-billing.md
- [8] https://docs.kapso.ai/docs/whatsapp/pricing-faq.md
- [9] https://docs.kapso.ai/docs/whatsapp/templates/lifecycle.md
- [10] https://docs.kapso.ai/api/meta/whatsapp/templates/create-or-update-message-template.md
- [11] https://docs.kapso.ai/api/meta/whatsapp/templates/list-message-templates.md
- [12] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization
- [13] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review
- [14] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components
- [15] https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- [16] https://whatsappbusiness.com/wp-json/wab/v1/pricing?market=LATAM&currency=USD&category=Utility (también Marketing y Service; es la calculadora que enlaza business.whatsapp.com/products/platform-pricing)
- [17] https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits
- [18] https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names
- [19] https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
- [20] https://docs.kapso.ai/docs/how-to/whatsapp/bring-your-own-sim-troubleshooting.md
- [21] https://docs.kapso.ai/docs/how-to/whatsapp/coexistence-troubleshooting.md
- [22] https://docs.kapso.ai/docs/whatsapp/business-verification.md
- [23] https://docs.kapso.ai/docs/whatsapp/templates/buttons.md
- [24] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management
- [25] https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_review_update/
- [26] https://docs.kapso.ai/docs/how-to/whatsapp/use-sandbox-for-testing.md
- [27] https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in
- [28] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/supported-languages
- [29] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/time-to-live
- [30] https://whatsappbusiness.com/policy/
