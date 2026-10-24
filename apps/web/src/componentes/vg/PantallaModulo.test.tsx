// PantallaModulo y L3 (PLAN_MAESTRO §14.1): rojo solo con una acción al lado. `sin_conexion` es «aún no hay conexión»
// (apps/api/src/estado/modulo.ts): no es un fallo y no pinta rojo; lo explica el «Conecta …». Un token inválido sí pinta
// la chapa roja, pero con «Reconectar» al lado. Sin jsdom: renderToStaticMarkup con la caché precargada, como el arnés
// de src/seguridad/xss.test.tsx.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, ConnectionPublic, EstadoModulo, type Module, type Provider } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { TINTE } from '@/lib/severidad';
import { PantallaModulo } from './PantallaModulo';

// supabase-js pide VITE_SUPABASE_URL al importarse; aquí no hay red ni sesión.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const ORG = fx.me.orgs[0]!.id;
const ORG_ACTUAL: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const CONEXIONES = z.array(ConnectionPublic).parse(fx.connections);
type Prov = Exclude<Provider, 'ingest'>;
const MODULOS: [Module, Prov, string][] = [['supabase', 'supabase', 'Supabase'], ['cloudflare', 'cloudflare', 'Cloudflare'], ['codebase', 'github', 'GitHub']];
type Estado = z.infer<typeof EstadoModulo>;

// Lo que responde el BACK cuando no puede leer (fallo() de estado/modulo.ts): cifras con n:null, checks sin comprobar y,
// en una org sin hallazgos, contador a 0 y «Ahora» vacío.
function falla(m: Module, error: NonNullable<Estado['error']>): Estado {
  const base = fx.moduleState[m] as Estado;
  return EstadoModulo.parse({
    ok: false, error, hora: base.hora, contador: { rojo: 0, aviso: 0, cola: 0 }, ahora: [],
    cifras: base.cifras.map((c) => ({ tipo: c.tipo, etiqueta: c.etiqueta, n: null, ...(c.de !== undefined ? { de: c.de } : {}),
      ...(c.unidad ? { unidad: c.unidad } : {}), ...(c.decimales !== undefined ? { decimales: c.decimales } : {}) })),
    checks: base.checks.map((c) => ({ ...c, n: null, comprobado: false })),
  });
}

