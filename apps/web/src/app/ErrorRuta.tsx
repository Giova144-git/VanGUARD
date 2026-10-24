import { isRouteErrorResponse, useRouteError } from 'react-router';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/componentes/ui/button';
import { esApiError } from '@/lib/errores';
import NoEncontrada from './paginas/NoEncontrada';

// errorElement de cada ruta (S14 §14.4): «Algo falló al pintar esta página · Recargar» + request_id si lo hay.
export default function ErrorRuta() {
  const e = useRouteError();
  if (isRouteErrorResponse(e) && e.status === 404) return <NoEncontrada />;
  const rid = esApiError(e) ? e.requestId : undefined;
  return (
    <div className="mx-auto flex min-h-[60svh] max-w-lg flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-mal-relleno text-mal"><TriangleAlert className="size-6" /></span>
      <h1 className="text-[22px] font-semibold">Algo falló al pintar esta página</h1>
      {rid ? <p className="font-mono text-[13px] text-texto-3">{rid}</p> : null}
      <Button variant="principal" size="grande" onClick={() => location.reload()}><RotateCw />Recargar</Button>
    </div>
  );
}
