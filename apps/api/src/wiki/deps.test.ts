import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorGithub, ErrorWiki, pasoArbol, type CodigoErrorGithub, type Fetch } from '@vanguard/deepwiki';
import { ApiError } from '../lib/errors.ts';
import { dbDoble, type Op } from '../test/db-doble.ts';
import { conTokenGithub, depsWiki, falloGithub, salidaGithub, sinLlm, TOPE_SUBPETICIONES } from './deps.ts';

// Deps de DeepWiki en el Worker (wiki/deps.ts): lista de salida, tope de subpeticiones, token por withSecret y
// traducción de errores de GitHub. Sin red: fetch simulado y doble de la base.
const cred = vi.hoisted(() => ({ withSecret: vi.fn() }));
vi.mock('../lib/credentials.ts', () => cred);

// PAT falso armado en tiempo de ejecución: ningún literal con forma de secreto queda en el repo.
const PAT = ['github', 'pat', 'k'.repeat(40)].join('_');
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const OTRA_ORG = '0f6c0000-0000-4000-8000-000000000002';
const CONN = 'c0aa0000-0000-4000-8000-000000000001';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const API = 'https://api.github.com';

let lineas: string[];
beforeEach(() => {
  lineas = [];
  vi.spyOn(console, 'log').mockImplementation((l: unknown) => { lineas.push(String(l)); });
  cred.withSecret.mockReset().mockImplementation(async (_e: unknown, _a: unknown, _ctx: unknown, fn: (t: string) => unknown) => fn(PAT));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Llamada = { url: string; init: RequestInit | undefined };
function baseDoble(responder: (url: string) => Response = () => new Response('{}')) {
  const llamadas: Llamada[] = [];
  const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
    llamadas.push({ url: String(u), init });
    return responder(String(u));
  }) as Fetch;
  return { f, llamadas };
}

// GitHub de un repo pequeño: metadatos, commit de main y árbol recursivo.
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
function github(url: string): Response {
  if (url === `${API}/repos/acme/tienda`) {
    return json({ full_name: 'acme/tienda', description: 'Tienda', language: 'TypeScript', private: false, default_branch: 'main' });
  }
  if (url === `${API}/repos/acme/tienda/commits/main`) return new Response(SHA);
  if (url === `${API}/repos/acme/tienda/git/trees/${SHA}?recursive=1`) {
    return json({ sha: SHA, truncated: false, tree: [{ path: 'README.md', type: 'blob', size: 40 },
      { path: 'src/index.ts', type: 'blob', size: 300 }, { path: 'src/rutas/pedidos.ts', type: 'blob', size: 900 }] });
  }
  return new Response('no', { status: 404 });
}

