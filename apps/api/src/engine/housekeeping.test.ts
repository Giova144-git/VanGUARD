import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ApiError } from '../lib/errors.ts';
import { envDoble } from '../test/dobles.ts';

// Doble propio: el UPDATE de respaldo y la caducidad usan lt/overlaps, que el doble común (test/db-doble.ts) no trae.
// wiki_runs y scan_runs son tablas en memoria: el UPDATE de respaldo del vigilante se evalúa (in, lt, or, order, limit)
// sobre las filas que haya en ese momento, como haría Postgres.
type Llamada = { tabla?: string; rpc?: string; args?: unknown; metodos: [string, ...unknown[]][] };
type R = { data?: unknown; error?: { code?: string } | null };
type FilaMem = Record<string, unknown> & { id: string };
const estado = vi.hoisted(() => ({
  client: null as unknown,
  llamadas: [] as { tabla?: string; rpc?: string; args?: unknown; metodos: [string, ...unknown[]][] }[],
  rpc: (_n: string, _a: unknown): { data?: unknown; error?: { code?: string } | null } => ({ data: [] }),
  vigilante: (_a: unknown): { data?: unknown; error?: { code?: string } | null } => ({ data: [] }),
  update: (): { data?: unknown; error?: { code?: string } | null } => ({ data: [] }),
  vencidas: (): { data?: unknown; error?: { code?: string } | null } => ({ data: [] }),
  huerfanas: (): { data?: unknown; error?: { code?: string } | null } => ({ data: [] }),
  actualizar: (_l?: { metodos: [string, ...unknown[]][] }): { data?: unknown; error?: { code?: string } | null } =>
    ({ data: null }),
  tablas: {} as Record<string, (Record<string, unknown> & { id: string })[]>,
  errorTabla: null as { code?: string } | null,
  antesDeUpdate: null as (() => void) | null,
}));
vi.mock('../lib/db.ts', () => ({ db: () => { if (!estado.client) throw new Error('sin base'); return estado.client; } }));
const cred = vi.hoisted(() => ({ withSecret: vi.fn() }));
vi.mock('../lib/credentials.ts', () => ({ withSecret: cred.withSecret }));

const { CANDIDATOS_CADUCIDAD, ERROR_SCAN_INTERRUMPIDA, ERROR_WIKI_INTERRUMPIDA, housekeeping, LIMITE_CIERRE, LIMITE_VIGILANTE,
  MAX_REINTENTOS, VIGILANTE_SCAN_MS, VIGILANTE_WIKI_MS } = await import('./housekeeping.ts');
const { CRON_MINUTO, onCron } = await import('../cron.ts');
const { MAX_BARRIDO } = await import('../actions/under-attack.ts');
const { SIN_AVANCE_MS } = await import('../wiki/corridas.ts');

// Filtros que usa el respaldo del vigilante, evaluados sobre una fila: in, lt (fechas) y el or de started_at.
function pasaFiltros(f: FilaMem, metodos: [string, ...unknown[]][]): boolean {
  const antes = (v: unknown, corte: string) => typeof v === 'string' && Date.parse(v) < Date.parse(corte);
  return metodos.every(([m, ...a]) => {
    if (m === 'in') return (a[1] as unknown[]).includes(f[String(a[0])]);
    if (m === 'lt') return antes(f[String(a[0])], String(a[1]));
    if (m !== 'or') return true;
    return String(a[0]).split(',').some((c) => {
      const [col = '', op, ...resto] = c.split('.');
      const valor = resto.join('.');
      if (op === 'is' && valor === 'null') return f[col] === null || f[col] === undefined;
      if (op === 'lt' && /^".*"$/.test(valor)) return antes(f[col], valor.slice(1, -1));
      throw new Error('filtro or no soportado por el doble: ' + c);
    });
  });
}

function updateEnMemoria(tabla: string, l: Llamada): R {
  estado.antesDeUpdate?.();
  if (estado.errorTabla) return { error: estado.errorTabla };
  const cambio = l.metodos.find(([m]) => m === 'update')![1] as Record<string, unknown>;
  const orden = l.metodos.find(([m]) => m === 'order')?.[1];
  const limite = Number(l.metodos.find(([m]) => m === 'limit')?.[1] ?? Infinity);
  const elegidas = (estado.tablas[tabla] ?? []).filter((f) => pasaFiltros(f, l.metodos))
    .sort((a, b) => (orden === 'id' ? a.id.localeCompare(b.id) : 0)).slice(0, limite);
  for (const f of elegidas) Object.assign(f, cambio);
  return { data: elegidas.map((f) => ({ id: f.id, org_id: f.org_id })) };
}

function cliente() {
  return {
    async rpc(name: string, args: unknown) {
      estado.llamadas.push({ rpc: name, args, metodos: [] });
      const r = name === 'vg_vigilar_corridas' ? estado.vigilante(args) : estado.rpc(name, args);
      return { data: r.data ?? null, error: r.error ?? null };
    },
    from(tabla: string) {
      const l: Llamada = { tabla, metodos: [] };
      estado.llamadas.push(l);
      const b: Record<string, unknown> = {};
      for (const m of ['update', 'in', 'lt', 'or', 'overlaps', 'select', 'eq', 'order', 'limit']) {
        b[m] = (...a: unknown[]) => { l.metodos.push([m, ...a]); return b; };
      }
      b.then = (ok: (r: unknown) => unknown) => {
        const esUpdate = l.metodos.some(([m]) => m === 'update');
        // La lectura de la propuesta huérfana del modo bajo ataque es la única con status 'proposed'.
        const esHuerfana = l.metodos.some(([m, c, v]) => m === 'eq' && c === 'status' && v === 'proposed');
        const r: R = tabla === 'wiki_runs' || tabla === 'scan_runs' ? updateEnMemoria(tabla, l)
          : tabla === 'actions' ? (esUpdate ? estado.actualizar(l) : esHuerfana ? estado.huerfanas() : estado.vencidas())
          : estado.update();
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(ok);
      };
      return b;
    },
  };
}

const AHORA = new Date('2026-10-24T19:30:00.000Z');
const PROD = { VG_ENV: 'production' as const };
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const CONN = 'c0aa0000-0000-4000-8000-000000000002';
const ZONA = '023e105f4ecef8ad9ca31a8372d0c353';
const TOKEN = ['tok', 'acciones', 'x'.repeat(20)].join('-');
const REGLAS = `https://api.cloudflare.com/client/v4/zones/${ZONA}/firewall/access_rules/rules`;
const SIN_BLOQUEOS = { deshechos: 0, fallidos: 0 };
const VIGILANTE_QUIETO = { vigilante: 'rpc', interrumpidas: { wiki: 0, scans: 0 } };
const VIGILAR = { rpc: 'vg_vigilar_corridas', args: { p_wiki_seconds: 600, p_scan_seconds: 900, p_limit: LIMITE_VIGILANTE }, metodos: [] };
let logs: MockInstance<typeof console.log>;
let fetchMock: ReturnType<typeof vi.fn>;

