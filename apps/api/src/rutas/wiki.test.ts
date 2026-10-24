import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, WikiRun } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

// E42–E44 provisionales (rutas/wiki.ts): historial vacío y 404 uniforme hasta la integración de DeepWiki.
const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

const { app } = await import('../app.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const OTRA_ORG = '0f6c0000-0000-4000-8000-000000000002';

beforeEach(() => {
  estado.client = dbDoble({
    tabla: (op: Op): Resp | undefined => (op.table === 'org_members'
      ? { data: eqDe(op, 'org_id') === ORG ? { role: 'viewer' } : null } : undefined),
    claims: (tok) => (tok === 'ana' ? { sub: ANA, email: 'ana@acme.dev', is_anonymous: false } : null),
  }).client;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const pedir = (ruta: string, org = ORG) =>
  app.request(`https://officialvanguard.com/api/orgs/${org}/wiki/${ruta}`, { headers: { authorization: 'Bearer ana' } }, envDoble().env);

describe('E43 · GET /api/orgs/:org/wiki/runs (provisional)', () => {
  it('el historial sale vacío y válido según el contrato (el viewer puede leer)', async () => {
    for (const q of ['runs', 'runs?repo=acme/tienda']) {
      const r = await pedir(q);
      expect(r.status, q).toBe(200);
      expect(WikiRun.array().parse(await r.json())).toEqual([]);
    }
  });

  it('repo con formato inválido → 422 con field_errors.repo', async () => {
    const r = await pedir('runs?repo=no-es-un-repo');
    expect(r.status).toBe(422);
    expect(ApiErrorBody.parse(await r.json()).error.details).toMatchObject({ field_errors: { repo: expect.any(Array) } });
  });

  it('quien no es miembro → 404; sin sesión → 401', async () => {
    expect((await pedir('runs', OTRA_ORG)).status).toBe(404);
    const r = await app.request(`https://officialvanguard.com/api/orgs/${ORG}/wiki/runs`, {}, envDoble().env);
    expect(r.status).toBe(401);
  });
});

describe('E42 / E44 (provisionales): 404 con el mismo texto para cualquier id', () => {
  it('uuid, id malformado y el documento dan el mismo 404', async () => {
    const textos = [];
    for (const ruta of ['runs/0f6c0000-0000-4000-8000-0000000000aa', 'runs/no-es-un-uuid', 'runs/0f6c0000-0000-4000-8000-0000000000aa/doc']) {
      const r = await pedir(ruta);
      expect(r.status, ruta).toBe(404);
      textos.push(ApiErrorBody.parse(await r.json()).error.message);
    }
    expect(new Set(textos).size).toBe(1);
  });
});
