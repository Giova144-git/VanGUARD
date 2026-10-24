# Revisión de código en cada push: especificación y encargos

Especificación del ORQUESTADOR (sáb 24-oct, ~14:00). Revisada a las 14:50 con tres lentes (viabilidad, seguridad y
producto); cada corrección se comprobó contra el código antes de aplicarla. Pedido de Giovanni: «con cada pull request
o merge a main o push a main se haga un code review; en el módulo de Codebase, activable o desactivable; si encuentra
una vulnerabilidad, llamada o mensaje; en configuración el usuario elige el canal y la severidad mínima para cada uno».
Las llamadas llegan después: la preferencia se guarda y la UI dice «Próximamente».

> **Actualización (sáb 24-oct, ~16:30), decisiones de Giovanni de §13:**
> - **D1: «Reglas y PR hoy».** Los `pull_request` abiertos contra la rama vigilada (opened, synchronize, reopened,
>   ready_for_review) pasan a **P0** (B7, después de B4+B5). Sin IA. Donde este documento dice «PR: P1», manda esto.
> - **D3: el repo de la demo es `vanguard-demo-victima` de Gabriel.** Gabriel ya es admin de «Tienda Demo» para conectar
>   su PAT (Contents: Read basta para el compare: verificación 1 de §9 hecha por el BACK) y añade a Giovanni al repo.
> - **D2 (tramo del guion):** pendiente; se decide tras el corte de las 19:30.
> - Cambios del BACK al aplicar la 0013 (e0ea65e), que ya lleva la 0013c dentro: `code_reviews.push_commits` (≤ 50 SHA del
>   payload firmado) evita repetir en el merge lo avisado en el PR sin pedir nada a GitHub (un squash o un rebase vuelven a
>   avisar); `reported_keys` = `dedupe_key:huella`; `alert_reason` nuevos con `state none`: `fork` y `ya_avisado_pr`.
> - Plantilla de Meta `alerta_seguridad_v1` creada en la WABA del número real (UTILITY, PENDING); su envío sigue en P1.

Qué cambió con la revisión: §11. Correcciones descartadas: §12. Decisiones abiertas para Giovanni: §13.

Código leído antes de decidir: `apps/api/src/jobs.ts`, `scans/repo.ts`, `scans/repo-paso.ts`, `scans/osv.ts`,
`scans/comun.ts`, `rutas/connections.ts`, `rutas/ingest.ts`, `rutas/webhooks-kapso.ts`, `rutas/notifications.ts`,
`rutas/findings.ts`, `rutas/overview.ts`, `notify/despachador.ts`, `notify/kapso.ts`, `lib/hmac.ts`, `lib/credentials.ts`,
`lib/http.ts`, `lib/verificacion.ts`, `mw/prod-host.ts`, `mw/anon.ts`, `app.ts`, `cron.ts`, `wrangler.jsonc`, `.dev.vars`,
`packages/contracts/src/{api,comun,codebase,index}.ts`, `fixtures/`, `packages/core/src/{secrets/scan.ts,secrets/rules.ts,
engine/notify-plan.ts,engine/edge.ts,templates/whatsapp.ts,templates/titles.ts,crypto.ts,redact.ts,egress.ts}`,
migraciones 0001, 0003, 0004, 0005, 0008, 0008b, 0008c, 0008g, 0008h, 0008i, 0009–0012, `PLAN_MAESTRO.md` §15.4, la web
(`modulos/codebase/PaginaCodebase.tsx`, `modulos/ajustes/PaginaAjustes.tsx`, `componentes/vg/PantallaModulo.tsx`,
`lib/realtime.ts`, `lib/mutaciones.ts`, `lib/fixtures/router.ts`), `demo/guion.md` y `docs/PASOS_MANUALES_GIOVANNI.md`
(paso 9).

Documentación de GitHub consultada hoy: «Compare two commits» (REST), «Validating webhook deliveries», «Webhook events
and payloads», «Handling failed webhook deliveries» y «Best practices for using webhooks» (al reenviar, «the
X-GitHub-Delivery header will be the same as in the original delivery»).

---

## 0. Decisiones en una tabla

| Tema | Decisión | Por qué (dato) |
|---|---|---|
| Disparador P0 | Webhook de repositorio que el usuario pega a mano en GitHub | Llega en 1–3 s; el PAT es de solo lectura y no puede crear webhooks; el sondeo por cron tarda hasta 60 s y gasta cuota |
| Eventos | `push` a la rama vigilada (P0). Un merge de PR (merge, squash o rebase) llega como `push` y entra en P0. `pull_request` abierto contra la rama: **P0 tras D1** (B7, después de B4+B5), con filtro de forks | El P0 mínimo demostrable sigue siendo push → WhatsApp; Giovanni pidió los PR hoy (D1, §13) |
| Rama vigilada | `connections.meta.default_branch` al activar y al reactivar | `probarGithub` ya la guarda |
| Qué se revisa | Solo las líneas AÑADIDAS del diff `base...head` (una subpetición a `api.github.com`), escaneadas en compacto y devueltas a su línea de head | El costo depende del texto añadido (≤ 512 KB), no del número de línea |
| Reglas | P0: `CB_SECRET_*` y `CB_ENV_COMMITTED`. P1: `CB_GITIGNORE_NO_ENV` y `CB_DEP_VULN` (OSV en un paso propio). No hay `CR_*` | `findings.rule_id` y `RuleId` solo admiten `^(SB\|CF\|CB\|PF)_`. El detalle de OSV cuesta ~7 ms de los 10 de CPU y la auditoría ya lo separa en `repo:osv` |
| Dónde corre | Webhook: firma, host, ritmo y encolar (202). Trabajo: cola `vg-jobs` con un mensaje nuevo `kind:'review'` | 10 ms de CPU y 50 subpeticiones por invocación |
| Registro | Tabla nueva `code_reviews`, NO `scan_runs` | `overview.ts`, `estado/modulo.ts` y `scans/cobertura.ts` leen el último `scan_runs` de cualquier tipo: una revisión pasaría por «última auditoría» y movería puntaje y cobertura |
| «Nuevo» | No es nuevo el mismo secreto en el mismo sitio, ni el mismo secreto (regla + `fingerprint_short`) en otro sitio, si están `open` o `ignored`. `fixed`/`verified` reaparece. Otro valor en la misma línea sí es nuevo | Un mismo secreto no avisa dos veces; un `ignored` no tapa una clave distinta |
| Aviso | Peor severidad nueva ≥ umbral de WhatsApp de la org; mientras no haya llamadas, vale también el umbral de llamada. Una revisión incompleta (`partial`) también avisa. Texto fijo a contactos verificados | Regla determinista; la IA no decide ni escribe; un push grande no puede pasar en silencio |
| Topes | Cupo propio: 3 revisiones avisadas por org y hora (10 en la org de demo). No gastan el tope de los ataques | Unos pocos pushes no pueden dejar sin aviso un ataque real |
| Idempotencia | Unique de `code_reviews` por (config, evento, head_sha, PR); «Redeliver» reabre una revisión `failed` o atascada. Unique de `notifications` por (revisión, canal, destinatario). Sin `webhook_events` | GitHub conserva `X-GitHub-Delivery` al reenviar: un dedupe por delivery grabado antes del trabajo bloquearía justo el reintento |
| Fuera de 24 h | No se envía (fila `failed`/`window_closed`); queda en la app. El 131047 que Meta devuelve después se muestra igual | No hay plantillas aprobadas por Meta |
| Llamada | Se guarda el umbral. Mientras no haya llamadas, lo que lo pase sale por WhatsApp y `voice_pending` queda marcado; Ajustes lo dice | Voz no implementada; un aviso pedido no se pierde |
| IA | Nada nuevo en P0. «Generar prompt de corrección» (E15) ya sirve para los hallazgos del push | Costo 0 y nada de IA en WhatsApp |
| Rutas | E45–E49 en P0 (E46 sin rotar el secreto), E50 en P1 (E38 y E39 siguen libres; E40–E44 son la wiki) | Bloque contiguo tras la wiki |
| Migración | `0013` no toca `private.looks_like_secret` ni `webhook_events` | Ampliar el cable trampa a `vgw_` sin cambiar a la vez su copia en `engine/edge.ts` deja esquivar alertas del borde; el `vgw_` nunca va en una fila |
| `wrangler.jsonc` | Sin cambios | `JOBS_Q`, `RL_COSTLY`, `APP_ORIGIN` y `/webhooks/*` ya existen; no hace falta cron |

---

## 1. Disparador

### 1.1 Comparación

| Criterio | A. Webhook de GitHub pegado a mano | B. Sondeo por cron con el PAT |
|---|---|---|
| Demo en vivo | GitHub entrega en 1–3 s. Con la cola y Kapso, el WhatsApp llega en ~5–10 s | El cron es por minuto: de 0 a 60 s de espera, más la cola. Media ~35 s |
| Permisos del PAT | No cambian. El webhook lo crea el usuario en la UI de GitHub. Crearlo por API exigiría «Webhooks: write», contra el principio de solo lectura | `contents:read` para la rama. Para ver PR haría falta «Pull requests: read», que la guía actual no pide: el usuario tendría que rehacer el token |
| Configuración | 6 campos en GitHub (URL, tipo, secreto, eventos). El `ping` confirma que quedó bien | Ninguna |
| Cuota de peticiones | 1 petición al Worker por evento (de 100.000/día) | 1–2 llamadas a GitHub por repo y minuto (1.440–2.880/día). Dentro del cron por minuto compiten con `housekeeping` por las 50 subpeticiones; en la cola gastarían ~4.300 operaciones/día por repo de las 10.000 del plan (A7.4 ya sacó el monitor de la cola por esto) |
| CPU | HMAC nativo + `JSON.parse` de 10–60 KB, después de autenticar | Una llamada por repo cada minuto, haya o no cambios |
| PR | Evento propio con `base.sha` y `head.sha` | Hay que listar PR abiertos y guardar sus head |
| Fallos | GitHub NO reintenta solo una entrega fallida y corta a los 10 s. Hay «Redeliver» manual | Robusto a pérdidas: compara contra el último visto |
| Crons | Ninguno nuevo (siguen 3 de 5) | Reusa el de minuto |

### 1.2 Decisión

**P0: webhook (A).** Es lo único que da «push a main → WhatsApp en segundos» sin tocar permisos ni cuotas. El sondeo (B)
queda como respaldo P2 para quien no pueda añadir webhooks. Una revisión que falló se repite con «Redeliver» (E47 la
reabre). La pérdida de una entrega (413, 429, 500) se cubre en P1 (§2.9): la siguiente revisión compara desde el último
`head` revisado.

### 1.3 Eventos y acciones que se revisan

| Evento (`X-GitHub-Event`) | Condición | Qué hace | Prioridad |
|---|---|---|---|
| `ping` | Siempre (también con la revisión apagada) | Marca `last_ping_at` y `hook_events`. Si `repository.id` no es el de la conexión → `last_error = 'otro_repo'`; si `hook.events` no trae `push` ni `*` → `'sin_push'`; si no, borra `last_error` y queda «Conectada» | P0 |
| `push` | `ref = refs/heads/<rama vigilada>`, `deleted = false`, `before` y `after` de 40 hex, `before ≠ 000…0` | Revisión `base = before`, `head = after`. Un merge de PR (merge, squash o rebase) es un push a la rama: entra aquí | P0 |
| `pull_request` | `action ∈ {opened, synchronize, reopened, ready_for_review}` y `pull_request.base.ref = rama vigilada` | Revisión `base = pull_request.base.sha`, `head = pull_request.head.sha`, con `pr_number`. Solo avisa si `pull_request.head.repo.id = repository.id` (no es un fork) o si `author_association ∈ {OWNER, MEMBER, COLLABORATOR}`; un PR de un fork se revisa solo en la app (`alert_reason 'fork'`). Hasta el P1 responde 202 `ignorado: 'pr_p1'` | P1 |
| Otros (`closed`, `edited`, `create`, `delete`…) | — | 202 `ignorado: 'evento'` | — |

El usuario marca en GitHub «Pushes» y «Pull requests» desde el primer día (la tarjeta dice que el PR abierto llega
pronto). Así no tiene que volver a configurar nada cuando entre el P1.

### 1.4 Rama vigilada

- `code_review_configs.branch` = `connections.meta.default_branch` al activar y cada vez que se reactiva (E46 con
  `enabled` de false a true). Se valida con `^[A-Za-z0-9._/-]{1,100}$`; si falta o no pasa, E46 responde 409.
- Nunca se toma del payload. Un cambio de rama por defecto en GitHub se recoge al «Probar» la conexión (actualiza
  `meta`) y desactivar y volver a activar la revisión.
- Push forzado: el diff de tres puntos parte de la base común; se revisa lo que no estaba.

---

## 2. Qué hace la revisión

### 2.1 Flujo

```
GitHub ──POST /webhooks/github/:id──▶ E47: firma → host real → ritmo → code_reviews (queued, o reabre una failed) → JOBS_Q.send(diff) → 202
                                               │
vg-jobs  ── {kind:'review', paso:'diff'} ──▶ diff: claim → compare (PAT) → reglas → vg_review_findings → ¿aviso?
                                               │ alert_state = 'pending'
vg-jobs  ── {kind:'review', paso:'aviso'} ─▶ aviso: plan (core) → notifications queued → Kapso → sent/failed
```

P1: un paso `osv` entre `diff` y `aviso` (§2.4). En P0, dos invocaciones como mucho (tres con el webhook), cada una con
sus 10 ms y sus 50 subpeticiones.

**E47 y el manejador de `kind:'review'` salen en el MISMO deploy.** Hoy `runJob` confirma (`ack`) un `kind` desconocido
como `job.sin_manejador` (`apps/api/src/jobs.ts`): si E47 llegara antes, las revisiones se quedarían en `queued` para
siempre (no hay vigilante en P0).

### 2.2 Lectura del diff

- `GET https://api.github.com/repos/{meta.repo_full_name}/compare/{base}...{head}` con el PAT de la conexión
  (`withSecret`), `Accept: application/vnd.github.diff`, `X-GitHub-Api-Version: 2022-11-28` (`ghHeaders` de `repo.ts`).
- Una sola subpetición (más hasta 3 saltos si el repo se renombró: `pedir` solo sigue saltos al mismo host).
- Se lee con `leerAcotado(r, LIM_REVISION.diffBytes, undefined, { ignorarLargo: true })`: lee con el lector hasta 1 MB y
  corta ahí aunque el `Content-Length` diga más. Hoy, con un `Content-Length` mayor que el tope, `leerAcotado` devuelve
  texto vacío sin leer nada (`scans/repo.ts`): un diff de 1,1 MB no se escanearía en absoluto. La opción es nueva y no
  cambia el comportamiento por defecto de la auditoría. Lo leído se escanea; el corte marca `partial`.