describe('salidaGithub · lista de salida (§06.3) y tope', () => {
  it('host permitido: llama con redirect manual aunque pidan follow, conserva las cabeceras y cuenta', async () => {
    const b = baseDoble();
    const s = salidaGithub(5, b.f);
    await s.fetch(`${API}/repos/acme/tienda`, { headers: { 'User-Agent': 'x' }, redirect: 'follow' });
    expect(b.llamadas).toHaveLength(1);
    expect(b.llamadas[0]?.url).toBe(`${API}/repos/acme/tienda`);
    expect(b.llamadas[0]?.init).toMatchObject({ redirect: 'manual', headers: { 'User-Agent': 'x' } });
    expect([s.usadas(), s.bloqueadas()]).toEqual([1, 0]);
  });

  it('host fuera de la lista, http, credenciales o puerto: lanza sin llamar a fetch y el log no lleva la URL', async () => {
    const b = baseDoble();
    const s = salidaGithub(5, b.f);
    for (const u of ['https://evil.example/x?token=SECRETO_EN_QUERY', 'http://api.github.com/repos/a/b',
      'https://u:p@api.github.com/', 'https://api.github.com:8443/', 'https://codeload.github.com/a/b/zip/main']) {
      await expect(s.fetch(u)).rejects.toThrow('EGRESS_BLOCKED');
    }
    expect(b.llamadas).toHaveLength(0);
    expect([s.usadas(), s.bloqueadas()]).toEqual([0, 5]);
    expect(lineas.join('\n')).toContain('egress.bloqueado');
    expect(lineas.join('\n')).not.toContain('SECRETO_EN_QUERY');
    expect(lineas.join('\n')).not.toContain('evil.example');
  });

  it('pasado el tope no sale nada más', async () => {
    const b = baseDoble();
    const s = salidaGithub(2, b.f);
    await s.fetch(`${API}/a`);
    await s.fetch(`${API}/b`);
    await expect(s.fetch(`${API}/c`)).rejects.toThrow('SUBREQUEST_BUDGET');
    expect(b.llamadas.map((l) => l.url)).toEqual([`${API}/a`, `${API}/b`]);
    expect([s.usadas(), s.bloqueadas()]).toEqual([2, 1]);
  });

  it('por defecto llama al fetch global desde la clausura (sin «Illegal invocation»)', async () => {
    const global = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', global);
    const r = await salidaGithub(1).fetch(`${API}/x`);
    expect(await r.text()).toBe('ok');
    expect(global).toHaveBeenCalledWith(`${API}/x`, expect.objectContaining({ redirect: 'manual' }));
  });

  it('con el motor: pasoArbol de un repo pequeño son 3 subpeticiones a api.github.com, todas con redirect manual', async () => {
    const b = baseDoble(github);
    const s = salidaGithub(TOPE_SUBPETICIONES, b.f);
    const estado = await pasoArbol({ repo_full_name: 'acme/tienda' }, depsWiki({ fetch: s.fetch }));
    expect(estado.meta.commit_sha).toBe(SHA);
    expect(b.llamadas).toHaveLength(3);
    expect(b.llamadas.every((l) => l.url.startsWith(`${API}/`) && l.init?.redirect === 'manual')).toBe(true);
    expect(s.usadas()).toBe(3);
  });

  it('con el motor: una redirección a otro host no se sigue (el token no sale de GitHub)', async () => {
    const b = baseDoble(() => new Response(null, { status: 301, headers: { location: 'https://evil.example/repos/acme/tienda' } }));
    const s = salidaGithub(TOPE_SUBPETICIONES, b.f);
    await expect(pasoArbol({ repo_full_name: 'acme/tienda' }, depsWiki({ fetch: s.fetch, githubToken: PAT })))
      .rejects.toMatchObject({ codigo: 'github_error' });
    expect(b.llamadas.map((l) => l.url)).toEqual([`${API}/repos/acme/tienda`]);
  });
});

describe('depsWiki y sinLlm', () => {
  it('sin token no hay githubToken; el llm por defecto lanza sin_llm', async () => {
    const b = baseDoble();
    const d = depsWiki({ fetch: b.f });
    expect('githubToken' in d).toBe(false);
    expect('hallazgos' in d).toBe(false);
    await expect(d.llm?.({ tarea: 'wiki_triage', system: 's', user: 'u', maxTokens: 10 })).rejects.toBeInstanceOf(ErrorWiki);
    await expect(sinLlm({ tarea: 'wiki_area', system: 's', user: 'u', maxTokens: 10 })).rejects.toMatchObject({ codigo: 'sin_llm' });
  });

  it('pasa el token, los hallazgos (también [] = auditó sin hallazgos) y la fecha de la auditoría', () => {
    const b = baseDoble();
    const llm = vi.fn();
    const d = depsWiki({ fetch: b.f, githubToken: PAT, llm, hallazgos: [], auditoria_at: '2026-10-24T18:04:00.000Z' });
    expect(d).toMatchObject({ githubToken: PAT, llm, hallazgos: [], auditoria_at: '2026-10-24T18:04:00.000Z' });
  });
});

