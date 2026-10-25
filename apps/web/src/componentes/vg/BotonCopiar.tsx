import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/componentes/ui/button';

const TOPE = 150 * 1024;

// S14 §14.7: el texto ya está en memoria al pulsar (no se pierde el gesto del usuario). Si el portapapeles falla o el
// texto pasa de 150 KB, debajo y en el sitio aparece un textarea ya seleccionado con «Pulsa Ctrl+C».
// `tam="grande"` (h-14) para el botón principal de la vista (L8); por defecto, de fila (h-11). `className` va al botón
// (p. ej. para que un texto largo parta línea en 375 px).
export function BotonCopiar({ valor, texto = 'Copiar', variante = 'secundaria', tam = 'fila', className }: {
  valor: string; texto?: string; variante?: 'secundaria' | 'principal'; tam?: 'fila' | 'grande'; className?: string;
}) {
  const [hecho, setHecho] = useState(false);
  const [manual, setManual] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (manual) area.current?.select(); }, [manual]);
  useEffect(() => { if (!hecho) return; const t = setTimeout(() => setHecho(false), 2000); return () => clearTimeout(t); }, [hecho]);

  const copiar = async () => {
    if (valor.length > TOPE || !navigator.clipboard) { setManual(true); return; }
    try { await navigator.clipboard.writeText(valor); setHecho(true); } catch { setManual(true); }
  };
  return (
    <span className="inline-flex w-full flex-col gap-2 sm:w-auto">
      <Button variant={variante} size={tam} className={className} onClick={copiar} aria-live="polite">{hecho ? <><Check />Copiado</> : <><Copy />{texto}</>}</Button>
      {manual ? <>
        <textarea ref={area} readOnly value={valor} rows={4} className="w-full rounded-lg border bg-card p-2 font-mono text-[13px]" />
        <span className="text-[12.5px] text-texto-3">Pulsa Ctrl+C (Cmd+C en Mac)</span>
      </> : null}
    </span>
  );
}