- El formato diff evita el `JSON.parse` del compare (lo caro en CPU) y se puede cortar a mitad.
- `repo`, `base` y `head` salen de la conexión y de la fila de la revisión, nunca de URLs del payload. Los SHA se
  validan con `^[0-9a-f]{40}$` antes de armar la URL.

Topes (`LIM_REVISION`, en `apps/api/src/revision/pasos.ts`; `error_code` entre paréntesis):

| Tope | Valor | Si se pasa |
|---|---|---|
| Bytes del diff | 1.000.000 | Se corta la lectura; `partial` (`diff_grande`) |
| Archivos | 300 | El resto no se mira; `partial` (`diff_grande`) |
| Texto añadido total | 512 KB | El resto no se escanea; `partial` (`diff_grande`) |
| Ruta entre comillas (git cita las rutas con espacios o no ASCII) | — | P0: se salta el archivo; `partial` (`binario`). P1: se decodifica |
| Binario que no es multimedia (`Binary files … differ` o `GIT binary patch` con una extensión fuera de la lista de medios) | — | No se escanea; `partial` (`binario`). Así un `.ts` con un byte NUL no esconde una clave |

Toda revisión `partial` avisa como «revisión incompleta» (§5). Los topes a la mitad en el reintento son P1: en P0, una
revisión que agota la CPU tres veces acaba en la DLQ (`failed`/`dlq`).

Respuestas de GitHub:

| Respuesta | Qué pasa |
|---|---|
| 401, o 403 sin cabeceras de límite (token sin acceso, aprobación de la organización revocada) | `failed` con `error_code 'unauthorized'` o `'forbidden'` (`codigoGithub`) y `config.last_error = 'token'` |
| 404 | `failed` `not_found` (SHA borrado por un push forzado, o un PAT que ya no tiene el repo seleccionado). P1: si también falla el `base`, `last_error 'token'` |
| 406/422 (diff demasiado grande para GitHub) | RPC sin filas, `partial` y `error_code 'diff_grande'`: avisa como incompleta; la UI propone la auditoría completa |
| 429, 403 con límite, 5xx, red o plazo | `ProviderError` y la cola reintenta (2 veces) |

### 2.3 Del diff a texto compacto (core, puro)

`packages/core/src/revision/diff.ts`:

```ts
export type LineaDiff = { t: '+' | ' ' | '-'; texto: string; linea: number | null };   // linea = número en head
export type ArchivoDiff = { path: string; estado: 'added' | 'modified' | 'deleted' | 'renamed'; binario: boolean;
  lineas: LineaDiff[] };
export const LIM_DIFF = { archivos: 300, bytesAnadidos: 512_000 };
/** cortado: tope de archivos o de texto, ruta entre comillas o binario que no es multimedia. */
export function parsearDiff(texto: string, lim = LIM_DIFF): { archivos: ArchivoDiff[]; cortado: boolean };
/** Solo las líneas añadidas, una tras otra; lineas[i] = línea de head de la línea i + 1 del texto. */
export type ArchivoCompacto = { archivo: ArchivoTexto; lineas: number[] };
export function archivoCompacto(a: ArchivoDiff): ArchivoCompacto | null;   // null si binario, borrado o sin añadidas
/** escanearSecretos sobre los compactos, sin rebajar por ruta de pruebas, y vuelta a la línea de head. */
export function secretosDelDiff(cs: readonly ArchivoCompacto[], opts: OpcionesSecretos): Promise<BorradorCodebase[]>;
/** CB_ENV_COMMITTED de los .env* añadidos o renombrados, sin gitignore_lo_lista (la revisión no lee el .gitignore). */
export function envDelDiff(as: readonly ArchivoDiff[], cs: readonly ArchivoCompacto[]): BorradorCodebase[];
```

- `parsearDiff` entiende `diff --git`, `new file mode`, `deleted file mode`, `rename from/to`, `Binary files … differ`,
  `GIT binary patch`, `+++ b/<ruta>`, `+++ /dev/null`, `@@ -a,b +c,d @@`, líneas `+`, `-`, ` ` y
  `\ No newline at end of file`. Quita el `\r` final. Una ruta entre comillas se salta con `cortado` (P1: decodificarla).
- Salta `node_modules`, `vendor`, `dist`, `build` y `.git`, y reconoce los medios, con copias propias de `FUERA` y
  `BINARIO`: en `apps/api/src/scans/repo.ts` son `const` sin exportar y `core` no puede importar de `apps/api`.
- `archivoCompacto` junta las líneas añadidas con `\n`. CPU y memoria van con el texto añadido (≤ 512 KB). Un archivo
  sintético rellenado hasta su línea de head generaría N saltos para una línea añadida en la línea N, y `scanArchivo`
  pasa `toLowerCase` por todo el texto y arma un arreglo con todos los saltos (`secrets/scan.ts`): con 300 archivos,
  decenas de millones de caracteres.
- `secretosDelDiff` llama a `escanearSecretos(compactos, { ...opts, rebajarPruebas: false })` y vuelve a la línea de
  head con `lineas`: rehace `evidence.line`, `evidence.ubicaciones[].line`, `resource = recurso(prefijo, ruta:línea)` y
  `dedupe_input = resource`. Pide dos cambios pequeños en `secrets/scan.ts`: exportar `recurso` y la opción
  `rebajarPruebas` (por defecto true: la auditoría no cambia). La correspondencia crece con la línea dentro de cada
  archivo, así que el orden de `porUbicacion` se mantiene. El `snippet` enseña las líneas añadidas vecinas, no las reales;
  va redactado como siempre.
- `envDelDiff`: `reglasEnv(rutasEnvAñadidas, compactosEnv).filter((r) => r.rule_id === 'CB_ENV_COMMITTED')` y quita
  `evidence.gitignore_lo_lista`. Sin el `.gitignore`, `reglasEnv` lo deja en false en cada `.env` y E15 podría aconsejar
  añadir a `.gitignore` algo que ya está.
- Los lockfiles no se escanean como texto (`scanArchivo` ya los salta).

### 2.4 Reglas, `rule_id` y severidades

| Qué se busca | Cómo | `rule_id` | Severidad | Prioridad |
|---|---|---|---|---|
| Secreto en una línea añadida | `secretosDelDiff(compactos, { huella: (v) => fingerprint(keys, org, v) })` | Los 10 `CB_SECRET_*` actuales | La del escáner: critical (service_role, `sb_secret_`, AWS, Stripe live, Anthropic, OpenAI, PAT de GitHub, clave privada); Postgres high, o critical si el host es de Supabase; genérica medium. En rutas de prueba las reglas específicas NO bajan; solo la genérica baja a low | P0 |
| `.env` añadido o renombrado a `.env*` | `envDelDiff` | `CB_ENV_COMMITTED` | critical | P0 |
| `.gitignore` tocado que ya no excluye `.env` | Si el diff toca `.gitignore`: se lee entero en head (`contents/.gitignore?ref=<head>`, crudo, ≤ 100 KB, 1 subpetición) y `reglasEnv(['.gitignore'], [{…}]).filter(GITIGNORE)`. Borrado → `existe_gitignore: false` | `CB_GITIGNORE_NO_ENV` | medium | P1 |
| Dependencia añadida o con versión nueva en el lockfile | `depsDelDiff` en el paso `diff` → mensaje `{v:1, kind:'review', org_id, review_id, paso:'osv', deps: DepCompacta[]}` que reutiliza `depsVulnerables`, `detallar` (≤ 12) y `filaDep` como `repo:osv` y cierra con `vg_review_findings` | `CB_DEP_VULN` | La de OSV (`MAL-` = critical; sin detalle = medium) | P1 |

**Rutas de prueba.** Hoy `escanearSecretos` baja a low todo secreto cuyas ubicaciones estén en rutas de prueba
(`RUTA_PRUEBAS`: `__tests__/`, `fixtures/`, `*.test.*`, `*.spec.*`). En la revisión la ruta la elige quien empuja: una
clave live de Stripe en `pagos.test.ts` quedaría bajo el umbral por defecto. Con `rebajarPruebas: false` la severidad es
`enPruebas && (opts.rebajarPruebas !== false || p.rule_id === 'CB_SECRET_GENERIC') ? 'low' : p.severity`; `en_pruebas`
y el sufijo «(en pruebas)» del título se quedan como dato.

`depsDelDiff` (P1) lee el parche, no el lockfile entero (sin `JSON.parse` de 1 MB y sin pedir la base):

- `package-lock.json` v2/v3: recuerda la última clave `"…node_modules/<nombre>": {` (línea de contexto o añadida) y emite
  `(npm, nombre, versión)` en cada línea AÑADIDA `"version": "<v>"`. El nombre es lo que sigue al último
  `node_modules/` (con `@scope/`). La clave se olvida al empezar otro hunk. v1 queda fuera.
- `composer.lock`: igual con `"name": "vendor/paquete"` y la línea añadida `"version"`, quitando la `v` inicial como
  `fromComposerLock`.
- `dev` = false (más prudente para la urgencia). `pnpm-lock.yaml`, `yarn.lock` y rangos de `package.json` quedan fuera.

Todos los borradores llevan en `evidence` `fuente: 'github'` y `sha: <head_sha>` (`CodebaseEvidence` ya los admite).

**Por qué no hay `CR_*`:** el check de `findings.rule_id` (0004) y `RuleId` del contrato solo aceptan
`^(SB|CF|CB|PF)_[A-Z0-9_]+$`. Con `CB_*`, E15 (prompt de corrección) y los títulos por regla funcionan sin cambios, y la
`dedupe_key = sha256(org|regla|recurso)` coincide con la de la auditoría cuando el secreto tiene la misma primera
ubicación. Cuando no (un push copia a otro archivo un secreto ya conocido; la auditoría agrupa por huella y usa la
primera ubicación), la regla de huella de §2.5 evita el duplicado.

### 2.5 Qué es «nuevo» y deduplicación

- Antes de la RPC: `recortar(borradores, 200)` → `aFila` (redact + `dedupe_key`; hay que exportarla de `scans/comun.ts`)
  → `ocultarRutas` (nueva, en `revision/pasos.ts`; la revisión NO usa `prefiltrar`):
  - si `title` o `resource` casan con `PARECE_SECRETO` (el cable trampa en JS, sin `\b`): `resource` =
    `'[ruta oculta]#' + <8 primeros hex de sha256(resource)>`, `title` = el de la regla sin ruta («Clave … en el código»,
    «Archivo .env subido al repositorio») y `evidence = {redacted: true}`. Se conservan `rule_id`, severidad y la
    `dedupe_key` que ya calculó `aFila`. No se descarta nada; `error_code 'tripwire'` solo informa;
  - si solo casa la evidencia: `evidence = {redacted: true}`, como `prefiltrar`;
  - por qué: `prefiltrar` descarta la fila entera y la ruta la elige quien empuja. Con una clave real en
    `lib/x_ghp_000000000000000000000000/pagos.ts`, `redact()` no tapa la ruta (exige `\b` y `x_ghp_` no lo tiene), el
    cable trampa sí la ve y el hallazgo desaparecería sin aviso.
- `vg_review_findings` (0013) decide en UNA transacción, con un candado consultivo por org. Huella =
  `evidence.fingerprint_short` (8 hex del HMAC de la org; solo `CB_SECRET_*`):
  - no es nuevo si hay una fila `open`/`ignored` en el mismo sitio (`dedupe_key`) con la misma huella, o sin huella en
    alguno de los dos lados;
  - tampoco si el mismo secreto (misma regla y huella) está `open`/`ignored` en otro sitio: no avisa ni se inserta;
  - sí es nuevo si no hay fila, si la fila está `fixed`/`verified` (reaparece) o si en el mismo sitio hay OTRO valor. En
    ese último caso la fila se reabre aunque estuviera `ignored` (`status_reason 'otro valor en la misma línea…'`): un
    `ignored` vale para ese valor, no para la línea;
  - en un PR (P1), tampoco lo que ya se avisó en la revisión anterior del mismo PR (`reported_keys`).
- Push (`p_write = true`): se escriben en `findings` (inserta o reabre). Las que ya estaban abiertas con el mismo valor
  solo tocan `last_seen_at`: no se pisa la evidencia de la auditoría ni su prompt en caché.
- PR (`p_write = false`, P1): no se escribe en `findings`. El código aún no está en la rama; quedaría abierto si el PR se
  cierra sin merge. Lo encontrado vive solo en la revisión.
- Los hallazgos insertados por una revisión van con `connection_id = null` (como los del ZIP). Motivo: la auditoría solo
  lee ~20 archivos de riesgo y con `p_complete = true` marcaría `verified` («no reapareció») un secreto de un archivo
  que nunca leyó. Con `null` su auto-verificación no los toca. Una org tiene un solo repo (E8), así que el recurso
  `ruta:línea` no es ambiguo.
- Consecuencia: ninguna auditoría los cierra sola (la auto-verificación solo toca `connection_id = p_conn` y el
  `on conflict` de `vg_upsert_findings` no cambia `connection_id`). Se cierran con «Marcar arreglado»; la tarjeta y el
  detalle lo dicen. P1: que `vg_upsert_findings` adopte la fila (`connection_id = coalesce(f.connection_id,
  excluded.connection_id)`) cuando la auditoría la vea.
- Un secreto que solo cambia de línea no vuelve a ser nuevo mientras el mismo valor siga abierto (regla de huella).

### 2.6 IA

- P0: ninguna llamada nueva. Costo 0.
- Los hallazgos de un push están en `findings`: «Generar prompt de corrección» (E15) ya funciona con sus topes.
- P2: resumen de la revisión en la app (ruta nueva de `ai_usage` y `vg_ai_reserve`). Nunca decide alertas y nunca va
  en el WhatsApp.

### 2.7 Subpeticiones y CPU del paso `diff`

| Qué | Subpeticiones |
|---|---|
| Claim (CAS) | 1 |
| Config + conexión | 2 |
| PAT (`connection_secrets` + llaves en frío) y llaves de huella | ≤ 6 |
| Compare (+3 saltos si el repo se renombró) | ≤ 4 |
| `last_error = 'token'` (solo con 401/403) | ≤ 1 |
| `vg_review_findings` | 1 |
| Encolar `aviso` | 1 |
| **Total** | **≤ 16 de 40** |

CPU: leer y partir ≤ 1 MB y pasar las regex solo por el texto añadido compacto (≤ 512 KB, con el prefiltro por palabra
clave de `scanArchivo`). OSV va en su propio paso (P1). Se mide `ms` en el log `revision.fin` (§9).

### 2.8 Paso `aviso`

