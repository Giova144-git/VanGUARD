// «Wiki del repo» (DeepWiki, E40–E44) sobre el repo víctima de la demo (S09 §09.13), en la historia de los fixtures:
// la auditoría termina a las 18:04 (T_SCAN_FIN), el admin estima y corre la wiki a las 18:20 y a las 18:31 la vuelve a
// pedir sobre el mismo commit, que sale de la caché sin costo. El commit es el mismo que escaneó la auditoría (sha corto
// 9f1c2ab de las evidencias de hallazgos.ts). Nada de aquí tiene forma de secreto: ni valores, ni marcadores, ni URLs.
//
// Decisiones que el FRONT y el pipeline deben respetar:
// - overview_md lleva un «# título» y las 5 secciones «##» de SECCIONES_OVERVIEW, en ese orden (prompt de síntesis del
//   CLI deepwiki). El bloque Mermaid NO va dentro de overview_md: viaja solo en `mermaid` (sin las vallas ```), y el FRONT
//   lo dibuja bajo «## Mapa visual»; si se descartó, `mermaid` es null y `mermaid_descartado` true.
// - El Mermaid pasa la lista blanca del CLI: «flowchart LR», nodos `Id[Etiqueta]` y flechas `-->` o `-->|texto|`, con
//   etiquetas de letras ASCII, dígitos y espacios (por eso «Tienda web» y no «Tienda en línea»).
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
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const usd = (modelo: string, entrada: number, salida: number) =>
  r6((entrada * PRECIO[modelo]!.entrada + salida * PRECIO[modelo]!.salida) / 1e6);
const sumar = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ── Árbol del repo: lo que ven los filtros locales ────────────────────────────
// 41 archivos; las reglas locales quitan 12 sin leerlos (imágenes, fuentes, lockfiles y .env); el triage elige 24 de
// los 29 candidatos (deja fuera la prueba, la semilla, el CSS, la vista Blade y la versión de rendimiento).
const FILES_TOTAL = 41;
const FILES_CANDIDATOS = 29;

// ── Estimación (E40): cota alta antes de correr, solo con el árbol ────────────
// triage: 1 llamada con las 29 rutas; area: 1 por área con el presupuesto entero (24.000 caracteres ≈ 6.000 tokens
// más el system); sintesis: 1 llamada con los resúmenes y los hallazgos, salida al tope de maxTokens.
const pasoEst = (paso: WikiPaso, modelo: string, llamadas: number, entrada: number, salida: number) =>
  ({ paso, modelo, llamadas, input_tokens: entrada, output_tokens: salida, usd: usd(modelo, entrada, salida) });
const desgloseEst = [
  pasoEst('triage', MODELOS.fast, 1, 1_300, 1_200),
  pasoEst('area', MODELOS.fast, 6, 39_600, 2_400),
  pasoEst('sintesis', MODELOS.smart, 1, 4_200, 3_000),
];
const EST_USD = r6(sumar(desgloseEst.map((p) => p.usd)));

export const wikiEstimate = {
  repo_full_name: REPO, branch: RAMA, commit_sha: SHA_WIKI,
  files_total: FILES_TOTAL, files_candidatos: FILES_CANDIDATOS, files_a_leer_max: FILES_CANDIDATOS, areas_max: 6,
  truncado: false,
  est: { input_tokens: sumar(desgloseEst.map((p) => p.input_tokens)),
    output_tokens: sumar(desgloseEst.map((p) => p.output_tokens)), usd: EST_USD, desglose: desgloseEst },
  models: MODELOS,
  cached_run_id: null,
  avisos: [
    'Se omitirán 12 de 41 archivos sin leerlos: imágenes, fuentes, lockfiles y .env (puede contener claves).',
    'Antes de enviar cualquier archivo al modelo se ocultan los valores con forma de clave.',
  ],
} satisfies WikiEstimate;

