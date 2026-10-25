// «Bloquear merges con críticos» (bloqueo-merge-criticos.md §6.1; anexo bloqueo-merge-cierre-pr.md): en cada pull request
// y en cada push a la rama vigilada VanGUARD publica el check «VanGUARD» en GitHub (✗ si lo añadido trae un crítico) y,
// con «Cerrar los PR con críticos», además cierra el PR. Lo monta TarjetaRevisionCodigo solo si E45 trae config.gate (BACK
// con 0016 y repo del token de estados, varias-codebases §2.6) y la revisión está activa; si E53 da 404 no se pinta.
// Encender pasa por la simulación (D3): es el consentimiento de una escritura automática en el GitHub del cliente.
// El token de estados vive en el estado del formulario y en la mutación (gcTime 0 y reset() al terminar): nunca toca
// storage, la URL ni la caché de consultas.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import type { CodeReviewConfig, CommitStatusState, ConnectionPublic, MergeGateConfig, MergeGateMin, MergeGateProtection, MergeGatePut, PermCheck } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { Spinner } from '@/componentes/ui/spinner';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { CampoToken } from '@/componentes/vg/FormToken';
import { Interruptor } from '@/componentes/vg/Interruptor';
import { ListaChecks } from '@/componentes/vg/ListaChecks';
import { SectorPlegable } from '@/componentes/vg/SectorPlegable';
import { useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { esApiError, mensajeDe } from '@/lib/errores';
import { cuando } from '@/lib/formato';
import { GUIA_ESTADOS_GITHUB } from '@/lib/guias';
import { useGuardarBloqueo, useRutaAusente } from '@/lib/mutaciones';
import { preGuardar, type Rechazo } from '@/lib/pre-guardas';
import { AVISO_APAGAR_BLOQUEO, UMBRALES_BLOQUEO, avisoAlApagar, chipEstadoBloqueo, textoErrorTokenBloqueo, textoPrueba, textosProteccion } from '@/lib/revision';
import { deMapa } from '@/lib/severidad';

const REPO_VALIDO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;   // solo así se arma un enlace a github.com
const SHA = /^[0-9a-f]{40}$/;
const SELECTOR = 'h-12 rounded-lg border border-input bg-card px-3 text-[15px] outline-none focus-visible:border-info focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60';
const TEXTO_UMBRAL = Object.fromEntries(UMBRALES_BLOQUEO) as Record<MergeGateMin, string>;
const DE_MAS: Record<string, string> = { contents: 'Contents', administration: 'Administration' };
const ESTADO_TOKEN: Record<string, string> = { error: 'falla', expired: 'vencido', revoked: 'revocado' };

// Lo que E53 rechaza (§4.1). El mensaje del servidor ya llega en español y con los controles bidi a la vista (ApiError);
// los permisos de más, por mapa cerrado.
export function errorGuardarBloqueo(e: unknown): string {
  if (!esApiError(e)) return mensajeDe(e);
  const d = e.details ?? {};
  if (d.reason === 'excess_scope') {
    const de = Array.isArray(d.excess_permissions) ? [...new Set(d.excess_permissions.map((p) => deMapa(DE_MAS, p, '')).filter(Boolean))] : [];
    return `Ese token tiene permisos de más${de.length ? ` (${de.join(', ')})` : ''}. Crea uno con solo Commit statuses y Pull requests.`;
  }
  if (e.status === 429) return 'Demasiados intentos: espera un minuto y vuelve a probar';
  return mensajeDe(e);
}

// Confirmación en el sitio, sin modal (L6): Esc cancela y el foco va al botón que confirma. La usan la simulación de
// encender, el aviso al apagar y «Dar por bueno».
export function PanelConfirmar({ etiqueta, verbo, peligro, ocupado, deshabilitado, onConfirmar, onCancelar, children }: {
  etiqueta: string; verbo: string; peligro?: boolean; ocupado?: boolean; deshabilitado?: boolean;
  onConfirmar: () => void; onCancelar: () => void; children: ReactNode;
}) {
  const boton = useRef<HTMLButtonElement>(null);
  const cancelar = useRef(onCancelar);
  useEffect(() => { cancelar.current = onCancelar; });
  useEffect(() => {
    boton.current?.focus();                                          // al abrir, una vez
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); cancelar.current(); } };
    window.addEventListener('keydown', tecla, true);                 // en captura: no cierra paneles de detrás
    return () => window.removeEventListener('keydown', tecla, true);
  }, []);
  return (
    <div role="group" aria-label={etiqueta} className={`flex flex-col gap-3 rounded-xl border p-4 text-[15px] ${peligro ? 'border-aviso-borde bg-aviso-relleno' : 'bg-background'}`}>
      {children}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secundaria" size="grande" disabled={ocupado} onClick={onCancelar}>Cancelar</Button>
        <Button ref={boton} type="button" variant={peligro ? 'peligro' : 'principal'} size="grande" disabled={deshabilitado} aria-busy={ocupado || undefined}
          onClick={ocupado ? undefined : onConfirmar}>
          {ocupado ? <Spinner /> : null}{verbo}
        </Button>
      </div>
    </div>
  );
}

