# Evolución entre revisiones: especificación y encargos

Especificación para el ORQUESTADOR (sáb 24-oct; revisada a las ~19:45 de Caracas con las 13 correcciones del revisor,
§13). Cubre la función (1) del pedido de Giovanni. Las funciones (2) (bloquear un push o un PR con un crítico) y (3)
(Cloudflare en modo «bajo ataque» con token de escritura) van en sus propios documentos; aquí solo se nombra dónde se
tocan (§11).

Pedido literal (1): «Quiero que cada vez que se haga una revisión nueva te diga los errores nuevos, los que se mantienen y
los que se corrigieron, de modo que también podamos evaluar entre versiones cómo ha ido todo el sistema (tanto en
codebase, como supabase, todas las secciones) y podamos ver los cambios con métricas en base al tiempo, también con
gráficos.»

Lectura del pedido: Giovanni lo escribió justo después de lanzar `demo/empujar-revision.mjs` y recibir el WhatsApp de la
revisión de código. «Revisión» es, primero, la de cada push a la rama vigilada; y también cada auditoría, que es lo único
que mira todas las secciones. Las dos dejan una foto y cada una dice qué es nuevo, qué se mantiene y qué se corrigió
frente a la anterior de su tipo. La página «Evolución» las pone en el tiempo con cifras y gráficas.

Código leído antes de decidir: `apps/api/src/jobs.ts`, `scans/index.ts` (pasos `puntaje` y `resumen_ia`),
`scans/comun.ts` (`guardarHallazgos`, `aFila`), `scans/{cobertura,cloudflare,repo,repo-paso}.ts`,
`rutas/{scans,overview,findings,revision,index}.ts`, `revision/pasos.ts`, `notify/revision.ts`, `mw/{anon,admin}.ts`,
`app.ts`, `lib/{errors,iso}.ts`, `test/db-doble.ts`, `jobs.test.ts`; migraciones 0004, 0005, 0008, 0008b, 0008c, 0008h,
0013; `packages/core/src/{score.ts,secrets/rules.ts,secrets/scan.ts,templates/revision.ts}`;
`packages/contracts/src/{api,comun,codebase,index,contracts.test}.ts` y `fixtures/`; la web (`main.tsx`,
`app/router.tsx`, `app/AppShell.tsx`, `lib/{nav,guias,atajos,consultas,realtime}.ts`, `lib/fixtures/router.ts`,
`modulos/auditoria/PaginaAuditoria.tsx`, `modulos/codebase/TarjetaRevisionCodigo.tsx`,
`modulos/rendimiento/PaginaRendimiento.tsx`, `componentes/vg/{GraficaComparativa,GraficaTrafico,Cifra,SectorPlegable}.tsx`);
`demo/{guion.md,empujar-revision.mjs}`; y `asignaciones/{revision-codigo,verificar-arreglo-hoja-de-ruta,
bloqueo-merge-criticos,modo-bajo-ataque,varias-codebases}.md`.

Comprobado hoy en el scratchpad (sin tocar el repo):

- **Contrato.** El zod de §4.2, los fixtures de §4.4 y las pruebas de §4.5, aplicados sobre una copia de
  `packages/contracts` del HEAD `f92b137`, compilan con el `tsc` 6.0.3 del repo (`tsc --noEmit -p .`) y pasan con
  vitest 4.1.12 y zod 4.6.7: **60 en verde** (las 47 de hoy y 13 nuevas: 4 de esquema y 9 del bloque «evolución»).
  Cambiar un conteo de la cadena de auditorías o el `kept` de una foto de push hace fallar su prueba. Ningún fixture
  nuevo casa con el cable trampa (`PARECE_SECRETO`).
- **SQL.** 0015 (§3) y `supabase/tests/evolucion.sql` (§3.1) corren en PGlite 0.3.14 (Postgres en WASM) encima de las
  migraciones 0001–0013 del repo, con stubs de lo propio de Supabase (roles, `auth`, `vault`, `cron`, `realtime`): la
  prueba da **«RESULTADO OK»**. Las salidas de `vg_evolution`, `vg_audit_delta` y la columna `delta` de una revisión de
  push pasan `Evolution`, `AuditDelta` y `CodeReviewDelta` con zod. PGlite no es Supabase: el BACK repite la prueba
  pegada detrás de la migración antes de aplicarla (B1).

---

## 0. Decisiones en una tabla

| Tema | Decisión | Por qué (dato) |
|---|---|---|
| Qué es una «versión» | Dos cadenas. (a) Cada push a la rama vigilada: foto de Codebase al cerrar su revisión (nuevos de ese push, siguen abiertos, corregidos desde el push anterior). (b) Cada auditoría terminada (`full_audit`, `supabase`, `cloudflare`, `repo`, `zip`): foto de todas las secciones. Los PR salen en la línea de tiempo con sus nuevos | Giovanni llama «revisión» a la del push. La auditoría es lo único que mira el estado entero: un push solo ve las líneas añadidas (`revision/pasos.ts`) |
| Dónde se calcula | Auditoría: paso `puntaje`, RPC `vg_snapshot_audit`. Push: paso `diff`, RPC `vg_review_snapshot` justo después de `vg_review_findings` y antes de encolar el aviso. Una subpetición cada una; las cuentas las hace la base | `puntaje` corre con todas las fuentes cerradas (`guarded`) y antes de la IA. El aviso y E45 ya encuentran la foto del push |
| Dónde se guarda | Tabla nueva `audit_snapshots` (una fila por auditoría) y tres columnas nulas en `code_reviews` (`snap_at`, `snap_open_ids`, `delta`) | `resumen_ia` no llama a la IA si `summary` ya tiene algo, y `scan_runs` emite Realtime en cada `vg_mark_step`. `code_reviews` no tiene Realtime y E45 ya la lee: `delta` llega sin subpetición nueva |
| «Nuevo / se mantiene / corregido» | Resta de conjuntos de ids `open` entre esta foto y la anterior de la org, con la misma función para las dos cadenas (`private.vg_restar`). Corregido = estaba abierto y ahora está `fixed` o `verified`. Ignorado, aparte. Fila borrada = «ya no existe», aparte. Una clave que solo cambió de línea = «se mantiene» | El id de un hallazgo no cambia entre auditorías (`unique (org_id, dedupe_key)`). Una clave movida cambia de `dedupe_key` (resource = `path:line`, `core/src/secrets/scan.ts:246`) y se empareja por regla + huella |
| Claves | Una clave (`CB_SECRET_*`, `CB_ENV_COMMITTED`) que la auditoría da por `verified` sale como «Ya no está en el código · rota la clave», nunca como «Comprobado», y no entra en el tiempo hasta comprobar | La auditoría lee solo HEAD (`scans/repo.ts`) y auto-verifica lo que no reaparece (0004:73-77). Quitar una clave sin rotarla no la arregla |
| Una foto no se rehace | Si `puntaje` (o el diff) se repite, la RPC devuelve la foto que hay. `taken_at` = `clock_timestamp()` tomado después del candado | Un reintento (`jobs.ts:251-254`) o `finalizar` (`jobs.ts:146-148`) no reescriben una foto que otra ya tomó como anterior: la cadena no se desordena |
| Bug de `p_scan` nulo (0004) | No depende de él: no se lee `scan_run_id` ni se llama a `vg_upsert_findings`. Si el bug deja un hallazgo abierto, sale como «se mantiene», nunca como «corregido» | Un error solo puede inclinar hacia «se mantiene» |
| Comprobado o a mano | «Corregido» se parte en `verified` (una auditoría ya no lo encontró) y `fixed` (alguien lo marcó) | La UI nunca dice «comprobado» de algo marcado a mano |
| Historial | Fotos desde el despliegue del tramo A (§9.0), que va ANTES de las funciones (2) y (3). El puntaje de las auditorías anteriores sale exacto de `scan_runs.score` | Lo que se audite o se empuje antes no deja conteos. Reconstruirlos desde `first_seen_at`/`verified_at` sería aproximado (T02-14) |
| Tiempo hasta comprobar | De `first_seen_at` a `verified_at`, solo hallazgos `verified` del periodo y sin claves. Media y mediana | Lo marcado a mano no guarda hora |
| Rutas | E51 `GET …/scans/:id/delta` y E52 `GET …/evolution`. E45 suma `delta` (opcional) a cada revisión. Lectura para todo miembro, también el anónimo de la demo | Mismo nivel de acceso que E13 y E45 (títulos y recursos ya son visibles) |
| Validación en el Worker | E51 y E52 devuelven el JSON de la RPC sin zod. Las horas salen con `Z` del propio SQL (`private.vg_iso`) | Medido: con 60 puntos y 50 revisiones, `Evolution.safeParse` tarda 8,2 ms la primera vez aun con JIT; `JSON.parse`, 0,4 ms. Pasar `iso()` en JS obligaría a recorrer el JSON |
| core | Sin cambios. Una línea más en el WhatsApp es de la mensajería: propuesta M1 (§9.4) | La resta va en la misma transacción que lee los hallazgos |
| Realtime | Sin trigger nuevo. El FRONT refresca la evolución con los eventos de `scan_runs`, `findings` y `notifications` | Un push escribe en `findings` (y su aviso en `notifications`), no en `scan_runs` |
| `wrangler.jsonc` | Sin cambios | Ni cron ni bindings nuevos |
| Migración | 0015, aplicada ANTES del Worker. 0016 es de (2) y 0017 de (3); 0018 queda libre. No toca `findings`, `scan_runs` ni `vg_upsert_findings` | E45 pide la columna `delta`: sin 0015, PostgREST rechaza la consulta entera |

---

## 1. Qué ve el usuario

### 1.1 En cada push (fila de la revisión en Codebase)

La fila de cada revisión de push en `TarjetaRevisionCodigo` (el enlace del WhatsApp, `?revision=<id>`, la abre) suma una
línea con la foto de Codebase. Cifras de los fixtures (push de las 19:20Z):

- «**1 nuevo · 7 siguen abiertos · 0 corregidos** desde el push anterior».
- Con algo corregido: «2 corregidos desde el push anterior (1 comprobado por una auditoría)».
- Primer push con historial: «7 siguen abiertos en Codebase · desde el próximo push verás los corregidos».
- Con dos o más repos conectados (`varias-codebases.md`): «en Codebase (todos los repos)».
- Una nota por tarjeta: «Entre dos pushes, "corregido" es lo que alguien marcó o lo que comprobó una auditoría: un push
  no ve lo que se quita.»
- Una revisión de PR no lleva esta línea (un PR no escribe hallazgos): sigue con sus nuevos.

WhatsApp: hoy dice los nuevos (`mensajeRevision`). Sumar «Siguen abiertos: 7 · corregidos desde el push anterior: 0» es
la propuesta M1 a quien lleva la mensajería (§9.4). Mientras no esté, el enlace del WhatsApp abre esta fila con las tres
cifras.

### 1.2 En la página de una auditoría (`/o/:org/audit/:scanId`)

Debajo del puntaje, un bloque «Cambios desde la auditoría anterior» (cifras de los fixtures):

- Cabecera: «Frente a la auditoría del {fecha} · puntaje 57 → 20».
- Cuatro cifras: **Nuevos 7**, **Se mantienen 5**, **Corregidos 2** («1 comprobado por la auditoría») e «Ignorados 1» en
  pequeño.
- Una fila por módulo con algo distinto de 0 (Supabase, Cloudflare, Codebase) con nuevos, se mantienen y corregidos.
  Un módulo que no está en `modules_seen` lo dice: «Cloudflare: no se revisó en esta auditoría; sus cambios vienen de
  pushes o de marcas a mano».
- Tres listas plegables: Nuevos (abierta), Corregidos y Se mantienen. Cada fila: severidad, título, recurso y «Ver».
  En Corregidos, una etiqueta: «Comprobado», «Ya no está en el código · rota la clave», «Marcado a mano» o «Volvió a
  aparecer».
- Si hubo claves que solo cambiaron de línea: «1 clave cambió de línea y sigue abierta: cuenta en "Se mantienen"». Si
  la retención borró filas: «2 hallazgos ya no existen (se borraron por antigüedad): no cuentan como corregidos».

### 1.3 Página «Evolución» (`/o/:org/evolution`)

Nueva entrada del riel, en «Respuesta», debajo de «Auditoría». P0:

- Periodo (7, 30 o 90 días).
- Cifras del periodo entero, calculadas en la base aunque la gráfica se recorte: puntaje de la última auditoría (y
  cuánto cambió desde la primera del periodo), abiertos al cerrarla, nuevos y corregidos del periodo, tiempo medio hasta
  comprobar la corrección.
- Gráfica **puntaje por auditoría** (línea con las bandas 50 y 80).
- Tabla «Versiones» (tarjetas en móvil) con «Ver cambios» → la auditoría (§1.2).

P1, en este orden: gráfica **nuevos frente a corregidos** (barras arriba y abajo de cero), lista «Revisiones de código»
(pushes y PR: hora, commit corto, nuevos y la línea de §1.1), **abiertos por severidad** (barras apiladas), filtro por
módulo (Todo · Supabase · Cloudflare · Codebase; Rendimiento no entra: ningún paso de auditoría escribe hallazgos de
rendimiento) y **incidentes por día** (ataques, por severidad).

---

## 2. Cómo se calcula

### 2.1 La foto de una auditoría

`pasoPuntaje` (`apps/api/src/scans/index.ts`), después de escribir `score` y `coverage`, llama a
`vg_snapshot_audit(p_org, p_scan)`. La RPC, con un candado por org:

1. Lee la auditoría de ESA org. Si es `lighthouse` o no existe → `applied:false` (`scan`).
2. Si ya tiene foto, la devuelve (`repeated:true`) y no toca nada. Una foto no se rehace.
3. `modules_seen` = módulos cuyo paso quedó `done` (`repo` y `zip` → `codebase`). Si no hay ninguno → `applied:false`
   (`sin_modulos`): nunca una versión sin haber mirado nada.
4. `taken_at` = `clock_timestamp()` (posterior a toda foto ya escrita de la org). `open_ids` = ids de TODOS los
   hallazgos `open` de la org (todas las secciones, también los de pushes y ZIP).
5. Anterior = la foto más reciente de la org.
6. Con anterior, `private.vg_restar` (§2.3): `new`, `fixed`, `ignored`, `moved`, `gone` y `fixed_checked`. `kept` =
   abiertos menos nuevos (incluye las claves que cambiaron de línea).
7. Guarda ids y conteos por módulo × severidad (`counts.open|new|kept|fixed|ignored`).

Mejor esfuerzo: si la RPC falla, `puntaje` lo registra y sigue (`status: 'done'`).

### 2.2 La foto de un push

`revisar()` (`apps/api/src/revision/pasos.ts`), cuando `vg_review_findings` cerró la revisión de un push
(`applied:true`) y antes de encolar el aviso, llama a `vg_review_snapshot(p_org, p_review)`. La RPC, con su candado por
org:

1. Solo una revisión `push` en `done` de ESA org; si no → `applied:false` (`revision`). Un PR no hace foto.
2. Si ya tiene `delta`, la devuelve (`repeated:true`).
3. `snap_open_ids` = hallazgos de Codebase `open` de toda la org (los de push van con `connection_id` null: con varios
   repos no se pueden separar por repo).
4. Anterior = la foto de push más reciente de la ORG (no de la config: con dos repos, el mismo arreglo saldría en la fila
   de cada uno).
5. `kept` = abiertos menos los nuevos de este push (los `finding_id` de `new_findings`, hasta 50). Con anterior,
   `private.vg_restar` da `fixed`, `fixed_checked` e `ignored`.
6. Escribe `snap_at`, `snap_open_ids` y `delta` (`CodeReviewDelta`) en la revisión.

Entre dos pushes, «corregido» solo puede ser algo marcado a mano o algo que comprobó una auditoría: el diff no ve lo que
se quita. Y una auditoría nunca auto-verifica un hallazgo nacido de un push (`connection_id` null; 0004 verifica por
`connection_id`): esos solo se cierran a mano. La UI lo dice (§1.1).

### 2.3 La resta (`private.vg_restar`) y las definiciones que ve el usuario

| Lista | Qué es |
|---|---|
| Nuevos | Abiertos ahora que no estaban abiertos en la foto anterior. Incluye lo que volvió a aparecer y lo que trajo un push o un ZIP entre medias. En la foto de un push, «nuevos» son los de ESE push (`counts`, los del WhatsApp) |
| Se mantienen | Abiertos ahora que no son nuevos. Incluye las claves que solo cambiaron de línea (`moved`) |
| Corregidos | Abiertos en la anterior y ahora `fixed` o `verified`. Etiquetas: «Comprobado» (`verified`, no es una clave), «Ya no está en el código · rota la clave» (`verified` y regla `CB_SECRET_*` o `CB_ENV_COMMITTED`) y «Marcado a mano» (`fixed`) |
| Ignorados | Abiertos en la anterior y ahora `ignored`. No cuentan como corregidos |
| Ya no existen (`gone`) | Abiertos en la anterior cuya fila borró la retención (0008:40). No cuentan como corregidos ni como ignorados |

Una clave «se movió» cuando sale una fila `fixed`/`verified` y entra otra con la misma regla y la misma huella
(`evidence.fingerprint_short`); se emparejan 1 a 1 (`row_number()` por regla y huella), así que N salidas y M entradas
dan `min(N, M)` pares. Cuadra siempre, en total: `open = open anterior + new − fixed − ignored − gone`.

`fixed_checked` = corregidos `verified` que no son claves. Los conteos son los de la foto; las listas de E51 traen el
estado de AHORA de cada hallazgo: un corregido que volvió a salir trae `status 'open'` y la UI dice «Volvió a aparecer».

### 2.4 Por qué no depende del bug de `p_scan` nulo

El bug (`verificar-arreglo-hoja-de-ruta.md` §6) deja `open` un hallazgo que ya no aparece cuando dos llamadas seguidas
pasan `p_scan = null`. Aquí:

- No se lee `findings.scan_run_id` ni se llama a `vg_upsert_findings`. Se comparan ids.
- Las auditorías siempre pasan un `scan_run_id` real, así que la auto-verificación funciona.
- Si un hallazgo queda abierto por el bug, sale en «se mantiene». Nunca se afirma una corrección que no ocurrió.

### 2.5 Historial

- Conteos (nuevos, corregidos, abiertos por severidad) y fotos de push: desde el despliegue del tramo A (0015 y Worker,
  §9.0). La primera foto de cada cadena es `first:true` («punto de partida»). Las auditorías y los pushes de antes,
  incluidos los ensayos de esta noche si van antes del tramo A, no dejan conteos.
- Puntaje: E52 lista también las auditorías terminadas de antes (`snapshot:false`), con el `score` que escribió
  `puntaje` en su momento. Es exacto y cuesta cero.
- No se reconstruyen conteos viejos. `findings` no guarda el historial de estados: una reapertura pone `verified_at` a
  null y lo marcado `fixed` o `ignored` no tiene hora. Serían números aproximados (T02-14).

### 2.6 Casos borde

