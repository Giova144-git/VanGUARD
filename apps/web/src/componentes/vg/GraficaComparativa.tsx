// Barras por medición (S14 §14.13): la última en info, el resto neutras; líneas de «bueno» y «malo» por estrategia.
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { UMBRALES, type Estrategia, type Medicion, type Metrica } from '@/lib/perf';

const ETIQUETA: Record<Metrica, string> = { perf_score: 'Puntaje', lcp_ms: 'LCP (ms)', tbt_ms: 'TBT (ms)', cls: 'CLS' };

export function GraficaComparativa({ mediciones, metrica, estrategia }: { mediciones: Medicion[]; metrica: Metrica; estrategia: Estrategia }) {
  const datos = mediciones.map((m, i) => ({ x: m.version ?? `Medición ${i + 1}`, v: m[metrica] }));
  const u = metrica === 'perf_score' ? { bueno: 90, malo: 50 } : UMBRALES[metrica][estrategia];
  return (
    <div className="h-56 w-full" role="img" aria-label={`${ETIQUETA[metrica]} por medición: ${datos.map((d) => `${d.x} ${d.v ?? '—'}`).join(', ')}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={datos} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="x" tick={{ fill: 'var(--texto-3)', fontSize: 12 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fill: 'var(--texto-3)', fontSize: 12 }} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--foreground)' }}
            cursor={{ fill: 'var(--muted)' }} formatter={(v) => [String(v), ETIQUETA[metrica]]} />
          <ReferenceLine y={u.bueno} stroke="var(--bien)" strokeDasharray="4 4" label={{ value: 'bueno', fill: 'var(--texto-3)', fontSize: 11, position: 'insideTopRight' }} />
          <ReferenceLine y={u.malo} stroke="var(--aviso)" strokeDasharray="4 4" label={{ value: 'malo', fill: 'var(--texto-3)', fontSize: 11, position: 'insideTopRight' }} />
          <Bar dataKey="v" name={ETIQUETA[metrica]} isAnimationActive={false} radius={[4, 4, 0, 0]}>
            {datos.map((d, i) => <Cell key={d.x + i} fill={i === datos.length - 1 ? 'var(--info)' : 'var(--chart-1)'} fillOpacity={i === datos.length - 1 ? 0.8 : 0.45} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