// ── Páginas: una por área, en el orden en que las resume el paso `area` ───────
// Tokens reales de cada llamada de área (Haiku); la suma va a stats y al costo de la corrida.
type PaginaFx = WikiPagina & { tokens: [entrada: number, salida: number] };
const paginasFx: PaginaFx[] = [
  {
    id: 'tienda-web', area: 'Tienda web', titulo: 'La tienda que ve el cliente', tokens: [6_420, 250],
    archivos: ['src/index.ts', 'src/rutas/catalogo.ts', 'src/rutas/carrito.ts', 'public/index.html', 'public/app.js'],
    resumen_md: 'Es la vitrina del negocio. Muestra el catálogo con fotos y precios, deja agregar productos al carrito y '
      + 'acompaña al cliente hasta confirmar la compra. Las páginas se arman en el navegador del cliente y piden los datos '
      + 'al servidor de la tienda, que corre en Cloudflare, cerca de cada visitante.\n\n'
      + '**Para el negocio:** de esta parte dependen las ventas; si se cae o va lenta, se pierden compras en el momento.',
  },
  {
    id: 'pedidos-y-cuentas', area: 'Pedidos y cuentas', titulo: 'Pedidos y cuentas de los clientes', tokens: [4_150, 220],
    archivos: ['src/rutas/pedidos.ts', 'src/rutas/cuenta.ts', 'src/lib/precios.ts'],
    resumen_md: 'Registra cada compra: calcula el total con descuentos y envío, guarda el pedido y le muestra al cliente '
      + 'su historial. Las cuentas no usan contraseña: el cliente recibe un código de un solo uso por correo o por '
      + 'teléfono y con él entra.\n\n'
      + '**Para el negocio:** aquí viven los datos personales de los clientes y el registro de ventas, lo más delicado '
      + 'de cuidar.',
  },
  {
    id: 'base-de-datos', area: 'Base de datos', titulo: 'La base de datos en Supabase', tokens: [5_980, 240],
    archivos: ['supabase/config.toml', 'supabase/migrations/0001_pedidos.sql', 'supabase/migrations/0002_perfiles.sql',
      'supabase/migrations/0003_enviar_otp.sql', 'src/lib/supabase.ts'],
    resumen_md: 'Es el cuaderno donde se anota todo: pedidos, perfiles de clientes y los códigos de acceso que se piden. '
      + 'Supabase la guarda y además da el inicio de sesión. Cada cambio en su estructura queda escrito como un paso '
      + 'numerado, así se puede rehacer igual en otro entorno. Las reglas de quién puede leer qué también viven aquí.\n\n'
      + '**Para el negocio:** si estos datos se pierden o se filtran, el daño es directo; por eso importa qué puede ver '
      + 'cada visitante.',
  },
  {
    id: 'administracion', area: 'Zona de administración', titulo: 'La zona de administración y la llave maestra',
    tokens: [2_310, 210],
    archivos: ['src/rutas/admin.ts', 'src/lib/supabaseAdmin.ts'],
    resumen_md: 'Son las pantallas internas para ver y corregir pedidos y clientes. Para hacerlo usan la llave maestra de '
      + 'la base de datos, que se salta los permisos normales. Uno de estos archivos traía una clave escrita: VanGUARD la '
      + 'ocultó antes de enviar el código al modelo.\n\n'
      + '**Para el negocio:** es la puerta con más poder del sistema; debería pedir inicio de sesión y guardar la llave '
      + 'solo en el servidor.',
  },
  {
    id: 'panel-interno', area: 'Panel interno', titulo: 'El panel interno antiguo', tokens: [5_240, 230],
    archivos: ['panel-legacy/composer.json', 'panel-legacy/routes/web.php',
      'panel-legacy/app/Http/Controllers/PedidosController.php',
      'panel-legacy/app/Http/Controllers/InventarioController.php'],
    resumen_md: 'Es una aplicación aparte y más antigua, hecha en PHP con el marco Laravel. El equipo la usa para revisar '
      + 'pedidos pendientes, marcar despachos y ajustar el inventario. No comparte código con la tienda: se conecta '
      + 'directo a la misma base de datos.\n\n'
      + '**Para el negocio:** mantener dos sistemas cuesta el doble; conviene decidir si se moderniza o se retira.',
  },
  {
    id: 'publicacion', area: 'Publicación y configuración', titulo: 'Cómo se publica la tienda', tokens: [7_360, 230],
    archivos: ['wrangler.jsonc', 'package.json', 'tsconfig.json', 'README.md', '.gitignore'],
    resumen_md: 'Reúne las instrucciones para publicar la tienda en Cloudflare y la lista de piezas de terceros que usa: '
      + 'el sistema de rutas, el conector de Supabase y dos librerías clásicas del navegador, jquery y lodash. También '
      + 'dice qué archivos no se suben al repositorio.\n\n'
      + '**Para el negocio:** de aquí depende que publicar una versión nueva sea rápido y repetible, y que no se cuelen '
      + 'archivos privados.',
  },
];
const paginas: WikiPagina[] = paginasFx.map(({ tokens: _tokens, ...p }) => p);

