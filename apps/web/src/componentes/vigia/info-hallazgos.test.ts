// «Info» de un problema concreto. El catálogo de reglas no existe como lista exportada: lo forman las reglas que emiten
// packages/core y apps/api (`rule_id: '…'` en el código que no es de pruebas), las que documenta el prompt núcleo de la
// IA (apps/api/src/ia/prompts/nucleo.ts) y los avisos del advisor que traduce core (TITULOS_ADVISOR). La web no puede
// importar @vanguard/core (scripts/lint-imports.mjs también mira las pruebas), así que se leen del disco como texto.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hallazgoVisto, infoDeHallazgo, marcaHallazgo, MAX_RECURSO, MODULO, recursoCorto, REGLAS, textoRegla } from './info-hallazgos';

const RAIZ = fileURLToPath(new URL('../../../../../', import.meta.url));
const ts = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === 'node_modules' ? [] : ts(join(dir, e.name)))
    : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []);
const leer = (f: string) => readFileSync(join(RAIZ, f), 'utf8');

// 1. Lo que el código emite de verdad.
const emitidas = new Set([join(RAIZ, 'packages/core/src'), join(RAIZ, 'apps/api/src')].flatMap(ts)
  .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/rule_id:\s*'((?:SB|CF|CB|PF)_[A-Z0-9_]+)'/g)].map((m) => m[1]!)));
