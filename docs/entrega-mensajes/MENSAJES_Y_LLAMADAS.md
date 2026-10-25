# Mensajes (WhatsApp) y llamadas: cómo está hecho y qué falta

Entrega del BACK (sáb 24-oct, ~17:30 de Caracas). Desde ahora, todo lo de mensajes y llamadas lo lleva otra persona del
equipo. El BACK y el ORQUESTADOR siguen con lo demás. Este documento cuenta lo que hay en `main`, lo que quedó a medias
(la plantilla, con su parche) y lo que falta (plantilla y llamadas).

Documentos de referencia:
- `docs/plan_maestro_trabajo/asignaciones/back-whatsapp-real.md`: encargo de WhatsApp real (B1–B9), costos, plantilla y fuentes.
- `docs/plan_maestro_trabajo/asignaciones/revision-codigo.md` §5: avisos de la revisión de código.
- `docs/PASOS_MANUALES_GIOVANNI.md`: pasos 9 (Kapso), 12 (llamada) y 17 (revisión de código).

---

## 1. Estado hoy

| Qué | Estado |
|---|---|
| Número | Producción usa el número **real** de Kapso, +1 205-843-2279 (3d780ff: sin `KAPSO_SANDBOX`, con `KAPSO_DISPLAY_NUMBER`) |
| Contacto de la demo | «giova» de «Tienda Demo», verificado por WhatsApp (VERIFICAR) a las 20:44 UTC. Su ventana de 24 h está abierta desde entonces |
| Clave de Kapso del Worker | Era la de la cuenta vieja: todos los envíos de hoy dieron **401**. Giovanni la está subiendo con `scripts/subir-secretos-worker.mjs`. Hasta que lo confirme, un 401 viene de aquí y no del código |
| Plantilla `alerta_seguridad_v1` | Creada en Meta (id 1872189577531067, UTILITY, es, botones «Lo estoy viendo» y «Silenciar 1 h»). Está **PENDING**. El código para enviarla está en un parche sin verificar (§4.1) |
| Llamadas | **No existen.** Solo se guarda el umbral de llamada. Mientras no haya llamadas, lo que lo pasa sale por WhatsApp (§4.3) |
| Sandbox de Kapso | Plan B. Solo puede escribir a teléfonos unidos a su sesión con un código, sin plantillas y sin varios destinatarios. Cada mensaje cuesta 0,0113 USD |

---

## 2. Cómo está construido

### 2.1 Piezas