Ver §5. Subpeticiones: lectura de revisión, prefs, contactos, org, revisiones avisadas en la última hora y ventana de
demo (≤ 6) + por contacto insert, envío (≤ 2) y cierre (4 × ≤ 5) + cierre de la revisión (1) ≈ 27.

### 2.9 P1 de robustez

- `base` = último `head_sha` revisado (`done`, `push`) de esa rama en las últimas 24 h; si no hay, `before`. El diff de
  tres puntos parte de la base común, así que no hace falta comprobar que sea ancestro. Un push perdido (413, 429, 500)
  se revisa en el siguiente. Es un SELECT.
- E50 «Revisar el último push» (manual).
- Vigilante: `code_reviews` en `queued`/`running` más de 15 min → `failed` `interrumpida` (en `housekeeping`). Hasta
  entonces E45 las muestra así sin escribir.
- Retención de 90 días en `vg_purge_daily` (`0013b`).
- Topes a la mitad en el reintento (`m.attempts ≥ 2`): la revisión termina parcial en vez de ir a la DLQ.
- `last_error = 'firma'` con una escritura por minuto como mucho (`last_error_at`).
- Generar otro secreto (`rotate_secret`).
- Enfriamiento de 10 min por org entre avisos de revisión.

---

## 3. Modelo de datos: `supabase/migrations/0013_revision_codigo.sql`

Lo escribe y lo aplica el BACK (`list_migrations` antes; dev y prod son el mismo proyecto). Es un borrador cerrado en
columnas y nombres; el BACK lo prueba con `supabase/tests/revision.sql` antes de aplicarlo. Se aplica ANTES del deploy
que toca `despachador.ts` (B5): su consulta filtra por `notifications.code_review_id`, que no existe sin 0013.

```sql
-- 0013_revision_codigo.sql · Revisión de código en cada push (docs/plan_maestro_trabajo/asignaciones/revision-codigo.md).
-- Tres tablas solo del servidor (RLS sin políticas y sin grants a anon/authenticated, como 0008h y 0010), una columna y
-- dos checks en notifications y la RPC vg_review_findings. No toca private.looks_like_secret (el secreto vgw_ va sellado
-- y nunca se escribe en claro; ampliar el check sin cambiar a la vez su copia en engine/edge.ts dejaría esquivar alertas
-- del borde) ni webhook_events (la idempotencia la da el unique de code_reviews).

-- 1) Preferencias de aviso por org. En P0 solo las usa la revisión de código; el motor en vivo sigue con su regla fija
-- (high → WhatsApp, critical → llamada) para no tocar la demo del ataque. Sin fila = valores por defecto.
create table if not exists public.alert_prefs (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  review_whatsapp_min text not null default 'high' check (review_whatsapp_min in ('critical','high','medium','low','off')),
  review_voice_min text not null default 'critical' check (review_voice_min in ('critical','high','medium','low','off')),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now());

-- 2) Configuración de la revisión: una por conexión GitHub. El secreto del webhook va sellado aquí (Box de 05.7) con
-- AAD (org_id, id de ESTA fila, 'github', 'read'): no se puede mover a otra fila ni a otra org. Borrar la conexión
-- borra la config y sus revisiones.
create table if not exists public.code_review_configs (
  id uuid primary key,                          -- lo genera el Worker: va en la URL del webhook y en el AAD
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null,
  enabled boolean not null default true,
  branch text not null check (branch ~ '^[A-Za-z0-9._/-]{1,100}$'),
  secret_sealed jsonb not null check (secret_sealed ?& array['v','kid','iv','ct','ivk','wdek']),
  secret_kid text not null check (secret_kid ~ '^v[0-9]{1,3}$'),
  secret_last4 text check (char_length(secret_last4) <= 4),
  hook_events text[] not null default '{}' check (cardinality(hook_events) <= 30),   -- los del último ping
  last_ping_at timestamptz,
  last_event_at timestamptz,
  last_error text check (last_error in ('firma','otro_repo','sin_push','token')),
  last_error_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id),
  unique (id, org_id),
  foreign key (connection_id, org_id) references public.connections (id, org_id) on delete cascade,
  check (secret_sealed->>'kid' = secret_kid));

-- 3) Una fila por revisión. new_findings = hasta 50 nuevos, ya redactados (sin evidencia). reported_keys = dedupe_keys de
-- todo lo encontrado (lo usará el PR en P1 para no repetir el aviso en el siguiente synchronize).
create table if not exists public.code_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  config_id uuid not null,
  event text not null check (event in ('push','pull_request','manual')),
  delivery_id text check (delivery_id ~ '^[0-9A-Fa-f-]{36}$'),
  branch text not null check (branch ~ '^[A-Za-z0-9._/-]{1,100}$'),
  pr_number int check (pr_number > 0),
  base_sha text not null check (base_sha ~ '^[0-9a-f]{40}$'),
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  error_code text check (error_code ~ '^[a-z_]{2,40}$'),
  partial boolean not null default false,
  files_changed int not null default 0 check (files_changed >= 0),
  lines_added int not null default 0 check (lines_added >= 0),
  counts jsonb not null default '{"critical":0,"high":0,"medium":0,"low":0,"info":0}',
  max_severity text check (max_severity in ('critical','high','medium','low','info')),
  new_findings jsonb not null default '[]'
    check (jsonb_typeof(new_findings) = 'array' and jsonb_array_length(new_findings) <= 50),
  reported_keys text[] not null default '{}' check (cardinality(reported_keys) <= 200),
  alert_state text not null default 'none' check (alert_state in ('none','pending','sent','not_sent')),
  alert_reason text check (alert_reason ~ '^[a-z_]{2,40}$'),
  voice_pending boolean not null default false,
  notified_at timestamptz,
  created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz,
  foreign key (config_id, org_id) references public.code_review_configs (id, org_id) on delete cascade,
  check (event <> 'pull_request' or pr_number is not null),
  check (not private.looks_like_secret(new_findings::text)));
-- Un mismo commit no se revisa dos veces por el mismo evento. Una revisión failed se reabre con UPDATE (E47), no con otra
-- fila. Las manuales (P1) sí pueden repetirse.
create unique index if not exists code_reviews_unica_uidx
  on public.code_reviews (config_id, event, head_sha, coalesce(pr_number, 0)) where event <> 'manual';
create index if not exists code_reviews_org_created_idx on public.code_reviews (org_id, created_at desc);
create index if not exists code_reviews_pr_idx on public.code_reviews (config_id, pr_number, created_at desc)
  where pr_number is not null;

-- 4) notifications: el aviso de una revisión cuelga de la revisión, no de un incidente. Una sola fila por revisión,
-- canal y destinatario (23505 = ya avisado, como el unique de 0005 para incidentes).
alter table public.notifications add column if not exists code_review_id uuid
  references public.code_reviews(id) on delete cascade;
alter table public.notifications drop constraint if exists notifications_incidente_o_prueba;
alter table public.notifications add constraint notifications_incidente_o_prueba
  check (incident_id is not null or template = 'test_v1' or (code_review_id is not null and template = 'code_review_v1'));
alter table public.notifications drop constraint if exists notifications_un_origen;
alter table public.notifications add constraint notifications_un_origen check (incident_id is null or code_review_id is null);
create unique index if not exists notifications_revision_uidx
  on public.notifications (code_review_id, channel, recipient_masked) where code_review_id is not null;

-- 5) Solo el Worker (service_role). Decisión (a): los datos van por /api; anon y authenticated no leen nada.
alter table public.alert_prefs enable row level security;
alter table public.code_review_configs enable row level security;
alter table public.code_reviews enable row level security;
revoke all on public.alert_prefs, public.code_review_configs, public.code_reviews from anon, authenticated;
grant select, insert, update, delete on public.alert_prefs, public.code_review_configs, public.code_reviews to service_role;

-- 6) Cierre del paso 'diff' en UNA transacción. p_rows = filas ya pasadas por aFila (redact, dedupe_key) y ocultarRutas.
-- p_write = true en push (escribe en findings), false en PR (P1). p_meta = {files_changed, lines_added, partial,
-- error_code}. Candado por org: dos revisiones a la vez no cuentan el mismo hallazgo como nuevo. CAS: solo cierra una
-- revisión en 'running' de ESA org, una vez.
create or replace function public.vg_review_findings(p_org uuid, p_review uuid, p_rows jsonb, p_write boolean, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v public.code_reviews%rowtype;
  v_rows jsonb := coalesce(p_rows, '[]'::jsonb);
  v_parcial boolean := coalesce((p_meta->>'partial')::boolean, false);
  v_new jsonb;
  v_max text;
  v_wa text;
  v_voz text;
  v_alert text := 'none';
  v_reason text;
begin
  if jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) > 200 then
    raise exception 'p_rows' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('vg_review|' || p_org::text));
  select * into v from public.code_reviews r
   where r.id = p_review and r.org_id = p_org and r.status = 'running' for update;
  if v.id is null then return jsonb_build_object('applied', false); end if;

  -- Nuevo (§2.5), ANTES del upsert. fp = evidence.fingerprint_short (solo CB_SECRET_*). No es nuevo si hay una fila
  -- open/ignored (a) en el mismo sitio con el mismo valor, o sin huella en alguno de los dos lados, o (b) del mismo
  -- secreto (regla + huella) en otro sitio. fixed/verified en el mismo sitio reaparece; otro valor en el mismo sitio es
  -- nuevo. P1 (PR): tampoco lo ya avisado en la revisión anterior del mismo PR (reported_keys).
  select coalesce(jsonb_agg(d.x order by private.sev_rank(d.x->>'severity') desc, d.x->>'dedupe_key'), '[]'::jsonb)
    into v_new
    from (select distinct on (e->>'dedupe_key') e as x from jsonb_array_elements(v_rows) e order by e->>'dedupe_key') d
   where not exists (select 1 from public.findings g
                      where g.org_id = p_org and g.dedupe_key = d.x->>'dedupe_key' and g.status in ('open', 'ignored')
                        and (g.evidence->>'fingerprint_short' is null
                             or d.x->'evidence'->>'fingerprint_short' is null
                             or g.evidence->>'fingerprint_short' = d.x->'evidence'->>'fingerprint_short'))
     and not exists (select 1 from public.findings g
                      where g.org_id = p_org and g.rule_id = d.x->>'rule_id' and g.status in ('open', 'ignored')
                        and g.dedupe_key <> d.x->>'dedupe_key'
                        and g.evidence->>'fingerprint_short' = d.x->'evidence'->>'fingerprint_short');

  if p_write then
    -- connection_id null a propósito: la auto-verificación de la auditoría (vg_upsert_findings) no los toca. El mismo
    -- secreto ya open/ignored en otro sitio (b) no se inserta. Reabre = fila fixed/verified, o open/ignored con OTRO valor
    -- (las dos huellas existen y difieren; con una null, la comparación da null y cuenta como no).
    insert into public.findings as f (org_id, scan_run_id, connection_id, module, rule_id, severity, confirmed, origin,
                                      title, resource, evidence, dedupe_key, suspected_injection)
    select distinct on (e->>'dedupe_key') p_org, null, null, 'codebase', e->>'rule_id', e->>'severity',
           coalesce((e->>'confirmed')::boolean, false), coalesce(e->>'origin', 'rule'), e->>'title', e->>'resource',
           coalesce(e->'evidence', '{}'::jsonb), e->>'dedupe_key', coalesce((e->>'suspected_injection')::boolean, false)
      from jsonb_array_elements(v_rows) e
     where not exists (select 1 from public.findings g
                        where g.org_id = p_org and g.rule_id = e->>'rule_id' and g.status in ('open', 'ignored')
                          and g.dedupe_key <> e->>'dedupe_key'
                          and g.evidence->>'fingerprint_short' = e->'evidence'->>'fingerprint_short')
     order by e->>'dedupe_key'
    on conflict (org_id, dedupe_key) do update set
      last_seen_at  = now(),
      severity      = case when f.status in ('fixed','verified')
                             or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short'
                           then excluded.severity else f.severity end,
      confirmed     = case when f.status in ('fixed','verified')
                             or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short'
                           then excluded.confirmed else f.confirmed end,
      title         = case when f.status in ('fixed','verified')
                             or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short'
                           then excluded.title else f.title end,
      evidence      = case when f.status in ('fixed','verified')
                             or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short'
                           then excluded.evidence else f.evidence end,
      fix_prompt    = case when (f.status in ('fixed','verified')
                                 or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short')
                            and f.evidence is distinct from excluded.evidence then null else f.fix_prompt end,
      fix_model     = case when (f.status in ('fixed','verified')
                                 or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short')
                            and f.evidence is distinct from excluded.evidence then null else f.fix_model end,
      status        = case when f.status in ('fixed','verified')
                             or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short'
                           then 'open' else f.status end,
      status_reason = case when f.status in ('fixed','verified') then 'reapareció en una revisión de código'
                           when f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short'
                             then 'otro valor en la misma línea (revisión de código)'
                           else f.status_reason end,
      verified_at   = case when f.status in ('fixed','verified')
                             or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short'
                           then null else f.verified_at end;
  end if;

  select e->>'severity' into v_max from jsonb_array_elements(v_new) e
   order by private.sev_rank(e->>'severity') desc limit 1;
  select p.review_whatsapp_min, p.review_voice_min into v_wa, v_voz from public.alert_prefs p where p.org_id = p_org;
  v_wa := coalesce(v_wa, 'high');            -- sin fila, SELECT INTO deja null
  v_voz := coalesce(v_voz, 'critical');
  -- Cualquiera de los dos umbrales: mientras no haya llamadas, el paso aviso manda por WhatsApp (§5).
  if v_max is not null and ((v_wa <> 'off' and private.sev_rank(v_max) >= private.sev_rank(v_wa))
                         or (v_voz <> 'off' and private.sev_rank(v_max) >= private.sev_rank(v_voz))) then
    v_alert := 'pending';
  elsif v_parcial and (v_wa <> 'off' or v_voz <> 'off') then
    v_alert := 'pending';                    -- revisión incompleta: avisa aunque no haya nuevos (§2.2)
  elsif v_max is not null then
    v_reason := 'bajo_umbral';
  end if;

  update public.code_reviews r set
    status = 'done', finished_at = now(),
    partial = v_parcial,
    error_code = nullif(p_meta->>'error_code', ''),
    files_changed = greatest(coalesce((p_meta->>'files_changed')::int, 0), 0),
    lines_added = greatest(coalesce((p_meta->>'lines_added')::int, 0), 0),
    max_severity = v_max,
    counts = (select jsonb_build_object(
                'critical', count(*) filter (where e->>'severity' = 'critical'),
                'high',     count(*) filter (where e->>'severity' = 'high'),
                'medium',   count(*) filter (where e->>'severity' = 'medium'),
                'low',      count(*) filter (where e->>'severity' = 'low'),
                'info',     count(*) filter (where e->>'severity' = 'info'))
                from jsonb_array_elements(v_new) e),
    new_findings = (select coalesce(jsonb_agg(jsonb_build_object('finding_id', g.id, 'rule_id', t.e->>'rule_id',
                      'severity', t.e->>'severity', 'title', t.e->>'title', 'resource', t.e->>'resource') order by t.o),
                      '[]'::jsonb)
                      from jsonb_array_elements(v_new) with ordinality as t(e, o)
                      left join public.findings g on p_write and g.org_id = p_org and g.dedupe_key = t.e->>'dedupe_key'
                     where t.o <= 50),
    reported_keys = array(select distinct e->>'dedupe_key' from jsonb_array_elements(v_rows) e limit 200),
    alert_state = v_alert,
    alert_reason = v_reason
  where r.id = v.id;
  return jsonb_build_object('applied', true, 'nuevos', jsonb_array_length(v_new), 'max_severity', v_max,
                            'alert_state', v_alert, 'parcial', v_parcial);
end $$;

revoke all on function public.vg_review_findings(uuid, uuid, jsonb, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.vg_review_findings(uuid, uuid, jsonb, boolean, jsonb) to service_role;
```

