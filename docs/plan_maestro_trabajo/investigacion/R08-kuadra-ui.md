# R08 · Sistema de UX de KUADRA CRM traducido a componentes web (React + Tailwind + shadcn/ui)

Investigación R08, etapa 1 de 4 del plan maestro. Destino: chat FRONT. Producto: **Blindaje IA** (team-22).

Fuentes leídas (solo lectura), todas bajo `C:\Users\giova\Desktop\KUADRA\KUADRA CRM\kuadra_crm\lib\`:
`app.dart`, `ui/tema.dart`, `ui/piezas.dart`, `ui2/tokens.dart`, `ui2/cascaron.dart`, `ui2/contador.dart`, `ui2/barra_modulo.dart`,
`ui2/pantalla.dart`, `ui2/botones.dart`, `ui2/bandeja.dart`, `ui2/ahora_datos.dart`, `ui2/detalle.dart`, `ui2/auditoria.dart`,
`ui2/cifras.dart`, `ui2/exportar.dart`, `ui2/editor_prompt.dart`, `ui2/diferencias.dart`, `ui2/escucha.dart`, `ui2/formato.dart`,
`ui2/navegar.dart`, `ui2/edicion.dart`, `ui2/sectores.dart`, `ui2/tabla.dart`, `ui2/graficas.dart`, `ui2/marca.dart`,
`ui2/refresco.dart`, `modulos/resumen/modulo.dart`, `modulos/resumen/pantalla.dart`.

KUADRA tiene **dos** lenguajes: `lib/ui` (viejo: Material 3 oscuro, `CabeceraPantalla`, `Cargando`, `MensajeError`, `VacioAmable`, `KpiTile`,
`AnilloPorcentaje`) y `lib/ui2` (nuevo, "ola 4": tokens WCAG, cascarón con riel, «Ahora», cifras de alto fijo). `app.dart` ya monta
solo el `Cascaron` de `ui2` con tema claro/oscuro según el sistema. **Se toma `ui2` como referencia**; de `ui` solo se rescatan los
estados vacío/error a pantalla completa y la "explicación en cristiano" de la cabecera, que encajan con el encargo (guía, botones grandes).

---

## 1. Reglas de UX que KUADRA hace cumplir (y que conviene copiar tal cual)

Cada regla cita su origen. Son el valor real del sistema; los widgets son solo su consecuencia.

| # | Regla | Origen |
|---|---|---|
| R1 | **Cinco roles de estado y nada más**: `mal` (parar algo ya), `aviso` (límite cerca / decisión pendiente), `cola` (trabajo acumulado, número ámbar sin tinte), `bien` (SOLO lo verificado), `neutro`. Más `acento` (azul) para "acción principal / pulsado / cambio pendiente". | `tokens.dart` enum `Rol`, `cifras.dart` `VarianteCifra` |
| R2 | **El rojo nunca es relleno sólido**: tinte al 10 % sobre la superficie + texto rojo. En oscuro el rojo tira a rosa (#FF6F8E) para no confundirse con el color de marca. | `tokens.dart` `_rojoOscuro`, `_alfaRelleno = 0.10`, `_alfaBorde = 0.45` |
| R3 | **Rojo o ámbar solo con una acción al lado**. Una fila o píldora en `mal` sin acción se pinta neutra. | `bandeja.dart` `FilaProblema` (regla 4), `barra_modulo.dart` `PildoraEstado` |
| R4 | **Tres "nada" distintos**: sin dato/cargando = «—» en texto terciario (nunca verde, nunca rojo); cero problemas = «0 ✓» **neutro** ("nada que contar no es verificado"); verde = comprobado («Servicios 4 / 4»). | `contador.dart`, `pantalla.dart` `Seccion`, `cifras.dart` `Cifra` |
| R5 | **Un solo botón de color de marca por vista**, y solo cuando hay algo que aplicar. Todo lo demás: tinte `info` (principal), neutro (secundario) o tinte rojo (peligro). | `marca.dart` `BotonMarca`, `botones.dart` `TipoAccion` |
| R6 | **Nunca ventana emergente para confirmar**: la confirmación ocurre en el sitio del botón (`[plazo] [Cancelar] [Quitar 7]`), opcionalmente con vista previa que calcula el servidor (`p_simular = true`). Nunca «Deshacer». | `botones.dart` `ConfirmarEnSitio`, `ConfirmarConVista`; `edicion.dart` |
| R7 | **Verbos exactos con su cifra**: «Quitar 7», «Subir a 600», «Volver a 30». Resultado en el mismo sitio: «Cerradas 31 · 21:41». | `botones.dart` `BotonAccion.resultado`, `Veredicto.texto` |
| R8 | **La base decide, la UI pinta**: contadores, filas de «Ahora», acciones (verbo, rpc, args), efecto de la simulación y diffs llegan hechos del servidor. El cliente nunca recuenta ni arma SQL. | `ahora_datos.dart`, `bandeja.dart` `AccionFila`, `diferencias.dart` |
| R9 | **Orden fijo de toda pantalla**: barra del módulo → cifras → «Ahora» (lo que está mal) → secciones del módulo → «Auditoría» (estado, checks en cero, historial). El riel tampoco se reordena por gravedad. | `pantalla.dart` doc de `slivers`, `cascaron.dart` `RielCascaron` |
| R10 | **Un solo dueño del scroll** por pantalla; cabeceras de sección fijas (sticky); la cabecera fija nunca pasa de 1/3 del alto (si no cabe, las cifras bajan a la lista). | `pantalla.dart` |
| R11 | **Nada se mueve bajo el ojo**: tarjetas de cifra con alto fijo por construcción (78,2 px a escala 1), filas de alto fijo, sectores que esperan plegados en vez de empujar. | `cifras.dart` `Cifra.alto`, `tabla.dart`, `sectores.dart` |
| R12 | **Solo gasta backend cuando se ve**: refresco cada 30 s solo con la ventana y el módulo a la vista; sin conexión se quedan los datos viejos con su hora y aparece «Sin conexión · Reintentar». | `refresco.dart` `CicloDatos`, `cascaron.dart` `EstadoGlobal` |
| R13 | **Lo global, una sola vez y arriba**: «Sin conexión» o «Sin clave → Ir a Ajustes» bajo el logo; sin clave se aterriza en Ajustes y Ajustes muestra `[1]` rojo. | `cascaron.dart` `FilaEstadoGlobal`, `_aterrizaje()` |
| R14 | **Navegar con el filtro como dato**: «Bloquear IP» abre el módulo IPs con la IP puesta y el cambio propuesto (`Destino{modulo, filtro, ancla, cambio}`), nunca por portapapeles. | `navegar.dart` |
| R15 | **Exportar CSV seguro**: UTF-8 con BOM, `;`, CRLF, comillas RFC 4180 y celdas que empiezan por `= + - @ \t \r` prefijadas con `'` (anti inyección de fórmulas). | `exportar.dart` |
| R16 | **Prompt con núcleo bloqueado**: el editor solo devuelve la parte editable; el núcleo se ve en terciario con candado, seleccionable pero no editable; contador ámbar > 90 %, rojo al pasarse. | `editor_prompt.dart` |

### 1.1 Dónde Blindaje IA debe separarse de KUADRA

KUADRA es una sala de control densa de escritorio (Windows `.exe`) para UN dueño experto: controles de 28 px, texto de 11-13 px,
filetes de 0,5 px, atajos Ctrl+N y F5. El encargo de hoy pide lo contrario en superficie: **botones claros y GRANDES, guía, usuario no
experto, web** y una demo en proyector ante jueces. Por tanto:

- Se copian las **reglas** (R1-R16) y los **contratos JSON**; se cambia la **escala** (sección 2.3) y se añade una capa de guía
  (`GuiaPasos`, `BotonGrande`, `ConectarClave`) que KUADRA no tiene.
- Atajos: en navegador **F5 recarga la página, Ctrl+F es buscar y Ctrl+1…9 cambian de pestaña** (Chrome los reserva [no verificado:
  comprobar que `preventDefault` no los captura en Chrome/Edge]). Ver sección 9.
- La maquinaria de rendimiento de Flutter (`MemoriaFilas`, `_AvisaTamano`, `IndexedStack`, `Escucha`) no se porta: en React la
  sustituyen `React.memo`, claves estables y el router.

---

## 2. Tokens de diseño

### 2.1 Colores de KUADRA `ui2` (valores BASE; el texto final se deriva a contraste WCAG)

| Token KUADRA | Oscuro | Claro | Uso |
|---|---|---|---|
| `fondo` | `#0A0A0A` | `#EAE6DE` | página, riel |
| `superficie` | `#232327` | `#FFFFFF` | controles |
| `superficieSutil` | `#303036` | `#DDD8CE` | cifra neutra, fila desplegada, pista de barras |
| `textoPrimario` | `#FFFFFF` | `#17181B` | texto |
| `textoSecundario` | `#A8AEB9` | `#54595F` | sub, rótulos |
| `textoTerciario` | `#7C828C` | `#7A7F86` | «—», cabeceras de columna, ejes (3:1) |
| `borde` | `#3C3C43` | `#CFC9BC` | filete entre filas |
| `bordeFuerte` | `#5E5E69` | `#938C7E` | panel de detalle (3:1) |
| rojo `mal` (base) | `#FF6F8E` | `#EF4444` | tinte 10 %, borde 45 % |
| ámbar `aviso` (base) | `#F59E0B` | `#F59E0B` | |
| verde `bien` (base) | `#4ADE80` | `#4ADE80` | |
| azul `info`/acento (base) | `#3B82F6` | `#3B82F6` | principal, pulsado, editado |
| marca (solo `BotonMarca`) | `#FF6435` / texto `#17181B` | igual | único botón sólido |

