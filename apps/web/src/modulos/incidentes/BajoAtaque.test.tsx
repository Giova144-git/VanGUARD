// «Modo bajo ataque» (asignaciones/modo-bajo-ataque.md §9 y §10, web): bandera por 404, qué pinta cada motivo de E55, lo
// que ve el viewer y el recorrido reposo → vista → hecho → desactivado contra el router de fixtures, con la oferta
// invalidada tras confirmar (la tarjeta pasa a «Hecho» sin recargar). Sin jsdom: renderToStaticMarkup y la caché a mano.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fixtures as fx, IncidentDetail, UnderAttackOffer, type ActionPublic } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import { useBajoAtaque } from '@/lib/mutaciones';
import { BajoAtaque, vivoDe } from './BajoAtaque';
import { Propuesta } from './BloquearIp';
import PaginaIncidente from './PaginaIncidente';

// renderToStaticMarkup no mira las claves, pero el cliente sí: dos hermanos con la misma duplican u omiten hijos al
// cambiar el de al lado. Se apuntan al crear cada elemento (el JSX de los módulos pasa por estos runtimes).
const claves = vi.hoisted(() => {
  const repetidas: unknown[] = [];
  const revisar = (props: unknown) => {
    const hijos = (props as { children?: unknown } | null)?.children;
    if (!Array.isArray(hijos)) return;
    const vistas = new Set<unknown>();
    for (const h of hijos) {
      const k = h !== null && typeof h === 'object' ? (h as { key?: unknown }).key : null;
      if (k == null) continue;
      if (vistas.has(k)) repetidas.push(k); else vistas.add(k);
    }
  };
  return { repetidas, revisar };
});
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const r = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  return { ...r, jsxDEV: (...a: Parameters<typeof r.jsxDEV>) => { claves.revisar(a[1]); return r.jsxDEV(...a); } };
});
vi.mock('react/jsx-runtime', async (importOriginal) => {
  const r = await importOriginal<typeof import('react/jsx-runtime')>();
  return { ...r, jsx: (...a: Parameters<typeof r.jsx>) => { claves.revisar(a[1]); return r.jsx(...a); },
    jsxs: (...a: Parameters<typeof r.jsxs>) => { claves.revisar(a[1]); return r.jsxs(...a); } };
});
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/supabase-doble', () => ({ tipoSesionFalsa: () => 'correo' }));
// La API va al router de fixtures de verdad (cero red); api() de producción no se carga.
vi.mock('@/lib/api', async () => {
  const { fixtureFetch } = await import('@/lib/fixtures/router');
  return { api: (ruta: string, o: { method?: string; body?: unknown } = {}) => fixtureFetch(ruta, o) };
});

const ORG = fx.me.orgs[0]!.id;
const INC = fx.incidentDetail.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', puedeEscribir: false };
const OFERTA = UnderAttackOffer.parse(fx.underAttackOffer);
const clave = (id = INC) => ['org', ORG, 'under-attack', id];
const ACTIVO = { action_id: 'ac000000-0000-4000-8000-000000000001', scope: 'host' as const, target: 'demo.officialvanguard.com',
  created_at: '2026-10-24T19:12:00.000Z', expires_at: '2099-10-24T19:42:00.000Z', retirada_fallida: false };

