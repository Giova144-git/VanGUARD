// «Bloquear esta IP» (S14 §14.16): reposo → simulando → vista → escribiendo → hecho, sin modal (L6). La aprobación
// también llega por el botón «Sí, bloquear» de WhatsApp (A8): si el incidente refrescado trae un block_ip executed
// creado después de abrir la vista, se pasa a «hecho» solo.
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react';
import { Ban, Undo2, type LucideIcon } from 'lucide-react';
import type { ActionPublic, ProposeResponse } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { Input } from '@/componentes/ui/input';
import { Spinner } from '@/componentes/ui/spinner';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { sinBidi } from '@/lib/bidi';
import { esApiError, mensajeDe } from '@/lib/errores';
import { cronometro, cuando } from '@/lib/formato';
import { deMapa } from '@/lib/severidad';
import { useBloqueo } from '@/lib/mutaciones';

const RAZON: Record<string, string> = {
  private_ip: 'Es una IP privada: no llega desde Internet',
  documentation_range: 'Es una IP de ejemplo (rango de documentación)',
  own_ip: 'Es tu propia IP: bloquearla te dejaría fuera',
  allowlisted: 'Está en tu lista de permitidas',
  not_an_ip: 'Solo bloqueamos una IP suelta (/32 o /128)',
  range_too_wide: 'Solo bloqueamos una IP suelta (/32 o /128)',
};
const SOLO_PRODUCCION = 'Solo disponible en officialvanguard.com';
// El resultado ocupa el sitio del botón de 56 px que sustituye (L6, L7): mismo alto, letra legible a 3 m; en móvil parte línea.
const RESULTADO = 'h-auto min-h-14 shrink gap-2 px-4 py-2 text-base font-semibold [&_svg]:size-5';

// error o aviso de RespuestaEscritura: llega como dato, no como ApiError (que ya sanea su message), así que aquí se
// ponen a la vista los controles bidi (lib/bidi.ts). api() en producción no impone el esquema: lo que no sea texto, respaldo.
const motivo = (m: unknown, respaldo: string) => (typeof m === 'string' ? sinBidi(m) : respaldo);

function errorPropuesta(e: unknown): string {
  if (esApiError(e) && e.status === 403) return SOLO_PRODUCCION;
  const r = esApiError(e) && typeof e.details?.reason === 'string' ? deMapa(RAZON, e.details.reason, '') || undefined : undefined;
  return r ?? mensajeDe(e);
}

// role="timer" y aria-live="off": el lector no lee el reloj cada segundo mientras escriben el código.
function CuentaAtras({ hasta, alVencer }: { hasta: string; alVencer: () => void }) {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setAhora(Date.now()), 1000); return () => clearInterval(t); }, []);
  const queda = Date.parse(hasta) - ahora;
  useEffect(() => { if (queda <= 0) alVencer(); }, [queda, alVencer]);
  return <span role="timer" aria-live="off" className="font-mono tabular-nums">{cronometro(queda)}</span>;
}

type Fase =
  | { f: 'reposo'; error?: string }
  | { f: 'simulando' }
  | { f: 'vista' | 'escribiendo'; p: ProposeResponse; desde: number; error?: string }
  | { f: 'hecho'; accion: { id: string; en: string; expira: string | null } }
  | { f: 'deshecho'; en: string };

