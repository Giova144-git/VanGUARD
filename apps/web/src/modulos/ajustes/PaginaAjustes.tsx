// /o/:orgId/settings (S14 §14.18). WhatsApp primero (A8): «Probar WhatsApp» es P0 y no se recorta; la llamada es P1.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, LogOut, MessageCircle, Phone, Plus, Save, Trash2 } from 'lucide-react';
import type { Contact } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { Input } from '@/componentes/ui/input';
import { Spinner } from '@/componentes/ui/spinner';
import { BarraModulo } from '@/componentes/vg/BarraModulo';
import { BotonAccion } from '@/componentes/vg/BotonAccion';
import { BotonCopiar } from '@/componentes/vg/BotonCopiar';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { GuiaModulo } from '@/componentes/vg/GuiaModulo';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { useOrg } from '@/app/guardas';
import { armarContactos, normalizarTelefono, type FilaContacto } from '@/lib/contactos';
import { useContactos, useOverview } from '@/lib/consultas';
import { COMMIT, REPO_JUECES } from '@/lib/env';
import { esApiError, mensajeDe } from '@/lib/errores';
import { cuando } from '@/lib/formato';
import { SANDBOX_KAPSO } from '@/lib/guias';
import { useGuardarContactos, useProbarCanal } from '@/lib/mutaciones';
import { supabase } from '@/lib/supabase';
import { aplicarPresentacion, aplicarTema, leerPresentacion, leerTema, type Tema } from '@/lib/tema';
import { cn } from '@/lib/utils';

// La llamada llega después de WhatsApp (A8, P1): mientras no exista, «Probar llamada» va deshabilitado con su motivo.
const LLAMADA_LISTA = false;
const NIVEL_IA = { normal: 'normal', reduced: 'síntesis con Sonnet', minimal: 'solo Haiku', off: 'apagada' } as const;

