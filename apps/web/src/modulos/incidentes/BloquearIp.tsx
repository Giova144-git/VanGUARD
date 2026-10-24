// «Bloquear esta IP» (S14 §14.16): reposo → simulando → vista → escribiendo → hecho, sin modal (L6). La aprobación
// también llega por el botón «Sí, bloquear» de WhatsApp (A8): si el incidente refrescado trae un block_ip executed
// creado después de abrir la vista, se pasa a «hecho» solo.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Ban, Undo2 } from 'lucide-react';
import type { ActionPublic, ProposeResponse } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { Input } from '@/componentes/ui/input';
import { Spinner } from '@/componentes/ui/spinner';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { esApiError, mensajeDe } from '@/lib/errores';
import { cronometro, cuando } from '@/lib/formato';
import { useBloqueo } from '@/lib/mutaciones';

const RAZON: Record<string, string> = {
  private_ip: 'Es una IP privada: no llega desde Internet',
  documentation_range: 'Es una IP de ejemplo (rango de documentación)',
  own_ip: 'Es tu propia IP: bloquearla te dejaría fuera',
  allowlisted: 'Está en tu lista de permitidas',
  not_an_ip: 'Solo bloqueamos una IP suelta (/32 o /128)',
  range_too_wide: 'Solo bloqueamos una IP suelta (/32 o /128)',
};

function errorPropuesta(e: unknown): string {
  if (esApiError(e) && e.status === 403) return 'Solo disponible en officialvanguard.com';
  const r = esApiError(e) && typeof e.details?.reason === 'string' ? RAZON[e.details.reason] : undefined;
  return r ?? mensajeDe(e);
}

function CuentaAtras({ hasta, alVencer }: { hasta: string; alVencer: () => void }) {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setAhora(Date.now()), 1000); return () => clearInterval(t); }, []);
  const queda = Date.parse(hasta) - ahora;
  useEffect(() => { if (queda <= 0) alVencer(); }, [queda, alVencer]);
  return <span className="font-mono tabular-nums">{cronometro(queda)}</span>;
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
  const campo = useRef<HTMLInputElement>(null);

  // Aprobado desde WhatsApp: el incidente refrescado (Realtime o respaldo) trae el block_ip executed.
  useEffect(() => {
    if (!ejecutada) return;
    setFase((x) => x.f === 'hecho' || x.f === 'deshecho' ? x
      : x.f === 'vista' && Date.parse(ejecutada.created_at) < x.desde ? x
      : { f: 'hecho', accion: { id: ejecutada.id, en: ejecutada.created_at, expira: ejecutada.expires_at } });
  }, [ejecutada]);
  useEffect(() => {
    if (fase.f !== 'vista') return;
    campo.current?.focus();
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') { setCodigo(''); setFase({ f: 'reposo' }); } };
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
      if (r.ok && r.action_id) setFase({ f: 'hecho', accion: { id: r.action_id, en: r.en ?? new Date().toISOString(), expira: null } });
      else setFase({ f: 'vista', p, desde, error: r.error ?? r.aviso ?? 'No pudimos bloquearla' });
    } catch (e) {
      if (esApiError(e) && e.status === 409) setFase({ f: 'reposo', error: e.message });
      else if (esApiError(e) && e.details?.reason === 'wrong_code')
        setFase({ f: 'vista', p, desde, error: `Código incorrecto. Te quedan ${String(e.details.attempts_left ?? 0)} intentos` });
      else setFase({ f: 'vista', p, desde, error: mensajeDe(e) });
    }
  };
  const deshacer = async (id: string) => {
    setDeshaciendo(true);
    try { const r = await b.deshacer(id); setFase({ f: 'deshecho', en: r.en ?? new Date().toISOString() }); }
    catch (e) {
      if (esApiError(e) && e.status === 409) setFase({ f: 'deshecho', en: new Date().toISOString() });   // ya deshecha: cuenta como hecho
      else setFase((x) => x);
    } finally { setDeshaciendo(false); }
  };

  // La caducidad la da el servidor: la del incidente refrescado si ya trae esta acción.
  const expira = fase.f === 'hecho' ? (ejecutada?.id === fase.accion.id ? ejecutada.expires_at : fase.accion.expira) : null;
  if (fase.f === 'hecho') return (
    <div className="flex flex-wrap items-center gap-3" aria-live="polite">
      <Etiqueta texto={`Bloqueada · ${cuando(fase.accion.en)}${expira ? ` · caduca ${cuando(expira)}` : ''}`} rol="bien" icono={Ban} />
      <Button variant="secundaria" disabled={!puedeEscribir || deshaciendo} aria-busy={deshaciendo || undefined} onClick={() => deshacer(fase.accion.id)}>
        {deshaciendo ? <Spinner /> : <Undo2 />}Deshacer bloqueo
      </Button>
    </div>
  );
  if (fase.f === 'deshecho') return <Etiqueta texto={`Desbloqueada · ${cuando(fase.en)}`} rol="neutra" />;

  if (fase.f === 'reposo' || fase.f === 'simulando') return (
    <div className="flex flex-col gap-1">
      <Button variant="peligro" size="grande" disabled={!puedeEscribir} aria-busy={fase.f === 'simulando' || undefined}
        onClick={fase.f === 'simulando' ? undefined : simular}>
        {fase.f === 'simulando' ? <Spinner /> : <Ban />}Bloquear esta IP
      </Button>
      {!puedeEscribir ? <span className="text-[12.5px] text-texto-3">Modo demo: solo lectura</span> : null}
      {fase.f === 'reposo' && fase.error ? <span role="alert" className="text-sm text-mal">{fase.error}</span> : null}
    </div>
  );

  const { p } = fase;
  return (
    <form onSubmit={confirmar} className="flex w-full flex-col gap-3 rounded-xl border border-mal-borde bg-mal-relleno p-4" aria-live="polite">
      <p className="text-[15px] font-semibold text-mal">{p.efecto}</p>
      {p.avisos.map((a) => <p key={a} className="rounded-lg border border-aviso-borde bg-aviso-relleno px-3 py-2 text-sm text-aviso">{a}</p>)}
      <p className="text-sm text-muted-foreground">
        {p.delivery === 'whatsapp'
          ? 'Te lo enviamos por WhatsApp. También puedes aprobar con el botón del mensaje.'
          : <>No pudimos enviarte el WhatsApp: tu código es <span className="font-mono font-semibold text-foreground">{p.code}</span></>}
        {' '}Vence en <CuentaAtras hasta={p.expires_at} alVencer={() => setFase({ f: 'reposo', error: 'El código venció, pídelo de nuevo' })} />.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Código de 6 dígitos</span>
          <Input ref={campo} value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric"
            autoComplete="one-time-code" pattern="\d{6}" maxLength={6} className="w-40 font-mono text-lg tracking-widest" aria-invalid={!!fase.error || undefined} />
        </label>
        <Button type="button" variant="secundaria" size="grande" onClick={() => { setCodigo(''); setFase({ f: 'reposo' }); }}>Cancelar</Button>
        <Button type="submit" variant="peligro" size="grande" disabled={codigo.length !== 6 || fase.f === 'escribiendo'} aria-busy={fase.f === 'escribiendo' || undefined}>
          {fase.f === 'escribiendo' ? <Spinner /> : <Ban />}Confirmar bloqueo
        </Button>
      </div>
      {fase.error ? <p role="alert" className="text-sm font-medium text-mal">{fase.error}</p> : null}
    </form>
  );
}
