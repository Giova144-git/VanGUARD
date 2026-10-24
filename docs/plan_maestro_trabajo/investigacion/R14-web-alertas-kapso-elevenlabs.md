# R14 — Alertas en tiempo real: Kapso (WhatsApp), ElevenLabs (voz) y canales de respaldo

Investigación web para el plan maestro, etapa 1 de 4. Fecha: sábado 24-oct-2026, madrugada (Caracas).
Alcance: API exactas, costos, límites, riesgos y plan B por canal, más el diseño del motor de notificaciones
(escalamiento, deduplicación, cooldown, confirmación y aprobación por botón con código de un solo uso).

Marcas: **[verificado: URL]** = lo leí hoy en esa página. **[no verificado]** = conocimiento previo o fuente de
terceros sin confirmar en la fuente oficial. Las cifras con fecha de terceros se indican como tales.

---

## 0. Resumen ejecutivo

1. **Kapso es un proxy de la WhatsApp Cloud API de Meta**: mismos cuerpos JSON que Meta, cambiando la base URL a
   `https://api.kapso.ai/meta/whatsapp/v24.0` y autenticando con `X-API-Key`. Lo que sepamos de Meta sirve tal cual.
2. **El sandbox de Kapso NO envía plantillas**, solo texto e interactivos al número que se unió con un código de 6
   caracteres. Para la demo basta: el teléfono del presentador se une al sandbox antes de empezar y recibe alertas
   interactivas con botones sin esperar a Meta.
3. **Las plantillas (para avisar fuera de la ventana de 24 h) las revisa Meta: "hasta 24 h", más en cuentas nuevas**.
   Hay que pedirlas YA con número de producción. Si no llegan, el sandbox cubre la demo.
4. **ElevenLabs tiene endpoint directo de llamada saliente** `POST /v1/convai/twilio/outbound-call` (o `/sip-trunk/`)
   que acepta `conversation_initiation_client_data.dynamic_variables`: ahí va el resumen del incidente.
5. **Llamar a +58 es posible vía Twilio** (Venezuela permite salientes; móvil 0,1739 USD/min), pero hay que
   **actualizar la cuenta Twilio** (la de prueba pone un mensaje "press any key" y limita destinos) y activar el país en
   *Voice Geographic Permissions*. Se recomienda probarlo hoy antes de las 10:00.
6. **Costo de la demo: menos de 40 USD en total**: ElevenLabs Starter (1 USD el primer mes, 75 min), recarga de Twilio
   de unos 20 USD, número de EE. UU. (~1,15 USD/mes) y Kapso Free (2.000 mensajes y 2 USD de crédito).
7. **Plan B de voz sin telefonía**: la misma conversación de ElevenLabs corre en el navegador (SDK JS con
   `dynamicVariables`), o una llamada Twilio con `<Say>` y TwiML inline (sin servidor ni ElevenLabs).
8. **Plan B de mensajería**: un bot de Telegram (gratis, botones inline con `callback_data` de hasta 64 bytes y webhook
   con secreto). Se monta en unos 30 min y no depende de Meta.
9. **Motor de alertas**: la regla decide y el modelo solo redacta. Se agrupa por huella (`org+regla+recurso`), con
   cooldown por severidad, escalamiento in-app → WhatsApp → llamada si nadie confirma, y **"leído" ≠ "confirmado"**.
10. **Aprobación de acciones por botón**: el botón lleva un nonce de un solo uso (128 bits, TTL 10 min) del que solo se
    guarda el hash. Se valida el teléfono emisor y la acción se ejecuta una sola vez (UPDATE atómico). La voz solo
    confirma y nunca aprueba acciones.

---

## 1. Kapso (WhatsApp Business API)

### 1.1 Planes y costos

| Plan | USD/mes | Mensajes/mes (entrantes + salientes) | Números | Notas |
|---|---|---|---|---|
| Free | 0 | 2.000 | 1 | Incluye 2 USD de crédito y número sandbox |
| Pro | 25 | 100.000 | 3 (+10 USD c/u) | 1.000 llamadas de integración/mes |
| Platform | 299 | 1.000.000 | 50 (+5 USD c/u) | |

