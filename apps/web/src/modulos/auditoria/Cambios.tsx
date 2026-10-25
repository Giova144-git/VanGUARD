// «Cambios desde la auditoría anterior» (asignaciones/evolucion-entre-revisiones.md §1.2 y §6.3): en la auditoría
// terminada, entre el puntaje y el Resumen. Si E51 da 404 (aún sin desplegar) o falla sin datos, no se pinta nada y el
// resto de la página sigue igual. Viewer y anónimo ven lo mismo: no hay acciones de escritura.
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import type { AuditDelta, DeltaItem, DeltaLista } from '@vanguard/contracts';
import { Cifra, FilaCifras } from '@/componentes/vg/Cifra';
import { ChapaSeveridad, Etiqueta } from '@/componentes/vg/Etiqueta';
import { SectorPlegable } from '@/componentes/vg/SectorPlegable';
import { useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { useDeltaAuditoria } from '@/lib/consultas';
import {
  MODULOS_FOTO, etiquetaCorregido, etiquetaVersion, nombreModulo, porSeveridad, tipoAuditoria, totalFila, totalMatriz,
  type ListaDelta,
} from '@/lib/evolucion';
import { deMapa } from '@/lib/severidad';

type ConFoto = Extract<AuditDelta, { available: true }>;
const TITULO = 'Cambios desde la auditoría anterior';
const SIN_COMPARAR: Record<string, string> = {
  en_curso: 'Comparando con la auditoría anterior…',
  sin_foto: 'Esta auditoría es anterior al historial o no pudo revisar ningún módulo: no hay cambios que mostrar.',
};
const PRIMERA = 'Es la primera auditoría con historial. Desde la próxima verás qué es nuevo, qué se mantiene y qué se corrigió.';
const VISIBLES = 10;
const ID_NUEVOS = 'cambios-nuevos';

const plural = (n: number, uno: string, varios: string) => (n === 1 ? uno : varios);
const puntaje = (s: number | null | undefined) => (s == null ? '—' : String(s));

function cabecera(d: ConFoto) {
  const flecha = `puntaje ${puntaje(d.previous?.score)} → ${puntaje(d.score)}`;
  if (!d.previous) return 'Frente a una auditoría que ya se borró (se guardan 90 días)';
  const tipo = d.previous.kind === 'full_audit' ? '' : ` (${tipoAuditoria(d.previous.kind)})`;
  if (!d.previous.finished_at) return `Frente a la auditoría anterior${tipo} · ${flecha}`;
  return `Frente a la auditoría del ${etiquetaVersion(d.previous.finished_at)}${tipo} · ${flecha}`;
}

function Bloque({ children }: { children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-card p-5" aria-labelledby="t-cambios">
      <h3 id="t-cambios" className="text-[17px] font-semibold">{TITULO}</h3>
      {children}
    </section>
  );
}

function Fila({ item, lista }: { item: DeltaItem; lista: ListaDelta }) {
  const chip = etiquetaCorregido(item, lista);
  return (
    <li className="flex flex-wrap items-center gap-3 border-b py-3 last:border-b-0">
      <ChapaSeveridad severity={item.severity} />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Título y recurso del cliente, como «Hallazgos abiertos»: los controles bidi se ven (lib/bidi.ts). */}
        <span className="text-[15px] font-medium wrap-anywhere">{sinBidi(item.title)}</span>
        <span className="flex min-w-0 flex-wrap gap-x-2 text-[13px] text-muted-foreground">
          <span className="min-w-0 truncate font-mono"><bdi dir="ltr">{sinBidi(item.resource)}</bdi></span>
          <span>· {nombreModulo(item.module)}</span>
        </span>
      </div>
      {chip ? <Etiqueta texto={chip.texto} rol={chip.rol} className="h-auto min-h-6 whitespace-normal py-0.5" /> : null}
      <Link to={`?finding=${encodeURIComponent(item.finding_id)}`} className="inline-flex h-11 items-center gap-1 rounded-full border border-foreground px-4 font-mono text-[13px] font-medium uppercase tracking-[0.06em] text-foreground hover:bg-muted">Ver<ChevronRight className="size-4" /></Link>
    </li>
  );
}

// Se pintan 10; «Ver todos» despliega los que trae E51 (hasta 50) y «y N más» cuenta los que no caben.
function Lista({ titulo, datos, lista, abierta }: { titulo: string; datos: DeltaLista; lista: ListaDelta; abierta?: boolean }) {
  const [todos, setTodos] = useState(false);
  const items = todos ? datos.items : datos.items.slice(0, VISIBLES);
  const ocultos = datos.items.length - items.length;
  const fuera = datos.total - datos.items.length;
  return (
    <SectorPlegable titulo={`${titulo} (${datos.total})`} defaultOpen={abierta}>
      {datos.total === 0 ? <p className="text-[15px] text-muted-foreground">Ninguno.</p> : (
        <div className="flex flex-col gap-2">
          <ul>{items.map((i) => <Fila key={i.finding_id} item={i} lista={lista} />)}</ul>
          {ocultos > 0 ? (
            <button type="button" onClick={() => setTodos(true)} className="h-11 w-fit text-sm font-medium text-foreground underline underline-offset-4">
              Ver todos ({datos.items.length})</button>
          ) : fuera > 0 ? <p className="text-sm text-muted-foreground">y {fuera} más</p> : null}
        </div>
      )}
    </SectorPlegable>
  );
}

