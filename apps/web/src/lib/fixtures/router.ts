// Enrutador falso del modo fixtures (S14 §14.19). Único archivo que conoce los fixtures; solo se carga con
// import dinámico desde api.ts, así que no entra en el bundle de producción. Cero peticiones de red.
import { fixtures as fx, type Me, type Org } from '@vanguard/contracts';
import { ApiError } from '../errores';
import { tipoSesionFalsa } from '../supabase-doble';

type H = (m: RegExpMatchArray, body: unknown, q: URLSearchParams) => unknown;
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const falla = (s: number, c: string, m: string, d?: Record<string, unknown>): never => { throw new ApiError(s, c, m, undefined, d); };

const ORG_DEMO = fx.me.orgs[0]!.id;

// ?escenario=vacio prueba onboarding y estados vacíos; se recuerda en la pestaña para no perderlo al navegar.
function escenario(): 'lleno' | 'vacio' {
  try {
    const q = new URLSearchParams(location.search).get('escenario');
    if (q) sessionStorage.setItem('vg-fx-escenario', q);
    return sessionStorage.getItem('vg-fx-escenario') === 'vacio' ? 'vacio' : 'lleno';
  } catch { return 'lleno'; }
}

// Estado en memoria de la pestaña: organizaciones creadas con /start.
const orgsNuevas: Org[] = [];
const esDemo = (org: string) => org === ORG_DEMO;
const vacia = (org: string) => escenario() === 'vacio' || !esDemo(org);

function me(): Me {
  const base = tipoSesionFalsa() === 'anonima' ? fx.meViewer : fx.me;
  return { ...base, orgs: [...base.orgs, ...orgsNuevas.map((o) => ({ id: o.id, name: o.name, role: 'owner' as const, is_demo: false }))] };
}

function crearOrg(body: unknown): Org {
  if (tipoSesionFalsa() === 'anonima') falla(403, 'forbidden', 'Crea una cuenta con correo para conectar tus servicios');
  const name = String((body as { name?: unknown } | null)?.name ?? '').trim();
  if (name.length < 2 || name.length > 80) falla(422, 'invalid_body', 'El nombre debe tener entre 2 y 80 caracteres', { field_errors: { name: ['2 a 80 caracteres'] } });
  if (orgsNuevas.length >= 3) falla(409, 'conflict', 'Ya eres dueño de 3 organizaciones');
  const org: Org = {
    id: crypto.randomUUID(), name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    is_demo: false, created_at: new Date().toISOString(),
  };
  orgsNuevas.push(org);
  return org;
}

const ORG = '\\/api\\/orgs\\/([^/]+)';
const r = (s: string) => new RegExp(`^${s}$`);
const rutas: [string, RegExp, H][] = [
  ['GET',  r('\\/api\\/me'),                      () => me()],
  ['POST', r('\\/api\\/demo\\/join'),             () => ({ org_id: ORG_DEMO })],
  ['POST', r('\\/api\\/orgs'),                    (_m, b) => crearOrg(b)],
  ['GET',  r(`${ORG}\\/overview`),                (m) => vacia(m[1]!) ? fx.overviewVacio : fx.overview],
  ['GET',  r(`${ORG}\\/modules\\/(\\w+)\\/state`), (m) => fx.moduleState[m[2] as keyof typeof fx.moduleState] ?? falla(404, 'not_found', 'Módulo desconocido')],
  ['GET',  r(`${ORG}\\/connections`),             (m) => vacia(m[1]!) ? [] : fx.connections],
  ['GET',  r(`${ORG}\\/findings`),                (m) => vacia(m[1]!) ? [] : fx.findings],
  ['GET',  r(`${ORG}\\/incidents`),               (m) => vacia(m[1]!) ? [] : fx.incidents],
  ['GET',  r(`${ORG}\\/incidents\\/([^/]+)`),     () => fx.incidentDetail],
  ['GET',  r(`${ORG}\\/traffic`),                 () => fx.traffic],
  ['GET',  r(`${ORG}\\/scans\\/([^/]+)`),         () => fx.scanDone],
  ['GET',  r(`${ORG}\\/contacts`),                () => fx.contacts],
  ['GET',  r(`${ORG}\\/ai\\/usage`),              () => fx.aiUsage],
  ['GET',  r(`${ORG}\\/perf\\/runs`),             () => fx.perfRuns],
  ['GET',  r(`${ORG}\\/mcp-tokens`),              () => fx.mcpTokens],
  // Rutas que el FRONT pide con {crudo:true} devuelven un Response de verdad.
  ['GET',  r(`${ORG}\\/export`),                  () => new Response(fx.exportMd, {
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="vanguard-demo-20261024.md"' } })],
];

export async function fixtureFetch<T>(ruta: string, o: { method?: string; body?: unknown }): Promise<T> {
  await espera(250);
  const [camino = '', consulta = ''] = ruta.split('?');
  const q = new URLSearchParams(consulta);
  for (const [met, re, h] of rutas) {
    const m = camino.match(re);
    if (m && met === (o.method ?? 'GET')) return h(m, o.body, q) as T;
  }
  throw new ApiError(404, 'not_found', `Sin fixture para ${o.method ?? 'GET'} ${camino}`);
}
