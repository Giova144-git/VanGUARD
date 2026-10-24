import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { envDoble } from '../test/dobles.ts';

// Doble propio: el UPDATE de respaldo usa lt/overlaps, que el doble común (test/db-doble.ts) no trae.
type Llamada = { tabla?: string; rpc?: string; args?: unknown; metodos: [string, ...unknown[]][] };
const estado = vi.hoisted(() => ({
  client: null as unknown,
  llamadas: [] as { tabla?: string; rpc?: string; args?: unknown; metodos: [string, ...unknown[]][] }[],
  rpc: (_n: string, _a: unknown): { data?: unknown; error?: { code?: string } | null } => ({ data: [] }),
  update: (): { data?: unknown; error?: { code?: string } | null } => ({ data: [] }),
}));
vi.mock('../lib/db.ts', () => ({ db: () => { if (!estado.client) throw new Error('sin base'); return estado.client; } }));

const { housekeeping, LIMITE_CIERRE } = await import('./housekeeping.ts');
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
      for (const m of ['update', 'in', 'lt', 'overlaps', 'select', 'eq']) {
        b[m] = (...a: unknown[]) => { l.metodos.push([m, ...a]); return b; };
      }
      b.then = (ok: (r: unknown) => unknown) => {
        const r = estado.update();
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(ok);
      };
      return b;
    },
  };
}

const AHORA = new Date('2026-10-24T19:30:00.000Z');
let logs: MockInstance<typeof console.log>;

beforeEach(() => {
  estado.llamadas = [];
  estado.client = cliente();
  estado.rpc = () => ({ data: [{ id: 'i1', org_id: 'o1' }, { id: 'i2', org_id: 'o2' }] });
  estado.update = () => ({ data: [{ id: 'i3' }] });
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('housekeeping · cierre automático (§12.3)', () => {
  it('una sola RPC acotada: 15 min sin peticiones de la IP, tope de candidatos; cuenta los resueltos', async () => {
    const r = await housekeeping(envDoble().env, AHORA);
    expect(estado.llamadas).toEqual([{ rpc: 'vg_resolve_idle_incidents', args: { p_idle_seconds: 900, p_limit: LIMITE_CIERRE }, metodos: [] }]);
    expect(r).toEqual({ resueltos: 2, subpeticiones: 1, modo: 'rpc', error: null });
  });

  it('sin la 0009 aplicada (PGRST202): un solo UPDATE de respaldo por last_event_at, solo CF_ y no resueltos', async () => {
    estado.rpc = () => ({ error: { code: 'PGRST202' } });
    const r = await housekeeping(envDoble().env, AHORA);
    expect(r).toEqual({ resueltos: 1, subpeticiones: 2, modo: 'respaldo', error: null });
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
    expect(await housekeeping(envDoble().env, AHORA)).toEqual({ resueltos: 0, subpeticiones: 1, modo: 'rpc', error: '57014' });
    expect(estado.llamadas).toHaveLength(1);                 // otro error no cae al respaldo

    estado.rpc = () => ({ error: { code: '42883' } });
    estado.update = () => ({ error: { code: '42501' } });
    expect(await housekeeping(envDoble().env, AHORA)).toEqual({ resueltos: 0, subpeticiones: 2, modo: 'respaldo', error: '42501' });

    estado.client = null;
    const r = await housekeeping(envDoble().env, AHORA);
    expect(r).toMatchObject({ resueltos: 0, subpeticiones: 0, modo: null });
    expect(typeof r.error).toBe('string');
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
