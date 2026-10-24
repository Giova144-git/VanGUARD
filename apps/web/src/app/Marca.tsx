// Logo de VanGUARD (brand/README.md): por defecto, el logo con nombre (≥ 160 px de ancho); con `simbolo`, solo el ojo VG
// (≥ 64 px, el isotipo grande de /login); con `compacta`, el ojo en su versión compacta (< 64 px). Son los SVG que genera
// brand/build-mark.py, pintados como máscara sobre currentColor (clases .logo-vg de globals.css): toman el color del
// texto. El nombre nunca va como texto vivo.
// Encima se carga en diferido MarcaViva, con los mismos trazos en línea, la pupila que sigue al puntero y el parpadeo;
// cuando llega, .logo-vg-vivo apaga la máscara. Con prefers-reduced-motion (o sin navegador, en los tests) se queda la
// máscara sola.
import { lazy, Suspense, useCallback, useState, type ComponentType } from 'react';
import { MARCA } from '@/lib/marca';
import { cn } from '@/lib/utils';
import type { Forma } from './MarcaViva';

// Es decoración: si el chunk no llega (un despliegue nuevo), se queda la máscara, sin recargar ni pintar un error.
const MarcaViva = lazy<ComponentType<{ forma: Forma; onListo: () => void }>>(
  () => import('./MarcaViva').catch(() => ({ default: () => null })));

const CLASE: Record<Forma, string> = { nombre: 'logo-vg-nombre h-7', simbolo: 'logo-vg-simbolo h-24', compacta: 'logo-vg-compacto h-6' };
const animable = () => typeof window !== 'undefined' && !matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Marca({ compacta, simbolo, className }: { compacta?: boolean; simbolo?: boolean; className?: string }) {
  const forma: Forma = compacta ? 'compacta' : simbolo ? 'simbolo' : 'nombre';
  const [animar] = useState(animable);
  const [vivo, setVivo] = useState(false);
  const listo = useCallback(() => setVivo(true), []);
  return (
    <span role="img" aria-label={MARCA.nombre} className={cn('logo-vg', CLASE[forma], vivo && 'logo-vg-vivo', className)}>
      {animar ? <Suspense fallback={null}><MarcaViva forma={forma} onListo={listo} /></Suspense> : null}
    </span>
  );
}
