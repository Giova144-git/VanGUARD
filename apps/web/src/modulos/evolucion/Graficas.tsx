// Gráficas de la página Evolución (asignaciones/evolucion-entre-revisiones.md §6.4), con el patrón de GraficaComparativa:
// sin animación, sin la capa de accesibilidad de Recharts y un contenedor role="img" cuyo aria-label resume los datos.
// Ejes y avisos solo con fechas y números: nunca títulos ni recursos de hallazgos.
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { PuntoPuntaje, serieAbiertos, serieCambios, serieIncidentes } from '@/lib/evolucion';

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

// Leyenda en texto: el color nunca es la única señal.
export function Leyenda({ items }: { items: [string, string][] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground" aria-hidden="true">
      {items.map(([t, c]) => <li key={t} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: c }} />{t}</li>)}
    </ul>
  );
}
const abs = (v: unknown) => String(Math.abs(Number(v) || 0));

// Nuevos hacia arriba y corregidos hacia abajo de cero (llegan en negativo); el aviso y el eje dicen el valor absoluto.
export function GraficaCambios({ serie }: { serie: ReturnType<typeof serieCambios> }) {
  const fecha = porId(serie);
  return (
    <div className="h-56 w-full" role="img"
      aria-label={`Nuevos y corregidos por auditoría: ${serie.map((p) => `${p.x} ${p.nuevos} nuevos y ${-p.corregidos} corregidos`).join(', ')}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={serie} stackOffset="sign" margin={{ top: 8, right: 12, bottom: 0, left: -16 }} accessibilityLayer={false}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="id" tickFormatter={fecha} tick={EJE} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tickFormatter={abs} allowDecimals={false} tick={EJE} tickLine={false} axisLine={false} width={44} />
          <Tooltip contentStyle={AVISO} cursor={{ fill: 'var(--muted)' }} labelFormatter={fecha} formatter={(v, nombre) => [abs(v), String(nombre)]} />
          <ReferenceLine y={0} stroke="var(--borde-fuerte)" />
          <Bar dataKey="nuevos" name="Nuevos" stackId="c" fill="var(--mal)" fillOpacity={0.7} isAnimationActive={false} />
          <Bar dataKey="corregidos" name="Corregidos" stackId="c" fill="var(--bien)" fillOpacity={0.7} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Severidades apiladas (abiertos al cerrar cada versión y, P1, incidentes por día). Baja e info van juntas.
export const PILA: [key: 'critical' | 'high' | 'medium' | 'low', nombre: string, color: string][] = [
  ['critical', 'Crítica', 'var(--mal)'], ['high', 'Alta', 'var(--aviso)'], ['medium', 'Media', 'var(--info)'], ['low', 'Baja e info', 'var(--chart-1)'],
];
export const LEYENDA_PILA = PILA.map(([, n, c]): [string, string] => [n, c]);
// `k` es la clave del eje (id de la versión o día) y `x` su texto.
type FilaPila = { k: string; x: string; critical: number; high: number; medium: number; low: number };
const resumenPila = (p: FilaPila) => PILA.map(([k, n]) => `${p[k]} ${n.toLowerCase()}`).join(', ');

const total = (p: FilaPila) => PILA.reduce((a, [k]) => a + p[k], 0);
// `soloConDatos`: el aviso de lectores de pantalla nombra solo las barras con algo (90 días serían 90 frases).
function Pila({ datos, titulo, soloConDatos }: { datos: FilaPila[]; titulo: string; soloConDatos?: boolean }) {
  const fecha = porId(datos.map((p) => ({ id: p.k, x: p.x })));
  const nombradas = soloConDatos ? datos.filter((p) => total(p) > 0) : datos;
  const resumen = nombradas.length ? nombradas.map((p) => `${p.x} ${resumenPila(p)}`).join('; ') : 'ninguno';
  return (
    <div className="h-56 w-full" role="img" aria-label={`${titulo}: ${resumen}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={datos} margin={{ top: 8, right: 12, bottom: 0, left: -16 }} accessibilityLayer={false}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="k" tickFormatter={fecha} tick={EJE} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis allowDecimals={false} tick={EJE} tickLine={false} axisLine={false} width={44} />
          <Tooltip contentStyle={AVISO} cursor={{ fill: 'var(--muted)' }} labelFormatter={fecha} />
          {PILA.map(([k, n, c]) => <Bar key={k} dataKey={k} name={n} stackId="s" fill={c} fillOpacity={0.75} isAnimationActive={false} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function GraficaAbiertos({ serie }: { serie: ReturnType<typeof serieAbiertos> }) {
  return <Pila datos={serie.map((p) => ({ ...p, k: p.id }))} titulo="Abiertos por severidad" />;
}

// Incidentes (ataques) por día de Caracas en que empezaron; un día por barra, los días sin incidentes en 0.
export function GraficaIncidentes({ serie }: { serie: ReturnType<typeof serieIncidentes> }) {
  return <Pila datos={serie.map((d) => ({ ...d, k: d.dia }))} titulo="Incidentes por día" soloConDatos />;
}
