import type * as React from 'react';
import { Dialog as SheetPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

// Panel lateral (riel en móvil y detalle a ancho estrecho). No es un modal de confirmación (L6).
export const Sheet = SheetPrimitive.Root;
export const SheetTitle = SheetPrimitive.Title;
export const SheetDescription = SheetPrimitive.Description;

export function SheetContent({ className, children, side = 'left', ...props }:
  React.ComponentProps<typeof SheetPrimitive.Content> & { side?: 'left' | 'right' }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed inset-y-0 z-50 flex w-[85vw] max-w-80 flex-col bg-sidebar outline-none data-[state=open]:animate-in',
          side === 'left' ? 'left-0 border-r data-[state=open]:slide-in-from-left' : 'right-0 border-l data-[state=open]:slide-in-from-right',
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="absolute top-3 right-3 inline-flex size-11 items-center justify-center rounded-lg hover:bg-muted" aria-label="Cerrar">
          <X className="size-5" />
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}
