// Detalle de un hallazgo (S14 §14.15): en PanelDetalle (?finding=) y a ancho completo en /findings/:findingId.
import { useState } from 'react';
import { ArrowDown, CheckCheck, ExternalLink, RotateCcw, ShieldAlert } from 'lucide-react';
import type { Finding, FindingStatus, Module } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { Input } from '@/componentes/ui/input';
import { BotonAccion } from '@/componentes/vg/BotonAccion';
import { BotonCopiar } from '@/componentes/vg/BotonCopiar';
import { ConfirmarEnSitio } from '@/componentes/vg/ConfirmarEnSitio';
import { ChapaSeveridad, Etiqueta } from '@/componentes/vg/Etiqueta';
import { FichaFila } from '@/componentes/vg/FichaFila';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { SOLO_LECTURA } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { useHallazgo } from '@/lib/consultas';
import { esApiError, mensajeDe } from '@/lib/errores';
import { esId } from '@/lib/ids';
import { cuando } from '@/lib/formato';
import { usePatchHallazgo } from '@/lib/mutaciones';
import { porQueImporta, referencias } from '@/lib/reglas-texto';
import { deMapa, type Rol } from '@/lib/severidad';
import { PromptCorreccion } from './PromptCorreccion';
import { ResolverConMcp } from './ResolverConMcp';

const MODULO: Record<Module, string> = { supabase: 'Supabase', cloudflare: 'Cloudflare', codebase: 'Codebase', performance: 'Rendimiento' };
const ESTADO: Record<FindingStatus, { texto: string; rol: Rol }> = {
  open: { texto: 'Abierto', rol: 'neutra' }, fixed: { texto: 'Corregido', rol: 'neutra' },
  verified: { texto: 'Verificado ✓', rol: 'bien' }, ignored: { texto: 'Ignorado', rol: 'neutra' },
};

function Acciones({ org, f, puedeEscribir }: { org: string; f: Finding; puedeEscribir: boolean }) {
  const patch = usePatchHallazgo(org);
  const [motivo, setMotivo] = useState('');
  const solo = puedeEscribir ? undefined : SOLO_LECTURA;
  if (f.status === 'fixed' || f.status === 'ignored')
    return (
      <div className="flex flex-col gap-2">
        <BotonAccion icono={RotateCcw} disabled={!!solo} ayuda={solo} ocupado={patch.isPending}
          onClick={() => patch.mutate({ id: f.id, status: 'open' })}>Reabrir</BotonAccion>
        {patch.isError ? <p role="alert" className="text-sm text-mal">{mensajeDe(patch.error)}</p> : null}
      </div>
    );
  if (f.status === 'verified') return null;                      // verified nunca lo pone el FRONT
  const motivoOk = motivo.trim().length >= 3 && motivo.trim().length <= 300;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-2">
        <BotonAccion variante="principal" icono={CheckCheck} disabled={!!solo} ayuda={solo} ocupado={patch.isPending && patch.variables?.status === 'fixed'}
          onClick={() => patch.mutate({ id: f.id, status: 'fixed' })}>Marcar corregido</BotonAccion>
      </div>
      {solo ? null : (
        <div className="flex flex-col gap-2">
          <Input value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={300} placeholder="Por qué lo ignoras (3 a 300 caracteres)" aria-label="Motivo para ignorar" />
          <ConfirmarEnSitio verbo="Ignorar" deshabilitado={motivoOk ? undefined : 'Escribe el motivo para poder ignorarlo'}
            aviso="Dejará de contar en tu puntaje."
            onConfirmar={async () => { await patch.mutateAsync({ id: f.id, status: 'ignored', reason: motivo.trim() }); setMotivo(''); }} />
        </div>
      )}
      {patch.isError ? <p role="alert" className="text-sm text-mal">{mensajeDe(patch.error)}</p> : null}
    </div>
  );
}

