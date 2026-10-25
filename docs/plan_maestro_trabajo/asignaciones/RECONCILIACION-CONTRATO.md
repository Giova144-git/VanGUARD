> **Renumeración tras el MCP de Gabriel (fe26f3d, sáb ~20:30):** `0014_mcp_tokens.sql` ocupa el 0014. Evolución pasa a **0015**, bloqueo a **0016** y bajo ataque a **0017**; la columna `muted_until` del botón «Silenciar repo 1 h» va dentro de la **0016** del bloqueo. Los números de abajo ya están corregidos. Anexos que manda el ORQUESTADOR sobre lo de abajo: `bloqueo-merge-cierre-pr.md` y `avisos-whatsapp-botones.md` (campos ya añadidos al contrato).

# Reconciliación del contrato: las cuatro funciones de la noche en `packages/contracts`

Sáb 24-oct, ~20:05 (Caracas). Integrador del CONTRATO. Base: `main` en `f92b137`. `packages/contracts` no había cambiado
desde `03c871d`.

Funciones: (1) `evolucion-entre-revisiones.md`, (2) `bloqueo-merge-criticos.md`, (3) `modo-bajo-ataque.md` y
`varias-codebases.md`. Todo está aplicado en el árbol de trabajo, **sin commit**.

**Cómo se hizo.** Se trabajó en una copia (`scratchpad/contrato-4`). Se fusionó a tres vías (`git merge-file`) cada
copia ya aplicada y comprobada de cada función contra `main`, en este orden: varias-codebases (`varias-codebases-zod`),
bloqueo (`bloqueo-zod-v2`), evolución (`evol3`) y bajo ataque (`verif-bajo-ataque-*`, el resultado de su `aplicar.mjs`).
Los conflictos se resolvieron a mano. Después se comprobó línea por línea que cada línea añadida por cada función está
tal cual en el resultado. Solo difieren las 7 líneas que se cambiaron a propósito (§2). Al final se copiaron los
archivos al repo.

## 1. Lo añadido, por función

| Función | `api.ts` | Fixtures (`fixtures/`) | Claves nuevas de `fixtures` | Pruebas |
|---|---|---|---|---|
| varias-codebases | `MAX_REPOS_GITHUB` (5), `ScanRepo`, `CodeReviewQuery` (E45 `?connection_id=`). Campos opcionales: `ScanRun.repos` y `AhoraItem.connection_id` | `ids.ts`: `CONN_GITHUB_2`, `REPO_2`, `T_CONEXION_REPO_2`. `conexiones.ts`: `conexionGithub2`. `auditoria.ts`: `scanDoneDosRepos`. `revision.ts`: `codeReviewStateRepo2` | `conexionGithub2`, `scanDoneDosRepos`, `codeReviewStateRepo2` | 3 casos |
| bloqueo de merge | `GATE_CONTEXT`, `MergeGateMin`, `CommitStatusState`, `MergeGateProtection`, `MergeGateState`, `MergeGateError`, `MergeGateConnection`, `MergeGateConfig`, `MergeGateReview`, `MergeGatePut`, `MergeGateSaved`, `MergeGateAction`. Campos opcionales: `CodeReviewConfig.gate` y `CodeReview.gate` | `ids.ts`: `CONN_GITHUB_ESTADOS`, `CR_REV_PR_BLOQUEADO`, `T_GATE_GUARDADO`, `T_CR_PR`. `revision.ts`: `codeReviewStateBloqueo`, `mergeGateSaved` (y las constantes locales `HEAD_PR`, `gate` y `bloqueante`) | `codeReviewStateBloqueo`, `mergeGateSaved` | 2 casos + `describe('bloqueo de merge')` (8) |
| evolución | `CodeReviewDelta`, `PorSeveridad`, `MatrizHallazgos`, `DeltaItem`, `DeltaLista`, `DeltaAnterior`, `AuditDelta` (E51), `EvolutionPoint`, `EvolutionReview`, `EvolutionIncidentDay`, `EvolutionTotals`, `Evolution` (E52). Campo opcional: `CodeReview.delta` | `ids.ts`: `SCAN_EV_MAR/MIE/JUE/VIE`, `CR_REV_JUEVES`, `F_SB_INDICE`, `F_CB_GENERICO` y las horas `T_EV_*`, `T_CR_JUEVES`, `T_SNAP_*`. Nuevo: `evolucion.ts` | `auditDelta`, `evolution`, `hallazgosCorregidos`, `deltasRevision` | 4 casos + `describe('evolución')` (9) |
| bajo ataque | `UnderAttackScope`, `UnderAttackMotivo`, `UnderAttackActivo`, `UnderAttackOffer` (E55), `UnderAttackPropose`, `UnderAttackProposal` (E56). La constante local `HostOZona` | `ids.ts`: `APPROVAL_BAJO_ATAQUE`, `ACTION_BAJO_ATAQUE` (tras `APPROVAL_BLOQUEO`). Nuevo: `bajo-ataque.ts` | `underAttackOffer`, `underAttackOfferUnaIp`, `underAttackOfferSinPermiso`, `underAttackProposal` | 4 casos + `describe('modo bajo ataque')` (4) |
| integración (nuevo) | — | — | — | `describe('convivencia de las funciones nuevas')` (2): ningún id de `ids.ts` se repite; una revisión con `gate` y `delta` a la vez, y `codeReviewStateBloqueo` con la foto de cada push, cumplen E45; `CodeReviewQuery` acepta `{}` |

