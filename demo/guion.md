# Guion de la demo (3 min, meta 2:50)

> **Estado al 24-oct, 17:40 UTC.** El recorrido base (abajo) solo usa lo que está en `main` y responde hoy en
> producción (regla T02-14, «solo lo que funciona»). Lo que depende de algo pendiente va como **condicional**, con
> lo que le falta, en «Condicionales / Hoja de ruta» (abajo):
> - **WhatsApp** (aviso y aprobación de «Bloquear IP»): **en pausa** por decisión de Giovanni; depende de Kapso.
> - **Ataque en vivo**, **bloqueo/Deshacer** en vivo, **incidente con su línea de tiempo** y **Rendimiento
>   v1/v2**: dependen de la víctima desplegada (`demo.officialvanguard.com`, paso 13 de Giovanni).
> - **DeepWiki**: desplegada; para enseñarla sobre «Tienda Demo» falta la conexión de GitHub al repo de la víctima.
> - **ZIP en el navegador**: desplegado (`8aa1922`) hasta la vista previa local; guardar el resultado espera E11
>   `kind: zip` y E23 del BACK.
> - **Llamada de voz**: P1, no implementada.
>
> **Dependencia del recorrido base:** el puntaje y los hallazgos de «Tienda Demo» salen de auditar la víctima. Hoy
> «Tienda Demo» no tiene conexiones. Hacen falta la base Supabase y el repo de la víctima, que crea el equipo
> (`docs/VICTIMA_DEMO_PARA_EL_EQUIPO.md`), sus conexiones cargadas en «Tienda Demo» y una «Auditar todo». Sin eso,
> el Resumen sale vacío y solo queda el **video de respaldo**.

Fuentes: `PLAN_MAESTRO.md` §01.8, §16.7, §16.8, §02.3 y §01.14 (adaptadas al recorte de arriba), el código de
`main` y lo comprobado hoy en `https://officialvanguard.com` con `curl` (ver «Qué está verificado»).

Target: 2:50 en el ensayo, nada por encima de 2:55. Todo sobre el **apex** `https://officialvanguard.com`, nunca
en `*.workers.dev`.

**Dos ventanas en la portátil del presentador:**
- **Ventana normal:** sesión con correo de un owner o admin de «Tienda Demo». Solo para el rechazo de clave del
  primer tramo: el visitante anónimo no puede enviar el formulario de conexión (el botón sale deshabilitado,
  `apps/web/src/modulos/conexiones/Asistente.tsx`, `disabled={!org.puedeEscribir}`; `puedeEscribir` es falso
  para `viewer` y para anónimos, `apps/web/src/app/guardas.tsx`).
- **Ventana privada (sin sesión):** es la vista del jurado. «Ver demo en vivo» crea una sesión anónima y entra
  como `viewer`. Con una sesión previa, `/demo` solo une esa cuenta y no la rebaja a viewer
  (`apps/web/src/app/paginas/Demo.tsx`), por eso va en otra ventana.

---

## 1. Momentos, con tiempos

