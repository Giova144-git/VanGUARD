import { EstadoModulo, type CheckDato, type CifraDato, type FilaDato, type GrupoDato, type Module, type RolDato, type ScanStep } from '@vanguard/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from '../lib/db.ts';
import { iso } from '../lib/iso.ts';
import { log } from '../lib/log.ts';

// E6 · EstadoModulo (R08 §6, nombres en español a propósito). El BACK decide grupos, roles y verbos; rol 'mal' solo si
// hay acción posible; un chequeo que no corrió va con comprobado:false y n:null (nunca verde sin mirar). Error de base o
// de proveedor → ok:false con cifras n:null y chequeos sin mirar (§15.4 E6).
type FilaFinding = { id: string; rule_id: string; severity: string; title: string; resource: string; confirmed: boolean;
  evidence: Record<string, unknown> | null };
type ErrorEstado = NonNullable<EstadoModulo['error']>;
type Proveedor = Exclude<Module, 'performance'>;
type Miradas = Record<string, unknown>;

// Chequeos P0 por módulo: código de regla (o prefijo con *) → nombre y fuente que lo mira. `mira` = claves de
// scan_runs.coverage.detail.<modulo>.miradas que deben ser true (todas); `vivo` = reglas en vivo de la ingesta (cuentan
// incidentes, no hallazgos); sin `mira` ni `vivo` = todavía no corre en P0 (nunca se pinta revisado).
type Check = { codigo: string; nombre: string; mira?: readonly string[]; vivo?: true };
const CHECKS: Record<Proveedor, Check[]> = {
  supabase: [
    { codigo: 'SB_RLS_DISABLED', nombre: 'Tablas sin RLS', mira: ['sql_rls'] },
    { codigo: 'SB_POLICY_ALLOW_ALL', nombre: 'Políticas pase-todo', mira: ['sql_politicas'] },
    { codigo: 'SB_RPC_ANON_NO_LIMIT', nombre: 'Funciones abiertas a anon', mira: ['sql_rpc'] },
    { codigo: 'SB_ADVISOR_*', nombre: 'Advisors de Supabase', mira: ['advisors'] },
    { codigo: 'SB_CPU_HIGH', nombre: 'Uso de CPU' },
  ],
  cloudflare: [
    { codigo: 'CF_ZONE_01', nombre: 'Zona activa con proxy', mira: ['zona'] },
    { codigo: 'CF_ADMIN_EXPOSED', nombre: 'Rutas de admin abiertas', vivo: true },
    { codigo: 'CF_PATH_SCAN', nombre: 'Escaneo de rutas', vivo: true },
    { codigo: 'CF_UA_TOOL', nombre: 'Herramientas de ataque', vivo: true },
  ],
  codebase: [
    { codigo: 'CB_ENV_COMMITTED', nombre: '.env subido al repo', mira: ['env'] },
    { codigo: 'CB_GITIGNORE_NO_ENV', nombre: '.gitignore sin .env', mira: ['env'] },
    { codigo: 'CB_SECRET_*', nombre: 'Secretos en el código', mira: ['secretos'] },
    { codigo: 'CB_DEP_VULN', nombre: 'Dependencias con avisos', mira: ['lockfiles', 'osv'] },
  ],
};
const PASO: Record<Proveedor, ScanStep['name'][]> = { supabase: ['supabase'], cloudflare: ['cloudflare'], codebase: ['repo', 'zip'] };
const PROVEEDOR: Record<Proveedor, string> = { supabase: 'supabase', cloudflare: 'cloudflare', codebase: 'github' };
const VIVO_MS = 24 * 3_600_000;   // edge_hits de la ingesta en las últimas 24 h = las reglas en vivo están mirando

const casa = (codigo: string, rule: string) => (codigo.endsWith('*') ? rule.startsWith(codigo.slice(0, -1)) : rule === codigo);
const rol = (s: string): RolDato => (s === 'critical' || s === 'high' ? 'mal' : s === 'medium' ? 'aviso' : 'cola');
const ORDEN: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function fila(m: Module, f: FilaFinding): FilaDato {
  const r = rol(f.severity);
  const sub = typeof f.evidence?.path === 'string' ? `${f.evidence.path}${typeof f.evidence.line === 'number' ? `:${f.evidence.line}` : ''}` : undefined;
  return { clave: f.id, modulo: m, tipo: 'finding', rol: r, etiqueta: f.title.slice(0, 40), objeto: f.resource,
    ...(sub ? { sub } : {}), ...(f.confirmed ? { chips: ['confirmado'] } : {}),
    acciones: [
      { verbo: 'Generar prompt', clase: 'prompt', principal: true, args: { finding_id: f.id } },
      { verbo: 'Ver hallazgos', clase: 'navegar', destino: { modulo: m, filtro: f.resource } },
    ] };
}