[verificado: https://kapso.com/pricing] [verificado: https://docs.kapso.ai/docs/whatsapp/pricing-faq.md]
- Las tarifas de Meta van aparte del plan. Se pueden pagar con créditos de Kapso a costo, sin margen en cuentas en USD,
  o directo a Meta. Las confirmaciones de lectura no cuentan como mensajes [verificado: pricing-faq.md].
- **Cambio de Meta en vigor desde el 1-oct-2026**: los mensajes de servicio (no plantilla, dentro de la ventana de 24 h)
  vuelven a cobrarse, con 1.000 gratis por número y mes. Las plantillas *utility* enviadas dentro de la ventana dejan de
  ser gratis [verificado: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing].
- Los mensajes de servicio entregados desde el sandbox **gastan créditos del proyecto** y no la franquicia de 1.000. Si
  el saldo llega a ≤ 0 con un cargo ya liquidado, Kapso pausa los envíos con `service_credits_exhausted` y el endpoint
  puede responder `402` con código `service_*` [verificado: https://docs.kapso.ai/docs/whatsapp/meta-message-billing.md].
  **Hay que tener crédito positivo antes de la demo.**
- Tarifa de Meta para Venezuela (región "Rest of Latin America"): utility/authentication ≈ 0,01266 USD y marketing ≈
  0,08288 USD por mensaje entregado, según una tabla de terceros de julio de 2025 [no verificado; la tarifa oficial está
  en el CSV de Meta]. Para la demo el gasto es de céntimos.

### 1.2 Autenticación y bases URL

| Uso | Base URL | Auth |
|---|---|---|
| Proxy de Meta (enviar, plantillas) | `https://api.kapso.ai/meta/whatsapp/v24.0` | `X-API-Key: <KAPSO_API_KEY>` o `Authorization: Bearer <KAPSO_API_KEY>` |
| API de plataforma (webhooks, números) | `https://api.kapso.ai/platform/v1` | `X-API-Key` |

[verificado: https://docs.kapso.ai/api/introduction.md]. Solo HTTPS; los límites de tasa van por key y por plan, con
cifras en otra página que no leí [no verificado]. SDK TypeScript oficial: `@kapso/whatsapp-cloud-api`, con
`new WhatsAppClient({ baseUrl: 'https://api.kapso.ai/meta/whatsapp', kapsoApiKey })`
[verificado: https://docs.kapso.ai/docs/whatsapp/send-messages/buttons.md].

### 1.3 Enviar un mensaje interactivo con botones (válido en sandbox y dentro de la ventana de 24 h)

```http
POST https://api.kapso.ai/meta/whatsapp/v24.0/{PHONE_NUMBER_ID}/messages
X-API-Key: {KAPSO_API_KEY}
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "to": "584141234567",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "header": { "type": "text", "text": "ALERTA CRITICA · Supabase" },
    "body":   { "text": "CPU al 97 % durante 5 min en proyecto demo-shop. Posible ataque o consulta sin indice. Accion propuesta: activar modo Under Attack en Cloudflare." },
    "footer": { "text": "Incidente #A1F3C9 · expira en 10 min" },
    "action": {
      "buttons": [
        { "type": "reply", "reply": { "id": "ack:A1F3C9:Zx9...", "title": "Lo estoy viendo" } },
        { "type": "reply", "reply": { "id": "ok:A1F3C9:Qm2...",  "title": "Aprobar accion" } },
        { "type": "reply", "reply": { "id": "snz:A1F3C9:Lp0...", "title": "Silenciar 1 h" } }
      ]
    }
  }
}
```

- Forma del cuerpo (`type: interactive`, `interactive.type: button`, `action.buttons[].reply.{id,title}`)
  [verificado: https://docs.kapso.ai/docs/whatsapp/send-messages/buttons.md].
- Límites de Meta: **máximo 3 botones**, `body` ≤ 1024 caracteres, `id` ≤ 256 caracteres
  [verificado: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages].
  `title` ≤ 20 caracteres según la guía antigua de Meta [no verificado en la página nueva]. Los títulos de arriba
  caben ("Lo estoy viendo" tiene 15).
- `header` y `footer` son campos estándar de Meta para interactivos [no verificado en la página de Kapso]. Si dan
  error, se quitan y basta con `body`.
- Texto simple: el mismo endpoint con `{"messaging_product":"whatsapp","to":"...","type":"text","text":{"body":"..."}}`
  [no verificado en Kapso, formato estándar de Meta].
- Respuesta esperada (formato Meta): `{"messaging_product":"whatsapp","contacts":[{"input":"...","wa_id":"..."}],"messages":[{"id":"wamid..."}]}`
  [no verificado]. Se guarda `messages[0].id` para casar luego los eventos `delivered` y `read`.

### 1.4 Plantillas: crear, enviar y aprobación

**Crear** (va a revisión de Meta):

```http
POST https://api.kapso.ai/meta/whatsapp/v24.0/{WABA_ID}/message_templates
X-API-Key: {KAPSO_API_KEY}
Content-Type: application/json

{
  "name": "alerta_seguridad_v1",
  "category": "UTILITY",
  "language": "es",
  "parameter_format": "NAMED",
  "components": [
    { "type": "BODY",
      "text": "Alerta {{severidad}} en {{servicio}}: {{resumen}}. Responde con un boton.",
      "example": { "body_text_named_params": [
        { "param_name": "severidad", "example": "CRITICA" },
        { "param_name": "servicio",  "example": "Supabase" },
        { "param_name": "resumen",   "example": "CPU al 97 % durante 5 minutos" } ] } },
    { "type": "BUTTONS",
      "buttons": [
        { "type": "QUICK_REPLY", "text": "Lo estoy viendo" },
        { "type": "QUICK_REPLY", "text": "Ver acciones" } ] }
  ]
}
```

**Enviar** la plantilla con un payload distinto por botón en cada envío (ahí va el nonce):

```http
POST https://api.kapso.ai/meta/whatsapp/v24.0/{PHONE_NUMBER_ID}/messages
X-API-Key: {KAPSO_API_KEY}
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "to": "584141234567",
  "type": "template",
  "template": {
    "name": "alerta_seguridad_v1",
    "language": { "code": "es" },
    "components": [
      { "type": "body", "parameters": [
        { "type": "text", "parameter_name": "severidad", "text": "CRITICA" },
        { "type": "text", "parameter_name": "servicio",  "text": "Supabase" },
        { "type": "text", "parameter_name": "resumen",   "text": "CPU al 97 % durante 5 minutos" } ] },
      { "type": "button", "sub_type": "quick_reply", "index": "0",
        "parameters": [ { "type": "payload", "payload": "ack:A1F3C9:Zx9..." } ] },
      { "type": "button", "sub_type": "quick_reply", "index": "1",
        "parameters": [ { "type": "payload", "payload": "menu:A1F3C9:Qm2..." } ] }
    ]
  }
}
```

[verificado: https://docs.kapso.ai/docs/whatsapp/templates/buttons] (estructura con `parameter_format: NAMED`,
`body_text_named_params`, `sub_type: quick_reply`, `index` y `payload`). El ejemplo de la página usa `en_US`; el
código `es` es estándar de Meta [no verificado].

- **Patrón recomendado**: la plantilla solo "abre la puerta". Al pulsar "Ver acciones" el usuario abre la ventana de
  24 h y le mandamos un interactivo (1.3) con los botones de acción. Así la plantilla es genérica, se aprueba una vez
  y no hay que pedir otra por cada tipo de incidente.
- **Estados**: `PENDING`, `APPROVED`, `REJECTED`, `DISABLED`. "Reviews typically take up to 24 hours" y la primera
  aprobación en cuentas nuevas puede tardar más. Kapso no añade demora. Una causa típica de rechazo es la categoría
  equivocada (utility frente a marketing). Para sincronizar plantillas: `POST /whatsapp_templates/sync`
  [verificado: https://docs.kapso.ai/docs/whatsapp/templates/lifecycle.md].
- Twilio documenta que la mayoría se resuelve en minutos por revisión automática y que la revisión humana llega a
  48 h; el clasificador de categorías de Meta "no es determinista"
  [verificado: https://static0.twilio.com/docs/whatsapp/tutorial/message-template-approvals-statuses].
- Para que la aprobación salga rápido como UTILITY: sin lenguaje promocional, variables con ejemplo, texto ligado a
  una cuenta o servicio del usuario y nombre en snake_case [no verificado; práctica habitual].

### 1.5 Webhooks de Kapso (respuestas y estados)

**Alta** por panel (Integrations → Webhooks, o el número → Edit) o por API:

```http
POST https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/{PHONE_NUMBER_ID}/webhooks
X-API-Key: {KAPSO_API_KEY}
Content-Type: application/json

{ "whatsapp_webhook": {
    "kind": "kapso",
    "url": "https://<app>.vercel.app/api/webhooks/kapso",
    "events": ["whatsapp.message.received","whatsapp.message.delivered","whatsapp.message.read","whatsapp.message.failed"],
    "secret_key": "<32+ bytes aleatorios>" } }
```

[verificado: https://docs.kapso.ai/docs/platform/webhooks/overview.md]

- Eventos: `whatsapp.message.received`, `.sent`, `.delivered`, `.read`, `.failed`
  [verificado: https://docs.kapso.ai/docs/platform/webhooks/message-events.md].
- Cabeceras: `X-Webhook-Event` (nombre del evento), `X-Idempotency-Key` (se mantiene igual entre reintentos),
  `X-Webhook-Payload-Version: v2`, y con buffering también `X-Webhook-Batch: true` y `X-Batch-Size` [verificado:
  message-events.md y overview.md]. **Hay que desactivar el buffering** para no meter latencia en la respuesta al
  botón.
- Firma: `X-Webhook-Signature` = HMAC-SHA256 en hex del **cuerpo crudo** con el secreto, comparada en tiempo constante
  [verificado: https://docs.kapso.ai/docs/platform/webhooks/security.md].
- Entrega: hay que responder **200 en ≤ 10 s**. Reintenta a los 10 s y a los 40 s, con 3 intentos en total
  [verificado: overview.md]. Se procesa de forma asíncrona: se guarda, se responde 200 y luego se trabaja.
- Payload v2 de mensaje recibido: claves de primer nivel `message`, `conversation`, `is_new_conversation` y
  `phone_number_id`. `message` trae `id`, `timestamp` (string con epoch), `type`, `from` y `kapso{direction,status,...}`.
  En los interactivos llega `message.interactive.button_reply = { "id": "btn_1", "title": "Confirm" }` [verificado:
  message-events.md]. **Las respuestas a botones de plantilla** no aparecen documentadas en Kapso. En Meta llegan
  como `type: "button"` con `button: { payload, text }` [no verificado], así que el parser debe aceptar ambas formas.
- Un `failed` con código `131047` ("Re-engagement message") significa que la ventana de 24 h está cerrada y hay que
  enviar plantilla [verificado: message-events.md].

```ts
// Verificación portable (Next.js route handler o Supabase Edge Function / Deno): Web Crypto.
export async function verificarFirmaKapso(raw: string, firmaHex: string | null, secreto: string) {
  if (!firmaHex) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const esperado = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  if (esperado.length !== firmaHex.length) return false;
  let d = 0; for (let i = 0; i < esperado.length; i++) d |= esperado.charCodeAt(i) ^ firmaHex.charCodeAt(i);
  return d === 0;
}
// Extraer el payload del botón (interactivo o plantilla):
export function payloadBoton(m: any): string | null {
  return m?.interactive?.button_reply?.id ?? m?.button?.payload ?? null;
}
```

### 1.6 Sandbox de Kapso (la vía rápida para la demo)

- Pasos: WhatsApp → Sandbox → **Add Test Number** (teléfono que va a probar) → Create. Da un **código de 6
  caracteres** (distingue mayúsculas, caduca a los 15 min si no se usa), el número sandbox y un enlace. Se abre
  WhatsApp y se envía el código desde ese teléfono [verificado:
  https://docs.kapso.ai/docs/how-to/whatsapp/use-sandbox-for-testing.md].
- Permite **texto e interactivos**. **No permite plantillas** ni sincronizar desde WhatsApp. El campo `to` debe ser el
  número registrado en la sesión; si no, devuelve el error "Active sandbox session required to send messages"
  [verificado: misma URL].
- El número sandbox es compartido entre usuarios de Kapso, con sesiones aisladas. Si un número se activa en otro
  proyecto, la sesión anterior pasa a `superseded` [verificado: misma URL y pricing-faq.md].
- La página no aclara cuánto dura una sesión ni si aplica la ventana de 24 h [no verificado]. **Mitigación**: en el
  ensayo del sábado por la tarde y otra vez 30 min antes del pitch, el teléfono de la demo escribe al sandbox. Así la
  ventana queda abierta y los interactivos entran.

### 1.7 MCP de Kapso

- Servidor `https://api.kapso.ai/mcp`, transporte HTTP. Acepta login por navegador (por defecto **solo lectura**) o
  API key con `Authorization: Bearer` / `X-API-Key`, que da acceso completo al proyecto [verificado:
  https://docs.kapso.ai/docs/whatsapp/mcp.md].
- Herramientas: `whatsapp_messages` (listar, obtener, enviar, marcar leído), `whatsapp_templates` (listar, obtener,
  crear), `whatsapp_webhooks` (gestionar, probar, ver entregas), `whatsapp_numbers` (incluye *health*),
  `search_docs`, `status`, entre otras [verificado: misma URL].
- Uso recomendado: **solo para el equipo** (Claude Code configura plantillas y webhooks y prueba entregas:
  `claude mcp add --transport http kapso https://api.kapso.ai/mcp --header "Authorization: Bearer $KAPSO_API_KEY"`).
  El producto envía con REST directo, sin pasar por el modelo: la regla decide y el código envía.

### 1.8 Plan B de WhatsApp

| Opción | Plantillas | Destinatarios | Montaje | Nota |
|---|---|---|---|---|
| Sandbox Kapso (plan A de la demo) | No | 1 por sesión | 10 min | Interactivos sí |
| Número de prueba de Meta (Cloud API directa) | Solo las preaprobadas (`hello_world`) | Hasta 5 verificados | 30 min | El token temporal caduca; hay que crear un *system user* [verificado: https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started] |
| Sandbox de Twilio WhatsApp | 3 preconfiguradas | Cada uno envía "join <código>" | 20 min | La sesión expira a los 3 días; 1 mensaje cada 3 s [verificado: https://www.twilio.com/docs/whatsapp/sandbox] |
| Telegram (sección 3.1) | No aplica | Ilimitados | 30 min | No depende de Meta |

---

## 2. ElevenLabs Agents (llamada de voz)

### 2.1 Planes y costo por minuto

| Plan | USD/mes | Min. de llamada incluidos | Llamadas concurrentes |
|---|---|---|---|
| Free | 0 | 15 | 4 |
| Starter | 6 (1 el primer mes) | 75 | 6 |
| Creator | 22 (11 el primer mes) | 275 | 10 |
| Pro | 99 | 1.238 | 20 |
| Scale | 299 | 3.738 | 30 |
| Business | 990 | 12.375 | 40 |

[verificado: https://elevenlabs.io/pricing/agents]
- Minuto extra: **0,08 USD**. En ráfaga (hasta 3× la concurrencia) cuesta 0,16 USD/min. ElevenLabs no cobra
  telefonía: Twilio o el SIP trunk facturan aparte. El LLM del agente se cobra por uso y depende del modelo
  [verificado: misma URL].
- Si el plan Free permite usar telefonía saliente con número Twilio importado no está confirmado [no verificado].
  **Recomendación**: Starter (1 USD) para no descubrir un bloqueo de plan a mitad de la demo.
- Auth de toda la API: cabecera `xi-api-key: <ELEVENLABS_API_KEY>`. Se pueden crear keys con alcance por endpoint y
  límite de créditos [verificado: https://elevenlabs.io/docs/api-reference/authentication]. **Hay que usar una key
  limitada** a convai y TTS, con tope de créditos.

### 2.2 Telefonía: conectar Twilio y lanzar la llamada

**Conexión nativa con Twilio** (una vez, por panel): ElevenAgents → Phone Numbers → Label, número, **Twilio SID**
(Account SID o API Key SID `SK...`) y **Twilio Token** (Auth Token o API Key Secret). ElevenLabs configura el número
automáticamente. Un *Verified Caller ID* de Twilio sirve **solo para salientes** y no puede asignarse a un agente
para entrantes [verificado: https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration].
Al importar el número se obtiene su `agent_phone_number_id`, visible en el panel [no verificado el nombre exacto en
la UI].

**Llamada saliente (Twilio)**

```http
POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call
xi-api-key: {ELEVENLABS_API_KEY}
Content-Type: application/json

{
  "agent_id": "agent_xxx",
  "agent_phone_number_id": "phnum_xxx",
  "to_number": "+584141234567",
  "conversation_initiation_client_data": {
    "user_id": "org_42",
    "dynamic_variables": {
      "empresa": "Demo Shop",
      "incidente_id": "A1F3C9",
      "severidad": "critica",
      "servicio": "Supabase",
      "resumen": "La CPU de la base de datos lleva cinco minutos por encima del noventa y cinco por ciento.",
      "accion_propuesta": "activar el modo bajo ataque en Cloudflare",
      "secret__token_llamada": "<token HMAC de un solo uso>"
    }
  },
  "telephony_call_config": { "ringing_timeout_secs": 30 }
}
```

Respuesta 200: `{ "success": true, "message": "...", "conversation_id": "...", "callSid": "CA..." }`. Errores de
validación devuelven 422 con `detail[].{loc,msg,type}`
[verificado: https://elevenlabs.io/docs/eleven-agents/api-reference/integrations/twilio/outbound-call.md].
- Campos opcionales útiles: `call_recording_enabled` y `telephony_call_config.twilio_machine_detection` (detección de
  contestador; el veredicto llega por un webhook `answering_machine_detection` aparte y Twilio lo cobra) [verificado:
  misma URL]. Para la demo: **sin AMD** (menos latencia y menos piezas) y `ringing_timeout_secs: 30` para escalar al
  siguiente contacto si no contesta.
- `conversation_config_override.agent.first_message` y `.language` permiten fijar el saludo y el idioma por llamada
  [verificado: misma URL]. Hay que habilitar los overrides en la configuración de seguridad del agente [no verificado].
- Si la petición incluye `conversation_initiation_client_data`, **no** se dispara el *conversation initiation
  webhook*: hay que pasarlo todo en la propia llamada [verificado: búsqueda sobre
  https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/register-call].

**SIP trunk** (alternativa a Twilio con cualquier proveedor SIP): `POST https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call`.
Mismos campos obligatorios (`agent_id`, `agent_phone_number_id`, `to_number`) y mismo `conversation_initiation_client_data`.
Responde `sip_call_id` en lugar de `callSid`
[verificado: https://elevenlabs.io/docs/eleven-agents/api-reference/sip-trunk/outbound-call.md]. Para la hackatón
no compensa: configurar un trunk lleva más tiempo que Twilio.

**Batch calling** (avisar a varios contactos de guardia a la vez): `POST https://api.elevenlabs.io/v1/convai/batch-calling/submit`.
Campos obligatorios: `call_name`, `agent_id` y `recipients[]`. Opcionales: `agent_phone_number_id`,
`scheduled_time_unix`, `timezone`, `target_concurrency_limit`. También existen GET, cancel y retry del lote
[verificado: búsqueda sobre https://elevenlabs.io/docs/eleven-agents/api-reference/batch-calling/create]. El esquema
de cada `recipient` (teléfono y variables por destinatario) no lo pude leer [no verificado]. **No lo usamos en el MVP**:
el escalamiento es secuencial (contacto 1 → contacto 2), que se hace con llamadas sueltas.

### 2.3 Variables dinámicas y diseño del agente

- Sintaxis `{{nombre}}` en el prompt de sistema, el primer mensaje y los parámetros o cabeceras de herramientas.
  Distingue mayúsculas y los valores son **string, number o boolean** [verificado:
  https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables.md].
- Variables del sistema útiles: `system__conversation_id`, `system__called_number`, `system__call_sid` (solo Twilio),
  `system__call_duration_secs` y `system__time` [verificado: misma URL].
- `secret__*`: solo se usan en **cabeceras** de herramientas, nunca llegan al LLM y salen como `<REDACTED>` en la API
  de conversaciones [verificado: misma URL]. Ahí va el token con el que el agente llama a nuestro backend.
- Hay que definir un **placeholder** para cada variable. Si falta, en las pruebas del panel se lee literalmente
  `{{variable}}` [verificado: misma URL].

Agente propuesto (se crea a mano en el panel, idioma español y voz latinoamericana):

```text
first_message:
"Hola, te llamo de Centinela por una alerta {{severidad}} en {{servicio}} de {{empresa}}. ¿Tienes un minuto?"

system prompt (resumen):
Eres el asistente de guardia de Centinela. Informas de UN incidente y nada más.
Hechos (no inventes otros): {{resumen}}. Acción propuesta: {{accion_propuesta}}. Incidente {{incidente_id}}.
1) Explica el incidente en dos frases. 2) Pregunta si lo atiende ahora.
3) Si dice que sí, llama a la herramienta registrar_respuesta con respuesta="ack".
   Si pide que lo llamen luego, respuesta="snooze". Si pide aprobar la acción, NO la ejecutes:
   di que le llegó un botón de aprobación por WhatsApp y registra respuesta="pide_aprobar".
4) Despídete y termina la llamada. Máximo 90 segundos. No leas claves, IPs completas ni correos.

Herramienta servidor (webhook) "registrar_respuesta":
POST https://<app>/api/voz/respuesta
Headers: Authorization: Bearer {{secret__token_llamada}}
Body: { "incidente_id": "{{incidente_id}}", "respuesta": "<ack|snooze|pide_aprobar>", "conversation_id": "{{system__conversation_id}}" }
```

("Centinela" es un nombre de trabajo; se sustituye por el nombre final del producto.)

Limitar `max_duration_seconds` por override (`conversation_config_override.conversation.max_duration_seconds`)
[verificado: outbound-call.md] acota el costo: 90 s ≈ 0,12 USD de ElevenLabs más el minuto de Twilio.

### 2.4 Webhooks post-llamada

- Tipos: `post_call_transcription` (transcripción, `analysis` y `metadata`), `post_call_audio` (MP3 en base64) y
  `call_initiation_failure`, con `failure_reason` ∈ `busy`, `no-answer`, `unknown`. En Twilio, `failed` se convierte en
  `unknown`. **Si contesta un buzón no llega ningún failure**, porque la llamada sí se inició [verificado:
  https://elevenlabs.io/docs/agents-platform/workflows/post-call-webhooks].
- Campos útiles: `data.analysis.call_successful`, `data.analysis.transcript_summary`,
  `data.analysis.data_collection_results`, `data.metadata.call_duration_secs` y
  `data.conversation_initiation_client_data.dynamic_variables` (de ahí sale el `incidente_id`) [verificado: misma URL].
- Firma: cabecera `ElevenLabs-Signature: t=<timestamp>,v0=<hex>`, donde `hex` = HMAC-SHA256 de `"<timestamp>.<cuerpo>"`.
  Hay que validar el hash y la antigüedad del timestamp [verificado: búsqueda sobre
  https://elevenlabs.io/docs/eleven-api/resources/webhooks]. El SDK JS trae `constructEvent`. La ventana de tolerancia
  no está documentada: elegimos 30 min [decisión propia].
- Hay que responder 200. El webhook se desactiva solo tras ≥ 10 fallos seguidos más 7 días sin éxito. Se deduplica
  por `conversation_id` [verificado: post-call-webhooks].
- **Fuente de verdad del ack por voz**: la herramienta `registrar_respuesta`, que llega en tiempo real. El post-call
  sirve de respaldo y auditoría; si la herramienta falló, se lee `data_collection_results.respuesta`, configurado como
  *data collection* en el agente [no verificado el nombre del campo de configuración].

```ts
export async function verificarFirmaEleven(raw: string, cabecera: string | null, secreto: string, tolSeg = 1800) {
  if (!cabecera) return false;
  const p = Object.fromEntries(cabecera.split(',').map(s => s.split('=') as [string, string]));
  const t = Number(p.t); if (!t || Math.abs(Date.now() / 1000 - t) > tolSeg) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)));
  const hex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.length === (p.v0 ?? '').length && hex === p.v0; // en producción, comparar en tiempo constante (ver 1.5)
}
```

### 2.5 Latencia

- No encontré una cifra oficial de latencia por turno del producto Agents [no verificado]. El modelo Flash anuncia
  unos 75 ms de síntesis más la latencia de red y de aplicación [verificado: búsqueda sobre
  https://elevenlabs.io/blog/meet-flash].
- Referencia de terceros: unos 465 ms de punta a punta en web y más de 965 ms por telefonía, por la red telefónica
  [no verificado, benchmark de Vapi/AssemblyAI]. Lo que el público nota: **el tiempo desde la detección hasta que suena
  el teléfono** (API, Twilio y red celular venezolana), unos 5–15 s según experiencia previa [no verificado]. Hay que
  medirlo en el ensayo y contarlo en el pitch.

### 2.6 ¿Se puede llamar a +58 (Venezuela)?

- Twilio: Venezuela admite **salientes a números no Twilio**. El caller ID internacional sale en +E.164. No hay
  llamadas de emergencia y no figuran restricciones ni requisitos especiales [verificado:
  https://www.twilio.com/en-us/guidelines/ve/venezuela--voice-guidelines---twilio].
- Precio saliente de Twilio a Venezuela: **fijo 0,0682 USD/min, móvil 0,1739 USD/min**. Números internacionales desde
  1,15 USD/mes. No se compran números +58: se usa uno de EE. UU. [verificado: https://www.twilio.com/en-us/voice/pricing/ve].
- Permisos geográficos: los rangos de bajo riesgo están disponibles de entrada y basta activar el país en *Voice
  Geographic Permissions*. **Los de alto riesgo exigen cuenta actualizada** [verificado:
  https://support.twilio.com/hc/en-us/articles/223180228]. Si Venezuela es de alto riesgo [no verificado], la cuenta
  de prueba no llega.
- Cuenta de prueba de Twilio: solo llama a números verificados, reproduce un **mensaje de prueba que pide pulsar una
  tecla** antes del TwiML, corta a los 10 min y, según una tabla, solo permite salientes nacionales [verificado:
  búsqueda sobre support.twilio.com y twilio.com/docs/voice/make-calls; las fuentes no coinciden sobre lo
  internacional]. **Conclusión: actualizar la cuenta (recarga mínima de unos 20 USD [no verificado]) para quitar el
  mensaje y abrir +58.**
- ElevenLabs no publica una lista de países restringidos; el límite lo pone el proveedor de telefonía [no verificado: no
  encontré esa lista en la documentación revisada].
- Riesgo propio de Venezuela: entrega y calidad de llamadas internacionales a Movistar, Digitel o Movilnet
  [no verificado]. **Mitigación**: probar hoy con los tres operadores del equipo y tener un número no venezolano de
  respaldo (por ejemplo, un familiar o integrante con línea +1 o +57) para el día de la demo.

### 2.7 Plan B de voz (de más a menos parecido al plan A)

**B1 · Misma conversación en el navegador (sin telefonía)**: el SDK JS de ElevenLabs abre la sesión con
`dynamicVariables` (`Conversation.startSession({ agentId, dynamicVariables: {...} })`) [verificado: dynamic-variables.md
documenta `dynamicVariables` en JS]. En la demo, el panel "suena" en el portátil y la voz habla. No depende de Twilio
ni de los operadores venezolanos. Esfuerzo S.

**B2 · Llamada Twilio con TTS de Twilio y TwiML inline (sin servidor ni ElevenLabs)**:

```bash
curl -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Calls.json" \
  -u "$TWILIO_API_KEY:$TWILIO_API_SECRET" \
  --data-urlencode "To=+584141234567" --data-urlencode "From=+1XXXXXXXXXX" \
  --data-urlencode 'Twiml=<Response><Say voice="Polly.Lupe-Neural" language="es-US">Alerta critica en Supabase de Demo Shop. La CPU lleva cinco minutos por encima del noventa y cinco por ciento. Revisa WhatsApp para aprobar la accion.</Say><Gather numDigits="1" action="https://<app>/api/voz/dtmf?i=A1F3C9" timeout="8"><Say voice="Polly.Lupe-Neural" language="es-US">Pulsa uno si lo estas atendiendo.</Say></Gather></Response>' \
  --data-urlencode "StatusCallback=https://<app>/api/voz/estado" \
  --data-urlencode "StatusCallbackEvent=answered" --data-urlencode "StatusCallbackEvent=completed" \
  --data-urlencode "Timeout=30"
```

- `Twiml` admite como **máximo 4.000 caracteres**. Si se pasan `Twiml` y `Url`, se ignora `Twiml`. `StatusCallbackEvent`
  ∈ `initiated`, `ringing`, `answered`, `completed`. `Timeout` va por defecto a 60 s con máximo 600. La auth del
  ejemplo oficial usa API Key y Secret [verificado: https://www.twilio.com/docs/voice/api/call-resource]. Con
  `AccountSid:AuthToken` también funciona [no verificado en esa página].
- Voces en español: `Polly.Lupe-Neural` y `Polly.Pedro-Neural` (es-US), `Google.es-US-Neural2-A/B/C`,
  `Polly.Mia-Neural` (es-MX) y otras [verificado: https://www.twilio.com/docs/voice/twiml/say/text-speech].
- `<Gather>` con DTMF ("pulsa 1") da un **ack por teclado** sin LLM [no verificado en esta sesión; verbo estándar de
  TwiML]. Esfuerzo S.

**B3 · Voz de ElevenLabs pregrabada y llamada Twilio**: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128`
con `{"text": "...", "model_id": "eleven_multilingual_v2"}` y `xi-api-key`. Devuelve el audio binario
[verificado: https://elevenlabs.io/docs/api-reference/text-to-speech/convert]. Se sube a Supabase Storage con URL
firmada y se reproduce con `<Play>` en el TwiML. La voz es de ElevenLabs aunque la llamada no sea conversacional.
Esfuerzo S/M.

**B4 · Video de respaldo** grabado el sábado por la noche con la llamada real (decisión previa del equipo).

---

## 3. Canales de respaldo baratos

| Canal | Costo | Montaje | Botones / ack | Depende de | Uso propuesto |
|---|---|---|---|---|---|
| In-app (Supabase Realtime) | 0 | S (1 h) | Sí (UI propia) | Nuestra app abierta | Siempre, en t0 |
| Telegram bot | 0 | S (30–45 min) | Sí (`callback_data`) | Que el usuario vincule el chat | Respaldo de WhatsApp |
| Email (Resend) | 0 hasta 3.000/mes | S (20 min) | Enlace a la app | Dominio verificado | Resúmenes y auditoría |
| Slack (incoming webhook) | 0 | S (15 min) | No sin app interactiva | Workspace del cliente | Canal del equipo |
| Web push (VAPID) | 0 | M (2–3 h) | Acciones de notificación | Permiso del navegador; PWA en iOS | Después del MVP |

### 3.1 Telegram (plan B de WhatsApp)

```http
POST https://api.telegram.org/bot{TELEGRAM_TOKEN}/setWebhook
Content-Type: application/json

{ "url": "https://<app>/api/webhooks/telegram",
  "secret_token": "<1-256 chars [A-Za-z0-9_-]>",
  "allowed_updates": ["message", "callback_query"] }
```

```http
POST https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage
Content-Type: application/json

{ "chat_id": 123456789,
  "text": "<b>ALERTA CRITICA · Supabase</b>\nCPU al 97 % durante 5 min (demo-shop).\nAcción propuesta: modo Under Attack.",
  "parse_mode": "HTML",
  "reply_markup": { "inline_keyboard": [
    [ { "text": "Lo estoy viendo", "callback_data": "ack:A1F3C9:Zx9kQm2Lp0Ab7Yt4" } ],
    [ { "text": "Aprobar acción",  "callback_data": "ok:A1F3C9:Qm2Lp0Ab7Yt4Zx9k" },
      { "text": "Silenciar 1 h",   "callback_data": "snz:A1F3C9:Lp0Ab7Yt4Zx9kQm2" } ] ] } }
```

- La URL tiene la forma `https://api.telegram.org/bot<token>/METHOD_NAME` y admite JSON. Con `secret_token`, cada
  update trae la cabecera `X-Telegram-Bot-Api-Secret-Token`. `text` va de 1 a 4.096 caracteres. **`callback_data` va de
  1 a 64 bytes**. El `CallbackQuery` trae `id`, `from`, `message` y `data`, y **hay que llamar siempre a
  `answerCallbackQuery`** (`callback_query_id`, `text` de 0 a 200 caracteres, `show_alert`) o el cliente se queda con
  la barra de progreso [verificado: https://core.telegram.org/bots/api].
- Por el límite de 64 bytes, en Telegram el nonce es de **12 bytes en base64url (16 caracteres)** y el código del
  incidente tiene 6 caracteres: `ok:A1F3C9:<16>` ocupa 26 bytes.
- Vinculación del chat: deep link `https://t.me/<bot>?start=<codigo_vinculo>`. El bot recibe `/start <codigo>`, casa
  el código (TTL de 15 min) con el contacto y guarda `chat_id` [no verificado en esta sesión; mecanismo estándar de
  Telegram]. Límites de envío: unos 30 msg/s global y 1 msg/s por chat [no verificado].
- Tras el clic, `editMessageText` quita los botones y escribe "Confirmado por X a las 10:42" [no verificado el
  detalle de parámetros].

### 3.2 Email con Resend

```http
POST https://api.resend.com/emails
Authorization: Bearer {RESEND_API_KEY}
Content-Type: application/json
Idempotency-Key: notif-<notificacion_id>

{ "from": "Alertas <alertas@<dominio-verificado>>", "to": ["dueno@empresa.com"],
  "subject": "[CRITICA] Supabase · CPU 97 % · incidente A1F3C9",
  "html": "<p>...</p><p><a href=\"https://<app>/incidentes/A1F3C9\">Ver y aprobar en el panel</a></p>" }
```

Respuesta: `{ "id": "49a3999c-..." }`. `Idempotency-Key` dura 24 h y admite hasta 256 caracteres [verificado:
https://resend.com/docs/api-reference/emails/send-email]. Plan Free: **100 correos/día y 3.000/mes, 2 peticiones/s**
[verificado: búsqueda sobre https://resend.com/docs/knowledge-base/account-quotas-and-limits]. Sin dominio verificado,
`onboarding@resend.dev` solo entrega a la dirección de la propia cuenta (403 en otro caso) [no verificado, fuentes de
terceros]. **El email nunca lleva botones de aprobación**: solo un enlace a la app, que exige sesión.

### 3.3 Slack (incoming webhook)

`POST https://hooks.slack.com/services/T.../B.../XXX` con `{"text": "...", "blocks": [...]}`. Responde 200 con el
cuerpo `ok`. Errores: `invalid_payload`, `no_service`, `channel_not_found`, `action_prohibited`, etc. No se puede
cambiar el canal ni el icono, y no devuelve `ts` [verificado:
https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks]. Los botones interactivos requieren una app
de Slack con *interactivity* [no verificado]. **La URL es un secreto del cliente**: se guarda cifrada como las demás
keys (sobre AES-256-GCM, ver la corrección del orquestador).

### 3.4 Web push (después del MVP)

`npm install web-push` → `webpush.generateVAPIDKeys()` una vez → `setVapidDetails(subject, publicKey, privateKey)` →
`sendNotification(subscription, payload, { TTL, urgency: 'high' })` (`urgency` ∈ `very-low`, `low`, `normal`, `high`).
Los errores exponen `statusCode` [verificado: https://github.com/web-push-libs/web-push]. Con 404 o 410 se borra la
suscripción [no verificado]. En iOS solo funciona como PWA instalada [no verificado]. No compensa en 36 h.

### 3.5 In-app (el primer escalón, siempre)

Supabase Realtime sobre la tabla `incidentes`:
`supabase.channel('inc').on('postgres_changes', { event: '*', schema: 'public', table: 'incidentes', filter: 'org_id=eq.<org>' }, cb).subscribe()`
[no verificado en esta sesión; API habitual de supabase-js v2]. Realtime respeta RLS, así que la política de SELECT
por organización basta. En la UI: banner rojo, sonido, contador y botones grandes "Lo estoy viendo / Aprobar /
Silenciar", los mismos que en WhatsApp y con el mismo endpoint.

---

## 4. Diseño del motor de notificaciones

### 4.1 Principios

1. **La regla decide; el modelo redacta.** La severidad sale del motor de reglas (decisión de anoche). Claude solo
   puede reescribir `resumen` a partir de los hechos en JSON, en ≤ 300 caracteres y sin datos sensibles. Si falla o
   tarda más de 3 s, se usa la plantilla determinista. Nunca se espera al modelo para avisar.
2. **Cada envío es una fila** (`notificaciones`) con clave única: reintentar no duplica.
3. **Leído ≠ confirmado.** `whatsapp.message.read` solo pinta "visto 10:42" en la UI. El escalamiento se detiene
   únicamente con un **ack explícito** (botón, clic en la app, herramienta de voz o DTMF).
4. **Topes anti-abuso**: un atacante que conozca el producto puede provocar alertas para gastar nuestro crédito o
   acosar al dueño. Por eso hay techos por organización.

### 4.2 Escalamiento por severidad

| Severidad | t0 | Sin ack a los… | Luego | Horario |
|---|---|---|---|---|
| crítica | in-app + WhatsApp (interactivo o plantilla) + Telegram si está vinculado | 3 min (**demo: 45 s**) → llamada al contacto 1 | +2 min → llamada al contacto 2; +5 min → WhatsApp a todos con "nadie confirmó" | 24/7 |
| alta | in-app + WhatsApp | 15 min → llamada al contacto 1 | +15 min → WhatsApp al contacto 2 | Llamada solo de 07:00 a 22:00 locales |
| media | in-app | — | Resumen por email cada hora | — |
| baja | in-app | — | Resumen diario | — |

Conmutación por fallo de canal: un `whatsapp.message.failed`, o ningún `delivered` en 60 s, dispara Telegram y email.
Un `failed` con `131047` cambia a plantilla (o a Telegram si aún no está aprobada). Una llamada con `busy` o
`no-answer` pasa al siguiente contacto tras 60 s, con un máximo de 2 intentos por contacto y 3 llamadas por incidente.

### 4.3 Deduplicación, agrupación y cooldown

- **Huella** = `sha256(org_id | regla_id | recurso_normalizado)`. Ejemplos de `recurso`: `supabase:<ref>:cpu`,
  `supabase:<ref>:rls:public.pedidos`, `cloudflare:<zona>:ip:203.0.113.0/24`, `github:<repo>:dep:lodash@4.17.20`.
- Hay **un incidente abierto por huella** (índice único parcial). Si el evento se repite, se suma a `ocurrencias` y
  se actualiza `ultima_vez`, sin notificar de nuevo. **Solo se renotifica si sube la severidad** (alta → crítica).
- **Cooldown** tras resolver o silenciar: si la misma huella reaparece antes de 10 min (crítica), 30 min (alta) o
  2 h (media), se reabre el mismo incidente y se avisa solo in-app más un texto por WhatsApp, sin llamada, salvo que
  suba la severidad. Más de 3 reaperturas en 1 h la marcan como "inestable" y se agrupa.
- **Tormenta**: más de 5 incidentes nuevos de la misma organización en 2 min generan un solo mensaje ("7 alertas
  nuevas: 3 de Cloudflare, 4 de Supabase") y una sola llamada.
- **Techos por organización**: 2 llamadas/hora, 10 WhatsApp/hora y 20 correos/hora. Al superarlos se pasa a resumen
  y se marca en la UI.
- **Webhooks entrantes**: se deduplican por `X-Idempotency-Key` (Kapso), `conversation_id` (ElevenLabs) y
  `update_id` (Telegram) en la tabla `webhook_eventos`.

### 4.4 Aprobación de acciones por botón con código de un solo uso

Alcance de las "acciones" (coherente con "MCP en solo lectura, sin service_role"): en el MVP, los botones solo hacen
**ack, silenciar y enviar el prompt de corrección** (sin escritura en la infraestructura del cliente). La **mitigación
real** (p. ej. bloquear un rango IP o activar *Under Attack* en Cloudflare) solo se ofrece si el usuario cargó a
propósito un token *opcional* con ese permiso de escritura. Es una decisión del plan y la define la investigación de
Cloudflare.

Flujo:
1. Al notificar, por cada botón se genera `nonce = base64url(random(16))` (12 bytes en Telegram) y se guarda
   **solo** `sha256(nonce)` en `aprobaciones` con `incidente_id`, `accion`, `canal`, `destinatario` y `expira_en =
   now() + 10 min`.
2. El botón lleva `"<accion>:<codigo_incidente>:<nonce>"` (como `reply.id` en interactivo, `payload` en plantilla o
   `callback_data` en Telegram).
3. Llega el webhook: se verifica la firma, se deduplica el evento y se busca el hash. **El `from` del mensaje debe
   coincidir con `destinatario`**, para que un mensaje reenviado o un número ajeno no apruebe nada.
4. El canje es atómico y de un solo uso:
   `UPDATE aprobaciones SET usado_en = now() WHERE nonce_hash = $1 AND usado_en IS NULL AND expira_en > now() RETURNING *`.
   Si devuelve 0 filas, se responde "Código vencido o ya usado. Abre el panel".
5. Si la acción escribe en la infraestructura, hay **doble paso**: se responde con un interactivo nuevo ("¿Bloquear
   203.0.113.0/24 durante 1 h?" → "Sí, ejecutar" / "Cancelar") que lleva otro nonce. Se ejecuta con una clave de
   idempotencia `aprobacion_id`, se responde el resultado y se registra en auditoría.
6. **La voz nunca aprueba**: no se puede verificar quién contesta el teléfono. El agente solo registra `ack`,
   `snooze` o `pide_aprobar`, y en este último caso el backend reenvía el botón por WhatsApp.

```ts
const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function nuevoNonce(bytes = 16) { return b64url(crypto.getRandomValues(new Uint8Array(bytes))); }
export async function hashNonce(n: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(n)));
}
export function parsearBoton(p: string) {
  const m = /^(ack|ok|snz|menu|si|no):([A-Z0-9]{6}):([A-Za-z0-9_-]{16,43})$/.exec(p);
  return m ? { accion: m[1], codigo: m[2], nonce: m[3] } : null;
}
```

### 4.5 Esquema SQL (Supabase, proyecto propio del producto)

```sql
create type severidad as enum ('baja','media','alta','critica');          -- orden = gravedad
create type estado_incidente as enum ('abierto','confirmado','silenciado','resuelto');
create type canal as enum ('inapp','whatsapp','llamada','telegram','email','slack');

create table contactos_alerta (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  nombre text not null,
  telefono_e164 text check (telefono_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  telegram_chat_id bigint,
  email text,
  orden int not null default 1,
  canales canal[] not null default '{inapp,whatsapp,llamada}',
  zona_horaria text not null default 'America/Caracas',
  verificado_en timestamptz,               -- se verifica con un OTP por WhatsApp antes de llamar
  creado_en timestamptz not null default now()
);

create table incidentes (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 6)),
  org_id uuid not null,
  regla_id text not null,
  huella text not null,
  recurso text not null,
  severidad severidad not null,
  estado estado_incidente not null default 'abierto',
  titulo text not null,
  resumen text not null,
  accion_propuesta text,
  datos jsonb not null default '{}',       -- métricas; NUNCA secretos ni PII
  ocurrencias int not null default 1,
  reaperturas int not null default 0,
  primera_vez timestamptz not null default now(),
  ultima_vez timestamptz not null default now(),
  nivel_escalamiento int not null default 0,
  proximo_escalamiento timestamptz,
  confirmado_por uuid references contactos_alerta(id),
  confirmado_en timestamptz,
  silenciado_hasta timestamptz,
  resuelto_en timestamptz
);
create unique index incidentes_huella_activa on incidentes (org_id, huella)
  where estado in ('abierto','confirmado','silenciado');
create index incidentes_pendientes on incidentes (proximo_escalamiento) where estado = 'abierto';

create table notificaciones (
  id bigint generated always as identity primary key,
  incidente_id uuid not null references incidentes(id) on delete cascade,
  contacto_id uuid references contactos_alerta(id),
  canal canal not null,
  nivel int not null,
  estado text not null default 'pendiente',  -- pendiente|enviado|entregado|leido|fallido|contestada|no_contesta
  proveedor_id text,                         -- wamid | conversation_id | callSid | message_id
  error text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique nulls not distinct (incidente_id, contacto_id, canal, nivel)
);
create index on notificaciones (proveedor_id);

create table aprobaciones (
  id uuid primary key default gen_random_uuid(),
  incidente_id uuid not null references incidentes(id) on delete cascade,
  accion text not null,                      -- ack | snooze_1h | enviar_prompt | cf_bloquear_ip ...
  canal canal not null,
  destinatario text not null,                -- E.164 sin '+' (como llega en "from") o chat_id
  nonce_hash bytea not null unique,
  expira_en timestamptz not null default now() + interval '10 minutes',
  usado_en timestamptz,
  resultado jsonb
);

create table webhook_eventos (
  proveedor text not null, clave text not null,
  recibido_en timestamptz not null default now(),
  primary key (proveedor, clave)
);

alter table contactos_alerta enable row level security;
alter table incidentes      enable row level security;
alter table notificaciones  enable row level security;
alter table aprobaciones    enable row level security;   -- sin políticas: solo el backend
alter table webhook_eventos enable row level security;   -- sin políticas: solo el backend
-- SELECT para miembros de la organización (la función es_miembro() la define el esquema general):
create policy inc_select on incidentes for select using (es_miembro(org_id));
```

`unique nulls not distinct` exige Postgres 15 o superior [no verificado para la versión del proyecto; si falla se
usa `coalesce` en un índice de expresión]. Upsert de incidente (en una sola sentencia, sin carreras):

```sql
insert into incidentes (org_id, regla_id, huella, recurso, severidad, titulo, resumen, accion_propuesta, datos, proximo_escalamiento)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
on conflict (org_id, huella) where estado in ('abierto','confirmado','silenciado')
do update set ultima_vez = now(),
              ocurrencias = incidentes.ocurrencias + 1,
              datos = excluded.datos,
              severidad = greatest(incidentes.severidad, excluded.severidad),
              proximo_escalamiento = case when excluded.severidad > incidentes.severidad
                                          then now() else incidentes.proximo_escalamiento end
returning id, codigo, severidad, (xmax = 0) as es_nuevo;
```

**Tick de escalamiento**: Supabase Cron admite intervalos de segundos (`'30 seconds'`, pg_cron ≥ 1.5) y con `pg_net`
hace un POST a una función o endpoint [verificado: https://supabase.com/docs/guides/database/extensions/pgcron y
https://supabase.com/docs/guides/cron/quickstart.md]. Vercel Hobby no sirve para esto: su cron no baja de diario
[no verificado].

```sql
select cron.schedule('alertas-tick', '15 seconds', $$
  select net.http_post(
    url := 'https://<app>/api/alertas/tick',
    headers := jsonb_build_object('Authorization', 'Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'tick_secret')),
    body := '{}'::jsonb) $$);
```

El endpoint toma un lote con
`select ... from incidentes where estado = 'abierto' and proximo_escalamiento <= now() order by severidad desc limit 20 for update skip locked`
(dentro de una función RPC transaccional), ejecuta el siguiente nivel de la tabla 4.2, inserta en `notificaciones`
(un conflicto equivale a envío ya hecho) y fija `nivel_escalamiento + 1` y el nuevo `proximo_escalamiento`. El ack
pone `estado = 'confirmado'` y `proximo_escalamiento = null`, y notifica a los demás contactos ("X lo está
atendiendo").

### 4.6 Contenido: qué viaja por cada canal

| Dato | WhatsApp / Telegram | Voz (ElevenLabs) | Email |
|---|---|---|---|
| Servicio, severidad, métrica y umbral | Sí | Sí (en palabras) | Sí |
| IP atacante | Prefijo /24 | No | Completa (detrás de login, en la app) |
| Nombre de tabla o función | Sí | No | Sí |
| Keys, tokens, filas de datos, correos de usuarios | **Nunca** | **Nunca** | **Nunca** |

Guion de voz: números en palabras ("noventa y cinco por ciento"), menos de 40 palabras antes de la primera pregunta
y sin siglas raras (decir "la base de datos" en vez de "PG").

---

## 5. Checklist de cuentas, en orden (HOY, antes de las 10:00)

1. **Kapso**: cuenta Free → proyecto → API key → Sandbox → Add Test Number (teléfono de la demo) → enviar el código →
   webhook `kind: kapso` sin buffering hacia `/api/webhooks/kapso` → guardar el secreto. Comprobar que el crédito es
   positivo (servicio cobrado desde el 1-oct-2026).
2. **Kapso producción (en paralelo, sin bloquear)**: conectar un número que no tenga WhatsApp activo → crear
   `alerta_seguridad_v1` (UTILITY, es, NAMED, 2 quick replies) → seguir el estado. Si a las 18:00 no está APPROVED,
   la demo va por sandbox.
3. **Twilio**: cuenta → **actualizar** (recarga) → comprar un número de EE. UU. con Voice → Voice Geographic
   Permissions: activar Venezuela → crear API Key `SK...` y su Secret.
4. **ElevenLabs**: Starter → key limitada (convai más TTS, con tope de créditos) → crear el agente en español con
   primer mensaje, prompt, placeholders de las 7 variables, herramienta `registrar_respuesta` y duración máxima de 90 s
   → Phone Numbers: importar el número Twilio → webhook post-call (transcripción y failure) con secreto.
5. **Prueba de humo**: `curl` a `/v1/convai/twilio/outbound-call` hacia un móvil de cada operador (Movistar, Digitel,
   Movilnet) y medir el tiempo hasta que suena.
6. **Telegram**: @BotFather → token → `setWebhook` con `secret_token`.
7. **Resend**: key y, si hay dominio, verificarlo. Si no, solo envía a la dirección propia.

Variables de entorno (servidor, nunca en el cliente): `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_WABA_ID`,
`KAPSO_WEBHOOK_SECRET`, `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`,
`ELEVENLABS_WEBHOOK_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_FROM`,
`TELEGRAM_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `ALERTAS_TICK_SECRET`.

---

## Implicaciones para el plan

**Adoptar**
- Kapso por REST (proxy de Meta) con el SDK `@kapso/whatsapp-cloud-api` o `fetch`. **Demo por sandbox con mensajes
  interactivos**, y la plantilla UTILITY genérica pedida hoy como mejora, no como dependencia.
- ElevenLabs `POST /v1/convai/twilio/outbound-call` con `dynamic_variables` y `secret__token_llamada`. Agente en
  español de 90 s cuya única salida es la herramienta `registrar_respuesta` (ack, snooze o pide_aprobar).
- Twilio actualizado, con número de EE. UU. y Venezuela activado. Twilio `<Say>` con TwiML inline como plan B de voz.
- Motor propio en Supabase: tablas `incidentes`, `notificaciones`, `aprobaciones` y `webhook_eventos`, huella con
  índice único parcial, tick con Supabase Cron cada 15 s y escalamiento in-app → WhatsApp → llamada.
- Aprobación por botón con nonce de un solo uso (solo se guarda el hash), verificación de `from`, canje atómico y
  doble paso para acciones que escriben.
- Telegram como plan B de mensajería, con los mismos botones y el mismo endpoint de canje.
- Verificación HMAC de todos los webhooks (Kapso en hex sobre el cuerpo crudo; ElevenLabs `t=…,v0=…`; Telegram por
  cabecera secreta) y respuesta 200 inmediata con proceso asíncrono.

**Evitar**
- Depender de la aprobación de Meta para la demo, o de la cuenta de prueba de Twilio (mensaje "press any key" y
  posible bloqueo de +58).
- Que el LLM decida si se avisa o que la voz apruebe acciones.
- Usar "leído" como confirmación.
- Batch calling, SIP trunk, detección de contestador y web push en las 36 h.
- Meter IPs completas, nombres de usuarios o cualquier secreto en WhatsApp o en la voz (ElevenLabs retiene datos
  2 años por defecto, según el trabajo previo).
- Exponer el MCP de Kapso con API key al producto: da acceso completo al proyecto. Solo para el equipo.

**Riesgos (de mayor a menor)**
1. La llamada internacional a móviles venezolanos no entra o tarda (operador). *Mitigación*: probar hoy con los tres
   operadores, tener un número extranjero de respaldo, B1 (navegador) y video.
2. El sandbox de Kapso exige ventana abierta o la sesión caduca [no verificado]. *Mitigación*: reactivar 30 min antes
   del pitch, con Telegram listo.
3. Sin crédito en Kapso, los mensajes de servicio quedan en pausa (`service_credits_exhausted` o 402). *Mitigación*:
   recargar 5 USD.
4. Abuso: alguien provoca alertas en masa y gasta llamadas. *Mitigación*: techos por organización y modo tormenta.
5. El parser de respuestas a plantilla no coincide con el payload real de Kapso (no documentado). *Mitigación*:
   aceptar `interactive.button_reply.id` y `button.payload`, y registrar el JSON crudo en el primer ensayo.

**Esfuerzo**
| Pieza | Esfuerzo |
|---|---|
| Cuentas y configuración (Kapso sandbox, Twilio, ElevenLabs y agente) | S (2 h, una persona) |
| Envío WhatsApp interactivo, webhook Kapso y canje de botones | M (3–4 h) |
| Llamada ElevenLabs, herramienta `registrar_respuesta` y webhook post-call | M (3 h) |
| Motor: esquema, upsert por huella, cooldown, tick de escalamiento y topes | M (4 h) |
| UI in-app con Realtime (banner, botones grandes, línea de tiempo de notificaciones) | M (3 h, chat FRONT) |
| Telegram de respaldo | S (1 h) |
| Plan B de voz (navegador o TwiML `<Say>`) | S (1 h) |
| Email Resend (resumen y enlace) | S (30 min) |
| Plantilla de Meta en producción | S de trabajo, L de espera (hasta 24 h o más) |
