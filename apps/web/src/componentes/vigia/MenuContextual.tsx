// Clic derecho → «Info» → Vigía lo explica. Sobre un elemento (o un ancestro) con un data-info conocido (una clave de INFO), el menú del
// navegador se cambia por este, pequeño y con el estilo de la app; fuera de ellos, en campos de texto o sobre texto
// seleccionado, el clic derecho sigue siendo el del navegador. Con teclado lo abren Shift+F10 y la tecla Menú sobre el
// elemento enfocado. ACCIONES es la lista de opciones: hoy «Info» y, sobre un enlace, abrirlo en otra pestaña (el menú
// del navegador, que lo ofrecía, ya no sale ahí).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as EventoTeclado } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Info, type LucideIcon } from 'lucide-react';
import { useGuia, type ApiGuia } from './contexto';
import { esIdInfo, INFO, type IdInfo } from './info';

const MARGEN = 8;          // px libres hasta el borde de la ventana
const ECO_TECLADO_MS = 600;  // el contextmenu que el navegador manda tras Shift+F10 / Menú ya está atendido

export type Destino = { elemento: HTMLElement; id: IdInfo };
type Abierto = Destino & { x: number; y: number; antes: HTMLElement | null };

/** Lo que una acción recibe: a quién se refiere y la guía para hablar. */
export type Contexto = { elemento: HTMLElement; id: IdInfo; guia: Pick<ApiGuia, 'decir'> };
export type Accion = { id: string; texto: string; icono: LucideIcon; disponible?: (c: Contexto) => boolean; hacer: (c: Contexto) => void };

const enlaceDe = (el: HTMLElement) => el.closest<HTMLAnchorElement>('a[href]');

export const ACCIONES: readonly Accion[] = [
  { id: 'info', texto: 'Info', icono: Info,
    hacer: ({ elemento, id, guia }) => { const i = INFO[id]; guia.decir({ objetivo: elemento, titulo: i.titulo, texto: i.texto }); } },
  { id: 'pestana', texto: 'Abrir en una pestaña nueva', icono: ExternalLink,
    disponible: ({ elemento }) => !!enlaceDe(elemento),
    hacer: ({ elemento }) => { const a = enlaceDe(elemento); if (a) window.open(a.href, '_blank', 'noopener,noreferrer'); } },
];

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/** ¿Este clic derecho es nuestro? Null deja el menú del navegador: sin data-info conocido, en un campo o con texto elegido. */
export function destinoDe(objetivo: EventTarget | null, haySeleccion = false): Destino | null {
  if (haySeleccion || !objetivo || typeof (objetivo as Element).closest !== 'function') return null;
  const el = objetivo as Element;
  if (el.closest(EDITABLE)) return null;
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

  const ctx: Contexto | null = abierto ? { elemento: abierto.elemento, id: abierto.id, guia } : null;
  const acciones = ctx ? ACCIONES.filter((a) => !a.disponible || a.disponible(ctx)) : [];

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

  if (!abierto || !ctx) return null;
  const elegir = (a: Accion) => { cerrar(false); a.hacer(ctx); };
  const alTeclaMenu = (e: EventoTeclado<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const sig = moverFoco(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (sig !== null) { e.preventDefault(); items[sig]?.focus(); }
    else if (e.key === 'Escape' || esTeclaMenu(e)) { e.preventDefault(); e.stopPropagation(); cerrar(true); }
    else if (e.key === 'Tab') { e.preventDefault(); cerrar(true); }
  };

  return createPortal(
    <div ref={menu} role="menu" aria-label={`Opciones: ${INFO[abierto.id].titulo}`} aria-orientation="vertical"
      style={{ left: abierto.x, top: abierto.y, visibility: 'hidden' }} onKeyDown={alTeclaMenu} onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[70] min-w-44 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg animate-in fade-in-0">
      {acciones.map((a) => {
        const Icono = a.icono;
        return (
          <button key={a.id} type="button" role="menuitem" tabIndex={-1} onClick={() => elegir(a)}
            className="flex min-h-11 w-full cursor-default items-center gap-2 rounded-md px-3 text-left text-sm whitespace-nowrap outline-none select-none hover:bg-muted focus:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
            <Icono className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />{a.texto}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