function grupos(m: Module, hallazgos: FilaFinding[]): GrupoDato[] {
  const porRegla = new Map<string, FilaFinding[]>();
  for (const f of hallazgos) porRegla.set(f.rule_id, [...(porRegla.get(f.rule_id) ?? []), f]);
  return [...porRegla.entries()]
    .map(([regla, xs]) => {
      const peor = xs.reduce((a, b) => ((ORDEN[b.severity] ?? 0) > (ORDEN[a.severity] ?? 0) ? b : a));
      return { grupo: regla, etiqueta: peor.title.slice(0, 60), rol: rol(peor.severity), n: xs.length, orden: ORDEN[peor.severity],
        filas: xs.slice(0, 20).map((f) => fila(m, f)) };
    })
    .sort((a, b) => (b.orden ?? 0) - (a.orden ?? 0));
}

const contador = (hallazgos: FilaFinding[]) => {
  const cuenta = (r: RolDato) => hallazgos.filter((f) => rol(f.severity) === r).length;
  return { rojo: cuenta('mal'), aviso: cuenta('aviso'), cola: cuenta('cola') };
};

// count exacto: «Hallazgos abiertos» no se queda en 200 aunque la lista sí.
const consultaHallazgos = (admin: SupabaseClient, orgId: string, m: Module) =>
  admin.from('findings').select('id, rule_id, severity, title, resource, confirmed, evidence', { count: 'exact' }).eq('org_id', orgId)
    .eq('module', m).eq('status', 'open').order('severity_rank', { ascending: false }).limit(200);

// Respuesta de error: nunca verde. Cifras con n:null, chequeos sin mirar; contador y «ahora» solo si los hallazgos se leyeron.
function fallo(error: ErrorEstado, hora: string, cifras: CifraDato[], checks: { codigo: string; nombre: string }[],
  m: Module, hallazgos: FilaFinding[] | null): EstadoModulo {
  return EstadoModulo.parse({
    ok: false, error, hora,
    contador: hallazgos ? contador(hallazgos) : { rojo: null, aviso: null, cola: null },
    cifras: cifras.map((c) => ({ tipo: c.tipo, etiqueta: c.etiqueta, n: null, ...(c.de !== undefined ? { de: c.de } : {}),
      ...(c.unidad ? { unidad: c.unidad } : {}), ...(c.decimales !== undefined ? { decimales: c.decimales } : {}) })),
    ahora: hallazgos ? grupos(m, hallazgos) : [],
    checks: checks.map(({ codigo, nombre }) => ({ nombre, codigo, n: null, comprobado: false })),
  });
}

// Conexión revocada/caducada o en error → código de E6 según last_error (ProviderErrorCode o http_NNN de §09.4).
export function errorDeConexion(status: string, lastError: string | null): ErrorEstado {
  const e = (lastError ?? '').toLowerCase();
  if (status === 'revoked' || status === 'expired' || e === 'unauthorized' || e === 'http_401') return 'token_invalido';
  if (e === 'rate_limited' || e === 'http_429') return 'limite_api';
  if (e === 'unavailable' || e === 'timeout' || /^http_5\d\d$/.test(e)) return 'sin_conexion';
  return 'sin_permiso';   // forbidden, not_found, excess_scope, invalid, http_403/404…
}

// Último intento (done|failed) de los pasos del módulo, con las miradas de ESA auditoría (null = corrida vieja sin miradas).
type Scan = { steps: unknown; coverage: unknown; finished_at: string | null };
export function ultimoPaso(scans: Scan[], nombres: ScanStep['name'][], modulo: Proveedor):
  { status: 'done' | 'failed'; miradas: Miradas | null } | null {
  for (const s of scans) {
    const steps = (Array.isArray(s.steps) ? s.steps : []) as ScanStep[];
    const p = steps.find((x) => nombres.includes(x.name) && (x.status === 'done' || x.status === 'failed'));
    if (p) return { status: p.status as 'done' | 'failed', miradas: obj(obj(obj(obj(s.coverage)?.detail)?.[modulo])?.miradas) };
  }
  return null;
}