| t | Qué se dice | Qué se clica / se ve | Respaldo del archivo |
|---|---|---|---|
| **0:00–0:25** | «Una de cada diez apps del escaparate de Lovable dejaba leer su base de datos con la llave pública. Somos VanGUARD: conectamos Supabase, Cloudflare y GitHub con **tokens de solo lectura**. Miren: pego una clave secreta de Supabase, falsa, y VanGUARD la rechaza y explica por qué.» | **Ventana normal** → Conexiones de «Tienda Demo» (tarjetas con `••••` y los 4 últimos caracteres del token) → asistente de Supabase → se pega una `sb_secret_` falsa → **rechazo con explicación, sin salir del navegador**. | Dato: CVE-2025-48757, 170 de 1.645 apps (`PLAN_MAESTRO.md` §01.2, con sus fuentes). Rechazo en el navegador: `apps/web/src/lib/pre-guardas.ts` (`preGuardar`, caso `sb_secret_` y JWT `service_role`), llamado en `apps/web/src/modulos/conexiones/Asistente.tsx` líneas 123-124; tras el rechazo el campo se vacía (línea 150). No hay petición de red. Texto de la página: «Solo lectura… La única excepción es el token opcional» de Modo blindaje (`PaginaConexiones.tsx`). |
| **0:25–1:00** | «Ahora entramos como ustedes, sin cuenta: *Ver demo en vivo*. Esta es una tienda de prueba con fallas sembradas a propósito. El puntaje es **{puntaje}** y aquí dice cuántas de las 4 fuentes estamos viendo.» | **Ventana privada** → portada → botón **«Ver demo en vivo»** → **Resumen**: puntaje, barra por severidad, cifra «Fuentes N de 4» y bloque «Ahora». Se lee de la pantalla, no se recita. | Portada: `apps/web/src/app/paginas/Inicio.tsx`. Entrada anónima: `apps/web/src/app/paginas/Demo.tsx` + E4 `POST /api/demo/join` en `apps/api/src/rutas/demo.ts` (une como `viewer`). Solo lectura: `apps/api/src/mw/anon.ts` (escrituras bajo `/api/orgs/:org/*` → 403, salvo pedir un prompt ya guardado). Resumen: `apps/web/src/modulos/resumen/PaginaResumen.tsx` (pinta `overview`, no recuenta). Cobertura: `apps/api/src/scans/cobertura.ts`. |
| **1:00–1:40** | «Un hallazgo crítico: RLS desactivada. VanGUARD no solo lo marca: te da el **prompt de corrección listo para tu IA**. Ya estaba generado, así que no gastamos tokens delante de ustedes.» | Clic en la cifra **«Críticos abiertos»** (baja a «Ahora») → abrir el hallazgo crítico en el panel → **«Ir al prompt de corrección»** → **«Copiar para mi IA»**; junto al botón dice «Generado por … · guardado». | Panel: `apps/web/src/modulos/hallazgos/DetalleEnPanel.tsx` → `DetalleHallazgo.tsx` → `PromptCorreccion.tsx` (botón «Copiar para mi IA»). Caché: E15 en `apps/api/src/rutas/findings.ts` devuelve `cached: true` si `fix_prompt` existe; al anónimo nunca le genera uno nuevo. La falla viene de `demo/seed-victima.sql` (tabla `pedidos` sin RLS). |
| **1:40–2:10** | «Cada fuente tiene su pantalla. En "Revisado", un chequeo sale en verde **solo si de verdad lo miramos**; si no, queda en gris. Por eso el Resumen dice cuántas fuentes vemos: nunca pintamos verde sin mirar.» | Menú → **Supabase** (o **Código**) → bloque «Ahora» y sección **«Revisado»**. Si «Fuentes» no era 4 de 4, se dice cuál falta. | `apps/web/src/componentes/vg/PantallaModulo.tsx` (sección «Revisado»), `apps/web/src/componentes/vg/ChecksEnCero.tsx` («verde con ✓ solo si `comprobado`»), `apps/api/src/scans/cobertura.ts` («Nunca verde sin mirar»). |
| **2:10–2:50** | «Si tu equipo usa otra IA, exportas todo en **Markdown, con los secretos tapados**, y se lo pasas tal cual. La app y la API corren en un Worker del **plan gratuito de Cloudflare**. Y en el código, la **regla decide la alerta, no el modelo**: un texto malicioso en un log no apaga la alarma. Lo siguiente: el aviso y el bloqueo por WhatsApp ante un ataque en vivo.» | **Llevar a tu IA** → vista previa del Markdown → **Descargar .md** (o **.json**). Cierre. | Página: `apps/web/src/modulos/exportar/PaginaExportar.tsx` (usa `descargarExport` de `apps/web/src/lib/mutaciones.ts`). Redacción en el servidor: E25 en `apps/api/src/rutas/export.ts` (lista blanca de columnas) y `redactarParaExport` en `packages/core/src/export.ts`. Plan gratuito: `apps/api/wrangler.jsonc` («Plan Workers Free»). La regla decide: `packages/core/src/engine/edge.ts` (reglas `CF_*` puras, sin modelo) y `packages/core/src/engine/incidente.ts`. MCP sale como «Próximamente» en la misma página y `/mcp` da 404: se nombra solo como hoja de ruta. La frase de cierre cambia si para entonces el aviso por WhatsApp ya funciona en vivo. |

