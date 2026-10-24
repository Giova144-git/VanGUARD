import { useEffect, useState } from 'react';
import { Button } from '@/componentes/ui/button';
import { Spinner } from '@/componentes/ui/spinner';
import { mensajeDe } from '@/lib/errores';

// Confirmación en el sitio del botón, sin modal (L6): [Quitar] → [aviso] [Cancelar] [Quitar]. Esc cancela.
export function ConfirmarEnSitio({ verbo, aviso, onConfirmar, deshabilitado }: {
  verbo: string; aviso?: string; onConfirmar: () => Promise<void>; deshabilitado?: string;
}) {
  const [fase, setFase] = useState<'reposo' | 'pregunta' | 'ocupado'>('reposo');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (fase !== 'pregunta') return;
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') setFase('reposo'); };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [fase]);

  if (fase === 'reposo') return (
    <span className="inline-flex flex-col gap-1">
      <Button variant="secundaria" disabled={!!deshabilitado} onClick={() => { setError(null); setFase('pregunta'); }}>{verbo}</Button>
      {deshabilitado ? <span className="text-[12.5px] text-texto-3">{deshabilitado}</span> : null}
      {error ? <span role="alert" className="text-sm text-mal">{error}</span> : null}
    </span>
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {aviso ? <span className="text-sm text-muted-foreground">{aviso}</span> : null}
      <Button variant="secundaria" disabled={fase === 'ocupado'} onClick={() => setFase('reposo')}>Cancelar</Button>
      <Button variant="peligro" aria-busy={fase === 'ocupado' || undefined} autoFocus
        onClick={async () => {
          if (fase === 'ocupado') return;
          setFase('ocupado');
          try { await onConfirmar(); } catch (e) { setError(mensajeDe(e)); setFase('reposo'); }
        }}>
        {fase === 'ocupado' ? <Spinner /> : null}{verbo}
      </Button>
    </span>
  );
}
