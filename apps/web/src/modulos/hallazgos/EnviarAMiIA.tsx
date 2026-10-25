// «Enviar a mi IA» con un clic (cola fix_requests, E58): el botón es un enlace profundo a Claude Code
// (`claude-cli://open?repo=…&q=/mcp__vanguard__resolver_hallazgo <id>`) y, al pulsarlo, además (a) crea la petición en
// la cola y (b) Vigía avisa de que se lo ha mandado a tu IA. El navegador sigue el enlace solo: Claude Code se abre con
// la orden escrita y nada se ejecuta hasta que el usuario pulsa Enter. Cuando su IA pide la corrección por MCP, la
// petición pasa a «Arreglando»; cuando la auditoría ya no ve el hallazgo (o se marca corregido), a «Corregido».
// Solo viaja el id (UUID validado con esId), nunca texto del hallazgo. Viewer y demo: el botón sale apagado con motivo.
// La misma lógica (useEnviarAMiIA) sirve al botón y al clic derecho → «Enviar a mi IA» de cada problema (MenuContextual).
import type { MouseEvent } from 'react';
import { SquareTerminal } from 'lucide-react';
import { FIX_REQUEST_ABIERTA, type FixRequest, type FixRequestClient } from '@vanguard/contracts';
import { SOLO_LECTURA } from '@/app/guardas';
import { Button } from '@/componentes/ui/button';
import { IconoArreglando } from '@/componentes/vigia/IconoArreglando';
import { useGuia } from '@/componentes/vigia/contexto';
import { esId } from '@/lib/ids';
import { useColaIA, useConexiones } from '@/lib/consultas';
import { comandoClaudeCode, enlaceClaudeCode, repoParaArreglar } from '@/lib/mcp';
import { useCancelarEnvioIA, useEnviarAIA } from '@/lib/mutaciones';
import { cn } from '@/lib/utils';

const TEXTO: Record<'enviado' | 'arreglando' | 'corregido', string> = {
  enviado: 'Enviado a tu IA', arreglando: 'Arreglando', corregido: 'Corregido',
};
const AYUDA: Record<'enviado' | 'arreglando' | 'corregido', string> = {
  enviado: 'Tu IA aún no ha pedido la corrección',
  arreglando: 'Tu IA ya pidió la corrección y la está aplicando',
  corregido: 'La auditoría ya no lo ve, o se marcó corregido',
};

/** Distintivo del envío: icono de Vigía con su martillo + texto siempre visible. Nada si no hay envío o se canceló. */
export function EstadoEnvioIA({ envio, className }: { envio: FixRequest | null | undefined; className?: string }) {
  if (!envio || envio.status === 'cancelado') return null;
  const e = envio.status;
  return (
    <span className={cn('inline-flex h-6 shrink-0 items-center gap-1.5 rounded-lg border px-2 font-mono text-[12.5px] font-medium uppercase tracking-[0.08em]',
      e === 'corregido' ? 'border-foreground/30' : 'border-border', className)} data-info="estado-correccion" title={AYUDA[e]}>
      <IconoArreglando estado={e} tam={18} />
      {TEXTO[e]}
    </span>
  );
}

const DICHO = 'Se lo he enviado a tu IA. Revisa la orden en Claude Code y pulsa Enter; cuando la tome, aquí verás «Arreglando».';

/** Crea la petición y hace hablar a Vigía señalando `objetivo`. Devuelve la mutación para pintar su error. */
export function useEnviarConVigia(org: string) {
  const m = useEnviarAIA(org);
  const guia = useGuia();
  const enviar = (findingId: string, client: FixRequestClient, objetivo?: HTMLElement) => {
    if (!esId(findingId)) return;
    m.mutate({ id: findingId, client });
    // Si Vigía no está visible, decir() la invoca: el usuario acaba de pedir la acción.
    guia.decir({ pose: 'reparar', titulo: 'Enviado a tu IA', texto: DICHO, objetivo, duracion: 6000 });
  };
  return { enviar, mutacion: m };
}

/** ¿El envío sigue abierto (enviado o arreglando)? Entonces no se vuelve a enviar: se puede cancelar. */
export const envioAbierto = (e: FixRequest | null | undefined) => !!e && FIX_REQUEST_ABIERTA.includes(e.status);

