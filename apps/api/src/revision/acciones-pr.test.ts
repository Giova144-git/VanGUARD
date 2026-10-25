import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbDoble, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

// Acciones con el token de acciones de GitHub que luego dispararán los botones del WhatsApp (anexos
// bloqueo-merge-cierre-pr.md y avisos-whatsapp-botones.md): «Reabrir el PR» y «Crear issue». Sin red: fetch simulado.
const estado = vi.hoisted(() => ({ ctx: null as unknown, sinSecreto: false }));
vi.mock('../lib/credentials.ts', async () => {
  const { ApiError } = await import('../lib/errors.ts');
  return {
    withSecret: async (_e: unknown, _a: unknown, ctx: unknown, fn: (t: string) => Promise<unknown>) => {
      estado.ctx = ctx;
      if (estado.sinSecreto) throw new ApiError('not_found', 'Esta conexión ya no tiene credencial.');
      return fn('tok-acciones');
    },
  };
});

const { conexionAccion, crearIssue, mismoRepoGh, reabrirPr } = await import('./acciones-pr.ts');

const ORG = '0f6c0000-0000-4000-8000-000000000001';
const REV = 'c4000000-0000-4000-8000-000000000022';
const CFG = 'c4000000-0000-4000-8000-000000000001';
const CONN = 'c0000000-0000-4000-8000-000000000001';
const ACC = 'c0000000-0000-4000-8000-000000000006';
const GH = 'https://api.github.com/repos/Acme/Tienda';

type Fila = Record<string, unknown>;
let fila: Fila;
let conexiones: Fila[];
let gh: Record<string, () => Response>;
let fetchMock: ReturnType<typeof vi.fn>;
let doble: ReturnType<typeof dbDoble>;
const env = envDoble().env;

const cumple = (f: Fila, op: Op) => op.filters.every(([c, o, v]) =>
  o === 'eq' ? f[c] === v : o === 'in' ? (v as unknown[]).includes(f[c]) : o === 'is' ? (f[c] ?? null) === v : true);