function pintar(m: Module, proveedor: Prov | null, estado: Estado, conexiones: ConnectionPublic[]): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['org', ORG, 'module', m], estado);
  qc.setQueryData(['org', ORG, 'connections'], conexiones);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/o/${ORG}/${m}`]}>
        <OrgDePrueba org={ORG_ACTUAL}><PantallaModulo modulo={m} proveedor={proveedor} /></OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Chapas rojas: el tinte `mal` de Etiqueta (la píldora de MarcasContador lleva otras clases).
const chapasRojas = (html: string) => [...html.matchAll(/<span class="([^"]*)">([\s\S]*?)<\/span>/g)]
  .filter(([, cls]) => cls!.includes(TINTE.mal)).map(([, , texto]) => texto!.replace(/<[^>]+>/g, ''));
const leida = (p: Prov) => CONEXIONES.find((x) => x.provider === p && x.kind === 'read')!;
const reconectar = (p: Prov) => new RegExp(`<a [^>]*href="/o/${ORG}/connections/${p}"[^>]*>Reconectar<`);

describe('PantallaModulo · sin_conexion no pinta rojo (L3)', () => {
  it.each(MODULOS)('%s sin conexión: sin chapa roja ni «No llegamos», con el «Conecta …»', (m, p, nombre) => {
    for (const conexiones of [[], CONEXIONES.filter((x) => x.provider !== p)]) {
      const html = pintar(m, p, falla(m, 'sin_conexion'), conexiones);
      expect(chapasRojas(html)).toEqual([]);
      expect(html).not.toContain('text-mal');
      expect(html).not.toContain('No llegamos');
      expect(html).not.toContain('Reconectar');
      expect(html).toContain(`Conecta ${nombre} para ver este módulo`);
      expect(html).toContain(`Conectar ${nombre}`);
    }
  });

  it.each(MODULOS)('%s con su conexión activa y sin_conexion del BACK: «Sin conexión activa» neutra, sin rojo', (m, p) => {
    const html = pintar(m, p, falla(m, 'sin_conexion'), CONEXIONES);
    expect(chapasRojas(html)).toEqual([]);
    expect(html).toContain('Sin conexión activa');
    expect(html).toContain(TINTE.neutra);
    expect(html).not.toContain('Reconectar');
  });

  it('Rendimiento (proveedor null) con sin_conexion: sin chapa roja, sin «Reconectar» y sin «Conecta …»', () => {
    const conDatos = { ...(fx.moduleState.performance as Estado), ok: false, error: 'sin_conexion' as const };
    for (const estado of [falla('performance', 'sin_conexion'), conDatos]) {
      for (const conexiones of [[], CONEXIONES]) {
        const html = pintar('performance', null, estado, conexiones);
        expect(chapasRojas(html)).toEqual([]);
        expect(html).not.toContain('No llegamos');
        expect(html).not.toContain('Reconectar');
        expect(html).not.toContain('Conecta ');
      }
    }
    // Sin ninguna cifra medida, el vacío propio de Rendimiento.
    expect(pintar('performance', null, falla('performance', 'sin_conexion'), [])).toContain('Aún no medimos tu web');
  });
});

describe('PantallaModulo · un fallo de verdad sí pinta rojo, con su acción al lado (L3)', () => {
  it.each(MODULOS)('%s con token_invalido: chapa roja «Token inválido · Reconectar» y el enlace «Reconectar» justo después', (m, p) => {
    for (const conexiones of [CONEXIONES, []]) {
      const html = pintar(m, p, falla(m, 'token_invalido'), conexiones);
      expect(chapasRojas(html)).toEqual(['Token inválido · Reconectar']);
      expect(html).toMatch(new RegExp(`Token inválido · Reconectar</span>${reconectar(p).source}`));
    }
  });

  it.each(MODULOS)('%s con la conexión en error: cada chapa roja comparte barra con «Reconectar»', (m, p) => {
    const conexiones = CONEXIONES.map((x) => (x.id === leida(p).id ? { ...x, status: 'error' as const } : x));
    const html = pintar(m, p, falla(m, 'token_invalido'), conexiones);
    expect(chapasRojas(html)).toEqual(['La conexión falla', 'Token inválido · Reconectar']);
    expect(html.match(new RegExp(reconectar(p).source, 'g'))).toHaveLength(1);
  });

  it('control: sin_permiso pinta la chapa roja con «Ver» al lado', () => {
    const html = pintar('supabase', 'supabase', falla('supabase', 'sin_permiso'), CONEXIONES);
    expect(chapasRojas(html)).toEqual(['Falta un permiso · Ver']);
    expect(html).toMatch(new RegExp(`Falta un permiso · Ver</span><a [^>]*href="/o/${ORG}/connections/supabase"[^>]*>Ver<`));
  });
});

describe('PantallaModulo · errores fuera de contrato y límite de la API', () => {
  // api() en producción deja pasar un cuerpo que no cumple el contrato: el texto de la chapa sale de deMapa.
  it.each(['__proto__', 'constructor', 'toString', 'zzz'])('error %j: no lanza y la chapa roja dice «No pudimos leer», nunca vacía', (k) => {
    const estado = { ...falla('supabase', 'token_invalido'), error: k as Estado['error'] };
    const html = pintar('supabase', 'supabase', estado, CONEXIONES);
    expect(chapasRojas(html)).toEqual(['No pudimos leer']);
    expect(html).not.toContain('[object');
    expect(html).not.toContain('native code');
  });

  it('limite_api se reintenta solo: chapa neutra, sin rojo (L3)', () => {
    const html = pintar('supabase', 'supabase', falla('supabase', 'limite_api'), CONEXIONES);
    expect(chapasRojas(html)).toEqual([]);
    expect(html).toContain('Límite de la API · reintentamos en 1 min');
  });
});
