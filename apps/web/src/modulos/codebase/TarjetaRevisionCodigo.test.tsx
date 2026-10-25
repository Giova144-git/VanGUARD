// «Revisión automática de código» (§6.1 y F6): bandera por 404, lo que ve el viewer y que el secreto del alta no se
// queda en el MutationCache ni en el almacenamiento tras reset(). Sin jsdom: renderToStaticMarkup y la caché a mano.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// La consulta va por conexión (varias-codebases §6.2): ['org', org, 'revision', connection_id].
function tarjeta(org: OrgActual, estado: CodeReviewState | ApiError, ruta = `/o/${ORG}/codebase`, prefs = fx.alertPrefs, varios = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (estado instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: ['org', ORG, 'revision', GH.id] }).setState({ status: 'error', error: estado, fetchStatus: 'idle' });
  else qc.setQueryData(['org', ORG, 'revision', GH.id], estado);
  qc.setQueryData(['org', ORG, 'alert-prefs'], prefs);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}>
        <OrgDePrueba org={org}><TarjetaRevisionCodigo conexion={GH} varios={varios} /></OrgDePrueba>
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

  it('los enlaces a Ajustes («Cambiar», «añade uno en Ajustes») solo para owner y admin; el viewer ve el dato en neutro', () => {
    const sinContactos = { ...fx.alertPrefs, whatsapp_ready_contacts: 0 };
    const viewer = tarjeta(VIEWER, ESPERANDO);
    expect(viewer).toContain('Te avisamos por WhatsApp desde');
    expect(viewer).not.toContain('settings#avisos');
    const viewer0 = tarjeta(VIEWER, ESPERANDO, undefined, sinContactos);
    expect(viewer0).toContain('Aún no hay contactos con WhatsApp verificado');
    expect(viewer0).not.toContain('añade uno en Ajustes');
    expect(tarjeta(ADMIN, ESPERANDO)).toContain('settings#avisos');
    expect(tarjeta(ADMIN, ESPERANDO, undefined, sinContactos)).toContain('añade uno en Ajustes');
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

  it('«Generar otro secreto» solo para owner y admin con la revisión activa; el viewer no lo ve', () => {
    expect(tarjeta(ADMIN, ESPERANDO)).toContain('Generar otro secreto');
    expect(tarjeta(VIEWER, ESPERANDO)).not.toContain('Generar otro secreto');
    const apagada = { ...ESPERANDO, config: { ...ESPERANDO.config!, enabled: false, state: 'off' as const } };
    expect(tarjeta(ADMIN, apagada)).not.toContain('Generar otro secreto');
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
      expect(tomarSecreto(ORG, GH.id)).toBe(SECRETO);
      expect(tomarSecreto(ORG, GH.id)).toBeNull();
      expect(JSON.stringify(qc.getMutationCache().getAll().map((x) => x.state))).not.toContain('vgw_');
      expect(JSON.stringify(qc.getQueryCache().getAll().map((x) => x.state.data))).not.toContain('vgw_');
      expect(guardados.join('\n')).not.toContain('vgw_');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// Evolución (evolucion-entre-revisiones.md §6.2 y §9.3): la foto de Codebase de cada push, con los deltas del router.
describe('TarjetaRevisionCodigo · foto de cada push (evolución F3)', () => {
  const CON_FOTO: CodeReviewState = { ...ESPERANDO, recent: ESPERANDO.recent.map((r) => ({ ...r, delta: fx.deltasRevision[r.id] ?? null })) };
  const NOTA = 'un push no ve lo que se quita';

  it('la fila del push de las 19:20Z dice «1 nuevo · 7 siguen abiertos · 0 corregidos desde el push anterior», con una sola nota', () => {
    const html = tarjeta(ADMIN, CON_FOTO);
    expect(html).toContain('1 nuevo · 7 siguen abiertos · 0 corregidos desde el push anterior');
    expect(html).toContain('0 nuevos · 7 siguen abiertos · 2 corregidos desde el push anterior (1 comprobado por una auditoría)');
    expect(html.split(NOTA)).toHaveLength(2);
    // Debajo de lo que ya hay en la fila: después de los chips, dentro del mismo botón.
    const fila = html.slice(html.indexOf(`id="revision-${CON_FOTO.recent[0]!.id}"`));
    expect(fila.indexOf('1 nuevo · 7 siguen abiertos')).toBeGreaterThan(fila.indexOf('WhatsApp en 6,4 s'));
    expect(fila.indexOf('1 nuevo · 7 siguen abiertos')).toBeLessThan(fila.indexOf('</button>'));
    expect(tarjeta(VIEWER, CON_FOTO)).toContain('1 nuevo · 7 siguen abiertos · 0 corregidos desde el push anterior');
  });

  it('con dos o más repos la foto es de toda la org', () => {
    expect(tarjeta(ADMIN, CON_FOTO, undefined, undefined, true)).toContain('1 nuevo · 7 siguen abiertos en Codebase (todos los repos) · 0 corregidos');
  });

  it('sin delta (null o ausente: BACK sin 0015 o foto fallida), nada; un PR, nada aunque traiga delta', () => {
    for (const estado of [ESPERANDO, { ...ESPERANDO, recent: ESPERANDO.recent.map((r) => ({ ...r, delta: null })) }]) {
      const html = tarjeta(ADMIN, estado);
      expect(html).toContain('Revisiones recientes');
      expect(html).not.toContain('siguen abiertos');
      expect(html).not.toContain(NOTA);
    }
    const pr = { ...CON_FOTO.recent[0]!, event: 'pull_request' as const, pr_number: 7 };
    const html = tarjeta(ADMIN, { ...CON_FOTO, recent: [pr] });
    expect(html).toContain('PR #7 · ');
    expect(html).not.toContain('siguen abiertos');
    expect(html).not.toContain(NOTA);
  });
});

// Anexo de botones de WhatsApp (avisos-whatsapp-botones.md, «FRONT»): la acción tomada desde el mensaje y el repo silenciado.
describe('TarjetaRevisionCodigo · acciones desde WhatsApp', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-24T19:40:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });
  const conAccion = (whatsapp_action: unknown) => ({ ...ESPERANDO, recent: [{ ...ESPERANDO.recent[0]!,
    alert: { ...ESPERANDO.recent[0]!.alert, whatsapp_action: whatsapp_action as never, whatsapp_action_at: '2026-10-24T19:22:05.000Z' } }] });

  it('la fila de la revisión dice lo que se hizo desde WhatsApp y a qué hora; una acción nueva, el texto por defecto', () => {
    expect(tarjeta(ADMIN, conAccion('fix_sent'))).toContain('Arreglo enviado por WhatsApp · 15:22');
    expect(tarjeta(VIEWER, conAccion('pr_reopened'))).toContain('PR reabierto por WhatsApp · 15:22');
    const rara = tarjeta(ADMIN, conAccion('__proto__'));
    expect(rara).toContain('Acción por WhatsApp · 15:22');
    expect(rara).not.toContain('__proto__');
    expect(tarjeta(ADMIN, ESPERANDO)).not.toMatch(/(Arreglo enviado|Issue creado|Silenciado 1 h|PR reabierto|Acción) por WhatsApp/);   // BACK sin el anexo: nada
  });

  it('«Silenciado hasta hh:mm» (hora de Caracas) solo con muted_until en el futuro', () => {
    const silenciado = (muted_until: string | null) => tarjeta(VIEWER, { ...ESPERANDO, config: { ...ESPERANDO.config!, muted_until } });
    expect(silenciado('2026-10-24T20:30:00.000Z')).toContain('Silenciado hasta 16:30');
    expect(silenciado('2026-10-24T19:00:00.000Z')).not.toContain('Silenciado hasta');
    expect(silenciado(null)).not.toContain('Silenciado hasta');
    expect(tarjeta(ADMIN, ESPERANDO)).not.toContain('Silenciado hasta');
  });
});

describe('TarjetaRevisionCodigo · varias codebases (§6.2)', () => {
  const OTRA = 'c0000000-0000-4000-8000-000000000007';

  it('el secreto vgw_ de un repo no salta a la pestaña de otro', async () => {
    api.mockResolvedValueOnce({ config: fx.codeReviewSaved.config, webhook_secret: SECRETO });
    const qc = new QueryClient();
    await new MutationObserver(qc, opcionesGuardarRevision(ORG, qc)).mutate({ connection_id: GH.id, enabled: true });
    expect(tomarSecreto(ORG, OTRA)).toBeNull();
    expect(tomarSecreto(ORG, GH.id)).toBe(SECRETO);
  });

  it('setQueryData escribe en la clave de la pestaña de ese repo y no deja una entrada suelta sin conexión', async () => {
    api.mockResolvedValueOnce({ config: { ...fx.codeReviewSaved.config, enabled: false, state: 'off' }, webhook_secret: null });
    const qc = new QueryClient();
    qc.setQueryData(['org', ORG, 'revision', GH.id], ESPERANDO);
    qc.setQueryData(['org', ORG, 'revision', OTRA], { ...ESPERANDO, config: null });
    await new MutationObserver(qc, opcionesGuardarRevision(ORG, qc)).mutate({ connection_id: GH.id, enabled: false });
    expect(qc.getQueryData<CodeReviewState>(['org', ORG, 'revision', GH.id])?.config).toMatchObject({ enabled: false, state: 'off' });
    expect(qc.getQueryData<CodeReviewState>(['org', ORG, 'revision', OTRA])?.config).toBeNull();
    expect(qc.getQueryCache().find({ queryKey: ['org', ORG, 'revision'], exact: true })).toBeUndefined();
  });

  it('con varios repos, una config de otra conexión (BACK sin ?connection_id=) no se pinta; con uno, como siempre', () => {
    const deOtro = { ...ESPERANDO, config: { ...ESPERANDO.config!, connection_id: OTRA } };
    expect(tarjeta(ADMIN, deOtro, undefined, undefined, true)).toBe('');
    expect(tarjeta(ADMIN, deOtro)).toContain('Revisión automática de código');
    expect(tarjeta(ADMIN, ESPERANDO, undefined, undefined, true)).toContain('Revisión automática de código');
  });
});
