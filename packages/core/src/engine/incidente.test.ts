// Decisión del incidente (S15 15.9/15.12, S12 12.3–12.4, M10 de §02.5.1): motivo de aviso, cooldown, tormenta, ventana
// de demo, cierre por inactividad, parámetros de vg_upsert_incident y servicio/regla principal.
import { describe, expect, it } from 'vitest';
import { agruparEdge, evaluarVentanaEdge } from './edge.ts';
import {
  cerrarPorInactividad, dentroDeCooldown, estadoTormenta, fueraDeVentanaDemo, moduloDeRegla, motivoAviso,
  paramsUpsertIncidente, REAPERTURA_MS, reglaPrincipal, RESOLVER_SIN_EVENTOS_MS, SERVICIO_MODULO, servicioDeReglas,
  subioSeveridad, TORMENTA_UMBRAL,
} from './incidente.ts';

const ORG = '00000000-0000-4000-a000-00000000de00';
const AHORA = new Date('2026-10-24T19:02:00.000Z');
const hace = (ms: number) => new Date(AHORA.getTime() - ms).toISOString();

describe('subida de severidad y motivo de aviso', () => {
  it('se compara por rango, no por texto', () => {
    expect(subioSeveridad('high', 'critical')).toBe(true);
    expect(subioSeveridad('critical', 'high')).toBe(false);
    expect(subioSeveridad('high', 'high')).toBe(false);
    expect(subioSeveridad('medium', 'high')).toBe(true);
    expect(subioSeveridad(null, 'critical')).toBe(false);
  });
  it('nuevo > subió > reabierto; sin cambio → null', () => {
    const b = { severity: 'high' as const, prev_severity: null, is_new: false, reopened: false };
    expect(motivoAviso({ ...b, is_new: true })).toBe('nuevo');
    expect(motivoAviso({ ...b, severity: 'critical', prev_severity: 'high' })).toBe('subio');
    expect(motivoAviso({ ...b, severity: 'critical', prev_severity: 'high', reopened: true })).toBe('subio');
    expect(motivoAviso({ ...b, prev_severity: 'high', reopened: true })).toBe('reabierto');
    expect(motivoAviso({ ...b, prev_severity: 'high' })).toBeNull();
    expect(motivoAviso({ ...b, severity: 'high', prev_severity: 'critical' })).toBeNull();
  });
});

describe('cooldown de reapertura (espejo de la RPC)', () => {
  it('resuelto hace 9:59 → se reabriría; hace 10:00 o más → incidente nuevo', () => {
    expect(dentroDeCooldown(hace(REAPERTURA_MS - 1_000), AHORA)).toBe(true);
    expect(dentroDeCooldown(hace(REAPERTURA_MS), AHORA)).toBe(false);
    expect(dentroDeCooldown(hace(11 * 60_000), AHORA)).toBe(false);          // el resolved_at atrasado 11 min de §02.5.1
    expect(dentroDeCooldown(null, AHORA)).toBe(false);
    expect(dentroDeCooldown('no es fecha', AHORA)).toBe(false);
  });
});

describe('tormenta', () => {
  it('más de 5 incidentes en 2 min: el primero manda storm_v1, el resto se suprime', () => {
    expect(TORMENTA_UMBRAL).toBe(5);
    expect(estadoTormenta(5, false)).toBe('none');
    expect(estadoTormenta(5, true)).toBe('none');
    expect(estadoTormenta(6, false)).toBe('first');
    expect(estadoTormenta(6, true)).toBe('suppressed');
    expect(estadoTormenta(0, false)).toBe('none');
    expect(estadoTormenta(Number.NaN, false)).toBe('none');
  });
});

describe('ventana de alertas de la org de demo (M10)', () => {
  const demo = { is_demo: true }, normal = { is_demo: false };
  it('org normal nunca está fuera de ventana', () => {
    expect(fueraDeVentanaDemo(normal, null, AHORA)).toBe(false);
    expect(fueraDeVentanaDemo(normal, hace(60_000), AHORA)).toBe(false);
  });
  it('org de demo: sin clave, fecha inválida o vencida → fuera; abierta → dentro', () => {
    expect(fueraDeVentanaDemo(demo, null, AHORA)).toBe(true);
    expect(fueraDeVentanaDemo(demo, undefined, AHORA)).toBe(true);
    expect(fueraDeVentanaDemo(demo, 'mañana', AHORA)).toBe(true);
    expect(fueraDeVentanaDemo(demo, AHORA.toISOString(), AHORA)).toBe(true);
    expect(fueraDeVentanaDemo(demo, '2026-10-24T19:47:00Z', AHORA)).toBe(false);   // el SQL de §02.5.1 abre 45 min
  });
});

describe('cierre por inactividad (housekeeping)', () => {
  const cf = { status: 'open' as const, rule_ids: ['CF_UA_TOOL'] };
  it('CF_ sin peticiones de la IP en 15 min → se cierra; 14:59 → no', () => {
    expect(cerrarPorInactividad(cf, hace(RESOLVER_SIN_EVENTOS_MS), AHORA)).toBe(true);
    expect(cerrarPorInactividad(cf, hace(RESOLVER_SIN_EVENTOS_MS - 1_000), AHORA)).toBe(false);
    expect(cerrarPorInactividad({ ...cf, status: 'mitigated' }, null, AHORA)).toBe(true);
    expect(cerrarPorInactividad({ ...cf, status: 'ack' }, hace(20 * 60_000), AHORA)).toBe(true);
  });
  it('ya resuelto o sin reglas CF_ → no se toca', () => {
    expect(cerrarPorInactividad({ ...cf, status: 'resolved' }, null, AHORA)).toBe(false);
    expect(cerrarPorInactividad({ status: 'open', rule_ids: ['SB_DB_DOWN'] }, null, AHORA)).toBe(false);
  });
});

