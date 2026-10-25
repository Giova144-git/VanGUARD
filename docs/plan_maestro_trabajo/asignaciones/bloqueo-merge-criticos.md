# Bloqueo de merge con críticos: especificación y encargos

Especificación del ORQUESTADOR (sáb 24-oct, ~18:45, hora de Caracas). Cubre la función (2) del pedido de Giovanni:

> «A su vez, si hace una revisión de un PR o cualquier push a main, si tiene un error crítico haz que te avise y que
> bloquee la subida del mismo, de modo que no quedes ese periodo vulnerable.»

Las funciones (1) (nuevos, se mantienen y corregidos, con métricas) y (3) (modo bajo ataque en Cloudflare) van en sus
propios documentos. Este usa la migración **0016** y las rutas **E53–E54**. Decisiones abiertas para Giovanni: §14 (D1,
D2 y D3; **D3 decide si la función se construye**). Correcciones del revisor (sáb 24-oct, ~19:20), integradas tras
comprobarlas contra el código y la documentación de GitHub: §15.

Código leído antes de decidir: `apps/api/src/rutas/webhooks-github.ts`, `revision/pasos.ts`, `notify/revision.ts`,
`rutas/revision.ts`, `rutas/connections.ts`, `rutas/index.ts`, `jobs.ts`, `lib/credentials.ts`, `scans/repo.ts`
(`probarGithub`, `codigoGithub`, `leerAcotado`), `scans/repo-paso.ts` (`recortar`), `scans/comun.ts` (`conexionActiva`,
`PARECE_SECRETO`), `actions/block-ip.ts`, `actions/approvals.ts`, `wiki/corridas.ts`, `wrangler.jsonc`; migraciones
`0003`, `0008h` y `0013` (la aplicada, con `0013c` dentro); `packages/contracts/src/{api,comun}.ts`,
`fixtures/{ids,revision,index}.ts`, `contracts.test.ts`; `packages/core/src/{redact,key-guards}.ts`; en la web
`modulos/codebase/TarjetaRevisionCodigo.tsx`, `modulos/conexiones/{ActivarBlindaje,TarjetaConexion}.tsx`,
`lib/{guias,revision,consultas,mutaciones}.ts`, `componentes/vg/FormToken.tsx`, `scripts/lint-seguridad.mjs`;
`demo/empujar-revision.mjs`; `SECURITY.md` §5; `docs/PASOS_MANUALES_GIOVANNI.md` (repo de la víctima);
`revision-codigo.md` (§2, §3, §4, §8).

Documentación de GitHub consultada hoy: «About webhooks», «About pre-receive hooks» (Enterprise Server), «REST API
endpoints for commit statuses», «REST API endpoints for check runs», «Permissions required for fine-grained personal
access tokens», «Managing your personal access tokens» (URL prellenada), «REST API endpoints for branches», «REST API
endpoints for rules», «About protected branches», «Managing a branch protection rule», «Available rules for
rulesets», «About rulesets» y «GitHub's plans». Además, pruebas en vivo con `curl` sin token contra repos públicos
(`microsoft/vscode`, `supabase/supabase`, `nodejs/node`, `vercel/next.js`): §1.5.

---

## 0. Decisiones en una tabla

