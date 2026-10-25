// «Modo bajo ataque» de Cloudflare (asignaciones/modo-bajo-ataque.md §9). Cuando varias IPs inundan el mismo host (≥ 2
// incidentes CF_IP_FLOOD sin resolver), la regla lo ofrece debajo de «Bloquear IP»: una Configuration Rule que pone SOLO
// ese host bajo el desafío de Cloudflare y caduca sola. La activa un admin con la simulación (dry_run de Cloudflare) y el
// código de un solo uso, como el bloqueo: reposo → simulando → vista → escribiendo → hecho, sin modal (L6). Lo que se ve lo
// manda E55 (la oferta y el modo vivo del host). Bandera del servidor: mientras E55 no responda (404 sin desplegar o quitado
// en el corte de §13.1), no se pinta nada. Sin Modo blindaje o sin Config Rules · Edit en su token, la misma propuesta en
// vista previa (sin confirmar) con lo que falta y los pasos para hacerlo a mano.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Cable, RotateCcw, ShieldAlert, ShieldOff, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ActionPublic, UnderAttackOffer, UnderAttackProposal } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { Spinner } from '@/componentes/ui/spinner';
import { BotonCopiar } from '@/componentes/vg/BotonCopiar';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { SOLO_LECTURA } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { useOfertaBajoAtaque } from '@/lib/consultas';
import { esApiError, mensajeDe } from '@/lib/errores';
import { cuando } from '@/lib/formato';
import { useBajoAtaque } from '@/lib/mutaciones';
import { nombrePermiso } from '@/lib/permisos';
import { TINTE, deMapa, type Rol } from '@/lib/severidad';
import { cn } from '@/lib/utils';
import { MARCO_PROPUESTA, Propuesta, TextosPropuesta } from './BloquearIp';

const SOLO_PRODUCCION = 'Solo disponible en officialvanguard.com';
const CONFIG_RULES = nombrePermiso('config_rules_edit');                 // «Zone · Config Rules · Edit»
const FALTA_PERMISO = `Te falta el permiso ${CONFIG_RULES} en el token de Modo blindaje`;
const EJEMPLO_HOST = 'demo.officialvanguard.com';
// details.reason de E56 (tabla de §5) → texto. Los que traen un dato del servidor (zona, cupo del plan, código de
// Cloudflare) no están: sale el mensaje del servidor, que ApiError ya sanea.
const RAZON: Record<string, string> = {
  no_aplica: 'El modo bajo ataque es solo para inundaciones de tráfico',
  una_ip: 'Viene de una sola IP: bloquéala con «Bloquear IP»',
  sin_host: `No sabemos qué host atacan: ponle a tu conexión de ingesta el nombre del host (por ejemplo, ${EJEMPLO_HOST})`,
  host_invalido: `No sabemos qué host atacan: ponle a tu conexión de ingesta el nombre del host (por ejemplo, ${EJEMPLO_HOST})`,
  host_protegido: 'Ese host es VanGUARD: ponerlo bajo ataque cortaría tu panel y tus avisos',
  zona_del_producto: 'En esta zona solo se puede por host',
  alcance_no_disponible: 'Por ahora solo por host',
  no_action_connection: 'Activa el Modo blindaje con un token de acciones',
  sin_permiso: FALTA_PERMISO,
  in_progress: 'Se está activando ahora mismo',
  resolved: 'El incidente ya se cerró',
};
// El resultado ocupa el sitio del botón de 56 px que sustituye, como en BloquearIp; en móvil parte línea.
const RESULTADO = 'h-auto min-h-14 min-w-0 shrink flex-wrap gap-x-2 gap-y-0.5 px-4 py-2 text-base font-semibold [&_svg]:size-5';
const NOTA = 'text-[12.5px] text-muted-foreground';
// «Copiar pasos para hacerlo a mano» no cabe en una línea a 375 px: el botón parte línea en vez de desbordar la tarjeta.
const PARTE = 'h-auto max-w-full whitespace-normal py-2 text-center';

