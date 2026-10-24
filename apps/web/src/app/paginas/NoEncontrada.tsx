import { Link } from 'react-router';
import { MapPinOff } from 'lucide-react';
import { Button } from '@/componentes/ui/button';
import { Vacio } from '@/componentes/vg/Vacio';

export default function NoEncontrada({ texto = 'Esta página no existe' }: { texto?: string }) {
  return (
    <div className="mx-auto flex min-h-[60svh] max-w-lg items-center px-4">
      <div className="w-full">
        <Vacio icono={MapPinOff} titulo={texto} texto="Revisa el enlace o vuelve al inicio."
          accion={<Button asChild variant="principal" size="grande"><Link to="/">Volver al inicio</Link></Button>} />
      </div>
    </div>
  );
}