// Simulación antes de encender (D3): qué publicamos, cuándo y qué efecto tiene con y sin la protección de rama.
// `cerrarPr`: el BACK trae el anexo de cierre de PR (MergeGateConfig.close_pr).
export function SimulacionEncender({ rama, cerrarPr = true, ocupado, onEncender, onCancelar }: {
  rama: ReactNode; cerrarPr?: boolean; ocupado?: boolean; onEncender: () => void; onCancelar: () => void;
}) {
  return (
    <PanelConfirmar etiqueta="Encender el bloqueo de merge" verbo="Encender" ocupado={ocupado} onConfirmar={onEncender} onCancelar={onCancelar}>
      <p>
        En cada pull request y en cada push a {rama} publicaremos el check “VanGUARD” en GitHub: ✗ si el cambio añade un hallazgo
        crítico (o alto, según el umbral) o si no pudimos leerlo entero; ✓ si no. Si en GitHub marcas ese check como obligatorio, un ✗
        impide fusionar.
      </p>
      {cerrarPr ? <p>Con «Cerrar los PR con críticos», además cerramos el pull request con un comentario fijo de VanGUARD, sin rutas ni valores. Se reabre desde su revisión.</p> : null}
      <p className="text-muted-foreground">
        No tocamos código, ramas ni ajustes. Lo apagas aquí cuando quieras y cada ✗ se puede dar por bueno desde su revisión. El token
        caduca a los 30 días: entonces dejamos de publicar.
      </p>
    </PanelConfirmar>
  );
}

// Aviso al apagar el bloqueo o «Revisar cada push» con el bloqueo publicando (§6.1).
export function AvisoApagar({ verbo, ocupado, onConfirmar, onCancelar }: { verbo: string; ocupado?: boolean; onConfirmar: () => void; onCancelar: () => void }) {
  return (
    <PanelConfirmar etiqueta={verbo} verbo={verbo} peligro ocupado={ocupado} onConfirmar={onConfirmar} onCancelar={onCancelar}>
      <p className="font-medium text-aviso">{AVISO_APAGAR_BLOQUEO}</p>
    </PanelConfirmar>
  );
}

// Qué pasa al pulsar el interruptor (D3 y §6.1): encender siempre pasa por la simulación; apagar con el bloqueo
// publicando, por el aviso; si no, se apaga sin más.
export const alPulsarBloqueo = (v: boolean, g: Pick<MergeGateConfig, 'state'>): 'encender' | 'apagar' | 'apagar-ya' =>
  v ? 'encender' : avisoAlApagar(g) ? 'apagar' : 'apagar-ya';

