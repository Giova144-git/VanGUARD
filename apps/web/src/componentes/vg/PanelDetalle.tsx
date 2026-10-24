import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/componentes/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/componentes/ui/sheet';

// Panel de detalle (S14 §14.7): aside fijo de 420 px desde 1100 px; por debajo, Sheet a la derecha. Esc cierra.
export function PanelDetalle({ titulo, onCerrar, children }: { titulo: string; onCerrar: () => void; children: ReactNode }) {
  const [ancho, setAncho] = useState(() => window.matchMedia('(min-width: 1100px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1100px)');
    const cambio = () => setAncho(mq.matches);
    mq.addEventListener('change', cambio);
    return () => mq.removeEventListener('change', cambio);
  }, []);
  // Foco: al abrir va al panel y al cerrar vuelve a lo que lo abrió (no hay Dialog.Trigger: sin esto cae en <body>).
  const previo = useRef(document.activeElement as HTMLElement | null);
  const cabecera = useRef<HTMLHeadingElement>(null);
  useEffect(() => { const p = previo.current; return () => p?.focus(); }, []);
  useEffect(() => { if (ancho) cabecera.current?.focus(); }, [ancho]);
  useEffect(() => {
    if (!ancho) return;                                    // el Sheet ya maneja Esc
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar(); };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [ancho, onCerrar]);

  if (!ancho) return (
    <Sheet open onOpenChange={(v) => { if (!v) onCerrar(); }}>
      <SheetContent side="right" onCloseAutoFocus={(e) => { e.preventDefault(); previo.current?.focus(); }} className="w-full max-w-[420px] overflow-y-auto bg-background p-5">
        <SheetTitle className="pr-12 text-[17px] font-semibold">{titulo}</SheetTitle>
        <SheetDescription className="sr-only">Detalle del hallazgo</SheetDescription>
        <div className="mt-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
  return (
    <aside aria-label={titulo} className="fixed top-14 right-0 bottom-0 z-20 flex w-[420px] flex-col border-l bg-background">
      <header className="flex items-center gap-2 border-b px-5 py-3">
        <h2 ref={cabecera} tabIndex={-1} className="flex-1 truncate text-[17px] font-semibold outline-none">{titulo}</h2>
        <Button variant="fantasma" size="icono" onClick={onCerrar} aria-label="Cerrar detalle"><X className="size-5" /></Button>
      </header>
      <div className="flex-1 overflow-y-auto p-5">{children}</div>
    </aside>
  );
}
