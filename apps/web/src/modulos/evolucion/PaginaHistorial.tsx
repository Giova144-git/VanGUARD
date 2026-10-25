// /o/:orgId/evolution/history · historial de fallas (E13h/E13t, 0025_historial_hallazgos.sql). Vive dentro de Evolución
// (el riel marca Evolución por el segmento de la ruta): Evolución cuenta cuántas aparecieron y se corrigieron entre
// auditorías; aquí se ve cuáles, una a una, con su estado y sus fechas. Los filtros van en la URL (?estado=, ?modulo=,
// ?gravedad=, ?dias=, ?orden=) para compartir el enlace; ?falla=<uuid> («Ver historial» del clic derecho) abre su línea
// de tiempo arriba, esté o no en la lista filtrada. Si E13h da 404 (aún sin desplegar): «El historial llega pronto».
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, History } from 'lucide-react';
import type { Module, Severity } from '@vanguard/contracts';
import { BarraModulo } from '@/componentes/vg/BarraModulo';
import { ErrorBloque, Vacio } from '@/componentes/vg/Vacio';
import { useOrg } from '@/app/guardas';
import { DetalleEnPanel } from '@/modulos/hallazgos/DetalleEnPanel';
import { useHistorialFallas, useLineaTiempoFalla, type FiltroHistorial } from '@/lib/consultas';
import { esApiError } from '@/lib/errores';
import { ESTADOS_FILTRO, MODULOS_FILTRO, SEVERIDADES_FILTRO, esFiltro, type FiltroEstado } from '@/lib/historial';
import { esId } from '@/lib/ids';
import { cn } from '@/lib/utils';
import { FilaFalla } from './FilaFalla';

const PERIODOS: [string, string][] = [['', 'Siempre'], ['7', '7 días'], ['30', '30 días'], ['90', '90 días']];
const ORDENES: [string, string][] = [['desc', 'Más recientes primero'], ['asc', 'Más antiguas primero']];
const LIMITE = 200;

function Grupo<T extends string>({ valor, opciones, onCambio, etiqueta, 'data-info': info }: { valor: T; opciones: [T, string][]; onCambio: (v: T) => void; etiqueta: string; 'data-info'?: string }) {
  return (
    <div className="inline-flex w-fit max-w-full flex-wrap rounded-lg bg-muted p-1" data-info={info} role="group" aria-label={etiqueta}>
      {opciones.map(([v, t]) => (
        <button key={v} type="button" aria-pressed={valor === v} onClick={() => onCambio(v)}
          className={cn('h-11 rounded-md px-3 text-sm font-medium', valor === v ? 'bg-card text-foreground' : 'text-muted-foreground')}>{t}</button>
      ))}
    </div>
  );
}

function Selector({ etiqueta, valor, opciones, onCambio, 'data-info': info }: { etiqueta: string; valor: string; opciones: [string, string][]; onCambio: (v: string) => void; 'data-info'?: string }) {
  return (
    <label className="flex flex-col gap-1 text-[12.5px] font-medium text-muted-foreground" data-info={info}>
      {etiqueta}
      <select value={valor} onChange={(e) => onCambio(e.target.value)}
        className="h-11 rounded-lg border bg-card px-3 text-[15px] font-normal text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {opciones.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </label>
  );
}

// La falla de ?falla=: su fila con la línea de tiempo abierta, sacada de E13t.
function FallaElegida({ org, id, onCerrar }: { org: string; id: string; onCerrar: () => void }) {
  const q = useLineaTiempoFalla(org, id);
  if (!q.data) return null;
  return (
    <section className="flex flex-col gap-1 rounded-xl border border-info bg-card px-5 py-3" aria-label="Falla elegida">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold">Línea de tiempo de la falla</h3>
        <button type="button" onClick={onCerrar} className="h-11 text-sm font-medium text-foreground underline underline-offset-4">Cerrar</button>
      </div>
      <ul><FilaFalla org={org} f={q.data.item} abierta onAlternar={onCerrar} /></ul>
    </section>
  );
}