No cambian `comun.ts`, `index.ts` del paquete (ya hace `export * from './api.ts'`) ni `database.types.ts`. Tampoco
cambian `ScanStep`, `Finding`, `CodeReviewPut`, `ProposeResponse`, `ActionKind` ni `connections`. En total son 13
claves nuevas en `fixtures` y en `CLAVES_ESPERADAS`. Las pruebas pasan de 47 a 83.

## 2. Choques y cómo se resolvieron

### 2.1 Ids de fixture repetidos (los dos eran de (2))

Al cambiarse los ids entre sí para esquivar los choques viejos, los tres documentos crearon dos choques nuevos:

| Id | Lo usaban | Resolución |
|---|---|---|
| `c4000000-0000-4000-8000-000000000021` | `CR_REV_JUEVES` (evolución) y `CR_REV_PR_BLOQUEADO` (bloqueo) | `CR_REV_PR_BLOQUEADO` = **`…000000000022`** |
| `c0000000-0000-4000-8000-000000000007` | `CONN_GITHUB_2` (varias) y `CONN_GITHUB_ESTADOS` (bloqueo) | `CONN_GITHUB_ESTADOS` = **`…000000000006`** |

Se cambió solo el bloqueo por tres razones. Los dos hermanos ya daban por hecho que el bloqueo no usaba sus ids
(varias-codebases lo dice tal cual: «`…0006` es `CONN_GITHUB_ESTADOS`»). Además, así se tocan menos documentos. Y los dos
extractores lo propusieron. `…0006` y `…022` no aparecen en `packages`, `apps`, `supabase` ni en los cuatro documentos.
Se descartó `…013`, aunque ya quedaba libre entre los fixtures: `apps/api/src/rutas/revision.test.ts:124` lo usa para
una revisión de prueba.

Nada más usaba estos literales: las pruebas de evolución y de bloqueo comparan por referencia, y el SQL de 0015/0016 no
lleva ids de fixture. Los ids de los fixtures no salen del paquete, así que el FRONT no se entera. Comprobado:

- ningún valor se repite entre las constantes de `fixtures/ids.ts`, y ningún UUID literal se repite en todo `fixtures/`;
- la prueba nueva «ningún id de fixture de ids.ts se repite» falla si se vuelve a poner `…021` en `CR_REV_PR_BLOQUEADO`
  (se probó).

### 2.2 Tipos que tocan dos funciones

- **`CodeReview` (E45)**: le añaden un campo opcional el bloqueo (`gate`) y evolución (`delta`). Quedan los dos, cada
  uno con su comentario, y `delta` cierra el objeto. Es la forma que ya fija evolución en su §4.2 (b) y O1:

  ```ts
    created_at: Ts, finished_at: Ts.nullable(),
    gate: MergeGateReview.optional(), // falta en revisiones de antes de 0016
    delta: CodeReviewDelta.nullable().optional() }); // E45 con 0015; null en un PR, en un push de antes de 0015 o sin foto
  ```

  Las dos declaraciones nuevas quedan entre `CodeReviewAlert` y `CodeReview`, en este orden: `MergeGateReview` y luego
  `CodeReviewDelta`, que así sigue «justo antes» de `CodeReview`, como pide evolución.
- **`CodeReviewConfig`**: solo la toca el bloqueo (`gate: MergeGateConfig.optional()`).
- **`CodeReviewState`**: su esquema no lo edita nadie. Hereda los dos campos opcionales de `CodeReview` y el de
  `CodeReviewConfig`. `CodeReviewQuery` (varias) es un esquema aparte, declarado justo después de `CodeReviewState`, y no
  cambia la respuesta.
