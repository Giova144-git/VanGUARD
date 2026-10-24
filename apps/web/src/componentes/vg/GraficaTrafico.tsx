// Tráfico de los últimos 5 min en cubetas de 10 s (S14 §14.16): áreas apiladas OK / 4xx / 5xx, sin animación.
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Traffic } from '@vanguard/contracts';
import { miles } from '@/lib/formato';

const hhmmss = new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function GraficaTrafico({ buckets }: { buckets: Traffic['buckets'] }) {
  const datos = buckets.map((b) => ({ t: hhmmss.format(new Date(b.t)), ok: Math.max(0, b.n - b.n4xx - b.n5xx), n4xx: b.n4xx, n5xx: b.n5xx }));
  const total = buckets.reduce((s, b) => s + b.n, 0);
  return (
    <figure className="flex flex-col gap-2">
      <div className="h-52 w-full" role="img" aria-label={`Tráfico de los últimos 5 minutos: ${miles(total)} peticiones`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={datos} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="t" tick={{ fill: 'var(--texto-3)', fontSize: 12 }} tickLine={false} axisLine={false} minTickGap={40} />
            <YAxis tick={{ fill: 'var(--texto-3)', fontSize: 12 }} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--foreground)' }}
              labelStyle={{ color: 'var(--muted-foreground)' }} />
            <Area type="monotone" dataKey="ok" name="OK" stackId="1" stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.25} isAnimationActive={false} />
            <Area type="monotone" dataKey="n4xx" name="4xx" stackId="1" stroke="var(--chart-2)" fill="var(--chart-2)" fillOpacity={0.25} isAnimationActive={false} />
            <Area type="monotone" dataKey="n5xx" name="5xx" stackId="1" stroke="var(--chart-3)" fill="var(--chart-3)" fillOpacity={0.25} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="flex flex-wrap gap-4 text-[12.5px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-chart-1" />OK</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-chart-2" />4xx</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-chart-3" />5xx</span>
        <span className="ml-auto tabular-nums">{miles(total)} peticiones en 5 min</span>
      </figcaption>
    </figure>
  );
}

// Top de IPs (IP en mono, peticiones, UA recortado a 60). La IP del incidente va resaltada en tinte info.
export function TablaTopIps({ ips, resaltar, accion }: { ips: Traffic['top_ips']; resaltar?: string | null; accion?: (ip: string) => React.ReactNode }) {
  if (ips.length === 0) return <p className="text-sm text-muted-foreground">Sin tráfico en los últimos 5 minutos.</p>;
  return (
    <ul className="overflow-hidden rounded-xl border bg-card" aria-label="IPs con más peticiones">
      {ips.map((x) => (
        <li key={x.ip} className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2.5 last:border-b-0 ${x.ip === resaltar ? 'bg-info-relleno' : ''}`}>
          <span className="font-mono text-[13px] font-medium">{x.ip}</span>
          <span className="text-sm tabular-nums">{miles(x.n)}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-texto-3" title={x.ua_top ?? undefined}>{x.ua_top ? x.ua_top.slice(0, 60) : '—'}</span>
          {accion?.(x.ip)}
        </li>
      ))}
    </ul>
  );
}
