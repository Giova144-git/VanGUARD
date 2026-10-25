import { describe, expect, it } from 'vitest';
import { EdgeEvent } from '@vanguard/contracts';
import { evaluateEdge, UMBRALES_EDGE, type EdgeWindowRow } from './edge.ts';
import { cantidadSimulada, eventosSimulados, ipSimulada, type EventoBorde, type KindSimulado } from './simulacion.ts';

// Espejo de vg_edge_window (0006) para un lote: conteos por IP de los eventos de la ventana. Solo para probar que los
// eventos sintéticos casan con las reglas; la prueba de verdad en la base va por SQL.
const PROBE = /^\/(\.env|\.git\/config|wp-login\.php|phpmyadmin|server-status)/;
const ADMIN = /^\/(admin|api\/admin|wp-admin)(\/|$)/;
export function ventana(evs: readonly EventoBorde[]): EdgeWindowRow[] {
  const porIp = new Map<string, EventoBorde[]>();
  for (const e of evs) porIp.set(e.ip, [...(porIp.get(e.ip) ?? []), e]);
  return [...porIp].map(([ip, xs]) => {
    const lat = xs.map((x) => x.latency_ms).sort((a, b) => a - b);
    const uas = new Map<string, number>();
    for (const x of xs) uas.set(x.ua, (uas.get(x.ua) ?? 0) + 1);
    return { ip, n: xs.length, total: evs.length,
      paths_4xx: new Set(xs.filter((x) => x.status === 403 || x.status === 404).map((x) => x.path)).size,
      probe_hits: xs.filter((x) => PROBE.test(x.path)).length,
      admin_ok: xs.filter((x) => x.status >= 200 && x.status <= 399 && !x.auth && ADMIN.test(x.path)).length,
      n5xx: xs.filter((x) => x.status >= 500).length,
      p95_ms: lat[Math.min(lat.length - 1, Math.ceil(0.95 * lat.length) - 1)] ?? null,
      ua_top: [...uas].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null };
  });
}

const AHORA = Date.parse('2026-10-25T12:00:00.000Z');
const IP = ipSimulada(77);
const reglas = (kind: KindSimulado, escala = 1) => evaluateEdge(ventana(eventosSimulados(kind, IP, AHORA, escala)));

describe('eventos sintéticos de «Simular ataque»', () => {
  it('cada kind dispara SOLO su regla con los umbrales de UMBRALES_EDGE; la inundación sale crítica', () => {
    expect(reglas('path_scan').map((h) => [h.rule_id, h.severity])).toEqual([['CF_PATH_SCAN', 'high']]);
    expect(reglas('attack_tool').map((h) => [h.rule_id, h.severity])).toEqual([['CF_UA_TOOL', 'high']]);
    expect(reglas('ip_flood').map((h) => [h.rule_id, h.severity])).toEqual([['CF_IP_FLOOD', 'critical']]);
  });

  it('lo justo por encima del umbral: path_scan rutas distintas ≥ paths_4xx, flood n ≥ flood_n, tool n ≥ ua_n', () => {
    expect(cantidadSimulada('path_scan')).toBe(UMBRALES_EDGE.paths_4xx + 2);
    expect(cantidadSimulada('ip_flood')).toBe(UMBRALES_EDGE.flood_n + 2);
    expect(cantidadSimulada('attack_tool')).toBe(UMBRALES_EDGE.ua_n + 2);
    expect(ventana(eventosSimulados('path_scan', IP, AHORA))[0]!.paths_4xx).toBe(UMBRALES_EDGE.paths_4xx + 2);
  });

  it('por debajo del umbral no se dispara nada (attack_tool y flood); path_scan sin las rutas de sondeo tampoco', () => {
    expect(reglas('attack_tool', 0.5)).toEqual([]);
    expect(reglas('ip_flood', 0.5)).toEqual([]);
    // path_scan con pocas rutas aún prueba /.env (probe_hits ≥ 1 basta para la regla, como un escaneo real).
    expect(reglas('path_scan', 0.05).map((h) => h.rule_id)).toEqual(['CF_PATH_SCAN']);
    expect(reglas('path_scan', 0)).toEqual([]);
  });

  it('forma exacta de EdgeEvent, IP de TEST-NET-3 y marcas dentro de los últimos 60 s', () => {
    for (const kind of ['path_scan', 'ip_flood', 'attack_tool'] as const) {
      for (const e of eventosSimulados(kind, IP, AHORA)) {
        expect(EdgeEvent.strict().parse(e)).toEqual(e);
        expect(e.ip).toMatch(/^203\.0\.113\.\d{1,3}$/);
        const t = Date.parse(e.ts);
        expect(t).toBeLessThanOrEqual(AHORA);
        expect(t).toBeGreaterThan(AHORA - 60_000);
      }
    }
    expect([ipSimulada(0), ipSimulada(999)]).toEqual(['203.0.113.1', '203.0.113.254']);
  });
});