Notas:

- **No se toca `private.looks_like_secret`.** El `vgw_` nunca se escribe en una fila (va sellado en `secret_sealed` y solo
  sale una vez en la respuesta de E46) y `redact.ts` lo tapa en los logs. Ampliar el check exigiría cambiar en el MISMO
  deploy sus copias en JS (`packages/core/src/engine/edge.ts`: `PARECE_SECRETO` y `uaSegura`; `edge.test.ts`;
  `apps/api/src/scans/comun.ts`) y aplicar la migración después. Si no, un User-Agent con `vgw_…` pasa `uaSegura`,
  acaba en `incidents.details.ua_top`, el insert falla con 23514 y el ataque no avisa; como dev y prod son el mismo
  proyecto, el hueco se abriría al aplicar la migración.
- **No se toca `webhook_events`** (E47, §4.1).
- Ninguna tabla nueva entra en la publicación de Realtime. La tarjeta se refresca con los broadcasts que `findings` y
  `notifications` ya emiten (0008b) y un sondeo acotado (§6.1).
- `0013b` (P1): `vg_purge_daily` con `delete from public.code_reviews where created_at < now() - interval '90 days';`
  (mismo cuerpo que 0008 más esa línea) y `code_reviews` en el vigilante.
- Tras aplicar, el ORQUESTADOR regenera `packages/contracts/src/database.types.ts`.

Pruebas SQL (`supabase/tests/revision.sql`):

- «Nuevo» frente a `open`, `ignored` y `verified` (reabre).
- Mismo sitio con otra huella: es nuevo y reabre aunque esté `ignored`.
- Mismo secreto (regla + huella) `open` en otro sitio: no es nuevo y no se inserta.
- `p_write = false` no escribe; el CAS devuelve `applied:false` la segunda vez.
- `alert_state`: con y sin fila en `alert_prefs`; con `off`; solo pasa el umbral de voz → `pending`; `partial` sin
  nuevos → `pending`; los dos en `off` → `none`; nuevos por debajo → `none` + `bajo_umbral`.
- El check de `notifications` rechaza `code_review_v1` sin `code_review_id` y una fila con incidente y revisión a la vez.
- anon y authenticated no leen las tres tablas (como `rls.sql`).

---

## 4. Contrato

### 4.1 Rutas nuevas

E38 y E39 están libres pero se dejan. El bloque nuevo va tras la wiki (E40–E44).

**E45 · `GET /api/orgs/:org/code-review`** · user · P0 → `CodeReviewState`
- `available:false` + `reason:'sin_conexion'` sin conexión GitHub `read`; `'conexion_inactiva'` si no está `active`.
- `config` sin columnas del secreto. `webhook_url` = `${APP_ORIGIN}/webhooks/github/${config.id}` solo con
  `VG_ENV = 'production'` y rol owner/admin; si no, `null` (en local `APP_ORIGIN` es la SPA en `http://localhost:5173` y
  el contrato exige https; el anónimo de la demo no ve la URL).
- `state`: `off` si `!enabled`; `error` si `last_error` y `last_error_at` es posterior al último ping y al último
  evento; `waiting_ping` sin ping ni eventos; si no, `connected`.
- `recent`: las 10 últimas revisiones de la org. Una en `queued`/`running` con más de 15 min sale como `failed` con
  `error_code 'interrumpida'`, sin escribir (el vigilante es P1).
- `alert.delivery` = el mejor estado de sus filas de `notifications` (`read > delivered > sent > queued > failed >
  skipped_cap`). `alert.delivery_error` = `notifications.error` de una fila `failed` cuando `delivery = 'failed'` (si
  casa `^[A-Za-z0-9_.-]{1,40}$`; si no, `null`). `alert.seconds` = `notified_at − created_at`.
- ≤ 4 subpeticiones (conexión, config, revisiones, notificaciones de esas revisiones). Errores: los comunes.

**E46 · `PUT /api/orgs/:org/code-review`** · admin · P0 · cuerpo `CodeReviewPut` → `CodeReviewSaved`
- La conexión debe ser de la org, `provider 'github'`, `kind 'read'`. Si no, 404. Si no está `active`, 409
  `{reason:'conexion_inactiva'}`.
- Sin config: crea la fila con `id = crypto.randomUUID()`, `branch = meta.default_branch` (si falta o no pasa la regex
  de §1.4: 409 «No sabemos la rama por defecto: vuelve a probar la conexión de GitHub») y secreto `newWebhookSecret()`
  sellado. Responde 201 con `webhook_secret` (única vez que se ve).
- Con config: cambia `enabled`. Si pasa de false a true, vuelve a copiar `branch` de `meta.default_branch` (validada).
  `webhook_secret: null`. 200.
- `rotate_secret: true` → P0: 400 «Generar otro secreto llega pronto». P1: sella uno nuevo, borra `last_ping_at`,
  `hook_events` y `last_error`, quita la clave del isolate y lo devuelve.
- Carrera en el alta (23505 en `connection_id`): 409 «Ya está activada».
- Log `revision.config` con `rid`, `enabled` y `rotado`. Nunca el secreto.

**E47 · `POST /webhooks/github/:id`** · firma de GitHub (`X-Hub-Signature-256`) · P0
1. Cuerpo crudo (≤ 1 MB: `bodyLimit` de `/webhooks/*` en `app.ts`; más → 413).
2. `:id` uuid y config por id (+ su conexión). Sin fila o id ilegible: verificación HMAC de relleno y 401.
3. `X-Hub-Signature-256` = `sha256=<64 hex>` → `hexABytes` → `crypto.subtle.verify('HMAC', clave, firma, crudo)`.
   Clave = bytes UTF-8 del `vgw_…`, importada no extraíble y en caché 60 s con la clave `${config.id}:${secret_sealed.iv}`
   (la fila ya se leyó en el paso 2: cero subpeticiones). Con una caché solo por config, como `ingestKey`, tras rotar el
   isolate seguiría aceptando el secreto viejo y el ping del nuevo daría 401 durante 60 s. Se ignora `X-Hub-Signature`
   (SHA-1). Mala o ausente → 401 «Firma no válida», mismo cuerpo que el paso 2. P0 no escribe `last_error 'firma'`
   (P1, con una escritura por minuto como mucho).
4. Host real: con `VG_ENV !== 'local'`, fuera del host de `APP_ORIGIN` → 403, como `requireColaPropia`
   (`mw/prod-host.ts`): una URL de versión de `workers.dev` comparte los bindings y encolaría en la cola de producción.
   Va tras la firma para no revelar nada.
5. `RL_COSTLY` con clave `gh:<config_id>` (10 por 60 s), solo tras autenticar → 429.
6. Cuerpo: solo `application/json`. Otro tipo → 400 «Elige Content type: application/json en el webhook». JSON ilegible
   → 400 `invalid_body`.
7. `repository.id` = `connections.meta.repo_id` (si falta, `full_name` en minúsculas). Si no casa: 202
   `{ok:true, ignorado:'otro_repo'}` (solo el `ping` escribe `last_error`).
8. Por evento (§1.3):
   - `ping` → `last_ping_at`, `hook_events` y `last_error` → 200.
   - `push` → si no aplica: 202 `{ok:true, ignorado:'desactivada'|'rama'|'borrado'|'rama_nueva'}`. Si aplica: insert en
     `code_reviews` (`delivery_id` = `X-GitHub-Delivery` si es un GUID).
     - 23505 del índice único (mismo commit): se lee esa fila. Si está `failed`, o `queued` con `started_at` null desde
       hace más de 2 min, se reabre con CAS (`status = 'queued'`; `error_code`, `started_at` y `finished_at` a null;
       `partial = false`; `delivery_id` nuevo; `where status = <el leído>`) y se reencola: 202
       `{ok:true, review_id, reintento:true}`. Si no: 202 `{ok:true, ignorado:'repetido'}`.
     - `JOBS_Q.send({v:1, kind:'review', org_id, review_id, paso:'diff'})`, `last_event_at = now()` y 202
       `{ok:true, review_id}`.
     - Si falla encolar: la fila recién insertada se borra (una reabierta pasa a `failed` con `error_code 'encolar'`) y
       500; «Redeliver» vuelve a entrar. Cualquier otro error de base → 500 sin filas a medias.
   - `pull_request` → P0 tras D1 (B7): mientras B7 no esté desplegado, 202 `ignorado:'pr_p1'`. Otro → 202 `ignorado:'evento'`.
- Sin `webhook_events`: GitHub conserva el `X-GitHub-Delivery` al reenviar, así que un dedupe por delivery grabado antes
  del trabajo bloquearía justo el reintento de una revisión fallida. El unique de `code_reviews` ya impide revisar dos
  veces el mismo commit, y sin `payload_redacted` una rama con forma de secreto no puede dar un 23514.
- Respuestas: 200/202 `{ok:true,…}`, 400, 401, 403, 413, 429, 500. Nunca datos de la org. Todo en < 1 s (GitHub corta
  a los 10 s).

**E48 · `GET /api/orgs/:org/alert-prefs`** · user · P0 → `AlertPrefs`. Sin fila: `high` / `critical`,
`updated_at: null`. `voice_available: false` mientras no haya llamadas. `whatsapp_ready_contacts` = contactos de la org
con `whatsapp = true` y `verified_at` no nulo (una consulta con `count`).

**E49 · `PUT /api/orgs/:org/alert-prefs`** · admin · P0 · cuerpo `AlertPrefsIn` → `AlertPrefs` (upsert por `org_id`,
`updated_by`, `updated_at`).

**E50 · `POST /api/orgs/:org/code-review/run`** · admin · P1 · cuerpo `CodeReviewRunBody` → `{review_id}` (202).
Revisión `manual` del último commit de la rama: `base` = último `head_sha` revisado, o el padre del commit. `RL_COSTLY`
por usuario y `requireColaPropia`.

### 4.2 Código zod EXACTO para `packages/contracts/src/api.ts`

Va al final del archivo. Todo lo que usa (`Id`, `Ts`, `Severity`, `RuleId`, `NotificationStatus`) ya se importa ahí.
No hacen falta cambios en `comun.ts`. Comprobado hoy en una copia: compila con el `tsc` del repo y los fixtures de §4.4
pasan `safeParse` con zod 4.6.7 (también: un secreto `vgw_` + 43 se acepta; `vgi_…`, `vgw_` + 32 hex y una URL `http://`
se rechazan; ningún fixture casa con el cable trampa).

```ts
// ── Revisión de código en cada push (E45–E50; asignaciones/revision-codigo.md) ─────────────────────────────────────
// Umbral por canal: severidad mínima de un hallazgo NUEVO para avisar por ese canal; 'off' = nunca por ese canal.
export const UmbralAviso = z.enum(['critical', 'high', 'medium', 'low', 'off']);
export type UmbralAviso = z.infer<typeof UmbralAviso>;
export const AlertPrefsIn = z.object({ review_whatsapp_min: UmbralAviso, review_voice_min: UmbralAviso });
export type AlertPrefsIn = z.infer<typeof AlertPrefsIn>;
// voice_available: false mientras no haya llamadas; entonces lo que pase el umbral de llamada también sale por WhatsApp.
// whatsapp_ready_contacts: contactos con WhatsApp activado y verificados (los únicos que reciben algo).
export const AlertPrefs = AlertPrefsIn.extend({ voice_available: z.boolean(),
  whatsapp_ready_contacts: z.number().int().min(0), updated_at: Ts.nullable() });
export type AlertPrefs = z.infer<typeof AlertPrefs>;

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);
export const CodeReviewEvent = z.enum(['push', 'pull_request', 'manual']); // pull_request y manual: P1
export type CodeReviewEvent = z.infer<typeof CodeReviewEvent>;
// off: interruptor apagado · waiting_ping: activa y GitHub aún no llamó · connected · error: ver last_error.
export const CodeReviewHookState = z.enum(['off', 'waiting_ping', 'connected', 'error']);
export type CodeReviewHookState = z.infer<typeof CodeReviewHookState>;
// firma (P1): llegó con otro secreto · otro_repo: el webhook es de otro repositorio · sin_push: el ping no trae
// «Pushes» · token: el PAT de la conexión dio 401 o 403 en la última revisión.
export const CodeReviewHookError = z.enum(['firma', 'otro_repo', 'sin_push', 'token']);
export type CodeReviewHookError = z.infer<typeof CodeReviewHookError>;
export const CodeReviewConfig = z.object({ id: Id, connection_id: Id, repo_full_name: z.string(), branch: z.string(),
  enabled: z.boolean(), state: CodeReviewHookState,
  // null si el rol no es owner/admin o fuera de producción (en local APP_ORIGIN es la SPA en http://localhost:5173).
  webhook_url: z.url().refine((u) => u.startsWith('https://'), 'solo https').nullable(),
  secret_last4: z.string().max(4).nullable(),
  hook_events: z.array(z.string().max(40)).max(30), // los que GitHub declaró en el último ping
  last_ping_at: Ts.nullable(), last_event_at: Ts.nullable(), last_error: CodeReviewHookError.nullable() });
export type CodeReviewConfig = z.infer<typeof CodeReviewConfig>;
// finding_id null en un PR (P1: no se escribe en findings) o si el hallazgo ya se borró.
export const CodeReviewFinding = z.object({ finding_id: Id.nullable(), rule_id: RuleId, severity: Severity,
  title: z.string().max(200), resource: z.string().max(300) });
export type CodeReviewFinding = z.infer<typeof CodeReviewFinding>;
export const CodeReviewAlert = z.object({
  state: z.enum(['none', 'pending', 'sent', 'not_sent']),
  // none: bajo_umbral o null · not_sent: sin_contactos | unverified | window_closed | cap | fuera_de_ventana_demo |
  // dry_run | sin_config | envio | dlq. La UI los traduce con un mapa cerrado y un texto por defecto.
  reason: z.string().max(40).nullable(),
  delivery: NotificationStatus.nullable(),   // el mejor estado de sus WhatsApp (read > delivered > sent > queued …)
  // notifications.error cuando delivery = 'failed' (p. ej. 131047 = ventana de 24 h cerrada, llega después del envío).
  delivery_error: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/).nullable(),
  voice_pending: z.boolean(),                // pasó el umbral de llamada; sin llamadas, el aviso salió por WhatsApp
  notified_at: Ts.nullable(),
  seconds: z.number().min(0).nullable() });  // notified_at − created_at de la revisión
export type CodeReviewAlert = z.infer<typeof CodeReviewAlert>;
export const CodeReview = z.object({ id: Id, event: CodeReviewEvent, branch: z.string(),
  pr_number: z.number().int().positive().nullable(), base_sha: Sha40, head_sha: Sha40,
  // failed con error_code 'interrumpida': E45 lo pone a una revisión queued/running de más de 15 min (sin escribir).
  status: z.enum(['queued', 'running', 'done', 'failed']), error_code: z.string().nullable(), partial: z.boolean(),
  files_changed: z.number().int().min(0), lines_added: z.number().int().min(0),
  counts: z.record(Severity, z.number().int()), // de los hallazgos NUEVOS; zod 4 exige las 5 claves
  max_severity: Severity.nullable(), findings: z.array(CodeReviewFinding).max(50), alert: CodeReviewAlert,
  created_at: Ts, finished_at: Ts.nullable() });
export type CodeReview = z.infer<typeof CodeReview>;
export const CodeReviewState = z.object({ available: z.boolean(),
  reason: z.enum(['sin_conexion', 'conexion_inactiva']).nullable(),
  config: CodeReviewConfig.nullable(), recent: z.array(CodeReview).max(10) });
export type CodeReviewState = z.infer<typeof CodeReviewState>;
// rotate_secret: P1 (en P0, true → 400).
export const CodeReviewPut = z.object({ connection_id: Id, enabled: z.boolean(), rotate_secret: z.boolean().optional() });
export type CodeReviewPut = z.infer<typeof CodeReviewPut>;
// webhook_secret solo al crear la configuración (y al rotarlo, P1); nunca en E45. 'vgw_' + 32 bytes en base64url.
export const CodeReviewSaved = z.object({ config: CodeReviewConfig,
  webhook_secret: z.string().regex(/^vgw_[A-Za-z0-9_-]{43}$/).nullable() });
export type CodeReviewSaved = z.infer<typeof CodeReviewSaved>;
export const CodeReviewRunBody = z.object({ connection_id: Id.optional() }); // E50, P1
export type CodeReviewRunBody = z.infer<typeof CodeReviewRunBody>;
```

