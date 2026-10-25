import type { ReactNode } from 'react';
import type { Contador } from '@vanguard/contracts';
import { MarcasContador } from './MarcasContador';

// Barra de cada pantalla (S14 §14.12): título, guía en una línea, marcas y lo que la página ponga a la derecha.
// `data-info` va en el título y su guía: lo que Vigía explica con clic derecho → «Info» (vigia/info.ts).
export function BarraModulo({ titulo, descripcion, contador, extra, 'data-info': info }: { titulo: string; descripcion?: string; contador?: Contador | null; extra?: ReactNode; 'data-info'?: string }) {
  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1" data-info={info}>
        <div className="flex items-center gap-3">
          <h2 className="text-[22px] font-light tracking-tight">{titulo}</h2>
          {contador !== undefined ? <MarcasContador contador={contador} grande /> : null}
        </div>
        {descripcion ? <p className="text-[15px] text-muted-foreground">{descripcion}</p> : null}
      </div>
      {extra ? <div className="flex flex-wrap items-center gap-2">{extra}</div> : null}
    </div>
  );
}
