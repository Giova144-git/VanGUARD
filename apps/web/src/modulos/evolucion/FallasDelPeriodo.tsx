// Debajo de las cifras de Evolución: «Nuevas» y «Corregidas» del periodo se despliegan en la lista de esas fallas (E13h),
// cada una con su línea de tiempo y su clic derecho de Vigía. Las cifras de arriba cuentan lo que vio cada auditoría
// (las fotos); estas listas, el estado de AHORA de cada falla: una corregida que reapareció ya no sale en «Corregidas».
// Con el filtro de módulo de Evolución, solo las de ese módulo. Si E13h da 404 o falla sin datos, no se pinta nada.
import { useState } from 'react';
import { Link } from 'react-router';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { FindingHistoryItem, Module } from '@vanguard/contracts';
import { useOrg } from '@/app/guardas';
import { useHistorialFallas } from '@/lib/consultas';
import type { FiltroModulo } from '@/lib/evolucion';
import { corregidaEnPeriodo, nuevaEnPeriodo, resueltaEn } from '@/lib/historial';
import { cn } from '@/lib/utils';
import { FilaFalla } from './FilaFalla';

const VISIBLES = 10;
type Cual = 'nuevas' | 'corregidas';
const ms = (t: string | null) => (t ? Date.parse(t) : 0);

function Lista({ org, fallas, dias, cual }: { org: string; fallas: FindingHistoryItem[]; dias: number; cual: Cual }) {
  const [abiertas, setAbiertas] = useState<ReadonlySet<string>>(() => new Set());
  const [todas, setTodas] = useState(false);
  const alternar = (id: string) => setAbiertas((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  if (!fallas.length) return <p className="py-2 text-[15px] text-muted-foreground">{cual === 'nuevas' ? 'Ninguna falla nueva en el periodo.' : 'Ninguna falla corregida en el periodo.'}</p>;
  const items = todas ? fallas : fallas.slice(0, VISIBLES);
  return (
    <div className="flex flex-col gap-1">
      <ul aria-label={cual === 'nuevas' ? 'Fallas nuevas del periodo' : 'Fallas corregidas del periodo'}>
        {items.map((f) => <FilaFalla key={f.id} org={org} f={f} verEn="pagina" abierta={abiertas.has(f.id)} onAlternar={() => alternar(f.id)} />)}
      </ul>
      {items.length < fallas.length ? (
        <button type="button" onClick={() => setTodas(true)} className="h-11 w-fit text-sm font-medium text-foreground underline underline-offset-4">
          Ver las {fallas.length}</button>
      ) : null}
      <Link to={`/o/${org}/evolution/history?dias=${dias}`} className="inline-flex h-11 w-fit items-center gap-1 text-sm font-medium text-foreground underline underline-offset-4">
        Abrir en el historial<ChevronRight className="size-4" /></Link>
    </div>
  );
}

export function FallasDelPeriodo({ dias, modulo }: { dias: number; modulo: FiltroModulo }) {
  const org = useOrg().id;
  const [abierta, setAbierta] = useState<Cual | null>(null);
  const q = useHistorialFallas(org, { days: dias, limit: 500, ...(modulo === 'todo' ? {} : { module: modulo as Module }) });
  if (!q.data) return null;
  const nuevas = q.data.filter((f) => nuevaEnPeriodo(f, dias))
    .sort((a, b) => Math.max(ms(b.first_seen_at), ms(b.reopened_at)) - Math.max(ms(a.first_seen_at), ms(a.reopened_at)));
  const corregidas = q.data.filter((f) => corregidaEnPeriodo(f, dias)).sort((a, b) => ms(resueltaEn(b)) - ms(resueltaEn(a)));
  const boton = (cual: Cual, texto: string, n: number) => (
    <button type="button" aria-expanded={abierta === cual} aria-controls="evo-fallas-lista" onClick={() => setAbierta(abierta === cual ? null : cual)}
      className={cn('inline-flex h-11 items-center gap-2 rounded-lg border px-4 text-sm font-medium', abierta === cual ? 'bg-muted text-foreground' : 'bg-card text-foreground hover:bg-muted')}>
      {texto} <span className="tabular-nums text-muted-foreground">({n})</span>
      <ChevronDown className={cn('size-4 transition-transform', abierta === cual && 'rotate-180')} /></button>
  );
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-5" aria-labelledby="t-fallas-periodo" data-info="evo-fallas-periodo">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="t-fallas-periodo" className="text-[17px] font-semibold">¿Cuáles? Fallas de los últimos {dias} días</h3>
        <Link to={`/o/${org}/evolution/history`} className="inline-flex h-11 items-center gap-1 text-sm font-medium text-foreground underline underline-offset-4">
          Historial de fallas<ChevronRight className="size-4" /></Link>
      </div>
      <div className="flex flex-wrap gap-2">
        {boton('nuevas', 'Ver las nuevas', nuevas.length)}
        {boton('corregidas', 'Ver las corregidas', corregidas.length)}
      </div>
      <div id="evo-fallas-lista" hidden={!abierta}>
        {abierta ? <>
          <Lista key={abierta} org={org} dias={dias} cual={abierta} fallas={abierta === 'nuevas' ? nuevas : corregidas} />
          <p className="text-[12.5px] text-texto-3">Con su estado de ahora: las cifras de arriba cuentan lo que vio cada auditoría.</p>
        </> : null}
      </div>
    </section>
  );
}
