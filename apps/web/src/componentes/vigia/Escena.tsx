// Escena de Vigía (se carga en diferido desde contexto.tsx): el personaje que viaja por la pantalla, su burbuja y el
// resalte del elemento que señala. Atiende los pedidos del contexto (bienvenida, saludo, menú, recorridos, decir/callar,
// adiós). En un recorrido, cada paso navega si hace falta, busca [data-guia="<objetivo>"] (el primero visible), se
// teletransporta a su lado (posicion.ts elige el hueco y la dirección), lo señala y lo explica; si el usuario hace scroll
// o cambia el tamaño, lo sigue al instante. En móvil, las entradas del riel se cambian por el botón del menú
// (adaptarPasos). Esc sale.
// Teletransporte: en el origen se deshace con glitch y píxeles (TP_IDA_MS), la caja salta sin transición y en el destino
// se rehace (TP_VUELTA_MS), con un rastro de píxeles entre los dos. Con prefers-reduced-motion, solo un fundido corto.
// decir/callar: una burbuja suelta. Uno nuevo sustituye al anterior al momento; si el objetivo y la pose no cambian, solo
// cambia el texto (sin saltar). Uno normal interrumpe el recorrido o el menú; uno `discreto` nunca interrumpe nada: si
// hay un recorrido o un mensaje abierto, se ignora (es un comentario de fondo, no vale la pena perder el paso).
// `callar` solo cierra lo dicho con `decir`: no toca recorridos ni menús.
// Los textos son fijos (tours.ts y lib/guias.ts): nunca pinta datos del servidor. Todas las esperas pasan por `pausa`,
// que se limpia al desmontar, y cada acción nueva invalida las anteriores (`vez`).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '@/componentes/ui/button';
import type { Dir, Pose } from './formas';
import type { Dicho, Pedido } from './contexto';
import { alCentro, burbuja, inicio, junto, limitar, pixeles, rastro, TAM, type Caja, type Pixel } from './posicion';
import { adaptarPasos, BIENVENIDA, ID_TOURS, textoDe, TOURS, type PasoTour } from './tours';
import { Vigia, type Fase } from './Vigia';

type Accion = { texto: string; hacer: () => void; principal?: boolean };
/** `alSalir`: qué hace Esc mientras se ve este mensaje (si no, vuelve al rincón). `discreto`: burbuja pequeña, sin
 *  botones obligatorios ni foco. */
type Mensaje = { texto: string; etiqueta?: string; titulo?: string; acciones: Accion[]; enfocar?: boolean; alSalir?: () => void; discreto?: boolean };
/** Salto en curso: `ida` se deshace en el origen, `vuelta` se rehace en el destino. */
type Salto = { id: number; fase: 'ida' | 'vuelta'; de: Caja; a: Caja };
type Recorrido = { titulo: string; pasos: readonly PasoTour[]; final?: string };

const TP_IDA_MS = 230, TP_VUELTA_MS = 300, FUNDIDO_MS = 180, ENTRADA_MS = 760, SALIDA_MS = 480, BUSCAR_MS = 2500, BUSCAR_CORTO_MS = 400, LECTURA_MS = 2600;
const calmado = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const vista = () => ({ w: innerWidth, h: innerHeight });
const cajaDe = (el: Element): Caja => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const enVista = (el: Element) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; };
const todos = (sel: string) => [...document.querySelectorAll(`[data-guia="${CSS.escape(sel)}"]`)];
const rielVisible = () => [...document.querySelectorAll('[data-guia^="nav-"]')].some(visible);
const PIXELES = pixeles(18);
/** El elemento al que apunta un dicho: un data-guia (el primero visible) o el propio elemento, si sigue en la página. */
const objetivoDe = (d: Dicho): Element | null =>
  typeof d.objetivo === 'string' ? todos(d.objetivo).find(visible) ?? null
    : d.objetivo instanceof HTMLElement && d.objetivo.isConnected && visible(d.objetivo) ? d.objetivo : null;
const estiloPixel = (p: Pixel, x: number | string, y: number | string) =>
  ({ left: x, top: y, width: p.t, height: p.t, '--dx': `${p.dx}px`, '--dy': `${p.dy}px`, '--d': `${p.d}ms` }) as CSSProperties;

