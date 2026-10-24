import { ProviderError, codigoHttp, pedir } from '../lib/http.ts';

// OSV.dev (§09.7): querybatch en lotes de 1000 → detalle con un POST /v1/query por paquete vulnerable (≤ 30 por
// mensaje) → dedupe por alias → un CB_DEP_VULN por ecosistema:paquete@versión. KEV/EPSS son P1/P2 (no aquí).
const OSV = 'https://api.osv.dev/v1';
const PLAZO = 20_000;
const LOTE = 1000;
// 12 y no 30: el humo de A7.7 midió 21–25 ms de CPU con 40 respuestas de OSV (lo caro es el JSON.parse); con 12 queda ~7 ms.
export const DETALLE_POR_MENSAJE = 12;
const PARALELO = 5;
const TRANSITORIOS = new Set(['unavailable', 'timeout', 'rate_limited']);
/** Red, plazo, 429 o 5xx: lo que la cola debe reintentar (jobs.ts usa el mismo conjunto). */
export const esTransitorio = (e: unknown): boolean => e instanceof ProviderError && TRANSITORIOS.has(e.code);
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Dep = { ecosystem: string; name: string; version: string; dev: boolean };
type Rango = { type?: string; events?: { introduced?: string; fixed?: string; last_affected?: string }[] };
type Aviso = { id: string; aliases?: string[]; summary?: string; database_specific?: { severity?: string; cvss?: string };
  severity?: { type?: string; score?: string }[];
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: Rango[] }[] };
export type FilaDep = { rule_id: 'CB_DEP_VULN'; severity: string; confirmed: boolean; title: string; resource: string;
  evidence: Record<string, unknown> };

const SEV: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const sevOsv = (a: Aviso): { s: string; defecto: boolean } => {
  if (a.id.startsWith('MAL-')) return { s: 'critical', defecto: false };
  const d = (a.database_specific?.severity ?? '').toUpperCase();
  const m: Record<string, string> = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', MEDIUM: 'medium', LOW: 'low' };
  return m[d] ? { s: m[d]!, defecto: false } : { s: 'medium', defecto: true };
};

