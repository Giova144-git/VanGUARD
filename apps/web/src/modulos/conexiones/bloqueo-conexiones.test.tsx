// Conexiones con el token de estados del bloqueo de merge (bloqueo-merge-criticos.md §6.3, F5): su línea propia, el aviso
// de «Quitar» elegido por proveedor Y tipo (no habla de IPs), «También quitamos el token de estados» solo en su repo, y el
// enlace a Codebase cuando no hay token. La guía del token (GUIA_ESTADOS_GITHUB) con el anexo de cierre de PR.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { z } from 'zod';
import { fixtures as fx, ConnectionPublic } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { GUIA_ESTADOS_GITHUB } from '@/lib/guias';
import { TarjetaConexion, avisoQuitar } from './TarjetaConexion';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const CX = z.array(ConnectionPublic).parse(fx.connections);
const GH = CX.find((c) => c.provider === 'github')!;
const GH2 = ConnectionPublic.parse(fx.conexionGithub2);
const ESTADOS: ConnectionPublic = { ...GH, id: 'c0000000-0000-4000-8000-000000000006', kind: 'action', label: `GitHub · estados · ${String(GH.meta.repo_full_name)}`,
  last4: 'k9Qz', scopes: ['statuses:write', 'pull_requests:write'], capabilities: { statuses: true },
  meta: { repo_full_name: GH.meta.repo_full_name, repo_id: GH.meta.repo_id, branch: 'main', purpose: 'commit_statuses' } };

const tarjeta = (conexiones: ConnectionPublic[]) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter><OrgDePrueba org={ADMIN}><TarjetaConexion proveedor="github" conexiones={conexiones} descripcion="d" icono={GitBranch} /></OrgDePrueba></MemoryRouter>
  </QueryClientProvider>,
);

describe('Conexiones · token de estados del bloqueo de merge (§6.3)', () => {
  it('el aviso de «Quitar» se elige por proveedor y tipo: el token de estados no habla de IPs; Cloudflare conserva el suyo', () => {
    expect(avisoQuitar({ provider: 'github', kind: 'action' })).not.toMatch(/IP/);
    expect(avisoQuitar({ provider: 'github', kind: 'action' })).toContain('no marcamos ✗ en GitHub');
    expect(avisoQuitar({ provider: 'cloudflare', kind: 'action' })).toBe('Sin este token no podrás bloquear IPs desde VanGUARD.');
    expect(avisoQuitar({ provider: 'github', kind: 'read' }, true)).toContain('También quitamos el token de estados.');
    expect(avisoQuitar({ provider: 'github', kind: 'read' })).not.toContain('token de estados');
  });

  it('con token de estados: su línea con título propio y sus permisos, sin contarlo como repo', () => {
    const html = tarjeta([...CX, GH2, ESTADOS]);
    expect(html).toContain('Estados de commit (bloqueo de merge)');
    expect(html).toContain('Commit statuses · Read and write');
    expect(html).toContain('Pull requests · Read and write');
    expect(html).toContain('2 repos');
    expect(html).not.toContain('se configura en');
  });

  it('sin token de estados: una línea que lleva a Codebase → Revisión automática', () => {
    const html = tarjeta(CX);
    expect(html).toContain(`href="/o/${ORG}/codebase#revision-codigo"`);
    expect(html).not.toContain('Estados de commit (bloqueo de merge)');
  });

  it('la guía del token: lo crea el dueño, Commit statuses y Pull requests en Read and write, Issues opcional', () => {
    expect(GUIA_ESTADOS_GITHUB.quien).toContain('Lo crea el dueño del repo');
    expect(GUIA_ESTADOS_GITHUB.permisos).toContain('Commit statuses y Pull requests en Read and write');
    expect(GUIA_ESTADOS_GITHUB.permisos).toContain('Opcional: Issues: Read and write');
    const url = new URL(GUIA_ESTADOS_GITHUB.enlace('equipo22-demo'));
    expect(url.origin).toBe('https://github.com');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ statuses: 'write', pull_requests: 'write', expires_in: '30', target_name: 'equipo22-demo' });
    expect(url.searchParams.has('contents')).toBe(false);
    expect(new URL(GUIA_ESTADOS_GITHUB.enlace(null)).searchParams.has('target_name')).toBe(false);
  });
});
