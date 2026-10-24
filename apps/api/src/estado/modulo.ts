import { EstadoModulo, type CheckDato, type FilaDato, type GrupoDato, type Module, type RolDato, type ScanStep } from '@vanguard/contracts';
import { db } from '../lib/db.ts';
import { iso } from '../lib/iso.ts';
import { ultimoIntento } from '../scans/cobertura.ts';

// E6 · EstadoModulo (R08 §6, nombres en español a propósito). El BACK decide grupos, roles y verbos; rol 'mal' solo si
// hay acción posible; un chequeo que no corrió va con comprobado:false y n:null (nunca verde sin mirar).
type FilaFinding = { id: string; rule_id: string; severity: string; title: string; resource: string; confirmed: boolean;
  evidence: Record<string, unknown> | null };

// Chequeos P0 por módulo: código de regla (o prefijo con *) → nombre y paso que lo mira.
const CHECKS: Record<Module, { codigo: string; nombre: string }[]> = {
  supabase: [
    { codigo: 'SB_RLS_DISABLED', nombre: 'Tablas sin RLS' },
    { codigo: 'SB_POLICY_ALLOW_ALL', nombre: 'Políticas pase-todo' },
    { codigo: 'SB_RPC_ANON_NO_LIMIT', nombre: 'Funciones abiertas a anon' },
    { codigo: 'SB_ADVISOR_*', nombre: 'Advisors de Supabase' },
    { codigo: 'SB_CPU_HIGH', nombre: 'Uso de CPU' },
  ],
  cloudflare: [
    { codigo: 'CF_ZONE_01', nombre: 'Zona activa con proxy' },
    { codigo: 'CF_ADMIN_EXPOSED', nombre: 'Rutas de admin abiertas' },
    { codigo: 'CF_PATH_SCAN', nombre: 'Escaneo de rutas' },
    { codigo: 'CF_UA_TOOL', nombre: 'Herramientas de ataque' },
  ],
  codebase: [
    { codigo: 'CB_ENV_COMMITTED', nombre: '.env subido al repo' },
    { codigo: 'CB_GITIGNORE_NO_ENV', nombre: '.gitignore sin .env' },
    { codigo: 'CB_SECRET_*', nombre: 'Secretos en el código' },
    { codigo: 'CB_DEP_VULN', nombre: 'Dependencias con avisos' },
  ],
  performance: [{ codigo: 'PF_REGRESSION', nombre: 'Regresión de rendimiento' }],
};
const PASO: Record<Module, ScanStep['name'][]> = { supabase: ['supabase'], cloudflare: ['cloudflare'], codebase: ['repo', 'zip'], performance: ['psi'] };
// Chequeos que en P0 todavía no corren (P0 tardío / P1): nunca se pintan como revisados.
const SIN_CORRER = new Set(['SB_CPU_HIGH', 'PF_REGRESSION']);
const EN_VIVO = new Set(['CF_ADMIN_EXPOSED', 'CF_PATH_SCAN', 'CF_UA_TOOL']);
const PROVEEDOR: Record<Module, string> = { supabase: 'supabase', cloudflare: 'cloudflare', codebase: 'github', performance: '' };

const casa = (codigo: string, rule: string) => (codigo.endsWith('*') ? rule.startsWith(codigo.slice(0, -1)) : rule === codigo);
const rol = (s: string): RolDato => (s === 'critical' || s === 'high' ? 'mal' : s === 'medium' ? 'aviso' : 'cola');
const ORDEN: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

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

export async function estadoModulo(env: CloudflareBindings, orgId: string, m: Module): Promise<EstadoModulo> {
  const admin = db(env);
  const ahora = new Date().toISOString();
  const [{ data: fs }, { data: scans }, { count: conexiones }] = await Promise.all([
    admin.from('findings').select('id, rule_id, severity, title, resource, confirmed, evidence').eq('org_id', orgId)
      .eq('module', m).eq('status', 'open').order('severity_rank', { ascending: false }).limit(200),
    admin.from('scan_runs').select('steps, finished_at').eq('org_id', orgId).order('created_at', { ascending: false }).limit(20),
    m === 'performance' ? Promise.resolve({ count: 1 })
      : admin.from('connections').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('provider', PROVEEDOR[m]).eq('status', 'active'),
  ]);
  const hallazgos = (fs ?? []) as FilaFinding[];
  const lista = ((scans ?? []) as { steps: ScanStep[] | null }[]).map((s) => ({ steps: Array.isArray(s.steps) ? s.steps : [] }));
  const revisado = ultimoIntento(lista, PASO[m]) === 'done';

  const porRegla = new Map<string, FilaFinding[]>();
  for (const f of hallazgos) porRegla.set(f.rule_id, [...(porRegla.get(f.rule_id) ?? []), f]);
  const grupos: GrupoDato[] = [...porRegla.entries()]
    .map(([regla, xs]) => {
      const peor = xs.reduce((a, b) => (ORDEN[b.severity]! > ORDEN[a.severity]! ? b : a));
      return { grupo: regla, etiqueta: peor.title.slice(0, 60), rol: rol(peor.severity), n: xs.length, orden: ORDEN[peor.severity],
        filas: xs.slice(0, 20).map((f) => fila(m, f)) };
    })
    .sort((a, b) => (b.orden ?? 0) - (a.orden ?? 0));

  const checks: CheckDato[] = CHECKS[m].map(({ codigo, nombre }) => {
    const corrio = !SIN_CORRER.has(codigo) && (EN_VIVO.has(codigo) ? (conexiones ?? 0) > 0 : revisado);
    return { nombre, codigo, n: corrio ? hallazgos.filter((f) => casa(codigo, f.rule_id)).length : null, comprobado: corrio };
  });
  const cuenta = (r: RolDato) => hallazgos.filter((f) => rol(f.severity) === r).length;
  const sinConexion = m !== 'performance' && (conexiones ?? 0) === 0;
  const fin = (scans as { finished_at: string | null }[] | null)?.find((s) => s.finished_at)?.finished_at;
  return EstadoModulo.parse({
    ok: !sinConexion,
    ...(sinConexion ? { error: 'sin_conexion' } : {}),
    hora: fin ? iso(fin) : ahora,
    contador: { rojo: cuenta('mal'), aviso: cuenta('aviso'), cola: cuenta('cola') },
    cifras: [
      { tipo: `${m}_abiertos`, etiqueta: 'Hallazgos abiertos', n: revisado || hallazgos.length ? hallazgos.length : null,
        rol: hallazgos.some((f) => rol(f.severity) === 'mal') ? 'mal' : hallazgos.length ? 'aviso' : 'bien' },
      { tipo: `${m}_criticos`, etiqueta: 'Críticos', n: revisado || hallazgos.length ? hallazgos.filter((f) => f.severity === 'critical').length : null },
    ],
    ahora: grupos,
    checks,
  });
}