const nuevaCache = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
function tarjeta(org: OrgActual, oferta: UnderAttackOffer | ApiError | QueryClient, ejecutada?: ActionPublic) {
  const qc = oferta instanceof QueryClient ? oferta : nuevaCache();
  if (oferta instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: clave() }).setState({ status: 'error', error: oferta, fetchStatus: 'idle' });
  else if (!(oferta instanceof QueryClient)) qc.setQueryData(clave(), oferta);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/o/${ORG}/incidents/${INC}`]}>
        <OrgDePrueba org={org}><BajoAtaque org={ORG} incidentId={INC} puedeEscribir={org.puedeEscribir} ejecutada={ejecutada} /></OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
// Los hooks de escritura fuera de React: se pintan una vez dentro del proveedor y se usan sus funciones.
function escrituras(qc: QueryClient) {
  let h: ReturnType<typeof useBajoAtaque> | undefined;
  function Captura() { h = useBajoAtaque(ORG); return null; }
  renderToStaticMarkup(<QueryClientProvider client={qc}><Captura /></QueryClientProvider>);
  return h!;
}

describe('BajoAtaque · bandera del servidor y motivos de E55', () => {
  it('si E55 da 404 (BACK sin desplegar o ruta quitada en el corte), no pinta nada', () => {
    expect(tarjeta(ADMIN, new ApiError(404, 'not_found', 'Ruta inexistente'))).toBe('');
  });

  it('cualquier otro fallo sin una lectura buena antes tampoco pinta nada', () => {
    expect(tarjeta(ADMIN, new ApiError(500, 'internal', 'Algo falló'))).toBe('');
  });

  it.each(['no_aplica', 'cerrado', 'sin_conexion', 'motivo_fuera_de_contrato'])('con motivo %s no pinta nada', (motivo) => {
    expect(tarjeta(ADMIN, { ...OFERTA, ofrece: false, motivo: motivo as UnderAttackOffer['motivo'], scopes: [] })).toBe('');
  });

  it('una_ip: una línea en neutro, sin botón', () => {
    const html = tarjeta(ADMIN, UnderAttackOffer.parse(fx.underAttackOfferUnaIp));
    expect(html).toContain('Viene de una sola IP: con «Bloquear IP» basta.');
    expect(html).not.toContain('<button');
  });

  it('el admin ve «Activar modo bajo ataque» con las IPs, el host en <bdi dir="ltr"> y los 30 min', () => {
    const html = tarjeta(ADMIN, OFERTA);
    expect(html).toContain('Activar modo bajo ataque');
    expect(html).toContain('Llega tráfico de 2 IPs a la vez');
    expect(html).toContain('<bdi dir="ltr">demo.officialvanguard.com</bdi>');
    expect(html).toContain('durante 30 min');
    expect(html).not.toContain('disabled=""');
  });

  it('el viewer y el anónimo de la demo: botón deshabilitado y «Modo demo: solo lectura»', () => {
    const html = tarjeta(VIEWER, OFERTA);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Activar modo bajo ataque/);
    expect(html).toContain('Modo demo: solo lectura');
  });

  it('sin_permiso: explica el permiso, «Copiar pasos para hacerlo a mano» y el enlace a Conexiones', () => {
    const html = tarjeta(ADMIN, UnderAttackOffer.parse(fx.underAttackOfferSinPermiso));
    expect(html).toContain('añade Zone · Config Rules · Edit a tu token de Modo blindaje');
    expect(html).toContain('Copiar pasos para hacerlo a mano');
    expect(html).toContain(`href="/o/${ORG}/connections"`);
    expect(html).not.toContain('Activar modo bajo ataque');
    // A 375 px el texto no cabe en una línea (≈ 340 px en mono mayúsculas en una tarjeta de ≈ 267): el botón parte línea.
    const boton = html.match(/<button[^>]*>(?:(?!<\/button>).)*Copiar pasos para hacerlo a mano/)?.[0] ?? '';
    expect(boton).toContain('whitespace-normal');
    expect(boton).not.toContain('whitespace-nowrap');
  });

  it('en_curso, host_protegido, fuera_de_zona y sin_host: una línea con el motivo, sin botón', () => {
    const linea = (motivo: UnderAttackOffer['motivo']) => tarjeta(ADMIN, { ...OFERTA, ofrece: false, motivo, scopes: [] });
    expect(linea('en_curso')).toContain('Se está activando el modo bajo ataque');
    expect(linea('host_protegido')).toContain('Ese host es VanGUARD');
    expect(linea('fuera_de_zona')).toContain('<bdi dir="ltr">officialvanguard.com</bdi>');
    expect(linea('sin_host')).toContain('Ponle a tu conexión de ingesta el nombre del host atacado');
    for (const m of ['en_curso', 'host_protegido', 'fuera_de_zona', 'sin_host'] as const) expect(linea(m)).not.toContain('Activar modo bajo ataque');
  });

  it('activo: «Bajo ataque · host · hasta hora» y «Desactivar ahora»; vencido: «lo estamos retirando»', () => {
    const html = tarjeta(ADMIN, { ...OFERTA, activo: ACTIVO });
    expect(html).toContain('Bajo ataque · <span class="font-mono normal-case wrap-anywhere"><bdi dir="ltr">demo.officialvanguard.com</bdi></span> · hasta');
    expect(html).toContain('Desactivar ahora');
    const vencido = tarjeta(ADMIN, { ...OFERTA, activo: { ...ACTIVO, expires_at: '2026-10-24T19:42:00.000Z' } });
    expect(vencido).toContain('lo estamos retirando');
    expect(vencido).toContain('Desactivar ahora');
    expect(tarjeta(VIEWER, { ...OFERTA, activo: ACTIVO })).toMatch(/<button[^>]*disabled=""[^>]*>.*Desactivar ahora/);
  });

  it('retirada_fallida: la etiqueta en rojo, los pasos a la vista, «Copiar pasos» y «Reintentar»', () => {
    const copiar = 'Para borrarla a mano en Cloudflare (zona officialvanguard.com):\n1. Rules → Configuration Rules.';
    const html = tarjeta(ADMIN, { ...OFERTA, ofrece: false, motivo: 'cerrado', activo: { ...ACTIVO, retirada_fallida: true }, copiar });
    expect(html).toContain('No pudimos retirar la regla de Cloudflare');
    expect(html).toContain('text-mal');
    expect(html).toContain('Rules → Configuration Rules.');
    expect(html).toContain('Copiar pasos');
    expect(html).toContain('Reintentar');
  });

  it('el incidente refrescado con un under_attack_on executed (otra pestaña o WhatsApp) pasa a «Hecho» aunque E55 aún no lo traiga', () => {
    const ejecutada: ActionPublic = { id: ACTIVO.action_id, kind: 'under_attack_on', target: ACTIVO.target, status: 'executed',
      created_at: ACTIVO.created_at, undone_at: null, expires_at: ACTIVO.expires_at, approval_id: null };
    expect(tarjeta(ADMIN, OFERTA, ejecutada)).toContain('Desactivar ahora');
  });

  it('host, zona, objetivo y pasos con <script> y U+202E salen escapados, con el control a la vista y en <bdi dir="ltr">', () => {
    const MALO = '‮evil<script>alert(1)</script>.com';
    const VISTO = '⟨U+202E⟩evil&lt;script&gt;alert(1)&lt;/script&gt;.com';
    const activo = { ...ACTIVO, target: MALO };
    const pinturas = [
      tarjeta(ADMIN, { ...OFERTA, hostname: MALO }),
      tarjeta(ADMIN, { ...OFERTA, ofrece: false, motivo: 'fuera_de_zona', scopes: [], zone_name: MALO }),
      tarjeta(ADMIN, { ...OFERTA, activo }),
      tarjeta(ADMIN, { ...OFERTA, activo: { ...activo, retirada_fallida: true }, copiar: MALO }),
    ];
    for (const html of pinturas) {
      expect(html).not.toContain('<script');
      expect(html).not.toContain('‮');
      expect(html).toContain(`<bdi dir="ltr">${VISTO}</bdi>`);
    }
  });
});

describe('vivoDe: qué cuenta como modo activo', () => {
  const local = { id: ACTIVO.action_id, host: ACTIVO.target, en: ACTIVO.created_at, expira: ACTIVO.expires_at, fallida: false };
  const ejecutada: ActionPublic = { id: 'ac000000-0000-4000-8000-000000000009', kind: 'under_attack_on', target: ACTIVO.target,
    status: 'executed', created_at: ACTIVO.created_at, undone_at: null, expires_at: ACTIVO.expires_at, approval_id: null };

  it('el activo de E55 manda sobre todo lo demás', () => {
    expect(vivoDe({ ...OFERTA, activo: ACTIVO }, 0, { f: 'hecho', vivo: { ...local, id: 'otro' }, canje: 1 }, ejecutada)).toMatchObject({ id: ACTIVO.action_id });
  });

  it('lo confirmado en esta pestaña vale hasta que E55 se relee; releída sin activo (ya retirado), no queda «lo estamos retirando»', () => {
    expect(vivoDe(OFERTA, 999, { f: 'hecho', vivo: local, canje: 1_000 }, undefined)).toEqual(local);
    expect(vivoDe(OFERTA, 1_001, { f: 'hecho', vivo: local, canje: 1_000 }, undefined)).toBeNull();
  });

  it('el under_attack_on del incidente refrescado no pisa una vista abierta después de su created_at', () => {
    const p = fx.underAttackProposal;
    const t = Date.parse(ejecutada.created_at);
    expect(vivoDe(OFERTA, 0, { f: 'vista', p, desde: t + 1 }, ejecutada)).toBeNull();
    expect(vivoDe(OFERTA, 0, { f: 'vista', p, desde: t - 1 }, ejecutada)).toMatchObject({ id: ejecutada.id });
    expect(vivoDe(OFERTA, 0, { f: 'reposo' }, ejecutada)).toMatchObject({ id: ejecutada.id, fallida: false });
  });
});

describe('Propuesta con las props de BajoAtaque', () => {
  it('verbo «Activar bajo ataque» y sin el botón del WhatsApp; por defecto, igual que hoy', () => {
    const p = { ...fx.underAttackProposal, expires_at: '2099-01-01T00:00:00.000Z' };
    const resto = { codigo: '', alCambiarCodigo: () => {}, escribiendo: false, alConfirmar: () => {}, alCancelar: () => {}, alVencer: () => {} };
    const bajo = renderToStaticMarkup(<Propuesta p={p} {...resto} verbo="Activar bajo ataque" conBotonWhatsapp={false} />);
    expect(bajo).toContain('Activar bajo ataque');
    expect(bajo).toContain('Te lo enviamos por WhatsApp. Vence en');
    expect(bajo).not.toContain('botón del mensaje');
    expect(bajo).not.toContain('Confirmar bloqueo');
    const bloqueo = renderToStaticMarkup(<Propuesta p={p} {...resto} />);
    expect(bloqueo).toContain('Confirmar bloqueo');
    expect(bloqueo).toContain('Te lo enviamos por WhatsApp. También puedes aprobar con el botón del mensaje.');
  });
});

describe('BajoAtaque · recorrido con el router de fixtures', () => {
  beforeAll(() => { vi.spyOn(console, 'debug').mockImplementation(() => {}); });
  afterAll(() => { vi.restoreAllMocks(); });

  it('reposo → vista → hecho (sin recargar: la oferta queda invalidada) → desactivado', async () => {
    const qc = nuevaCache();
    const { api } = await import('@/lib/api');
    const leer = () => qc.fetchQuery({ queryKey: clave(), staleTime: 0,
      queryFn: async () => UnderAttackOffer.parse(await api(`/api/orgs/${ORG}/incidents/${INC}/under-attack`)) });
    expect(await leer()).toEqual(fx.underAttackOffer);
    expect(tarjeta(ADMIN, qc)).toContain('Activar modo bajo ataque');

    const b = escrituras(qc);
    const p = await b.proponer(INC);
    expect(p).toMatchObject({ approval_id: fx.underAttackProposal.approval_id, target: 'demo.officialvanguard.com', validado: true });
    expect(Date.parse(p.expires_at)).toBeGreaterThan(Date.now() + 9 * 60_000);   // el router la reescribe con Date.now()

    expect(await b.confirmar(p.approval_id, '000000').catch((e: ApiError) => e.details)).toMatchObject({ reason: 'wrong_code' });
    const r = await b.confirmar(p.approval_id, '123456');
    expect(r).toMatchObject({ ok: true, action_id: 'ac000000-0000-4000-8000-000000000001' });
    expect(qc.getQueryState(clave())?.isInvalidated).toBe(true);           // fin() invalida ['org', org, 'under-attack', id]
    const o = await leer();
    expect(o.activo).toMatchObject({ action_id: r.action_id, target: 'demo.officialvanguard.com', retirada_fallida: false });
    expect(Date.parse(o.activo!.expires_at!) - Date.parse(o.activo!.created_at)).toBe(30 * 60_000);
    expect(tarjeta(ADMIN, qc)).toContain('Desactivar ahora');

    // E56 otra vez con el modo vivo: 409 already_active con el action_id.
    expect(await b.proponer(INC).catch((e: ApiError) => ({ status: e.status, ...e.details }))).toMatchObject({ status: 409, reason: 'already_active', action_id: r.action_id });

    const d = await b.deshacer(r.action_id!);
    expect(d).toMatchObject({ ok: true, resultado: 'Modo bajo ataque desactivado' });
    expect((await leer()).activo).toBeNull();
    expect(tarjeta(ADMIN, qc)).toContain('Activar modo bajo ataque');
  }, 15_000);

  // El incidente entero, con la oferta de E55 en la caché (o su error) y las conexiones de la demo (hay Modo blindaje).
  function pagina(i: IncidentDetail, oferta?: UnderAttackOffer | ApiError) {
    const qc = nuevaCache();
    qc.setQueryData(['org', ORG, 'incident', INC], i);
    qc.setQueryData(['org', ORG, 'connections'], fx.connections);
    if (oferta instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: clave() }).setState({ status: 'error', error: oferta, fetchStatus: 'idle' });
    else if (oferta) qc.setQueryData(clave(), oferta);
    claves.repetidas.length = 0;
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/o/${ORG}/incidents/${INC}`]}>
          <OrgDePrueba org={ADMIN}><Routes><Route path="/o/:orgId/incidents/:incidentId" element={<PaginaIncidente />} /></Routes></OrgDePrueba>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }
  const acciones = (html: string) => html.match(/<section[^>]*aria-label="Acciones">[\s\S]*?<\/section>/)?.[0];

  it('con E55 en 404 la sección Acciones queda igual que en un incidente sin inundación (ni título ni hueco)', () => {
    const conInundacion = pagina(IncidentDetail.parse(fx.incidentDetail), new ApiError(404, 'not_found', 'Ruta inexistente'));
    const sin = pagina(IncidentDetail.parse({ ...fx.incidentDetail, rule_ids: fx.incidentDetail.rule_ids.filter((r) => r !== 'CF_IP_FLOOD') }));
    expect(acciones(conInundacion)).toBeTruthy();
    expect(acciones(conInundacion)).toBe(acciones(sin));
    expect(conInundacion).not.toMatch(/bajo ataque/i);
  });

  it('el incidente muestra la tarjeta bajo «Bloquear IP» y la acción como «Modo bajo ataque»', () => {
    const i = IncidentDetail.parse({ ...fx.incidentDetail, status: 'mitigated', acked_at: fx.incidentDetail.started_at, acked_via: 'whatsapp',
      actions: [{ id: ACTIVO.action_id, kind: 'under_attack_on', target: ACTIVO.target, status: 'executed', created_at: ACTIVO.created_at,
        undone_at: null, expires_at: ACTIVO.expires_at, approval_id: null }],
      timeline: [...fx.incidentDetail.timeline, { t: ACTIVO.created_at, ms: 660_000, kind: 'action_executed', label: 'Modo bajo ataque activo' }] });
    const html = pagina(i, { ...OFERTA, activo: ACTIVO });
    expect(claves.repetidas).toEqual([]);                                  // BloquearIp y BajoAtaque no comparten clave
    expect(html.indexOf('Bloquear esta IP')).toBeGreaterThan(-1);
    expect(html.indexOf('Desactivar ahora')).toBeGreaterThan(html.indexOf('Bloquear esta IP'));
    expect(html).toContain('Visto por WhatsApp');
    expect(html).toContain('Modo bajo ataque</span>');
    expect(html).toContain('Bajo ataque activado');                       // el hito ya no dice «IP bloqueada»
    expect(html).not.toContain('IP bloqueada');
  });
});