export function BloquearIp({ org, incidentId, ip, ejecutada, puedeEscribir }: {
  org: string; incidentId: string; ip: string; ejecutada: ActionPublic | undefined; puedeEscribir: boolean;
}) {
  const b = useBloqueo(org);
  const [fase, setFase] = useState<Fase>(() => ejecutada
    ? { f: 'hecho', accion: { id: ejecutada.id, en: ejecutada.created_at, expira: ejecutada.expires_at } } : { f: 'reposo' });
  const [codigo, setCodigo] = useState('');
  const [deshaciendo, setDeshaciendo] = useState(false);
  const [errorDeshacer, setErrorDeshacer] = useState<string | null>(null);
  const campo = useRef<HTMLInputElement>(null);
  // Al cambiar de fase el control pulsado desaparece: el foco pasa al siguiente si el paso lo dio el usuario o si el
  // foco ya estaba dentro (aprobado por WhatsApp mientras escribía). Nunca al montar.
  const raiz = useRef<HTMLDivElement>(null);
  const botonBloquear = useRef<HTMLButtonElement>(null);
  const botonDeshacer = useRef<HTMLButtonElement>(null);
  const resultado = useRef<HTMLDivElement>(null);
  const enfocar = useRef(false);
  const dentro = () => !!raiz.current?.contains(document.activeElement);

  // Aprobado desde WhatsApp: el incidente refrescado (Realtime o respaldo) trae el block_ip executed.
  useEffect(() => {
    if (!ejecutada) return;
    const conFoco = dentro();
    setFase((x) => {
      if (x.f === 'hecho' || x.f === 'deshecho' || (x.f === 'vista' && Date.parse(ejecutada.created_at) < x.desde)) return x;
      enfocar.current = conFoco;
      return { f: 'hecho', accion: { id: ejecutada.id, en: ejecutada.created_at, expira: ejecutada.expires_at } };
    });
  }, [ejecutada]);
  useEffect(() => {
    if (!enfocar.current) return;
    enfocar.current = false;
    (fase.f === 'hecho' ? botonDeshacer : fase.f === 'deshecho' ? resultado : fase.f === 'reposo' ? botonBloquear : null)?.current?.focus();
  }, [fase.f]);
  const cancelar = () => { setCodigo(''); enfocar.current = true; setFase({ f: 'reposo' }); };
  useEffect(() => {
    if (fase.f !== 'vista') return;
    campo.current?.focus();
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelar(); };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [fase.f]);

  const simular = async () => {
    setFase({ f: 'simulando' });
    try { setFase({ f: 'vista', p: await b.proponer({ incident_id: incidentId, target: ip }), desde: Date.now() }); }
    catch (e) { setFase({ f: 'reposo', error: errorPropuesta(e) }); }
  };
  const confirmar = async (ev: FormEvent) => {
    ev.preventDefault();
    if (fase.f !== 'vista' || !/^\d{6}$/.test(codigo)) return;
    const { p, desde } = fase;
    const c = codigo;
    setCodigo('');                                                      // el código no se queda en el estado
    setFase({ f: 'escribiendo', p, desde });
    try {
      const r = await b.confirmar(p.approval_id, c);
      if (r.ok && r.action_id) { enfocar.current = true; setFase({ f: 'hecho', accion: { id: r.action_id, en: r.en ?? new Date().toISOString(), expira: null } }); }
      else setFase({ f: 'vista', p, desde, error: motivo(r.error ?? r.aviso, 'No pudimos bloquearla') });
    } catch (e) {
      if (esApiError(e) && e.status === 409) { enfocar.current = true; setFase({ f: 'reposo', error: e.message }); }
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
      else setErrorDeshacer(motivo(r.error ?? r.aviso, 'No pudimos desbloquearla'));   // sigue bloqueada: se dice en el sitio (L6)
    } catch (e) {
      if (esApiError(e) && e.status === 409) { enfocar.current = true; setFase({ f: 'deshecho', en: new Date().toISOString() }); }   // ya deshecha: cuenta como hecho
      else setErrorDeshacer(esApiError(e) && e.status === 403 ? SOLO_PRODUCCION : mensajeDe(e));
    } finally { setDeshaciendo(false); }
  };

  // La caducidad la da el servidor: la del incidente refrescado si ya trae esta acción.
  const expira = fase.f === 'hecho' ? (ejecutada?.id === fase.accion.id ? ejecutada.expires_at : fase.accion.expira) : null;
  const bloqueada = fase.f === 'hecho' ? `Bloqueada · ${cuando(fase.accion.en)}${expira ? ` · caduca ${cuando(expira)}` : ''}` : '';
  // Región siempre montada: las ramas se montan ya con su texto y así el lector sí anuncia el resultado.
  const marco = (hijo: ReactNode) => (
    <div ref={raiz}>
      <p className="sr-only" role="status">{fase.f === 'hecho' ? bloqueada : fase.f === 'deshecho' ? `Desbloqueada · ${cuando(fase.en)}` : ''}</p>
      {hijo}
    </div>
  );

  if (fase.f === 'hecho') return marco(
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-3">
        <Etiqueta texto={bloqueada} rol="bien" icono={Ban} className={RESULTADO} />
        <Button ref={botonDeshacer} variant="secundaria" size="grande" disabled={!puedeEscribir} aria-busy={deshaciendo || undefined}
          onClick={deshaciendo ? undefined : () => deshacer(fase.accion.id)}>
          {deshaciendo ? <Spinner /> : <Undo2 />}Deshacer bloqueo
        </Button>
      </div>
      {errorDeshacer ? <span role="alert" className="text-sm text-mal">{errorDeshacer}</span> : null}
    </div>
  );
  if (fase.f === 'deshecho') return marco(
    <div ref={resultado} tabIndex={-1} className="w-fit outline-none">
      <Etiqueta texto={`Desbloqueada · ${cuando(fase.en)}`} rol="neutra" className={RESULTADO} />
    </div>
  );

  if (fase.f === 'reposo' || fase.f === 'simulando') return marco(
    <div className="flex flex-col gap-1">
      <Button ref={botonBloquear} variant="peligro" size="grande" disabled={!puedeEscribir} aria-busy={fase.f === 'simulando' || undefined}
        onClick={fase.f === 'simulando' ? undefined : simular}>
        {fase.f === 'simulando' ? <Spinner /> : <Ban />}Bloquear esta IP
      </Button>
      {!puedeEscribir ? <span className="text-[12.5px] text-texto-3">Modo demo: solo lectura</span> : null}
      {fase.f === 'reposo' && fase.error ? <span role="alert" className="text-sm text-mal">{fase.error}</span> : null}
    </div>
  );

  return marco(
    <Propuesta p={fase.p} codigo={codigo} alCambiarCodigo={setCodigo} error={fase.error} escribiendo={fase.f === 'escribiendo'}
      campo={campo} alConfirmar={confirmar} alCancelar={cancelar} alVencer={vencer} />
  );
}

