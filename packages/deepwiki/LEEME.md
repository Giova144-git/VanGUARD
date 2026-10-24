# @vanguard/deepwiki · «Wiki del repo»

Lee un repositorio de GitHub y explica, en español y sin jerga, qué hace el proyecto. Está pensado para un directivo o
un jurado. Entrega un documento general con 5 secciones, un diagrama Mermaid y una página por área del código. Antes
de correr da una **estimación de costo** (y su techo) y guarda el resultado **por commit y por hallazgos**: lo mismo
no se paga dos veces.

VanGUARD lo usa para explicarle al cliente su propio repositorio y para cruzar ese mapa del código con los hallazgos de
seguridad de la auditoría. La sección «Riesgos y puntos de atención» prioriza esos hallazgos en lenguaje llano y dice
qué conviene hacer con cada uno.

El motor es puro: solo usa `fetch`, WebCrypto y `TextEncoder`, y corre igual en el Worker de Cloudflare y en Node. No
importa el SDK de Anthropic. El modelo le llega inyectado como `Deps.llm`.

## Cómo funciona

| Paso | Qué hace | Modelo | Subpeticiones |
|---|---|---|---|
| `arbol` | Metadatos, commit exacto y árbol de archivos; filtros locales (binarios, lockfiles, `.env`, claves…) | ninguno | ≤ 25 |
| `triage` | El modelo rápido elige entre ≤ 400 rutas las que explican el producto (≤ 80); se agrupan en ≤ 12 áreas + «(otros)» | `fast` | 1 |
| `area` (una por área) | Descarga los archivos que caben en el prompt (≤ 25), **redacta secretos**, la resume en 4–6 líneas con un título | `fast` | ≤ 37 |
| `sintesis` | Documento final con los resúmenes y los hallazgos de VanGUARD; valida el Mermaid | `smart` | 1 |

Entre pasos solo viaja `EstadoWiki`, un JSON con rutas, resúmenes, consumo y avisos. **Nunca guarda el código leído.**
Cada paso cabe en una invocación de Workers Free (10 ms de CPU y ≤ 40 subpeticiones). En el paso `area`, lo que sobra
del cupo (40 − descargas − 4 para el modelo) se usa para reintentar una vez los archivos que fallaron por un 5xx o la red.

Modelos por defecto: `fast = claude-haiku-5-5`, `smart = claude-sonnet-5-5`.

## API pública (`import … from '@vanguard/deepwiki'`)

- `pasoArbol(ref, deps) → EstadoWiki`: sin LLM.
- `estimar(estado, deps) → Estimacion`: es el `WikiEstimate` sin `cached_run_id`. No usa red. Su último aviso es el techo.
- `costoMaximoPaso(estado, siguiente, deps) → USD`: lo máximo que puede costar el paso que viene (entrada estimada y
  salida al tope de `max_tokens`). Es lo que se compara con `max_usd` **antes** de llamar al modelo.
- `pasoTriage(estado, deps)`, `pasoArea(estado, nombreArea, deps) → EstadoWiki`: si el paso ya estaba hecho devuelven
  **el mismo objeto** (`nuevo === estado`); eso es un mensaje repetido.
- `marcarSintesis(estado, ahora)` y `sintesisEnCurso(estado, ahora)`: marca de «síntesis pagándose» (ver punto 5).
- `pasoSintesis(estado, deps) → ResultadoWiki`: es el `WikiDoc` sin `run_id`.
- `siguientePaso(estado) → { paso: 'triage' } | { paso: 'area', area } | { paso: 'sintesis' }`.
- `progreso(estado, enCurso?) → 0–100` y `detalleInicio(siguiente, estado)` para `WikiRunStep.detalle`.
- `generarWiki(ref, deps, opciones)` y `completarWiki(estado, deps, opciones)` corren todo seguido (CLI y pruebas).
  `opciones`: `alAvanzar`, `alGuardar(estado)` tras cada paso que cambió algo y `maxUsd`.
