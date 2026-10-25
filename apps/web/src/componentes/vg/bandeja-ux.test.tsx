// UX P1-10/11 (ux-revision-develop.md): grupo de una fila = la fila sola con el título entero; el grupo de dependencias
// se titula «Dependencias con avisos (N)»; la ruta no se repite; un corte a media palabra se recorta en palabra.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fixtures as fx, type GrupoDato } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { Bandeja, sinCorte } from './Bandeja';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const fila = (etiqueta: string, objeto: string, sub?: string) => ({ clave: objeto, modulo: 'codebase', tipo: 'finding', rol: 'mal' as const, etiqueta, objeto, sub, acciones: [] });
const ver = (grupos: GrupoDato[]) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}><MemoryRouter><OrgDePrueba org={ADMIN}><Bandeja grupos={grupos} puedeEscribir /></OrgDePrueba></MemoryRouter></QueryClientProvider>);

describe('Bandeja · grupos', () => {
  it('un grupo de una fila es la fila sola, con el título entero y la ruta una vez', () => {
    const html = ver([{ grupo: 'CB_SECRET_POSTGRES_URL', etiqueta: 'Cadena de conexión a Postgres con contraseña en .env', rol: 'mal', n: 1,
      filas: [fila('Cadena de conexión a Postgres con contra', '.env:3', '.env:3')] }]);
    expect(html).not.toContain('<header');
    expect(html).toContain('>Cadena de conexión a Postgres con contraseña en .env</span>');
    expect(html.match(/\.env:3</g)).toHaveLength(1);
  });

  it('el grupo de dependencias se titula «Dependencias con avisos (N)»; sus filas no se cortan a media palabra', () => {
    const html = ver([{ grupo: 'CB_DEP_VULN', etiqueta: 'facade/ignition@2.5.1 tiene 1 aviso de seguridad', rol: 'mal', n: 2,
      filas: [fila('facade/ignition@2.5.1 tiene 1 aviso de s', 'Packagist:facade/ignition@2.5.1'), fila('vite@6.3.6 tiene 10 avisos de seguridad', 'npm:vite@6.3.6')] }]);
    expect(html).toContain('Dependencias con avisos (2)');
    expect(html).toContain('>facade/ignition@2.5.1 tiene 1 aviso de…</span>');
    expect(html).toContain('>vite@6.3.6 tiene 10 avisos de seguridad</span>');
  });

  it('sinCorte solo toca las etiquetas que llegan al tope de 40', () => {
    expect(sinCorte('El .gitignore no excluye .env')).toBe('El .gitignore no excluye .env');
    expect(sinCorte('lodash@4.17.15 tiene 6 avisos de segurid')).toBe('lodash@4.17.15 tiene 6 avisos de…');
  });
});
