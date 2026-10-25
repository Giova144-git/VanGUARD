// Menú del clic derecho (sin jsdom, como el resto de pruebas: la lógica va en funciones puras). Se abre sobre un
// data-info conocido o un descendiente; fuera, en campos o con texto elegido sigue el del navegador; Shift+F10 y la
// tecla Menú lo abren; las flechas recorren las opciones; cabe en la ventana; «Info» pide a Vigía el texto de INFO.
// Sobre un problema (data-hallazgo), «Info» explica ESE problema y «Enviar a mi IA» / «Cancelar envío» hacen lo del botón.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FixRequest } from '@vanguard/contracts';
import { SOLO_LECTURA } from '@/app/guardas';
import { abrirEnlace, enlaceEnviar } from '@/modulos/hallazgos/EnviarAMiIA';
import type { Dicho } from './contexto';
import { INFO } from './info';
import { infoDeHallazgo, marcaHallazgo, type DatosHallazgo } from './info-hallazgos';
import { ACCIONES, colocar, datosHallazgo, destinoDe, esTeclaMenu, infoDe, MenuContextual, moverFoco, type Contexto, type IAContexto } from './MenuContextual';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

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

describe('destinoDe · problemas', () => {
  const ID = 'c3d40000-0000-4000-8000-000000000001';
  const lista = new Nodo('ul', { 'data-info': 'ahora' });
  const fila = lista.hijo('li', { 'data-hallazgo': ID });
  const chapa = fila.hijo('span', { 'data-info': 'severidad' }).hijo('svg');

  it('dentro de la fila de un problema manda el problema, también sobre su chapa de gravedad', () => {
    expect(destinoDe(como(fila))).toEqual({ elemento: fila, id: null, hallazgo: ID });
    expect(destinoDe(como(chapa))).toEqual({ elemento: fila, id: null, hallazgo: ID });
  });

  it('un data-hallazgo que no es un UUID no cuenta: sigue el data-info de alrededor', () => {
    const mala = lista.hijo('li', { 'data-hallazgo': `${ID}/../x` }).hijo('span');
    expect(destinoDe(como(mala))).toEqual({ elemento: lista, id: 'ahora' });
  });

  it('en un campo dentro de la fila, el menú del navegador', () => {
    expect(destinoDe(como(fila.hijo('input')))).toBeNull();
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

describe('ACCIONES · problemas', () => {
  const ID = 'c3d40000-0000-4000-8000-000000000002';
  const elemento = { closest: () => null } as unknown as HTMLElement;
  const h: DatosHallazgo = { id: ID, module: 'supabase', rule_id: 'SB_RLS_DISABLED', severity: 'critical', resource: 'public.pedidos',
    connection_id: 'a0000000-0000-4000-8000-000000000001', status: 'open' };
  const envio = (status: FixRequest['status']): FixRequest => ({ id: 'f1c00000-0000-4000-8000-000000000001', finding_id: ID, status,
    client: 'claude_code', created_at: '2026-10-24T19:30:00.000Z', started_at: null, closed_at: null });
  const ia = (o: Partial<IAContexto> = {}): IAContexto => ({ bloqueo: null, envioDe: () => null, repoDe: () => 'acme/tienda',
    enviarYAbrir: vi.fn(), cancelar: vi.fn(), ...o });
  const ctx = (o: Partial<Contexto> = {}): Contexto => ({ elemento, id: null, hallazgo: h, guia: { decir: vi.fn<(d: Dicho) => void>() }, ia: ia(), ...o });
  const accion = (id: string) => ACCIONES.find((a) => a.id === id)!;
  const texto = (id: string, c: Contexto) => { const t = accion(id).texto; return typeof t === 'function' ? t(c) : t; };
  const visibles = (c: Contexto) => ACCIONES.filter((a) => !a.disponible || a.disponible(c)).map((a) => a.id);

  it('«Info» explica ESE problema (regla, recurso y gravedad) señalando su fila', () => {
    const c = ctx();
    accion('info').hacer(c);
    const i = infoDeHallazgo(h);
    expect(c.guia.decir).toHaveBeenCalledExactlyOnceWith({ objetivo: elemento, titulo: i.titulo, texto: i.texto });
    expect(i.texto).toContain('«public.pedidos»');
    expect(infoDe(c).titulo).toBe('Tabla sin RLS');
  });

  it('en un problema: Info y Enviar a mi IA; fuera de uno, «Enviar» no sale', () => {
    expect(visibles(ctx())).toEqual(['info', 'enviar-ia']);
    expect(visibles({ elemento, id: 'puntaje-blindaje', guia: { decir: vi.fn() } })).toEqual(['info']);
  });

  it('«Enviar a mi IA» hace lo del botón en el repo del hallazgo, sin confirmar, y señala la fila', () => {
    const c = ctx({ ia: ia({ repoDe: (x) => (x === h.connection_id ? 'acme/tienda' : null) }) });
    expect(texto('enviar-ia', c)).toBe('Enviar a mi IA');
    expect(accion('enviar-ia').deshabilitada?.(c)).toBeNull();
    accion('enviar-ia').hacer(c);
    expect(c.ia!.enviarYAbrir).toHaveBeenCalledExactlyOnceWith(ID, 'acme/tienda', elemento);
  });

  it('viewer o demo: sale apagada con su motivo y no hace nada; tampoco se ofrece cancelar', () => {
    const c = ctx({ ia: ia({ bloqueo: SOLO_LECTURA, envioDe: () => envio('enviado') }) });
    expect(accion('enviar-ia').deshabilitada?.(c)).toBe(SOLO_LECTURA);
    accion('enviar-ia').hacer(c);
    expect(c.ia!.enviarYAbrir).not.toHaveBeenCalled();
    expect(visibles(c)).not.toContain('cancelar-ia');
  });

  it('con una petición abierta: «Ya enviado a tu IA», apagada, y «Cancelar envío»', () => {
    for (const st of ['enviado', 'arreglando'] as const) {
      const c = ctx({ ia: ia({ envioDe: () => envio(st) }) });
      expect(texto('enviar-ia', c)).toBe('Ya enviado a tu IA');
      expect(accion('enviar-ia').deshabilitada?.(c)).toBeTruthy();
      expect(visibles(c)).toEqual(['info', 'enviar-ia', 'cancelar-ia']);
      accion('cancelar-ia').hacer(c);
      expect(c.ia!.cancelar).toHaveBeenCalledExactlyOnceWith(ID);
    }
  });

  it('cancelada o corregida se puede volver a enviar; un hallazgo ya cerrado, no', () => {
    for (const st of ['cancelado', 'corregido'] as const) {
      const c = ctx({ ia: ia({ envioDe: () => envio(st) }) });
      expect(texto('enviar-ia', c)).toBe('Enviar a mi IA');
      expect(accion('enviar-ia').deshabilitada?.(c)).toBeNull();
    }
    expect(accion('enviar-ia').deshabilitada?.(ctx({ hallazgo: { ...h, status: 'fixed' } }))).toBe('Ya no está abierto');
  });
});

describe('datosHallazgo (sin volver a pedirlo)', () => {
  const ORG = 'b1000000-0000-4000-8000-000000000001';
  const ID = 'c3d40000-0000-4000-8000-000000000003';
  const f = { id: ID, module: 'codebase', rule_id: 'CB_ENV_COMMITTED', severity: 'high', resource: '.env', connection_id: null, status: 'open' };
  const qc = (detalle?: unknown, listas: unknown[] = [], overview?: unknown) => ({
    getQueryData: (k: readonly unknown[]) => (k[2] === 'finding' ? detalle : k[2] === 'overview' ? overview : undefined),
    getQueriesData: () => listas.map((l) => [['org', ORG, 'findings', {}], l]),
  }) as never;

  it('del detalle, de una lista o del «Ahora» del resumen en caché', () => {
    expect(datosHallazgo(qc(f), ORG, ID)).toMatchObject({ rule_id: 'CB_ENV_COMMITTED', severity: 'high', resource: '.env', status: 'open' });
    expect(datosHallazgo(qc(undefined, [[{ ...f, id: 'otro' }], [f]]), ORG, ID)).toMatchObject({ severity: 'high' });
    expect(datosHallazgo(qc(undefined, [], { ahora: [{ ...f, kind: 'finding' }] }), ORG, ID)).toMatchObject({ rule_id: 'CB_ENV_COMMITTED' });
  });

  it('si no está en caché, lo que anotó la fila; y si tampoco, solo el id', () => {
    const OTRO = 'c3d40000-0000-4000-8000-000000000004';
    marcaHallazgo({ id: OTRO, rule_id: 'SB_RLS_DISABLED', rol: 'mal', resource: 'public.x' });
    expect(datosHallazgo(qc(), ORG, OTRO)).toMatchObject({ rule_id: 'SB_RLS_DISABLED', rol: 'mal' });
    expect(datosHallazgo(null, ORG, 'c3d40000-0000-4000-8000-000000000005')).toEqual({ id: 'c3d40000-0000-4000-8000-000000000005' });
  });
});

describe('abrirEnlace', () => {
  it('un clic sobre un <a href> de verdad dentro del documento (como el botón), que luego se quita', () => {
    const hechos: string[] = [];
    const a = { href: '', rel: '', hidden: false, click: () => hechos.push(`click ${a.href}`), remove: () => hechos.push('remove') };
    const doc = { createElement: (t: string) => { hechos.push(`crear ${t}`); return a; }, body: { append: () => hechos.push('append') } };
    vi.stubGlobal('document', doc);
    try {
      const href = enlaceEnviar('c3d40000-0000-4000-8000-000000000001', 'acme/tienda');
      abrirEnlace(href);
      expect(href).toBe('claude-cli://open?repo=acme/tienda&q=%2Fmcp__vanguard__resolver_hallazgo%20c3d40000-0000-4000-8000-000000000001');
      expect(hechos).toEqual(['crear a', 'append', `click ${href}`, 'remove']);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('MenuContextual', () => {
  it('cerrado no pinta nada', () => {
    expect(renderToStaticMarkup(<MenuContextual />)).toBe('');
  });
});