| Caso | Qué pasa |
|---|---|
| Un paso de fuente falló | Sus hallazgos siguen `open` → «se mantienen». `modules_seen` no lo trae y la UI lo dice |
| Todas las fuentes fallaron | Sin foto (`sin_modulos`). E51 → `sin_foto` |
| Dos auditorías cierran a la vez (p. ej. ZIP y completa) | El candado por org las ordena y `taken_at` sale después del candado: la segunda compara con la primera |
| `puntaje` se repite (reintento, entrega doble o `finalizar`) | La RPC devuelve la foto que hay (`repeated`). La cadena no cambia |
| El vigilante cierra como `failed` una auditoría que ya tenía foto | Sigue en E52 (toda foto cuenta, sea cual sea el status) y sigue siendo la anterior de la siguiente |
| Se borra la auditoría anterior (retención de 90 días) | El delta ya está guardado; `previous` sale `null` y la UI dice «una auditoría que ya se borró» |
| Se borra esta auditoría | Su foto se borra con ella (`on delete cascade`) |
| Un ZIP o un push trajo un hallazgo | Es parte del estado: sale como nuevo en la siguiente foto de auditoría |
| Una clave se quita de HEAD sin rotarla | La auditoría la da por `verified`: sale en Corregidos como «Ya no está en el código · rota la clave», no cuenta como comprobada ni en el tiempo hasta comprobar |
| Se añade código encima de una clave (cambia de línea) | La auditoría crea otra fila y verifica la vieja: se emparejan por regla + huella y cuenta como «se mantiene» (`moved`) |
| La retención borra la fila de un hallazgo que estaba abierto en la foto anterior | «Ya no existe» (`gone`): ni corregido ni ignorado |
| Otro valor en la misma línea (revisión de código) | Misma fila, mismo id: «se mantiene». Limitación conocida |
| Un push con más de 50 nuevos | `new_findings` guarda 50 (el diff admite 200 filas): `kept` cuenta de más los que no caben. Hacen falta 51 hallazgos nuevos en un solo push |
| Auditoría de una sola fuente | Es una versión más (el estado es el de toda la org); la tabla dice su tipo |

---

## 3. Modelo de datos: `supabase/migrations/0015_evolucion.sql`

```sql
-- 0015_evolucion.sql · Evolución entre revisiones (docs/plan_maestro_trabajo/asignaciones/evolucion-entre-revisiones.md
-- §3). Dos fotos del estado de los hallazgos: una al cerrar cada auditoría (paso puntaje, todos los módulos) y otra de
-- Codebase al cerrar cada revisión de push (paso diff). Frente a la foto anterior de la org: qué es nuevo, qué se
-- mantiene, qué se corrigió, qué se ignoró y qué ya no existe. Una foto no se rehace: si el paso se repite, se devuelve
-- la que hay. audit_snapshots es solo del servidor (RLS sin políticas y sin grants a anon/authenticated, como 0008h y
-- 0013) y sin trigger de Realtime. No toca findings, scan_runs ni vg_upsert_findings; a code_reviews le suma tres
-- columnas nulas (snap_at, snap_open_ids, delta) que solo escribe vg_review_snapshot. «Corregido» sale de comparar ids,
-- no de scan_run_id.

-- 1) Una foto por auditoría. Se borra con su scan_runs (retención de 90 días de 0008). prev_scan_run_id queda null si la
-- anterior se borra: el delta ya está guardado (ids y conteos).
create table if not exists public.audit_snapshots (
  scan_run_id uuid primary key references public.scan_runs(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  kind text not null check (kind in ('full_audit','supabase','cloudflare','repo','zip')),
  taken_at timestamptz not null default now(),
  modules_seen text[] not null
    check (cardinality(modules_seen) between 1 and 4
           and modules_seen <@ array['supabase','cloudflare','codebase','performance']::text[]),
  open_ids uuid[] not null default '{}' check (cardinality(open_ids) <= 20000),
  prev_scan_run_id uuid references public.scan_runs(id) on delete set null,
  is_first boolean not null,
  new_ids uuid[] not null default '{}',
  fixed_ids uuid[] not null default '{}',
  ignored_ids uuid[] not null default '{}',
  moved int not null default 0 check (moved >= 0),
  gone int not null default 0 check (gone >= 0),
  counts jsonb not null check (counts ?& array['open','new','kept','fixed','ignored']),
  fixed_checked int not null default 0 check (fixed_checked >= 0));
create index if not exists audit_snapshots_org_taken_idx on public.audit_snapshots (org_id, taken_at desc);

-- 2) Foto de Codebase de cada revisión de push. snap_open_ids = hallazgos de Codebase abiertos de TODA la org al cerrar
-- el diff (los de push van con connection_id null: con varios repos no se pueden separar por repo). delta = lo que leen
-- E45 y E52 (CodeReviewDelta del contrato). El anterior se busca entre las revisiones de la org
-- (code_reviews_org_created_idx): sin índice nuevo.
alter table public.code_reviews add column if not exists snap_at timestamptz;
alter table public.code_reviews add column if not exists snap_open_ids uuid[] check (cardinality(snap_open_ids) <= 20000);
alter table public.code_reviews add column if not exists delta jsonb check (jsonb_typeof(delta) = 'object');

-- 3) Piezas sin security definer: solo las llaman las RPC de abajo, que ya corren como dueño.
-- Hora con Z, como iso() del Worker (S15 15.3): el JSON sale tal cual hacia el FRONT.
create or replace function private.vg_iso(t timestamptz) returns text
language sql stable strict set search_path = '' as $$
  select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- Reglas de claves: que ya no estén en el código no prueba que se rotaron. No cuentan como «comprobado» ni en el tiempo
-- hasta comprobar.
create or replace function private.vg_es_clave(p_rule text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(starts_with(p_rule, 'CB_SECRET_') or p_rule = 'CB_ENV_COMMITTED', false)
$$;

-- Módulos cuyo paso quedó done (repo y zip → codebase).
create or replace function private.vg_modulos_vistos(p_steps jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct case x->>'name' when 'repo' then 'codebase' when 'zip' then 'codebase'
                                                   else x->>'name' end), '{}')
    from jsonb_array_elements(case when jsonb_typeof(p_steps) = 'array' then p_steps else '[]'::jsonb end) x
   where x->>'status' = 'done' and x->>'name' in ('supabase', 'cloudflare', 'repo', 'zip')
$$;

-- Conteo por módulo × severidad de unos ids (las 4 × 5 claves, aunque valgan 0). Severidad de ahora. Las filas borradas
-- no cuentan (por eso gone va aparte y nunca dentro de estos ids).
create or replace function private.vg_matriz(p_org uuid, p_ids uuid[]) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_object_agg(t.module, t.c) from (
    select m.module, jsonb_build_object(
             'critical', count(f.id) filter (where f.severity = 'critical'),
             'high',     count(f.id) filter (where f.severity = 'high'),
             'medium',   count(f.id) filter (where f.severity = 'medium'),
             'low',      count(f.id) filter (where f.severity = 'low'),
             'info',     count(f.id) filter (where f.severity = 'info')) as c
      from (values ('supabase'), ('cloudflare'), ('codebase'), ('performance')) as m(module)
      left join public.findings f on f.org_id = p_org and f.module = m.module and f.id = any(p_ids)
     group by m.module) t
$$;

-- Lista de E51: total y los p_lim primeros en el orden de E13, con el estado de AHORA. Sin evidencia.
create or replace function private.vg_lista_delta(p_org uuid, p_ids uuid[], p_lim int) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('total', coalesce(cardinality(p_ids), 0), 'items', coalesce((
    select jsonb_agg(jsonb_build_object('finding_id', f.id, 'module', f.module, 'rule_id', f.rule_id,
             'severity', f.severity, 'title', f.title, 'resource', f.resource, 'status', f.status)
             order by f.severity_rank desc, f.confirmed desc, f.last_seen_at desc, f.id)
      from (select g.id, g.module, g.rule_id, g.severity, g.title, g.resource, g.status, g.severity_rank, g.confirmed,
                   g.last_seen_at
              from public.findings g where g.org_id = p_org and g.id = any(p_ids)
             order by g.severity_rank desc, g.confirmed desc, g.last_seen_at desc, g.id limit p_lim) f), '[]'::jsonb))
$$;

-- La resta de conjuntos (§2.1), la misma para auditorías y pushes. p_prev = abiertos de la foto anterior; p_open =
-- abiertos ahora. Los que salieron se parten por su estado de ahora: fixed o verified → corregidos; ignored →
-- ignorados; fila borrada → gone (ni corregido ni ignorado). moved: la misma clave (regla + huella) salió de un sitio
-- (fixed o verified) y entró en otro, porque cambió de línea: se emparejan 1 a 1 y cuentan como «se mantiene», nunca como
-- nuevo ni como corregido. checked: corregidos verified que no son claves.
create or replace function private.vg_restar(p_org uuid, p_prev uuid[], p_open uuid[], out o_new uuid[],
  out o_fixed uuid[], out o_ignored uuid[], out o_moved int, out o_gone int, out o_checked int)
language sql stable set search_path = '' as $$
  with salen as (
    select g.id, f.status, f.rule_id, f.evidence->>'fingerprint_short' as fp
      from unnest(array(select unnest(p_prev) except select unnest(p_open))) as g(id)
      left join public.findings f on f.id = g.id and f.org_id = p_org),
  entran as (
    select g.id, f.rule_id, f.evidence->>'fingerprint_short' as fp
      from unnest(array(select unnest(p_open) except select unnest(p_prev))) as g(id)
      left join public.findings f on f.id = g.id and f.org_id = p_org),
  s as (select x.id, x.rule_id, x.fp, row_number() over (partition by x.rule_id, x.fp order by x.id) as n
          from salen x where x.fp is not null and x.status in ('fixed', 'verified')),
  e as (select x.id, x.rule_id, x.fp, row_number() over (partition by x.rule_id, x.fp order by x.id) as n
          from entran x where x.fp is not null),
  pares as (select s.id as sale, e.id as entra from s join e on e.rule_id = s.rule_id and e.fp = s.fp and e.n = s.n)
  select coalesce((select array_agg(x.id order by x.id) from entran x
                    where not exists (select 1 from pares p where p.entra = x.id)), '{}'),
         coalesce((select array_agg(x.id order by x.id) from salen x where x.status in ('fixed', 'verified')
                    and not exists (select 1 from pares p where p.sale = x.id)), '{}'),
         coalesce((select array_agg(x.id order by x.id) from salen x where x.status = 'ignored'), '{}'),
         (select count(*)::int from pares),
         (select count(*)::int from salen x where x.status is null),
         (select count(*)::int from salen x where x.status = 'verified' and not private.vg_es_clave(x.rule_id)
             and not exists (select 1 from pares p where p.sale = x.id))
$$;

-- 4) La foto de una auditoría (paso puntaje). Candado por org: dos auditorías que cierran a la vez no se comparan con
-- una foto a medias. taken_at = clock_timestamp() DESPUÉS del candado: siempre posterior a la foto anterior.
create or replace function public.vg_snapshot_audit(p_org uuid, p_scan uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_kind text;
  v_steps jsonb;
  v_seen text[];
  v_at timestamptz;
  v_open uuid[];
  v_prev uuid;
  v_prev_open uuid[];
  v_new uuid[] := '{}';
  v_kept uuid[] := '{}';
  v_fixed uuid[] := '{}';
  v_ign uuid[] := '{}';
  v_moved int := 0;
  v_gone int := 0;
  v_checked int := 0;
  a public.audit_snapshots%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('vg_snap|' || p_org::text));
  select s.kind, s.steps into v_kind, v_steps from public.scan_runs s where s.id = p_scan and s.org_id = p_org;
  if v_kind is null or v_kind = 'lighthouse' then
    return jsonb_build_object('applied', false, 'reason', 'scan');
  end if;
  -- Una foto no se rehace: un reintento de puntaje o finalizar devuelven la que hay. Ninguna foto cambia después de que
  -- otra la tomó como anterior.
  select * into a from public.audit_snapshots x where x.scan_run_id = p_scan;
  if a.scan_run_id is not null then
    return jsonb_build_object('applied', true, 'repeated', true, 'first', a.is_first, 'open', cardinality(a.open_ids),
      'new', cardinality(a.new_ids),
      'kept', case when a.is_first then 0 else cardinality(a.open_ids) - cardinality(a.new_ids) end,
      'fixed', cardinality(a.fixed_ids), 'ignored', cardinality(a.ignored_ids), 'moved', a.moved, 'gone', a.gone);
  end if;
  v_seen := private.vg_modulos_vistos(v_steps);
  if cardinality(v_seen) = 0 then
    return jsonb_build_object('applied', false, 'reason', 'sin_modulos');   -- nunca una versión sin mirar nada
  end if;
  v_at := clock_timestamp();
  select coalesce(array_agg(f.id order by f.id), '{}') into v_open
    from public.findings f where f.org_id = p_org and f.status = 'open';
  select x.scan_run_id, x.open_ids into v_prev, v_prev_open from public.audit_snapshots x
   where x.org_id = p_org order by x.taken_at desc, x.scan_run_id desc limit 1;
  if v_prev is not null then
    select r.o_new, r.o_fixed, r.o_ignored, r.o_moved, r.o_gone, r.o_checked
      into v_new, v_fixed, v_ign, v_moved, v_gone, v_checked
      from private.vg_restar(p_org, v_prev_open, v_open) r;
    v_kept := array(select unnest(v_open) except select unnest(v_new));   -- incluye las claves que cambiaron de línea
  end if;
  insert into public.audit_snapshots (scan_run_id, org_id, kind, taken_at, modules_seen, open_ids, prev_scan_run_id,
                                      is_first, new_ids, fixed_ids, ignored_ids, moved, gone, counts, fixed_checked)
  values (p_scan, p_org, v_kind, v_at, v_seen, v_open, v_prev, v_prev is null, v_new, v_fixed, v_ign, v_moved, v_gone,
          jsonb_build_object('open', private.vg_matriz(p_org, v_open), 'new', private.vg_matriz(p_org, v_new),
                             'kept', private.vg_matriz(p_org, v_kept), 'fixed', private.vg_matriz(p_org, v_fixed),
                             'ignored', private.vg_matriz(p_org, v_ign)),
          v_checked)
  on conflict (scan_run_id) do nothing;
  return jsonb_build_object('applied', true, 'first', v_prev is null, 'open', cardinality(v_open),
    'new', cardinality(v_new), 'kept', cardinality(v_kept), 'fixed', cardinality(v_fixed),
    'ignored', cardinality(v_ign), 'moved', v_moved, 'gone', v_gone);
end $$;

-- 5) La foto de Codebase de una revisión de push (paso diff, después de vg_review_findings). Anterior = la foto de push
-- más reciente de la ORG (no de la config: con varios repos, el mismo arreglo saldría en la fila de cada uno). kept =
-- abiertos de Codebase menos los nuevos de este push (new_findings guarda hasta 50). Entre dos pushes, «corregido» solo
-- puede ser algo marcado a mano o comprobado por una auditoría: el diff no ve lo que se quita. No se rehace.
create or replace function public.vg_review_snapshot(p_org uuid, p_review uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.code_reviews%rowtype;
  p public.code_reviews%rowtype;
  v_at timestamptz;
  v_open uuid[];
  v_nuevos uuid[];
  v_fixed uuid[] := '{}';
  v_ign uuid[] := '{}';
  v_moved int := 0;
  v_gone int := 0;
  v_checked int := 0;
  v_delta jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('vg_snap_rev|' || p_org::text));
  select * into r from public.code_reviews c where c.id = p_review and c.org_id = p_org;
  if r.id is null or r.event <> 'push' or r.status <> 'done' then
    return jsonb_build_object('applied', false, 'reason', 'revision');
  end if;
  if r.delta is not null then
    return jsonb_build_object('applied', true, 'repeated', true) || r.delta;
  end if;
  v_at := clock_timestamp();
  select coalesce(array_agg(f.id order by f.id), '{}') into v_open
    from public.findings f where f.org_id = p_org and f.module = 'codebase' and f.status = 'open';
  v_nuevos := array(select (e->>'finding_id')::uuid from jsonb_array_elements(r.new_findings) e
                     where e->>'finding_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    intersect select unnest(v_open));
  select * into p from public.code_reviews c
   where c.org_id = p_org and c.event = 'push' and c.snap_at is not null and c.id <> p_review
   order by c.snap_at desc, c.id desc limit 1;
  if p.id is not null then
    select x.o_fixed, x.o_ignored, x.o_moved, x.o_gone, x.o_checked into v_fixed, v_ign, v_moved, v_gone, v_checked
      from private.vg_restar(p_org, p.snap_open_ids, v_open) x;
  end if;
  v_delta := jsonb_build_object('first', p.id is null, 'previous_review_id', p.id,
    'previous_at', private.vg_iso(p.snap_at), 'open', cardinality(v_open),
    'kept', cardinality(v_open) - cardinality(v_nuevos), 'fixed', cardinality(v_fixed), 'fixed_checked', v_checked,
    'ignored', cardinality(v_ign));
  update public.code_reviews c set snap_at = v_at, snap_open_ids = v_open, delta = v_delta
   where c.id = r.id and c.org_id = p_org and c.delta is null;
  return jsonb_build_object('applied', true, 'moved', v_moved, 'gone', v_gone) || v_delta;
end $$;

-- 6) Lecturas. E51: found:false = la auditoría no es de la org (404 uniforme). Sin foto: en_curso si sigue queued o
-- running; si no, sin_foto. El puntaje y el de la anterior salen de scan_runs. En la primera foto no hay «se mantiene».
create or replace function public.vg_audit_delta(p_org uuid, p_scan uuid, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_status text;
  v_score smallint;
  a public.audit_snapshots%rowtype;
  v_lim int := least(greatest(coalesce(p_limit, 50), 1), 50);
begin
  select s.status, s.score into v_status, v_score from public.scan_runs s where s.id = p_scan and s.org_id = p_org;
  if v_status is null then return jsonb_build_object('found', false); end if;
  select * into a from public.audit_snapshots x where x.scan_run_id = p_scan and x.org_id = p_org;
  if a.scan_run_id is null then
    return jsonb_build_object('found', true, 'available', false, 'scan_run_id', p_scan,
      'reason', case when v_status in ('queued', 'running') then 'en_curso' else 'sin_foto' end);
  end if;
  return jsonb_build_object('found', true, 'available', true, 'scan_run_id', p_scan,
    'taken_at', private.vg_iso(a.taken_at), 'first', a.is_first, 'score', v_score,
    'modules_seen', to_jsonb(a.modules_seen),
    'previous', (select jsonb_build_object('scan_run_id', s.id, 'kind', s.kind,
                                           'finished_at', private.vg_iso(s.finished_at), 'score', s.score)
                   from public.scan_runs s where s.id = a.prev_scan_run_id and s.org_id = p_org),
    'counts', a.counts, 'fixed_checked', a.fixed_checked, 'moved', a.moved, 'gone', a.gone,
    'new', private.vg_lista_delta(p_org, a.new_ids, v_lim),
    'kept', private.vg_lista_delta(p_org, case when a.is_first then '{}'::uuid[]
                                    else array(select unnest(a.open_ids) except select unnest(a.new_ids)) end, v_lim),
    'fixed', private.vg_lista_delta(p_org, a.fixed_ids, v_lim),
    'ignored', private.vg_lista_delta(p_org, a.ignored_ids, v_lim));
end $$;

-- Versiones de la org desde p_desde: toda foto (sea cual sea el status de su auditoría: el vigilante puede cerrar como
-- failed una que ya tenía foto, y sigue siendo la anterior de la siguiente) y las auditorías terminadas con puntaje y sin
-- foto (anteriores a 0015). t = cuándo se tomó la foto (sin foto, cuándo terminó): el orden de la cadena.
create or replace function private.vg_versiones(p_org uuid, p_desde timestamptz)
returns table (scan_id uuid, kind text, score smallint, steps jsonb, snap boolean, t timestamptz, modules_seen text[],
               is_first boolean, counts jsonb, ignored int, gone int, fixed_checked int)
language sql stable set search_path = '' as $$
  select r.id, r.kind, r.score, r.steps, a.scan_run_id is not null, coalesce(a.taken_at, r.finished_at), a.modules_seen,
         a.is_first, a.counts, cardinality(a.ignored_ids), a.gone, a.fixed_checked
    from public.scan_runs r
    left join public.audit_snapshots a on a.scan_run_id = r.id and a.org_id = p_org
   where r.org_id = p_org and r.kind <> 'lighthouse'
     and r.created_at >= p_desde - interval '1 day'    -- una auditoría dura minutos (el vigilante corta a los 15)
     and (a.scan_run_id is not null or (r.status = 'succeeded' and r.score is not null and r.finished_at is not null))
     and coalesce(a.taken_at, r.finished_at) >= p_desde
$$;

-- Suma por módulo × severidad de una clave de counts ('new' o 'fixed') en las fotos del periodo con is_first false.
create or replace function private.vg_suma(p_org uuid, p_desde timestamptz, p_clave text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_object_agg(m.module, (
           select jsonb_object_agg(v.sev, (
                    select coalesce(sum((a.counts->p_clave->m.module->>v.sev)::int), 0)
                      from public.audit_snapshots a
                     where a.org_id = p_org and a.taken_at >= p_desde and not a.is_first))
             from unnest(array['critical', 'high', 'medium', 'low', 'info']) as v(sev)))
    from unnest(array['supabase', 'cloudflare', 'codebase', 'performance']) as m(module)
$$;

-- E52: versiones del periodo (las p_limit más recientes, de la más vieja a la más nueva), totales de TODO el periodo,
-- revisiones de código (push y PR) con la foto de cada push, incidentes por día de Caracas y tiempo hasta comprobar.
create or replace function public.vg_evolution(p_org uuid, p_days int default 30, p_limit int default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_dias int := least(greatest(coalesce(p_days, 30), 1), 90);
  v_tope int := least(greatest(coalesce(p_limit, 30), 1), 60);
  v_desde timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90));
  v_puntos jsonb;
  v_n int;
  v_totales jsonb;
  v_revs jsonb;
  v_inc jsonb;
  v_mttr jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'scan_run_id', p.scan_id, 'kind', p.kind, 'at', private.vg_iso(p.t), 'score', p.score,
           'modules_seen', to_jsonb(coalesce(p.modules_seen, private.vg_modulos_vistos(p.steps))),
           'snapshot', p.snap, 'first', coalesce(p.is_first, false),
           'open', p.counts->'open', 'new', p.counts->'new', 'fixed', p.counts->'fixed',
           'ignored', coalesce(p.ignored, 0), 'gone', coalesce(p.gone, 0), 'fixed_checked', coalesce(p.fixed_checked, 0))
         order by p.t, p.scan_id), '[]'::jsonb)
    into v_puntos
    from (select * from private.vg_versiones(p_org, v_desde) v order by v.t desc, v.scan_id desc limit v_tope) p;

  select count(*), jsonb_build_object(
           'versions', count(*), 'snapshots', count(*) filter (where v.snap),
           'score_first', (array_agg(v.score order by v.t, v.scan_id))[1],
           'new', private.vg_suma(p_org, v_desde, 'new'), 'fixed', private.vg_suma(p_org, v_desde, 'fixed'),
           'fixed_checked', coalesce(sum(v.fixed_checked) filter (where v.snap and not v.is_first), 0),
           'ignored', coalesce(sum(v.ignored) filter (where v.snap and not v.is_first), 0),
           'gone', coalesce(sum(v.gone) filter (where v.snap and not v.is_first), 0))
    into v_n, v_totales
    from private.vg_versiones(p_org, v_desde) v;

  select coalesce(jsonb_agg(jsonb_build_object('review_id', r.id, 'event', r.event, 'pr_number', r.pr_number,
           'at', private.vg_iso(r.created_at), 'head_sha7', left(r.head_sha, 7), 'new', r.counts, 'partial', r.partial,
           'delta', r.delta) order by r.created_at, r.id), '[]'::jsonb)
    into v_revs
    from (select c.id, c.event, c.pr_number, c.created_at, c.head_sha, c.counts, c.partial, c.delta
            from public.code_reviews c
           where c.org_id = p_org and c.event in ('push', 'pull_request') and c.status = 'done'
             and c.created_at >= v_desde
           order by c.created_at desc, c.id desc limit 50) r;

  select coalesce(jsonb_agg(jsonb_build_object('day', d.dia, 'counts', d.c) order by d.dia), '[]'::jsonb)
    into v_inc
    from (select to_char(i.started_at at time zone 'America/Caracas', 'YYYY-MM-DD') as dia,
                 jsonb_build_object('critical', count(*) filter (where i.severity = 'critical'),
                                    'high', count(*) filter (where i.severity = 'high'),
                                    'medium', count(*) filter (where i.severity = 'medium'),
                                    'low', count(*) filter (where i.severity = 'low'),
                                    'info', count(*) filter (where i.severity = 'info')) as c
            from public.incidents i
           where i.org_id = p_org and i.started_at >= v_desde
           group by 1) d;

  select jsonb_build_object('verified', count(*),
           'hours_avg', case when count(*) = 0 then null else round((greatest(avg(
             extract(epoch from f.verified_at - f.first_seen_at)::float8), 0) / 3600)::numeric, 1) end,
           'hours_median', case when count(*) = 0 then null else round((greatest(percentile_cont(0.5) within group
             (order by extract(epoch from f.verified_at - f.first_seen_at)::float8), 0) / 3600)::numeric, 1) end)
    into v_mttr
    from public.findings f
   where f.org_id = p_org and f.status = 'verified' and f.verified_at >= v_desde and not private.vg_es_clave(f.rule_id);

  return jsonb_build_object('days', v_dias, 'points', v_puntos, 'truncated', v_n > v_tope, 'totals', v_totales,
    'reviews', v_revs, 'incidents', v_inc, 'mttr', v_mttr);
end $$;

-- 7) Solo el Worker (service_role). Decisión (a): los datos van por /api; anon y authenticated no leen nada.
alter table public.audit_snapshots enable row level security;
revoke all on public.audit_snapshots from anon, authenticated;
grant select, insert, update, delete on public.audit_snapshots to service_role;
revoke all on function private.vg_iso(timestamptz), private.vg_es_clave(text), private.vg_modulos_vistos(jsonb),
  private.vg_matriz(uuid, uuid[]), private.vg_lista_delta(uuid, uuid[], int), private.vg_restar(uuid, uuid[], uuid[]),
  private.vg_versiones(uuid, timestamptz), private.vg_suma(uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.vg_snapshot_audit(uuid, uuid), public.vg_review_snapshot(uuid, uuid),
  public.vg_audit_delta(uuid, uuid, int), public.vg_evolution(uuid, int, int) from public, anon, authenticated;
grant execute on function public.vg_snapshot_audit(uuid, uuid), public.vg_review_snapshot(uuid, uuid),
  public.vg_audit_delta(uuid, uuid, int), public.vg_evolution(uuid, int, int) to service_role;
```

