# Varias codebases por organización y wiki por repo: especificación y encargos

Especificación del ORQUESTADOR (sáb 24-oct, ~19:00 Caracas; corregida ~19:40 con la revisión, §13). Congelación de BACK
y FRONT: domingo 07:00. Entrega: domingo 12:00.

Pedido literal de Giovanni: «Agrega también que en una misma organización pueda haber más de una codebase y el wiki del
repo debe estar activado para la demo o los repos dependiendo de cuántos repositorios tengas configurados en tu
organización.»

Lectura del pedido: una org conecta varios repos de GitHub (uno por conexión, cada uno con su token). La auditoría, el
módulo Codebase, la revisión en cada push y la wiki funcionan por repo. En la demo, cada repo conectado a «Tienda Demo»
tiene su wiki ya generada y el jurado (viewer anónimo) la abre gratis.

Código leído antes de decidir: `apps/api/src/rutas/{connections,revision,wiki,scans,overview}.ts`, `apps/api/src/jobs.ts`,
`apps/api/src/lib/credentials.ts`, `apps/api/src/scans/{index,repo-paso,comun,cobertura,repo}.ts`,
`apps/api/src/estado/modulo.ts`, `apps/api/src/wiki/{corridas,deps,pasos}.ts`, `apps/api/src/revision/pasos.ts`,
`apps/api/src/rutas/webhooks-github.ts`, migraciones 0003, 0004, 0008f, 0010, 0011 y 0013, `supabase/seed/demo.sql`,
`packages/contracts/src/{api,wiki,estado,codebase}.ts` y `fixtures/`,
`packages/core/src/{crypto.ts,secrets/scan.ts,templates/revision.ts}`, `packages/deepwiki/src/{estimar,pipeline,filtros}.ts`,
la web (`modulos/codebase/{PaginaCodebase,TarjetaRevisionCodigo}.tsx`, `modulos/wiki/PaginaWiki.tsx`,
`modulos/conexiones/{PaginaConexiones,TarjetaConexion}.tsx`, `modulos/resumen/PaginaResumen.tsx`,
`modulos/auditoria/pasos.ts`, `componentes/vg/{PantallaModulo,BotonRevisar}.tsx`, `lib/{consultas,mutaciones}.ts`,
`lib/fixtures/router.ts`), `demo/guion.md` y la especificación paralela `bloqueo-merge-criticos.md`.

> **Lo que hay que respetar.** «Generar otro secreto» (E46 `rotate_secret`) ya está en `main` (2460162 api, f92b137 web):
> B6 y F2 se hacen encima. **Otras especificaciones tocan los mismos sitios**: `bloqueo-merge-criticos.md` (E8, E10, E45,
> `conexionGithub` de `revision.ts` y el fixture `…0006`; ver §2.6) y `modo-bajo-ataque.md` (E8 y E10, en las ramas de
> Cloudflare). Quien llegue segundo integra sobre lo que haya en `main`.

---

## 0. Decisiones en una tabla

| # | Tema | Decisión | Por qué |
|---|---|---|---|
| 1 | Unidad | **Una conexión GitHub de lectura = un repo.** Varias por org. | `connections` ya lo admite (meta.repo_full_name obligatorio, sin único por proveedor). `code_review_configs` es único por conexión: la revisión ya es por repo. |
| 2 | PAT | **Un token por repo, obligatorio.** El mismo PAT no entra en dos conexiones de una org: 409 «Ese token ya está conectado en esta organización.» | `connection_secrets` tiene `unique (org_id, fingerprint)` (0003:36) y la huella es HMAC de `org\|token` (`core/crypto.ts:69-71`): el mismo PAT en la misma org da la misma huella y `credentials.ts:17` responde 409. Sin migración: el único se queda (lo usan `fingerprintsOfOrg` y el `same_token` del bloqueo). Además: mínimo privilegio y revocación por repo. |
| 3 | Tope | **5 repos por org** (`MAX_REPOS_GITHUB`): nombres de repo distintos (en minúsculas) entre las conexiones GitHub **de lectura**, en cualquier estado. | Auditoría completa ≤ ~45 mensajes de cola; dura menos que los 15 min del vigilante; 5 pestañas caben a 375 px. Por nombres y no por filas: el «Reconectar» de hoy deja parejas del mismo repo. La conexión de estados del bloqueo (`kind 'action'`) no cuenta. |
| 4 | Duplicados | Mismo repo (nombre en minúsculas o `repo_id`): **activo → 409 `repo_duplicado`**. **No activo → E8 lo reconecta**: sella el token nuevo con el `connection_id` existente y llama a `vg_rotate_secret` (0003:73-84, ya existe; deja la conexión `active`). | Mismo id: se conservan hallazgos, config de revisión, webhook y `meta`. Hoy «Reconectar» crea otra conexión; con un 409 por cualquier estado dejaría de funcionar, y rehacer la conexión de la demo duplicaría sus hallazgos a horas del pitch. |
| 5 | Hallazgos | **La clave de los hallazgos de código lleva el repo** en las conexiones nacidas con `meta.hallazgos_por_repo: true`, que E8 pone **solo si la org ya tiene otra conexión GitHub de lectura** (de otro repo). La primera conexión, las de antes y las reconectadas conservan su clave. | Hoy `dedupe_key = sha256(org\|regla\|recurso)`: el mismo `lodash@4.17.15` o el mismo `.env` en dos repos serían UNA fila, y la auto-verificación de un repo cerraría el hallazgo del otro. Re-clavar la conexión de la demo duplicaría sus hallazgos: no se toca. |
| 6 | Auditoría | El paso `repo` **recorre los repos en orden** (el más antiguo primero), **un mensaje de cola por repo** (más sus rondas de OSV). Un repo que falla no corta a los demás y el paso queda `done` con `error_code` **`parcial`** (el FRONT ya lo pinta «Hecho en parte»). `steps[]` no cambia. | Cada repo con su presupuesto de 40 subpeticiones y 10 ms. Sin migración ni cambio en `vg_claim_step`/`vg_mark_step`. Un código nuevo en el paso saldría en verde en el FRONT de hoy (`auditoria/pasos.ts:28-33`). |
| 7 | Repo principal | Sin `connection_id`, todo lo que elige «la» conexión GitHub usa **la activa más antigua** (hoy: la más nueva; en `revision.ts`, la más nueva sin mirar el estado). | Hoy, conectar un 2.º repo a «Tienda Demo» haría que la auditoría completa mirase el repo nuevo y no el de la víctima. Es lo primero que se arregla (B0). |
| 8 | Cobertura y chequeos | Codebase cuenta como visto si **al menos un repo** se miró bien. Pero un **chequeo** de E6 solo sale comprobado si **cada repo activo** tiene su último intento `done` con esa mirada. Detalle por repo en `ScanRun.repos` y en la cifra «Repos revisados». | Nunca verde sin mirar: lo que miró un repo no da por mirado a otro. |
| 9 | Resumen | Puntaje y conteos **agregados**. El repo de cada hallazgo viaja por `connection_id` (ya en `Finding`; nuevo opcional en `AhoraItem`) y el FRONT lo pinta como chip con ≥ 2 repos. **El chip no se recorta.** | El recurso visible no cambia: no se rompe ningún filtro ni prompt. Sin chip, dos hallazgos con el mismo título y recurso en dos repos se verían iguales. |
| 10 | Revisión por push | **E45 recibe `?connection_id=`**; la tarjeta de Codebase es una por repo. Contrato de respuesta sin cambios. | Compatible: el FRONT actual sigue funcionando (sin parámetro = repo principal). |
| 11 | Wiki | E40–E44 ya son por repo. **B8:** E40/E41 exigen que el repo pedido sea el de la conexión. **B7:** «auditado» por repo con la cobertura. La página lista **todos** los repos conectados, con el estado de su wiki, y abre sola la última wiki lista (F3, no se recorta). | Ver una wiki es gratis y ya lo puede hacer el anónimo; sin B8 un admin podría publicar a todos los miembros la wiki de un repo privado no conectado. |
| 12 | Demo | Giovanni **comprueba hoy** a mano el token de la demo, su rol en «Tienda Demo» y las conexiones repetidas, y **genera** la wiki del repo de la víctima (~US$ 0,04; techo US$ 0,08) y la de cada repo que conecte a la demo. | El guion ya dice «una wiki generada antes del pitch, no en vivo». El MCP de Supabase no conectó: nada de esto está comprobado en producción. |
| 13 | Rutas y migración | **Ninguna ruta nueva** (E57 queda libre). **Ninguna migración** (0018 queda libre). | Todo cabe en E6, E8, E11/E12, E5, E40/E41, E45 y la cola. |
| 14 | Bloqueo de merge | **Un repo por org**: el del token de estados (§2.6). | Lo fija el índice único de 0016. Sin esto, la otra especificación publicaría el estado en el repo equivocado y E10 borraría el token de estados de otro repo. |

---

## 1. Lo que hay hoy (comprobado en el código)

1. **E8 impide el segundo repo solo si hay uno activo.** `rutas/connections.ts:154-157`: cuenta las GitHub `active` y,
   si hay alguna, 409 «Ya hay un repo conectado. Quítalo antes de conectar otro.» Si la que hay está revocada, vencida o
   en error, deja crear otra. «Reconectar» (`TarjetaConexion.tsx:103`, `PantallaModulo.tsx:48-57`) lleva al asistente,
   que crea **otra** conexión: en producción puede haber ya parejas del mismo repo (una vieja no activa y otra activa).