/** Enlace profundo de «Enviar a mi IA»: Claude Code en el clon de `repo` con la orden del MCP para este hallazgo. */
export const enlaceEnviar = (findingId: string, repo: string | null) => enlaceClaudeCode(comandoClaudeCode('resolver_hallazgo', findingId), repo);

/** Sigue un enlace profundo desde un manejador de clic que no es un <a> (un ítem de menú): un clic sobre un enlace de
 *  verdad, dentro del mismo gesto del usuario, como el botón. Pasa por el documento, así una prueba lo puede interceptar. */
export function abrirEnlace(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.append(a);
  try { a.click(); } finally { a.remove(); }
}

/** «Enviar a mi IA» completo para un hallazgo: el botón y el clic derecho comparten esto. */
export function useEnviarAMiIA(org: string) {
  const { enviar, mutacion } = useEnviarConVigia(org);
  const cancelacion = useCancelarEnvioIA(org);
  const cola = useColaIA(org);
  const conexiones = useConexiones(org);
  return {
    mutacion, cancelacion,
    /** El último envío de ese hallazgo, o null. */
    envioDe: (findingId: string): FixRequest | null => cola.data?.find((x) => x.finding_id === findingId) ?? null,
    /** Repo donde se abre Claude Code: el de la conexión del hallazgo o el primero activo de la org. */
    repoDe: (connectionId: string | null | undefined) => repoParaArreglar(connectionId ?? null, conexiones.data),
    /** Desde un <a href> (el botón): el navegador sigue el enlace; aquí se encola y Vigía avisa. */
    alPulsarEnlace: (findingId: string, objetivo?: HTMLElement) => enviar(findingId, 'claude_code', objetivo),
    /** Desde un ítem de menú: encola, Vigía avisa y se abre Claude Code. Llamar dentro del manejador del clic. */
    enviarYAbrir: (findingId: string, repo: string | null, objetivo?: HTMLElement) => {
      if (!esId(findingId)) return;
      enviar(findingId, 'claude_code', objetivo);
      abrirEnlace(enlaceEnviar(findingId, repo));
    },
    cancelar: (findingId: string) => { if (esId(findingId)) cancelacion.mutate(findingId); },
  };
}

/** Botón «Enviar a mi IA»: enlace a Claude Code que, al pulsarlo, también encola y avisa. */
export function BotonEnviarAMiIA({ org, findingId, repo, puedeEscribir, tam = 'fila', compacto }: {
  org: string; findingId: string; repo: string | null; puedeEscribir: boolean; tam?: 'fila' | 'grande'; compacto?: boolean;
}) {
  const ia = useEnviarAMiIA(org);
  if (!esId(findingId)) return null;
  const texto = 'Enviar a mi IA';
  if (!puedeEscribir) {
    return (
      <span className="inline-flex flex-col gap-1">
        <Button variant={compacto ? 'secundaria' : 'principal'} size={tam} disabled title={SOLO_LECTURA} aria-label={`${texto} (${SOLO_LECTURA})`}><SquareTerminal />{texto}</Button>
        {compacto ? null : <span className="text-[12.5px] text-texto-3">{SOLO_LECTURA}</span>}
      </span>
    );
  }
  const alPulsar = (e: MouseEvent<HTMLAnchorElement>) => ia.alPulsarEnlace(findingId, e.currentTarget);
  return (
    <span className="inline-flex flex-col gap-1">
      <Button asChild variant={compacto ? 'secundaria' : 'principal'} size={tam}>
        <a href={enlaceEnviar(findingId, repo)} onClick={alPulsar} data-guia="enviar-ia"><SquareTerminal />{texto}</a>
      </Button>
      {ia.mutacion.isError ? <span role="alert" className="text-[12.5px] text-mal">No pudimos anotarlo en la cola; Claude Code se abre igual.</span> : null}
    </span>
  );
}

/** Distintivo de la fila de un hallazgo: su envío a la IA, si lo hay (tras «Enviar a mi IA» desde el botón o el menú). */
export function DistintivoEnvio({ org, findingId }: { org: string; findingId: string }) {
  const cola = useColaIA(org);
  if (!esId(findingId)) return null;
  return <EstadoEnvioIA envio={cola.data?.find((x) => x.finding_id === findingId)} />;
}
