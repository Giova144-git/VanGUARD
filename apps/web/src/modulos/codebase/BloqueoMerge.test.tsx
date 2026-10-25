// Bloqueo de merge con críticos (bloqueo-merge-criticos.md §6 y F6; anexo de cierre de PR): bandera por config.gate y
// por 404 de E53/E54, lo que ve el viewer, la simulación antes de encender, el aviso al apagar, la fila del PR y que el
// token de estados no se queda en el MutationCache ni en el almacenamiento. Sin jsdom: renderToStaticMarkup.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { MutationObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';
import { fixtures as fx, CodeReviewState, ConnectionPublic, type MergeGateConfig } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import { opcionesAccionBloqueo, opcionesGuardarBloqueo } from '@/lib/mutaciones';
import { AVISO_APAGAR_BLOQUEO, avisoAlApagar } from '@/lib/revision';
import { AvisoApagar, SimulacionEncender, alPulsarBloqueo, errorGuardarBloqueo } from './BloqueoMerge';
import { TarjetaRevisionCodigo } from './TarjetaRevisionCodigo';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api }));

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const VIEWER: OrgActual = { ...ADMIN, role: 'viewer', puedeEscribir: false };
const GH = z.array(ConnectionPublic).parse(fx.connections).find((c) => c.provider === 'github')!;
const PAT = 'github_pat_11ESTADOS0000000000000000_secretodeprueba';
// La demo con el anexo de cierre de PR, como la sirve el router de fixtures.
const BASE = CodeReviewState.parse(fx.codeReviewStateBloqueo);
const GATE: MergeGateConfig = { ...BASE.config!.gate!, close_pr: true, can_close_pr: true };
const PR = { ...BASE.recent[0]!, gate: { ...BASE.recent[0]!.gate!, pr_action: 'closed' as const } };
const BLOQUEO: CodeReviewState = { ...BASE, config: { ...BASE.config!, gate: GATE }, recent: [PR, ...BASE.recent.slice(1)] };
const conGate = (g: Partial<MergeGateConfig>): CodeReviewState => ({ ...BLOQUEO, config: { ...BLOQUEO.config!, gate: { ...GATE, ...g } } });
const nuevoQc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function tarjeta(org: OrgActual, estado: CodeReviewState, { ruta = `/o/${ORG}/codebase`, qc = nuevoQc() } = {}) {
  qc.setQueryData(['org', ORG, 'revision', GH.id], estado);
  qc.setQueryData(['org', ORG, 'alert-prefs'], fx.alertPrefs);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}>
        <OrgDePrueba org={org}><TarjetaRevisionCodigo conexion={GH} /></OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const abierta = `/o/${ORG}/codebase?revision=${PR.id}`;

describe('BloqueoMerge · bandera', () => {
  it('sin config.gate (BACK de antes u otro repo) no se pinta la sección; con la revisión apagada, tampoco', () => {
    expect(tarjeta(ADMIN, CodeReviewState.parse(fx.codeReviewState))).not.toContain('Bloquear merges con críticos');
    const apagada = { ...BLOQUEO, config: { ...BLOQUEO.config!, enabled: false, state: 'off' as const } };
    expect(tarjeta(ADMIN, apagada)).not.toContain('Bloquear merges con críticos');
    expect(tarjeta(ADMIN, BLOQUEO)).toContain('Bloquear merges con críticos');
  });

  it('si E53 da 404 (aún sin desplegar), la sección deja de pintarse', async () => {
    const qc = nuevoQc();
    api.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Ruta inexistente'));
    await new MutationObserver(qc, opcionesGuardarBloqueo(ORG, GH.id, qc)).mutate({ enabled: true, min_severity: 'critical' }).catch(() => {});
    expect(tarjeta(ADMIN, BLOQUEO, { qc })).not.toContain('Bloquear merges con críticos');
  });

  it('si E54 da 404, la fila abierta no ofrece «Dar por bueno» ni «Reabrir el PR» (el chip sigue)', async () => {
    expect(tarjeta(ADMIN, BLOQUEO, { ruta: abierta })).toContain('Dar por bueno este commit');
    const qc = nuevoQc();
    api.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Ruta inexistente'));
    await new MutationObserver(qc, opcionesAccionBloqueo(ORG, qc)).mutate({ id: PR.id, accion: { op: 'revert' } }).catch(() => {});
    const html = tarjeta(ADMIN, BLOQUEO, { ruta: abierta, qc });
    expect(html).not.toContain('Dar por bueno este commit');
    expect(html).not.toContain('Reabrir el PR');
    expect(html).toContain('✗ Merge bloqueado · 1 crítico');
  });
});