function ConCambios({ d }: { d: ConFoto }) {
  const nuevos = totalMatriz(d.counts.new);
  const siguen = totalMatriz(d.counts.kept);
  const corregidos = totalMatriz(d.counts.fixed);
  const ignorados = totalMatriz(d.counts.ignored);
  const sev = porSeveridad(d.counts.new);
  const grave = sev.critical + sev.high > 0;
  // Rendimiento no entra en las fotos, pero un módulo con algo distinto de 0 se pinta igual.
  const modulos = [...MODULOS_FOTO, 'performance' as const].map((m) => ({ m, nuevos: totalFila(d.counts.new[m]),
    siguen: totalFila(d.counts.kept[m]), corregidos: totalFila(d.counts.fixed[m]), ignorados: totalFila(d.counts.ignored[m]) }))
    .filter((x) => x.nuevos + x.siguen + x.corregidos + x.ignorados > 0);
  const irANuevos = () => document.getElementById(ID_NUEVOS)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <div className="flex flex-col gap-3" aria-labelledby="t-cambios" role="region">
      <section className="flex flex-col gap-4 rounded-xl border bg-card p-5">
        <div className="flex flex-col gap-1">
          <h3 id="t-cambios" className="text-[17px] font-semibold">{TITULO}</h3>
          <p className="text-[15px] text-muted-foreground">{cabecera(d)}</p>
        </div>
        <FilaCifras>
          <Cifra etiqueta="Nuevos" n={nuevos} rol={grave ? 'mal' : undefined}
            accion={grave ? <button type="button" onClick={irANuevos} className="w-fit text-[12.5px] font-medium text-foreground underline underline-offset-4">Ver</button> : undefined} />
          <Cifra etiqueta="Se mantienen" n={siguen} />
          <Cifra etiqueta="Corregidos" n={corregidos}
            sub={corregidos > 0 ? `${d.fixed_checked} ${plural(d.fixed_checked, 'comprobado', 'comprobados')} por la auditoría` : undefined} />
        </FilaCifras>
        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          <p>Ignorados: {ignorados}</p>
          {d.moved > 0 ? <p>{d.moved} {plural(d.moved, 'clave cambió de línea y sigue abierta: cuenta', 'claves cambiaron de línea y siguen abiertas: cuentan')} en «Se mantienen».</p> : null}
          {d.gone > 0 ? <p>{d.gone} {plural(d.gone, 'hallazgo ya no existe (se borró por antigüedad): no cuenta como corregido', 'hallazgos ya no existen (se borraron por antigüedad): no cuentan como corregidos')}.</p> : null}
        </div>
        {modulos.length ? (
          <ul className="flex flex-col" aria-label="Cambios por módulo">
            {modulos.map((x) => (
              <li key={x.m} className="flex flex-col gap-0.5 border-t py-2 text-[15px] first:border-t-0">
                <span><span className="font-medium">{nombreModulo(x.m)}</span><span className="text-muted-foreground"> · {x.nuevos} {plural(x.nuevos, 'nuevo', 'nuevos')} · {x.siguen} {plural(x.siguen, 'se mantiene', 'se mantienen')} · {x.corregidos} {plural(x.corregidos, 'corregido', 'corregidos')}</span></span>
                {d.modules_seen.includes(x.m) ? null
                  : <span className="text-[13px] text-texto-3">{nombreModulo(x.m)}: no se revisó en esta auditoría; sus cambios vienen de pushes o de marcas a mano.</span>}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <div id={ID_NUEVOS} className="scroll-mt-4"><Lista titulo="Nuevos" datos={d.new} lista="new" abierta /></div>
      <Lista titulo="Corregidos" datos={d.fixed} lista="fixed" />
      <Lista titulo="Se mantienen" datos={d.kept} lista="kept" />
      {d.ignored.total > 0 ? <Lista titulo="Ignorados" datos={d.ignored} lista="ignored" /> : null}
    </div>
  );
}

export function Cambios({ scanId }: { scanId: string }) {
  const org = useOrg();
  const q = useDeltaAuditoria(org.id, scanId, true);
  const d = q.data;
  if (!d) return null;                                        // cargando, 404 o error sin datos: nada
  if (!d.available) return <Bloque><p className="text-[15px] text-muted-foreground">{deMapa(SIN_COMPARAR, d.reason, SIN_COMPARAR.sin_foto!)}</p></Bloque>;
  if (d.first) return <Bloque><p className="text-[15px] text-muted-foreground">{PRIMERA}</p></Bloque>;
  return <ConCambios d={d} />;
}
