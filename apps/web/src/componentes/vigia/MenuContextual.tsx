// Clic derecho → «Info» → Vigía lo explica. Sobre un elemento (o un ancestro) con un data-info conocido (una clave de INFO), el menú del
// navegador se cambia por este, pequeño y con el estilo de la app; fuera de ellos, en campos de texto o sobre texto
// seleccionado, el clic derecho sigue siendo el del navegador. Con teclado lo abren Shift+F10 y la tecla Menú sobre el
// elemento enfocado. ACCIONES es la lista de opciones: «Info», sobre un enlace abrirlo en otra pestaña (el menú del
// navegador, que lo ofrecía, ya no sale ahí) y, sobre un problema (data-hallazgo="<uuid>", que manda sobre los data-info
// de dentro de su fila), «Enviar a mi IA», «Cancelar envío» y «Ver historial». La «Info» de un problema explica ESE
// problema (info-hallazgos.ts) con los datos que ya enseña la fila, sacados de la caché de TanStack Query o de lo que la
// fila anotó, y sus fechas: si ninguna lista las trae, el menú pide su línea de tiempo (E13t) al abrirse.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent as EventoTeclado, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ExternalLink, History, Info, X } from 'lucide-react';
import type { AhoraItem, Finding, FindingHistoryItem, FindingTimeline, FixRequest } from '@vanguard/contracts';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { envioAbierto, useEnviarAMiIA } from '@/modulos/hallazgos/EnviarAMiIA';
import { useLineaTiempoFalla } from '@/lib/consultas';
import { esId } from '@/lib/ids';
import { useGuia, type ApiGuia } from './contexto';
import { IconoArreglando } from './IconoArreglando';
import { esIdInfo, INFO, type IdInfo } from './info';
import { hallazgoVisto, infoDeHallazgo, type DatosHallazgo } from './info-hallazgos';

const MARGEN = 8;          // px libres hasta el borde de la ventana
const ECO_TECLADO_MS = 600;  // el contextmenu que el navegador manda tras Shift+F10 / Menú ya está atendido

/** A quién se refiere el menú: un data-info (`id`) o un problema (`hallazgo`, su UUID; entonces `id` es null). */
export type Destino = { elemento: HTMLElement; id: IdInfo | null; hallazgo?: string };
type Abierto = Destino & { x: number; y: number; antes: HTMLElement | null };

/** «Enviar a mi IA» para el menú (useEnviarAMiIA + permisos de la org). */
export type IAContexto = {
  /** null si puede escribir; si no, el motivo (viewer o demo de solo lectura). */
  bloqueo: string | null;
  envioDe: (findingId: string) => FixRequest | null;
  repoDe: (connectionId: string | null | undefined) => string | null;
  enviarYAbrir: (findingId: string, repo: string | null, objetivo?: HTMLElement) => void;
  cancelar: (findingId: string) => void;
};
/** Lo que una acción recibe: a quién se refiere, el problema (si lo es), la guía para hablar y la IA. */
export type Contexto = { elemento: HTMLElement; id: IdInfo | null; hallazgo?: DatosHallazgo | null; guia: Pick<ApiGuia, 'decir'>; ia?: IAContexto;
  /** Abre la línea de tiempo del problema en el historial de fallas (solo en el menú de un problema). */
  verHistorial?: (findingId: string) => void };
export type Accion = {
  id: string;
  texto: string | ((c: Contexto) => string);
  icono: ComponentType<{ className?: string }>;
  /** Sin ella, siempre sale. */
  disponible?: (c: Contexto) => boolean;
  /** Sale, pero apagada con este motivo (aria-disabled; sigue alcanzable con las flechas para oír por qué). */
  deshabilitada?: (c: Contexto) => string | null;
  hacer: (c: Contexto) => void;
};

const enlaceDe = (el: HTMLElement) => el.closest<HTMLAnchorElement>('a[href]');
const IconoEnviar = ({ className }: { className?: string }) => <IconoArreglando estado="enviado" tam={16} className={className} />;
const abiertoDe = (c: Contexto) => !!c.hallazgo && !!c.ia && envioAbierto(c.ia.envioDe(c.hallazgo.id));

/** Título y texto de «Info»: el del problema concreto o el fijo del data-info. */
export function infoDe(c: Pick<Contexto, 'id' | 'hallazgo'>) {
  return c.hallazgo ? infoDeHallazgo(c.hallazgo) : c.id ? INFO[c.id] : infoDeHallazgo(null);
}

