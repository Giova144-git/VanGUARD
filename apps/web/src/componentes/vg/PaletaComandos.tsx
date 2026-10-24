// Paleta de navegación (Ctrl+K, S14 §14.5 P1): un combobox con la lista de módulos. Flechas para moverse, Enter para ir,
// Esc para cerrar (lo maneja el Dialog). No es una confirmación (L6): navega o, al final, cambia el modo presentación
// (F-15: la demo del jurado va en ventana privada, donde el modo arranca apagado, y así se enciende sin ir a Ajustes).
import { useMemo, useState } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { CornerDownLeft, Presentation, Search, type LucideIcon } from 'lucide-react';
import { SECUENCIA_G } from '@/lib/atajos';
import { NAV, type IdNav } from '@/lib/nav';
import { aplicarPresentacion } from '@/lib/tema';
import { cn } from '@/lib/utils';

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const LETRA: Partial<Record<IdNav, string>> = Object.fromEntries(Object.entries(SECUENCIA_G).map(([k, v]) => [v, k]));

type Opcion = { clave: string; nombre: string; descripcion: string; icono: LucideIcon; letra?: string; hacer: () => void };

export function PaletaComandos({ abierta, onCambio, alIr }: { abierta: boolean; onCambio: (v: boolean) => void; alIr: (id: IdNav) => void }) {
  const [q, setQ] = useState('');
  const [activo, setActivo] = useState(0);
  const presentando = abierta && document.documentElement.classList.contains('presentacion');
  const opciones = useMemo<Opcion[]>(() => [
    ...NAV.map((n) => ({ clave: n.id, nombre: n.nombre, descripcion: n.descripcion, icono: n.icono, letra: LETRA[n.id], hacer: () => alIr(n.id) })),
    { clave: 'presentacion', nombre: presentando ? 'Salir del modo presentación' : 'Modo presentación',
      descripcion: 'Letra más grande para el proyector; se recuerda en este navegador', icono: Presentation,
      hacer: () => aplicarPresentacion(!presentando) },
  ], [alIr, presentando]);
  const lista = useMemo(() => {
    const f = sinTildes(q.trim());
    return opciones.filter((n) => !f || sinTildes(`${n.nombre} ${n.descripcion}`).includes(f));
  }, [q, opciones]);
  const actual = Math.min(activo, Math.max(0, lista.length - 1));
  const elegir = (o: Opcion) => { onCambio(false); setQ(''); setActivo(0); o.hacer(); };

  return (
    <DialogPrimitive.Root open={abierta} onOpenChange={(v) => { onCambio(v); if (!v) { setQ(''); setActivo(0); } }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <DialogPrimitive.Content className="fixed top-[12vh] left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground outline-none"
          aria-describedby={undefined}>
          <DialogPrimitive.Title className="sr-only">Ir a una pantalla</DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b px-4">
            <Search className="size-5 text-texto-3" />
            <input autoFocus value={q} placeholder="Ir a… (escribe un módulo)" aria-label="Ir a una pantalla"
              role="combobox" aria-expanded="true" aria-controls="paleta-lista" aria-autocomplete="list"
              aria-activedescendant={lista[actual] ? `paleta-${lista[actual].clave}` : undefined}
              className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-texto-3"
              onChange={(e) => { setQ(e.target.value); setActivo(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActivo((actual + 1) % Math.max(1, lista.length)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActivo((actual - 1 + lista.length) % Math.max(1, lista.length)); }
                else if (e.key === 'Enter' && lista[actual]) { e.preventDefault(); elegir(lista[actual]); }
              }} />
          </div>
          <ul id="paleta-lista" role="listbox" aria-label="Pantallas" className="max-h-[50vh] overflow-y-auto p-1">
            {lista.length === 0 ? <li className="px-3 py-4 text-sm text-muted-foreground" role="presentation">Nada coincide con «{q}».</li> : null}
            {lista.map((n, i) => {
              const Icono = n.icono;
              return (
                <li key={n.clave} id={`paleta-${n.clave}`} role="option" aria-selected={i === actual}
                  onMouseEnter={() => setActivo(i)} onClick={() => elegir(n)}
                  className={cn('flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-3 py-2', i === actual && 'bg-sidebar-accent text-sidebar-accent-foreground')}>
                  <Icono className="size-5 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[15px] font-medium">{n.nombre}</span>
                    <span className="truncate text-[12.5px] text-muted-foreground">{n.descripcion}</span>
                  </span>
                  {n.letra ? <kbd className="rounded border px-1.5 font-mono text-[12.5px] text-muted-foreground">g {n.letra}</kbd> : null}
                  {i === actual ? <CornerDownLeft className="size-4 text-texto-3" aria-hidden /> : null}
                </li>
              );
            })}
          </ul>
          <p className="border-t px-4 py-2 text-[12.5px] text-texto-3">↑ ↓ para moverte · Enter para ir · Esc para cerrar · Ctrl+B oculta el menú</p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
