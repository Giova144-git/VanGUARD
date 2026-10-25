# Seguridad de VanGUARD

VanGUARD guarda tokens de terceros y puede bloquear IPs en la zona de Cloudflare de un cliente. Este documento explica
cómo lo protegemos, **tal como está en el código de `main` y desplegado en https://officialvanguard.com**. Cada
afirmación cita el archivo que la respalda. Lo que aún no está hecho va en la sección 15, «Hoja de ruta».

- Revisado el 24-oct-2026 contra `main` en el commit `486a9ff`, el mismo que devolvía producción. Después solo
  entraron cambios de la web (`b1efab2`, `76745b3`, `8de07c3`), y a las 17:45 UTC producción devolvía `8de07c3`. Qué versión corre:
  `GET https://officialvanguard.com/api/health` devuelve `version` = SHA del commit desplegado.
- Arquitectura en una línea: un Worker de Cloudflare (`apps/api`, Hono) sirve la SPA (`apps/web`) como assets y la API
  en el mismo origen. Los datos viven en Supabase (Postgres con RLS, Vault y Auth). Lógica pura y compartida en
  `packages/core`.

---

## 1. Cómo reportar una vulnerabilidad

- **Contacto** (de `apps/web/public/.well-known/security.txt`, servido en
  https://officialvanguard.com/.well-known/security.txt):
  https://github.com/platanus-hack/platanus-hack-26-ve-team-22/issues/new
- Los issues son públicos. Usa un título genérico («Reporte de seguridad») y no pongas pasos explotables, tokens ni
  datos de terceros. Pide ahí un canal privado.
- Idiomas: español o inglés. El `security.txt` vence el 2027-04-24.
- **Alcance:** officialvanguard.com (SPA y API), el Worker `vanguard` y este repositorio.
- **Fuera de alcance:** `apps/victima` y `demo/repo-vulnerable` son vulnerables **a propósito**: son el blanco de la
  demo. Sus «secretos» son falsos (`demo/repo-vulnerable/README.md`).
- Prueba con tu propia cuenta o con «Ver demo». No accedas a datos de otras organizaciones y no hagas pruebas de
  volumen: corremos en el plan gratuito y la cuota diaria es compartida.

---

## 2. Principios

| Principio | Cómo se cumple | Dónde |
|---|---|---|
| **Solo lectura por defecto** | Supabase: PAT con alcance a un proyecto; a la base del cliente solo van tres consultas SQL fijas de la auditoría (más un `select 1` en el sondeo) por `/database/query/read-only`; el endpoint de escritura `POST /database/query` no aparece en el código. Cloudflare: token de lectura. GitHub: token fine-grained (`github_pat_`) de solo lectura; la guía pide marcar un solo repo. La única escritura es «Bloquear IP» (sección 5), con otro token y confirmación humana. | `packages/core/src/rules/supabase.ts` (`SQL_SUPABASE`), `apps/api/src/scans/supabase.ts` (`sqlRead`, `probarSupabase`), `apps/api/src/rutas/connections.ts`, `apps/web/src/lib/guias.ts` |
| **Mínimo privilegio** | Rechazamos tokens con más poder del necesario (3.1). El navegador no tiene ningún permiso sobre las tablas (4). La clave `service_role` solo vive en el Worker. Las funciones `security definer` de `public` solo las ejecuta `service_role`; `authenticated` solo ejecuta tres auxiliares de `private` que devuelven ids de orgs para las políticas RLS (`user_org_ids`, `user_admin_org_ids`, `demo_org_ids`). Una sesión anónima solo lee la org de demo. | `supabase/migrations/0008h_revoke_public_authenticated.sql`, `supabase/migrations/0008d_revoke_join_demo_org.sql`, `supabase/tests/rls.sql` |
| **La IA nunca decide** | Detectar, puntuar, alertar y bloquear lo hacen reglas deterministas y personas. El modelo solo redacta texto y no tiene herramientas (7). | `apps/api/src/ia/claude.ts` |
| **Fallo cerrado** | Webhook sin secreto o con firma ilegible → 401. Sin libro de gasto → sin IA. Sondeo negativo incompleto → el token no se guarda. Respuesta con forma inesperada → la fuente cuenta como no mirada, nunca como sana. | `apps/api/src/lib/hmac.ts`, `apps/api/src/ia/budget.ts`, `apps/api/src/scans/supabase.ts` |
| **Nada sensible en logs ni errores** | `log()` pasa todo por `redact()`. Los errores nunca incluyen `err.message` ni el cuerpo del proveedor (pueden llevar un token). | `apps/api/src/lib/log.ts`, `apps/api/src/mw/error.ts`, `apps/api/src/lib/http.ts` |

---

## 3. Credenciales de los clientes

### 3.1 Qué tokens aceptamos: guardas

Orden al conectar un servicio (E8, `POST /api/orgs/:org/connections`, `apps/api/src/rutas/connections.ts`):
validación del cuerpo → `guardKey` en cada token → sondeo de permisos contra el proveedor → id de conexión → sellado →
201. Si falla un paso, no queda nada guardado. Si falla el segundo token de Cloudflare, se borra el primero.

`guardKey` (`packages/core/src/key-guards.ts`) rechaza **antes de llamar al proveedor**:

| Token | Motivo del rechazo |
|---|---|
| `sb_secret_…` | Secret key de Supabase: salta toda la RLS |
| JWT con `role: service_role` | Lo mismo. Se lee el payload sin verificar la firma: solo sirve para rechazar |
| PAT de Supabase sin el prefijo `sbp_fc` | PAT legacy: ve todos los proyectos de la cuenta |
| `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` | PAT clásico de GitHub: todos los repos |
| `cfk_…` o 37–45 caracteres hex | Global API Key de Cloudflare: control total |
| Caracteres fuera del ASCII imprimible (espacios e invisibles incluidos), o más de 400 | No es un token; además evita cabeceras HTTP con el secreto dentro de un error |

Además, en la ruta: GitHub exige `github_pat_` (fine-grained) y una sola conexión GitHub activa por org; Cloudflare
exige que el token de acciones sea distinto del de lectura (`same_token`).

**Sondeo negativo del PAT de Supabase** (`PROHIBIDOS` en `apps/api/src/scans/supabase.ts`). El prefijo no basta: un PAT
legacy empieza por `sbp_fc` una de cada ~256 veces. Tras comprobar los permisos que sí necesita, el Worker pide cuatro
recursos que el token **no** debe poder leer:

- `GET /v1/organizations` (lo lee todo token de acceso total)
- `GET /v1/projects/{ref}/api-keys` (sin `?reveal`: nunca pedimos los valores)
- `GET /v1/projects/{ref}/postgrest`
- `GET /v1/projects/{ref}/secrets`

Un 2xx en cualquiera → `422 key_rejected` con la lista de permisos sobrantes y no se guarda nada. En la re-prueba (E9),
la conexión pasa a `error` y la auditoría deja de usarla. Si alguno responde 429, 5xx o falla la red, no se sabe → no se
guarda (502). Los cuerpos de estas respuestas se descartan sin leerlos.

El navegador repite las guardas más graves antes de enviar (`apps/web/src/lib/pre-guardas.ts`), para que una
`sb_secret_` ni siquiera salga de la máquina. La autoridad es el servidor.

### 3.2 Cifrado de sobre (AES-256-GCM)

`packages/core/src/crypto.ts`, solo WebCrypto estándar:

- Cada token se cifra con una **DEK aleatoria de 256 bits** (AES-256-GCM, IV de 96 bits). La DEK se envuelve con la
  **KEK** (AES-GCM, otro IV) y se borra de la memoria tras usarla (`fill(0)`).
- **Datos asociados (AAD)** en las dos capas: `vanguard|v1|org|conexión|proveedor|tipo`. Un sobre copiado a otra org,
  otra conexión u otro tipo no abre (`packages/core/src/crypto.test.ts`, «otra org u otra conexión lanza»).
- **KEK = HKDF-SHA-256 de dos mitades:** `kek_vN`, guardada en Supabase Vault, y la pimienta `VG_KEK_PEPPER`, secreto
  del Worker. Ni la base sola ni el Worker solo pueden derivarla. Cada mitad debe medir 32 bytes o la derivación lanza
  `CRYPTO_MATERIAL_BAD_LENGTH`: nunca se deriva con una pimienta vacía.
- La mitad de Vault se genera **dentro de la base** (`gen_random_bytes`) en
  `supabase/migrations/0003_connections_crypto.sql`: su valor no aparece en el repo ni en ninguna sentencia. La lee
  `vg_crypto_material()`, `security definer` ejecutable solo por `service_role`.
- Las llaves derivadas son `CryptoKey` **no extraíbles**, en caché 10 min por isolate; un fallo no se cachea
  (`apps/api/src/lib/keyring.ts`).
- `connection_secrets` tiene RLS **sin ninguna política** y `revoke all` a `anon` y `authenticated`. Un solo módulo la
  toca: `apps/api/src/lib/credentials.ts`. `withSecret()` descifra y el token solo existe dentro de la función que lo
  usa: no se devuelve, no se registra y no va a un prompt.
- La base valida la forma: el sobre debe traer sus 6 campos y el `kid` debe coincidir; `connections.meta` y
  `last_error` rechazan cualquier valor con forma de secreto (`private.looks_like_secret`,
  `supabase/migrations/0001_base.sql`). Del token solo queda visible `last4`.

### 3.3 Huella HMAC

`fingerprint()` = HMAC-SHA-256 con la FPK (HKDF de `fp_pepper_v1` en Vault + `VG_FP_PEPPER`) sobre `org|token`. Sirve
para:

- detectar el mismo token conectado dos veces en una org (`unique (org_id, fingerprint)` → 409);
- saber si un secreto encontrado en el repo del cliente es una de sus credenciales conectadas, **sin descifrar nada**
  (`fingerprintsOfOrg` en `apps/api/src/lib/credentials.ts`).

La huella incluye la org: no se puede comparar entre orgs. La misma FPK firma los códigos de un solo uso (sección 5) y
los códigos de verificación de contactos (`apps/api/src/lib/verificacion.ts`).

### 3.4 Rotación y revocación

Hecho:

- Cada sobre lleva su `kid`; `getKeys` deriva la KEK de ese `kid`; `app_config.kek_active`
  (`supabase/migrations/0007_ai_config_perf.sql`) dice con cuál se sellan los nuevos.
- `rewrap()` re-envuelve solo la DEK, sin descifrar el token. Probado en `crypto.test.ts`: el texto cifrado no cambia
  y las llaves viejas ya no abren.
- Un código de bloqueo guarda en `params` el `kid` con que se firmó: una rotación en esos 10 min no lo invalida.
- Borrar una conexión (E10) borra fila y secreto en cascada. Si es el token de acciones, antes retira sus bloqueos
  activos (409 si no puede). La respuesta trae `X-VG-Revoke-Url` con la página del proveedor para revocar el token allí.
- pg_cron marca `expired` cada 10 min las conexiones vencidas (`supabase/migrations/0008_rls_retention.sql`). La
  re-prueba (E9) marca `revoked` un token que el proveedor ya no acepta.

No hecho: ver sección 15 (re-envoltura masiva con `kek_v2`, pimienta anterior, ruta para rotar el token de un cliente).

---

## 4. Aislamiento por organización

**Decisión (a): el navegador no lee tablas.** Todo dato pasa por `/api`, donde el Worker comprueba la membresía.

- `supabase/migrations/0008h_revoke_public_authenticated.sql`: `revoke all on all tables in schema public from anon,
  authenticated`, y lo mismo en los privilegios por defecto: las tablas nuevas nacen sin permisos.
- La CSP de la SPA solo deja hablar con Supabase Auth y Realtime (`connect-src`), no con `/rest/v1` (sección 9).
- RLS está activa en todas las tablas de `public` como segunda barrera. Las políticas limitan cada fila a las orgs del
  usuario, y una sesión anónima solo a la org de demo (`0008_rls_retention.sql`, `0008e_anon_solo_demo.sql`).
- Realtime: canal privado `org:<id>`. El aviso solo lleva tabla, operación, `id` y `org_id`, nunca la fila (`0008e`).
- Los teléfonos de los contactos solo los lee un admin por la API; en los logs van enmascarados
  (`apps/api/src/notify/kapso.ts`, `enmascararTelefono`).

En el Worker (orden de middlewares en `apps/api/src/app.ts`):

1. `auth` valida el JWT con `getClaims`, nunca con `getSession` (`apps/api/src/mw/auth.ts`).
2. `orgMember` exige que `:org` sea un UUID, lo pasa a minúsculas y comprueba la membresía. Quien no es miembro recibe
   **404, no 403**: no se confirma que la org exista (`apps/api/src/mw/org.ts`).
3. `org_id` sale **siempre del contexto** (`c.get('orgId')`), nunca del cuerpo. Cada consulta filtra por `id` **y**
   `org_id`: un id de otra org da el mismo 404 que uno inexistente. En la ingesta, la org sale de la fila de la
   conexión, no de una cabecera.
4. Escrituras: `requireAdmin` (owner o admin) y `anonReadOnly` (la sesión anónima no escribe). Un anónimo no crea orgs
   (`apps/api/src/rutas/orgs.ts`) y entra como `viewer` de la org de demo (`apps/api/src/rutas/demo.ts`).

Se prueba con `test:idor`, `supabase/tests/rls.sql` y el arnés del FRONT (sección 12).

---

## 5. Acciones con escritura: «Bloquear IP»

Es la única escritura sobre la infraestructura del cliente. Código: `apps/api/src/actions/approvals.ts`,
`apps/api/src/actions/block-ip.ts`, `apps/api/src/rutas/actions.ts`, `packages/core/src/ip.ts`,
`packages/core/src/otp.ts`.

1. **Conexión aparte.** El bloqueo usa una conexión Cloudflare `kind: 'action'`, con su propio sobre. La base solo
   admite `action` en Cloudflare (`check` en `0003_connections_crypto.sql`). La guía pide un token con **solo Firewall
   Services · Edit** sobre la zona (`apps/web/src/lib/guias.ts`); el sondeo comprueba que lee las reglas de acceso de
   esa zona (`probarCloudflareAcciones` en `apps/api/src/scans/cloudflare.ts`). Nunca se entrega a la IA.
2. **Proponer (E20) solo simula: no toca Cloudflare.** `simularBloqueo` rechaza lo que no es una IP suelta (solo /32 o
   /128), IPs privadas o de documentación, **la IP del propio operador** (`cf-connecting-ip`) e IPs de Cloudflare
   (`RANGOS_CLOUDFLARE`). Devuelve el efecto en español («Bloquear X (/32) en la zona Y durante 1 h») y avisos, por
   ejemplo que el bloqueo vale para toda la zona. La simulación ya admite una lista de IPs permitidas, pero hoy ninguna
   ruta le pasa una: una org todavía no puede definirla (sección 15).
3. **Código de un solo uso.** Seis dígitos sin sesgo de módulo. La base guarda HMAC-SHA-256 con la FPK, nunca el código
   ni un SHA-256 a secas (con 10^6 códigos posibles se invertiría en milisegundos). El código llega por WhatsApp al
   contacto prioritario de la org, solo si está **verificado**: es el factor fuera de banda. Si no se puede entregar,
   fuera de la org de demo la API responde 502 y no crea nada (sección 14). Los botones ok/no de WhatsApp llevan un
   nonce de 16 bytes; la base guarda solo su SHA-256.
4. **Caducidad e intentos.** La aprobación vence a los 10 min. `vg_redeem_approval`
   (`supabase/migrations/0005_incidents_alerts.sql`) canjea en una sola sentencia: no usada, no vencida, menos de 5
   intentos y destinatario correcto (el usuario en la app; el teléfono que pulsó, en WhatsApp). Cada fallo suma un
   intento. Antes del canje, una lectura por `id` + `org_id` + destinatario impide que alguien de otra org queme los
   intentos. Además, `RL_COSTLY`: 10 por minuto y aprobación.
5. **Ejecutar.** Regla de acceso por IP en la zona, modo `block`, 1 h, con la nota «VanGUARD #código · regla · hasta
   <hora>», sin datos personales. Si ya había una regla `block` del cliente para esa IP, se reconoce y **nunca** se
   borra; si hay una regla en otro modo (por ejemplo, whitelist), no se toca.
6. **Deshacer (E22)** retira solo la regla que creó VanGUARD. Cloudflare no caduca estas reglas por sí solo: el cron de
   mantenimiento retira las vencidas (`apps/api/src/engine/housekeeping.ts`).
7. **Solo desde el host real.** Proponer, confirmar y deshacer exigen `VG_ENV=production` y el host de `APP_ORIGIN`
   (`apps/api/src/mw/prod-host.ts`): ni un despliegue de prueba ni `*.workers.dev` pueden bloquear nada.

---

## 6. Webhooks e ingesta firmada

**WhatsApp (Kapso), `POST /webhooks/kapso`** (`apps/api/src/rutas/webhooks-kapso.ts`, `apps/api/src/lib/hmac.ts`):

1. Lee el **cuerpo crudo**.
2. Verifica HMAC-SHA-256 (`X-Webhook-Signature`) con `crypto.subtle.verify`, en tiempo constante, **antes de
   parsear**. Sin secreto configurado o con firma ilegible → 401 sin efecto.
3. **Dedupe:** inserta en `webhook_events` (`unique (provider, external_id)`) con `X-Idempotency-Key` o, si falta, el
   SHA-256 del cuerpo. Un duplicado responde 200 sin reprocesar. Se guarda un resumen redactado, no el payload.
4. Responde 200 y procesa en segundo plano con un presupuesto de 40 subpeticiones.

**Ingesta de tráfico, `POST /ingest/v1/events`** (`apps/api/src/rutas/ingest.ts`): cuerpo ≤ 64 KB; `x-vg-ts` a menos
de 300 s de la hora del servidor; conexión `ingest` activa leída por id; HMAC-SHA-256 sobre `${ts}.${cuerpo crudo}` en
tiempo constante; solo después JSON y esquema. Todo fallo de autenticación → 401 sin decir la causa. El secreto `vgi_…`
se muestra una vez al crear la conexión y queda sellado como los demás tokens. Tras autenticar, `RL_INGEST` limita a 300
lotes por 10 s y conexión.

---

## 7. IA

Una sola puerta en el Worker: `apps/api/src/ia/claude.ts`. Ningún otro archivo importa el SDK de Anthropic (solo la CLI
de desarrollo de la wiki, `packages/deepwiki/src/cli.ts`, usa su propio cliente `crearLlmFetch`; el Worker no lo llama).

**Qué hace y qué no:**

- Escribe: el prompt de corrección de un hallazgo (`apps/api/src/rutas/findings.ts`), el resumen de una auditoría
  (`apps/api/src/scans/index.ts`) y la wiki del repo (`apps/api/src/wiki/llm.ts`).
- No decide: detección, severidad, puntaje, alertas y bloqueos son reglas deterministas (`packages/core/src/rules`,
  `apps/api/src/engine/evaluar.ts`, `packages/core/src/score.ts`) y el código humano de la sección 5. Las alertas de
  WhatsApp salen de plantillas: `apps/api/src/notify/despachador.ts` no llama al modelo. El modelo no recibe
  herramientas.

**Entrada:**

- Primero `redact()` (`packages/core/src/redact.ts`) tapa secretos.
- Luego `fence()` (`packages/core/src/untrusted.ts`) mete los datos en `<datos_no_confiables origen="…">` como JSON,
  con `<` y `>` escapados como `\u003c` y `\u003e`: un dato no puede cerrar la etiqueta. También marca banderas deterministas de
  inyección (orden de ignorar instrucciones, etiquetas de rol, «no avises», tubería a shell, borrados, base64 largo,
  caracteres invisibles), mirando el texto en NFKC y sin invisibles.
- La wiki redacta y neutraliza las etiquetas `<repo_*>` antes de armar el prompt (`packages/deepwiki/src/redactar.ts`).

**Salida:**

- JSON con esquema → zod → `checkSalidaIA` sobre **cada string ya parseado**. Se descarta si trae URLs fuera de la
  lista (supabase.com, cloudflare.com, github.com, osv.dev, nvd.nist.gov), comandos destructivos (`rm -rf`,
  `drop table`, `DELETE` sin `WHERE`, desactivar RLS, `git push --force`…), tuberías a shell, el canario del prompt de
  sistema o un secreto. Entonces se usa la plantilla de la regla.
- La wiki se sanea: sin HTML, enlaces, imágenes ni URLs; Mermaid solo con lista blanca
  (`packages/deepwiki/src/sanitizar.ts`).

**Gasto** (`apps/api/src/ia/budget.ts`, `supabase/migrations/0007_ai_config_perf.sql`,
`supabase/migrations/0012_ritmo_ia_wiki.sql`):

- Antes de llamar se **reserva el peor caso** en `ai_usage` (`vg_ai_reserve`), bajo un candado de la base; después se
  liquida con el uso real.
- Topes: ninguna llamada puede costar más de 1 USD en el peor caso. Los diarios viven en `app_config.topes` y se
  ajustan sin desplegar; la migración los deja en 1,5 USD por org (10 USD la org de demo) y 40 USD globales. Ritmo:
  10 reservas por minuto y org; desde `0012`, las rutas de la wiki (`wiki_*`) tienen su propio cupo de 20 por minuto
  para no quitarle el turno al resto. El gasto diario suma todas las rutas.
- **Escalera:** `normal` por debajo del 70 % del tope; `reduced` del 70 al 90 % (el resumen pasa de Opus a Sonnet);
  `minimal` del 90 al 100 % (solo Haiku, sin wiki); `off` desde el 100 % → plantillas.
- **Corte:** `IA_CORTE=1` (secreto del Worker) deja cero llamadas sin tocar la base. Si la key llega a su límite de
  gasto, se liquida sin coste y se usa la plantilla.
- Sin `temperature`, `top_p`, `top_k`, `tool_choice` ni `tools`.
- Nunca se registra el prompt, la salida ni la key: solo ids, tokens, coste y motivo de parada.

### 7.1 MCP de VanGUARD (`/mcp`) y «Enviar a mi IA»

La IA del cliente se conecta a `/mcp` con un token `vgk_` (E29; en la base solo su sha256). El tenant sale del token,
nunca de un argumento, y todo lo que sale pasa por `redactarParaExport` (`apps/api/src/mcp/vanguard.ts`).

- **Solo lectura para la IA.** Herramientas: `get_overview`, `get_repo_status`, `list_findings`, `get_finding`,
  `get_fix_prompt`, `list_fix_requests` y `list_incidents`; prompts: `resolver_hallazgo`, `resolver_criticos` y
  `resolver_enviados`. Ninguna escribe ni recibe un estado como argumento, y ninguna llama al modelo.
- **Cola «Enviar a mi IA»** (`supabase/migrations/0023_fix_requests.sql`, `apps/api/src/rutas/fix-requests.ts`). La web
  la llena: el botón del detalle (y de «Ahora») crea la petición (E58, `requireAdmin`; viewer y anónimo → 403) y abre
  el enlace profundo de Claude Code con `/mcp__vanguard__resolver_hallazgo <id>`: solo viaja el UUID validado, nunca
  texto del hallazgo. Estados: `enviado → arreglando → corregido`, o `cancelado` (DELETE de E58 o hallazgo ignorado).
- **Telemetría de estado, no escritura de la IA.** Al pedir la corrección (`get_fix_prompt` o el prompt
  `resolver_hallazgo`), el Worker pasa de `enviado` a `arreglando` la petición abierta de ese hallazgo, en la org del
  token, y anota el `mcp_token_id`. Es la única escritura del MCP, fija y sin argumentos de la IA; si falla, la
  corrección sale igual. `corregido` lo pone la base (trigger `vg_fix_request_cierre`) cuando el hallazgo deja de estar
  abierto: auto-verificación de la auditoría (`vg_upsert_findings`), «Marcar corregido» (E14) o la revisión de código.
- **Barreras en la base.** Como todo `public`: RLS y ningún privilegio para `anon` ni `authenticated` (solo el Worker
  toca la tabla). Las políticas dejan escrita la regla (miembros leen; owner/admin no anónimo crean una «enviado» suya
  y solo la cancelan). Trigger de transiciones (org, hallazgo y autor fijos; una cerrada no se reabre), una abierta por
  hallazgo (índice parcial único) y FK compuesta `(finding_id, org_id)`. Realtime: el mismo aviso de solo ids de `0008e`.

---

## 8. Salida de red

- Lista blanca de **hosts exactos** en `packages/core/src/egress.ts` (`HOSTS_SALIDA`): solo `https:`, sin usuario ni
  contraseña en la URL y sin puerto.
- `pedir()` (`apps/api/src/lib/http.ts`) la aplica antes de cada `fetch` del Worker a un proveedor (Management API de
  Supabase, Cloudflare, GitHub, OSV, Kapso). La salida de la wiki pasa por `salidaGithub`
  (`apps/api/src/wiki/deps.ts`) con la misma lista.
- **Redirecciones en `manual`:** se siguen hasta 3 y solo si el destino es el mismo host. Con `follow`, la cabecera
  `Authorization` viajaría a otro host.
- El log dice el motivo del bloqueo, nunca la URL (puede traer un secreto en la query). Las respuestas de la Management
  API de Supabase se cortan a 300 KB sin decodificarlas enteras.

**ZIP de código: el archivo no sube al servidor.** (Distinto del repo conectado por GitHub, que el Worker sí lee por la
API de GitHub.) «Analizar un ZIP» (página Codebase, desplegado) abre el archivo en un Web Worker del navegador
(`apps/web/src/modulos/codebase/zip/`, con fflate). Antes de abrirlo se comprueban la extensión, el tamaño (≤ 25 MB) y
la firma `PK\x03\x04` (`zip-local.ts`). Al descomprimir se cuentan los bytes reales,
no los declarados, y se corta al pasar los topes de `LIM` (`zip/tipos.ts`: ≤ 20 000 entradas, ≤ 1 MB por archivo
leído, ≤ 40 MB en total): un ZIP que miente sobre su tamaño no llena la memoria. Las rutas con `..`, unidad o
caracteres de control se descartan (`zip/leer.ts`). Lo único que se prepara para enviar es la lista de dependencias y
los hallazgos con la evidencia recortada (`ZipResult` en `packages/contracts/src/api.ts`: `evidence` estricto,
`preview` ≤ 12 caracteres). La ruta del servidor que recibe ese resultado todavía no existe (sección 15).

---

## 9. Cabeceras, CSP y rutas del Worker

**SPA.** El plugin `vg-headers` de `apps/web/vite.config.ts` genera `dist/_headers`. En producción hoy:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  font-src 'self'; connect-src 'self' https://<ref>.supabase.co/auth/v1/ wss://<ref>.supabase.co/realtime/v1/;
  frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
```

`script-src 'self'` va sin `'unsafe-eval'`: zod corre sin JIT y el plugin `zodSinJitPrimero` del mismo archivo hace
fallar el build si algún módulo pudiera usar `Function()` antes de apagarlo.

**API.** `apps/api/src/mw/security-headers.ts` pone `Cache-Control: no-store`, `nosniff`, `Referrer-Policy:
no-referrer`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
`Cross-Origin-Resource-Policy: same-origin`, y borra `Access-Control-Allow-Origin` (mismo origen: nunca CORS).
`originGuard` (`apps/api/src/mw/origin.ts`) responde 403 a un POST, PUT, PATCH o DELETE con `Origin` de otro host.
Cuerpo ≤ 1 MB en `/api` y en los webhooks.

**`run_worker_first`** (`apps/api/wrangler.jsonc`): pasan por el Worker `/api/*`, `/ingest/*`, `/webhooks/*`, `/mcp`,
`/mcp/*` y `/.*`, salvo `/.well-known/security.txt`. Así `/.env` y `/.git/config` dan 404 JSON y no la portada con 200.
El resto de la SPA son assets: no gastan CPU del Worker.

---

## 10. Zona `officialvanguard.com` y límites de tasa

Comprobado el 24-oct con DNS sobre HTTPS y `curl`:

| Ajuste | Estado | Cómo comprobarlo |
|---|---|---|
| DNSSEC | Activo (DS 2371, algoritmo 13); las respuestas llegan validadas (bandera AD) | `dig +dnssec DS officialvanguard.com` |
| Correo | SPF `v=spf1 -all`; DMARC `p=reject; sp=reject; adkim=s; aspf=s`; sin MX. El dominio no envía correo: nadie puede mandar «alertas de VanGUARD» falsas desde él | `dig TXT _dmarc.officialvanguard.com` |
| HTTP → HTTPS | 301 | `curl -sI http://officialvanguard.com/` |
| `www` → apex | 301 a `https://officialvanguard.com/` | `curl -sI https://www.officialvanguard.com/` |
| TLS | Acepta 1.2 y 1.3; una conexión limitada a 1.1 falla | `curl --tlsv1.3 …` y `curl --tls-max 1.1 …` (o SSL Labs) |

Ajustes de la zona que no viven en el repo (los aplicó el equipo en el panel de Cloudflare): SSL Full (strict), TLS
mínimo 1.2 y Automatic HTTPS Rewrites. Bot Fight Mode está apagado a propósito (sección 14).

**Regla de rate limit de la zona: activa, pero no versionada.** La regla existe en la fase `http_ratelimit` de la zona:
`starts_with(http.request.uri.path, "/api/")`, 400 peticiones por 10 s por IP y ubicación (`ip.src` + `cf.colo.id`),
con bloqueo de 10 s. Se comprobó leyendo el ruleset por la API de Cloudflare el 24-oct-2026 a las 17:46 UTC. No está
versionada en el repo y no la disparamos contra producción para no bloquear nuestra propia IP. Los límites que sí
están en el código son los del Worker, abajo.

**HSTS todavía no está activo:** ni la SPA ni la API envían `Strict-Transport-Security`. Se enciende en la zona cuando
apex, `www` y `demo` respondan por HTTPS; hoy `demo.officialvanguard.com` aún no tiene registro DNS (sección 15).

**Límites del Worker** (`ratelimits` en `apps/api/wrangler.jsonc`):

| Límite | Cupo | Clave | Dónde se usa |
|---|---|---|---|
| `RL_API` | 300 por 60 s | usuario; IP en rutas públicas y webhooks | `apps/api/src/mw/rate.ts` |
| `RL_COSTLY` | 10 por 60 s | usuario o aprobación | proponer y confirmar bloqueos, exportar, probar avisos |
| `RL_INGEST` | 300 por 10 s | conexión, tras autenticar | `apps/api/src/rutas/ingest.ts` |
| `RL_WA` | 3 por 60 s | teléfono | respuestas a WhatsApp (`apps/api/src/rutas/webhooks-kapso.ts`) |

---

## 11. Datos que guardamos y cuánto tiempo

Borrado automático con pg_cron (`supabase/migrations/0008_rls_retention.sql`): tráfico (`edge_hits`) 24 h; muestras
de métricas, eventos de webhook y aprobaciones 7 días; notificaciones 30 días; auditorías, hallazgos cerrados,
incidentes resueltos y uso de IA 90 días; usuarios anónimos de «Ver demo» 7 días.

---

## 12. Pruebas de seguridad que existen

| Prueba | Qué demuestra | Cómo se corre | Último resultado |
|---|---|---|---|
| `packages/core`: `crypto`, `key-guards`, `otp`, `untrusted`, `redact`, `egress`, `ip` (`*.test.ts`) | Sobre y AAD, rechazos de claves, códigos sin sesgo, cercado y filtro de salida, redacción, lista de salida, simulación de bloqueo | `pnpm --filter @vanguard/core test` | 227/227 en esos 7 archivos (24-oct) |
| `apps/api`: `src/lib`, `src/actions`, `src/ia`, webhooks, ingesta, conexiones, acciones y acceso | HMAC antes de parsear, dedupe, canje de un solo uso, guardas en la ruta, filtro de salida de la IA | `pnpm --filter @vanguard/api test` | 299/299 en esos 13 archivos (24-oct) |
| `test:fuga` (`apps/api/scripts/leak-test.ts`) | Sella un canario y comprueba: 0 apariciones en `sealed` y en `connections`, vuelve entero con `withSecret` y no abre desde otra org | `pnpm --filter @vanguard/api test:fuga` (necesita los secretos reales) | «0 apariciones» (commit `c3d1648`) |
| `test:idor` (`apps/api/test/idor.mjs`) | B pide recursos de A → 404; ids de A por la ruta de B → el mismo 404 que un id inexistente o malformado; `/api/me` solo lista lo propio; SELECT directo con la clave publicable y sesión a las 19 tablas y vistas de su lista fija → 42501 (`wiki_runs` llegó después y solo la cubre `rls.sql`, que recorre todo `public`) | `pnpm --filter @vanguard/api test:idor` | Verde contra producción (commit `ffa387c`) |
| `supabase/tests/rls.sql` | Ninguna tabla sin RLS; `anon` y `authenticated` sin SELECT, sin escritura, sin Vault y sin `vg_crypto_material`; toda función `definer` con `search_path`; aislamiento con JWT simulado dentro de `rollback` | Editor SQL o MCP tras cada migración | OK (commit `c3d1648`, último resultado registrado; `0009`, `0010` y `0012` llegaron después) |
| `supabase/tests/fix-requests.sql` | Una petición abierta por hallazgo, FK a un hallazgo de la misma org, transiciones, cierre al verificar/corregir/ignorar el hallazgo, políticas (viewer y anónimo no crean ni cancelan; nadie ve otra org) y `anon`/`authenticated` sin privilegios | Editor SQL o MCP tras aplicar `0023` | Ensayado en un Postgres 16 local con un esquema mínimo de Supabase (25-oct); falta correrlo en el proyecto |
| `apps/api`: `src/mcp/mcp.test.ts`, `src/rutas/fix-requests.test.ts` | El MCP no escribe salvo `enviado → arreglando` del hallazgo pedido en la org del token; E58 idempotente, 403 a viewer y anónimo, 409 a un hallazgo cerrado | `pnpm --filter @vanguard/api test` | Verde (25-oct) |
| Arnés XSS e IDOR del FRONT (`apps/web/src/seguridad/xss.test.tsx`, `idor.test.tsx`) | Todo texto del servidor (evidencia, user agents, salida del modelo) se pinta como texto; un id que no es UUID no llega a la API; la UI no distingue «no existe» de «es de otra org» | `pnpm --filter @vanguard/web test` | 593/593 en esos 2 archivos (24-oct) |
| Lector y análisis del ZIP (`apps/web/src/modulos/codebase/**/*.test.ts(x)`) | Rutas hostiles (`../`, unidad, U+202E), cabecera local y directorio central que no casan, más de 20 000 entradas, entradas que declaran 10 B y traen 2 MB, más de 40 MB descomprimidos, ZIP truncado o que no es ZIP | `pnpm --filter @vanguard/web test` | 74/74 en 6 archivos (24-oct) |
| `lint-seguridad` (`apps/web/scripts/lint-seguridad.mjs`) | Prohíbe `dangerouslySetInnerHTML`, `innerHTML`, `eval`, tokens en la URL, en `localStorage`, en la consola o en claves de caché | Dentro del `build` de `apps/web` | OK; una violación impide el despliegue |
| `lint-imports` (`scripts/lint-imports.mjs`) | `apps/web` no importa `@vanguard/core` (cifrado, guardas, redacción), salvo `apps/web/src/modulos/codebase/zip/`, el análisis local del ZIP en su Web Worker; fuera de ella nadie importa su lector ni su worker de forma estática | Dentro del `build` de `apps/web`; `pnpm lint:imports` | OK (24-oct) |

El `build` de `apps/web` (comando de build del despliegue) corre `lint-seguridad`, `lint-imports` y `tsc` antes de
`vite build`: si alguno falla, no se publica nada y sigue en línea la versión anterior.

---

## 13. Corre en el plan Free de Workers: cifras medidas

Diseño (`apps/api/wrangler.jsonc`): sin bloque `limits` (en Free no se pueden subir). La auditoría va por pasos en la
cola `vg-jobs`, un mensaje por invocación (`max_batch_size: 1`), con 3 reintentos y cola de mensajes muertos. Cada
invocación se fija un techo de 40 de las 50 subpeticiones del plan (`PRESUPUESTO` en
`apps/api/src/rutas/webhooks-kapso.ts`, `TOPE_SUBPETICIONES` en `apps/api/src/wiki/deps.ts`). La SPA son assets.

| Qué | Cifra | Fuente |
|---|---|---|
| Paso de cola con 40 respuestas de OSV | **21–25 ms de CPU** (≈ 1,2 s de reloj), todos «ok» | `docs/PASOS_MANUALES_GIOVANNI.md` (paso 4); commit `a4828aa` |
| Corrección | Detalles de OSV por invocación: de 30 a **12** (≈ 7 ms estimados; lo caro es `JSON.parse`) | `apps/api/src/scans/osv.ts` (`DETALLE_POR_MENSAJE`) |
| `GET /api/me` | **6 ms** en caliente | commit `a4828aa` |
| `GET /api/health` | **5 ms** | commit `a4828aa` |
| Cron por minuto | 0 ms | commit `a4828aa` |
| Paso `supabase` con respuestas de 750 KB | 12–17 ms de CPU y muerte por CPU (error 1102, a la cola de mensajes muertos) → tope de **300 KB** por respuesta (≈ 7 ms medidos en Node) | `apps/api/src/scans/supabase.ts` (`MAX_RESPUESTA`); commit `58a052c` |
| `redact()` con texto hostil (denegación por CPU) | Era cuadrático: 12.000 caracteres de dígitos y puntos costaban **247 ms**; 192 KB de `postgres://u:` sin `@`, **1,45 s**; cabeceras de clave privada sin pie, **84 ms**. Ahora lineal: **0,08 ms**, **0,7 ms** y **1,0 ms**. Los JWT con `eyJ-` repetido (48 KB): 539–650 ms → **0,1–1,9 ms**, y con una clave tapable delante 1,6–1,7 s → **≤ 2 ms** (commit `585b161`). Cero diferencias de resultado entre la versión vieja y la nueva en 95.793 cadenas (más 220.000 del fuzz de la verificación adversarial). Pruebas por proporción en 31 familias hostiles (doblar el texto cuesta ≤ 3×) | `packages/core/src/redact.ts`; commit `06a5c26` (Node 24, mejor de 3) |
| Filtro de la salida de la IA con texto hostil (`checkFixPrompt`, `scanInjection`) | La salida de la IA la puede dirigir una inyección y el `fix_prompt` admite 20.000 caracteres. Con 48 KB hostiles: conexión sin `@` 166–262 ms → **1,2–1,5 ms**; JWT `eyJ-` 882 ms → **2,6 ms**; etiqueta de rol sin `>` 218 ms → **1,4 ms**; prefijo de rol con saltos repetidos 1,5 s → **1,1 ms**. Una sola fuente para la regex de conexión (la de `redact.ts`). Cero diferencias en 15,3 millones de casos exhaustivos, 364.622 comparaciones del corpus y 250.000 cadenas de fuzz | `packages/core/src/untrusted.ts`; commit `26bf3af` (Node 24) |

Lectura honesta: 21–25 ms supera los 10 ms nominales del plan Free. Cloudflare no cortó esos pasos, pero no contamos
con esa tolerancia: por eso se bajó la carga por paso y se puso tope al tamaño de las respuestas.

---

## 14. Avisos aceptados

| Aviso | Por qué se acepta | Qué lo acota |
|---|---|---|
| `style-src 'unsafe-inline'` | Los diálogos de Radix (`react-remove-scroll-bar`) inyectan un `<style>` | `script-src 'self'` sin inline; `lint-seguridad` y arnés XSS |
| Sesión de Supabase en `localStorage` | Comportamiento por defecto de supabase-js (`apps/web/src/lib/supabase.ts`) | CSP sin scripts externos ni inline; `lint-seguridad`; arnés XSS |
| Registro con correo abierto, sin confirmación y sin CAPTCHA | Fricción mínima para el jurado; las cuentas no reciben correo | Cada cuenta solo ve sus propias orgs; CAPTCHA en la hoja de ruta |
| Inicio de sesión anónimo activo («Ver demo») | El jurado ve el producto sin crear cuenta | Solo `viewer` de la org de demo, sin escritura (`apps/api/src/mw/anon.ts`); se borran a los 7 días |
| En la org de demo, el código de bloqueo puede volver en la respuesta | La demo no debe depender de que WhatsApp entregue | Solo en la org `is_demo`; en las demás, 502 sin crear nada (`proponerBloqueo` en `apps/api/src/actions/approvals.ts`). El bloqueo dura 1 h y tiene «Deshacer» |
| Los botones de WhatsApp no comprueban la IP propia | El webhook no trae la IP de quien pulsa | El remitente debe ser un contacto verificado de la org; nonce de un solo uso que vence en 10 min |
| Bot Fight Mode apagado | En Free no admite excepciones y desafiaría a los webhooks, que no ejecutan JavaScript | Límites del Worker y la regla de rate limit de la zona en `/api/` (sección 10) |
| La regla de rate limit de la zona no filtra por host (limitación de Free) y no está versionada (sección 10) | Contaría también `/api/*` de `demo.officialvanguard.com` cuando exista | Umbral de 400/10 s, por encima del ataque simulado de la demo (~20 req/s). Aun así, una sola IP insistente podría agotar la cuota diaria de 100.000 peticiones del Worker |
| Un lote de ingesta firmado se puede reenviar dentro de los 300 s | No hay dedupe por lote | Hace falta el secreto de esa conexión; solo afecta a los datos de la propia org |
| Sin sondeo negativo del token de acciones de Cloudflare | Solo se comprueba que lee las reglas de acceso | La guía pide solo Firewall Services · Edit; cada bloqueo exige código y solo se borran reglas propias |
| `supabase-js` y el SDK de Anthropic no pasan por la lista de salida | Hablan con su host fijo, no con URLs que vengan de datos | Las URLs que salen de datos (repo, proveedores) sí pasan por `assertAllowedUrl` |
| Un solo proyecto Supabase para desarrollo y producción | Plan gratuito, sin branching | `test:idor` usa usuarios y orgs de prueba propias; `rls.sql` corre en una transacción con `rollback` |
| Rangos IP de Cloudflare copiados en el código | Evita una llamada por propuesta | Hay que revisarlos si Cloudflare publica rangos nuevos (`RANGOS_CLOUDFLARE` en `apps/api/src/actions/block-ip.ts`) |

---

## 15. Hoja de ruta (no hecho todavía)

- **HSTS** en la zona (`max-age` 15552000, `includeSubDomains`, sin `preload`): domingo 25-oct, tras confirmar HTTPS
  en apex, `www` y `demo`.
- **Versionar la regla de rate limit de la zona** y probarla en un entorno aparte (hoy está activa, pero solo vive en
  la configuración de la zona, sección 10).
- **Rotación completa de la KEK:** crear `kek_v2` en Vault, un proceso que recorra `connection_secrets` con `rewrap()`
  y la pimienta anterior (`VG_KEK_PEPPER_PREV`) durante la ventana. Hoy están las piezas (3.4), no el proceso.
- **Rotar el token de un cliente** sin perder su historial: la función SQL `vg_rotate_secret` existe en
  `0003_connections_crypto.sql`, pero ninguna ruta la llama.
- **Más sondeos negativos:** token de acciones de Cloudflare, PAT de GitHub, y PAT de Supabase con acceso a más de un
  proyecto.
- **Dedupe de lotes de ingesta** dentro de la ventana de 300 s.
- **CAPTCHA** (Cloudflare Turnstile) en registro e inicio de sesión, y **MFA** (TOTP).
- **Registro de auditoría** de las acciones de los administradores.
- Correr las **pruebas unitarias dentro del build** de despliegue (hoy corren los lints y `tsc`).
- **Recibir el resultado del ZIP en el servidor:** el análisis en el navegador ya está en `main` y desplegado
  (sección 8), pero la ruta E23 `POST /api/orgs/:org/scans/:id/zip-result` solo existe en los datos simulados del
  FRONT (`apps/web/src/lib/fixtures/`); la API todavía no la tiene.
- **Lista de IPs permitidas por org** para «Bloquear IP»: `simularBloqueo` ya la admite, falta dónde guardarla y la
  pantalla.
