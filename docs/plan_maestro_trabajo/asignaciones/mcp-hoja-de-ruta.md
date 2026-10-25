# MCP propio: lo que queda para la hoja de ruta

Propuesta del BACK (sáb 24-oct, noche de Caracas), tras la revisión adversarial del servidor MCP de Gabriel
(`docs/mcp-propio.md`, S13 §13.7 de PLAN_MAESTRO.md, fusionado en `fe26f3d`).

Referencias: `apps/api/src/mcp/*`, `apps/api/src/mw/mcp-auth.ts`, `apps/api/src/rutas/mcp-tokens.ts`,
`supabase/migrations/0014_mcp_tokens.sql` y `0014b_mcp_tokens_guardas.sql`.

---

## 0. Lo que sí se arregló (rama `func/mcp-arreglos`)

- **Lotes.** `/mcp` ya no acepta lotes JSON-RPC: un arreglo da `400` con `-32600` «Invalid Request». La versión
  2025-06-18 del protocolo quitó el batching, y un lote de 20 `get_overview` hacía 301 subpeticiones con un solo cobro.
- **Límite por llamada.** `RL_API` con clave `mcp:<token_id>` se cobra en `mcp/protocolo.ts` por cada petición JSON-RPC
  (cada `tools/call` y cada `prompts/get`), no una vez por POST. Agotado, da `429` con `Retry-After: 60` y un error
  JSON-RPC `-32000` con el `id` de la petición.
- **Presupuesto escrito.** Cada herramienta y cada prompt declara `subpeticiones`. La base son 4: RL por IP, SELECT del
  token, `last_used_at` y RL por token. La más cara es `get_overview`, con 4 + 15 = 19 de 40. `mcp.test.ts` mide las
  ocho en el peor caso.
- **Prompt `resolver_hallazgo`.** `title`, `resource` y la ruta del archivo pasan por `bidiAVista` y
  `redactarParaExport`, y van dentro de `fenceMd`. La instrucción fija va fuera del cercado. La `description` del prompt
  ya no lleva el título.
- **Corrección neutralizada (`resolver_hallazgo` y `get_fix_prompt`).** La plantilla volvía a meter esos campos fuera
  del cercado: `generica()` pone el título en prosa y casi todas las reglas citan el recurso o la ruta en código en línea,
  sin escapar `<` ni `>`. Un título o un recurso con `</datos_no_confiables>` cerraba un cercado falso. Ahora la
  plantilla se arma sin título; `resource` y `evidence.path` entran tal cual solo si tienen forma de identificador (sin
  espacios, comillas, acentos graves, `<` `>` ni controles o bidi), y si no se cambian por la referencia fija
  `(nombre en los datos del hallazgo)`. En el resto de la evidencia, `<` y `>` van escapados como en `fenceMd`. Si la
  corrección usa la referencia, o si hay texto con forma de instrucción, el prompt lo avisa con una línea fija. En el
  prompt guardado de IA-1, una etiqueta `datos_no_confiables` sale escapada.
- **Límite por IP antes del SELECT.** `mcpAuth` cobra `RL_API` con clave `mcp-ip:<cf-connecting-ip>` antes de buscar el
  token. Así, un `vgk_` inventado ya no consulta `mcp_tokens` sin freno.
- **Cable trampa del `name`.** E29 rechaza con `422 invalid_body` un nombre con forma de secreto o con `vgk_`. La
  migración 0014b añade el check `mcp_tokens_name_no_secreto` (`not private.looks_like_secret(name)`). Su prueba está en
  `supabase/tests/mcp-tokens.sql`.
- **Logs.** Los logs usan `mcp_id` en vez de `token_id`, porque `redact()` tachaba la clave y se perdía la traza.

**Queda desfasado:** `docs/mcp-propio.md` (§4.2, §4.3 y §4.5) todavía dice «lotes de hasta 20», «RL_API por POST» y
`token_id` en los logs. No lo toqué porque está fuera de mi zona. Que lo actualice quien lo lleve.

**Nota de versiones:** `initialize` sigue aceptando `2025-03-26`, la única versión negociada que permitía lotes. Un
cliente en esa versión que mande un arreglo recibe `-32600`. Claude Code y Cursor no mandan lotes. Si alguno lo hiciera,
la salida es dejar de anunciar `2025-03-26`, no volver a aceptar lotes.

