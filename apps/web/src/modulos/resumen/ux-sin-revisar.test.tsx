// UX P0-1 y P0-2 (ux-revision-develop.md): nunca «✓ Nada que atender» sin mirar, y «Última auditoría» = la última
// terminada, con la fallida aparte. Sin jsdom: renderToStaticMarkup.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fixtures as fx, Overview } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { Bandeja } from '@/componentes/vg/Bandeja';
import PaginaResumen from './PaginaResumen';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const envolver = (n: React.ReactNode, qc = new QueryClient()) => renderToStaticMarkup(
  <QueryClientProvider client={qc}><MemoryRouter><OrgDePrueba org={ADMIN}>{n}</OrgDePrueba></MemoryRouter></QueryClientProvider>);

describe('Bandeja vacía', () => {
  it('sin ningún chequeo comprobado: «Sin revisar» con «Revisar ahora», sin ✓', () => {
    const html = envolver(<Bandeja grupos={[]} puedeEscribir sinRevisar enlaceRevisar={`/o/${ORG}/audit`} />);
    expect(html).toContain('Sin revisar');
    expect(html).toContain('Revisar ahora');
    expect(html).not.toContain('✓');
  });
  it('mirado y sin nada: «0 ✓ Nada que atender», sin una segunda hora', () => {
    const html = envolver(<Bandeja grupos={[]} puedeEscribir />);
    expect(html).toContain('0 ✓ Nada que atender');
    expect(html).not.toContain('revisado');
  });
});

describe('Resumen · última auditoría', () => {
  const ver = (o: Overview) => {
    const qc = new QueryClient();
    qc.setQueryData(['org', ORG, 'overview'], o);
    qc.setQueryData(['org', ORG, 'connections'], fx.connections);
    return envolver(<PaginaResumen />, qc);
  };
  const base = Overview.parse(fx.overview);
  const FALLIDA = { id: '1fc34a1e-a951-46ea-8ee9-df5708e9a166', status: 'failed' as const, finished_at: '2026-10-25T03:46:50.946Z' };

  it('si la última falló, no se presenta como «Última auditoría»: se dice aparte, con su enlace', () => {
    const html = ver({ ...base, last_scan: FALLIDA });
    expect(html).not.toMatch(/Última auditoría \d/);
    expect(html).toContain('falló');
    expect(html).toContain(`/audit/${FALLIDA.id}`);
    expect(html).toContain('la última falló');
  });

  it('sin puntaje (ninguna terminada) y sin nada en «Ahora»: «Sin revisar», nunca ✓', () => {
    const html = ver({ ...base, score: null, band: null, ahora: [], last_scan: FALLIDA });
    expect(html).toContain('Sin revisar: aún no hay ninguna auditoría terminada.');
    expect(html).not.toContain('Nada que atender');
  });
});

describe('UX P0-2/3/4 con los campos de 6782e5b', () => {
  const base = Overview.parse(fx.overview);
  const verResumen = (o: Overview) => {
    const qc = new QueryClient();
    qc.setQueryData(['org', ORG, 'overview'], o);
    qc.setQueryData(['org', ORG, 'connections'], fx.connections);
    return envolver(<PaginaResumen />, qc);
  };

  it('last_ok_scan manda en «Última auditoría» aunque last_scan sea la fallida', () => {
    const html = verResumen({ ...base, last_scan: { id: '1fc34a1e-a951-46ea-8ee9-df5708e9a166', status: 'failed', finished_at: '2026-10-25T03:46:50.946Z' },
      last_ok_scan: { id: '78e9a636-2d3c-46ee-8865-8c3c002b800e', finished_at: '2026-10-25T04:07:34.000Z' } });
    expect(html).toContain('/audit/78e9a636-2d3c-46ee-8865-8c3c002b800e');
    expect(html).toMatch(/Última auditoría \S/);
    expect(html).toContain('falló');
  });

  it('en la vista previa «Auditar todo» va apagado con su motivo', () => {
    const html = verResumen({ ...base, preview: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Auditar todo/);
    expect(html).toContain('Las auditorías no corren en la vista previa');
  });
});

describe('Incidentes · «vigilando» solo con tráfico reciente', async () => {
  const { default: PaginaIncidentes } = await import('@/modulos/incidentes/PaginaIncidentes');
  const ver = (last_ingest_at: string | null) => {
    const qc = new QueryClient();
    qc.setQueryData(['org', ORG, 'overview'], { ...Overview.parse(fx.overview), last_ingest_at });
    qc.setQueryData(['org', ORG, 'incidents', 'open'], []);
    return envolver(<PaginaIncidentes />, qc);
  };
  it('sin eventos de ingesta en la última hora no dice «vigilando»', () => {
    expect(ver(null)).toContain('Sin tráfico de tu app en la última hora');
    expect(ver(null)).not.toContain('vigilando');
    expect(ver(new Date(Date.now() - 2 * 3_600_000).toISOString())).not.toContain('vigilando');
  });
  it('con un evento reciente, sí', () => {
    expect(ver(new Date(Date.now() - 60_000).toISOString())).toContain('vigilando');
  });
});