Notas para el BACK:

- Probado en PGlite 0.3.14 sobre 0001–0013 (ver cabecera). En Supabase se prueba igual que `revision.sql`:
  `supabase/tests/evolucion.sql` (§3.1) pegado detrás de la migración en la misma llamada, antes de aplicarla.
- `audit_snapshots` no lleva trigger de Realtime (0008b solo cubre cuatro tablas) y `code_reviews` tampoco tiene: los
  `uuid[]` no viajan a nadie.
- `findings_org_open_idx` cubre la lectura de los `open`; `id = any(...)` va por la clave primaria.
- Tamaño: una org con 100 abiertos guarda ~1,6 KB de ids por foto. El tope de 20.000 da 320 KB; si se pasa, el insert
  falla, el paso lo registra y sigue.
- `private.vg_versiones` declara `returns table (...)`: en una función `language sql` esos nombres no chocan con las
  columnas del cuerpo (en PGlite compila y responde; si el editor de Supabase protestara, renombrar las columnas de
  salida y sus usos en `vg_evolution`).

### 3.1 Pruebas SQL (`supabase/tests/evolucion.sql`, BACK)

Mismo patrón que `revision.sql`: orgs `idor-a` e `idor-b`, termina en ERROR a propósito y no deja filas. Compara lo que
obtiene con lo esperado: «RESULTADO OK …» o «RESULTADO DISTINTO: … ≠ esperado: …». Casos:

1. A (pasos supabase y repo `done`, cloudflare `failed`) con f1, f2, f5 y f6 abiertos → `first:true`, `open:4`,
   `modules_seen {codebase,supabase}`; E51 de A: `kept` vacío y en 0.
2. Entre A y B: f1 → `verified`, f5 → `fixed`, f6 → `ignored`, f3 nuevo, f2 sigue (todos con `scan_run_id` null) → B
   `new:1 (f3)`, `kept:1`, `fixed:2`, `fixed_checked:1`, `ignored:1`; matrices con esos números.
3. E51 de B: `previous` = A con su `score`, orden de E13 (la alta primero), horas con `Z`.
4. Repetir B → `repeated`, mismo `taken_at`. C después de B; repetir B otra vez no la mueve y C sigue apuntando a B.
5. D trae k1, k2 (claves) y g1. Antes de E: k1 pasa a `verified` (quitada sin rotar), k2 cambia de línea (otra fila,
   misma regla y huella) y g1 se borra → E `new:0`, `fixed:1 (k1)`, `fixed_checked:0`, `moved:1`, `gone:1`, k2b en
   «se mantiene» y la cuenta cuadra.
6. IDOR (`applied:false` / `found:false`), `sin_modulos`, `lighthouse`, `en_curso` y `sin_foto`.
7. Fotos de push: R1 primera (`open:3`, `kept:2`); f2 se marca a mano; R2 limpio → `fixed:1`, `fixed_checked:0`,
   `previous_review_id` = R1; repetir R2 → `repeated`; un PR, un push `running` y otra org → `applied:false`.
8. E52: el punto sin foto primero (`score 40`, `open:null`), A…E en orden, `truncated` con `limit 2`, totales de todo
   el periodo aunque se recorte, revisiones (R1, R2 y el PR con `delta` null; sin el push `failed`), un incidente,
   tiempo hasta comprobar sin claves, límites de `days` y `limit`, otra org.
9. Borrar A → su foto desaparece y E51 de B sigue con su delta y `previous` null.
10. Privilegios: anon y authenticated sin `select` en `audit_snapshots` y sin `execute` en las 4 RPC y las 8 piezas.