// Vista de la propuesta (efecto, avisos y code del servidor) con el campo del código. Presentación pura: el estado vive
// en BloquearIp (y en BajoAtaque, que cambia el verbo y el icono, y no tiene botón en el WhatsApp). Exportada para el
// arnés de XSS.
export function Propuesta({ p, codigo, alCambiarCodigo, error, escribiendo, campo, alConfirmar, alCancelar, alVencer,
  verbo = 'Confirmar bloqueo', icono: Icono = Ban, conBotonWhatsapp = true }: {
  p: ProposeResponse; codigo: string; alCambiarCodigo: (v: string) => void; error?: string; escribiendo: boolean;
  campo?: Ref<HTMLInputElement>; alConfirmar: (ev: FormEvent) => void; alCancelar: () => void; alVencer: () => void;
  verbo?: string; icono?: LucideIcon; conBotonWhatsapp?: boolean;
}) {
  return (
    <form onSubmit={alConfirmar} className="flex w-full flex-col gap-3 rounded-xl border border-mal-borde bg-mal-relleno p-4">
      <p className="text-[15px] font-semibold text-mal">{sinBidi(p.efecto)}</p>
      {p.avisos.map((a) => <p key={a} className="rounded-lg border border-aviso-borde bg-aviso-relleno px-3 py-2 text-sm text-aviso">{sinBidi(a)}</p>)}
      <p className="text-sm text-muted-foreground">
        {p.delivery === 'whatsapp'
          ? `Te lo enviamos por WhatsApp.${conBotonWhatsapp ? ' También puedes aprobar con el botón del mensaje.' : ''}`
          : <>No pudimos enviarte el WhatsApp: tu código es <span className="font-mono font-semibold text-foreground">{p.code ? sinBidi(p.code) : '—'}</span>.</>}
        {' '}Vence en <CuentaAtras hasta={p.expires_at} alVencer={alVencer} />.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Código de 6 dígitos</span>
          <Input ref={campo} value={codigo} onChange={(e) => alCambiarCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric"
            autoComplete="one-time-code" pattern="\d{6}" maxLength={6} className="w-40 font-mono text-lg tracking-widest" aria-invalid={!!error || undefined} />
        </label>
        <Button type="button" variant="secundaria" size="grande" onClick={alCancelar}>Cancelar</Button>
        <Button type="submit" variant="peligro" size="grande" disabled={codigo.length !== 6 || escribiendo} aria-busy={escribiendo || undefined}>
          {escribiendo ? <Spinner /> : <Icono />}{verbo}
        </Button>
      </div>
      {error ? <p role="alert" className="text-sm font-medium text-mal">{sinBidi(error)}</p> : null}
    </form>
  );
}