- `paginaDeRuta(ruta, paginas) → WikiPagina | null`: la página donde cae un hallazgo (ver «Uso en el FRONT»).
- `huellaHallazgos(hallazgos) → sha-256 hex`: va en la llave de la caché (ver punto 2).
- `documentoMarkdown(doc)`: un único `.md` con el diagrama bajo «Mapa visual», las páginas y las notas de esta versión.
- `AVISOS`: los textos de los avisos (una sola fuente para el motor, sus pruebas y los fixtures del contrato).
- `ErrorWiki` y `ErrorGithub`: los dos traen `codigo`, que sirve para `WikiRunStep.error_code`.
  - Códigos de GitHub: `repo_invalido`, `ref_invalida`, `repo_no_encontrado`, `ref_no_encontrada`, `limite_github`,
    `token_invalido`, `repo_vacio`, `github_error`, `github_red` y `respuesta_invalida`. En `limite_github`,
    `reintentarEnS` trae los segundos que pide GitHub (`retry-after` o `x-ratelimit-reset`, como mucho 3.600).
  - Códigos del pipeline: `estado_invalido`, `sin_llm`, `sin_archivos`, `area_desconocida`, `pasos_pendientes`,
    `sin_resumenes` y `tope_usd`.
- Piezas sueltas: `redactar` y `prepararDato`; `sanearMarkdown`, `sanearSalida` y `validarMermaid`; `leerMeta`,
  `leerArbol`, `leerArchivos` y `leerArchivosDetalle`; los `armar*` y `parsear*` de prompts, `SECCIONES` y
  `MAX_TOKENS_SALIDA`; y `costoDe`, `techoPaso`, `techoDesglose`, `PRECIOS` y `limitesDe`.

`Deps.limites` solo puede **bajar** los topes de `LIMITES_POR_DEFECTO`: 400 candidatos, 150 archivos, 12 áreas, 25 archivos
por área, 60 KB por archivo, 3.000 caracteres por archivo, 24.000 por área y 90.000 tokens por prompt de Haiku.

## CLI (solo desarrollo)

Se corre desde `packages/deepwiki`. Lee `ANTHROPIC_API_KEY` y `GITHUB_TOKEN` del `.env` de la raíz y **nunca los imprime**:

```sh
node --env-file-if-exists=../../.env src/cli.ts dueño/repo --estimar     # solo GitHub: estimación y techo
node --env-file-if-exists=../../.env src/cli.ts https://github.com/dueño/repo [--ref=rama] [--max-usd=0.10]
node --env-file-if-exists=../../.env src/cli.ts dueño/repo --forzar      # ignora la caché local y el estado guardado
node --env-file-if-exists=../../.env src/cli.ts dueño/repo --hallazgos=out/hallazgos-demo.json
# o bien: pnpm --filter @vanguard/deepwiki generate -- dueño/repo --estimar
```

- `--estimar` no necesita la clave de Anthropic. Imprime la estimación y el techo (todas las salidas al tope).
- `--max-usd=N` corta **antes** de un paso si lo gastado más lo máximo que puede costar ese paso pasa de N.
- `--hallazgos=a.json`: un arreglo de `HallazgoBreve` (`rule_id`, `severity`, `title` y `path` opcional; como mucho
  200) para probar la sección de riesgos sin el BACK. `[]` es una auditoría sin hallazgos. Para la demo, sale de los
  fixtures del contrato (solo `rule_id`, `severity`, `title` y `evidence.path`, nunca la evidencia):

  ```sh
  node --input-type=module -e "import { fixtures } from '../contracts/src/index.ts'; import { writeFileSync } from 'node:fs'; writeFileSync('out/hallazgos-demo.json', JSON.stringify(fixtures.findings.map((f) => ({ rule_id: f.rule_id, severity: f.severity, title: f.title, ...(typeof f.evidence?.path === 'string' ? { path: f.evidence.path } : {}) }))))"
  ```
- Sin `GITHUB_TOKEN` funciona con repos públicos, pero con un límite de 60 peticiones por hora.
- Imprime el progreso por paso, los avisos y, al final, el costo real junto al estimado. Si falla, dice cuánto se gastó.
- Guarda `out/<dueño>__<repo>/<commit_sha>[-h<huella>]/overview.md` y `wiki.json`; con `--hallazgos`, la huella de esos
  hallazgos va en el nombre para no reutilizar una wiki hecha sin ellos. La carpeta `out/` está en `.gitignore`.
- Después de cada paso guarda `estado.json` (solo rutas, resúmenes y consumo). Si la corrida falla a mitad, volver a
  correrla **reanuda** desde ahí sin repagar el triage ni las áreas; `--forzar` empieza de cero.