export const ACCIONES: readonly Accion[] = [
  { id: 'info', texto: 'Info', icono: Info,
    hacer: (c) => { const i = infoDe(c); c.guia.decir({ objetivo: c.elemento, titulo: i.titulo, texto: i.texto }); } },
  { id: 'enviar-ia', icono: IconoEnviar,
    texto: (c) => (abiertoDe(c) ? 'Ya enviado a tu IA' : 'Enviar a mi IA'),
    disponible: (c) => !!c.hallazgo,
    deshabilitada: (c) => (!c.ia ? 'No disponible aquí' : c.ia.bloqueo ? c.ia.bloqueo : abiertoDe(c) ? 'Tu IA ya lo tiene'
      : c.hallazgo?.status && c.hallazgo.status !== 'open' ? 'Ya no está abierto' : null),
    // Se asume la IA conectada (como el botón): sin confirmación. El enlace se abre dentro de este mismo clic.
    hacer: (c) => { if (c.hallazgo && c.ia && !c.ia.bloqueo) c.ia.enviarYAbrir(c.hallazgo.id, c.ia.repoDe(c.hallazgo.connection_id), c.elemento); } },
  { id: 'cancelar-ia', texto: 'Cancelar envío', icono: X,
    disponible: (c) => abiertoDe(c) && !c.ia?.bloqueo,
    hacer: (c) => { if (c.hallazgo && c.ia) c.ia.cancelar(c.hallazgo.id); } },
  { id: 'ver-historial', texto: 'Ver historial', icono: History,
    disponible: (c) => !!c.hallazgo && !!c.verHistorial,
    hacer: (c) => { if (c.hallazgo) c.verHistorial?.(c.hallazgo.id); } },
  { id: 'pestana', texto: 'Abrir en una pestaña nueva', icono: ExternalLink,
    disponible: ({ elemento }) => !!enlaceDe(elemento),
    hacer: ({ elemento }) => { const a = enlaceDe(elemento); if (a) window.open(a.href, '_blank', 'noopener,noreferrer'); } },
];

/** Lo que se sabe de un hallazgo sin pedirlo otra vez: el detalle o las listas en caché, el «Ahora» del resumen y lo
 *  que anotó la fila (la bandeja de un módulo trae el rol, no la gravedad). Lo de la caché manda. */
export function datosHallazgo(qc: Pick<QueryClient, 'getQueryData' | 'getQueriesData'> | null, org: string, id: string): DatosHallazgo {
  const anotado = hallazgoVisto(id);
  const historia = historiaEnCache(qc, org, id);
  let f: (Finding | AhoraItem | FindingHistoryItem) & { status?: string } | undefined = qc?.getQueryData<Finding>(['org', org, 'finding', id]);
  if (!f && qc) for (const [, lista] of qc.getQueriesData<Finding[]>({ queryKey: ['org', org, 'findings'] })) {
    f = Array.isArray(lista) ? lista.find((x) => x?.id === id) : undefined;
    if (f) break;
  }
  f ??= historia ?? qc?.getQueryData<{ ahora?: AhoraItem[] }>(['org', org, 'overview'])?.ahora?.find((x) => x.kind === 'finding' && x.id === id);
  if (!f) return anotado ?? { id };
  // Las fechas: las del historial (traen todas) y, si no, las de la fila o lo anotado. El estado de la caché manda.
  const fecha = (k: 'first_seen_at' | 'fixed_at' | 'verified_at' | 'ignored_at' | 'reopened_at') =>
    historia?.[k] ?? (f as Partial<Record<typeof k, string | null>>)[k] ?? anotado?.[k] ?? null;
  return { ...anotado, id, module: f.module, rule_id: f.rule_id, severity: f.severity, resource: f.resource,
    connection_id: f.connection_id ?? anotado?.connection_id ?? null, status: f.status ?? anotado?.status ?? null,
    first_seen_at: fecha('first_seen_at'), fixed_at: fecha('fixed_at'), verified_at: fecha('verified_at'),
    ignored_at: fecha('ignored_at'), reopened_at: fecha('reopened_at') };
}

/** La fila del historial (E13t de esa falla o cualquier lista de E13h en caché), o undefined. */
function historiaEnCache(qc: Pick<QueryClient, 'getQueryData' | 'getQueriesData'> | null, org: string, id: string): FindingHistoryItem | undefined {
  const t = qc?.getQueryData<FindingTimeline>(['org', org, 'history', 'falla', id])?.item;
  if (t?.id === id) return t;
  if (qc) for (const [, lista] of qc.getQueriesData<FindingHistoryItem[]>({ queryKey: ['org', org, 'history', 'lista'] })) {
    const x = Array.isArray(lista) ? lista.find((y) => y?.id === id) : undefined;
    if (x) return x;
  }
  return undefined;
}

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/** ¿Este clic derecho es nuestro? Null deja el menú del navegador: sin data-info conocido ni problema, en un campo o con
 *  texto elegido. Dentro de la fila de un problema manda el problema (su gravedad, su repo… son de él). */
