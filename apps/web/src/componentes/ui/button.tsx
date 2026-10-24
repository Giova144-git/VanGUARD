import type * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Variantes de S14 §14.7: un solo sólido de marca por vista (L5); rojo siempre en tinte (L3). Sin sombras ni onda.
// Identidad (brand/README.md): píldora con borde de 1 px y texto en Geist Mono en mayúsculas; el sólido de marca es
// hueso sobre tinta (en claro, al revés) y el principal va en monocromo: el color queda para los estados.
export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full border font-mono text-[13px] font-medium uppercase tracking-[0.06em] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  {
    variants: {
      variant: {
        marca: 'border-transparent bg-marca text-marca-texto hover:opacity-90',
        principal: 'bg-transparent text-foreground border-foreground hover:bg-muted',
        secundaria: 'bg-card text-foreground border-border hover:bg-muted',
        peligro: 'bg-mal-relleno text-mal border-mal-borde hover:bg-mal/15',
        fantasma: 'border-transparent bg-transparent text-foreground hover:bg-muted',
      },
      size: {
        grande: 'h-14 px-5',
        fila: 'h-11 px-4',
        chico: 'h-9 px-3',
        icono: 'size-11',
      },
    },
    defaultVariants: { variant: 'secundaria', size: 'fila' },
  },
);

export function Button({ className, variant, size, asChild = false, ...props }:
  React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