- Si ese commit ya está en `out/` y no se pasa `--forzar`, imprime la ruta y no gasta.
- Modelos opcionales: `DEEPWIKI_MODEL_FAST` y `DEEPWIKI_MODEL_SMART`.
- Si un antivirus intercepta TLS (Norton en el equipo de Giovanni), Node no confía en su certificado. Agrega `NODE_OPTIONS=--use-system-ca`.

## Integración en el BACK (apps/api)

1. **E40 · estimar**: `pasoArbol` (solo GitHub, ≤ 25 subpeticiones) + `estimar`. Luego se busca una wiki terminada con
   la misma llave de caché (punto 2). Si existe, se devuelve en `cached_run_id`.
2. **Llave de la caché**: `(org_id, repo_full_name, commit_sha, huella)`, con `huella = await huellaHallazgos(hallazgos)`
   de los hallazgos que se van a pasar (o el `scan_id` de la auditoría usada). Los hallazgos de Supabase cambian sin
   cambiar el commit: si alguien activa RLS y vuelve a pedir la wiki, la huella cambia y no se sirve el documento
   viejo. Se guarda en `wiki_runs` y se compara en E40 y E41; si cambió, `cached_run_id = null`.
3. **E41 · correr**: si hay caché y no viene `force`, se crea una corrida `cached: true` con los cuatro pasos `skipped`,
   `fin` en `done`, costo 0, y no se encola nada. Si no hay caché, se crea la fila en `wiki_runs` y se encola un mensaje
   en `vg-jobs`, por ejemplo `{ v: 1, kind: 'wiki', org_id, wiki_run_id, paso: 'arbol' }`.
4. **Un paso por mensaje**. El consumidor carga `wiki_runs.state` y, **antes** de ejecutar el paso:
   - corta con `error_code: 'tope_usd'` si `estado.consumo.cost_usd + costoMaximoPaso(estado, siguiente, deps) > max_usd`.
     Cortar después tiraría un paso ya pagado: la síntesis con Sonnet es cerca del 87 % del costo.

   Ejecuta `pasoArbol` → `pasoTriage` → `pasoArea(estado, area)` por cada área → `pasoSintesis`. Después de cada uno:
   - si el paso devolvió **el mismo objeto** (`nuevo === estado`), es una entrega repetida: no guarda ni encola nada;
   - guarda el estado con **compare-and-set** sobre `n`:
     `update wiki_runs set state = $nuevo where id = $id and coalesce((state->>'n')::int, 0) = $n_anterior`.
     Si no actualiza ninguna fila, otra entrega ya avanzó: no encola nada;
   - actualiza `steps` (`detalle = detalleInicio(...)`), `progress = progreso(estado)` y `cost_usd = estado.consumo.cost_usd`;
   - encola lo que diga `siguientePaso(estado)`.

   Al terminar la síntesis, guarda el documento (más `run_id`) y marca la corrida `succeeded`. **Un documento ya
   generado se guarda siempre**, aunque haya pasado el tope por el pensamiento del modelo; en ese caso, con un aviso.
5. **La síntesis no se paga dos veces**: antes de llamar a `pasoSintesis`, guarda `marcarSintesis(estado)` con el mismo
   compare-and-set. Si el estado cargado ya trae `sintesisEnCurso(estado)` (marca de hace menos de 5 minutos) o la
   corrida está `succeeded`, no la corre. Una marca más vieja es de un Worker que se cayó: se puede repetir.
6. **Errores y reintentos de la cola**: `limite_github` → `msg.retry({ delaySeconds: e.reintentarEnS ?? 60 })`, en vez
   de gastar los reintentos contra el mismo límite. `github_red` (también cuando GitHub falla en la mayoría de los
   archivos de un área: así no se guarda en la caché una wiki degradada) y los 5xx → reintento normal. El resto falla
   la corrida con su `codigo`.