| Pieza | Archivo | Qué hace |
|---|---|---|
| Cliente de Kapso | `apps/api/src/notify/kapso.ts` | Arma el cuerpo con funciones puras (`cuerpoTexto`, `cuerpoInteractivo`), envía por el proxy de la Cloud API de Meta con `X-API-Key` (`enviarKapso`) y lee el código de error de Meta (`codigoMeta`). Límites de Meta: 3 botones, cuerpo ≤ 1024, título de botón ≤ 20, id ≤ 256 |
| Textos de incidentes | `packages/core/src/templates/whatsapp.ts` | `mensajeIncidente`, botones `ack`/`snz`/`blk`, `textoSeguro` (una línea, redactado, IP recortada), `severidadMayus`, `ofreceBloqueo` |
| Plan de avisos | `packages/core/src/engine/notify-plan.ts` | `planAvisos` (incidentes: high → WhatsApp, critical → llamada; la llamada hoy se ignora), `TOPES_AVISOS`, tormenta. También `planAvisoRevision`, `umbralWhatsapp` y `TOPES_REVISION` para la revisión de código |
| Despachador de incidentes | `apps/api/src/notify/despachador.ts` | Tras cada incidente nuevo, con subida de severidad o reabierto: lee incidente, contactos, uso de la última hora, ventana de demo y tormenta. Por cada WhatsApp escribe la fila `notifications` en `queued` ANTES de enviar (el unique da 23505 si ya se avisó), una fila de `approvals` por botón con `sha256(nonce)`, el interactivo por Kapso y el cierre `sent`/`failed`. **Hoy no mira la ventana de 24 h** (eso es B6, §4.1) |
| Botones | `apps/api/src/actions/approvals.ts` | Ids de botón, nonces de un solo uso (10 min) y canje atómico con `vg_redeem_approval`: `ack`, `snz` y «Bloquear IP» (`blk`, `ok`, `no`) |
| Webhook de Kapso (E31) | `apps/api/src/rutas/webhooks-kapso.ts` | `POST /webhooks/kapso`: HMAC sobre el cuerpo crudo en tiempo constante, dedupe por `X-Idempotency-Key` en `webhook_events`, 200 inmediato y el resto en `waitUntil`. Estados → `notifications` (`delivered`/`read`/`failed`). Entrantes: cualquier mensaje registra `contacts.wa_last_inbound_at`; botón → canje; «VERIFICAR <código>» verifica; «BAJA/STOP/SALIR» da de baja. Respuestas con tope `RL_WA` (3/min) |
| Verificación de contactos | `apps/api/src/rutas/contacts.ts` (E26), `apps/api/src/lib/verificacion.ts` | E26 enseña a los admins el código de 6 hex y el enlace `wa.me`. Código = HMAC-SHA256(FPK kid fijo `v1`, `contact|<org>|<id>`). E31 lo comprueba con el `from` que autentica Meta. Nunca se registran el código ni el texto |
| Probar WhatsApp (E27) | `apps/api/src/rutas/notifications.ts` | `POST /api/orgs/:org/notifications/test`: al contacto prioritario verificado. Con la ventana cerrada responde 409 `window_closed` («Escribe cualquier mensaje a VanGUARD desde ese teléfono…»), salvo `KAPSO_SANDBOX=1` |
| Aviso de la revisión de código | `apps/api/src/notify/revision.ts`, `packages/core/src/templates/revision.ts` | Paso `aviso` de la cola: umbrales de `alert_prefs`, cupo propio (3 revisiones avisadas/h, 10 en la demo), ventana de 24 h (cerrada → `failed`/`window_closed` sin llamar a Kapso), texto FIJO de `mensajeRevision` (sin repo, rutas ni texto de IA), `notifications.code_review_id` |
| Preferencias de aviso | `apps/api/src/rutas/revision.ts` (E48/E49) | `review_whatsapp_min` y `review_voice_min`; `voice_available: false` |

### 2.2 Base de datos (Supabase, todo solo del servidor)

| Tabla | Qué guarda |
|---|---|
| `contacts` | Teléfono E.164, `whatsapp`, `voice`, `priority`, `verified_at`, `wa_last_inbound_at` (ventana de 24 h), `optin_at` (0008i) |
| `notifications` | Una fila por envío: `channel`, `recipient_masked` (+58•••4567), `template` (`incident_v1`, `storm_v1`, `test_v1`, `code_review_v1`), `status`, `provider_id` (wamid), `error`. `incident_id` o `code_review_id` (0013) |
| `approvals` | Botones: solo `sha256(nonce)`, destinatario, caducidad |
| `webhook_events` | Dedupe de E31 |
| `app_config` | `demo_alertas_hasta` (ventana de alertas de la org de demo) y, cuando exista, `kapso_plantilla_alerta` (§4.1) |
| `alert_prefs`, `code_reviews` | Umbrales y avisos de la revisión de código (0013) |

### 2.3 Secretos y variables (nombres, nunca valores)

- Secretos del Worker:
  - Kapso: `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_WABA_ID`, `KAPSO_WEBHOOK_SECRET`.
  - Llamadas, para el P1: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, `ELEVENLABS_WEBHOOK_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET` y `TWILIO_FROM`. Están declarados en `apps/api/worker-configuration.d.ts`, pero no los usa ningún código.
- Variables en `apps/api/wrangler.jsonc`:
  - `KAPSO_DISPLAY_NUMBER` (12058432279).
  - `KAPSO_SANDBOX` (solo con el sandbox; hoy no está).
  - El tope `RL_WA`.
- Scripts:
  - `scripts/kapso-config.mjs` (`--real`, `--webhook`) y `scripts/subir-secretos-worker.mjs`, ambos del ORQUESTADOR.
  - `apps/api/scripts/kapso-prueba.mjs`.

Los scripts toman los secretos del entorno y no los imprimen. Ningún chat lee `.env` ni `.dev.vars`.

### 2.4 Pruebas

- api:
  - `notify/kapso.test.ts`, `notify/despachador.test.ts` y `notify/revision.test.ts`;
  - `rutas/webhooks-kapso.test.ts`, `rutas/notifications.test.ts` y `rutas/contacts.test.ts`;
  - `actions/*.test.ts`.