describe('conTokenGithub · el PAT solo dentro de withSecret', () => {
  // Filas de connections; el doble aplica todos los .eq() de la consulta, como Postgres.
  const FILAS = [
    { id: CONN, org_id: ORG, provider: 'github', kind: 'read', status: 'active', meta: { repo_full_name: 'Acme/Tienda' } },
    { id: 'c0aa0000-0000-4000-8000-000000000002', org_id: OTRA_ORG, provider: 'github', kind: 'read', status: 'active',
      meta: { repo_full_name: 'acme/tienda' } },
    { id: 'c0aa0000-0000-4000-8000-000000000003', org_id: ORG, provider: 'github', kind: 'read', status: 'revoked',
      meta: { repo_full_name: 'acme/tienda' } },
    { id: 'c0aa0000-0000-4000-8000-000000000004', org_id: ORG, provider: 'cloudflare', kind: 'read', status: 'active', meta: {} },
    { id: 'c0aa0000-0000-4000-8000-000000000005', org_id: ORG, provider: 'github', kind: 'read', status: 'active', meta: {} },
  ];
  const doble = (error?: { code: string }) => dbDoble({
    tabla: (op: Op) => {
      if (op.table !== 'connections') return undefined;
      if (error) return { error };
      const fila = FILAS.find((f) => op.filters.every(([c, o, v]) => o !== 'eq' || (f as Record<string, unknown>)[c] === v));
      return { data: fila ?? null };
    },
  });
  const admin = (d: ReturnType<typeof dbDoble>) => d.client as unknown as SupabaseClient;
  const env = {} as CloudflareBindings;

  it('sin connection_id: fn(undefined, null), sin tocar la base ni withSecret', async () => {
    const d = doble();
    const fn = vi.fn(async (t: string | undefined) => t ?? 'publico');
    expect(await conTokenGithub(env, admin(d), ORG, undefined, 'acme/publico', fn)).toBe('publico');
    expect(fn).toHaveBeenCalledWith(undefined, null);   // sin conexión, la wiki lleva el nombre canónico (E40/E41)
    expect(d.ops).toHaveLength(0);
    expect(cred.withSecret).not.toHaveBeenCalled();
  });

  it('conexión GitHub activa de esta org: withSecret con su contexto y fn recibe el token', async () => {
    const d = doble();
    const r = await conTokenGithub(env, admin(d), ORG, CONN, 'acme/tienda', async (t) => (t === PAT ? 'con-token' : 'otro'));
    expect(r).toBe('con-token');
    const filtros = d.ops[0]?.filters ?? [];
    expect(filtros).toEqual(expect.arrayContaining([['id', 'eq', CONN], ['org_id', 'eq', ORG], ['provider', 'eq', 'github'],
      ['kind', 'eq', 'read'], ['status', 'eq', 'active']]));
    expect(cred.withSecret).toHaveBeenCalledWith(env, admin(d), { orgId: ORG, connectionId: CONN, provider: 'github', kind: 'read' },
      expect.any(Function));
  });

  it('de otra org, revocada, de otro proveedor o inexistente → 404 con el mismo texto y sin withSecret', async () => {
    const textos = new Set<string>();
    for (const id of ['c0aa0000-0000-4000-8000-000000000002', 'c0aa0000-0000-4000-8000-000000000003',
      'c0aa0000-0000-4000-8000-000000000004', 'c0aa0000-0000-4000-8000-0000000000ff']) {
      const e = await conTokenGithub(env, admin(doble()), ORG, id, 'acme/tienda', async () => 'no').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status, id).toBe(404);
      textos.add((e as ApiError).message);
    }
    expect(textos.size).toBe(1);
    expect(cred.withSecret).not.toHaveBeenCalled();
  });

  it('B8: tiene que ser la conexión del repo pedido: otras mayúsculas valen; otro repo o meta sin repo → el mismo 404', async () => {
    const d = doble();
    const r = await conTokenGithub(env, admin(d), ORG, CONN, 'ACME/tienda', async (t, repo) => (t === PAT ? repo : 'otro'));
    expect(r).toBe('Acme/Tienda');   // fn recibe el nombre tal como está en la conexión: E40/E41 nombran la wiki con él
    expect(d.ops[0]?.columns).toContain('meta');   // la misma subpetición, con meta
    const SIN_REPO = 'c0aa0000-0000-4000-8000-000000000005';
    const textos = new Set<string>();
    for (const [id, repo] of [[CONN, 'acme/privado'], [CONN, 'acme/tienda-2'], [SIN_REPO, 'acme/tienda']] as const) {
      const e = await conTokenGithub(env, admin(doble()), ORG, id, repo, async () => 'no').catch((x: unknown) => x);
      expect(e, `${id} ${repo}`).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(404);
      textos.add((e as ApiError).message);
    }
    expect([...textos]).toEqual(['Conexión no encontrada']);
    expect(cred.withSecret).toHaveBeenCalledTimes(1);   // solo la que casa: con otro repo el PAT ni se descifra
  });

  it('error de la base → 500 internal sin detalles de Postgres', async () => {
    const e = await conTokenGithub(env, admin(doble({ code: '57014' })), ORG, CONN, 'acme/tienda', async () => 'no')
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'internal', status: 500 });
    expect(cred.withSecret).not.toHaveBeenCalled();
  });
});