```sql
-- supabase/tests/evolucion.sql · 0015: fotos de auditoría (primera, resta de conjuntos, repetición, orden de la cadena,
-- claves quitadas sin rotar y claves que cambian de línea, filas borradas), E51 (kept vacío en la primera, horas con Z,
-- anterior borrada), fotos de push (primera, corregido entre pushes, repetición, PR y otra org), E52 (punto sin foto,
-- orden, recorte, totales, revisiones, incidentes, tiempo hasta comprobar sin claves, límites), IDOR y privilegios.
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0015 (o pegado detrás de la migración en la misma
-- llamada, para probarla antes de aplicarla). Usa las orgs idor-a e idor-b. Siempre termina en ERROR a propósito: la
-- excepción deshace todo (no queda ninguna fila de prueba). «RESULTADO OK …» = todo bien; «RESULTADO DISTINTO …» trae
-- lo obtenido y lo esperado.
create or replace function pg_temp.h(p_org uuid, p_mod text, p_rule text, p_sev text, p_res text, p_fp text)
returns uuid language sql as $$
  insert into public.findings (org_id, module, rule_id, severity, title, resource, evidence, dedupe_key)
  values (p_org, p_mod, p_rule, p_sev, 'Prueba ' || p_rule, p_res,
          case when p_fp is null then '{}'::jsonb else jsonb_build_object('fingerprint_short', p_fp) end,
          encode(sha256(convert_to('evo|' || p_org || '|' || p_rule || '|' || p_res, 'UTF8')), 'hex'))
  returning id
$$;
create or replace function pg_temp.aud(p_org uuid, p_kind text, p_steps jsonb, p_status text, p_score int)
returns uuid language sql as $$
  insert into public.scan_runs (org_id, kind, status, steps, score, finished_at)
  values (p_org, p_kind, p_status, p_steps, p_score, case when p_status in ('succeeded', 'failed') then now() end)
  returning id
$$;
create or replace function pg_temp.est(p_id uuid, p_status text) returns void language sql as $$
  update public.findings set status = p_status, verified_at = case when p_status = 'verified' then now() end
   where id = p_id
$$;
create or replace function pg_temp.rev(p_org uuid, p_cfg uuid, p_event text, p_status text, p_new jsonb)
returns uuid language sql as $$
  insert into public.code_reviews (org_id, config_id, event, branch, pr_number, base_sha, head_sha, status, new_findings,
                                   finished_at)
  values (p_org, p_cfg, p_event, 'main', case when p_event = 'pull_request' then 7 end, repeat('0', 39) || '1',
          left(encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 40), p_status, p_new, now())
  returning id
$$;
-- Total de una matriz módulo × severidad.
create or replace function pg_temp.tot(m jsonb) returns int language sql immutable as $$
  select coalesce(sum(v.value::int), 0)::int from jsonb_each(m) mo, jsonb_each_text(mo.value) v
$$;

do $$
declare
  o uuid := (select id from public.orgs where slug = 'idor-a');
  ob uuid := (select id from public.orgs where slug = 'idor-b');
  pasos jsonb := '[{"name":"supabase","status":"done"},{"name":"cloudflare","status":"failed"},'
                 '{"name":"repo","status":"done"},{"name":"puntaje","status":"done"}]';
  cn uuid := gen_random_uuid();
  cf uuid := gen_random_uuid();
  f1 uuid; f2 uuid; f3 uuid; f5 uuid; f6 uuid; k1 uuid; k2 uuid; k2b uuid; g1 uuid;
  viejo uuid; a uuid; b uuid; c uuid; d uuid; e uuid; sb uuid; x uuid; r1 uuid; r2 uuid; rp uuid;
  j jsonb; j1 jsonb; j2 jsonb;
  t1 timestamptz;
  n int;
  s text := '';
  esperado text := ''
    || '1 A:true/4/codebase,supabase kept=0/0'
    || ' | '
    || '2 B: new=1 kept=1 fixed=2 ign=1 chk=1 mat=1/1/2/1/2 f3=true'
    || ' | '
    || '3 delta: prev=true/30 kept=1 fixed=2 primero=high z=true/true'
    || ' | '
    || '4 rep=true new=1 t=true C.prev=B:true B.prev=A:true t=true'
    || ' | '
    || '5 D: new=3 E: new=0 kept=3 fixed=1 moved=1 gone=1 chk=0 k1=true k2b=true matfixed=1 cuadra=true'
    || ' | '
    || '6 idor=false/false sin_modulos/scan en_curso/sin_foto'
    || ' | '
    || '7 push: R1=true/3/2 R2=false/2/2/1/0/0 prev=true/true rep=true pr=false running=false otra_org=false'
    || ' | '
    || '8 evo: puntos=6 viejo=false/40/null orden=true trunc=false/true/2 tot=6/5/40/4/3/1/1/1 trunc_tot=6'
    || ' revs=3/null inc=1/1 mttr=1 z=true dias=1/90/6 otra_org=1'
    || ' | '
    || '9 borrar: foto=0 prev=null fixed=2'
    || ' | '
    || '10 priv: tabla=0 funciones=0';
begin
  -- 0) Una auditoría anterior a 0015: terminada, con puntaje 40 y sin foto
  viejo := pg_temp.aud(o, 'full_audit', pasos, 'succeeded', 40);

  -- 1) A: primera foto. Cloudflare falló: no está en modules_seen. E51 de la primera: kept vacío y en 0
  f1 := pg_temp.h(o, 'supabase', 'SB_RLS_DISABLED', 'high', 'public.a', null);
  f2 := pg_temp.h(o, 'codebase', 'CB_DEP_VULN', 'low', 'npm:a@1', null);
  f5 := pg_temp.h(o, 'codebase', 'CB_GITIGNORE_NO_ENV', 'medium', '.gitignore', null);
  f6 := pg_temp.h(o, 'supabase', 'SB_ADVISOR_X', 'low', 'public.b', null);
  a := pg_temp.aud(o, 'full_audit', pasos, 'succeeded', 30);
  j := public.vg_snapshot_audit(o, a);
  s := s || '1 A:' || (j->>'first') || '/' || (j->>'open') || '/'
         || (select array_to_string(x.modules_seen, ',') from public.audit_snapshots x where x.scan_run_id = a);
  j := public.vg_audit_delta(o, a, 50);
  s := s || ' kept=' || (j->'kept'->>'total') || '/' || pg_temp.tot(j->'counts'->'kept') || ' | ';

  -- 2) Entre A y B: f1 verified, f5 fixed (a mano), f6 ignored, f3 nuevo, f2 sigue. scan_run_id es null en todos: no
  -- depende de él
  perform pg_temp.est(f1, 'verified');
  perform pg_temp.est(f5, 'fixed');
  perform pg_temp.est(f6, 'ignored');
  f3 := pg_temp.h(o, 'codebase', 'CB_DEP_VULN', 'critical', 'npm:b@1', null);
  b := pg_temp.aud(o, 'full_audit', pasos, 'succeeded', 45);
  j := public.vg_snapshot_audit(o, b);
  s := s || '2 B: new=' || (j->>'new') || ' kept=' || (j->>'kept') || ' fixed=' || (j->>'fixed')
         || ' ign=' || (j->>'ignored')
         || (select ' chk=' || x.fixed_checked || ' mat=' || pg_temp.tot(x.counts->'new') || '/'
                    || pg_temp.tot(x.counts->'kept') || '/' || pg_temp.tot(x.counts->'fixed') || '/'
                    || pg_temp.tot(x.counts->'ignored') || '/' || pg_temp.tot(x.counts->'open')
                    || ' f3=' || (x.new_ids = array[f3])::text
               from public.audit_snapshots x where x.scan_run_id = b) || ' | ';

  -- 3) E51 de B: anterior = A con su puntaje; listas en el orden de E13; horas con Z
  j := public.vg_audit_delta(o, b, 50);
  s := s || '3 delta: prev=' || ((j->'previous'->>'scan_run_id')::uuid = a)::text || '/' || (j->'previous'->>'score')
         || ' kept=' || (j->'kept'->>'total') || ' fixed=' || jsonb_array_length(j->'fixed'->'items')
         || ' primero=' || (j->'fixed'->'items'->0->>'severity')
         || ' z=' || ((j->>'taken_at') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')::text
         || '/' || ((j->'previous'->>'finished_at') ~ 'Z$')::text || ' | ';

  -- 4) Repetir B: la misma foto (no se rehace). C después de B; repetir B otra vez no la mueve y C sigue apuntando a B
  t1 := (select x.taken_at from public.audit_snapshots x where x.scan_run_id = b);
  j := public.vg_snapshot_audit(o, b);
  s := s || '4 rep=' || coalesce(j->>'repeated', 'no') || ' new=' || (j->>'new')
         || ' t=' || ((select x.taken_at from public.audit_snapshots x where x.scan_run_id = b) = t1)::text;
  c := pg_temp.aud(o, 'supabase', '[{"name":"supabase","status":"done"},{"name":"puntaje","status":"done"}]',
                   'succeeded', 45);
  perform public.vg_snapshot_audit(o, c);
  perform public.vg_snapshot_audit(o, b);
  s := s || ' C.prev=B:' || ((select x.prev_scan_run_id from public.audit_snapshots x where x.scan_run_id = c) = b)::text
         || ' B.prev=A:' || ((select x.prev_scan_run_id from public.audit_snapshots x where x.scan_run_id = b) = a)::text
         || ' t=' || ((select x.taken_at from public.audit_snapshots x where x.scan_run_id = b) = t1)::text || ' | ';

  -- 5) Claves y filas borradas. D trae k1, k2 y g1. Antes de E: k1 se quita de HEAD sin rotar (la auditoría la da por
  -- verified): corregida, pero no «comprobada»; k2 cambia de línea (otra fila, misma regla y huella): se mantiene; g1 se
  -- cierra y la retención borra su fila: gone, ni corregido ni ignorado. open(E) = open(D) + new − fixed − ign − gone
  k1 := pg_temp.h(o, 'codebase', 'CB_SECRET_STRIPE_LIVE', 'critical', 'src/a.ts:1', 'aaaaaaaa');
  k2 := pg_temp.h(o, 'codebase', 'CB_SECRET_AWS', 'critical', 'src/b.ts:2', 'bbbbbbbb');
  g1 := pg_temp.h(o, 'supabase', 'SB_ADVISOR_Y', 'info', 'public.c', null);
  d := pg_temp.aud(o, 'full_audit', pasos, 'succeeded', 20);
  j := public.vg_snapshot_audit(o, d);
  s := s || '5 D: new=' || (j->>'new');
  perform pg_temp.est(k1, 'verified');
  perform pg_temp.est(k2, 'verified');
  k2b := pg_temp.h(o, 'codebase', 'CB_SECRET_AWS', 'critical', 'src/b.ts:9', 'bbbbbbbb');
  perform pg_temp.est(g1, 'fixed');
  delete from public.findings where id = g1;
  e := pg_temp.aud(o, 'full_audit', pasos, 'succeeded', 25);
  j := public.vg_snapshot_audit(o, e);
  s := s || ' E: new=' || (j->>'new') || ' kept=' || (j->>'kept') || ' fixed=' || (j->>'fixed')
         || ' moved=' || (j->>'moved') || ' gone=' || (j->>'gone')
         || (select ' chk=' || x.fixed_checked || ' k1=' || (x.fixed_ids = array[k1])::text
                    || ' k2b=' || (k2b = any(x.open_ids) and not k2b = any(x.new_ids))::text
                    || ' matfixed=' || pg_temp.tot(x.counts->'fixed')
                    || ' cuadra=' || (cardinality(x.open_ids) = (select cardinality(y.open_ids) from public.audit_snapshots y
                                                                   where y.scan_run_id = d)
                                      + cardinality(x.new_ids) - cardinality(x.fixed_ids) - cardinality(x.ignored_ids)
                                      - x.gone)::text
               from public.audit_snapshots x where x.scan_run_id = e) || ' | ';

  -- 6) IDOR, sin módulos, lighthouse, en_curso y sin_foto
  sb := pg_temp.aud(ob, 'full_audit', pasos, 'succeeded', 50);
  s := s || '6 idor=' || (public.vg_snapshot_audit(o, sb)->>'applied') || '/' || (public.vg_audit_delta(o, sb, 50)->>'found');
  x := pg_temp.aud(o, 'full_audit', '[{"name":"supabase","status":"failed"},{"name":"repo","status":"failed"}]',
                   'succeeded', null);
  s := s || ' ' || (public.vg_snapshot_audit(o, x)->>'reason');
  x := pg_temp.aud(o, 'lighthouse', '[]', 'succeeded', null);
  s := s || '/' || (public.vg_snapshot_audit(o, x)->>'reason');
  x := pg_temp.aud(o, 'full_audit', pasos, 'running', null);
  s := s || ' ' || (public.vg_audit_delta(o, x, 50)->>'reason') || '/' || (public.vg_audit_delta(o, viejo, 50)->>'reason')
         || ' | ';

  -- 7) Fotos de push (Codebase de toda la org). R1: primera; k2b es su nuevo. Se marca f2 a mano. R2: limpio, 1 corregido.
  -- Repetir R2 no la rehace. Un PR, un push que sigue running y otra org no hacen foto
  insert into public.connections (id, org_id, provider, kind, label, meta)
    values (cn, o, 'github', 'read', 'repo de prueba', '{"repo_full_name":"acme/evo","default_branch":"main"}');
  insert into public.code_review_configs (id, org_id, connection_id, branch, secret_sealed, secret_kid)
    values (cf, o, cn, 'main', '{"v":1,"kid":"v1","iv":"x","ct":"x","ivk":"x","wdek":"x"}', 'v1');
  r1 := pg_temp.rev(o, cf, 'push', 'done', jsonb_build_array(jsonb_build_object('finding_id', k2b,
          'rule_id', 'CB_SECRET_AWS', 'severity', 'critical', 'title', 'Prueba', 'resource', 'src/b.ts:9')));
  j1 := public.vg_review_snapshot(o, r1);
  perform pg_temp.est(f2, 'fixed');
  r2 := pg_temp.rev(o, cf, 'push', 'done', '[]');
  j2 := public.vg_review_snapshot(o, r2);
  rp := pg_temp.rev(o, cf, 'pull_request', 'done', '[]');
  x := pg_temp.rev(o, cf, 'push', 'running', '[]');
  s := s || '7 push: R1=' || (j1->>'first') || '/' || (j1->>'open') || '/' || (j1->>'kept')
         || ' R2=' || (j2->>'first') || '/' || (j2->>'open') || '/' || (j2->>'kept') || '/' || (j2->>'fixed')
         || '/' || (j2->>'fixed_checked') || '/' || (j2->>'ignored')
         || ' prev=' || ((j2->>'previous_review_id')::uuid = r1)::text || '/' || ((j2->>'previous_at') ~ 'Z$')::text
         || ' rep=' || (public.vg_review_snapshot(o, r2)->>'repeated')
         || ' pr=' || (public.vg_review_snapshot(o, rp)->>'applied')
         || ' running=' || (public.vg_review_snapshot(o, x)->>'applied')
         || ' otra_org=' || (public.vg_review_snapshot(ob, r1)->>'applied') || ' | ';
  update public.code_reviews set status = 'failed' where id = x;

  -- 8) E52: el punto sin foto va primero (score 40, open null); A, B, C, D y E en orden; recorte con limit 2; totales
  -- de todo el periodo; revisiones = R1, R2 y el PR (sin el failed), el PR con delta null; un incidente; el tiempo hasta
  -- comprobar cuenta f1 y no las claves; límites de days y limit
  insert into public.incidents (org_id, rule_ids, severity, title, resource, dedupe_key)
    values (o, '{CF_IP_FLOOD}', 'high', 'Prueba de incidente', 'ip:203.0.113.7', repeat('a', 64));
  j := public.vg_evolution(o, 30, 30);
  s := s || '8 evo: puntos=' || jsonb_array_length(j->'points')
         || ' viejo=' || (j->'points'->0->>'snapshot') || '/' || (j->'points'->0->>'score') || '/'
         || coalesce(j->'points'->0->>'open', 'null')
         || ' orden=' || ((j->'points'->1->>'scan_run_id')::uuid = a and (j->'points'->5->>'scan_run_id')::uuid = e)::text
         || ' trunc=' || (j->>'truncated') || '/' || (public.vg_evolution(o, 30, 2)->>'truncated')
         || '/' || jsonb_array_length(public.vg_evolution(o, 30, 2)->'points')
         || ' tot=' || (j->'totals'->>'versions') || '/' || (j->'totals'->>'snapshots') || '/'
         || (j->'totals'->>'score_first') || '/' || pg_temp.tot(j->'totals'->'new') || '/'
         || pg_temp.tot(j->'totals'->'fixed') || '/' || (j->'totals'->>'fixed_checked') || '/'
         || (j->'totals'->>'ignored') || '/' || (j->'totals'->>'gone')
         || ' trunc_tot=' || (public.vg_evolution(o, 30, 2)->'totals'->>'versions')
         || ' revs=' || jsonb_array_length(j->'reviews') || '/'
         || coalesce((select r->>'delta' from jsonb_array_elements(j->'reviews') r where r->>'event' = 'pull_request'), 'null')
         || ' inc=' || jsonb_array_length(j->'incidents') || '/' || (j->'incidents'->0->'counts'->>'high')
         || ' mttr=' || (j->'mttr'->>'verified')
         || ' z=' || ((j->'points'->0->>'at') ~ 'Z$' and (j->'reviews'->0->>'at') ~ 'Z$')::text
         || ' dias=' || (public.vg_evolution(o, 0, 0)->>'days') || '/' || (public.vg_evolution(o, 500, 500)->>'days')
         || '/' || jsonb_array_length(public.vg_evolution(o, 500, 500)->'points')
         || ' otra_org=' || jsonb_array_length(public.vg_evolution(ob, 30, 30)->'points') || ' | ';

  -- 9) Borrar A: su foto desaparece; E51 de B sigue con su delta y previous null
  delete from public.scan_runs where id = a;
  j := public.vg_audit_delta(o, b, 50);
  s := s || '9 borrar: foto=' || (select count(*) from public.audit_snapshots x where x.scan_run_id = a)
         || ' prev=' || coalesce(j->>'previous', 'null') || ' fixed=' || (j->'fixed'->>'total') || ' | ';

  -- 10) Privilegios: anon y authenticated no leen la tabla ni ejecutan las 4 RPC ni las 8 piezas
  select count(*) into n from (values ('anon'), ('authenticated')) ro(rol)
   where has_table_privilege(ro.rol, 'public.audit_snapshots', 'select');
  s := s || '10 priv: tabla=' || n;
  select count(*) into n from (values ('anon'), ('authenticated')) ro(rol),
         (values ('public.vg_snapshot_audit(uuid, uuid)'), ('public.vg_review_snapshot(uuid, uuid)'),
                 ('public.vg_audit_delta(uuid, uuid, int)'), ('public.vg_evolution(uuid, int, int)'),
                 ('private.vg_iso(timestamptz)'), ('private.vg_es_clave(text)'), ('private.vg_modulos_vistos(jsonb)'),
                 ('private.vg_matriz(uuid, uuid[])'), ('private.vg_lista_delta(uuid, uuid[], int)'),
                 ('private.vg_restar(uuid, uuid[], uuid[])'), ('private.vg_versiones(uuid, timestamptz)'),
                 ('private.vg_suma(uuid, timestamptz, text)')) f(fn)
   where has_function_privilege(ro.rol, f.fn, 'execute');
  s := s || ' funciones=' || n;

  if s = esperado then raise exception 'RESULTADO OK %', s; end if;
  raise exception 'RESULTADO DISTINTO: % ≠ esperado: %', s, esperado;
end $$;
```

---

## 4. Contrato y cambios en el Worker

### 4.1 Rutas nuevas y cambios

**E51 · `GET /api/orgs/:org/scans/:id/delta`** · user (todo miembro, también el anónimo de la demo) · P0 → `AuditDelta`

- `:id` que no es uuid → 404 «Auditoría no encontrada».
- Una RPC: `vg_audit_delta(p_org = c.get('orgId'), p_scan, p_limit = 50)`. `found:false` → 404 con el mismo mensaje
  (no dice si existe en otra org).
- `available:false` + `reason`:
  - `'en_curso'`: la auditoría sigue `queued`/`running` y aún no hay foto.
  - `'sin_foto'`: anterior a 0015, o no revisó ningún módulo.
- `available:true`: el cuerpo de la RPC sin la clave `found`.
- Error de la base → 500 `internal` «No pudimos leer los cambios de esta auditoría». Log `evolucion.delta_error` con
  `rid` y `code`.
- Sin zod en el Worker (§8). Sin cabeceras de caché.

**E52 · `GET /api/orgs/:org/evolution?days=30&limit=30`** · user · P0 → `Evolution`

- `days` entero 1–90 (por defecto 30); `limit` entero 1–60 (por defecto 30). Fuera de rango o no entero → 422
  `invalid_body` con `field_errors` (como el filtro de E13).
- Una RPC: `vg_evolution(p_org, p_days, p_limit)`. Si no trae `points` como array → 500 `internal`.
- `points` y `reviews` van de la más vieja a la más nueva; `totals` es del periodo entero aunque `truncated` sea true.
- Error de la base → 500 «No pudimos leer la evolución». Log `evolucion.lectura_error`.

Código para `apps/api/src/rutas/evolucion.ts` (nuevo; montar en `rutas/index.ts` tras `scans`):

```ts
import { Hono } from 'hono';
import { Id } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';
import { db } from '../lib/db.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';

// E51 y E52 (asignaciones/evolucion-entre-revisiones.md §4.1). Lectura para cualquier miembro (también el anónimo de la
// demo). Una RPC cada una y el JSON sale como lo arma la base (las horas ya vienen con Z): su forma la prueban
// supabase/tests/evolucion.sql y evolucion.test.ts. Re-validarlo con zod costaría ~8 ms de CPU la primera vez con 60
// puntos y 50 revisiones (§8).
export const evolucion = new Hono<AppEnv>();

const entero = (v: string | undefined, campo: string, min: number, max: number, def: number) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError('invalid_body', 'Filtro no válido', { field_errors: { [campo]: [`Entre ${min} y ${max}`] } });
  }
  return n;
};

evolucion.get('/orgs/:org/scans/:id/delta', async (c) => {
  const id = Id.safeParse(c.req.param('id'));
  if (!id.success) throw new ApiError('not_found', 'Auditoría no encontrada');
  const { data, error } = await db(c.env).rpc('vg_audit_delta', { p_org: c.get('orgId'), p_scan: id.data, p_limit: 50 });
  if (error) {
    log('error', 'evolucion.delta_error', { rid: c.get('rid'), code: error.code ?? null });
    throw new ApiError('internal', 'No pudimos leer los cambios de esta auditoría');
  }
  const { found, ...cuerpo } = (data ?? {}) as Record<string, unknown>;
  if (found !== true) throw new ApiError('not_found', 'Auditoría no encontrada');
  return c.json(cuerpo);
});

evolucion.get('/orgs/:org/evolution', async (c) => {
  const q = c.req.query();
  const days = entero(q.days, 'days', 1, 90, 30);
  const limit = entero(q.limit, 'limit', 1, 60, 30);
  const { data, error } = await db(c.env).rpc('vg_evolution', { p_org: c.get('orgId'), p_days: days, p_limit: limit });
  const r = (data ?? null) as { points?: unknown } | null;
  if (error || !r || !Array.isArray(r.points)) {
    log('error', 'evolucion.lectura_error', { rid: c.get('rid'), code: error?.code ?? 'forma' });
    throw new ApiError('internal', 'No pudimos leer la evolución');
  }
  return c.json(r);
});
```

**Foto de auditoría** en `pasoPuntaje` (`apps/api/src/scans/index.ts`; importar `log` de `../lib/log.ts`), justo antes
de `return { status: 'done' }`:

```ts
  // Foto para la evolución (0015; asignaciones/evolucion-entre-revisiones.md §2.1). Mejor esfuerzo: si falla, la
  // auditoría sigue y la siguiente foto compara con la última que exista. Una subpetición; las cuentas las hace la base.
  // Si puntaje se repite (reintento o finalizar), la RPC devuelve la foto que ya hay (repeated): no se rehace.
  const { data: foto, error: ef } = await admin.rpc('vg_snapshot_audit', { p_org: m.org_id, p_scan: m.scan_run_id });
  if (ef) log('warn', 'evolucion.foto_error', { code: ef.code ?? null });
  else {
    const f = (foto ?? {}) as Record<string, unknown>;
    const n = (k: string) => (typeof f[k] === 'number' ? f[k] : null);
    log('info', 'evolucion.foto', { applied: f.applied === true, first: f.first === true, repetida: f.repeated === true,
      reason: typeof f.reason === 'string' ? f.reason : null, open: n('open'), nuevos: n('new'), se_mantienen: n('kept'),
      corregidos: n('fixed'), ignorados: n('ignored'), movidos: n('moved'), ya_no_existen: n('gone') });
  }
```

**Foto de push** en `apps/api/src/revision/pasos.ts`. Función nueva:

```ts
// Foto de Codebase de un push (0015; asignaciones/evolucion-entre-revisiones.md §2.2). Mejor esfuerzo: nunca cambia el
// resultado del paso. Idempotente (la RPC devuelve la que ya hay), así que yaReclamada la puede volver a pedir.
async function fotoPush(admin: ReturnType<typeof db>, m: MsgRevision) {
  try {
    const { data, error } = await admin.rpc('vg_review_snapshot', { p_org: m.org_id, p_review: m.review_id });
    if (error) { log('warn', 'evolucion.foto_push_error', { review: m.review_id, code: error.code ?? null }); return; }
    const f = obj(data);
    const n = (k: string) => (typeof f[k] === 'number' ? f[k] : null);
    log('info', 'evolucion.foto_push', { review: m.review_id, applied: f.applied === true, first: f.first === true,
      repetida: f.repeated === true, abiertos: n('open'), siguen: n('kept'), corregidos: n('fixed') });
  } catch {
    log('warn', 'evolucion.foto_push_error', { review: m.review_id, code: 'red' });
  }
}
```

- En `revisar()`, después del bloque `if (res.applied !== true) { … return 'ack'; }` y ANTES de
  `if (res.alert_state === 'pending')`: `if (rev.event === 'push') await fotoPush(admin, m);`. Subpeticiones del diff:
  ≤ 18 de 40 (era ≤ 17).
- En `yaReclamada()`: el `select` pasa a `'status, alert_state, event'` y, si `f.status === 'done' && f.event ===
  'push'`, `await fotoPush(db(env), m)` antes de mirar el aviso. Cubre la entrega que cayó entre `vg_review_findings` y
  la foto (+1 subpetición, solo en una reentrega).
- La función (2) también toca `revisar()` (`bloqueo-merge-criticos.md` §2.5): la foto va primero, antes de encolar el
  aviso y el paso `estado`.

**E45 con `delta`** (`apps/api/src/rutas/revision.ts`; importar `CodeReviewDelta` de `@vanguard/contracts`):

- `COLUMNAS_REVISION` suma `, delta` al final. 0015 tiene que estar aplicada antes de desplegar este Worker: sin la
  columna, PostgREST rechaza la consulta entera y la tarjeta desaparece.
- En `aRevision`, dentro del objeto que valida `CodeReview.safeParse`, tras `finished_at`:
  `delta: CodeReviewDelta.safeParse(f.delta).success ? f.delta : null,` (un `delta` raro no tumba la fila).

### 4.2 Código zod EXACTO para `packages/contracts/src/api.ts`

Todo lo que usa (`Id`, `Ts`, `Severity`, `Module`, `RuleId`, `FindingStatus`, `ScanKind`) ya se importa ahí. Sin
cambios en `comun.ts`. Tres trozos; solo se agregan campos opcionales y tipos nuevos (la regla de `api.ts` desde el
sábado 11:00).

**(a)** Justo ANTES de `export const CodeReview = z.object(` (tiene que ir antes: `CodeReview` lo usa):

```ts
// Foto de Codebase al cerrar una revisión de push (0015; asignaciones/evolucion-entre-revisiones.md §2.2). open =
// abiertos de Codebase de TODA la org al cerrar; kept = open menos los nuevos de este push; fixed = abiertos en la foto
// del push anterior de la org que ya no lo están (fixed o verified; ignored aparte); fixed_checked = de esos, los que
// comprobó una auditoría, sin claves (que una clave ya no esté en el código no prueba que se rotó). first:true = primer
// push con foto: no hay con qué comparar y fixed, fixed_checked e ignored van en 0.
export const CodeReviewDelta = z.object({ first: z.boolean(), previous_review_id: Id.nullable(), previous_at: Ts.nullable(),
  open: z.number().int().min(0), kept: z.number().int().min(0), fixed: z.number().int().min(0),
  fixed_checked: z.number().int().min(0), ignored: z.number().int().min(0) });
export type CodeReviewDelta = z.infer<typeof CodeReviewDelta>;
```

