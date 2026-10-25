import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { CifraDato } from '@vanguard/contracts';
import { sinBidi } from '@/lib/bidi';
import { cifra } from '@/lib/formato';
import { TEXTO_ROL, type Rol } from '@/lib/severidad';
import { cn } from '@/lib/utils';

type Props = Pick<CifraDato, 'etiqueta' | 'n' | 'de' | 'unidad' | 'decimales' | 'sub'> & { rol?: Rol; href?: string; valor?: string; accion?: ReactNode };

// Cifra de alto fijo (L7, S14 §14.7): n = null → «—» neutra; el color solo con una acción al lado (L3). El alto es
// mínimo, no fijo: a 375 px una etiqueta larga («Puntaje escritorio») parte en dos líneas y con h fija se montaba sobre
// la cifra; el grid iguala las de la misma fila, así que nada salta al cargar.
// `etiqueta` y `sub` llegan del servidor (EstadoModulo.cifras): sus controles bidi se ven aquí dentro (lib/bidi.ts).
export function Cifra({ etiqueta, n, de, unidad, decimales, sub, rol, href, valor, accion }: Props) {
  const r: Rol = n == null ? 'neutra' : (rol === 'mal' || rol === 'aviso') && !href && !accion ? 'neutra' : rol ?? 'neutra';
  const cuerpo = (
    <>
      <span className="font-mono text-[12.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{typeof etiqueta === 'string' ? sinBidi(etiqueta) : etiqueta}</span>
      <span className={cn('text-3xl font-semibold tabular-nums', r === 'neutra' ? (n == null ? 'text-texto-3' : 'text-foreground') : TEXTO_ROL[r])}>
        {valor ?? cifra({ n, de, unidad, decimales })}
      </span>
      {sub ? <span className="truncate text-[12.5px] text-texto-3">{typeof sub === 'string' ? sinBidi(sub) : sub}</span> : null}
      {accion}
    </>
  );
  const clase = 'flex min-h-[104px] flex-col justify-between rounded-xl border bg-card px-4 py-3';
  return href
    ? <Link to={href} className={cn(clase, 'outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring')}>{cuerpo}</Link>
    : <div className={clase}>{cuerpo}</div>;
}

export function FilaCifras({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">{children}</div>;
}
