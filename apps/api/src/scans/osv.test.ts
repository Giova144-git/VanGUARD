import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ProviderError } from '../lib/http.ts';
import { arregloDe, cmpVersion, dedupeAvisos, depsVulnerables, detallar, esTransitorio, filaDep, type Dep } from './osv.ts';

// Fixtures JSON sin red (§15.13: dos ids con el mismo alias CVE → un hallazgo).
const lodash: Dep = { ecosystem: 'npm', name: 'lodash', version: '4.17.15', dev: false };
const rango = (intro: string, fixed: string, name = 'lodash') =>
  ({ package: { name, ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: intro }, { fixed }] }] });

describe('osv', () => {
  it('compara versiones por segmentos numéricos', () => {
    expect(cmpVersion('1.10.0', '1.9.9')).toBe(1);
    expect(cmpVersion('4.17.15', '4.17.21')).toBe(-1);
    expect(cmpVersion('v2.5.2', '2.5.2')).toBe(0);
  });

  it('dos ids con el mismo alias CVE son un solo aviso', () => {
    const a = [
      { id: 'GO-2021-0113', aliases: ['CVE-2021-38561'] },
      { id: 'GHSA-ppp9-7jff-5vj2', aliases: ['CVE-2021-38561'], database_specific: { severity: 'HIGH' } },
    ];
    expect(dedupeAvisos(a)).toHaveLength(1);
    expect(filaDep(lodash, a).evidence.n_avisos).toBe(1);
  });

  it('el arreglo sale solo del rango del mismo paquete que contiene la versión', () => {
    const aviso = { id: 'GHSA-x', affected: [rango('0', '4.17.21'), rango('0', '9.9.9', 'lodash-es')] };
    expect(arregloDe(aviso, lodash)).toBe('4.17.21');
    expect(arregloDe({ id: 'GHSA-y', affected: [rango('4.18.0', '4.18.1')] }, lodash)).toBeNull();
  });

  it('un hallazgo por paquete con la mayor severidad, el mayor arreglo, CVE visible y ≤ 10 avisos', () => {
    const avisos = Array.from({ length: 12 }, (_, i) => ({
      id: `GHSA-${i}`, aliases: [`CVE-2026-${1000 + i}`],
      database_specific: { severity: i === 3 ? 'HIGH' : 'MODERATE' },
      affected: [rango('0', i === 5 ? '4.18.0' : '4.17.21')],
    }));
    const f = filaDep(lodash, avisos);
    expect(f.rule_id).toBe('CB_DEP_VULN');
    expect(f.severity).toBe('high');
    expect(f.resource).toBe('npm:lodash@4.17.15');
    expect(f.evidence.version_arreglo).toBe('4.18.0');
    expect(f.evidence.n_avisos).toBe(12);
    expect((f.evidence.avisos as unknown[]).length).toBe(10);
    expect((f.evidence.avisos as { id: string }[])[0]?.id).toBe('CVE-2026-1003');
    expect(f.evidence.urgencia).toBe('hoy');
  });

  it('MAL-* es critical con urgencia ahora; sin severidad es medium por defecto', () => {
    expect(filaDep(lodash, [{ id: 'MAL-2026-1' }]).severity).toBe('critical');
    expect(filaDep(lodash, [{ id: 'MAL-2026-1' }]).evidence.urgencia).toBe('ahora');
    const sin = filaDep(lodash, [{ id: 'PYSEC-1' }]);
    expect(sin.severity).toBe('medium');
    expect((sin.evidence.avisos as { severidad_por_defecto?: boolean }[])[0]?.severidad_por_defecto).toBe(true);
  });
});