2. **El mismo PAT no entra dos veces en una org.** `connection_secrets` tiene `unique (org_id, fingerprint)` (0003:36);
   `fingerprint` = HMAC de `orgId|secret.trim()` (`core/crypto.ts:69-71`); `vg_create_connection` es atómica y
   `credentials.ts:17` convierte el 23505 en 409 «Ese token ya está conectado en esta organización.»
   `fingerprintsOfOrg` (`credentials.ts:81`) y el `same_token` de `bloqueo-merge-criticos.md:293` dependen de ese único.
   `vg_rotate_secret` (0003:73-84) existe y no lo llama nadie todavía.
3. **La auditoría elige UN repo, el más nuevo.** `scans/comun.ts:24` (`conexionActiva`): `params.connection_id` o la
   conexión activa más reciente (`order created_at desc limit 1`). `jobs.ts:44`: `full_audit` tiene un solo paso `repo`.
   `revocarConexion` (`jobs.ts:166-172`), sin `connection_id`, revoca la que elija `conexionActiva`; `repo-paso.ts` no
   usa `conConexion`, así que un 401 llega sin id.
4. **E45 asume un repo.** `rutas/revision.ts:37-48` (`conexionGithub`) toma la conexión GitHub de lectura más reciente
   **sin filtrar el estado**; la config y las revisiones se leen por org (`revision.ts:102-108`, `limit(1)` y las 10
   últimas de la org, mezclando repos si hubiera varios).
5. **El FRONT asume un repo.** `PaginaCodebase.tsx:13`, `PaginaWiki.tsx:213` (solo la activa), `TarjetaConexion.tsx:121`,
   `PantallaModulo.tsx:43`, `PaginaResumen.tsx:55` (chapa de la tarjeta Codebase del Resumen) y
   `lib/fixtures/router.ts:524` (`githubDe`) hacen `find(github read)`. El secreto `vgw_` de la tarjeta se guarda por org
   (`lib/mutaciones.ts:129`) y `setQueryData` usa la clave exacta `['org', org, 'revision']` (`mutaciones.ts:140`).
6. **Colisión de hallazgos entre repos.** `packages/core/src/crypto.ts:73`: `dedupe_key = sha256(org|regla|recurso)`, y el
   recurso de código no lleva el repo (`.env`, `src/x.ts:12`, `npm:lodash@4.17.15`). `vg_upsert_findings` (0004:64-71)
   hace `on conflict (org_id, dedupe_key)` **sin tocar `connection_id`**, y auto-verifica por `connection_id`. Con dos
   repos y la misma dependencia vulnerable: una sola fila, atribuida al primero; si el primero la arregla, la fila queda
   «verificada» aunque el segundo siga vulnerable. La revisión por push (0013) usa la misma clave.
7. **La wiki ya es por repo, pero no comprueba el repo de la conexión.** E40/E41 reciben `repo_full_name` y
   `connection_id`; `conTokenGithub` (`wiki/deps.ts:79-91`) comprueba id, org, GitHub, lectura y activa, **no
   `meta.repo_full_name`**, y E40/E41 (`rutas/wiki.ts:66-69`, `117-120`) usan ese token con el repo del cuerpo. E43 filtra
   por `?repo=`; `wiki_runs` guarda ambos. `hallazgosDelRepo` (`wiki/corridas.ts:84`) lista las conexiones GitHub **sin
   filtrar `kind`** (línea 86) y da por auditado un repo con cualquier auditoría sin `params.connection_id` (97-99).
8. **El anónimo ve las wikis solo con la conexión activa.** E7, E42, E43 y E44 son de lectura para cualquier miembro.
   La página preselecciona el repo de la conexión GitHub **activa** (`PaginaWiki.tsx:213`) y el campo para escribir otro
   repo está oculto al viewer (línea 271): con la conexión caída, el anónimo no ve ninguna wiki. Con ella activa, tiene
   que pulsar una fila del historial.
9. **E6 da los chequeos de Codebase por la última auditoría con paso `repo` o `zip`, de cualquier tipo**
   (`estado/modulo.ts:108-116`, `158`): con dos repos, lo que miró uno valdría para todos.
10. **El aviso de WhatsApp de la revisión nunca lleva el nombre del repo** (`core/templates/revision.ts:3`). Se mantiene.
11. **«Tienda Demo»** (`00000000-0000-4000-a000-00000000de00`) tiene una conexión GitHub (`gabgaru1/vanguard-demo-victima`,
    privada) y ninguna wiki generada. El alta de Giovanni y Gabriel como owner/admin de la demo está **comentada** en
    `supabase/seed/demo.sql:23-26` («a mano»): no está comprobada.

---

## 2. Varias conexiones GitHub por org

### 2.1 Alta del segundo, tercero… repo y «Reconectar» (E8, B1)

- Mismo formulario y misma ruta que hoy (`POST /api/orgs/:org/connections`, `provider: 'github'`). El cuerpo no cambia.
- Antes del sondeo, **una** lectura: `id, status, meta` de las conexiones GitHub **de lectura** de la org, `created_at` e
  `id` ascendentes, `limit(50)` (sustituye al `count` de hoy; las parejas viejas de «Reconectar» pueden ser muchas).
  - Si alguna **activa** tiene `meta.repo_full_name` igual al pedido (en minúsculas): 409, `details.reason:
    'repo_duplicado'`, «Ese repo ya está conectado.»
  - Si no hay ninguna del mismo nombre y ya hay `MAX_REPOS_GITHUB` (5) nombres distintos: 409, `details.reason:
    'tope_repos'`, «Ya tienes 5 repos conectados: quita uno para conectar otro.»
- Después del sondeo correcto, lo mismo por `meta.repo_id` (un repo renombrado cambia de nombre, no de id): una activa
  con ese id → 409 `repo_duplicado`. No hay carrera que importe: es una acción de admin.
- **Reconectar.** Si hay una del mismo repo (por nombre o por `repo_id`) que no está activa: se sella el token nuevo con
  el `connection_id` EXISTENTE en el AAD y se llama a `vg_rotate_secret`, que deja la conexión `active` con `last4`,
  `scopes`, `capabilities` y `expires_at` nuevos. Respuesta: 201 `ConnectionCreated` con esa conexión. Se conservan el id,
  los hallazgos, la config de revisión, el secreto del webhook, el `label` y la `meta` (con su marca o sin ella). De
  varias no activas del mismo repo, **la más antigua**: es la que tiene los hallazgos (`vg_upsert_findings` no reasigna
  `connection_id`).
- **Token.** El mismo PAT de otra conexión de la org da 409 «Ese token ya está conectado en esta organización.» al crear
  (como hoy) y también al reconectar (`vg_rotate_secret` choca con el mismo único). Pegar de nuevo el MISMO token en la
  misma conexión vale (es la misma fila).
- **Marca.** Una conexión **nueva** se guarda con `meta: { ...sondeo.meta, hallazgos_por_repo: true }` solo si la org ya
  tiene alguna conexión GitHub de lectura (de otro repo: las del mismo van por «Reconectar»). La primera conexión de una
  org conserva la clave de hoy. Ni E9 ni `vg_rotate_secret` tocan `meta`: la marca se conserva.

```ts
// rutas/connections.ts, rama github de E8 (sustituye el count y el 409 «Ya hay un repo conectado»).
// Antes del if/else de proveedores: let reconectar: Previa | null = null; let hallazgosPorRepo = false;
type Previa = { id: string; status: string; meta: Record<string, unknown> | null };
const { data, error } = await admin.from('connections').select('id, status, meta').eq('org_id', orgId)
  .eq('provider', 'github').eq('kind', 'read').order('created_at').order('id').limit(50);
if (error) throw new ApiError('internal', 'No pudimos comprobar tus conexiones');
const previas = (data ?? []) as Previa[];
const nombre = (f: Previa) => String(f.meta?.repo_full_name ?? '').toLowerCase();
const pedido = body.repo_full_name.toLowerCase();
const duplicado = () => new ApiError('conflict', 'Ese repo ya está conectado.', { reason: 'repo_duplicado' });
const porNombre = previas.filter((f) => nombre(f) === pedido);
if (porNombre.some((f) => f.status === 'active')) throw duplicado();
if (!porNombre.length && new Set(previas.map(nombre)).size >= MAX_REPOS_GITHUB) {
  throw new ApiError('conflict', `Ya tienes ${MAX_REPOS_GITHUB} repos conectados: quita uno para conectar otro.`, { reason: 'tope_repos' });
}
sondeo = await probarGithub(token, body.repo_full_name);
if (sondeo.estado === 'ok') {
  const id = sondeo.meta.repo_id;
  const porId = previas.filter((f) => id !== undefined && f.meta?.repo_id === id);
  if (porId.some((f) => f.status === 'active')) throw duplicado();
  reconectar = porNombre[0] ?? porId[0] ?? null;          // la más antigua: es la que tiene los hallazgos
  hallazgosPorRepo = !reconectar && previas.length > 0;    // ya hay otro repo: clave por repo (§2.2)
}
// … después de exigirSondeo(sondeo), antes de createConnectionWithSecret:
if (reconectar) {
  await rotarSecretoConexion(env, admin, { orgId, connectionId: reconectar.id, provider: 'github', kind: 'read' }, token,
    { scopes: sondeo.scopes, capabilities: sondeo.capabilities, expiresAt: sondeo.expiresAt });
  const [fila] = await leer(c, [reconectar.id]);
  log('info', 'connection.reconectada', { rid: c.get('rid'), provider: 'github' });
  return c.json(ConnectionCreated.parse({ connection: fila, action_connection: null, checks: sondeo.checks, ingest_secret: null }), 201);
}
// … y en createConnectionWithSecret: meta: hallazgosPorRepo ? { ...sondeo.meta, hallazgos_por_repo: true } : sondeo.meta
```