const vencida = (id: string, o: Record<string, unknown> = {}) => ({ id, org_id: ORG, provider_ref: `${id}0000000000000000000000000000`.slice(0, 32),
  previous: { connection_id: CONN, zone_id: ZONA, existed: false }, ...o });

beforeEach(() => {
  estado.llamadas = [];
  estado.client = cliente();
  estado.rpc = () => ({ data: [{ id: 'i1', org_id: 'o1' }, { id: 'i2', org_id: 'o2' }] });
  estado.vigilante = () => ({ data: [] });
  estado.tablas = {};
  estado.errorTabla = null;
  estado.antesDeUpdate = null;
  estado.update = () => ({ data: [{ id: 'i3' }] });
  estado.vencidas = () => ({ data: [] });
  estado.huerfanas = () => ({ data: [] });
  estado.actualizar = () => ({ data: null });
  cred.withSecret.mockReset().mockImplementation(async (_e: unknown, _a: unknown, _c: unknown, fn: (t: string) => Promise<unknown>) => fn(TOKEN));
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('housekeeping · cierre automático (§12.3)', () => {
  it('una sola RPC acotada: 15 min sin peticiones de la IP, tope de candidatos; cuenta los resueltos', async () => {
    const r = await housekeeping(envDoble().env, AHORA);
    expect(estado.llamadas).toEqual([{ rpc: 'vg_resolve_idle_incidents', args: { p_idle_seconds: 900, p_limit: LIMITE_CIERRE }, metodos: [] },
      VIGILAR]);
    expect(r).toEqual({ resueltos: 2, subpeticiones: 2, modo: 'rpc', error: null, ...SIN_BLOQUEOS, ...VIGILANTE_QUIETO });
  });

  it('sin la 0009 aplicada (PGRST202): un solo UPDATE de respaldo por last_event_at, solo CF_ y no resueltos', async () => {
    estado.rpc = () => ({ error: { code: 'PGRST202' } });
    const r = await housekeeping(envDoble().env, AHORA);
    expect(r).toEqual({ resueltos: 1, subpeticiones: 3, modo: 'respaldo', error: null, ...SIN_BLOQUEOS, ...VIGILANTE_QUIETO });
    const u = estado.llamadas[1]!;
    expect(u.tabla).toBe('incidents');
    expect(u.metodos).toEqual([
      ['update', { status: 'resolved', resolved_at: AHORA.toISOString() }],
      ['in', 'status', ['open', 'ack', 'mitigated']],
      ['lt', 'last_event_at', '2026-10-24T19:15:00.000Z'],
      ['overlaps', 'rule_ids', ['CF_UA_TOOL', 'CF_PATH_SCAN', 'CF_ADMIN_EXPOSED', 'CF_IP_FLOOD']],
      ['select', 'id'],
    ]);
  });

  it('nunca lanza: error de la RPC, del respaldo o sin base configurada → código corto en el resumen', async () => {
    estado.rpc = () => ({ error: { code: '57014' } });
    expect(await housekeeping(envDoble().env, AHORA)).toEqual({ resueltos: 0, subpeticiones: 2, modo: 'rpc', error: '57014',
      ...SIN_BLOQUEOS, ...VIGILANTE_QUIETO });
    expect(estado.llamadas.filter((l) => l.tabla === 'incidents')).toHaveLength(0);   // otro error no cae al respaldo

    estado.rpc = () => ({ error: { code: '42883' } });
    estado.update = () => ({ error: { code: '42501' } });
    expect(await housekeeping(envDoble().env, AHORA)).toEqual({ resueltos: 0, subpeticiones: 3, modo: 'respaldo', error: '42501',
      ...SIN_BLOQUEOS, ...VIGILANTE_QUIETO });

    estado.client = null;
    const r = await housekeeping(envDoble().env, AHORA);
    expect(r).toMatchObject({ resueltos: 0, subpeticiones: 0, modo: null, vigilante: null, interrumpidas: { wiki: 0, scans: 0 } });
    expect(typeof r.error).toBe('string');
  });
});

describe('housekeeping · caducidad de «Bloquear IP» (§08.8)', () => {
  const llamadaActions = () => estado.llamadas.filter((l) => l.tabla === 'actions');

  const updates = () => llamadaActions().filter((l) => l.metodos.some(([m]) => m === 'update'));
  const PREV = { connection_id: CONN, zone_id: ZONA, existed: false };
  const minutos = (n: number) => new Date(AHORA.getTime() + n * 60_000).toISOString();

  it('deshace las executed vencidas (≤ 5, las más viejas primero): DELETE con el token action, 404 = ya no estaba, existed sin Cloudflare', async () => {
    estado.vencidas = () => ({ data: [vencida('a1'), vencida('a2'),
      vencida('a3', { provider_ref: null, previous: { connection_id: CONN, zone_id: ZONA, existed: true } })] });
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 200 }))
      .mockImplementationOnce(async () => new Response('{}', { status: 404 }));
    const r = await housekeeping(envDoble(PROD).env, AHORA);
    expect(r).toMatchObject({ resueltos: 2, error: null, deshechos: 3, fallidos: 0 });
    // rpc · vigilante · select · sobre (2) · 2 DELETE · undone por id y por regla · lectura de la huérfana (gastó ≤ 15)
    expect(r.subpeticiones).toBe(1 + 1 + 1 + 2 + 2 + 2 + 1);

    const [sel, up, porRegla] = llamadaActions();
    expect(sel!.metodos).toEqual([
      ['select', 'id, org_id, kind, target, provider_ref, previous'], ['eq', 'status', 'executed'], ['in', 'kind', ['block_ip', 'under_attack_on']],
      ['lt', 'expires_at', AHORA.toISOString()], ['order', 'expires_at'], ['limit', CANDIDATOS_CADUCIDAD],
    ]);
    expect(fetchMock.mock.calls.map((c) => [String(c[0]), (c[1] as RequestInit).method])).toEqual([
      [`${REGLAS}/${vencida('a1').provider_ref}`, 'DELETE'], [`${REGLAS}/${vencida('a2').provider_ref}`, 'DELETE']]);
    expect(cred.withSecret).toHaveBeenCalledTimes(1);
    expect(up!.metodos).toEqual([['update', { status: 'undone', undone_at: AHORA.toISOString() }],
      ['in', 'id', ['a1', 'a2', 'a3']], ['in', 'org_id', [ORG]], ['in', 'status', ['executed', 'failed']]]);
    expect(porRegla!.metodos[1]).toEqual(['in', 'provider_ref', [vencida('a1').provider_ref, vencida('a2').provider_ref]]);
  });

  it('fallo permanente (403, sin credencial) → failed con previous.deshacer_error; 5xx → sigue executed con intento y espera', async () => {
    estado.vencidas = () => ({ data: [vencida('a1'), vencida('a2')] });
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 403 }))
      .mockImplementationOnce(async () => new Response('{}', { status: 503 }));
    const r = await housekeeping(envDoble(PROD).env, AHORA);
    expect(r).toMatchObject({ deshechos: 0, fallidos: 1, error: null });
    // rpc · vigilante · select · sobre · 2 DELETE · una escritura por fila · lectura de la huérfana
    expect(r.subpeticiones).toBe(1 + 1 + 1 + 2 + 2 + 2 + 1);
    expect(updates().map((u) => u.metodos)).toEqual([
      [['update', { status: 'failed', previous: { ...PREV, intentos: 1, deshacer_error: 'sin_permiso' } }],
        ['eq', 'id', 'a1'], ['eq', 'org_id', ORG], ['eq', 'status', 'executed']],
      [['update', { previous: { ...PREV, intentos: 1, reintento_en: minutos(1) } }],
        ['eq', 'id', 'a2'], ['eq', 'org_id', ORG], ['eq', 'status', 'executed']],
    ]);
    expect(logs.mock.calls.map((a) => String(a[0])).join('\n')).toContain('"bloqueo.caducidad_fallida"');

    cred.withSecret.mockImplementation(async () => { throw new ApiError('not_found', 'x'); });
    estado.llamadas = [];
    expect(await housekeeping(envDoble(PROD).env, AHORA)).toMatchObject({ fallidos: 2 });
  });

  it('4xx que no es 401/403/404 (zona borrada: 400) → failed al momento, no se queda atascada para el minuto siguiente', async () => {
    estado.vencidas = () => ({ data: ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => vencida(id)) });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: false, errors: [{ code: 7003 }] }), { status: 400 }));
    expect(await housekeeping(envDoble(PROD).env, AHORA)).toMatchObject({ deshechos: 0, fallidos: 5 });
    expect(updates().every((u) => (u.metodos[0]![1] as { status?: string }).status === 'failed')).toBe(true);
  });

  it('5 atascadas (5xx) esperando su reintento no tapan una sexta, de otra org, que sí se deshace', async () => {
    const OTRA = '0f6c0000-0000-4000-8000-000000000002';
    // Minuto 1: las 5 más viejas caen con 503 → executed con intentos 1 y reintento_en = +1 min.
    estado.vencidas = () => ({ data: ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => vencida(id)) });
    fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }));
    expect(await housekeeping(envDoble(PROD).env, AHORA)).toMatchObject({ deshechos: 0, fallidos: 0 });
    const esperas = updates().map((u) => (u.metodos[0]![1] as { previous: Record<string, unknown> }).previous);
    expect(esperas.map((p) => p.reintento_en)).toEqual(Array(5).fill(minutos(1)));

    // Minuto 1,5: la base las devuelve primero (más viejas) con su espera, y detrás la sexta.
    estado.llamadas = [];
    fetchMock.mockReset().mockImplementation(async () => new Response('{}', { status: 200 }));
    const enEspera = ['a1', 'a2', 'a3', 'a4', 'a5'].map((id, i) => vencida(id, { previous: esperas[i] }));
    estado.vencidas = () => ({ data: [...enEspera, vencida('a6', { org_id: OTRA })] });
    const r = await housekeeping(envDoble(PROD).env, new Date(AHORA.getTime() + 30_000));
    expect(r).toMatchObject({ deshechos: 1, fallidos: 0 });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([`${REGLAS}/${vencida('a6').provider_ref}`]);

    // Pasada la espera vuelven a probarse (tope de 5 por minuto).
    estado.llamadas = [];
    fetchMock.mockClear();
    estado.vencidas = () => ({ data: [...enEspera, vencida('a7'), vencida('a8')] });
    await housekeeping(envDoble(PROD).env, new Date(AHORA.getTime() + 2 * 60_000));
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it(`al ${MAX_REINTENTOS}.º fallo pasajero se rinde: failed con deshacer_error 'caido' (visible y reintentable con E22)`, async () => {
    estado.vencidas = () => ({ data: [vencida('a1', { previous: { ...PREV, intentos: MAX_REINTENTOS - 1, reintento_en: minutos(-1) } })] });
    fetchMock.mockImplementation(async () => new Response('{}', { status: 502 }));
    expect(await housekeeping(envDoble(PROD).env, AHORA)).toMatchObject({ fallidos: 1 });
    expect(updates()[0]!.metodos[0]).toEqual(['update', { status: 'failed',
      previous: { ...PREV, intentos: MAX_REINTENTOS, reintento_en: minutos(-1), deshacer_error: 'caido' } }]);
  });

  it('fuera de producción no se toca Cloudflare ni se leen bloqueos; un error al leerlos va al resumen sin lanzar', async () => {
    estado.vencidas = () => ({ data: [vencida('a1')] });
    await housekeeping(envDoble().env, AHORA);
    expect(llamadaActions()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();

    estado.vencidas = () => ({ error: { code: '57014' } });
    expect(await housekeeping(envDoble(PROD).env, AHORA)).toMatchObject({ resueltos: 2, error: '57014', deshechos: 0 });
  });
});