### 4.3 Lo que NO cambia en el contrato, y por qué

- `ScanKind`, `ScanStep` y `ScanRun`: sin `code_review`. La revisión no es una auditoría (§0, fila «Registro»).
- `RuleId`: sin `CR_*` (§2.4).
- `Provider` y `ConnectionCreate`: la config no es una conexión; no aparece en E7.
- `NotificationPublic`: igual. Las filas de revisión no tienen incidente y E17 no las lista.
- `webhook_events` y su `provider`: sin `github` (E47 no lo usa).

### 4.4 Fixtures nuevos

`packages/contracts/src/fixtures/ids.ts` (añadir):

```ts
// ── Revisión de código ───────────────────────────────────────────────────────
export const CR_CONFIG = 'c4000000-0000-4000-8000-000000000001';
export const CR_REV_SECRETO = 'c4000000-0000-4000-8000-000000000011';
export const CR_REV_LIMPIA = 'c4000000-0000-4000-8000-000000000012';
export const F_CB_STRIPE_PUSH = 'f0000000-0000-4000-8000-00000000000e'; // lo crea la revisión; no está en `findings`
export const T_CR_PING = '2026-10-24T18:20:03.000Z';
export const T_CR_PUSH = '2026-10-24T19:20:11.000Z';
```

`packages/contracts/src/fixtures/revision.ts` (nuevo). El hallazgo del push es una clave de Stripe en un recurso nuevo:
el `F_CB_SERVICE_ROLE` de antes ya estaba `open` desde la auditoría de las 18:02 en el mismo recurso y, por §2.5, no
sería nuevo. Va aparte de `findings` porque añadirlo ahí movería `resumen.ts`, `exportar.ts` y la prueba de la wiki que
exige nombrar cada crítico y alto de `hallazgos.ts`.

```ts
// Revisión de código (E45, E46, E48). La historia: el repo de la víctima ya tiene el webhook (ping 18:20Z); a las
// 19:20Z el push de demo/empujar-revision.mjs sube una clave live de Stripe FALSA a src/lib/pagos.ts y el WhatsApp sale
// y se lee. El push anterior fue limpio. hallazgoRevision es el hallazgo que crea esa revisión: va aparte de `findings`
// (hallazgos.ts) para no mover el Resumen, el export ni la wiki; el router de fixtures del FRONT lo añade a la lista de
// la org para que ?finding= lo abra. webhook_secret va null: un valor con forma de secreto en un fixture lo pararía el
// cable trampa; el router lo genera al vuelo.
import type { AlertPrefs, CodeReviewConfig, CodeReviewSaved, CodeReviewState, Finding } from '../api.ts';
import { CONN_GITHUB, CR_CONFIG, CR_REV_LIMPIA, CR_REV_SECRETO, F_CB_STRIPE_PUSH, REPO, T_CR_PING, T_CR_PUSH } from './ids.ts';

const HEAD = '9f1c2e7a4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a';
const PREVIO = '3b18e1a9c0d24f6e8a7b5c4d3e2f1a0b9c8d7e6f';

export const hallazgoRevision = {
  id: F_CB_STRIPE_PUSH, module: 'codebase', rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical', confirmed: true,
  origin: 'rule', title: 'Clave live de Stripe en el código', resource: 'src/lib/pagos.ts:3',
  evidence: { fuente: 'github', sha: HEAD.slice(0, 7), path: 'src/lib/pagos.ts', line: 3, preview: 'sk_l…7Qx2',
    fingerprint_short: 'c41d9e07', ubicaciones: [{ path: 'src/lib/pagos.ts', line: 3, origen: 'head' }] },
  has_fix_prompt: false, fix_model: null, status: 'open', status_reason: null, suspected_injection: false,
  scan_run_id: null, connection_id: null, first_seen_at: T_CR_PUSH, last_seen_at: T_CR_PUSH, verified_at: null,
} satisfies Finding;

const config = {
  id: CR_CONFIG, connection_id: CONN_GITHUB, repo_full_name: REPO, branch: 'main', enabled: true, state: 'connected',
  webhook_url: `https://officialvanguard.com/webhooks/github/${CR_CONFIG}`, secret_last4: 'Q7xk',
  hook_events: ['pull_request', 'push'], last_ping_at: T_CR_PING, last_event_at: T_CR_PUSH, last_error: null,
} satisfies CodeReviewConfig;

export const codeReviewState = {
  available: true, reason: null, config,
  recent: [
    { id: CR_REV_SECRETO, event: 'push', branch: 'main', pr_number: null, base_sha: PREVIO, head_sha: HEAD,
      status: 'done', error_code: null, partial: false, files_changed: 1, lines_added: 12,
      counts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 }, max_severity: 'critical',
      findings: [{ finding_id: F_CB_STRIPE_PUSH, rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical',
        title: 'Clave live de Stripe en el código', resource: 'src/lib/pagos.ts:3' }],
      alert: { state: 'sent', reason: null, delivery: 'read', delivery_error: null, voice_pending: true,
        notified_at: '2026-10-24T19:20:17.400Z', seconds: 6.4 },
      created_at: T_CR_PUSH, finished_at: '2026-10-24T19:20:14.900Z' },
    { id: CR_REV_LIMPIA, event: 'push', branch: 'main', pr_number: null,
      base_sha: '7c0d2e4f6a8b1c3d5e7f9a0b2c4d6e8f1a3b5c7d', head_sha: PREVIO,
      status: 'done', error_code: null, partial: false, files_changed: 1, lines_added: 3,
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, max_severity: null, findings: [],
      alert: { state: 'none', reason: null, delivery: null, delivery_error: null, voice_pending: false, notified_at: null,
        seconds: null },
      created_at: '2026-10-24T18:31:40.000Z', finished_at: '2026-10-24T18:31:42.100Z' },
  ],
} satisfies CodeReviewState;

export const codeReviewSaved = {
  config: { ...config, state: 'waiting_ping', hook_events: [], last_ping_at: null, last_event_at: null },
  webhook_secret: null,
} satisfies CodeReviewSaved;

// whatsapp_ready_contacts = 1: en ajustes.ts Ana está verificada y Luis no.
export const alertPrefs = { review_whatsapp_min: 'high', review_voice_min: 'critical', voice_available: false,
  whatsapp_ready_contacts: 1, updated_at: null } satisfies AlertPrefs;
```

`fixtures/index.ts`: importar y añadir `codeReviewState`, `codeReviewSaved`, `alertPrefs` y `hallazgoRevision` a
`fixtures`. `contracts.test.ts`: las cuatro claves en `CLAVES_ESPERADAS` y en `casos`
(`['codeReviewState', c.CodeReviewState, …]`, `['codeReviewSaved', c.CodeReviewSaved, …]`,
`['alertPrefs', c.AlertPrefs, …]`, `['hallazgoRevision', c.Finding, …]`), más un caso que confirme que
`CodeReviewSaved` acepta `vgw_` + 43 de base64url y rechaza un secreto sin `vgw_`.

El 6,4 s del fixture es un dato de prueba: no se cita en el pitch (§8.5).

---

## 5. Avisos

| Pregunta | Respuesta |
|---|---|
| Cuándo | Al cerrar el paso `diff`, `alert_state = 'pending'` (lo decide `vg_review_findings` con `alert_prefs`) si (a) la peor severidad de los NUEVOS pasa el umbral de WhatsApp o el de llamada, o (b) la revisión quedó `partial` y algún umbral no es `off` («revisión incompleta»). Nuevos por debajo: `none` con `alert_reason 'bajo_umbral'`. Sin nuevos y completa: `none` |
| A quién | Contactos de la org con `whatsapp = true`, por prioridad (≤ 5, como E26). Solo los verificados reciben algo real; el resto deja fila `failed`/`unverified` |
| Canal | WhatsApp con el umbral efectivo: mientras `voice_available` sea false, el más permisivo de `review_whatsapp_min` y `review_voice_min`. Quien eligió «llámame en crítico» y «WhatsApp: nunca» se entera por WhatsApp; Ajustes lo dice. `voice_pending = true` si pasa el umbral de voz; la voz no genera fila (como hace hoy el despachador) |
| Una sola alerta por revisión | Un mensaje como mucho por contacto: unique `(code_review_id, channel, recipient_masked)`. Fila `queued` ANTES de enviar; 23505 = ya avisado. El cierre de la revisión es CAS `where alert_state = 'pending'` |
| Topes | Cupo propio de la revisión: 3 revisiones avisadas por org y hora (10 en la org de demo), contadas en `code_reviews` (`alert_state = 'sent'` y `notified_at` en la última hora; una subpetición con `count`). Pasado el cupo, las filas quedan `skipped_cap`/`cap` y el aviso queda en la app. El despachador de incidentes deja de contar las filas de revisión: `.is('code_review_id', null)` en su `used1h` (`notify/despachador.ts`). Así unos pocos pushes no dejan sin aviso un ataque real |
| Org de demo | Respeta la ventana `app_config.demo_alertas_hasta` (`fueraDeVentanaDemo`) como el despachador |
| Fuera de la ventana de 24 h | `ventanaAbierta(env, wa_last_inbound_at)` falsa → fila `failed`/`window_closed`, sin llamar a Kapso. Con `KAPSO_SANDBOX='1'` nuestro chequeo da siempre abierta, pero Meta aplica igual su ventana: Kapso responde 200 y el fallo llega después por E31 con el código 131047, que la tarjeta muestra (`delivery_error`). Por eso G3: el teléfono de la demo escribe al número antes de cada ensayo. Plantillas aprobadas: P1, cuando Meta lo permita |
| Fuera de producción | `VG_ENV !== 'production'` → `failed`/`dry_run` (S15 15.3) |
| Sin Kapso configurado | `failed`/`sin_config` |

### 5.1 Plan (core, puro): `packages/core/src/engine/notify-plan.ts`

```ts
export type UmbralAviso = Severity | 'off';
export const superaUmbral = (s: Severity | null, u: UmbralAviso): boolean => s !== null && u !== 'off' && rank(s) >= rank(u);
/** Umbral efectivo de WhatsApp: sin llamadas, el más permisivo de los dos ('off' solo si los dos lo son). */
export function umbralWhatsapp(p: { whatsapp: UmbralAviso; voice: UmbralAviso }, vozDisponible: boolean): UmbralAviso;
/** Cupo propio de la revisión: revisiones avisadas por org y hora, aparte de TOPES_AVISOS. */
export const TOPES_REVISION: Readonly<{ normal: number; demo: number }> = Object.freeze({ normal: 3, demo: 10 });
/** Revisión de código: plantilla code_review_v1 por WhatsApp a cada contacto con whatsapp (por prioridad, ≤ 5). Hay
 *  envío si la peor severidad nueva pasa el umbral efectivo o si la revisión es parcial. Por envío, el mismo orden que
 *  planAvisos: ventana de demo → sin verificar → cupo. La voz no genera envíos, solo voz_pendiente. */
export function planAvisoRevision(r: { max: Severity | null; parcial: boolean },
  prefs: { whatsapp: UmbralAviso; voice: UmbralAviso }, contacts: readonly ContactoAviso[], avisadas1h: number, cupo: number,
  o: { fueraDeVentanaDemo?: boolean; vozDisponible?: boolean } = {}):
  { envios: Planned[]; voz_pendiente: boolean; motivo: 'sin_hallazgos' | 'bajo_umbral' | 'sin_contactos' | null };
```

`PlantillaAviso` suma `'code_review_v1'`. `voz_pendiente` = supera el umbral de voz y hay algún contacto con
`voice = true` verificado. El motivo `solo_llamada` llega con las llamadas (P1): hasta entonces no puede darse.

### 5.2 Texto FIJO: `packages/core/src/templates/revision.ts`

```ts
export function mensajeRevision(d: { evento: CodeReviewEvent; rama: string; sha: string; pr?: number | null;
  counts: Record<Severity, number>; reglas: readonly string[]; parcial: boolean; url: string }): string;