```ts
// lib/credentials.ts (el ÚNICO módulo que toca connection_secrets). Lo usan E8 (aquí) y E53 (bloqueo-merge-criticos.md):
// una sola función para los dos.
// «Reconectar» sin perder historial: sella el token con el connection_id EXISTENTE en el AAD y llama a vg_rotate_secret
// (0003), que deja la conexión active. Mismo id: se conservan hallazgos, config de revisión y meta.
export async function rotarSecretoConexion(env: CloudflareBindings, admin: SupabaseClient, ctx: SecretCtx, token: string,
  c: { scopes: string[]; capabilities: Record<string, boolean>; expiresAt: string | null }) {
  const keys = await getKeys(env, admin, await activeKid(admin));
  const sealed = await seal(keys, token, ctx);
  const { error } = await admin.rpc('vg_rotate_secret', { p_org: ctx.orgId, p_conn: ctx.connectionId,
    p_secret: { sealed, kid: keys.kid, fingerprint: await fingerprint(keys, ctx.orgId, token) }, p_last4: last4(token),
    p_scopes: c.scopes, p_capabilities: c.capabilities, p_expires_at: c.expiresAt });
  if (error?.code === '23505') throw new ApiError('conflict', 'Ese token ya está conectado en esta organización.');
  if (error?.code === 'P0002') throw new ApiError('not_found', 'Conexión no encontrada');
  if (error) throw new ApiError('internal', 'No se pudo guardar la conexión.');   // nunca error.message
}
```

### 2.2 Clave de los hallazgos por repo (B2)

Regla: si la conexión tiene `meta.hallazgos_por_repo === true`, el `dedupe_input` de cada hallazgo de código lleva
delante el repo en minúsculas. El `resource` visible **no cambia**.

```ts
// scans/comun.ts
// Clave de los hallazgos de código por repo (varias-codebases §2.2). Solo conexiones nacidas con
// meta.hallazgos_por_repo: las de antes conservan su clave y sus hallazgos abiertos no se duplican.
export function claveDeRepo(meta: Record<string, unknown>): (b: Borrador) => Borrador {
  const repo = meta.hallazgos_por_repo === true && typeof meta.repo_full_name === 'string'
    ? meta.repo_full_name.toLowerCase() : null;
  return repo ? (b) => ({ ...b, dedupe_input: `${repo}|${b.dedupe_input ?? b.resource}` }) : (b) => b;
}
```

- Se aplica en `scans/repo-paso.ts` a las filas de cada `guardarHallazgos` (archivos, rondas de OSV y cierre) y en
  `revision/pasos.ts` antes de `aFila` (la conexión ya se lee con `meta`). Así un secreto visto en un push y luego en la
  auditoría sigue siendo la misma fila.
- Con el repo en la clave, la auto-verificación de `vg_upsert_findings` (por `connection_id`) vuelve a ser correcta.
- La conexión de la demo no tiene la marca: su clave es la de siempre. Una conexión del mismo repo no se vuelve a crear:
  E8 reconecta la existente, con su id y su marca (§2.1).
- `meta.repo_full_name` no se reescribe nunca (ni E9 ni `vg_rotate_secret` lo tocan): la clave no cambia aunque el repo
  se renombre.
- Efecto conocido y aceptado: el mismo secreto (misma huella) ya abierto en el repo A no crea fila nueva al aparecer en
  un push del repo B (0013 lo frena por `fingerprint_short`). Es la misma clave: se rota una vez.

### 2.3 Auditoría con varios repos

**B0, antes que nada:**

- En `conexionActiva` (`scans/comun.ts:24`), para `provider === 'github'`: orden `created_at` ascendente (e `id`
  ascendente como desempate). Ya filtra `status 'active'`.
- En `conexionGithub` de `rutas/revision.ts` (37-48), **sin** `connectionId`: `.eq('kind', 'read')` como hoy, orden
  `created_at` e `id` ascendentes, `limit(20)`, y en JS primero las activas y, dentro, la más antigua. Con
  `connectionId`, esa (en cualquier estado, como hoy: E46 la usa así). Sin esto, una org que ya usó «Reconectar» vería
  en E45 la vieja revocada (`conexion_inactiva`).
- En `repo-paso.ts`, rama de archivos (218-222): `connection_id: conn.id` dentro de `detalle` (0 subpeticiones). Lo leen
  E6 (B5) y la wiki (B7) para saber qué repo miró cada auditoría aunque B3 no llegue. El cierre de OSV ya hace
  `{ ...cb, … }` y lo conserva.

Sin B0, conectar un 2.º repo a la demo cambia el repo que mira la auditoría completa.

**B3, el recorrido.** Solo cambia el paso `repo` y dos tipos de `jobs.ts`. `steps[]`, `pasosDe`, `siguientePaso`,
`vg_claim_step` y `vg_mark_step` no cambian.

- `MsgScan` gana `conn?: string` (solo el id de la conexión GitHub que mira ese mensaje). `ResultadoPaso.continuar` gana
  `conn?: string`. En `guarded`, la continuación se encola con `conn: r.continuar.conn ?? b.conn`. El mensaje del paso
  siguiente (`puntaje`) no lleva `conn`.
- **Lista de repos**, solo en el **primer mensaje: sin `m.conn` y sin `m.cursor`** (los `repo:osv` que ya estén en vuelo
  al desplegar no traen `conn` y siguen con `conexionActiva`, como hoy): con `params.connection_id`, solo esa; si no, las
  conexiones GitHub de lectura **activas** de la org, `created_at` e `id` ascendentes, `limit(MAX_REPOS_GITHUB)`. Es la
  misma consulta de `conexionActiva` con otro límite: 0 subpeticiones extra.
- **Por repo**, el trabajo de hoy, envuelto en `conConexion(conn.id, …)` (`jobs.ts`): un 401 lleva el id de ESE repo y
  `revocarConexion` no cae en la conexión por defecto. `repo:archivos` en su propio mensaje y, si hay dependencias, sus
  rondas de `repo:osv` (cada una en su mensaje, con `conn` = ese repo). Tope de 200 filas **por repo** (`escritas` vive
  en el cursor, que empieza de cero en cada repo).
- **Fin de un repo** (archivos sin dependencias, o última ronda de OSV): se escribe su entrada en
  `coverage.detail.codebase.repos` (la escritura de detalle que ya se hace: 0 extra) y:
  - si queda un repo `pending` después de él: `return { continuar: { cursor: 'repo', conn: <su id> } }`. El cursor
    `'repo'` hace que `vg_claim_step` retome el paso que sigue `running`; la rama de archivos es «cursor sin `osv`»;
  - si no queda: `status` = `done` si algún repo quedó `done`, si no `failed`. `findings` = `totalHallazgos` (todo el
    escaneo). `error_code`, el más importante: `tripwire` > `osv_unavailable` > `hallazgos_truncados` > `parcial`, y
    **como mínimo `parcial` si algún repo quedó `failed`, `skipped` o `pending`**. El código de cada repo
    (`unauthorized`, `no_connection`, `forbidden`…) va **solo en su entrada** de `repos[]`. No hay `repo_fallido`: el
    FRONT de hoy no lo conoce y pintaría el paso «Hecho» en verde (`auditoria/pasos.ts:28-33`, `53`).
- **Un repo que falla no corta a los demás.** En el `catch` del trabajo del repo: transitorio con reintento de cola
  pendiente (`intento <= REINTENTOS.repo`) → se relanza y la cola repite ESE mensaje. Si no: su entrada queda `failed`
  con el código; con `unauthorized` se revoca esa conexión (exportar `revocarConexion` de `jobs.ts` y pasarle el id) y se
  pasa al fin de repo. Un repo que dejó de estar activo cuando le toca queda `skipped` con `no_connection`. Si fallan
  todos, el último devuelve `failed` con su `connection_id` (guarded revoca como hoy; repetirlo es idempotente).
- **Forma de `coverage.detail.codebase`** (interna; `aScanRun` la quita con zod salvo `repos`):

```ts
detail.codebase = {
  ...detalleDelRepoActual,   // campos planos de hoy (modo, archivos_leidos, sha, connection_id…), por compatibilidad
  miradas: Y lógico de las miradas de TODOS los repos de la corrida: uno failed, skipped o pending las pone en false,
  repos: [{ connection_id, repo_full_name, status, findings?, error_code?, miradas?, sha?, archivos_leidos?, … }],
}
```

  La ronda de OSV lee y escribe `miradas`, `deps_truncadas` y `hallazgos_omitidos` en **la entrada de su repo**, no en
  los campos planos.
- **Requisitos que no se ven en el código de hoy** (también en las pruebas de B3):
  1. **Fusionar siempre.** Hoy la rama de archivos escribe `detail.codebase = detalle`, un objeto nuevo
     (`repo-paso.ts:222`): con B3 lee el detalle, conserva `repos[]` de los repos anteriores y recalcula `miradas`.
  2. **Primer mensaje = sin `conn` y sin `cursor`** (arriba).
  3. **`ScanRepo.findings` por repo** sale de las filas escritas para ese repo (`g.n` de archivos más `escritas` del
     cursor de OSV): 0 subpeticiones. `totalHallazgos` filtra por `scan_run_id`, no por conexión: no sirve para esto.
  4. **Presupuesto del `catch`**: cobertura (2) + revocar (1) + continuar o cierre (2-3). Cada repo reserva
     `SUB_FALLO = 6` antes de GitHub, dentro de las 40 (`TOPE_SUBPETICIONES`).
- Un mensaje de un repo que acaba en la DLQ deja el paso `failed/dlq` como hoy; los repos que faltaban quedan `pending`
  y la UI los pinta «sin revisar». Es raro y no se complica más.