---

## 1. El token no se ata a la membresía de quien lo creó (y E29b sin `created_by`)

**Qué pasa.** `mcpAuth` solo mira la fila de `mcp_tokens`: hash, `revoked_at` y `expires_at`. Si a quien lo creó lo sacan
de la org, lo bajan a viewer o borran su usuario, el token sigue leyendo la org hasta que vence (hasta 90 días). Con un
usuario borrado, `created_by` pasa a `null` (`on delete set null`) y el token sigue vivo.

Además, E29b no devuelve `created_by`, así que el admin no ve de quién es cada token para revocar el de quien se fue.

**Por qué no hoy.** Cambia el contrato y necesita una migración con trigger la víspera de la entrega.

**Arreglo propuesto.**
- **En la base (0014c):** un trigger `after delete or update of role on org_members` que revoque
  (`revoked_at = now()`) los tokens de esa org con `created_by = old.user_id` cuando el miembro sale o deja de ser
  owner/admin.
- **En la auth:** `mcpAuth` exige `created_by is not null`. Es un filtro más en el mismo SELECT, sin subpetición nueva,
  y cubre a los usuarios borrados.
- **Si se prefiere no usar el trigger:** una RPC `vg_mcp_token(p_hash)` que devuelva la fila solo si
  `created_by` sigue siendo owner/admin de la org. Hace una subpetición, igual que hoy.
- **En el contrato:** `McpTokenPublic` sumaría `created_by` (o el correo enmascarado) y E29b lo leería. Es un cambio de
  `packages/contracts` y lo tiene que decidir el ORQUESTADOR.

## 2. Tope de 10 vivos y lista de E29b con historial

**Qué pasa.**
- **Sin purga.** Los tokens revocados o vencidos se quedan para siempre. E29b (`limit 50`, por `created_at`) los mezcla
  con los vivos. Tras muchos ciclos de crear y revocar, un token vivo pero antiguo se cae de la lista y no se puede
  revocar desde la UI.
- **El conteo del tope no filtra `expires_at` en SQL.** E29 lee hasta 60 filas no revocadas (`MAX_VIVOS + 50`) y filtra
  las vencidas en JS. Si hay más de 60 no revocadas pero vencidas, las 60 leídas pueden ser todas vencidas: el conteo da
  0 y el tope de 10 deja de aplicarse.
- **Comprobar y luego insertar.** Dos POST a la vez ven 9 vivos y los dos insertan, así que la org queda con 11.

**Por qué no hoy.** Hace falta otra migración (RPC o trigger) y una tarea de retención. El riesgo real es bajo: solo un
admin crea tokens, con `RL_API` por usuario.

**Arreglo propuesto.**
- **Conteo exacto en SQL:** `select('id', { count: 'exact', head: true })` con `revoked_at is null` y
  `or(expires_at.is.null, expires_at.gt.<ahora>)`.
- **Atómico:** una RPC `vg_mcp_token_create(p_org, p_name, p_hash, p_last4, p_expires, p_user)` que tome
  `pg_advisory_xact_lock(hashtext(p_org::text))`, cuente los vivos e inserte en la misma transacción. También vale un
  trigger `before insert` que bloquee la fila de `orgs`. La RPC lleva `revoke` a public, anon y authenticated, y
  `grant` a service_role.
- **Purga:** en la retención de 0008, borrar los tokens revocados o vencidos hace más de 30 días.
- **E29b** devuelve por defecto solo los vivos y, con `?historial=1`, los últimos 50 de cualquier estado.

## 3. Pruebas de hash tautológicas y aislamiento probado en 2 de 6 herramientas

**Qué pasa.**
- **Hash:** `mcp.test.ts` compara `token_hash` con `hashToken(token)`, que es la misma función. El doble de la base
  también responde según `hashToken(TOKEN)`. Si `hashToken` cambiara (por ejemplo, a base64 o a otro algoritmo), las
  pruebas seguirían en verde y todos los tokens emitidos dejarían de valer en producción.
- **Aislamiento:** el anti-IDOR solo se prueba en `get_finding` (token de otra org) y en `get_fix_prompt` (`org_id` del
  SELECT). De `get_overview`, `get_repo_status`, `list_findings` y `list_incidents` ninguna prueba mira que cada consulta
  lleve `.eq('org_id', <org del token>)`.

