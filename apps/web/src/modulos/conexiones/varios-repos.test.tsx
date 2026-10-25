// Conexiones con varios repos de GitHub (varias-codebases §6.1, F1): una línea por conexión de lectura con el repo de
// título, «Conectar otro repo» (apagado con 5 repos distintos o para el viewer), la chapa «N repos» y el Resumen.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { z } from 'zod';
import { fixtures as fx, ConnectionPublic, Overview } from '@vanguard/contracts';
import { OrgDePrueba, SOLO_LECTURA, type OrgActual } from '@/app/guardas';
import PaginaResumen from '@/modulos/resumen/PaginaResumen';
import { TarjetaConexion } from './TarjetaConexion';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', puedeEscribir: false };
const CX = z.array(ConnectionPublic).parse(fx.connections);
const GH = CX.find((c) => c.provider === 'github')!;
const GH2 = ConnectionPublic.parse(fx.conexionGithub2);
const repo = (n: number): ConnectionPublic => ({ ...GH2, id: `c0000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
  meta: { ...GH2.meta, repo_full_name: `equipo/repo-${n}` } });

function tarjeta(conexiones: ConnectionPublic[], org: OrgActual = ADMIN) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><OrgDePrueba org={org}><TarjetaConexion proveedor="github" conexiones={conexiones} descripcion="d" icono={GitBranch} /></OrgDePrueba></MemoryRouter>
    </QueryClientProvider>,
  );
}
const otroRepo = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Conectar otro repo<\/button>/)?.[0] ?? '';

describe('TarjetaConexion · GitHub con varios repos', () => {
  it('una línea por conexión de lectura con su repo de título, en <bdi>, y la chapa «2 repos»', () => {
    const html = tarjeta([...CX, GH2]);
    expect(html).toContain(`<bdi dir="ltr" class="font-mono break-all">${GH.meta.repo_full_name}</bdi>`);
    expect(html).toContain(`<bdi dir="ltr" class="font-mono break-all">${GH2.meta.repo_full_name}</bdi>`);
    expect(html.match(/Probar conexión/g)).toHaveLength(2);
    expect(html).toContain('2 repos');
    expect(otroRepo(html)).not.toContain('disabled=""');
  });

  it('con un repo, sin chapa de repos y con «Conectar otro repo»; sin repos, «Conectar GitHub» como antes', () => {
    const uno = tarjeta(CX);
    expect(uno).not.toContain('1 repos');
    expect(otroRepo(uno)).toContain('Conectar otro repo');
    const ninguno = tarjeta(CX.filter((c) => c.provider !== 'github'));
    expect(ninguno).toContain('Conectar GitHub');
    expect(ninguno).not.toContain('Conectar otro repo');
  });

  it('con 5 repos distintos, «Conectar otro repo» apagado con su motivo; las parejas viejas cuentan uno', () => {
    const cinco = [GH, ...[1, 2, 3, 4].map(repo)];
    const html = tarjeta(cinco);
    expect(otroRepo(html)).toContain('disabled=""');
    expect(html).toContain('Tope de 5 repos por organización');
    expect(html).toContain('5 repos');
    const conPareja = [{ ...GH, id: 'c0000000-0000-4000-8000-0000000000a1', status: 'revoked' as const }, GH, ...[1, 2, 3].map(repo)];
    const cuatro = tarjeta(conPareja);
    expect(cuatro).toContain('4 repos');
    expect(otroRepo(cuatro)).not.toContain('disabled=""');
    expect(cuatro.match(/Probar conexión/g)).toHaveLength(4);             // la revocada no se prueba, pero se ve para quitarla
    expect(cuatro).toContain('Token revocado');
  });

  it('el viewer ve los repos sin poder conectar otro (SOLO_LECTURA)', () => {
    const html = tarjeta([...CX, GH2], VIEWER);
    expect(otroRepo(html)).toContain('disabled=""');
    expect(html).toContain(SOLO_LECTURA);
  });
});

describe('PaginaResumen · tarjeta Codebase con varios repos', () => {
  function resumen(conexiones: ConnectionPublic[]) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['org', ORG, 'overview'], Overview.parse(fx.overview));
    qc.setQueryData(['org', ORG, 'connections'], conexiones);
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/o/${ORG}/overview`]}><OrgDePrueba org={ADMIN}><PaginaResumen /></OrgDePrueba></MemoryRouter>
      </QueryClientProvider>,
    );
  }
  it('«2 repos» con los dos activos; la chapa del que falla si uno cae', () => {
    expect(resumen([...CX, GH2])).toContain('2 repos');
    const html = resumen([...CX, { ...GH2, status: 'expired' }]);
    expect(html).toContain('Token vencido');
    expect(html).not.toContain('2 repos');
  });
});