---

## 2. Huecos a rellenar (mediana de 3 ensayos)

- **`{puntaje}`**: el que muestre el Resumen en vivo al cargar «Ver demo en vivo». Se lee de la pantalla. Es el
  único hueco que se dice como número. En los fixtures del repo es **20** (rojo, 4 de 4 fuentes), pero eso es un
  dato de prueba (`packages/contracts/src/fixtures/resumen.ts`), no el de producción.
- **Fuentes «N de 4»**: tampoco se recita. Rendimiento solo cuenta si hay una medición de los últimos 7 días
  (`apps/api/src/scans/cobertura.ts`), y hoy no hay ninguna en el repo (ver «Fuera de alcance»). Lo esperable es
  **3 de 4** como mucho; se dice lo que salga.
- **`{t_whatsapp}`** y **`{t_bloqueo}`**: **no se miden en esta versión**. El flujo de ataque, WhatsApp y bloqueo
  está recortado y no se enseña ninguna línea de tiempo. Las cifras de los fixtures (WhatsApp a +8,4 s, crítico a
  +26,1 s, `apps/web/src/lib/fixtures/router.ts`) son de prueba y **no se dicen en el pitch** (PLAN §01.8, §16.7).
  Si el ataque en vivo vuelve, se miden con la mediana de 3 ensayos leyendo `timeline[]` de
  `GET /api/orgs/:org/incidents/:id` (PLAN §01.4, «Cifras del cronómetro para el pitch»).
- Los 3 ensayos de esta versión cronometran solo el recorrido en vivo (rechazo → «Ver demo en vivo» → hallazgo →
  módulo → exportar). Meta 2:50; si se pasa de 2:55, se recorta primero el tramo de «Revisado».

---

## 3. Lista previa a cada ensayo (demo recortada)

Dueño: ORQUESTADOR. Lo que de verdad corremos ahora:

- [ ] Portátil del presentador en el **wifi del evento**, abierta en `https://officialvanguard.com` (nunca en
      `*.workers.dev`).
- [ ] **Ventana normal** con sesión de un owner o admin de «Tienda Demo», abierta en Conexiones.
- [ ] **Ventana privada, modo presentación:** antes de empezar, Ctrl+K → «Modo presentación». Arranca apagado porque
      la ventana privada no guarda nada; sin él, unos 40 textos del Resumen quedan a 12,5 px, ilegibles a 3 m.
- [ ] **Ventana privada:** «Ver demo en vivo» llega al Resumen de «Tienda Demo». Si sale «Demo no disponible»,
      el inicio de sesión anónimo está apagado o hubo un 429 por IP (`Demo.tsx`): ir al plan B.
- [ ] «Tienda Demo» tiene sus **conexiones** cargadas: Supabase de la víctima (token de solo lectura del equipo),
      GitHub (PAT de solo lectura al repo de la víctima) y Cloudflare (paso 15). Hoy (24-oct) no tiene ninguna.
- [ ] El Resumen tiene **datos de una auditoría** (puntaje y hallazgos) y entre ellos el crítico de **RLS
      desactivada**. Si no, correr «Auditar todo» desde la ventana normal (el viewer no puede).
- [ ] **Prompt en caché:** **después** de la última «Auditar todo», generar desde la ventana normal el prompt del
      hallazgo crítico que se abre (y, por si preguntan, los otros 3 de PLAN §16.7) y comprobar
      `has_fix_prompt = true`. Una auditoría posterior con evidencia distinta lo borra (PLAN §16.7). Sin prompt
      guardado, el viewer ve «Este hallazgo aún no tiene prompt: lo genera un administrador» (`PromptCorreccion.tsx`).
- [ ] **Exportar** responde: la vista previa carga y «Descargar .md» baja el archivo.
- [ ] `curl -s https://officialvanguard.com/api/health`: `version` igual al último commit de `main`. Hoy
      (24-oct, 17:45 UTC) daba `8de07c3`, igual a `main`.
- [ ] Nada volátil en pantalla: sin banners de error; las dos sesiones limpias.