- core: `templates/whatsapp.test.ts`, `templates/revision.test.ts` y `engine/notify-plan.test.ts`.
- Comandos: `pnpm --filter @vanguard/api test` y `pnpm --filter @vanguard/core test`, siempre con typecheck.

---

## 3. Reglas que no se pueden romper

- Solo reciben algo los contactos **verificados**. BAJA se respeta siempre.
- Nunca va por WhatsApp texto de IA, nombre de repo, rutas de archivo, valores, títulos de PR ni autores. Los parámetros de una plantilla pasan por `textoSeguro` y no llevan URL.
- **Ventana de 24 h de Meta.** Fuera de ella solo sale una plantilla aprobada. Cualquier otra cosa da 131047, que llega DESPUÉS del 200 por E31. Por eso, antes de cada ensayo y del pitch, el teléfono de la demo le escribe al número.
- **Demo del ataque.** Con la ventana abierta, el despachador tiene que mandar exactamente lo de hoy: interactivo `incident_v1`/`storm_v1`, botones, topes, tormenta y ventana de demo.
- La fila `notifications` se escribe ANTES de llamar a Kapso, y el unique impide repetir.
- Logs sin teléfonos completos, códigos, cuerpos ni secretos.
- Despliegues: nunca durante el ensayo. El backend se congela el sáb a las 23:00; después, solo arreglos con el OK del ORQUESTADOR.

---

## 4. Lo que falta

### 4.1 Envío con plantilla (B4, B6 y B7 de `back-whatsapp-real.md`): hay un parche

`docs/entrega-mensajes/plantilla-b4-b6-b7-sin-verificar.patch` tiene 9 archivos y se aplica limpio sobre `main` de hoy
(8a74286, 06a5c26):

- `notify/kapso.ts`: plantilla, `cuerpoPlantilla`, `enviarPlantilla`, códigos de texto en `codigoMeta`, 402 → `saldo`.
- `notify/plantilla.ts` (nuevo).
- `notify/despachador.ts`: ventana de 24 h; si está cerrada, plantilla de `app_config.kapso_plantilla_alerta` o `failed`/`window_closed` sin llamar a Kapso.
- `rutas/webhooks-kapso.ts`: códigos de fallo de B7 y reintento por 131047.
- `core/templates/whatsapp.ts`.
- Las pruebas de todo lo anterior.

Lo escribió un agente que se paró **antes de su verificación adversarial**. Medido en una copia limpia: typecheck de api y core sin errores, api 1007 pruebas en verde (+34) y core 578.

```bash
git apply docs/entrega-mensajes/plantilla-b4-b6-b7-sin-verificar.patch
```

Antes de subirlo:

1. **Revisarlo entero contra B4, B6 y B7.** En particular:
   - el cuerpo exacto de la plantilla (`index` como string, en el orden de los botones);
   - el saneado de los parámetros ({{3}} ≤ 80 y sin URL);
   - que un 131047 no reintente en bucle;
   - que no se reintente a contactos sin verificar.
2. **Comprobar la demo del ataque.** Con la ventana abierta, el despachador debe hacer lo mismo que hoy.
   - Efecto conocido: con B6, un contacto verificado sin `wa_last_inbound_at` (o con su última entrada de hace más de 23 h 50 min) deja de recibir el aviso del ataque mientras no haya plantilla APPROVED.
   - Es lo correcto, porque Meta lo rechazaría igual con 131047, pero obliga a que el teléfono escriba antes.
3. **Activar la plantilla.** Cuando Meta la apruebe (APPROVED y UTILITY), el ORQUESTADOR escribe por SQL `app_config` `key = 'kapso_plantilla_alerta'`, `value = '"alerta_seguridad_v1"'`. Sin esa fila no se usa plantilla.
4. **Desplegar** antes de las 20:00 de Caracas o después del ensayo de las 20:30, avisando al ORQUESTADOR.

Queda fuera del parche: el interactivo de seguimiento con «Bloquear IP» tras tocar un botón de la plantilla. Mira las «decisiones» del parche y B6.

### 4.2 Otros de `back-whatsapp-real.md`

- **B8** (P1): respaldo por `context.id` si el payload del botón no vuelve. Solo si la prueba real lo pide.
- **B9**: `kapso-prueba.mjs --plantilla`, solo con el OK de Giovanni porque gasta.
- **Saldo**: mirarlo antes de cada ensayo. Con 0, Kapso pausa todos los envíos (`service_credits_exhausted`).

### 4.3 Llamadas (no hay nada construido)