- **E12** (`aScanRun`): `repos` sale de `coverage.detail.codebase.repos`, cada entrada con `ScanRepo.safeParse` (las
  inválidas se descartan), `slice(0, MAX_REPOS_GITHUB)`, y solo si queda alguna.
- `kind: 'repo'` con `connection_id` («Analizar este repo») = lista de uno: idéntico a hoy. `kind: 'repo'` sin
  `connection_id` («Analizar todos») = todos.
- E11 sigue con un `repo` en curso por org (409 con el `scan_run_id` en curso; el FRONT ya navega a él).

**Plan B si B3 no llega a las 03:00.** Con B0, B2, B5, B7 y B8 desplegados: la auditoría completa mira el repo principal
y cada repo se analiza con su botón (`kind: 'repo'` + `connection_id`, que ya funciona). E6 y la wiki siguen siendo
honestos porque saben qué repo miró cada auditoría (`detail.codebase.connection_id`, B0). El FRONT no pinta «Analizar
todos» ni dice que la auditoría completa revisa todos (§6.2, regla «solo lo que funciona»).

### 2.4 Cobertura, estado del módulo y Resumen

- **Cobertura** (`scans/cobertura.ts`): sin cambios. Codebase cuenta si el último paso `repo`/`zip` quedó `done`, y con
  B3 eso pasa si al menos un repo se miró.
- **E6** (`estado/modulo.ts`, codebase), **B5**. Con **un** repo activo, nada cambia. Con **2 o más repos activos**
  (nombres distintos en minúsculas entre las conexiones GitHub de lectura activas):
  - Las consultas que ya hace piden también: `scan_runs.params`; `connections.meta, created_at` (orden `created_at`);
    `findings.connection_id`. 0 subpeticiones más.
  - **Último intento de cada repo.** Se recorren las auditorías (más nuevas primero) y cada paso `repo` terminado
    (`done`/`failed`) se atribuye así:
    1. con `detail.codebase.repos` (B3): cada entrada, con su `status` y sus `miradas` (`pending` o `skipped` = sin
       mirar);
    2. si no, con `detail.codebase.connection_id` (B0): ese repo, con el `status` del paso y `detail.codebase.miradas`;
    3. si no (auditorías de antes de B0): `params.connection_id` si lo hay; si no, la conexión GitHub de lectura más
       antigua.

    Los ids se pasan a nombre de repo con la lista de conexiones (las parejas viejas de «Reconectar» son el mismo repo).
    Un paso `zip` no cuenta para ningún repo. El primer intento que aparece de cada repo es su último intento.
  - **Chequeo comprobado** solo si **cada** repo activo tiene su último intento `done` con todas las `mira` del chequeo
    en `true`. Si no: `comprobado: false`, `n: null`. Así «Analizar este repo» sobre un repo limpio no da por mirados
    los demás.
  - Chips: cada fila de hallazgo con `connection_id` lleva el nombre del repo en `chips` (la Bandeja ya los pinta). No
    se recortan.
  - Cifra nueva al final (lo único recortable de B5): `{ tipo: 'codebase_repos', etiqueta: 'Repos revisados', n: <repos
    activos con último intento done>, de: <repos activos>, rol: n === de ? 'bien' : 'aviso' }`; si ningún repo tiene
    intento, `n: null`. Sale del mismo recorrido: no depende de B3.
  - `ok: true` si al menos una conexión GitHub de lectura está activa (como hoy).
  - Limitación conocida: «Ver hallazgos» filtra por `resource` (`estado/modulo.ts:58`) y puede listar los dos repos; el
    chip los distingue.
- **E5** (Resumen): puntaje y `counts` agregados, sin cambios. La consulta de «ahora» pide `connection_id` y cada
  `AhoraItem` de hallazgo lo lleva (`null` si no tiene). Los incidentes no lo llevan.
- **Wiki** (`hallazgosDelRepo`, **B7**). No depende de B3:
  - la lectura de `connections` (`corridas.ts:86`) filtra `.eq('kind', 'read')` (la conexión de estados del bloqueo no
    entra) y pide `created_at`, en orden ascendente;
  - la de `scan_runs` pide también `coverage`. En una auditoría con el paso `repo` `done`, el repo cuenta como auditado
    si: su entrada de `detail.codebase.repos` (por `connection_id`) está `done`; o, sin `repos`,
    `detail.codebase.connection_id` es de ese repo; o, sin ninguno de los dos (auditorías de antes de B0),
    `params.connection_id` es de ese repo; o, sin nada, el repo es el de la conexión más antigua;
  - corregir el comentario de las líneas 81-82 («usó la conexión GitHub activa más nueva»);
  - resultado: sin B3, el repo 2 queda «sin auditar» hasta su «Analizar este repo», y la wiki lo dice en vez de
    afirmar «auditado y limpio».

### 2.5 Quitar un repo (E10)

Sin cambios en el BACK de esta especificación (la del bloqueo sí toca E10: §2.6). Borra la conexión, su config de
revisión (cascada) y deja sus hallazgos con `connection_id` null, como hoy. El aviso «Revoca también el token en GitHub»
no cambia: cada repo tiene su token. Para cambiar el token de un repo, «Reconectar» (mismo id); quitar y volver a
conectar pierde la config de revisión y deja los hallazgos viejos sin conexión.

### 2.6 Convivencia con el bloqueo de merge (`bloqueo-merge-criticos.md`: 0016, E53–E54)

Esa especificación da por hecho un solo repo GitHub por org y añade conexiones GitHub `kind 'action'` (token de
estados, una por org por el índice único de 0016, líneas 374-376). Con varios repos, **el bloqueo de merge vale para un
repo por org: el del token de estados.** El BACK lo hace al implementar el bloqueo (≈ 20 min más en el B4 de aquella
especificación); sustituye lo que dice su §2.8 de E8 y E10:

1. **Fixture**: `CONN_GITHUB_2 = 'c0000000-0000-4000-8000-000000000007'` (`…0006` es `CONN_GITHUB_ESTADOS`,
   `bloqueo-merge-criticos.md:608`).
2. **E8**: la lectura de §2.1 ya filtra `.eq('kind', 'read')`: la conexión de estados no cuenta para el tope ni para
   los duplicados. El 409 «Ya hay un repo conectado» que cita bloqueo §2.8 desaparece.
3. **E53, paso 1**: la conexión de lectura del bloqueo es la del mismo `meta.repo_id` que la conexión de estados, si
   existe; si no hay conexión de estados, la principal (`conexionGithub` sin parámetro: activa más antigua, B0). Si hay
   conexión de estados y ninguna de lectura de su repo: 409 `{reason: 'otro_repo'}` «El token de estados es de otro
   repo: quítalo en Conexiones». La conexión de estados nace con `repo_full_name` y `repo_id` de esa conexión de lectura.
   `MergeGatePut` no cambia.
4. **E45 con `?connection_id=`**: `config.gate` solo en el repo del bloqueo (la conexión que elegiría el punto 3). En los
   demás, `gate` no viene (ya es opcional: «falta en un BACK de antes») y el FRONT no pinta «Bloquear merges con
   críticos» en esa pestaña. Si no, ofrecería activar el bloqueo en un repo donde E53 no lo aplicaría.
5. **Paso `estado`** (bloqueo §2.4, punto 6): además exige `action.meta.repo_id === meta.repo_id` de la conexión de
   lectura de la config de la revisión (la config ya se lee en el punto 3: pedir `connection_id` y embeber
   `connections(meta)`, o +1 subpetición). Si no casan: `gate_error 'otro_repo'` y `ack`. Nunca publica el SHA de un repo
   en otro. FRONT (bloqueo §6.4): `otro_repo` «El token de estados es de otro repo». `gate_error` ya admite
   `^[a-z_]{2,40}$`: sin cambio de contrato ni de 0016.
6. **E10** (bloqueo §2.8): borrar una GitHub de lectura borra la de estados **solo si es del mismo repo**
   (`meta.repo_id`; sin él, nombre en minúsculas). Quitar el repo 2 no toca el token de estados del repo 1. El aviso del
   FRONT «También quitamos el token de estados» solo en la línea de ese repo.
7. `wiki/corridas.ts:86` sí se toca (B7 filtra `kind 'read'`), aunque bloqueo §2.8 diga que no hace falta.
8. Bloqueo §14 D1 dice «la org solo admite un repo (E8)»: deja de ser cierto con B1. Su recomendación no cambia.

**Aviso al BACK:** E8, E10, E45 y `conexionGithub` de `revision.ts` los tocan las dos especificaciones (E8 y E10 también
`modo-bajo-ataque.md`, en las ramas de Cloudflare). `rotarSecretoConexion` (§2.1) es una sola función para E8 y E53.

---

## 3. Revisión de código por repo (E45, B6)

- `GET /api/orgs/:org/code-review?connection_id=<id>` → `CodeReviewState` de ESE repo. El cuerpo de la respuesta no
  cambia. Sin parámetro: la conexión GitHub de lectura principal (B0: activa más antigua). `connection_id` malformado:
  422 `invalid_body`. Ajena, inexistente o no GitHub: `available: false, reason: 'sin_conexion'` (como hoy, sin
  distinguir).
- Orden de lecturas (≤ 4 subpeticiones, ahora en serie): conexión → config por `connection_id` → las 10 últimas
  `code_reviews` **por `config_id`** (sin config: `recent: []`) → sus WhatsApp. Con el bloqueo de merge, su lectura de
  la conexión de estados va en paralelo con la config (§2.6, punto 4).
