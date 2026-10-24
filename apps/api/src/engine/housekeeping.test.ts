import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ApiError } from '../lib/errors.ts';
import { envDoble } from '../test/dobles.ts';

// Doble propio: el UPDATE de respaldo y la caducidad usan lt/overlaps, que el doble común (test/db-doble.ts) no trae.
type Llamada = { tabla?: string; rpc?: string; args?: unknown; metodos: [string, ...unknown[]][] };
type R = { data?: unknown; error?: { code?: string } | null };
const estado = vi.hoisted(() => ({
  client: null as unknown,
  llamadas: [] as { tabla?: string; rpc?: string; args?: unknown; metodos: [string, ...unknown[]][] }[],
  rpc: (_n: string, _a: unknown): { data?: unknown; error?: { code?: string } | null } => ({ data: [] }),
  update: (): { data?: unknown; error?: { code?: string } | null } => ({ data: [] }),
  vencidas: (): { data?: unknown; error?: { code?: string } | null } => ({ data: [] }),
  actualizar: (): { data?: unknown; error?: { code?: string } | null } => ({ data: null }),
}));
vi.mock('../lib/db.ts', () => ({ db: () => { if (!estado.client) throw new Error('sin base'); return estado.client; } }));
const cred = vi.hoisted(() => ({ withSecret: vi.fn() }));
vi.mock('../lib/credentials.ts', () => ({ withSecret: cred.withSecret }));

const { CANDIDATOS_CADUCIDAD, housekeeping, LIMITE_CIERRE, MAX_REINTENTOS } = await import('./housekeeping.ts');
const { CRON_MINUTO, onCron } = await import('../cron.ts');

function cliente() {
  return {
    async rpc(name: string, args: unknown) {
      estado.llamadas.push({ rpc: name, args, metodos: [] });
      const r = estado.rpc(name, args);
      return { data: r.data ?? null, error: r.error ?? null };
    },
    from(tabla: string) {
      const l: Llamada = { tabla, metodos: [] };
      estado.llamadas.push(l);
      const b: Record<string, unknown> = {};
      for (const m of ['update', 'in', 'lt', 'overlaps', 'select', 'eq', 'order', 'limit']) {
        b[m] = (...a: unknown[]) => { l.metodos.push([m, ...a]); return b; };
      }
      b.then = (ok: (r: unknown) => unknown) => {
        const esUpdate = l.metodos.some(([m]) => m === 'update');
        const r: R = tabla === 'actions' ? (esUpdate ? estado.actualizar() : estado.vencidas()) : estado.update();
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
let logs: MockInstance<typeof console.log>;
let fetchMock: ReturnType<typeof vi.fn>;

const vencida = (id: string, o: Record<string, unknown> = {}) => ({ id, org_id: ORG, provider_ref: `${id}0000000000000000000000000000`.slice(0, 32),
  previous: { connection_id: CONN, zone_id: ZONA, existed: false }, ...o });

beforeEach(() => {
  estado.llamadas = [];
  estado.client = cliente();
  estado.rpc = () => ({ data: [{ id: 'i1', org_id: 'o1' }, { id: 'i2', org_id: 'o2' }] });
  estado.update = () => ({ data: [{ id: 'i3' }] });
  estado.vencidas = () => ({ data: [] });
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
    expect(estado.llamadas).toEqual([{ rpc: 'vg_resolve_idle_incidents', args: { p_idle_seconds: 900, p_limit: LIMITE_CIERRE }, metodos: [] }]);
    expect(r).toEqual({ resueltos: 2, subpeticiones: 1, modo: 'rpc', error: null, ...SIN_BLOQUEOS });
  });

  it('sin la 0009 aplicada (PGRST202): un solo UPDATE de respaldo por last_event_at, solo CF_ y no resueltos', async () => {
    estado.rpc = () => ({ error: { code: 'PGRST202' } });
    const r = await housekeeping(envDoble().env, AHORA);
    expect(r).toEqual({ resueltos: 1, subpeticiones: 2, modo: 'respaldo', error: null, ...SIN_BLOQUEOS });
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
    expect(await housekeeping(envDoble().env, AHORA)).toEqual({ resueltos: 0, subpeticiones: 1, modo: 'rpc', error: '57014', ...SIN_BLOQUEOS });
    expect(estado.llamadas).toHaveLength(1);                 // otro error no cae al respaldo

    estado.rpc = () => ({ error: { code: '42883' } });
    estado.update = () => ({ error: { code: '42501' } });
    expect(await housekeeping(envDoble().env, AHORA)).toEqual({ resueltos: 0, subpeticiones: 2, modo: 'respaldo', error: '42501', ...SIN_BLOQUEOS });

    estado.client = null;
    const r = await housekeeping(envDoble().env, AHORA);
    expect(r).toMatchObject({ resueltos: 0, subpeticiones: 0, modo: null });
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
    expect(r.subpeticiones).toBe(1 + 1 + 2 + 2 + 2);           // rpc · select · sobre (2) · 2 DELETE · undone por id y por regla

    const [sel, up, porRegla] = llamadaActions();
    expect(sel!.metodos).toEqual([
      ['select', 'id, org_id, provider_ref, previous'], ['eq', 'status', 'executed'], ['eq', 'kind', 'block_ip'],
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
    expect(r.subpeticiones).toBe(1 + 1 + 2 + 2 + 2);           // rpc · select · sobre · 2 DELETE · una escritura por fila
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

describe('cron por minuto', () => {
  it('engancha housekeeping y deja UNA línea monitor.minuto con su resumen', async () => {
    await onCron(CRON_MINUTO, envDoble().env, AHORA);
    const ev = logs.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>);
    expect(ev).toEqual([{ level: 'info', event: 'monitor.minuto', minuto: 30, trabajos: 1, subpeticiones: 1, resueltos: 2,
      housekeeping: 'rpc', error: null }]);
  });

  it('si housekeeping falla, la línea sale en warn con el código y el cron no lanza', async () => {
    estado.rpc = () => ({ error: { code: '57014' } });
    await expect(onCron(CRON_MINUTO, envDoble().env, AHORA)).resolves.toBeUndefined();
    const ev = logs.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>);
    expect(ev).toEqual([expect.objectContaining({ level: 'warn', event: 'monitor.minuto', error: '57014', resueltos: 0 })]);
  });
});