// OSV caído (hallazgos 8 y 17): fetch simulado, sin red.
describe('osv · fallos', () => {
  type Fetch = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  let f: Mock<Fetch>;
  const jquery: Dep = { ecosystem: 'npm', name: 'jquery', version: '3.4.0', dev: false };
  beforeEach(() => { f = vi.fn<Fetch>(); vi.stubGlobal('fetch', f); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('esTransitorio: red, plazo, 429 y 5xx sí; 4xx y errores sueltos no', () => {
    expect(esTransitorio(new ProviderError('unavailable', 503))).toBe(true);
    expect(esTransitorio(new ProviderError('rate_limited', 429))).toBe(true);
    expect(esTransitorio(new ProviderError('timeout'))).toBe(true);
    expect(esTransitorio(new ProviderError('invalid', 400))).toBe(false);
    expect(esTransitorio(new SyntaxError('json'))).toBe(false);
  });

  it('querybatch: un 503 se reintenta una vez dentro del mensaje', async () => {
    f.mockResolvedValueOnce(new Response('x', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ results: [{}, { vulns: [{ id: 'GHSA-1' }] }] }));
    expect(await depsVulnerables([lodash, jquery], 0)).toEqual({ vulnerables: [1], subpeticiones: 2 });
  });

  it('querybatch: dos 503 seguidos lanzan el ProviderError transitorio (el paso decide el reintento de cola)', async () => {
    f.mockImplementation(async () => new Response('x', { status: 503 }));
    await expect(depsVulnerables([lodash], 0)).rejects.toMatchObject({ code: 'unavailable' });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('querybatch: un 400 no se reintenta', async () => {
    f.mockResolvedValue(new Response('x', { status: 400 }));
    await expect(depsVulnerables([lodash], 0)).rejects.toMatchObject({ code: 'invalid' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('detallar: un /query caído cuenta como fallido (su fila entra sin_detalle); un 400 no', async () => {
    f.mockImplementation(async (_u, init) => {
      const nombre = (JSON.parse(String(init?.body)) as { package: { name: string } }).package.name;
      return nombre === 'lodash' ? new Response('x', { status: 502 }) : new Response('x', { status: 400 });
    });
    const r = await detallar([lodash, jquery]);
    expect(r.fallidos).toBe(1);
    expect(r.errores).toBe(2);   // el 400 no vuelve a la cola, pero deja OSV incompleto (sin auto-verificar)
    expect(r.filas.map((x) => x.evidence.sin_detalle)).toEqual([true, true]);
  });

  // Cuerpo que se corta después de las cabeceras: 200, empieza el JSON y la red cae (revisión del hallazgo 17).
  const cortado = () => new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode('{"results":[')); c.error(new TypeError('Network connection lost.')); },
  }), { status: 200 });

  it('querybatch: un cuerpo cortado a mitad es transitorio y se reintenta dentro del mensaje', async () => {
    f.mockImplementationOnce(async () => cortado())
      .mockResolvedValueOnce(Response.json({ results: [{ vulns: [{ id: 'GHSA-1' }] }] }));
    expect(await depsVulnerables([lodash], 0)).toEqual({ vulnerables: [0], subpeticiones: 2 });
  });

  it('querybatch: dos cuerpos cortados lanzan ProviderError unavailable (no un TypeError que la cola no reintenta)', async () => {
    f.mockImplementation(async () => cortado());
    const e = await depsVulnerables([lodash], 0).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(esTransitorio(e)).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('un 200 que no es JSON también es transitorio', async () => {
    f.mockImplementation(async () => new Response('<html>proxy</html>', { status: 200 }));
    await expect(depsVulnerables([lodash], 0)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('detallar: un /query con el cuerpo cortado cuenta como fallido', async () => {
    f.mockImplementation(async () => cortado());
    const r = await detallar([lodash]);
    expect(r).toMatchObject({ fallidos: 1, errores: 1 });
    expect(r.filas[0]?.evidence.sin_detalle).toBe(true);
  });

  it('detallar: el plazo vencido mientras se lee el cuerpo es timeout (transitorio)', async () => {
    f.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.error(new DOMException('plazo', 'TimeoutError')); },
    }), { status: 200 }));
    expect((await detallar([lodash])).fallidos).toBe(1);
    await expect(depsVulnerables([lodash], 0)).rejects.toMatchObject({ code: 'timeout' });
  });
});