- E46 ya recibe `connection_id` en el cuerpo. E47 (webhook) y los pasos de la cola ya son por config. E48/E49 (umbrales)
  siguen siendo de la org: valen para todos los repos.
- El enlace del WhatsApp (`?revision=<id>`) no cambia y no lleva el repo. El FRONT encuentra la pestaña cuyo `recent`
  contiene ese id (§6.2).

```ts
// rutas/revision.ts, E45
const q = CodeReviewQuery.safeParse({ connection_id: c.req.query('connection_id') || undefined });
if (!q.success) throw new ApiError('invalid_body', 'Revisa la conexión', { field_errors: { connection_id: ['Id no válido'] } });
const conn = await conexionGithub(c, q.data.connection_id);           // sin id: la principal (B0)
if (!conn) return c.json(CodeReviewState.parse({ available: false, reason: 'sin_conexion', config: null, recent: [] }));
const { data: cfg, error: ec } = await admin.from('code_review_configs').select(COLUMNAS_CONFIG).eq('org_id', orgId)
  .eq('connection_id', conn.id).maybeSingle();
// … code_reviews .eq('org_id', orgId).eq('config_id', cfg.id) solo si hay cfg; el resto como hoy
```

---

## 4. Wiki por repo y la wiki de la demo

### 4.1 Comportamiento

- La página «Wiki del repo» lista **todos** los repos conectados de la org (conexiones GitHub de lectura, activas o no,
  sin repetidos por nombre), en el orden de E7. Cada fila dice el estado de su wiki: «Wiki lista · commit `abc1234` ·
  hace 2 h», «Generando…» o «Sin wiki».
- Al elegir un repo (`?repo=owner/name`), se ve su historial (E43 `?repo=`). Sin `?run=`, la página **abre sola la última
  wiki lista** de ese repo (para el viewer y para el admin).
- Admin: «Estimar costo» del repo elegido, con el `connection_id` de SU conexión si está activa. E40/E41 rechazan con
  404 «Conexión no encontrada» un `connection_id` cuyo repo no es el pedido (B8, §7). Un repo con la conexión caída
  deja ver sus wikis pero no generar («Reconecta el repo para generar otra»). El campo libre para un repo público sigue,
  plegado bajo «Otro repo público».
- Viewer y anónimo de la demo: la lista y las wikis ya generadas. Nunca «Estimar» ni «Generar». Nada nuevo se expone: los
  nombres de los repos ya salen en E7.
- No se genera ninguna wiki sola al conectar un repo (gasta IA sin estimar). Ver D2.

### 4.2 Qué hace falta para que «Tienda Demo» tenga su wiki activada

La página actual basta **solo mientras la conexión GitHub de la demo esté activa** (`PaginaWiki.tsx:213`): si pasa a
`revoked`, `expired` o `error`, el anónimo no ve ninguna wiki, porque el campo para escribir el repo está oculto al
viewer. **F3 es lo que lo asegura (lista también las conexiones no activas) y no se recorta.** Mientras F3 no esté, el
anónimo tiene que pulsar la fila del historial. Lo hace Giovanni (§9.4, G1):

0. **Comprobaciones a mano** (el MCP de Supabase no conectó; nada de esto está comprobado):
   - En Conexiones de «Tienda Demo», el `expires_at` del token GitHub. Si vence antes del domingo 12:00, «Reconectar»
     con un token nuevo **después de B1** (mismo id, hallazgos y wiki intactos). Antes de B1, «Reconectar» crea otra
     conexión y los hallazgos de la vieja quedan colgando.
   - Que Giovanni es `owner` o `admin` de «Tienda Demo» en `org_members` (el alta del seed está comentada,
     `supabase/seed/demo.sql:23-26`). Si no lo es, no puede generar la wiki: hacer ese `insert` a mano.
   - Conexiones GitHub repetidas: `select org_id, lower(meta->>'repo_full_name'), count(*) from connections where
     provider = 'github' and kind = 'read' group by 1, 2 having count(*) > 1;`. Si sale la demo, avisar al ORQUESTADOR.
1. Confirmar que la última auditoría completa de la demo terminó (la wiki cita sus riesgos; sin auditoría el documento
   dice que no la hubo).
2. En **officialvanguard.com** (E41 solo arranca desde el host de producción), con su sesión de admin, no en «Ver demo»:
   «Wiki del repo» → el repo de la conexión viene puesto → «Estimar costo».
3. Costo esperado: **~US$ 0,04**, techo **~US$ 0,08** (estimación local con `estimarCorrida` de `packages/deepwiki` sobre
   la plantilla `demo/repo-vulnerable` más el `.env` y `src/lib/pagos.ts` sembrados: 27 archivos, 10 candidatos, 6 áreas;
   triage y áreas con Haiku 5.5, síntesis con Sonnet 5.5). El tope por defecto (US$ 1) sobra. Si E40 da otra cifra,
   manda E40.
4. «Generar wiki» y esperar ~2–4 min a «Wiki lista».
5. Comprobar como jurado: ventana privada → «Ver demo» → «Wiki del repo» → el historial muestra la wiki y se abre sin
   ningún botón de generar. Sin F3, pulsando la fila; con F3, sola.
6. Si se conecta un 2.º repo a la demo (D1): lo mismo con ese repo, después de conectarlo y de auditarlo (§9.4, G5).

La wiki es una foto del commit y de los hallazgos de ese momento. Volver a sembrar el repo o auditar después no la
borra: sigue en el historial.

---

## 5. Contrato (lo escribe el ORQUESTADOR)

Solo campos opcionales y exportaciones nuevas: el FRONT y el BACK actuales siguen compilando. Compilado de nuevo tras la
revisión (sáb ~19:30) con el `tsc` del repo (TypeScript 6.0.3, `tsconfig.base.json`) sobre una copia de
`packages/contracts` en el scratchpad (`varias-codebases-zod/`), con estas inserciones y los fixtures de §5.2: `tsc
--noEmit` en verde y `vitest run` 57/57 con zod 4.6.7 (los 50 de `contracts.test.ts`, con las 3 claves nuevas, más 7
comprobaciones aparte: 5 repos pasan y 6 no; `connection_id` malformado, estado desconocido y `error_code` de más de 40
se rechazan; `AhoraItem` con `connection_id` null o ausente pasa; `CodeReviewQuery`; `CONN_GITHUB_2` no choca con ningún
id ni con `…0006`).

### 5.1 `packages/contracts/src/api.ts`

**(a) Justo antes de `export const ScanRun = z.object({`:**

```ts
// ── Varias codebases por org (asignaciones/varias-codebases.md) ───────────────────────────────────────────────────
// Tope de repos GitHub por org: nombres de repo distintos entre las conexiones GitHub de LECTURA, en cualquier estado.
// E8 responde 409 (details.reason 'tope_repos'). La conexión de estados del bloqueo de merge (kind 'action') no cuenta.
export const MAX_REPOS_GITHUB = 5;
// Cómo le fue a cada repo en una auditoría con paso repo (full_audit, o repo sin connection_id). Sale de
// scan_runs.coverage.detail.codebase.repos, en el orden en que se revisan (la conexión más antigua primero).
// findings: filas escritas para ESE repo; error_code: el del repo (unauthorized, no_connection, tripwire…).
export const ScanRepo = z.object({ connection_id: Id, repo_full_name: z.string().max(140), status: ScanStep.shape.status,
  findings: z.number().int().min(0).optional(), error_code: z.string().max(40).optional() });
export type ScanRepo = z.infer<typeof ScanRepo>;
```

**(b) Última línea de `ScanRun`** (sustituye la línea de `band`):

```ts
  band: z.enum(['red', 'amber', 'green']).nullable().optional(), // opcional: color del puntaje en corridas viejas (§14.14)
  repos: z.array(ScanRepo).max(MAX_REPOS_GITHUB).optional() }); // solo si el paso repo miró conexiones (varias-codebases)
```

**(c) `AhoraItem`** (sustituye las dos líneas):

```ts
export const AhoraItem = z.object({ kind: z.enum(['finding', 'incident']), id: Id, module: Module, rule_id: RuleId, severity: Severity,
  title: z.string(), resource: z.string(),
  connection_id: Id.nullable().optional() }); // hallazgo: su conexión (el FRONT pinta el repo si la org tiene ≥ 2); incidente: sin campo
```

**(d) Justo después de `export type CodeReviewState = z.infer<typeof CodeReviewState>;`:**

```ts
// E45 · ?connection_id= (varias-codebases): el estado de ESE repo. Sin él, la conexión GitHub de lectura principal
// (la activa más antigua).
export const CodeReviewQuery = z.object({ connection_id: Id.optional() });
export type CodeReviewQuery = z.infer<typeof CodeReviewQuery>;
```

`ConnectionCreate`, `ConnectionCreated`, `ConnectionPublic`, `ScanCreate`, `ScanStep`, `Coverage`, `Finding`,
`CodeReviewState`, `WikiRun*` y `EstadoModulo` no cambian. Los 409 de E8 usan `details.reason` (`repo_duplicado`,
`tope_repos`), que el cuerpo de error ya admite; el 409 del mismo token va sin `reason`, como hoy. «Reconectar» responde
el mismo `ConnectionCreated`.

### 5.2 Fixtures (una org con dos repos)

El segundo repo es pequeño, público y limpio: no mueve el puntaje ni el orden de «Ahora».

`fixtures/ids.ts`, al final:

```ts
// ── Varias codebases (asignaciones/varias-codebases.md) ─────────────────────────────────────────────────────────
// Segundo repo de la org: pequeño, público y limpio (no mueve el puntaje ni el orden de «Ahora»). …0006 es
// CONN_GITHUB_ESTADOS (bloqueo-merge-criticos.md).
export const CONN_GITHUB_2 = 'c0000000-0000-4000-8000-000000000007';
export const REPO_2 = 'equipo22-demo/vanguard-demo-landing';
export const T_CONEXION_REPO_2 = '2026-10-24T18:00:52.000Z';
```

