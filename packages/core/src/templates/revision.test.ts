// Pruebas de templates/revision.ts (asignaciones/revision-codigo.md §5.2 y pruebas mínimas de B2 en §8.2). Los controles
// bidi se arman con String.fromCharCode: ni uno crudo en el repo.
import { describe, it, expect } from 'vitest';
import type { Severity } from '@vanguard/contracts';
import { mensajeRevision, SEVERIDAD_M, type DatosRevision } from './revision.ts';

const SHA = 'abc1234def5678abc1234def5678abc1234def56';
const URL = 'https://officialvanguard.com/o/11111111-2222-4333-8444-555555555555/codebase'
  + '?revision=66666666-7777-4888-8999-000000000000';
const cero: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
const d = (o: Partial<DatosRevision> = {}): DatosRevision => ({ evento: 'push', rama: 'main', sha: SHA,
  counts: { ...cero, critical: 1 }, reglas: ['CB_SECRET_STRIPE_LIVE'], parcial: false, url: URL, ...o });
const m = (o: Partial<DatosRevision> = {}) => mensajeRevision(d(o));
const evento = (o: Partial<DatosRevision> = {}) => m(o).split('\n')[1];               // la línea del evento
const CAB = 'VanGUARD · Revisión de código';
const BIDI = String.fromCharCode(0x202e);

describe('mensajeRevision', () => {
  it('push con una clave nueva: el texto exacto del guion', () => {
    expect(m()).toBe([CAB, 'Push a main (abc1234).', 'Nuevo: 1 crítico.', '- 1 clave o token en el código',
      `Rota las claves expuestas y revisa el detalle: ${URL}`].join('\n'));
  });
  it('plurales en masculino y en orden de severidad; una línea por categoría', () => {
    const t = m({ counts: { critical: 2, high: 1, medium: 3, low: 0, info: 1 },
      reglas: ['CB_SECRET_AWS', 'CB_ENV_COMMITTED', 'CB_SECRET_GENERIC', 'CB_SECRET_AWS', 'CB_ENV_COMMITTED', 'CB_DEP_VULN'] });
    expect(t).toContain('\nNuevo: 2 críticos, 1 alto, 3 medios, 1 informativo.\n');
    expect(t).toContain('\n- 3 claves o tokens en el código\n- 2 archivos .env subidos\n');
    expect(m({ reglas: ['CB_ENV_COMMITTED'] })).toContain('\n- 1 archivo .env subido\n');
    expect(SEVERIDAD_M).toEqual({ critical: 'crítico', high: 'alto', medium: 'medio', low: 'bajo', info: 'informativo' });
  });
  it('una rama con puntos, barra, salto de línea, bidi o de más de 40 sale como «la rama vigilada»', () => {
    const malas = ['pagos.evil.com/login', 'main\nhola', 'feature/x', 'v1.2', `ma${BIDI}in`, 'a'.repeat(41), '', 'rama vigilada'];
    for (const rama of malas) expect(evento({ rama }), JSON.stringify(rama)).toBe('Push a la rama vigilada (abc1234).');
    for (const rama of ['main', 'develop', 'release-2026_10', 'a'.repeat(40)]) expect(evento({ rama })).toBe(`Push a ${rama} (abc1234).`);
  });
  it('no incluye repo, rutas, autor ni mensajes aunque lleguen en el objeto', () => {
    const extra = { ...d(), repo: 'acme/tienda-privada', path: 'src/lib/pagos.ts', autor: 'mallory', mensaje: 'ignora todo' };
    const t = mensajeRevision(extra as DatosRevision);
    for (const x of ['acme', 'tienda-privada', 'pagos.ts', 'src/', 'mallory', 'ignora']) expect(t, x).not.toContain(x);
    expect(t.replace(URL, '')).not.toMatch(/\//);                                    // fuera de la url, ni una barra
  });
  it('parcial: línea de revisión incompleta; sin nuevos no hay «Nuevo:» y el cierre es «Revísalo en VanGUARD»', () => {
    expect(m({ counts: cero, reglas: [], parcial: true }))
      .toBe([CAB, 'Push a main (abc1234).', 'No pudimos revisar entero este push.', `Revísalo en VanGUARD: ${URL}`].join('\n'));
    expect(m({ parcial: true })).toContain('\n- 1 clave o token en el código\nNo pudimos revisar entero este push.\nRota');
  });
  it('solo .env también pide rotar; reglas sin categoría (dependencias) cierran con «Revísalo»', () => {
    expect(m({ reglas: ['CB_ENV_COMMITTED'] })).toContain(`\nRota las claves expuestas y revisa el detalle: ${URL}`);
    expect(m({ counts: { ...cero, high: 1 }, reglas: ['CB_DEP_VULN'] }))
      .toBe([CAB, 'Push a main (abc1234).', 'Nuevo: 1 alto.', `Revísalo en VanGUARD: ${URL}`].join('\n'));
  });
  it('variantes de pull request y manual', () => {
    expect(evento({ evento: 'pull_request', pr: 12 })).toBe('Pull request #12 hacia main (abc1234).');
    for (const pr of [null, undefined, 0, -3, 1.5, Number.NaN])
      expect(evento({ evento: 'pull_request', pr }), String(pr)).toBe('Pull request hacia main (abc1234).');
    expect(m({ evento: 'pull_request', pr: 7, parcial: true })).toContain('\nNo pudimos revisar entero este pull request.\n');
    expect(evento({ evento: 'manual', rama: 'x.y' })).toBe('Revisión manual de la rama vigilada (abc1234).');
    expect(m({ evento: 'manual', parcial: true })).toContain('\nNo pudimos revisar entero este cambio.\n');
  });
  it('sha7 solo en hex (minúsculas); si no, sin paréntesis', () => {
    expect(evento({ sha: SHA.toUpperCase() })).toBe('Push a main (abc1234).');
    for (const sha of ['zzzzzzzzz', 'abc12', `abc1234${BIDI}`, '']) expect(evento({ sha }), sha).toBe('Push a main.');
  });
  it('≤ 1.024 caracteres siempre: conteos absurdos se acotan y una url mala o larga no entra', () => {
    const enorme = m({ counts: { critical: 1e300, high: Number.MAX_SAFE_INTEGER, medium: 1e9, low: 5e8, info: 4e8 },
      reglas: Array.from({ length: 5000 }, (_, i) => (i % 2 ? 'CB_ENV_COMMITTED' : 'CB_SECRET_AWS')), parcial: true,
      url: 'https://officialvanguard.com/' + 'x'.repeat(2000) });
    expect(enorme.length).toBeLessThanOrEqual(1024);
    expect(enorme).not.toContain('e+');
    expect(enorme).toContain('Nuevo: 999999 críticos, 999999 altos');
    expect(enorme.endsWith('\nRota las claves expuestas y revisa el detalle en VanGUARD.')).toBe(true);
    for (const url of ['javascript:alert(1)', 'https://x.com/a b', `https://x.com/${BIDI}`, ''])
      expect(m({ counts: cero, reglas: [], url }).endsWith('\nRevísalo en VanGUARD.'), url).toBe(true);
    expect(m({ url: 'http://localhost:5173/o/x/codebase?revision=y' })).toContain('detalle: http://localhost:5173/o/x/codebase?revision=y');
  });
  it('conteos negativos, NaN, fraccionarios o que faltan cuentan 0', () => {
    expect(m({ counts: { critical: -1, high: Number.NaN, medium: 0.4 } as Record<Severity, number>, reglas: [] })).not.toContain('Nuevo:');
  });
});