- **Convivencia en la tarjeta (E45)**: todo es opcional. Un BACK de antes de 0015/0016, o una pestaña de un repo sin
  bloqueo (varias §2.6.4), sigue cumpliendo el contrato. El FRONT de hoy compila y sus 960 pruebas pasan.
- **`ScanRun`** y **`AhoraItem`**: solo los toca varias-codebases.

### 2.3 Nombres

No se repite ningún nombre exportado entre funciones: `tsc` pasa y el `export *` de `index.ts` no da ninguna
ambigüedad. Las constantes locales (`gate`, `bloqueante` y `HEAD_PR` en `revision.ts`; `HostOZona` en `api.ts`) tampoco
chocan.

### 2.4 Choques de texto (misma zona del archivo)

- `fixtures/index.ts`:
  - los imports quedan por orden de archivo (`auditoria`, `bajo-ataque`, `conexiones`, `evolucion`…);
  - los tres imports de `./revision.ts` (main, varias y bloqueo) se juntan en uno de varias líneas;
  - las claves del objeto van en el orden varias, bloqueo, evolución y bajo ataque.
- `contracts.test.ts`:
  - `CLAVES_ESPERADAS` y `casos`, en el mismo orden (los 4 casos de bajo ataque van tras `['me', …]`, como en su
    documento);
  - `describe('bloqueo de merge')` y `describe('evolución')` van antes de `describe('fixtures')`;
  - `describe('modo bajo ataque')` y el nuevo de convivencia, al final.
- `fixtures/ids.ts`, `fixtures/revision.ts` y el final de `api.ts`: los bloques que se añaden al final van uno tras otro
  (varias, bloqueo, evolución, bajo ataque), con una línea en blanco entre ellos.
- Se cambió un comentario de evolución en `ids.ts` para que siga siendo cierto: «CR_REV_JUEVES no es …022: ese id es
  CR_REV_PR_BLOQUEADO».

## 3. Cambios en las especificaciones

| Documento | Cambio |
|---|---|
| `bloqueo-merge-criticos.md` | §4.3: los ids pasan a `…0006` y `…022`, en el párrafo y en el bloque de `ids.ts`. §15.3: la nota de ids, igual. §4.2 (d): una frase que dice cómo queda la última línea de `CodeReview` con evolución aplicada |
| `evolucion-entre-revisiones.md` | §4.4: el texto y el comentario del bloque de `ids.ts` dicen `…022` (antes `…013`). Nota del final de §13: `CR_REV_PR_BLOQUEADO` quedó en `…022` |
| `modo-bajo-ataque.md` | §19, nota para el ORQUESTADOR: el choque de `…013` está resuelto (`CR_REV_JUEVES` = `…021`, `CR_REV_PR_BLOQUEADO` = `…022`) |
| `varias-codebases.md` | Sin cambios: ya decía que `…0006` es `CONN_GITHUB_ESTADOS` |

Los bloques de `ids.ts` de bloqueo, evolución y varias que están en los documentos aparecen tal cual en el contrato
(comprobado).

## 4. Verificación

| Qué | Resultado |
|---|---|
| `@vanguard/contracts`: `tsc --noEmit -p .` | OK |
| `@vanguard/contracts`: `vitest run` | 83/83 |
| `@vanguard/api`: `tsc --noEmit -p .` | OK |
| `@vanguard/web`: `tsc --noEmit -p .` | OK |
| `@vanguard/api` / `@vanguard/web`: `vitest run` (extra) | 983/983 y 960/960 |
| `scripts/lint-imports.mjs` y `apps/web/scripts/lint-seguridad.mjs` | OK |
| `varias.test.ts` del scratchpad de varias (7 comprobaciones; no se copia al repo) | 7/7 sobre el contrato reconciliado |

En el momento de la prueba no había trabajo sin commit en `apps/`: ningún fallo quedó sin explicar.

## 5. Orden recomendado de implementación

Lo fijan los archivos de `apps/` que tocan varias funciones. Regla: un archivo, una sesión a la vez; quien termina hace
commit y push antes de que otro lo toque.

