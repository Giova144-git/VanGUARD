// CLI de desarrollo (solo Node 24, sin compilar): genera la wiki de un repo con la API real y la guarda por commit.
//   node --env-file-if-exists=../../.env src/cli.ts <dueño/repo|url> [--ref=rama] [--estimar] [--forzar]
//     [--max-usd=N] [--hallazgos=ruta.json]
// Lee ANTHROPIC_API_KEY y GITHUB_TOKEN del entorno y JAMÁS los imprime: toda salida pasa por `limpiar`.
// Es el único archivo del paquete que toca node:fs; el motor (pipeline.ts) corre igual en el Worker.
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WikiModelos } from '@vanguard/contracts';
import { techoDesglose } from './estimar.ts';
import { ErrorGithub, normalizarRepo } from './github.ts';
import { crearLlmFetch } from './llm-fetch.ts';
import { completarWiki, documentoMarkdown, ErrorWiki, estimar, huellaHallazgos, modelosDe, pasoArbol } from './pipeline.ts';
import { redactar } from './redactar.ts';
import type { Deps, Estimacion, EstadoWiki, HallazgoBreve } from './tipos.ts';

const USO = `Uso: node --env-file-if-exists=../../.env src/cli.ts <dueño/repo|url> [opciones]
  --ref=rama           rama o tag (por defecto, la principal)
  --estimar            solo lee GitHub e imprime el costo estimado y su techo (no necesita ANTHROPIC_API_KEY)
  --forzar             regenera aunque ya exista la wiki de ese commit en out/ (y no reanuda un estado guardado)
  --max-usd=N          corta ANTES de un paso si lo gastado más lo máximo que puede costar ese paso pasa de N
  --hallazgos=a.json   arreglo de hallazgos de VanGUARD ({rule_id, severity, title, path?}, máx. 200) para la
                       sección de riesgos; [] = auditoría sin hallazgos
Entorno: ANTHROPIC_API_KEY (obligatoria salvo --estimar), GITHUB_TOKEN (opcional; repos privados y más límite),
  DEEPWIKI_MODEL_FAST / DEEPWIKI_MODEL_SMART (opcionales).`;
const OUT = fileURLToPath(new URL('../out/', import.meta.url));
const BANDERAS = new Set(['--estimar', '--forzar', '--ayuda', '--help', '-h']);
const CON_VALOR = ['--ref=', '--max-usd=', '--hallazgos='];
const MAX_HALLAZGOS = 200;
const GRAVEDADES = new Set(['critical', 'high', 'medium', 'low', 'info']);

function env(nombre: string): string | undefined {
  const v = process.env[nombre]?.trim();
  return v ? v : undefined;
}

// Defensa extra: aunque el motor nunca pone claves en sus mensajes, nada sale por consola sin pasar por aquí.
const SECRETOS = [env('ANTHROPIC_API_KEY'), env('GITHUB_TOKEN')].filter((s): s is string => !!s && s.length >= 8);
function limpiar(texto: string): string {
  let t = texto;
  for (const s of SECRETOS) t = t.split(s).join('[REDACTADO]');
  return redactar(t).texto;
}
const decir = (m: string) => console.log(limpiar(m));
const quejarse = (m: string) => console.error(limpiar(m));
const usd = (n: number) => `US$ ${n.toFixed(4)}`;
const mostrarRuta = (p: string) => relative(process.cwd(), p) || '.';
// Lo gastado en la corrida en curso, para decirlo aunque falle a mitad de camino.
let gastado = 0;

function modelosEnv(): Partial<WikiModelos> {
  const m: Partial<WikiModelos> = {};
  const fast = env('DEEPWIKI_MODEL_FAST'), smart = env('DEEPWIKI_MODEL_SMART');
  if (fast && /^[A-Za-z0-9._:-]{3,80}$/.test(fast)) m.fast = fast;
  if (smart && /^[A-Za-z0-9._:-]{3,80}$/.test(smart)) m.smart = smart;
  return m;
}

async function existe(ruta: string): Promise<boolean> {
  try { await access(ruta); return true; } catch { return false; }
}

const valor = (args: string[], prefijo: string) => args.find((a) => a.startsWith(prefijo))?.slice(prefijo.length).trim();