export function BloqueoMerge({ c, gate, conexion }: { c: CodeReviewConfig; gate: MergeGateConfig; conexion: ConnectionPublic }) {
  const org = useOrg();
  const guardar = useGuardarBloqueo(org.id, conexion.id);
  const sinRuta = useRutaAusente(org.id, 'E53');
  const [fase, setFase] = useState<'reposo' | 'encender' | 'apagar'>('reposo');
  const [error, setError] = useState<string | null>(null);
  // Lo que publicó «Guardar y probar». Vive aquí: al guardar, el estado deja needs_token y el paso 1 se vuelve a montar plegado.
  const [prueba, setPrueba] = useState<Prueba | null>(null);
  if (sinRuta) return null;

  const rama = <bdi dir="ltr" className="font-mono">{sinBidi(c.branch)}</bdi>;
  const repo = REPO_VALIDO.test(c.repo_full_name) ? c.repo_full_name : null;
  const chip = chipEstadoBloqueo(gate);
  const tok = gate.statuses_connection;
  const enviar = async (body: MergeGatePut) => {
    setError(null);
    try { await guardar.mutateAsync(body); setFase('reposo'); }
    catch (e) { setError(errorGuardarBloqueo(e)); }
    finally { guardar.reset(); }
  };
  const base = { enabled: gate.enabled, min_severity: gate.min_severity };
  const cambiar = (v: boolean) => {
    const paso = alPulsarBloqueo(v, gate);
    if (paso === 'apagar-ya') void enviar({ ...base, enabled: false });
    else setFase(paso);
  };
  const cancelar = () => setFase('reposo');
  const abrirToken = gate.state === 'needs_token' || gate.state === 'error';
  const abrirProteccion = gate.state === 'unchecked' || gate.state === 'needs_protection';

  return (
    <section className="flex flex-col gap-3 rounded-xl border px-4 py-4" aria-labelledby={`t-bloqueo-${conexion.id}`}>
      <div className="flex flex-wrap items-center gap-3">
        <ShieldCheck className="size-5 text-muted-foreground" strokeWidth={1.5} aria-hidden />
        <h4 id={`t-bloqueo-${conexion.id}`} className="flex-1 text-[15px] font-semibold">Bloquear merges con críticos</h4>
        <Etiqueta texto={chip.texto} rol={chip.rol} />
        {org.puedeEscribir ? (
          <label className="flex items-center gap-2 text-sm font-medium">
            <Interruptor activo={gate.enabled} etiqueta="Bloquear merges con críticos" ocupado={guardar.isPending} deshabilitado={fase !== 'reposo'} onCambio={cambiar} />
            {gate.enabled ? 'Encendido' : 'Apagado'}
          </label>
        ) : null}
      </div>
      <p className="text-[15px] text-muted-foreground">
        Si un cambio añade un hallazgo crítico, marcamos ✗ “VanGUARD” en GitHub. Con la protección de rama, GitHub no deja fusionarlo.
      </p>
      {gate.state === 'unchecked' ? <p className="text-sm">Comprueba en GitHub que el check “VanGUARD” es obligatorio (paso 2).</p> : null}
      {gate.protection ? <LecturaProteccion p={gate.protection} /> : null}
      {/* P1: E53 sin token relee la protección con el token de lectura. Solo con el token de estados activo. */}
      {org.puedeEscribir && gate.enabled && tok?.status === 'active' ? (
        <div>
          <Button variant="secundaria" aria-busy={guardar.isPending || undefined} onClick={guardar.isPending ? undefined : () => void enviar(base)}>
            {guardar.isPending ? <Spinner /> : <RefreshCw />}Comprobar de nuevo
          </Button>
        </div>
      ) : null}
      {gate.state === 'error' ? <p className="text-[15px] font-medium text-mal">{textoErrorTokenBloqueo(gate.last_error)}</p> : null}
      {fase === 'encender' ? <SimulacionEncender rama={rama} cerrarPr={gate.close_pr !== undefined} ocupado={guardar.isPending} onCancelar={cancelar}
        onEncender={() => void enviar({ ...base, enabled: true })} /> : null}
      {fase === 'apagar' ? <AvisoApagar verbo="Apagar el bloqueo" ocupado={guardar.isPending} onCancelar={cancelar} onConfirmar={() => void enviar({ ...base, enabled: false })} /> : null}
      <p role="alert" className="min-h-5 text-sm text-mal">{error ?? ''}</p>

      {org.puedeEscribir ? (
        <label className="flex flex-wrap items-center gap-2 text-[15px]">
          Bloquea desde
          <select className={SELECTOR} value={gate.min_severity} disabled={guardar.isPending}
            onChange={(e) => void enviar({ ...base, min_severity: e.target.value as MergeGateMin })}>
            {UMBRALES_BLOQUEO.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
        </label>
      ) : <p className="text-[15px]">Bloquea desde: <span className="font-semibold">{deMapa(TEXTO_UMBRAL, gate.min_severity, '—')}</span></p>}

      {tok ? (
        <p className="text-sm text-muted-foreground">
          Token de estados ••••<bdi dir="ltr" className="font-mono">{sinBidi(tok.last4 ?? '')}</bdi>
          {tok.expires_at ? ` · caduca ${cuando(tok.expires_at)}` : ''}
          {tok.status !== 'active' ? <span className="font-medium text-mal"> · {deMapa(ESTADO_TOKEN, tok.status, 'falla')}</span> : null}
        </p>
      ) : null}
      {prueba ? <ResultadoPrueba prueba={prueba} /> : null}

      {gate.enabled && gate.close_pr !== undefined ? (
        <CerrarPr gate={gate} puedeEscribir={org.puedeEscribir} ocupado={guardar.isPending}
          onCambio={(v) => void enviar({ ...base, close_pr: v })} />
      ) : null}

      {org.puedeEscribir && gate.enabled ? <>
        <SectorPlegable key={abrirToken ? 'token-abierto' : 'token-plegado'} titulo="Paso 1 · Token de estados y PR" defaultOpen={abrirToken}>
          <PasoToken org={org.id} conexionId={conexion.id} repo={repo} rama={rama} gate={gate} alProbar={setPrueba} />
        </SectorPlegable>
        <SectorPlegable key={abrirProteccion ? 'rama-abierto' : 'rama-plegado'} titulo="Paso 2 · Protección de rama en GitHub" defaultOpen={abrirProteccion}>
          <PasoProteccion repo={repo} rama={rama} privado={conexion.meta.private === true} cerrarPr={gate.close_pr !== undefined} />
        </SectorPlegable>
        <p className="text-sm text-muted-foreground">
          Si un PR se queda en “Expected” y no aparece aquí abajo: en GitHub → Settings → Webhooks → Recent Deliveries → “Redeliver”. Si
          cambiaste la rama base del PR, empuja un commit nuevo o ciérralo y reábrelo.
        </p>
      </> : null}
    </section>
  );
}

// P1: lo que E53 leyó de la protección de la rama (textos por mapa cerrado) y cuándo.
function LecturaProteccion({ p }: { p: MergeGateProtection }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      {textosProteccion(p).map((t) => <p key={t}>{t}</p>)}
      <p className="text-[12.5px] text-texto-3">Comprobado {cuando(p.checked_at)}</p>
    </div>
  );
}

