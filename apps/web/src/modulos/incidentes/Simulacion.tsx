// «Simular ataque» (E57, asignaciones/llamada-ataque.md F1): solo owner/admin y solo en la org de demo. Crea un incidente
// crítico de prueba con una IP reservada; el despachador de siempre avisa por WhatsApp y, si el contacto tiene la llamada
// activada, llama Guardia. Bandera del servidor: un 404 (E57 aún sin desplegar) o un 403 retiran el botón. En modo
// fixtures responde el enrutador falso (con los hitos del guion). «Simular aprobación por WhatsApp» existe SOLO en
// fixtures (S14 §14.19): el import dinámico va dentro de la condición escrita en línea, para que Vite la sustituya por
// literales y el enrutador falso no entre en el bundle de producción (F-03).
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { SimulateAttackKind, SimulateAttackOut } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { BotonAccion } from '@/componentes/vg/BotonAccion';
import type { OrgActual } from '@/app/guardas';
import { USA_FIXTURES } from '@/lib/env';
import { esApiError, mensajeDe } from '@/lib/errores';
import { useRutaAusente, useSimularAtaque } from '@/lib/mutaciones';
import { deMapa } from '@/lib/severidad';
import { cn } from '@/lib/utils';

// La inundación primero y por defecto: con el motor real es la única crítica, la que trae «Llamar a Guardia» (1bbfa42).
const TIPOS: { kind: SimulateAttackKind; texto: string }[] = [
  { kind: 'ip_flood', texto: 'Inundación' },
  { kind: 'path_scan', texto: 'Escaneo de rutas' },
  { kind: 'attack_tool', texto: 'Herramienta de ataque' },
];
const CANAL: Record<SimulateAttackOut['whatsapp'], string> = { queued: 'en camino', skipped: 'no aplica', failed: 'falló' };
/** Lo que hizo cada canal, dicho en una línea (un valor fuera de contrato sale «—»). */
export const textoCanales = (o: Pick<SimulateAttackOut, 'whatsapp' | 'voice'>) =>
  `WhatsApp: ${deMapa(CANAL, o.whatsapp, '—')} · Llamada: ${deMapa(CANAL, o.voice, '—')}`;
/** Estado de la navegación al incidente recién simulado: su página enseña el aviso de los canales. */
export type EstadoSimulacion = { simulacion: { id: string; canales: string } };

const errorSimulacion = (e: unknown) => (esApiError(e) && e.status === 429 ? 'Espera 2 minutos entre simulaciones' : mensajeDe(e));

export function SimularAtaque({ org }: { org: OrgActual }) {
  const navegar = useNavigate();
  const ausente = useRutaAusente(org.id, 'E57');
  const sim = useSimularAtaque(org.id);
  const [kind, setKind] = useState<SimulateAttackKind>('ip_flood');
  if (!org.puedeEscribir || !(org.is_demo || org.sandbox) || ausente) return null;   // también en la copia de la demo
  const simular = () => sim.mutate({ kind }, {
    onSuccess: (r) => navegar(`/o/${org.id}/incidents/${encodeURIComponent(r.incident_id)}`,
      { state: { simulacion: { id: r.incident_id, canales: textoCanales(r) } } satisfies EstadoSimulacion }),
  });
  return (
    <section className="flex flex-col items-start gap-3 rounded-xl border bg-card p-5" aria-label="Simular ataque">
      <div className="inline-flex max-w-full flex-wrap rounded-lg bg-muted p-1" role="group" aria-label="Tipo de ataque">
        {TIPOS.map((t) => (
          <button key={t.kind} type="button" aria-pressed={kind === t.kind} onClick={() => setKind(t.kind)}
            className={cn('h-11 rounded-md px-4 text-sm font-medium', kind === t.kind ? 'bg-card text-foreground' : 'text-muted-foreground')}>
            {t.texto}
          </button>
        ))}
      </div>
      <BotonAccion variante="secundaria" tam="grande" icono={FlaskConical} ocupado={sim.isPending} onClick={simular}>Simular ataque</BotonAccion>
      <p className="text-[12.5px] text-muted-foreground">
        Crea un incidente de prueba con una IP reservada (203.0.113.x). La inundación es crítica: llega el WhatsApp y el botón para llamar a Guardia. El escaneo y la herramienta son altos: solo el WhatsApp.
      </p>
      {sim.isError && !ausente ? <p role="alert" className="text-sm text-mal">{errorSimulacion(sim.error)}</p> : null}
    </section>
  );
}

async function cargar() {
  if (import.meta.env.MODE === 'fixtures' || import.meta.env.VITE_USE_FIXTURES === '1') return import('@/lib/fixtures/router');
  return null;
}

export function BotonSimularWhatsApp({ org, incidentId }: { org: string; incidentId: string }) {
  const qc = useQueryClient();
  if (!USA_FIXTURES) return null;
  return (
    <Button variant="secundaria" onClick={async () => {
      const m = await cargar();
      if (!m) return;
      m.simularAprobacionWhatsApp(org, incidentId);
      await qc.invalidateQueries({ queryKey: ['org', org] });
    }}><FlaskConical />Simular aprobación por WhatsApp</Button>
  );
}