7. **`Deps` en el Worker**:
   - `fetch: (u, i) => fetch(u, i)`. Envuelto, para evitar el «Illegal invocation» del `fetch` suelto.
   - `githubToken`: el PAT de la conexión, descifrado solo durante el paso. Nunca va al estado ni a los logs.
   - `hallazgos`: los de la última auditoría de ese repo, solo `rule_id`, `severity`, `title` y `path`, nunca la evidencia.
     `path` es `evidence.path`, **sin** número de línea (no el `resource` «src/a.ts:4»). `undefined` = no hubo
     auditoría; `[]` = VanGUARD auditó y no encontró nada. El documento dice cosas distintas en cada caso, así que no
     hay que pasar `[]` cuando no hubo auditoría.
   - `auditoria_at`: el ISO de esa auditoría; el documento avisa «Los riesgos salen de la auditoría de VanGUARD del …».
   - `llm`: **enrutado por `apps/api/src/ia/claude.ts`**, que aplica los topes, el interruptor y el registro en
     `ai_usage`. Recibe `{ tarea, system, user, maxTokens }` y devuelve `{ texto, modelo, uso, stop_reason }`. El modelo
     se elige con `modeloPara(tarea, modelos)`. Nunca se envían `temperature`, `top_p`, `top_k` ni `tool_choice` forzado.

## Uso en el FRONT (E40–E44 del contrato `packages/contracts/src/wiki.ts`)

- **E40**: muestra el costo estimado, el desglose y los avisos antes de pedir confirmación. El último aviso es el techo
  («el costo puede llegar a US$ X»): propone `max_usd` ≥ ese techo, no la estimación, o la corrida se cortará en la
  síntesis. Con `cached_run_id`, ofrece «ver la wiki existente» sin costo.
- **E41**: envía el `max_usd` que aceptó el usuario y, si quiere regenerar, `force`.
- **E42/E43**: muestran el progreso (`progress`, `steps[].detalle`) y el historial por commit.
- **E44**: dibuja `overview_md` con Markdown **sin HTML crudo** y pone `mermaid` bajo «## Mapa visual». Mermaid se dibuja
  con `securityLevel: 'strict'`. Si `mermaid_descartado`, ya viene la nota en el texto. Cada `paginas[]` es una pestaña
  o ancla por `id` (estable, `[a-z0-9-]`).
- **Texto plano**: `paginas[].area`, `paginas[].titulo`, `paginas[].archivos`, `avisos` y `steps[].detalle` salen (o
  pueden salir) de nombres de carpetas y archivos que controla el dueño del repo. Se pintan siempre como texto, nunca
  como Markdown ni HTML. Solo `overview_md` y `resumen_md` son Markdown, y ya vienen saneados.
- **Cruce con hallazgos**: un hallazgo cuelga de `paginaDeRuta(evidence.path, paginas)`, la misma regla que usa la
  síntesis: 1) la página que leyó ese archivo; 2) el área más larga que sea prefijo de la ruta con «/»; 3) la que leyó
  otro archivo de la misma carpeta; 4) la página de «(raiz)» (`id: 'raiz'`) si la ruta no tiene carpeta, como `.env`,
  `.gitignore` o `package-lock.json`, que nunca se leen; si no, ninguna. Conviene pintar **siempre** la lista real de
  hallazgos junto a «Riesgos», cruzada así: el texto del modelo no es la única fuente.

## Costos típicos

Precios en USD por millón de tokens:

| Modelo | Entrada | Salida |
|---|---|---|
| Haiku 5.5 | 0,10 | 0,50 |
| Sonnet 5.5 | 2,00 | 10,00 |

- **Repo chico** (41 archivos, 27 candidatos, 7 áreas; los fixtures del contrato): estimación de unos **US$ 0,043**,
  costo real de unos **US$ 0,034** y techo de unos **US$ 0,080**.
- **Repo mediano** (400 candidatos, 13 áreas): unos **US$ 0,06** estimados.
- **Techo práctico**: unos **US$ 0,10** por corrida, con todas las salidas al tope de `max_tokens` (4.000, 1.500 y 6.000).
- La síntesis con Sonnet es cerca del 87 % del costo. Los modelos 5.5 piensan por defecto y ese pensamiento se cobra
  como salida, así que el costo real puede superar la estimación: por eso la estimación trae el techo y el tope se
  comprueba con `costoMaximoPaso` antes de cada paso.

## Protecciones

- **Filtros locales**: `.env*`, llaves (`.pem`, `.key`, `id_rsa`…), credenciales (`wp-config.php`, `secrets.*`),
  lockfiles, binarios, generados y carpetas como `node_modules` no se piden nunca. Las rutas con caracteres de control,
  marcas bidi o de ancho cero, ángulos, comillas dobles, comilla invertida o barra invertida se descartan antes del
  triage. `pasoTriage` y `pasoArea` vuelven a
  filtrar, por si el estado guardado fue alterado.
