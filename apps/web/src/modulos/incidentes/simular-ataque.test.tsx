// «Simular ataque» (E57, llamada-ataque.md F1): solo owner/admin en la org de demo; un 404/403 de E57 lo retira. El
// incidente simulado lleva la chapa «Simulado» y, al llegar desde el botón, lo que hizo cada canal. Sin jsdom.
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fixtures as fx, IncidentDetail } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import PaginaIncidente from './PaginaIncidente';
import { SimularAtaque, textoCanales } from './Simulacion';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ORG = fx.me.orgs[0]!.id;
const ADMIN_DEMO: OrgActual = { ...fx.me.orgs[0]!, is_demo: true, me: fx.me, puedeEscribir: true };

function pintar(org: OrgActual, nodo: ReactNode, qc = new QueryClient(), entrada: string | { pathname: string; state: unknown } = `/o/${ORG}/incidents`, patron = '/o/:orgId/incidents') {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entrada]}>
        <OrgDePrueba org={org}><Routes><Route path={patron} element={nodo} /></Routes></OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SimularAtaque', () => {
  it('owner o admin en la demo: los tres tipos, el botón y la nota de la IP reservada', () => {
    const html = pintar(ADMIN_DEMO, <SimularAtaque org={ADMIN_DEMO} />);
    for (const t of ['Escaneo de rutas', 'Inundación', 'Herramienta de ataque', 'Simular ataque', '203.0.113.x', 'el botón para llamar a Guardia', 'solo el WhatsApp']) expect(html).toContain(t);
    // La inundación (la única crítica con el motor real) va primera y elegida.
    expect(html).toMatch(/aria-label="Tipo de ataque"><button[^>]*aria-pressed="true"[^>]*>Inundación</);
  });

  it('no se pinta para el viewer, fuera de la demo ni con E57 ausente (404/403)', () => {
    expect(pintar(ADMIN_DEMO, <SimularAtaque org={{ ...ADMIN_DEMO, puedeEscribir: false }} />)).not.toContain('Simular ataque');
    expect(pintar(ADMIN_DEMO, <SimularAtaque org={{ ...ADMIN_DEMO, is_demo: false }} />)).not.toContain('Simular ataque');
    const qc = new QueryClient();
    qc.setQueryData(['org', ORG, 'ruta-ausente', 'E57'], true);
    expect(pintar(ADMIN_DEMO, <SimularAtaque org={ADMIN_DEMO} />, qc)).not.toContain('Simular ataque');
  });

  it('textoCanales dice qué hizo cada canal; un valor fuera de contrato sale «—»', () => {
    expect(textoCanales({ whatsapp: 'queued', voice: 'skipped' })).toBe('WhatsApp: en camino · Llamada: no aplica');
    expect(textoCanales({ whatsapp: 'failed', voice: 'raro' as never })).toBe('WhatsApp: falló · Llamada: —');
  });
});

describe('PaginaIncidente · incidente simulado', () => {
  const base = IncidentDetail.parse(fx.incidentDetail);
  const simulado = { ...base, details: { ...base.details, simulated: true } };
  const ver = (i: IncidentDetail, state?: unknown) => {
    const qc = new QueryClient();
    qc.setQueryData(['org', ORG, 'incident', i.id], i);
    const ruta = `/o/${ORG}/incidents/${i.id}`;
    return pintar(ADMIN_DEMO, <PaginaIncidente />, qc, state ? { pathname: ruta, state } : ruta, '/o/:orgId/incidents/:incidentId');
  };

  it('lleva la chapa «Simulado» solo si details.simulated es true', () => {
    expect(ver(simulado)).toContain('>Simulado<');
    expect(ver(base)).not.toContain('>Simulado<');
  });

  it('al llegar desde «Simular ataque» dice qué hizo cada canal, solo en ese incidente', () => {
    expect(ver(simulado, { simulacion: { id: base.id, canales: 'WhatsApp: en camino · Llamada: no aplica' } }))
      .toContain('Ataque simulado · WhatsApp: en camino · Llamada: no aplica');
    expect(ver(simulado, { simulacion: { id: 'otro', canales: 'x' } })).not.toContain('Ataque simulado');
  });
});
