import { Link } from 'react-router';
import type { Overview } from '@vanguard/contracts';
import { sinBidi } from '@/lib/bidi';
import type { Rol } from '@/lib/severidad';
import { TEXTO_ROL, deMapa } from '@/lib/severidad';
import { cn } from '@/lib/utils';

const NOMBRE_MODULO: Record<string, string> = { supabase: 'Supabase', cloudflare: 'Cloudflare', codebase: 'Codebase', performance: 'Rendimiento' };

// S14 §14.11: el puntaje SIEMPRE con la cobertura pegada; verde solo con cobertura completa (L4).
// Sin `coverage` (aún cargando) pinta la misma estructura con «—», y la línea de «Falta» va siempre reservada: no cambia de alto (L7).
// Sin `enlaceConectar` (el viewer, que no puede conectar nada) «Falta: …» va sin el enlace.
export function PuntajeBlindaje({ score = null, band = null, coverage, enlaceConectar }:
  Partial<Pick<Overview, 'score' | 'band' | 'coverage'>> & { enlaceConectar?: string }) {
  const completa = coverage != null && coverage.seen === coverage.total;
  const rol: Rol = score == null || band == null ? 'neutra'
    : band === 'red' ? 'mal' : band === 'amber' ? 'aviso' : completa ? 'bien' : 'neutra';
  return (
    <div className="flex flex-col gap-1" aria-busy={coverage ? undefined : true}>
      <span className="text-[12.5px] font-medium text-muted-foreground">Puntaje de blindaje</span>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={cn('font-mono text-6xl font-semibold tabular-nums', score == null ? 'text-texto-3' : rol === 'neutra' ? 'text-foreground' : TEXTO_ROL[rol])}
          aria-hidden={score == null || undefined}>
          {score ?? '—'}
        </span>
        <span className="text-[15px] text-muted-foreground">
          {!coverage ? null : score == null ? 'Aún no auditamos tu ecosistema' : <>de 100 · Vemos <span className="font-semibold text-foreground">{coverage.seen} de {coverage.total}</span> fuentes</>}
        </span>
      </div>
      <span className="min-h-[1.5em] text-[15px] text-muted-foreground">
        {coverage?.missing.length ? <>
          {/* Un módulo fuera de contrato sale tal cual llega: con los controles bidi a la vista (lib/bidi.ts). */}
          Falta: {sinBidi(coverage.missing.map((m) => deMapa(NOMBRE_MODULO, m, String(m))).join(', '))}
          {enlaceConectar ? <> · <Link to={enlaceConectar} className="font-medium text-foreground underline underline-offset-4">Conectar</Link></> : null}
        </> : null}
      </span>
    </div>
  );
}