1. **Contrato**: este. Desbloquea al FRONT de las cuatro.
2. **BACK, revisión de código** (`rutas/revision.ts` E45, `revision/pasos.ts`, `jobs.ts`, `rutas/webhooks-github.ts`):
   1. **evolución, tramo A** (0015, las dos fotos, `delta` en `COLUMNAS_REVISION`). Va primero: es una columna más y
      una llamada de mejor esfuerzo, y el historial solo empieza cuando está en producción (evolución §9.0);
   2. **varias-codebases** (`conexionGithub` por conexión, `?connection_id=` en E45, cola por repo);
   3. **bloqueo** (0016, cálculo de `gate`, paso `estado`, E53/E54), ya con las reglas de varias §2.6: `config.gate` solo
      en el repo del token de estados, `otro_repo` y E10 por `repo_id`. Hacer el bloqueo antes que varias obligaría a
      rehacer E45, E53 y el paso `estado` para varios repos. En `revisar()` la foto de evolución va primero, antes de
      encolar el aviso y el paso `estado` (evolución §4.1).
3. **BACK, conexiones** (`rutas/connections.ts` E8/E9/E10): **varias** (tope de repos, `kind 'read'`) → **bloqueo B4**
   (GitHub `kind 'action'`, aplicando varias §2.6 a E8/E10) → **bajo ataque B3** (despacho por `kind` en E21/E22/E10).
   Bajo ataque va el último en el BACK, como dice su §13.1.
4. **Migraciones**: 0015 (evolución) → 0016 (bloqueo) → 0017 (bajo ataque). Varias no lleva ninguna y 0018 queda
   libre. Después de cada una el BACK regenera `database.types.ts` (no se hizo aquí).
5. **FRONT, tarjeta de revisión** (`TarjetaRevisionCodigo.tsx`, `useRevisionCodigo`, `lib/fixtures/router.ts`):
   **varias** (pestañas por repo, `key` y `connectionId`) → **bloqueo** (§6.2: bandera solo si `config.gate` existe, y
   fila con el estado y «Dar por bueno») → **evolución F3** (una línea con `delta` debajo de lo que haya). En el router
   de fixtures: `githubDe` por conexión (varias) → `codeReviewStateBloqueo` para la org de demo (bloqueo) → inyectar
   `deltasRevision` en cada revisión, también en `codeReviewStateBloqueo`, y añadir `hallazgosCorregidos` a la lista de
   la org (evolución).
6. **Independientes, en paralelo**: la página y las gráficas de evolución (E51/E52), y la tarjeta de bajo ataque con
   sus rutas E55/E56 en el router de fixtures.

## 6. Fuera de este encargo / pendiente

- **`bloqueo-merge-cierre-pr.md`** apareció a las 19:58. Es el anexo «VanGUARD cierra el PR con críticos» y dice que el
  contrato lo pone el ORQUESTADOR tras esta reconciliación. Pide, aditivo y opcional:
  - `close_pr` y `can_close_pr` en `MergeGateConfig`;
  - `pr_action` y `pr_close_error` en la revisión;
  - `close_pr?` en `MergeGatePut`;
  - la acción «Reabrir el PR» en `MergeGateAction`.

  **No está aplicado.**
- `database.types.ts`: lo regenera el BACK tras aplicar 0015, 0016 y 0017.
- El SQL de evolución (`0015_evolucion.sql` y `supabase/tests/evolucion.sql`, en `scratchpad/evol3/sql`) es trabajo del
  BACK.
- Sin commit, como se pidió. Archivos del contrato tocados:
  - en `packages/contracts/src/`: `api.ts` y `contracts.test.ts`;
  - en `packages/contracts/src/fixtures/`: `ids.ts`, `index.ts`, `revision.ts`, `conexiones.ts` y `auditoria.ts`;
  - nuevos: `fixtures/evolucion.ts` y `fixtures/bajo-ataque.ts`.

## 7. Revisión adversarial (sáb 24-oct, ~20:20)

Se revisó el contrato reconciliado contra las cuatro especificaciones. Sin commit, como el resto.

**Qué se comprobó, sin fallos:**