export function destinoDe(objetivo: EventTarget | null, haySeleccion = false): Destino | null {
  if (haySeleccion || !objetivo || typeof (objetivo as Element).closest !== 'function') return null;
  const el = objetivo as Element;
  if (el.closest(EDITABLE)) return null;
  const fila = el.closest<HTMLElement>('[data-hallazgo]');
  const hallazgo = fila?.getAttribute('data-hallazgo');
  if (fila && esId(hallazgo)) return { elemento: fila, id: null, hallazgo };
  const elemento = el.closest<HTMLElement>('[data-info]');
  const id = elemento?.getAttribute('data-info');
  return elemento && esIdInfo(id) ? { elemento, id } : null;
}

/** Shift+F10 o la tecla Menú (sin otros modificadores). */
export const esTeclaMenu = (e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>) =>
  !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey));

/** Esquina superior izquierda para que un menú de ancho×alto quepa en la ventana: si no cabe a la derecha o abajo, se da la vuelta. */
export function colocar(x: number, y: number, ancho: number, alto: number, vw: number, vh: number) {
  const left = x + ancho + MARGEN > vw ? x - ancho : x;
  const top = y + alto + MARGEN > vh ? y - alto : y;
  return { left: Math.max(MARGEN, Math.min(left, vw - ancho - MARGEN)), top: Math.max(MARGEN, Math.min(top, vh - alto - MARGEN)) };
}

/** Siguiente opción con las flechas, Inicio y Fin (da la vuelta); null si la tecla no mueve. */
export function moverFoco(tecla: string, actual: number, n: number): number | null {
  if (!n) return null;
  if (tecla === 'ArrowDown') return (actual + 1) % n;
  if (tecla === 'ArrowUp') return (actual - 1 + n) % n;
  if (tecla === 'Home') return 0;
  if (tecla === 'End') return n - 1;
  return null;
}

const haySeleccion = () => { const s = window.getSelection(); return !!s && !s.isCollapsed && s.toString().trim() !== ''; };

export function MenuContextual() {
  const guia = useGuia();
  const [abierto, setAbierto] = useState<Abierto | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const teclado = useRef(0);

  const actual = useRef<Abierto | null>(null);
  actual.current = abierto;
  // Con Esc o Tab el foco vuelve a donde estaba (con teclado, el propio elemento); al elegir, lo toma quien responda.
  const cerrar = useCallback((devolverFoco: boolean) => {
    const a = actual.current;
    setAbierto(null);
    if (a && devolverFoco) a.antes?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const abrir = (d: Destino, x: number, y: number) =>
      setAbierto({ ...d, x, y, antes: document.activeElement instanceof HTMLElement ? document.activeElement : null });
    const junto = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return [r.left + Math.min(16, r.width / 2), r.bottom] as const; };
    const alMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      if (Date.now() - teclado.current < ECO_TECLADO_MS) { e.preventDefault(); return; }
      const d = destinoDe(e.target, haySeleccion());
      if (!d) return;
      e.preventDefault();
      // Desde teclado algunos navegadores lo mandan en (0, 0): se abre junto al elemento.
      const [x, y] = e.clientX === 0 && e.clientY === 0 ? junto(d.elemento) : [e.clientX, e.clientY];
      abrir(d, x, y);
    };
    const alTecla = (e: KeyboardEvent) => {
      if (!esTeclaMenu(e)) return;
      const d = destinoDe(document.activeElement);
      if (!d) return;
      e.preventDefault();
      teclado.current = Date.now();
      abrir(d, ...junto(d.elemento));
    };
    document.addEventListener('contextmenu', alMenu);
    document.addEventListener('keydown', alTecla);
    return () => { document.removeEventListener('contextmenu', alMenu); document.removeEventListener('keydown', alTecla); };
  }, []);

  // Abierto: se coloca dentro de la ventana, enfoca la primera opción y se cierra al tocar fuera, al desplazar o al
  // cambiar el tamaño de la ventana.
  useLayoutEffect(() => {
    const m = menu.current;
    if (!abierto || !m) return;
    const { left, top } = colocar(abierto.x, abierto.y, m.offsetWidth, m.offsetHeight, window.innerWidth, window.innerHeight);
    m.style.left = `${left}px`;
    m.style.top = `${top}px`;
    m.style.visibility = 'visible';
    m.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [abierto]);
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node)) cerrar(false); };
    const soltar = () => cerrar(false);
    document.addEventListener('pointerdown', fuera, true);
    window.addEventListener('scroll', soltar, true);
    window.addEventListener('resize', soltar);
    window.addEventListener('blur', soltar);
    return () => {
      document.removeEventListener('pointerdown', fuera, true);
      window.removeEventListener('scroll', soltar, true);
      window.removeEventListener('resize', soltar);
      window.removeEventListener('blur', soltar);
    };
  }, [abierto, cerrar]);

  if (!abierto) return null;
  return createPortal(abierto.hallazgo
    ? <MenuHallazgo abierto={abierto} hallazgo={abierto.hallazgo} menu={menu} cerrar={cerrar} guia={guia} />
    : <Menu abierto={abierto} ctx={{ elemento: abierto.elemento, id: abierto.id, guia }} menu={menu} cerrar={cerrar} />, document.body);
}

