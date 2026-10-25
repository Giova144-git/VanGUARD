// Distintivo de «Enviar a mi IA»: la carita de Vigía en miniatura (cabeza oscura, melena blanca en cuchillas y las
// gafas en G alargadas con pupila V cian) con un martillo pequeño. A 16–20 px basta la silueta y las gafas.
//   enviado    → martillo quieto, en alto.
//   arreglando → el martillo golpea en bucle (SMIL, sin CSS ni JS por fotograma); con prefers-reduced-motion, quieto.
//   corregido  → un check cian en una chapa oscura en vez del martillo.
// Decorativo (aria-hidden): quien lo usa pone siempre la etiqueta de texto al lado. Paleta fija de Vigía (vigia.css),
// escrita aquí porque sus variables solo existen dentro de .vigia; los trazos oscuros lo separan de un fondo claro.
import { useEffect, useState } from 'react';
import type { FixRequestStatus } from '@vanguard/contracts';

const CARA = '#0a0d16';
const PELO = '#f3f5fc';
const CIAN = '#2df5d2';
const MADERA = '#8a91a8';                     // gris de Vigía: mango y canto de la cabeza (se ve en claro y en oscuro)

function useMovimientoReducido(): boolean {
  const [reducido, setReducido] = useState(() =>
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const cambio = () => setReducido(mq.matches);
    mq.addEventListener('change', cambio);
    return () => mq.removeEventListener('change', cambio);
  }, []);
  return reducido;
}

// Un lente en G alargada (almendra afilada hacia la sien) con su pupila V, en coordenadas de 24×24.
function Lente({ x, espejo }: { x: number; espejo?: boolean }) {
  return (
    <g transform={`translate(${x} 13.4)${espejo ? ' scale(-1 1)' : ''}`}>
      <path d="M-2.6 0 C-2.6 -1.6 -0.4 -2 2.4 -0.6 C1.4 1.4 -2.6 1.8 -2.6 0 Z" fill="#0b1322" stroke={PELO} strokeWidth={0.9} strokeLinejoin="round" />
      <path d="M-1.3 -0.6 L-0.4 0.8 L0.6 -0.6" fill="none" stroke={CIAN} strokeWidth={0.9} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

export function IconoArreglando({ estado, tam = 18, className }: { estado: Exclude<FixRequestStatus, 'cancelado'>; tam?: number; className?: string }) {
  const reducido = useMovimientoReducido();
  const golpea = estado === 'arreglando' && !reducido;
  return (
    <svg viewBox="0 0 24 24" width={tam} height={tam} aria-hidden="true" focusable="false" className={className} data-estado={estado}>
      {/* melena en cuchillas, detrás de la cabeza */}
      <path d="M2.6 13 L3.4 5.2 L6 8.6 L7.6 2.6 L10.2 7.4 L12.6 2.2 L13.8 7.6 L17 4.4 L16.6 10 Z" fill={PELO} stroke={CARA} strokeWidth={0.8} strokeLinejoin="round" />
      {/* cabeza */}
      <path d="M3.2 13.2 C3.2 8.6 6.2 7.4 9.8 7.4 C13.4 7.4 16.4 8.6 16.4 13.2 C16.4 18 13.4 20.6 9.8 20.6 C6.2 20.6 3.2 18 3.2 13.2 Z" fill={CARA} stroke={MADERA} strokeWidth={0.7} />
      {/* flequillo: dos cuchillas sobre la frente */}
      <path d="M5 10.4 L7.4 7.2 L8 9.6 Z M10.6 9.4 L12.6 7 L12.8 9.8 Z" fill={PELO} />
      <Lente x={7.3} />
      <Lente x={12.3} espejo />
      {estado === 'corregido' ? (
        <g data-parte="check">
          <circle cx={18.6} cy={18.4} r={4.6} fill={CARA} stroke={PELO} strokeWidth={0.8} />
          <path d="M16.4 18.5 L18 20.1 L21 16.9" fill="none" stroke={CIAN} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ) : (
        // Martillo con el pivote en el extremo del mango (abajo a la derecha): quieto, en alto; golpeando, baja hasta la cabeza.
        <g data-parte="martillo" transform="rotate(14 21.6 22)">
          {golpea ? (
            <animateTransform attributeName="transform" type="rotate" dur="0.7s" repeatCount="indefinite"
              values="14 21.6 22; -16 21.6 22; 14 21.6 22" keyTimes="0; 0.35; 1" calcMode="spline" keySplines="0.5 0 0.9 0.6; 0.2 0.4 0.4 1" />
          ) : null}
          <path d="M21.6 22 L17.6 13.4" stroke={CARA} strokeWidth={2.4} strokeLinecap="round" />
          <path d="M21.6 22 L17.6 13.4" stroke={MADERA} strokeWidth={1.2} strokeLinecap="round" />
          <rect x={14.2} y={10.6} width={7.2} height={3.6} rx={0.8} transform="rotate(-25 17.8 12.4)" fill={PELO} stroke={CARA} strokeWidth={0.9} />
        </g>
      )}
    </svg>
  );
}