export async function estadoModulo(env: CloudflareBindings, orgId: string, m: Module): Promise<EstadoModulo> {
  return m === 'performance' ? estadoRendimiento(env, orgId) : estadoProveedor(env, orgId, m);
}

async function estadoProveedor(env: CloudflareBindings, orgId: string, m: Proveedor): Promise<EstadoModulo> {
  const admin = db(env);
  const ahora = new Date();
  const provs = m === 'cloudflare' ? ['cloudflare', 'ingest'] : [PROVEEDOR[m]];
  const [fs, sc, cx] = await Promise.all([
    consultaHallazgos(admin, orgId, m),
    admin.from('scan_runs').select('steps, coverage, finished_at').eq('org_id', orgId).order('created_at', { ascending: false }).limit(20),
    admin.from('connections').select('id, provider, kind, status, last_error').eq('org_id', orgId).in('provider', provs).limit(20),
  ]);
  const scans = (sc.data ?? []) as Scan[];
  const fin = scans.find((s) => s.finished_at)?.finished_at;
  const hora = fin ? iso(fin) : ahora.toISOString();
  const cifrasBase: CifraDato[] = [
    { tipo: `${m}_abiertos`, etiqueta: 'Hallazgos abiertos', n: null },
    { tipo: `${m}_criticos`, etiqueta: 'Críticos', n: null },
  ];
  if (fs.error || sc.error || cx.error) {
    log('error', 'estado.consulta_error', { modulo: m, code: fs.error?.code ?? sc.error?.code ?? cx.error?.code ?? null });
    return fallo('sin_conexion', hora, cifrasBase, CHECKS[m], m, fs.error ? null : ((fs.data ?? []) as FilaFinding[]));
  }
  const hallazgos = (fs.data ?? []) as FilaFinding[];
  const conns = (cx.data ?? []) as { id: string; provider: string; kind: string; status: string; last_error: string | null }[];
  const propias = conns.filter((c) => c.provider === PROVEEDOR[m] && c.kind === 'read');
  if (!propias.some((c) => c.status === 'active')) {
    const mala = propias[0];
    return fallo(mala ? errorDeConexion(mala.status, mala.last_error) : 'sin_conexion', hora, cifrasBase, CHECKS[m], m, hallazgos);
  }

  const paso = ultimoPaso(scans, PASO[m], m);
  const revisado = paso?.status === 'done';
  const vivo = m === 'cloudflare' ? await enVivo(admin, orgId, conns, ahora) : null;
  const checks: CheckDato[] = CHECKS[m].map(({ codigo, nombre, mira, vivo: esVivo }) => {
    if (esVivo) {
      const n = vivo?.incidentes.filter((r) => r.includes(codigo)).length ?? null;
      return { nombre, codigo, n, comprobado: n !== null };
    }
    const corrio = !!mira && revisado && (paso.miradas ? mira.every((k) => paso.miradas?.[k] === true) : true);
    return { nombre, codigo, n: corrio ? hallazgos.filter((f) => casa(codigo, f.rule_id)).length : null, comprobado: corrio };
  });
  const total = fs.count ?? hallazgos.length;
  const visto = revisado || total > 0;
  return EstadoModulo.parse({
    ok: true, hora, contador: contador(hallazgos),
    cifras: [
      { ...cifrasBase[0], n: visto ? total : null,
        rol: hallazgos.some((f) => rol(f.severity) === 'mal') ? 'mal' : total ? 'aviso' : 'bien' },
      { ...cifrasBase[1], n: visto ? hallazgos.filter((f) => f.severity === 'critical').length : null },
    ],
    ahora: grupos(m, hallazgos),
    checks,
  });
}

// Reglas en vivo (CF_ADMIN_EXPOSED, CF_PATH_SCAN, CF_UA_TOOL): solo miran si hay una conexión ingest activa que mandó
// edge_hits en las últimas 24 h. Entonces n = incidentes open/ack con esa regla. null = sin mirar.
async function enVivo(admin: SupabaseClient, orgId: string, conns: { id: string; provider: string; status: string }[], ahora: Date):
  Promise<{ incidentes: string[][] } | null> {
  const ingest = conns.filter((c) => c.provider === 'ingest' && c.status === 'active').map((c) => c.id);
  if (!ingest.length) return null;
  const [hits, inc] = await Promise.all([
    admin.from('edge_hits').select('id').eq('org_id', orgId).in('connection_id', ingest)
      .gte('ts', new Date(ahora.getTime() - VIVO_MS).toISOString()).limit(1),
    admin.from('incidents').select('rule_ids').eq('org_id', orgId).in('status', ['open', 'ack']).limit(200),
  ]);
  if (hits.error || inc.error || !(hits.data ?? []).length) return null;
  return { incidentes: ((inc.data ?? []) as { rule_ids: unknown }[]).map((i) => (Array.isArray(i.rule_ids) ? i.rule_ids.map(String) : [])) };
}

