import { Check, X } from 'lucide-react';
import type { PermCheck } from '@vanguard/contracts';
import { FRASE_ERROR, nombrePermiso } from '@/lib/permisos';
import { deMapa } from '@/lib/severidad';

// Resultado de «Probar conexión» (S14 §14.10): ✓/✗ por permiso; en cada ✗, qué marcar al recrear el token.
// Un ✗ opcional va en ámbar con «opcional»: la conexión funciona sin él.
export function ListaChecks({ checks }: { checks: PermCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Permisos comprobados">
      {checks.map((c) => (
        <li key={c.permission} className="flex items-start gap-2 text-sm">
          {c.ok
            ? <Check className="mt-0.5 size-4 shrink-0 text-bien" aria-label="Bien" />
            : <X className={`mt-0.5 size-4 shrink-0 ${c.required === false ? 'text-aviso' : 'text-mal'}`} aria-label="Falta" />}
          <span className="flex flex-col">
            <span><span className="font-medium">{nombrePermiso(c.permission)}</span>{!c.ok && c.required === false ? <span className="text-aviso"> · opcional</span> : null}</span>
            {c.ok ? null : <span className="text-muted-foreground">
              {deMapa(FRASE_ERROR, c.error_code, '') ? `${deMapa(FRASE_ERROR, c.error_code, '')} ` : ''}Vuelve a crear el token marcando «{nombrePermiso(c.permission)}».
            </span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