Derivación (`tokens.dart` `_derivar`): `relleno(rol) = alphaBlend(rol @ 10 %, superficie)`, `borde(rol) = alphaBlend(rol @ 45 %, superficie)`,
y el **contenido** (texto/icono del rol) se aclara u oscurece en HSL hasta lograr **4,5:1 contra fondo, superficie, superficieSutil y su
propio relleno**; terciario y bordeFuerte a 3:1. En claro eso oscurece mucho ámbar y verde (ámbar #F59E0B sobre blanco no llega a 4,5:1).

### 2.2 Propuesta para Blindaje IA: CSS de tema (Tailwind v4 + nombres de shadcn)

shadcn/ui usa las variables `--background --foreground --card --card-foreground --popover --primary --secondary --muted
--muted-foreground --accent --destructive --border --input --ring --chart-1..5 --sidebar-*` y `--radius`, mapeadas en `@theme inline`
como `--color-background: var(--background)` [verificado: https://ui.shadcn.com/docs/theming]. Se añaden los tokens de rol propios.
Valores: neutros de KUADRA; textos de rol en claro precalculados con tonos 700 de Tailwind **a validar con el test de contraste (2.5)**;
color de marca **propuesto** violeta (no comparte tono con ningún rol; el amarillo del logo del hackatón chocaría con `aviso`).

```css
/* app/globals.css (fragmento). Tema oscuro por defecto: sala de control + demo en proyector. */
:root {
  --radius: 0.75rem;                          /* 12 px = Radios.tarjeta */
  --background: #EAE6DE;  --foreground: #17181B;
  --card: #FFFFFF;        --card-foreground: #17181B;
  --popover: #FFFFFF;     --popover-foreground: #17181B;
  --muted: #DDD8CE;       --muted-foreground: #54595F;   /* superficieSutil / textoSecundario */
  --texto-3: #6B7078;                                    /* terciario; validar 3:1 */
  --border: #CFC9BC;      --input: #CFC9BC;   --borde-fuerte: #938C7E;
  --mal: #B91C1C;  --aviso: #B45309;  --bien: #15803D;  --info: #1D4ED8;   /* contenido; validar 4,5:1 */
  --marca: #7C3AED;  --marca-texto: #FFFFFF;
  --ring: var(--info);  --primary: var(--info);  --primary-foreground: #FFFFFF;
  --destructive: var(--mal);
}
.dark {
  --background: #0A0A0A;  --foreground: #FFFFFF;
  --card: #232327;        --card-foreground: #FFFFFF;
  --popover: #232327;     --popover-foreground: #FFFFFF;
  --muted: #303036;       --muted-foreground: #A8AEB9;
  --texto-3: #7C828C;
  --border: #3C3C43;      --input: #3C3C43;   --borde-fuerte: #5E5E69;
  --mal: #FF6F8E;  --aviso: #F59E0B;  --bien: #4ADE80;  --info: #60A5FA;   /* info subido para 4,5:1 sobre #303036; validar */
  --marca: #A78BFA;  --marca-texto: #0A0A0A;
  --ring: var(--info);  --primary: var(--info);  --primary-foreground: #0A0A0A;
  --destructive: var(--mal);
}
/* Rellenos y bordes de rol derivados como en KUADRA (10 % / 45 % sobre la superficie). */
:root, .dark {
  --mal-relleno:   color-mix(in srgb, var(--mal) 10%, var(--card));
  --mal-borde:     color-mix(in srgb, var(--mal) 45%, var(--card));
  --aviso-relleno: color-mix(in srgb, var(--aviso) 10%, var(--card));
  --bien-relleno:  color-mix(in srgb, var(--bien) 10%, var(--card));
  --info-relleno:  color-mix(in srgb, var(--info) 10%, var(--card));
}
@theme inline {
  --color-background: var(--background); --color-foreground: var(--foreground);
  --color-card: var(--card); --color-muted: var(--muted); --color-muted-foreground: var(--muted-foreground);
  --color-border: var(--border); --color-ring: var(--ring); --color-primary: var(--primary);
  --color-texto-3: var(--texto-3); --color-borde-fuerte: var(--borde-fuerte);
  --color-mal: var(--mal); --color-mal-relleno: var(--mal-relleno); --color-mal-borde: var(--mal-borde);
  --color-aviso: var(--aviso); --color-aviso-relleno: var(--aviso-relleno);
  --color-bien: var(--bien); --color-bien-relleno: var(--bien-relleno);
  --color-info: var(--info); --color-info-relleno: var(--info-relleno);
  --color-marca: var(--marca); --color-marca-texto: var(--marca-texto);
  --font-sans: var(--font-geist-sans); --font-mono: var(--font-geist-mono);
}
```
Notas: `color-mix()` está en todos los navegadores modernos [no verificado: confirmar en caniuse antes de depender de él; alternativa
`bg-mal/10` de Tailwind v4 sobre `bg-card`]. La regla «el rojo nunca sólido» se aplica en el componente: **no existe** clase `bg-mal`
en el código (lint con `grep -R "bg-mal\b"` en CI), igual que en KUADRA una prueba caza cualquier `Color(0x…)` fuera de `tokens.dart`.

### 2.3 Tipografía, espaciado, radios y altos

| Token | KUADRA (escritorio denso) | **Blindaje IA (web, botones grandes)** | Clase Tailwind sugerida |
|---|---|---|---|
| `cifra` (número de tarjeta) | 22 / 500 / 1.3, tabular | 30 / 600 / 1.2, tabular | `text-3xl font-semibold tabular-nums` |
| `titulo` (módulo) | 16 / 500 | 22 / 600 | `text-[22px] font-semibold` |
| `seccion` | 14 / 500 | 17 / 600 | `text-[17px] font-semibold` |
| `fila` | 13 / 400 / 1.45, tabular | 15 / 400 / 1.5 | `text-[15px] tabular-nums` |
| `control` (botón, sub) | 12 / 400 | 14 / 500 | `text-sm font-medium` |
| `etiqueta` (chapa, cabecera de columna, eje) | 11 / 400 | 12.5 / 500 | `text-[12.5px] font-medium` |
| `mono` (IPs, rutas, tablas, CVE) | Consolas 12 | Geist Mono / JetBrains Mono 13 | `font-mono text-[13px]` |
| Pesos | solo 400 y 500 | 400, 500, 600 | |
| Espacios | 4, 6, 8, 10; sección arriba 28 / abajo 6; grupo arriba 14 | 4, 8, 12, 16; sección arriba 32 / abajo 8; grupo arriba 16 | `gap-1/2/3/4`, `mt-8 mb-2`, `mt-4` |
| Radios | etiqueta 8, tarjeta 12, barra 3, pista 2 | igual (8 / 12 / 3 / 2) | `rounded-lg`, `rounded-xl`, `rounded-[3px]` |
| Alto control | 28 | **compacto 36 · normal 44 · grande 64** (`BotonGrande`) | `h-9`, `h-11`, `min-h-16` |
| Alto fila tabla / historial | 34 / 32 | 48 / 44 | `h-12`, `h-11` |
| Chapa / píldora | 18 / 24 | 24 / 30 | `h-6`, `h-[30px]` |
| Barra segmentada / pista | 6 / 4 (máx. 220 px) | 8 / 6 (máx. 280 px) | `h-2`, `h-1.5` |
| Filete | 0,5 px | 1 px (0,5 solo se ve en HiDPI) | `border` |
| Riel | 216 px, 64 corto (< 1200 px o Ctrl+B) | 240 px, 64 corto (< 1200 px o Ctrl+B) | `--sidebar-width: 15rem` |
| Panel detalle | 420 px al lado si ancho útil ≥ 1100; superpuesto (máx. 60 %) si no | igual: `aside w-[420px]` ≥ 1100, `Sheet` por debajo | |
| Íconos | 16 (12-14 en chapas) | 18 (14 en chapas), `lucide-react` | |

Sin sombras ni degradados, sin onda (ripple) al pulsar: KUADRA lo decide explícitamente (`temaUi2`, `CajaBoton`).

### 2.4 Formatos (de `ui2/formato.dart`; portar tal cual, todo en español de Venezuela)

`—` sin dato · separador ` · ` · miles con punto `9.000` · decimal con coma `0,2` · `90 %` con espacio · `60 → 120` · bytes base 1024
`512 B / 8 KB / 44,4 MB / 106 MB / 1,5 GB` (un decimal por debajo de 100) · duraciones `344 ms / 39,1 ms / 5,0 s / 2 min 4 s / 1 h 5 min
/ 2 d 3 h` · hora `21:14` hoy, `08-10 22:35` otro día, en hora de Caracas (UTC−4 fijo).

```ts
// lib/formato.ts — port directo de ui2/formato.dart
export const SIN_DATO = '—'
export const SEP = ' · '
export function miles(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return SIN_DATO
  const e = Math.round(n)
  return (e < 0 ? '-' : '') + Math.abs(e).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
export function decimal(x?: number | null, decimales = 1): string {
  if (x == null || !Number.isFinite(x)) return SIN_DATO
  if (decimales <= 0) return miles(x)
  const [ent, frac] = Math.abs(x).toFixed(decimales).split('.')
  const cero = Number(ent) === 0 && /^0*$/.test(frac)
  return (x < 0 && !cero ? '-' : '') + miles(Number(ent)) + ',' + frac
}
export const pct = (p?: number | null) => (p == null ? SIN_DATO : `${miles(p)} %`)
export const flecha = (a: unknown, d: unknown) => `${a == null ? SIN_DATO : typeof a === 'number' ? miles(a) : a} → ${d == null ? SIN_DATO : typeof d === 'number' ? miles(d) : d}`
export const unir = (p: (string | null | undefined)[]) => p.filter(Boolean).join(SEP)
const UNIDADES = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
export function bytes(b?: number | null): string {
  if (b == null) return SIN_DATO
  let v = Math.abs(b), i = 0
  while (i < UNIDADES.length - 1 && v >= 1024) { v /= 1024; i++ }
  if (i < UNIDADES.length - 1 && Math.round(v) >= 1024) { v /= 1024; i++ }
  const n = i === 0 ? miles(v) : v < 100 ? decimal(v).replace(/,0$/, '') : miles(v)
  return `${b < 0 ? '-' : ''}${n} ${UNIDADES[i]}`
}
const hhmm = new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', hour12: false })
const ddmm = new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit' })
export function cuando(t?: Date | string | null, ahora = new Date()): string {
  if (!t) return SIN_DATO
  const d = typeof t === 'string' ? new Date(t) : t
  const mismoDia = ddmm.format(d) === ddmm.format(ahora)
  return mismoDia ? hhmm.format(d) : `${ddmm.format(d).replace('/', '-')} ${hhmm.format(d)}`
}
```
No usar `Intl.NumberFormat('es-ES')` para miles: con 4 cifras no agrupa por defecto [no verificado: depende de `minimumGroupingDigits`
del locale en ICU]; la función manual es determinista.

### 2.5 Contraste: port del candado de KUADRA (para un test de Vitest)

```ts
// lib/contraste.ts — de tokens.dart luminanciaRelativa / contraste
const canal = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
export function luminancia(hex: string) {
  const n = parseInt(hex.replace('#', ''), 16)
  return 0.2126 * canal((n >> 16) & 255) + 0.7152 * canal((n >> 8) & 255) + 0.0722 * canal(n & 255)
}
export function contraste(a: string, b: string) {
  const la = luminancia(a), lb = luminancia(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
// test: para cada tema, cada rol (mal, aviso, bien, info) >= 4.5 contra background, card y muted;
// texto-3 y borde-fuerte >= 3.0. Si falla, se ajusta el hex en globals.css (no en el componente).
```

---

## 3. Cascarón y navegación por módulos

### 3.1 Cómo lo hace KUADRA (`cascaron.dart`, `app.dart`)

- **Registro**: cada módulo expone UNA constante `ModuloCrm{id, nombre, icono, atajo, tecla, categoria, construir, alArrancar}`;
  `app.dart` los lista en el orden del riel. Categorías: `portada` (Resumen, suelto arriba), `tecnologia`, `comercios` (con rótulo)
  y `pie` (Ajustes). Solo existen las categorías con contenido.
- **Riel** de 216 px (64 px por debajo de 1200 px de ancho o con Ctrl+B): logo + «CRM» (40 px) → fila de estado global si hace
  falta → Resumen → rótulo de categoría (28 px, 11 px secundario) + sus módulos → hueco → Ajustes → «◷ 21:40» (hora del dato;
  roja sin conexión).
- **Entrada del riel** (32 px, radio 8): icono 16 · nombre · `MarcasContador`. Activa = relleno `info` + texto `info`. Clic en el
  nombre abre el módulo donde se dejó; **clic en el contador abre su «Ahora»**. Ayuda: «nombre · Ctrl+3». Corta: icono + marca peor.
- **Clic en el rótulo de categoría** abre el módulo de peor nivel (peor rol → más rojas → más filas → orden del riel).
- **Contadores**: `ContadorModulo{rojo, aviso, cola, hora}` por módulo, leídos de UNA función del servidor
  (`crm_cascaron_estado()`) cada 30 s, también para módulos ocultos; el de Resumen es la suma. `null` en los tres = «—».
- **Marcas del contador** (iguales en riel, cabecera y portada): rojo > 0 → píldora con número (tinte rojo); aviso+cola > 0 →
  número ámbar, con tinte solo si hay `aviso`; todo 0 → «0» terciario (con ✓ en tamaño grande), **nunca verde**; sin dato → «—».
- **Aterrizaje**: Resumen si hay clave; si no, Ajustes. Los módulos visitados quedan montados (`IndexedStack`): cambiar de módulo
  no pierde scroll ni filtros. Se recuerda el último módulo y el riel corto.

### 3.2 Traducción web

- Rutas (Next.js App Router si ese es el stack; `parte5-decisiones-y-plan.md` fila 9 ya lo asume): `app/(app)/[modulo]/page.tsx`
  con `layout.tsx` = `AppShell`. Datos en caché (TanStack Query o SWR) para que volver a un módulo no recargue; filtros en la URL.
- Riel = **shadcn `Sidebar`** con `collapsible="icon"`: trae `SidebarProvider`, `SidebarGroupLabel`, `SidebarMenuButton`,
  `SidebarMenuBadge`, `SidebarRail`, `useSidebar()` y **atajo Ctrl+B por defecto** (el mismo de KUADRA); ancho `"16rem"`
  configurable con `--sidebar-width` [verificado: https://ui.shadcn.com/docs/components/sidebar].
- `Destino` (`navegar.dart`) → URL: `{modulo:'cloudflare', filtro:'203.0.113.7', ancla:'ahora'}` →
  `/cloudflare?filtro=203.0.113.7#ahora`. El filtro viaja como dato, nunca por portapapeles (R14).

Registro propuesto (el orquestador fija la lista final):

```ts
// lib/modulos.ts
import type { LucideIcon } from 'lucide-react'
import { Activity, Database, Cloud, GitBranch, Gauge, ShieldCheck, Bell, Share2, KeyRound } from 'lucide-react'
export type Categoria = 'portada' | 'ecosistema' | 'acciones' | 'pie'
export interface ModuloDef { id: string; nombre: string; icono: LucideIcon; categoria: Categoria; ruta: string; descripcion: string }
export const MODULOS: ModuloDef[] = [
  { id: 'resumen',     nombre: 'Resumen',        icono: Activity,    categoria: 'portada',    ruta: '/resumen',     descripcion: 'Todo lo que está mal ahora, de todos tus servicios.' },
  { id: 'supabase',    nombre: 'Supabase',       icono: Database,    categoria: 'ecosistema', ruta: '/supabase',    descripcion: 'Salud de la base, RLS, funciones sin freno, tablas hinchadas.' },
  { id: 'cloudflare',  nombre: 'Cloudflare',     icono: Cloud,       categoria: 'ecosistema', ruta: '/cloudflare',  descripcion: 'IPs y user agents insistentes, picos, configuración débil.' },
  { id: 'codebase',    nombre: 'Codebase',       icono: GitBranch,   categoria: 'ecosistema', ruta: '/codebase',    descripcion: 'Dependencias con CVE, .env subido, credenciales filtradas.' },
  { id: 'rendimiento', nombre: 'Rendimiento',    icono: Gauge,       categoria: 'ecosistema', ruta: '/rendimiento', descripcion: 'Lighthouse por versión, comparado con la anterior.' },
  { id: 'auditoria',   nombre: 'Auditoría',      icono: ShieldCheck, categoria: 'acciones',   ruta: '/auditoria',   descripcion: 'Revisa todo el ecosistema con un botón.' },
  { id: 'alertas',     nombre: 'Alertas',        icono: Bell,        categoria: 'acciones',   ruta: '/alertas',     descripcion: 'WhatsApp y llamada: a quién, cuándo y qué se envió.' },
  { id: 'exportar',    nombre: 'Llevar a tu IA', icono: Share2,      categoria: 'acciones',   ruta: '/exportar',    descripcion: 'Exporta hallazgos y prompts para cualquier IA.' },
  { id: 'conexiones',  nombre: 'Conexiones',     icono: KeyRound,    categoria: 'pie',        ruta: '/conexiones',  descripcion: 'Tus claves y tu repo. Solo lectura.' },
]
```
Equivalencias: `resumen` ↔ `modulos/resumen`; `supabase` ↔ `base_datos` + `freno` + `seguridad` + `sesiones`; `cloudflare` ↔
`cloudflare` + `ips`; `conexiones` ↔ `ajustes`; `exportar` ↔ IA-15 + `ia`. Sin conexiones: aterriza en `/conexiones` y el riel pinta
`[1]` rojo en Conexiones (R13). `descripcion` es la "explicación en cristiano" de `ui/piezas.dart` `CabeceraPantalla`: se pinta bajo
el título del módulo (lo pide el encargo: guía para no expertos).

### 3.3 Contrato del contador global (FRONT ↔ BACK)

```ts
// RPC cascaron_estado() → UNA lectura cada 30 s con la pestaña visible
export interface Contador { rojo: number | null; aviso: number | null; cola: number | null; hora?: string }
export interface CascaronEstado {
  ok: boolean
  hora: string                                 // ISO del servidor = «hora del dato» al pie del riel
  modulos: ({ modulo: string } & Contador)[]   // uno por módulo; ausente = «—»
  errores?: Record<string, string>             // {"cloudflare":"token_invalido"} → «—» en ese módulo, sin culpar a la red
}
```
Suma (`contador.dart` `operator +`): `null + x = x`; la hora resultante es la más vieja. La UI nunca recuenta filas (R8).

---

## 4. Esqueleto de pantalla de módulo (`ui2/pantalla.dart`)

```
┌ BarraModulo ─────────────────────────────────────────────────────────────────┐
│ Título  [3] [4]   descripción de una línea          (derecha) PildoraEstado   │ fila 1: título · contador (clic → «Ahora»)
│ [1 h|24 h|7 d|30 d]  [⟳ 21:20]                      EnlaceModulo ›            │ fila 2: rango · Actualizar + hora · enlaces
├ FilaCifras (fija si cabe en 1/3 del alto; si no, primera fila de la lista) ───┤
├ BarraCambios (solo con cambios pendientes) ───────────────────────────────────┤
├ lista: ÚNICO scroll ──────────────────────────────┬ PanelDetalle 420 px ──────┤
│ ▸ Ahora [3][4]        (cabecera sticky)            │ ≥ 1100 px útiles: al lado │
│   grupo → FilaProblema con acciones                │ < 1100: Sheet a la        │
│   checks en cero                                   │ derecha, máx. 60 % ancho, │
│ ▸ Secciones propias del módulo (sticky)            │ la lista no se mueve      │
│ ▸ Auditoría: RejillaEstado · ChecksEnCero · Historial                          │
└────────────────────────────────────────────────────┴───────────────────────────┘
```
Relleno KUADRA `16, 8, 16, 0`; 24 px libres al final. Sin conexión, la píldora de estado se cambia por «Sin conexión» (chapa roja con
icono de nube tachada) + «Reintentar» (principal) y los datos viejos se quedan con su hora. Secciones = `SectorPlegable`: cabecera
fija, cuerpo no renderizado mientras está plegado, acordeón entre exclusivos; «Ahora» es independiente y se abre sola con problemas
nuevos salvo que abrirse empuje lo que se está mirando.

**Ejemplo real: la portada de KUADRA** (`modulos/resumen/pantalla.dart`). `BarraModulo(titulo:'Resumen', contador: total)` →
`FilaCifras(unaFila:true, maxColumnas:8, anchoMinimo:104)` con 6 cifras: **Servicios** (`ok / total`; verde solo si todos responden,
rojo si alguno cae; sub «Base 12 ms · REST 40 ms»), **CPU %** (sub «Carga 0,42»), **Memoria %** (sub «1,2 GB de 4 GB»), **Disco %**,
**Base** (% del límite del plan; aviso 80 %, mal 95 %; sub «106 MB de 500 MB»), **Conexiones** (`n / max`) → sector **Ahora**
(`Bandeja(gruposDeModulo:true)`: primero las rojas de TODOS los módulos con la chapa de su módulo; luego un `GrupoModulo` por
módulo con aviso/cola, ordenados peor → más rojas → más filas → orden del riel; al pie `ChecksEnCero` con los módulos sin filas) →
acordeón de consulta: **Servidor 10 min** (`RejillaEstado` de 4 columnas con la latencia de cada servicio + 4 `SerieViva`: CPU,
Memoria, Red bajada, Red subida), **Base**, **Crones**, **Mesero 24 h**. Cada cifra es clicable y lleva a su grupo o sector.
**Esa portada es casi literal el «Resumen» de Blindaje IA** con Supabase como fuente (CPU, RAM, disco, conexiones).

---

## 5. Estados: vacío, cargando, error, sin conexión, sin clave

| Estado | KUADRA `ui2` | Blindaje IA |
|---|---|---|
| Cargando (primera vez) | Cada cifra y contador muestra «—» terciario con su alto definitivo; `Bandeja(grupos:null)` = «—». Sin spinner de página. | Igual: `Cifra n={null}`. Nada de *skeleton* que cambie de alto. `Spinner` de shadcn solo dentro de botones [verificado que existe: https://ui.shadcn.com/docs/components]. |
| Acción en curso | `BotonAccion(ocupado:true)`: indicador de 12 px delante del texto, **mismos colores** (ocupado ≠ deshabilitado), sin clics. | `<Spinner className="size-3.5"/>` + `aria-busy`; sin `opacity-50`. |
| Actualizando | `BotonActualizar`: icono → indicador; un 2.º clic no lanza otra; si falla, tinte rojo y texto «Reintentar». | Idéntico, alimentado por `useCicloDatos` (9.2). |
| Vacío sano | «0 ✓» neutro en la cabecera de «Ahora»; sin mensaje. Verde solo en `ChecksEnCero` comprobados. | Igual; como mucho una línea: «Nada que atender · revisado 21:40». |
| Vacío de onboarding | No existe en `ui2`; en `ui/piezas.dart` `VacioAmable{icono, titulo, texto}` centrado, icono 34, texto máx. 460 px. | `Vacio` (shadcn `Empty`) **solo** si el módulo no tiene conexión: título + 1 línea + `BotonGrande` «Conectar Supabase» + enlace a la guía. |
| Error de módulo | Datos viejos con su hora + «Sin conexión · Reintentar» en la cabecera. Función inexistente (404): todo «—» sin culpar a la red. | Igual. Error del proveedor traducido a 1-3 palabras («Token inválido», «Sin permiso», «Límite de API»), texto crudo en la ayuda. |
| Error de acción | `Veredicto{ok:false, error}` → chapa roja en el sitio del botón; el texto del servidor en la ayuda. | Igual, con `traducirError(codigo)` por módulo. |
| Sin clave global | Riel: «Sin clave · Ir a Ajustes»; aterriza en Ajustes; Ajustes con `[1]` rojo. | «Sin conexiones · Conectar» → `/conexiones`. |
| Error de página | (viejo) `MensajeError{mensaje, reintentar}` centrado, máx. 520 px. | `ErrorBloque` (shadcn `Alert` con tinte rojo, nunca sólido) solo si la página entera no puede pintarse. |

---

## 6. «Ahora»: la bandeja de hallazgos (`bandeja.dart`, `ahora_datos.dart`)

La pieza central. Una **fila de problema** = icono del color del rol · **objeto** (mono: tabla, IP, paquete, ruta) o lista de chips ·
**sub** con cifras unidas por « · » («4 topes · 60/min · 21:14») · opcional barra fina «Cerca 90 %» · **etiqueta** de 1-3 palabras que
nombra el PROBLEMA («RLS desactivada», «IP insistente», «CVE crítica») · **acciones** con verbo exacto. Las acciones principales siempre
visibles; el resto (`masAcciones`) aparece al pasar el ratón o con foco de teclado (decisión del dueño del 01-10). Tras actuar, el
resultado («Visto · 21:41», «Prompt copiado · 21:42») sustituye a las acciones hasta el siguiente refresco.

Grupos: un grupo = una cifra de arriba con el **mismo número** (`GrupoAhora.n`); orden que manda el servidor (peor rol, luego
`orden`). Cuatro clases de acción, sin excepciones (`ClaseAccion`): `inmediata` (1 clic, resultado en la fila), `barra` (va a la
barra de cambios), `confirmar` (destructiva, confirmación en el sitio, con simulación si `simula`), `navegar` (abre otro módulo con
el filtro puesto). Más `copiar` (texto listo). **Para Blindaje IA se añade `prompt`** (pide al motor el prompt de corrección y lo abre
en el `PanelDetalle`), coherente con «el sistema propone, el humano decide».

Contrato JSON portado tal cual (§1.2-§1.5 del contrato de la ola 4 de KUADRA), en TypeScript:

```ts
// lib/contrato.ts — lo devuelve UNA lectura por módulo: rpc <modulo>_estado(p_rango)
export type RolDato = 'mal' | 'aviso' | 'cola' | 'bien' | 'neutra'
export type ClaseAccion = 'inmediata' | 'barra' | 'confirmar' | 'navegar' | 'copiar' | 'prompt'
export interface Destino { modulo: string; filtro?: string | Record<string, unknown>; ancla?: string; cambio?: { tipo: string; datos: Record<string, unknown> } }
export interface AccionDato {
  id?: string; verbo: string; clase: ClaseAccion; principal?: boolean   // verbo con su cifra: «Quitar 7»
  rpc?: string; args?: Record<string, unknown>; por_cada?: Record<string, unknown[]>  // una llamada por valor, en serie
  destino?: Destino; copiar?: string
  motivo?: boolean; motivo_defecto?: string                            // pide motivo (3..300) en el sitio
  simula?: boolean; efecto?: string                                    // vista previa: con simula la calcula el servidor
  resultado?: string; n?: number                                       // resultado esperado (1-3 palabras, sin hora)
}
export interface FilaDato {
  clave: string; modulo: string; tipo: string; rol: RolDato; etiqueta: string
  objeto?: string; chips?: string[]                                    // uno de los dos
  sub?: string; fraccion?: number                                      // 0..1 → BarraPista
  severidad_cve?: 'critical' | 'high' | 'medium' | 'low'               // extensión Blindaje IA (opcional)
  acciones: AccionDato[]
}
export interface GrupoDato { grupo: string; etiqueta: string; rol: RolDato; n: number; orden?: number; chapas?: string[]; filas: FilaDato[] }
export interface CifraDato {
  tipo: string; etiqueta: string; n: number | null; de?: number; rol?: RolDato
  unidad?: '%' | 'ms' | 'bytes' | 'h' | 'd'; decimales?: number; sub?: string; siempre?: boolean
  tramos?: { rotulo: string; n: number; tono: 'secundario' | 'acento' | 'aviso' | 'terciario' | 'fuerte' | 'mal' }[]
  columnas?: number; destino?: Destino; ancla?: string
}
export interface CheckDato { nombre: string; codigo: string; n: number | null; de?: number; comprobado: boolean; destino?: Destino }
export interface EstadoModulo {
  ok: boolean; error?: string; hora: string
  contador: Contador; cifras: CifraDato[]; ahora: GrupoDato[]; checks: CheckDato[]
}
// Respuesta de TODA escritura (§1.8). Con p_simular=true devuelve la vista previa; sin él, el veredicto.
export interface RespuestaEscritura {
  ok: boolean; error?: string; aviso?: string; rol?: 'neutra' | 'aviso' | 'mal'
  resultado?: string; en?: string                                    // «Cerradas 31» + ISO → «Cerradas 31 · 21:41»
  efecto?: string; chapas?: string[]; avisos?: string[]; riesgos?: string[]; verbo?: string   // solo en simulación
}
```
Mapeo de rol → color (`ahora_datos.dart` `rolDesdeJson`): `mal` rojo; `aviso` y `cola` ámbar (cola sin tinte); `bien` verde; resto neutro.
**Ganancia para 36 h**: con este contrato, Supabase, Cloudflare y Codebase usan UNA misma página genérica
(`<PantallaModulo estado={EstadoModulo}/>`); cada vertical solo añade sus secciones propias. El BACK decide filas, roles y verbos.

---

## 7. Botones y confirmaciones (`botones.dart`, `marca.dart`, `edicion.dart`)

| KUADRA | Web | Comportamiento a copiar |
|---|---|---|
| `TipoAccion.principal` | `variant="principal"`: `bg-info-relleno text-info border border-info` | acción principal de una fila o botón pulsado (`aria-pressed`) |
| `TipoAccion.secundaria` | `variant="secundaria"`: `bg-card text-foreground border-border` | neutra |
| `TipoAccion.peligro` | `variant="peligro"`: `bg-mal-relleno text-mal border-mal-borde` | confirmar lo destructivo; **nunca sólido** |
| `BotonMarca` | `variant="marca"`: `bg-marca text-marca-texto` | el ÚNICO sólido de la vista: «Auditar todo» en Resumen/Auditoría, «Aplicar N» en la barra de cambios |
| `CajaBoton` | base `cva` | alto fijo, radio 8, filete, sin ripple; `px-[9px]` → `px-4` en web |
| `BotonIcono` | `size="icon"` + `Tooltip` | etiqueta solo para lectores (`aria-label`) |
| `BotonCopiar` | idem + `navigator.clipboard.writeText` | muestra «Copiado ✓» 2 s y vuelve a su verbo |
| `ConfirmarEnSitio` | estado local `confirmando` | reposo `[Quitar 7]` → `[plazo] [Cancelar] [Quitar 7 (peligro)]` en la misma línea; nunca modal |
| `ConfirmarConVista` | máquina `reposo → simulando → vista → escribiendo → hecho` | pide `simular()` (servidor con `p_simular`), pinta `efecto` + chapas + avisos (ámbar) + riesgos (rojo), opcional motivo 3-300 y confirmación fuerte `teclear` (escribir el nombre); Esc cancela sin llamar |
| `BarraCambios` + `ControladorCambios` | `useCambios()` + barra bajo las cifras | lote «2 cambios · Descartar · Aplicar» → simulación → «antes → después · Afecta N · Cortaría N» → «Confirmar N». Tope de lote (freno: 50) |
| `Conmutador` / `SelectorRango` / `ChipsFiltro` | shadcn `ToggleGroup` | rangos `1 h · 24 h · 7 d · 30 d`; chips con cifra «Todas 211 · Críticas 4» |
| `Buscador` | `Input` 200 px con lupa | foco con `/` en web (Ctrl+F es del navegador) |

**Novedad de Blindaje IA: `BotonGrande`** (no existe en KUADRA; lo pide el encargo). Tarjeta-botón de `min-h-16`, icono 24 en un
cuadrado `bg-info-relleno`, título 16/600 + descripción 14 secundaria, chevron a la derecha, estado opcional (chapa «Conectado ✓» en
`bien` solo tras verificar el token; «Falta» neutro). Uso: acciones de primer nivel de cada módulo («Conectar Supabase», «Analizar
repo», «Subir ZIP», «Auditar todo», «Generar prompt de corrección»). Se construye sobre shadcn `Item` o `Button asChild`
[verificado que `Item` existe: https://ui.shadcn.com/docs/components].

---

## 8. Detalle (`detalle.dart`)

- `PanelDetalle{icono, titulo, mono=true, chapas[], sub?, izquierda[], derecha[], alCerrar}`: borde `bordeFuerte`, radio 12, relleno
  14×12; cabecera = icono 16 · nombre en mono 14 · chapas · botón cerrar; una línea de sub («RPC · POS · Usada hoy»); cuerpo en dos
  columnas si el panel mide ≥ 560 px, una si no. Esc lo cierra.
- `DetalleEnLinea` / `DetalleEnLineaSliver`: lo desplegado bajo una fila, fondo `superficieSutil`, radio 12, relleno 12×10.
- `Rotulo`: 11 px secundario («Cortaría», «Funciones 2»).
- `FichaFila{columnas, valores}`: cada valor ENTERO en mono, JSON con sangría 2 y seleccionable; `NULL` y `""` distintos y en
  terciario; «Copiar» por valor (no en NULL).

En Blindaje IA el detalle de un hallazgo lleva: explicación de Claude en lenguaje claro (izquierda), evidencia (`FichaFila`: política
RLS, cabeceras, línea del fichero con el secreto **redactado**), referencias (CVE con enlace a cve.org), y abajo `PromptCorreccion`.

---

## 9. Auditoría, historial, diferencias, exportar y prompt

### 9.1 Auditoría en KUADRA (`auditoria.dart`) = última sección de cada módulo

- `RejillaEstado{casillas: CasillaEstado[], columnas=3}` (2 si ancho < 480): casilla = rótulo 12 secundario · valor 13 (mono opcional,
  color de su rol) · sub («desde 08-10 22:35») · ✓ verde solo si `ok`; `valor null` = «—» y nunca ✓.
- `ChecksEnCero{checks}`: solo las comprobaciones en 0 o sin dato, juntas como chapas: verde con ✓ si `comprobado`, neutras si no;
  «Credenciales 4 de 4» con `de`. Las ≠ 0 no se repiten (ya son cifras de arriba). Clicables → `destino`.
- `PuntoEstado{rol, hueco}`: punto de 8 px; relleno del rol si está desviado, terciario si está bien (lo sano no se pinta verde), aro
  si «Sin comprobar».
- `Historial{entradas, cargado, alVolver, filtros, buscador}`: columnas `Cuándo 78 · Objeto 1fr (mono) · Cambio 1fr («30 → 60») ·
  Vía 60 («CRM», «Auto», «Cron») · Operador 108 (IP o versión; chapa roja «Nueva») · acción 112 («Volver a N» solo si N ≠ vigente;
  principal si la fila es anomalía)`. Filas de 32 px; fila anómala en rojo SOLO si trae su «Volver a».

### 9.2 Auditoría con UN botón (nuevo en Blindaje IA, compuesto con piezas de KUADRA)

`/auditoria`: `BotonMarca` «Auditar todo» → la vista pasa a una lista de **pasos** (un verificador por fila: «Supabase · RLS»,
«Supabase · funciones sin freno», «Cloudflare · TLS mínimo», «Codebase · CVE de dependencias», «Codebase · secretos»…) con
`PuntoEstado` (hueco = pendiente, spinner = corriendo, rol = resultado) y su cifra; al terminar: `PuntajeBlindaje` (0-100 con delta
contra la auditoría anterior y `BarraSegmentada` por severidad), la `Bandeja` con los hallazgos agrupados y `ChecksEnCero` con lo que
pasó limpio (verde: comprobado). Abajo, `Historial` de auditorías y `VistaDiferencias` «nuevos / resueltos» contra la anterior.
El progreso llega por Supabase Realtime o polling de 2 s a la fila de la auditoría [no verificado aquí: lo resuelve el informe de BACK].

### 9.3 Diferencias (`diferencias.dart`)

`VistaDiferencias{lineas: {t:'igual'|'mas'|'menos', n, x}[], plegarIguales=3}`: el diff lo calcula el servidor (LCS en
`crm_ia_prompt_diff`); `−` tachada en terciario, `+` con relleno `info`, iguales en secundario; rachas de > 3 iguales plegadas en
«N iguales» (clic despliega). **Sin rojo ni verde: un diff no es un estado.** Uso: prompt vs versión anterior, auditoría vs anterior,
`package.json` entre versiones.

### 9.4 Exportar (`exportar.dart`) y «Llevar a tu IA»

```ts
// lib/csv.ts — port de exportar.dart (anti inyección CSV)
const PELIGROSOS = new Set(['=', '+', '-', '@', '\t', '\r'])
export const celdaNeutralizada = (v: string) => (v && PELIGROSOS.has(v[0]) ? `'${v}` : v)
export function campoCsv(v: string) {
  const c = celdaNeutralizada(v)
  return /[;"\n\r]/.test(c) || c.trim() !== c ? `"${c.replace(/"/g, '""')}"` : c
}
export interface TablaCsv { titulo?: string; columnas: string[]; filas: string[][] }
export function textoCsv(tablas: TablaCsv[]) {
  return tablas.map(t => [t.titulo != null ? campoCsv(t.titulo) : null, t.columnas.map(campoCsv).join(';'),
    ...t.filas.map(f => f.map(campoCsv).join(';'))].filter(l => l != null).join('\r\n') + '\r\n').join('\r\n')
}
export const blobCsv = (t: TablaCsv[]) => new Blob(['﻿' + textoCsv(t)], { type: 'text/csv;charset=utf-8' })
```
«Llevar a tu IA» añade dos formatos que KUADRA no tiene: **Markdown** (contexto del stack + hallazgos por severidad + instrucciones de
corrección, listo para pegar en cualquier chat) y **JSON** (`EstadoModulo[]` + metadatos). Todo pasa antes por el redactor de secretos
del BACK (la UI nunca recibe un secreto en claro). Botones: `BotonCopiar` «Copiar para mi IA» (principal) y «Descargar .md / .json /
.csv» (secundarios).

### 9.5 Editor de prompt (`editor_prompt.dart`)

`EditorPrompt{nucleoAntes[], editable, nucleoDespues[], largoMax, errores: {linea?, texto}[], soloLectura, nucleoVersion, editado,
alCambiar}`: chapa «Núcleo n1 · fijo» con candado; zonas de núcleo en mono terciario sobre `superficieSutil`, seleccionables, no
editables; parte editable en mono 12 que crece con el texto (sin scroll propio); contador «178 / 4.000» (`rolLargo`: neutro ≤ 90 %,
ámbar > 90 %, rojo al pasarse; largo = puntos de código con `\r\n` → `\n`); errores por línea en rojo («Línea 3 · Delimitador
prohibido») que **vienen del servidor**; `alCambiar` devuelve SOLO la parte editable. En Blindaje IA: `PromptCorreccion` = este
editor en `soloLectura` por defecto (núcleo = instrucciones fijas de seguridad, p. ej. «no desactives RLS, no subas secretos»; parte
editable = contexto del hallazgo) + `BotonCopiar` «Copiar prompt» + «Regenerar» (ConfirmarEnSitio, gasta créditos de Claude).

---

## 10. Cifras y gráficas (`cifras.dart`, `graficas.dart`)

- `Cifra{etiqueta, n, total?, unidad?, decimales?, variante, sub?, tramos?, ayuda?, alPulsar?, columnas?, siempre?, textoNumero?}`:
  tres ranuras SIEMPRE presentes (etiqueta 12 · número 22 · ranura de 11/18) → alto fijo `2·8 + 12·1,3 + 22·1,3 + max(18, 11·1,3)` =
  78,2 px a escala 1. Variantes: `mal` (tinte + borde rojo), `aviso` (tinte ámbar), `cola` (neutra, número ámbar), `neutra`, `bien`
  (neutra, número verde: SOLO lo comprobado). `n null` → «—» y tarjeta neutra sea cual sea la variante. «/ 211» en secundario 14.
  Web: alto fijo con `h-[104px]` a la escala grande; `tabular-nums`.
- `FilaCifras{maxColumnas=5, anchoMinimo=120, unaFila, estirarUltima, juntar}`: rejilla; con `juntar`, lo menor se agrupa en «Otros
  +N» (nunca un rojo, una `siempre` ni una ancha). Web: `grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3`.
- `BarraSegmentada{tramos: {etiqueta, n, tono}[], leyenda}`: barra de 6 px proporcional + leyenda de una línea («Crítica 2 · Alta 5»);
  tramos a 0 no se pintan; el tono `mal` usa el BORDE rojo, nunca el rojo de texto sólido.
- `SerieViva{valores: (number|null)[], etiqueta, valor, maximo, puntos=60, alto=40}`: rótulo + valor actual arriba, línea sin ejes ni
  rejilla en texto secundario; `null` = hueco (no se midió). `GraficaSerie{valores, etiquetas, alto=56}`: barras por día en terciario,
  etiquetas primera/medio/última si no caben. `GraficaHoras`: 24 barras con línea del techo vigente y la pendiente discontinua en acento.
- Web: shadcn `Chart` (`ChartContainer`, `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, `ChartConfig`) sobre **Recharts v3**
  [verificado: https://ui.shadcn.com/docs/components/chart]. Para `SerieViva` basta `<LineChart>` sin `XAxis/YAxis/CartesianGrid`,
  `connectNulls={false}`, `isAnimationActive={false}`. Nuevo: `GraficaComparativa` (Lighthouse por versión: barras por despliegue de
  LCP/TBT/CLS/score con línea de umbral y la versión actual en `info`; la peor regresión con chapa `aviso`).

---

## 11. Teclado y refresco

### 11.1 Atajos (KUADRA → web)

| KUADRA | Acción | Web propuesta |
|---|---|---|
| Ctrl+0…9 | ir al módulo N | **Ctrl+K** paleta (shadcn `Command`) + `g` luego letra (`g s` Supabase, `g c` Cloudflare). Ctrl+1…9 cambian de pestaña en el navegador [no verificado si la página puede capturarlos] |
| Ctrl+B | riel corto/largo | Ctrl+B (default de shadcn Sidebar) [verificado] |
| Ctrl+↓ / Ctrl+. / Ctrl+↑ | siguiente / anterior módulo con rojo, luego con ámbar | `n` / `Shift+N` |
| F5 | actualizar módulo (y contadores) | `r` (F5 recarga la página: no tocarlo) |
| Ctrl+F | foco al buscador | `/` |
| Ctrl+S | aplicar/confirmar cambios | Ctrl+Enter |
| Esc | cancelar confirmación; si no hay, cerrar detalle | Esc |
| Alt+1…0 | abrir sector N | Alt+1…9 [no verificado conflicto en navegador] |

Mostrar cada atajo en la ayuda del botón con shadcn `Kbd` («Supabase · g s»), como KUADRA hace con «nombre · Ctrl+3».

### 11.2 Ciclo de datos (`refresco.dart` → hook)

```ts
// hooks/useCicloDatos.ts — semántica de CicloDatos
// abrir(): al montar el módulo, sincroniza (si hay) + carga una vez y arranca el reloj
// actualizar(): botón/atajo; sincroniza + carga; si ya hay una en curso, espera y corre (el clic nunca se pierde); lanza si falla
// reloj: cada 30 s SOLO con document.visibilityState === 'visible' y el módulo en pantalla; solo recarga (no sincroniza)
// fallo: conserva datos y horaDato; sinConexion = true → BarraModulo pinta «Sin conexión · Reintentar»
export interface CicloDatos<T> { datos: T | null; horaDato: Date | null; ocupado: boolean; sinConexion: boolean; actualizar(): Promise<void> }
```
Con TanStack Query: `refetchInterval: 30_000` + `refetchIntervalInBackground: false` + `placeholderData: keepPreviousData`
[no verificado: confirmar nombres en la versión instalada]. Las alertas críticas no esperan al reloj: llegan por Realtime y
encienden el contador del riel al momento.

---

## 12. Catálogo de componentes para el chat FRONT

Prioridad: **P0** = demo del domingo; **P1** = si sobra tiempo; **P2** = no construir en el hackatón. Ruta: `components/blindaje/`.
Props en TypeScript abreviado (`?` opcional). Tipos `Contador`, `Destino`, `FilaDato`, `GrupoDato`, `CifraDato`, `CheckDato`,
`EstadoModulo`, `RespuestaEscritura` de la sección 6. `Rol = 'mal'|'aviso'|'bien'|'acento'|'neutro'`.

| P | Componente | Origen KUADRA | Base shadcn | Props | Propósito |
|---|---|---|---|---|---|
| P0 | `AppShell` | `Cascaron` | `SidebarProvider`, `SidebarInset` | `modulos: ModuloDef[]; children` | riel + módulo; lee `cascaron_estado` cada 30 s; atajos globales |
| P0 | `RielModulos` | `RielCascaron` | `Sidebar collapsible="icon"` | `modulos; contadores: Record<string, Contador\|null>; activo: string; estadoGlobal: 'normal'\|'sin_conexion'\|'sin_clave'; horaDato: Date\|null` | orden fijo; logo; categorías; hora del dato al pie |
| P0 | `EntradaRiel` | `EntradaRiel` | `SidebarMenuButton` + `SidebarMenuBadge` | `modulo: ModuloDef; contador: Contador\|null; activa: boolean; onProblemas(): void` | clic nombre → módulo; clic contador → `#ahora` |
| P1 | `RotuloCategoria` | `RotuloCategoria` | `SidebarGroupLabel` | `nombre; onPulsar()` | clic → módulo de peor nivel de la categoría |
| P0 | `FilaEstadoGlobal` | `FilaEstadoGlobal` | — | `estado; onReintentar(); onIrConexiones()` | «Sin conexión · Reintentar» / «Sin conexiones · Conectar», una vez y arriba |
| P0 | `MarcasContador` | `MarcasContador` | `Badge` | `contador: Contador\|null; corta?; grande?` | las dos marcas (rojo / ámbar), «0», «—»; `aria-label` «Rojo 3 · Ámbar 4» |
| P0 | `PantallaModulo` | `Pantalla` | — | `barra; cifras?; cambios?; detalle?; onCerrarDetalle?; children` | esqueleto: cabecera fija ≤ 1/3, único scroll, detalle lateral ≥ 1100 o `Sheet` |
| P0 | `BarraModulo` | `BarraModulo` | — | `titulo; descripcion?; contador: Contador\|null; onProblemas?; estado?: ReactNode; rango?: ReactNode; onActualizar(): Promise<void>; horaDato; sinConexion; enlaces?: ReactNode[]` | cabecera de 2 filas de todo módulo |
| P0 | `BotonActualizar` | `BotonActualizar` | `Button` + `Spinner` | `onActualizar(): Promise<void>; horaDato: Date\|null` | ⟳ + hora; ocupado; falla → peligro «Reintentar» |
| P1 | `PildoraEstado` | `PildoraEstado` | `Badge` | `texto; rol; icono; accion?: ReactNode; onPulsar?` | «Vigilancia activa» (bien) / «Token caducado» + «Renovar»; rojo sin acción → neutra |
| P1 | `EnlaceModulo` | `EnlaceModulo` | `Button variant=secundaria` | `texto; destino: Destino; extra?; rolExtra?` | «Cloudflare 3 IPs ›» |
| P0 | `Seccion` | `Seccion` | — (sticky `top-0 bg-background`) | `icono; titulo; n?; problemas?; ceroBien?; controles?` | cabecera de sección: 32 arriba, 8 abajo |
| P1 | `Grupo` | `Grupo` | — | `icono; etiqueta; n?; rol; controles?` | subcabecera dentro de sección |
| P0 | `SectorPlegable` | `SectorPlegable` | `Collapsible` (exclusivos: `Accordion type="single"`) | `id; icono; titulo; n?; contador?; chapas?: {texto; rol}[]; controles?; abrible?; defaultOpen?; children` | rectángulo plegable; plegado no renderiza el cuerpo |
| P0 | `Cifra` | `Cifra` | `Card` | `etiqueta; n: number\|null; total?; unidad?; decimales?; variante: 'mal'\|'aviso'\|'cola'\|'neutra'\|'bien'; sub?: ReactNode; tramos?; ayuda?; onPulsar?` | tarjeta de alto fijo; clic → su grupo de «Ahora» |
| P0 | `FilaCifras` | `FilaCifras` | — | `cifras: CifraDato[]; maxColumnas?=6; juntar?` | rejilla; «Otros +N» |
| P1 | `BarraSegmentada` | `BarraSegmentada` | — | `tramos: {etiqueta; n; tono}[]; leyenda?` | reparto por severidad / cobertura |
| P0 | `Etiqueta` | `Etiqueta` | `Badge` (variantes por rol) | `texto; rol?; icono?; mono?; grande?; ayuda?` | chapa de 1-3 palabras con tinte del rol |
| P1 | `ListaChips` | `ListaChips` | — | `nombres: string[]; maximo?` | objetos de una fila-cola en mono, «+N» |
| P0 | `PuntoEstado` | `PuntoEstado` | — | `rol; hueco?` | punto de 8 px de un verificador |
| P0 | `Bandeja` | `Bandeja` | — | `grupos: GrupoDato[]\|null; porModulo?; ejecutar?(fila, accion, {simular, motivo}): Promise<RespuestaEscritura>; onNavegar(d: Destino); habilitada` | «Ahora» entera; guarda resultados por `clave` hasta el refresco |
| P0 | `FilaProblema` | `FilaProblema` | — | `fila: FilaDato; acciones: ReactNode; masAcciones?: () => ReactNode; chapaModulo?; resultado?: {texto; rol}` | fila de hallazgo; rojo/ámbar solo con acción |
| P0 | `AccionFila` | `AccionEjecutable` | — | `fila: FilaDato; accion: AccionDato; ejecutar` | resuelve las 6 clases de acción |
| P1 | `BarraPista` | `BarraPista` | `Progress` | `fraccion: number; rol?: 'aviso'\|'acento'` | «Cerca 90 %» (máx. 280 px; nunca roja sólida) |
| P0 | `ChapaModulo` | `ChapaModulo` | `Badge` | `modulo; icono; nombre` | en la portada, de qué módulo es la fila |
| P0 | `BotonAccion` | `BotonAccion` | `Button` + `cva` | `texto; tipo?: 'principal'\|'secundaria'\|'peligro'; icono?; pulsado?; ocupado?; resultado?; rolResultado?; ayuda?; onPulsar?` | botón de verbo exacto; resultado al lado |
| P0 | `BotonGrande` | (nuevo; idea de `CabeceraPantalla`) | `Item` / `Button asChild` | `titulo; descripcion; icono; estado?: {texto; rol}; ocupado?; onPulsar` | acciones de primer nivel, guía para no expertos |
| P0 | `BotonMarca` | `BotonMarca` | `Button variant=marca` | `texto; ocupado?; onPulsar` | el único sólido de la vista |
| P0 | `BotonIcono` | `BotonIcono` | `Button size=icon` + `Tooltip` | `icono; etiqueta; ayuda?; onPulsar` | cerrar, copiar, etc. |
| P0 | `BotonCopiar` | `BotonCopiar` | `Button` | `texto; valor; hecho?='Copiado'` | copiar prompt / comando / IP |
| P0 | `ConfirmarEnSitio` | `ConfirmarEnSitio` | — | `verbo; plazo?; ayuda?; onConfirmar` | confirmación sin modal |
| P1 | `ConfirmarConVista` | `ConfirmarConVista` | — | `verbo; simular(): Promise<RespuestaEscritura>; confirmar(motivo?): Promise<RespuestaEscritura>; pedirMotivo?; teclear?; onTerminar?` | acciones de escritura opcionales sobre el proveedor (p. ej. activar RLS) |
| P2 | `BarraCambios` + `useCambios` | `BarraCambios`, `ControladorCambios` | — | `verbo?='Aplicar'; maxFilas?` | lote de cambios con simulación |
| P0 | `SelectorRango` / `ChipsFiltro` | `Conmutador`, `SelectorRango`, `ChipsFiltro` | `ToggleGroup` | `opciones: {valor; texto; n?}[]; valor; onCambiar` | `1 h · 24 h · 7 d · 30 d`; filtros con cifra |
| P1 | `Buscador` | `Buscador` | `Input` + `Kbd` | `valor; onCambiar; placeholder?='Buscar'` | foco con `/` |
| P0 | `PanelDetalle` | `PanelDetalle` | `aside` ≥ 1100 / `Sheet side="right"` | `icono; titulo; mono?; chapas?; sub?; izquierda: ReactNode; derecha?: ReactNode; onCerrar` | detalle del hallazgo |
| P1 | `DetalleEnLinea` | `DetalleEnLinea` | `CollapsibleContent` | `children` | desplegado bajo una fila |
| P0 | `FichaFila` | `FichaFila` | — | `columnas: string[]; valores: unknown[]` | evidencia cruda: JSON con sangría, NULL vs `""`, copiar |
| P0 | `TablaFilas` | `TablaFilas`, `Columna` | `Table` | `columnas: {titulo; ancho?; numerica?; mono?; texto?(f); celda?(f)}[]; filas: T[]; alto?=48; onAbrir?; techo?; rolFila?` | tabla de alto fijo; «Ver las N» con techo |
| P0 | `RejillaEstado` | `RejillaEstado` | — | `casillas: {rotulo; valor: string\|null; ok?; mono?; rol?; sub?}[]; columnas?=3` | estado de una conexión / servidor |
| P0 | `ChecksEnCero` | `ChecksEnCero` | `Badge` | `checks: CheckDato[]` | lo que pasó limpio (verde solo comprobado) |
| P1 | `Historial` | `Historial` | `Table` | `entradas: {cuando; objeto; cambio; via; operador?; anomalia?; volverA?; vigente?}[]; cargado; onVolver?` | auditorías pasadas, alertas enviadas |
| P0 | `AuditoriaGlobal` | (nuevo: `RejillaEstado` + `Bandeja` + `ChecksEnCero`) | — | `estado: 'reposo'\|'corriendo'\|'hecha'; pasos: {id; nombre; modulo; rol?; n?; estado: 'pendiente'\|'corriendo'\|'hecho'\|'error'}[]; onAuditar` | el botón «Auditar todo» y su progreso |
| P0 | `PuntajeBlindaje` | (nuevo; idea de `AnilloPorcentaje` de `ui/piezas.dart`) | — | `puntaje: number\|null; delta?: number; tramos` | 0-100 con «+6 desde 08-10 22:35»; «—» sin auditoría |
| P1 | `VistaDiferencias` | `VistaDiferencias` | — | `lineas: {t; n; x}[]; plegarIguales?=3` | auditoría vs anterior, prompt vs anterior |
| P0 | `PromptCorreccion` | `EditorPrompt` (solo lectura) | `Textarea` | `nucleoAntes: string[]; editable: string; nucleoDespues: string[]; largoMax; errores?; soloLectura?=true; onCambiar?` | prompt listo para pegar en otra IA |
| P0 | `ExportarHallazgos` | `exportar.dart` | `Button` × 4 | `datos: EstadoModulo[]; onDescargar(formato: 'md'\|'json'\|'csv')` | «Copiar para mi IA» + descargas (CSV neutralizado) |
| P0 | `SerieViva` | `SerieViva` | `Chart` + `LineChart` | `valores: (number\|null)[]; etiqueta; valor?; maximo?; puntos?=60; alto?=48` | CPU/RAM/peticiones en vivo, sin ejes |
| P1 | `GraficaSerie` | `GraficaSerie` | `Chart` + `BarChart` | `valores: (number\|null)[]; etiquetas: string[]; alto?=64` | tráfico 7 d de Cloudflare |
| P0 | `GraficaComparativa` | (nuevo) | `Chart` + `BarChart` | `versiones: {version; fecha; valores: Record<string, number\|null>}[]; metrica; umbral?` | Lighthouse por despliegue |
| P0 | `ConectarClave` | (nuevo; equivale a `ajustes`) | `Field`, `Input type=password` | `proveedor: 'supabase'\|'cloudflare'\|'github'; campos: {id; etiqueta; ayuda; dondeObtenerla}[]; estado: 'vacia'\|'probando'\|'ok'\|'error'; huella?: string; onProbar; onGuardar; onBorrar` | carga de tokens; nunca muestra la clave guardada, solo su huella («…a3f9 · guardada 21:40») |
| P0 | `GuiaPasos` | (nuevo) | — | `pasos: {titulo; texto; hecho: boolean; accion?: ReactNode}[]` | «1 Conecta Supabase · 2 Conecta Cloudflare · 3 Conecta tu repo · 4 Audita» |
| P0 | `Vacio` | `VacioAmable` (viejo) | `Empty` | `icono; titulo; texto?; accion?` | solo onboarding |
| P1 | `ErrorBloque` | `MensajeError` (viejo) | `Alert` | `mensaje; onReintentar?` | página que no puede pintarse |
| P0 | `Ayuda` | `conAyuda`, `AyudaPerezosa` | `Tooltip` | `texto?: string; children` | el «antes → después» y el detalle al pasar el ratón |

Estructura sugerida: `lib/{formato,contraste,csv,contrato,modulos}.ts`, `hooks/useCicloDatos.ts`, `components/ui/*` (shadcn),
`components/blindaje/*` (lo de arriba), `app/(app)/[modulo]/page.tsx` (página genérica que pinta `EstadoModulo` + secciones propias
por vertical). Orden de construcción: tokens/tema → `formato.ts` → chapas y botones → `AppShell` → `PantallaModulo` + `BarraModulo` +
`Seccion` → `Cifra` → `Bandeja` → `PanelDetalle` → `ConectarClave` + `GuiaPasos` → `AuditoriaGlobal` → `PromptCorreccion` +
`ExportarHallazgos` → gráficas. Datos de prueba: un `EstadoModulo` falso por vertical en `lib/fixtures/` para que el FRONT avance sin
esperar al BACK.

---

## Implicaciones para el plan

**Adoptar**
- Las reglas R1-R16 como "ley" del FRONT, escritas en su prompt: 5 roles, rojo nunca sólido, rojo solo con acción, «—» ≠ «0 ✓» ≠
  verde comprobado, un solo botón de marca por vista, confirmación en el sitio, verbos exactos con cifra.
- El contrato `EstadoModulo` (sección 6) como interfaz FRONT ↔ BACK: una página genérica sirve a Supabase, Cloudflare y Codebase; el
  BACK decide filas, roles, verbos y efectos. Es lo que más tiempo ahorra y lo que más "ingeniería" muestra a los jueces.
- La portada de KUADRA (6 cifras de servidor + «Ahora» de todos los módulos con chapa + checks en cero) como «Resumen».
- Cifras de alto fijo y «—» en carga: la demo no salta al llegar los datos.
- shadcn `Sidebar` (ya trae Ctrl+B e iconos colapsados) y `Chart` (Recharts v3) en vez de hacer riel y gráficas a mano.

**Evitar**
- La densidad de KUADRA (controles de 28 px, texto 11-13 px, filetes de 0,5): choca con "botones grandes" y con el proyector.
- Atajos que el navegador ya usa (F5, Ctrl+F, Ctrl+1…9); los de la sección 11.1 los sustituyen.
- Portar la maquinaria de Flutter (`MemoriaFilas`, `_AvisaTamano`, `IndexedStack`, memoria de sectores por usuario de Windows,
  cabecera que mide su alto en cada frame): en React no hace falta y cuesta horas.
- `BarraCambios` (edición por lotes con simulación): Blindaje IA es de solo lectura por defecto; las escrituras son acciones sueltas
  con `ConfirmarEnSitio`/`ConfirmarConVista`.
- Modales de confirmación y toasts como único canal de resultado: el resultado va en el sitio del botón.
- El naranja de KUADRA y el amarillo del logo de PH26 como color de marca (chocan con `mal` y `aviso`).

**Riesgos**
- Contraste en tema claro: ámbar y verde base no llegan a 4,5:1; los hex de 2.2 están [no verificado] → test de `contraste.ts`.
- `color-mix()` y nombres exactos de shadcn: el listado de componentes muestra `Toast` y no `Sonner` [verificado:
  https://ui.shadcn.com/docs/components]; el FRONT debe instalar con `npx shadcn@latest add …` y usar lo que exista, no ejemplos viejos.
- Alcance: el catálogo tiene 55 piezas (40 P0, 14 P1, 1 P2); muchas P0 son de 20 líneas (`Etiqueta`, `PuntoEstado`,
  `BotonIcono`), pero sin la priorización un solo chat FRONT no llega. Si el sábado a mediodía va atrasado, bajar a P1
  `GraficaComparativa`, `FichaFila` y `PuntajeBlindaje` (sustituible por una `Cifra`).
- Los contratos de la sección 6 son de KUADRA adaptados; el BACK puede necesitar cambiarlos: congelarlos temprano (sábado mañana).
- Secretos en la UI: `FichaFila` y el exportador deben recibir valores ya redactados por el BACK; la UI no redacta.

**Esfuerzo**
| Bloque | Esfuerzo |
|---|---|
| Tokens, tema claro/oscuro, `formato.ts`, `contraste.ts`, `csv.ts` | S |
| Chapas, botones (`BotonAccion`, `BotonGrande`, `BotonMarca`, `BotonCopiar`, `ConfirmarEnSitio`) | S |
| `AppShell` + riel con contadores + estado global | M |
| `PantallaModulo` genérica + `BarraModulo` + `Seccion`/`SectorPlegable` + `Cifra`/`FilaCifras` | M |
| `Bandeja` + `FilaProblema` + `AccionFila` (6 clases) + `PanelDetalle` + `FichaFila` | M |
| `ConectarClave` + `GuiaPasos` + `Vacio` (onboarding) | S |
| `AuditoriaGlobal` + `PuntajeBlindaje` + `ChecksEnCero` + `RejillaEstado` | M |
| `PromptCorreccion` (solo lectura + copiar) + `ExportarHallazgos` (md/json/csv) | S |
| Gráficas (`SerieViva`, `GraficaComparativa`, `GraficaSerie`) | M |
| `Historial`, `VistaDiferencias`, `ConfirmarConVista` (P1) | M |
| `BarraCambios` con simulación por lotes (P2) | L |
