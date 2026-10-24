import { CircleHelp } from 'lucide-react';
import { GUIAS } from '@/lib/guias';
import type { IdNav } from '@/lib/nav';
import { SectorPlegable } from './SectorPlegable';

// «¿Cómo leer este módulo?»: abierto la primera visita; el recuerdo queda en localStorage['vg-guia-<modulo>'] (S14 §14.12).
export function GuiaModulo({ id }: { id: IdNav }) {
  const g = GUIAS[id];
  return (
    <SectorPlegable titulo={g.titulo} icono={CircleHelp} defaultOpen recuerdo={`vg-guia-${id}`}>
      <ol className="flex flex-col gap-3">
        {g.pasos.map((p, i) => (
          <li key={i} className="flex gap-3 text-[15px] leading-relaxed">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-info-relleno text-sm font-semibold text-info tabular-nums">{i + 1}</span>
            <span className="pt-0.5 text-muted-foreground">{p}</span>
          </li>
        ))}
      </ol>
    </SectorPlegable>
  );
}