```

Plantilla (texto simple, `cuerpoTexto`, ≤ 1.024 caracteres):

```
VanGUARD · Revisión de código
Push a {rama} ({sha7}).                               ← P1: «Pull request #{n} hacia {rama}…» o «Revisión manual…»
Nuevo: {1 crítico, 2 altos}.                          ← solo con nuevos
- {n} clave(s) o token(s) en el código                ← solo las líneas con n > 0
- {n} archivo(s) .env subido(s)
No pudimos revisar entero este push.                  ← solo si parcial
Rota las claves expuestas y revisa el detalle: {url}  ← «Revísalo en VanGUARD: {url}» si no hay secretos
```

- Lo único que no es nuestro: `rama` (de la config; sale tal cual solo si casa `^[A-Za-z0-9_-]{1,40}$`, si no «la rama
  vigilada»), `sha7` (hex) y los números. Con puntos, WhatsApp convertiría una rama como `pagos.evil.com/login` en un
  enlace pulsable, y `textoSeguro` no toca los dominios.
- El nombre del repo NO va: no hace falta (la org tiene un solo repo) y el nombre de un repo privado no tiene por qué
  llegar a Meta ni a Kapso.
- Nunca: título del PR, mensajes de commit, autor, rutas de archivo, valores, previews ni texto de IA.
- Categorías por prefijo de `rule_id` de `new_findings`: `CB_SECRET_*` → claves; `CB_ENV_COMMITTED` → `.env`. Las
  líneas de `.gitignore` («- El .gitignore ya no excluye .env») y dependencias («- {n} dependencia(s) con una
  vulnerabilidad conocida») entran con B6, cuando funcionen.
- Severidades con un mapa propio en masculino, `SEVERIDAD_M` en `templates/revision.ts` (crítico, alto, medio, bajo,
  informativo): `SEVERIDAD_ES` de `templates/titles.ts` está en femenino («crítica»).
- `url` = `${APP_ORIGIN}/o/${org_id}/codebase?revision=${review_id}` (dominio propio).
- Sin botones en P0. P1: «Lo estoy viendo» necesitaría `approvals` con revisión en vez de incidente.

### 5.3 Por qué no se crea un incidente

Se pensó reutilizar `vg_upsert_incident` + `avisarIncidente`. Se descarta por tres datos:

1. `planAvisos` fija el umbral en `high` y no lee preferencias.
2. La tormenta cuenta los incidentes high/critical de los últimos 2 min: un push durante la demo del ataque podía
   degradar el aviso del ataque a `storm_v1`.
3. La página de incidente, la línea de tiempo y el botón «Bloquear IP» están pensados para el borde (CF_/SB_).

Con `notifications.code_review_id` se reutiliza todo lo demás: E31 marca `delivered`/`read`/`failed` por `provider_id`.

---

## 6. UI (FRONT)

### 6.1 Codebase: tarjeta «Revisión automática de código»

Componente nuevo `apps/web/src/modulos/codebase/TarjetaRevisionCodigo.tsx`. Va dentro de `PantallaModulo`, debajo de
«Repositorio» (solo con GitHub conectado; sin conexión, `PantallaModulo` ya enseña «Conecta GitHub»). P1: un chip en la
barra del módulo que lleve a la tarjeta (F7).

- **Bandera:** si E45 responde 404 (ruta aún no desplegada), la tarjeta no se pinta. Así el FRONT puede congelar a las
  22:00 sin prometer lo que no está en producción (§8.0).
- **Cabecera:** título, una línea «Revisamos cada push a `{rama}`, también los merges de pull requests. Pull requests
  abiertos: próximamente.» e `Interruptor` (`role="switch"`) «Revisar cada push». Solo admin; el viewer ve el estado
  sin interruptor. Llama a E46.
- **Qué revisa** (una línea): «Buscamos en lo que se añadió claves y tokens, y archivos .env subidos. Solo te avisamos
  de lo nuevo. Leemos el cambio con tu token de solo lectura y no guardamos tu código.» Con B6: «…y dependencias con
  vulnerabilidades conocidas».
- **Umbral:** «Te avisamos por WhatsApp desde {Alta} · Cambiar» (enlace a `/settings#avisos`, datos de E48). Con
  `whatsapp_ready_contacts = 0`: «Ningún contacto con WhatsApp verificado: añade uno en Ajustes».
- **Estado** (chip `Etiqueta`): `off` «Desactivada» · `waiting_ping` «Esperando a GitHub» · `connected` «Conectada ·
  último evento {cuando}» · `error` con texto por `last_error`:
  - `firma` (P1): «GitHub llegó con otro secreto. Pega el secreto de nuevo.»
  - `otro_repo`: «Ese webhook es de otro repositorio.»
  - `sin_push`: «Marca el evento “Pushes” en el webhook.»
  - `token`: «El token de GitHub ya no vale o no ve el repo. Vuelve a conectarlo.»
- **Pasos en GitHub** (abiertos en `waiting_ping` y `error`; plegados en `connected`; `GuiaPasos` si encaja; solo admin):
  1. Abre `https://github.com/{repo}/settings/hooks/new` (enlace; solo con `repo` validado por regex).
  2. **Payload URL:** `webhook_url` con `BotonCopiar`. Si es `null`: «La URL solo existe en officialvanguard.com».
  3. **Content type:** `application/json`.
  4. **Secret:** el `webhook_secret` de la respuesta de E46 con `BotonCopiar` y el aviso «Cópialo ahora: no lo
     volveremos a mostrar». Sin secreto a mano: «Termina en ••{secret_last4}» («Generar otro secreto»: P1).
  5. **Which events…:** «Let me select individual events» → marca «Pushes» y «Pull requests» (este último, para cuando
     llegue).
  6. **Active** marcado → «Add webhook». GitHub manda un ping y aquí cambia a «Conectada».
- **El secreto:** `useGuardarRevision` con `gcTime: 0`; en `onSuccess` se copia `webhook_secret` al estado del
  componente y se llama a `reset()`. Nunca en `localStorage`, la URL ni las cachés de React Query (con el `gcTime` por
  defecto la respuesta quedaría 5 min en el `MutationCache`; `useGuardarContactos` lo baja a 60 s por lo mismo).
- **Revisiones recientes** (`recent`, ≤ 10). Por fila: icono push, `rama · {sha7}` (mono), `cuando(created_at)` y un
  chip de estado:
  - `queued`/`running`: «Revisando…»;
  - `done` sin nuevos: «Sin hallazgos nuevos»;
  - `done` con nuevos: «{n} nuevos» con la peor severidad;
  - `failed`: «No se pudo revisar: {texto de error_code}»;
  - `partial` (se suma): «Revisión incompleta: {texto de error_code}».
- **Chip de aviso:**
  - `sent`: «WhatsApp en {seconds} s · Enviado | Entregado | Leído» según `delivery`. Si `delivery = 'failed'`:
    «WhatsApp no entregado: {texto de delivery_error}»;
  - `not_sent`: «Aviso no enviado: {texto de reason}»;
  - `none` con `bajo_umbral`: «Por debajo de tu umbral (Ajustes)»;
  - `voice_pending` NO va en la fila (se leería como «te vamos a llamar»). En la fila abierta: «Llamada: aún no
    disponible; te avisamos por WhatsApp».
- **Textos** (mapa cerrado con `deMapa` y un texto por defecto; nunca un código crudo):

| Campo | Valor | Texto |
|---|---|---|
| `reason` | `sin_contactos` | No hay contactos con WhatsApp: añádelos en Ajustes |
| `reason` | `unverified` | Verifica el contacto en Ajustes |
| `reason` | `window_closed` | Escribe a VanGUARD por WhatsApp para abrir la ventana de 24 h |
| `reason` | `cap` | Tope de avisos de revisión por hora |
| `reason` | `fuera_de_ventana_demo` | Avisos de la demo en pausa |
| `reason` | `dry_run` | Solo se envía desde officialvanguard.com |
| `reason` | `sin_config` | WhatsApp aún no está configurado |
| `reason` | `envio` | WhatsApp no aceptó el envío |
| `reason` | `dlq` | No pudimos terminar el aviso |
| `reason` | (otro) | No se envió |
| `error_code` | `unauthorized`, `forbidden` | El token de GitHub ya no vale o no ve el repo: reconéctalo |
| `error_code` | `not_found` | GitHub ya no tiene ese commit (¿push forzado?) |
| `error_code` | `diff_grande` | Cambio demasiado grande: lanza una auditoría del repo |
| `error_code` | `binario` | Trae archivos que no sabemos leer |
| `error_code` | `tripwire` | Ocultamos una ruta con forma de clave |
| `error_code` | `interrumpida`, `dlq`, `encolar` | No pudimos terminar la revisión |
| `error_code` | (otro) | No pudimos revisarlo entero |
| `delivery_error` | `131047` | Fuera de la ventana de 24 h: escribe a VanGUARD por WhatsApp |
| `delivery_error` | (otro) | WhatsApp no lo entregó |

- Al abrir una fila se listan sus `findings` (severidad, título, recurso) y la nota «Estos hallazgos se cierran con
  “Marcar arreglado”: la auditoría no los cierra sola». Los que tienen `finding_id` abren el detalle existente
  (`?finding=<id>`). `?revision=<id>` (el enlace del WhatsApp) abre esa fila y la lleva a la vista (`scrollIntoView`).
- **Consulta:** `useRevisionCodigo(org)` → E45 con la clave `['org', org, 'code-review']`. Realtime: añadir
  `'code-review'` en `MAPA` de `apps/web/src/lib/realtime.ts` a `findings` y a `notifications` (y en `TODO`): el insert
  del hallazgo y la fila del aviso refrescan la tarjeta al instante sin gastar peticiones del Worker (0008b ya emite esos
  broadcasts). Sondeo de respaldo, solo con la pestaña visible: cada 5 s durante 3 min tras montar la página o volver a
  la pestaña, durante 10 min tras activar desde aquí, o mientras haya una revisión `queued`/`running` de menos de 2 min;
  si no, cada 30 s. `useGuardarRevision(org)` → E46.

### 6.2 Ajustes: sección «Avisos»

En `PaginaAjustes.tsx`, la sección actual «Canales por severidad» pasa a ser una sola sección «Avisos» (`id="avisos"`)
con dos bloques:

- **«Revisión de código»** (editable):
  - Selector 1: «Avisar por WhatsApp a los contactos con WhatsApp activado cuando la revisión encuentre algo nuevo de
    severidad…» → «Solo crítica» · «Alta o más» (por defecto) · «Media o más» · «Baja o más» · «Nunca».
  - Selector 2: «Llamar cuando sea de severidad…» → mismas opciones (por defecto «Solo crítica»), con `Etiqueta`
    «Próximamente» y la ayuda «Guardamos tu preferencia. Mientras no haya llamadas, lo que pase este umbral también te
    llega por WhatsApp.» mientras `voice_available` sea false.
  - Los dos en «Nunca»: «No recibirás avisos de la revisión de código; quedan en la app.»
  - Nota: «Solo reciben los contactos con WhatsApp verificados ({whatsapp_ready_contacts} ahora). Fuera de la ventana de
    24 h de WhatsApp el aviso queda en la app. Como mucho 3 avisos de revisión por hora (10 en la org de demo), aparte
    de los de ataques.»
  - Botón «Guardar» (admin) → E49. El viewer ve los valores sin editar. Si E48 da 404, el bloque no se pinta.
- **«Ataques en vivo»** (fijo): la lista actual sin cambios, con su línea de topes.
- Consultas: `usePrefsAvisos(org)` → E48 (clave `['org', org, 'alert-prefs']`, la usa también la tarjeta) y
  `useGuardarPrefsAvisos(org)` → E49.

### 6.3 Modo fixtures

`apps/web/src/lib/fixtures/router.ts` responde E45 (`codeReviewState`; la primera vez añade `fx.hallazgoRevision` a la
lista de hallazgos de la org para que `?finding=` lo abra), E46 (`codeReviewSaved` con `webhook_secret` = `'vgw_'` + 32
bytes de `crypto.getRandomValues` en base64url sin relleno, 43 caracteres; el patrón de `ingest_secret`, `'vgi_'` + un
`randomUUID` sin guiones, da 32 caracteres y no pasa el contrato), E48 y E49 (`alertPrefs`).

---

## 7. Seguridad

| Amenaza | Control |
|---|---|
| Petición falsa al webhook | HMAC-SHA256 sobre los bytes CRUDOS antes de parsear, con `crypto.subtle.verify` (tiempo constante). Solo `X-Hub-Signature-256`. Secreto `vgw_` de 256 bits por config |
| Saber si una config existe | Id inexistente, ilegible o firma mala: mismo 401 y mismo cuerpo, con una verificación de relleno. El id es un uuid v4: no se puede enumerar. La URL solo la ve un admin |
| Despliegue de prueba que encola en producción | E47 (y E50) rechazan con 403, tras la firma, fuera del host de `APP_ORIGIN`, como `requireColaPropia` |
| Cuerpos enormes o CPU | ≤ 1 MB (413). Parseo solo tras autenticar. Topes del diff (§2.2) y escaneo compacto: el costo va con el texto añadido, no con el número de línea |
| Ráfagas y repeticiones | `RL_API` por IP (ya en `/webhooks/*`); `RL_COSTLY` `gh:<config>` tras autenticar; unique por (config, evento, head_sha, PR); `notifications` única por revisión y contacto |
| Abuso del cupo de WhatsApp con pushes | Cupo propio de revisiones (3/h, 10 en la org de demo) y el despachador de incidentes no cuenta sus filas: un push no deja sin aviso un ataque. PR de forks (P1): sin aviso |
| Un repo ajeno dispara revisiones en otra org | La org sale de la config del `:id`, nunca del payload. `repository.id` debe ser `meta.repo_id`. El diff se pide al repo de la CONEXIÓN con su PAT: un payload firmado con datos de otro repo no puede leer nada ajeno |
| SSRF | Solo `https://api.github.com` por `pedir` + `assertAllowedUrl` (`HOSTS_SALIDA`); saltos solo al mismo host; nunca URLs del payload (`compare`, `url`, `html_url`); SHA y rama validados por regex |
| Texto malicioso (inyección) | Mensajes de commit, títulos de PR, autores y rutas no van a la IA, al WhatsApp ni a los logs. La regla decide; un texto no puede apagar ni crear una alerta |
| El autor del push apaga la alerta con la ruta | Una ruta con forma de token se oculta (hash) en vez de descartar el hallazgo; una ruta de pruebas no baja la severidad de las reglas específicas (§2.4, §2.5) |
| Un push grande pasa en silencio | Toda revisión `partial` (topes, binario raro, ruta entre comillas, 406/422) avisa como incompleta; el diff se lee hasta 1 MB aunque `Content-Length` diga más |
| Un `ignored` tapa una clave real | «Nuevo» compara también la huella: otro valor en la misma línea es nuevo y reabre la fila |
| Secretos en filas o logs | Evidencia por `aFila` (redact) + `ocultarRutas` + check `looks_like_secret` (sin cambios). `redact.ts` suma `\bvgw_`. Sin `payload_redacted`. Logs: `rid`, id de config, evento, `sha7`, conteos; nunca el cuerpo, la firma ni el secreto |
| Robo del secreto en la base | Sellado con AES-GCM (Box de 05.7) y AAD atado a org + id de la config; solo se ve una vez (E46). Caché de la clave por versión (`iv`): un secreto rotado (P1) vale al instante y el viejo deja de valer |
| Datos de más a Meta y Kapso | El WhatsApp no lleva el repo; la rama solo si casa `^[A-Za-z0-9_-]{1,40}$` (sin puntos: no se vuelve enlace) |
| Escritura en GitHub | Ninguna. El PAT sigue de solo lectura; el webhook lo crea el usuario |
| Auto-verificación falsa | Los hallazgos de revisión van con `connection_id = null`: la auditoría no los marca `verified` sin haber leído ese archivo (§2.5). Se cierran a mano |
| PR cerrado sin merge | Los hallazgos de un PR no van a `findings` (P1) |
| Costo de IA | Cero en P0. E15 bajo demanda con sus topes de siempre |
| Repetición vieja (GitHub no firma la hora) | Unique de `code_reviews` (90 días con 0013b); una entrega repetida de un commit ya revisado responde `repetido` |
| Viewer anónimo de la demo | E45/E48 de solo lectura y sin URL ni secreto; E46/E49 con `requireAdmin` y `anonReadOnly` |