// error o aviso de RespuestaEscritura: llega como dato, no como ApiError (que ya sanea su message).
const motivo = (m: unknown, respaldo: string) => (typeof m === 'string' ? sinBidi(m) : respaldo);
const host = (h: string) => <span className="font-mono normal-case wrap-anywhere"><bdi dir="ltr">{sinBidi(h)}</bdi></span>;

/** ttl_s de E55 (300..3600 en el contrato) → «30 min», «1 h», «1 h 30 min»: la duración la manda el servidor. */
export function plazo(s: number) {
  const m = Math.max(1, Math.round(s / 60)), h = Math.floor(m / 60), r = m % 60;
  return h === 0 ? `${m} min` : r === 0 ? `${h} h` : `${h} h ${r} min`;
}
// Qué hace la regla, dicho igual en la nota del botón y en la vista previa (con el host ya en <bdi>).
const ipsALaVez = (n: number) => `Llega tráfico de ${n} IPs a la vez: bloquearlas una a una no basta.`;
const desafio = (h: ReactNode, ttl_s: number) => <>Cada visitante de {h} pasará un desafío de Cloudflare durante {plazo(ttl_s)}.</>;
const SOLO_ESE_HOST = 'Solo ese host: el resto de tu zona de Cloudflare sigue igual.';
// Qué falta para activarlo desde aquí. Owner y admin lo leen con el enlace a Conexiones y «Copiar pasos»; el viewer y el
// anónimo de la demo, el mismo dato en neutro y sin controles (como «añade uno en Ajustes» en la revisión de código).
// Cloudflare conectado solo por URL (cloudflare-por-url.md): sin zona no hay Modo blindaje posible; E20/E55 dan sin_conexion.
export const ZONA_NECESARIA = 'Bloquear IP y el modo bajo ataque necesitan una zona de Cloudflare (Zone ID). Tu sitio está conectado por URL: VanGUARD lo revisa, pero no puede cambiar su configuración.';
const FALTA = {
  sin_conexion: { admin: 'Para activarlo desde aquí, activa el Modo blindaje', lectura: 'Sin el Modo blindaje no se puede activar desde aquí.' },
  // La página del incidente ya pinta encima la tarjeta «Activa el Modo blindaje» (incidente de IP sin blindaje): aquí no
  // se repite la llamada ni el enlace a Conexiones, solo se dice que esa misma activación sirve también para esto.
  sin_conexion_arriba: { admin: 'Con el Modo blindaje de arriba también lo activas desde aquí', lectura: 'Sin el Modo blindaje no se puede activar desde aquí.' },
  sin_zona: { admin: ZONA_NECESARIA, lectura: ZONA_NECESARIA },
  sin_zona_arriba: { admin: 'Como dice arriba, el modo bajo ataque también necesita una zona de Cloudflare.', lectura: 'Como dice arriba, el modo bajo ataque también necesita una zona de Cloudflare.' },
  sin_permiso: { admin: `Para activarlo desde aquí, añade ${CONFIG_RULES} a tu token de Modo blindaje`,
    lectura: `Al token de Modo blindaje le falta ${CONFIG_RULES}: no se puede activar desde aquí.` },
};

function errorPropuesta(e: unknown): { error: string; copiar?: string } {
  if (esApiError(e) && e.status === 403) return { error: SOLO_PRODUCCION };
  const d = esApiError(e) ? e.details : undefined;
  // 409 sin_permiso trae los pasos para hacerlo a mano en el panel (se copian tal cual, sin secretos).
  const copiar = typeof d?.copiar === 'string' && d.copiar ? d.copiar.slice(0, 1500) : undefined;
  return { error: deMapa(RAZON, d?.reason, '') || mensajeDe(e), copiar };
}

// Chapa de resultado con el host en <bdi dir="ltr">: Etiqueta solo admite texto.
function Chapa({ rol, icono: Icono, children }: { rol: Rol; icono: LucideIcon; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-lg border font-mono uppercase tracking-[0.08em]', deMapa(TINTE, rol, TINTE.neutra), RESULTADO)}>
      <Icono />{children}
    </span>
  );
}