**Por qué no hoy.** No hay ningún fallo conocido: todas las consultas llevan el filtro al revisarlas a mano. Lo que
falta es la red.

**Arreglo propuesto.**
- **Hash:** un vector conocido, `hashToken('vgk_' + 'A'.repeat(43))` igual a un hex calculado fuera (por ejemplo, con
  `sha256sum`) y escrito literal en la prueba. Comprobar también que sale en hex en minúsculas con 64 caracteres, como
  exige el check de 0014.
- **Aislamiento:** reutilizar el bucle de la prueba de presupuesto (ya recorre las 6 herramientas y los 2 prompts) con
  un token de `OTRA` org. Cada `op` de datos (todas salvo `mcp_tokens`) debe llevar `eqDe(op, 'org_id') === OTRA`, y cada
  `rpc` debe llevar `p_org === OTRA`, como hace `export.test.ts` («cada consulta va filtrada por la org de la sesión»).

## 4. `get_repo_status` lee dos veces 200 hallazgos (cerca de 10 ms)

**Qué pasa.** La herramienta pide hasta 200 hallazgos abiertos de codebase con `evidence`. Después, `estadoModulo`
vuelve a pedir otros 200 con `evidence`. Son hasta 400 filas con su JSON para parsear y recorrer. Con evidencias
grandes, la CPU se acerca a los 10 ms de Workers Free. El presupuesto de subpeticiones va bien (4 + 6), pero la CPU no.

**Por qué no hoy.** Tocar `estado/modulo.ts` (E6) arrastra al panel del FRONT, y con pocos hallazgos no se nota.

**Arreglo propuesto.** Que la herramienta deje de leer sus 200:
- los conteos por severidad, con 5 consultas `head` como `armarOverview`, o con lo que ya trae `estadoModulo` (`cifras`
  y `fs.count`);
- la lista, con `limit(20)` y sin `evidence` salvo la ruta. `location` solo necesita `evidence.path` y `evidence.line`:
  basta pedir `evidence->path, evidence->line` en el select.

Con los 5 `head`, el presupuesto pasaría de 6 a 11 (conexiones, revisiones, las 3 de `estadoModulo`, 5 conteos y la
lista), todavía lejos de 40. Tomando los conteos de `estadoModulo`, se queda en 6. Otra opción es que `estadoModulo`
acepte las filas ya leídas.

## 5. Nombres de la evidencia en código en línea y la misma fuga en E15

**Qué pasa.**
- **MCP.** En la corrección neutralizada, los demás nombres de la evidencia (tabla, esquema, política, función y sus
  argumentos, manifiesto, paquete) siguen entrando en código en línea o en el SQL de la plantilla, ya sin `<` ni `>`. Una
  tabla o una política con prosa (por ejemplo, la política por defecto de Supabase «Enable read access for all users»)
  sale tal cual fuera del cercado. No se cambian por la referencia porque las plantillas los necesitan para el SQL: con
  la referencia, el `drop policy` o el `revoke` saldrían rotos en el caso más común. Son nombres de la base del propio
  cliente, no texto de un tercero.
- **E15 («Copiar para mi IA») y el export.** `plantillaDe()` llama a la plantilla con el hallazgo tal cual. `generica()`
  pone el título en prosa en «Qué pasa», y `nombreEnCodigo`/`unaLinea` no escapan `<` ni `>`.
- **Prompt guardado de IA-1.** Se entrega tal cual (solo se escapa la etiqueta `datos_no_confiables`). Pasó el filtro de
  salida de IA-1 (`checkFixPrompt`), pero puede citar el título en prosa.

**Por qué no hoy.** El arreglo de fondo es de `packages/core` (fuera de la zona del MCP) y cambia los bytes que fija el
fixture de contracts (`hallazgos.ts`).

**Arreglo propuesto (para el ORQUESTADOR).**
- `generica()` deja de interpolar `title`: usa siempre «VanGUARD detectó REGLA en RECURSO».
- `nombreEnCodigo` (o `unaLinea`) escapa `<` y `>` como `fenceMd` (`<`, `>`).
- Si se quiere el mismo nivel que el MCP, `plantillaCorreccion` recibe una opción `soloIdentificadores` que cambie por
  una referencia fija los nombres que no lo son, y cada plantilla elige qué hace sin ellos (sin SQL, por ejemplo).