**(b)** En `CodeReview`, la última línea (`created_at: Ts, finished_at: Ts.nullable() });`) pasa a:

```ts
  created_at: Ts, finished_at: Ts.nullable(),
  delta: CodeReviewDelta.nullable().optional() }); // E45 con 0015; null en un PR, en un push de antes de 0015 o sin foto
```

Con la función (2) (`bloqueo-merge-criticos.md` §4.2 (d)) quedan los dos campos opcionales:
`created_at: Ts, finished_at: Ts.nullable(),` / `gate: MergeGateReview.optional(),` /
`delta: CodeReviewDelta.nullable().optional() });`.

**(c)** Al final del archivo:

```ts
// ── Evolución entre revisiones (E51–E52; asignaciones/evolucion-entre-revisiones.md) ───────────────────────────────
// Hallazgos por severidad (zod 4: las 5 claves) y por módulo × severidad (las 4 × 5 claves).
export const PorSeveridad = z.record(Severity, z.number().int().min(0));
export type PorSeveridad = z.infer<typeof PorSeveridad>;
export const MatrizHallazgos = z.record(Module, PorSeveridad);
export type MatrizHallazgos = z.infer<typeof MatrizHallazgos>;
// Un hallazgo de una lista del delta con su estado de AHORA (los conteos son los de la foto): un corregido que volvió a
// salir trae status 'open'; un nuevo que ya se arregló, 'fixed' o 'verified'.
export const DeltaItem = z.object({ finding_id: Id, module: Module, rule_id: RuleId, severity: Severity,
  title: z.string().max(200), resource: z.string().max(300), status: FindingStatus });
export type DeltaItem = z.infer<typeof DeltaItem>;
// total = cuántos hay; items = los 50 primeros en el orden de E13 (un hallazgo ya borrado cuenta en total y no sale).
export const DeltaLista = z.object({ total: z.number().int().min(0), items: z.array(DeltaItem).max(50) });
export type DeltaLista = z.infer<typeof DeltaLista>;
// La auditoría con la que se compara. null si es la primera foto o si la anterior ya se borró (retención de 90 días).
// finished_at null si la anterior aún no había cerrado (la foto se toma en el paso puntaje, antes de resumen_ia).
export const DeltaAnterior = z.object({ scan_run_id: Id, kind: ScanKind, finished_at: Ts.nullable(),
  score: z.number().int().min(0).max(100).nullable() });
export type DeltaAnterior = z.infer<typeof DeltaAnterior>;
// E51 · GET /api/orgs/:org/scans/:id/delta · user. available:false → 'en_curso' (aún sin foto) o 'sin_foto' (auditoría
// anterior a 0015, o que no pudo revisar ningún módulo). first:true → primera foto de la org: no hay con qué comparar;
// solo cuenta open y lo demás va en 0 y vacío. moved = claves (regla + huella) que solo cambiaron de línea: cuentan en
// kept, nunca en new ni en fixed. gone = abiertos en la anterior cuya fila ya no existe (retención de 0008): no cuentan
// como corregidos ni como ignorados. En total: open = open anterior + new − fixed − ignored − gone.
export const AuditDelta = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), scan_run_id: Id, reason: z.enum(['en_curso', 'sin_foto']) }),
  z.object({ available: z.literal(true), scan_run_id: Id, taken_at: Ts, first: z.boolean(),
    score: z.number().int().min(0).max(100).nullable(),
    modules_seen: z.array(Module).max(4),    // módulos cuyo paso terminó bien en ESTA auditoría
    previous: DeltaAnterior.nullable(),
    counts: z.object({ open: MatrizHallazgos, new: MatrizHallazgos, kept: MatrizHallazgos, fixed: MatrizHallazgos,
      ignored: MatrizHallazgos }),
    fixed_checked: z.number().int().min(0),  // corregidos que una auditoría comprobó (verified), sin contar claves
    moved: z.number().int().min(0), gone: z.number().int().min(0),
    new: DeltaLista, kept: DeltaLista, fixed: DeltaLista, ignored: DeltaLista }),
]);
export type AuditDelta = z.infer<typeof AuditDelta>;
// Una versión = una auditoría con foto (sea cual sea su status) o una terminada con puntaje anterior a 0015
// (snapshot:false: open, new y fixed van null y el punto solo entra en la gráfica del puntaje). at = cuándo se tomó la
// foto (sin foto, cuándo terminó): es el orden de la cadena. score sale de scan_runs.
export const EvolutionPoint = z.object({ scan_run_id: Id, kind: ScanKind, at: Ts,
  score: z.number().int().min(0).max(100).nullable(), modules_seen: z.array(Module).max(4),
  snapshot: z.boolean(), first: z.boolean(),
  open: MatrizHallazgos.nullable(), new: MatrizHallazgos.nullable(), fixed: MatrizHallazgos.nullable(),
  ignored: z.number().int().min(0), gone: z.number().int().min(0), fixed_checked: z.number().int().min(0) });
export type EvolutionPoint = z.infer<typeof EvolutionPoint>;
// Revisión de código terminada (push a la rama vigilada o pull request): new = sus hallazgos NUEVOS por severidad;
// delta = la foto de Codebase del push (null en un PR, en un push anterior a 0015 o si la foto falló).
export const EvolutionReview = z.object({ review_id: Id, event: z.enum(['push', 'pull_request']),
  pr_number: z.number().int().positive().nullable(), at: Ts, head_sha7: z.string().regex(/^[0-9a-f]{7}$/),
  new: PorSeveridad, partial: z.boolean(), delta: CodeReviewDelta.nullable() });
export type EvolutionReview = z.infer<typeof EvolutionReview>;
// Incidentes (ataques) por día de Caracas en que empezaron y por severidad. Solo los días con alguno.
export const EvolutionIncidentDay = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), counts: PorSeveridad });
export type EvolutionIncidentDay = z.infer<typeof EvolutionIncidentDay>;
// Totales de TODO el periodo, calculados en la base aunque points venga recortado: versions = versiones del periodo;
// snapshots = de ellas, las que tienen foto; score_first = puntaje de la más vieja; new, fixed, fixed_checked, ignored y
// gone = sumas de las fotos del periodo con first:false.
export const EvolutionTotals = z.object({ versions: z.number().int().min(0), snapshots: z.number().int().min(0),
  score_first: z.number().int().min(0).max(100).nullable(), new: MatrizHallazgos, fixed: MatrizHallazgos,
  fixed_checked: z.number().int().min(0), ignored: z.number().int().min(0), gone: z.number().int().min(0) });
export type EvolutionTotals = z.infer<typeof EvolutionTotals>;
// E52 · GET /api/orgs/:org/evolution?days=30&limit=30 · user. points y reviews de la más vieja a la más nueva (las
// `limit` versiones y las 50 revisiones más recientes del periodo); truncated: el periodo tiene más versiones que
// `limit` (la UI usa totals y dice «últimas N auditorías» en las gráficas). mttr: hallazgos que una auditoría dio por
// corregidos (verified) en el periodo, horas de first_seen_at a verified_at; no cuentan los marcados a mano (sin hora)
// ni las claves (que ya no estén en el código no prueba que se rotaron).
export const Evolution = z.object({ days: z.number().int().min(1).max(90),
  points: z.array(EvolutionPoint).max(60), truncated: z.boolean(), totals: EvolutionTotals,
  reviews: z.array(EvolutionReview).max(50), incidents: z.array(EvolutionIncidentDay).max(91),
  mttr: z.object({ verified: z.number().int().min(0), hours_avg: z.number().min(0).nullable(),
    hours_median: z.number().min(0).nullable() }) });
export type Evolution = z.infer<typeof Evolution>;
```

### 4.3 Lo que NO cambia en el contrato

- `ScanRun`, `ScanStep`, `ScanKind`, `Overview`: igual. No se añade ninguna fila a `scan_runs`, así que el Resumen,
  `estado/modulo.ts` y la cobertura siguen leyendo la última auditoría como hoy.
- `Finding`, `FindingStatus` y `FindingPatch`: igual.
- `CodeReview` (E45): solo el campo opcional `delta`. Un BACK sin 0015 sigue cumpliendo el contrato.

### 4.4 Fixtures nuevos

`packages/contracts/src/fixtures/ids.ts` (añadir al final). `CR_REV_JUEVES` usa `…021`: `…022` es `CR_REV_PR_BLOQUEADO`
de la función (2) (`RECONCILIACION-CONTRATO.md`).

```ts
// ── Evolución entre revisiones ────────────────────────────────────────────────
// Auditorías completas de martes a viernes (la del sábado es SCAN_AUDITORIA; la del martes es anterior a 0015 y solo
// tiene puntaje), el push del jueves que subió un posible secreto y los dos hallazgos que el sábado ya no están
// abiertos (uno comprobado por la auditoría y otro marcado a mano). CR_REV_JUEVES no es …022: ese id es
// CR_REV_PR_BLOQUEADO (bloqueo-merge-criticos.md).
export const SCAN_EV_MAR = '5a1c0000-0000-4000-8000-000000000005';
export const SCAN_EV_MIE = '5a1c0000-0000-4000-8000-000000000002';
export const SCAN_EV_JUE = '5a1c0000-0000-4000-8000-000000000003';
export const SCAN_EV_VIE = '5a1c0000-0000-4000-8000-000000000004';
export const CR_REV_JUEVES = 'c4000000-0000-4000-8000-000000000021';
export const F_SB_INDICE = 'f0000000-0000-4000-8000-00000000000f';
export const F_CB_GENERICO = 'f0000000-0000-4000-8000-000000000010';
// Hora de cada versión = la de su foto (paso puntaje). En el fixture coincide con el cierre de la auditoría; en
// producción va unos segundos antes (resumen_ia). La del martes, sin foto, es su cierre.
export const T_EV_MAR = '2026-10-20T18:02:30.000Z';
export const T_EV_MIE = '2026-10-21T18:03:20.000Z';
export const T_EV_JUE = '2026-10-22T18:02:50.000Z';
export const T_CR_JUEVES = '2026-10-22T19:10:00.000Z';
export const T_EV_VIE = '2026-10-23T18:04:05.000Z';
// Hora de la foto de Codebase de cada push (vg_review_snapshot, al cerrar el diff).
export const T_SNAP_JUEVES = '2026-10-22T19:10:02.600Z';
export const T_SNAP_LIMPIA = '2026-10-24T18:31:42.300Z';
```

`packages/contracts/src/fixtures/evolucion.ts` (nuevo). La historia cuadra con `hallazgos.ts`, `auditoria.ts`,
`resumen.ts`, `revision.ts` e `incidentes.ts`: el último punto tiene los 12 abiertos de hoy y el puntaje 20 del Resumen;
los puntajes salen de `score()` de core (20 → 42 → 57 → 20); la foto del push de las 19:20Z son los 7 de Codebase de
`hallazgos.ts` más la clave de Stripe. `revision.ts` no se toca: `deltasRevision` va aparte y el router del FRONT lo
pone en cada revisión (también en `codeReviewStateBloqueo` de la función (2)).

```ts
// Evolución entre revisiones (E51, E52 y la foto de Codebase de cada push en E45). La historia: «Tienda Demo» audita
// cada día. La del martes es anterior a 0015 (solo puntaje, sin foto); la del miércoles es la primera foto. El jueves y
// el viernes corrigió cosas (puntaje 20 → 42 → 57) y el sábado una regresión (RLS apagada en pedidos, un .env subido con
// dos claves y una dependencia crítica) lo bajó a 20. El delta del sábado (auditDelta, la auditoría de auditoria.ts) sale
// de hallazgos.ts: 7 nuevos, 5 se mantienen, 2 corregidos (uno comprobado por la auditoría y otro marcado a mano) y 1
// ignorado. Los comprobados del jueves y del viernes no son claves (una clave que desaparece no cuenta como comprobada).
// Pushes: el del jueves subió el posible secreto (primera foto de push); los dos del sábado son los de revision.ts y
// deltasRevision es su foto (el router de fixtures del FRONT la pone como `delta` en cada revisión de E45).
// hallazgosCorregidos va aparte de `findings` (como hallazgoRevision) para no mover el Resumen, el export ni la wiki; el
// router de fixtures del FRONT lo añade a la lista de la org para que ?finding= los abra.
// Dato de prueba: en hallazgos.ts todos tienen first_seen_at del sábado; aquí los «se mantienen» ya estaban el viernes.
// No se toca hallazgos.ts (lo usan el export y la wiki).
import type {
  AuditDelta, CodeReviewDelta, DeltaItem, Evolution, EvolutionIncidentDay, EvolutionPoint, EvolutionReview, Finding,
  MatrizHallazgos,
} from '../api.ts';
import type { Module, Severity } from '../comun.ts';
import { scanDone } from './auditoria.ts';
import { findings } from './hallazgos.ts';
import {
  CONN_SUPABASE, CR_REV_JUEVES, CR_REV_LIMPIA, CR_REV_SECRETO, F_CB_DEP_IGNITION, F_CB_DEP_JQUERY, F_CB_DEP_LODASH,
  F_CB_ENV, F_CB_GENERICO, F_CB_GITIGNORE, F_CB_POSTGRES, F_CB_SERVICE_ROLE, F_SB_ADV_CODIGOS, F_SB_ADV_DUP,
  F_SB_ADV_EVENTOS, F_SB_INDICE, F_SB_POLICY, F_SB_RLS, F_SB_RPC, SCAN_EV_JUE, SCAN_EV_MAR, SCAN_EV_MIE, SCAN_EV_VIE,
  T_CR_JUEVES, T_EV_JUE, T_EV_MAR, T_EV_MIE, T_EV_VIE, T_SCAN_FIN, T_SNAP_JUEVES, T_SNAP_LIMPIA,
} from './ids.ts';
import { incidents } from './incidentes.ts';
import { codeReviewState } from './revision.ts';

const VISTOS: Module[] = ['supabase', 'cloudflare', 'codebase'];   // los pasos de «Auditar todo» (Rendimiento no entra)

export const hallazgosCorregidos = [
  { id: F_SB_INDICE, module: 'supabase', rule_id: 'SB_ADVISOR_UNUSED_INDEX', severity: 'low', confirmed: false,
    origin: 'provider', title: 'Índice sin usar en public.pedidos_tmp', resource: 'public.pedidos_tmp_creado_idx',
    evidence: { lint: 'unused_index', nivel: 'INFO', categorias: ['PERFORMANCE'], esquema: 'public', tabla: 'pedidos_tmp' },
    has_fix_prompt: false, fix_model: null, status: 'verified', status_reason: 'no reapareció en la auditoría',
    suspected_injection: false, scan_run_id: SCAN_EV_VIE, connection_id: CONN_SUPABASE, first_seen_at: T_EV_MIE,
    last_seen_at: T_EV_VIE, verified_at: T_SCAN_FIN },
  { id: F_CB_GENERICO, module: 'codebase', rule_id: 'CB_SECRET_GENERIC', severity: 'medium', confirmed: false,
    origin: 'rule', title: 'Posible secreto en el código', resource: 'src/config/correo.ts:7',
    evidence: { fuente: 'github', sha: 'a41c9d2', path: 'src/config/correo.ts', line: 7, preview: 'smtp…',
      fingerprint_short: '5d0e7a13', ubicaciones: [{ path: 'src/config/correo.ts', line: 7, origen: 'head' }] },
    has_fix_prompt: false, fix_model: null, status: 'fixed', status_reason: 'Rotada la clave del correo',
    suspected_injection: false, scan_run_id: null, connection_id: null, first_seen_at: T_CR_JUEVES,
    last_seen_at: T_CR_JUEVES, verified_at: null },
] satisfies Finding[];

const SEV = ['critical', 'high', 'medium', 'low', 'info'] as const satisfies readonly Severity[];
const MODULOS = ['supabase', 'cloudflare', 'codebase', 'performance'] as const satisfies readonly Module[];
type Fila5 = [number, number, number, number, number];   // critical, high, medium, low, info
const fila = (v: Fila5) => Object.fromEntries(SEV.map((s, i) => [s, v[i]!])) as Record<Severity, number>;
const matriz = (m: Partial<Record<Module, Fila5>>): MatrizHallazgos =>
  Object.fromEntries(MODULOS.map((k) => [k, fila(m[k] ?? [0, 0, 0, 0, 0])])) as MatrizHallazgos;
const contar = (xs: readonly { module: Module; severity: Severity }[]): MatrizHallazgos => {
  const m = matriz({});
  for (const x of xs) m[x.module][x.severity] += 1;
  return m;
};
const sumar = (ms: readonly MatrizHallazgos[]): MatrizHallazgos => {
  const m = matriz({});
  for (const x of ms) for (const k of MODULOS) for (const s of SEV) m[k][s] += x[k][s];
  return m;
};
const enModulo = (m: MatrizHallazgos, k: Module) => SEV.reduce((a, s) => a + m[k][s], 0);

const porId = new Map<string, Finding>([...findings, ...hallazgosCorregidos].map((f) => [f.id, f]));
const item = (id: string): DeltaItem => {
  const f = porId.get(id)!;
  return { finding_id: f.id, module: f.module, rule_id: f.rule_id, severity: f.severity, title: f.title,
    resource: f.resource, status: f.status };
};
const lista = (ids: string[]) => ({ total: ids.length, items: ids.map(item) });

// En el orden de E51 (el de E13): severidad, confirmed, last_seen_at y id.
const NUEVOS = [F_CB_ENV, F_CB_SERVICE_ROLE, F_CB_POSTGRES, F_CB_DEP_IGNITION, F_SB_RLS, F_SB_RPC, F_CB_GITIGNORE];
const SE_MANTIENEN = [F_CB_DEP_LODASH, F_SB_POLICY, F_CB_DEP_JQUERY, F_SB_ADV_EVENTOS, F_SB_ADV_DUP];
const CORREGIDOS = [F_CB_GENERICO, F_SB_INDICE];
const IGNORADOS = [F_SB_ADV_CODIGOS];

export const auditDelta = {
  available: true, scan_run_id: scanDone.id, taken_at: T_SCAN_FIN, first: false, score: scanDone.score,
  modules_seen: VISTOS,
  previous: { scan_run_id: SCAN_EV_VIE, kind: 'full_audit', finished_at: T_EV_VIE, score: 57 },
  counts: {
    open: contar([...NUEVOS, ...SE_MANTIENEN].map(item)), new: contar(NUEVOS.map(item)),
    kept: contar(SE_MANTIENEN.map(item)), fixed: contar(CORREGIDOS.map(item)), ignored: contar(IGNORADOS.map(item)),
  },
  fixed_checked: 1, moved: 0, gone: 0,
  new: lista(NUEVOS), kept: lista(SE_MANTIENEN), fixed: lista(CORREGIDOS), ignored: lista(IGNORADOS),
} satisfies AuditDelta;

// Versiones de martes a sábado. Las que tienen foto cuadran en total: open[k] = open[k-1] + new[k] − fixed[k] −
// ignored[k] − gone[k]. Puntajes con score() de core: 20 (crítico confirmado) → 42 → 57 → 20. Comprobados (ninguno es
// una clave): el jueves el crítico de Supabase y un .gitignore; el viernes una política y una dependencia alta.
const punto = (scan_run_id: string, at: string, score: number, open: MatrizHallazgos, extra?: Partial<EvolutionPoint>) =>
  ({ scan_run_id, kind: 'full_audit', at, score, modules_seen: VISTOS, snapshot: true, first: false, open,
    new: matriz({}), fixed: matriz({}), ignored: 0, gone: 0, fixed_checked: 0, ...extra }) satisfies EvolutionPoint;

const JUEVES = matriz({ supabase: [0, 1, 1, 3, 1], codebase: [0, 2, 1, 0, 0] });
const puntos: EvolutionPoint[] = [
  // Anterior a 0015: el puntaje sale de scan_runs; sin foto no hay conteos.
  { scan_run_id: SCAN_EV_MAR, kind: 'full_audit', at: T_EV_MAR, score: 20, modules_seen: VISTOS, snapshot: false,
    first: false, open: null, new: null, fixed: null, ignored: 0, gone: 0, fixed_checked: 0 },
  punto(SCAN_EV_MIE, T_EV_MIE, 20, matriz({ supabase: [1, 1, 1, 3, 1], codebase: [0, 2, 2, 0, 0] }), { first: true }),
  punto(SCAN_EV_JUE, T_EV_JUE, 42, JUEVES,
    { fixed: matriz({ supabase: [1, 0, 0, 0, 0], codebase: [0, 0, 1, 0, 0] }), fixed_checked: 2 }),
  punto(SCAN_EV_VIE, T_EV_VIE, 57, matriz({ supabase: [0, 1, 0, 3, 1], codebase: [0, 1, 2, 0, 0] }),
    { new: matriz({ codebase: [0, 0, 1, 0, 0] }), fixed: matriz({ supabase: [0, 0, 1, 0, 0], codebase: [0, 1, 0, 0, 0] }),
      fixed_checked: 2 }),
  punto(scanDone.id, T_SCAN_FIN, 20, auditDelta.counts.open,
    { new: auditDelta.counts.new, fixed: auditDelta.counts.fixed, ignored: IGNORADOS.length, fixed_checked: 1 }),
];

// Foto de Codebase de cada push (toda la org). Jueves: los 3 de Codebase de la auditoría del jueves más el posible
// secreto que trajo el push (primera foto). Sábado 18:31Z (limpio): los 7 de Codebase de hallazgos.ts siguen; desde el
// jueves se corrigieron 2 (la dependencia alta, comprobada el viernes, y el posible secreto, marcado a mano el sábado).
// Sábado 19:20Z: la clave de Stripe (hallazgoRevision) es nueva y los 7 siguen.
const abiertosCodebase = findings.filter((f) => f.status === 'open' && f.module === 'codebase').length;
const deltaJueves = { first: true, previous_review_id: null, previous_at: null, open: enModulo(JUEVES, 'codebase') + 1,
  kept: enModulo(JUEVES, 'codebase'), fixed: 0, fixed_checked: 0, ignored: 0 } satisfies CodeReviewDelta;
export const deltasRevision: Record<string, CodeReviewDelta> = {
  [CR_REV_LIMPIA]: { first: false, previous_review_id: CR_REV_JUEVES, previous_at: T_SNAP_JUEVES,
    open: abiertosCodebase, kept: abiertosCodebase, fixed: 2, fixed_checked: 1, ignored: 0 },
  [CR_REV_SECRETO]: { first: false, previous_review_id: CR_REV_LIMPIA, previous_at: T_SNAP_LIMPIA,
    open: abiertosCodebase + 1, kept: abiertosCodebase, fixed: 0, fixed_checked: 0, ignored: 0 },
};

const revisiones: EvolutionReview[] = [
  { review_id: CR_REV_JUEVES, event: 'push', pr_number: null, at: T_CR_JUEVES, head_sha7: 'a41c9d2',
    new: fila([0, 0, 1, 0, 0]), partial: false, delta: deltaJueves },
  ...[...codeReviewState.recent].reverse().map((r) => ({ review_id: r.id, event: 'push' as const, pr_number: null,
    at: r.created_at, head_sha7: r.head_sha.slice(0, 7), new: r.counts, partial: r.partial,
    delta: deltasRevision[r.id] ?? null })),
];

// Incidentes por día de Caracas (UTC−4, sin horario de verano) en que empezaron: los dos de incidentes.ts, del sábado.
const diaCaracas = (t: string) => new Date(Date.parse(t) - 4 * 3_600_000).toISOString().slice(0, 10);
const porDia = new Map<string, Record<Severity, number>>();
for (const i of incidents) {
  const d = diaCaracas(i.started_at);
  const c = porDia.get(d) ?? fila([0, 0, 0, 0, 0]);
  c[i.severity] += 1;
  porDia.set(d, c);
}
const incidentesPorDia: EvolutionIncidentDay[] = [...porDia].sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([day, counts]) => ({ day, counts }));

const comparables = puntos.filter((p) => p.snapshot && !p.first);
export const evolution = {
  days: 30,
  points: puntos,
  truncated: false,
  // Sin recorte, las sumas de las fotos de points (la base las calcula sobre todo el periodo).
  totals: {
    versions: puntos.length, snapshots: puntos.filter((p) => p.snapshot).length, score_first: puntos[0]!.score,
    new: sumar(comparables.map((p) => p.new!)), fixed: sumar(comparables.map((p) => p.fixed!)),
    fixed_checked: comparables.reduce((a, p) => a + p.fixed_checked, 0),
    ignored: comparables.reduce((a, p) => a + p.ignored, 0), gone: comparables.reduce((a, p) => a + p.gone, 0),
  },
  reviews: revisiones,
  incidents: incidentesPorDia,
  // 5 comprobados en el periodo (ninguno es una clave): 2 el jueves (~24 h), 2 el viernes (~48 h) y el índice el sábado
  // (~72 h).
  mttr: { verified: 5, hours_avg: 43.2, hours_median: 48 },
} satisfies Evolution;
```

