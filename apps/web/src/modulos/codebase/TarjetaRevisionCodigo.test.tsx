// «Revisión automática de código» (§6.1 y F6): bandera por 404, lo que ve el viewer y que el secreto del alta no se
// queda en el MutationCache ni en el almacenamiento tras reset(). Sin jsdom: renderToStaticMarkup y la caché a mano.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { MutationObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, ConnectionPublic, type CodeReviewState } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import { opcionesGuardarRevision, tomarSecreto } from '@/lib/mutaciones';
import { TarjetaRevisionCodigo } from './TarjetaRevisionCodigo';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const SECRETO = `vgw_${'A'.repeat(43)}`;
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api }));

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', puedeEscribir: false };
const GH = z.array(ConnectionPublic).parse(fx.connections).find((c) => c.provider === 'github')!;
const ESPERANDO: CodeReviewState = { ...fx.codeReviewState as CodeReviewState,
  config: { ...fx.codeReviewState.config as NonNullable<CodeReviewState['config']>, state: 'waiting_ping', last_ping_at: null, last_event_at: null } };

function tarjeta(org: OrgActual, estado: CodeReviewState | ApiError, ruta = `/o/${ORG}/codebase`) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (estado instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: ['org', ORG, 'revision'] }).setState({ status: 'error', error: estado, fetchStatus: 'idle' });
  else qc.setQueryData(['org', ORG, 'revision'], estado);
  qc.setQueryData(['org', ORG, 'alert-prefs'], fx.alertPrefs);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}>
        <OrgDePrueba org={org}><TarjetaRevisionCodigo conexion={GH} /></OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TarjetaRevisionCodigo', () => {
  it('si E45 da 404 (aún sin desplegar), la tarjeta no se pinta', () => {
    expect(tarjeta(ADMIN, new ApiError(404, 'not_found', 'Ruta inexistente'))).toBe('');
  });

  it('el viewer ve el estado y las revisiones, sin interruptor, sin pasos y sin la URL del webhook', () => {
    const html = tarjeta(VIEWER, { ...ESPERANDO, config: { ...ESPERANDO.config!, webhook_url: null } });
    expect(html).toContain('Revisión automática de código');
    expect(html).toContain('Esperando a GitHub');
    expect(html).toContain('Revisiones recientes');
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('Pasos en GitHub');
    expect(html).not.toContain('/webhooks/github/');
  });

  it('el admin esperando el ping ve el interruptor y los pasos abiertos con la URL; el secreto solo por su final', () => {
    const html = tarjeta(ADMIN, ESPERANDO);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(ESPERANDO.config!.webhook_url!);
    expect(html).toContain('Termina en ••');
    expect(html).not.toContain('vgw_');
    expect(html).toContain('Te avisamos por WhatsApp desde <span class="font-semibold">Alta</span>');
  });

  it('con el aviso sin enviar (cupo) y voice_pending, la fila abierta no promete un WhatsApp que no salió', () => {
    const r = { ...ESPERANDO.recent[0]!, alert: { ...ESPERANDO.recent[0]!.alert, state: 'not_sent' as const, reason: 'cap', delivery: null } };
    const html = tarjeta(ADMIN, { ...ESPERANDO, recent: [r] }, `/o/${ORG}/codebase?revision=${r.id}`);
    expect(html).toContain('Aviso no enviado: Tope de avisos de revisión por hora');
    expect(html).toContain('Llamada: aún no disponible');
    expect(html).not.toContain('te avisamos por WhatsApp');
    const leida = tarjeta(ADMIN, ESPERANDO, `/o/${ORG}/codebase?revision=${ESPERANDO.recent[0]!.id}`);
    expect(leida).toContain('Llamada: aún no disponible; te avisamos por WhatsApp');
  });

  it('los pull requests entran ya (D1): el texto lo dice y una fila de PR lleva su número, igual que un push', () => {
    const pr = { ...ESPERANDO.recent[0]!, id: 'c4000000-0000-4000-8000-000000000099', event: 'pull_request' as const, pr_number: 42 };
    const html = tarjeta(ADMIN, { ...ESPERANDO, recent: [pr, ...ESPERANDO.recent] });
    expect(html).toContain('cada pull request hacia');
    expect(html).not.toContain('próximamente');
    expect(html).toContain('PR #42 · ');
    expect(html).toContain('aria-label="Pull request"');
  });

  it('el secreto del alta (E46) no queda en el MutationCache ni en el almacenamiento tras reset()', async () => {
    const guardados: string[] = [];
    const almacen = { setItem: (k: string, v: string) => guardados.push(`${k}=${v}`), getItem: () => null, removeItem() {} };
    vi.stubGlobal('localStorage', almacen);
    vi.stubGlobal('sessionStorage', almacen);
    try {
      api.mockResolvedValueOnce({ config: fx.codeReviewSaved.config, webhook_secret: SECRETO });
      const qc = new QueryClient();
      const m = new MutationObserver(qc, opcionesGuardarRevision(ORG, qc));
      const r = await m.mutate({ connection_id: GH.id, enabled: true });
      expect(r.webhook_secret).toBe(SECRETO);                         // llega una vez, a quien lo pidió
      m.reset();
      await new Promise((ok) => setTimeout(ok, 10));                   // gcTime 0: el recolector corre en el siguiente tick
      // Queda en el contenedor en memoria hasta que la tarjeta lo toma (aunque se desmontara al activar), y solo una vez.
      expect(tomarSecreto(ORG)).toBe(SECRETO);
      expect(tomarSecreto(ORG)).toBeNull();
      expect(JSON.stringify(qc.getMutationCache().getAll().map((x) => x.state))).not.toContain('vgw_');
      expect(JSON.stringify(qc.getQueryCache().getAll().map((x) => x.state.data))).not.toContain('vgw_');
      expect(guardados.join('\n')).not.toContain('vgw_');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
