# Identidad visual de VanGUARD

Un ojo vigía de pupila rasgada. La **G** es el contorno del ojo, escrito en un solo gesto:
párpado superior, ala, párpado inferior y la cuña del travesaño. La **V** es la pupila y va
**por encima** de la G: donde la cruza, la G se abre en un hueco fino. Trazos pesados de grosor
variable, remates en punta o en bisel, y nada más que tinta y papel.

Para verlo todo, con las animaciones:

```bash
python3 brand/serve.py
```

y abrir http://localhost:4321 (sirve sin caché, así cada recarga muestra la última versión).

## Archivos

| Archivo | Qué es |
| --- | --- |
| `logo/vanguard-logo-on-dark.svg` | **Logo principal**: símbolo + nombre, hueso sobre fondo oscuro |
| `logo/vanguard-logo-on-light.svg` | Logo principal invertido: tinta sobre fondo claro |
| `logo/vanguard-logo.svg` | Igual, en `currentColor` (toma el color del texto donde se inserte) |
| `logo/vanguard-mark-on-dark.svg` · `-on-light.svg` · `.svg` | Solo el símbolo |
| `logo/vanguard-mark-compact-*.svg` | Símbolo con más peso, para menos de 64 px de ancho |
| `logo/favicon-dark.svg` · `favicon-light.svg` | Símbolo compacto en un cuadrado redondeado |
| `index.html` | Página de identidad: animaciones, construcción, escalas, archivos |
| `mark-data.js` | Contornos, ejes y cuadros del parpadeo (lo usa `index.html`) |
| `build-mark.py` | Genera todo lo anterior a partir de la geometría de los trazos |
| `build-wordmark.py` · `wordmark.json` | El nombre «VANGUARD» convertido a trazos desde Geist |
| `serve.py` | Servidor local sin caché |

