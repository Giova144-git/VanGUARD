// Marca tipográfica «VanGUARD» (O-03) hasta que exista el logo. GUARD siempre en mayúsculas, de MARCA.nombre.
import { ShieldCheck } from 'lucide-react';
import { MARCA } from '@/lib/marca';

export function Marca({ compacta }: { compacta?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-info-relleno text-marca"><ShieldCheck className="size-5" /></span>
      {compacta ? null : <span className="text-[17px] font-semibold tracking-tight">{MARCA.nombre.slice(0, 3)}<span className="text-marca">{MARCA.nombre.slice(3)}</span></span>}
    </span>
  );
}
