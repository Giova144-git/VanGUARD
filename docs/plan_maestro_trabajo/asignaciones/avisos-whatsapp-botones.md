# Anexo: todos los avisos por WhatsApp con botones de acción rápida

Decisión de Giovanni (sáb 24-oct, ~20:10 de Caracas): «es importante que todos los avisos lleguen por WhatsApp al número
registrado en la cuenta con sus botones de acción rápida». Lo implementa el **BACK**, dentro de cada función, reutilizando
el envío interactivo y el webhook que ya funcionan. La plantilla de Meta y el resto de la mensajería siguen siendo del
compañero de Giovanni (docs/entrega-mensajes/MENSAJES_Y_LLAMADAS.md).

## Lo que ya existe (no cambia)

- Destinatarios: los contactos de la org con WhatsApp **verificado** (Ajustes → Contactos). Ventana de 24 h de Meta:
  dentro, mensaje interactivo; fuera, la plantilla `alerta_seguridad_v1` cuando Meta la apruebe (hoy PENDING) o queda
  en la app.
- Incidentes: interactivo con «Lo estoy viendo» (`ack`), «Silenciar 1 h» (`snz`) y «Bloquear IP» (`blk` → «Sí, bloquear»
  `ok` / «Cancelar» `no`). Ids de botón `^(ack|snz|ok|no|blk):([A-Z0-9]{6}):([A-Za-z0-9_-]{16,43})$`
  (`packages/core/src/templates/whatsapp.ts`, `apps/api/src/rutas/webhooks-kapso.ts`), nonces de un solo uso guardados
  como sha256, solo el remitente verificado, caducan a los 10 min (`apps/api/src/actions/approvals.ts`).

## Lo nuevo

**Regla de Giovanni (sáb ~20:15): cada botón hace una ACCIÓN REAL y útil.** Nada de botones que solo «marcan» algo.

| Aviso | Mensaje (texto FIJO, sin texto de la IA ni del autor) | Botones (≤ 3, títulos ≤ 20 caracteres) y qué hacen de verdad |
|---|---|---|
| Revisión de push o PR con hallazgos nuevos ≥ umbral (hoy sale como texto: `notify/revision.ts` usa `cuerpoTexto`) | El de `mensajeRevision` | **«Enviarme el arreglo»**: responde por WhatsApp con los pasos de corrección FIJOS de la regla del hallazgo más grave (la plantilla determinista de `packages/core/src/templates/fix/`, la misma que el `fallback_prompt` de E15; sin IA, sin valores ni rutas) y el enlace al hallazgo en el panel. **«Crear issue»** (solo si el token de escritura del bloqueo tiene «Issues: Read and write»): confirmación «Sí, crear» / «Cancelar» → crea un issue en el repo con título y cuerpo fijos (regla, archivo y línea, sin el valor; pasos de la plantilla) y etiqueta `vanguard`, y responde con su número y URL. **«Silenciar repo 1 h»**: VanGUARD no manda más avisos de revisión de ese repo durante 1 h (el ✗ y el cierre de PR siguen) y responde con la hora de fin. |
| PR cerrado por VanGUARD (anexo `bloqueo-merge-cierre-pr.md`) | «VanGUARD cerró el PR #{n} hacia {rama}: {k} crítico(s) nuevo(s). Corrige, rota las claves y vuelve a abrirlo.» | **«Reabrir el PR»**: confirmación «Sí, reabrir» / «Cancelar» → `state: open` en GitHub (queda el ✗) y responde «PR #{n} reabierto». **«Enviarme el arreglo»** (igual que arriba). **«Silenciar repo 1 h»**. |
| Incidente (ya existe, sin cambios) | El de hoy | «Lo estoy viendo» (para el reaviso y deja constancia), «Silenciar 1 h», «Bloquear IP» → «Sí, bloquear» / «Cancelar». |
| Ataque en el que se puede activar el modo bajo ataque (`modo-bajo-ataque.md`) | Un **2.º mensaje** tras el del incidente (el del incidente ya usa los 3 botones): «Ataque desde {n} IPs en {host}. Puedes poner ese host en modo bajo ataque 30 min.» | **«Modo bajo ataque»**: confirmación «Sí, activar» / «Cancelar» → crea la regla de configuración en Cloudflare y responde con la hora de fin y cómo deshacerlo. **«Cancelar»**. |

Toda acción responde por WhatsApp con el resultado real («Hecho: …» o «No se pudo: <motivo corto>»), y la app lo muestra.

Reglas:
1. **Acciones nuevas de botón**, con el mismo formato `accion:CODIGO:nonce` y las mismas guardas (nonce de un solo uso,
   remitente verificado de la org, 10 min). El `CODIGO` de 6 caracteres es el de la revisión o el del incidente.
   Propuesta de ids: `fix` (enviarme el arreglo), `iss` (pedir crear issue), `rvs` (silenciar el repo 1 h), `rpr` (pedir
   reabrir el PR), `uat` (pedir modo bajo ataque); la confirmación reutiliza `ok`/`no` con la aprobación correspondiente. El BACK ajusta
   la expresión regular del webhook y `TITULOS_BOTON`.
2. **Toda escritura en sistemas del cliente necesita el 2.º paso** («Sí, …» o el código de 6 dígitos), igual que «Bloquear
   IP». «Lo estoy viendo» y «Silenciar» no escriben fuera de VanGUARD y van en un toque.
3. **«Silenciar repo 1 h»**: no envía más avisos de revisión de esa configuración durante 1 h (columna nueva en
   `code_review_configs`, en la migración de la función que vaya primero). El ✗ y el cierre de PR siguen.
4. **Ventana de 24 h:** igual que hoy. Fuera de la ventana no se manda el interactivo (saldría 131047); queda en la app.
   La plantilla, cuando esté APPROVED, la conecta el compañero de mensajería.
5. Cada aviso respeta su cupo (incidentes y revisiones por separado) y la ventana de avisos de la demo.
6. Pruebas: cada botón nuevo con su id válido e inválido, nonce reusado, remitente no verificado, confirmación caducada,
   y que el aviso de incidente sigue IDÉNTICO al de hoy.

## Reparto

- **BACK**, dentro de cada función:
  - revisión: botones en el aviso actual ≈ 40 min;
  - bloqueo: «Reabrir el PR» ≈ 30 min, sumado al anexo de cierre;
  - bajo ataque: 2.º mensaje ≈ 40 min.
  Toca `packages/core/src/templates/whatsapp.ts`, `apps/api/src/rutas/webhooks-kapso.ts`, `apps/api/src/notify/revision.ts`
  y `actions/approvals.ts`; NO toca `notify/kapso.ts` salvo para usar `cuerpoInteractivo`, ni la plantilla de Meta.
- **FRONT**: en la tarjeta de revisión y en el incidente, mostrar la acción tomada desde WhatsApp («Visto por WhatsApp»,
  «Silenciado 1 h», «PR reabierto por WhatsApp», «Modo bajo ataque activado por WhatsApp»).
- **Compañero de mensajería**: al aplicar el parche de plantillas, conservar estos botones nuevos y no reutilizar sus ids.