El ORQUESTADOR añade a `THREAT_MODEL.md` las filas de esta tabla y a `SECURITY.md` el párrafo «Webhook de GitHub».
Solo cuando el flujo funcione en producción (T02-14).

---

## 8. Reparto

### 8.0 Horario y puntos de control (sáb 24-oct, hora de Caracas)

| Hora | Qué debe estar | Si no |
|---|---|---|
| 15:30 | O1 (contrato y fixtures en `main`) y O2 (encargos enviados). El BACK ya subió su arreglo de la wiki (36cffa1, 15:00) y está libre | El BACK empieza B1 igual; el FRONT espera O1 |
| 17:30 | B1 aplicada y B2 en `main` con pruebas en verde | E48/E49 pasan a después de E47 |
| 18:00 | G0: acceso al repo de la demo (D3) | Se usa el repo que haya |
| 19:00 | B3 + B4/B5 desplegados en UN deploy; G1 y G2: ping → «Conectada» | — |
| 19:30 | **Corte:** un push real deja una fila `done` y llega el WhatsApp en producción | El ensayo de las 20:30 usa la demo actual y el FRONT oculta la tarjeta y el bloque de Ajustes antes de congelar |
| 20:30 | Ensayo G4 con push real; se mide `{t_revision}` | — |
| 22:00 | Congelación del FRONT | — |
| Dom 10:00 | T02-14: entra al pitch y a `project-description.md` solo si funcionó en el ensayo y en una prueba del domingo | Va como hoja de ruta |

### 8.1 ORQUESTADOR (antes de que empiecen BACK y FRONT)

| # | Qué | Archivos | Prioridad | Estimación |
|---|---|---|---|---|
| O1 | Contrato §4.2 y fixtures §4.4; `pnpm --filter @vanguard/contracts test` en verde; commit en `main` | `packages/contracts/src/api.ts`, `fixtures/{ids,revision,index}.ts`, `contracts.test.ts` | P0 · primero | 30 min |
| O2 | Mandar las asignaciones a las sesiones BACK y FRONT (todo junto), con este documento | — | P0 | 5 min |
| O3 | Regenerar `database.types.ts` tras 0013 | `packages/contracts/src/database.types.ts` | P0 | 10 min |
| O5 | `demo/empujar-revision.mjs`: clona el repo de la demo, crea `src/lib/pagos.ts` con una clave live de Stripe FALSA distinta en cada ejecución (aleatoria, armada por concatenación como `sembrar-repo.mjs`; no la imprime), comprueba con `escanearSecretos` que casa, hace commit «feat: cobro con tarjeta» y push a `main`. `--deshacer`: borra el archivo, commit y push. P1: `--dep` con `minimist 1.2.5` | `demo/` | P0 · antes de las 19:30 | 25 min |
| O4 | `PLAN_MAESTRO.md` §15.4 (E45–E50), `ARQUITECTURA.md`, `SECURITY.md`, `THREAT_MODEL.md`; `demo/guion.md` con el tramo de D2 y el hueco `{t_revision}` medido en G4 (nunca la cifra del fixture); «Estado de la entrega» en `project-description.md`: solo lo que funcione en producción, y que los avisos fuera de la ventana de 24 h necesitan plantillas de Meta (P1) | docs | P1 | 30 min |
| — | `wrangler.jsonc`: sin cambios. Si en la prueba `RL_COSTLY` (10/min) corta ráfagas reales, binding `RL_GH` 30/60 s | — | — | — |

### 8.2 BACK (≈ 4 h de P0)

Orden pensado para tener el P0 demostrable antes del corte de las 19:30. Cada paso con sus pruebas en Vitest; nada de
ejecutables (`pnpm --filter @vanguard/core test`, `pnpm --filter @vanguard/api test`).

| # | Qué | Archivos | Prioridad | Estimación |
|---|---|---|---|---|
| B1 | Migración 0013 (§3) + `supabase/tests/revision.sql`; `list_migrations` y aplicar | `supabase/migrations/0013_revision_codigo.sql`, `supabase/tests/revision.sql` | P0 | 45 min |
| B2 | Core: `parsearDiff` (sin rutas entre comillas), `archivoCompacto`, `secretosDelDiff`, `envDelDiff`, copias de `FUERA` y `BINARIO`; en `secrets/scan.ts`, `recurso` exportada y `rebajarPruebas`; `planAvisoRevision`, `superaUmbral`, `umbralWhatsapp`, `TOPES_REVISION`; `mensajeRevision` + `SEVERIDAD_M`; `newWebhookSecret()` (`'vgw_'` + 32 bytes en base64url, en `crypto.ts`); `\bvgw_` en `redact.ts` | `packages/core/src/revision/diff.ts` (+ export en `index.ts`), `secrets/scan.ts`, `engine/notify-plan.ts`, `templates/revision.ts`, `crypto.ts`, `redact.ts` | P0 | 55 min |
| B3 | E45, E46 (sin rotar), E48, E49 + sellado del secreto y clave en caché por `iv` | `apps/api/src/rutas/revision.ts` (montar en `rutas/index.ts`), `lib/credentials.ts` (`sellarSecretoWebhook`, `claveWebhook`) | P0 | 40 min |
| B4+B5 | En el MISMO deploy (§2.1). E47 (§4.1). Cola: `JobMsg` suma `{ v:1; kind:'review'; org_id; review_id; paso: PasoRevision }` con `PasoRevision = 'diff' \| 'aviso'` (P1: `'osv'`); `runJob` y `cierreDlq` lo enrutan (DLQ → `failed`/`dlq`, o `alert_state 'not_sent'`/`dlq` si era `aviso`). Paso `diff` (§2.2–2.5): claim CAS, retoma con `attempts > 1`, reencola `aviso` si encuentra `done` + `pending`, `leerAcotado` con `ignorarLargo`, `ocultarRutas`, `aFila` exportada, `last_error 'token'`. Paso `aviso` (§5) con el cupo propio. `despachador.ts`: `.is('code_review_id', null)` en `used1h` | `apps/api/src/rutas/webhooks-github.ts`, `app.ts` (`app.route('/webhooks', webhooksGithub)`), `jobs.ts`, `revision/pasos.ts`, `notify/revision.ts`, `notify/despachador.ts`, `scans/comun.ts`, `scans/repo.ts` | P0 | 1 h 40 |
| B6 | `.gitignore` en el diff y dependencias con OSV en el paso `osv` (§2.4) | `revision/pasos.ts`, `jobs.ts`, `packages/core/src/revision/diff.ts` (`depsDelDiff`) | P1 | 45 min |
| B7 | `pull_request` (E47 + `p_write:false` + filtro de forks de §1.3 + `0013c`: no repetir en el merge lo ya avisado en un PR solo si ESE PR es el que se fusiona —su `head_sha` es ancestro del `after`— y la huella coincide) | `rutas/webhooks-github.ts`, `revision/pasos.ts`, RPC (`0013c`) | P0 (D1) | 45 min |
| B8 | E50, `base` = último `head` revisado, vigilante, `0013b` (retención), 401 del PAT → conexión `revoked`, `rotate_secret`, `last_error 'firma'` con tope, topes a la mitad en el reintento, enfriamiento entre avisos, `vg_upsert_findings` que adopta `connection_id` | varios | P1 | 1 h 30 |

Pruebas mínimas por paso:

- **B1:** las de §3.
- **B2:**
  - `parsearDiff`: archivo nuevo, modificado, borrado, renombrado, binario multimedia (sin `cortado`), `.ts` binario
    (`cortado`), ruta entre comillas (`cortado`), CRLF, `\ No newline`, dos hunks.
  - `secretosDelDiff`: mismo `resource` y línea que `escanearSecretos` sobre el archivo entero; una línea añadida en la
    línea 150.000 no genera 150.000 líneas; una clave live en `x.test.ts` sigue `critical`.
  - `envDelDiff`: sin `gitignore_lo_lista`.
  - `planAvisoRevision`: `off`, por debajo, solo umbral de voz → WhatsApp con `vozDisponible` false, parcial sin nuevos →
    envío, sin verificar, cupo, ventana de demo. `umbralWhatsapp` con las combinaciones de `off`.
  - `mensajeRevision`: una rama con puntos o salto de línea sale como «la rama vigilada»; no incluye repo ni rutas;
    línea de parcial; ≤ 1.024.
  - `redact` tapa `vgw_…`.
- **B3:**
  - El viewer recibe 403 en PUT y `webhook_url: null` en GET; fuera de producción, `null` también para el admin.
  - El secreto solo sale en el alta; nunca en E45.
  - Una conexión de otra org da 404; una no activa, 409; reactivar vuelve a leer la rama; `rotate_secret` → 400.
- **B4+B5:**
  - 401 idéntico con id inexistente y con firma mala; solo SHA-1 → 401; host `workers.dev` → 403 tras la firma.
  - Ping → `connected` y `hook_events`; sin `push` → `sin_push`; otro repo → `otro_repo`.
  - Otra rama, rama borrada y rama nueva → ignorado; desactivada → 202 ignorado.
  - Mismo commit → `repetido`; revisión `failed` → se reabre y se reencola; `queued` de más de 2 min → igual.
  - `form-urlencoded` → 400; > 1 MB → 413; fallo al encolar → 500 y sin filas.
  - El CAS no deja correr dos `diff`; retoma con `attempts > 1`; la URL del compare sale de `meta` aunque el payload
    traiga otra.
  - 401 y 403 sin límite → `failed` + `last_error 'token'`; `Content-Length` de 1,5 MB → escanea el primer MB y `partial`.
  - Una ruta con `x_ghp_…` → `resource` oculto, hallazgo nuevo y aviso.
  - `aviso` con la ventana cerrada → `window_closed` sin llamar a Kapso; el segundo `aviso` no repite (23505);
    `dry_run` fuera de producción.
  - Las filas de revisión no cuentan en el `used1h` del despachador; el cupo de revisión corta la 4.ª.
  - DLQ → `failed`/`dlq`.

### 8.3 FRONT (≈ 2 h, antes de la congelación de las 22:00)

| # | Qué | Archivos | Prioridad | Estimación |
|---|---|---|---|---|
| F1 | Consultas y mutaciones E45, E46, E48, E49 (`gcTime: 0` y `reset()` en E46) + modo fixtures (§6.3) | `lib/consultas.ts`, `lib/mutaciones.ts`, `lib/fixtures/router.ts` | P0 | 15 min |
| F2 | Sacar `Interruptor` de `PaginaAjustes.tsx` a `componentes/vg/Interruptor.tsx` | ambos | P0 | 5 min |
| F3 | `TarjetaRevisionCodigo`: bandera por 404, interruptor, estado, qué revisa, umbral y aviso sin contactos, pasos en GitHub con copiar y secreto de una vez | `modulos/codebase/TarjetaRevisionCodigo.tsx`, `PaginaCodebase.tsx` | P0 | 40 min |
| F4 | Revisiones recientes, chips con el mapa cerrado de §6.1, `?revision=`, `?finding=`, Realtime (`MAPA`) y sondeo acotado | mismo componente, `lib/realtime.ts` | P0 | 35 min |
| F5 | Ajustes: sección «Avisos» con «Revisión de código» (dos selectores, «Próximamente», textos de §6.2) y «Ataques en vivo» | `modulos/ajustes/PaginaAjustes.tsx` | P0 | 20 min |
| F6 | Pruebas: el secreto no queda en almacenamiento ni en el `MutationCache` tras `reset()`; el viewer no ve interruptor ni URL; chips `window_closed` y `131047`; E45 en 404 → sin tarjeta | `*.test.tsx` | P0 | 10 min |
| F7 | Chip «Revisión automática: activada · último push hace X» en la barra del módulo (prop nueva en `PantallaModulo`, que hoy arma `extra` por dentro) que lleva a la tarjeta; botón «Generar otro secreto» cuando exista en E46 | `componentes/vg/PantallaModulo.tsx`, tarjeta | P1 | 20 min |

### 8.4 Giovanni

| # | Qué | Cuándo |
|---|---|---|
| G0 | Acceso al repo de la demo (decisión D3). Hoy `vanguard-demo-victima` está en el GitHub de Gabriel y «Tienda Demo» no tiene ninguna conexión (`demo/guion.md`). Gabriel conecta su PAT de solo lectura en Conexiones → GitHub de «Tienda Demo» y añade a Giovanni como colaborador Admin (o hace él G2). El presentador prueba un `git push` a ese repo. La revisión se activa en «Tienda Demo», la org que ve el jurado | Antes de las 18:00 |
| G1 | En `officialvanguard.com`, ventana normal con admin de «Tienda Demo»: Codebase → activar «Revisión automática» → copiar URL y secreto | Tras el deploy de las 19:00 |
| G2 | En el repo: Settings → Webhooks → Add webhook → pegar URL, `application/json`, secreto, «Pushes» + «Pull requests», Active → comprobar el ✓ verde del ping en «Recent Deliveries» y «Conectada» en VanGUARD | Igual |
| G3 | WhatsApp: (a) «Probar WhatsApp» (E27) en Ajustes de «Tienda Demo» llega al teléfono de la demo, antes de las 20:30 y otra vez el domingo; (b) desde ese teléfono, escribir al número (sandbox o real) antes del ensayo y el domingo como mucho 2 h antes del pitch: Meta aplica su ventana de 24 h también en el sandbox; (c) abrir `demo_alertas_hasta` con el SQL de `PLAN_MAESTRO.md` §02.5.1 para el ensayo y el domingo; (d) número real solo si E27 llega por él antes de las 20:30 (hoy sigue el problema de cobro de Meta): entonces se quita `KAPSO_SANDBOX` y se verifica el contacto con VERIFICAR. Si no, sandbox | Antes del ensayo |
| G4 | Ensayo con un push real y cronometrar `{t_revision}`. Después de cada ensayo: `node demo/empujar-revision.mjs --deshacer` y «Marcar arreglado» en el hallazgo desde la ventana normal (nunca «Ignorar»): así el puntaje queda limpio y el push del pitch vuelve a ser nuevo | 20:30 |