// Anexo de cierre de PR: el interruptor solo vale si el token tiene «Pull requests: Read and write» (can_close_pr).
function CerrarPr({ gate, puedeEscribir, ocupado, onCambio }: { gate: MergeGateConfig; puedeEscribir: boolean; ocupado: boolean; onCambio: (v: boolean) => void }) {
  const puede = gate.can_close_pr !== false;
  const activo = !!gate.close_pr && puede;
  const ayuda = !gate.statuses_connection
    ? 'Necesita el token del paso 1, con «Pull requests: Read and write».'
    : !puede ? 'El token no tiene «Pull requests: Read and write»: créalo de nuevo con ese permiso (paso 1) para poder cerrarlos.'
    : 'Si un pull request añade un crítico nuevo, además del ✗ lo cerramos con un comentario de VanGUARD. Sirve en cualquier plan de GitHub, también en repos privados sin Pro. Si alguien lo reabre a mano sin commits nuevos, no lo volvemos a cerrar.';
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-[15px] font-medium">
        {puedeEscribir ? <Interruptor activo={activo} etiqueta="Cerrar los PR con críticos" ocupado={ocupado} deshabilitado={!puede} onCambio={onCambio} /> : null}
        Cerrar los PR con críticos{puedeEscribir ? null : <span className="font-semibold">: {activo ? 'encendido' : 'apagado'}</span>}
      </label>
      <p className="text-sm text-muted-foreground">{ayuda}</p>
    </div>
  );
}

// Paso 1 (§6.1, con el anexo): lo crea el dueño del repo; «Guardar y probar» publica un estado de prueba en el último
// commit de la rama. Tras el éxito el campo se vacía y la mutación sale del MutationCache (reset()).
type Prueba = { sha: string | null; estado: CommitStatusState | null; checks: PermCheck[] };
function ResultadoPrueba({ prueba }: { prueba: Prueba }) {
  return (
    <div role="status" className="flex flex-col gap-2 text-[15px]">
      <p className="font-medium">Publicamos {textoPrueba(prueba.estado)}{prueba.sha ? <> · commit <span className="font-mono">{prueba.sha.slice(0, 7)}</span></> : null}.</p>
      <ListaChecks checks={prueba.checks} />
    </div>
  );
}