`fixtures/index.ts`: `import { auditDelta, deltasRevision, evolution, hallazgosCorregidos } from './evolucion.ts';` (tras
el de `./conexiones.ts`) y una línea al final de `fixtures`: `auditDelta, evolution, hallazgosCorregidos,
deltasRevision,`.

### 4.5 Pruebas del contrato (`contracts.test.ts`, ORQUESTADOR)

- `CLAVES_ESPERADAS` suma `'auditDelta', 'evolution', 'hallazgosCorregidos', 'deltasRevision'`.
- `casos` suma `['auditDelta', c.AuditDelta, fx.auditDelta]`, `['evolution', c.Evolution, fx.evolution]`,
  `['hallazgosCorregidos', z.array(c.Finding), fx.hallazgosCorregidos]` y
  `['deltasRevision', z.record(c.Id, c.CodeReviewDelta), fx.deltasRevision]`.
- Este bloque antes de `describe('fixtures', …)` (es el que pasó en la copia: 60 en verde):

```ts
// Evolución (E51, E52 y la foto de cada push en E45): los fixtures cuentan la misma historia que hallazgos.ts,
// auditoria.ts, resumen.ts, revision.ts e incidentes.ts.
describe('evolución', () => {
  const SEV = c.Severity.options;
  const MOD = c.Module.options;
  const total = (m: c.MatrizHallazgos | null) => (m ? MOD.reduce((a, k) => a + SEV.reduce((b, s) => b + m[k][s], 0), 0) : NaN);
  const suma = (r: Record<c.Severity, number>) => SEV.reduce((a, s) => a + r[s], 0);
  const esClave = (rule: string) => rule.startsWith('CB_SECRET_') || rule === 'CB_ENV_COMMITTED';
  const d = fx.auditDelta;
  const evo = fx.evolution;
  const todos: c.EvolutionPoint[] = evo.points;
  const pts = todos.filter((p) => p.snapshot);
  const ultimo = pts[pts.length - 1]!;

  it('open del último punto = hallazgos open de hallazgos.ts; puntaje y conteos = Resumen', () => {
    const abiertos = fx.findings.filter((f) => f.status === 'open');
    for (const k of MOD) for (const s of SEV) {
      expect(ultimo.open![k][s], `${k}.${s}`).toBe(abiertos.filter((f) => f.module === k && f.severity === s).length);
    }
    expect(ultimo.score).toBe(fx.overview.score);
    expect(ultimo.scan_run_id).toBe(fx.scanDone.id);
    expect(todos[todos.length - 1]).toBe(ultimo);
    for (const s of SEV) expect(MOD.reduce((a, k) => a + ultimo.open![k][s], 0)).toBe(fx.overview.counts[s]);
  });

  it('cada punto con foto cuadra con el anterior: open = open anterior + new − fixed − ignored − gone', () => {
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1]!, pts[i]!];
      expect(total(b.open), b.scan_run_id).toBe(total(a.open) + total(b.new) - total(b.fixed) - b.ignored - b.gone);
      expect(b.first).toBe(false);
    }
    expect(pts[0]!.first).toBe(true);
    expect(total(pts[0]!.new) + total(pts[0]!.fixed)).toBe(0);
    for (let i = 1; i < todos.length; i++) expect(Date.parse(todos[i]!.at)).toBeGreaterThan(Date.parse(todos[i - 1]!.at));
    for (const p of todos.filter((x) => !x.snapshot)) {
      expect([p.open, p.new, p.fixed, p.first, p.ignored, p.gone, p.fixed_checked]).toEqual([null, null, null, false, 0, 0, 0]);
    }
  });

  it('el delta cuadra: listas = conteos, kept = open − new, comprobados sin claves y = último punto', () => {
    if (!d.available) throw new Error('auditDelta debe estar disponible');
    for (const k of ['new', 'kept', 'fixed', 'ignored'] as const) {
      expect(d[k].total, k).toBe(total(d.counts[k]));
      expect(d[k].items.length, k).toBe(d[k].total);
    }
    for (const k of MOD) for (const s of SEV) {
      expect(d.counts.kept[k][s], `${k}.${s}`).toBe(d.counts.open[k][s] - d.counts.new[k][s]);
    }
    expect(d.counts.open).toEqual(ultimo.open);
    expect([d.ignored.total, d.gone, d.fixed_checked]).toEqual([ultimo.ignored, ultimo.gone, ultimo.fixed_checked]);
    expect(d.fixed_checked).toBe(d.fixed.items.filter((x) => x.status === 'verified' && !esClave(x.rule_id)).length);
    expect(d.previous?.scan_run_id).toBe(pts[pts.length - 2]!.scan_run_id);
    expect(d.previous?.score).toBe(pts[pts.length - 2]!.score);
    for (const x of [...d.new.items, ...d.kept.items]) expect(x.status).toBe('open');
  });

  it('totals = sumas de las fotos del periodo (sin recorte); incidentes = los de incidentes.ts', () => {
    expect(evo.truncated).toBe(false);
    const comp = pts.filter((p) => !p.first);
    expect([evo.totals.versions, evo.totals.snapshots, evo.totals.score_first]).toEqual([todos.length, pts.length, todos[0]!.score]);
    expect(total(evo.totals.new)).toBe(comp.reduce((a, p) => a + total(p.new), 0));
    expect(total(evo.totals.fixed)).toBe(comp.reduce((a, p) => a + total(p.fixed), 0));
    expect(evo.totals.fixed_checked).toBe(comp.reduce((a, p) => a + p.fixed_checked, 0));
    expect(evo.totals.ignored).toBe(comp.reduce((a, p) => a + p.ignored, 0));
    for (let i = 1; i < evo.incidents.length; i++) expect(evo.incidents[i]!.day > evo.incidents[i - 1]!.day).toBe(true);
    for (const s of SEV) {
      expect(evo.incidents.reduce((a, x) => a + x.counts[s], 0), s).toBe(fx.incidents.filter((i) => i.severity === s).length);
    }
  });

  it('revisiones de más vieja a más nueva; la foto de cada push encadena con la del push anterior', () => {
    const r = evo.reviews;
    for (let i = 1; i < r.length; i++) expect(Date.parse(r[i]!.at)).toBeGreaterThan(Date.parse(r[i - 1]!.at));
    for (const x of fx.codeReviewState.recent) {
      expect(r.find((y) => y.review_id === x.id)?.head_sha7).toBe(x.head_sha.slice(0, 7));
      expect(r.find((y) => y.review_id === x.id)?.delta).toEqual(fx.deltasRevision[x.id]);
    }
    const pushes = r.filter((x) => x.event === 'push' && x.delta);
    expect(pushes[0]!.delta!.first).toBe(true);
    for (let i = 0; i < pushes.length; i++) {
      const x = pushes[i]!.delta!;
      expect(x.kept, pushes[i]!.review_id).toBe(x.open - suma(pushes[i]!.new));   // kept = open − nuevos de este push
      if (x.first) expect([x.fixed, x.fixed_checked, x.ignored, x.previous_review_id]).toEqual([0, 0, 0, null]);
      else expect(x.previous_review_id).toBe(pushes[i - 1]!.review_id);
      expect(x.fixed_checked).toBeLessThanOrEqual(x.fixed);
    }
    const ultimaRev = pushes[pushes.length - 1]!.delta!;
    expect(ultimaRev.open).toBe(fx.findings.filter((f) => f.status === 'open' && f.module === 'codebase').length + 1);
  });

  it('CodeReview acepta delta, delta null y sin delta (un BACK de antes de 0015)', () => {
    const [primera] = fx.codeReviewState.recent;
    expect(c.CodeReview.safeParse(primera).success).toBe(true);
    expect(c.CodeReview.safeParse({ ...primera, delta: null }).success).toBe(true);
    expect(c.CodeReview.safeParse({ ...primera, delta: fx.deltasRevision[primera!.id] }).success).toBe(true);
    expect(c.CodeReview.safeParse({ ...primera, delta: { first: false } }).success).toBe(false);
  });

  it('AuditDelta acepta available:false con su motivo y rechaza un motivo desconocido', () => {
    const base = { available: false, scan_run_id: fx.scanDone.id };
    expect(c.AuditDelta.safeParse({ ...base, reason: 'en_curso' }).success).toBe(true);
    expect(c.AuditDelta.safeParse({ ...base, reason: 'otro' }).success).toBe(false);
  });

  it('una matriz sin un módulo o sin una severidad no pasa (zod 4 exige todas las claves)', () => {
    if (!d.available) throw new Error('auditDelta debe estar disponible');
    const { performance: _, ...sinModulo } = d.counts.open;
    expect(c.MatrizHallazgos.safeParse(sinModulo).success).toBe(false);
    const { info: __, ...sinInfo } = d.counts.open.supabase;
    expect(c.MatrizHallazgos.safeParse({ ...d.counts.open, supabase: sinInfo }).success).toBe(false);
  });

  it('las horas van con Z (la base las da con to_char) y un día de incidente es AAAA-MM-DD', () => {
    const conZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    for (const p of todos) expect(p.at).toMatch(conZ);
    for (const x of evo.reviews) expect(x.at).toMatch(conZ);
    if (d.available) expect(d.taken_at).toMatch(conZ);
    expect(c.EvolutionIncidentDay.safeParse({ day: '24-10-2026', counts: evo.incidents[0]!.counts }).success).toBe(false);
  });
});
```

---

## 5. Cambios por paquete

| Paquete | Archivos | Qué |
|---|---|---|
| contracts (ORQUESTADOR) | `src/api.ts`, `src/fixtures/{ids,evolucion,index}.ts`, `src/contracts.test.ts`, `src/database.types.ts` | §4.2, §4.4, §4.5; tipos regenerados tras 0015 |
| core | — | Sin cambios (§0, fila «core»; la línea del WhatsApp es M1, §9.4) |
| supabase (BACK) | `migrations/0015_evolucion.sql`, `tests/evolucion.sql` | §3, §3.1 (copiar) |
| api (BACK) | `scans/index.ts` (+ `log`), `revision/pasos.ts` (`fotoPush`), `rutas/revision.ts` (E45 `delta`), `rutas/evolucion.ts` (nuevo), `rutas/index.ts` (montar tras `scans`), `rutas/evolucion.test.ts`, `scans/index.test.ts` o `jobs.test.ts`, `revision/pasos.test.ts`, `rutas/revision.test.ts` | §4.1 |
| web (FRONT) | `lib/consultas.ts`, `lib/realtime.ts`, `lib/evolucion.ts` (+ test), `modulos/codebase/TarjetaRevisionCodigo.tsx`, `modulos/auditoria/Cambios.tsx` (+ test) y `PaginaAuditoria.tsx`, `modulos/evolucion/{PaginaEvolucion,Graficas}.tsx` (+ test), `app/router.tsx`, `lib/nav.ts`, `app/AppShell.tsx`, `lib/guias.ts`, `lib/atajos.ts`, `lib/fixtures/router.ts` (+ test) | §6 |

---

## 6. UI (FRONT)

### 6.1 Consultas

- `useDeltaAuditoria(org, id, habilitado)`: clave `['org', org, 'scan', id, 'delta']` (el evento de `scan_runs` ya
  invalida el prefijo `scan`). `enabled` solo con la auditoría `succeeded`. `staleTime: 60_000`. Valida con
  `AuditDelta.parse`, como E45. Sondeo de 10 s solo si llega `en_curso`; un 404 no se sondea y oculta el bloque (E51 aún
  sin desplegar).
- `useEvolucion(org, dias)`: clave `['org', org, 'evolution', dias]`, `staleTime: 60_000`, sin sondeo, sin `limit` (30).
  Valida con `Evolution.parse`. 404 → la página dice «La evolución llega pronto».
- E45: `delta` llega dentro de `CodeReview` por `useRevisionCodigo`, sin consulta nueva.
- `lib/realtime.ts`: `'evolution'` se suma a `MAPA.scan_runs`, `MAPA.findings` y `MAPA.notifications` (un push escribe
  hallazgos y su aviso cuelga de `notifications`), y a `TODO`. Un push limpio no escribe ni lo uno ni lo otro: la página
  se refresca al volver a la pestaña (TanStack lo hace por defecto y `main.tsx` no lo apaga) y la tarjeta sigue con su
  sondeo de 5 s / 30 s.

### 6.2 Fila de cada push (`modulos/codebase/TarjetaRevisionCodigo.tsx`)

Solo en revisiones `event === 'push'` con `delta`. Sin `delta` (null o ausente: BACK sin 0015 o foto fallida), nada.
El texto lo arma `lineaFoto(revision)` de `lib/evolucion.ts` (con pruebas):

| `delta` | Texto |
|---|---|
| `first:true` | «{kept} siguen abiertos en Codebase · desde el próximo push verás los corregidos» |
| `first:false` | «{nuevos} nuevo(s) · {kept} siguen abiertos · {fixed} corregido(s) desde el push anterior»; « ({fixed_checked} comprobado(s) por una auditoría)» si > 0; « · {ignored} ignorado(s)» si > 0 |

`nuevos` = suma de `counts`. Con dos o más conexiones GitHub (`varias-codebases.md`) se añade «en Codebase (todos los
repos)». Una sola nota al pie de la tarjeta: «Entre dos pushes, "corregido" es lo que alguien marcó o lo que comprobó una
auditoría: un push no ve lo que se quita.» Solo números: nada que sanear. Convive con la chapa de la función (2) en la
misma fila.

### 6.3 Auditoría: «Cambios desde la auditoría anterior» (`modulos/auditoria/Cambios.tsx`)

Va en `Corrida` entre el puntaje y el Resumen, solo con la auditoría terminada.

| Estado | Qué se pinta |
|---|---|
| 404 o error | Nada (el resto de la página sigue igual) |
| `en_curso` | «Comparando con la auditoría anterior…» |
| `sin_foto` | «Esta auditoría es anterior al historial o no pudo revisar ningún módulo: no hay cambios que mostrar.» |
| `first:true` | «Es la primera auditoría con historial. Desde la próxima verás qué es nuevo, qué se mantiene y qué se corrigió.» |
| Con anterior | Cabecera, cifras, fila por módulo y listas |