type PropsMenu = { abierto: Abierto; menu: RefObject<HTMLDivElement | null>; cerrar: (devolverFoco: boolean) => void };

/** El de un problema: trae sus datos (sin pedirlos) y «Enviar a mi IA» con los permisos de la org. */
function MenuHallazgo({ abierto, hallazgo, guia, ...p }: PropsMenu & { hallazgo: string; guia: Pick<ApiGuia, 'decir'> }) {
  const org = useOrg();
  const qc = useQueryClient();
  const navegar = useNavigate();
  const ia = useEnviarAMiIA(org.id);
  // Sin fechas en ninguna lista (Cambios, la bandeja de un módulo, «Ahora»): se piden mientras el menú está abierto.
  const sinFechas = !historiaEnCache(qc, org.id, hallazgo);
  useLineaTiempoFalla(org.id, hallazgo, sinFechas);            // al llegar, el render vuelve a leer la caché
  const ctx: Contexto = { elemento: abierto.elemento, id: null, hallazgo: datosHallazgo(qc, org.id, hallazgo), guia,
    ia: { bloqueo: org.puedeEscribir ? null : SOLO_LECTURA, envioDe: ia.envioDe, repoDe: ia.repoDe, enviarYAbrir: ia.enviarYAbrir, cancelar: ia.cancelar },
    verHistorial: (id) => navegar(`/o/${org.id}/evolution/history?falla=${encodeURIComponent(id)}`) };
  return <Menu abierto={abierto} ctx={ctx} {...p} />;
}

function Menu({ abierto, ctx, menu, cerrar }: PropsMenu & { ctx: Contexto }) {
  const acciones = ACCIONES.filter((a) => !a.disponible || a.disponible(ctx));
  const elegir = (a: Accion) => { if (a.deshabilitada?.(ctx)) return; cerrar(false); a.hacer(ctx); };
  const alTeclaMenu = (e: EventoTeclado<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const sig = moverFoco(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (sig !== null) { e.preventDefault(); items[sig]?.focus(); }
    else if (e.key === 'Escape' || esTeclaMenu(e)) { e.preventDefault(); e.stopPropagation(); cerrar(true); }
    else if (e.key === 'Tab') { e.preventDefault(); cerrar(true); }
  };

  return (
    <div ref={menu} role="menu" aria-label={`Opciones: ${infoDe(ctx).titulo}`} aria-orientation="vertical"
      style={{ left: abierto.x, top: abierto.y, visibility: 'hidden' }} onKeyDown={alTeclaMenu} onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[70] min-w-44 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg animate-in fade-in-0">
      {acciones.map((a) => {
        const Icono = a.icono;
        const motivo = a.deshabilitada?.(ctx) ?? null;
        const texto = typeof a.texto === 'function' ? a.texto(ctx) : a.texto;
        return (
          <button key={a.id} type="button" role="menuitem" tabIndex={-1} onClick={() => elegir(a)} data-accion={a.id}
            aria-disabled={motivo ? true : undefined} title={motivo ?? undefined}
            className="flex min-h-11 w-full cursor-default items-center gap-2 rounded-md px-3 text-left text-sm whitespace-nowrap outline-none select-none hover:bg-muted focus:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-disabled:text-muted-foreground">
            <Icono className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {motivo && motivo !== texto ? <span className="flex flex-col py-1">{texto}<span className="text-[12.5px] text-texto-3">{motivo}</span></span> : texto}
          </button>
        );
      })}
    </div>
  );
}