> Lo de abajo **solo** aplica si se reactiva el flujo de ataque en vivo (hoy **no** se usa): portátil del panel
> fuera del hotspot (PLAN §16.7, S02 Z3), regla de bloqueo anterior borrada con «Deshacer», saldo del sandbox de
> Kapso positivo, ventana de 24 h de WhatsApp abierta (reescribir al sandbox), víctima `demo.officialvanguard.com`
> respondiendo, conexiones de «Tienda Demo» activas, ventana `demo_alertas_hasta` abierta con el SQL de
> `PLAN_MAESTRO.md` §02.5.1, y sesión de admin abierta. Se documentan aquí para no perderlos, pero están
> **fuera de alcance** (§Fuera de alcance).

---

## 4. Plan B por paso (lo que dependemos hoy)

| Paso | Si falla | Plan B |
|---|---|---|
| Rechazo de clave | La sesión de admin no está abierta | Se salta el clic y se cuenta en una frase; el código está en `pre-guardas.ts`. Si hay video de respaldo, ese tramo. |
| «Ver demo en vivo» / Resumen | El anónimo no entra («Demo no disponible») | Seguir en la ventana normal (owner/admin) y decirlo: «esto lo ve el jurado como solo lectura». Si tampoco carga, **video de respaldo** del recorrido. El README todavía no publica una cuenta de demo. |
| Prompt de corrección | No quedó guardado | El viewer no puede generarlo. Abrirlo en la ventana normal: si la IA no tiene saldo o está en pausa, E15 devuelve la **plantilla de la regla** (`details.fallback_prompt`, `findings.ts`), que también se copia. |
| «Revisado» | El módulo sale vacío | Saltar el tramo (es el primero que se recorta). |
| Exportar | Error de red al descargar | «Copiar para mi IA» y la vista previa de 80 líneas ya están en la misma página. |
| Red completa caída | — | **Video** del tramo (PLAN §16.8 #6). «¿Y en vivo?»: `curl -s https://officialvanguard.com/api/health` (su `version` es el SHA del commit desplegado). |

> Plan B de los puntos recortados (solo si se reactivan, §Fuera de alcance): WhatsApp no llega → código y
> banner **in-app** (`delivery: 'in_app'`, solo org de demo, `apps/api/src/actions/approvals.ts`); el borde corta
> el UA `sqlmap/1.8` → `--ua "nikto/2.5.0"` (`scripts/ataque.mjs`); IA sin saldo → prompts en caché.

---

## 5. Qué es real y qué es simulado (se dice tal cual)

- **Real:** el dominio y el Worker en el plan gratuito de Cloudflare; el rechazo de claves peligrosas en el
  navegador; el acceso anónimo de solo lectura; el puntaje, la cobertura y los hallazgos del Resumen, que salen
  de auditar la víctima; los `fix_prompt` guardados; la exportación redactada; y las reglas deterministas del
  borde en el código (`packages/core/src/engine/edge.ts`).
- **Simulado a propósito:** la víctima y sus fallas, sembradas por nosotros (`demo/seed-victima.sql`, repo
  privado de prueba); sus datos y secretos son falsos.
- **Condicional (no va en el recorrido base hasta que se cumpla lo que le falta):** el aviso y la aprobación del
  bloqueo por WhatsApp, el ataque en vivo, el bloqueo/Deshacer en vivo, la línea de tiempo de un incidente,
  Rendimiento v1/v2, DeepWiki sobre «Tienda Demo» y guardar el resultado del ZIP. La llamada de voz es hoja de ruta
  (ver abajo).

---

## Condicionales / Hoja de ruta

Puntos que hoy no van en el recorrido base, con lo que les falta:

| Punto | Estado | Comprobado |
|---|---|---|
| Aviso por **WhatsApp** + aprobación de «Bloquear IP» desde WhatsApp | **En pausa** (decisión del equipo); depende del sandbox de Kapso | El código está en `main` (`apps/api/src/notify/kapso.ts`, `apps/api/src/rutas/webhooks-kapso.ts`; config en `scripts/kapso-config.mjs`), pero no se ejerce en vivo. |
| **Ataque en vivo** desde el hotspot contra la víctima | Víctima **no desplegada** | `curl https://demo.officialvanguard.com/` → **000** (no responde). Script: `scripts/ataque.mjs` (listo, no se corre en la demo). |
| **Bloquear IP / Deshacer** ejecutados en vivo | Depende del incidente en vivo y de la aprobación por WhatsApp | UI en `apps/web/src/modulos/incidentes/BloquearIp.tsx`; la acción en `apps/api/src/actions/block-ip.ts`. El botón «Simular ataque» (`Simulacion.tsx`) existe **solo en modo fixtures**, no en producción. |
| **Incidente con su línea de tiempo** | Sin datos en producción | Ningún archivo del repo siembra incidentes (`supabase/seed/demo.sql` solo crea la org). Los incidentes nacen de la ingesta del tráfico de la víctima, que no está desplegada. La pantalla existe (`PaginaIncidente.tsx`, `hitos.ts`). |
| **Rendimiento v1/v2** | Sin medición | `demo/seed-perf.sql` en `main` solo tiene la cabecera y la guarda (18 líneas, ningún bloque de medición). Las 2 filas de `supabase/seed/demo.sql` llevan marcadores `__X__` y el propio archivo dice que no se aplicaron. Lo que se mide es la víctima, no desplegada. La pantalla (`PaginaRendimiento.tsx`) no pinta nada con menos de 2 mediciones. |
| **Llamada de voz** | P1, no implementada | No hay código de ElevenLabs ni Twilio en `apps/api/src`; solo los nombres de variables (`apps/api/worker-configuration.d.ts`) y sus hosts en la lista de salida (`packages/core/src/egress.ts`, marcados P1). |
| **DeepWiki** (wiki del repo) | **Desplegada**; para «Tienda Demo» falta la conexión de GitHub al repo de la víctima | Rutas E40–E44 en `apps/api/src/rutas/wiki.ts` (generar es solo para admin y gasta IA; una wiki ya generada se ve gratis) y motor en `packages/deepwiki/src/pipeline.ts`. Si entra, va con una wiki ya generada antes del pitch, no generándola en vivo. |
| **ZIP** analizado en el navegador | **Desplegado** (`8aa1922`) hasta la vista previa; guardar espera al BACK | `apps/web/src/modulos/codebase/AnalizarZip.tsx`: el análisis corre en un Web Worker y muestra el resultado sin salir del navegador; «enviar» crea el scan (E11 `kind: zip`) y sube el resultado (E23), que aún no existen en la API. Solo owner o admin (`org.puedeEscribir`): el viewer anónimo no lo ve. No depende de la víctima. |
| **MCP** (`/mcp`, «Llevar a tu IA») | No desplegado | `curl https://officialvanguard.com/mcp` → **404**; la página de exportar lo marca «Próximamente». |

Si se reactivan (WhatsApp vuelve del sandbox + víctima desplegada), el tramo ataque → aviso → bloqueo → línea de
tiempo se re-inserta entre el hallazgo y la exportación siguiendo `PLAN_MAESTRO.md` §16.7, y vuelven a medirse
`{t_whatsapp}` y `{t_bloqueo}`. Rendimiento vuelve cuando `scripts/perf-medir.ts` genere bloques reales en
`demo/seed-perf.sql`.

---

## Qué está verificado (hoy, 24-oct, 17:23–17:40 UTC, con `curl` de solo lectura, `git` y el navegador)

- `GET https://officialvanguard.com/api/health` → `{"ok":true,"version":"8de07c3…"}`: **vivo** e igual a `main`.
- Con «Ver demo» en `/o/<demo>/codebase` aparecen «O analiza un ZIP en tu navegador» y el botón «Analizar un ZIP»
  (build de `8aa1922`).
- `GET https://officialvanguard.com/` → 200, portada de VanGUARD: **vivo**.
- `GET https://demo.officialvanguard.com/` → **000** (víctima no desplegada).
- `GET https://officialvanguard.com/mcp` → **404** (MCP no desplegado).
- Cualquier `GET /api/...` sin sesión da **401** (probado con una ruta inexistente): ese código no dice si una
  función está desplegada.
- `git show HEAD:demo/seed-perf.sql`: 18 líneas, sin mediciones.
- No verificado desde aquí (requiere sesión): el puntaje, los hallazgos y los prompts guardados de «Tienda Demo»
  en producción. Por eso están en la lista previa.