export default function PaginaHistorial() {
  const org = useOrg();
  const [params, setParams] = useSearchParams();
  const leer = <T extends string>(k: string, opciones: [T, string][], def: T): T => { const v = params.get(k) ?? def; return esFiltro(opciones, v) ? v : def; };
  const estado = leer<FiltroEstado>('estado', ESTADOS_FILTRO, '');
  const modulo = leer('modulo', MODULOS_FILTRO, '');
  const gravedad = leer('gravedad', SEVERIDADES_FILTRO, '');
  const dias = leer('dias', PERIODOS, '');
  const orden = leer('orden', ORDENES, 'desc');
  const elegida = params.get('falla');
  const poner = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });

  const filtro: FiltroHistorial = { limit: LIMITE, ...(estado ? { status: estado } : {}), ...(modulo ? { module: modulo as Module } : {}),
    ...(gravedad ? { severity: gravedad as Severity } : {}), ...(dias ? { days: Number(dias) } : {}), ...(orden === 'asc' ? { order: 'asc' as const } : {}) };
  const q = useHistorialFallas(org.id, filtro);
  const pronto = q.isError && esApiError(q.error) && q.error.status === 404;
  const [abiertas, setAbiertas] = useState<ReadonlySet<string>>(() => new Set());
  const alternar = (id: string) => setAbiertas((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  useEffect(() => {                                   // «Ver historial» del clic derecho: la falla, a la vista
    if (esId(elegida)) document.getElementById('falla-elegida')?.scrollIntoView({ block: 'start' });
  }, [elegida]);

  const lista = q.data ?? [];
  const filtrado = !!(estado || modulo || gravedad || dias);
  return (
    <div className="flex flex-col gap-6">
      <BarraModulo titulo="Historial de fallas" data-info="historial-fallas"
        descripcion="Todas las fallas que encontré: las abiertas, las corregidas, las que una auditoría verificó y las ignoradas, con sus fechas."
        extra={<Link to={`/o/${org.id}/evolution`} className="inline-flex h-11 items-center gap-1 text-sm font-medium text-foreground underline underline-offset-4">
          <ArrowLeft className="size-4" />Evolución</Link>} />
      {esId(elegida) ? <div id="falla-elegida" className="scroll-mt-4"><FallaElegida org={org.id} id={elegida} onCerrar={() => poner('falla', '')} /></div> : null}
      {pronto ? <Vacio icono={History} titulo="El historial llega pronto" texto="Aquí verás cada falla que encontré, si se corrigió y cuándo." /> : (
        <>
          <div className="flex flex-col gap-3">
            <Grupo etiqueta="Estado" data-info="historial-filtro-estado" valor={estado} opciones={ESTADOS_FILTRO} onCambio={(v) => poner('estado', v)} />
            <div className="flex flex-wrap items-end gap-3">
              <Selector etiqueta="Módulo" data-info="historial-filtro-modulo" valor={modulo} opciones={MODULOS_FILTRO} onCambio={(v) => poner('modulo', v)} />
              <Selector etiqueta="Gravedad" data-info="historial-filtro-gravedad" valor={gravedad} opciones={SEVERIDADES_FILTRO} onCambio={(v) => poner('gravedad', v)} />
              <Selector etiqueta="Último cambio" data-info="historial-filtro-periodo" valor={dias} opciones={PERIODOS} onCambio={(v) => poner('dias', v)} />
              <Selector etiqueta="Orden" data-info="historial-orden" valor={orden} opciones={ORDENES} onCambio={(v) => poner('orden', v === 'desc' ? '' : v)} />
            </div>
          </div>
          {q.isError && !q.data ? <ErrorBloque error={q.error} onReintentar={() => q.refetch()} />
            : !q.data ? <p className="text-texto-3" aria-busy="true">—</p>
            : lista.length === 0 ? <Vacio icono={History} titulo={filtrado ? 'Ninguna falla con estos filtros' : 'Aún no hay fallas'}
                texto={filtrado ? 'Prueba con otro estado, módulo o periodo.' : 'Cuando una auditoría encuentre algo, quedará aquí con sus fechas.'} />
            : (
              <section className="flex flex-col gap-2 rounded-xl border bg-card px-5 py-3" aria-labelledby="t-historial">
                <h3 id="t-historial" className="pt-2 text-[17px] font-semibold">
                  {lista.length} {lista.length === 1 ? 'falla' : 'fallas'}{lista.length >= LIMITE ? ` (las ${LIMITE} de cambio más ${orden === 'asc' ? 'antiguo' : 'reciente'})` : ''}
                </h3>
                <ul aria-label="Fallas">
                  {lista.map((f) => <FilaFalla key={f.id} org={org.id} f={f} abierta={abiertas.has(f.id)} onAlternar={() => alternar(f.id)} />)}
                </ul>
              </section>
            )}
          <p className="text-[13px] text-texto-3">Corregida es que alguien la marcó como arreglada; verificada, que una auditoría comprobó que ya no está. Una falla cerrada se borra a los 90 días.</p>
        </>
      )}
      <DetalleEnPanel />
    </div>
  );
}
