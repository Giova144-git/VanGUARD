// /o/:orgId/connections/:provider (S14 §14.10): pasos a la izquierda y formulario a la derecha (apilado en móvil).
// Pre-guardas antes de enviar; el token vive solo en el campo y se vacía al enviar, con éxito o con error (L10).
// «Que Vigía me guíe» recorre los data-guia de esta pantalla (guia-vigia.ts). Tras cada prueba Vigía comenta el
// resultado solo si ya está a la vista: pedir la guía la llama; si alguien la despidió, la prueba no la trae de vuelta.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, CircleCheck, ExternalLink, Eye } from 'lucide-react';
import type { ConnectionCreate, ConnectionCreated, Provider } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { Spinner } from '@/componentes/ui/spinner';
import { BotonCopiar } from '@/componentes/vg/BotonCopiar';
import { CampoTexto, CampoToken } from '@/componentes/vg/FormToken';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { ListaChecks } from '@/componentes/vg/ListaChecks';
import { useGuia, type Dicho } from '@/componentes/vigia/contexto';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import NoEncontrada from '@/app/paginas/NoEncontrada';
import { sinBidi } from '@/lib/bidi';
import { esApiError, mensajeDe } from '@/lib/errores';
import { GUIA_CLOUDFLARE_SITIO, GUIAS_CONEXION, type PasoConexion } from '@/lib/guias';
import { useConectar } from '@/lib/mutaciones';
import { nombrePermiso } from '@/lib/permisos';
import { extraerProjectRef, extraerRepo, extraerUrlSitio, preGuardar, zoneIdValido, type Rechazo } from '@/lib/pre-guardas';
import { cn } from '@/lib/utils';
import type { EstadoBlindaje } from './ActivarBlindaje';
import { dichoDeChecks, dichoDeError, dichoDeRechazo, GUIA_VIGIA, GUIA_VIGIA_CF_SITIO } from './guia-vigia';

const PROVEEDORES: Provider[] = ['supabase', 'cloudflare', 'github', 'ingest'];
type Errores = Partial<Record<'ref' | 'token' | 'zona' | 'url' | 'accion' | 'repo' | 'label', Rechazo | string>> & { general?: string };
// Cloudflare (cloudflare-por-url.md): «Zona» (zone_id + token de lectura, como siempre) o «Sitio» (URL de Pages, Workers o
// su dominio, token de cuenta opcional y sin Modo blindaje, que necesita una zona).
type ModoCf = 'zone' | 'url';
const MODOS_CF: { modo: ModoCf; texto: string }[] = [
  { modo: 'url', texto: 'Sitio (URL de Pages, Workers o dominio)' },
  { modo: 'zone', texto: 'Zona (Zone ID)' },
];
const AYUDA_TOKEN_SITIO = 'Opcional. Con un token de cuenta con Cloudflare Pages · Read y Workers Scripts · Read también revisamos la configuración del proyecto. Sin token revisamos el sitio por HTTP.';