type Vivo = { id: string; host: string; en: string; expira: string | null; fallida: boolean };
type Fase =
  | { f: 'reposo'; error?: string; copiar?: string }
  | { f: 'simulando' }
  | { f: 'vista' | 'escribiendo'; p: UnderAttackProposal; desde: number; error?: string }
  | { f: 'hecho'; vivo: Vivo; canje: number }          // canje: cuándo salió el confirm (para saber si E55 ya se releyó)
  | { f: 'deshecho'; en: string };

const deOferta = (a: NonNullable<UnderAttackOffer['activo']>): Vivo =>
  ({ id: a.action_id, host: a.target, en: a.created_at, expira: a.expires_at, fallida: a.retirada_fallida });

// Modo vivo del host. E55 manda; lo que acaba de confirmar esta pestaña solo vale mientras E55 no se relea después del
// canje (si no, tras retirarlo housekeeping seguiría «lo estamos retirando» para siempre). Si no, el que trae el incidente
// refrescado (otra pestaña, o el WhatsApp cuando el BACK tenga su botón), que no pisa una vista abierta antes. leidaEn es
// el dataUpdatedAt de E55. Exportada para las pruebas.
export function vivoDe(o: UnderAttackOffer | undefined, leidaEn: number, fase: Fase, ejecutada: ActionPublic | undefined): Vivo | null {
  if (o?.activo) return deOferta(o.activo);
  if (fase.f === 'hecho' && leidaEn < fase.canje) return fase.vivo;
  if (!ejecutada || ((fase.f === 'vista' || fase.f === 'escribiendo') && Date.parse(ejecutada.created_at) < fase.desde)) return null;
  return { id: ejecutada.id, host: ejecutada.target, en: ejecutada.created_at, expira: ejecutada.expires_at, fallida: false };
}

