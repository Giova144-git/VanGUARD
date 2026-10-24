import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/componentes/ui/button';
import type { ApiError } from '@/lib/errores';
import { mensajeDe } from '@/lib/errores';

export function Vacio({ icono: Icono, titulo, texto, accion }: { icono: LucideIcon; titulo: string; texto?: string; accion?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground"><Icono className="size-6" /></span>
      <h2 className="text-[17px] font-semibold">{titulo}</h2>
      {texto ? <p className="max-w-md text-[15px] text-muted-foreground">{texto}</p> : null}
      {accion ? <div className="mt-2">{accion}</div> : null}
    </div>
  );
}

// Error con request_id copiable y «Reintentar» (S14 §14.7). Los datos viejos se quedan con su hora: este bloque no los tapa.
export function ErrorBloque({ error, onReintentar }: { error: ApiError | Error | unknown; onReintentar?: () => void }) {
  const rid = (error as ApiError | undefined)?.requestId;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-mal-borde bg-mal-relleno px-4 py-3 text-mal">
      <TriangleAlert className="size-5 shrink-0" />
      <span className="flex-1 text-sm font-medium">{mensajeDe(error)}{rid ? <span className="ml-2 font-mono text-[13px] opacity-80">· {rid}</span> : null}</span>
      {onReintentar ? <Button variant="peligro" size="fila" onClick={onReintentar}><RotateCw />Reintentar</Button> : null}
    </div>
  );
}