// SB_ADVISOR_ + nombre del lint en mayúsculas (core/rules/supabase.ts): los que core traduce.
const advisor = [...leer('packages/core/src/templates/titles.ts').matchAll(/\['([a-z_]+)', '[^']+'\]/g)].map((m) => `SB_ADVISOR_${m[1]!.toUpperCase()}`);
// 2. Lo que la IA conoce: líneas «REGLA[, REGLA]: explicación» del prompt núcleo. «X_*» y «X_<algo>» son familias.
const nucleo = leer('apps/api/src/ia/prompts/nucleo.ts').split('\n')
  .flatMap((l) => /^((?:SB|CF|CB|PF)_[A-Z0-9_<>*a-z]*(?:, (?:SB|CF|CB|PF)_[A-Z0-9_<>*a-z]*)*):/.exec(l)?.[1]!.split(', ') ?? []);
const familias = nucleo.filter((r) => /[*<]/.test(r)).map((r) => r.replace(/[*<].*$/, ''));
const concretas = [...new Set([...emitidas, ...advisor, ...nucleo.filter((r) => !/[*<]/.test(r))])]
  .filter((r) => r !== 'SB_ADVISOR_');                          // prefijo: lo cubren los lints de `advisor`

describe('catálogo de reglas', () => {
  it('se encuentra (si cambia de sitio, esta prueba tiene que seguirlo)', () => {
    expect(emitidas.size).toBeGreaterThanOrEqual(25);
    expect(advisor.length).toBe(12);
    expect(nucleo.length).toBeGreaterThanOrEqual(15);
    for (const r of ['SB_RLS_DISABLED', 'CF_SITE_CORS', 'CB_SECRET_AWS', 'CB_DEP_VULN', 'PF_REGRESSION']) expect(concretas).toContain(r);
  });

  it('cada regla del catálogo tiene su texto', () => {
    for (const r of concretas) expect(textoRegla(r), r).not.toBeNull();
  });

  it('las familias de la IA (CF_DNS_*, CF_TLS_*, CB_SECRET_<tipo>) también; los avisos del advisor sin traducir van por módulo', () => {
    for (const p of familias.filter((f) => f !== 'SB_ADVISOR_')) expect(textoRegla(`${p}NUEVO_99`), p).not.toBeNull();
    expect(textoRegla('SB_ADVISOR_ALGO_NUEVO')).toBeNull();
    expect(infoDeHallazgo({ id: 'x', module: 'supabase', rule_id: 'SB_ADVISOR_ALGO_NUEVO' }).titulo).toBe(MODULO.supabase.titulo);
  });

  it('no sobran textos: cada entrada es una regla del catálogo', () => {
    expect(Object.keys(REGLAS).filter((r) => !concretas.includes(r))).toEqual([]);
  });
});

describe('textos', () => {
  it('fijos, en 1–3 frases llanas, y caben en la burbuja con el recurso al lado', () => {
    for (const { titulo, texto } of [...Object.values(REGLAS), ...Object.values(MODULO)]) {
      for (const t of [titulo, texto]) expect(t, t).not.toMatch(/[{}<>$`]/);
      expect(titulo.length, titulo).toBeLessThanOrEqual(40);
      expect(texto.length, texto).toBeLessThanOrEqual(220);
      expect(texto.split(/[.!?](?:\s|$)/).filter((x) => x.trim()).length, texto).toBeLessThanOrEqual(3);
    }
  });

  it('textoRegla no cae en el prototipo ni acepta un prefijo pelado', () => {
    for (const x of ['__proto__', 'constructor', 'toString', '', 'CB_SECRET_', null, 3]) expect(textoRegla(x), String(x)).toBeNull();
  });
});

describe('infoDeHallazgo', () => {
  it('explica ESE problema: la regla, su recurso y cuánta prisa corre', () => {
    const i = infoDeHallazgo({ id: 'x', module: 'supabase', rule_id: 'SB_RLS_DISABLED', severity: 'critical', resource: 'public.pedidos' });
    expect(i.titulo).toBe('Tabla sin RLS');
    expect(i.texto).toBe(`${REGLAS.SB_RLS_DISABLED!.texto} Afecta a «public.pedidos». Gravedad crítica: arréglalo hoy.`);
  });

  it('sin gravedad (bandeja de un módulo), la dice por su rol; sin regla ni módulo conocidos, un texto general', () => {
    expect(infoDeHallazgo({ id: 'x', rule_id: 'CB_ENV_COMMITTED', rol: 'mal' }).texto).toMatch(/Es urgente: arréglalo cuanto antes\.$/);
    const g = infoDeHallazgo({ id: 'x', module: '__proto__', rule_id: 'XX', severity: 'constructor' });
    expect(g.titulo).toBe('Problema');
    expect(g.texto).not.toMatch(/Gravedad|Afecta/);
    expect(infoDeHallazgo(null).titulo).toBe('Problema');
  });

  it('un hallazgo de la IA (regla desconocida) se explica por su módulo y su gravedad', () => {
    const i = infoDeHallazgo({ id: 'x', module: 'codebase', rule_id: 'CB_AI_LOGICA_PAGOS', severity: 'high', resource: 'src/pagos.ts' });
    expect(i.titulo).toBe(MODULO.codebase.titulo);
    expect(i.texto).toContain('Afecta a «src/pagos.ts». Gravedad alta: arréglalo esta semana.');
  });
});

describe('recursoCorto (lo único del servidor que entra en la burbuja)', () => {
  it('controles bidi a la vista, en una línea y recortado', () => {
    expect(recursoCorto('src/lib/‮sj.nimda')).toBe('src/lib/⟨U+202E⟩sj.nimda');
    expect(recursoCorto('a\nb\r\n\tc d')).toBe('a b c d');
    const largo = recursoCorto('x'.repeat(10_000));
    expect(Array.from(largo)).toHaveLength(MAX_RECURSO);
    expect(largo.endsWith('…')).toBe(true);
    expect(recursoCorto(undefined)).toBe('');
  });

  it('el HTML queda como texto (lo escapa React al pintarlo; aquí no se toca)', () => {
    expect(recursoCorto('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });
});

describe('marcaHallazgo', () => {
  const ID = 'c3d40000-0000-4000-8000-0000000000aa';
  it('anota lo que pinta la fila y da el atributo; sin un UUID, nada', () => {
    expect(marcaHallazgo({ id: ID, rule_id: 'SB_RLS_DISABLED', resource: 'public.x' })).toEqual({ 'data-hallazgo': ID });
    expect(hallazgoVisto(ID)).toMatchObject({ id: ID, rule_id: 'SB_RLS_DISABLED', resource: 'public.x' });
    expect(marcaHallazgo({ id: `${ID}" onclick="x` })).toEqual({});
    expect(hallazgoVisto(`${ID}" onclick="x`)).toBeNull();
  });

  it('solo guarda los campos que usa el menú (no la evidencia) y una fila nueva completa a la anterior', () => {
    marcaHallazgo({ id: ID, severity: 'high', evidence: { secreto: 'sk_live_x' } } as never);
    const v = hallazgoVisto(ID)!;
    expect(v).toMatchObject({ rule_id: 'SB_RLS_DISABLED', severity: 'high' });
    expect(JSON.stringify(v)).not.toContain('sk_live');
  });
});