export function BajoAtaque({ org, incidentId, puedeEscribir, ejecutada, blindajeArriba = false, sitioPorUrl = false }: {
  org: string; incidentId: string; puedeEscribir: boolean; ejecutada: ActionPublic | undefined;
  /** La página ya enseña encima «Activa el Modo blindaje» (o, con sitioPorUrl, que hace falta una zona): no se repite. */
  blindajeArriba?: boolean;
  /** La única conexión de Cloudflare de la org es de un sitio por URL: sin_conexion pide una zona, no el Modo blindaje. */
  sitioPorUrl?: boolean;
}) {
  const q = useOfertaBajoAtaque(org, incidentId);
  const b = useBajoAtaque(org);
  const [fase, setFase] = useState<Fase>({ f: 'reposo' });
  const [codigo, setCodigo] = useState('');
  const [deshaciendo, setDeshaciendo] = useState(false);
  const [errorDeshacer, setErrorDeshacer] = useState<string | null>(null);
  const campo = useRef<HTMLInputElement>(null);
  // Al cambiar de fase el control pulsado desaparece: el foco pasa al siguiente solo si el paso lo dio el usuario.
  const raiz = useRef<HTMLDivElement>(null);
  const botonActivar = useRef<HTMLButtonElement>(null);
  const botonDesactivar = useRef<HTMLButtonElement>(null);
  const resultado = useRef<HTMLDivElement>(null);
  const enfocar = useRef(false);
  const dentro = () => !!raiz.current?.contains(document.activeElement);

  const o = q.data;
  const vista = fase.f === 'vista' || fase.f === 'escribiendo';
  const vivo = vivoDe(o, q.dataUpdatedAt, fase, ejecutada);
  const pantalla = fase.f === 'deshecho' ? 'deshecho' : vivo ? 'hecho' : vista ? 'vista' : 'reposo';

  useEffect(() => {
    if (!enfocar.current) return;
    enfocar.current = false;
    (pantalla === 'hecho' ? botonDesactivar : pantalla === 'deshecho' ? resultado : pantalla === 'reposo' ? botonActivar : null)?.current?.focus();
  }, [pantalla]);
  const cancelar = () => { setCodigo(''); enfocar.current = true; setFase({ f: 'reposo' }); };
  useEffect(() => {
    if (pantalla !== 'vista') return;
    campo.current?.focus();
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelar(); };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [pantalla]);

  const simular = async () => {
    setFase({ f: 'simulando' });
    try { setFase({ f: 'vista', p: await b.proponer(incidentId), desde: Date.now() }); }
    catch (e) {
      if (esApiError(e) && e.status === 409) void b.refrescar();        // ya activo o activándose: la oferta lo dirá
      setFase({ f: 'reposo', ...errorPropuesta(e) });
    }
  };
  const confirmar = async (ev: FormEvent) => {
    ev.preventDefault();
    if (fase.f !== 'vista' || !/^\d{6}$/.test(codigo)) return;
    const { p, desde } = fase;
    const c = codigo;
    const canje = Date.now();
    setCodigo('');                                                      // el código no se queda en el estado
    setFase({ f: 'escribiendo', p, desde });
    try {
      const r = await b.confirmar(p.approval_id, c);
      if (r.ok && r.action_id) {
        const en = r.en ?? new Date().toISOString();
        const t = Date.parse(en);                                       // api() en producción no impone el esquema
        enfocar.current = true;
        setFase({ f: 'hecho', canje, vivo: { id: r.action_id, host: p.target, en, expira: Number.isFinite(t) ? new Date(t + p.ttl_s * 1000).toISOString() : null, fallida: false } });
      } else setFase({ f: 'vista', p, desde, error: motivo(r.error ?? r.aviso, 'No pudimos activarlo') });
    } catch (e) {
      if (esApiError(e) && e.status === 409) { void b.refrescar(); enfocar.current = true; setFase({ f: 'reposo', error: e.message }); }
      else if (esApiError(e) && e.details?.reason === 'wrong_code') {
        const n = Number(e.details.attempts_left ?? 0);
        setFase({ f: 'vista', p, desde, error: `Código incorrecto. Te quedan ${n} ${n === 1 ? 'intento' : 'intentos'}` });
      }
      else setFase({ f: 'vista', p, desde, error: mensajeDe(e) });
    }
  };
  const vencer = () => { enfocar.current = dentro(); setFase({ f: 'reposo', error: 'El código venció, pídelo de nuevo' }); };
  const deshacer = async (id: string) => {
    setDeshaciendo(true);
    setErrorDeshacer(null);
    try {
      const r = await b.deshacer(id);
      if (r.ok) { enfocar.current = true; setFase({ f: 'deshecho', en: r.en ?? new Date().toISOString() }); }
      else setErrorDeshacer(motivo(r.error ?? r.aviso, 'No pudimos desactivarlo'));   // sigue activo: se dice en el sitio (L6)
    } catch (e) {
      // 409 «ya deshecha» cuenta como hecho; «no ejecutada» (aún activándose) se dice tal cual.
      if (esApiError(e) && e.status === 409 && e.details?.reason !== 'not_executed') { enfocar.current = true; setFase({ f: 'deshecho', en: new Date().toISOString() }); }
      else setErrorDeshacer(esApiError(e) && e.status === 403 ? SOLO_PRODUCCION : mensajeDe(e));
    } finally { setDeshaciendo(false); }
  };

  if (q.isError && esApiError(q.error) && q.error.status === 404) return null;
  // Sin la oferta (cargando, o E55 caído en la primera lectura) no se promete nada. Un fallo pasajero tras una lectura buena
  // deja la última: no esconde un modo activo con su «Desactivar ahora».
  if (!o) return null;

  const vencido = !!vivo?.expira && Date.parse(vivo.expira) <= Date.now();
  const estado = pantalla === 'hecho' && vivo && !vivo.fallida
    ? vencido ? `Modo bajo ataque vencido ${cuando(vivo.expira)}` : `Bajo ataque · ${sinBidi(vivo.host)}${vivo.expira ? ` · hasta ${cuando(vivo.expira)}` : ''}`
    : fase.f === 'deshecho' ? `Modo bajo ataque desactivado · ${cuando(fase.en)}` : '';
  const soloLectura = !puedeEscribir ? <span className="text-[12.5px] text-texto-3">{SOLO_LECTURA}</span> : null;
  // Región siempre montada: las ramas se montan ya con su texto y así el lector sí anuncia el resultado.
  const marco = (hijo: ReactNode) => (
    <div ref={raiz} role="group" aria-label="Modo bajo ataque" data-info="bajo-ataque">
      <p className="sr-only" role="status">{estado}</p>
      {hijo}
    </div>
  );
  const botonDeshacer = (texto: string, Icono: LucideIcon) => (
    <Button ref={botonDesactivar} variant="secundaria" size="grande" disabled={!puedeEscribir} aria-busy={deshaciendo || undefined}
      onClick={deshaciendo || !vivo ? undefined : () => deshacer(vivo.id)}>
      {deshaciendo ? <Spinner /> : <Icono />}{texto}
    </Button>
  );
  const error = errorDeshacer ? <span role="alert" className="text-sm text-mal">{errorDeshacer}</span> : null;

  if (fase.f === 'deshecho') return marco(
    <div ref={resultado} tabIndex={-1} className="w-fit outline-none">
      <Etiqueta texto={`Modo bajo ataque desactivado · ${cuando(fase.en)}`} rol="neutra" icono={ShieldOff} className={RESULTADO} />
    </div>
  );

  // housekeeping no pudo borrar la regla: ya no debería actuar, pero sigue en el panel del cliente y ocupa una del plan.
  if (vivo?.fallida) return marco(
    <div className="flex flex-col gap-3 rounded-xl border p-4">
      <Etiqueta texto="No pudimos retirar la regla de Cloudflare" rol="mal" icono={TriangleAlert} className="h-auto min-h-6 w-fit py-1 whitespace-normal" />
      <p className="text-sm text-muted-foreground">
        La regla de {host(vivo.host)} sigue en tu panel de Cloudflare y ocupa una de las reglas de configuración de tu plan.
        Bórrala a mano o pulsa «Reintentar».
      </p>
      {o.copiar ? <p className="rounded-lg bg-muted p-3 font-mono text-[13px] whitespace-pre-line wrap-anywhere"><bdi dir="ltr">{sinBidi(o.copiar)}</bdi></p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {o.copiar ? <BotonCopiar valor={o.copiar} texto="Copiar pasos" tam="grande" /> : null}
        {botonDeshacer('Reintentar', RotateCcw)}
      </div>
      {soloLectura}
      {error}
    </div>
  );

  if (vivo) return marco(
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-3">
        {vencido
          ? <Chapa rol="aviso" icono={ShieldAlert}>Venció {cuando(vivo.expira)}; lo estamos retirando</Chapa>
          : <Chapa rol="aviso" icono={ShieldAlert}>Bajo ataque · {host(vivo.host)}{vivo.expira ? <> · hasta {cuando(vivo.expira)}</> : null}</Chapa>}
        {botonDeshacer('Desactivar ahora', ShieldOff)}
      </div>
      {soloLectura}
      {error}
    </div>
  );

  if (fase.f === 'vista' || fase.f === 'escribiendo') return marco(
    <Propuesta p={fase.p} codigo={codigo} alCambiarCodigo={setCodigo} error={fase.error} escribiendo={fase.f === 'escribiendo'}
      campo={campo} alConfirmar={confirmar} alCancelar={cancelar} alVencer={vencer}
      verbo="Activar bajo ataque" icono={ShieldAlert} conBotonWhatsapp={false} />
  );

  // Sin host (el nombre de la conexión de ingesta no lo es) no hay qué proponer ni qué previsualizar, sea cual sea el motivo.
  // Un modo vivo o una propuesta abierta, arriba, sí se pintan: traen su propio host.
  if (!o.hostname) return null;
  const atacado = host(o.hostname);
  if (o.ofrece && o.motivo === null) return marco(
    <div className="flex flex-col gap-1">
      <Button ref={botonActivar} variant="secundaria" size="grande" disabled={!puedeEscribir} aria-busy={fase.f === 'simulando' || undefined}
        onClick={fase.f === 'simulando' ? undefined : simular}>
        {fase.f === 'simulando' ? <Spinner /> : <ShieldAlert />}Activar modo bajo ataque
      </Button>
      <span className={NOTA}>{ipsALaVez(o.ips)} {desafio(atacado, o.ttl_s)}</span>
      {soloLectura}
      {fase.f === 'reposo' && fase.error ? <span role="alert" className="text-sm text-mal">{fase.error}</span> : null}
      {fase.f === 'reposo' && fase.copiar ? <BotonCopiar valor={fase.copiar} texto="Copiar pasos para hacerlo a mano" className={cn(PARTE, 'min-h-11')} /> : null}
    </div>
  );

  // Sin Modo blindaje o sin el permiso: la propuesta en vista previa (el mismo aspecto que la de E56, sin código ni botón de
  // confirmar), lo que falta para activarlo desde aquí y los pasos para hacerlo a mano. `copiar` va tal cual al portapapeles.
  if (o.motivo === 'sin_conexion' || o.motivo === 'sin_permiso') {
    const repite = o.motivo === 'sin_conexion' && blindajeArriba;
    const falta = o.motivo === 'sin_permiso' ? FALTA.sin_permiso
      : sitioPorUrl ? (repite ? FALTA.sin_zona_arriba : FALTA.sin_zona)
      : repite ? FALTA.sin_conexion_arriba : FALTA.sin_conexion;
    return marco(
      <div className={MARCO_PROPUESTA}>
        <Etiqueta texto="Modo bajo ataque · vista previa" icono={ShieldAlert} className="h-auto min-h-6 w-fit py-1 whitespace-normal" />
        <TextosPropuesta efecto={desafio(atacado, o.ttl_s)} avisos={[ipsALaVez(o.ips), SOLO_ESE_HOST]} />
        {puedeEscribir ? <>
          <p className="text-[15px] font-semibold">{falta.admin}</p>
          <div className="flex flex-wrap items-center gap-2">
            {repite ? null : <Button asChild variant="fantasma" size="grande"><Link to={`/o/${org}/connections`}><Cable />{sitioPorUrl && o.motivo === 'sin_conexion' ? 'Añadir la zona en Conexiones' : 'Ir a Conexiones'}</Link></Button>}
            {o.copiar ? <BotonCopiar valor={o.copiar} texto="Copiar pasos para hacerlo a mano" tam="grande" className={cn(PARTE, 'min-h-14')} /> : null}
          </div>
        </> : <p className="text-sm text-muted-foreground">{falta.lectura}</p>}
      </div>
    );
  }

  // Una línea en neutro con el motivo; no_aplica y cerrado no pintan nada, igual que un motivo fuera de contrato.
  const linea = deMapa<string, ReactNode>({
    una_ip: 'Viene de una sola IP: con «Bloquear IP» basta.',
    host_protegido: 'Ese host es VanGUARD: ponerlo bajo ataque cortaría tu panel y tus avisos.',
    fuera_de_zona: o.zone_name ? <>El host atacado no es de tu zona {host(o.zone_name)}: no se puede poner bajo ataque desde aquí.</>
      : 'El host atacado no es de tu zona de Cloudflare: no se puede poner bajo ataque desde aquí.',
    sin_host: <>Ponle a tu conexión de ingesta el nombre del host atacado, por ejemplo {host(EJEMPLO_HOST)}.</>,
    en_curso: <><Spinner className="inline size-3.5 align-[-2px]" /> Se está activando el modo bajo ataque…</>,
  }, o.motivo, null);
  if (!linea) return null;
  return marco(
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span><span className="font-medium text-foreground">Modo bajo ataque.</span> {linea}</span>
    </p>
  );
}