describe('parámetros de vg_upsert_incident', () => {
  it('salen del incidente agrupado; la IP completa solo en p_ip, p_resource y p_details', async () => {
    const [x] = await evaluarVentanaEdge([{ ip: '186.92.14.7', n: 1180, paths_4xx: 37, probe_hits: 3, admin_ok: 3, n5xx: 0,
      p95_ms: 240, ua_top: 'sqlmap/1.8', total: 1300 }], { org_id: ORG, host: 'demo.officialvanguard.com' });
    const p = paramsUpsertIncidente(x!, { org_id: ORG, connection_id: 'c0000000-0000-4000-a000-000000000001',
      started_at: '2026-10-24T19:01:00.000Z' });
    expect(p).toEqual({
      p_org: ORG, p_conn: 'c0000000-0000-4000-a000-000000000001', p_dedupe: x!.dedupe_key,
      p_rules: ['CF_UA_TOOL', 'CF_PATH_SCAN', 'CF_ADMIN_EXPOSED', 'CF_IP_FLOOD'], p_severity: 'critical',
      p_title: 'Escaneo con sqlmap y /admin abierto desde 186.92.x.x', p_resource: 'ip:186.92.14.7',
      p_details: { ip: '186.92.14.7', host: 'demo.officialvanguard.com', source: 'ingest', ua_top: 'sqlmap/1.8', n_60s: 1180,
        total_60s: 1300, share_pct: 91, paths_4xx: 37, probe_hits: 3, admin_ok: 3, n5xx: 0, p95_ms: 240 },
      p_ip: '186.92.14.7', p_started: '2026-10-24T19:01:00.000Z',
    });
    expect(p.p_title).not.toContain('186.92.14.7');
    p.p_rules.push('X');                                                               // copia: no altera el incidente
    expect(x!.rule_ids).toHaveLength(4);
  });
  it('sin started_at ni conexión pasan null (la RPC usa now())', async () => {
    expect(agruparEdge([], { org_id: ORG, host: 'h' })).toEqual([]);
    const [x] = await evaluarVentanaEdge([{ ip: '186.92.14.7', n: 1, paths_4xx: 0, probe_hits: 1, admin_ok: 0, n5xx: 0,
      p95_ms: null, ua_top: null, total: 1 }], { org_id: ORG, host: 'h' });
    expect(paramsUpsertIncidente(x!, { org_id: ORG, connection_id: null, started_at: null })).toMatchObject({ p_conn: null,
      p_started: null, p_severity: 'high' });
  });
});

describe('módulo, servicio y regla principal', () => {
  it('módulo por prefijo de rule_ids[0] (E17)', () => {
    expect(moduloDeRegla('CF_UA_TOOL')).toBe('cloudflare');
    expect(moduloDeRegla('SB_DB_DOWN')).toBe('supabase');
    expect(moduloDeRegla('CB_ENV_COMMITTED')).toBe('codebase');
    expect(moduloDeRegla('PF_REGRESSION')).toBe('performance');
    expect(moduloDeRegla('XX_OTRA')).toBeNull();
    expect(moduloDeRegla(undefined)).toBeNull();
    expect(servicioDeReglas(['CF_UA_TOOL', 'SB_DB_DOWN'])).toBe('Cloudflare');
    expect(servicioDeReglas(['SB_DB_DOWN'])).toBe('Supabase');
    expect(servicioDeReglas([])).toBe('VanGUARD');
    expect(SERVICIO_MODULO.performance).toBe('Rendimiento');
  });
  it('regla del resumen: la causa de la subida si es critical; la del primer aviso si es high', () => {
    const todas = ['CF_ADMIN_EXPOSED', 'CF_IP_FLOOD', 'CF_PATH_SCAN', 'CF_UA_TOOL'];   // orden alfabético de la RPC
    expect(reglaPrincipal(todas, 'critical')).toBe('CF_ADMIN_EXPOSED');
    expect(reglaPrincipal(['CF_IP_FLOOD', 'CF_UA_TOOL'], 'critical')).toBe('CF_IP_FLOOD');
    expect(reglaPrincipal(['CF_IP_FLOOD', 'CF_PATH_SCAN', 'CF_UA_TOOL'], 'high')).toBe('CF_UA_TOOL');
    expect(reglaPrincipal(['CF_IP_FLOOD', 'CF_PATH_SCAN'], 'high')).toBe('CF_PATH_SCAN');
    expect(reglaPrincipal(['SB_DB_DOWN'], 'critical')).toBe('SB_DB_DOWN');
    expect(reglaPrincipal(['CB_ENV_COMMITTED'], 'high')).toBe('CB_ENV_COMMITTED');
    expect(reglaPrincipal([], 'high')).toBeNull();
  });
});
