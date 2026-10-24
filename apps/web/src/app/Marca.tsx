// Logo de VanGUARD (brand/README.md): sin `compacta`, el logo con nombre (≥ 160 px de ancho); con `compacta`, solo el
// ojo VG en su versión compacta (< 64 px). Son los SVG que genera brand/build-mark.py, pintados como máscara sobre
// currentColor (clases .logo-vg de globals.css): toman el color del texto. El nombre nunca va como texto vivo.
import { MARCA } from '@/lib/marca';
import { cn } from '@/lib/utils';

export function Marca({ compacta, className }: { compacta?: boolean; className?: string }) {
  return <span role="img" aria-label={MARCA.nombre} className={cn('logo-vg', compacta ? 'logo-vg-compacto h-6' : 'logo-vg-nombre h-7', className)} />;
}
