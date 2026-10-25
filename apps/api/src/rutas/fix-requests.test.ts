// E58 y E58b «Enviar a mi IA» (cola fix_requests, 0023): crear idempotente, cancelar, leer la cola y permisos.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FixRequest } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const { app } = await import('../app.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const F = 'c3d40000-0000-4000-8000-000000000001';
const R = 'f1c00000-0000-4000-8000-000000000001';
const fila = (o: Record<string, unknown> = {}) => ({ id: R, finding_id: F, status: 'enviado', client: 'claude_code',
  created_at: '2026-10-24T19:30:00+00:00', started_at: null, closed_at: null, ...o });

let rol: string;
let anon: boolean;
let hallazgo: Record<string, unknown> | null;
let tabla: (op: Op) => Resp | undefined;
let doble: ReturnType<typeof dbDoble>;

beforeEach(() => {
  rol = 'admin'; anon = false; hallazgo = { id: F, status: 'open' }; tabla = () => undefined;
  doble = dbDoble({
    tabla: (op) => {
      const propia = tabla(op);
      if (propia) return propia;
      if (op.table === 'org_members') return { data: { role: rol } };
      if (op.table === 'findings') return { data: eqDe(op, 'org_id') === ORG && eqDe(op, 'id') === F ? hallazgo : null };
      return undefined;
    },
    claims: (t) => (t === 'ok' ? { sub: ANA, email: anon ? '' : 'ana@acme.dev', is_anonymous: anon, role: 'authenticated' } : null),
  });
  estado.client = doble.client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const pedir = (method: string, ruta: string, body?: string) => app.request(`https://officialvanguard.com/api/orgs/${ORG}${ruta}`, {
  method, headers: { authorization: 'Bearer ok', 'content-type': 'application/json', origin: 'https://officialvanguard.com' },
  ...(body === undefined ? {} : { body }) }, envDoble().env);
const escrituras = () => doble.ops.filter((o) => o.table === 'fix_requests' && o.action !== 'select');

describe('E58 · POST findings/:id/fix-requests', () => {
  it('crea «enviado» con el autor, la org de la sesión y el cliente → 201', async () => {
    tabla = (op) => (op.table === 'fix_requests' && op.action === 'insert' ? { data: fila() } : undefined);
    const r = await pedir('POST', `/findings/${F}/fix-requests`, JSON.stringify({ client: 'claude_code' }));
    expect(r.status).toBe(201);
    expect(FixRequest.parse(await r.json())).toMatchObject({ id: R, status: 'enviado' });
    const [ins] = escrituras();
    expect(ins!.payload).toEqual({ org_id: ORG, finding_id: F, requested_by: ANA, client: 'claude_code' });
  });

  it('idempotente: con una abierta devuelve esa (200) sin insertar; sin cuerpo también vale', async () => {
    tabla = (op) => (op.table === 'fix_requests' && op.action === 'select' ? { data: fila({ status: 'arreglando',
      started_at: '2026-10-24T19:31:00+00:00' }) } : undefined);
    const r = await pedir('POST', `/findings/${F}/fix-requests`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { status: string }).status).toBe('arreglando');
    expect(escrituras()).toHaveLength(0);
    const q = doble.ops.find((o) => o.table === 'fix_requests')!;
    expect(eqDe(q, 'org_id')).toBe(ORG);
    expect(q.filters).toContainEqual(['status', 'in', ['enviado', 'arreglando']]);
  });

  it('doble clic en paralelo (23505) → 200 con la que ganó', async () => {
    let lecturas = 0;
    tabla = (op) => {
      if (op.table !== 'fix_requests') return undefined;
      if (op.action === 'insert') return { error: { code: '23505' } };
      return { data: lecturas++ === 0 ? null : fila() };
    };
    expect((await pedir('POST', `/findings/${F}/fix-requests`)).status).toBe(200);
  });

  it('viewer o anónimo de la demo → 403 sin tocar la tabla; hallazgo cerrado → 409; de otra org o id raro → 404; cliente raro → 422', async () => {
    rol = 'viewer';
    expect((await pedir('POST', `/findings/${F}/fix-requests`)).status).toBe(403);
    rol = 'admin'; anon = true;
    expect((await pedir('POST', `/findings/${F}/fix-requests`)).status).toBe(403);
    expect((await pedir('DELETE', `/findings/${F}/fix-requests`)).status).toBe(403);
    anon = false;
    expect(doble.ops.filter((o) => o.table === 'fix_requests')).toHaveLength(0);
    hallazgo = { id: F, status: 'verified' };
    expect((await pedir('POST', `/findings/${F}/fix-requests`)).status).toBe(409);
    hallazgo = null;
    expect((await pedir('POST', `/findings/${F}/fix-requests`)).status).toBe(404);
    expect((await pedir('POST', '/findings/no-es-uuid/fix-requests')).status).toBe(404);
    hallazgo = { id: F, status: 'open' };
    expect((await pedir('POST', `/findings/${F}/fix-requests`, JSON.stringify({ client: 'pastebin' }))).status).toBe(422);
    expect(escrituras()).toHaveLength(0);
  });
});

describe('E58 · DELETE y E58b · GET', () => {
  it('DELETE cancela solo la abierta del hallazgo en la org de la sesión → 204', async () => {
    const r = await pedir('DELETE', `/findings/${F}/fix-requests`);
    expect(r.status).toBe(204);
    const [u] = escrituras();
    expect(u!.payload).toMatchObject({ status: 'cancelado' });
    expect(eqDe(u!, 'org_id')).toBe(ORG);
    expect(eqDe(u!, 'finding_id')).toBe(F);
    expect(u!.filters).toContainEqual(['status', 'in', ['enviado', 'arreglando']]);
  });

  it('GET (también el viewer): una por hallazgo, la abierta antes que una cerrada', async () => {
    rol = 'viewer';
    const G = 'c3d40000-0000-4000-8000-000000000002';
    tabla = (op) => {
      if (op.table !== 'fix_requests') return undefined;
      const abiertas = op.filters.some(([c, o, v]) => c === 'status' && o === 'in' && (v as string[]).includes('enviado'));
      return { data: abiertas ? [fila()] : [fila({ id: 'f1c00000-0000-4000-8000-000000000009', status: 'cancelado',
        closed_at: '2026-10-24T19:00:00+00:00' }), fila({ id: 'f1c00000-0000-4000-8000-000000000003', finding_id: G,
        status: 'corregido', started_at: '2026-10-24T18:00:00+00:00', closed_at: '2026-10-24T20:00:00+00:00' })] };
    };
    const r = await pedir('GET', '/fix-requests');
    expect(r.status).toBe(200);
    const b = FixRequest.array().parse(await r.json());
    expect(b.map((x) => [x.finding_id, x.status])).toEqual([[F, 'enviado'], [G, 'corregido']]);
    for (const q of doble.ops.filter((o) => o.table === 'fix_requests')) expect(eqDe(q, 'org_id')).toBe(ORG);
  });
});
