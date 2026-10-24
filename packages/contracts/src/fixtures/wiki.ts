// «Wiki del repo» (DeepWiki, E40–E44) sobre el repo víctima de la demo (S09 §09.13), en la historia de los fixtures:
// la auditoría termina a las 18:04 (T_SCAN_FIN), el admin estima y corre la wiki a las 18:20 y a las 18:31 la vuelve a
// pedir sobre el mismo commit, que sale de la caché sin costo. El commit es el mismo que escaneó la auditoría (sha corto
// 9f1c2ab de las evidencias de hallazgos.ts). Nada de aquí tiene forma de secreto: ni valores, ni marcadores, ni URLs.
//
// Es lo que el motor de packages/deepwiki produce de verdad para este repo (lo comprueba
// packages/deepwiki/src/fixtures-contrato.test.ts): áreas por carpeta como agruparEnAreas, ids de slugDeArea, títulos
// legibles como los propone el modelo (2 a 6 palabras, solo letras, números y espacios), resúmenes de un párrafo como
// pide SYS_AREA y avisos con los textos exactos de AVISOS. Decisiones que el FRONT y el pipeline deben respetar:
// - overview_md lleva un «# título» y las 5 secciones «##» de SECCIONES_OVERVIEW (= SECCIONES de prompts.ts), en ese
//   orden. El bloque Mermaid NO va dentro de overview_md: viaja solo en `mermaid` (sin las vallas ```), y el FRONT lo
//   dibuja bajo «## Mapa visual»; si se descartó, `mermaid` es null y `mermaid_descartado` true.
// - El Mermaid pasa la lista blanca de validarMermaid (packages/deepwiki/src/sanitizar.ts): «flowchart LR|TD», nodos
//   `Id[Etiqueta]` y flechas `-->` o `-->|texto|`; etiquetas de letras (tildes y eñe valen), dígitos y espacios, de
//   hasta 40 caracteres en nodos y 30 en flechas.
// - area, titulo, archivos, avisos y los detalles de los pasos son TEXTO PLANO: el nombre de una carpeta lo controla el
//   dueño del repo, así que el FRONT nunca los pinta como Markdown ni HTML.
// - «Riesgos y puntos de atención» solo usa lo que el motor le pasa al modelo de cada hallazgo (gravedad, título y
//   ruta, nunca la evidencia) y cubre todos los críticos y altos; lo que no sale de un hallazgo va en la línea
//   «Observación (no es un hallazgo de la auditoría): …».
// - Los costos salen de precio × tokens (USD por millón, sin caché), redondeados a 6 decimales.
// - wikiRunRunning y wikiRunDone son la misma corrida vista en dos momentos (mismo id): así el FRONT ve la transición.
import type { WikiDoc, WikiEstimate, WikiModelos, WikiPagina, WikiPaso, WikiRun, WikiRunStep } from '../wiki.ts';
import { ORG_NOMBRE, REPO } from './ids.ts';

// ── Ids, commit y horas (sábado 2026-10-24, UTC) ──────────────────────────────
export const WIKI_RUN = 'de3e0000-0000-4000-8000-000000000001';        // corrida real (la que generó wikiDoc)
export const WIKI_RUN_CACHE = 'de3e0000-0000-4000-8000-000000000002';  // segunda corrida, servida desde la caché
export const SHA_WIKI = '9f1c2ab4e07d3b58c6a1f29e8d40b7c35e1a6d92';    // 40 hex inventados; empieza como el sha de la auditoría
export const T_WIKI_ESTIMADA = '2026-10-24T18:19:40.000Z';
export const T_WIKI_CREADA = '2026-10-24T18:20:05.000Z';
export const T_WIKI_INICIO = '2026-10-24T18:20:07.000Z';
export const T_WIKI_FIN = '2026-10-24T18:21:52.000Z';
export const T_WIKI_CACHE = '2026-10-24T18:31:20.000Z';