- Cada línea de los bloques ```ts de las secciones de contrato de los cuatro documentos (varias §5, bloqueo §4.2–4.3,
  evolución §4.2–4.5, bajo ataque §6) está tal cual en `packages/contracts`. La única excepción es la línea de `gate` en
  `CodeReview`, que es el cambio a propósito de §2.2. Al revés, todo lo añadido sale de un documento, salvo los cambios
  de §2 y la prueba de convivencia.
- Cada fixture nuevo pasa su esquema, y al parsearlo zod no quita ni cambia ninguna clave. La evidencia de
  `hallazgosCorregidos` (Codebase) cumple `CodebaseEvidence`.
- Ningún UUID literal se repite en `fixtures/`. Los ids nuevos no se usan en `apps/`, `packages/` ni `supabase/`.
  `5a1c…002` aparece en `apps/api/src/scans/zip-paso.test.ts`, pero como constante local que no toca fixtures.
- Cable trampa: ningún valor de `fixtures` (JSON) ni ninguna línea de `fixtures/*.ts`, `api.ts` o `contracts.test.ts`
  casa con `PARECE_SECRETO` (`scans/comun.ts`) ni con `scanArchivo` de `core/secrets`.
- Todo es aditivo (campos opcionales y exportaciones nuevas). Siguen en verde `tsc` de api y web, `lint-imports` y
  `lint-seguridad`. Los nombres nuevos no chocan en el `export *` de `index.ts`. Ningún código de `apps/api` (fuera de
  las pruebas) importa `fixtures`.
- E45 entre varias y bloqueo: las formas son compatibles. `CodeReviewQuery` va aparte, `gate` y `delta` son opcionales
  y `codeReviewStateRepo2` (sin config) no trae `gate`. `MergeGateSaved` no lleva `connection_id`: el FRONT lo toma de
  la pestaña, que es la única con `config.gate`.

**Arreglado:**

1. **E45 `config.gate`, bloqueo contra varias.** Bloqueo §4.1 decía «`config.gate` siempre que haya config»; varias
   §2.6 (punto 4) lo limita al repo del bloqueo. Un BACK que siguiera solo el bloqueo ofrecería activar el bloqueo en
   pestañas donde E53 no lo aplicaría. Se corrigió bloqueo §4.1 (E45). También el comentario de `CodeReviewConfig.gate`
   en `api.ts` y su copia en bloqueo §4.2 (b), que ahora dice «falta en un BACK de antes y en los repos sin bloqueo
   (varias §2.6)». Solo cambian comentarios: el esquema es el mismo.
2. **Prueba de convivencia.** «una revisión lleva gate y delta a la vez» ponía `delta` a un PR, un estado que E45 nunca
   da (en un PR, `delta` es null). Ahora usa el push de la clave con el `gate` del PR (sus `findings`, con
   `finding_id: null`) y su foto, y comprueba que es un `push`.

**Observaciones (no se tocan; las decide quien lleva cada función):**

- Bajo ataque: `underAttackOffer` dice `ips: 2`, pero en `incidentes.ts` solo hay un incidente `CF_IP_FLOOD` abierto
  para ese host; el otro está resuelto y no es de inundación. Con E55 real saldría `una_ip`. Es la decisión del
  documento (§6.2) para ensayar el botón en modo fixtures; no se cita como medida (T02-14).
- Evolución: `evolution.reviews` no trae el PR #7 de `codeReviewStateBloqueo`, que el router sirve en la org de demo.
  En modo fixtures, Evolución no lista ese PR y la tarjeta de Codebase sí. No se acopla a propósito: si el bloqueo se
  corta, la lista mostraría un PR que no sale en ningún otro sitio.
- Varias + evolución: `DeltaItem` no lleva `connection_id`. Con ≥ 2 repos, dos hallazgos con el mismo título y recurso
  se ven iguales en «Cambios desde la auditoría anterior». Va contra el criterio de varias §6.4 (F4a), pero ninguno de
  los dos documentos lo pide. Si se quiere, es un campo opcional en el contrato y en `vg_lista_delta` (0015).

**Aviso para el ORQUESTADOR (aparecido durante la revisión):** a las 20:15, el merge `fe26f3d` (MCP de Gabriel) metió
en `main` `supabase/migrations/0014_mcp_tokens.sql`. El número 0015 era el de evolución (§5, punto 4: 0015 → 0016 →
0017). Antes de que el BACK cree `0015_evolucion.sql`, hay que renumerar: por ejemplo, evolución 0016, bloqueo 0017 y
bajo ataque 0018. Si se hace, cambian los cuatro documentos y los comentarios de `api.ts` que citan 0015 y 0016
(`CodeReviewConfig.gate`, `CodeReviewDelta`, `CodeReview.gate` y `.delta`, `AuditDelta`, `EvolutionPoint`,
`EvolutionReview`). Los comentarios no se tocaron aquí, porque el número lo decide el ORQUESTADOR. Ese merge no toca
`packages/contracts`, y web y api compilan con él (comprobado después de las 20:15).

**Verificación tras los arreglos:**

| Qué | Resultado |
|---|---|
| `@vanguard/contracts`: `tsc --noEmit -p .` | OK |
| `@vanguard/contracts`: `vitest run` | 83/83 |
| `@vanguard/api` y `@vanguard/web`: `tsc --noEmit -p .` | OK |
| `scripts/lint-imports.mjs` y `apps/web/scripts/lint-seguridad.mjs` | OK |
