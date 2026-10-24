// Corrida de la wiki estancada: 3 min sin que cambien status, progress ni steps. Pasa si el proceso que la corre se
// reinicia a mitad (en local, el --watch) y la cola pierde el mensaje. El BACK la pasa a failed a los 10 min; mientras,
// el FRONT avisa en neutro, ofrece «Reintentar» y consulta cada 15 s en vez de cada 3.
import { useEffect, useState } from 'react';
import type { WikiRun } from '@vanguard/contracts';

export const ESTANCADA_MS = 3 * 60_000;

// Lo que cambia cuando la corrida avanza. null si ya terminó: entonces no hay nada que vigilar.
export const firmaRun = (r: WikiRun | undefined): string | null =>
  r && (r.status === 'queued' || r.status === 'running') ? `${r.status}|${r.progress}|${JSON.stringify(r.steps)}` : null;

export const estaEstancada = (firma: string | null, desde: number, ahora: number, ms = ESTANCADA_MS) =>
  firma !== null && ahora - desde >= ms;

export function useEstancada(run: WikiRun | undefined, ms = ESTANCADA_MS): boolean {
  const firma = firmaRun(run);
  const [desde, setDesde] = useState(() => Date.now());
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => { const t = Date.now(); setDesde(t); setAhora(t); }, [firma]);   // cada avance reinicia la cuenta
  useEffect(() => {
    if (firma === null) return;
    const t = setInterval(() => setAhora(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [firma]);
  return estaEstancada(firma, desde, ahora, ms);
}