beforeEach(() => {
  fila = { id: REV, org_id: ORG, config_id: CFG, event: 'pull_request', pr_number: 7, gate_pr_action: 'closed' };
  conexiones = [
    { id: CONN, org_id: ORG, provider: 'github', kind: 'read', status: 'active', meta: { repo_full_name: 'acme/tienda', repo_id: 42 } },
    { id: ACC, org_id: ORG, provider: 'github', kind: 'action', status: 'active',
      capabilities: { statuses: true, pull_requests: true, issues: true },
      meta: { repo_full_name: 'Acme/Tienda', repo_id: 42, branch: 'main' } },
  ];
  estado.sinSecreto = false;
  gh = {
    [`PATCH ${GH}/pulls/7`]: () => new Response('{"state":"open"}', { status: 200 }),
    [`POST ${GH}/issues`]: () => new Response(JSON.stringify({ number: 12, html_url: 'https://github.com/Acme/Tienda/issues/12' }),
      { status: 201 }),
  };
  doble = dbDoble({
    tabla: (op): Resp | undefined => {
      if (op.table === 'code_reviews') {
        const hit = cumple(fila, op) ? fila : null;
        if (op.action === 'update' && hit) Object.assign(fila, op.payload);
        return { data: hit };
      }
      if (op.table === 'code_review_configs') return { data: cumple({ id: CFG, org_id: ORG }, op) ? { id: CFG, connection_id: CONN } : null };
      if (op.table === 'connections') return { data: conexiones.filter((c) => cumple(c, op)) };
      return undefined;
    },
  });
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const f = gh[`${init.method ?? 'GET'} ${url}`];
    if (!f) throw new Error('sin respuesta');
    return f();
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const admin = () => doble.client as never;
const cuerpo = (i = 0) => JSON.parse(String((fetchMock.mock.calls[i]![1] as RequestInit).body)) as Record<string, unknown>;
const lineas = () => (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join('\n');

describe('reabrirPr', () => {
  it('PR que cerró VanGUARD → PATCH state open con el token de acciones en el repo de su meta; queda reopened', async () => {
    expect(await reabrirPr(env, admin(), ORG, REV, { via: 'whatsapp' })).toEqual({ ok: true, numero: 7 });
    expect(fetchMock.mock.calls.map(([u, i]) => `${(i as RequestInit).method} ${String(u)}`)).toEqual([`PATCH ${GH}/pulls/7`]);
    expect(cuerpo()).toEqual({ state: 'open' });
    expect(estado.ctx).toEqual({ orgId: ORG, connectionId: ACC, provider: 'github', kind: 'action' });
    expect(fila.gate_pr_action).toBe('reopened');
    const u = doble.ops.find((o) => o.table === 'code_reviews' && o.action === 'update')!;
    expect(u.filters).toContainEqual(['gate_pr_action', 'in', ['closed', 'reopened_by_human']]);
    expect(lineas()).toContain('"via":"whatsapp"');
    expect(lineas()).not.toContain('tok-acciones');
  });

  it('solo un PR que cerró VanGUARD: push, ya abierto o nunca cerrado → motivo, sin GitHub', async () => {
    const casos: [Fila, string][] = [[{ event: 'push', pr_number: null }, 'no_es_pr'],
      [{ gate_pr_action: 'reopened_by_human' }, 'ya_abierto'], [{ gate_pr_action: 'reopened' }, 'ya_abierto'],
      [{ gate_pr_action: null }, 'no_cerrado'], [{ gate_pr_action: 'close_failed' }, 'no_cerrado'], [{ org_id: 'otra' }, 'no_encontrada']];
    for (const [cambio, motivo] of casos) {
      fila = { id: REV, org_id: ORG, config_id: CFG, event: 'pull_request', pr_number: 7, gate_pr_action: 'closed', ...cambio };
      expect(await reabrirPr(env, admin(), ORG, REV)).toEqual({ ok: false, motivo });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sin token, sin Pull requests, de otro repo o sin secreto → motivo, sin GitHub', async () => {
    conexiones[1]!.capabilities = { statuses: true };
    expect(await reabrirPr(env, admin(), ORG, REV)).toEqual({ ok: false, motivo: 'sin_permiso_pr' });
    conexiones[1]!.capabilities = { statuses: true, pull_requests: true };
    conexiones[1]!.meta = { repo_full_name: 'acme/otro', repo_id: 99 };
    expect(await reabrirPr(env, admin(), ORG, REV)).toEqual({ ok: false, motivo: 'otro_repo' });
    conexiones[1]!.status = 'revoked';
    expect(await reabrirPr(env, admin(), ORG, REV)).toEqual({ ok: false, motivo: 'sin_token' });
    expect(fetchMock).not.toHaveBeenCalled();
    conexiones[1]!.status = 'active';
    conexiones[1]!.meta = { repo_full_name: 'Acme/Tienda', repo_id: 42 };
    estado.sinSecreto = true;
    expect(await reabrirPr(env, admin(), ORG, REV)).toEqual({ ok: false, motivo: 'sin_token' });
  });

  it('GitHub 403 → forbidden, 422 → rechazado, 5xx → red; la revisión sigue closed', async () => {
    for (const [status, motivo] of [[403, 'forbidden'], [422, 'rechazado'], [502, 'red'], [401, 'unauthorized']] as const) {
      gh[`PATCH ${GH}/pulls/7`] = () => new Response('{"message":"no"}', { status });
      expect(await reabrirPr(env, admin(), ORG, REV)).toEqual({ ok: false, motivo });
      expect(fila.gate_pr_action).toBe('closed');
    }
    expect(lineas()).not.toContain('"message"');
  });
});

describe('crearIssue', () => {
  const texto = { titulo: 'VanGUARD: clave live de Stripe en src/lib/cobros.ts:3', cuerpo: 'Rota la clave en el panel de Stripe.' };
  it('crea el issue con la etiqueta vanguard y devuelve número y URL', async () => {
    expect(await crearIssue(env, admin(), ORG, REV, texto)).toEqual({ ok: true, numero: 12,
      url: 'https://github.com/Acme/Tienda/issues/12' });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${GH}/issues`);
    expect(cuerpo()).toEqual({ title: texto.titulo, body: texto.cuerpo, labels: ['vanguard'] });
  });

  it('sin Issues: write → sin_permiso_issues; un texto con forma de secreto o con bidi nunca sale a GitHub', async () => {
    conexiones[1]!.capabilities = { statuses: true, pull_requests: true };
    expect(await crearIssue(env, admin(), ORG, REV, texto)).toEqual({ ok: false, motivo: 'sin_permiso_issues' });
    conexiones[1]!.capabilities = { issues: true };
    const secreto = 'gh' + 'p_' + 'A1b2'.repeat(9);
    expect(await crearIssue(env, admin(), ORG, REV, { ...texto, cuerpo: `valor ${secreto}` }))
      .toEqual({ ok: false, motivo: 'texto_rechazado' });
    const bidi = String.fromCharCode(0x202e);
    expect(await crearIssue(env, admin(), ORG, REV, { ...texto, titulo: `x${bidi}y` })).toEqual({ ok: false, motivo: 'texto_rechazado' });
    expect(await crearIssue(env, admin(), ORG, REV, { titulo: '  ', cuerpo: 'x' })).toEqual({ ok: false, motivo: 'texto_rechazado' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creado con un cuerpo ilegible → ok con numero null (nunca «no se pudo» sobre un issue que existe)', async () => {
    gh[`POST ${GH}/issues`] = () => new Response('no es json', { status: 201 });
    expect(await crearIssue(env, admin(), ORG, REV, texto)).toEqual({ ok: true, numero: null });
  });

  it('una html_url de otro repo no se devuelve', async () => {
    gh[`POST ${GH}/issues`] = () => new Response(JSON.stringify({ number: 3, html_url: 'https://evil.example/x' }), { status: 201 });
    expect(await crearIssue(env, admin(), ORG, REV, texto)).toEqual({ ok: true, numero: 3 });
  });
});

describe('conexionAccion y mismoRepoGh', () => {
  it('mismo repo por repo_id; sin él, por nombre sin mayúsculas', () => {
    expect(mismoRepoGh({ repo_id: 42, repo_full_name: 'a/b' }, { repo_id: '42', repo_full_name: 'x/y' })).toBe(true);
    expect(mismoRepoGh({ repo_id: 42 }, { repo_id: 43 })).toBe(false);
    expect(mismoRepoGh({ repo_full_name: 'Acme/Tienda' }, { repo_full_name: 'acme/tienda' })).toBe(true);
    expect(mismoRepoGh({}, {})).toBe(false);
  });
  it('un repo con forma rara en meta no se usa', async () => {
    conexiones[1]!.meta = { repo_full_name: '../evil', repo_id: 42 };
    expect(await conexionAccion(admin(), ORG, CONN)).toEqual({ ok: false, motivo: 'repo_invalido' });
  });
});