describe('housekeeping · modo bajo ataque: caducidad por tipo y propuesta huérfana (modo-bajo-ataque.md §8)', () => {
  const RS = 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6';
  const REF = 'vg_ua_' + 'a'.repeat(32);
  const CF = `https://api.cloudflare.com/client/v4/zones/${ZONA}`;
  const EP = `${CF}/rulesets/phases/http_config_settings/entrypoint`;
  const conn = (i: number) => `c0aa0000-0000-4000-8000-00000000000${i}`;
  const modo = (id: string, o: Record<string, unknown> = {}) => ({ id, org_id: ORG, kind: 'under_attack_on',
    provider_ref: `${id}${'d'.repeat(32)}`.slice(0, 32), previous: { connection_id: CONN, zone_id: ZONA, scope: 'host', ruleset_id: RS },
    ...o });
  const borrados = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit).method === 'DELETE').map((c) => String(c[0]));
  const actions = () => estado.llamadas.filter((l) => l.tabla === 'actions');
  const leeHuerfana = () => actions().some((l) => l.metodos.some(([m, c, v]) => m === 'eq' && c === 'status' && v === 'proposed'));

  it('un under_attack_on vencido se retira con DELETE de su regla de configuración (nunca access_rules) y queda undone', async () => {
    estado.vencidas = () => ({ data: [modo('u1')] });
    const r = await housekeeping(envDoble(PROD).env, AHORA);
    expect(r).toMatchObject({ deshechos: 1, fallidos: 0, error: null });
    expect(borrados()).toEqual([`${CF}/rulesets/${RS}/rules/${modo('u1').provider_ref}`]);
    const up = actions().find((l) => l.metodos.some(([m]) => m === 'update'))!;
    expect(up.metodos).toEqual([['update', { status: 'undone', undone_at: AHORA.toISOString() }], ['in', 'id', ['u1']],
      ['in', 'org_id', [ORG]], ['eq', 'kind', 'under_attack_on'], ['in', 'status', ['executed', 'failed']]]);
    expect(r.subpeticiones).toBe(1 + 1 + 1 + 2 + 1 + 1 + 1);    // rpc · vigilante · select · sobre · DELETE · undone · huérfana
  });

  it('con 3 vencidos de bajo ataque solo se procesan 2 (y los bloqueos completan hasta 5)', async () => {
    estado.vencidas = () => ({ data: [modo('u1'), modo('u2'), modo('u3'), vencida('a1'), vencida('a2'), vencida('a3'), vencida('a4')] });
    const r = await housekeeping(envDoble(PROD).env, AHORA);
    expect(r).toMatchObject({ deshechos: 5 });
    const urls = borrados();
    expect(urls.filter((u) => u.includes('/rulesets/'))).toHaveLength(2);
    expect(urls.filter((u) => u.includes('/access_rules/'))).toHaveLength(3);
    expect(urls.some((u) => u.includes(modo('u3').provider_ref))).toBe(false);
  });

  it('un fallo permanente al retirar un modo bajo ataque → failed con deshacer_error y su propia línea de error', async () => {
    estado.vencidas = () => ({ data: [modo('u1')] });
    fetchMock.mockImplementation(async () => new Response('{}', { status: 403 }));
    expect(await housekeeping(envDoble(PROD).env, AHORA)).toMatchObject({ deshechos: 0, fallidos: 1 });
    const up = actions().find((l) => l.metodos.some(([m]) => m === 'update'))!;
    expect(up.metodos[0]).toEqual(['update', { status: 'failed', previous: { ...modo('u1').previous, intentos: 1, deshacer_error: 'sin_permiso' } }]);
    expect(logs.mock.calls.map((a) => String(a[0])).join(' ')).toContain('"bajo_ataque.caducidad_fallida"');
  });

  it('propuesta huérfana de 3 min con la regla presente → DELETE por su ref y failed con huerfana retirada', async () => {
    estado.huerfanas = () => ({ data: [{ id: 'h1', org_id: ORG, expires_at: new Date(AHORA.getTime() + 27 * 60_000).toISOString(),
      previous: { connection_id: CONN, zone_id: ZONA, scope: 'host', ref: REF } }] });
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => (init.method === 'GET' && url === EP
      ? new Response(JSON.stringify({ result: { id: RS, rules: [{ id: 'e'.repeat(32), ref: REF }] } })) : new Response(null, { status: 200 })));
    const r = await housekeeping(envDoble(PROD).env, AHORA);
    expect(borrados()).toEqual([`${CF}/rulesets/${RS}/rules/${'e'.repeat(32)}`]);
    const [lectura] = actions().filter((l) => l.metodos.some(([m, c, v]) => m === 'eq' && c === 'status' && v === 'proposed'));
    expect(lectura!.metodos).toContainEqual(['lt', 'created_at', new Date(AHORA.getTime() - 120_000).toISOString()]);
    const up = actions().find((l) => l.metodos.some(([m]) => m === 'update'))!;
    expect(up.metodos).toEqual([['update', { status: 'failed', previous: { connection_id: CONN, zone_id: ZONA, scope: 'host', ref: REF,
      huerfana: 'retirada' } }], ['eq', 'id', 'h1'], ['eq', 'org_id', ORG], ['eq', 'status', 'proposed']]);
    expect(r.subpeticiones).toBe(1 + 1 + 1 + 6);                // rpc · vigilante · caducidad (lectura) · huérfana
  });

  it('si la caducidad gastó más de 15 subpeticiones no se lee la huérfana; el peor caso del minuto queda ≤ 29', async () => {
    // 5 bloqueos en 5 conexiones distintas, todos retirados: 1 + 5 × 2 + 5 + 2 = 18 > 15.
    estado.vencidas = () => ({ data: [1, 2, 3, 4, 5].map((i) => vencida(`a${i}`, { previous: { connection_id: conn(i), zone_id: ZONA, existed: false } })) });
    let r = await housekeeping(envDoble(PROD).env, AHORA);
    expect(r.subpeticiones).toBe(1 + 1 + 18);
    expect(leeHuerfana()).toBe(false);

    // Peor caso: 3 bloqueos y 2 modos, cada uno en su conexión, con fallos que suman una escritura por fila (caducidad 22).
    estado.llamadas = [];
    estado.vencidas = () => ({ data: [
      ...[1, 2, 3].map((i) => vencida(`a${i}`, { previous: { connection_id: conn(i), zone_id: ZONA, existed: false } })),
      ...[4, 5].map((i) => modo(`u${i}`, { previous: { connection_id: conn(i), zone_id: ZONA, scope: 'host', ruleset_id: RS } })),
    ] });
    let n = 0;
    fetchMock.mockImplementation(async () => new Response('{}', { status: [200, 503, 403, 200, 503][n++ % 5] }));
    r = await housekeeping(envDoble(PROD).env, AHORA);
    expect(r).toMatchObject({ deshechos: 2, error: null });
    expect(r.subpeticiones).toBe(1 + 1 + 22);
    expect(r.subpeticiones).toBeLessThanOrEqual(29);
    expect(leeHuerfana()).toBe(false);

    // Con la caducidad barata (≤ 15) sí corre la huérfana y el minuto sigue ≤ 29.
    estado.llamadas = [];
    fetchMock.mockReset().mockImplementation(async () => new Response(null, { status: 200 }));
    estado.vencidas = () => ({ data: [vencida('a1'), modo('u1')] });
    estado.huerfanas = () => ({ data: [{ id: 'h1', org_id: ORG, expires_at: AHORA.toISOString(),
      previous: { connection_id: CONN, zone_id: ZONA, scope: 'host', ref: REF } }] });
    r = await housekeeping(envDoble(PROD).env, AHORA);
    expect(leeHuerfana()).toBe(true);
    expect(r.subpeticiones).toBeLessThanOrEqual(29);
  });

  describe('fila sin confirmar de E21 y barrido de reglas de otros intentos', () => {
    const HOST = 'demo.officialvanguard.com';
    const OTRO_HOST = 'tienda.officialvanguard.com';
    const INC = '9e0b0000-0000-4000-8000-000000000001';
    const expr = (h: string) => `(http.host eq "${h}" and http.request.timestamp.sec lt 1792885320)`;
    const vieja = (i: number) => ({ id: String(i).repeat(32), ref: `vg_ua_${String(i).repeat(32)}`, expression: expr(HOST) });
    const cfCon = (reglas: Record<string, unknown>[], status: (url: string) => number = () => 200) =>
      fetchMock.mockImplementation(async (url: string, init: RequestInit) => (init.method === 'GET' && url === EP
        ? new Response(JSON.stringify({ result: { id: RS, rules: reglas } })) : new Response('{}', { status: status(url) })));

    it('una sin confirmar (previous.reconciliar) con la regla puesta → executed con provider_ref, sin DELETE; incidente mitigated', async () => {
      const prev = { connection_id: CONN, zone_id: ZONA, scope: 'host', ref: REF, reconciliar: 'cf_503', intentos: 1,
        reintento_en: new Date(AHORA.getTime() - 1000).toISOString() };
      estado.huerfanas = () => ({ data: [{ id: 'h1', org_id: ORG, incident_id: INC, previous: prev,
        expires_at: new Date(AHORA.getTime() + 27 * 60_000).toISOString() }] });
      cfCon([{ id: 'e'.repeat(32), ref: REF, expression: expr(HOST) }]);
      const r = await housekeeping(envDoble(PROD).env, AHORA);
      expect(borrados()).toEqual([]);
      const up = actions().find((l) => l.metodos.some(([m]) => m === 'update'))!;
      expect(up.metodos).toEqual([['update', { status: 'executed', provider_ref: 'e'.repeat(32), previous: { connection_id: CONN,
        zone_id: ZONA, scope: 'host', ref: REF, reconciliar: 'cf_503', ruleset_id: RS, huerfana: 'adoptada' } }], ['eq', 'id', 'h1'],
      ['eq', 'org_id', ORG], ['eq', 'status', 'proposed']]);
      expect(estado.llamadas.find((l) => l.tabla === 'incidents')!.metodos).toContainEqual(['update',
        { status: 'mitigated', mitigated_at: AHORA.toISOString() }]);
      expect(r.subpeticiones).toBe(1 + 1 + 1 + 6);              // rpc · vigilante · caducidad (lectura) · reconciliación
    });

    it('la caducidad lee target y retira también las demás reglas de VanGUARD de ese host (nunca las del cliente ni otro host)', async () => {
      estado.vencidas = () => ({ data: [modo('u1', { target: HOST })] });
      cfCon([{ id: modo('u1').provider_ref, ref: REF, expression: expr(HOST) }, vieja(7),
        { id: 'c'.repeat(32), ref: 'del_cliente', expression: expr(HOST) }, { ...vieja(8), expression: expr(OTRO_HOST) }]);
      const r = await housekeeping(envDoble(PROD).env, AHORA);
      expect(r).toMatchObject({ deshechos: 1, error: null });
      expect(actions()[0]!.metodos).toContainEqual(['select', 'id, org_id, kind, target, provider_ref, previous']);
      expect(borrados()).toEqual([`${CF}/rulesets/${RS}/rules/${modo('u1').provider_ref}`, `${CF}/rulesets/${RS}/rules/${'7'.repeat(32)}`]);
      // rpc · vigilante · lectura · sobre · GET · 2 DELETE · undone · undone del barrido · huérfana (la caducidad gastó 8 ≤ 15)
      expect(r.subpeticiones).toBe(1 + 1 + 1 + 2 + 1 + 2 + 1 + 1 + 1);
    });

    it('peor caso del minuto con barrido (3 bloqueos y 2 modos en 5 conexiones, MAX_BARRIDO reglas viejas) ≤ 40', async () => {
      estado.vencidas = () => ({ data: [
        ...[1, 2, 3].map((i) => vencida(`a${i}`, { previous: { connection_id: conn(i), zone_id: ZONA, existed: false } })),
        modo('u4', { target: HOST, previous: { connection_id: conn(4), zone_id: ZONA, scope: 'host', ruleset_id: RS } }),
        modo('u5', { target: OTRO_HOST, previous: { connection_id: conn(5), zone_id: ZONA, scope: 'host', ruleset_id: RS } }),
      ] });
      // a1 retirado, a2 pasajero, a3 permanente; u4 retirado con 3 viejas de su host; u5 pasajero (sin barrido).
      const malos: Record<string, number> = { a2: 503, a3: 403, u5: 503 };
      cfCon([{ id: modo('u4').provider_ref, expression: expr(HOST) }, { id: modo('u5').provider_ref, expression: expr(OTRO_HOST) },
        vieja(1), vieja(2), vieja(3), vieja(4)], (url) => malos[Object.keys(malos).find((k) => url.includes(`/${k}`)) ?? ''] ?? 200);
      const r = await housekeeping(envDoble(PROD).env, AHORA);
      expect(r).toMatchObject({ deshechos: 2, error: null });
      expect(borrados().filter((u) => /\/rules\/[1-4]{32}$/.test(u))).toHaveLength(MAX_BARRIDO);
      expect(leeHuerfana()).toBe(false);
      expect(r.subpeticiones).toBe(1 + 1 + 1 + 11 + 13 + 3);   // rpc · vigilante · lectura · bloqueos · modos · 3 no retiradas
      expect(r.subpeticiones).toBeLessThanOrEqual(40);
    });

    it('si deshacerBajoAtaque lanza con filas que barren, su tope cuenta el GET y MAX_BARRIDO', async () => {
      estado.vencidas = () => ({ data: [modo('u1', { target: HOST })] });
      estado.actualizar = (l) => (l?.metodos.some(([m, c, v]) => m === 'eq' && c === 'kind' && v === 'under_attack_on')
        ? { error: { code: '57014' } } : { data: null });
      cfCon([{ id: modo('u1').provider_ref, ref: REF, expression: expr(HOST) }]);
      const r = await housekeeping(envDoble(PROD).env, AHORA);
      expect(r.error).toBe('internal');
      // rpc · vigilante · lectura · tope (sobre 2 + DELETE 1 + GET 1 + MAX_BARRIDO + 2 escrituras) · huérfana (10 ≤ 15).
      expect(r.subpeticiones).toBe(1 + 1 + 1 + 2 + 1 + 1 + MAX_BARRIDO + 2 + 1);
    });
  });

  it('si una función de deshacer lanza (falla su undone), lo que ya gastó cuenta y no se lee la huérfana', async () => {
    // 3 bloqueos y 2 modos, cada uno en su conexión, todos retirados: caducidad real 1 + (3 × 2 + 3 + 2) + (2 × 2 + 2 + 1)
    // = 19 > 15.
    estado.vencidas = () => ({ data: [
      ...[1, 2, 3].map((i) => vencida(`a${i}`, { previous: { connection_id: conn(i), zone_id: ZONA, existed: false } })),
      ...[4, 5].map((i) => modo(`u${i}`, { previous: { connection_id: conn(i), zone_id: ZONA, scope: 'host', ruleset_id: RS } })),
    ] });
    estado.actualizar = (l) => (l?.metodos.some(([m, c, v]) => m === 'eq' && c === 'kind' && v === 'under_attack_on')
      ? { error: { code: '57014' } } : { data: null });
    estado.huerfanas = () => ({ data: [{ id: 'h1', org_id: ORG, expires_at: AHORA.toISOString(),
      previous: { connection_id: CONN, zone_id: ZONA, scope: 'host', ref: REF } }] });
    const r = await housekeeping(envDoble(PROD).env, AHORA);
    expect(r.error).toBe('internal');
    expect(leeHuerfana()).toBe(false);
    // rpc · vigilante · lectura · bloqueos (11, los suyos) · bajo ataque: su tope 2 × 2 + 2 + 2 = 8 (real 7) al lanzar.
    expect(r.subpeticiones).toBe(1 + 1 + 1 + 11 + 8);
    expect(r.subpeticiones).toBeGreaterThanOrEqual(1 + 1 + 19);
  });
});

