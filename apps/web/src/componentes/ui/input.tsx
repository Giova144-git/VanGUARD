import type * as React from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      data-slot="input"
      className={cn(
        'h-12 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-[15px] outline-none placeholder:text-texto-3 focus-visible:border-info focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60 aria-invalid:border-mal-borde',
        className,
      )}
      {...props}
    />
  );
}