function PasoToken({ org, conexionId, repo, rama, gate, alProbar }: {
  org: string; conexionId: string; repo: string | null; rama: ReactNode; gate: MergeGateConfig; alProbar: (p: Prueba | null) => void;
}) {
  const guardar = useGuardarBloqueo(org, conexionId);
  const [valor, setValor] = useState('');
  const [rechazo, setRechazo] = useState<Rechazo | string | null>(null);
  const owner = repo ? repo.split('/')[0]! : null;
  const enviar = async (ev: FormEvent) => {
    ev.preventDefault();
    if (guardar.isPending) return;
    const v = valor.trim();
    const r = preGuardar(v, 'github')
      ?? (v.startsWith('github_pat_') ? null : { titulo: 'No es un token fine-grained', explicacion: 'Los tokens fine-grained empiezan por github_pat_: créalo con el enlace de arriba.' });
    setRechazo(r);
    if (r) return;
    alProbar(null);
    try {
      const res = await guardar.mutateAsync({ enabled: true, min_severity: gate.min_severity, statuses_pat: v });
      setValor('');
      alProbar({ sha: typeof res.probe_sha === 'string' && SHA.test(res.probe_sha) ? res.probe_sha : null, estado: res.probe_state,
        checks: Array.isArray(res.checks) ? res.checks : [] });
    } catch (e) {
      setRechazo(errorGuardarBloqueo(e));
    } finally {
      guardar.reset();
    }
  };
  const paso = 'flex flex-col gap-1 border-b py-3 first:pt-0 last:border-b-0';
  return (
    <form onSubmit={enviar} className="flex flex-col gap-3 text-[15px]">
      <ol className="flex flex-col" aria-label="Pasos para crear el token de estados">
        <li className={paso}><span><span className="font-semibold">1.</span> {GUIA_ESTADOS_GITHUB.quien}</span></li>
        <li className={paso}>
          <span><span className="font-semibold">2.</span> {GUIA_ESTADOS_GITHUB.crear}</span>
          <a href={GUIA_ESTADOS_GITHUB.enlace(owner)} target="_blank" rel="noopener noreferrer" className="inline-flex w-fit items-center gap-1 font-medium underline underline-offset-4">
            Crear token en GitHub<ExternalLink className="size-3.5" /></a>
        </li>
        <li className={paso}><span><span className="font-semibold">3.</span> {GUIA_ESTADOS_GITHUB.acceso} {repo
          ? <bdi dir="ltr" className="font-mono break-all">{sinBidi(repo)}</bdi> : 'tu repo'}.</span></li>
        <li className={paso}><span><span className="font-semibold">4.</span> {GUIA_ESTADOS_GITHUB.permisos}</span></li>
      </ol>
      <CampoToken id={`estados-${conexionId}`} etiqueta="Token de estados (github_pat_…)" valor={valor} error={rechazo}
        onCambio={(x) => { setValor(x); setRechazo(null); }} />
      <p className="text-sm">
        Al guardar publicamos un estado de prueba “VanGUARD” en el último commit de {rama}: ✗ si ya sabemos que tiene un crítico; si no,
        “pendiente”. Nunca un ✓ sobre un commit que no revisamos.
      </p>
      <div>
        <Button type="submit" variant="principal" size="grande" disabled={!valor.trim() || guardar.isPending} aria-busy={guardar.isPending || undefined}>
          {guardar.isPending ? <Spinner /> : null}Guardar y probar
        </Button>
      </div>
    </form>
  );
}

// Paso 2 (§9, en corto): la protección de rama la activa el dueño a mano; P0 no la lee.
function PasoProteccion({ repo, rama, privado, cerrarPr }: { repo: string | null; rama: ReactNode; privado: boolean; cerrarPr: boolean }) {
  const paso = 'border-b py-3 first:pt-0 last:border-b-0';
  return (
    <div className="flex flex-col gap-3 text-[15px]">
      <ol className="flex flex-col" aria-label="Pasos para proteger la rama en GitHub">
        <li className={paso}><span className="font-semibold">1.</span> Abre {repo
          ? <a href={`https://github.com/${repo}/settings/branches`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono break-all underline underline-offset-4">
              <bdi dir="ltr">github.com/{sinBidi(repo)}/settings/branches</bdi><ExternalLink className="size-3.5" /></a>
          : 'Settings → Branches en tu repositorio'} → «Add classic branch protection rule».</li>
        <li className={paso}><span className="font-semibold">2.</span> Branch name pattern: {rama}.</li>
        <li className={paso}><span className="font-semibold">3.</span> Marca «Require a pull request before merging». Para la demo, desmarca «Require approvals».</li>
        <li className={paso}><span className="font-semibold">4.</span> Marca «Require status checks to pass before merging», busca <span className="font-mono">VanGUARD</span> y elígelo (Any source). Aparece después de «Guardar y probar».</li>
        <li className={paso}><span className="font-semibold">5.</span> Marca «Do not allow bypassing the above settings» para que valga también para los admins.</li>
        <li className={paso}><span className="font-semibold">6.</span> «Create». Para comprobarlo: un PR con un crítico muestra ✗ y «Merging is blocked».</li>
      </ol>
      {privado ? (
        <p className="text-sm font-medium">
          En un repo privado, proteger ramas exige GitHub Pro o Team. Sin eso el ✗ solo avisa{cerrarPr ? ': enciende «Cerrar los PR con críticos» para que el PR no se pueda fusionar' : ''}.
        </p>
      ) : null}
    </div>
  );
}
