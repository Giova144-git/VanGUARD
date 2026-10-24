import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, Contact } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));

// getKeys de mentira (B1): una FPK de bytes conocidos por kid, para comprobar el código con node:crypto, contar las
// llamadas por petición y ver que el kid es el fijo (activeKid diría 'v2').
const llaves = vi.hoisted(() => ({ kids: [] as string[], falla: false }));
const bytesDe = (kid: string) => new Uint8Array(32).fill(kid === 'v1' ? 0x11 : 0x22);
vi.mock('../lib/keyring.ts', () => ({
  getKeys: async (_env: unknown, _admin: unknown, kid: string) => {
    llaves.kids.push(kid);
    if (llaves.falla) throw new Error('CRYPTO_MATERIAL_UNAVAILABLE');
    const fpk = await crypto.subtle.importKey('raw', bytesDe(kid), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return { kid, kek: fpk, fpk };
  },
  activeKid: async () => 'v2',
}));

const { app } = await import('../app.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const C1 = 'c0c00000-0000-4000-8000-000000000001';
const C2 = 'c0c00000-0000-4000-8000-000000000002';
const C3 = 'c0c00000-0000-4000-8000-000000000003';
const ORG2 = '0f6c0000-0000-4000-8000-000000000002';
const NUMERO = '15550100';
const urlDe = (org: string) => `https://officialvanguard.com/api/orgs/${org}/contacts`;

let rol: string;
let anon: boolean;
let tabla: (op: Op) => Resp | undefined;
let rpc: (name: string, args: Record<string, unknown>) => Resp | undefined;
let doble: ReturnType<typeof dbDoble>;

const fila = (o: Record<string, unknown> = {}) => ({ id: C1, org_id: ORG, name: 'Gabriel', phone_e164: '+584141234567', whatsapp: true,
  voice: true, priority: 1, verified_at: '2026-10-24T14:00:00.123456+00:00', created_at: '2026-10-24T13:00:00+00:00', ...o });

beforeEach(() => {
  rol = 'owner';
  anon = false;
  llaves.kids.length = 0;
  llaves.falla = false;
  tabla = () => undefined;
  rpc = () => undefined;
  doble = dbDoble({
    tabla: (op) => (op.table === 'org_members' ? { data: { role: rol } } : tabla(op)),
    rpc: (n, a) => rpc(n, a),
    claims: (tok) => (tok === 'ana' ? { sub: ANA, email: anon ? undefined : 'ana@acme.dev', is_anonymous: anon } : null),
  });
  estado.client = doble.client;
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sin red en las pruebas'); }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const pedir = (method: 'GET' | 'PUT', body?: unknown, o: { org?: string; env?: Partial<CloudflareBindings> } = {}) =>
  app.request(urlDe(o.org ?? ORG), {
    method, headers: { authorization: 'Bearer ana', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, envDoble(o.env).env);
const error = async (r: Response) => ApiErrorBody.parse(await r.json()).error;

describe('E26 · GET contacts', () => {
  it('admin → 200 Contact[] con verified_at en …Z, filtrado por org y ordenado por prioridad', async () => {
    rol = 'admin';
    tabla = (op) => (op.table === 'contacts' ? { data: [fila(), fila({ id: C2, name: 'Carlos', phone_e164: '+584121112233', voice: false,
      priority: 2, verified_at: null })] } : undefined);
    const r = await pedir('GET');
    expect(r.status).toBe(200);
    const b = (await r.json()) as unknown[];
    const lista = b.map((x) => Contact.parse(x));
    expect(lista[0]!.verified_at).toBe('2026-10-24T14:00:00.123Z');
    expect(lista[1]!.verified_at).toBeNull();
    expect(b[0]).not.toHaveProperty('org_id');
    const op = doble.ops.find((o) => o.table === 'contacts')!;
    expect(eqDe(op, 'org_id')).toBe(ORG);
  });

  it('viewer → 403 sin leer teléfonos', async () => {
    rol = 'viewer';
    const r = await pedir('GET');
    expect(r.status).toBe(403);
    expect((await error(r)).code).toBe('forbidden');
    expect(doble.ops.some((o) => o.table === 'contacts')).toBe(false);
  });

  it('sesión anónima (aunque fuese admin) → 403', async () => {
    anon = true;
    expect((await pedir('GET')).status).toBe(403);
  });

  it('error de la base → 500 internal', async () => {
    tabla = (op) => (op.table === 'contacts' ? { error: { code: '57014' } } : undefined);
    const r = await pedir('GET');
    expect(r.status).toBe(500);
    expect((await error(r)).code).toBe('internal');
  });
});

describe('E26 · PUT contacts', () => {
  const lista = [{ name: ' Gabriel ', phone_e164: '+584141234567', whatsapp: true, voice: true, priority: 1 }];

  it('reemplaza con vg_replace_contacts (nunca delete + insert) y devuelve Contact[]', async () => {
    rpc = (n) => (n === 'vg_replace_contacts' ? { data: [fila({ verified_at: null })] } : undefined);
    const r = await pedir('PUT', lista);
    expect(r.status).toBe(200);
    const [c] = ((await r.json()) as unknown[]).map((x) => Contact.parse(x));
    expect(c).toMatchObject({ id: C1, name: 'Gabriel', verified_at: null });
    expect(doble.rpcs).toEqual([{ name: 'vg_replace_contacts', args: { p_org: ORG, p_rows: [{ ...lista[0], name: 'Gabriel' }] } }]);
    expect(doble.ops.some((o) => o.table === 'contacts' && (o.action === 'delete' || o.action === 'insert'))).toBe(false);
  });

  it('lista vacía es válida (la org se queda sin contactos)', async () => {
    rpc = () => ({ data: [] });
    const r = await pedir('PUT', []);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it('teléfono sin + o con letras → 422 invalid_body sin llamar a la RPC', async () => {
    for (const phone_e164 of ['584141234567', '+58414abc4567', '+0123456789']) {
      const r = await pedir('PUT', [{ ...lista[0], phone_e164 }]);
      expect(r.status).toBe(422);
      const e = await error(r);
      expect(e.code).toBe('invalid_body');
      expect(e.details?.field_errors).toBeDefined();
    }
    expect(doble.rpcs).toHaveLength(0);
  });

  it('más de 5, prioridades o teléfonos repetidos → 422', async () => {
    const c = (i: number, o: Record<string, unknown> = {}) => ({ name: `Persona ${i}`, phone_e164: `+58414123456${i}`, whatsapp: true,
      voice: false, priority: i, ...o });
    for (const body of [[1, 2, 3, 4, 5, 6].map((i) => c(i)), [c(1), c(2, { priority: 1 })], [c(1), c(2, { phone_e164: '+584141234561' })]]) {
      expect((await pedir('PUT', body)).status).toBe(422);
    }
    expect(doble.rpcs).toHaveLength(0);
  });

  it('viewer → 403 sin llamar a la RPC', async () => {
    rol = 'viewer';
    expect((await pedir('PUT', lista)).status).toBe(403);
    expect(doble.rpcs).toHaveLength(0);
  });

  it('error de la RPC → 500; 23505 → 409', async () => {
    rpc = () => ({ error: { code: 'XX000' } });
    expect((await pedir('PUT', lista)).status).toBe(500);
    rpc = () => ({ error: { code: '23505' } });
    expect((await error(await pedir('PUT', lista))).code).toBe('conflict');
  });
});

describe('E26 · verificacion (B1)', () => {
  const CON_NUMERO = { env: { KAPSO_DISPLAY_NUMBER: NUMERO } };
  // Referencia independiente: 6 primeros hex de HMAC-SHA256(fpk de v1, contact|org|id), con node:crypto.
  const esperado = (org: string, id: string, kid = 'v1') =>
    createHmac('sha256', bytesDe(kid)).update(`contact|${org}|${id}`).digest('hex').slice(0, 6).toUpperCase();
  const enlace = (cod: string) => `https://wa.me/${NUMERO}?text=` +
    encodeURIComponent(`VERIFICAR ${cod}. Acepto recibir alertas de seguridad de VanGUARD en este WhatsApp. BAJA para salir`);
  const tres = () => [
    fila(),                                                                         // verificado
    fila({ id: C2, name: 'Carlos', phone_e164: '+584121112233', priority: 2, verified_at: null }),
    fila({ id: C3, name: 'Luis', phone_e164: '+584161112233', priority: 3, verified_at: null }),
  ];
  const leer = async (r: Response) => ((await r.json()) as unknown[]).map((x) => Contact.parse(x));

  beforeEach(() => {
    // Si alguien leyera kek_active, sería 'v2': el código cambiaría y las pruebas lo verían.
    tabla = (op) => (op.table === 'contacts' ? { data: tres() } : op.table === 'app_config' ? { data: { value: 'v2' } } : undefined);
  });

  it('solo en contactos con whatsapp=true y sin verificar; null en el resto; una sola getKeys por petición', async () => {
    tabla = (op) => (op.table === 'contacts'
      ? { data: [...tres(), fila({ id: 'c0c00000-0000-4000-8000-000000000004', name: 'Sin WA', phone_e164: '+584261112233',
        whatsapp: false, priority: 4, verified_at: null })] }
      : undefined);
    const r = await pedir('GET', undefined, CON_NUMERO);
    expect(r.status).toBe(200);
    const [verificado, carlos, luis, sinWa] = await leer(r);
    expect(verificado!.verificacion).toBeNull();
    expect(sinWa!.verificacion).toBeNull();
    expect(carlos!.verificacion).toEqual({ codigo: esperado(ORG, C2), enlace: enlace(esperado(ORG, C2)) });
    expect(luis!.verificacion).toEqual({ codigo: esperado(ORG, C3), enlace: enlace(esperado(ORG, C3)) });
    expect(llaves.kids).toEqual(['v1']);
  });

  it('el mismo código entre llamadas, y el PUT devuelve el mismo que el GET', async () => {
    const a = (await leer(await pedir('GET', undefined, CON_NUMERO)))[1]!.verificacion;
    const b = (await leer(await pedir('GET', undefined, CON_NUMERO)))[1]!.verificacion;
    expect(a).toEqual(b);
    rpc = (n) => (n === 'vg_replace_contacts' ? { data: tres() } : undefined);
    const body = tres().map((f) => ({ name: f.name, phone_e164: f.phone_e164, whatsapp: f.whatsapp, voice: f.voice,
      priority: f.priority }));
    const r = await pedir('PUT', body, CON_NUMERO);
    expect(r.status).toBe(200);
    const filas = await leer(r);
    expect(filas[1]!.verificacion).toEqual(a);
    expect(filas[0]!.verificacion).toBeNull();
  });

  it('kid FIJO v1 aunque kek_active sea otro: ni se lee app_config', async () => {
    const [, carlos] = await leer(await pedir('GET', undefined, CON_NUMERO));
    expect(llaves.kids).toEqual(['v1']);
    expect(doble.ops.some((o) => o.table === 'app_config')).toBe(false);
    expect(carlos!.verificacion!.codigo).toBe(esperado(ORG, C2));
    expect(carlos!.verificacion!.codigo).not.toBe(esperado(ORG, C2, 'v2'));
  });

  it('dos orgs con el mismo contacto-id dan códigos distintos', async () => {
    const a = (await leer(await pedir('GET', undefined, CON_NUMERO)))[1]!.verificacion!.codigo;
    const b = (await leer(await pedir('GET', undefined, { ...CON_NUMERO, org: ORG2 })))[1]!.verificacion!.codigo;
    expect(a).toBe(esperado(ORG, C2));
    expect(b).toBe(esperado(ORG2, C2));
    expect(a).not.toBe(b);
  });

  it('sin KAPSO_DISPLAY_NUMBER (o sin forma de 8–15 dígitos) → verificacion null y ni una getKeys', async () => {
    for (const env of [{}, { KAPSO_DISPLAY_NUMBER: '' }, { KAPSO_DISPLAY_NUMBER: '+15550100' }, { KAPSO_DISPLAY_NUMBER: '1555' }]) {
      const r = await pedir('GET', undefined, { env });
      expect(r.status).toBe(200);
      const b = (await r.json()) as Record<string, unknown>[];
      expect(b.map((x) => x.verificacion)).toEqual([null, null, null]);
    }
    expect(llaves.kids).toEqual([]);
  });

  it('nadie pendiente de verificar → ni una getKeys', async () => {
    tabla = (op) => (op.table === 'contacts' ? { data: [fila(), fila({ id: C2, phone_e164: '+584121112233', priority: 2,
      whatsapp: false, verified_at: null })] } : undefined);
    const lista = await leer(await pedir('GET', undefined, CON_NUMERO));
    expect(lista.map((c) => c.verificacion)).toEqual([null, null]);
    expect(llaves.kids).toEqual([]);
  });

  it('si las claves fallan, la lista sale igual (200) sin verificacion y queda el log de error', async () => {
    llaves.falla = true;
    const espia = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await pedir('GET', undefined, CON_NUMERO);
    expect(r.status).toBe(200);
    expect((await leer(r)).map((c) => c.verificacion)).toEqual([null, null, null]);
    const lineas = espia.mock.calls.map((a) => String(a[0]));
    expect(lineas.some((l) => l.includes('contacts.verificacion_error') && l.includes('CRYPTO_MATERIAL_UNAVAILABLE'))).toBe(true);
    expect(lineas.join('\n')).not.toContain('+58412');
  });
});

// 0008i: las columnas de la ventana existen, nadie más que service_role las lee, y el upsert de vg_replace_contacts no las
// toca (la prueba contra la base es supabase/tests/contacts-ventana.sql).
describe('migraciones · contacts.wa_last_inbound_at y optin_at', () => {
  const dir = fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url).href);
  const archivos = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const sql = (f: string) => readFileSync(join(dir, f), 'utf8').toLowerCase().replace(/--.*$/gm, '');

  it('0008i añade las dos columnas timestamptz sin grants a nadie', () => {
    const f = archivos.find((x) => x.startsWith('0008i_'));
    expect(f).toBeDefined();
    const s = sql(f!);
    expect(s).toMatch(/alter table public\.contacts add column if not exists wa_last_inbound_at timestamptz/);
    expect(s).toMatch(/alter table public\.contacts add column if not exists optin_at timestamptz/);
    expect(s).not.toMatch(/\bgrant\b/);
  });

  it('la última definición de vg_replace_contacts solo pone name, whatsapp, voice y priority en el upsert', () => {
    const defs = archivos.filter((f) => sql(f).includes('function public.vg_replace_contacts'));
    const s = sql(defs.at(-1)!);
    const cuerpo = s.slice(s.indexOf('function public.vg_replace_contacts'));
    const desde = cuerpo.indexOf('do update');
    const set = cuerpo.slice(desde, cuerpo.indexOf('returning', desde));
    expect(set.replace(/\s+/g, ' ').trim())
      .toBe('do update set name = excluded.name, whatsapp = excluded.whatsapp, voice = excluded.voice, priority = excluded.priority');
  });
});
