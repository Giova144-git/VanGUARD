import { describe, expect, it } from 'vitest';
import { contextoLlamada, TIPO_LLAMADA } from './voz.ts';

describe('contextoLlamada', () => {
  it('escaneo de rutas: las 5 claves exactas, IP recortada, host de details y eventos de event_count', () => {
    const c = contextoLlamada({ rule_ids: ['CF_PATH_SCAN'], severity: 'critical', resource: 'ip:203.0.113.42',
      details: { host: 'vanguard-demo-victima.pages.dev', ip: '203.0.113.42' }, event_count: 87 });
    expect(c).toEqual({ tipo: 'un escaneo de rutas', host: 'vanguard-demo-victima.pages.dev', ip: '203.0.x.x',
      eventos: '87', severidad: 'crítica' });
    expect(Object.keys(c).sort()).toEqual(['eventos', 'host', 'ip', 'severidad', 'tipo']);
  });

  it('cada regla con su tipo; otra regla → actividad sospechosa; high → alta; sin host → tu sitio', () => {
    expect(contextoLlamada({ rule_ids: ['CF_IP_FLOOD'], severity: 'critical', resource: 'ip:198.51.100.7' }).tipo)
      .toBe(TIPO_LLAMADA.CF_IP_FLOOD);
    expect(contextoLlamada({ rule_ids: ['CF_UA_TOOL'], severity: 'critical', resource: 'ip:198.51.100.7' }).tipo)
      .toBe('una herramienta de ataque');
    const o = contextoLlamada({ rule_ids: ['SB_DB_DOWN'], severity: 'high', resource: 'db', event_count: null });
    expect(o).toEqual({ tipo: 'actividad sospechosa', host: 'tu sitio', ip: 'una IP desconocida', eventos: '1', severidad: 'alta' });
  });

  it('el host pasa por textoSeguro: una línea, sin la IP completa ni claves, y ≤ 80', () => {
    const c = contextoLlamada({ rule_ids: ['CF_PATH_SCAN'], severity: 'critical', resource: 'ip:203.0.113.9',
      details: { host: `ataque 203.0.113.9\n${'x'.repeat(200)}` } });
    expect(c.host).not.toContain('203.0.113.9');
    expect(c.host).not.toContain('\n');
    expect(c.host.length).toBeLessThanOrEqual(80);
  });
});
