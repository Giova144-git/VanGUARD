import { cn } from '@/lib/utils';

// Grupo de botones de una sola elección (estrategia, métrica, URL) del histórico y de «Medir ahora». El texto de cada
// botón va en <bdi dir="ltr">: en el grupo «URL» es la URL del servidor (ya con sinBidi). Parte línea y recorta la URL
// larga: a 375 px no desborda la tarjeta.
export function Grupo<T extends string>({ valor, opciones, onCambio, etiqueta, desactivado }: {
  valor: T; opciones: [T, string][]; onCambio: (v: T) => void; etiqueta: string; desactivado?: boolean;
}) {
  return (
    <div className="inline-flex w-fit max-w-full flex-wrap rounded-lg bg-muted p-1" role="group" aria-label={etiqueta}>
      {opciones.map(([v, t]) => (
        <button key={v} type="button" aria-pressed={valor === v} onClick={() => onCambio(v)} disabled={desactivado}
          className={cn('h-11 max-w-full rounded-md px-3 text-sm font-medium disabled:opacity-60', valor === v ? 'bg-card text-foreground' : 'text-muted-foreground')}><span className="block truncate"><bdi dir="ltr">{t}</bdi></span></button>
      ))}
    </div>
  );
}