Lo que existe:

- **Base:** `contacts.voice` y `alert_prefs.review_voice_min`.
- **Código:**
  - `planAvisos` genera entradas de voz para los critical, pero el despachador las ignora sin dejar fila;
  - `TOPE_GLOBAL_LLAMADAS_HORA = 20` en core;
  - el tipo de mensaje de cola `kind: 'escalate'`, sin manejador;
  - en la revisión de código, `voice_pending = true` cuando se pasa el umbral de voz (el aviso sale por WhatsApp).
- **API y pantalla:** E48 devuelve `voice_available: false` y la UI dice «Próximamente».

Hay dos caminos.

**A. Llamada por WhatsApp (Kapso Calling), con el mismo número.**
1. Activar «Calling setup» en el número de Kapso/Meta. Hoy no está activado.
2. Un servidor de audio (WebRTC) que hable en la llamada. El Worker no puede llevar audio. Kapso tiene una guía para conectar un agente de voz: https://docs.kapso.ai/docs/whatsapp/calling/voice-agents.md
3. Permiso de cada usuario. Antes de llamar hay que mandarle un `call_permission_request`. Fuera de la ventana, también con plantilla aprobada. Solo se le llama si acepta (`call_permission_reply`). El estado se consulta con `call_permissions`.
4. País y cobro. Meta limita las llamadas por país (falta comprobar +58) y cobra por pulsos de 6 s. Un bloqueo de cobro de Meta o un saldo insuficiente en Kapso la frena aunque haya permiso.
- Documentación: https://docs.kapso.ai/docs/whatsapp/calling/outbound-calls.md

**B. Llamada telefónica (Twilio + ElevenLabs).** Es el paso 12 de `PASOS_MANUALES_GIOVANNI.md`.
1. Cuenta de prueba de Twilio sin pagar, con los teléfonos del equipo verificados y el permiso geográfico para Venezuela.
2. Agente «VanGUARD» en ElevenLabs con el número de Twilio importado, y una API key con tope de créditos.
3. Secretos `ELEVENLABS_*` en el Worker.
4. Código, más o menos 1 h: cuando se pase el umbral de voz, una llamada HTTP a la API de llamadas salientes de ElevenLabs desde el despachador y desde el paso `aviso` de la revisión. Se guarda la fila `notifications` con `channel: 'voice'`, con su tope (`TOPE_GLOBAL_LLAMADAS_HORA`), solo a contactos verificados con `voice = true`. Después, `voice_available: true` en E48.
- **Riesgos:** la cuenta de prueba de Twilio solo llama a números verificados, mete un aviso de cuenta de prueba al principio y puede no dejar llamar a +58. El presupuesto en efectivo es 0.

Recomendación del BACK: si hace falta una llamada en el pitch, la vía B es la más corta. Antes de escribir código, conviene comprobar que la cuenta de prueba de Twilio deja llamar a un +58.

---

## 5. Cómo probar en producción

- **«Probar WhatsApp»** en Ajustes (E27) con un admin de la org. Con 409 `window_closed`, escribir antes al número.
- **Filas de envío:** mirar `notifications` de la org (status, error, provider_id) con el SQL del MCP de Supabase. Un `failed` con `131047` es la ventana cerrada; un 401 en los logs del Worker, la clave de Kapso.
- **Logs del Worker:** `kapso.*`, `notificacion.*`, `despacho.*` y `revision.*`, en Workers Observability.

## Aviso del ORQUESTADOR (sáb 24-oct, ~20:10): botones nuevos que hace el BACK

Por decisión de Giovanni, el BACK añade botones de acción rápida a los avisos nuevos (revisión de push y PR, PR cerrado
por VanGUARD y modo bajo ataque), reutilizando `cuerpoInteractivo` y el webhook de Kapso. Detalle:
`docs/plan_maestro_trabajo/asignaciones/avisos-whatsapp-botones.md`. Toca `packages/core/src/templates/whatsapp.ts`
(`TITULOS_BOTON` y acciones nuevas `fix`, `iss`, `rvs`, `rpr`, `uat`), `apps/api/src/rutas/webhooks-kapso.ts` (expresión de los
ids de botón), `apps/api/src/notify/revision.ts` y `apps/api/src/actions/approvals.ts`. Al aplicar el parche de
plantillas, conserva esos botones y no reutilices sus ids. La plantilla de Meta y su envío siguen siendo tuyos.