// ── Rendimiento (§10.10, §10.3): la última medición de cada estrategia de la URL medida más reciente, desde perf_runs ──
type FilaPerf = { url: string; strategy: string; run_group: string | null; version_label: string | null; lighthouse_version: string | null;
  scores: unknown; metrics: unknown; created_at: string; runtime_error: string | null };
type Medicion = { at: string; n: number; version: string | null; lh: string | null; score: number | null;
  lcp: number | null; tbt: number | null; cls: number | null; ttfb: number | null };
const DIA_MS = 86_400_000;
const UMBRAL = { lcp: [2500, 4000], tbt: [200, 600], cls: [0.1, 0.25], ttfb: [800, 1800] } as const;   // móvil, §10.3
const CHECKS_PERF = [
  { codigo: 'PF_LCP', nombre: 'LCP móvil bajo 2,5 s' }, { codigo: 'PF_TBT', nombre: 'TBT móvil bajo 200 ms' },
  { codigo: 'PF_CLS', nombre: 'CLS móvil bajo 0,1' }, { codigo: 'PF_FRESH', nombre: 'Medición de hace ≤ 7 días' },
];
const CIFRAS_PERF: CifraDato[] = [
  { tipo: 'perf_score_mobile', etiqueta: 'Puntaje móvil', n: null, de: 100 },
  { tipo: 'perf_score_desktop', etiqueta: 'Puntaje escritorio', n: null, de: 100 },
  { tipo: 'lcp_mobile', etiqueta: 'LCP móvil', n: null, unidad: 'ms' },
  { tipo: 'tbt_mobile', etiqueta: 'TBT móvil', n: null, unidad: 'ms' },
  { tipo: 'cls_mobile', etiqueta: 'CLS móvil', n: null, decimales: 2 },
  { tipo: 'ttfb_mobile', etiqueta: 'TTFB móvil', n: null, unidad: 'ms' },
];
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
// El FRONT pinta las horas en America/Caracas (UTC−4 fijo, §14.6).
const horaCaracas = (t: string) => { const d = new Date(Date.parse(t) - 4 * 3_600_000); return `${DIAS[d.getUTCDay()]} ${d.toISOString().slice(11, 16)}`; };

export function mediana(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k]! : (s[k - 1]! + s[k]!) / 2;
}

// Mediana de las repeticiones válidas del run_group de la fila más nueva de esa estrategia (= un punto de perf_points).
export function medicion(filas: FilaPerf[], strategy: 'mobile' | 'desktop'): Medicion | null {
  const ultima = filas.find((f) => f.strategy === strategy);
  if (!ultima) return null;
  const grupo = ultima.run_group ? filas.filter((f) => f.strategy === strategy && f.run_group === ultima.run_group) : [ultima];
  const med = (de: (f: FilaPerf) => unknown) => mediana(grupo.map((f) => num(de(f))).filter((x): x is number => x !== null));
  const m = (f: FilaPerf, k: string) => obj(f.metrics)?.[k];
  const p = med((f) => obj(f.scores)?.performance);
  const ms = (x: number | null) => (x === null ? null : Math.round(x));
  const cls = med((f) => m(f, 'cls'));
  return { at: grupo.reduce((a, f) => (f.created_at < a ? f.created_at : a), ultima.created_at), n: grupo.length,
    version: ultima.version_label, lh: ultima.lighthouse_version,
    score: p === null ? null : Math.max(0, Math.min(100, Math.round(p <= 1 ? p * 100 : p))),
    lcp: ms(med((f) => m(f, 'lcp_ms'))), tbt: ms(med((f) => m(f, 'tbt_ms'))),
    cls: cls === null ? null : Math.round(cls * 1000) / 1000, ttfb: ms(med((f) => m(f, 'ttfb_ms'))) };
}

const rolPuntaje = (n: number): RolDato => (n >= 90 ? 'bien' : n >= 50 ? 'aviso' : 'mal');
const rolMetrica = (v: number, [bueno, malo]: readonly [number, number]): RolDato => (v <= bueno ? 'bien' : v <= malo ? 'aviso' : 'mal');

