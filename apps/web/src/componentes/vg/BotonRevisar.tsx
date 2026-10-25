// «Revisar X ahora» de cada módulo (S14 §14.12): POST scans {kind} → /audit/:id. 409 con scan_run_id → la que corre.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ShieldCheck } from 'lucide-react';
import type { ScanCreate } from '@vanguard/contracts';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { esApiError, mensajeDe } from '@/lib/errores';
import { useLanzarScan } from '@/lib/mutaciones';
import { BotonGrande } from './BotonGrande';

// `connectionId`: «Analizar este repo» de una pestaña de Codebase (varias-codebases §6.2). Sin él, E11 elige (principal).
export function BotonRevisar({ kind, titulo, descripcion, connectionId }: {
  kind: Extract<ScanCreate['kind'], 'supabase' | 'cloudflare' | 'repo'>; titulo: string; descripcion: string; connectionId?: string;
}) {
  const org = useOrg();
  const navegar = useNavigate();
  const lanzar = useLanzarScan(org.id);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <BotonGrande icono={ShieldCheck} titulo={titulo} descripcion={descripcion} ocupado={lanzar.isPending}
        deshabilitado={org.puedeEscribir ? undefined : SOLO_LECTURA}
        onClick={() => { setError(null); lanzar.mutate(connectionId ? { kind, connection_id: connectionId } : { kind }, {
          // Ids codificados, como useLanzarYNavegar: un id con «../», «?» o «#» no saca la navegación de /audit/.
          onSuccess: (r) => navegar(`/o/${org.id}/audit/${encodeURIComponent(r.scan_run_id)}`),
          onError: (e) => {
            const enCurso = esApiError(e) && e.code === 'conflict' && typeof e.details?.scan_run_id === 'string' ? e.details.scan_run_id : null;
            if (enCurso) navegar(`/o/${org.id}/audit/${encodeURIComponent(enCurso)}`); else setError(mensajeDe(e));
          },
        }); }} />
      {error ? <p role="alert" className="text-sm text-mal">{error}</p> : null}
    </div>
  );
}
