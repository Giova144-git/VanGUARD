import type * as React from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return <LoaderCircle role="status" aria-label="Cargando" className={cn('size-3.5 animate-spin', className)} {...props} />;
}
