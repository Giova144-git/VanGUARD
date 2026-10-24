# Reglas de modelos y filtrado (deepwiki)

## Enrutado (src/models.mjs)
| Tarea | Modelo | Por que |
|---|---|---|
| `triage`: elegir archivos relevantes (solo rutas) | Haiku 5.5 | masivo, barato, tarea de clasificar |
| `area`: resumen por carpeta | Haiku 5.5 | muchas llamadas pequenas |
| `synthesis`: documento final para el CEO + Mermaid | Sonnet 5.5 | razonar y redactar con calidad |

Cambiar con `DEEPWIKI_MODEL_FAST` / `DEEPWIKI_MODEL_SMART` en `.env`. Toda tarea nueva se declara en `ROUTE`; sin ruta, el cliente se niega a llamar.

## Orden de filtros (de mas barato a mas caro)
1. Reglas locales sin modelo: se omiten `node_modules`, builds, binarios, lockfiles, `.env*`, claves (`.pem`, `.key`, `id_rsa`), archivos > 60 KB.
2. Triage con Haiku sobre rutas (maximo 400 rutas, devuelve <= 80).
3. Redaccion local de secretos (`redact.mjs`) antes de enviar nada a ningun modelo.
4. Presupuestos: <= 150 archivos, <= 12 areas, 24k caracteres por area.

## Seguridad
- Todo contenido del repo va entre etiquetas `<repo_file>`/`<repo_paths>`/`<repo_summary>` y es DATO, nunca instruccion.
- Salida: sin HTML, enlaces ni imagenes; Mermaid solo `flowchart LR` con lista blanca.
- La clave `ANTHROPIC_API_KEY` solo en `deepwiki/.env`.