describe('falloGithub · errores esperados de GitHub → §15.3, nunca 500', () => {
  const casos: [CodigoErrorGithub, number, string][] = [
    ['repo_invalido', 422, 'invalid_body'], ['ref_invalida', 422, 'invalid_body'],
    ['repo_no_encontrado', 404, 'not_found'], ['ref_no_encontrada', 404, 'not_found'], ['repo_vacio', 409, 'conflict'],
    ['token_invalido', 422, 'provider_rejected'], ['limite_github', 429, 'rate_limited'],
    ['github_error', 502, 'provider_unavailable'], ['github_red', 502, 'provider_unavailable'],
    ['respuesta_invalida', 502, 'provider_unavailable'],
  ];
  it.each(casos)('%s → %i %s, con texto propio y details.reason', (codigo, status, code) => {
    const f = falloGithub(new ErrorGithub(codigo, `mensaje interno ${PAT}`, 500), false);
    expect(f?.error.status).toBe(status);
    expect(f?.error.code).toBe(code);
    expect(f?.error.message).not.toContain(PAT);
    expect(f?.error.message).not.toContain('mensaje interno');
    expect(f?.error.details?.reason).toBe(codigo === 'token_invalido' ? 'unauthorized' : codigo);
    expect(f?.codigo).toBe(codigo);
  });

  it('formato malo marca el campo; limite_github trae Retry-After (el de GitHub o 60)', () => {
    expect(falloGithub(new ErrorGithub('ref_invalida', 'x'), false)?.error.details).toMatchObject({ field_errors: { ref: expect.any(Array) } });
    expect(falloGithub(new ErrorGithub('limite_github', 'x', 403, 120), false)?.retryAfterS).toBe(120);
    expect(falloGithub(new ErrorGithub('limite_github', 'x', 429, null), true)?.retryAfterS).toBe(60);
    expect(falloGithub(new ErrorGithub('github_red', 'x'), false)?.retryAfterS).toBeNull();
  });

  it('con o sin conexión el texto cambia; lo que no es de GitHub no se traduce', () => {
    const sin = falloGithub(new ErrorGithub('repo_no_encontrado', 'x', 404), false)?.error.message;
    const con = falloGithub(new ErrorGithub('repo_no_encontrado', 'x', 404), true)?.error.message;
    expect(sin).toContain('conecta tu GitHub');
    expect(con).not.toBe(sin);
    expect(falloGithub(new ErrorWiki('sin_llm', 'x'), false)).toBeNull();
    expect(falloGithub(new Error('x'), false)).toBeNull();
  });
});