`fixtures/conexiones.ts`: añadir `CONN_GITHUB_2, REPO_2, T_CONEXION_REPO_2` al import de `./ids.ts` y, al final:

```ts
// Segundo repo (varias-codebases): lo que devuelve E8 al conectar REPO_2 y lo que E7 añade al final de `connections`
// (E7 ordena por created_at). meta.hallazgos_por_repo: la conexión nació con la clave de hallazgos por repo (la org ya
// tenía otro repo conectado).
export const conexionGithub2 = {
  id: CONN_GITHUB_2, provider: 'github', kind: 'read', label: `GitHub · ${REPO_2}`, status: 'active', last4: '2b7d',
  scopes: ['metadata:read', 'contents:read'],
  meta: { repo_full_name: REPO_2, default_branch: 'main', private: false, repo_id: 870000002, hallazgos_por_repo: true },
  capabilities: { metadata: true, contents: true, dependabot_alerts: false },
  expires_at: EXPIRA_TOKENS, last_checked_at: T_CONEXION_REPO_2, last_error: null,
} satisfies ConnectionPublic;
```

`fixtures/auditoria.ts`: añadir `CONN_GITHUB, CONN_GITHUB_2, REPO, REPO_2` al import de `./ids.ts` y, al final:

```ts
// La misma auditoría con dos repos (varias-codebases): el paso repo los miró los dos; el segundo salió limpio, así que
// puntaje, cobertura y resumen no cambian.
export const scanDoneDosRepos = {
  ...scanDone,
  repos: [
    { connection_id: CONN_GITHUB, repo_full_name: REPO, status: 'done', findings: 7 },
    { connection_id: CONN_GITHUB_2, repo_full_name: REPO_2, status: 'done', findings: 0 },
  ],
} satisfies ScanRun;
```

`fixtures/revision.ts`, al final:

```ts
// E45 ?connection_id=CONN_GITHUB_2 (varias-codebases): repo conectado, revisión aún sin activar.
export const codeReviewStateRepo2 = { available: true, reason: null, config: null, recent: [] } satisfies CodeReviewState;
```

`fixtures/index.ts`: importar `scanDoneDosRepos`, `conexionGithub2` y `codeReviewStateRepo2`, y añadir al objeto
`conexionGithub2, scanDoneDosRepos, codeReviewStateRepo2,`.

`contracts.test.ts`: las tres claves en `CLAVES_ESPERADAS` y en `casos`:

```ts
  ['conexionGithub2', c.ConnectionPublic, fx.conexionGithub2],
  ['scanDoneDosRepos', c.ScanRun, fx.scanDoneDosRepos],
  ['codeReviewStateRepo2', c.CodeReviewState, fx.codeReviewStateRepo2],
```

`fixtures.connections` **no** cambia: la org de los fixtures sigue con un repo y el segundo entra por el flujo real
(E8 falso) o por el arnés de pruebas. Si el bloqueo de merge entra antes, `…0006` ya está ocupado por
`CONN_GITHUB_ESTADOS`: por eso `…0007`.

### 5.3 Migración

**No hace falta.** Varias conexiones GitHub ya caben en `connections`; la revisión ya es por conexión
(`code_review_configs` único por `connection_id`, `code_reviews` por `config_id`); «Reconectar» usa `vg_rotate_secret`,
que ya existe; la clave por repo vive en el JS que calcula `dedupe_key`; el detalle por repo va en `scan_runs.coverage`
(jsonb). El único `(org_id, fingerprint)` se queda (decisión 2). Un índice único contra repos duplicados no compensa
(carrera solo entre dos admins a la vez). 0018 queda libre.

---

## 6. UI (FRONT)

### 6.1 Conexiones (F1)

- Tarjeta GitHub: una `LineaConexion` por conexión de lectura, con el repo como título. Debajo, «Conectar otro repo»
  (secundario) que lleva al asistente de GitHub. Sin repos: «Conectar GitHub» como hoy.
- Con 5 repos (nombres distintos), el botón queda deshabilitado con la ayuda «Tope de 5 repos por organización». Viewer:
  `SOLO_LECTURA`.
- Con ≥ 2 repos, la cabecera lleva la chapa «N repos» (nombres distintos).
- Asistente de GitHub, ayuda del token: «Crea un token para cada repo: el mismo token no se puede usar dos veces en una
  organización.» El 409 del mismo token (sin `reason`), `repo_duplicado` y `tope_repos` muestran el mensaje del
  servidor.
- «Reconectar» no cambia: el asistente manda el mismo repo y E8 reconecta la misma conexión. Opcional: pasar el repo en
  la URL del asistente para que venga puesto.
- `AvisoQuitada` de GitHub: sin frases nuevas (cada repo tiene su token).
- Resumen, `PaginaResumen.tsx:55` (`TarjetaVertical`): con ≥ 2 repos, la chapa de la tarjeta Codebase es la del peor
  estado o «N repos», con la misma regla que `PantallaModulo` (§6.2).

### 6.2 Codebase (F2)

- Repos = conexiones GitHub de lectura, en el orden de E7, **sin repetidos por nombre en minúsculas**: de cada grupo, la
  activa; si ninguna, la más antigua (las parejas viejas de «Reconectar», §1.1). Elegido = `?repo=<connection_id>` si es
  válido; si no, el primero.
- Con ≥ 2 repos: pestañas (`role="tablist"`) con el nombre del repo y una chapa del estado de su revisión (Activa,
  Apagada, Error, «—»). El nombre del repo no se recorta con puntos suspensivos: hace salto de línea. Con 1 repo: como
  hoy, sin pestañas.
- Contenido de la pestaña: «Repositorio» (repo · rama · probado), «Analizar este repo» (`BotonRevisar` con
  `connectionId`) y `TarjetaRevisionCodigo` con `key={`${org.id}:${conexion.id}`}`.
- «Analizar todos los repos (N)» (`kind: 'repo'` sin `connection_id`) **solo cuando B3 esté en producción** (lo avisa
  el ORQUESTADOR). Antes, debajo de las pestañas: «La auditoría completa revisa el repo principal. Los demás, con su
  botón.»
- `useRevisionCodigo(org, rapidoHasta, connectionId)`: **siempre con `connectionId`**, también con un repo (un BACK sin B6
  ignora el parámetro). Clave `['org', org, 'revision', connectionId]` y URL `…/code-review?connection_id=`. Solo la
  pestaña elegida sondea; las demás se piden una vez (para su chapa).
- `opcionesGuardarRevision` (`lib/mutaciones.ts:140`): `setQueryData(['org', org, 'revision', r.config.connection_id], …)`.
  `setQueryData` usa la clave exacta: con la de hoy no actualizaría la pestaña y dejaría una entrada suelta en la caché.
  Solo `invalidateQueries` (línea 142) vale por prefijo.
- Secreto `vgw_` de una sola vista: la clave del `Map` de `lib/mutaciones.ts` pasa a `${org}:${connection_id}`
  (`r.config.connection_id` en `onSuccess`) y `tomarSecreto(org, connectionId)`.
- `?revision=<id>` sin `?repo=`: se elige la pestaña cuyo `recent` contiene ese id; si ninguno, la primera.
- `PantallaModulo` con ≥ 2 repos: chapa «N repos» en verde, o el peor estado si alguno falla, con «Reconectar» como hoy.
- `BotonRevisar` acepta `connectionId?: string` y lo manda en el cuerpo de E11.
- Bloqueo de merge: la sección «Bloquear merges con críticos» (bloqueo §6.1) solo en la pestaña cuyo E45 trae
  `config.gate` (§2.6, punto 4).
- El ZIP no cambia.

### 6.3 Wiki (F3) — no se recorta

- Lista de repos de §4.1 (componente nuevo `ReposWiki`), con `useWikiRuns(org, repo)` por repo (≤ 5 consultas). Incluye
  las conexiones no activas y quita los repetidos por nombre (como F2). Es lo que hace que el anónimo vea la wiki de la
  demo aunque la conexión GitHub deje de estar activa.
- `?repo=` elige el repo; sin `?run=`, `setParams` con `replace` al id de la última corrida `succeeded` de ese repo.
- `connection_id` de estimar, generar, regenerar y reintentar: el de la conexión **activa de ese repo** (búsqueda por
  nombre en minúsculas entre todas), no el de la primera conexión.
- Sin conexiones GitHub: como hoy. Opcional: listar los repos distintos de E43 sin `?repo` (ya lo admite).

### 6.4 Repo en hallazgos, Resumen y Auditoría (F4)

- `useRepoDeConexion(org)` → `(id: string | null | undefined) => string | null`; devuelve `null` si la org tiene menos de 2
  repos.
- **F4a, no se recorta:** Hallazgos (lista y detalle) y «Ahora» del Resumen: chip con el repo cuando el helper devuelve
  nombre. Sin él, dos hallazgos con el mismo título y recurso (`.env`, `npm:lodash@4.17.15`) en dos repos se ven iguales.
- **F4b, recortable:** Auditoría: con `run.repos` de 2 o más, una línea por repo bajo el paso «Repo»: nombre · estado en
  texto · N hallazgos · motivo si falló (`unauthorized` → «Token revocado», `no_connection` → «Conexión quitada», otro →
  «No pudimos revisarlo»). El paso ya sale «Hecho en parte» con `parcial` aunque F4b no esté.
- Las chips de E6 llegan del servidor (B5).

### 6.5 Modo fixtures (F5)