const RAMA = 'main';
const NOMBRE_REPO = REPO.slice(REPO.indexOf('/') + 1);
const MODELOS: WikiModelos = { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' };

// ── Costos: USD por millón de tokens (precios de la spec del 24-oct) ──────────
const PRECIO: Record<string, { entrada: number; salida: number }> = {
  'claude-haiku-5-5': { entrada: 0.1, salida: 0.5 },
  'claude-sonnet-5-5': { entrada: 2, salida: 10 },
};
// Topes de salida por llamada (MAX_TOKENS_SALIDA de prompts.ts): con ellos sale el techo de la estimación.
const MAX_SALIDA = { triage: 4000, area: 1500, sintesis: 6000 } as const;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const usd = (modelo: string, entrada: number, salida: number) =>
  r6((entrada * PRECIO[modelo]!.entrada + salida * PRECIO[modelo]!.salida) / 1e6);
const sumar = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ── Árbol del repo: lo que ven los filtros locales ────────────────────────────
// 41 archivos. Los filtros locales quitan 14 sin leerlos: el .env, 2 lockfiles, 9 imágenes e íconos, 1 fuente y 2 de
// configuración (tsconfig.json y .gitignore). Quedan 27 candidatos y el triage elige 22: deja fuera la prueba
// (src/rutas/pedidos.test.ts), la semilla (supabase/seed.sql), el CSS, la vista Blade del panel y la copia optimizada
// de app.js (public/app-rapida.js).
const FILES_TOTAL = 41;
const FILES_OMITIDOS = 14;
const FILES_CANDIDATOS = FILES_TOTAL - FILES_OMITIDOS;

// ── Estimación (E40): valor típico antes de correr, solo con el árbol ─────────
// Cifras de estimarCorrida sobre este árbol: triage con las 27 rutas; área: 1 llamada por cada una de las 7 áreas de
// los 27 candidatos, con sus tamaños recortados a 3.000 caracteres por archivo (≈ 3,5 caracteres por token) más el
// system; síntesis: el prompt con resúmenes del largo esperado y la reserva de hallazgos. Las salidas son las ESPERADAS
// (1.200, 450 por área y 2.800), no los topes: el techo con las salidas al tope de max_tokens va en el último aviso.
const pasoEst = (paso: 'triage' | 'area' | 'sintesis', modelo: string, llamadas: number, entrada: number, salida: number) =>
  ({ paso, modelo, llamadas, input_tokens: entrada, output_tokens: salida, usd: usd(modelo, entrada, salida) });
const desgloseEst = [
  pasoEst('triage', MODELOS.fast, 1, 616, 1_200),
  pasoEst('area', MODELOS.fast, 7, 19_879, 7 * 450),
  pasoEst('sintesis', MODELOS.smart, 1, 5_295, 2_800),
];
const EST_USD = r6(sumar(desgloseEst.map((p) => p.usd)));
const TECHO_USD = r6(sumar(desgloseEst.map((p) => usd(p.modelo, p.input_tokens, MAX_SALIDA[p.paso] * p.llamadas))));

// Avisos con los textos exactos de AVISOS (pipeline.ts) y avisoTecho (estimar.ts).
const AVISO_OMITIDOS = `Se omitieron ${FILES_OMITIDOS} de ${FILES_TOTAL} archivos sin leerlos: binarios, imágenes, lockfiles, generados o de configuración.`;
const AVISO_CLAVES = 'Hay 1 archivo con posibles claves (como .env): nunca se leen ni se envían al modelo.';

export const wikiEstimate = {
  repo_full_name: REPO, branch: RAMA, commit_sha: SHA_WIKI,
  files_total: FILES_TOTAL, files_candidatos: FILES_CANDIDATOS, files_a_leer_max: FILES_CANDIDATOS, areas_max: 7,
  truncado: false,
  est: { input_tokens: sumar(desgloseEst.map((p) => p.input_tokens)),
    output_tokens: sumar(desgloseEst.map((p) => p.output_tokens)), usd: EST_USD, desglose: desgloseEst },
  models: MODELOS,
  cached_run_id: null,
  avisos: [
    AVISO_OMITIDOS,
    AVISO_CLAVES,
    `Si el modelo razona más de lo previsto, el costo puede llegar a US$ ${TECHO_USD.toFixed(4)}.`,
  ],
} satisfies WikiEstimate;

// ── Páginas: una por área, en el orden de agruparEnAreas («(raiz)», luego por tamaño y nombre) ─
// Tokens reales de cada llamada de área (Haiku); la suma va a stats y al costo de la corrida. `archivos` empieza por los
// «Archivos clave» que citó el modelo y sigue con el resto de lo leído.
type PaginaFx = WikiPagina & { tokens: [entrada: number, salida: number] };
const paginasFx: PaginaFx[] = [
  {
    id: 'raiz', area: '(raiz)', titulo: 'Cómo se publica la tienda', tokens: [1_520, 260],
    archivos: ['README.md', 'wrangler.jsonc', 'package.json'],
    resumen_md: 'Reúne la presentación del proyecto y las instrucciones para publicar la tienda en Cloudflare, el servicio '
      + 'que la sirve rápido desde muchos países. También lista las piezas de terceros que usa: el sistema de rutas del '
      + 'servidor, el conector de Supabase y dos librerías clásicas del navegador, jquery y lodash. De aquí depende que '
      + 'publicar una versión nueva sea rápido y repetible.',
  },
  {
    id: 'src-rutas', area: 'src/rutas', titulo: 'Lo que el cliente puede hacer', tokens: [3_900, 290],
    archivos: ['src/rutas/catalogo.ts', 'src/rutas/pedidos.ts', 'src/rutas/carrito.ts', 'src/rutas/cuenta.ts',
      'src/rutas/admin.ts'],
    resumen_md: 'Atiende cada acción de la tienda: mostrar el catálogo con precios, armar el carrito, confirmar el pedido '
      + 'y entrar a la cuenta. Las cuentas no usan contraseña: el cliente recibe un código de un solo uso por correo o '
      + 'por teléfono. Incluye también las pantallas internas para corregir pedidos y clientes, que parecen no pedir '
      + 'inicio de sesión. De esta parte dependen las ventas.',
  },
  {
    id: 'panel-legacy', area: 'panel-legacy', titulo: 'Panel interno antiguo', tokens: [3_960, 280],
    archivos: ['panel-legacy/app/Http/Controllers/PedidosController.php',
      'panel-legacy/app/Http/Controllers/InventarioController.php', 'panel-legacy/routes/web.php',
      'panel-legacy/composer.json'],
    resumen_md: 'Es una aplicación aparte y más antigua, hecha en PHP con Laravel, un marco de trabajo para sitios web. El '
      + 'equipo la usa para revisar pedidos pendientes, marcar despachos y ajustar el inventario. No comparte código con '
      + 'la tienda: se conecta directo a la misma base de datos. Mantener dos sistemas cuesta el doble, así que conviene '
      + 'decidir si se moderniza o se retira.',
  },
  {
    id: 'supabase', area: 'supabase', titulo: 'Base de datos en Supabase', tokens: [1_850, 270],
    archivos: ['supabase/migrations/0001_pedidos.sql', 'supabase/migrations/0003_enviar_otp.sql',
      'supabase/migrations/0002_perfiles.sql', 'supabase/config.toml'],
    resumen_md: 'Es el cuaderno donde se anota todo: pedidos, perfiles de clientes y los códigos de acceso que se piden. '
      + 'Supabase la guarda y además da el inicio de sesión. Cada cambio en su estructura queda escrito como un paso '
      + 'numerado, así se puede rehacer igual en otro entorno. Aquí viven también las reglas de quién puede leer qué y '
      + 'la función que envía los códigos de acceso.',
  },
  {
    id: 'src-lib', area: 'src/lib', titulo: 'Llave maestra y cálculo de precios', tokens: [1_190, 300],
    archivos: ['src/lib/supabaseAdmin.ts', 'src/lib/precios.ts', 'src/lib/supabase.ts'],
    resumen_md: 'Son piezas que comparte el resto de la tienda: el cálculo del total con descuentos y envío, y la conexión '
      + 'con la base de datos. Una de ellas usa la llave maestra de la base, que se salta todos los permisos; en el '
      + 'código aparece una clave escrita que llegó oculta. Esa llave debería vivir solo en el servidor.',
  },
  {
    id: 'public', area: 'public', titulo: 'Páginas que ve el cliente', tokens: [2_480, 240],
    archivos: ['public/index.html', 'public/app.js'],
    resumen_md: 'Son las páginas que se cargan en el navegador del cliente: la vitrina con fotos y precios, el carrito y el '
      + 'formulario de compra. Piden los datos al servidor de la tienda a medida que el cliente navega y usan dos '
      + 'librerías clásicas del navegador para animar la página y ordenar datos.',
  },
  {
    id: 'src', area: 'src', titulo: 'Arranque del servidor de la tienda', tokens: [1_020, 210],
    archivos: ['src/index.ts'],
    resumen_md: 'Es el punto de partida del servidor de la tienda: recibe cada visita y la reparte a la parte que '
      + 'corresponde, como el catálogo, el carrito o la cuenta. Corre en Cloudflare, cerca de cada visitante, para que '
      + 'la tienda responda rápido.',
  },
];
const paginas: WikiPagina[] = paginasFx.map(({ tokens: _tokens, ...p }) => p);
const titulo = (id: string) => paginas.find((p) => p.id === id)!.titulo;

// ── Consumo real de la corrida ────────────────────────────────────────────────
const TRIAGE: [number, number] = [588, 640];
const SINTESIS: [number, number] = [5_020, 2_150];
const AREAS_IN = sumar(paginasFx.map((p) => p.tokens[0]));
const AREAS_OUT = sumar(paginasFx.map((p) => p.tokens[1]));
const COSTO_USD = r6(usd(MODELOS.fast, ...TRIAGE) + usd(MODELOS.fast, AREAS_IN, AREAS_OUT) + usd(MODELOS.smart, ...SINTESIS));
// Lo gastado cuando va por el área 3 de 7: triage y las dos primeras áreas.
const COSTO_PARCIAL_USD = r6(usd(MODELOS.fast, ...TRIAGE)
  + sumar(paginasFx.slice(0, 2).map((p) => usd(MODELOS.fast, ...p.tokens))));
const FILES_LEIDOS = sumar(paginas.map((p) => p.archivos.length));

// ── Corridas (E42/E43) ────────────────────────────────────────────────────────
const paso = (name: WikiPaso, status: WikiRunStep['status'], detalle?: string): WikiRunStep =>
  detalle === undefined ? { name, status } : { name, status, detalle };
const DET_ARBOL = `${FILES_TOTAL} archivos; ${FILES_CANDIDATOS} candidatos tras los filtros`;
const DET_TRIAGE = `${FILES_LEIDOS} archivos en ${paginas.length} áreas`;
const base = { id: WIKI_RUN, repo_full_name: REPO, branch: RAMA, commit_sha: SHA_WIKI, est_usd: EST_USD, models: MODELOS,
  cached: false, error: null, created_at: T_WIKI_CREADA, started_at: T_WIKI_INICIO } as const;

// progress = progreso(estado, true): 10 árbol + 20 triage + 60 repartido entre áreas (la que está en curso cuenta
// media) + 10 síntesis; en el área 3 de 7 da round(30 + 60 × 2,5 / 7) = 51. El detalle es detalleInicio: el área se
// nombra con su título de respaldo (tituloDeArea), porque el del modelo aún no existe cuando el paso empieza.
export const wikiRunRunning = {
  ...base, status: 'running', progress: 51, cost_usd: COSTO_PARCIAL_USD, finished_at: null,
  steps: [
    paso('arbol', 'done', DET_ARBOL),
    paso('triage', 'done', DET_TRIAGE),
    paso('area', 'running', `Área 3 de ${paginas.length}: Panel legacy`),
    paso('sintesis', 'pending'),
    paso('fin', 'pending'),
  ],
} satisfies WikiRun;

export const wikiRunDone = {
  ...base, status: 'succeeded', progress: 100, cost_usd: COSTO_USD, finished_at: T_WIKI_FIN,
  steps: [
    paso('arbol', 'done', DET_ARBOL),
    paso('triage', 'done', DET_TRIAGE),
    paso('area', 'done', `${paginas.length} de ${paginas.length} áreas resumidas`),
    paso('sintesis', 'done', 'Documento y diagrama listos'),
    paso('fin', 'done'),
  ],
} satisfies WikiRun;

// Mismo commit y mismos hallazgos: E41 no vuelve a llamar a Claude; la corrida nace terminada, con costo 0 y los pasos
// saltados.
const wikiRunCache = {
  id: WIKI_RUN_CACHE, repo_full_name: REPO, branch: RAMA, commit_sha: SHA_WIKI, status: 'succeeded', progress: 100,
  steps: [
    paso('arbol', 'skipped'), paso('triage', 'skipped'), paso('area', 'skipped'), paso('sintesis', 'skipped'),
    paso('fin', 'done', `Reutiliza la wiki del commit ${SHA_WIKI.slice(0, 7)}`),
  ],
  est_usd: 0, cost_usd: 0, models: MODELOS, cached: true, error: null,
  created_at: T_WIKI_CACHE, started_at: T_WIKI_CACHE, finished_at: T_WIKI_CACHE,
} satisfies WikiRun;

// Historial del repo (E43): más recientes primero.
export const wikiRuns = [wikiRunCache, wikiRunDone] satisfies WikiRun[];

// ── Documento (E44) ───────────────────────────────────────────────────────────
// Títulos exactos de las 5 secciones (SECCIONES de packages/deepwiki/src/prompts.ts).
export const SECCIONES_OVERVIEW = [
  'Qué es y para qué sirve', 'Cómo funciona, en simple', 'Las piezas principales', 'Mapa visual',
  'Riesgos y puntos de atención',
] as const;
const [S_QUE, S_COMO, S_PIEZAS, S_MAPA, S_RIESGOS] = SECCIONES_OVERVIEW;

// «Las piezas principales» nombra cada parte con el mismo título que su página. «Riesgos» junta hallazgos de la misma
// causa, de más grave a menos grave, con qué conviene hacer; cubre los 8 críticos y altos de hallazgos.ts sin usar la
// evidencia (ni filas, ni ubicaciones), y las marcas [Hn] con que el modelo los cita ya vienen quitadas.
const overview_md = `# ${NOMBRE_REPO} · la tienda en línea de ${ORG_NOMBRE}

## ${S_QUE}
Es la tienda en línea de ${ORG_NOMBRE}: el sitio donde los clientes ven el catálogo, arman su carrito, entran a su cuenta y hacen pedidos. Junto a la tienda vive un panel interno más antiguo que el equipo usa para despachar pedidos y mover el inventario. Todos los datos (productos, clientes y pedidos) se guardan en Supabase, un servicio que le da al proyecto su base de datos y el inicio de sesión. La tienda se publica en Cloudflare, que la sirve rápido desde muchos países.

## ${S_COMO}
Piensa en una tienda de barrio. La vitrina es la tienda web: muestra los productos y toma los pedidos. La trastienda es la base de datos: un cuaderno donde se anota cada pedido y cada cliente, y donde una regla dice quién puede leer cada página. El panel interno es la oficina del encargado, que consulta ese mismo cuaderno para despachar. Y existe una llave maestra que abre todos los cajones sin preguntar quién es: solo debería guardarse en el servidor, nunca a la vista.

## ${S_PIEZAS}
- **${titulo('raiz')}:** las instrucciones para ponerla en línea en Cloudflare y la lista de piezas de terceros que usa.
- **${titulo('src-rutas')}:** catálogo, carrito, pedidos y cuentas que entran con un código de un solo uso.
- **${titulo('public')}:** la vitrina que se carga en el navegador de cada cliente.
- **${titulo('src')}:** recibe cada visita y la reparte a la parte que corresponde.
- **${titulo('src-lib')}:** piezas compartidas, entre ellas la conexión con la llave maestra de la base de datos.
- **${titulo('supabase')}:** pedidos, perfiles y códigos de acceso, con las reglas de quién lee qué.
- **${titulo('panel-legacy')}:** una aplicación aparte, hecha en PHP con Laravel, para inventario y despachos.

## ${S_MAPA}
El diagrama sigue el camino de un pedido: el cliente compra en la tienda, la tienda lo guarda en la base de datos y el equipo lo atiende desde el panel interno. Las pantallas internas entran a la misma base con la llave maestra.

## ${S_RIESGOS}
VanGUARD cruzó este mapa con los hallazgos de su última auditoría. De lo más urgente a lo menos:

1. **La llave maestra de la base de datos está escrita en el código.** Es la clave de Supabase que se salta todos los permisos: quien la tenga puede leer, cambiar o borrar cualquier dato. Conviene cambiarla hoy en Supabase, porque borrarla del código no basta (${titulo('src-lib')}).
2. **Se subió al repositorio un archivo con contraseñas.** El archivo .env, que debería quedarse en la computadora de cada programador, está junto al código con una contraseña de la base de datos, y la lista de archivos que el repositorio ignora no lo incluye, así que puede volver a pasar. Conviene sacarlo, cambiar esas claves y agregarlo a esa lista (${titulo('raiz')}).
3. **Datos de clientes legibles sin iniciar sesión.** La tabla de pedidos no tiene activada la seguridad por filas, la regla de Supabase que decide qué filas ve cada usuario, y una regla demasiado amplia deja leer los perfiles de clientes. Conviene activar esa seguridad y cerrar esa regla hoy (${titulo('supabase')}).
4. **El envío de códigos de acceso no tiene freno.** La función que manda los códigos de un solo uso se puede llamar sin sesión y sin límite: alguien podría disparar miles de envíos y generar un costo por cada correo o mensaje. Conviene exigir sesión o poner un límite de envíos (${titulo('supabase')}).
5. **Piezas de terceros con fallas conocidas.** El panel interno usa una versión de un componente con una falla crítica que permite tomar el control del servidor, y la tienda usa versiones de lodash y jquery con fallas publicadas. Actualizarlas es un cambio pequeño y de bajo riesgo (${titulo('panel-legacy')}; ${titulo('raiz')}).

Observación (no es un hallazgo de la auditoría): según el código, las pantallas internas de administración no piden iniciar sesión; conviene confirmarlo con el equipo.`;

// 6 nodos: Cliente, Tienda, Datos, Admin, Equipo y Panel.
const mermaid = [
  'flowchart LR',
  '  Cliente[Cliente] -->|compra| Tienda[Tienda en línea]',
  '  Tienda -->|pedidos y cuentas| Datos[Base de datos Supabase]',
  '  Tienda --> Admin[Pantallas internas]',
  '  Admin -->|llave maestra| Datos',
  '  Equipo[Equipo de la tienda] --> Panel[Panel interno antiguo]',
  '  Panel -->|inventario y despachos| Datos',
].join('\n');

// Avisos en el orden del motor: primero los de la síntesis (leídos y fecha de la auditoría), luego los del estado
// (árbol y redacción). La redacción nunca nombra el archivo.
export const wikiDoc = {
  run_id: WIKI_RUN, repo_full_name: REPO, branch: RAMA, commit_sha: SHA_WIKI, generated_at: T_WIKI_FIN, models: MODELOS,
  overview_md, mermaid, mermaid_descartado: false, paginas,
  stats: { files_total: FILES_TOTAL, files_leidos: FILES_LEIDOS, areas: paginas.length,
    input_tokens: TRIAGE[0] + AREAS_IN + SINTESIS[0], output_tokens: TRIAGE[1] + AREAS_OUT + SINTESIS[1],
    cost_usd: COSTO_USD },
  avisos: [
    `Se leyeron ${FILES_LEIDOS} de ${FILES_CANDIDATOS} archivos candidatos; el resto se juzgó menos útil para explicar el proyecto.`,
    'Los riesgos salen de la auditoría de VanGUARD del 24/10/2026.',
    AVISO_OMITIDOS,
    AVISO_CLAVES,
    'Antes de enviar el código al modelo se ocultó 1 valor con forma de clave.',
  ],
} satisfies WikiDoc;