describe('housekeeping · vigilante de corridas colgadas (0011)', () => {
  const ORG2 = '0f6c0000-0000-4000-8000-000000000002';
  const hace = (min: number) => new Date(AHORA.getTime() - min * 60_000).toISOString();
  const MINUTO_IMPAR = new Date(AHORA.getTime() + 60_000);
  const lineasVigilante = () => logs.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>)
    .filter((e) => e.event === 'vigilante.interrumpidas');
  const corrida = (id: string, status: string, avance: number, o: Record<string, unknown> = {}): FilaMem =>
    ({ id, org_id: ORG, status, updated_at: hace(avance), created_at: hace(avance + 30), cost_usd: 0.0421, error: null,
      finished_at: null, ...o });
  const auditoria = (id: string, status: string, creada: number, iniciada: number | null): FilaMem =>
    ({ id, org_id: ORG2, status, created_at: hace(creada), started_at: iniciada === null ? null : hace(iniciada), step: 'repo',
      error: null, finished_at: null });

  it('umbrales: 10 min para la wiki (= SIN_AVANCE_MS de E41), 15 para auditorías; tope de 50 filas por tabla', () => {
    expect([VIGILANTE_WIKI_MS, SIN_AVANCE_MS, VIGILANTE_SCAN_MS, LIMITE_VIGILANTE]).toEqual([600_000, 600_000, 900_000, 50]);
  });

  it('una sola RPC acotada (1 subpetición): cuenta lo cerrado por tabla y deja una línea con los ids, sin escribir nada más', async () => {
    estado.vigilante = () => ({ data: [{ tabla: 'wiki_runs', id: 'w1', org_id: ORG }, { tabla: 'scan_runs', id: 's1', org_id: ORG2 },
      { tabla: 'wiki_runs', id: 'w2', org_id: ORG }] });
    const r = await housekeeping(envDoble().env, AHORA);
    expect(estado.llamadas.filter((l) => l.rpc === 'vg_vigilar_corridas')).toEqual([VIGILAR]);
    expect(estado.llamadas.filter((l) => l.tabla)).toEqual([]);
    expect(r).toMatchObject({ subpeticiones: 2, vigilante: 'rpc', interrumpidas: { wiki: 2, scans: 1 }, error: null });
    expect(lineasVigilante()).toEqual([{ level: 'warn', event: 'vigilante.interrumpidas', modo: 'rpc', wiki: ['w1', 'w2'],
      scans: ['s1'], total: 3 }]);
  });

  it('0022: una auditoría terminada cuyo cierre se perdió (scan_runs_cerradas) no cuenta como interrumpida', async () => {
    estado.vigilante = () => ({ data: [{ tabla: 'scan_runs_cerradas', id: 's9', org_id: ORG }, { tabla: 'scan_runs', id: 's1', org_id: ORG2 }] });
    const r = await housekeeping(envDoble().env, AHORA);
    expect(r).toMatchObject({ subpeticiones: 2, vigilante: 'rpc', interrumpidas: { wiki: 0, scans: 1 }, error: null });
    expect(lineasVigilante()).toEqual([{ level: 'warn', event: 'vigilante.interrumpidas', modo: 'rpc', wiki: [], scans: ['s1'],
      total: 1 }]);
    const ev = logs.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>);
    expect(ev.filter((e) => e.event === 'vigilante.cerradas')).toEqual([{ level: 'info', event: 'vigilante.cerradas',
      scans: ['s9'], total: 1 }]);
  });

  it('sin nada que cerrar no deja línea propia; otro error de la RPC va al resumen sin caer al respaldo', async () => {
    await housekeeping(envDoble().env, AHORA);
    expect(lineasVigilante()).toEqual([]);

    estado.vigilante = () => ({ error: { code: '57014' } });
    const r = await housekeeping(envDoble().env, AHORA);
    expect(r).toMatchObject({ resueltos: 2, subpeticiones: 2, vigilante: 'rpc', error: '57014', interrumpidas: { wiki: 0, scans: 0 } });
    expect(estado.llamadas.filter((l) => l.tabla)).toEqual([]);
  });

  describe('respaldo sin la 0011 (PGRST202)', () => {
    beforeEach(() => { estado.vigilante = () => ({ error: { code: 'PGRST202' } }); });

    it('minuto par: un UPDATE de wiki_runs con el corte en la misma sentencia; cierra la de hace 11 min y no la de hace 9 ni la que avanzó justo antes; no cobra', async () => {
      const filas = [corrida('a1', 'running', 11), corrida('a2', 'running', 9), corrida('a3', 'queued', 11),
        corrida('a4', 'succeeded', 120), corrida('a5', 'failed', 60), corrida('a6', 'queued', 25)];
      estado.tablas.wiki_runs = filas;
      // vg_wiki_avanzar de otra entrega entre la decisión y la escritura: el UPDATE ya no la ve.
      estado.antesDeUpdate = () => { filas[2]!.updated_at = AHORA.toISOString(); };
      const antes = structuredClone(filas);
      const r = await housekeeping(envDoble().env, AHORA);

      expect(r).toMatchObject({ subpeticiones: 1 + 2, vigilante: 'respaldo', interrumpidas: { wiki: 2, scans: 0 }, error: null });
      const [u] = estado.llamadas.filter((l) => l.tabla);
      expect(u).toEqual({ tabla: 'wiki_runs', metodos: [
        ['update', { status: 'failed', error: ERROR_WIKI_INTERRUMPIDA, finished_at: AHORA.toISOString(), updated_at: AHORA.toISOString() }],
        ['in', 'status', ['queued', 'running']], ['lt', 'updated_at', hace(10)], ['order', 'id'], ['limit', LIMITE_VIGILANTE],
        ['select', 'id, org_id']] });
      expect(filas.map((f) => [f.id, f.status])).toEqual([['a1', 'failed'], ['a2', 'running'], ['a3', 'queued'], ['a4', 'succeeded'],
        ['a5', 'failed'], ['a6', 'failed']]);
      expect(filas[0]).toEqual({ ...antes[0], status: 'failed', error: ERROR_WIKI_INTERRUMPIDA, finished_at: AHORA.toISOString(),
        updated_at: AHORA.toISOString() });
      expect(filas.map((f) => f.cost_usd)).toEqual(antes.map((f) => f.cost_usd));          // sin cobrar nada más
      expect([filas[1], filas[3], filas[4]]).toEqual([antes[1], antes[3], antes[4]]);
      expect(lineasVigilante()).toEqual([expect.objectContaining({ modo: 'respaldo', wiki: ['a1', 'a6'], scans: [] })]);
      expect(estado.llamadas.some((l) => l.tabla === 'scan_runs')).toBe(false);
    });

    it('tope de filas: con 60 colgadas cierra 50 y el resto queda para el minuto siguiente', async () => {
      estado.tablas.wiki_runs = Array.from({ length: 60 }, (_, i) => corrida(`w${String(i).padStart(2, '0')}`, 'running', 30 + i));
      expect(await housekeeping(envDoble().env, AHORA)).toMatchObject({ interrumpidas: { wiki: 50, scans: 0 } });
      expect(estado.tablas.wiki_runs.filter((f) => f.status === 'running')).toHaveLength(10);
      estado.llamadas = [];
      expect(await housekeeping(envDoble().env, new Date(AHORA.getTime() + 2 * 60_000))).toMatchObject({ interrumpidas: { wiki: 10 } });
    });

    it('minuto impar: auditorías queued/running sin avance desde hace más de 15 min → failed con su error y step null', async () => {
      const filas = [auditoria('s1', 'running', 17, 16), auditoria('s2', 'running', 20, 14), auditoria('s3', 'queued', 16, null),
        auditoria('s4', 'queued', 14, null), auditoria('s5', 'succeeded', 90, 89), auditoria('s6', 'failed', 90, 89)];
      estado.tablas.scan_runs = filas;
      const antes = structuredClone(filas);
      const r = await housekeeping(envDoble().env, MINUTO_IMPAR);

      expect(r).toMatchObject({ subpeticiones: 1 + 2, vigilante: 'respaldo', interrumpidas: { wiki: 0, scans: 2 }, error: null });
      const corte = new Date(MINUTO_IMPAR.getTime() - VIGILANTE_SCAN_MS).toISOString();
      const [u] = estado.llamadas.filter((l) => l.tabla);
      expect(u).toEqual({ tabla: 'scan_runs', metodos: [
        ['update', { status: 'failed', error: ERROR_SCAN_INTERRUMPIDA, step: null, finished_at: MINUTO_IMPAR.toISOString() }],
        ['in', 'status', ['queued', 'running']], ['lt', 'created_at', corte], ['or', `started_at.is.null,started_at.lt."${corte}"`],
        ['order', 'id'], ['limit', LIMITE_VIGILANTE], ['select', 'id, org_id']] });
      expect(filas.map((f) => [f.id, f.status, f.step])).toEqual([['s1', 'failed', null], ['s2', 'running', 'repo'],
        ['s3', 'failed', null], ['s4', 'queued', 'repo'], ['s5', 'succeeded', 'repo'], ['s6', 'failed', 'repo']]);
      expect([filas[1], filas[3], filas[4], filas[5]]).toEqual([antes[1], antes[3], antes[4], antes[5]]);
      expect(estado.llamadas.some((l) => l.tabla === 'wiki_runs')).toBe(false);
    });

    it('un error del UPDATE de respaldo va al resumen sin lanzar', async () => {
      estado.errorTabla = { code: '42501' };
      expect(await housekeeping(envDoble().env, AHORA)).toMatchObject({ resueltos: 2, subpeticiones: 3, vigilante: 'respaldo',
        error: '42501', interrumpidas: { wiki: 0, scans: 0 } });
    });
  });

  // La sentencia real vive en la 0011 (se aplica aparte): aquí se comprueba su forma, que el doble no puede probar.
  describe('0011_vigilante.sql', () => {
    const ruta = fileURLToPath(new URL('../../../../supabase/migrations/0011_vigilante.sql', import.meta.url).href);
    const crudo = readFileSync(ruta, 'utf8').replace(/--.*$/gm, '');
    const sql = crudo.toLowerCase().replace(/\s+/g, ' ');
    const entre = (desde: string, hasta: string) => {
      const i = sql.indexOf(desde);
      return sql.slice(i, sql.indexOf(hasta, i));
    };

    it('una sola sentencia acotada: for update skip locked y tope de filas en cada tabla, umbrales con suelo', () => {
      expect(sql).toContain('create or replace function public.vg_vigilar_corridas(p_wiki_seconds int default 600, '
        + 'p_scan_seconds int default 900, p_limit int default 50) returns table (tabla text, id uuid, org_id uuid) language sql '
        + "security definer set search_path = ''");
      expect(sql.match(/for update skip locked/g)).toHaveLength(2);
      expect(sql.match(/limit least\(greatest\(p_limit, 1\), 200\)/g)).toHaveLength(2);
      expect(sql.replace(/'[^']*'/g, "''").match(/;/g)).toHaveLength(3);   // la función, el revoke y el grant
    });

    it('compare-and-set: el corte va en el select for update y otra vez en el update de cada tabla', () => {
      const corteWiki = 'updated_at < now() - make_interval(secs => greatest(p_wiki_seconds, 300))';
      const corteScan = 'coalesce(s.started_at, s.created_at) < now() - make_interval(secs => greatest(p_scan_seconds, 300))';
      expect(entre('with cw as', 'for update')).toContain(`w.${corteWiki}`);
      expect(entre('update public.wiki_runs u', 'returning')).toContain(`u.${corteWiki}`);
      expect(entre('update public.wiki_runs u', 'returning')).toContain("u.status in ('queued', 'running')");
      expect(entre('cs as', 'for update')).toContain(corteScan);
      expect(entre('update public.scan_runs u', 'returning')).toContain(corteScan.replace(/\bs\./g, 'u.'));
      expect(entre('update public.scan_runs u', 'returning')).toContain("u.status in ('queued', 'running')");
    });

    it('no cobra: no toca cost_usd ni state; los textos son los mismos que los del respaldo', () => {
      expect(sql).not.toMatch(/cost_usd|state\s*=/);
      expect(crudo).toContain(`error = '${ERROR_WIKI_INTERRUMPIDA}'`);
      expect(crudo).toContain(`error = '${ERROR_SCAN_INTERRUMPIDA}'`);
    });

    it('solo service_role la ejecuta', () => {
      expect(sql).toContain('revoke all on function public.vg_vigilar_corridas(int, int, int) from public, anon, authenticated;');
      expect(sql).toContain('grant execute on function public.vg_vigilar_corridas(int, int, int) to service_role;');
    });
  });

  // 0022 reescribe la función con la misma firma: cierra como finalizar las auditorías con todos los pasos terminados
  // (prueba en la base: supabase/tests/vigilante-terminadas.sql).
  describe('0022_vigilante_cierra_terminadas.sql', () => {
    const ruta = fileURLToPath(new URL('../../../../supabase/migrations/0022_vigilante_cierra_terminadas.sql', import.meta.url).href);
    const crudo = readFileSync(ruta, 'utf8').replace(/--.*$/gm, '');
    const sql = crudo.toLowerCase().replace(/\s+/g, ' ');
    const entre = (desde: string, hasta: string) => {
      const i = sql.indexOf(desde);
      return sql.slice(i, sql.indexOf(hasta, i));
    };
    const terminada = "not exists (select 1 from jsonb_array_elements(s.steps) t(e) where t.e->>'status' in ('pending', 'running'))";

    it('misma firma, sin drop, y los mismos permisos que la 0011', () => {
      expect(sql).toContain('create or replace function public.vg_vigilar_corridas(p_wiki_seconds int default 600, '
        + 'p_scan_seconds int default 900, p_limit int default 50) returns table (tabla text, id uuid, org_id uuid) language sql '
        + "security definer set search_path = ''");
      expect(sql).not.toContain('drop function');
      expect(sql).toContain('revoke all on function public.vg_vigilar_corridas(int, int, int) from public, anon, authenticated;');
      expect(sql).toContain('grant execute on function public.vg_vigilar_corridas(int, int, int) to service_role;');
      expect(sql).toContain('revoke all on function private.vg_fuentes_fallaron(jsonb) from public, anon, authenticated;');
      expect(sql.match(/for update skip locked/g)).toHaveLength(3);
    });

    it('terminada: sin pasos abiertos, compare-and-set en el select y en el update, y sale como scan_runs_cerradas', () => {
      expect(entre('ct as', 'for update')).toContain(terminada);
      expect(entre('ct as', 'for update')).toContain("jsonb_array_length(s.steps) > 0");
      const ut = entre('ut as', 'returning');
      expect(ut).toContain(terminada.replace('s.steps', 'u.steps'));
      expect(ut).toContain("u.status in ('queued', 'running')");
      expect(ut).toContain("then 'failed' else 'succeeded' end");
      expect(ut).toContain("'todos los pasos de la auditoría fallaron'");
      expect(ut).not.toMatch(/steps =|summary|score|coverage/);
      expect(sql).toContain("select 'scan_runs_cerradas'::text, ut.id, ut.org_id from ut");
      // Las de pasos abiertos siguen el camino de la 0011 y nunca se cruzan con las terminadas.
      expect(entre('cs as', 'for update')).toContain(`not (jsonb_typeof(s.steps) = 'array' and jsonb_array_length(s.steps) > 0 and ${terminada})`);
      expect(crudo).toContain(`error = '${ERROR_SCAN_INTERRUMPIDA}'`);
      expect(crudo).toContain(`error = '${ERROR_WIKI_INTERRUMPIDA}'`);
    });
  });
});