Los archivos de `logo/` son **generados**: no se editan a mano. Para cambiar el logo se toca
`build-mark.py` y se vuelve a ejecutar (ver [Regenerar](#regenerar)).

## Logo

### Versiones

- **Logo con nombre** (`vanguard-logo-*`): la versión por defecto. Símbolo a la izquierda y
  «VAN**GUARD**» a la derecha, centrado en la línea de las esquinas del ojo.
- **Símbolo** (`vanguard-mark-*`): cuando el nombre ya está cerca (barra lateral, cabecera
  compacta, avatar) o no cabe.
- **Símbolo compacto** (`vanguard-mark-compact-*`): por debajo de 64 px de ancho. Mismos trazos
  con un 30 % más de peso para que no se pierdan.
- **Favicon** (`favicon-*`): solo para iconos de navegador y de app.

### Color

Solo dos combinaciones, y nada más:

- **Sobre oscuro**: logo en hueso `#EDEDEA` sobre tinta `#0A0A0A` (o cualquier fondo oscuro).
- **Sobre claro**: logo en tinta `#0A0A0A` sobre papel `#F7F7F5` (o cualquier fondo claro).

El logo **no lleva verde** ni ningún otro acento: la pupila es del mismo color que el resto.

### Tamaños y espacio

- Logo con nombre: mínimo **160 px** de ancho.
- Símbolo: desde **64 px** de ancho; por debajo, el compacto (hasta 16 px).
- Espacio libre alrededor: al menos la **altura de las mayúsculas del nombre** (≈ 30 % del
  alto del símbolo) por cada lado. Nada de texto ni bordes dentro de ese margen.

### No hacer

- Recomponer el nombre con texto vivo, cambiar su espaciado o sus pesos: se usa el archivo.
- Separar la V de la G, quitar el hueco del cruce o cambiar el orden (la V siempre encima).
- Colorear la pupila, poner degradados, sombras, contornos o brillos.
- Rotar, deformar o meter el símbolo en un escudo o un círculo (salvo el favicon).

## Look and feel

Lo que hay que trasladar al producto para que todo se vea como el logo.

### Principios

1. **Monocromo.** Tinta y papel. El color se reserva para *estados* (error, aviso, correcto,
   información), nunca para la marca ni la decoración.
2. **Contraste de peso, no de color.** Igual que «VAN» ligero y «GUARD» pesado: los textos
   corrientes van finos (300) y lo importante sube a 600–650.
3. **Líneas finas, formas firmes.** Separadores de 1 px muy suaves; superficies planas, sin
   sombras ni degradados.
4. **Silencio.** Mucho espacio en blanco, pocos elementos por pantalla, alineación limpia.
5. **Vigilancia tranquila.** El movimiento es lento y orgánico (como el parpadeo); nada rebota
   ni parpadea en rojo salvo una alerta real.

### Colores

| Token | Valor | Uso |
| --- | --- | --- |
| Tinta | `#0A0A0A` | Fondo del tema oscuro; texto y logo en el tema claro |
| Papel | `#F7F7F5` | Fondo del tema claro |
| Hueso | `#EDEDEA` | Texto y logo en el tema oscuro |
| Gris | `#7A7A76` (oscuro) · `#6A6A65` (claro) | Texto secundario (ambos ≥ 4,5:1 sobre su fondo) |
| Línea | `#1E1E1C` (oscuro) · `#E4E4E0` (claro) | Separadores y bordes suaves |
| Superficie | `#111110` (oscuro) · `#FFFFFF` (claro) | Tarjetas |

### Tipografía

- **Geist** para todo: 300 en texto corriente y títulos grandes; 600–650 para énfasis.
- **Geist Mono** para datos, etiquetas y botones: mayúsculas, 10–11 px, espaciado 0,12–0,16 em.
- Títulos grandes con poco espaciado; etiquetas pequeñas con mucho.

### Componentes

- **Botones**: píldora (radio completo), borde de 1 px, texto en Geist Mono en mayúsculas. El
  botón principal es sólido en hueso con texto en tinta (en claro, al revés).
- **Tarjetas**: radio pequeño (4 px), borde de 1 px en el color de línea, sin sombra.
- **Secciones**: separadas por una línea de 1 px y una etiqueta numerada en mono
  (`01  CONCEPTO`), como en `index.html`.

### Movimiento

Definido en `index.html` y `build-mark.py`:

| Animación | Cuándo | Detalle |
| --- | --- | --- |
| Trazado | Entrada de la app o la portada | La G de un gesto y luego la V, ~2,7 s |
| Parpadeo | En reposo, cada 3,5–9 s | 0,78 s; a veces doble. Cuadros precalculados (`blink` en `mark-data.js`) |
| Mirada | Siempre | La pupila sigue al cursor en 2D con un resorte; si no hay cursor, hace sacadas al azar |
| Escaneo | Mientras corre una auditoría | La pupila barre de lado a lado, 2,6 s por ciclo |

Todo se apaga con `prefers-reduced-motion`.

## Llevar la identidad a `apps/web`

Pasos para cambiar la app a este look and feel. Ninguno está hecho todavía en esta rama.

1. **Favicon.** Copiar `brand/logo/favicon-dark.svg` sobre `apps/web/public/favicon.svg`
   (el `index.html` de la app ya lo enlaza).
2. **Componente del logo.** Reemplazar el escudo de `apps/web/src/app/Marca.tsx` por el símbolo
   (`vanguard-mark.svg`, en `currentColor`) y, sin `compacta`, por el logo con nombre
   (`vanguard-logo.svg`). Importarlos como componentes o pegarlos como JSX; no usar texto vivo
   para el nombre.
3. **Logo animado** (opcional, para la portada o la pantalla de carga). Pasar a React la lógica
   de `index.html`: la función `mark()` arma el SVG, `gazeLoop()` mueve la pupila y `blink()`
   reproduce los cuadros con `requestAnimationFrame`. Dos cosas a tener en cuenta:
   - `mark-data.js` expone un global y pesa ~160 KB por los cuadros del parpadeo. Para la app
     conviene que `build-mark.py` escriba también un módulo JSON/TS y cargarlo de forma diferida,
     o bajar `BLINK_FPS`.
   - La CSP de la app no admite JS en línea: todo debe ir en el bundle, como el resto.
4. **Tokens de color** en `apps/web/src/styles/globals.css`. Propuesta de partida (validar con
   `apps/web/src/lib/contraste.test.ts`, que es quien manda):
   - Tema oscuro: `--background:#0A0A0A`, `--foreground:#EDEDEA`, `--card:#111110`,
     `--muted-foreground:#7A7A76` (o más claro si no llega a 4,5:1), bordes en la gama de `#1E1E1C`.
   - Tema claro: `--background:#F7F7F5`, `--foreground:#0A0A0A`, `--card:#FFFFFF`.
   - **`--marca`** deja de ser esmeralda: hueso `#EDEDEA` con `--marca-texto:#0A0A0A` en oscuro,
     y tinta `#0A0A0A` con `--marca-texto:#F7F7F5` en claro. Actualizar el comentario y los
     casos de `contraste.test.ts` que hablan de la marca.
   - `--mal`, `--aviso`, `--bien` e `--info` se quedan: son estados, no marca.
5. **Forma.** Bajar `--radius` (hoy `0.75rem`) a ~4 px para tarjetas y usar píldora en botones
   (`apps/web/src/componentes/ui/button.tsx`); revisar la variante `marca` para que sea el sólido
   hueso/tinta.
6. **Tipografía.** Ya se usa Geist y Geist Mono. Falta el contraste de pesos: texto a 300,
   énfasis a 600–650, y etiquetas en mono mayúsculas con espaciado.
7. **Iconos de la portada.** `apps/web/src/app/paginas/Inicio.tsx` usa iconos de lucide
   (escudo, ojo, chispas); valorar sustituir el escudo por el símbolo y dejar los iconos en
   trazo fino y monocromo.

## Regenerar

```bash
python3 brand/build-mark.py
```

Reescribe `brand/logo/*.svg` y `brand/mark-data.js`. La geometría está al principio del archivo:

- `STROKES`: cada trazo con su eje (curva cúbica), su perfil de grosor y el bisel de sus remates.
- `GAP`: ancho del hueco donde la V cruza la G.
- `POSES` y `CLOSED`: forma de los párpados a medio cerrar y cerrados; `BLINK_DUR` y `lid_p()`
  dan el ritmo del parpadeo.
- `INK`, `BONE`, `PAPER`: los colores de los archivos `-on-dark` y `-on-light`.

El nombre en trazos solo hay que regenerarlo si cambia el texto, el peso o el espaciado
(instrucciones en la cabecera de `build-wordmark.py`).

### PNG

No se generan automáticamente. Para exportar: abrir el SVG en Figma (o en el navegador) y
exportar a 2× o 4× sobre el fondo que toque. Para redes, el logo con nombre centrado sobre tinta
con el margen de espacio libre.