function Burbuja({ m, caja, evitar, alHablar }: { m: Mensaje; caja: Caja; evitar: Caja | null; alHablar: (h: boolean) => void }) {
  const el = useRef<HTMLDivElement>(null);
  // Los dichos discretos (esperas largas, cambian cada pocos segundos) salen enteros: no se escriben letra a letra.
  const entero = calmado() || !!m.discreto;
  const [n, setN] = useState(entero ? m.texto.length : 0);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Texto que se escribe solo (la boca se mueve mientras); el lector de pantalla recibe la frase entera de una vez.
  useEffect(() => {
    if (entero) { setN(m.texto.length); return; }
    setN(0); alHablar(true);
    let i = 0;
    const t = window.setInterval(() => {
      i += 2;
      setN(Math.min(i, m.texto.length));
      if (i >= m.texto.length) { clearInterval(t); alHablar(false); }
    }, 24);
    return () => { clearInterval(t); alHablar(false); };
  }, [m.texto, entero, alHablar]);
  useLayoutEffect(() => {
    const b = el.current;
    if (!b) return;
    const p = burbuja(caja, vista(), b.offsetWidth, b.offsetHeight, evitar);
    setPos({ x: p.x, y: p.y });
  }, [caja, evitar, m, n]);
  useEffect(() => { if (m.enfocar) el.current?.querySelector<HTMLButtonElement>('[data-principal]')?.focus(); }, [m]);
  // Al cerrarse con el foco dentro, el foco vuelve al ojo de la cabecera y no se pierde en el body.
  useLayoutEffect(() => {
    const nodo = el.current;
    return () => { if (nodo?.contains(document.activeElement)) document.querySelector<HTMLElement>('[data-guia="vigia"]')?.focus(); };
  }, []);
  return (
    <div ref={el} role={m.discreto ? 'note' : 'dialog'} aria-label="Vigía, tu guía"
      className={`vg-burbuja flex flex-col rounded border bg-card ${m.discreto ? 'w-[min(240px,calc(100vw-24px))] gap-2 p-3' : 'w-[min(300px,calc(100vw-24px))] gap-3 p-4'}`}
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}>
      {m.etiqueta ? <span className="font-mono text-[10.5px] tracking-[0.14em] text-muted-foreground uppercase">{m.etiqueta}</span> : null}
      {m.titulo ? <p className={`font-semibold ${m.discreto ? 'text-[13px]' : 'text-[15px]'}`}>{m.titulo}</p> : null}
      <p className="sr-only" aria-live="polite">{m.texto}</p>
      <p aria-hidden className={m.discreto ? 'min-h-[2lh] text-[13px] leading-snug text-muted-foreground' : 'min-h-[3lh] text-[15px] leading-relaxed'}>{m.texto.slice(0, n)}</p>
      {m.acciones.length ? (
        <div className="flex flex-wrap gap-2">
          {m.acciones.map((a) => (
            <Button key={a.texto} size="chico" variant={a.principal ? 'principal' : 'fantasma'} data-principal={a.principal ? '' : undefined} onClick={a.hacer}>{a.texto}</Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function Escena({ org, soloLectura = false, pedido, alAtender, alCerrar }: {
  org: string; soloLectura?: boolean; pedido: Pedido | null; alAtender: () => void; alCerrar: () => void;
}) {
  const navegar = useNavigate();
  const lugar = useLocation();
  // La bienvenida empieza en el centro (luego «se retira al rincón»); lo demás, en el rincón.
  const [caja, setCaja] = useState<Caja>(() => (pedido?.tipo === 'bienvenida' ? alCentro(vista()) : inicio(vista())));
  const [salto, setSalto] = useState<Salto | null>(null);
  const [pose, setPose] = useState<Pose>('reposo');
  const [dir, setDir] = useState<Dir>('e');
  const [fase, setFase] = useState<Fase>('entrar');
  const [mensaje, setMensaje] = useState<Mensaje | null>(null);
  const [resalte, setResalte] = useState<Caja | null>(null);
  const [hablando, setHablando] = useState(false);
  const cajaRef = useRef(caja); cajaRef.current = caja;
  const lugarRef = useRef(lugar.pathname); lugarRef.current = lugar.pathname;
  const vez = useRef(0);                         // cada acción nueva invalida las esperas de la anterior
  const saltos = useRef(0);                      // cada salto nuevo deja sin efecto el final del anterior
  const saltando = useRef(false);
  const viajera = useRef<HTMLDivElement>(null);
  const mensajeRef = useRef(mensaje); mensajeRef.current = mensaje;
  /** El dicho a la vista (lo que dejó `decir`): a quién señala y con qué pose. null si no hay. */
  const dicho = useRef<{ el: Element | null; pose: Pose; discreto: boolean } | null>(null);
  const resaltar = useRef(true);                 // los dichos discretos siguen al objetivo sin resaltarlo
  const llegada = useRef(performance.now());
  const relojes = useRef(new Set<number>());
  const objetivo = useRef<Element | null>(null);
  const recorrido = useRef<(Recorrido & { i: number }) | null>(null);

  const pausa = (ms: number) => new Promise<void>((ok) => {
    const t = window.setTimeout(() => { relojes.current.delete(t); ok(); }, ms);
    relojes.current.add(t);
  });
  // Movimiento: con prefers-reduced-motion no se espera. Lectura: sí, el texto hay que leerlo igual.
  const esperar = async (ms: number, v: number) => { await pausa(calmado() ? 0 : ms); return vez.current === v; };
  const leer = async (ms: number, v: number) => { await pausa(ms); return vez.current === v; };
  const trasEntrada = (v: number) => esperar(Math.max(0, ENTRADA_MS - (performance.now() - llegada.current)), v);
  const nueva = () => { dicho.current = null; resaltar.current = true; return ++vez.current; };
  // Al desmontar: nada pendiente sigue adelante ni deja relojes vivos.
  useEffect(() => {
    const r = relojes.current;
    // (En desarrollo, StrictMode monta dos veces: tampoco queda un salto a medias ni un dicho que ya no se ve.)
    return () => {
      vez.current++; saltos.current++; saltando.current = false; dicho.current = null; setSalto(null);
      r.forEach((t) => clearTimeout(t)); r.clear();
    };
  }, []);

  // El salto termina siempre (dura medio segundo) aunque la acción que lo pidió quede invalidada: así nunca se queda
  // a medio deshacer. Solo otro salto lo corta, y entonces el nuevo parte de donde esté la caja.
  const saltar = useCallback(async (c: Caja, v: number) => {
    const de = cajaRef.current;
    if (Math.abs(c.x - de.x) + Math.abs(c.y - de.y) < 4) { setCaja(c); return vez.current === v; }
    const id = ++saltos.current;
    if (calmado()) {
      setSalto(null); saltando.current = false; setCaja(c);
      viajera.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FUNDIDO_MS, easing: 'ease-out' });
      return vez.current === v;
    }
    saltando.current = true;
    setSalto({ id, fase: 'ida', de, a: c });
    await pausa(TP_IDA_MS);
    if (saltos.current !== id) return false;
    setCaja(c); setSalto({ id, fase: 'vuelta', de, a: c });
    await pausa(TP_VUELTA_MS);
    if (saltos.current !== id) return false;
    saltando.current = false; setSalto(null);
    return vez.current === v;
  }, []);

  const quieta = useCallback(() => {
    setPose('reposo'); setMensaje(null); setResalte(null); objetivo.current = null; recorrido.current = null; dicho.current = null;
  }, []);

  const alRincon = useCallback(async () => {
    const v = nueva();
    quieta();
    if (await saltar(inicio(vista()), v)) setPose('reposo');
  }, [quieta, saltar]);

  const despedirse = useCallback(async () => {
    const v = nueva();
    quieta(); setFase('salir');
    if (await esperar(SALIDA_MS, v)) alCerrar();
  }, [alCerrar, quieta]);

  // «Ahora no» de la bienvenida: vuelve al rincón, recuerda dónde está el ojo y se va.
  const retirarse = useCallback(async (texto: string) => {
    const v = nueva();
    quieta();
    if (!(await saltar(inicio(vista()), v))) return;
    setPose('reposo');
    setMensaje({ texto, acciones: [], alSalir: () => void despedirse() });
    if (await leer(LECTURA_MS, v)) void despedirse();
  }, [despedirse, quieta, saltar]);

  const buscar = async (sel: string, v: number, navego: boolean): Promise<Element | null> => {
    // Si ya está en la página pero no se ve (el riel oculto en móvil), no hace falta esperar a que aparezca.
    const fin = performance.now() + (navego || !todos(sel).length ? BUSCAR_MS : BUSCAR_CORTO_MS);
    for (;;) {
      if (vez.current !== v) return null;
      const el = todos(sel).find(visible);
      if (el) return el;
      if (performance.now() >= fin) return null;
      await pausa(120);
    }
  };

  const terminar = useCallback(async (final?: string) => {
    const v = nueva();
    recorrido.current = null; objetivo.current = null; setResalte(null); setMensaje(null);
    if (!(await saltar(inicio(vista()), v))) return;
    setPose('celebrar');
    setMensaje({ texto: final ?? '¡Listo!', acciones: [{ texto: 'Gracias', principal: true, hacer: () => quieta() }], enfocar: true });
    if (await esperar(2600, v)) setPose('reposo');
  }, [quieta, saltar]);

  const irPaso = useCallback(async (i: number) => {
    const r = recorrido.current;
    if (!r) return;
    const paso = r.pasos[i];
    if (!paso) { void terminar(r.final); return; }
    r.i = i;
    const v = nueva();
    const n = r.pasos.length;
    const etiqueta = `${r.titulo} · ${i + 1}/${n}`;
    const salir = { texto: 'Salir', hacer: () => void alRincon() };
    const siguiente = { texto: i + 1 < n ? 'Siguiente' : 'Terminar', principal: true, hacer: () => void irPaso(i + 1) };
    const atras = i > 0 ? [{ texto: 'Atrás', hacer: () => void irPaso(i - 1) }] : [];
    setMensaje(null);
    const navego = !!paso.ruta && !lugarRef.current.endsWith(`/${paso.ruta}`);
    if (navego) navegar(`/o/${org}/${paso.ruta}`);
    const el = await buscar(paso.objetivo, v, navego);
    if (vez.current !== v) return;
    if (!el) {
      objetivo.current = null; setResalte(null); setPose('pensar');
      setMensaje({ etiqueta, texto: 'No encuentro eso en esta pantalla. Si el menú está plegado, ábrelo y vuelve a intentarlo.',
        acciones: [...atras, siguiente, salir], enfocar: true });
      return;
    }
    if (!enVista(el)) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: calmado() ? 'auto' : 'smooth' });
      if (!(await esperar(360, v))) return;
    }
    objetivo.current = el;
    const rect = cajaDe(el);
    setResalte(rect);
    if (!(await saltar(junto(rect, vista()).caja, v))) return;
    // Al llegar se vuelve a medir: la página pudo terminar de cargar y empujarlo fuera de la vista durante el vuelo.
    if (!enVista(el)) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    const ahora = cajaDe(el), sitio = junto(ahora, vista());
    setResalte(ahora); setCaja(sitio.caja); setDir(sitio.dir); setPose('apuntar');
    setMensaje({ etiqueta, texto: textoDe(paso, soloLectura), acciones: [...atras, siguiente, salir], enfocar: true });
  }, [alRincon, navegar, org, soloLectura, terminar, saltar]);

  const empezar = useCallback((r: Recorrido) => {
    recorrido.current = { ...r, pasos: adaptarPasos(r.pasos, rielVisible()), i: 0 };
    void irPaso(0);
  }, [irPaso]);

  // Bienvenida (primera visita o «Repetir la bienvenida»): saluda, se presenta, cuenta qué puede hacer y ofrece el
  // recorrido. «Ahora no» o Esc: se retira al rincón y se va (el ojo de la cabecera la vuelve a llamar).
  const presentar = useCallback(async () => {
    const v = nueva();
    recorrido.current = null; objetivo.current = null; setResalte(null); setMensaje(null);
    if (!(await trasEntrada(v))) return;
    if (!(await saltar(alCentro(vista()), v))) return;
    const no = () => void retirarse(BIENVENIDA.despedida);
    const ahoraNo: Accion = { texto: 'Ahora no', hacer: no };
    const decir = (p: Pose, texto: string, acciones: Accion[], enfocar = true) =>
      { setPose(p); setMensaje({ etiqueta: 'Bienvenida', texto, acciones, enfocar, alSalir: no }); };
    const oferta = () => decir('hablar', BIENVENIDA.oferta,
      [{ texto: 'Hacer el recorrido', principal: true, hacer: () => empezar(TOURS.bienvenida) }, ahoraNo]);
    const futuro = () => decir('reparar', BIENVENIDA.futuro, [{ texto: 'Seguir', principal: true, hacer: oferta }, ahoraNo]);
    const ayuda = () => decir('hablar', BIENVENIDA.ayuda, [{ texto: 'Seguir', principal: true, hacer: futuro }, ahoraNo]);
    // El primer mensaje no roba el foco: nadie lo pidió todavía.
    decir('saludar', BIENVENIDA.saludo, [{ texto: '¡Hola, Vigía!', principal: true, hacer: ayuda }, ahoraNo], false);
  }, [empezar, retirarse, saltar]);

  // «callar» cierra el dicho y vuelve al rincón (no la despide). Si no hay dicho, no toca nada.
  const callar = useCallback(async () => {
    if (!dicho.current) return;
    const v = nueva();
    quieta();
    if (await saltar(inicio(vista()), v)) setPose('reposo');
  }, [quieta, saltar]);

  const decir = useCallback(async (d: Dicho) => {
    if (d.discreto && (recorrido.current || (mensajeRef.current && !dicho.current))) return;
    let el = objetivoDe(d);
    // Uno discreto no mueve la página: si su objetivo no se ve, habla desde el rincón.
    if (el && d.discreto && !enVista(el)) el = null;
    const pose: Pose = d.pose ?? (el ? 'apuntar' : 'hablar');
    const antes = dicho.current;
    const mismo = !!antes && antes.el === el && antes.pose === pose;
    const v = nueva();
    recorrido.current = null;
    dicho.current = { el, pose, discreto: !!d.discreto };
    resaltar.current = !d.discreto;
    const cerrar = () => void callar();
    const m: Mensaje = {
      titulo: d.titulo, texto: d.texto, discreto: d.discreto, enfocar: !d.discreto && !mismo, alSalir: cerrar,
      acciones: d.discreto ? [] : [{ texto: 'Entendido', principal: true, hacer: cerrar }],
    };
    if (mismo) { setPose(pose); if (el) setDir(junto(cajaDe(el), vista()).dir); }
    else {
      setMensaje(null);
      objetivo.current = el;
      if (el && !enVista(el)) {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: calmado() ? 'auto' : 'smooth' });
        if (!(await esperar(360, v))) return;
      }
      setResalte(el && !d.discreto ? cajaDe(el) : null);
      const sitio = el ? junto(cajaDe(el), vista()) : null;
      if (!(await saltar(sitio?.caja ?? inicio(vista()), v))) return;
      if (el) { const ahora = cajaDe(el), s2 = junto(ahora, vista()); setCaja(s2.caja); setDir(s2.dir); if (!d.discreto) setResalte(ahora); }
      setPose(pose);
    }
    setMensaje(m);
    if (d.duracion && d.duracion > 0 && await leer(d.duracion, v)) void callar();
  }, [callar, quieta, saltar]);

  const menu = useCallback(async (saludo = false) => {
    const v = nueva();
    recorrido.current = null; objetivo.current = null; setResalte(null);
    if (saludo && !(await trasEntrada(v))) return;
    setPose(saludo ? 'saludar' : 'hablar');
    setMensaje({
      texto: saludo ? '¡Hola! Soy Vigía, tu guía en VanGUARD. ¿Te enseño algo?' : '¿En qué te ayudo?',
      acciones: [
        ...ID_TOURS.map((id, k) => id === 'bienvenida'
          ? { texto: 'Repetir la bienvenida', hacer: () => void presentar() }
          : { texto: TOURS[id].titulo, principal: k === 0, hacer: () => empezar(TOURS[id]) }),
        { texto: 'Ahora no', hacer: () => quieta() },
        { texto: 'Adiós', hacer: () => void despedirse() },
      ],
      enfocar: !saludo,
    });
  }, [despedirse, empezar, presentar, quieta]);

  // Entrada: aparece con su animación; después atiende lo que le pidan.
  useEffect(() => { const t = window.setTimeout(() => setFase('quieta'), calmado() ? 0 : ENTRADA_MS); return () => clearTimeout(t); }, []);
  useEffect(() => {
    if (!pedido) return;
    alAtender();
    switch (pedido.tipo) {
      case 'saludo': void menu(true); break;
      case 'bienvenida': void presentar(); break;
      case 'menu': void menu(); break;
      case 'tour': empezar(TOURS[pedido.id]); break;
      case 'pasos': empezar({ titulo: pedido.titulo, pasos: pedido.pasos, final: pedido.final }); break;
      case 'decir': void decir(pedido.dicho); break;
      case 'callar': void callar(); break;
      case 'adios': void despedirse(); break;
    }
  }, [pedido, alAtender, menu, presentar, empezar, decir, callar, despedirse]);

  // Sigue al objetivo con el scroll y el tamaño de la ventana (sin volar); fuera de un recorrido, se queda en pantalla.
  useEffect(() => {
    let cuadro = 0;
    const ajustar = () => {
      cancelAnimationFrame(cuadro);
      cuadro = requestAnimationFrame(() => {
        const el = objetivo.current;
        if (saltando.current) return;          // el salto ya va hacia su sitio; al llegar se vuelve a medir
        if (el && el.isConnected && visible(el)) {
          const rect = cajaDe(el), sitio = junto(rect, vista());
          if (resaltar.current) setResalte(rect);
          setCaja(sitio.caja); setDir(sitio.dir);
        } else if (el) setResalte(null);
        else setCaja((c) => limitar(c, vista()));
      });
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !(recorrido.current || mensaje)) return;
      if (mensaje?.alSalir) mensaje.alSalir(); else void alRincon();
    };
    // La página también se mueve sin scroll (termina de cargar, se abre un desplegable): se vigila el tamaño del body.
    const cambios = typeof ResizeObserver === 'function' ? new ResizeObserver(ajustar) : null;
    cambios?.observe(document.body);
    addEventListener('scroll', ajustar, { capture: true, passive: true });
    addEventListener('resize', ajustar, { passive: true });
    addEventListener('keydown', tecla);
    return () => {
      cancelAnimationFrame(cuadro); cambios?.disconnect();
      removeEventListener('scroll', ajustar, { capture: true }); removeEventListener('resize', ajustar); removeEventListener('keydown', tecla);
    };
  }, [mensaje, alRincon]);

  const alHablar = useCallback((h: boolean) => setHablando(h), []);
  return (
    <>
      {resalte ? <div className="vg-resalte" aria-hidden style={{ left: resalte.x - 4, top: resalte.y - 4, width: resalte.w + 8, height: resalte.h + 8 }} /> : null}
      {salto ? (
        <div key={salto.id} className="vg-rastro" aria-hidden>
          {rastro(salto.de, salto.a, 12).map((p, i) => <i key={i} className={`vg-pixel vg-pixel-${p.tono}`} style={estiloPixel(p, p.x, p.y)} />)}
        </div>
      ) : null}
      <div ref={viajera} className="vg-viajera" data-salto={salto?.fase}
        style={{ transform: `translate(${caja.x}px, ${caja.y}px)`, width: TAM.w, height: TAM.h }}>
        <button type="button" aria-label="Vigía, tu guía: abrir su menú" onClick={() => (mensaje ? (dicho.current ? void callar() : quieta()) : void menu())} className="size-full rounded outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Vigia pose={pose} dir={dir} fase={fase} hablando={hablando} className="size-full" />
        </button>
        {salto ? (
          <div key={`${salto.id}-${salto.fase}`} className="vg-pixeles" aria-hidden>
            {PIXELES.map((p, i) => <i key={i} className={`vg-pixel vg-pixel-${p.tono}`} style={estiloPixel(p, `${p.x}%`, `${p.y}%`)} />)}
          </div>
        ) : null}
      </div>
      {mensaje ? <Burbuja m={mensaje} caja={caja} evitar={resalte} alHablar={alHablar} /> : null}
    </>
  );
}
