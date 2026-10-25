// Menú del clic derecho (sin jsdom, como el resto de pruebas: la lógica va en funciones puras). Se abre sobre un
// data-info conocido o un descendiente; fuera, en campos o con texto elegido sigue el del navegador; Shift+F10 y la
// tecla Menú lo abren; las flechas recorren las opciones; cabe en la ventana; «Info» pide a Vigía el texto de INFO.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Dicho } from './contexto';
import { INFO } from './info';
import { ACCIONES, colocar, destinoDe, esTeclaMenu, MenuContextual, moverFoco } from './MenuContextual';

// Un DOM mínimo: lo justo para closest() y getAttribute() con los selectores que usa el menú.
class Nodo {
  readonly tag: string; readonly attrs: Record<string, string>; readonly padre: Nodo | null;
  constructor(tag: string, attrs: Record<string, string> = {}, padre: Nodo | null = null) { this.tag = tag; this.attrs = attrs; this.padre = padre; }
  hijo(tag: string, attrs: Record<string, string> = {}) { return new Nodo(tag, attrs, this); }
  getAttribute(a: string) { return Object.hasOwn(this.attrs, a) ? this.attrs[a]! : null; }
  private cumple(sel: string) {
    const m = sel.trim().match(/^([a-z]*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
    if (!m) throw new Error(`selector sin soporte: ${sel}`);
    const [, tag, attr, valor] = m;
    return (!tag || tag === this.tag) && (!attr || (valor === undefined ? this.getAttribute(attr) !== null : this.getAttribute(attr) === valor));
  }
  closest(sel: string): Nodo | null {
    for (let n: Nodo | null = this; n; n = n.padre) if (sel.split(',').some((s) => n!.cumple(s))) return n;
    return null;
  }
}
const como = (n: Nodo) => n as unknown as EventTarget;

describe('destinoDe', () => {
  const raiz = new Nodo('main');
  const tarjeta = raiz.hijo('div', { 'data-info': 'puntaje-blindaje' });
  const cifra = tarjeta.hijo('span');

  it('sobre el elemento con data-info, o dentro de él, abre con ese elemento', () => {
    expect(destinoDe(como(tarjeta))).toEqual({ elemento: tarjeta, id: 'puntaje-blindaje' });
    expect(destinoDe(como(cifra))).toEqual({ elemento: tarjeta, id: 'puntaje-blindaje' });
  });

  it('el data-info más cercano manda', () => {
    const chapa = tarjeta.hijo('span', { 'data-info': 'severidad' }).hijo('svg');
    expect(destinoDe(como(chapa))?.id).toBe('severidad');
  });

  it('fuera de un data-info, el menú del navegador', () => {
    expect(destinoDe(como(raiz.hijo('p')))).toBeNull();
    expect(destinoDe(null)).toBeNull();
    expect(destinoDe({} as EventTarget)).toBeNull();          // window, document…: sin closest
  });

  it('un id que no está en INFO (o «__proto__») no abre', () => {
    expect(destinoDe(como(raiz.hijo('div', { 'data-info': 'no-existe' })))).toBeNull();
    expect(destinoDe(como(raiz.hijo('div', { 'data-info': '__proto__' })))).toBeNull();
  });

  it('en inputs, textarea, select y contenteditable, el del navegador aunque estén dentro de un data-info', () => {
    const zona = raiz.hijo('div', { 'data-info': 'mcp-tokens' });
    for (const campo of [zona.hijo('input'), zona.hijo('textarea'), zona.hijo('select'), zona.hijo('div', { contenteditable: 'true' }).hijo('b')])
      expect(destinoDe(como(campo))).toBeNull();
  });

  it('con texto seleccionado, el del navegador (para copiarlo)', () => {
    expect(destinoDe(como(cifra), true)).toBeNull();
  });
});

describe('teclado', () => {
  const t = (key: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}) =>
    ({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods });

  it('Shift+F10 y la tecla Menú abren; F10 solo o con Ctrl no', () => {
    expect(esTeclaMenu(t('F10', { shiftKey: true }))).toBe(true);
    expect(esTeclaMenu(t('ContextMenu'))).toBe(true);
    expect(esTeclaMenu(t('F10'))).toBe(false);
    expect(esTeclaMenu(t('F10', { shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(esTeclaMenu(t('Escape'))).toBe(false);
  });

  it('las flechas recorren las opciones y dan la vuelta; Inicio y Fin van a los extremos', () => {
    expect(moverFoco('ArrowDown', 0, 2)).toBe(1);
    expect(moverFoco('ArrowDown', 1, 2)).toBe(0);
    expect(moverFoco('ArrowUp', 0, 2)).toBe(1);
    expect(moverFoco('ArrowUp', -1, 3)).toBe(1);               // sin opción enfocada, desde abajo
    expect(moverFoco('Home', 2, 3)).toBe(0);
    expect(moverFoco('End', 0, 3)).toBe(2);
    expect(moverFoco('Enter', 0, 3)).toBeNull();               // Enter y Espacio los atiende el propio botón
    expect(moverFoco('ArrowDown', 0, 0)).toBeNull();
  });
});

describe('colocar', () => {
  it('donde se hizo clic, si cabe', () => {
    expect(colocar(100, 200, 180, 60, 1280, 720)).toEqual({ left: 100, top: 200 });
  });

  it('cerca del borde derecho o del de abajo, se da la vuelta', () => {
    expect(colocar(1250, 700, 180, 60, 1280, 720)).toEqual({ left: 1070, top: 640 });
  });

  it('nunca se sale de la ventana, ni en un móvil estrecho', () => {
    const { left, top } = colocar(100, 10, 300, 60, 320, 640);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + 300).toBeLessThanOrEqual(320 - 8);
    expect(top).toBe(10);
  });
});

describe('ACCIONES', () => {
  const guia = () => ({ decir: vi.fn<(d: Dicho) => void>() });
  const elemento = { closest: () => null } as unknown as HTMLElement;

  it('la primera es «Info» y siempre está', () => {
    expect(ACCIONES[0]?.texto).toBe('Info');
    expect(ACCIONES[0]?.disponible).toBeUndefined();
  });

  it('«Info» pide a Vigía el título y el texto de INFO señalando al propio elemento', () => {
    const g = guia();
    ACCIONES[0]!.hacer({ elemento, id: 'puntaje-blindaje', guia: g });
    expect(g.decir).toHaveBeenCalledExactlyOnceWith({ objetivo: elemento, titulo: INFO['puntaje-blindaje'].titulo, texto: INFO['puntaje-blindaje'].texto });
  });

  it('«Abrir en una pestaña nueva» solo sobre un enlace', () => {
    const pestana = ACCIONES.find((a) => a.id === 'pestana')!;
    const enlace = new Nodo('a', { href: '/o/x/supabase', 'data-info': 'nav-supabase' });
    expect(pestana.disponible?.({ elemento: enlace as unknown as HTMLElement, id: 'nav-supabase', guia: guia() })).toBe(true);
    expect(pestana.disponible?.({ elemento, id: 'puntaje-blindaje', guia: guia() })).toBe(false);
  });

  it('cada acción tiene id único, texto e icono', () => {
    expect(new Set(ACCIONES.map((a) => a.id)).size).toBe(ACCIONES.length);
    for (const a of ACCIONES) { expect(a.texto).toBeTruthy(); expect(a.icono).toBeTruthy(); }
  });
});

describe('MenuContextual', () => {
  it('cerrado no pinta nada', () => {
    expect(renderToStaticMarkup(<MenuContextual />)).toBe('');
  });
});