// Comparación numérica por segmentos (1.10.0 > 1.9.9); los sufijos de prerelease se ignoran.
export function cmpVersion(a: string, b: string): number {
  const p = (v: string) => v.replace(/^v/, '').split(/[.+-]/).map((x) => Number.parseInt(x, 10)).map((n) => (Number.isNaN(n) ? 0 : n));
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Versión de arreglo: rango SEMVER/ECOSYSTEM del MISMO paquete con introduced ≤ v < fixed (los GIT se ignoran).
export function arregloDe(a: Aviso, dep: Dep): string | null {
  let mejor: string | null = null;
  for (const af of a.affected ?? []) {
    if (af.package?.name !== dep.name || af.package?.ecosystem !== dep.ecosystem) continue;
    for (const r of af.ranges ?? []) {
      if (r.type === 'GIT') continue;
      let intro = '0';
      for (const ev of r.events ?? []) {
        if (ev.introduced !== undefined) intro = ev.introduced;
        if (ev.fixed !== undefined && cmpVersion(intro, dep.version) <= 0 && cmpVersion(dep.version, ev.fixed) < 0) {
          if (!mejor || cmpVersion(ev.fixed, mejor) > 0) mejor = ev.fixed;
        }
      }
    }
  }
  return mejor;
}

// Dedupe por alias dentro de un paquete: ids que comparten id ∪ aliases son un solo aviso. Id visible: CVE o GHSA.
export function dedupeAvisos(avisos: Aviso[]): Aviso[] {
  const out: { claves: Set<string>; a: Aviso }[] = [];
  for (const a of avisos) {
    const claves = new Set([a.id, ...(a.aliases ?? [])]);
    const igual = out.find((o) => [...claves].some((k) => o.claves.has(k)));
    if (igual) { for (const k of claves) igual.claves.add(k); if (sevOsv(a).s && SEV[sevOsv(a).s]! > SEV[sevOsv(igual.a).s]!) igual.a = a; }
    else out.push({ claves, a });
  }
  return out.map((o) => o.a);
}
const visible = (a: Aviso) => [a.id, ...(a.aliases ?? [])].find((x) => x.startsWith('CVE-'))
  ?? [a.id, ...(a.aliases ?? [])].find((x) => x.startsWith('GHSA-')) ?? a.id;

export function filaDep(dep: Dep, avisos: Aviso[], sinDetalle = false): FilaDep {
  const resource = `${dep.ecosystem}:${dep.name}@${dep.version}`;
  if (sinDetalle) {
    return { rule_id: 'CB_DEP_VULN', severity: 'medium', confirmed: false, title: `Dependencia con avisos: ${dep.name}@${dep.version}`,
      resource, evidence: { paquete: dep, sin_detalle: true, n_avisos: avisos.length } };
  }
  const unicos = dedupeAvisos(avisos)
    .map((a) => ({ a, sev: sevOsv(a), arreglo: arregloDe(a, dep) }))
    .sort((x, y) => SEV[y.sev.s]! - SEV[x.sev.s]!);
  const peor = unicos[0]?.sev.s ?? 'medium';
  const arreglos = unicos.map((u) => u.arreglo).filter((x): x is string => !!x);
  const version_arreglo = arreglos.reduce<string | null>((m, v) => (!m || cmpVersion(v, m) > 0 ? v : m), null);
  const malicioso = unicos.some((u) => u.a.id.startsWith('MAL-'));
  const urgencia = malicioso ? 'ahora' : !dep.dev && (peor === 'critical' || peor === 'high') ? 'hoy'
    : dep.dev ? 'backlog' : version_arreglo ? 'semana' : 'backlog';
  const avisosEv = unicos.slice(0, 10).map(({ a, sev, arreglo }) => {
    const id = visible(a);
    const refs = [`https://osv.dev/vulnerability/${a.id}`];
    if (id.startsWith('CVE-')) refs.push(`https://nvd.nist.gov/vuln/detail/${id}`, `https://www.cve.org/CVERecord?id=${id}`);
    return { id, osv_id: a.id, severidad: sev.s, ...(sev.defecto ? { severidad_por_defecto: true } : {}),
      resumen: (a.summary ?? '').slice(0, 200), arreglo, refs };
  });
  return {
    rule_id: 'CB_DEP_VULN', severity: peor, confirmed: true,
    title: `${dep.name}@${dep.version} tiene ${unicos.length} aviso${unicos.length === 1 ? '' : 's'} de seguridad`.slice(0, 200),
    resource,
    evidence: { paquete: dep, n_avisos: unicos.length, avisos: avisosEv, version_arreglo, urgencia },
  };
}

const deRed = (e: unknown) => ((e as Error)?.name === 'TimeoutError' ? 'timeout' : 'unavailable');

// El cuerpo también puede fallar después de las cabeceras (red cortada, plazo vencido a mitad, 200 que no es JSON): es
// el mismo fallo transitorio que un 5xx, para que el querybatch y la cola lo reintenten (mismo criterio que http.ts).
async function osvJson<T>(path: string, body: unknown): Promise<T> {
  const r = await pedir(`${OSV}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) }, PLAZO);
  if (!r.ok) { await r.body?.cancel(); throw new ProviderError(codigoHttp(r.status), r.status); }
  try { return (await r.json()) as T; } catch (e) { throw new ProviderError(deRed(e), r.status); }
}

// Paso 1: índices de las deps con algún aviso. Reintenta el querybatch una vez tras una espera corta (lo único que se
// reintenta dentro del mensaje, §09.4) y solo si el fallo es transitorio. Si vuelve a fallar, lanza: el paso decide si
// la cola reintenta el mensaje o si se rinde con osv_unavailable.
export async function depsVulnerables(deps: Dep[], espera = 500): Promise<{ vulnerables: number[]; subpeticiones: number }> {
  const vulnerables: number[] = [];
  let sub = 0;
  for (let i = 0; i < deps.length; i += LOTE) {
    const trozo = deps.slice(i, i + LOTE);
    const cuerpo = { queries: trozo.map((d) => ({ package: { ecosystem: d.ecosystem, name: d.name }, version: d.version })) };
    let res: { results?: { vulns?: unknown[] }[] } | null = null;
    for (let intento = 0; intento < 2 && !res; intento++) {
      sub++;
      try { res = await osvJson('/querybatch', cuerpo); } catch (e) {
        if (intento === 1 || !esTransitorio(e)) throw e;
        await dormir(espera);
      }
    }
    (res?.results ?? []).forEach((r, j) => { if ((r.vulns?.length ?? 0) > 0) vulnerables.push(i + j); });
  }
  return { vulnerables, subpeticiones: sub };
}

// Paso 2: detalle de hasta DETALLE_POR_MENSAJE paquetes, 5 en paralelo. Un paquete que falla entra sin detalle;
// `fallidos` cuenta los fallos transitorios para que el paso devuelva el mensaje a la cola en vez de rebajar a medium
// sin_detalle un hallazgo que la auditoría anterior tenía con su severidad real; `errores` cuenta todos (un 400
// incluido): con alguno, OSV no vio todo y el cierre no auto-verifica.
export async function detallar(deps: Dep[]): Promise<{ filas: FilaDep[]; fallidos: number; errores: number }> {
  const filas: FilaDep[] = new Array(deps.length);
  let k = 0;
  let fallidos = 0;
  let errores = 0;
  const hilo = async () => {
    while (k < deps.length) {
      const i = k++;
      const d = deps[i]!;
      try {
        const r = await osvJson<{ vulns?: Aviso[] }>('/query', { package: { ecosystem: d.ecosystem, name: d.name }, version: d.version });
        filas[i] = (r.vulns?.length ?? 0) > 0 ? filaDep(d, r.vulns!) : filaDep(d, [], true);
      } catch (e) {
        filas[i] = filaDep(d, [], true);
        errores++;
        if (esTransitorio(e)) fallidos++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALELO, deps.length) }, hilo));
  return { filas: filas.filter(Boolean), fallidos, errores };
}