export function DetalleHallazgo({ org, id, puedeEscribir }: { org: string; id: string; puedeEscribir: boolean }) {
  const q = useHallazgo(org, id);
  if (!esId(id) || (q.isError && esApiError(q.error) && q.error.status === 404))
    return <p className="text-[15px] text-muted-foreground">Este hallazgo no existe o no es de esta organización.</p>;
  if (q.isError && !q.data) return <ErrorBloque error={q.error} onReintentar={() => q.refetch()} />;
  const f = q.data;
  if (!f) return <p className="text-texto-3" aria-busy="true">—</p>;
  const texto = porQueImporta(f.rule_id);
  const refs = referencias(f.evidence);
  const estado = deMapa(ESTADO, f.status, { texto: '—', rol: 'neutra' });

  return (
    <article className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <ChapaSeveridad severity={f.severity} />
          <Etiqueta texto={deMapa(MODULO, f.module, '—')} />
          <Etiqueta texto={f.confirmed ? 'Confirmado por regla' : 'Posible'} rol={f.confirmed ? 'neutra' : 'aviso'} />
          <Etiqueta texto={estado.texto} rol={estado.rol} />
        </div>
        <h2 className="text-[17px] font-semibold wrap-anywhere">{sinBidi(f.title)}</h2>
        <p className="font-mono text-[13px] text-muted-foreground"><bdi dir="ltr">{sinBidi(f.rule_id)}</bdi></p>
        <p className="text-[12.5px] text-texto-3">Visto por primera vez {cuando(f.first_seen_at)} · última vez {cuando(f.last_seen_at)}</p>
        {f.status_reason ? <p className="text-sm text-muted-foreground">Motivo: {sinBidi(f.status_reason)}</p> : null}
        {/* El prompt queda al final del detalle: en la demo se salta hasta él sin bajar a mano por la evidencia (F-15). */}
        <Button variant="fantasma" size="fila" className="-ml-3 self-start"
          onClick={() => document.getElementById('titulo-prompt')?.scrollIntoView({ block: 'start',
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}>
          <ArrowDown />Ir al prompt de corrección</Button>
      </header>

      <section className="flex flex-col gap-2" aria-label="Dónde">
        <h3 className="text-[15px] font-semibold">Dónde</h3>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 rounded-lg border bg-card px-3 py-2 font-mono text-[13px] break-all"><bdi dir="ltr">{sinBidi(f.resource)}</bdi></code>
          <BotonCopiar valor={f.resource} />
        </div>
      </section>

      {texto ? (
        <section className="flex flex-col gap-1" aria-label="Por qué importa">
          <h3 className="text-[15px] font-semibold">Por qué importa</h3>
          <p className="text-[15px] leading-relaxed">{texto}</p>
        </section>
      ) : null}

      <Acciones org={org} f={f} puedeEscribir={puedeEscribir} />

      <PromptCorreccion org={org} finding={f} puedeEscribir={puedeEscribir} />

      {f.status === 'open' ? <ResolverConMcp org={org} findingId={f.id} /> : null}

      <section className="flex flex-col gap-2" aria-label="Evidencia">
        <h3 className="text-[15px] font-semibold">Evidencia</h3>
        {f.suspected_injection ? <Etiqueta icono={ShieldAlert} rol="aviso" className="h-auto py-1 whitespace-normal"
          texto="La evidencia trae texto que intenta dar órdenes: lo mostramos como dato y la IA no lo obedece" /> : null}
        <FichaFila valor={f.evidence} rotulo="Dato no confiable, con secretos tapados" />
        {refs.length ? (
          <ul className="flex flex-wrap gap-2">
            {refs.map((r) => (
              <li key={r.href}><a href={r.href} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-[13px] text-foreground underline underline-offset-4">{r.id}<ExternalLink className="size-3.5" /></a></li>
            ))}
          </ul>
        ) : null}
      </section>
    </article>
  );
}