| Tema | Decisión | Por qué (dato) |
|---|---|---|
| Quién bloquea | **GitHub**, con la protección de rama del repo. VanGUARD le da el check | Un webhook llega después del push y no puede rechazarlo (§1.1). En github.com no hay pre-receive hooks |
| API | **Commit statuses**, no Checks | Escribir checks solo lo puede hacer una GitHub App. Los estados se publican con un PAT fine-grained con «Commit statuses: write» (§1.2, §1.3) |
| Contexto | `VanGUARD`, exacto y fijo (`GATE_CONTEXT`) | Es lo que el dueño marca como obligatorio. GitHub no distingue mayúsculas |
| Token | **Segundo token** de GitHub, opcional, solo «Commit statuses: Read and write» de un repo. Se guarda como segunda conexión GitHub `kind 'action'`, como el «Modo blindaje» de Cloudflare. Uno por org. **Lo crea el dueño del repo** (en una cuenta personal, un colaborador no puede) | El PAT de lectura no puede escribir. Separar tokens limita el daño si uno se filtra. E53 rechaza un token con Contents o Administration de más (sondeo negativo) |
| Consentimiento | Escritura **automática** con consentimiento permanente del admin, simulación antes de encender, TTL = caducidad del token y «Deshacer» por commit (E54, P0). **D3** | Contradice SECURITY.md tal como está (una sola escritura, con confirmación por acción): lo decide Giovanni, y SECURITY.md se corrige en el mismo deploy que 0016 |
| Cuándo publica | Al cerrar cada revisión de push y de PR, en un **paso nuevo `estado`** de la cola `vg-jobs`. Con el bloqueo apagado no se encola nada | Reintentos propios. El paso `diff` ya cerró y no puede reintentar un POST perdido |
| Qué bloquea | Hallazgos de las líneas **añadidas** con severidad ≥ umbral (`critical` por defecto; `high` opcional), salvo los que el usuario marcó «Ignorar» con el mismo valor. Lo `open` también bloquea | Pedido: «error crítico». **No sirve `counts`**: en un PR, `vg_review_findings` excluye lo visto en el push anterior al mismo PR (`v_previas`). El segundo push al PR con la misma clave daría 0 y pintaría ✓ (§2.2) |
| Revisión fallida o incompleta | Fallida: `error` (bloquea). Incompleta sin bloqueantes (`diff_grande` o `binario`): `error` con un texto por motivo si D2 = (a). `hallazgos_truncados` no cuenta como incompleta. Los lockfiles dejan de contar para el tope de 128 KB | Un producto de seguridad no pinta ✓ sobre lo que no leyó. Los lockfiles no se escanean nunca: contarlos dejaba parcial cualquier PR de dependencias grande |
| `pending` al empezar | **P1** | Con el check obligatorio, GitHub ya muestra «Expected — Waiting for status to be reported» y bloquea. `pending` es solo estético |
| Push directo que se cuela | ✗ en ese commit + el WhatsApp de siempre. **Nunca se revierte** | Revertir exige «Contents: write» y no arregla nada: la clave ya está en el historial. Hay que rotarla |
| Protección de rama | La activa el dueño a mano (§9). Leerla con el token de lectura (chip «Activo» / «Falta la protección») es **P1**; en P0 el chip dice «Publicando» | Configurarla por API exige «Administration: write». Recorte del horario (§15 #1) |
| `VanGUARD ✓` publicado por otro | Riesgo real con «any source»: cualquiera con escritura, o un workflow del propio PR con `statuses: write`, puede tapar nuestro ✗. Detección en **P1** (§2.10). En el pitch no se dice que el bloqueo no se puede saltar | Doc de GitHub: «Any person or integration with write permissions to a repository can set the state of any status check». Cerrarlo exige la GitHub App con la fuente fijada (hoja de ruta) |
| Repo de la demo | Privado, en la cuenta personal de Gabriel: hace falta GitHub Pro. **D1** | En repos privados, proteger ramas exige Pro o Team (§1.4) |
| Repo del propio VanGUARD | E53 lo rechaza (409 `repo_del_producto`) | El equipo empuja directo a `main` y Workers Builds despliega desde el espejo: con el check exigido, un VanGUARD roto no podría publicar el ✓ de su propio arreglo |
| Migración | `0016` sin tablas nuevas. **No toca `vg_review_findings`**. La B5 de evolución (P1) pasa a **0018** | Lo que bloquea lo calcula el paso `diff` en JS (una consulta de ignorados) y lo escribe antes de cerrar |
| Rutas | E53 `PUT …/code-review/gate` (P0, mínimo). E54 «Dar por bueno» y «Deshacer» (**P0** si D3 = a); «Publicar de nuevo» (P1). Cambios pequeños en E45, E47, E8, E9 y E10 | E51–E52 quedan para la función (1) |
| WhatsApp | Sin cambios de texto ni de despachador | El aviso de la revisión ya sale con un crítico nuevo. La plantilla `alerta_seguridad_v1` enviada a Meta no cambia |
| `wrangler.jsonc` | Sin cambios | La cola, `RL_COSTLY` y `APP_ORIGIN` ya existen. Sin cron nuevo |

---

## 1. Lo que GitHub permite (verificado hoy)

### 1.1 Un webhook no puede rechazar un push

- GitHub manda el webhook **cuando el evento ya ocurrió**: el push ya movió la rama. La respuesta del receptor no lo
  deshace («About webhooks»).
- Los scripts que aceptan o rechazan un push (pre-receive hooks) solo existen en **GitHub Enterprise Server**, no en
  github.com («About pre-receive hooks»).
- En github.com, lo que frena un cambio **antes** de que entre es la protección de rama (o un ruleset):
  - «Require a pull request before merging»: nadie empuja directo a `main` (salvo quien tenga excepción).
  - «Require status checks to pass before merging»: los checks obligatorios deben estar en `success` antes de que
    alguien cambie la rama.
- Conclusión: VanGUARD **no bloquea** el push. Publica un estado `failure` en el commit y GitHub, con la protección
  activa, no deja fusionar ni empujar ese commit a `main`. Sin protección, el ✗ solo avisa.

### 1.2 Commit statuses frente a Checks

| | Commit statuses | Checks API |
|---|---|---|
| Quién escribe | Cualquiera con push al repo, con un PAT fine-grained con «Commit statuses: write» | **Solo GitHub Apps**. La doc lo dice para la API REST de checks; los usuarios y las OAuth apps no pueden crear check runs |
| Qué muestra | Un renglón por contexto: icono, contexto, descripción corta y enlace «Details» | Lo mismo, más resumen largo y anotaciones por línea |
| Fuente en la protección | «Any source»: cualquiera con escritura puede publicar el mismo contexto | Se puede fijar la app como fuente |
| Lo que costaría hoy | Una conexión más y un POST por revisión | Registrar una app, guardar su clave privada, firmar JWT, pedir tokens de instalación, reescribir el alta |

**Decisión:** statuses para la entrega. La GitHub App con Checks queda en P2 (§13).

### 1.3 Permisos exactos de un PAT fine-grained

Tabla «Permissions required for fine-grained personal access tokens»:

| Endpoint | Permiso | Token que lo usa |
|---|---|---|
| `POST /repos/{owner}/{repo}/statuses/{sha}` | **Commit statuses: write** | Token de estados (nuevo) |
| `GET /repos/{owner}/{repo}/commits/{ref}/status` | Commit statuses: read (lo incluye write) | Token de estados, en E9 (sondeo sin escribir) |
| `GET /repos/{owner}/{repo}/commits/{ref}/statuses` | Commit statuses: read | Token de estados, P1 (estado ajeno, §2.10) |
| `GET /repos/{owner}/{repo}/branches/{branch}` | Contents: read | Token de **lectura** (el `head` de la rama). Con el token de estados, sondeo negativo en repos **privados** (§4.1 E53) |
| `GET /repos/{owner}/{repo}/keys` | Administration: read | Token de estados: sondeo negativo (200 = tiene Administration de más) |
| `GET /repos/{owner}/{repo}/rules/branches/{branch}` | Metadata: read (todo PAT fine-grained la trae) | Token de lectura (P1) |
| `GET /repos/{owner}/{repo}/branches/{branch}/protection` | Administration: read | **Ninguno**. Ni para el sondeo negativo: con la rama sin proteger responde 404 «Branch not protected» aunque el token tenga el permiso |
| `PUT …/branches/{branch}/protection` | Administration: write | Ninguno: la protección la activa el dueño |

Comprobado de nuevo hoy (~19:20) en la tabla oficial: branches/{branch} y contents en «Contents», keys y
branches/{branch}/protection en «Administration», commits/{ref}/status(es) y statuses/{sha} en «Commit statuses».

- La doc de statuses: solo quien tiene **push** al repo puede crear estados. El dueño del token debe tener escritura.
- **Quién puede crear el token** («Managing your personal access tokens»): un token fine-grained tiene un solo dueño de
  recursos (la cuenta o la organización dueña del repo), y entre lo que no admiten figura contribuir a repos donde el
  usuario es colaborador. En un repo de **cuenta personal** solo lo crea el **dueño** (en la demo, Gabriel; Giovanni no
  puede). En un repo de organización, un miembro de la org, con aprobación si la org la exige. El enlace con
  `target_name` de otro dueño le da error a cualquier otro usuario.
- URL prellenada para crear el token (doc «Managing your personal access tokens»): el permiso se pasa por su nombre.
  El de «Commit statuses» es `statuses`; `write` incluye `read`; Metadata entra sola. Repository access no se puede
  prellenar.

```
https://github.com/settings/personal-access-tokens/new?name=VanGUARD+estados&description=Solo+estados+de+commit+para+VanGUARD&expires_in=30&statuses=write&target_name={owner}
```

- En un repo de una organización, el token queda `pending` hasta que un admin de la org lo apruebe. Mientras, el POST
  falla (E53 lo explica).

### 1.4 Protección de rama: qué bloquea y en qué planes

- «Require status checks to pass before merging»: los checks obligatorios deben estar en `success`, `skipped` o
  `neutral` antes de cambiar la rama protegida. Un check que no llegó se ve como «Expected — Waiting for status to be
  reported» y también bloquea.
- Con «any source», la doc avisa de que el autor de cada estado se verifica a mano en el cuadro de merge.
- Por defecto los admins se saltan la protección clásica. «Do not allow bypassing the above settings» la aplica
  también a ellos.
- **Planes («GitHub's plans»):** «Protected branches» en repos privados figura en **GitHub Pro** (cuentas personales) y
  **GitHub Team** (organizaciones). En repos públicos basta GitHub Free. `vanguard-demo-victima` es privado y está en la
  cuenta personal de Gabriel: **D1**.
- Las listas de excepciones (bypass) de los rulesets solo existen en repos de una organización.

### 1.5 Leer la protección con el token de lectura (probado hoy; se usa en P1)

Sin token, contra repos públicos (`curl -H "Accept: application/vnd.github+json"`):

- `GET /repos/microsoft/vscode/branches/main` devuelve `protected: true` y
  `protection: {enabled, required_status_checks: {enforcement_level: "everyone", contexts: [29 nombres],
  checks: [{context, app_id}]}}`. `supabase/supabase` igual. La protección clásica **se ve con permiso de lectura**.
- Lo que **no** trae: si la protección clásica exige PR. Eso solo sale de `…/protection`, que pide Administration.
- `GET /repos/nodejs/node/rules/branches/main` y `…/vercel/next.js/rules/branches/canary` devuelven las reglas
  activas de los rulesets, incluida `{"type": "pull_request", …}`. La doc añade que los rulesets en modo «evaluate» o
  «disabled» no salen. La regla `required_status_checks` trae `parameters.required_status_checks[].context` y un
  `integration_id` opcional (la app fijada).
- Con un ruleset no se ve su lista de excepciones.

Resultado: VanGUARD sabe si GitHub **exige «VanGUARD»**, si la regla clásica vale **también para admins** y si un
ruleset **exige PR**. Lo que no ve, la UI lo dice (§6.1).

### 1.6 Límites de la API de estados

- `state`: `error`, `failure`, `pending` o `success`.
- `context`: por defecto `default`. GitHub no distingue mayúsculas.
- Como mucho **1.000 estados por SHA y contexto** en un repo. Pasado eso, error de validación (422).
- `description`: la doc no da tope. Se vio 140 caracteres en uso real (sin verificar hoy): core corta a 140.

---

## 2. Diseño

### 2.1 Flujo

```
GitHub ─push / pull_request─▶ E47 (al reabrir una failed, gate_* a null) ─▶ vg-jobs {kind:'review', paso:'diff'}
diff:   claim → compare → reglas → aFila → ocultarRutas
        → [bloqueo encendido] ignorados (1 consulta) → bloqueantes() de core → code_reviews.gate_blocking, gate_findings
        → vg_review_findings (SIN cambios) → encolar 'aviso' si pending → [bloqueo encendido] encolar 'estado'
estado: revisión + config + conexión de estados → estadoCommit() de core → POST /repos/{repo}/statuses/{head_sha}
        → code_reviews.gate_state (lo que GitHub aceptó) o gate_error (por qué no). Bloqueo apagado: ack sin escribir
GitHub: protección de rama exige «VanGUARD» → ✗ = «Merging is blocked»; push directo a main sin ✓ → rechazado
```

**`estado` y el resto del paso `diff` salen en el MISMO deploy.** Hoy `pasoRevision` confirma un `paso` desconocido
(`revision.paso_desconocido`) y el mensaje se pierde.

### 2.2 Qué bloquea

Función pura `bloqueantes(filas, ignorados, umbral)` en `packages/core/src/revision/bloqueo.ts`:

- Entran las filas del paso `diff` **después** de `aFila` y `ocultarRutas` (`oc.filas`, ≤ 200), con severidad ≥ umbral.
  Las de `fuera` (más de 200, ordenadas por severidad) que pasen el umbral se suman al número sin más filtro.
- Una fila **no bloquea** si un hallazgo `ignored` de la org tapa ese mismo valor. Es la misma regla de «no es nuevo»
  de 0013, pero solo con `ignored`:
  - misma `dedupe_key` y la misma huella (`evidence.fingerprint_short`), o sin huella en alguno de los dos lados;
  - o misma regla y misma huella en otro sitio (las dos huellas existen).
- Lo `open` **sí** bloquea: la clave sigue en lo que el cambio añade. Lo `fixed` o `verified` que reaparece, también.
- Sin duplicados por `dedupe_key`. Orden: severidad desc, después `dedupe_key`.
- **Por qué no `counts` ni `new_findings`.** En un PR, `vg_review_findings` quita de «nuevo» lo que salió en la
  revisión anterior del mismo PR (`reported_keys`, 0013). Primer push al PR con la clave: 1 crítico. Segundo push sin
  quitarla: 0 nuevos. Con `counts`, el segundo commit saldría ✓ y se podría fusionar con la clave dentro.
- El PR se revisa siempre con el diff `base...head` entero del PR. Cada revisión ve todo lo que el PR añade.
- La consulta de ignorados (1 subpetición, solo si hay candidatas):
  `findings.select('dedupe_key, rule_id, fp:evidence->>fingerprint_short').eq('org_id').eq('status','ignored')
  .in('rule_id', reglas).limit(500)`.
- En un PR los hallazgos no van a `findings` (0013, `p_write false`): no hay `finding_id` que ignorar. La salida para un
  falso positivo es «Dar por bueno» (E54, P0 si D3 = a) o la excepción de un admin en GitHub.

### 2.3 Qué publica VanGUARD

`estadoCommit(r, umbral, { parcialBloquea })` en core devuelve `{ state, description }`. `r` lleva `status`, `partial`,
`error_code` (el motivo del parcial que ya escribe `pasos.ts`: `diff_grande`, `binario` o `hallazgos_truncados`),
`gate_blocking`, las categorías de `gate_findings` y `gate_override_at`. Texto fijo, ≤ 140 caracteres. Nunca lleva
rutas, valores, títulos de PR, autores ni el nombre del repo.

| Caso | `state` | `description` |
|---|---|---|
| `done`, 0 bloqueantes, completa (o parcial por `hallazgos_truncados`: se leyó todo, solo se recortó lo guardado) | `success` | «Sin hallazgos críticos en lo añadido» (umbral `high`: «Sin hallazgos críticos ni altos en lo añadido») |
| `done`, ≥ 1 bloqueante (completa o no) | `failure` | «1 crítico: clave o token en el código. Detalle en VanGUARD» · «2 críticos: claves o tokens en el código, archivo .env subido. Detalle en VanGUARD» · umbral `high`: «3 hallazgos críticos o altos: …» |
| `done`, parcial `diff_grande`, 0 bloqueantes, D2 = (a) | `error` | «Cambio demasiado grande para revisarlo entero. Que decida un admin en VanGUARD» |
| `done`, parcial `binario`, 0 bloqueantes, D2 = (a) | `error` | «Hay archivos que no pudimos leer (binarios o rutas con acentos). Que decida un admin en VanGUARD» |
| `done`, parcial (`diff_grande` o `binario`), 0 bloqueantes, D2 = (b) | `success` | «Sin críticos en lo revisado (revisión incompleta)» |
| `failed` (token, 404…) | `error` | «No pudimos revisar este cambio. Reenvía la entrega o mira VanGUARD» |
| `queued`/`running` (P1) | `pending` | «Revisando lo añadido en este cambio…» |
| «Dar por bueno» (E54) | `success` | «Aprobado a mano en VanGUARD por un admin» |
| Prueba de E53 sobre un commit que ninguna revisión dio por bueno ni marcó (§4.1) | `pending` | «Prueba de conexión: VanGUARD aún no revisó este commit» |

- `binario` agrupa dos causas (`motivoCorte` en `pasos.ts:165-168`): un binario que no es multimedia y una ruta que git
  pone entre comillas (acentos o caracteres especiales; `RUTA_CITADA`). Por eso el texto nombra las dos y nunca dice
  «demasiado grande».

- Categorías por prefijo de `rule_id`, con singular y plural: `CB_SECRET_*` → «clave o token en el código»;
  `CB_ENV_COMMITTED` → «archivo .env subido»; `CB_DEP_VULN` → «dependencia con vulnerabilidad»;
  `CB_GITIGNORE_NO_ENV` → «.gitignore que ya no excluye .env»; otro → «hallazgo de seguridad».
- `context`: `VanGUARD`.
- `target_url`: `${APP_ORIGIN}/o/${org_id}/codebase?revision=${review_id}`. Es el mismo enlace del WhatsApp. Pide
  sesión. En un repo público, quien lea el estado ve dos uuid que no dan acceso a nada.
- `PARCIAL_BLOQUEA = true` en core: lo decide D2 y se cambia en una línea.

### 2.4 Paso `estado` (nuevo): `apps/api/src/revision/estado.ts`

Mensaje `{v:1, kind:'review', org_id, review_id, paso:'estado'}`. `PasoRevision = 'diff' | 'aviso' | 'estado'`; si
la B5 de evolución (P1, D2 de aquel documento) entra, acabará siendo `'diff' | 'aviso' | 'estado' | 'foto'`. Las dos
funciones tocan `jobs.ts` y `revision/pasos.ts`: el orden de esos cambios lo fija el ORQUESTADOR (§10.0).
Nunca lanza sin decidir: `ack` o `retry`, como `diff`.

1. Lee la revisión (`id, config_id, event, status, partial, error_code, head_sha, gate_blocking, gate_findings,
   gate_override_at`) por `id` + `org_id`. Error → `retry`. Sin fila → `ack`.
2. `queued`/`running` → `ack` (en P0 no hay `pending`; el `diff` encola otro `estado` al cerrar).
3. Config (`enabled, gate_enabled, gate_min, gate_last_error, connection_id`). Sin config, revisión apagada o bloqueo
   apagado → **`ack` sin escribir nada**. Así una org que nunca encendió el bloqueo no ve chips de bloqueo en sus
   revisiones (E45 solo adjunta `gate` si alguna columna `gate_*` tiene algo).
4. `VG_ENV !== 'production'` → `gate_error 'dry_run'` y `ack`. Ni un despliegue de prueba ni local escriben en GitHub.
5. `done` con `gate_blocking` null → `gate_error 'sin_calculo'` y `ack` (el bloqueo se encendió después del diff).
6. Conexión de estados: `connections` con `org_id`, `provider 'github'`, `kind 'action'`, `status 'active'`. Sin ella →
   `gate_error 'sin_token'` y `ack`. El repo sale de `meta.repo_full_name` de esa conexión, validado con
   `NOMBRE_REPO`. El SHA sale de la fila, validado con `^[0-9a-f]{40}$`. Nada sale del payload. Si `meta.repo_id` de la
   conexión de estados no es el de la conexión de lectura de la config de la revisión (`config.connection_id`) →
   `gate_error 'otro_repo'` y `ack` (+1 subpetición; protege del día en que una org tenga varios repos,
   `varias-codebases.md`).
7. `estadoCommit` → `withSecret(… kind 'action')` → `POST https://api.github.com/repos/{repo}/statuses/{sha}` por
   `pedir` (plazo 10 s), `ghHeaders(token)` + `Content-Type: application/json`, cuerpo
   `{state, target_url, description, context: 'VanGUARD'}`. El cuerpo de la respuesta se cancela sin leer.
8. Respuesta:

| GitHub | Qué hace |
|---|---|
| 201 | `gate_state`, `gate_published_at`, `gate_error = null`. Si `config.gate_last_error` tenía algo, se borra. Log `gate.publicado` |
| 401 | `gate_error 'unauthorized'`; `config.gate_last_error 'token'`; la conexión de estados pasa a `revoked` con `last_error 'unauthorized'` (como `guarded` con la de lectura) |
| 403 sin cabeceras de límite (`codigoGithub`) | `gate_error 'forbidden'`; `config.gate_last_error 'forbidden'` (falta el permiso o la org no aprobó el token) |
| 404 | `gate_error 'not_found'`; `config.gate_last_error 'not_found'` (el token no ve el repo) |
| 422 | **Solo** `gate_error 'limite'` en la revisión. La config no se toca: un 422 es de ese commit (SHA que GitHub no encuentra, commit de un PR de fork, tope de 1.000 estados), no del token. `config.gate_last_error` queda para 401, 403 y 404 |
| 429, 403 con límite, 5xx, red, plazo | `retry` escalonado hasta 2 veces; después `gate_error 'red'` |
| `withSecret` sin secreto | `gate_error 'sin_token'` |

9. DLQ del paso `estado` (P1): `gate_error 'dlq'`. En P0 un mensaje en la DLQ deja el check en «Expected» (bloqueado,
   falla cerrado) y la fila sin `gate`.

Publicar dos veces lo mismo no hace daño: el último estado del contexto manda. Si una revisión de `push` y otra de
`pull_request` tienen el mismo `head_sha`, gana la última; las dos revisan ese mismo commit. **Ojo:** «el último manda»
vale también para un estado ajeno. Con «any source», cualquiera con escritura en el repo (o un workflow de Actions del
propio PR con `permissions: statuses: write`) puede publicar `VanGUARD ✓` después de nuestro ✗ y el PR queda
fusionable. La detección es P1 (§2.10); el pitch no dice que el bloqueo no se puede saltar (§7, §11).

### 2.5 Cambios en el paso `diff` (`revision/pasos.ts`)

- `revisar()`: la config se lee con `gate_enabled, gate_min`.
- Con el bloqueo encendido, tras `ocultarRutas` y **antes** de `vg_review_findings`:
  - candidatas (≥ umbral) → ignorados (si hay candidatas) → `bloqueantes()`;
  - `update code_reviews set gate_blocking = n, gate_findings = <≤ 20 {finding_id: null, rule_id, severity, title,
    resource}> where id and org_id and status = 'running'`. Error → `ProviderError('unavailable')` y reintento (la
    revisión sigue `running`). Un 23514 (cable trampa) → se repite con `gate_findings = []` y solo el número.
- Tras la RPC aplicada y el `aviso`: si el bloqueo está encendido, encolar `estado`. Si falla encolar → `retry`.
- `fallar()`: tras escribir `failed`, encola `estado` **solo si ya leyó la config con `gate_enabled = true`** (mejor
  esfuerzo). Los fallos de antes de leer la config (`sha_invalido`, `sin_config`) no publican: el check queda en
  «Expected» y bloquea igual. Con el bloqueo apagado, un fallo no gasta ni un mensaje de cola ni una escritura.
- `yaReclamada()`: además del `aviso`, reencola `estado` si el bloqueo está encendido y la revisión está `done` o
  `failed`, con `gate_state` y `gate_error` en null y (si `done`) `gate_blocking` no null. Así un fallo al encolar no
  deja el PR sin estado. Funciona también tras un «Redeliver» porque E47 limpia las columnas `gate_*` al reabrir (§4.1).
- `cierreRevisionDlq()` (P1): paso `diff` → tras marcar `failed`/`dlq`, encola `estado` (mejor esfuerzo; el paso hace
  `ack` sin escribir si el bloqueo está apagado). Paso `estado` → `gate_error 'dlq'`.
- Con el bloqueo apagado, el paso `diff` no gasta ni una subpetición más.

**Lockfiles fuera del tope de texto añadido (core, P0).** Hoy `parsearDiff` (`packages/core/src/revision/diff.ts:114`)
suma al tope de 128 KB las líneas añadidas de `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`… aunque nunca se
escanean (`esLockfile` solo se mira después, en `:162`). Un PR de dependencias que añada más de 128 KB al lockfile queda
parcial y, con D2 = (a), bloqueado en cada push. Cambio: en `decidir`, `x.lock = esLockfile(path)`; en la rama `+` (y en
`-` y contexto) no se guardan ni se cuentan las líneas de un archivo `lock`. El archivo sigue en `archivos`
(`files_changed` lo cuenta); `lines_added` deja de contar sus líneas. El tope de lectura de 1 MB del diff sigue
incluyéndolas: un lockfile de más de ~1 MB sigue dando `diff_grande`.

### 2.6 Qué pasa en GitHub en cada caso (con la protección activa)

| Situación | VanGUARD publica | GitHub |
|---|---|---|
| PR que añade una clave crítica | `failure` · WhatsApp si no es de un fork | «Merging is blocked» |
| Otro push al mismo PR que la mantiene | `failure` otra vez (cuenta todo lo añadido) · sin WhatsApp repetido (`reported_keys`) | Sigue bloqueado |
| Push al PR que la quita | `success` | Se puede fusionar. El commit viejo sigue en la rama: hay que rotar la clave. Con «Squash and merge» no llega al historial de `main` |
| PR limpio | `success` | Se puede fusionar |
| PR de un fork de fuera | Igual que arriba · sin WhatsApp (0013, `fork`) | Igual. El tope de E47 (`topeFork`, `webhooks-github.ts:245-253`) cuenta **todas** las revisiones de PR de la config de la última hora, no solo las de fork: con 10 o más, un PR de fork que llega queda «Expected» sin fila en VanGUARD |
| Revisión fallida | `error` | Bloqueado hasta un push nuevo, «Redeliver» (E47 reabre una `failed`) o «Dar por bueno» |
| Revisión parcial sin bloqueantes (`diff_grande` o `binario`) | `error` con el texto de su motivo (D2 = a) | Bloqueado. **«Redeliver» no sirve**: E47 solo reabre `failed` (`webhooks-github.ts:168`), y un push nuevo revisa otra vez el PR entero (`base...head`), con la misma causa. Salida: quitar la causa, «Dar por bueno» (E54) o el bypass de un admin |
| Evento que E47 descarta: límite de 10 entregas de PR por minuto (`RL_COSTLY`, cubo `ghpr`; p. ej. Dependabot abriendo varios a la vez), el tope de arriba, o un cambio de rama base del PR (llega como `edited`, que `ACCIONES_PR` no incluye) | Nada | «Expected» y **ninguna fila en VanGUARD** que lo explique. Salida: Recent Deliveries → «Redeliver» (pasado el minuto o la hora); tras cambiar la base, un push nuevo o cerrar y reabrir el PR. P1: procesar `edited` con `changes.base` hacia la rama vigilada |
| Alguien publica `VanGUARD ✓` sobre nuestro ✗ (any source) | Nada en P0 · P1: lo detecta, vuelve a publicar el ✗ y lo dice la fila (§2.10) | Fusionable. GitHub enseña el autor de cada estado en el cuadro de merge |
| VanGUARD caído, revisión o bloqueo apagados | Nada | «Expected — Waiting for status to be reported»: bloqueado (falla cerrado) |
| Push directo a `main` de alguien sin excepción | — | Rechazado: exige PR y el check |
| Push directo de un admin con excepción | `failure` en ese commit · WhatsApp si el hallazgo es nuevo | Entra. GitHub le avisa de que se saltó la regla |
| Un admin fusiona un PR con ✗ | `failure` en el commit de merge · sin WhatsApp si ya se avisó en el PR (`ya_avisado_pr`); P1: aviso «bloqueo saltado» | Entra |

### 2.7 Push directo que se cuela (pedido d)

- Solo pasa si alguien tiene excepción (admin sin «Do not allow bypassing», o lista de excepciones de un ruleset).
- VanGUARD revisa ese push como siempre: `failure` en el commit de `main` y el WhatsApp de la revisión si el hallazgo es
  nuevo.
- La fila dice: «Ya está en {rama}: marcamos ✗. Rota la clave y quítala con un push nuevo». VanGUARD no revierte, no
  fuerza pushes ni borra nada.
- P1: si un push a la rama vigilada trae bloqueantes y el aviso quedó `none` por `ya_avisado_pr`, se pasa a
  `pending` con `alert_reason 'bloqueo_saltado'` (CAS `where alert_state = 'none'`) y se encola `aviso`. Así un merge
  que se saltó el ✗ también avisa.

### 2.8 Segundo token: conexión GitHub `kind 'action'` (pedido b)

- Mismo patrón que el «Modo blindaje»: fila en `connections` con su sobre en `connection_secrets` (AES-GCM, AAD con
  org, id de conexión, `'github'` y `'action'`). Un solo token de estados por org (índice único de 0016).
- Se da de alta y se cambia en **E53**, no en E8. E8 ya tiene una conexión GitHub y responde «Ya hay un repo
  conectado»; quitarla para volver a crearla borraría en cascada `code_review_configs` y el secreto del webhook.
- Al cambiar el token, E53 rota el secreto de la MISMA conexión (`vg_rotate_secret`, 0003): mismo id. Lo hace una
  función nueva de `apps/api/src/lib/credentials.ts`, el único módulo que toca `connection_secrets` (`:6`):
  `rotateConnectionSecret(env, admin, ctx, token, {scopes, capabilities, expiresAt})` sella con el AAD de la misma
  conexión (`{orgId, connectionId, provider: 'github', kind: 'action'}`), calcula la huella con `fingerprint(keys,
  orgId, token)` y llama a `vg_rotate_secret`; un `23505` (esa huella ya está en la org) → `ApiError('conflict')`, un
  `P0002` → `not_found`, nunca `error.message`.
- `meta`: `{repo_full_name, repo_id, branch, purpose: 'commit_statuses'}` (el check de 0003 exige `repo_full_name`).
  `branch` = `code_review_configs.branch` al guardar (la rama vigilada; E9 la usa para sondear). `scopes:
  ['statuses:write']`. `capabilities: {statuses: true}`. `label`: `GitHub · estados · {repo}` (≤ 80). `expires_at`:
  cabecera `github-authentication-token-expiration` de la respuesta del POST de prueba.
- Debe ser distinto del de lectura: E53 compara la huella del token nuevo con las de la org (`fingerprintsOfOrg`,
  `credentials.ts:81`, ya existe) antes de probar (`same_token`). El unique de `connection_secrets (org_id,
  fingerprint)` lo respalda.
- Cambios en las rutas de conexiones (todas P0, pequeños):
  - **E8**: el conteo de «Ya hay un repo conectado» filtra `.eq('kind', 'read')` (ojo: `varias-codebases.md` también
    cambia ese conteo; §15.3).
  - **E9** con GitHub `action`: `probarEstadosGithub` lee `GET /repos/{repo}/commits/{meta.branch}/status` (Commit
    statuses: read; la rama con `encodeURIComponent`). 200 → `active` con el check `statuses:read`. 401 → `revoked`.
    403 o 404 → `error`. Nunca escribe. Hoy E9 llamaría a `probarGithub`, que pide Contents y marcaría el token como
    roto.
  - **E10**: borrar la GitHub de **lectura** borra también la de estados de la org (la config del bloqueo ya cae en
    cascada). La cabecera `X-VG-Revoke-Url` ya lleva a los tokens de GitHub. **Arreglo necesario:** hoy la rama de
    bloqueos de E10 solo mira `kind` (`connections.ts:238`, `if (fila.kind === 'action')`) y su consulta de
    `proposed` recientes es de toda la org (`:245-251`): quitar el token de estados justo después de proponer un
    «Bloquear IP» daría 409 `block_in_progress`. Pasa a `if (fila.kind === 'action' && fila.provider ===
    'cloudflare')`. Va en el B4 de esta función, que por `modo-bajo-ataque.md` §13.1 sale antes que el B3 de bajo
    ataque; ese B3 reescribe el mismo bloque y debe conservar el filtro por `provider`.
  - **Web**: `TarjetaConexion.tsx:106` elige el aviso de «Quitar» solo por `kind` («Sin este token no podrás bloquear
    IPs»). Pasa a elegirlo por `provider` y `kind` (§6.3).
- `wiki/corridas.ts` lista las conexiones GitHub sin filtrar `kind`. Solo usa sus ids para casar hallazgos: la de
  estados no tiene ninguno. No hace falta tocarlo.

### 2.9 Lectura de la protección: `leerProteccion(rama, reglas)` en core (P1)

Recortada de P0 (§15 #1). Mientras no entre, E53 solo lee la rama para saber su `head`, `protection` va `null` y el
chip dice «Publicando» (`unchecked`).


Entradas: el JSON de `GET …/branches/{rama}` y el de `GET …/rules/branches/{rama}` (los dos con el token de lectura,
`leerAcotado` ≤ 64 KB cada uno, la rama con `encodeURIComponent`). Salida `{required, admins, pr_required}`
(`MergeGateProtection` sin `checked_at`). Comparación del contexto sin mayúsculas.

- **Clásica:** `protection.enabled` y `required_status_checks.enforcement_level !== 'off'` y `VanGUARD` en `contexts`
  o en `checks[].context`.
  - Si ese check trae `app_id` > 0 → `other_source` (fijado a una app: nuestro estado no cuenta). `null` o `-1` = any
    source (verificación 4 de §12).
  - `admins`: `everyone` → `enforced`; `non_admins` → `bypass`.
- **Ruleset:** una regla `required_status_checks` con `VanGUARD` en `parameters.required_status_checks[].context`. Con
  `integration_id` → `other_source`. `admins` → `unknown`.
- `required`: `yes` si alguna de las dos lo exige de cualquier fuente; `other_source` si solo fijado; `no` si ninguna;
  `unknown` si no se pudo leer la rama, o si `protected: true` sin protección clásica y la lectura de reglas falló.
- `pr_required`: `yes` si hay una regla `pull_request`; `unknown` si hay protección clásica (no se ve); `no` si la rama
  no está protegida.
- Respuestas: rama 404 → E53 da 409 `sin_rama`. Reglas 403 o 404 → se tratan como lista vacía (un repo privado sin Pro
  puede responder así). 401 → la conexión de lectura está rota: 409 con «Vuelve a conectar GitHub».

### 2.10 P1, con su diseño cerrado

- **`pending` al empezar.** En `revisar()`, con el bloqueo encendido y en producción, se publica `pending` en paralelo
  al compare (`Promise.allSettled`) y se espera **antes** de la RPC. El `estado` final se encola después: siempre llega
  detrás. Mejor esfuerzo: un fallo solo se registra. +5 subpeticiones en `diff` (≤ 25 de 40).
- **E54 `republish`** (§4.1): «Publicar de nuevo». `override` y `revert` son P0 si D3 = (a).
- **Lectura de la protección** (§2.9) en E53 y chip `active` / `needs_protection`; «Comprobar de nuevo».
- **Aviso «bloqueo saltado»** (§2.7).
- **Relectura de la protección** en `estado` si `gate_checked_at` tiene más de 6 h (+3 subpeticiones). Así la tarjeta
  ve si el dueño quitó la protección.
- **Estado ajeno (sube de P2 a P1):** el POST de `estado` ya devuelve el `creator.id` del token (se lee el cuerpo, ≤ 8
  KB, en vez de cancelarlo). Tras el 201, y otra vez a los 120 s (un mensaje `estado` con `delaySeconds: 120` y
  `vigilar: true`, una sola vez), `GET …/commits/{sha}/statuses?per_page=30` (Commit statuses: read, que el token ya
  trae; `leerAcotado` ≤ 32 KB): el primero con contexto `vanguard` (sin mayúsculas) es el vigente. Si su
  `creator.id` no es el nuestro y lo nuestro era `failure` o `error` → se vuelve a publicar lo nuestro y `gate_error
  'estado_ajeno'` (sin migración: `gate_error` ya admite el código). La fila dice «Alguien más publicó “VanGUARD” en
  este commit». No cierra el hueco (el otro puede volver a publicar): lo cierra la GitHub App con la fuente fijada
  (§13). +2 subpeticiones por revisión y +1 mensaje de cola.
- **DLQ** del paso `estado` y encolado desde `cierreRevisionDlq` (§2.5).
- **Rutas entre comillas** en `parsearDiff` (core): desescapar `\ooo`, `\t`, `\"` y `\\` de git en vez de saltar el
  archivo. Quita la causa de parcial más común en repos en español (`docs/Guía.md`).
- **`edited` con `changes.base`** hacia la rama vigilada en E47 (§2.6).

---

## 3. Modelo de datos: `supabase/migrations/0016_bloqueo_merge.sql`

Lo escribe y lo aplica el BACK (dev y prod son el mismo proyecto). No depende de 0015: si 0015 no está lista, 0016 se
aplica igual. **Se aplica ANTES del deploy** que lee las columnas `gate_*`: E45 las pide y, sin ellas, daría 500.

Antes de aplicarla, el BACK confirma el nombre del check de 0003 con
`select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.connections'::regclass and contype = 'c';`.
La función (3) (`modo-bajo-ataque.md`, 0017, E55–E56) no toca este check ni estas tablas; si algún día lo hace, que
parta de `connections_accion_proveedor`. **Numeración:** la B5 de evolución (`evolucion-entre-revisiones.md` §9.2,
tabla `push_snapshots`, P1 con su D2) decía 0016: pasa a **0018** (0017 es de bajo ataque; `varias-codebases.md` no usa
migración). El ORQUESTADOR lo corrige en aquel documento.

```sql
-- 0016_bloqueo_merge.sql · Bloqueo de merge con críticos (docs/plan_maestro_trabajo/asignaciones/bloqueo-merge-criticos.md).
-- Sin tablas nuevas: (1) GitHub admite un token de acciones (solo estados de commit), uno por org; (2) configuración
-- del bloqueo en code_review_configs; (3) lo que bloquea y lo publicado, por revisión. Las tablas siguen solo del
-- servidor: RLS sin políticas y nada para anon ni authenticated (0008h, 0013); las columnas nuevas heredan los grants
-- de su tabla. No toca vg_review_findings: lo que bloquea lo calcula el paso diff y lo escribe antes de cerrar.

-- 1) connections: el check sin nombre de 0003 «kind = 'read' or provider = 'cloudflare'» pasa a admitir GitHub. Se
-- busca por su definición (Postgres le dio un nombre automático) y se cambia por uno con nombre.
do $$
declare
  v text[];
begin
  select coalesce(array_agg(c.conname), '{}') into v
    from pg_constraint c
   where c.conrelid = 'public.connections'::regclass and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%kind = ''read''::text%'
     and pg_get_constraintdef(c.oid) like '%provider = ''cloudflare''::text%';
  if cardinality(v) > 1 then raise exception 'más de un check kind/provider en connections: %', v; end if;
  if cardinality(v) = 1 then execute format('alter table public.connections drop constraint %I', v[1]); end if;
end $$;
alter table public.connections drop constraint if exists connections_accion_proveedor;
alter table public.connections add constraint connections_accion_proveedor
  check (kind = 'read' or provider in ('cloudflare', 'github'));
-- Un solo token de estados por org: E53 lo rota con vg_rotate_secret (mismo id) en vez de crear otro.
create unique index if not exists connections_github_accion_uidx on public.connections (org_id)
  where provider = 'github' and kind = 'action';

-- 2) Configuración del bloqueo, una por config de revisión. gate_min = severidad mínima que bloquea. gate_required,
-- gate_admins y gate_pr_required = lo que E53 leyó de GitHub con el token de LECTURA (null = sin comprobar).
-- gate_last_error = el último fallo del TOKEN de estados al publicar: 401, 403 o 404 (lo borra una publicación buena o
-- E53). Un 422 es de un solo commit y va solo en code_reviews.gate_error. gate_required/gate_admins/gate_pr_required
-- los rellena la lectura de la protección (P1); en P0 quedan null.
alter table public.code_review_configs
  add column if not exists gate_enabled boolean not null default false,
  add column if not exists gate_min text not null default 'critical' check (gate_min in ('critical','high')),
  add column if not exists gate_required text check (gate_required in ('yes','no','other_source','unknown')),
  add column if not exists gate_admins text check (gate_admins in ('enforced','bypass','unknown')),
  add column if not exists gate_pr_required text check (gate_pr_required in ('yes','no','unknown')),
  add column if not exists gate_checked_at timestamptz,
  add column if not exists gate_last_error text check (gate_last_error in ('token','forbidden','not_found')),
  add column if not exists gate_last_error_at timestamptz;

-- 3) Por revisión. gate_blocking = hallazgos de lo AÑADIDO con severidad ≥ gate_min que no tapa un ignored con el mismo
-- valor (null = no se calculó). OJO: no es counts (los NUEVOS; en un PR excluyen lo visto en el push anterior).
-- gate_findings = hasta 20 de esos, redactados como new_findings. gate_state = lo último que GitHub aceptó (201).
-- gate_error = por qué no se publicó. gate_override_* = «Dar por bueno» (E54). E47 pone todas estas columnas a null
-- (gate_findings a '[]') al reabrir una revisión failed con «Redeliver».
alter table public.code_reviews
  add column if not exists gate_blocking int check (gate_blocking >= 0),
  add column if not exists gate_findings jsonb not null default '[]'
    check (jsonb_typeof(gate_findings) = 'array' and jsonb_array_length(gate_findings) <= 20),
  add column if not exists gate_state text check (gate_state in ('pending','success','failure','error')),
  add column if not exists gate_published_at timestamptz,
  add column if not exists gate_error text check (gate_error ~ '^[a-z_]{2,40}$'),
  add column if not exists gate_override_by uuid references auth.users(id) on delete set null,
  add column if not exists gate_override_at timestamptz,
  add column if not exists gate_override_reason text check (char_length(gate_override_reason) between 3 and 200);
alter table public.code_reviews drop constraint if exists code_reviews_gate_limpio;
alter table public.code_reviews add constraint code_reviews_gate_limpio
  check (not private.looks_like_secret(gate_findings::text) and not private.looks_like_secret(gate_override_reason));
```

Notas:

- Sin grants nuevos: `anon` y `authenticated` siguen sin nada en esas tablas (0008h revocó también el ACL por defecto).
  `supabase/tests/rls.sql` debe seguir en verde.
- Sin índices nuevos: `estado` lee por `id`; E54 usa `code_reviews_pr_idx` (0013).
- Sin Realtime nuevo: la tarjeta ya sondea E45 cada 5 s mientras hay una revisión en curso.
- Tras aplicar, el ORQUESTADOR regenera `packages/contracts/src/database.types.ts`.

Pruebas SQL (`supabase/tests/bloqueo.sql`, dentro de `begin … rollback`):

- `vg_create_connection` con `provider 'github'`, `kind 'action'` entra; con `provider 'supabase'`, `kind 'action'` →
  23514; una segunda GitHub `action` en la misma org → 23505.
- `gate_findings` con 21 elementos → 23514; con un texto con forma de secreto → 23514; `gate_error 'Forbidden 403'` →
  23514; `gate_min 'medium'` → 23514; `gate_last_error 'limite'` → 23514.
- `anon` y `authenticated` no leen `code_reviews` ni `code_review_configs` (como `rls.sql`).

---

## 4. Contrato

### 4.1 Rutas

**E53 · `PUT /api/orgs/:org/code-review/gate`** · admin (`requireAdmin`; `anonReadOnly` ya corta al anónimo) · P0
(mínimo; la lectura de la protección es P1) · cuerpo `MergeGatePut` → 200 `MergeGateSaved`. Archivo nuevo
`apps/api/src/rutas/bloqueo.ts`, montado en `rutas/index.ts`.

1. Conexión GitHub de lectura de la org. Sin ella → 404 «Conecta primero tu repo de GitHub». No `active` → 409
   `{reason: 'conexion_inactiva'}`.
2. `code_review_configs` de esa conexión. Sin config, o `enabled: true` con la revisión apagada → 409
   `{reason: 'sin_revision'}` «Activa primero “Revisar cada push”».
3. Con `statuses_pat`, en este orden y sin llamar todavía a GitHub:
   - Solo con `VG_ENV = 'production'` y el host de `APP_ORIGIN` (`esHostProduccion`): publica en GitHub. Si no → 409
     `{reason: 'solo_produccion'}`.
   - `esRepoDelProducto(meta.repo_full_name)` (core; lista fija `platanus-hack/platanus-hack-26-ve-team-22` y
     `Giova144-git/VanGUARD`, sin mayúsculas) → 409 `{reason: 'repo_del_producto'}` «No actives el bloqueo en el repo
     desde el que se despliega VanGUARD: si VanGUARD falla, no podrías fusionar su propio arreglo». También sin token
     con `enabled: true`.
   - `RL_COSTLY` con clave `gate:<userId>` → 429.
   - `guardKey('github', …)` (token clásico → 422 `key_rejected`). Debe empezar por `github_pat_` → 400
     `field_errors.statuses_pat`.
   - Huella del token nuevo (`fingerprint(keys, org, token)`) frente a las de la org (`fingerprintsOfOrg`): si casa con
     la de la conexión de lectura → 422 `key_rejected` `{reason: 'same_token'}` «Usa un token nuevo, solo con Commit
     statuses».
4. Con el token de **lectura** (`withSecret`, kind `read`): `GET …/branches/{rama}` (`leerAcotado` ≤ 64 KB, la rama
   con `encodeURIComponent`) → el `head` de la rama (`commit.sha`, validado con `^[0-9a-f]{40}$`). Rama 404 → 409
   `{reason: 'sin_rama'}`; 401 → 409 «Vuelve a conectar GitHub»; GitHub caído → 503 `provider_unavailable`.
   P1: en paralelo `GET …/rules/branches/{rama}` y `leerProteccion` con las dos respuestas (§2.9).
5. **Sondeo negativo** con `statuses_pat`, en paralelo y **antes** de escribir nada:
   - `GET /repos/{repo}/keys` (Administration: read). 200 → sobra `administration`.
   - Solo si la conexión de lectura dice `meta.private: true`: `GET /repos/{repo}/branches/{rama}` (Contents: read).
     200 → sobra `contents`. En un repo público ese GET responde 200 con cualquier token: no se hace.
   - Algo sobra → 422 `key_rejected` `{reason: 'excess_scope', excess_permissions: [...]}` «Ese token tiene permisos de
     más (Contents, Administration). Crea uno con solo Commit statuses: Read and write». Nada se guarda.
   - 403 o 404 en los dos → bien. 5xx o plazo en alguno → 503 `provider_unavailable`, nada se guarda (falla cerrado,
     como el sondeo negativo de Supabase).
   - No usa `…/branches/{rama}/protection`: con la rama sin proteger (lo normal en este paso, §9) responde 404 «Branch
     not protected» aunque el token tenga Administration.
6. Con `statuses_pat`: POST de prueba al `head` de la rama, `context 'VanGUARD'`, con el estado que VanGUARD **ya
   sabe** de ese commit (1 lectura: la revisión más reciente de la config con ese `head_sha`):
   - revisión `done` con `gate_blocking` no null → `estadoCommit` de esa revisión (su estado real, ✓ incluido);
   - revisión anterior a 0016 (`gate_blocking` null) con `max_severity` ≥ umbral → `failure` con el texto de
     `estadoCommit` armado con `counts` («1 crítico: …»). Es el caso de la demo de hoy: el push de
     `demo/empujar-revision.mjs` dejó la clave en `main` si no se ejecutó `--deshacer`;
   - cualquier otro caso (sin revisión, revisión anterior a 0016 sin críticos, parcial o fallida) → `pending` «Prueba
     de conexión: VanGUARD aún no revisó este commit». **Nunca un ✓ sobre un commit que no se revisó con el bloqueo**:
     `counts` son los hallazgos NUEVOS y 0 no prueba que el commit esté limpio.
   - Sirve para dos cosas: comprueba el permiso sin adivinar, y hace que «VanGUARD» aparezca en el buscador de checks
     de la protección de rama (§9; con `pending`, verificación 2 de §12).
   - La UI lo dice antes de pulsar, con la simulación de D3: es la confirmación explícita de esta escritura.
   - 401 → 422 `provider_rejected` `{reason: 'unauthorized'}` «El token no es válido o caducó».
   - 403 → 422 `provider_rejected` `{missing_permissions: ['statuses:write']}` «Falta Commit statuses: Read and write,
     o el token espera la aprobación de la organización».
   - 404 → 422 `provider_rejected` `{reason: 'not_found'}` «Ese token no ve {repo}: márcalo en Only select
     repositories».
   - 5xx o plazo → 503 `provider_unavailable`. Nada se guarda.
7. Guardar: con conexión de estados → `rotateConnectionSecret` (mismo id, §2.8); sin ella →
   `createConnectionWithSecret` (`provider 'github'`, `kind 'action'`, meta con `branch`, §2.8). Carrera o huella
   repetida (23505) → 409.
8. Config: `gate_enabled`, `gate_min` y `gate_last_error = null` si se guardó un token. P1: también
   `gate_required`/`gate_admins`/`gate_pr_required`/`gate_checked_at`.
9. 200 `MergeGateSaved {gate, checks, probe_sha, probe_state}`. `checks`: `statuses:write` (solo con token,
   `required`); P1 suma `protection:read`.

- Sin `statuses_pat` (cambiar umbral, encender o apagar): pasos 1, 2, la guarda `repo_del_producto` si `enabled`, 8 y 9.
  Se puede encender sin token: el estado queda `needs_token`. P1: «Comprobar de nuevo» relee la protección (paso 4).
- Log `gate.config`: `rid`, `enabled`, `min`, `token` (booleano), `probe` (el `state` publicado). Nunca el token.
- Subpeticiones con token: 3 lecturas en paralelo + huellas 1 + llaves ≤ 2 + secreto de lectura 1 + rama 1 + sondeo
  negativo ≤ 2 + revisión del SHA 1 + POST 1 + alta o rotación 1 + config 1 → **≤ 14** (P1: + reglas 1). Sin token:
  **≤ 4**.

**E54 · `POST /api/orgs/:org/code-review/reviews/:id/gate`** · admin · **`override` y `revert`: P0 si D3 = (a)** (son
el «Deshacer» por commit de esta escritura) · `republish`: P1 · cuerpo `MergeGateAction` → 202
`RespuestaEscritura {ok: true, resultado: 'encolado'}`.

- Comunes: revisión de la org (si no, 404); bloqueo encendido (409 `apagado`); host de producción (409
  `solo_produccion`); `RL_COSTLY` `gate:<userId>`.
- `override`: revisión `done` con `gate_blocking > 0`, o `failed`, o `partial` por `diff_grande` o `binario` (si no,
  409 `nada_que_aprobar`). Escribe `gate_override_by/at/reason` y encola `estado`, que publica `success` «Aprobado a
  mano en VanGUARD por un admin». Vale para ese SHA: el siguiente push se revisa de nuevo. Log `gate.override` con
  `rid`, revisión y largo del motivo (no el texto). En la UI, con panel de simulación (§6.2).
- `revert`: borra el override (409 `sin_override` si no había) y encola `estado`: vuelve el estado de la regla
  (`failure` o `error`).
- `republish` (P1): solo la revisión más nueva de ese PR (o de ese `head_sha` en un push) → si no, 409
  `no_es_la_ultima`. Encola `estado`. Sirve tras pegar el token con PR ya abiertos. En P0 → 409 `{reason: 'p1'}`.

**Cambios en rutas existentes (P0):**

- **E45 · `GET …/code-review`**: lee también la conexión de estados (en paralelo, ≤ 5 subpeticiones en total; ninguna a
  GitHub). `config.gate` siempre que haya config **del repo del bloqueo**: con varios repos (`varias-codebases.md`
  §2.6, punto 4), solo en la config de la conexión de lectura que elige E53 (la del `meta.repo_id` del token de
  estados; sin token, la principal). En las demás pestañas `gate` no viene y el FRONT no pinta la sección (§6.1).
  `state`:
  - `off` si la revisión o el bloqueo están apagados;
  - `needs_token` sin conexión de estados `active`;
  - `error` con `gate_last_error` (solo 401, 403 o 404);
  - P1: `active` con `gate_required = 'yes'`, `needs_protection` con `no` u `other_source`;
  - si no, `unchecked` (en P0, siempre que publica sin error).
  - Cada revisión lleva `gate` si alguna columna `gate_blocking`, `gate_state` o `gate_error` no es null. Con el
    bloqueo apagado nunca se escriben (§2.4 paso 3).
- **E47 · webhook** (`webhooks-github.ts:171-173`): al reabrir una revisión `failed` (o `queued` atascada) con
  «Redeliver», el `update` suma `gate_blocking: null, gate_findings: [], gate_state: null, gate_error: null,
  gate_published_at: null, gate_override_by: null, gate_override_at: null, gate_override_reason: null`. Un «Redeliver»
  pide otra revisión: la tarjeta no enseña el error viejo mientras se revisa, `yaReclamada` vuelve a funcionar (exige
  `gate_state` y `gate_error` en null) y un «Dar por bueno» anterior no sobrevive a la nueva revisión. Necesita 0016
  aplicada antes del deploy.
- **E8, E9, E10**: §2.8.

### 4.2 Código zod EXACTO para `packages/contracts/src/api.ts`

Comprobado hoy (sáb 24-oct, ~19:25) en una copia del paquete en el scratchpad
(`…/scratchpad/bloqueo-zod-v2`, con `aplicar.mjs`, que aplica estos mismos bloques con anclas exactas): `tsc --noEmit`
del repo (TypeScript 6.0.3) en verde y `vitest run` con **57/57** (47 de antes + los 2 casos y los 8 `it` de §4.3).
`ConnectionStatus`, `Id`, `Ts`, `PermCheck`, `Token` y `Sha40` ya están en el archivo; `comun.ts` no cambia. Son tres
inserciones y dos campos opcionales. Cambios frente a la versión anterior de este documento: `MergeGateState` suma
`unchecked` (P0 no lee la protección), `MergeGateError` pierde `limite` (un 422 no es del token), `MergeGateSaved`
suma `probe_state` y `MergeGateAction` documenta `override`/`revert` como P0 (D3).

**(a)** Insertar **justo antes** de `export const CodeReviewConfig = z.object({`:

```ts
// ── Bloqueo de merge con críticos (E53–E54; asignaciones/bloqueo-merge-criticos.md) ─────────────────────────────────
// VanGUARD publica un estado de commit (Commit statuses API) con este contexto EXACTO en cada revisión de push y de PR.
// Es el nombre que el dueño marca como obligatorio en la protección de rama de GitHub (GitHub no distingue mayúsculas).
export const GATE_CONTEXT = 'VanGUARD';
// Severidad mínima de lo AÑADIDO que bloquea. El pedido es «crítico»; 'high' es opcional.
export const MergeGateMin = z.enum(['critical', 'high']);
export type MergeGateMin = z.infer<typeof MergeGateMin>;
// Estados de la Commit statuses API (POST /repos/{owner}/{repo}/statuses/{sha}).
export const CommitStatusState = z.enum(['pending', 'success', 'failure', 'error']);
export type CommitStatusState = z.infer<typeof CommitStatusState>;
// P1. Protección de la rama vigilada, leída por E53 con el token de LECTURA (Get a branch + Get rules for a branch).
// required: yes = GitHub exige «VanGUARD» de cualquier fuente · other_source = lo exige fijado a una GitHub App (nuestro
//   estado no cuenta) · no = no lo exige · unknown = no se pudo leer.
// admins: enforced = la regla clásica vale también para admins · bypass = los admins se la saltan · unknown = ruleset (su
//   lista de excepciones no se ve con un token de lectura) o sin regla.
// pr_required: yes = un ruleset exige PR · no = la rama no tiene protección · unknown = protección clásica (no se ve sin
//   Administration: read).
export const MergeGateProtection = z.object({ required: z.enum(['yes', 'no', 'other_source', 'unknown']),
  admins: z.enum(['enforced', 'bypass', 'unknown']), pr_required: z.enum(['yes', 'no', 'unknown']), checked_at: Ts });
export type MergeGateProtection = z.infer<typeof MergeGateProtection>;
// off: apagado · needs_token: encendido sin token de estados activo · unchecked: publica, pero no sabemos si GitHub exige
// el check (P0 no lee la protección; en P1, lectura fallida) · needs_protection (P1): publica y GitHub aún no exige el
// check (no bloquea nada) · active (P1): publica y GitHub lo exige · error: el token falló al publicar (ver last_error).
export const MergeGateState = z.enum(['off', 'needs_token', 'unchecked', 'needs_protection', 'active', 'error']);
export type MergeGateState = z.infer<typeof MergeGateState>;
// Problemas del TOKEN al publicar (un 422 es de un solo commit y va solo en CodeReview.gate.error):
// token: 401 (caducado o revocado) · forbidden: 403 (sin Commit statuses: write, o pendiente de aprobar en la
// organización) · not_found: 404 (el token no ve el repo).
export const MergeGateError = z.enum(['token', 'forbidden', 'not_found']);
export type MergeGateError = z.infer<typeof MergeGateError>;
// La conexión GitHub kind 'action' (solo Commit statuses). Nunca el token.
export const MergeGateConnection = z.object({ id: Id, status: ConnectionStatus, last4: z.string().max(4).nullable(),
  expires_at: Ts.nullable() });
export type MergeGateConnection = z.infer<typeof MergeGateConnection>;
// protection: null en P0 (no se lee) o si nunca se comprobó.
export const MergeGateConfig = z.object({ enabled: z.boolean(), min_severity: MergeGateMin, state: MergeGateState,
  context: z.literal(GATE_CONTEXT), statuses_connection: MergeGateConnection.nullable(),
  protection: MergeGateProtection.nullable(), last_error: MergeGateError.nullable() });
export type MergeGateConfig = z.infer<typeof MergeGateConfig>;
```

**(b)** En `CodeReviewConfig`, la última línea pasa a:

```ts
  last_ping_at: Ts.nullable(), last_event_at: Ts.nullable(), last_error: CodeReviewHookError.nullable(),
  gate: MergeGateConfig.optional() }); // E45 con 0016; falta en un BACK de antes y en los repos sin bloqueo (varias §2.6)
```

**(c)** Insertar **justo después** de `export type CodeReviewAlert = z.infer<typeof CodeReviewAlert>;`:

```ts
// Bloqueo por revisión (CodeReview.gate). blocking: hallazgos de lo AÑADIDO con severidad ≥ min_severity y sin «Ignorar»
// (null = no se calculó: bloqueo apagado al revisar, o revisión fallida). NO es counts: counts son los NUEVOS y, en un
// PR, excluyen lo ya visto en el push anterior al mismo PR; blocking cuenta todo lo que el cambio añade.
// findings: hasta 20 de esos (finding_id siempre null). state: lo último que GitHub aceptó (null = nada todavía).
// error: por qué no se publicó: sin_token | dry_run | sin_calculo | otro_repo | unauthorized | forbidden | not_found |
// limite | red | dlq (la UI los traduce con un mapa cerrado y un texto por defecto). override_at: «Dar por bueno» (E54).
export const MergeGateReview = z.object({ blocking: z.number().int().min(0).nullable(),
  findings: z.array(CodeReviewFinding).max(20), state: CommitStatusState.nullable(),
  error: z.string().regex(/^[a-z_]{2,40}$/).nullable(), published_at: Ts.nullable(), override_at: Ts.nullable() });
export type MergeGateReview = z.infer<typeof MergeGateReview>;
```

**(d)** En `CodeReview`, la última línea pasa a:

```ts
  created_at: Ts, finished_at: Ts.nullable(),
  gate: MergeGateReview.optional() }); // falta en revisiones de antes de 0016
```

Con `evolucion-entre-revisiones.md` aplicado (así queda en `packages/contracts`, `RECONCILIACION-CONTRATO.md`), `gate`
deja de cerrar el objeto: `gate: MergeGateReview.optional(), // …` y debajo `delta: CodeReviewDelta.nullable().optional() }); // …`.

**(e)** Al final del archivo (tras una línea en blanco):

```ts
// E53 · PUT /api/orgs/:org/code-review/gate. statuses_pat: token fine-grained NUEVO, de un solo repo, con solo «Commit
// statuses: Read and write»; al guardarlo VanGUARD publica en el último commit de la rama vigilada el estado que ya
// conoce de ese commit (✗ si una revisión vio un crítico; ✓ solo si una revisión con el bloqueo lo dio por bueno; si no,
// pending «este commit no se revisó»). Sin statuses_pat: cambia enabled y min_severity.
export const MergeGatePut = z.object({ enabled: z.boolean(), min_severity: MergeGateMin, statuses_pat: Token.optional() });
export type MergeGatePut = z.infer<typeof MergeGatePut>;
// probe_sha / probe_state: commit y estado de la prueba (solo al guardar un token; si no, null los dos).
export const MergeGateSaved = z.object({ gate: MergeGateConfig, checks: z.array(PermCheck), probe_sha: Sha40.nullable(),
  probe_state: CommitStatusState.nullable() });
export type MergeGateSaved = z.infer<typeof MergeGateSaved>;
// E54 · POST /api/orgs/:org/code-review/reviews/:id/gate → RespuestaEscritura. override: «Dar por bueno» (success
// «Aprobado a mano en VanGUARD») · revert: «Deshacer» (vuelve el estado de la regla) · republish (P1): publica de nuevo.
export const MergeGateAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('republish') }),
  z.object({ op: z.literal('override'), reason: z.string().trim().min(3).max(200) }),
  z.object({ op: z.literal('revert') }),
]);
export type MergeGateAction = z.infer<typeof MergeGateAction>;
```

Nombres elegidos para no chocar con `apps/web/scripts/lint-seguridad.mjs`: el campo de la respuesta es
`statuses_connection` (no `token`); el del cuerpo, `statuses_pat`, solo viaja en el cuerpo de la mutación.

### 4.3 Fixtures nuevos

Ids revisados contra los otros documentos de esta noche (reconciliación del contrato, `RECONCILIACION-CONTRATO.md`):
`CONN_GITHUB_ESTADOS` es `…000000000006` (`CONN_GITHUB_2` de `varias-codebases.md` es `…0007`) y `CR_REV_PR_BLOQUEADO`
es `c4000000-…-000000000022` (`CR_REV_JUEVES` de `evolucion-entre-revisiones.md` es `…021`), libres en el repo y en los
cuatro documentos.

`packages/contracts/src/fixtures/ids.ts` (al final):

```ts

// ── Bloqueo de merge con críticos (asignaciones/bloqueo-merge-criticos.md) ──────
export const CONN_GITHUB_ESTADOS = 'c0000000-0000-4000-8000-000000000006'; // GitHub kind 'action' (solo Commit statuses)
export const CR_REV_PR_BLOQUEADO = 'c4000000-0000-4000-8000-000000000022';
export const T_GATE_GUARDADO = '2026-10-24T19:40:05.000Z';
export const T_CR_PR = '2026-10-24T19:45:08.000Z';
```

(`T_GATE_GUARDADO` no lo importa ningún fixture: queda para las pruebas del FRONT.)

`fixtures/revision.ts`: las dos líneas de import pasan a

```ts
import type {
  AlertPrefs, CodeReviewConfig, CodeReviewFinding, CodeReviewSaved, CodeReviewState, Finding, MergeGateConfig, MergeGateSaved,
} from '../api.ts';
import {
  CONN_GITHUB, CONN_GITHUB_ESTADOS, CR_CONFIG, CR_REV_LIMPIA, CR_REV_PR_BLOQUEADO, CR_REV_SECRETO, EXPIRA_TOKENS, F_CB_STRIPE_PUSH,
  REPO, T_CR_PING, T_CR_PR, T_CR_PUSH,
} from './ids.ts';
```

y al final del archivo:

```ts
// ── Bloqueo de merge con críticos (E45 con `gate`, E53) ───────────────────────────────────────────────────────────────
// La historia: a las 19:40Z Gabriel guarda el token de estados. El último commit de main (HEAD) es el push de las 19:20Z
// con la clave: VanGUARD publica allí su estado real, ✗ «1 crítico» (nunca un ✓ sobre un commit que no dio por bueno).
// Después activa en GitHub la protección de rama con el check «VanGUARD». A las 19:45Z el PR #7 añade una clave live de
// Stripe FALSA en otro archivo: ✗ «VanGUARD — 1 crítico» y Merge bloqueado. Las revisiones de antes no traen `gate`.
// P0 no lee la protección: state 'unchecked' y protection null. codeReviewStateBloqueo es un superconjunto de
// codeReviewState (mismas dos revisiones, más el PR arriba): el router del FRONT lo usa para la org de demo. La conexión
// de estados no está en `connections` (conexiones.ts) para no mover las tarjetas de Conexiones: el router la añade al
// guardar E53.
const HEAD_PR = 'a7d3c9e1f5b2048c6e9a1d3f5b7c9e0a2c4e6f81';
const gate = {
  enabled: true, min_severity: 'critical', state: 'unchecked', context: 'VanGUARD',
  statuses_connection: { id: CONN_GITHUB_ESTADOS, status: 'active', last4: 'k9Qz', expires_at: EXPIRA_TOKENS },
  protection: null, last_error: null,
} satisfies MergeGateConfig;
const bloqueante = { finding_id: null, rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical',
  title: 'Clave live de Stripe en el código', resource: 'src/lib/cobros.ts:3' } satisfies CodeReviewFinding;

export const codeReviewStateBloqueo = {
  ...codeReviewState,
  config: { ...config, last_event_at: T_CR_PR, gate },
  recent: [
    { id: CR_REV_PR_BLOQUEADO, event: 'pull_request', branch: 'main', pr_number: 7, base_sha: HEAD, head_sha: HEAD_PR,
      status: 'done', error_code: null, partial: false, files_changed: 1, lines_added: 14,
      counts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 }, max_severity: 'critical', findings: [bloqueante],
      alert: { state: 'sent', reason: null, delivery: 'delivered', delivery_error: null, voice_pending: true,
        notified_at: '2026-10-24T19:45:13.900Z', seconds: 5.9 },
      gate: { blocking: 1, findings: [bloqueante], state: 'failure', error: null,
        published_at: '2026-10-24T19:45:12.700Z', override_at: null },
      created_at: T_CR_PR, finished_at: '2026-10-24T19:45:12.300Z' },
    ...codeReviewState.recent,
  ],
} satisfies CodeReviewState;

// Respuesta de E53 al guardar el token: el estado de prueba en HEAD es el ✗ real de la revisión de las 19:20Z (anterior
// a 0016: sale de max_severity y counts).
export const mergeGateSaved = {
  gate,
  checks: [{ permission: 'statuses:write', ok: true, required: true }],
  probe_sha: HEAD,
  probe_state: 'failure',
} satisfies MergeGateSaved;
```

`fixtures/index.ts`: el import de `./revision.ts` suma `codeReviewStateBloqueo` y `mergeGateSaved`, y los dos van a
`fixtures` tras `hallazgoRevision`. `contracts.test.ts`: las dos claves en `CLAVES_ESPERADAS`; en `casos`
`['codeReviewStateBloqueo', c.CodeReviewState, fx.codeReviewStateBloqueo]` y
`['mergeGateSaved', c.MergeGateSaved, fx.mergeGateSaved]`; y este bloque antes de `describe('fixtures', …)`:

```ts
describe('bloqueo de merge', () => {
  const gate = fx.mergeGateSaved.gate;
  it('el contexto es exactamente VanGUARD', () => {
    expect(c.GATE_CONTEXT).toBe('VanGUARD');
    expect(c.MergeGateConfig.safeParse({ ...gate, context: 'vanguard/revision' }).success).toBe(false);
  });
  it('P0 sin protección leída y P1 con ella cumplen MergeGateConfig', () => {
    expect(c.MergeGateConfig.safeParse({ ...gate, state: 'unchecked', protection: null }).success).toBe(true);
    const p1 = { ...gate, state: 'active', protection: { required: 'yes', admins: 'bypass', pr_required: 'unknown',
      checked_at: '2026-10-24T19:41:00.000Z' } };
    expect(c.MergeGateConfig.safeParse(p1).success).toBe(true);
  });
  it('last_error es solo del token: un 422 no pasa a la config', () => {
    expect(c.MergeGateConfig.safeParse({ ...gate, state: 'error', last_error: 'forbidden' }).success).toBe(true);
    expect(c.MergeGateConfig.safeParse({ ...gate, state: 'error', last_error: 'limite' }).success).toBe(false);
  });
  it('MergeGatePut admite el cambio sin token y rechaza un token corto', () => {
    expect(c.MergeGatePut.safeParse({ enabled: true, min_severity: 'critical' }).success).toBe(true);
    expect(c.MergeGatePut.safeParse({ enabled: true, min_severity: 'medium' }).success).toBe(false);
    expect(c.MergeGatePut.safeParse({ enabled: true, min_severity: 'high', statuses_pat: 'corto' }).success).toBe(false);
  });
  it('MergeGateSaved: sin token, probe_sha y probe_state van null', () => {
    expect(c.MergeGateSaved.safeParse({ ...fx.mergeGateSaved, probe_sha: null, probe_state: null }).success).toBe(true);
    expect(c.MergeGateSaved.safeParse({ ...fx.mergeGateSaved, probe_state: 'aprobado' }).success).toBe(false);
  });
  it('MergeGateAction: override exige motivo; un op desconocido no pasa', () => {
    expect(c.MergeGateAction.safeParse({ op: 'override', reason: 'ok' }).success).toBe(false);
    expect(c.MergeGateAction.safeParse({ op: 'override', reason: 'clave de prueba documentada' }).success).toBe(true);
    expect(c.MergeGateAction.safeParse({ op: 'revert' }).success).toBe(true);
    expect(c.MergeGateAction.safeParse({ op: 'borrar' }).success).toBe(false);
  });
  it('una revisión sin gate (antes de 0016) sigue cumpliendo CodeReview', () => {
    const [primera] = fx.codeReviewState.recent;
    expect(c.CodeReview.safeParse(primera).success).toBe(true);
    expect('gate' in (primera ?? {})).toBe(false);
  });
  it('blocking no es counts: un error de publicación es un código corto', () => {
    const r = c.CodeReview.parse(fx.codeReviewStateBloqueo.recent[0]);
    expect(c.CodeReview.safeParse({ ...r, gate: { ...r.gate!, error: 'Forbidden 403' } }).success).toBe(false);
    expect(c.CodeReview.safeParse({ ...r, gate: { ...r.gate!, state: null, error: 'sin_token' } }).success).toBe(true);
  });
});
```

Ningún fixture casa con `PARECE_SECRETO`: `last4 'k9Qz'` y los SHA son hex.

### 4.4 Lo que no cambia en el contrato

- `Provider`, `ConnectionKind` y `ConnectionCreate`: ya admiten `github` + `action` en el tipo; el alta va por E53.
- `ScanRun`, `Finding`, `RuleId`, `NotificationPublic`, `AlertPrefs`: sin cambios.
- `CodeReviewPut` y E46: sin cambios. Apagar la revisión con el bloqueo exigido en GitHub deja los PR en «Expected»;
  lo avisa la UI (§6.1).
- E47 (`webhooks-github.ts`): sin cambios de contrato. Solo cambia el `update` de la reapertura (§4.1).

---

## 5. Archivos por capa

| Capa | Archivo | Qué |
|---|---|---|
| core | `packages/core/src/revision/bloqueo.ts` (nuevo, exportado en `index.ts`) | `CONTEXTO_BLOQUEO = 'VanGUARD'`, `UmbralBloqueo`, `EstadoCommit`, `PARCIAL_BLOQUEA`, `LIM_BLOQUEO = {filas: 20, descripcion: 140}`, `REPOS_DEL_PRODUCTO` y `esRepoDelProducto(full)`, `superaBloqueo(sev, umbral)`, `bloqueantes(filas, ignorados, umbral)`, `estadoCommit(r, umbral, o)` (texto por motivo de parcial). P1: `leerProteccion(rama, reglas)`. Puro, sin red |
| core | `packages/core/src/revision/diff.ts` | Lockfiles fuera del tope de 128 KB de texto añadido (§2.5). P1: rutas entre comillas |
| core | `packages/core/src/revision/bloqueo.test.ts` (nuevo), `diff.test.ts` | §10.5 |
| api | `apps/api/src/revision/estado.ts` (nuevo) | `pasoEstado` y `publicarEstado(token, repo, sha, body)` |
| api | `apps/api/src/revision/pasos.ts` | §2.5; `pasoRevision` enruta `'estado'` |
| api | `apps/api/src/jobs.ts` | `PasoRevision = 'diff' \| 'aviso' \| 'estado'` (con evolución B5: `\| 'foto'`) |
| api | `apps/api/src/lib/credentials.ts` | `rotateConnectionSecret` (§2.8); E53 usa también `fingerprintsOfOrg`, que ya existe |
| api | `apps/api/src/rutas/bloqueo.ts` (nuevo) + `rutas/index.ts` | E53 (P0 mínimo); E54 `override`/`revert` (P0 con D3 = a), `republish` (P1) |
| api | `apps/api/src/rutas/revision.ts` | E45: `config.gate` y `recent[].gate` |
| api | `apps/api/src/rutas/webhooks-github.ts` | E47: columnas `gate_*` a null al reabrir (§4.1) |
| api | `apps/api/src/rutas/connections.ts` | E8 filtra `kind`; E9 con GitHub `action`; E10 borra también la de estados y su rama de bloqueos filtra `provider 'cloudflare'` |
| api | `apps/api/src/scans/repo.ts` | `probarEstadosGithub` (E9, solo lectura), `leerRama` (head con el token de lectura), `sondeoNegativoEstados` (§4.1 paso 5). P1: `leerRamaYReglas` |
| web | `apps/web/src/modulos/codebase/BloqueoMerge.tsx` (nuevo) | Sección del bloqueo (§6.1) |
| web | `apps/web/src/modulos/codebase/TarjetaRevisionCodigo.tsx` | Monta `BloqueoMerge`; chip, detalle y «Dar por bueno» / «Deshacer» por fila; aviso al apagar la revisión |
| web | `apps/web/src/lib/revision.ts` | `chipBloqueo`, `textoBloqueo`, `textoErrorBloqueo` (mapas cerrados con `deMapa`) |
| web | `apps/web/src/lib/mutaciones.ts` | `useGuardarBloqueo` (E53, `gcTime: 0`, `reset()`); `useAccionBloqueo` (E54) |
| web | `apps/web/src/lib/guias.ts` | `GUIA_ESTADOS_GITHUB` (pasos, quién crea el token y URL prellenada de §1.3) |
| web | `apps/web/src/modulos/conexiones/TarjetaConexion.tsx` | Línea «Estados de commit (bloqueo de merge)» en la tarjeta GitHub; aviso de «Quitar» por `provider` y `kind` |
| web | `apps/web/src/lib/fixtures/router.ts` | E53, E54 y `codeReviewStateBloqueo` |
| demo | `demo/empujar-revision.mjs` | `--rama <nombre>` (ORQUESTADOR) |
| docs | `SECURITY.md` §2 y §5 | En el MISMO deploy que 0016 (O5a, P0; D3) |

---

## 6. UI (FRONT)

### 6.1 Codebase: sección «Bloquear merges con críticos»

Componente `BloqueoMerge.tsx`, dentro de `TarjetaRevisionCodigo`, debajo de «Umbral» y antes de «Pasos en GitHub».

- **Bandera:** solo se pinta si `s.config?.gate` existe (BACK con 0016) y la revisión está activa. Si E53 da 404, igual.
- **Cabecera:** «Bloquear merges con críticos» + `Interruptor` (solo admin; el viewer ve el estado). Una línea: «Si un
  cambio añade un hallazgo crítico, marcamos ✗ “VanGUARD” en GitHub. Con la protección de rama, GitHub no deja
  fusionarlo.»
- **Simulación antes de encender** (D3; solo admin, al pulsar el `Interruptor` con el bloqueo apagado; confirmar llama a
  E53): «En cada pull request y en cada push a {rama} publicaremos el check “VanGUARD” en GitHub: ✗ si el cambio añade
  un hallazgo crítico (o alto, según el umbral) o si no pudimos leerlo entero; ✓ si no. Si en GitHub marcas ese check
  como obligatorio, un ✗ impide fusionar. No tocamos código, ramas ni ajustes. Lo apagas aquí cuando quieras y cada ✗
  se puede dar por bueno desde su revisión. El token caduca a los 30 días: entonces dejamos de publicar.» Botones
  «Encender» y «Cancelar».
- **Umbral** (admin): «Bloquea desde: Solo crítico | Crítico o alto» → E53.
- **Chip de estado** (`Etiqueta`):
  - `off`: «Apagado»;
  - `needs_token`: «Falta el token de estados»;
  - `unchecked` (lo normal en P0): «Publicando en GitHub» y al lado «Comprueba en GitHub que el check “VanGUARD” es
    obligatorio (paso 2)»;
  - P1 `needs_protection`: «Falta la protección de rama»;
  - P1 `active`: «Activo: GitHub exige “VanGUARD”»;
  - `error`: «Con error» y al lado el texto de `last_error`.
- **Paso 1 · Token de estados** (abierto con `needs_token` o `last_error` de token; plegado si no; solo admin):
  1. «Lo crea el dueño del repo en GitHub (o un miembro de la organización dueña, con aprobación si la org la exige).
     Un colaborador no puede crear este tipo de token para un repo ajeno.»
  2. «Crea un token solo para esto» → enlace prellenado de §1.3 (con `target_name` = dueño, solo si `repo_full_name`
     pasa `REPO_VALIDO`).
  3. «En Repository access elige “Only select repositories” y marca {repo}.»
  4. «Comprueba que solo tiene Commit statuses: Read and write (Metadata: Read-only viene sola). Si tiene Contents o
     Administration, lo rechazamos.»
  5. `CampoToken` (password, nunca prellenado) con `preGuardar(valor, 'github')`.
  6. Aviso antes del botón: «Al guardar publicamos un estado de prueba “VanGUARD” en el último commit de {rama}: ✗ si ya
     sabemos que tiene un crítico; si no, “pendiente”. Nunca un ✓ sobre un commit que no revisamos.»
  7. Botón «Guardar y probar». Tras el éxito se vacía el campo y se llama a `reset()`; una línea dice qué se publicó
     (`probe_state` en `probe_sha` corto). Nunca va a `localStorage`, la URL ni la caché de consultas (`gcTime: 0`,
     como `useGuardarRevision`).
  8. `excess_scope` (422): «Ese token tiene permisos de más ({excess_permissions}). Crea uno con solo Commit statuses.»
     `repo_del_producto` (409): el mensaje del servidor.
- **Paso 2 · Protección de rama** (abierto con `unchecked`; P1 con `needs_protection`): enlace a
  `https://github.com/{repo}/settings/branches` y los pasos de §9 en corto, con «En un repo privado, proteger ramas exige
  GitHub Pro o Team» si `conexion.meta.private`. P1: botón «Comprobar de nuevo» (E53 sin token) y textos por
  `protection`:
  - `other_source`: «GitHub exige “VanGUARD” de una app concreta. Elige “Any source” en ese check para que cuente el
    nuestro.»
  - `admins: bypass`: «Los admins del repo pueden saltárselo.» · `enforced`: «Vale también para los admins.»
  - `pr_required: unknown`: «Comprueba que “Require a pull request before merging” está marcado: con un token de solo
    lectura no lo vemos.»
  - `checked_at`: «Comprobado {cuando}».
- **Ayuda fija bajo el paso 2:** «Si un PR se queda en “Expected” y no aparece aquí abajo: en GitHub → Settings →
  Webhooks → Recent Deliveries → “Redeliver”. Si cambiaste la rama base del PR, empuja un commit nuevo o ciérralo y
  reábrelo.»
- **Errores** (`last_error`, solo del token):
  - `token`: «El token de estados caducó o se revocó: pega uno nuevo.»
  - `forbidden`: «El token no puede publicar estados: márcale Commit statuses: Read and write, o espera la aprobación
    de la organización.»
  - `not_found`: «El token de estados no ve el repo: márcalo en Only select repositories.»
- **Aviso al apagar** (el bloqueo, y también «Revisar cada push») siempre que `gate.state` no sea `off` (en P0 no
  sabemos si GitHub exige el check; P1: solo con `protection.required = 'yes'`): `ConfirmarEnSitio` con «Si GitHub
  exige el check “VanGUARD”, los pull requests quedarán en “Expected” y no se podrán fusionar. Quita el check en GitHub
  antes, o déjalo encendido.»

### 6.2 Fila de cada revisión

Chip nuevo `chipBloqueo(r)` (solo si `r.gate` existe), junto a los de hoy:

| `gate` | Chip | Rol |
|---|---|---|
| `state: failure`, PR | «✗ Merge bloqueado · {blocking} crítico(s)» (umbral `high`: «… crítico(s) o alto(s)») | mal |
| `state: failure`, push | «✗ Ya está en {rama}» | mal |
| `state: success` con `override_at` | «✓ Aprobado a mano» | aviso |
| `state: success` | «✓ GitHub» | bien |
| `state: error`, revisión parcial | «GitHub: no pudimos leerlo entero» | aviso |
| `state: error`, revisión fallida | «GitHub: no pudimos revisar» | aviso |
| `state: pending` | «GitHub: revisando…» | info |
| `error: estado_ajeno` (P1) | «Otro publicó “VanGUARD” en este commit» | mal |
| `state: null` y `error` | «No publicado: {textoErrorBloqueo}» | neutra |

En el detalle abierto:

- «Lo que bloquea» con `gate.findings` (`ChapaSeveridad`, título, recurso con `<bdi>` y `sinBidi`). Si `blocking` >
  `findings.length`: «y {n} más».
- Parcial con `error`: el motivo con el `error_code` de la revisión: `diff_grande` «El cambio es demasiado grande para
  revisarlo entero» · `binario` «Hay archivos que no pudimos leer: binarios que no son imágenes, o rutas con acentos».
  Y: «Un push nuevo vuelve a revisar todo el PR: si la causa sigue, el ✗ también. “Redeliver” no lo cambia.»
- Push con `failure`: «Este cambio ya está en {rama}. Rota la clave y quítala con un push nuevo. VanGUARD no revierte
  nada solo.»
- PR con `failure`: «Arréglalo con un push nuevo al PR. Aunque lo quites, la clave quedó en el historial de la rama:
  rótala.»
- Solo admin, **P0 si D3 = (a)**: «Dar por bueno este commit» (E54 `override`) en revisiones con `failure` o `error`,
  con panel de simulación: «Publicaremos ✓ “VanGUARD — Aprobado a mano en VanGUARD por un admin” en {sha7}. Un push
  nuevo se revisa otra vez. Puedes deshacerlo.» Campo «Motivo» (3–200). Tras aprobar, botón «Deshacer» (`revert`).
  P1: «Publicar de nuevo» (`republish`).

### 6.3 Conexiones

- En `TarjetaConexion` de GitHub, si hay conexión `action`: `LineaConexion` con título «Estados de commit (bloqueo de
  merge)». Aviso de «Quitar»: «Sin este token no marcamos ✗ en GitHub. Si GitHub exige el check “VanGUARD”, los pull
  requests quedarán esperando.»
- El aviso de «Quitar» se elige por `provider` **y** `kind`: hoy `TarjetaConexion.tsx:106` lo elige solo por `kind` y
  le diría «Sin este token no podrás bloquear IPs» al token de estados. Cloudflare `action` conserva su texto.
- Sin conexión `action`: nada nuevo aquí; una línea «Se configura en Codebase → Revisión automática» con enlace a
  `/o/{org}/codebase#revision-codigo`.
- El aviso de «Quitar» de la conexión de lectura suma: «También quitamos el token de estados.»

### 6.4 Textos de `gate.error` (mapa cerrado, `deMapa`, texto por defecto «No se publicó»)

`sin_token` «Falta el token de estados» · `dry_run` «Solo se publica desde officialvanguard.com» · `sin_calculo` «Se
activó después de esta revisión» · `otro_repo` «El token de estados es de otro repo» · `unauthorized` «El token de
estados caducó» · `forbidden` «El token no puede publicar estados» · `not_found` «El token no ve el repo» · `limite`
«GitHub rechazó el estado de este commit» · `red` «GitHub no respondió» · `dlq` «No pudimos terminar» (P1) ·
`estado_ajeno` «Otro publicó “VanGUARD” en este commit» (P1). (`apagado` ya no existe: con el bloqueo apagado no se
escribe nada.)

### 6.5 Modo fixtures

El router sirve `codeReviewStateBloqueo` en la org de demo (gate `unchecked`, sin protección leída). E53 con
`statuses_pat` → `mergeGateSaved` (`probe_state: 'failure'`; añade la conexión de estados a la lista). E54 `override`
→ la revisión pasa a `state: 'success'` con `override_at`; `revert` la devuelve a `failure`. P1: E53 sin token con
`enabled: true` → mismo `gate` con `state: 'active'` y `protection.required: 'yes'`, para ensayar «Comprobar de nuevo».

---

## 7. Seguridad

| Amenaza | Control |
|---|---|
| Robo del token de estados en la base | Sellado AES-GCM (Box de 05.7), AAD atado a org + id de conexión + `github` + `action`. Nunca en logs, IA, MCP ni respuestas. `redact.ts` ya tapa `github_pat_` |
| El token sirve para más cosas | La guía prellena solo `statuses=write` y pide un solo repo. Lo usa la cola sin un humano en cada uso, así que E53 hace **sondeo negativo** antes de escribir: `GET …/keys` (Administration) y, en repos privados, `GET …/branches/{rama}` (Contents); un 200 → 422 `excess_scope` y no se guarda. Residual: en un repo público no se detecta Contents de más, ni otros permisos (Workflows, Secrets…). `same_token` impide reusar el de lectura |
| Alguien con escritura en el repo publica un `VanGUARD ✓` falso | **Riesgo real, no teórico**: doc de GitHub, «Any person or integration with write permissions to a repository can set the state of any status check»; y quien tiene escritura puede dar `statuses: write` al `GITHUB_TOKEN` de un workflow de su PR con la clave `permissions`. Es justo el actor de la demo (la IA del equipo con escritura). P1: detección tras publicar y a los 120 s (§2.10), que vuelve a publicar el ✗ y lo marca en la fila. GitHub enseña el autor de cada estado en el cuadro de merge. Cierre de verdad: GitHub App con la fuente fijada (§13). **Pitch (T02-14): nunca «no se puede saltar»** |
| Webhook falso que pinte ✓ | E47: HMAC antes de parsear (sin cambios). El SHA sale del payload firmado; el repo, de la conexión; el estado, de la regla. Nada del payload decide |
| ✓ engañoso | `success` solo con `done`, completa o parcial por `hallazgos_truncados` (D2), y 0 bloqueantes. `blocking` cuenta todo lo añadido, no solo lo nuevo (§2.2). Fallo o parcial por `diff_grande`/`binario` → `error`. La prueba de E53 nunca publica ✓ sobre un commit que no se revisó con el bloqueo: `pending` o el ✗ que ya se conoce |
| Datos de más en GitHub | Descripción fija de core: sin rutas, valores, títulos, autores ni repo. ≤ 140 |
| Escritura sin confirmación por acción | **D3.** Escritura automática con consentimiento permanente: simulación antes de encender (§6.1), «Guardar y probar» del admin y el paso del dueño en GitHub (sin el check obligatorio, el ✗ no bloquea nada); TTL = caducidad del token (30 días prellenados; con 401 deja de publicar); «Deshacer» por commit con «Dar por bueno» y «Deshacer» (E54, P0) y global con el interruptor. Un estado no cambia código, ramas ni ajustes, y el siguiente lo reemplaza. Es la segunda escritura en sistemas del cliente, tras «Bloquear IP» (tercera con bajo ataque) |
| Repo del propio VanGUARD | E53 rechaza `repo_del_producto` (core, lista fija). §9: nunca «Do not allow bypassing» en un repo desde el que se despliega VanGUARD |
| Fork o colaborador que crea el token | Un colaborador no puede crear el token fine-grained de un repo de cuenta personal (§1.3): lo crea el dueño. La UI lo dice (§6.1) |
| Despliegue de prueba que escribe en GitHub | `estado`: fuera de producción → `dry_run`. E53 con token solo desde el host de `APP_ORIGIN` |
| Revertir o borrar | Nunca. Exigiría Contents: write. VanGUARD avisa y marca ✗ |
| Spam de estados o de cola | ≤ 2 POST por revisión (P1: 3). Tope de GitHub: 1.000 por SHA y contexto. PR de forks: entran mientras la config tenga menos de 10 revisiones de PR en la última hora (E47) |
| VanGUARD caído | Falla cerrado: el check obligatorio queda «Expected». El dueño decide si se salta la regla |
| Viewer y anónimo | E45 de solo lectura, sin token ni secreto. E53 y E54 con `requireAdmin` y `anonReadOnly` |
| La clave del PR queda en el historial de la rama | El bloqueo evita que llegue a `main` y a producción, no que exista en GitHub. El WhatsApp y la fila piden rotarla |
| Lo que no se ve de la protección | La UI dice qué no puede comprobar (PR obligatorio en la clásica, excepciones de un ruleset) |
| T02-14 | En el pitch y en `project-description.md` solo si el ensayo deja «Merging is blocked» en el repo de la demo. Se dice «GitHub no deja fusionar mientras VanGUARD marque ✗», nunca que el bloqueo no se puede saltar (admins con excepción y cualquiera con escritura pueden) |

**`SECURITY.md` en el MISMO deploy que 0016** (O5a, P0; no después). Desde que 0016 cambia el check de `connections`,
estas líneas serían falsas:

- `SECURITY.md:36` (§2, «Solo lectura por defecto»): «La única escritura es «Bloquear IP» (sección 5), con otro token y
  confirmación humana» → «Escrituras (sección 5): «Bloquear IP», con otro token y confirmación humana por acción, y el
  estado de commit “VanGUARD” del bloqueo de merge, con otro token que solo puede publicar estados y el consentimiento
  permanente de un admin».
- `SECURITY.md:165` (§5): «Es la única escritura sobre la infraestructura del cliente» → «Es la única que cambia la
  infraestructura del cliente; la otra escritura es un estado de commit en GitHub (5.x)».
- `SECURITY.md:169-170` (§5.1): «La base solo admite `action` en Cloudflare (`check` en `0003_connections_crypto.sql`)»
  → «La base admite `action` en Cloudflare y GitHub (`connections_accion_proveedor`, 0016); en GitHub, una por org y
  solo para estados de commit».
- §5.x nuevo, «Estado de commit “VanGUARD”»: token y permisos, sondeo negativo, consentimiento (D3), simulación, TTL,
  «Deshacer», `dry_run` fuera de producción, falla cerrado y el riesgo de «any source» sin esconderlo.

`modo-bajo-ataque.md` (O3a, P0) edita las mismas secciones: el ORQUESTADOR las fusiona en un solo cambio. Las filas de
`THREAT_MODEL.md` siguen en O5 (P1).

---

## 8. Costo en Workers Free

| Invocación | CPU | Subpeticiones |
|---|---|---|
| `diff` con el bloqueo apagado | Igual que hoy | Igual que hoy (≤ 17 de 40) |
| `diff` con el bloqueo encendido | + filtrar ≤ 200 filas: < 0,1 ms | + ignorados ≤ 1 + `gate_*` 1 + encolar `estado` 1 → **≤ 20 de 40** |
| `estado` | AES-GCM + armar un JSON pequeño; la respuesta no se parsea: < 1 ms | revisión 1 + config 1 + conexión de estados 1 + conexión de lectura (`otro_repo`) 1 + secreto 1 + llaves ≤ 2 (en frío) + POST ≤ 4 (saltos) + cierre 1 + config y conexión en error ≤ 2 → **≤ 14**. Bloqueo apagado: revisión 1 + config 1 y `ack` |
| P1 estado ajeno | Un `JSON.parse` de ≤ 32 KB: < 1 ms | + 2 (cuerpo del POST ya leído; GET statuses) y un mensaje de cola a los 120 s → ≤ 16 |
| E53 con token | 1 `JSON.parse` de ≤ 64 KB (lo normal, ~5 KB; P1: 2), una huella HMAC, un sellado: ~1–2 ms | 3 lecturas en paralelo + huellas 1 + llaves ≤ 2 + secreto de lectura 1 + rama 1 + sondeo negativo ≤ 2 + revisión del SHA 1 + POST 1 + alta o rotación 1 + config 1 → **≤ 14** (P1: ≤ 15) |
| E53 sin token | < 1 ms | **≤ 4** (P1 «Comprobar de nuevo»: ≤ 8) |
| E54 | < 1 ms | revisión 1 + config 1 + override 1 + encolar 1 → **≤ 4** |
| E45 | Igual | + 1 en paralelo → **≤ 5** |
| P1 `pending` en `diff` | < 0,5 ms | + 5 → ≤ 25 de 40 |

- Cola: + 1 mensaje por revisión con el bloqueo encendido (~3 operaciones de las 10.000 diarias). Con el bloqueo apagado, ninguno: ni en las fallidas.
- GitHub: ≤ 2 POST por revisión, de las 5.000 peticiones por hora del PAT.
- Sin cron nuevo. `wrangler.jsonc` sin cambios.

---

## 9. Pasos en GitHub para el dueño del repo (pedido c)

Requisito: repo público, o privado con GitHub Pro (cuenta personal) o Team (organización). Antes: «Guardar y probar» en
VanGUARD (el token lo crea el dueño del repo, §1.3), para que el estado de prueba haga aparecer «VanGUARD» en el buscador
de checks.

**Nunca en el repo desde el que se despliega VanGUARD** (`platanus-hack/platanus-hack-26-ve-team-22` y su espejo
`Giova144-git/VanGUARD`): el equipo empuja directo a `main` y Workers Builds despliega desde el espejo. Con el check
exigido, los pushes de BACK y FRONT fallarían y un VanGUARD roto no podría publicar el ✓ que necesita su propio arreglo.
E53 lo rechaza (`repo_del_producto`); y si alguien protege a mano uno de esos repos, nunca con «Do not allow bypassing».

**Protección clásica (recomendada; la que lee mejor VanGUARD):**

1. Repo → **Settings** → **Branches** (`https://github.com/{repo}/settings/branches`).
2. **Add classic branch protection rule**.
3. **Branch name pattern:** `main` (la rama vigilada).
4. ☑ **Require a pull request before merging**. Para la demo, desmarca **Require approvals**: si no, el PR limpio
   también espera una aprobación y su autor no puede aprobarse. En un cliente real, déjalo con 1.
5. ☑ **Require status checks to pass before merging** → en el buscador escribe `VanGUARD` y elígelo. Fuente: any
   source (la de los estados publicados con un PAT).
6. ☐ **Require branches to be up to date before merging** (opcional: obliga a actualizar el PR cuando `main` avanza).
7. **Do not allow bypassing the above settings:** en un cliente real, ☑ (vale también para admins). En la demo, ☐:
   así Gabriel puede rescatar el repo si VanGUARD cae. Por eso el PR de la demo se enseña con la sesión de **Giovanni**
   (colaborador, sin excepción): con la de Gabriel (admin) GitHub ofrece fusionar saltándose las reglas al lado del
   bloqueo (§11).
8. **Create** (o **Save changes**).
9. En VanGUARD (P1): **Comprobar de nuevo** → «Activo: GitHub exige “VanGUARD”». En P0 el chip sigue en «Publicando»:
   la comprobación es el punto de abajo.

**Con ruleset (alternativa):** Settings → **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset** →
Name `VanGUARD` → Enforcement status **Active** → Target branches → **Add target** → **Include default branch** → ☑
**Require a pull request before merging** (Required approvals: 0) → ☑ **Require status checks to pass** → **Add
checks** → `VanGUARD` → **Create**. Con ruleset VanGUARD ve que se exige PR, pero no la lista de excepciones.

Cómo se comprueba: un `git push origin main` directo de alguien sin excepción debe fallar con un error de rama
protegida; un PR con una clave falsa debe mostrar ✗ y «Merging is blocked».

En un cliente real, además: con «any source», cualquiera con escritura (o un workflow con `statuses: write`) puede
publicar «VanGUARD». Da escritura solo a quien la necesita y mira el autor del estado en el cuadro de merge.

---

## 10. Reparto

Todo §10 vale solo si **D3 = (a)**. Con D3 = (b) la función no se construye esta noche y el BACK y el FRONT recuperan
las horas de abajo.

### 10.0 Horas de la noche y horario (sáb 24 → dom 25, hora de Caracas)

**Las cuentas no cuadraban** (§15 #1): la versión anterior ponía B3 + B4 (2 h 40) entre las 21:00 y las 22:30, y B1–B4
sumaban 4 h 05 para una franja de 3 h 15. Sumando las tres funciones con las cifras de hoy de cada documento:

| Sesión | (1) Evolución | (2) Bloqueo de merge | (3) Bajo ataque | Total P0 |
|---|---|---|---|---|
| BACK | ≈ 1 h 45 (`evolucion-entre-revisiones.md` §9.2) | ≈ **4 h 50** (§10.2) | ≈ 4 h 45 (`modo-bajo-ataque.md` §13; 4 h 20 sin su B5) | **≈ 11 h 20** |
| FRONT | ≈ 2 h 30 (§9.3) | ≈ **3 h 00** (§10.3) | ≈ 2 h 25 (§14; 2 h 05 sin su F3) | **≈ 7 h 55** |

Sin contar `varias-codebases.md`, que también pide horas a las dos sesiones. Frente a la versión anterior de este
documento (BACK 4 h 25, FRONT 2 h 30): el recorte que pidió el revisor (lectura de la protección y DLQ a P1) quita
≈ 30 min; las correcciones que añaden trabajo P0 suman ≈ 55 min en el BACK (E54 `override`/`revert` como «Deshacer»,
sondeo negativo, prueba con el estado real, lockfiles fuera del tope, `repo_del_producto`, limpieza de E47) y ≈ 30 min
en el FRONT («Dar por bueno» y simulación).

**O0 · el ORQUESTADOR fija ya el orden y las sesiones.** Un solo BACK no llega: con el orden de `modo-bajo-ataque.md`
§13.1 ((1) → (2) → (3)), (2) iría de 21:30 a 02:20 y (3) acabaría hacia las 07:05, después de la congelación de las
07:00 y sin margen para `varias-codebases.md`. **Recomendado: una segunda sesión de BACK (BACK-2) solo para (2).**
Archivos que comparte con el BACK-1: `rutas/connections.ts` (E9 y E10; el B4 de aquí va antes que el B3 de bajo
ataque, que llega hacia las 00:05), y `rutas/revision.ts`, `revision/pasos.ts`, `jobs.ts` y `rutas/webhooks-github.ts`
con `varias-codebases.md`. Regla: un archivo, una sesión a la vez; quien termina hace commit y push en `main` antes de
que la otra lo toque.

Horario con BACK-2 (empieza en cuanto O1 está en `main`):

| Hora | Qué debe estar | Si no |
|---|---|---|
| 19:45 | O0, O1 (contrato y fixtures en `main`) y O2 (encargos) | El BACK-2 empieza B1 y B2 igual |
| 20:20 | B1: 0016 aplicada y probada | — |
| 21:05 | B2 (core) en `main` con pruebas en verde | — |
| 22:20 | B3 en verde (sin desplegar todavía) | — |
| 23:40 | B4 en verde | — |
| 00:15 | B5 (E54) en verde | Si D3 = (a) y E54 no está, **no se despliega** B3–B4: sin «Deshacer» no se cumple D3 |
| 00:35 | B6: deploy (0016 antes) + O5a (`SECURITY.md`) | — |
| 01:00 | **Corte 1:** B1–B5 en producción. G3–G5 si Gabriel está; si no, dom 08:00 | El BACK-2 sigue hasta el corte 2 |
| Dom 05:00 | **Corte 2:** si B3–B5 no están en producción, no se despliegan; la sección no se pinta (bandera) y la función va a la hoja de ruta | — |
| FRONT | F1–F6 (3 h) en su turno, con fixtures, antes de la congelación de las 07:00. Recorte si falta tiempo: F5 se queda en el aviso de «Quitar» por `provider` (5 min) | Sin E45 con `gate`, la sección no se pinta |
| Dom 08:00–09:00 | G3–G7: token, protección, PR de la demo y ensayo cronometrado (`{t_bloqueo}`) | Plan B de §11 |
| Dom 10:00 | T02-14: al pitch y a `project-description.md` solo si funcionó en el ensayo | Va como hoja de ruta |

Sin BACK-2: el bloque de arriba empieza a las 21:30 (tras (1)), el corte 1 pasa a las 02:30 y el corte 2 sigue a las
05:00; (3) queda sin margen y el ORQUESTADOR decide qué recorta de ella (su §13.1).

### 10.1 ORQUESTADOR

| # | Qué | Archivos | Prioridad | Estimación |
|---|---|---|---|---|
| O0 | Orden entre (1), (2) y (3), y BACK-2 sí o no (§10.0) | — | P0 · ya | 5 min |
| O1 | Contrato §4.2 y fixtures §4.3 (copiar de `…/scratchpad/bloqueo-zod-v2/bloques/` o del documento); `pnpm --filter @vanguard/contracts test` y `typecheck` en verde; commit en `main` | `packages/contracts/src/api.ts`, `fixtures/{ids,revision,index}.ts`, `contracts.test.ts` | P0 · primero | 25 min |
| O2 | Mandar los encargos a BACK (o BACK-2) y FRONT, todo junto, con este documento | — | P0 | 5 min |
| O3 | Regenerar `database.types.ts` tras 0016 | `packages/contracts/src/database.types.ts` | P0 | 10 min |
| O4 | `demo/empujar-revision.mjs --rama <nombre>`: si la rama existe en `origin`, parte de ella (el PR de G6); si no, la crea desde `origin/<rama por defecto>`; empuja a `refs/heads/<nombre>`; `--deshacer` y `--plan-b` funcionan igual en esa rama; imprime `https://github.com/{repo}/compare/{por defecto}...{nombre}?expand=1`. Prueba en `empujar-revision.test.mjs` con `--no-push` | `demo/` | P0 · antes del ensayo | 25 min |
| O5a | `SECURITY.md` §2 y §5 (§7, texto exacto), fusionado con el O3a de bajo ataque, en el MISMO deploy que 0016 | `SECURITY.md` | P0 | 15 min |
| O5b | Tras producción (T02-14): `THREAT_MODEL.md`, `ARQUITECTURA.md`, `PLAN_MAESTRO.md` §15.4 (E53–E54), `demo/guion.md` con `{t_bloqueo}` medido | docs | P1 | 25 min |
| O6 | En `evolucion-entre-revisiones.md`: la B5 pasa a la migración **0018** y su paso de cola a `PasoRevision = 'diff' \| 'aviso' \| 'estado' \| 'foto'` | `evolucion-entre-revisiones.md` | P0 | 5 min |
| — | `wrangler.jsonc`: sin cambios | — | — | — |

### 10.2 BACK (o BACK-2) (≈ 4 h 50 de P0)

Cada paso con Vitest; nada de ejecutables (`pnpm --filter @vanguard/core test`, `pnpm --filter @vanguard/api test`).

| # | Qué | Archivos | Prioridad | Estimación |
|---|---|---|---|---|
| B1 | Consulta del nombre del check (§3) → 0016 + `supabase/tests/bloqueo.sql`; `list_migrations`; aplicar; `rls.sql` en verde | `supabase/migrations/0016_bloqueo_merge.sql`, `supabase/tests/bloqueo.sql` | P0 | 35 min |
| B2 | Core `revision/bloqueo.ts` sin `leerProteccion` (§5) + lockfiles fuera del tope en `diff.ts` (§2.5) + pruebas | `packages/core/src/revision/{bloqueo,diff}.ts`, sus `.test.ts`, `index.ts` | P0 | 45 min |
| B3 | Cola: `'estado'` en `PasoRevision`; `revision/estado.ts` (§2.4); `pasos.ts` (§2.5: `fallar()` solo con el bloqueo encendido, `yaReclamada`); E47 limpia `gate_*` al reabrir (§4.1). **Mismo deploy** | `jobs.ts`, `revision/pasos.ts`, `revision/estado.ts`, `rutas/webhooks-github.ts` | P0 | 1 h 15 |
| B4 | E53 mínimo (§4.1: guardas, `repo_del_producto`, `same_token` con `fingerprintsOfOrg`, sondeo negativo, prueba con el estado real, alta o `rotateConnectionSecret`); E45 con `gate` (`unchecked`); E8, E9 (`meta.branch`) y E10 (filtro `provider 'cloudflare'`) (§2.8) | `rutas/bloqueo.ts`, `rutas/index.ts`, `rutas/revision.ts`, `rutas/connections.ts`, `scans/repo.ts`, `lib/credentials.ts` | P0 | 1 h 20 |
| B5 | E54 `override` y `revert` (§4.1; `republish` → 409 `p1`) | `rutas/bloqueo.ts` | P0 si D3 = (a) | 35 min |
| B6 | Deploy: 0016 ANTES del Worker, con O5a; ensayo con Gabriel (G3–G7); medir `ms` en `gate.publicado` | — | P0 | 20 min |
| B7 | P1, por este orden: lectura de la protección y chip `active`/`needs_protection` (40 min); estado ajeno (40 min); `republish` (15 min); DLQ (15 min); rutas entre comillas en `parsearDiff` (30 min); `pending` en `diff` (20 min); aviso `bloqueo_saltado` (20 min); `edited` con `changes.base` (15 min) | `revision/*`, `rutas/bloqueo.ts`, `scans/repo.ts`, core | P1 | ≈ 3 h 15 |

### 10.3 FRONT (≈ 3 h 00 de P0)

A las 18:45 había cambios sin commitear en `TarjetaRevisionCodigo.tsx` y `lib/fixtures/router.ts` («Generar otro
secreto»; ya en `main` con f92b137). El bloqueo va en su propio archivo (`BloqueoMerge.tsx`) y en la tarjeta solo se
monta.

| # | Qué | Archivos | Prioridad | Estimación |
|---|---|---|---|---|
| F1 | `useGuardarBloqueo` (E53, `gcTime: 0`, `reset()`, invalida `['org', org, 'revision']` y las conexiones); `useAccionBloqueo` (E54); router de fixtures (§6.5) | `lib/mutaciones.ts`, `lib/fixtures/router.ts` | P0 | 25 min |
| F2 | `BloqueoMerge.tsx` (§6.1 sin lo marcado P1, con la simulación de D3) y su montaje; aviso al apagar la revisión | `modulos/codebase/BloqueoMerge.tsx`, `TarjetaRevisionCodigo.tsx` | P0 | 55 min |
| F3 | Chip y detalle por fila (§6.2) y textos (§6.4) | `TarjetaRevisionCodigo.tsx`, `lib/revision.ts` | P0 | 30 min |
| F4 | «Dar por bueno» / «Deshacer» por fila, con simulación (E54) | `TarjetaRevisionCodigo.tsx` | P0 si D3 = (a) | 30 min |
| F5 | Conexiones (§6.3: línea de estados y aviso de «Quitar» por `provider`) y `GUIA_ESTADOS_GITHUB` (con «lo crea el dueño») | `modulos/conexiones/TarjetaConexion.tsx`, `lib/guias.ts` | P0 | 20 min |
| F6 | Pruebas (§10.5) y `lint:seguridad` en verde | `*.test.tsx` | P0 | 20 min |
| F7 | P1: «Comprobar de nuevo» y textos por `protection`; «Publicar de nuevo»; chip `estado_ajeno` | `BloqueoMerge.tsx`, `TarjetaRevisionCodigo.tsx` | P1 | 35 min |

### 10.4 Giovanni y Gabriel

| # | Quién | Qué | Cuándo |
|---|---|---|---|
| G1 | Giovanni | Decidir D1, D2 y **D3** (§14) | Ya |
| G2 | Gabriel | Si D1 = (a): activar GitHub Pro en su cuenta | Antes de G4 |
| G2b | Giovanni | `node demo/empujar-revision.mjs <clon> --deshacer`: quita de `main` la clave que dejó el push de hoy (si sigue ahí, el estado de prueba de G3 saldrá ✗, que es correcto pero confunde en el ensayo) | Antes de G3 |
| G3 | Gabriel (dueño del repo y admin de «Tienda Demo»; **solo él puede crear el token**, §1.3) | En `officialvanguard.com` → Codebase → «Bloquear merges con críticos» → leer la simulación → «Encender» → enlace «Crear token» → Only select repositories: `vanguard-demo-victima` → solo Commit statuses: Read and write → 30 días → pegar → «Guardar y probar». Ver el estado de prueba (`pending` tras G2b) en el último commit de `main` | Tras el deploy (corte 1) o dom 08:00 |
| G4 | Gabriel | Protección de rama de §9 (sin «Require approvals» y sin «Do not allow bypassing») | Igual |
| G5 | Gabriel | Settings → Webhooks → el de VanGUARD → Edit: confirmar «Pull requests» marcado | Igual |
| G6 | Giovanni | Abrir de antemano el PR de la demo, sin script: en GitHub, editar una línea de `README.md` → «Create a new branch for this commit and start a pull request» con el nombre `demo/cobros` → «Create pull request» («Cobro con tarjeta»). Esperar el ✓ de VanGUARD | Antes del ensayo |
| G7 | Giovanni | Ensayo §11 con cronómetro (`{t_bloqueo}`), **con su sesión de GitHub** (colaborador, sin excepción): comprobar que junto a «Merging is blocked» no aparece la opción de fusionar saltándose las reglas. Probar que un push directo suyo a `main` es rechazado. Después: `--deshacer --rama demo/cobros`. El PR no se fusiona nunca | Dom 08:00–09:00 |

**Ojo con la demo de hoy:** con la protección activa, `node demo/empujar-revision.mjs <clon>` (push directo a `main`)
**fallará** para Giovanni, que es colaborador y no admin. El tramo del push pasa a ser el del PR (§11). Si D1 = (b), no
hay protección y el tramo de hoy sigue igual.

### 10.5 Pruebas mínimas

- **B1:** las de §3.
- **B2:**
  - `bloqueantes`: lo `open` bloquea; un `ignored` con la misma huella en el mismo sitio tapa; con otra huella en el
    mismo sitio no tapa; mismo `rule_id` y huella en otro sitio tapa; sin huella en un lado tapa en el mismo sitio;
    umbral `high` incluye `high`; sin duplicados por `dedupe_key`.
  - `estadoCommit`: los casos de §2.3; `diff_grande` y `binario` dan textos distintos y el de `binario` no dice
    «grande»; `hallazgos_truncados` con 0 bloqueantes → `success`; plural y singular; ≤ 140 siempre (con 20 categorías
    distintas); la descripción no contiene `/`, `:` de una ruta ni ningún `resource`; parcial con `parcialBloquea`
    false → `success` «… (revisión incompleta)».
  - `esRepoDelProducto`: los dos repos en cualquier combinación de mayúsculas → true; `gabriel/vanguard-demo-victima`
    → false.
  - `parsearDiff`: un PR con 200 KB añadidos en `pnpm-lock.yaml` y una clave en `src/x.ts` → no `cortado` y la clave se
    encuentra; 200 KB en `src/datos.ts` → `cortado`; un binario fuera de `EXT_BINARIA` y una ruta entre comillas siguen
    dando `cortado`.
- **B3:**
  - Bloqueo apagado: `diff` sin subpeticiones extra y sin `estado` encolado; `fallar()` no encola; un `estado` que llega
    igual hace `ack` sin escribir ninguna columna `gate_*`.
  - **PR con dos pushes y la misma clave:** la segunda revisión tiene `counts.critical = 0` y `gate_blocking = 1`, y
    publica `failure`.
  - `estado`: `dry_run` fuera de producción; `sin_token`; `otro_repo`; 201 → `gate_state`; 401 → conexión `revoked` y
    `gate_last_error 'token'`; 403 → `forbidden`; **422 → solo `gate_error 'limite'` y la config intacta**; 5xx →
    `retry` y después `red`; `failed` → `error`; parcial `binario` → `error` con su texto; el cuerpo lleva `context
    'VanGUARD'` y nunca un `resource`; la URL sale de `meta` de la conexión aunque la fila diga otra cosa; un SHA
    inválido no llama a GitHub.
  - `yaReclamada` reencola `estado` si no se publicó.
  - E47: «Redeliver» de una `failed` con `gate_error` y `gate_override_at` → la fila reabierta tiene todas las `gate_*`
    a null y `gate_findings` vacío.
- **B4:**
  - E53: viewer 403; anónimo 403; sin config 409 `sin_revision`; repo del producto → 409 `repo_del_producto` (con y sin
    token); mismo token que el de lectura → 422 `same_token`; `ghp_…` → 422; `GET …/keys` 200 → 422 `excess_scope`
    sin llamar al POST; repo privado y `GET …/branches` 200 con el token nuevo → 422 `excess_scope`; repo público → ese
    GET no se hace; sondeo 5xx → 503 sin guardar; POST 403 → 422 `provider_rejected` con `statuses:write`; fuera de
    producción con token → 409; prueba sobre un SHA con revisión anterior a 0016 y `max_severity 'critical'` →
    `failure`; sin revisión → `pending`, nunca `success`; alta → conexión GitHub `action` con `meta.branch`; segundo
    token → `rotateConnectionSecret` con el mismo id; nunca registra el token.
  - `rotateConnectionSecret`: sella con el AAD de la misma conexión; 23505 → `conflict`.
  - E45: `gate.state` en `off`, `needs_token`, `unchecked` y `error`; una org con el bloqueo apagado no tiene `gate` en
    ninguna revisión; sin llamadas a GitHub.
  - E8 cuenta solo `read`; E9 con GitHub `action` no llama a `probarGithub` y sondea `meta.branch`; E10 de la lectura
    borra también la de estados; **E10 sobre la conexión de estados no consulta `actions`** (aunque haya un
    `proposed` reciente de «Bloquear IP» en la org).
- **B5:** `override` sobre una revisión limpia → 409 `nada_que_aprobar`; sobre `failure` → escribe `gate_override_*` y
  encola `estado`, que publica `success` «Aprobado a mano…»; `revert` sin override → 409; con override → lo borra y
  vuelve el `failure`; viewer 403; el log no lleva el motivo.
- **FRONT (F6):** el token no queda en almacenamiento ni en el `MutationCache` tras `reset()`; el viewer no ve
  interruptor, campo ni «Dar por bueno»; encender pasa por la simulación; chips de §6.2 con el mapa cerrado (un `error`
  desconocido sale «No se publicó»); sin `config.gate` no se pinta la sección; el aviso al apagar sale con cualquier
  `state` que no sea `off`; el aviso de «Quitar» del token de estados no habla de IPs.
---

## 11. Guion de la demo (pedido f; ≤ 40 s)

Preparado antes (G6): PR «Cobro con tarjeta» abierto desde `demo/cobros` hacia `main`, con el check «VanGUARD» en ✓ y
el botón de merge en verde. Pestaña 1: el PR en GitHub **con la sesión de Giovanni** (colaborador sin excepción: con la
de Gabriel, admin, GitHub ofrece fusionar saltándose las reglas al lado del bloqueo; G7 lo comprueba). Pestaña 2:
Codebase de «Tienda Demo» en VanGUARD.

1. «La IA del equipo acaba de meter una clave de Stripe en este PR.» →
   `node demo/empujar-revision.mjs <clon> --rama demo/cobros` (clave FALSA y distinta cada vez).
2. En `{t_bloqueo}` s, en el PR: ✗ **«VanGUARD — 1 crítico: clave o token en el código. Detalle en VanGUARD»** y
   **«Merging is blocked»**. Llega el WhatsApp de la revisión del PR.
3. Clic en «Details» → abre la revisión en VanGUARD: «PR #N · ✗ Merge bloqueado · 1 crítico».
4. Frase: «Un webhook llega después del push y no puede deshacerlo. Por eso VanGUARD actúa en el PR: GitHub no deja
   fusionar mientras VanGUARD marque ✗.» No decir que no se puede saltar: un admin con excepción, o cualquiera con
   escritura publicando su propio «VanGUARD», puede (§7; T02-14). La GitHub App con la fuente fijada va en la hoja de
   ruta.
5. Si sobra tiempo: `--deshacer --rama demo/cobros` → ✓ y el botón vuelve a verde.

Cada ejecución genera otra clave (otra huella): vuelve a ser nueva y vuelve a avisar, dentro del cupo de 10 avisos por
hora de la org de demo.

Plan B:

- No aparece el ✗ en 15 s y hay fila en VanGUARD: la fila dice por qué (`sin_token`, `forbidden`…). «Redeliver» solo
  ayuda si la revisión quedó `failed` (o `queued` atascada): E47 no reabre una `done`, aunque sea parcial.
- El PR se queda en «Expected» y **no hay fila** en VanGUARD (E47 descartó el evento: límite de 10 entregas de PR por
  minuto o tope de la hora): Recent Deliveries → «Redeliver» del `pull_request` pasado el minuto.
- D1 = (b), sin protección: se enseña el ✗ y la tarjeta dice «Publicando en GitHub». No se dice «bloqueado».
- La protección de push de GitHub bloquea la clave: `--plan-b` (`.env.staging`, dos críticos).

---

## 12. Verificaciones pendientes (antes de depender de ello)

1. `GET …/branches/main` con el PAT de lectura del repo **privado** (P0, para el `head`) y `GET …/rules/branches/main`
   (P1). Hoy probado solo sin token en repos públicos. Lo confirma E53 en el ensayo.
2. Que «VanGUARD» aparezca en el buscador de checks tras el estado de prueba, que tras G2b será `pending`. La doc habla
   de checks «reportados» en la última semana sin decir el estado; se ve en G4. Si no aparece: el ✓ del PR limpio de G6
   lo hace aparecer (G6 antes de G4).
3. Que un push directo de Giovanni a `main` sea rechazado con la protección (G7).
4. Cómo devuelve «Get a branch» un check de «any source» en `checks[].app_id` (`null` o `-1`). Tras G4, un `curl` del
   BACK con el PAT de lectura; se ajusta `leerProteccion` si hace falta.
5. Tope real de `description` (core manda ≤ 140).
6. Que la página del PR refresque el check sin recargar (se ve en G7; si no, recargar en el guion).
7. Estado en el SHA de un PR de un fork (no hace falta para la demo). Si da 422, ahora solo marca esa revisión.
8. Sondeo negativo: que `GET /repos/{repo}/keys` dé 200 con un token que tenga Administration: read y no 200 (403 o
   404) con el de solo estados, en el repo privado de la demo. La tabla oficial lo pone en «Administration» (comprobado
   hoy). En G3 el token de solo estados debe pasar el sondeo.
9. Que la prueba de E53 en `pending` no deje un aviso raro en el último commit de `main` (solo se ve en la lista de
   checks de ese commit; no afecta a los PR).

---

## 13. Fuera de este encargo

- **GitHub App + Checks API (P2, hoja de ruta en el pitch):** fuente fijada en la protección (cierra el estado falso de
  §7), anotaciones por línea,
  sin PAT que caduque, y la app podría crear el webhook. Exige registrar la app y guardar su clave privada.
- Configurar la protección de rama por API: exigiría Administration: write.
- Revertir commits o cerrar PR.
- Cambiar el texto del WhatsApp o la plantilla enviada a Meta; `notify/kapso.ts` y el despachador.
- Funciones (1) y (3) del pedido.

---

## 14. Decisiones abiertas para Giovanni

**D1. Plan de GitHub del repo de la demo.** `vanguard-demo-victima` es privado y está en la cuenta personal de Gabriel.
Proteger ramas en un repo privado exige GitHub Pro (o Team, en una organización).

- (a) **Recomendado:** Gabriel activa Pro (unos US$4 al mes; gratis con el GitHub Student Developer Pack si es
  estudiante; precio y oferta sin verificar hoy). La demo completa sale sin tocar el repo ni la conexión.
- (b) Sin protección: la demo enseña el ✗ y la tarjeta dice «Publicando en GitHub». No se dice «bloqueado» (T02-14),
  y el tramo del push directo de hoy sigue igual.

Un repo público nuevo no conviene: GitHub y Supabase escanean los repos públicos y la org solo admite un repo (E8).

**D2. Qué publica VanGUARD cuando no pudo leer entero el cambio.** Las causas reales salen de `pasos.ts` (`motivoCorte`,
`:165-168`) y quedan en `code_reviews.error_code`:

- `diff_grande`: diff de más de 1 MB, demasiados archivos o más de 128 KB de texto añadido. Con el cambio de §2.5, los
  lockfiles ya no cuentan para los 128 KB: un PR de dependencias normal deja de quedar parcial.
- `binario`: un binario que no es multimedia (`xlsx`, `docx`, `psd`, `heic`, `bun.lockb`… no están en `EXT_BINARIA`) o
  una ruta que git pone entre comillas (acentos o caracteres especiales, p. ej. `docs/Guía.md`).
- `hallazgos_truncados` ya no cuenta como incompleta: el cambio se leyó entero y `blocking` incluye lo recortado.

Opciones:

- (a) **Recomendado:** falla cerrado, `error` con un texto por motivo (§2.3). Salida: un push que quite la causa, «Dar
  por bueno» desde VanGUARD (E54, P0 con D3 = a) o el bypass de un admin. **«Redeliver» no sirve**: E47 solo reabre
  revisiones `failed`; y un push nuevo revisa otra vez el PR entero (`base...head`), con la misma causa. En un repo en
  español, los archivos con acentos harán que esto pase a menudo hasta que entre la lectura de rutas entre comillas
  (P1, §2.10).
- (b) Falla abierto: `success` con «Sin críticos en lo revisado (revisión incompleta)». Menos fricción y un hueco que
  la demo enseña sola: basta con poner la clave en un archivo con un acento en el nombre, o en un `.ts` con un byte NUL,
  para que salga ✓. `diff.ts:100` marca esos casos como cortados justo para que no escondan una clave.

Se cambia en una línea (`PARCIAL_BLOQUEA` en core). Una revisión `failed` publica `error` en los dos casos.

**D3. ¿Se acepta que VanGUARD escriba solo en el GitHub del cliente, sin un clic por cada estado?** (nueva; §15 #2)

El paso `estado` publica desde la cola en cada revisión de PR y de push a la rama vigilada, sin confirmación por
acción. Hoy `SECURITY.md` dice que la única escritura es «Bloquear IP», con confirmación humana por acción (`:36`,
`:165`), y el principio del producto pide confirmación explícita, simulación previa, TTL y «Deshacer» en toda escritura.

- (a) **Recomendado: sí, como consentimiento permanente y acotado.**
  - Confirmación: dos actos explícitos, uno en cada sistema. El admin lee la simulación y pulsa «Encender» y «Guardar y
    probar» en VanGUARD. El dueño del repo crea un token que solo puede publicar estados y marca él mismo el check como
    obligatorio en GitHub; sin ese paso, el ✗ solo avisa.
  - Simulación antes de encender (§6.1): qué se publica, cuándo y qué efecto tiene con y sin la protección de rama.
  - TTL: la caducidad del token (30 días en la URL prellenada). Al caducar, GitHub responde 401, VanGUARD deja de
    publicar y la tarjeta pide otro token. El interruptor lo apaga al momento.
  - Deshacer: por commit, «Dar por bueno» y su «Deshacer» (E54 `override`/`revert`, que pasan a **P0**: BACK +35 min,
    FRONT +30 min, ya en §10); global, apagar el bloqueo y quitar el check en GitHub.
  - `SECURITY.md` §2 y §5 se corrigen en el MISMO deploy que 0016 (O5a, P0), no después.
- (b) No: la función (2) no se construye esta noche y va a la hoja de ruta. El WhatsApp de cada revisión sigue igual.
  El BACK recupera ≈ 4 h 50 y el FRONT ≈ 3 h.

---

## 15. Correcciones del revisor (sáb 24-oct, ~19:20)

### 15.1 Integradas (cada una comprobada contra el código o la documentación)

| # | Corrección | Comprobación | Dónde quedó |
|---|---|---|---|
| 1 | El horario no cuadraba y chocaba con (1) y (3) | B1–B4 = 35 + 50 + 80 + 80 = 4 h 05 para una franja de 3 h 15 (19:15–22:30). Cifras de hoy de los otros documentos: evolución §9.2–9.3 (1 h 45 / 2 h 30), bajo ataque §13–14 (4 h 45 / 2 h 25; el revisor usó 3 h 55 / 2 h 10, que eran anteriores). Total: BACK ≈ 11 h 20, FRONT ≈ 7 h 55 | §10.0 (tabla de la noche, O0, BACK-2 recomendado, cortes a la hora que sale de sumar), lectura de la protección y DLQ a P1 (§2.9, §2.10), §10.2–10.3 recalculados |
| 2 | Escritura automática sin decisión de Giovanni; `SECURITY.md` quedaba falso | `SECURITY.md:36`, `:165`, `:169-170`; check de `0003_connections_crypto.sql:19` («solo Cloudflare tiene token de acciones») | D3 (§14), §0, §7 (fila y texto exacto para `SECURITY.md`), simulación en §6.1, E54 `override`/`revert` a P0, O5a P0 |
| 3 | Con D2 (a), un parcial bloqueaba para siempre y el texto mentía | `diff.ts:95` (ruta entre comillas → corta), `:101` (binario fuera de `EXT_BINARIA`), `:114` (el tope cuenta lockfiles) y `:162` (`esLockfile` solo después); `pasos.ts:41` y `:165-168` (`binario` agrupa binario y ruta citada); `secrets/scan.ts:38` (sin `xlsx`, `docx`, `psd`, `heic`; `bun.lockb` no acaba en `.lock`); `webhooks-github.ts:168` (solo reabre `failed` o `queued` atascada) | Opción (a) con salida en P0 (E54), texto por motivo (§2.3), lockfiles fuera del tope (§2.5, core), `hallazgos_truncados` no bloquea, §2.6, §11 y D2 corregidos («Redeliver» solo arregla `failed`). La opción (b) del revisor, ver §15.2 |
| 4 | Cualquiera con escritura puede publicar `VanGUARD ✓` | Doc «About protected branches» (hoy): «Any person or integration with write permissions to a repository can set the state of any status check in the repository». Doc «Managing GitHub Actions settings» (hoy): «Anyone with write access to a repository can modify the permissions granted to the `GITHUB_TOKEN`» | Detección de P2 a P1 (§2.10), §0, §2.4, §2.6, §7, §9, §11 (frase del pitch), §13 |
| 5 | E10 no está limitado a Cloudflare | `connections.ts:238` (`if (fila.kind === 'action')`), `:245-251` (`proposed` de toda la org → 409 `block_in_progress`); `TarjetaConexion.tsx:106` (aviso por `kind`); `modo-bajo-ataque.md` §E10 reescribe el bloque | §2.8 (filtro `provider 'cloudflare'` en el B4 de aquí), §6.3, prueba en §10.5 B4 |
| 6 | 0016 choca con la B5 de evolución | `evolucion-entre-revisiones.md:993` (B5: `push_snapshots` en 0016, paso `foto`) | §0, §3 (0018 para evolución), §2.4 (`PasoRevision` con `foto`), O6 |
| 7 | `fallar()` metía ruido en orgs sin bloqueo | Coherencia interna: §2.5 encolaba siempre, el paso 3 escribía `gate_error 'apagado'` y E45 adjunta `gate` con cualquier `gate_*` no null | §2.4 paso 3 (`ack` sin escribir), §2.5 (`fallar()` solo con `gate_enabled`), §6.4 sin `apagado`, §8, pruebas B3 |
| 8 | El ✓ de prueba podía caer sobre un commit con un crítico | `demo/empujar-revision.mjs:2-3` y `:133` (empuja a la rama por defecto); `0013:63-64` (`counts`, `max_severity`); en los fixtures, `HEAD` es justo el push con la clave | §4.1 E53 paso 6 (estado real; si no se sabe, `pending`), `probe_state` en el contrato, fixture `mergeGateSaved` con `failure`, G2b `--deshacer` |
| 9 | E47 no limpiaba `gate_*` al reabrir | `webhooks-github.ts:171-173` (el `update` solo toca `status`, `error_code`, `started_at`, `finished_at`, `partial`, `delivery_id`, `created_at`) | §4.1 E47 (todas las `gate_*`, también `gate_override_*`: un «Redeliver» pide otra revisión), §3, prueba B3 |
| 10 | Un 422 de un commit ponía todo el bloqueo en error | Coherencia con §12 verificación 7 (SHA de un PR de fork sin comprobar) | §2.4 (422 solo en la revisión), `MergeGateError` sin `limite`, check de 0016, §6.1 |
| 11 | E9 no tenía la rama | `scans/repo.ts:53` (`default_branch` solo en la meta de la conexión de lectura) | `meta.branch` en la conexión de estados (§2.8), E9 la usa |
| 12 | Faltaba el helper de rotación en `credentials.ts` | `credentials.ts:6` («ÚNICO módulo que toca connection_secrets»), `:81` (`fingerprintsOfOrg`); `vg_rotate_secret` en `0003:73-84`; unique `(org_id, fingerprint)` → 23505 | `rotateConnectionSecret` (§2.8), §5, E53 pasos 3 y 7, prueba B4 |
| 13 | Solo el dueño puede crear el token | Doc «Managing your personal access tokens» (hoy): los fine-grained no admiten «contributing to repositories where the user is an outside collaborator or a repository collaborator»; un solo dueño de recursos | §1.3, §0, §6.1 Paso 1, §7, §9, G3 |
| 14 | PR en «Expected» sin fila en VanGUARD | `webhooks-github.ts:309-313` (cubo `ghpr`), `wrangler.jsonc:60` (`RL_COSTLY` 10 cada 60 s), `:245-253` (`topeFork` cuenta todas las de PR), `:38` (`ACCIONES_PR` sin `edited`) | §2.6 (texto del tope corregido y fila nueva), §6.1 (ayuda fija), §11 Plan B, P1 `edited` (§2.10) |
| 15 | Sin sondeo negativo para un token que usa la cola | `connections.ts:60-74` (`errorSobra` en Supabase); tabla oficial de permisos (hoy): `branches/{branch}` en Contents, `keys` y `branches/{branch}/protection` en Administration | §4.1 E53 paso 5, §1.3, §7, verificación 8 de §12, pruebas B4 (con cambios, §15.2) |
| 16 | La demo con una cuenta con bypass resta fuerza | Doc «About protected branches» (hoy): «By default, the restrictions of a branch protection rule don't apply to people with admin permissions» | §9 paso 7, §11 (pestaña 1 con Giovanni), G7 |
| 17 | Nada impedía activarlo en el repo del propio VanGUARD | `git remote -v` (push a `platanus-hack/platanus-hack-26-ve-team-22` y a `Giova144-git/VanGUARD`); memoria del proyecto: trabajo directo en `main` y Workers Builds desde el espejo | `esRepoDelProducto` en core, E53 409 `repo_del_producto`, §0, §7, §9 |

### 15.2 Correcciones descartadas (o aplicadas de otra forma)

- **#3, opción (b): «`success` con aviso si la causa es binario o ruta citada»**: no se aplica. Reabre el hueco que
  `diff.ts:100` cierra a propósito («Un binario que no es multimedia no se escanea: así un `.ts` con un NUL no esconde
  una clave»): una clave en `src/cobros_ñ.ts`, o en un `.ts` con un byte NUL, saldría con ✓. Se queda la opción (a) con
  salida en P0 (E54), y se quita la causa más tonta (lockfiles) en core.
- **#8, «si no existe revisión, publicar con la descripción “Prueba de conexión: este commit no se revisó”»**: se
  aplica con `pending`, no con `success`. Un ✓ con una aclaración sigue siendo verde en la lista de checks del commit.
- **#15, «`GET branches/{branch}/protection` como sondeo de Administration»**: se cambia por `GET /repos/{repo}/keys`
  (también Administration: read en la tabla oficial). `…/protection` responde 404 «Branch not protected» en una rama
  sin proteger aunque el token tenga el permiso, y en E53 la rama aún no suele estar protegida (§9 pide «Guardar y
  probar» antes). El sondeo de Contents solo se hace en repos privados: en uno público responde 200 con cualquier token.
- **#5, «en el mismo commit que el B3 de bajo ataque»**: el filtro va en el B4 de esta función, que por
  `modo-bajo-ataque.md` §13.1 sale antes. Si esperase al B3 de bajo ataque, el 409 sin sentido estaría en producción
  entre los dos deploys. El B3 de bajo ataque debe conservar el filtro al reescribir el bloque.
- **#1, «recortar el P0 a B1; B2 sin `leerProteccion`; B3; E53 mínimo; E8, E9 y E10»**: se recorta así, salvo dos
  cosas. E45 con `gate` sigue en P0: sin él la sección no se pinta (bandera de §6.1) y nadie podría encenderlo. E54
  `override`/`revert` entra en P0 por #2 y #3. Por eso el P0 del BACK sube de 4 h 25 a 4 h 50 en vez de bajar; lo que
  hace que la noche quepa es BACK-2 (§10.0), no el recorte.
- **#4, «comparar con el `creator.id` guardado del POST de prueba de E53»**: se compara con el `creator.id` de la
  respuesta del POST del mismo `estado` (mismo token, nada que guardar), y se repite a los 120 s: un ✓ falso llega
  normalmente después del nuestro y una sola lectura justo tras el 201 casi nunca lo vería.

### 15.3 Notas para el ORQUESTADOR (fuera de las correcciones)

- **Ids de fixture:** la versión anterior chocaba con otros documentos (`…000000000006` con `CONN_GITHUB_2` de
  `varias-codebases.md`; `c4000000-…-000000000013` con `CR_REV_JUEVES` de evolución, que ya avisó
  `modo-bajo-ataque.md` §19). Tras la reconciliación del contrato, `…000000000006` y `…000000000022` (§4.3): `…0007` y
  `…021` los tomaron `CONN_GITHUB_2` y `CR_REV_JUEVES` (`RECONCILIACION-CONTRATO.md`).
- **`varias-codebases.md`** permite varios repos de GitHub por org. Aquí hay un solo token de estados por org (índice
  único de 0016), atado a un repo: con varios repos el bloqueo solo vale para el del token, y `estado` lo protege con
  `otro_repo` (§2.4 paso 6). Si esa función entra, P1: un token de estados por config y E53 por id de config. Las dos
  tocan E8 (el conteo de «Ya hay un repo conectado»), E45 (`rutas/revision.ts`), `revision/pasos.ts`, `jobs.ts` y
  `rutas/webhooks-github.ts`: en serie, nunca a la vez.
- **`SECURITY.md`:** O5a de aquí y O3a de bajo ataque cambian las mismas líneas (§2 y §5): un solo cambio con las dos
  (o tres) escrituras.
- **Contrato:** §4.2 y §4.3 compilan solos sobre el `api.ts` de hoy (`f92b137`). No comparten nombres con los bloques
  de evolución ni de bajo ataque.