// Esquema mínimo de HallazgoBreve, sin dependencias: la CLI no confía en el archivo más que el BACK en la base.
function validarHallazgos(datos: unknown): HallazgoBreve[] {
  if (!Array.isArray(datos) || datos.length > MAX_HALLAZGOS) {
    throw new Error(`--hallazgos debe ser un arreglo JSON de hasta ${MAX_HALLAZGOS} hallazgos.`);
  }
  return datos.map((h: unknown, i) => {
    const o = (typeof h === 'object' && h !== null ? h : {}) as Record<string, unknown>;
    const ok = typeof o.rule_id === 'string' && o.rule_id.length > 0 && o.rule_id.length <= 120
      && typeof o.severity === 'string' && GRAVEDADES.has(o.severity)
      && typeof o.title === 'string' && o.title.length > 0 && o.title.length <= 300
      && (o.path === undefined || (typeof o.path === 'string' && o.path.length <= 300));
    if (!ok) throw new Error(`--hallazgos: el elemento ${i} no cumple {rule_id, severity, title, path?}.`);
    const out: HallazgoBreve = { rule_id: o.rule_id as string, severity: o.severity as HallazgoBreve['severity'],
      title: o.title as string };
    if (typeof o.path === 'string') out.path = o.path;
    return out;
  });
}

function imprimirEstimacion(e: Estimacion): void {
  decir(`Estimación (${e.models.fast} + ${e.models.smart}): ${usd(e.est.usd)} · ${e.est.input_tokens} tokens de entrada `
    + `y ${e.est.output_tokens} de salida · hasta ${e.files_a_leer_max} archivos en ${e.areas_max} áreas.`);
  for (const d of e.est.desglose) decir(`  - ${d.paso}: ${d.llamadas} llamada(s) a ${d.modelo}, ${usd(d.usd)}`);
  if (e.est.desglose.length > 0) {
    decir(`  Techo (todas las salidas al tope de max_tokens): ${usd(techoDesglose(e.est.desglose))}`);
  }
  for (const a of e.avisos) decir(`  Aviso: ${a}`);
}

// Estado guardado de una corrida anterior del MISMO commit que falló a mitad: se reanuda sin repagar lo hecho.
async function estadoGuardado(ruta: string, sha: string): Promise<EstadoWiki | null> {
  try {
    const e = JSON.parse(await readFile(ruta, 'utf8')) as EstadoWiki;
    return e && e.version === 1 && e.meta?.commit_sha === sha && Array.isArray(e.areas) ? e : null;
  } catch { return null; }
}