function Interruptor({ activo, onCambio, etiqueta }: { activo: boolean; onCambio: (v: boolean) => void; etiqueta: string }) {
  return (
    <button type="button" role="switch" aria-checked={activo} aria-label={etiqueta} onClick={() => onCambio(!activo)}
      className={cn('relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        activo ? 'border-info bg-info-relleno' : 'bg-muted')}>
      <span className={cn('inline-block size-5 rounded-full transition-transform', activo ? 'translate-x-6 bg-info' : 'translate-x-1 bg-borde-fuerte')} />
    </button>
  );
}

const aFila = (c: Contact): FilaContacto => ({ clave: c.id, id: c.id, name: c.name, phone: c.phone_e164, whatsapp: c.whatsapp, voice: c.voice, verified_at: c.verified_at });

function ProbarCanal({ org, canal, deshabilitado }: { org: string; canal: 'whatsapp' | 'voice'; deshabilitado?: string }) {
  const probar = useProbarCanal(org);
  const [msg, setMsg] = useState<{ texto: string; mal?: boolean } | null>(null);
  const texto = (e: unknown) => {
    if (!esApiError(e)) return mensajeDe(e);
    if (e.status === 409 && e.details?.reason === 'unverified') return 'Ese contacto aún no está verificado: no le enviamos nada real';
    if (e.status === 403) return 'Solo disponible en officialvanguard.com';
    if (e.status === 429) return 'Llegaste al tope de avisos de esta hora';
    if (e.status === 502) return `El proveedor no respondió (${String(e.details?.provider_code ?? 'sin código')})`;
    return e.message;
  };
  return (
    <span className="inline-flex flex-col gap-1">
      <BotonAccion icono={canal === 'whatsapp' ? MessageCircle : Phone} tam="grande" variante={canal === 'whatsapp' ? 'principal' : 'secundaria'}
        disabled={!!deshabilitado} ayuda={deshabilitado} ocupado={probar.isPending}
        onClick={() => { setMsg(null); probar.mutate(canal, {
          onSuccess: () => setMsg({ texto: `Enviado · ${cuando(new Date())}` }), onError: (e) => setMsg({ texto: texto(e), mal: true }) }); }}>
        {canal === 'whatsapp' ? 'Probar WhatsApp' : 'Probar llamada'}
      </BotonAccion>
      {msg ? <span role={msg.mal ? 'alert' : 'status'} className={cn('max-w-xs text-sm', msg.mal ? 'text-mal' : 'text-bien')}>{msg.texto}</span> : null}
    </span>
  );
}

// Verificación por WhatsApp: tras abrir el enlace se consulta GET contacts cada 5 s durante 2 min (solo con la pestaña
// visible) hasta que el servidor marque verified_at. El código y el enlace vienen del servidor y no se guardan en ningún
// almacenamiento del navegador ni en el historial.
const ESPERA_VERIFICAR_MS = 120_000;
type Espera = { id: string; nombre: string; hasta: number };

function Verificar({ c, esperando, alAbrir }: { c: Contact; esperando: boolean; alAbrir: () => void }) {
  if (!c.verificacion) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed px-3 py-3">
      <p className="text-sm text-muted-foreground">Solo enviamos alertas a teléfonos que confirman ser suyos.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="principal">
          <a href={c.verificacion.enlace} target="_blank" rel="noopener noreferrer" onClick={alAbrir}>
            <MessageCircle />Verificar por WhatsApp
          </a>
        </Button>
        <span className="text-sm">
          O escribe <code className="rounded bg-muted px-1.5 font-mono text-[13px]">VERIFICAR {c.verificacion.codigo}</code> a VanGUARD desde ese teléfono
        </span>
        <BotonCopiar valor={`VERIFICAR ${c.verificacion.codigo}`} texto="Copiar" />
      </div>
      {esperando ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Esperando tu mensaje…</p> : null}
    </div>
  );
}

function Contactos({ org }: { org: string }) {
  const [espera, setEspera] = useState<Espera | null>(null);
  const [aviso, setAviso] = useState<{ texto: string; bien: boolean } | null>(null);
  const q = useContactos(org, true, espera ? 5_000 : false);
  const guardar = useGuardarContactos(org);
  const [filas, setFilas] = useState<FilaContacto[] | null>(null);
  const [errores, setErrores] = useState<Record<string, string>>({});
  const [guardado, setGuardado] = useState<string | null>(null);
  useEffect(() => { if (q.data && filas === null) setFilas([...q.data].sort((a, b) => a.priority - b.priority).map(aFila)); }, [q.data, filas]);

  // La verdad de cada fila guardada sale del servidor: la chapa cambia en cuanto llega verified_at.
  const servidor = new Map((q.data ?? []).map((c) => [c.id, c]));
  useEffect(() => {
    if (!espera) return;
    if (q.data?.find((c) => c.id === espera.id)?.verified_at) {
      setAviso({ texto: `${espera.nombre} quedó verificado: ya le enviamos alertas reales.`, bien: true });
      setEspera(null);
      return;
    }
    const t = setTimeout(() => { setAviso({ texto: 'No nos llegó. Vuelve a intentarlo.', bien: false }); setEspera(null); }, Math.max(0, espera.hasta - Date.now()));
    return () => clearTimeout(t);
  }, [espera, q.data]);

  if (q.isError) return <ErrorBloque error={q.error} onReintentar={() => q.refetch()} />;
  if (!filas) return <p className="text-texto-3" aria-busy="true">—</p>;
  const hayVerificacion = (q.data ?? []).some((c) => c.verificacion);
  const cambiar = (clave: string, p: Partial<FilaContacto>) => { setGuardado(null); setFilas(filas.map((f) => f.clave === clave ? { ...f, ...p } : f)); };
  const mover = (i: number, d: -1 | 1) => { const n = [...filas]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x!); setFilas(n); setGuardado(null); };
  const enviar = () => {
    const r = armarContactos(filas);
    if (!r.ok) { setErrores(r.errores); return; }
    setErrores({});
    guardar.mutate(r.lista, {
      onSuccess: (lista) => { setFilas([...lista].sort((a, b) => a.priority - b.priority).map(aFila)); setGuardado(new Date().toISOString()); },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <ProbarCanal org={org} canal="whatsapp" />
        <ProbarCanal org={org} canal="voice" deshabilitado={LLAMADA_LISTA ? undefined : 'La llamada llega después de WhatsApp'} />
      </div>
      <p className="text-sm text-muted-foreground">«Probar» envía al contacto con más prioridad que tenga ese canal activo.</p>
      {SANDBOX_KAPSO ? <p className="rounded-lg border bg-info-relleno px-3 py-2 text-sm">{SANDBOX_KAPSO}</p> : null}
      <p className="sr-only" role="status" aria-live="polite">{aviso?.texto ?? ''}</p>
      {aviso ? <p className={cn('text-sm font-medium', aviso.bien ? 'text-bien' : 'text-mal')}>{aviso.texto}</p> : null}
      <ol className="flex flex-col gap-3" aria-label="Contactos de alerta">
        {filas.map((f, i) => {
          const s = f.id ? servidor.get(f.id) : undefined;
          const verificado = !!(s?.verified_at ?? f.verified_at);
          // El enlace es del teléfono guardado: si la fila tiene cambios sin guardar, no se ofrece.
          const sinCambios = !!s && normalizarTelefono(f.phone) === s.phone_e164 && f.whatsapp === s.whatsapp;
          return (
          <li key={f.clave} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-full bg-info-relleno text-sm font-semibold text-info tabular-nums" role="img" aria-label={`Prioridad ${i + 1}`}>{i + 1}</span>
              <Etiqueta texto={verificado ? 'Verificado' : 'Sin verificar'} rol={verificado ? 'bien' : 'aviso'} />
              <span className="flex-1" />
              <Button variant="fantasma" size="icono" disabled={i === 0} onClick={() => mover(i, -1)} aria-label="Subir prioridad"><ArrowUp /></Button>
              <Button variant="fantasma" size="icono" disabled={i === filas.length - 1} onClick={() => mover(i, 1)} aria-label="Bajar prioridad"><ArrowDown /></Button>
              <Button variant="fantasma" size="icono" onClick={() => { setFilas(filas.filter((x) => x.clave !== f.clave)); setGuardado(null); }} aria-label="Quitar contacto"><Trash2 /></Button>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto_auto] md:items-center">
              <Input value={f.name} maxLength={60} placeholder="Nombre" aria-label="Nombre" onChange={(e) => cambiar(f.clave, { name: e.target.value })} />
              <Input value={f.phone} inputMode="tel" placeholder="+58 412 123 4567" aria-label="Teléfono" className="font-mono" autoComplete="off"
                onChange={(e) => cambiar(f.clave, { phone: e.target.value })} aria-invalid={!!errores[f.clave] || undefined} />
              <label className="flex items-center gap-2 text-sm"><Interruptor activo={f.whatsapp} onCambio={(v) => cambiar(f.clave, { whatsapp: v })} etiqueta="WhatsApp" />WhatsApp</label>
              <label className="flex items-center gap-2 text-sm"><Interruptor activo={f.voice} onCambio={(v) => cambiar(f.clave, { voice: v })} etiqueta="Llamada" />Llamada</label>
            </div>
            {errores[f.clave] ? <p role="alert" className="text-sm text-mal">{errores[f.clave]}</p> : null}
            {s && sinCambios && !verificado ? (
              <Verificar c={s} esperando={espera?.id === s.id}
                alAbrir={() => { setAviso(null); setEspera({ id: s.id, nombre: s.name, hasta: Date.now() + ESPERA_VERIFICAR_MS }); }} />
            ) : null}
          </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secundaria" disabled={filas.length >= 5}
          onClick={() => setFilas([...filas, { clave: crypto.randomUUID(), name: '', phone: '', whatsapp: true, voice: false, verified_at: null }])}>
          <Plus />Añadir contacto
        </Button>
        <BotonAccion variante="principal" tam="grande" icono={Save} ocupado={guardar.isPending} onClick={enviar}>Guardar</BotonAccion>
        {guardado ? <span role="status" className="text-sm text-bien">Guardado · {cuando(guardado)}</span> : null}
        {guardar.isError ? <span role="alert" className="text-sm text-mal">{mensajeDe(guardar.error)}</span> : null}
        {errores._ ? <span role="alert" className="text-sm text-mal">{errores._}</span> : null}
      </div>
      <p className="text-[12.5px] text-muted-foreground">
        {hayVerificacion
          ? 'Solo los contactos verificados reciben WhatsApp y llamadas reales. Cada uno se verifica enviando su código a VanGUARD desde su propio teléfono.'
          : 'Solo los contactos verificados reciben WhatsApp y llamadas reales. Por ahora la verificación la hace a mano el equipo de VanGUARD; la verificación automática por WhatsApp está en camino.'}
      </p>
    </div>
  );
}

function ModoPresentacion() {
  const [si, setSi] = useState(leerPresentacion);
  return (
    <label className="flex w-fit items-center gap-3 text-[15px]">
      <Interruptor activo={si} etiqueta="Modo presentación" onCambio={(v) => { aplicarPresentacion(v); setSi(v); }} />
      Modo presentación <span className="text-sm text-muted-foreground">(texto más grande para el proyector)</span>
    </label>
  );
}

function SelectorTema() {
  const [tema, setTema] = useState<Tema>(leerTema);
  return (
    <div className="inline-flex w-fit rounded-lg bg-muted p-1" role="group" aria-label="Tema">
      {([['claro', 'Claro'], ['oscuro', 'Oscuro'], ['sistema', 'Sistema']] as const).map(([v, t]) => (
        <button key={v} type="button" aria-pressed={tema === v} onClick={() => { aplicarTema(v); setTema(v); }}
          className={cn('h-11 rounded-md px-4 text-sm font-medium', tema === v ? 'bg-card text-foreground' : 'text-muted-foreground')}>{t}</button>
      ))}
    </div>
  );
}

export default function PaginaAjustes() {
  const org = useOrg();
  const qc = useQueryClient();
  const navegar = useNavigate();
  const ia = useOverview(org.id).data?.ai;
  const salir = async () => { await supabase.auth.signOut(); qc.clear(); navegar('/', { replace: true }); };

  return (
    <div className="flex flex-col gap-6">
      <BarraModulo titulo="Ajustes" descripcion="A quién avisamos, por qué canal y el estado de la IA." />

      <section className="flex flex-col gap-4 rounded-xl border bg-card p-5" aria-labelledby="t-contactos">
        <h3 id="t-contactos" className="text-[17px] font-semibold">Contactos de alerta</h3>
        {org.puedeEscribir ? <Contactos org={org.id} /> : <p className="text-sm text-muted-foreground">Los contactos solo los ve un administrador.</p>}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border bg-card p-5" aria-labelledby="t-canales">
        <h3 id="t-canales" className="text-[17px] font-semibold">Canales por severidad</h3>
        <ul className="flex flex-col gap-2 text-[15px]">
          {/* Solo lectura: sin acción al lado, sin rojo (L3). */}
          <li><span className="font-semibold">Crítica</span> · en la app + WhatsApp a todos · llamada: próximamente</li>
          <li><span className="font-semibold">Alta</span> · en la app + WhatsApp</li>
          <li><span className="font-semibold">Media, Baja e Info</span> · en la app</li>
        </ul>
        <p className="text-sm text-muted-foreground">Topes por hora: 2 llamadas y 10 WhatsApp (en la org de demo, 6 y 30).</p>
        <p className="text-sm text-muted-foreground">Leído no es confirmado: confirma con «Lo estoy viendo».</p>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border bg-card p-5" aria-labelledby="t-ia">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="t-ia" className="flex-1 text-[17px] font-semibold">IA</h3>
          {ia ? <Etiqueta texto={ia.enabled ? `IA encendida · ${NIVEL_IA[ia.level]}` : 'IA en pausa'} rol={ia.enabled ? 'info' : 'neutra'} /> : <span className="text-texto-3">—</span>}
        </div>
        <p className="text-sm text-muted-foreground">El tope diario lo cambia solo el administrador de VanGUARD. Si la IA se pausa, las alertas siguen saliendo con plantillas.</p>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border bg-card p-5" aria-labelledby="t-org">
        <h3 id="t-org" className="text-[17px] font-semibold">Organización y sesión</h3>
        <dl className="grid gap-x-6 gap-y-1 text-[15px] sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Organización</dt><dd>{org.name}</dd>
          <dt className="text-muted-foreground">Tu rol</dt><dd>{org.role === 'owner' ? 'Dueño' : org.role === 'admin' ? 'Admin' : 'Solo lectura'}</dd>
          <dt className="text-muted-foreground">Tu correo</dt><dd>{org.me.user.email ?? 'Invitado · demo'}</dd>
        </dl>
        <SelectorTema />
        <ModoPresentacion />
        <div><Button variant="secundaria" size="grande" onClick={salir}><LogOut />Cerrar sesión</Button></div>
        <p className="text-[12.5px] text-texto-3">
          versión{' '}
          {COMMIT === 'local' ? <span className="font-mono">local</span>
            : <a className="font-mono underline underline-offset-2" href={`${REPO_JUECES}/commit/${COMMIT}`} target="_blank" rel="noopener noreferrer">{COMMIT}</a>}
        </p>
      </section>

      <GuiaModulo id="settings" />
    </div>
  );
}
