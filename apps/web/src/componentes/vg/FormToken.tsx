import type { ReactNode } from 'react';
import { Input } from '@/componentes/ui/input';
import { Label } from '@/componentes/ui/label';
import type { Rechazo } from '@/lib/pre-guardas';

// Campo de un token (S14 §14.10, L10): password, sin autocompletar ni corrector, nunca prellenado. El rechazo va en rojo debajo.
export function CampoToken({ id, etiqueta, valor, onCambio, error, ayuda, placeholder }: {
  id: string; etiqueta: string; valor: string; onCambio: (v: string) => void;
  error?: Rechazo | string | null; ayuda?: ReactNode; placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{etiqueta}</Label>
      <Input id={id} type="password" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder={placeholder}
        value={valor} onChange={(e) => onCambio(e.target.value)} aria-invalid={!!error || undefined} aria-describedby={`${id}-msg`} />
      <ErrorCampo id={`${id}-msg`} error={error} ayuda={ayuda} />
    </div>
  );
}

export function CampoTexto({ id, etiqueta, valor, onCambio, error, ayuda, placeholder, mono }: {
  id: string; etiqueta: string; valor: string; onCambio: (v: string) => void;
  error?: Rechazo | string | null; ayuda?: ReactNode; placeholder?: string; mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{etiqueta}</Label>
      <Input id={id} autoComplete="off" spellCheck={false} placeholder={placeholder} className={mono ? 'font-mono text-[14px]' : undefined}
        value={valor} onChange={(e) => onCambio(e.target.value)} aria-invalid={!!error || undefined} aria-describedby={`${id}-msg`} />
      <ErrorCampo id={`${id}-msg`} error={error} ayuda={ayuda} />
    </div>
  );
}

function ErrorCampo({ id, error, ayuda }: { id: string; error?: Rechazo | string | null; ayuda?: ReactNode }) {
  if (error) {
    const r = typeof error === 'string' ? { titulo: error, explicacion: '' } : error;
    return (
      <div id={id} role="alert" className="rounded-lg border border-mal-borde bg-mal-relleno px-3 py-2 text-mal">
        <p className="text-sm font-semibold">{r.titulo}</p>
        {r.explicacion ? <p className="text-sm">{r.explicacion}</p> : null}
      </div>
    );
  }
  return ayuda ? <span id={id} className="text-[12.5px] text-texto-3">{ayuda}</span> : <span id={id} hidden />;
}
