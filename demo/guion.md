# Guion de la demo (3 min, meta 2:50)

> **Recorrido final (dom 25-oct, actualizado a las 04:10 UTC sobre `0c7fe7b`).** Solo usa lo que responde hoy en
> producción. Respecto a la versión del sábado, ya entran: **WhatsApp con botones de acción real**, **bloqueo de merge
> con cierre del PR**, **evolución entre revisiones**, **Rendimiento con «Medir ahora»** y el **MCP propio**.
> Los ataques en vivo (bloquear IP, modo bajo ataque) se nombran como «próximamente»: la víctima vive en
> `pages.dev`, que no es una zona de ninguna cuenta del equipo, y no manda tráfico a VanGUARD.

Target: 2:50 en el ensayo, nada por encima de 2:55. Todo sobre el **apex** `https://officialvanguard.com`, nunca en
`*.workers.dev`.

**Dos ventanas en la portátil del presentador:**
- **Ventana normal:** sesión de un owner o admin de «Tienda Demo». Para el rechazo de clave, «Medir ahora» y lo que
  el visitante anónimo no puede hacer (`org.puedeEscribir` es falso para `viewer` y anónimos,
  `apps/web/src/app/guardas.tsx`).
- **Ventana privada (sin sesión):** la vista del jurado. «Ver demo en vivo» entra como `viewer` anónimo de solo
  lectura (`apps/web/src/app/paginas/Demo.tsx`, E4 `POST /api/demo/join`).

**Un teléfono** con WhatsApp que haya escrito al número de VanGUARD (+1 205-843-2279) en las últimas 24 h.

---

## 1. Momentos, con tiempos

| t | Qué se dice | Qué se clica / se ve | Respaldo |
|---|---|---|---|
| **0:00–0:20** | «Una de cada diez apps del escaparate de Lovable dejaba leer su base con la llave pública. VanGUARD conecta Supabase, Cloudflare y GitHub con **tokens de solo lectura**: si pego una clave secreta, la rechaza y explica por qué.» | **Ventana normal** → Conexiones → asistente de Supabase → se pega una `sb_secret_` falsa → rechazo con explicación, sin petición de red. | CVE-2025-48757, 170 de 1.645 apps. `apps/web/src/lib/pre-guardas.ts` (`preGuardar`), llamado desde `apps/web/src/modulos/conexiones/Asistente.tsx`. |
| **0:20–0:45** | «Entramos como ustedes, sin cuenta. Puntaje **{puntaje}**, las fuentes que miramos, y lo que ya se **corrigió** desde la auditoría anterior.» | **Ventana privada** (Ctrl+K → «Modo presentación») → «Ver demo en vivo» → **Resumen**: puntaje, severidades, «Fuentes N de 4», «N corregidos». | `apps/web/src/modulos/resumen/PaginaResumen.tsx`; cobertura en `apps/api/src/scans/cobertura.ts` («nunca verde sin mirar»). |
| **0:45–1:05** | «Un crítico: la tabla de pedidos sin RLS, legible con la clave pública. VanGUARD te da el **prompt de corrección listo para tu IA**; ya estaba generado, no gastamos tokens delante de ustedes.» | «Críticos abiertos» → **«RLS desactivada en public.pedidos»** → «Ir al prompt de corrección» → «Copiar para mi IA». | Regla `SB_RLS_DISABLED` (`packages/core/src/rules/supabase.ts`); `PromptCorreccion.tsx`; E15 devuelve el guardado y al anónimo nunca le genera uno. |
| **1:05–1:45** | «Vigila cada cambio. Simulo a una IA que sube una clave al repo.» … «En **{t_revision}** segundos, el WhatsApp. **La regla lo detectó en el diff, no un modelo.** Y el botón hace algo real: *Enviarme el arreglo*.» | **Portátil:** `node demo/empujar-revision.mjs <clon> --plan-b`. **Teléfono:** llega el aviso → toque en **«Enviarme el arreglo»** → llega el arreglo. **Ventana privada:** Codebase → tarjeta «Revisión automática de código» con la fila nueva y la acción de WhatsApp. | Webhook E47 (`apps/api/src/rutas/webhooks-github.ts`, HMAC), `apps/api/src/revision/pasos.ts`, texto fijo sin IA (`packages/core/src/templates/revision.ts`, `templates/whatsapp.ts`), botones en `apps/api/src/rutas/webhooks-kapso.ts`. Tarjeta: `apps/web/src/modulos/codebase/TarjetaRevisionCodigo.tsx`. |
| **1:45–2:00** | «Si ese cambio llega por pull request con un crítico, VanGUARD **marca el PR en rojo y lo cierra**.» | **Condicional (ver §4):** Codebase → «Bloqueo de merge» encendido → enseñar en GitHub un PR ya cerrado por VanGUARD (✗ y comentario). Si no está encendido, se cuenta en una frase. | `apps/api/src/revision/estado.ts`, `acciones-pr.ts`; UI `apps/web/src/modulos/codebase/BloqueoMerge.tsx`. |
| **2:00–2:25** | «Y no es una foto fija: VanGUARD compara cada revisión con la anterior, qué empeoró, qué se arregló. También mide el **rendimiento** real de la web.» | **Ventana privada:** **Evolución** (gráficas y «Desde la anterior»). **Ventana normal:** **Rendimiento → «Medir ahora»** (Móvil) sobre `https://vanguard-demo-victima.pages.dev/`; sale la medición real en ~10 s. | `apps/web/src/modulos/evolucion/PaginaEvolucion.tsx`, `DesdeAnterior.tsx`; `apps/web/src/modulos/rendimiento/MedirAhora.tsx` (PageSpeed real). |
| **2:25–2:50** | «Si tu equipo usa otra IA: exportas en **Markdown con los secretos tapados**, o la conectas a nuestro **MCP**. Todo en el **plan gratuito de Cloudflare**, y la **regla decide la alerta, no el modelo**. Próximamente: bloquear un ataque en vivo con un toque.» | **Llevar a tu IA** → vista previa → «Descargar .md» (y mención al MCP). Cierre. | `apps/web/src/modulos/exportar/PaginaExportar.tsx`; E25 `apps/api/src/rutas/export.ts`, `redactarParaExport` en `packages/core/src/export.ts`. MCP: `/mcp` (responde 401 sin token). |