- `githubDe` (`lib/fixtures/router.ts:524`) y `verRevision(org, connection_id)` / `guardarRevision`: estado por conexión
  (`fx.codeReviewStateRepo2` para `CONN_GITHUB_2`).
- `conectarFalso` de GitHub: mismo token ya usado en esa org (comparado en memoria) → 409 sin `reason`; mismo repo activo
  → 409 `repo_duplicado`; mismo repo no activo → la misma conexión, `active`; con 5 → `tope_repos`; conectar `REPO_2`
  devuelve `fx.conexionGithub2`.
- Con dos repos en la lista, E12 de la auditoría sirve `fx.scanDoneDosRepos`.

---

## 7. Seguridad

- **Un token por repo.** El único `(org_id, fingerprint)` de `connection_secrets` impide pegar el mismo PAT en dos
  conexiones de una org. Cada conexión tiene su secreto sellado con su `connection_id` en el AAD; «Reconectar» sella con
  el MISMO id. Nada copia secretos entre conexiones.
- **E40/E41 exigen el repo de la conexión (B8).** `conTokenGithub(env, admin, orgId, connectionId, repo, fn)`: la lectura
  de `connections` pide también `meta` y exige `meta.repo_full_name` en minúsculas igual a `repo` en minúsculas; si no,
  el mismo 404 «Conexión no encontrada». Es la misma subpetición. Llamadores: E40 y E41 (`body.repo_full_name`) y los
  pasos `arbol` y `area` de la cola (`fila.repo_full_name`, `wiki/pasos.ts:179` y `210`). Sin esto, un admin con un PAT
  que ve varios repos podría documentar un repo privado no conectado, y la wiki quedaría a la vista de todos los
  miembros, el anónimo de la demo incluido.
- Anti-IDOR: E45 filtra la conexión por `org_id`, `provider = 'github'` y `kind = 'read'`; E11 ya valida `connection_id`
  contra la org.
- El anónimo de la demo solo lee: E7, E42–E45 (E45 sin `webhook_url`). Nada nuevo se expone.
- WhatsApp sin nombre de repo (decisión de `revision-codigo.md` §5.2). Logs con `connection_id`, nunca token ni repo
  privado completo en eventos nuevos (`connection.reconectada` solo lleva `rid` y proveedor).
- La clave por repo es un hash: el nombre del repo no sale por ella.
- Un token de estados nunca publica en un repo que no es el suyo (§2.6, punto 5).
- El tope de 5 acota cola, GitHub e IA por org.

---

## 8. Costo en Workers Free (10 ms de CPU, 50 subpeticiones; tope del equipo 40)

- Cada mensaje del paso `repo` gasta lo mismo que hoy (≤ 40). Pasar al repo siguiente cuesta un `send` que ya estaba en
  la cuenta del cierre. El primer mensaje pide la lista con la misma consulta de hoy. El `catch` de un repo que falla
  reserva 6 (§2.3). CPU por invocación: la de hoy.
- Auditoría completa: por repo, 1 mensaje de archivos + hasta 8 rondas de OSV. Con 5 repos, ≤ ~45 mensajes más
  reintentos. El límite diario de operaciones de Queues en Free [no verificado] sobra para el volumen del hackatón.
- Duración: repos en serie, ~20–60 s cada uno [no verificado con 5]. Dentro de los 15 min del vigilante (0011).
- E8: «Reconectar» = 1 lectura + sondeo + llaves + `vg_rotate_secret` + `leer`: lo mismo que el alta.
- E6 (B5) y la wiki (B7): columnas de más en las lecturas que ya hacen; 0 subpeticiones. B8: la misma subpetición con
  `meta`.
- E45: ≤ 4 subpeticiones por petición, igual que hoy (≤ 5 con el bloqueo). El FRONT solo sondea la pestaña elegida.
- Paso `estado` del bloqueo: +1 como mucho para leer la conexión de la config (0 con el embed).
- Wiki: ~12–15 mensajes por corrida; ~US$ 0,04 el repo de la demo. El tope diario de IA de la org lo cubre.

---

## 9. Reparto

Horario objetivo (Caracas). Si algo se atrasa, se recorta en este orden: P1 → F4b → cifra «Repos revisados» de E6 → B3
(plan B, §2.3). **No se recortan** B0, B1, B2, B5 (salvo la cifra), B6, B7, B8, F1, F2, F3 ni F4a: sin ellos un 2.º
repo daría chequeos, wikis o hallazgos engañosos.

### 9.1 ORQUESTADOR (≈ 45 min, antes de las 20:15)

1. Contrato de §5.1 en `api.ts` (insertar en los anclajes indicados; hay otras especificaciones tocando `api.ts` en
   paralelo: no mover bloques ajenos).
2. Fixtures de §5.2 (`CONN_GITHUB_2 = …0007`) y `contracts.test.ts`. `pnpm --filter @vanguard/contracts test` y
   `typecheck`.
3. Commit y push a `main`.
4. Mandar a la vez las asignaciones de §9.2 y §9.3, y pasar §2.6 a quien lleve el bloqueo de merge (BACK y FRONT): E8,
   E10, E45 y `conexionGithub` de `revision.ts` los tocan las dos especificaciones, y `rotarSecretoConexion` es una sola.
5. Avisar al FRONT cuando B3 esté en producción (activa «Analizar todos»).

### 9.2 BACK (P0 ≈ 4 h 20 sin B3; ≈ 7 h 05 con B3)

| Paso | Qué | Estimación | Depende de |
|---|---|---|---|
| B0 | Repo principal (§2.3): `conexionActiva` (github) la activa más antigua; `conexionGithub` de `revision.ts` sin parámetro, activas primero y dentro la más antigua (`limit(20)`); `connection_id` en `detail.codebase`. Pruebas: dos conexiones, gana la activa más antigua; una revocada más antigua no gana en E45. **Desplegar ya.** | 25 min | — |
| B2 | `claveDeRepo` en `scans/comun.ts`; aplicarla en `repo-paso.ts` y `revision/pasos.ts`. Prueba: dos conexiones con la marca y el mismo `npm:lodash@4.17.15` → dos `dedupe_key`; sin la marca, la clave de hoy. | 30 min | — |
| B8 | `conTokenGithub` exige el repo (§7) en E40, E41 y los pasos `arbol` y `area`. Pruebas: repo distinto → 404; mismas letras con otras mayúsculas → vale; sin `connection_id` (repo público) → como hoy. | 20 min | — |
| B6 | E45 `?connection_id=` (§3), sobre `rotate_secret` (ya en `main`). Pruebas: por conexión, sin parámetro (la principal), malformado 422, ajena `sin_conexion`, `recent` solo de su config. | 40 min | contrato |
| B5 | E6 codebase por repo (§2.4): chequeos por repo, chips de repo y cifra «Repos revisados». Pruebas: 1 repo, igual que hoy; 2 repos con solo uno analizado → chequeos sin comprobar; los dos `done` → comprobados; un ZIP no cuenta; auditoría vieja sin datos → la más antigua. | 45 min | B0 |
| B7 | `hallazgosDelRepo` por repo (§2.4): `coverage`, `kind 'read'`, auditorías viejas → la más antigua. Prueba: auditoría completa sin `connection_id` y con `detail.codebase.connection_id` del repo 1 → el repo 2 queda sin auditar (`{}`). | 30 min | B0 |
| B1 | E8 (§2.1) con `rotarSecretoConexion`. Pruebas: 409 `repo_duplicado` por nombre (mayúsculas distintas) y por `repo_id` con la conexión activa; no activa → mismo id, `active`, hallazgos y config intactos; mismo PAT que otra conexión → 409 al crear y al reconectar; 409 `tope_repos` con 5 nombres (las parejas cuentan uno); la conexión de estados no cuenta; marca solo si ya hay otro repo. **Se despliega con B2, B5 y B7 o después**: es lo que abre la puerta al 2.º repo. | 50 min | contrato, B2, B5, B7 |
| B4 | E12 `repos` (§2.3) y E5 `connection_id` en «ahora» (§2.4). | 20 min | contrato |
| B3 | Recorrido de repos en el paso `repo` (§2.3), con sus cuatro requisitos. Pruebas: 2 repos → 2 mensajes de archivos y `repos` con dos entradas; 401 en el 2.º revoca solo ese y el paso queda `done` con `parcial`; 1 repo → mismo resultado que hoy; repo quitado a mitad → `skipped`; un `repo:osv` sin `conn` en vuelo → como hoy; la rama de archivos del 2.º conserva la entrada del 1.º; `findings` por repo; presupuesto del `catch` ≤ 40. | 2 h 45 | B0, B2 |
| P1 | Revisión por push: `evidence.conexion = { id, provider: 'github', label }` en sus hallazgos, para pintar el repo aunque tengan `connection_id` null. | 15 min | B2 |

Más ≈ 20 min en el B4 de `bloqueo-merge-criticos.md` por §2.6, si el bloqueo sigue adelante.

Objetivo: B0, B2, B8 y B6 en producción antes de las 22:00; B5, B7 y B1 antes de las 23:30; B4 y B3 antes de las 03:00
(B3 solo si se decide en D3).

### 9.3 FRONT (P0 ≈ 5 h; ≈ 4 h 35 sin F4b)

