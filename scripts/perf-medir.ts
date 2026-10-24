// Siembra de Rendimiento de la demo (PLAN_MAESTRO §10.11, RND-06; ORQUESTADOR). Mide con PageSpeed Insights una URL de
// nuestras zonas en móvil y escritorio (3 repeticiones de cada una, todas en paralelo, con la misma lógica que fetchPsi de
// vg-psi, §10.2) y deja:
//   demo/perf-lhr/<versión>/<hora UTC>/<versión>-<estrategia>-<rep>.json  respuesta cruda de PSI (la verdad; no se versiona)
//   demo/seed-perf.sql         un bloque delete + insert por (medición, estrategia) en public.perf_runs, trigger 'seed'
//   demo/perf-lhr/resumen.json una línea por repetición con cifras sueltas (sí se versiona: prueba que es medido)
// Lo lanza Giovanni en SU terminal: Node lee PSI_API_KEY del .env y la clave no se imprime nunca (A6, RND-02).
//   node --env-file=.env scripts/perf-medir.ts --url https://demo.officialvanguard.com/ --version v1-sana
//   node scripts/perf-medir.ts --url https://demo.officialvanguard.com/ --version v1-sana --from-dir demo/perf-lhr/v1-sana/<hora>
// El segundo (plan C de §10.11: JSON bajados con curl, o regenerar el SQL cuando exista core/perf) no usa la clave.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const ORG_DEMO = '00000000-0000-4000-a000-00000000de00'; // §05.11, el mismo id que fixtures/ids.ts
export const ZONAS = ['officialvanguard.com']; // VanGUARD no mide sitios ajenos (§10.1)
const PSI = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const CATEGORIAS = ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO'];
export const ESPERAS_MS = [20_000, 40_000]; // R_PSI de §10.2: se reintenta solo ante 429, 5xx o red
const VERSION = /^[A-Za-z0-9_.-]{1,40}$/; // el mismo check que perf_runs.version_label
const URL_BD = /^https:\/\/[a-z0-9.-]+(\/[^?#\s]*)?$/; // el mismo check que perf_runs.url
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOPE_DIAGNOSIS = 8 * 1024; // §10.5: diagnosis ≤ 8 KB
const MAX_REPS = 5; // check (rep between 1 and 5) de §10.5

export type Strategy = 'mobile' | 'desktop';
type Audit = { numericValue?: unknown; details?: { items?: unknown } };
export type Lhr = {
  fetchTime?: unknown; lighthouseVersion?: unknown; requestedUrl?: unknown; finalUrl?: unknown; finalDisplayedUrl?: unknown;
  runtimeError?: { code?: unknown }; configSettings?: { formFactor?: unknown };
  categories?: Record<string, { score?: unknown } | undefined>; audits?: Record<string, Audit | undefined>;
};
export type Rep = { lhr: Lhr; field: unknown; crudo: unknown } | { fatal: string } | { transient: string };
export type Metricas = {
  lcp_ms: number | null; tbt_ms: number | null; cls: number | null; fcp_ms: number | null; si_ms: number | null;
  ttfb_ms: number | null; tti_ms: number | null; total_bytes: number | null; script_bytes: number | null; request_count: number | null;
};
// Una fila de public.perf_runs: PerfRunExt (packages/contracts/src/perf.ts) más las columnas que el contrato no expone.
export type FilaPerf = {
  id: string; org_id: string; url: string; strategy: Strategy; source: 'psi'; lighthouse_version: string | null;
  scores: Record<string, number | null>; metrics: Metricas; created_at: string; scan_run_id: null; run_group: string;
  rep: number; is_representative: boolean; trigger: 'seed'; version_label: string | null; commit_sha: null;
  final_url: string | null; runtime_error: string | null; diagnosis: unknown; field: unknown;
};
export const COLUMNAS = ['id', 'org_id', 'url', 'strategy', 'source', 'lighthouse_version', 'scores', 'metrics', 'created_at',
  'scan_run_id', 'run_group', 'rep', 'is_representative', 'trigger', 'version_label', 'commit_sha', 'final_url',
  'runtime_error', 'diagnosis', 'field'] as const;

/** El uuidFrom de §10.2: mismo texto → mismo uuid (v5, variante RFC), así regenerar no duplica filas. */
export function uuidFrom(s: string): string {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** assertMeasurableUrl de §10.9: solo https de nuestras zonas, sin IPs, puertos ni credenciales → origin + pathname. */
export function urlMedible(raw: string, zonas: string[] = ZONAS): string {
  if (raw.length > 2048) throw new Error('URL demasiado larga');
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('No es una URL'); }
  if (u.protocol !== 'https:') throw new Error('Solo https');
  if (u.username || u.password || (u.port && u.port !== '443')) throw new Error('Sin credenciales ni puertos');
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (/^\d+(\.\d+){3}$/.test(h) || h.startsWith('[')) throw new Error('No se miden IPs');
  if (!zonas.some((z) => h === z || h.endsWith('.' + z))) throw new Error(`Solo dominios de nuestras zonas: ${zonas.join(', ')}`);
  const limpia = `https://${h}${u.pathname || '/'}`; // sin query ni fragmento
  if (!URL_BD.test(limpia)) throw new Error('La URL no pasa el check de perf_runs.url');
  return limpia;
}

/** Quita la clave de cualquier texto que se vaya a imprimir o escribir (la URL de PSI lleva key=). */
export function ocultar(texto: string, clave?: string): string {
  const t = clave && clave.length >= 8 ? texto.split(clave).join('[clave]') : texto;
  return t.replace(/([?&]key=)[^&\s"']*/gi, '$1[clave]').replace(/AIza[0-9A-Za-z_-]{35}/g, '[clave]');
}
const conSecreto = (t: string, clave: string) => (clave.length >= 8 && t.includes(clave)) || /AIza[0-9A-Za-z_-]{35}/.test(t);

/** Una llamada a PSI, clasificada como fetchPsi de vg-psi: lhr, fatal (no se reintenta) o transient. */
export async function pedirPsi(url: string, s: Strategy, clave: string, f: typeof fetch = fetch): Promise<Rep> {
  const q = new URLSearchParams({ url, strategy: s.toUpperCase(), locale: 'es', key: clave }); // strategy siempre explícita
  for (const c of CATEGORIAS) q.append('category', c);
  try {
    const r = await f(`${PSI}?${q}`, { signal: AbortSignal.timeout(130_000) }); // esta URL lleva la clave: nunca se registra
    if (!r.ok) {
      const cuerpo = (await r.json().catch(() => null)) as { error?: { message?: unknown } } | null;
      const lh = String(cuerpo?.error?.message ?? '').match(/Lighthouse returned error: ([A-Z_]+)/)?.[1];
      if (lh) return { fatal: `LH_${lh}` }; // la página no carga: reintentar no sirve
      return r.status === 429 || r.status >= 500 ? { transient: `PSI_${r.status}` } : { fatal: `PSI_${r.status}` };
    }
    const j = (await r.json()) as { lighthouseResult?: Lhr; loadingExperience?: { metrics?: unknown } } | null;
    return j?.lighthouseResult ? { lhr: j.lighthouseResult, field: j.loadingExperience?.metrics ?? null, crudo: j } : { fatal: 'PSI_NO_LHR' };
  } catch {
    return { transient: 'PSI_RED' }; // timeout, red o TLS; el error de fetch no se imprime (podría citar la URL)
  }
}

export async function medirConReintentos(url: string, s: Strategy, clave: string, f: typeof fetch,
  esperar: (ms: number) => Promise<void>): Promise<Rep> {
  let r = await pedirPsi(url, s, clave, f);
  for (const ms of ESPERAS_MS) {
    if (!('transient' in r)) break;
    await esperar(ms);
    r = await pedirPsi(url, s, clave, f);
  }
  return r;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const entero = (v: unknown) => { const n = num(v); return n === null ? null : Math.round(n); };

/** scores con las claves del LHR tal cual (best-practices con guion) y metrics de §10.3; lo que falte va null. */
export function summarize(lhr: Lhr): { scores: Record<string, number | null>; metrics: Metricas } {
  const a = lhr.audits ?? {};
  const valor = (id: string) => a[id]?.numericValue;
  const items = (id: string) => { const x = a[id]?.details?.items; return (Array.isArray(x) ? x : []) as Record<string, unknown>[]; };
  const fila = (tipo: string) => items('resource-summary').find((x) => x?.resourceType === tipo);
  const cls = num(valor('cumulative-layout-shift'));
  return {
    scores: Object.fromEntries(Object.entries(lhr.categories ?? {}).map(([k, c]) => [k, num(c?.score)])),
    metrics: {
      lcp_ms: entero(valor('largest-contentful-paint')), tbt_ms: entero(valor('total-blocking-time')),
      cls: cls === null ? null : Math.round(cls * 10_000) / 10_000,
      fcp_ms: entero(valor('first-contentful-paint')), si_ms: entero(valor('speed-index')),
      ttfb_ms: entero(items('metrics')[0]?.timeToFirstByte ?? valor('server-response-time')),
      tti_ms: entero(valor('interactive')), total_bytes: entero(fila('total')?.transferSize),
      script_bytes: entero(fila('script')?.transferSize), request_count: entero(fila('total')?.requestCount),
    },
  };
}

const texto = (v: unknown) => (typeof v === 'string' ? v : null);

export function toPerfRow(o: { orgId: string; url: string; strategy: Strategy; runGroup: string; rep: number;
  version: string | null; lhr: Lhr; field: unknown }): FilaPerf {
  const { scores, metrics } = summarize(o.lhr);
  const at = new Date(String(o.lhr.fetchTime ?? ''));
  if (Number.isNaN(at.getTime())) throw new Error('LHR sin fetchTime válido');
  const final = texto(o.lhr.finalDisplayedUrl) ?? texto(o.lhr.finalUrl);
  return {
    id: uuidFrom(`${o.runGroup}|${o.rep}`), org_id: o.orgId, url: o.url, strategy: o.strategy, source: 'psi',
    lighthouse_version: texto(o.lhr.lighthouseVersion), scores, metrics, created_at: at.toISOString(), // = fetchTime, hora real
    scan_run_id: null, run_group: o.runGroup, rep: o.rep, is_representative: false, trigger: 'seed',
    version_label: o.version, commit_sha: null, final_url: final ? final.slice(0, 2048) : null,
    runtime_error: texto(o.lhr.runtimeError?.code), diagnosis: null, field: o.field ?? null,
  };
}

const puntaje = (f: FilaPerf) => { const p = f.scores.performance; return typeof p === 'number' ? Math.round(p * 100) : null; };
const mediana = (xs: number[]) => {
  const o = [...xs].sort((a, b) => a - b), m = o.length >> 1;
  return o.length === 0 ? null : o.length % 2 ? o[m]! : (o[m - 1]! + o[m]!) / 2;
};

/** La repetición sin runtime_error más cercana a la mediana del puntaje (empate: menor LCP); -1 si ninguna. */
export function pickRepresentative(filas: FilaPerf[]): number {
  const v = filas.flatMap((f, i) => { const p = puntaje(f); return f.runtime_error === null && p !== null ? [{ i, p, lcp: f.metrics.lcp_ms ?? Number.MAX_VALUE }] : []; });
  const m = mediana(v.map((x) => x.p));
  if (m === null) return -1;
  v.sort((a, b) => Math.abs(a.p - m) - Math.abs(b.p - m) || a.lcp - b.lcp);
  return v[0]!.i;
}

/** Una medición = las repeticiones de una estrategia: dedupe por fetchTime, rep 1..n, run_group del contenido. */
export function armarMedicion(o: { orgId: string; url: string; strategy: Strategy; version: string | null; reps: Rep[];
  diagnosticar?: ((lhr: Lhr) => unknown) | null }): { filas: FilaPerf[]; motivos: string[] } {
  const motivos = o.reps.flatMap((r) => ('fatal' in r ? [r.fatal] : 'transient' in r ? [r.transient] : []));
  const vistos = new Set<string>();
  const ok = o.reps.flatMap((r) => ('lhr' in r ? [{ ...r, t: Date.parse(String(r.lhr.fetchTime ?? '')) }] : []))
    .filter((r) => {
      if (Number.isNaN(r.t)) { motivos.push('LHR_SIN_FETCHTIME'); return false; }
      if (vistos.has(String(r.t))) return false; // PSI devolvió la misma corrida en caché: cuenta una vez (§10.1)
      vistos.add(String(r.t));
      return true;
    })
    .sort((a, b) => a.t - b.t);
  if (!ok.length) return { filas: [], motivos };
  if (ok.length > MAX_REPS) throw new Error(`${ok.length} repeticiones de ${o.strategy}: una carpeta por medición (máximo ${MAX_REPS})`);
  // Determinista: la misma medición regenerada con --from-dir reemplaza su bloque en lugar de duplicarlo.
  const runGroup = uuidFrom(`seed|${o.orgId}|${o.url}|${o.strategy}|${new Date(ok[0]!.t).toISOString()}`);
  const filas = ok.map((r, i) => toPerfRow({ orgId: o.orgId, url: o.url, strategy: o.strategy, runGroup, rep: i + 1,
    version: o.version, lhr: r.lhr, field: r.field }));
  const i = pickRepresentative(filas);
  if (i >= 0) {
    filas[i]!.is_representative = true; // solo ella lleva diagnosis (§10.5)
    if (o.diagnosticar) {
      try {
        const d = o.diagnosticar(ok[i]!.lhr);
        // Bytes UTF-8, no caracteres: las etiquetas en español llevan tildes y el tope de §10.5 es de 8 KB.
        if (d != null && Buffer.byteLength(JSON.stringify(d), 'utf8') <= TOPE_DIAGNOSIS) filas[i]!.diagnosis = d;
        else if (d != null) motivos.push('DIAGNOSIS_MAYOR_DE_8KB');
      } catch { motivos.push('DIAGNOSE_FALLO'); }
    }
  }
  return { filas, motivos };
}

/** Literal SQL: comillas dobladas; objetos como jsonb (sin NUL, que jsonb rechaza). */
export function lit(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('número no finito'); return String(v); }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return `'${v.replaceAll("'", "''")}'`;
  // El NUL se quita de cada texto antes de serializar: borrar «\u0000» del JSON ya escrito rompería un «\\u0000» literal.
  return `${lit(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'string' ? x.replaceAll('\u0000', '') : x)))}::jsonb`;
}

export const ENCABEZADO_SQL = `-- demo/seed-perf.sql · siembra de Rendimiento de la demo (PLAN_MAESTRO §10.11, RND-06) · ORQUESTADOR
-- Lo GENERA scripts/perf-medir.ts: no se escribe a mano ni se inventan filas. Cada bloque «>>> medicion <run_group>» es
-- una medición real de PageSpeed Insights (una URL, una estrategia, 3 repeticiones o las de --reps) con su hora real
-- (created_at = lighthouseResult.fetchTime), trigger 'seed', scan_run_id null y la version_label de --version.
-- Dónde: accshmgmfrqrxubpuxcl (editor SQL o MCP de Supabase), después de 0007 y de supabase/seed/demo.sql (§05.11).
-- Re-aplicarlo entero es seguro: cada bloque borra su run_group y lo vuelve a insertar, y el run_group sale de lo medido
-- (no del azar), así que regenerar con --from-dir reemplaza el bloque en lugar de duplicarlo.
-- Sin claves: solo cifras, URLs de nuestras zonas, la versión y, cuando exista packages/core/src/perf, el diagnóstico.
-- Si a las 19:00 no hay ningún bloque debajo, vale el plan B: las filas manuales de supabase/seed/demo.sql.
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'perf_runs' and column_name = 'run_group') then
    raise exception 'perf_runs sin las columnas de §10.5: esta no es la base de VanGUARD o falta 0007';
  end if;
  if not exists (select 1 from public.orgs where id = '${ORG_DEMO}' and is_demo) then
    raise exception 'Falta la org de demo: aplica antes supabase/seed/demo.sql (§05.11)';
  end if;
end $$;
`;

const seguro = (s: string | null) => (s && /^[0-9A-Za-z._-]{1,40}$/.test(s) ? s : '?'); // lo que va en un comentario SQL

export function bloqueSql(filas: FilaPerf[]): string {
  const f0 = filas[0]!, rg = f0.run_group;
  const validas = filas.filter((f) => f.runtime_error === null).length;
  return [
    `-- >>> medicion ${rg}`,
    `-- ${f0.url} · ${f0.strategy} · ${seguro(f0.version_label)} · ${filas.length} repeticiones (${validas} sin runtime_error) · Lighthouse ${seguro(f0.lighthouse_version)}`,
    `-- fetchTime: ${filas.map((f) => f.created_at).join(', ')}`,
    `delete from public.perf_runs where org_id = ${lit(f0.org_id)} and run_group = ${lit(rg)};`,
    `insert into public.perf_runs (${COLUMNAS.join(', ')}) values`,
    filas.map((f) => ` (${COLUMNAS.map((c) => lit(f[c])).join(', ')})`).join(',\n') + ';',
    `-- <<< medicion ${rg}`,
    '',
  ].join('\n');
}

/** Añade cada bloque al final o reemplaza el que ya tenga ese run_group. */
export function fusionarSql(previo: string | null, bloques: { runGroup: string; sql: string }[]): string {
  let t = previo ?? ENCABEZADO_SQL;
  for (const b of bloques) {
    const re = new RegExp(`-- >>> medicion ${b.runGroup}\\r?\\n[\\s\\S]*?-- <<< medicion ${b.runGroup}\\r?\\n?`);
    t = re.test(t) ? t.replace(re, () => b.sql) : `${t}${t.endsWith('\n') ? '' : '\n'}\n${b.sql}`;
  }
  return t;
}

export type LineaResumen = {
  url: string; version: string | null; strategy: Strategy; rep: number; run_group: string; fetchTime: string;
  lighthouseVersion: string | null; perf_score: number | null; lcp_ms: number | null; tbt_ms: number | null;
  cls: number | null; runtime_error: string | null;
};

// Solo estos campos (§10.11): no puede arrastrar la clave ni nada del LHR crudo.
export const lineasResumen = (filas: FilaPerf[]): LineaResumen[] => filas.map((f) => ({
  url: f.url, version: f.version_label, strategy: f.strategy, rep: f.rep, run_group: f.run_group, fetchTime: f.created_at,
  lighthouseVersion: f.lighthouse_version, perf_score: puntaje(f), lcp_ms: f.metrics.lcp_ms, tbt_ms: f.metrics.tbt_ms,
  cls: f.metrics.cls, runtime_error: f.runtime_error }));

export function fusionarResumen(previo: string | null, nuevas: LineaResumen[]): string {
  const antes = previo ? (JSON.parse(previo) as LineaResumen[]) : []; // si está roto, que falle: es la evidencia
  if (!Array.isArray(antes)) throw new Error('resumen.json no es una lista');
  const grupos = new Set(nuevas.map((l) => l.run_group));
  const todas = [...antes.filter((l) => !grupos.has(l.run_group)), ...nuevas]
    .sort((a, b) => a.fetchTime.localeCompare(b.fetchTime) || a.strategy.localeCompare(b.strategy) || a.rep - b.rep);
  return `[\n${todas.map((l) => '  ' + JSON.stringify(l)).join(',\n')}\n]\n`;
}

/** Plan C: lee las respuestas de PSI (o LHR sueltos) de una carpeta; la estrategia sale del propio LHR. */
export function leerCarpeta(dir: string, url: string): Record<Strategy, Rep[]> {
  const out: Record<Strategy, Rep[]> = { mobile: [], desktop: [] };
  const nombres = readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'resumen.json').sort();
  if (!nombres.length) throw new Error(`No hay .json en ${dir}`);
  for (const n of nombres) {
    const j = JSON.parse(readFileSync(join(dir, n), 'utf8')) as Record<string, unknown> & { lighthouseResult?: Lhr;
      loadingExperience?: { metrics?: unknown }; error?: { code?: unknown } };
    if (j?.error) throw new Error(`${n}: PSI respondió un error (${String(j.error.code ?? '?')}), no una medición`);
    const lhr: Lhr | undefined = j?.lighthouseResult ?? (j?.lighthouseVersion && j?.fetchTime ? (j as Lhr) : undefined);
    if (!lhr) throw new Error(`${n}: no es una respuesta de PSI ni un LHR`);
    const ff = lhr.configSettings?.formFactor;
    const s = ff === 'mobile' || ff === 'desktop' ? ff : n.match(/(mobile|desktop)/i)?.[1]?.toLowerCase();
    if (s !== 'mobile' && s !== 'desktop') throw new Error(`${n}: no sé si es móvil o escritorio`);
    let pedida: string | null = null;
    try { pedida = urlMedible(String(lhr.requestedUrl ?? j.id ?? '')); } catch { /* queda null */ }
    if (pedida !== url) throw new Error(`${n}: midió ${pedida ?? 'otra URL'}, no ${url}`);
    out[s].push({ lhr, field: j.loadingExperience?.metrics ?? null, crudo: j });
  }
  return out;
}

/** Árbol del repo de la demo leído del disco (sin llamar a GitHub) para locateAll. */
function arbolDemo(raiz: string): string[] | null {
  const dir = join(raiz, 'demo', 'repo-vulnerable');
  if (!existsSync(dir)) return null;
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .filter((p) => !/(^|\/)(node_modules|\.git)\//.test(p));
}

/** diagnose/locateAll de packages/core/src/perf si ya existen (RND-03); si no, la siembra sale sin causas (§10.11). */
export async function cargarDiagnostico(raiz: string, decir: (t: string) => void): Promise<((lhr: Lhr) => unknown) | null> {
  const base = join(raiz, 'packages', 'core', 'src', 'perf');
  if (!existsSync(join(base, 'diagnose.ts'))) {
    decir('· Aún no existe packages/core/src/perf: sin causas. Cuando exista, regenera con --from-dir (mismo run_group).');
    return null;
  }
  try {
    const { diagnose } = (await import(pathToFileURL(join(base, 'diagnose.ts')).href)) as { diagnose?: unknown };
    const { locateAll } = existsSync(join(base, 'locate.ts'))
      ? ((await import(pathToFileURL(join(base, 'locate.ts')).href)) as { locateAll?: unknown }) : {};
    if (typeof diagnose !== 'function') return null;
    // Las firmas de core/perf se dedujeron del plan (l.6147); lo que salga se valida con PerfDiagnosis (§10.9) antes de
    // sembrarlo, porque el estado del módulo lee esa diagnosis y una forma distinta lo rompería en la demo.
    const { PerfDiagnosis } = (await import(pathToFileURL(join(RAIZ, 'packages', 'contracts', 'src', 'perf.ts')).href)) as
      { PerfDiagnosis: { safeParse: (v: unknown) => { success: boolean } } };
    const arbol = arbolDemo(raiz);
    return (lhr) => {
      const d: unknown = diagnose(lhr, 5);
      const out: unknown = typeof locateAll === 'function' ? locateAll(d, arbol, ZONAS) : d;
      if (!PerfDiagnosis.safeParse(out).success) throw new Error('diagnosis fuera de PerfDiagnosis');
      return out;
    };
  } catch {
    decir('· No pude cargar core/perf: la siembra sale sin causas.');
    return null;
  }
}

function usarCaDelSistema() {
  // Norton intercepta HTTPS con su propia CA, que está en el almacén de Windows pero no en el de Node: se suma la del
  // sistema, como scripts/kapso-config.mjs (equivale a node --use-system-ca; existe desde Node 24.5).
  try { tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]); } catch { /* Node viejo */ }
}

const PISTAS: Record<string, string> = {
  PSI_400: 'PSI no aceptó la URL (¿la víctima está en línea?)',
  PSI_403: 'la clave no tiene permiso: revisa que la API de PageSpeed Insights esté activada y la restricción de la clave',
  PSI_429: 'cuota o ráfaga: espera un minuto y repite',
  PSI_RED: 'sin red, timeout o TLS roto (Norton): prueba node --use-system-ca o el plan C con curl y --from-dir',
  PSI_NO_LHR: 'PSI respondió sin lighthouseResult',
  DIAGNOSE_FALLO: 'core/perf falló o no devolvió un PerfDiagnosis válido: la representativa va sin causas',
  DIAGNOSIS_MAYOR_DE_8KB: 'la diagnosis pasa de 8 KB: la representativa va sin causas',
};
const pista = (m: string) => PISTAS[m] ?? (m.startsWith('LH_') ? 'Lighthouse no pudo cargar la página' : m.startsWith('PSI_5') ? 'error de Google; repite' : '');

export const USO = `Uso (en tu terminal; la clave la lee Node y no se imprime):
  node --env-file=.env scripts/perf-medir.ts --url https://demo.officialvanguard.com/ --version v1-sana
  node scripts/perf-medir.ts --url <url> --version <etiqueta> --from-dir demo/perf-lhr/<etiqueta>/<hora>
Opciones: --org <uuid> (por defecto la org de demo) · --reps 1-5 (3) · --solo mobile|desktop · --help`;

export type Dependencias = {
  fetch: typeof fetch; esperar: (ms: number) => Promise<void>; env: Record<string, string | undefined>; raiz: string;
  log: (t: string) => void; error: (t: string) => void; ahora: () => Date; prepararTls: () => void;
  diagnosticar?: ((lhr: Lhr) => unknown) | null; // undefined: lo intenta cargar de core/perf; null: sin causas
};

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const HOST_VICTIMA = 'demo.officialvanguard.com';
const sello = (d: Date) => d.toISOString().slice(0, 16).replace(/[-:]/g, '') + 'Z'; // 20261024T2030Z

/** PERF_VERSION de apps/victima/src/perf-version.ts (la misma regex que perf-hook.mjs, §10.4); null si no se puede leer. */
export function versionDeLaVictima(raiz: string): string | null {
  try {
    const v = readFileSync(join(raiz, 'apps', 'victima', 'src', 'perf-version.ts'), 'utf8').match(/PERF_VERSION\s*=\s*'([\w.-]+)'/)?.[1];
    return v && VERSION.test(v) ? v : null;
  } catch { return null; }
}

/** Versiones que dicen los nombres <versión>-<estrategia>-<rep>.json de una carpeta (sin contar sin-version). */
export function versionesEnNombres(nombres: string[]): string[] {
  const v = nombres.flatMap((n) => n.match(/^([A-Za-z0-9_.-]{1,40})-(?:mobile|desktop)-\d+\.json$/)?.[1] ?? []);
  return [...new Set(v.filter((x) => x !== 'sin-version'))].sort();
}
const ms = (n: number | null) => (n === null ? '?' : `${Math.round(n)} ms`);

export async function main(argv: string[], dep: Partial<Dependencias> = {}): Promise<number> {
  const d: Dependencias = { fetch: globalThis.fetch, esperar: (t) => new Promise((r) => setTimeout(r, t)), env: process.env,
    raiz: RAIZ, log: (t) => console.log(t), error: (t) => console.error(t), ahora: () => new Date(),
    prepararTls: usarCaDelSistema, ...dep };
  const clave = (d.env.PSI_API_KEY ?? '').trim();
  const decir = (t: string) => d.log(ocultar(t, clave)), quejarse = (t: string) => d.error(ocultar(t, clave));
  const ruta = (p: string) => relative(d.raiz, p).split(sep).join('/');

  let a;
  try {
    a = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { url: { type: 'string' },
      version: { type: 'string' }, org: { type: 'string' }, 'from-dir': { type: 'string' }, reps: { type: 'string' },
      solo: { type: 'string' }, help: { type: 'boolean', short: 'h' } } }).values;
  } catch (e) { quejarse(`${e instanceof Error ? e.message : 'argumentos inválidos'}\n${USO}`); return 2; }
  if (a.help) { decir(USO); return 0; }

  let url: string;
  try { url = urlMedible(a.url ?? ''); } catch (e) { quejarse(`--url: ${(e as Error).message}\n${USO}`); return 2; }
  let version = a.version ?? null;
  if (version !== null && !VERSION.test(version)) { quejarse('--version: solo letras, números, _ . - (máximo 40)'); return 2; }
  const org = a.org ?? ORG_DEMO;
  if (!UUID.test(org)) { quejarse('--org: no es un uuid'); return 2; }
  const reps = Number(a.reps ?? 3);
  if (!Number.isInteger(reps) || reps < 1 || reps > MAX_REPS) { quejarse(`--reps: entre 1 y ${MAX_REPS}`); return 2; }
  if (a.solo && a.solo !== 'mobile' && a.solo !== 'desktop') { quejarse('--solo: mobile o desktop'); return 2; }
  const estrategias: Strategy[] = a.solo ? [a.solo as Strategy] : ['mobile', 'desktop'];

  let porEstrategia: Record<Strategy, Rep[]>;
  let carpeta: string;
  if (a['from-dir']) {
    carpeta = resolve(d.raiz, a['from-dir']);
    try { porEstrategia = leerCarpeta(carpeta, url); } catch (e) { quejarse(`--from-dir: ${(e as Error).message}`); return 1; }
    // El run_group no depende de la versión: regenerar con la etiqueta equivocada pisaría el bloque bueno con otra versión.
    const enNombres = versionesEnNombres(readdirSync(carpeta));
    if (enNombres.length > 1 || (enNombres.length === 1 && enNombres[0] !== version)) {
      quejarse(`--from-dir: los JSON dicen ${enNombres.join(', ')} y --version es ${version ?? '(ninguna)'}; una carpeta por versión y la misma etiqueta`);
      return 2;
    }
  } else {
    if (!clave) { quejarse('Falta PSI_API_KEY: lánzalo con node --env-file=.env (o apps/api/.dev.vars) scripts/perf-medir.ts …'); return 1; }
    // La víctima declara su versión en perf-version.ts (§10.11): sin --version se usa esa, y si no coinciden se avisa,
    // porque lo desplegado puede ir por detrás del código local.
    const deLaVictima = new URL(url).hostname === HOST_VICTIMA ? versionDeLaVictima(d.raiz) : null;
    if (deLaVictima && version === null) {
      version = deLaVictima;
      decir(`· Sin --version: uso PERF_VERSION = ${version} de apps/victima/src/perf-version.ts.`);
    } else if (deLaVictima && version !== deLaVictima) {
      decir(`⚠ --version ${version} pero apps/victima/src/perf-version.ts dice ${deLaVictima}: comprueba qué está desplegado.`);
    }
    d.prepararTls();
    decir(`Midiendo ${url} · ${estrategias.join(' y ')} · ${reps} repeticiones en paralelo (PSI tarda 20–60 s; hasta 2 reintentos ante 429/5xx/red)…`);
    const pares = estrategias.flatMap((s) => Array.from({ length: reps }, (_, i) => ({ s, rep: i + 1 })));
    const res = await Promise.all(pares.map((p) => medirConReintentos(url, p.s, clave, d.fetch, d.esperar)));
    porEstrategia = { mobile: [], desktop: [] };
    carpeta = join(d.raiz, 'demo', 'perf-lhr', version ?? 'sin-version', sello(d.ahora()));
    mkdirSync(carpeta, { recursive: true });
    pares.forEach((p, i) => {
      const r = res[i]!;
      porEstrategia[p.s].push(r);
      if (!('lhr' in r)) return;
      const json = JSON.stringify(r.crudo);
      if (conSecreto(json, clave)) { quejarse(`· ${p.s}-${p.rep}: la respuesta trae algo con forma de clave; no la guardo`); return; }
      writeFileSync(join(carpeta, `${version ?? 'sin-version'}-${p.s}-${p.rep}.json`), json); // son la verdad (§10.11)
    });
  }

  const diagnosticar = d.diagnosticar === undefined ? await cargarDiagnostico(d.raiz, decir) : d.diagnosticar;
  const bloques: { runGroup: string; sql: string }[] = [];
  const nuevas: LineaResumen[] = [];
  for (const s of estrategias) {
    let medicion: ReturnType<typeof armarMedicion>;
    try { medicion = armarMedicion({ orgId: org, url, strategy: s, version, reps: porEstrategia[s], diagnosticar }); }
    catch (e) { quejarse(`✗ ${s}: ${(e as Error).message}`); return 1; } // p. ej. más de 5 repeticiones en la carpeta
    const { filas, motivos } = medicion;
    const avisos = [...new Set(motivos)].map((m) => `${m}${pista(m) ? ` (${pista(m)})` : ''}`).join('; ');
    if (!filas.length) { quejarse(`✗ ${s}: ninguna repetición utilizable${avisos ? `: ${avisos}` : ''}`); continue; }
    const v = filas.filter((f) => f.runtime_error === null);
    const med = (k: 'lcp_ms' | 'tbt_ms' | 'cls') => mediana(v.flatMap((f) => (f.metrics[k] === null ? [] : [f.metrics[k]!])));
    const rep = filas.find((f) => f.is_representative);
    decir(`✓ ${s}: ${filas.length} repeticiones (${v.length} válidas${v.length < 3 ? ', «indicativo»' : ''}) · puntaje ${mediana(v.flatMap((f) => { const p = puntaje(f); return p === null ? [] : [p]; })) ?? '?'}`
      + ` · LCP ${ms(med('lcp_ms'))} · TBT ${ms(med('tbt_ms'))} · CLS ${med('cls') ?? '?'} · Lighthouse ${filas[0]!.lighthouse_version ?? '?'}`
      + ` · representativa rep ${rep?.rep ?? '-'}${rep?.diagnosis ? ' con causas' : ''}${avisos ? ` · avisos: ${avisos}` : ''}`);
    const sql = bloqueSql(filas);
    if (conSecreto(sql, clave)) { quejarse(`✗ ${s}: el SQL saldría con algo con forma de clave; no lo escribo`); return 1; }
    bloques.push({ runGroup: filas[0]!.run_group, sql });
    nuevas.push(...lineasResumen(filas));
  }
  if (!bloques.length) { quejarse(`Nada que sembrar. Los JSON que llegaron están en ${ruta(carpeta)}.`); return 1; }

  mkdirSync(join(d.raiz, 'demo', 'perf-lhr'), { recursive: true }); // con --from-dir puede no existir todavía
  const rutaSql = join(d.raiz, 'demo', 'seed-perf.sql');
  writeFileSync(rutaSql, fusionarSql(existsSync(rutaSql) ? readFileSync(rutaSql, 'utf8') : null, bloques));
  const rutaResumen = join(d.raiz, 'demo', 'perf-lhr', 'resumen.json');
  writeFileSync(rutaResumen, fusionarResumen(existsSync(rutaResumen) ? readFileSync(rutaResumen, 'utf8') : null, nuevas));

  decir(`SQL: ${ruta(rutaSql)} (${bloques.length} bloque(s) nuevos o reemplazados). Aplícalo en accshmgmfrqrxubpuxcl después de 0007 y supabase/seed/demo.sql.`);
  decir(`Resumen versionable: ${ruta(rutaResumen)} · JSON crudos: ${ruta(carpeta)} (haz copia fuera del repo).`);
  const gi = join(d.raiz, '.gitignore');
  if (!existsSync(gi) || !readFileSync(gi, 'utf8').includes('demo/perf-lhr')) {
    decir('⚠ .gitignore no excluye demo/perf-lhr: añade «demo/perf-lhr/*» y «!demo/perf-lhr/resumen.json» antes de commitear.');
  }
  decir('RND-09: comprueba que esta medición no abrió ningún incidente en la org de demo.');
  return 0;
}

const esCli = import.meta.main === true || (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (esCli) process.exitCode = await main(process.argv.slice(2));
