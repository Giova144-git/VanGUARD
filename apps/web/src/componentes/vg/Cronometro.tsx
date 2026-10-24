import { useEffect, useState } from 'react';
import { cronometro } from '@/lib/formato';
import { cn } from '@/lib/utils';

// Cronómetro del incidente (S14 §14.16): desde `desde` hasta `hasta`; avanza cada 1 s solo mientras sigue abierto.
export function Cronometro({ desde, hasta, className }: { desde: string; hasta: string | null; className?: string }) {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    if (hasta) return;
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasta]);
  const fin = hasta ? Date.parse(hasta) : ahora;
  return (
    <span className={cn('font-mono text-6xl font-semibold tabular-nums', className)} role="timer" aria-live="off">
      {cronometro(fin - Date.parse(desde))}
    </span>
  );
}
