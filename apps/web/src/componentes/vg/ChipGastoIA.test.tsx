// «Gasto IA hoy» (E28): solo owner y admin, color por level con su acción (abre Ajustes → IA), y nada si E28 da 404.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fixtures as fx, type AiUsage } from '@vanguard/contracts';
import { ApiError } from '@/lib/errores';
import { ChipGastoIA } from './ChipGastoIA';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const ORG = fx.me.orgs[0]!.id;

function chip(puedeEscribir: boolean, dato: AiUsage | ApiError) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (dato instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: ['org', ORG, 'ai'] }).setState({ status: 'error', error: dato, fetchStatus: 'idle' });
  else qc.setQueryData(['org', ORG, 'ai'], dato);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}><MemoryRouter><ChipGastoIA org={ORG} puedeEscribir={puedeEscribir} /></MemoryRouter></QueryClientProvider>,
  );
}

describe('ChipGastoIA', () => {
  it('el admin ve el gasto de hoy y su tope, y el chip lleva a Ajustes → IA', () => {
    const html = chip(true, fx.aiUsage as AiUsage);
    expect(html).toContain('Gasto IA hoy · 0,41 USD de 10,00 USD');
    expect(html).toContain('IA 0,41 USD');                       // forma corta en móvil
    expect(html).toContain(`href="/o/${ORG}/settings#ia"`);
    expect(html).toContain('IA normal');
  });
  it('el viewer no ve gastos', () => {
    expect(chip(false, fx.aiUsage as AiUsage)).toBe('');
  });
  it('E28 aún sin desplegar (404) o con error: no se pinta', () => {
    expect(chip(true, new ApiError(404, 'not_found', 'Ruta inexistente'))).toBe('');
    expect(chip(true, new ApiError(500, 'internal', 'x'))).toBe('');
  });
  it('cambia de color con level: normal neutro, reduced/minimal ámbar, off rojo; un level raro, neutro', () => {
    const tinte = (level: string) => chip(true, { ...fx.aiUsage, level } as AiUsage);
    expect(tinte('normal')).not.toMatch(/text-aviso|text-mal/);
    expect(tinte('reduced')).toContain('text-aviso');
    expect(tinte('minimal')).toContain('solo Haiku');
    expect(tinte('off')).toContain('text-mal');
    expect(tinte('__proto__')).not.toMatch(/text-aviso|text-mal/);
  });
});