describe('cron por minuto', () => {
  it('engancha housekeeping y deja UNA línea monitor.minuto con su resumen', async () => {
    await onCron(CRON_MINUTO, envDoble().env, AHORA);
    const ev = logs.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>);
    expect(ev).toEqual([{ level: 'info', event: 'monitor.minuto', minuto: 30, trabajos: 1, subpeticiones: 2, resueltos: 2,
      housekeeping: 'rpc', vigilante: 'rpc', interrumpidas: { wiki: 0, scans: 0 }, error: null }]);
  });

  it('keepalive de la voz: con VOZ_URL, cada 10 min un GET /healthz de 5 s sin reintento; sin VOZ_URL u otro minuto, nada', async () => {
    const VOZ = 'https://vanguard-voz.onrender.com';
    const pings = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith(VOZ));
    await onCron(CRON_MINUTO, envDoble().env, AHORA);                                       // minuto 30 sin VOZ_URL
    expect(pings()).toHaveLength(0);
    await onCron(CRON_MINUTO, envDoble({ VOZ_URL: VOZ }).env, new Date(AHORA.getTime() + 60_000));   // minuto 31
    expect(pings()).toHaveLength(0);
    await onCron(CRON_MINUTO, envDoble({ VOZ_URL: VOZ }).env, AHORA);
    expect(pings().map((c) => [String(c[0]), (c[1] as RequestInit).method])).toEqual([[`${VOZ}/healthz`, 'GET']]);
    const ev = () => logs.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>);
    expect(ev().at(-1)).toEqual({ level: 'info', event: 'voz.ping_ok', status: 200 });
    // Dormido o caído: un solo intento, solo un log, y el cron no lanza.
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (u: unknown) => {
      if (String(u).startsWith(VOZ)) throw new DOMException('plazo', 'TimeoutError');
      return new Response('{}', { status: 200 });
    });
    await expect(onCron(CRON_MINUTO, envDoble({ VOZ_URL: VOZ }).env, AHORA)).resolves.toBeUndefined();
    expect(pings()).toHaveLength(1);
    expect(ev().at(-1)).toEqual({ level: 'warn', event: 'voz.ping_fallido', status: null });
  });

  it('si housekeeping falla, la línea sale en warn con el código y el cron no lanza', async () => {
    estado.rpc = () => ({ error: { code: '57014' } });
    await expect(onCron(CRON_MINUTO, envDoble().env, AHORA)).resolves.toBeUndefined();
    const ev = logs.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>);
    expect(ev).toEqual([expect.objectContaining({ level: 'warn', event: 'monitor.minuto', error: '57014', resueltos: 0 })]);
  });
});