// ── Consumo real de la corrida ────────────────────────────────────────────────
const TRIAGE: [number, number] = [1_140, 520];
const SINTESIS: [number, number] = [3_240, 1_950];
const AREAS_IN = sumar(paginasFx.map((p) => p.tokens[0]));
const AREAS_OUT = sumar(paginasFx.map((p) => p.tokens[1]));
const COSTO_USD = r6(usd(MODELOS.fast, ...TRIAGE) + usd(MODELOS.fast, AREAS_IN, AREAS_OUT) + usd(MODELOS.smart, ...SINTESIS));
// Lo gastado cuando va por el área 3 de 6: triage y las dos primeras áreas.
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

// progress sugerido: 10 árbol + 20 triage + 60 repartido entre áreas (la que está en curso cuenta media) + 10 síntesis;
// en el área 3 de 6 da 10 + 20 + 60 × 2,5 / 6 = 55.
export const wikiRunRunning = {
  ...base, status: 'running', progress: 55, cost_usd: COSTO_PARCIAL_USD, finished_at: null,
  steps: [
    paso('arbol', 'done', DET_ARBOL),
    paso('triage', 'done', DET_TRIAGE),
    paso('area', 'running', `Área 3 de ${paginas.length}: ${paginas[2]!.area}`),
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

// Mismo commit: E41 no vuelve a llamar a Claude; la corrida nace terminada, con costo 0 y los pasos saltados.
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
// Títulos exactos de las 5 secciones (prompt de síntesis del CLI deepwiki, con tildes).
export const SECCIONES_OVERVIEW = [
  'Qué es y para qué sirve', 'Cómo funciona, en simple', 'Las piezas principales', 'Mapa visual',
  'Riesgos y puntos de atención',
] as const;
const [S_QUE, S_COMO, S_PIEZAS, S_MAPA, S_RIESGOS] = SECCIONES_OVERVIEW;

const overview_md = `# ${NOMBRE_REPO} · la tienda en línea de ${ORG_NOMBRE}

## ${S_QUE}
Es la tienda en línea de ${ORG_NOMBRE}: el sitio donde los clientes ven el catálogo, arman su carrito, entran a su cuenta y hacen pedidos. Junto a la tienda vive un panel interno más antiguo que el equipo usa para despachar pedidos y mover el inventario. Todos los datos (productos, clientes y pedidos) se guardan en Supabase, un servicio que le da al proyecto su base de datos y el inicio de sesión. La tienda se publica en Cloudflare, que la sirve rápido desde muchos países.

## ${S_COMO}
Piensa en una tienda de barrio. La vitrina es la tienda web: muestra los productos y toma los pedidos. La trastienda es la base de datos: un cuaderno donde se anota cada pedido y cada cliente, y donde una regla dice quién puede leer cada página. El panel interno es la oficina del encargado, que consulta ese mismo cuaderno para despachar. Y existe una llave maestra que abre todos los cajones sin preguntar quién es: la usa la zona de administración y solo debería guardarse en el servidor, nunca a la vista.

## ${S_PIEZAS}
- **Tienda web:** las páginas que ve el cliente y el servidor que responde a sus clics: catálogo, carrito y compra.
- **Pedidos y cuentas:** calcula el total, registra el pedido y deja entrar al cliente con un código de un solo uso.
- **Base de datos en Supabase:** las tablas de pedidos, perfiles y códigos de acceso, con la función que envía esos códigos.
- **Zona de administración:** pantallas para el personal que trabajan con la llave maestra de la base de datos.
- **Panel interno antiguo:** una aplicación aparte, hecha en PHP con Laravel, para inventario y despachos.
- **Publicación y configuración:** cómo se publica la tienda en Cloudflare y qué piezas de terceros usa.

## ${S_MAPA}
El diagrama sigue el camino de un pedido: el cliente compra en la tienda web, la tienda lo guarda en la base de datos y el equipo lo atiende desde el panel interno. La zona de administración entra a la misma base con la llave maestra.

## ${S_RIESGOS}
VanGUARD cruzó este mapa con los hallazgos de su última auditoría. Lo que un directivo debe saber, de lo más urgente a lo menos:

1. **La llave maestra de la base de datos está escrita en el código.** Es la clave service_role de Supabase: quien la tenga puede leer, cambiar o borrar cualquier dato saltándose todos los permisos. Aparece en la zona de administración y en un archivo de configuración. Hay que cambiarla hoy en Supabase; borrarla del código no basta, porque ya quedó expuesta.
2. **Se subió al repositorio un archivo con contraseñas.** El archivo .env, que debería quedarse en la computadora de cada programador, está guardado junto al código con la llave maestra y la contraseña de la base de datos: cualquiera con acceso al repositorio puede verlas. Además, la lista de archivos que el repositorio ignora no lo incluye, así que puede volver a pasar.
3. **La tabla de pedidos no tiene candado.** En public.pedidos está desactivada la seguridad por filas (RLS), la regla de Supabase que decide qué filas ve cada usuario. Hoy cualquiera que visite la tienda puede descargar cerca de 500 pedidos sin iniciar sesión.
4. **Piezas de terceros con fallas conocidas.** El panel interno usa una versión de facade/ignition con una falla crítica (CVE-2021-3129) que permite tomar el control del servidor, y la tienda usa versiones de lodash y jquery con fallas publicadas. Actualizarlas es un cambio pequeño y de bajo riesgo.
5. **Para planificar.** El panel interno es tecnología antigua y separada del resto: decidir si se moderniza o se retira reduce costos y puntos débiles. Según el código, la zona de administración no pide iniciar sesión; conviene confirmarlo con el equipo.
`;

// 6 nodos: Cliente, Tienda, Datos, Admin, Equipo y Panel.
const mermaid = [
  'flowchart LR',
  '  Cliente[Cliente] -->|compra| Tienda[Tienda web]',
  '  Tienda -->|pedidos y cuentas| Datos[Base de datos Supabase]',
  '  Tienda --> Admin[Zona admin]',
  '  Admin -->|llave maestra| Datos',
  '  Equipo[Equipo de la tienda] --> Panel[Panel interno antiguo]',
  '  Panel -->|inventario y despachos| Datos',
].join('\n');

export const wikiDoc = {
  run_id: WIKI_RUN, repo_full_name: REPO, branch: RAMA, commit_sha: SHA_WIKI, generated_at: T_WIKI_FIN, models: MODELOS,
  overview_md, mermaid, mermaid_descartado: false, paginas,
  stats: { files_total: FILES_TOTAL, files_leidos: FILES_LEIDOS, areas: paginas.length,
    input_tokens: TRIAGE[0] + AREAS_IN + SINTESIS[0], output_tokens: TRIAGE[1] + AREAS_OUT + SINTESIS[1],
    cost_usd: COSTO_USD },
  avisos: [
    `Se omitieron 12 de ${FILES_TOTAL} archivos sin leerlos: imágenes, fuentes, lockfiles y .env (puede contener claves).`,
    `Se leyeron ${FILES_LEIDOS} de ${FILES_CANDIDATOS} archivos candidatos; las pruebas y los datos de ejemplo quedaron fuera.`,
    'Antes de enviar el código al modelo se ocultó 1 valor con forma de clave en src/lib/supabaseAdmin.ts.',
  ],
} satisfies WikiDoc;
