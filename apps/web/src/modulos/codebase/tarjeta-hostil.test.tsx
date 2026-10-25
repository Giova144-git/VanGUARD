// Verificación adversarial de la tarjeta de revisión con el bloqueo de merge, la foto de cada push y las acciones de
// WhatsApp: todo texto del servidor con controles bidi y HTML. Nada llega crudo, lo técnico (ramas, repos, recursos) va en
// <bdi dir="ltr">, y los códigos raros salen con su texto por defecto. Sin jsdom: renderToStaticMarkup.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, CodeReviewState, ConnectionPublic } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { TarjetaRevisionCodigo } from './TarjetaRevisionCodigo';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/api', () => ({ api: vi.fn() }));

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', puedeEscribir: false };
const GH = z.array(ConnectionPublic).parse(fx.connections).find((c) => c.provider === 'github')!;
const RLO = '‮';
const HOSTIL = `ma${RLO}in<script>alert(1)</script>`;

const BASE = CodeReviewState.parse(fx.codeReviewStateBloqueo);
const [PR, PUSH] = BASE.recent as [CodeReviewState['recent'][number], CodeReviewState['recent'][number]];
const f = { finding_id: null, rule_id: 'CB_SECRET_STRIPE_LIVE', severity: 'critical' as const,
  title: `Clave ${RLO}<img src=x onerror=alert(1)>`, resource: `src/${RLO}sj.nimda<script>:3` };
const HOSTIL_ESTADO: CodeReviewState = {
  ...BASE,
  config: { ...BASE.config!, branch: HOSTIL, repo_full_name: `gabriel/demo${RLO}<script>`,
    gate: { ...BASE.config!.gate!, state: 'needs_token', statuses_connection: null, close_pr: true, can_close_pr: false } },
  recent: [
    { ...PR, branch: HOSTIL, gate: { ...PR.gate!, findings: [f], blocking: 3, pr_action: 'close_failed', pr_close_error: 'zz_raro' } },
    { ...PUSH, branch: HOSTIL, findings: [f], partial: true, error_code: `<b>${RLO}`,
      gate: { blocking: 1, findings: [f], state: 'failure', error: 'zz_desconocido', published_at: null, override_at: null },
      alert: { ...PUSH.alert, whatsapp_action: 'fix_sent', whatsapp_action_at: 'no-es-fecha' },
      delta: fx.deltasRevision[PUSH.id] ?? null },
  ],
};

function tarjeta(org: OrgActual, estado: CodeReviewState, abierta?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['org', ORG, 'revision', GH.id], estado);
  qc.setQueryData(['org', ORG, 'alert-prefs'], fx.alertPrefs);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/o/${ORG}/codebase${abierta ? `?revision=${abierta}` : ''}`]}>
        <OrgDePrueba org={org}><TarjetaRevisionCodigo conexion={GH} /></OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('tarjeta de revisión con texto hostil del servidor', () => {
  for (const [quien, org] of [['admin', ADMIN], ['viewer', VIEWER]] as const) {
    for (const abierta of [PR.id, PUSH.id]) {
      it(`${quien}, fila ${abierta === PR.id ? 'del PR' : 'del push'} abierta: ni controles bidi ni HTML crudos`, () => {
        const html = tarjeta(org, HOSTIL_ESTADO, abierta);
        expect(html).not.toContain(RLO);
        expect(html).not.toMatch(/<script|<img|<b>/);
        expect(html).toContain('&lt;script&gt;');
        expect(html).not.toContain('zz_raro');
        expect(html).not.toContain('zz_desconocido');
      });
    }
  }

  it('la rama del chip «✗ Ya está en {rama}» va en <bdi dir="ltr"> con los controles a la vista', () => {
    const html = tarjeta(ADMIN, HOSTIL_ESTADO);
    expect(html).toMatch(/✗ Ya está en <bdi dir="ltr" class="normal-case break-all">ma⟨U\+202E⟩in&lt;script&gt;/);
  });

  it('a 375 px nada largo desborda: el chip del bloqueo parte línea, la rama y el título del hallazgo también', () => {
    const activo = { ...HOSTIL_ESTADO, config: { ...HOSTIL_ESTADO.config!, gate: { ...HOSTIL_ESTADO.config!.gate!, state: 'active' as const } } };
    expect(tarjeta(ADMIN, activo)).toMatch(/max-w-full shrink py-0\.5 text-left">Activo: GitHub exige “VanGUARD”<\/span>/);
    const pr = tarjeta(VIEWER, HOSTIL_ESTADO, PUSH.id);
    expect(pr).toContain('<span class="text-[15px] font-medium wrap-anywhere">Clave ⟨U+202E⟩&lt;img');
    expect(pr).toContain('Este cambio ya está en <bdi dir="ltr" class="font-mono break-all">ma⟨U+202E⟩in');
  });

  it('un repo fuera de REPO_VALIDO no arma enlaces a github.com ni sale crudo', () => {
    const html = tarjeta(ADMIN, HOSTIL_ESTADO);
    expect(html).not.toContain('target_name=gabriel');
    expect(html).not.toContain('github.com/gabriel');
    expect(html).toContain('marca solo tu repo');
  });

  it('los códigos fuera de mapa salen con su texto por defecto', () => {
    const pr = tarjeta(ADMIN, HOSTIL_ESTADO, PR.id);
    expect(pr).toContain('No pudimos cerrar el PR: GitHub no lo aceptó');
    expect(pr).toContain('y 2 más');
    const push = tarjeta(ADMIN, HOSTIL_ESTADO, PUSH.id);
    expect(push).toContain('Arreglo enviado por WhatsApp');    // fecha inválida: sin hora
    expect(push).toContain('1 nuevo · 7 siguen abiertos');
  });
});
