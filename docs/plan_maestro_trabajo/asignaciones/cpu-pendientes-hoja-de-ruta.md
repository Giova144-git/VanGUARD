# CPU con texto hostil: lo que queda para la hoja de ruta

Nota del BACK (sáb 24-oct, ~18:45 de Caracas). Ya están lineales en `main`, con 0 diferencias de resultado frente a la
versión anterior:

- `redact()`: correo, conexión y clave privada en 06a5c26; JWT en 585b161.
- `checkFixPrompt` y `scanInjection` en 26bf3af.

Las cifras están en SECURITY.md. Queda un patrón cuadrático que no se arregla hoy.

## `PARECE_SECRETO` (cable trampa en JS): alternativa JWT sin `\b`

Dónde está:
- `packages/core/src/engine/edge.ts`, en `uaSegura`.
- `apps/api/src/scans/comun.ts`, comprobando `JSON.stringify(f.evidence)` antes de escribir los hallazgos.

Las dos copias llevan la alternativa `eyJ…\.eyJ…\.` sin `\b`. Con `'eyJ-'` repetido, cada inicio recorre el tramo
entero buscando el punto.

| Texto hostil | 12 KB | 24 KB | 48 KB |
|---|---|---|---|
| `'eyJ-'` repetido, `test()` o `replace()` | 34 ms | 143 ms | 580 ms |

Por qué no se arregla hoy:

- **`edge.ts`.** `IngestBatch` valida `ua: z.string().max(200)` (packages/contracts/src/ingest.ts:6), así que a `uaSegura` le llegan como mucho 200 caracteres y el coste es despreciable. Además es el camino del ataque en vivo de la demo: no se toca.
- **`comun.ts`.** La evidencia está acotada a 16 KB (check de `findings.evidence`), lo que da unos 60 ms en el peor caso. Esa evidencia sale de los sistemas del propio cliente: con ella solo podría frenar su propia auditoría.

Arreglo cuando se retome: el mismo de `redact.ts`. `siguienteJwt(t, desde)` ya está exportada en core; sirve para
detectar en lineal (`siguienteJwt(v, 0) !== null`) y para tapar (`tapaJwt`). Hay que:

- comparar la versión vieja contra la nueva con fuzz;
- añadir una prueba por proporción;
- tocar a la vez las dos copias y `edge.test.ts`, para no desalinear el cable trampa de `private.looks_like_secret` (§11 VIA-1 de revision-codigo.md).