describe('BloqueoMerge · admin y viewer', () => {
  it('el admin ve el estado, los dos interruptores, el umbral, el campo vacío del token y el paso 2 abierto', () => {
    const html = tarjeta(ADMIN, BLOQUEO);
    expect(html).toContain('Publicando en GitHub');
    expect(html).toContain('aria-label="Bloquear merges con críticos"');
    expect(html).toContain('aria-label="Cerrar los PR con críticos"');
    expect(html).toContain('Bloquea desde');
    expect(html).toContain('Comprueba en GitHub que el check “VanGUARD” es obligatorio (paso 2)');
    expect(html).toContain('Paso 1 · Token de estados y PR');
    expect(html).toContain('Paso 2 · Protección de rama en GitHub');
    expect(html).toContain(`href="https://github.com/${GH.meta.repo_full_name}/settings/branches"`);
    expect(html).toContain('proteger ramas exige GitHub Pro o Team');      // el repo de la demo es privado
    expect(html).toContain('Token de estados ••••');
  });

  it('con needs_token el paso 1 se abre: lo crea el dueño, enlace prellenado y campo password nunca prellenado', () => {
    const html = tarjeta(ADMIN, conGate({ state: 'needs_token', statuses_connection: null }));
    expect(html).toContain('Falta el token de estados');
    expect(html).toContain('Lo crea el dueño del repo');
    const owner = String(GH.meta.repo_full_name).split('/')[0];
    expect(html).toContain(`statuses=write&amp;pull_requests=write&amp;target_name=${owner}`);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*value=""/);
    expect(html).toContain('Guardar y probar');
    expect(html).toContain('Necesita el token del paso 1');
  });

  it('el viewer ve estado y umbral, sin interruptores, sin campo, sin pasos y sin «Dar por bueno»', () => {
    const html = tarjeta(VIEWER, BLOQUEO, { ruta: abierta });
    expect(html).toContain('Bloquear merges con críticos');
    expect(html).toContain('Publicando en GitHub');
    expect(html).toContain('Bloquea desde: <span class="font-semibold">Solo crítico</span>');
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('Paso 1');
    expect(html).not.toContain('Dar por bueno');
    expect(html).not.toContain('Reabrir el PR');
    expect(html).toContain('PR cerrado por VanGUARD');
  });

  it('sin permiso de pull requests el interruptor de cerrar PR sale deshabilitado y dice por qué', () => {
    const html = tarjeta(ADMIN, conGate({ can_close_pr: false }));
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*aria-label="Cerrar los PR con críticos"[^>]*disabled=""/);
    expect(html).toContain('El token no tiene «Pull requests: Read and write»');
    // Un BACK sin el anexo (close_pr ausente) no lo ofrece.
    const sinAnexo = tarjeta(ADMIN, conGate({ close_pr: undefined, can_close_pr: undefined }));
    expect(sinAnexo).not.toContain('aria-label="Cerrar los PR con críticos"');
    expect(sinAnexo).not.toContain('«Cerrar los PR con críticos»');
  });

  it('con error del token lo dice con su arreglo; un last_error fuera de contrato cae al texto por defecto', () => {
    expect(tarjeta(ADMIN, conGate({ state: 'error', last_error: 'forbidden' }))).toContain('márcale Commit statuses: Read and write');
    expect(tarjeta(ADMIN, conGate({ state: 'error', last_error: '__proto__' as never }))).toContain('El token de estados falló al publicar');
  });
});

describe('BloqueoMerge · simulación y aviso al apagar', () => {
  it('encender pasa siempre por la simulación; apagar avisa con cualquier estado que no sea off', () => {
    for (const s of ['off', 'needs_token', 'unchecked', 'needs_protection', 'active', 'error'] as const) {
      expect(alPulsarBloqueo(true, { state: s })).toBe('encender');
      expect(alPulsarBloqueo(false, { state: s })).toBe(s === 'off' ? 'apagar-ya' : 'apagar');
      expect(avisoAlApagar({ state: s })).toBe(s !== 'off');
    }
    expect(avisoAlApagar(undefined)).toBe(false);   // sin bloqueo, «Revisar cada push» se apaga sin aviso
  });

  it('la simulación dice qué publicamos, que no tocamos código y que caduca a los 30 días; el aviso al apagar, «Expected»', () => {
    const sim = renderToStaticMarkup(<SimulacionEncender rama="main" onEncender={() => {}} onCancelar={() => {}} />);
    expect(sim).toContain('publicaremos el check “VanGUARD” en GitHub');
    expect(sim).toContain('No tocamos código, ramas ni ajustes');
    expect(sim).toContain('El token caduca a los 30 días');
    expect(sim).toContain('Encender');
    expect(sim).toContain('Cancelar');
    const aviso = renderToStaticMarkup(<AvisoApagar verbo="Apagar la revisión" onConfirmar={() => {}} onCancelar={() => {}} />);
    expect(aviso).toContain(AVISO_APAGAR_BLOQUEO);
    expect(AVISO_APAGAR_BLOQUEO).toContain('“Expected”');
  });

  it('excess_scope dice qué sobra con un mapa cerrado (lo desconocido no se pinta)', () => {
    const e = new ApiError(422, 'key_rejected', 'x', undefined, { reason: 'excess_scope', excess_permissions: ['contents', '<img>', 'administration', 'contents'] });
    expect(errorGuardarBloqueo(e)).toBe('Ese token tiene permisos de más (Contents, Administration). Crea uno con solo Commit statuses y Pull requests.');
    expect(errorGuardarBloqueo(new ApiError(409, 'conflict', 'No actives el bloqueo en el repo desde el que se despliega VanGUARD', undefined, { reason: 'repo_del_producto' })))
      .toBe('No actives el bloqueo en el repo desde el que se despliega VanGUARD');
  });
});