async function principal(args: string[]): Promise<number> {
  const ref = valor(args, '--ref=');
  const maxUsdTxt = valor(args, '--max-usd=');
  const rutaHallazgos = valor(args, '--hallazgos=');
  const banderas = args.filter((a) => a.startsWith('-') && !CON_VALOR.some((p) => a.startsWith(p)));
  const objetivos = args.filter((a) => !a.startsWith('-'));
  const desconocida = banderas.find((b) => !BANDERAS.has(b));
  if (banderas.some((b) => b === '--ayuda' || b === '--help' || b === '-h')) { decir(USO); return 0; }
  const maxUsd = maxUsdTxt === undefined ? undefined : Number(maxUsdTxt);
  if (desconocida || objetivos.length !== 1 || ref === '' || rutaHallazgos === ''
    || (maxUsd !== undefined && !(Number.isFinite(maxUsd) && maxUsd > 0))) {
    if (desconocida) quejarse(`Opción desconocida: ${desconocida.slice(0, 40)}`);
    quejarse(USO);
    return 1;
  }
  const soloEstimar = banderas.includes('--estimar');
  const forzar = banderas.includes('--forzar');

  const repo = normalizarRepo(objetivos[0] ?? '');
  const githubToken = env('GITHUB_TOKEN');
  const deps: Deps = { fetch: (u, i) => fetch(u, i), modelos: modelosDe({ modelos: modelosEnv() }) };
  if (githubToken) deps.githubToken = githubToken;
  if (rutaHallazgos) {
    deps.hallazgos = validarHallazgos(JSON.parse(await readFile(rutaHallazgos, 'utf8')));
    decir(`Hallazgos de VanGUARD: ${deps.hallazgos.length} (de ${mostrarRuta(rutaHallazgos)}).`);
  }

  decir(`[  0%] arbol: leyendo ${repo}${ref ? ` (${ref})` : ''} en GitHub `
    + `${githubToken ? 'con tu token' : 'sin token (60 peticiones por hora)'}…`);
  const arbol = await pasoArbol(ref ? { repo_full_name: repo, ref } : { repo_full_name: repo }, deps);
  const { meta } = arbol;
  decir(`[ 10%] arbol: commit ${meta.commit_sha.slice(0, 7)} de ${meta.full_name} (${meta.branch}): `
    + `${arbol.files_total} archivos, ${arbol.candidatos.length} candidatos tras los filtros.`);

  // Caché por commit y por hallazgos: la sección de riesgos depende de ellos, así que una wiki generada sin hallazgos
  // (o con otros) no se reutiliza.
  const huella = deps.hallazgos ? `-h${(await huellaHallazgos(deps.hallazgos)).slice(0, 8)}` : '';
  const dir = join(OUT, meta.full_name.replace('/', '__'), meta.commit_sha + huella);
  const rutaEstado = join(dir, 'estado.json');
  const enCache = await existe(join(dir, 'wiki.json')) && await existe(join(dir, 'overview.md'));
  const est = estimar(arbol, deps);
  imprimirEstimacion(est);
  if (soloEstimar) {
    if (enCache) decir(`Ya existe la wiki de este commit (costaría US$ 0): ${mostrarRuta(join(dir, 'overview.md'))}`);
    return 0;
  }
  if (enCache && !forzar) {
    decir(`Ya existe la wiki de este commit, no se gasta nada: ${mostrarRuta(join(dir, 'overview.md'))}`);
    decir('Usa --forzar para regenerarla.');
    return 0;
  }

  const apiKey = env('ANTHROPIC_API_KEY');
  if (!apiKey) {
    quejarse('Falta ANTHROPIC_API_KEY en el entorno (.env de la raíz del repo). Para solo estimar usa --estimar.');
    return 1;
  }
  const previo = forzar ? null : await estadoGuardado(rutaEstado, meta.commit_sha);
  const estado = previo ?? arbol;
  if (previo) {
    gastado = previo.consumo.cost_usd;
    decir(`Reanudo la corrida anterior de este commit (ya gastado ${usd(gastado)}; ${previo.resumenes.length} áreas hechas).`);
  }
  await mkdir(dir, { recursive: true });
  const llm = crearLlmFetch({ apiKey, fetch: (u, i) => fetch(u, i), modelos: deps.modelos, avisar: quejarse });
  const doc = await completarWiki(estado, { ...deps, llm }, {
    ...(maxUsd !== undefined ? { maxUsd } : {}),
    alAvanzar: (a) => {
      gastado = a.consumo.cost_usd;
      decir(`[${String(a.progreso).padStart(3)}%] ${a.paso}: ${a.detalle} (llevas ${usd(a.consumo.cost_usd)})`);
    },
    // Solo rutas, resúmenes y consumo (nunca código): sirve para reanudar si la corrida falla a mitad.
    alGuardar: async (e) => {
      gastado = e.consumo.cost_usd;
      await writeFile(rutaEstado, `${JSON.stringify(e)}\n`, 'utf8');
    },
  });
  gastado = doc.stats.cost_usd;

  await writeFile(join(dir, 'overview.md'), documentoMarkdown(doc), 'utf8');
  await writeFile(join(dir, 'wiki.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await rm(rutaEstado, { force: true });
  for (const a of doc.avisos) decir(`Aviso: ${a}`);
  decir(`Costo real: ${usd(doc.stats.cost_usd)} (estimado ${usd(est.est.usd)}) · ${doc.stats.input_tokens} tokens de `
    + `entrada y ${doc.stats.output_tokens} de salida · ${doc.stats.files_leidos} archivos en ${doc.stats.areas} áreas.`);
  decir(`Listo: ${mostrarRuta(join(dir, 'overview.md'))} y wiki.json`);
  return 0;
}

try {
  // pnpm pasa el «--» separador tal cual (pnpm generate -- dueño/repo): se ignora.
  process.exitCode = await principal(process.argv.slice(2).filter((a) => a !== '--'));
} catch (e) {
  const codigo = e instanceof ErrorGithub || e instanceof ErrorWiki ? ` [${e.codigo}]` : '';
  quejarse(`Error${codigo}: ${e instanceof Error ? e.message : 'desconocido'}`);
  if (gastado > 0) quejarse(`Gastado hasta el fallo: ${usd(gastado)} (el estado quedó guardado: vuelve a correrlo para reanudar).`);
  // Norton y otros antivirus interceptan TLS: Node no confía en su certificado salvo que use el almacén del sistema.
  if (e instanceof ErrorGithub && e.codigo === 'github_red') {
    quejarse('Si un antivirus intercepta TLS en este equipo, prueba con NODE_OPTIONS=--use-system-ca.');
  }
  process.exitCode = 1;
}
