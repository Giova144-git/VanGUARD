import { describe, expect, it } from 'vitest';
import { estadoPaso } from './pasos';

const cob = (missing: ('supabase' | 'cloudflare' | 'codebase' | 'performance')[]) => ({ coverage: { seen: 4 - missing.length, total: 4, missing } });

describe('estadoPaso', () => {
  it('traduce los estados del servidor', () => {
    expect(estadoPaso(cob([]), { name: 'supabase', status: 'pending' })).toBe('pendiente');
    expect(estadoPaso(cob([]), { name: 'supabase', status: 'running' })).toBe('corriendo');
    expect(estadoPaso(cob([]), { name: 'repo', status: 'skipped' })).toBe('sin_mirar');
    expect(estadoPaso(cob([]), { name: 'psi', status: 'failed' })).toBe('error');
  });
  it('nunca pinta hecho un paso cuyo módulo quedó en coverage.missing', () => {
    expect(estadoPaso(cob(['codebase']), { name: 'repo', status: 'done' })).toBe('sin_mirar');
    expect(estadoPaso(cob(['codebase']), { name: 'supabase', status: 'done' })).toBe('hecho');
    expect(estadoPaso({ coverage: null }, { name: 'resumen_ia', status: 'done' })).toBe('hecho');
  });
});