### 8.5 Guion de la demo (≤ 40 s; el tramo que sustituye lo decide Giovanni, D2)

1. Codebase en la ventana del jurado: la tarjeta dice «Conectada · último evento hace X min».
2. En el portátil: `node demo/empujar-revision.mjs` (o, sin script, el editor web de GitHub: crear `src/lib/pagos.ts`
   pegando la línea preparada y «Commit changes» a `main`). Se dice: «Simulo lo que hace una IA cuando pega una clave
   en el código y la sube a main».
3. En `{t_revision}` s llega el WhatsApp al teléfono: «VanGUARD · Revisión de código · Push a main (…) · Nuevo: 1
   crítico · 1 clave o token en el código · Rota las claves expuestas…».
4. La fila nueva aparece en la tarjeta (Realtime): «1 nuevo · crítico · WhatsApp en {t_revision} s». Ajustes se nombra
   con una frase: «el canal y la severidad se eligen en Ajustes».

Sin «Generar prompt de corrección» en este tramo: el hallazgo recién empujado no tiene prompt guardado y el anónimo solo
puede leer uno guardado (`mw/anon.ts`); generarlo en vivo gasta tokens y segundos.

Plan B:

- No llega el webhook o la revisión falló → GitHub, «Recent Deliveries» → «Redeliver» (GitHub conserva el delivery y
  E47 reabre una revisión `failed` o atascada). Si la revisión terminó `done`, un push nuevo: el script genera otra
  clave en cada ejecución.
- No llega el WhatsApp → la tarjeta enseña el motivo y el hallazgo sigue en Codebase.
- Push protection bloquea el push → usar un `.env.staging` con `DATABASE_URL=postgresql://postgres:<aleatorio>@db.<ref
  falso>.supabase.co:5432/postgres` (`CB_ENV_COMMITTED` + `CB_SECRET_POSTGRES_URL`, los dos críticos).

---

## 9. Verificaciones pendientes (antes de depender de ello)

1. `compare/{sha}...{sha}` con `Accept: application/vnd.github.diff` y el PAT fine-grained (Contents: Read-only) del
   repo privado. La doc admite el tipo diff y dice que se pueden comparar SHA, pero la descripción de `basehead` habla
   solo de ramas. Prueba con `curl` antes de B5.
2. Que un merge desde la UI de GitHub genere un `push` a `main` con `before`/`after` (lo normal; confirmar en el ensayo).
3. CPU del paso `diff` con un diff de ~1 MB: medir `ms` en el log `revision.fin`.
4. Push protection en el repo privado de la víctima. En repos privados sin «Secret Protection» de pago no suele estar;
   comprobar en Settings → Code security.
5. Ventana de 24 h de Meta con el sandbox: tras G3 (b), E27 debe llegar; no dar la ventana por abierta sin ese mensaje.
6. Número real de Kapso: sigue el problema de cobro de Meta (141006). La demo va por el sandbox hasta que E27 llegue
   por el número real (G3 d).

Resueltas por la revisión: el nombre del check de `webhook_events` (0013 ya no lo toca) y si «Redeliver» conserva el
`X-GitHub-Delivery` (sí, según «Best practices for using webhooks»; el diseño ya no depende de eso). La severidad de
`minimist@1.2.5` en OSV queda para B6.

---

## 10. Fuera de este encargo

- Llamada de voz (ElevenLabs/Twilio) y plantillas de WhatsApp para fuera de la ventana.
- Sondeo por cron como respaldo del webhook (P2).
- Resumen de la revisión con IA (P2, solo en la app).
- `.gitignore` y dependencias con OSV en la revisión (P1: B6). Los pull requests abiertos (B7) pasaron a P0 con D1.
- `pnpm-lock.yaml`, `yarn.lock`, lockfile v1 y rangos de `package.json` en el diff (P1).
- Usar las mismas preferencias de umbral para los incidentes en vivo (P2: cambiaría `planAvisos` y la demo del ataque).

---

## 11. Cambios tras la revisión

VIA = lente de viabilidad, SEG = seguridad, PRO = producto. Todas comprobadas contra el código citado.

| Revisión | Qué cambió | Dónde |
|---|---|---|
| VIA-1 | 0013 ya no amplía `looks_like_secret` a `vgw_`; `comun.ts` y `edge.ts` sin cambios; `redact.ts` sí lo tapa | §0, §3, §7 |
| VIA-2 | OSV y `.gitignore` a P1, con un paso `osv` propio | §2.4, B6 |
| VIA-3 + SEG-1 (`lineaMax`) | Escaneo compacto de las líneas añadidas en vez del archivo sintético rellenado; sin `lineaMax` | §2.3 |
| VIA-4 + PRO-10 | P0 recortado (sin PR, OSV, `.gitignore`, rotar, `last_error 'firma'`, topes a la mitad), E47 y la cola en el mismo deploy, puntos de control y corte a las 19:30 | §2.1, §8.0, §8.2 |
| VIA-5 + PRO-6 | G3 con pasos concretos; `delivery_error` y texto del 131047; project-description con las plantillas P1 | §4.2, §5, §6.1, §8.4, O4 |
| VIA-6 + SEG-7 | «Nuevo» por sitio y por huella: el mismo secreto en otro sitio no duplica; otro valor en la misma línea es nuevo; nota de «Marcar arreglado» | §2.5, §3, §6.1 |
| VIA-7 + PRO-15 | Fixture con `CB_SECRET_STRIPE_LIVE` en `src/lib/pagos.ts:3` (`F_CB_STRIPE_PUSH`, `hallazgoRevision`) | §4.4, §6.3 |
| VIA-8 + SEG-5 | Sin `webhook_events`; «Redeliver» reabre una revisión `failed` o atascada; Plan B con otra clave | §4.1, §8.5 |
| VIA-9 | 401 y 403 sin límite → `last_error 'token'`; 404 documentado | §2.2 |
| VIA-10 | `webhook_url` solo en producción; secreto de fixtures de 43 caracteres | §4.1, §4.2, §6.3 |
| VIA-11 | `gcTime: 0` + `reset()` en E46 | §6.1, F1 |
| VIA-12 + SEG-14 | Sondeo acotado; E45 marca `interrumpida` sin escribir | §4.1, §6.1 |
| VIA-13 | Reactivar vuelve a leer la rama | §1.4, E46 |
| VIA-14 | `FUERA`/`BINARIO` propios en core; `SEVERIDAD_M`; `.env` sin `gitignore_lo_lista` | §2.3, §5.2 |
| SEG-1 | Toda revisión `partial` avisa; binario raro y ruta entre comillas cuentan como `partial`; `base` = último head → P1 | §2.2, §3, §5, §2.9 |
| SEG-2 | `leerAcotado` con `ignorarLargo` para el diff | §2.2 |
| SEG-3 | `ocultarRutas`: no se descarta nada por el cable trampa | §2.5 |
| SEG-4 | Cupo propio de revisiones y el despachador deja de contarlas; enfriamiento → P1 | §5, §5.1 |
| SEG-6 | Caché de la clave HMAC por `config.id` + `iv` | E47 |
| SEG-8 | `rebajarPruebas: false` en la revisión | §2.4 |
| SEG-9 | Sin llamadas, el umbral de llamada también manda WhatsApp (`umbralWhatsapp`) | §5, §5.1, §6.2 |
| SEG-10 | Filtro de forks en el PR (P1) y supresión de B7 solo para el PR fusionado y con la misma huella | §1.3, B7 |
| SEG-11 | Resuelto al quitar `webhook_events` (sin `payload_redacted`) | §4.1 |
| SEG-12 | E47 rechaza fuera del host real tras la firma | §4.1, §7 |
| SEG-13 | Sin repo en el WhatsApp; rama solo con `^[A-Za-z0-9_-]{1,40}$` | §5.2 |
| PRO-1 | Clave aleatoria por ejecución, `--deshacer` y «Marcar arreglado» tras cada ensayo | O5, G4 |
| PRO-2 | G0 con hora límite y org «Tienda Demo» | §8.4 |
| PRO-3 | Textos honestos: «push y merges; pull requests abiertos: próximamente». El PR en P0 queda a decisión (D1) | §6.1, §13 |
| PRO-4 | Guion de ≤ 40 s sin los pasos 2 y 6; `{t_revision}` medido; tramo a decidir (D2) | §8.5, O4, §13 |
| PRO-5 | Realtime por `findings` y `notifications` | §6.1 |
| PRO-7 | Mapa cerrado de motivos y códigos | §6.1 |
| PRO-8 | Sin «Llamada: próximamente» en las filas; texto en la fila abierta y en Ajustes | §6.1, §6.2 |
| PRO-9 | Fuera el paso «Generar prompt» del guion | §8.5 |
| PRO-11 | La tarjeta dice qué revisa y cómo; fuera «Nada sale de GitHub…» | §6.1 |
| PRO-12 | Una sección «Avisos» con dos bloques; textos y umbral visibles en la tarjeta (`whatsapp_ready_contacts`) | §4.2, §6.1, §6.2 |
| PRO-13 | Frase del pitch: «Simulo lo que hace una IA…» | §8.5 |
| PRO-14 | Chip en la barra del módulo → P1 (F7) | §8.3 |

---

## 12. Correcciones descartadas

- **PRO-8, en parte (`alert_state` solo con el umbral de WhatsApp, aviso «no te llegará nada» y voz por defecto en
  `off`).** Se aplica en su lugar SEG-9: mientras no haya llamadas, lo que pase el umbral de llamada sale por WhatsApp.
  Con la propuesta de producto, quien elige «llámame en crítico» y «WhatsApp: nunca» no se entera de un crítico, y eso
  choca con que una vulnerabilidad siempre llegue a alguien. La voz sigue en «Solo crítica» por defecto porque, con el
  respaldo, no cambia nada hasta que existan las llamadas. De PRO-8 sí se aplica quitar el chip de las filas.
- **PRO-3 (PR mínimo en P0 en ~20 min).** No entra por defecto. La estimación no incluye el filtro de forks (SEG-10):
  sin él, en un repo público cualquiera dispara avisos con un PR. Además, VIA-4 muestra que el BACK ya pasa de las 4 h
  sin PR. Queda como decisión D1.
- **PRO-10, en parte (checkpoint a las 18:30).** Es cierto que el BACK puede empezar ya: el ZIP está en `main`
  (a403943, 14:20) y el arreglo de la wiki que tenía sin commitear a las 14:44 se subió a las 15:00 (36cffa1). Pero con
  el BACK empezando hacia las 15:30 y ≈ 4 h de P0, un push en producción a las 18:30 no es alcanzable; el corte va a las
  19:30 (§8.0).
- **PRO-1, en parte (PATCH a `fixed` desde el script y comprobar antes que no haya un `open` con ese recurso).**
  `PATCH /findings/:id` exige `requireAdmin` y el script no tiene sesión. Con la regla de huella (SEG-7), una clave
  distinta en la misma línea ya es «nueva» aunque la anterior siga abierta. Se aplica el resto: clave aleatoria,
  `--deshacer` y «Marcar arreglado» desde la ventana normal.
- **SEG-5, en parte (`unique (config_id, delivery_id)` e índice único parcial `where status <> 'failed'`).** No hace
  falta: la revisión fallida se reabre con UPDATE sobre su misma fila, así que el unique por commit se queda como está, y
  sin `webhook_events` no hay dedupe por delivery que consumir. Sí se aplica la reapertura (`failed`, o `queued` de más
  de 2 min).
- **SEG-4, en parte (enfriamiento de 10 min y «≤ 3 filas por hora»).** El enfriamiento pasa a P1: en la org de demo los
  ensayos empujan varias veces seguidas y lo cortaría, y el cupo por hora ya acota el abuso. El cupo cuenta revisiones,
  no filas: con dos contactos, 3 filas serían una sola revisión.
- **VIA-6, la consulta previa (1 subpetición).** Se hace dentro de `vg_review_findings`: cero subpeticiones y en la misma
  transacción y candado que decide «nuevo».
- **SEG-1, «base = último head revisado» en P0.** Pasa a P1 (§2.9) por tiempo. Una entrega perdida por 413, 429 o 500 es
  rara (el payload de un push no suele pasar de 100 KB) y una revisión fallida ya se repite con «Redeliver».

---

## 13. Decisiones abiertas para Giovanni

**D1 (RESUELTA: «Reglas y PR hoy»; los PR van en P0, B7). ¿«Code review» = reglas sin IA, con los pull requests abiertos en P1?** La revisión de P0 busca claves y tokens y
`.env` subidos en cada push y en cada merge a `main` (los merges llegan como push). No hay IA (costo 0; el prompt de
corrección sigue a mano). La revisión de un PR abierto, antes del merge, queda en P1 y la UI lo dice como «próximamente».
Meterla hoy cuesta ~45 min de BACK con el filtro de forks y pone en riesgo el corte de las 19:30. Por defecto, si no
contestas antes de O2: como está escrito.

**D2. ¿Qué tramo del guion de 3 min cede ≤ 40 s a la revisión, y sale el WhatsApp del «en pausa» para este aviso?**
Propuesta: sustituir «Revisado» (1:40–2:10, el que el guion ya recorta primero) y nombrar Ajustes con una frase. Solo
aplica si a las 19:30 un push real llega por WhatsApp en producción; si no, la revisión va como hoja de ruta.

**D3 (RESUELTA: el de Gabriel; ya es admin de «Tienda Demo»). ¿El repo de la demo sigue siendo el de Gabriel?** Si sí, Gabriel conecta su PAT en «Tienda Demo» y te da Admin del
repo antes de las 18:00 (o crea él el webhook). Si no, creas tú un repo privado nuevo con `sembrar-repo.mjs` y lo
conectas en «Tienda Demo». Eso cambia los hallazgos de la auditoría que ve el jurado.
