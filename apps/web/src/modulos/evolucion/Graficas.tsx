// Gráficas de la página Evolución (asignaciones/evolucion-entre-revisiones.md §6.4), con el patrón de GraficaComparativa:
// sin animación, sin la capa de accesibilidad de Recharts y un contenedor role="img" cuyo aria-label resume los datos.
// Ejes y avisos solo con fechas y números: nunca títulos ni recursos de hallazgos.
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { PuntoPuntaje } from '@/lib/evolucion';

export const EJE = { fill: 'var(--texto-3)', fontSize: 12 };
export const AVISO = { background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--foreground)' };
// El eje X va por id (dos auditorías del mismo minuto no se funden) y se pinta con su fecha.
export const porId = (serie: readonly { id: string; x: string }[]) => {
  const m = new Map(serie.map((p) => [p.id, p.x]));
  return (id: unknown) => m.get(String(id)) ?? '';
};

// Puntaje de cada auditoría (0–100), con las fronteras de banda: rojo hasta 49, ámbar hasta 79 y verde desde 80.
export function GraficaPuntaje({ serie }: { serie: PuntoPuntaje[] }) {
  const fecha = porId(serie);
  return (
    <div className="h-56 w-full" role="img" aria-label={`Puntaje por auditoría: ${serie.map((p) => `${p.x} ${p.score ?? '—'}`).join(', ')}`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={serie} margin={{ top: 8, right: 12, bottom: 0, left: -16 }} accessibilityLayer={false}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="id" tickFormatter={fecha} tick={EJE} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis domain={[0, 100]} ticks={[0, 50, 80, 100]} tick={EJE} tickLine={false} axisLine={false} width={44} />
          <Tooltip contentStyle={AVISO} cursor={{ stroke: 'var(--border)' }} labelFormatter={fecha}
            formatter={(v) => [v == null ? '—' : String(v), 'Puntaje']} />
          <ReferenceLine y={50} stroke="var(--aviso)" strokeDasharray="4 4" />
          <ReferenceLine y={80} stroke="var(--bien)" strokeDasharray="4 4" />
          <Line type="linear" dataKey="score" name="Puntaje" stroke="var(--info)" strokeWidth={2} dot={{ r: 3, fill: 'var(--info)' }}
            connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
