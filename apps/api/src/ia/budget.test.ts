// Envoltorios del libro (S11 11.8, 11.12): argumentos exactos de cada RPC y «nunca lanzan». Sin red.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbDoble, type Resp } from '../test/db-doble.ts';

const estado = vi.hoisted(() => ({ client: null as unknown, lanza: false }));
vi.mock('../lib/db.ts', () => ({ db: () => { if (estado.lanza) throw new Error('sin base'); return estado.client; } }));

import { estadoIA, reservarIA, liquidarIA } from './budget.ts';

const env = {} as CloudflareBindings;
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const USO = 'a1a10000-0000-4000-8000-000000000001';
let rpc: (n: string, a: Record<string, unknown>) => Resp | undefined;
let doble: ReturnType<typeof dbDoble>;

beforeEach(() => {
  estado.lanza = false;
  rpc = () => undefined;
  doble = dbDoble({ rpc: (n, a) => rpc(n, a) });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('estadoIA', () => {
  it('devuelve el jsonb de vg_ai_status', async () => {
    const st = { enabled: true, today_usd: 0.42, cap_usd: 10, calls_1m: 1, level: 'normal' };
    rpc = () => ({ data: st });
    expect(await estadoIA(env, ORG)).toEqual(st);
    expect(doble.rpcs).toEqual([{ name: 'vg_ai_status', args: { p_org: ORG } }]);
  });
  it('error de la RPC, respuesta vacía o base sin configurar → null', async () => {
    rpc = () => ({ error: { code: '42883', message: 'no existe' } });
    expect(await estadoIA(env, ORG)).toBeNull();
    rpc = () => ({ data: null });
    expect(await estadoIA(env, ORG)).toBeNull();
    estado.lanza = true;
    expect(await estadoIA(env, ORG)).toBeNull();
  });
});

describe('reservarIA', () => {
  it('llama a vg_ai_reserve con org, ruta, modelo y peor caso', async () => {
    rpc = () => ({ data: { ok: true, usage_id: USO, global_pct: 2.1 } });
    expect(await reservarIA(env, ORG, 'fix_prompt', 'claude-sonnet-5-5', 0.146)).toEqual({ ok: true, usage_id: USO, global_pct: 2.1 });
    expect(doble.rpcs).toEqual([{ name: 'vg_ai_reserve',
      args: { p_org: ORG, p_route: 'fix_prompt', p_model: 'claude-sonnet-5-5', p_worst_usd: 0.146 } }]);
  });
  it('pasa el {ok:false, code, scope} tal cual; error o excepción → null', async () => {
    rpc = () => ({ data: { ok: false, code: 'budget', scope: 'org' } });
    expect(await reservarIA(env, ORG, 'audit_summary', 'claude-opus-5-5', 0.8)).toEqual({ ok: false, code: 'budget', scope: 'org' });
    rpc = () => ({ error: { message: 'x' } });
    expect(await reservarIA(env, ORG, 'audit_summary', 'claude-opus-5-5', 0.8)).toBeNull();
    estado.lanza = true;
    expect(await reservarIA(env, ORG, 'audit_summary', 'claude-opus-5-5', 0.8)).toBeNull();
  });
});

describe('liquidarIA', () => {
  it('manda los 9 parámetros de vg_ai_settle; lo que falta va como null', async () => {
    await liquidarIA(env, USO, { cost: null, stop: 'error_transient' });
    expect(doble.rpcs).toEqual([{ name: 'vg_ai_settle', args: { p_id: USO, p_input: null, p_cache_read: null,
      p_cache_write: null, p_output: null, p_cost: null, p_stop: 'error_transient', p_refusal: null, p_request_id: null } }]);
  });
  it('con usage real', async () => {
    await liquidarIA(env, USO, { input: 3000, cache_read: 1900, cache_write: 0, output: 2700, cost: 0.03319, stop: 'end_turn',
      refusal: null, request_id: 'msg_01' });
    expect(doble.rpcs[0]?.args).toEqual({ p_id: USO, p_input: 3000, p_cache_read: 1900, p_cache_write: 0, p_output: 2700,
      p_cost: 0.03319, p_stop: 'end_turn', p_refusal: null, p_request_id: 'msg_01' });
  });
  it('no lanza si la RPC falla o la base no está', async () => {
    rpc = () => ({ error: { code: '500', message: 'x' } });
    await expect(liquidarIA(env, USO, { cost: 0, stop: 'error_4xx' })).resolves.toBeUndefined();
    estado.lanza = true;
    await expect(liquidarIA(env, USO, { cost: 0, stop: 'error_4xx' })).resolves.toBeUndefined();
  });
});