---

## 2. Huecos a rellenar (mediana de 3 ensayos)

- **`{puntaje}`**: se lee del Resumen en vivo. La última auditoría completa (03:31 UTC) dio **20**.
- **Fuentes «N de 4»**: no se recita; se dice lo que salga (hoy, sin Cloudflare: 3 de 4 como mucho).
- **«N corregidos»**: sale solo si la última auditoría completa tiene una anterior con hallazgos que ya no están
  (preparación, §3).
- **`{t_revision}`**: segundos del push al WhatsApp, mediana de 3 ensayos. Referencia real: 10,2 s (24-oct).
- Si el recorrido pasa de 2:55, se recorta en este orden: rechazo de clave (una frase), bloqueo de merge (una
  frase), Rendimiento (se enseña la medición ya guardada, sin pulsar).

---

## 3. Preparación (una vez, antes del ensayo de las 09:00 de Caracas)

Dueño: ORQUESTADOR.

1. Auditoría completa nueva de «Tienda Demo» que acabe en `succeeded`.
   **Bloqueada:** la del 25-oct 03:31 UTC (`1fc34a1e…`) hizo todos los pasos pero no se cerró; lo arregla el BACK.
2. `node demo/empujar-revision.mjs <clon> --deshacer` y «Marcar arreglado» de los críticos que vienen de pushes de
   prueba (Stripe en `src/lib/pagos.ts`, `.env.staging` del plan B).
3. Otra auditoría completa → el Resumen enseña «N corregidos» y Evolución tiene al menos 2 fotos con delta.
4. Generar los prompts de corrección de los críticos que se abren **después** de la última auditoría
   (`has_fix_prompt = true`).
5. Generar la wiki de «Tienda Demo» si no está (~0,04 USD).
6. Giovanni enciende el **bloqueo de merge** con el 2.º token de GitHub (Commit statuses + Pull requests) y deja un
   PR de prueba cerrado por VanGUARD para enseñarlo.

## 4. Lista previa a cada ensayo

