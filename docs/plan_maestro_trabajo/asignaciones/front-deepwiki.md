# FRONT · Vista DeepWiki «Wiki del repo»

Asignación del ORQUESTADOR, sábado 24-oct. Va antes de F-15 (pulido para proyector) y de los P1 (atajos g+letra, Ctrl+K, «Activar modo blindaje»).

**Fixtures commiteados (b7e333b):**
- `fx.wikiEstimate`, `wikiRunRunning`, `wikiRunDone`, `wikiRuns` y `wikiDoc`.
- Contrato en `packages/contracts/src/wiki.ts` (E40–E44).
- `fx.perfRuns` ahora trae `run_group` (4 grupos), `rep` 1–3 y `version_label` (`v1-sana` / `v2-regresion`), así que el histórico de Rendimiento ya rotula sin cambios.

## Especificación (P1 alto, módulo nuevo)

1. **Ruta `/wiki`**, «Wiki del repo» en la barra, después de Codebase. Explica un repo a un directivo: qué es, cómo funciona, sus piezas, un mapa y los riesgos.
2. **Entrada (solo admin):**
   - Repo `owner/nombre`. Por defecto, el `meta.repo_full_name` de la conexión GitHub activa; si no hay, texto libre para repos públicos, validado con `RepoFullName`.
   - Rama opcional.
   - Botón «Estimar costo» → E40 `POST /api/orgs/:org/wiki/estimate`.
3. **Tarjeta de estimación:**
   - Commit corto; archivos total, candidatos y a leer; áreas; aviso «truncado» si aplica.
   - Costo estimado en USD, con el desglose por paso y por modelo (fast/smart).
   - `avisos[]`.
   - Con `cached_run_id` ≠ null: «Ya existe la wiki de este commit · Ver (gratis)» y, como secundario, «Regenerar» con confirmación (`force: true`).
   - Sin caché: «Generar wiki · ~$X» → E41, con `max_usd` = estimación × 1,5 redondeada a centavos, tope 5.
4. **Progreso (E42):**
   - Pasos `arbol → triage → area → sintesis → fin`, cada uno con su `detalle`, más `progress` y `cost_usd` acumulado.
   - Polling cada 3 s solo mientras esté `queued`/`running` y la pestaña esté visible (`wiki_runs` no tiene Realtime).
   - `failed` → mostrar `error` y «Reintentar».
5. **Documento (E44):**
   - Cabecera: repo@rama, commit corto, fecha, modelos y costo.
   - `overview_md` como Markdown **sin HTML** (ni rehype-raw ni `dangerouslySetInnerHTML`). Es dato no confiable aunque ya venga saneado.
   - El mapa, si `mermaid` ≠ null. Si `mermaid_descartado`, el texto «El diagrama se descartó por seguridad».
   - Páginas por área en acordeón: título, `resumen_md` y archivos en mono, plegados.
   - Avisos y stats al pie, y «Copiar como Markdown».
6. **Historial (E43):** `GET wiki/runs?repo=` con commit, estado, costo y una chapa «caché» para los de costo 0.
7. **Viewer y anónimo de «Ver demo»:** solo ven el historial y el documento. Nunca estiman ni generan, porque el jurado no gasta IA. Los botones van deshabilitados con su motivo.
8. **Diagrama sin dependencia nueva (recomendado):**
   - El Mermaid que acepta el motor es solo `flowchart LR`, con líneas `A[Etiqueta] --> B` o `A -->|texto| B`. La lista blanca admite alfanuméricos y espacios, con unos 6–12 nodos; ver el test «el Mermaid pasa la lista blanca» en `contracts.test.ts`.
   - Parséalo a mano, ordena las columnas por camino más largo y pinta un SVG con `<text>` de React, sin innerHTML. Si no parsea, muestra el bloque de código.
   - Así no hay ~1 MB de mermaid, ni superficie XSS, ni cambio de lockfile.
   - Si aun así se prefiere la librería, avisar antes al ORQUESTADOR por el lockfile.
9. **Router de fixtures:**
   - E40 → `wikiEstimate`.
   - E41 → `{ wiki_run_id: wikiRunDone.id, cached: false }`.
   - E42 → `wikiRunRunning` en las primeras llamadas y después `wikiRunDone`.
   - E43 → `wikiRuns`.
   - E44 → `wikiDoc`.

**API real (`/api/me` y `../web/dist`):** dependen de los pasos 2 y 3 de Giovanni (claves secretas y secretos del Worker). El paso 1, Auth y Realtime, ya está. El ORQUESTADOR avisa cuando `/api/me` responda con un usuario.