Cabecera: «Frente a la auditoría del {cuando(previous.finished_at)} · puntaje {previous.score} → {score}». Con
`previous.finished_at` null: «Frente a la auditoría anterior · …». Con `previous: null` y `first:false`: «Frente a una
auditoría que ya se borró (se guardan 90 días)».

Cifras (`Cifra`): «Nuevos» (rol `mal` si hay crítica o alta nueva, con su acción «Ver»), «Se mantienen», «Corregidos»
(sub «{fixed_checked} comprobados por la auditoría»). «Ignorados: {n}» en texto pequeño. Debajo, solo si son > 0: «{moved}
clave(s) cambió/cambiaron de línea y sigue(n) abierta(s): cuenta(n) en "Se mantienen"» y «{gone} hallazgo(s) ya no
existe(n) (se borraron por antigüedad): no cuentan como corregidos».

Por módulo: una fila por módulo con algo distinto de 0. Si ese módulo no está en `modules_seen`: «{Módulo}: no se
revisó en esta auditoría; sus cambios vienen de pushes o de marcas a mano.»

Listas (`SectorPlegable`): «Nuevos ({total})» abierta; «Corregidos ({total})» y «Se mantienen ({total})» plegadas;
«Ignorados» solo si hay. Fila: `ChapaSeveridad`, título y recurso (con `sinBidi` y `<bdi dir="ltr">`, como «Hallazgos
abiertos»), nombre del módulo y «Ver» → `?finding=<id>` (abre `DetalleEnPanel`). Se pintan 10; «Ver todos» despliega
hasta 50; si `total > items.length`: «y {n} más».

Etiqueta de estado actual (mapa cerrado en `etiquetaCorregido`; lo demás, sin etiqueta). Clave = `rule_id` que empieza
por `CB_SECRET_` o es `CB_ENV_COMMITTED` (`esClave`, la misma regla que `private.vg_es_clave`):

| Lista | `status` | Etiqueta |
|---|---|---|
| Corregidos | `verified` y no es clave | «Comprobado» (rol `bien`) |
| Corregidos | `verified` y es clave | «Ya no está en el código · rota la clave» (rol `aviso`) |
| Corregidos | `fixed` | «Marcado a mano» (neutra) |
| Corregidos | `open` | «Volvió a aparecer» (rol `aviso`) |
| Nuevos | `fixed` o `verified` | «Ya corregido» (neutra) |

Viewer y anónimo: mismo bloque (no hay acciones de escritura).

### 6.4 Página «Evolución» (`modulos/evolucion/PaginaEvolucion.tsx`)

Rutas y riel (P0):

- `app/router.tsx`: `{ path: 'evolution', lazy: pagina(() => import('@/modulos/evolucion/PaginaEvolucion')), errorElement: <ErrorRuta /> }`.
- `lib/nav.ts`: tras `audit`, `{ id: 'evolution', nombre: 'Evolución', icono: TrendingUp, grupo: 'respuesta',
  descripcion: 'Cómo cambió tu seguridad entre revisiones: nuevos, corregidos y puntaje en el tiempo.' }`.
- `app/AppShell.tsx`: `{item('evolution')}` tras `{item('audit')}`.
- `lib/guias.ts` (`GUIAS` exige la clave): «¿Cómo leer la evolución?» con estos pasos:
  1. «Cada punto es una auditoría terminada. El puntaje es el que tenía en ese momento.»
  2. «Nuevos: abiertos que no estaban abiertos en la auditoría anterior. Se mantienen: siguen abiertos. Corregidos:
     estaban abiertos y ya no; "comprobado" si la auditoría ya no los encontró, "marcado a mano" si alguien lo marcó.»
  3. «Una clave que ya no está en el código no está arreglada hasta que la rotas: por eso no cuenta como comprobada.»
  4. «Un módulo que no se pudo revisar deja sus hallazgos como estaban: no cuentan como corregidos.»
  5. «Cada push a main muestra lo nuevo que trajo, lo que sigue abierto y lo corregido desde el push anterior.»
- `lib/atajos.ts`: `e: 'evolution'` (la letra está libre).

Contenido P0, de arriba abajo:

1. `BarraModulo` «Evolución» y un grupo de botones (el `Grupo` de `PaginaRendimiento`): «Periodo» (7 días · 30 días ·
   90 días; 30 por defecto).
2. Cifras (de `totals` y del último punto; nunca sumando `points`, que puede venir recortado):
   - «Puntaje en la última auditoría»; sub «{±n} desde la primera del periodo» (`totals.score_first`). No es el del
     Resumen, que se mueve al marcar algo sin re-auditar: por eso la etiqueta dice «en la última auditoría».
   - «Abiertos al cerrarla»; sub «{c} críticos».
   - «Nuevos en {días} días» (`totals.new`).
   - «Corregidos en {días} días» (`totals.fixed`); sub «{totals.fixed_checked} comprobados».
   - «Tiempo hasta comprobar la corrección»: media (`1 d 19 h`); sub «mediana {m} · {n} hallazgos».
3. **Puntaje por auditoría** (`modulos/evolucion/Graficas.tsx`, patrón de `GraficaComparativa`: `ResponsiveContainer`,
   `isAnimationActive={false}`, `accessibilityLayer={false}`, contenedor `role="img"` con `aria-label` que resume los
   datos; ejes y avisos solo con fechas y números, nunca títulos de hallazgos): `LineChart` con todos los puntos;
   dominio 0–100; `ReferenceLine` en 50 y 80 (bandas de `banda()`: rojo ≤ 49, ámbar ≤ 79, verde ≥ 80). Eje X: «mié 21 ·
   14:03» en hora de Caracas (`Intl` con `America/Caracas`), `minTickGap`. Con `truncated`: el título dice «últimas
   {points.length} auditorías».
4. «Versiones» (tabla desde `md`, tarjetas debajo): auditoría (fecha y tipo: «Completa», «Solo Supabase»…), puntaje,
   abiertos (C/A/M/B), nuevos, corregidos y «Ver cambios» → `/o/:org/audit/:scanId`. Punto sin foto: «—» y «Anterior al
   historial».
5. Notas al pie: «Rendimiento no entra en las auditorías: su historia está en Rendimiento.» · «El tiempo hasta comprobar
   solo cuenta lo que una auditoría dio por corregido; no cuenta lo marcado a mano (no guarda la hora) ni las claves
   (que ya no estén no prueba que se rotaron).»

P1, en este orden (mismo patrón de gráficas):

- **Nuevos y corregidos**: `BarChart` con nuevos hacia arriba (`--mal`) y corregidos hacia abajo (valor negativo,
  `--bien`), `ReferenceLine` en 0, solo puntos con foto y `first:false`. El aviso muestra valores absolutos.
- «Revisiones de código»: hora, commit corto (mono, `bdi`), «Push» o «PR #n», «Limpio» o «{n} nuevos · peor:
  {severidad}», la línea de §6.2 si hay `delta`, «Parcial» si `partial`. «Ver» → `/o/:org/codebase?revision=<id>`.
- **Abiertos por severidad**: `BarChart` apilado (`stackId`) con los puntos con foto; crítica `--mal`, alta `--aviso`,
  media `--info`, baja e info `--chart-1`. Con el filtro «Módulo» (Todo · Supabase · Cloudflare · Codebase): el puntaje
  y el tiempo son globales y lo dicen («de toda la organización»).
- **Incidentes por día** (`incidents`): barras apiladas por severidad, un día por barra (los días sin incidentes en 0).

Estados: 0 puntos → `Vacio` «Aún no hay auditorías en este periodo. Cada auditoría que termine queda aquí.» con
«Auditar todo» (deshabilitado con `SOLO_LECTURA` para viewer y anónimo). Un solo punto con foto → cifras y «Con la
próxima auditoría verás qué cambió». Error → `ErrorBloque` con «Reintentar».

`lib/evolucion.ts` (puro, con pruebas). P0: `totalMatriz(m)`, `cifras(evo)`, `seriePuntaje(points)`,
`etiquetaVersion(at)`, `horas(h)` («43 h» → «1 d 19 h»), `esClave(rule_id)`, `etiquetaCorregido(item)` y
`lineaFoto(revision)`. P1: `porSeveridad(m, modulo)`, `serieAbiertos(points, modulo)`, `serieCambios(points, modulo)`
(corregidos en negativo) y `serieIncidentes(incidents, dias)`.

### 6.5 Modo fixtures y viewer anónimo

`lib/fixtures/router.ts`:

- `GET …/scans/:id/delta` (antes de la ruta de `scans/:id`; las dos están ancladas y no se pisan):
  - id de `fx.scanDone` en la org de la demo → `fx.auditDelta`; la primera vez añade `fx.hallazgosCorregidos` a la lista
    de hallazgos de la org (como `hallazgoRevision`).
  - Auditoría simulada de la sesión: `en_curso` mientras corre; al terminar, un delta frente a `fx.scanDone`: 0 nuevos,
    los 12 abiertos en «se mantienen», 0 corregidos, `moved: 0`, `gone: 0`. En una org sin datos de la demo:
    `first:true` con todo en 0.
  - Otra org o id desconocido → 404.
- `GET …/evolution` → `fx.evolution` en la org de la demo; en una org vacía, `{ days, points: [], truncated: false,
  totals: { versions: 0, snapshots: 0, score_first: null, new: <matriz en 0>, fixed: <matriz en 0>, fixed_checked: 0,
  ignored: 0, gone: 0 }, reviews: [], incidents: [], mttr: { verified: 0, hours_avg: null, hours_median: null } }`.
  `days` y `limit` se ignoran.
- `GET …/code-review` (E45): cada revisión de `recent` sale con `delta: fx.deltasRevision[r.id] ?? null` (sirve igual
  sobre `codeReviewStateBloqueo` de la función (2)). Una revisión que simule el router, con `delta: null`.

Viewer anónimo: E51, E52 y E45 son GET y pasan `anonReadOnly`. Ven lo mismo que en Hallazgos (títulos y recursos). El
único botón (Auditar todo en el estado vacío) va deshabilitado.

---

## 7. Seguridad

| Amenaza | Control |
|---|---|
| Ver la evolución de otra org (IDOR) | `p_org` sale de `orgMember` (`c.get('orgId')`), nunca del cuerpo ni de la URL. Las RPC filtran por `org_id`: una auditoría ajena da `found:false` → 404 uniforme; una revisión ajena, `applied:false` |
| Leer las fotos sin pasar por la API | RLS activa sin políticas en `audit_snapshots`; sin grants a anon/authenticated (0008h); `code_reviews` ya era solo del servidor (0013). RPC con `revoke … from public, anon, authenticated` y `grant execute` solo a `service_role`; `security definer` con `search_path = ''` y nombres calificados |
| Secretos o evidencia en las respuestas | Las listas llevan título y recurso (ya redactados por `aFila` y el cable trampa de `findings`), nunca `evidence` ni `fingerprint_short`: la huella solo se compara dentro de la base (`vg_restar`). `delta` son números. Los logs solo llevan conteos y códigos |
| Afirmar una corrección que no ocurrió | «Corregido» = salió del conjunto `open`. Un paso caído o el bug de `p_scan` nulo dejan el hallazgo en «se mantiene». «Comprobado» solo con `verified` y nunca para una clave («Ya no está en el código · rota la clave»). Una clave que cambió de línea se mantiene. Una fila borrada va aparte. Lo `fixed` dice «Marcado a mano». Un módulo no revisado lo dice. Entre pushes, la UI explica que el push no ve lo que se quita |
| Texto malicioso en títulos o recursos | La UI los pinta con `sinBidi` y `<bdi>`, como Hallazgos. Las gráficas y la línea del push no llevan textos de hallazgos |
| La IA decide algo | No hay IA: la regla es la resta de conjuntos en SQL |
| Consumo excesivo | `days` ≤ 90, `limit` ≤ 60, revisiones ≤ 50, días de incidentes ≤ 91, listas ≤ 50, `open_ids` ≤ 20.000. `RL_API` de siempre. Una RPC por petición |
| Una foto rota tumba la auditoría o la revisión | Las dos fotos son de mejor esfuerzo: `puntaje` y `revisar()` no lanzan por ellas |
| Datos que crecen sin fin | La foto de auditoría se borra con su `scan_runs` y la de push con su `code_reviews` (retención de 0008): sin trabajo nuevo de limpieza |
| Realtime filtra datos | Ni `audit_snapshots` ni `code_reviews` tienen trigger de difusión |
| Escritura en sistemas del cliente | Ninguna. Todo es lectura y escritura de la propia base |

El ORQUESTADOR añade a `THREAT_MODEL.md` las filas «IDOR en la evolución» y «Afirmar una corrección que no ocurrió»
solo cuando funcione en producción (T02-14).

---

## 8. Costo en Workers Free

Medido hoy en Node 24.13 (el portátil de Giovanni) sobre `fx.evolution` inflado al peor caso:

| Qué | Bytes | CPU |
|---|---|---|
| E52 con 60 puntos, 50 revisiones con `delta` y 91 días de incidentes | 88 KB | `JSON.parse` 0,4 ms. `Evolution.safeParse`: 8,2 ms la primera vez y 2,5 ms después, CON JIT (en Workers, sin JIT, más). Por eso no se valida en el Worker |
| E51 con 4 listas de 50 | 75 KB | `JSON.parse` < 0,5 ms (medido en la versión anterior; la forma no cambió salvo dos números) |

| Pieza | Subpeticiones | CPU del Worker |
|---|---|---|
| `puntaje` | +1 (la RPC): ~8 de 40 en total | ≈ 0: la respuesta es un objeto de 10 números |
| Paso `diff` de un push | +1 (la RPC): ≤ 18 de 40 | ≈ 0 |
| E45 | Igual (una columna más en la misma consulta) | +1 `safeParse` de un objeto de 8 campos por revisión (≤ 10) |
| E51 | 1 RPC + las del middleware de siempre | < 1 ms |
| E52 | 1 RPC + las del middleware | < 1 ms (30 puntos por defecto) |

En Postgres: lecturas de los `open` por índice, restas de arrays de ≤ 2.000 elementos, cinco matrices por clave
primaria y, en E52, 40 subconsultas pequeñas sobre las fotos del periodo; milisegundos. Sin crons ni colas nuevas.

---

## 9. Reparto

### 9.0 Orden y horario (sáb 24 y dom 25-oct, hora de Caracas)

El orden entre funciones lo fija el ORQUESTADOR por escrito en O2. Lo que pide (1) es esto: su **tramo A** va
**antes** de empezar (2) y (3), porque el historial (de auditorías y de pushes) solo empieza cuando 0015 y las dos fotos
están en producción (§2.5): cada auditoría o push anterior, incluidos los ensayos de (2) y (3) de esta noche, se pierde
para los conteos.

| Hora | Qué debe estar | Si no |
|---|---|---|
| ~20:00 | O1 (contrato y fixtures en `main`) y O2 (encargos con este orden) | El BACK empieza B1 igual (no depende del contrato); el FRONT espera O1 |
| ~21:15 | **Tramo A** en producción: B1–B5 (0015, las dos fotos y E45 con `delta`). Desde aquí cada auditoría y cada push dejan foto | Lo que se audite o empuje antes no deja historial |
| Tras el tramo A | G1 (no necesita E51/E52: se comprueba con los logs y la fila del push en Codebase) | Se repite G1 el domingo a primera hora |
| Como tarde dom 03:00 | **Tramo B** en producción: B6–B7 (E51 y E52) | Sin él, el FRONT oculta el bloque de la auditoría y la página (404) y queda la fila del push |
| Antes de congelar el FRONT (dom 07:00) | F1–F7 en `main` | Se publica sin la entrada del riel (la ruta sigue por URL) |
| Dom 10:00 | T02-14: entra al pitch y a `project-description.md` solo si funcionó en el ensayo | Va como hoja de ruta |

Carga de la noche, según los cuatro documentos de hoy (P0): BACK ≈ 2 h (1) + 4 h 25 (2, `bloqueo-merge-criticos.md`
§10.2) + 4 h 45 (3, `modo-bajo-ataque.md`, «P0 total») + 5 h (`varias-codebases.md` §9.2) ≈ 16 h; FRONT ≈ 2 h 15 (1) +
2 h 30 (2) + 2 h 25 (3) + 4 h 30 (varias codebases) ≈ 11 h 40. Entre las 20:00 y la congelación de las 07:00 hay 11 h:
no cabe todo y el ORQUESTADOR tiene que recortar. Dentro de (1), el orden de recorte es: P1 del FRONT → tramo B (E51/E52)
→ F4 (el bloque de la auditoría). El tramo A y la fila del push (F3) son lo último que se recorta: son lo que contesta el
pedido literal en cada push.

### 9.1 ORQUESTADOR

| # | Qué | Archivos | Prioridad | Estimación |
|---|---|---|---|---|
| O1 | Contrato §4.2 (tres trozos), fixtures §4.4 y pruebas §4.5; `pnpm --filter @vanguard/contracts test` (60 en verde) y `typecheck`; commit en `main`. Con (2) en el mismo `api.ts`: la última línea de `CodeReview` lleva `gate` y `delta` | `packages/contracts/src/{api.ts,fixtures/ids.ts,fixtures/evolucion.ts,fixtures/index.ts,contracts.test.ts}` | P0 · primero | 15 min (el código ya pasó) |
| O2 | Mandar las asignaciones a BACK y FRONT con este documento (junto con las de (2) y (3)) y el ORDEN de §9.0 por escrito | — | P0 | 5 min |
| O3 | Regenerar `database.types.ts` tras 0015 | `packages/contracts/src/database.types.ts` | P0 | 10 min |
| O4 | Pasar a Giovanni la propuesta M1 (§9.4) para quien lleva la mensajería | — | P1 | 2 min |
| O5 | `PLAN_MAESTRO.md` §15.4 (E51, E52, E45 `delta`), `ARQUITECTURA.md` (tabla, columnas y pasos `puntaje` y `diff`), `THREAT_MODEL.md` (§7), `demo/guion.md` (según D1) y «Estado de la entrega» de `project-description.md`: solo lo que funcione en producción | docs | P1 | 25 min |
| — | `wrangler.jsonc`: sin cambios | — | — | — |

### 9.2 BACK (≈ 2 h de P0: tramo A 1 h 20 + tramo B 40 min)

Pruebas con Vitest; nada de ejecutables (`pnpm --filter @vanguard/api test`).

| # | Qué | Archivos | Prioridad | Estimación |
|---|---|---|---|---|
| B1 | 0015 (§3) y `tests/evolucion.sql` (§3.1), copiados de aquí. `list_migrations`, la prueba pegada detrás de la migración (tiene que dar «RESULTADO OK») y aplicar | `supabase/migrations/0015_evolucion.sql`, `supabase/tests/evolucion.sql` | P0 · tramo A · primero | 25 min |
| B2 | Foto de auditoría en `pasoPuntaje` (§4.1) | `apps/api/src/scans/index.ts`, `scans/index.test.ts` o `jobs.test.ts` | P0 · tramo A | 15 min |
| B3 | Foto de push: `fotoPush` en `revisar()` y en `yaReclamada()` (§4.1) | `apps/api/src/revision/pasos.ts`, `revision/pasos.test.ts` | P0 · tramo A | 20 min |
| B4 | E45 con `delta` (§4.1) | `apps/api/src/rutas/revision.ts`, `rutas/revision.test.ts` | P0 · tramo A | 10 min |
| B5 | Despliegue del tramo A: 0015 ya aplicada, luego el Worker. En producción: un push con log `evolucion.foto_push` (`applied:true`) y E45 con `delta`; una auditoría con log `evolucion.foto` (`applied:true`) | — | P0 · tramo A | 10 min |
| B6 | E51 y E52 (§4.1) | `apps/api/src/rutas/evolucion.ts`, `rutas/index.ts`, `rutas/evolucion.test.ts` | P0 · tramo B | 30 min |
| B7 | Despliegue del tramo B; E51 y E52 con `curl` y sesión, y con el anónimo de la demo | — | P0 · tramo B | 10 min |

