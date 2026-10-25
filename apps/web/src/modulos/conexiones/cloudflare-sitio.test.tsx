// Cloudflare sin zona (asignaciones/cloudflare-por-url.md, FRONT): interruptor «Sitio» / «Zona» en el asistente, la URL
// normalizada antes de enviar y la tarjeta de una conexión en modo sitio. Sin jsdom: renderToStaticMarkup.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Cloud } from 'lucide-react';
import { z } from 'zod';
import { fixtures as fx, ConnectionPublic } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { extraerUrlSitio } from '@/lib/pre-guardas';
import Asistente from './Asistente';
import { TarjetaConexion } from './TarjetaConexion';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };

describe('extraerUrlSitio', () => {
  it('normaliza a https://host: sin ruta, query ni puerto; acepta el host a secas', () => {
    expect(extraerUrlSitio('https://mi-app.pages.dev/precios?x=1')).toEqual({ url: 'https://mi-app.pages.dev' });
    expect(extraerUrlSitio('  Mi-App.Pages.dev  ')).toEqual({ url: 'https://mi-app.pages.dev' });
    expect(extraerUrlSitio('https://api.mi-cuenta.workers.dev:443/')).toEqual({ url: 'https://api.mi-cuenta.workers.dev' });
    expect(extraerUrlSitio('tienda.com')).toEqual({ url: 'https://tienda.com' });
  });
  it.each(['', 'http://mi-app.pages.dev', 'ftp://x.com', 'https://203.0.113.7', 'https://localhost', 'https://[::1]', 'intranet',
    'https://officialvanguard.com', 'https://demo.officialvanguard.com', 'https://user:pw@x.com'])('rechaza %j', (v) => {
    expect(extraerUrlSitio(v)).toHaveProperty('error');
  });
});

const asistente = (state?: unknown) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter initialEntries={[state ? { pathname: `/o/${ORG}/connections/cloudflare`, state } : `/o/${ORG}/connections/cloudflare`]}>
      <OrgDePrueba org={ADMIN}><Routes><Route path="/o/:orgId/connections/:provider" element={<Asistente />} /></Routes></OrgDePrueba>
    </MemoryRouter>
  </QueryClientProvider>,
);

describe('Asistente de Cloudflare · Sitio o Zona', () => {
  it('por defecto «Sitio»: URL, token de cuenta opcional con su ayuda y sin token de Modo blindaje ni Zone ID', () => {
    const html = asistente();
    expect(html).toContain('Conecta tu sitio de Cloudflare');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Sitio \(URL de Pages, Workers o dominio\)/);
    expect(html).toContain('Zona (Zone ID)');
    expect(html).toContain('URL del sitio');
    expect(html).toContain('placeholder="https://mi-app.pages.dev"');
    expect(html).toContain('Token de cuenta (opcional)');
    expect(html).toContain('Sin token revisamos el sitio por HTTP.');
    expect(html).not.toContain('>Zone ID<');
    expect(html).not.toContain('Token de Modo blindaje');
  });

  it('«Activar modo blindaje» llega en «Zona»: Zone ID y token de blindaje, como siempre', () => {
    const html = asistente({ blindaje: true, zone_id: null });
    expect(html).toContain('Conecta tu zona de Cloudflare');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Zona \(Zone ID\)/);
    expect(html).toContain('Zone ID');
    expect(html).toContain('Token de Modo blindaje');
    expect(html).not.toContain('URL del sitio');
  });
});

describe('TarjetaConexion · Cloudflare en modo sitio', () => {
  const CX = z.array(ConnectionPublic).parse(fx.connections);
  const cf = CX.find((c) => c.provider === 'cloudflare' && c.kind === 'read')!;
  const sitio = (config_read: boolean, site_kind: unknown = 'pages'): ConnectionPublic => ({ ...cf, label: 'Cloudflare · mi-app.pages.dev',
    last4: config_read ? 'a1B2' : null, meta: { mode: 'url', site_url: 'https://mi-app.pages.dev', site_kind, project: 'mi-app', account_id: null, config_read } });
  const tarjeta = (c: ConnectionPublic) => renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><OrgDePrueba org={ADMIN}><TarjetaConexion proveedor="cloudflare" conexiones={[c]} descripcion="d" icono={Cloud} /></OrgDePrueba></MemoryRouter>
    </QueryClientProvider>,
  );

  it('dice qué sitio es y que sin token solo se revisa por HTTP; sin Modo blindaje, que pide zona', () => {
    const html = tarjeta(sitio(false));
    expect(html).toContain('Sitio de Pages');
    expect(html).toContain('https://mi-app.pages.dev');
    expect(html).toContain('Revisamos el sitio por HTTP. Con un token de cuenta');
    expect(html).toContain('necesitan una zona propia');
    expect(html).not.toContain('Modo blindaje (acciones)');
  });

  it('con token de cuenta dice que lee la configuración; un site_kind desconocido sale genérico', () => {
    expect(tarjeta(sitio(true))).toContain('Revisamos el sitio por HTTP y la configuración del proyecto.');
    expect(tarjeta(sitio(true, 'raro'))).toContain('Sitio de Pages/Workers');
    expect(tarjeta(sitio(true, 'workers'))).toContain('Sitio de Workers');
    expect(tarjeta(sitio(true, 'custom'))).toContain('Sitio con dominio propio');
    const deWorker = sitio(true, 'custom');
    expect(tarjeta({ ...deWorker, meta: { ...deWorker.meta, project_kind: 'workers' } })).toContain('Dominio propio de Workers');
  });
});