- [ ] Portátil en el **wifi del evento**, en `https://officialvanguard.com`.
- [ ] `curl -s https://officialvanguard.com/api/health`: `version` igual al último commit de `main`.
- [ ] **Ventana normal** con sesión de owner/admin de «Tienda Demo», en Conexiones.
- [ ] **Ventana privada** en modo presentación (Ctrl+K → «Modo presentación»; arranca apagado en privada).
- [ ] «Ver demo en vivo» llega al Resumen; si sale «Demo no disponible», plan B.
- [ ] El crítico de **RLS desactivada** está en «Ahora» con prompt guardado.
- [ ] **Revisión de código** de «Tienda Demo» «Conectada»; en GitHub el ping del webhook con ✓.
- [ ] Clon de la víctima en `C:\Users\giova\Desktop\hackaton\vanguard-demo-victima`, en `main` igual a
      `origin/main`; `node demo/empujar-revision.mjs <clon> --plan-b --no-push` funciona. **Siempre `--plan-b`:** la
      clave de Stripe falsa la bloquea la protección de push de GitHub.
- [ ] El **teléfono escribió** al número en las últimas 24 h (ventana actual: hasta el 26-oct 03:12 UTC).
- [ ] Avisos de la demo activos: `demo_alertas_hasta` posterior a la hora del pitch (hoy `2026-10-25T18:00:00Z`).
- [ ] Rendimiento: queda cupo de «Medir ahora» (20) y no hay una medición en curso (la 2.ª seguida da 409).
- [ ] Después de cada ensayo: `--deshacer` del push y «Marcar arreglado» de su hallazgo (nunca «Ignorar»).
- [ ] Si un push falla, antes de reintentar:
      `git -C C:\Users\giova\Desktop\hackaton\vanguard-demo-victima reset --hard origin/main`.

---

## 5. Plan B por paso

| Paso | Si falla | Plan B |
|---|---|---|
| Rechazo de clave | No hay sesión de admin | Una frase; el código está en `pre-guardas.ts`. |
| «Ver demo en vivo» | «Demo no disponible» (anónimo apagado o 429 por IP) | Seguir en la ventana normal y decir «esto lo ve el jurado en solo lectura». Si nada carga: video. |
| Prompt de corrección | No quedó guardado | Abrirlo en la ventana normal; sin saldo de IA, E15 devuelve la plantilla de la regla. |
| Push y WhatsApp | No llega el webhook o el aviso | GitHub → webhook → «Recent Deliveries» → «Redeliver». Si la revisión terminó sin WhatsApp, la tarjeta dice el motivo y se enseña el hallazgo en Codebase. |
| «Enviarme el arreglo» | No llega la respuesta | La tarjeta de revisión enseña la acción registrada; se cuenta y se sigue. |
| Bloqueo de merge | Apagado o sin PR de prueba | Una frase. |
| «Medir ahora» | 409, cupo agotado o PageSpeed lento | Enseñar las mediciones guardadas (móvil 100, LCP 754 ms; escritorio 100, LCP 208 ms). |
| Exportar | Error al descargar | «Copiar para mi IA» y la vista previa están en la misma página. |
| Red caída | — | Video del recorrido. |

---

## 6. Qué es real y qué es simulado (se dice tal cual)

- **Real:** el dominio y el Worker en el plan gratuito de Cloudflare; el rechazo de claves en el navegador; el
  acceso anónimo de solo lectura; puntaje, cobertura y hallazgos de auditar la víctima; la revisión de cada push
  con el WhatsApp por el número real y sus botones con acción real; el cierre del PR por el bloqueo; la evolución
  entre auditorías; las mediciones de PageSpeed; la exportación redactada; el MCP.
- **Simulado a propósito:** la víctima y sus fallas, sembradas por el equipo (repo `gabgaru1/vanguard-demo-victima`
  y base `MessedUp_DB`); sus datos y secretos son falsos.
- **Próximamente (no se enseña):** bloquear una IP y el modo bajo ataque en vivo (están en el código, con
  confirmación, simulación, TTL y Deshacer, pero hacen falta una zona propia de la víctima y la ingesta de su
  tráfico); la llamada de voz.