async function estadoRendimiento(env: CloudflareBindings, orgId: string): Promise<EstadoModulo> {
  const admin = db(env);
  const ahora = new Date();
  const [fs, pr, cn] = await Promise.all([
    consultaHallazgos(admin, orgId, 'performance'),
    admin.from('perf_runs').select('url, strategy, run_group, version_label, lighthouse_version, scores, metrics, created_at, runtime_error')
      .eq('org_id', orgId).order('created_at', { ascending: false }).limit(30),
    admin.from('connections').select('label').eq('org_id', orgId).eq('provider', 'ingest').eq('status', 'active'),
  ]);
  if (fs.error || pr.error) {
    log('error', 'estado.consulta_error', { modulo: 'performance', code: fs.error?.code ?? pr.error?.code ?? null });
    return fallo('sin_conexion', ahora.toISOString(), CIFRAS_PERF, CHECKS_PERF, 'performance', fs.error ? null : ((fs.data ?? []) as FilaFinding[]));
  }
  const hallazgos = (fs.data ?? []) as FilaFinding[];
  // Las filas con runtime_error no entran en medianas (§10.3); una sola URL: la de la app que vigila la org (host = label
  // de su conexión ingest, p. ej. demo.officialvanguard.com) y, si no se midió, la medida más reciente. Así medir otra
  // URL después no cambia la pantalla. Sin la consulta de conexiones, la más reciente.
  const validas = ((pr.data ?? []) as FilaPerf[]).filter((f) => !f.runtime_error);
  const hostsIngest = new Set(((cn.error ? [] : cn.data ?? []) as { label: string }[]).map((c) => String(c.label).toLowerCase()));
  const hostDe = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
  const url = validas.find((f) => hostsIngest.has(hostDe(f.url)))?.url ?? validas[0]?.url;
  const filas = validas.filter((f) => f.url === url);
  const movil = medicion(filas, 'mobile');
  const escritorio = medicion(filas, 'desktop');
  const ultima = [movil?.at, escritorio?.at].filter((x): x is string => !!x).sort().at(-1) ?? null;

  const sub = (x: Medicion, conLh: boolean) => [x.version, horaCaracas(x.at), x.n >= 3 ? `mediana de ${x.n}` : 'indicativo',
    conLh && x.lh ? `Lighthouse ${x.lh}` : null].filter(Boolean).join(' · ');
  const puntaje = (base: CifraDato, x: Medicion | null, conLh: boolean): CifraDato =>
    x?.score == null ? base : { ...base, n: x.score, rol: rolPuntaje(x.score), sub: sub(x, conLh) };
  const metrica = (base: CifraDato, v: number | null | undefined, u: readonly [number, number]): CifraDato =>
    v == null ? base : { ...base, n: v, rol: rolMetrica(v, u) };
  const [cScoreM, cScoreD, cLcp, cTbt, cCls, cTtfb] = CIFRAS_PERF as [CifraDato, CifraDato, CifraDato, CifraDato, CifraDato, CifraDato];

  // n: 0 si cumple y 1 si no, de:1; sin dato → sin mirar.
  const check = (i: number, v: number | null | undefined, limite: number): CheckDato => {
    const { codigo, nombre } = CHECKS_PERF[i]!;
    return v == null ? { nombre, codigo, n: null, comprobado: false } : { nombre, codigo, n: v <= limite ? 0 : 1, de: 1, comprobado: true };
  };
  const edad = ultima ? ahora.getTime() - Date.parse(ultima) : null;
  return EstadoModulo.parse({
    ok: true, hora: ultima ? iso(ultima) : ahora.toISOString(), contador: contador(hallazgos),
    cifras: [
      puntaje(cScoreM, movil, true), puntaje(cScoreD, escritorio, false),
      metrica(cLcp, movil?.lcp, UMBRAL.lcp), metrica(cTbt, movil?.tbt, UMBRAL.tbt),
      metrica(cCls, movil?.cls, UMBRAL.cls), metrica(cTtfb, movil?.ttfb, UMBRAL.ttfb),
    ],
    ahora: grupos('performance', hallazgos),
    checks: [check(0, movil?.lcp, UMBRAL.lcp[0]), check(1, movil?.tbt, UMBRAL.tbt[0]), check(2, movil?.cls, UMBRAL.cls[0]),
      check(3, edad, 7 * DIA_MS)],
  });
}