Pruebas mínimas:

- **B1:** las de §3.1 («RESULTADO OK»).
- **B2:**
  - `puntaje` llama a `vg_snapshot_audit` con `{p_org, p_scan}` DESPUÉS de escribir `score`.
  - Si la RPC da error, `puntaje` devuelve `done` y registra `evolucion.foto_error`.
  - Si falla escribir `score`, lanza antes y no llama a la RPC.
  - El doble devuelve `{data:null, error:null}` para RPC desconocidas: una prueba que compare `doble.rpcs` entera puede
    necesitar sumar `vg_snapshot_audit`.
- **B3:**
  - Push que cierra (`applied:true`): llama a `vg_review_snapshot` con `{p_org, p_review}` ANTES de encolar el aviso.
  - PR: no la llama. CAS perdido (`applied:false`): no la llama.
  - Si la RPC da error o lanza: el paso sigue igual (`ack`, el aviso se encola) y registra `evolucion.foto_push_error`.
  - Reentrega de un push ya `done` (`yaReclamada`): la vuelve a pedir.
- **B4:** E45 con `delta` válido lo devuelve; con `delta` null o malformado devuelve `delta: null` sin perder la fila;
  la salida pasa `CodeReviewState.safeParse`.
- **B6:**
  - E51: id que no es uuid → 404; `found:false` → 404; `available:false` pasa tal cual; `available:true` sale sin
    `found` y pasa `AuditDelta.safeParse` en la prueba; error de la base → 500.
  - E52: valores por defecto 30/30; `days=0`, `days=91`, `limit=61` y `days=abc` → 422 con `field_errors`; RPC sin
    `points` → 500; la salida del doble pasa `Evolution.safeParse`.
  - `p_org` sale del middleware aunque la URL traiga otra org (IDOR).
  - Viewer y anónimo → 200 en las dos.

### 9.3 FRONT (≈ 2 h 15 de P0, antes de congelar)

| # | Qué | Archivos | Prioridad | Estimación |
|---|---|---|---|---|
| F1 | Consultas E51/E52 y `realtime.ts` (§6.1) | `lib/consultas.ts`, `lib/realtime.ts` | P0 | 10 min |
| F2 | Router de fixtures: E51, E52, `delta` en E45 y `hallazgosCorregidos` (§6.5) | `lib/fixtures/router.ts`, `router.test.ts` | P0 | 20 min |
| F3 | Fila de cada push con su foto (§6.2) | `modulos/codebase/TarjetaRevisionCodigo.tsx` (+ test) | P0 | 15 min |
| F4 | Bloque «Cambios desde la auditoría anterior» (§6.3) | `modulos/auditoria/Cambios.tsx`, `PaginaAuditoria.tsx` | P0 | 35 min |
| F5 | `lib/evolucion.ts` P0 con pruebas (§6.4) | `lib/evolucion.ts`, `lib/evolucion.test.ts` | P0 | 15 min |
| F6 | Página Evolución P0: periodo, cifras, puntaje, Versiones y estados (§6.4) | `modulos/evolucion/{PaginaEvolucion,Graficas}.tsx` | P0 | 30 min |
| F7 | Ruta, riel, guía y atajo | `app/router.tsx`, `lib/nav.ts`, `app/AppShell.tsx`, `lib/guias.ts`, `lib/atajos.ts` | P0 | 10 min |
| F8 | Gráfica «Nuevos y corregidos» | `Graficas.tsx` | P1 · primero | 15 min |
| F9 | Lista «Revisiones de código» en la página | `PaginaEvolucion.tsx` | P1 | 15 min |
| F10 | «Abiertos por severidad» y filtro por módulo | `Graficas.tsx`, `PaginaEvolucion.tsx` | P1 | 25 min |
| F11 | «Incidentes por día» | `Graficas.tsx` | P1 | 15 min |
| F12 | Resumen: «Desde la auditoría anterior: {n} nuevos · {m} corregidos · Ver evolución» con E51 de `last_scan`; etiqueta «Nuevo» en «Hallazgos abiertos» de la auditoría | `modulos/resumen/PaginaResumen.tsx`, `PaginaAuditoria.tsx` | P1 | 25 min |

La función (2) también toca la fila de `TarjetaRevisionCodigo.tsx` (`bloqueo-merge-criticos.md` §6.2) y
`varias-codebases.md` la parte en pestañas por repo: F3 es una línea de texto debajo de lo que haya.

Pruebas mínimas:

- `lib/evolucion.ts` con `fx.evolution` y `fx.deltasRevision`: `cifras` usa `totals` (no suma `points`); el punto sin
  foto entra en la serie del puntaje; `horas(43.2)` → «1 d 19 h»; `etiquetaCorregido` da «Ya no está en el código ·
  rota la clave» para una `CB_SECRET_*` `verified` y «Comprobado» para una `SB_*` `verified`; `lineaFoto` con
  `first:true`, con corregidos y con `fixed_checked`.
- `TarjetaRevisionCodigo`: la fila del push de las 19:20Z dice «1 nuevo · 7 siguen abiertos · 0 corregidos desde el
  push anterior»; sin `delta`, nada; un PR, nada.
- `Cambios`: los cinco estados de §6.3; mapa de etiquetas; 404 → no pinta nada; un título con controles bidi se ve
  saneado; el módulo no revisado lo dice; `moved` y `gone` solo con > 0.
- Página: 0 puntos (vacío con botón deshabilitado para viewer), 1 punto, los fixtures (`role="img"` con `aria-label`),
  `truncated` cambia el título, 404 → «llega pronto».
- Router de fixtures: delta de `scanDone`, de una auditoría simulada (`en_curso` y luego terminada), otra org → 404;
  E45 trae `delta` en las dos revisiones del sábado.

### 9.4 Giovanni, Gabriel y la mensajería

La función (1) no necesita tokens, permisos ni protección de rama (eso es de (2) y (3)).

| # | Qué | Cuándo |
|---|---|---|
| G1 | En la ventana normal (admin de «Tienda Demo»): (a) «Auditar todo» (foto de auditoría); (b) `node demo/empujar-revision.mjs <clon>` → en Codebase, la fila del push dice «1 nuevo · N siguen abiertos …»; (c) «Auditar todo» → en la auditoría, «Nuevos» trae la clave de Stripe; (d) `node demo/empujar-revision.mjs --deshacer` → su fila dice «0 nuevos · … · 0 corregidos» (el push no ve lo que se quita: es lo esperado) y después «Marcar arreglado» en ese hallazgo con el motivo «Clave falsa de la demo: quitada del código; no hay clave real que rotar»; (e) «Auditar todo» → «Corregidos: 1 · Marcado a mano». Con el tramo B: abrir Evolución en la ventana privada (anónimo) y comprobar puntos, tabla y el push. Tope de la org de demo: 20 auditorías al día | Tras B5 (~21:15) |
| G2 | Antes del ensayo del domingo: una auditoría más para que la última versión sea de ese día | Dom 09:00 |
| M1 | Propuesta para quien lleva la mensajería (no es un encargo de BACK ni FRONT; lo decide esa persona con Giovanni, D3): en el WhatsApp de un push, una línea más tras «Nuevo: …»: «Siguen abiertos en Codebase: 7 · corregidos desde el push anterior: 0.» Cambio: `DatosRevision` (`core/src/templates/revision.ts`) suma `siguen?: number \| null; corregidos?: number \| null`; `mensajeRevision` añade la línea solo con `evento === 'push'` y `siguen` numérico (pasado por `conteo()`); `notify/revision.ts` suma `delta` a su `select` de `code_reviews` y pasa `siguen: delta.kept` y `corregidos: delta.first ? null : delta.fixed`. La foto ya existe cuando corre el paso `aviso` (§2.2). Un push limpio no manda WhatsApp (umbrales de `alert_prefs`): sus cifras se ven en la fila | Cuando decidan |

### 9.5 Guion de la demo (≤ 12 s; dónde entra lo decide Giovanni, D1)

Después del WhatsApp del push (fin del tramo 1:25–2:15):

1. Se abre el enlace del WhatsApp: la fila del push dice «1 nuevo · N siguen abiertos · M corregidos desde el push
   anterior».
2. Con el tramo B: en la ventana privada, riel → «Evolución». Se dice: «Y cada revisión queda como una versión: qué
   entró, qué se mantiene y qué se corrigió, y cómo se movió el puntaje.» Se señalan la línea del puntaje y la tabla.
   Los números se leen de la pantalla; nunca las cifras de los fixtures (20 → 42 → 57 → 20; 1 · 7 · 0).

Plan B: si E52 falla o no hay al menos dos fotos, se queda en el paso 1 y la página se nombra en una frase como
«próximamente».

---

## 10. Verificaciones pendientes

1. `tests/evolucion.sql` en Supabase con «RESULTADO OK» antes de aplicar 0015 (en PGlite ya pasó; Supabase es la
   referencia). Incluye que `private.vg_versiones` (`returns table`) compile allí.
2. En producción, tras el tramo A: el log `evolucion.foto_push` de un push real con `applied:true`, E45 con `delta`, y
   el log `evolucion.foto` de una auditoría real con `applied:true` y los conteos esperados.
3. E52 de «Tienda Demo» con varias auditorías: tiempo de respuesta y que el anónimo de la demo la ve.
4. Que las auditorías de hoy anteriores a 0015 salgan en la gráfica del puntaje (`snapshot:false`).

---

## 11. Fuera de este encargo

- **(2) Bloquear un push o un PR con un crítico** y **(3) Cloudflare en modo «bajo ataque»**: sus documentos. Puntos de
  contacto con (2): `revisar()` en `revision/pasos.ts` (la foto va justo después de `vg_review_findings` y antes de lo
  que (2) encola), la última línea de `CodeReview` (`gate` y `delta`) y la fila de `TarjetaRevisionCodigo`. Cuando
  exista, `EvolutionReview` puede sumar un campo opcional `gate` (P2).
- **Varias codebases** (`varias-codebases.md`): la foto de push es de Codebase de toda la org. Una foto por repo
  necesita que los hallazgos de push sepan su conexión (P1 de ese documento, `evidence.conexion`): P2.
- Conteos reconstruidos de auditorías anteriores a 0015: no se hacen (serían aproximados).
- Columna `closed_at` en `findings` (trigger) para que el tiempo de corrección cuente lo marcado a mano: P2; toca la
  tabla de hallazgos la víspera.
- Que el resumen de la IA mencione el delta: P2 (sin IA nueva en P0).
- Distinguir en «Nuevos» lo que volvió a aparecer de lo nunca visto: P2.
- «Todas las secciones»: Supabase, Cloudflare y Codebase entran en las fotos; los incidentes, en E52 (gráfica P1).
  Rendimiento no tiene quien escriba hallazgos (`scans/index.ts` no registra `psi` y `rutas/scans.ts` rechaza
  `lighthouse`) y Cloudflare tiene una sola regla de auditoría (`CF_ZONE_01`, `scans/cloudflare.ts`): su historia será
  corta. Se dice en la página, no se esconde.

---

## 12. Decisiones abiertas para Giovanni

**D1. ¿Entra la Evolución al pitch (≤ 12 s tras el WhatsApp) recortando el rechazo de clave a una frase?** El guion ya
va en 2:50 y el rechazo es lo primero que se recorta (`demo/guion.md` §2). La fila del push (paso 1 de §9.5) cuesta
~3 s; la página solo entra si G1 deja al menos tres versiones reales en «Tienda Demo» y el ensayo del domingo sale bien.
Por defecto, si no contestas antes de O5: entra con esas condiciones.

**D2. ¿«Revisión» incluye cada push con su «se mantiene» y «corregido»?** Ahora sí, en P0 (§1.1, §2.2): es tu pedido
literal. Si dices que no: se quitan B3, B4 y F3 (≈ 45 min) y cada push se queda con sus nuevos.

**D3. ¿El WhatsApp del push dice también «siguen abiertos» y «corregidos»?** Es la propuesta M1 (§9.4) y la decide
quien lleva la mensajería contigo. Por defecto: el WhatsApp no cambia y su enlace abre la fila con las tres cifras.

**D4. ¿Los incidentes (ataques) cuentan como «sección» en la evolución?** E52 ya los trae por día y severidad; la
gráfica es P1 (F11). Por defecto: P1, después de «Nuevos y corregidos».

---

## 13. Correcciones del revisor

### 13.1 Aplicadas (verificadas contra el código antes de aplicarlas)

| # | Corrección | Verificado en | Qué cambió aquí |
|---|---|---|---|
| 1 | El delta por push quedaba en «no» (D2) y Giovanni llama «revisión» a la del push | Pedido literal; 0013: `code_reviews` solo guarda `counts` y `new_findings` de lo nuevo; `vg_evolution` filtraba `event = 'push'`; el texto sale de `mensajeRevision` (core) | Foto de push en P0 (`vg_review_snapshot`, columnas en `code_reviews`), E45 con `delta`, fila del push (F3), PR en E52, propuesta M1 para la mensajería, D2 por defecto «sí» |
| 2 | Claves quitadas sin rotar o movidas salían «Corregido · Comprobado» | `secrets/scan.ts:246` y `:255` (`resource` = `path:line` = `dedupe_input`), `scans/comun.ts:31-35`, 0004:73-77 (auto-verificación), `repo-paso.ts:207` (`p_complete`), `repo.ts` (solo HEAD) | `vg_restar` empareja por regla + huella (`moved`); las claves `verified` no cuentan en `fixed_checked` ni en el tiempo hasta comprobar; etiqueta «Ya no está en el código · rota la clave»; casos en §3.1 (5) |
| 3 | No cabía con (2) y (3) sin ordenar el trabajo | Estimaciones de los cuatro documentos (§9.0) | Tramo A (1 h 20) antes de (2) y (3); tramo B después; FRONT P0 recortado a F1–F7 (≈ 2 h 15); orden de recorte |
| 4 | El caso 1 de §3.1 se contradecía con el 2 | §3.1 anterior | A con f1, f2, f5 y f6 → `open:4` |
| 5 | 0016 ya era de (2) | `bloqueo-merge-criticos.md` (0016), `modo-bajo-ataque.md` (0017), `varias-codebases.md` (0018 libre) | La foto de push va dentro de 0015 |
| 6 | La cadena de fotos se podía desordenar y una auditoría `failed` con foto desaparecía de E52 | `jobs.ts:251-254` y `:146-148`; el upsert anterior reescribía `taken_at` y la anterior | Ver §13.2: una foto no se rehace; `taken_at` tras el candado; E52 ordena por `coalesce(taken_at, finished_at)` y muestra toda foto; caso 4 de §3.1 |
| 7 | En la primera foto, E51 traía todos los abiertos en `kept` con `counts.kept` en 0 | `vg_audit_delta` anterior | `kept` vacío cuando `is_first`; caso 1 de §3.1 |
| 8 | Una fila borrada contaba como corregida y descuadraba las matrices | 0008:40 (borra lo no `open` de más de 90 días); `vg_matriz` usa `left join` | Apartado `gone`, fuera de `fixed` y de `ignored`; la cuenta cuadra con `− gone`; caso 5 de §3.1 |
| 9 | Las horas salían `…+00:00` y la API usa `…Z` | `lib/iso.ts`, `rutas/scans.ts:35`, `rutas/revision.ts:34` | `private.vg_iso` en el SQL para `taken_at`, `finished_at`, `at`, `previous_at`; prueba de formato en §4.5 |
| 10 | Un push no refrescaba la página Evolución | `lib/realtime.ts:17-20` | `'evolution'` en `MAPA.findings`, `MAPA.notifications` (y `scan_runs`, `TODO`) |
| 11 | «No se revisó; sus hallazgos siguen como estaban» era falso con cambios de pushes o marcas | §2.1: `open_ids` es de toda la org | Texto nuevo y solo si el módulo no está en `modules_seen` |
| 12 | «Todas las secciones» quedaba flojo | `scans/index.ts:60-65`, `rutas/scans.ts:58-60`, `scans/cloudflare.ts:164-192` | Rendimiento fuera del filtro; incidentes por día en E52 (gráfica P1, D4); se dice en §11 |
| 13 | Las cifras del periodo se cortaban con `limit` | `useEvolucion` no pasa `limit`; tope de 20 auditorías al día en la demo (`rutas/scans.ts:92`) | `totals` del periodo entero y `truncated` en E52; la UI usa `totals` y avisa del recorte |

Además: `CR_REV_JUEVES` pasa a `…021` (el `…013` chocaba con `CR_REV_PR_BLOQUEADO` de (2), aviso de
`modo-bajo-ataque.md`). (2) también se había ido a `…021`; en la reconciliación del contrato `CR_REV_PR_BLOQUEADO` quedó
en `…022` (`RECONCILIACION-CONTRATO.md`).

### 13.2 Descartadas o aplicadas de otra forma

- **#1, «comparados con la revisión de push anterior de esa config»**: se compara con la foto de push anterior de la
  **org**. Los hallazgos de push van con `connection_id` null (0013), así que el conjunto es Codebase de toda la org;
  encadenar por config sobre un conjunto de toda la org contaría el mismo arreglo en la fila de cada repo
  (`varias-codebases.md`). Con un solo repo, como hoy en «Tienda Demo», da lo mismo.
- **#1, «proponer una línea más en `mensajeRevision`»**: se propone (M1), pero no como encargo de BACK: el texto del
  WhatsApp es de quien lleva la mensajería. Queda como D3.
- **#2, «en G1 (d), marcarla con el motivo "Rotada"»**: no se aplica. La clave de `empujar-revision.mjs` es falsa
  (`claveStripeFalsa`, «clave live de Stripe FALSA»): no hay nada que rotar y el motivo sería falso (T02-14). Se marca con
  «Clave falsa de la demo: quitada del código; no hay clave real que rotar». Además, una auditoría nunca auto-verifica la
  clave de un push (`connection_id` null): en G1 la corrección es a mano y la UI dice «Marcado a mano».
- **#3, citas de `modo-bajo-ataque.md` («3 h 55» y «2 h 10»)**: ese documento cambió y hoy dice ≈ 4 h 45 (BACK) y
  ≈ 2 h 25 (FRONT). La conclusión del revisor se mantiene y pesa más: con `varias-codebases.md`, la noche no alcanza
  (§9.0). El tramo A dura 1 h 20 y no 65 min: incluye la foto de push y E45 con `delta`, sin los cuales los pushes de esta
  noche tampoco dejarían historial.
- **#3, «la página mínima es la línea del puntaje y la tabla»**: aplicado así; «Nuevos y corregidos» queda como el
  primer P1 (F8, 15 min).
- **#6, «conservar el `taken_at` de la primera foto y elegir como anterior la más reciente con `taken_at` menor»**: se
  aplica algo más estricto. La foto no se rehace nunca (la RPC devuelve la que hay) y `taken_at` se toma con
  `clock_timestamp()` después del candado. Rehacerla con otro estado, aun con el `taken_at` viejo, rompería la cuenta de
  la foto siguiente, que ya restó contra los ids de la primera.
- **#8, «o ignorarlas»**: se cuentan aparte (`gone`) en vez de ignorarlas, para que la cuenta
  `open = open anterior + new − fixed − ignored − gone` cuadre y la UI pueda decirlo.
