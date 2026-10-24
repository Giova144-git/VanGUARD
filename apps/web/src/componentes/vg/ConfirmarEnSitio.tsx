import { useEffect, useRef, useState } from 'react';
import { Button } from '@/componentes/ui/button';
import { Spinner } from '@/componentes/ui/spinner';
import { mensajeDe } from '@/lib/errores';

// Confirmación en el sitio del botón, sin modal (L6): [Quitar] → [aviso] [Cancelar] [Quitar]. Esc cancela.
export function ConfirmarEnSitio({ verbo, aviso, onConfirmar, deshabilitado }: {
  verbo: string; aviso?: string; onConfirmar: () => Promise<void>; deshabilitado?: string;
}) {
  const [fase, setFase] = useState<'reposo' | 'pregunta' | 'ocupado'>('reposo');
  const [error, setError] = useState<string | null>(null);
  const boton = useRef<HTMLButtonElement>(null);
  const volvio = useRef(false);
  // Al volver a reposo, el foco vuelve al botón: el que tenía el foco se desmontó y caería en <body>.
  useEffect(() => {
    if (fase !== 'reposo') { volvio.current = true; return; }
    if (volvio.current) { volvio.current = false; boton.current?.focus(); }
  }, [fase]);
  useEffect(() => {
    if (fase !== 'pregunta') return;
    // En captura y sin propagar: Esc cancela solo la pregunta, no cierra el panel ni el Sheet que la contiene.
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setFase('reposo'); } };
    window.addEventListener('keydown', tecla, true);
    return () => window.removeEventListener('keydown', tecla, true);
  }, [fase]);

  if (fase === 'reposo') return (
    <span className="inline-flex flex-col gap-1">
      <Button ref={boton} variant="secundaria" disabled={!!deshabilitado} onClick={() => { setError(null); setFase('pregunta'); }}>{verbo}</Button>
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
          // Si el padre no lo desmonta al terminar bien, vuelve a reposo en vez de quedarse girando (L6).
          try { await onConfirmar(); setFase('reposo'); } catch (e) { setError(mensajeDe(e)); setFase('reposo'); }
        }}>
        {fase === 'ocupado' ? <Spinner /> : null}{verbo}
      </Button>
    </span>
  );
}