- **Redacción antes del modelo**: cada archivo pasa por `prepararDato` antes de armar el prompt. Si el archivo se
  recortó, se descarta la cola del texto ya redactado: un secreto partido por el corte (que ya no casa con su patrón)
  nunca entra, aunque una redacción grande anterior haya encogido el texto. Pasan por la misma redacción la descripción
  de GitHub, los títulos de los hallazgos y las rutas con forma de clave. Patrones: claves con prefijo (Anthropic,
  OpenAI, Stripe, GitHub, GitLab, Slack, SendGrid, npm, Hugging Face, Supabase, AWS, Google), JWT, PEM, cadenas de
  conexión, `Bearer`/`Basic`/`token`, asignaciones (`=`, `:`, `:=`, `=>`), `define()` y `setX()` con nombre de secreto,
  y literales largos de alta entropía.
- **Redacción después del modelo**: los resúmenes y el documento también se redactan antes de guardarse, por si un
  secreto se coló y el modelo lo repite.
- **Datos, no instrucciones**: el contenido del repo va entre `<repo_file>`, `<repo_paths>`, `<repo_summary>` y
  `<vanguard_findings>`, también el nombre del área, la rama y la descripción. El system prompt dice que es dato no
  confiable, y las etiquetas que aparecen dentro del contenido (también como `&lt;`, `<` o `\x3c`) se
  neutralizan con `‹`.
- **Riesgos verificados por código**: el modelo cita cada hallazgo con una marca `[Hn]`; el código comprueba que estén
  todos los críticos y altos, quita las marcas y anexa los que falten con un aviso. Una inyección que le pida callar un
  hallazgo grave no vacía la sección.
- **Salida saneada**: sin HTML, enlaces, imágenes ni URLs (todo corchete que queda va escapado, así no hay enlace
  posible ni con anidamientos ni con entidades). El Mermaid pasa una lista blanca estricta: solo `flowchart LR|TD`,
  nodos `Id[Etiqueta]` y flechas `-->`, sin `click`, `style` ni `%%{init}`. Si no la pasa, se descarta
  (`mermaid: null`, `mermaid_descartado: true`). Se avisa si el documento llegó cortado o le faltan secciones.
- **Topes**: ≤ 40 subpeticiones por paso, prompts de Haiku ≤ 90.000 tokens, árboles de más de ~450 KB pasan al árbol
  superficial, todas las regex son lineales, `Deps.limites` solo puede bajarlos, y se estima (con techo) antes de gastar.
- **Secretos del operador**: el token de GitHub y la clave de Anthropic nunca entran en mensajes de error, avisos,
  estado ni salida de la CLI. Las redirecciones a otro host no se siguen, para no filtrar el token.

## Pruebas

```sh
pnpm --filter @vanguard/deepwiki test        # vitest, con dobles de fetch y de llm: cero red real
pnpm --filter @vanguard/deepwiki typecheck
```

`src/pipeline.test.ts` corre la wiki completa sobre un repo de juguete que trae un `.env` y secretos falsos armados por
partes. Comprueba, entre otras cosas, lo siguiente:

- el `.env` no se pide a GitHub y ningún secreto llega al modelo, ni partido por el recorte;
- el estado no guarda contenido de archivos y ningún paso pasa de 40 subpeticiones;
- un Mermaid malicioso se descarta y un hallazgo grave que el modelo calla se anexa;
- el tope de costo corta antes de pagar y un mensaje repetido no rehace nada;
- el resultado cumple el esquema zod de `WikiDoc`, salvo `run_id`.

`src/fixtures-contrato.test.ts` comprueba que los fixtures de la wiki del contrato son una salida posible del motor:
áreas e ids, títulos y textos saneados, avisos con los textos de `AVISOS` y el paso en curso.

## Créditos

- **CLI deepwiki original de Andrés Valero (equipo 22)**, commit `14c229a` de este repo. Este paquete porta su flujo:
  filtros, triage con Haiku, resumen por carpeta, síntesis con Sonnet, redacción y lista blanca de Mermaid.
- **DeepWiki-Open**, © 2024 Sheing Ng, licencia MIT (ver [LICENSE-deepwiki-open.txt](LICENSE-deepwiki-open.txt)).
  De ahí vienen:
  - las listas de exclusión de `api/config/repo.json`;
  - la idea de wiki por páginas de `api/schemas/wiki.py`;
  - consejos de prompts de `api/prompts.py`.

  Los archivos que portan algo de ahí lo dicen en su cabecera.
