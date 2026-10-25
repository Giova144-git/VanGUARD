// Resumen visto por el viewer de «Ver demo»: lo que falta conectar se dice, pero sin un enlace ni un botón que no puede usar.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, ConnectionPublic, Overview } from '@vanguard/contracts';
import { OrgDePrueba, SOLO_LECTURA, type OrgActual } from '@/app/guardas';
import PaginaResumen from './PaginaResumen';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', puedeEscribir: false };
// Como «Tienda Demo» hoy: sin Cloudflare ni Rendimiento.
const OVERVIEW = Overview.parse({ ...fx.overview, coverage: { seen: 2, total: 4, missing: ['cloudflare', 'performance'] } });
const SIN_CLOUDFLARE = z.array(ConnectionPublic).parse(fx.connections).filter((c) => c.provider !== 'cloudflare');

function resumen(org: OrgActual) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['org', ORG, 'overview'], OVERVIEW);
  qc.setQueryData(['org', ORG, 'connections'], SIN_CLOUDFLARE);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/o/${ORG}/overview`]}><OrgDePrueba org={org}><PaginaResumen /></OrgDePrueba></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PaginaResumen · lo que falta conectar', () => {
  it('el viewer ve «Sin revisar: Cloudflare (sin conectar), Rendimiento» sin enlace y «Conectar Cloudflare» apagado con su motivo', () => {
    const html = resumen(VIEWER);
    expect(html).toContain('Sin revisar: Cloudflare (sin conectar), Rendimiento');
    expect(html).not.toMatch(/href="\/o\/[^"]+\/connections"[^>]*>Conectar</);
    expect(html).toContain('Conectar Cloudflare');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Conectar Cloudflare/);
    expect(html).toContain(SOLO_LECTURA);
  });
  it('owner y admin siguen con el enlace «Conectar» y el botón activo', () => {
    const html = resumen(ADMIN);
    expect(html).toMatch(/href="\/o\/[^"]+\/connections"[^>]*>Conectar</);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Conectar Cloudflare/);
  });
});

describe('PaginaResumen · «Sin revisar» dice si la fuente está conectada (UX P1-16)', () => {
  it('Supabase conectado pero sin mirar: «(conectado)», y sin «Conectar» si no falta conectar nada', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['org', ORG, 'overview'], Overview.parse({ ...fx.overview, coverage: { seen: 2, total: 4, missing: ['supabase', 'performance'] } }));
    qc.setQueryData(['org', ORG, 'connections'], z.array(ConnectionPublic).parse(fx.connections));
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/o/${ORG}/overview`]}><OrgDePrueba org={ADMIN}><PaginaResumen /></OrgDePrueba></MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain('Sin revisar: Supabase (conectado), Rendimiento');
    expect(html).not.toMatch(/Rendimiento · <a[^>]*>Conectar</);
  });
});
