// «Activar modo blindaje» (S14 §14.10): volver a pegar el mismo token de lectura da 409, así que se confirma en el sitio
// (L6), se quita la conexión de lectura de Cloudflare (y cualquier conexión de acciones caída) y se abre el asistente con
// el zone_id ya puesto para crear las dos de una vez. Los tokens nunca se prellenan (L10); los hallazgos se conservan.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ShieldHalf } from 'lucide-react';
import { Button } from '@/componentes/ui/button';
import { Spinner } from '@/componentes/ui/spinner';
import { BotonGrande } from '@/componentes/vg/BotonGrande';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { useConexiones } from '@/lib/consultas';
import { mensajeDe } from '@/lib/errores';
import { useQuitarConexion } from '@/lib/mutaciones';

export const AVISO_BLINDAJE = 'Quitamos la conexión de lectura de Cloudflare y la vuelves a crear con los dos tokens; los hallazgos se conservan.';

// Lo que el asistente recibe en el estado de la navegación (no en la URL).
export type EstadoBlindaje = { blindaje: true; zone_id: string | null };

export function ActivarBlindaje({ forma = 'grande', titulo = 'Activar modo blindaje' }: { forma?: 'grande' | 'fila'; titulo?: string }) {
  const org = useOrg();
  const navegar = useNavigate();
  const conexiones = useConexiones(org.id);
  const quitar = useQuitarConexion(org.id);
  const [fase, setFase] = useState<'reposo' | 'pregunta' | 'ocupado'>('reposo');
  const [error, setError] = useState<string | null>(null);
  const confirmar = useRef<HTMLButtonElement>(null);
  const lista = conexiones.data ?? [];
  const lectura = lista.find((c) => c.provider === 'cloudflare' && c.kind === 'read');
  const zona = typeof lectura?.meta.zone_id === 'string' ? lectura.meta.zone_id : null;
  const solo = org.puedeEscribir ? undefined : SOLO_LECTURA;

  useEffect(() => {
    if (fase !== 'pregunta') return;
    confirmar.current?.focus();
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setFase('reposo'); } };
    window.addEventListener('keydown', tecla, true);                         // en captura: no cierra paneles de detrás
    return () => window.removeEventListener('keydown', tecla, true);
  }, [fase]);

  const ir = () => navegar(`/o/${org.id}/connections/cloudflare`, { state: { blindaje: true, zone_id: zona } satisfies EstadoBlindaje });
  const abrir = () => { setError(null); if (lectura) setFase('pregunta'); else ir(); };   // sin lectura no hay nada que quitar

  const seguir = async () => {
    if (fase === 'ocupado') return;
    setFase('ocupado');
    try {
      // La lectura y, si quedó alguna, la de acciones caída: el asistente crea las dos de nuevo.
      const sobran = lista.filter((c) => c.provider === 'cloudflare' && (c.kind === 'read' || c.status !== 'active'));
      for (const c of sobran) await quitar.mutateAsync(c.id);
      ir();
    } catch (e) {
      setError(mensajeDe(e));
      setFase('reposo');
    }
  };

  if (fase === 'reposo') return (
    <div className="flex flex-col gap-1">
      {forma === 'grande'
        ? <BotonGrande icono={ShieldHalf} titulo={titulo} descripcion="Para bloquear IPs desde VanGUARD hace falta un segundo token, solo para eso"
            deshabilitado={solo} onClick={abrir} />
        : <span className="inline-flex flex-col gap-1">
            <Button variant="principal" disabled={!!solo} onClick={abrir}><ShieldHalf />{titulo}</Button>
            {solo ? <span className="text-[12.5px] text-texto-3">{solo}</span> : null}
          </span>}
      {error ? <span role="alert" className="text-sm text-mal">{error}</span> : null}
    </div>
  );
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4" role="group" aria-label={titulo}>
      <p className="text-[15px]">{AVISO_BLINDAJE}</p>
      <p className="text-sm text-muted-foreground">Ten a mano el token de lectura (puede ser el mismo) y uno nuevo con solo Firewall Services · Edit.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secundaria" size="grande" disabled={fase === 'ocupado'} onClick={() => setFase('reposo')}>Cancelar</Button>
        <Button ref={confirmar} variant="principal" size="grande" aria-busy={fase === 'ocupado' || undefined} onClick={seguir}>
          {fase === 'ocupado' ? <Spinner /> : <ShieldHalf />}Quitar y reconectar con los dos tokens
        </Button>
      </div>
    </div>
  );
}