function Pasos({ g }: { g: { pasos: PasoConexion[] } }) {
  return (
    <ol className="flex flex-col gap-4">
      {g.pasos.map((p, i) => (
        <li key={i} className="flex gap-3" data-guia={`conexion-paso-${i + 1}`}>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-foreground tabular-nums">{i + 1}</span>
          <div className="flex flex-col gap-2 pt-1">
            <p className="text-[15px] leading-relaxed">{p.texto}</p>
            {p.enlace ? <a href={p.enlace.href} target="_blank" rel="noopener noreferrer" data-guia="conexion-enlace"
              className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-foreground underline underline-offset-4">
              {p.enlace.texto}<ExternalLink className="size-3.5" /></a> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

// Lo que el servidor devolvió al crear: permisos comprobados, ••••last4 y, en la ingesta, el secreto UNA vez.
export function Resultado({ r, alTerminar }: { r: ConnectionCreated; alTerminar: () => void }) {   // exportada para el arnés de XSS
  const [guardado, setGuardado] = useState(false);
  const titulo = useRef<HTMLSpanElement>(null);
  useEffect(() => titulo.current?.focus(), []);   // el botón enviado desaparece: el foco pasa al resultado
  const c = r.connection;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <CircleCheck className="size-6 text-bien" />
        <span ref={titulo} tabIndex={-1} className="text-[17px] font-semibold outline-none">Conectado</span>
        {c.last4 ? <span className="font-mono text-[13px] text-muted-foreground">••••<bdi dir="ltr">{sinBidi(c.last4)}</bdi></span> : null}
        {r.action_connection ? <Etiqueta texto="Modo blindaje activo" rol="info" /> : null}
      </div>
      <div data-guia="conexion-permisos"><ListaChecks checks={r.checks} /></div>
      {r.ingest_secret ? (
        <div className="flex flex-col gap-3 rounded-xl border border-aviso-borde bg-aviso-relleno p-4">
          <p className="text-sm font-semibold text-aviso">Copia el secreto ahora: no se vuelve a mostrar.</p>
          <Dato etiqueta="VG_INGEST_SECRET" valor={r.ingest_secret} />
          <Dato etiqueta="Id de la conexión (cabecera x-vg-conn)" valor={c.id} />
          <Dato etiqueta="Endpoint" valor="https://officialvanguard.com/ingest/v1/events" />
          <p className="text-sm text-muted-foreground">Cada lote va firmado con las cabeceras <span className="font-mono">x-vg-conn</span>, <span className="font-mono">x-vg-ts</span> y <span className="font-mono">x-vg-sig</span>.</p>
          <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
            <input type="checkbox" className="size-5" checked={guardado} onChange={(e) => setGuardado(e.target.checked)} />Ya lo guardé
          </label>
        </div>
      ) : null}
      <div>
        <Button variant="principal" size="grande" disabled={!!r.ingest_secret && !guardado} onClick={alTerminar}>Volver a Conexiones</Button>
      </div>
    </div>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-texto-3">{etiqueta}</span>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 rounded-lg border bg-card px-3 py-2 font-mono text-[13px] break-all">{sinBidi(valor)}</code>
        <BotonCopiar valor={valor} />
      </div>
    </div>
  );
}

export default function Asistente() {
  const { provider = '' } = useParams();
  const org = useOrg();
  const navegar = useNavigate();
  const conectar = useConectar(org.id);
  // «Activar modo blindaje» llega con el zone_id de la lectura que acaba de quitar (estado de la navegación, no la URL).
  const llegada = useLocation().state as Partial<EstadoBlindaje> | null;
  const blindaje = provider === 'cloudflare' && llegada?.blindaje === true;
  const [ref, setRef] = useState('');
  const [zona, setZona] = useState(() => (blindaje && typeof llegada?.zone_id === 'string' ? llegada.zone_id : ''));
  // «Sitio» por defecto; «Activar modo blindaje» llega siempre en «Zona» (bloquear necesita una zona).
  const [modoCf, setModoCf] = useState<ModoCf>(blindaje ? 'zone' : 'url');
  const [sitio, setSitio] = useState('');
  // «Reconectar» de GitHub llega con ?repo=: el mismo repo viene puesto y E8 reconecta esa conexión (varias-codebases §6.1).
  const [params] = useSearchParams();
  const [repo, setRepo] = useState(() => (provider === 'github' ? extraerRepo(params.get('repo') ?? '') ?? '' : ''));
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [accion, setAccion] = useState('');
  const [errores, setErrores] = useState<Errores>({});
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<ConnectionCreated | null>(null);
  const guia = useGuia();
  // Lo que Vigía dirá tras la prueba: se dice después de pintar, para que exista lo que señala. Un objeto nuevo por prueba.
  const [reaccion, setReaccion] = useState<{ dicho: Dicho } | null>(null);
  useEffect(() => { if (reaccion && guia.visible) guia.decir(reaccion.dicho); }, [reaccion]);   // solo cuando hay prueba nueva
  useEffect(() => () => { setToken(''); setAccion(''); setResultado(null); }, []);   // nada se queda al salir

  if (!PROVEEDORES.includes(provider as Provider)) return <NoEncontrada />;
  const p = provider as Provider;
  const sitioCf = p === 'cloudflare' && modoCf === 'url';
  const g = sitioCf ? { ...GUIAS_CONEXION.cloudflare, ...GUIA_CLOUDFLARE_SITIO } : GUIAS_CONEXION[p];
  const volver = () => navegar(`/o/${org.id}/connections`);
  const vaciarTokens = () => { setToken(''); setAccion(''); };

  // Validación local: si algo falla, el token no sale del navegador.
  function armar(): ConnectionCreate | Errores {
    const e: Errores = {};
    if (sitioCf) {
      const u = extraerUrlSitio(sitio);
      if ('error' in u) e.url = u.error;
      const t = token.trim();
      if (t) { const r = preGuardar(t, 'cloudflare'); if (r) e.token = r; }
      return Object.keys(e).length ? e : { provider: 'cloudflare', mode: 'url', url: (u as { url: string }).url, ...(t ? { read_token: t } : {}) };
    }
    if (p === 'ingest') {
      const l = label.trim();
      if (l.length < 2 || l.length > 40) e.label = 'Entre 2 y 40 caracteres';
      return Object.keys(e).length ? e : { provider: 'ingest', label: l };
    }
    const rechazo = preGuardar(token, p);
    if (rechazo) e.token = rechazo;
    if (p === 'supabase') {
      const pr = extraerProjectRef(ref);
      if (!pr) e.ref = 'Pega la URL del proyecto (https://<ref>.supabase.co) o su ref de 20 letras';
      return Object.keys(e).length ? e : { provider: 'supabase', project_ref: pr!, pat: token.trim() };
    }
    if (p === 'cloudflare') {
      if (!zoneIdValido(zona)) e.zona = 'El Zone ID son 32 caracteres hexadecimales en minúscula';
      if (blindaje && !accion.trim()) e.accion = 'Para el Modo blindaje hace falta el segundo token, con Firewall Services · Edit (y Config Rules · Edit para el modo bajo ataque)';
      if (accion.trim()) {
        const ra = preGuardar(accion, 'cloudflare');
        if (ra) e.accion = ra;
        else if (accion.trim() === token.trim()) e.accion = 'Usa dos tokens distintos: uno de lectura y otro solo para bloquear';
      }
      return Object.keys(e).length ? e : { provider: 'cloudflare', mode: 'zone', zone_id: zona.trim(), read_token: token.trim(), ...(accion.trim() ? { action_token: accion.trim() } : {}) };
    }
    const rp = extraerRepo(repo);
    if (!rp) e.repo = 'Escribe owner/repo o la URL del repo';
    return Object.keys(e).length ? e : { provider: 'github', repo_full_name: rp!, pat: token.trim() };
  }

  const enviar = async (ev: FormEvent) => {
    ev.preventDefault();
    const cuerpo = armar();
    if (!('provider' in cuerpo)) {
      setErrores(cuerpo);
      const d = dichoDeRechazo(cuerpo);
      if (d) setReaccion({ dicho: d });
      if (cuerpo.token) setToken('');                                // tras un rechazo el campo se vacía (§14.10)
      if (cuerpo.accion) setAccion('');
      return;
    }
    setErrores({}); setOcupado(true);
    try {
      const r = await conectar(cuerpo);
      setResultado(r);
      setReaccion({ dicho: dichoDeChecks(r.checks) });
    } catch (e) {
      setReaccion({ dicho: dichoDeError(e) });
      // e.message ya llega sin controles bidi (ApiError); `details` no, así que lo que se saca de ahí pasa por sinBidi.
      const d = esApiError(e) ? e.details : undefined;
      if (esApiError(e) && e.code === 'key_rejected') setErrores({ token: { titulo: 'Rechazamos esa clave', explicacion: e.message } });
      else if (esApiError(e) && e.code === 'provider_rejected' && Array.isArray(d?.missing_permissions))
        setErrores({ general: `Te falta: ${sinBidi((d.missing_permissions as string[]).map(nombrePermiso).join(', '))}` });
      else if (esApiError(e) && e.code === 'invalid_body' && d?.field_errors && typeof d.field_errors === 'object') {
        const fe = d.field_errors as Record<string, string[] | undefined>;
        setErrores({ general: sinBidi(Object.values(fe).flat().filter(Boolean).join(' · ')) || e.message });
      } else setErrores({ general: mensajeDe(e) });
    } finally {
      vaciarTokens();                                                // éxito o error: el token no se queda en el estado
      setOcupado(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Link to={`/o/${org.id}/connections`} className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />Conexiones
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex-1 text-[22px] font-semibold">{g.titulo}</h2>
        <Button variant="secundaria" onClick={() => { const v = sitioCf ? GUIA_VIGIA_CF_SITIO : GUIA_VIGIA[p]; guia.explicar(v.titulo, v.pasos, v.final); }}>
          <Eye />Que Vigía me guíe
        </Button>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(0,28rem)]">
        <section className="rounded-xl border bg-card p-5" aria-label="Pasos"><Pasos g={g} /></section>
        <section className="rounded-xl border bg-card p-5" aria-label="Formulario">
          {resultado ? <Resultado r={resultado} alTerminar={() => { setResultado(null); volver(); }} /> : (
            <form onSubmit={enviar} className="flex flex-col gap-4" noValidate>
              {blindaje ? (
                <p className="rounded-lg border border-info bg-info-relleno px-3 py-2 text-sm">
                  Activa el Modo blindaje: pega tu token de lectura (puede ser el mismo de antes) y uno nuevo con Firewall Services · Edit (y Config Rules · Edit para el modo bajo ataque).
                </p>
              ) : null}
              {p === 'supabase' ? <div data-guia="conexion-proyecto"><CampoTexto id="sb-ref" etiqueta="Proyecto (URL o ref)" valor={ref} onCambio={setRef} error={errores.ref} mono
                placeholder="https://<ref>.supabase.co" /></div> : null}
              {p === 'cloudflare' ? (
                <div className="inline-flex max-w-full flex-wrap rounded-lg bg-muted p-1" role="group" aria-label="Qué conectas de Cloudflare" data-guia="conexion-modo">
                  {MODOS_CF.map((m) => (
                    <button key={m.modo} type="button" aria-pressed={modoCf === m.modo} disabled={blindaje && m.modo === 'url'}
                      onClick={() => { setModoCf(m.modo); setErrores({}); vaciarTokens(); }}
                      className={cn('min-h-11 rounded-md px-3 py-1.5 text-left text-sm font-medium disabled:opacity-50', modoCf === m.modo ? 'bg-card text-foreground' : 'text-muted-foreground')}>
                      {m.texto}
                    </button>
                  ))}
                </div>
              ) : null}
              {sitioCf ? <div data-guia="conexion-url"><CampoTexto id="cf-url" etiqueta="URL del sitio" valor={sitio} onCambio={setSitio} error={errores.url} mono placeholder="https://mi-app.pages.dev" /></div> : null}
              {p === 'cloudflare' && !sitioCf ? <div data-guia="conexion-zona"><CampoTexto id="cf-zona" etiqueta="Zone ID" valor={zona} onCambio={setZona} error={errores.zona} mono /></div> : null}
              {p === 'github' ? <div data-guia="conexion-repo"><CampoTexto id="gh-repo" etiqueta="Repositorio" valor={repo} onCambio={setRepo} error={errores.repo} mono placeholder="owner/repo" /></div> : null}
              {p === 'ingest' ? <div data-guia="conexion-nombre"><CampoTexto id="in-label" etiqueta="Nombre de tu app" valor={label} onCambio={setLabel} error={errores.label} placeholder="Tienda en producción" /></div> : null}
              {p !== 'ingest' ? <div data-guia="conexion-token"><CampoToken id="tok" etiqueta={sitioCf ? 'Token de cuenta (opcional)' : p === 'cloudflare' ? 'Token de lectura' : 'Token de acceso'} valor={token} onCambio={setToken}
                error={errores.token} ayuda={sitioCf ? AYUDA_TOKEN_SITIO : p === 'supabase' ? 'Empieza por sbp_fc' : p === 'github' ? 'Empieza por github_pat_. Crea un token para cada repo: el mismo token no se puede usar dos veces en una organización.' : 'Solo permisos Zone · Read'} /></div> : null}
              {p === 'cloudflare' && !sitioCf ? <div data-guia="conexion-token-accion"><CampoToken id="tok-accion" etiqueta={blindaje ? 'Token de Modo blindaje' : 'Token de Modo blindaje (opcional)'} valor={accion} onCambio={setAccion}
                error={errores.accion} ayuda="Firewall Services · Edit (y Config Rules · Edit para el modo bajo ataque). Sin él no podrás bloquear IPs desde VanGUARD." /></div> : null}
              {errores.general ? <p role="alert" data-guia="conexion-error" className="rounded-lg border border-mal-borde bg-mal-relleno px-3 py-2 text-sm font-medium text-mal">{errores.general}</p> : null}
              <Button type="submit" variant="principal" size="grande" data-guia="conexion-probar" disabled={!org.puedeEscribir} aria-busy={ocupado || undefined}>
                {ocupado ? <Spinner /> : null}{p === 'ingest' ? 'Crear conexión' : 'Conectar y probar'}
              </Button>
              {org.puedeEscribir ? null : <span className="text-[12.5px] text-texto-3">{SOLO_LECTURA}</span>}
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