describe('BloqueoMerge · fila del PR', () => {
  it('la fila abierta del PR #7 dice lo que bloquea, que se cerró y ofrece «Dar por bueno» y «Reabrir el PR»', () => {
    const html = tarjeta(ADMIN, BLOQUEO, { ruta: abierta });
    expect(html).toContain('✗ Merge bloqueado · 1 crítico');
    expect(html).toContain('PR cerrado por VanGUARD');
    expect(html).toContain('Lo que bloquea');
    expect(html).toContain('Arréglalo con un push nuevo al PR');
    expect(html).toContain('VanGUARD cerró este pull request');
    expect(html).toContain('Dar por bueno este commit');
    expect(html).toContain('Reabrir el PR');
  });

  it('aprobado a mano: chip propio y «Deshacer la aprobación» en vez de «Dar por bueno»', () => {
    const r = { ...PR, gate: { ...PR.gate, state: 'success' as const, override_at: '2026-10-24T19:50:00.000Z' } };
    const html = tarjeta(ADMIN, { ...BLOQUEO, recent: [r] }, { ruta: abierta });
    expect(html).toContain('✓ Aprobado a mano');
    expect(html).toContain('Deshacer la aprobación');
    expect(html).not.toContain('Dar por bueno este commit');
  });

  it('con el bloqueo apagado la fila no ofrece acciones (E54 daría 409 apagado)', () => {
    const html = tarjeta(ADMIN, conGate({ enabled: false, state: 'off' }), { ruta: abierta });
    expect(html).toContain('✗ Merge bloqueado');
    expect(html).not.toContain('Dar por bueno este commit');
  });

  it('lo que bloquea pasa por sinBidi y va en <bdi>: un recurso con U+202E no reordena la fila', () => {
    const f = { ...PR.gate.findings[0]!, resource: 'src/\u202Esj.nimda:3' };
    const html = tarjeta(ADMIN, { ...BLOQUEO, recent: [{ ...PR, gate: { ...PR.gate, findings: [f] } }] }, { ruta: abierta });
    expect(html).toContain('<bdi dir="ltr">src/⟨U+202E⟩sj.nimda:3</bdi>');
    expect(html).not.toContain('\u202E');
  });
});

describe('BloqueoMerge · el token de estados no se queda en memoria', () => {
  it('tras reset() no queda en el MutationCache, en la caché de consultas ni en el almacenamiento; el gate entra en la pestaña', async () => {
    const guardados: string[] = [];
    const almacen = { setItem: (k: string, v: string) => guardados.push(`${k}=${v}`), getItem: () => null, removeItem() {} };
    vi.stubGlobal('localStorage', almacen);
    vi.stubGlobal('sessionStorage', almacen);
    try {
      const qc = nuevoQc();
      qc.setQueryData(['org', ORG, 'revision', GH.id], conGate({ state: 'needs_token', statuses_connection: null }));
      api.mockResolvedValueOnce(fx.mergeGateSaved);
      const m = new MutationObserver(qc, opcionesGuardarBloqueo(ORG, GH.id, qc));
      const r = await m.mutate({ enabled: true, min_severity: 'critical', statuses_pat: PAT });
      expect(r.probe_state).toBe('failure');
      expect(JSON.stringify(api.mock.lastCall)).toContain(PAT);                      // viajó solo en el cuerpo
      m.reset();
      await new Promise((ok) => setTimeout(ok, 10));                                  // gcTime 0: el recolector corre en el siguiente tick
      expect(JSON.stringify(qc.getMutationCache().getAll().map((x) => x.state))).not.toContain('github_pat_');
      expect(JSON.stringify(qc.getQueryCache().getAll().map((x) => [x.queryKey, x.state.data]))).not.toContain('github_pat_');
      expect(guardados.join('\n')).not.toContain('github_pat_');
      // MergeGateSaved no trae connection_id: el gate se escribe en la pestaña desde la que se guardó.
      expect(qc.getQueryData<CodeReviewState>(['org', ORG, 'revision', GH.id])?.config?.gate?.state).toBe('unchecked');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
