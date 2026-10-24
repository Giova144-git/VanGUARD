// Mapa de la wiki como SVG propio (sin la librería mermaid ni innerHTML): cajas por columna y flechas con su texto.
// Si el Mermaid no parsea con la lista blanca, se muestra como bloque de código.
import { useMemo } from 'react';
import { parsearMermaid, partir } from '@/lib/mermaid';

const W = 168, H = 52, GX = 72, GY = 28, M = 16;

export function DiagramaWiki({ fuente }: { fuente: string }) {
  const g = useMemo(() => parsearMermaid(fuente), [fuente]);
  if (!g) return <pre className="overflow-auto rounded-lg border bg-background p-3 font-mono text-[13px] whitespace-pre-wrap">{fuente}</pre>;
  const alto = Math.max(...Array.from({ length: g.columnas }, (_, c) => g.nodos.filter((n) => n.col === c).length));
  const ancho = M * 2 + g.columnas * W + (g.columnas - 1) * GX;
  const altura = M * 2 + alto * H + (alto - 1) * GY;
  // Centra verticalmente cada columna.
  const pos = new Map(g.nodos.map((n) => {
    const enCol = g.nodos.filter((x) => x.col === n.col).length;
    const y0 = M + ((alto - enCol) * (H + GY)) / 2;
    return [n.id, { x: M + n.col * (W + GX), y: y0 + n.fila * (H + GY) }];
  }));
  const descripcion = g.aristas.map((a) => `${g.nodos.find((n) => n.id === a.de)!.etiqueta} → ${g.nodos.find((n) => n.id === a.a)!.etiqueta}${a.texto ? ` (${a.texto})` : ''}`).join('; ');

  return (
    <div className="overflow-x-auto rounded-xl border bg-background p-2">
      <svg viewBox={`0 0 ${ancho} ${altura}`} width={ancho} height={altura} role="img" aria-label={`Mapa del repositorio: ${descripcion}`} className="max-w-none">
        <defs>
          <marker id="vg-flecha" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--muted-foreground)" />
          </marker>
        </defs>
        {g.aristas.map((a, i) => {
          const p = pos.get(a.de)!, q = pos.get(a.a)!;
          const atras = q.x <= p.x;                            // ciclo o misma columna: la flecha sale por abajo
          const x1 = atras ? p.x + W / 2 : p.x + W, y1 = atras ? p.y + H : p.y + H / 2;
          const x2 = atras ? q.x + W / 2 : q.x, y2 = atras ? q.y + H : q.y + H / 2;
          const cx = (x1 + x2) / 2;
          const d = atras ? `M${x1},${y1} C${x1},${y1 + 40} ${x2},${y2 + 40} ${x2},${y2}` : `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`;
          return (
            <g key={i}>
              <path d={d} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.5} markerEnd="url(#vg-flecha)" />
              {a.texto ? <text x={cx} y={(y1 + y2) / 2 - 6} textAnchor="middle" fontSize={11} fill="var(--texto-3)">{a.texto}</text> : null}
            </g>
          );
        })}
        {g.nodos.map((n) => {
          const p = pos.get(n.id)!;
          const lineas = partir(n.etiqueta);
          return (
            <g key={n.id}>
              <rect x={p.x} y={p.y} width={W} height={H} rx={10} fill="var(--card)" stroke="var(--info)" strokeWidth={1.5} />
              {lineas.map((l, i) => (
                <text key={i} x={p.x + W / 2} y={p.y + H / 2 + (i - (lineas.length - 1) / 2) * 16 + 5} textAnchor="middle" fontSize={13}
                  fontWeight={600} fill="var(--foreground)">{l}</text>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