| Paso | Qué | Estimación | Depende de |
|---|---|---|---|
| F3 | Wiki por repo (§6.3). No espera al BACK. **Primero.** | 1 h 30 | — |
| F1 | Conexiones con varios repos y chapa del Resumen (§6.1). | 1 h | contrato (B1 para probar contra el BACK real) |
| F2 | Codebase con pestañas y E45 por conexión (§6.2), sobre `rotate_secret`. «Analizar todos» detrás del aviso de B3. | 1 h 40 | contrato, B6 |
| F4a | Chip de repo en Hallazgos y «Ahora» (§6.4). | 25 min | contrato, B4 |
| F4b | Una línea por repo en Auditoría (§6.4). Recortable. | 25 min | contrato, B4 |
| F5 | Fixtures del router (§6.5), junto con cada paso. | incluido | contrato |

Objetivo: F3 antes de las 21:45; F1 y F2 antes de las 00:30; F4 antes de las 02:00.

### 9.4 Giovanni

- **G1, ya (≈ 20 min, sin esperar código):** las comprobaciones a mano de §4.2 (paso 0: vencimiento del token de la demo,
  su rol en «Tienda Demo», conexiones repetidas), generar la wiki de «Tienda Demo» y comprobarla como anónimo. Hasta
  que F3 esté, en el guion: «pulsa la fila del historial».
- **G2:** decidir D1, D2 y D3 (§12).
- **G3, tras B0, B1, B2, B5, B7 y B8 en producción (~23:30):** en una org de prueba (no la demo), conectar un 2.º repo
  **con su propio token**. Comprobar: Conexiones lista los dos; el mismo token del 1.º da «Ese token ya está conectado en
  esta organización»; el 1.º otra vez da «Ese repo ya está conectado»; «Analizar este repo» del 2.º y, hasta analizar
  también el 1.º, los chequeos de Codebase salen sin comprobar; activar su revisión por push (otra URL de webhook); su
  wiki.
- **G4, tras B3 (~03:00) o por la mañana:** auditoría completa en la org de prueba con 2 repos → «Repos revisados 2 de
  2» y una línea por repo en la auditoría.
- **G5, si D1 = sí:** conectar el 2.º repo a «Tienda Demo» con su propio token **solo con B1 en producción** (y por
  tanto B0, B2, B5 y B7). Con B3: auditoría completa. Sin B3: «Analizar este repo» del 2.º **antes** de generar su wiki
  (si no, la wiki dice que no hubo auditoría). Generar su wiki y repasar el guion (puntaje y orden de «Ahora»).

---

## 10. Pruebas mínimas

- E8: los casos de B1 (duplicado activo por nombre y por `repo_id`, reconectar uno no activo con el mismo id, mismo PAT
  al crear y al reconectar, tope por nombres distintos, la conexión de estados fuera, la marca).
- `rotarSecretoConexion`: 23505 → 409; `P0002` → 404; el AAD lleva el id existente (el token se abre con `withSecret`).
- `claveDeRepo`: con y sin marca.
- `pasoRepo`: los casos de B3, más el presupuesto (ningún mensaje pasa de 40 subpeticiones en las pruebas de presupuesto
  existentes).
- `aScanRun`: `repos` presente, ausente y con una entrada inválida (se descarta).
- E45: los casos de B6. E40/E41 y pasos de la wiki: los casos de B8. `hallazgosDelRepo`: el caso de B7.
- E6: los casos de B5.
- Bloqueo (§2.6): paso `estado` con el token de estados de otro repo → `gate_error 'otro_repo'` y nada publicado; E10
  del repo 2 no borra la de estados del repo 1; E45 de un repo que no es el del bloqueo, sin `gate`.
- FRONT: pestañas y `?revision=` en otra pestaña; secreto `vgw_` que no salta de un repo a otro; `setQueryData` con la
  clave de la pestaña; la wiki se abre sola para el viewer, también con la conexión revocada; repos repetidos salen una
  vez; «Conectar otro repo» deshabilitado con 5; el paso «Repo» con `parcial` sale «Hecho en parte»; bidi en los
  nombres de repo (`sinBidi`, `<bdi>`).

---

## 11. Guion de demo (≤ 20 s)

Con D1 = sí (dos repos en la demo):

> «Una empresa no tiene un solo repo. En Conexiones, Tienda Demo tiene dos: la tienda y la landing, cada uno con su
> token. *(Codebase)* Cada uno con su pestaña, su análisis y su revisión en cada push. *(Wiki del repo)* Y cada repo
> trae su wiki ya generada: el directivo la abre gratis, sin gastar IA.»

Solo con B3 en producción se puede añadir «la auditoría completa revisó los dos» (regla «solo lo que funciona»). Sin
F3, en la wiki: «pulsa la fila del historial».

Con D1 = no:

> «*(Conexiones)* Puedes conectar hasta cinco repos por organización, cada uno con su token de solo lectura. *(Wiki del
> repo)* Este es el de la tienda, explicado para un directivo: generarlo costó cuatro centavos y abrirlo es gratis.»

---

## 12. Decisiones abiertas para Giovanni

**D1. ¿Conectamos un segundo repo a «Tienda Demo» para el jurado?**
Recomendación: **sí, solo si hay a mano un repo pequeño y limpio del equipo** (sin secretos ni dependencias
vulnerables), con su propio token, conectado después de B1 (que va con B0, B2, B5 y B7), analizado y con su wiki
generada. Así se ve el pedido en la demo sin mover el puntaje ni el orden de «Ahora» del guion. Si no hay uno limpio:
no; se enseña «Conectar otro repo» y la wiki del único repo.

**D2. ¿La wiki se genera sola al conectar un repo?**
Recomendación: **no.** Gastaría IA sin estimación previa (la regla es estimar antes de gastar). En la demo, Giovanni
la deja generada; para un cliente, un admin pulsa «Generar» en cada repo. P1: un botón «Generar las que faltan» con el
costo sumado.

**D3. ¿Se intenta B3 («Analizar todos») esta noche?**
El BACK tiene ≈ 4 h 20 de P0 sin B3 y otras especificaciones en paralelo. Recomendación: **B3 solo si el lote de B0,
B2, B8, B6, B5, B7 y B1 está en producción antes de las 00:15**; si no, plan B directo (§2.3): cada repo con su botón y
el FRONT nunca pinta «Analizar todos». El pedido se cumple igual: varias codebases por org, cada una con su análisis, su
revisión y su wiki.

---

## 13. Correcciones de la revisión (sáb ~19:30)

Cada punto se comprobó contra el código antes de integrarlo. Las líneas que cita el revisor en `estado/modulo.ts`
(124-132, 163-171, 61) no casan con el archivo de hoy (108-116, 158, 58); el fondo sí.

| # | Corrección | Dónde queda | Ajuste o descarte |
|---|---|---|---|
| 1 | El mismo PAT en dos conexiones da 409 | Decisión 2, §1.2, §2.1, §6.1, §7, G3 | — |
| 2 | Choque con el bloqueo de merge | Decisión 14, §2.6, §5.2 (`…0007`), código de E8 con `kind 'read'` | Añadido: E53 elige la conexión del repo del token y E45 no trae `gate` en los demás repos (si no, el FRONT ofrecería activar el bloqueo donde no vale) |
| 3 | «Reconectar» deja de funcionar | Decisiones 4 y 5, §2.1, `rotarSecretoConexion` | Ajustes: tope por nombres distintos y `limit(50)` (las parejas viejas contarían doble); de varias no activas del mismo repo, la más antigua (tiene los hallazgos); `meta` no se reescribe (la clave por repo depende de él) |
| 4 | `repo_fallido` sale en verde | Decisión 6, §2.3 | Descartado `repo_fallido` también en la entrada: cada repo lleva su propio código (`unauthorized`, `no_connection`…) |
| 5 | E6 da por mirados todos los repos con uno | Decisión 8, §2.3 (Y lógico sobre todos), §2.4 (B5) | Ajustes: por nombre de repo (parejas viejas); auditorías viejas → la conexión más antigua (como B7); un ZIP no cuenta con ≥ 2 repos; la cifra sale del mismo recorrido y B5 deja de depender de B3 |
| 6 | B7 depende de B3 | §2.3 (B0 escribe `connection_id`), §2.4 (B7), G5 | — |
| 7 | E40/E41 no comprueban el repo | Decisión 11, §7, B8 | Ampliado a los pasos `arbol` y `area` de la cola. Sin `repo_id`: la petición de wiki no lo trae |
| 8 | El anónimo depende de la conexión activa | §4.2, §6.3 (F3 no se recorta), G1, §11 | — |
| 9 | Sitios que faltaban | §1.3, §1.5, §1.7, §2.3 (`conConexion`), §2.4 (B7), §6.1, §6.5 | — |
| 10 | B0 sin filtro de estado | §2.3 (B0), §6.2, §6.3, G1 | `limit(20)` en vez de `limit(5)`: las parejas viejas de un mismo repo pueden pasar de 5 |
| 11 | Trampas de B3 | §2.3 (requisitos), pruebas de B3 | `findings` por repo con las filas escritas (0 subpeticiones) en vez de un `count` filtrado |
| 12 | B1 depende de B2 | §9.2 | Ampliado: B1 también con B5 y B7 o después (sin ellos, el 2.º repo daría chequeos y wikis falsos) |
| 13 | `setQueryData` usa la clave exacta | §6.2 | Añadido: F2 manda siempre `connectionId`; si no, la clave sin id no casaría con la de `setQueryData` |
| 14 | El chip de repo no debería recortarse | Decisión 9, §6.4 (F4a), §9 | Descartado `evidence.repo` desde el servidor: cambiaría la evidencia de todos los hallazgos de código y con ella la caché del prompt (0004:67-68). «Ver hallazgos» mezclando repos queda como limitación conocida (§2.4) |

Pendiente de comprobar a mano en producción (el MCP de Supabase no conectó): vencimiento del token de la demo, conexiones
GitHub repetidas y pertenencia de Giovanni a «Tienda Demo» (§4.2, paso 0).
