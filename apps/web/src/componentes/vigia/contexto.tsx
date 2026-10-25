// Contexto de Vigía: quién la invoca y qué se le pide. Es pequeño a propósito: el personaje y el recorrido (Escena.tsx,
// con los trazos del isotipo) se cargan en diferido la primera vez que aparece. El recuerdo de «estaba invocada» va en
// localStorage['vg-vigia'] (solo '1'; sin nada más). La primera vez que alguien entra en una org, Vigía se presenta sola
// (pedido «bienvenida»); localStorage['vg-vigia-bienvenida'] = '1' recuerda que ya lo hizo. Borrar esa clave, o
// «Repetir la bienvenida» en su menú, la vuelve a mostrar.
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import type { Pose } from './formas';
import type { IdTour, PasoTour } from './tours';

/** Lo que Vigía dice sin recorrido: una burbuja corta, opcionalmente señalando algo. Textos fijos; la única excepción es
 *  la «Info» de un problema (info-hallazgos.ts), que cita su recurso: recortado, en una línea, con los controles bidi a
 *  la vista (sinBidi) y pintado como texto React, nunca como HTML. Nada más del servidor entra aquí. */
export type Dicho = {
  texto: string;
  titulo?: string;
  pose?: Pose;
  /** A quién señala: un data-guia o el propio elemento (p. ej. el que recibió el clic derecho). */
  objetivo?: string | HTMLElement;
  /** Milisegundos hasta que se calla sola; sin él, espera a que la cierren. */
  duracion?: number;
  /** Comentario de fondo (esperas largas): no roba el foco, no resalta ni oscurece la página. */
  discreto?: boolean;
};

export type Pedido =
  | { tipo: 'saludo' }                                                     // aparece y ofrece el menú
  | { tipo: 'bienvenida' }                                                 // se presenta y ofrece el recorrido
  | { tipo: 'menu' }
  | { tipo: 'tour'; id: IdTour }
  | { tipo: 'pasos'; titulo: string; pasos: readonly PasoTour[]; final?: string }   // recorrido armado al vuelo
  | { tipo: 'decir'; dicho: Dicho }
  | { tipo: 'callar' }                                                     // cierra el dicho actual y vuelve al rincón
  | { tipo: 'adios' };

export type ApiGuia = {
  visible: boolean;
  invocar: (p?: Pedido) => void;
  despedir: () => void;
  alternar: () => void;
  recorrer: (id: IdTour) => void;
  /** Explica una pantalla paso a paso: cada paso señala su `objetivo` (data-guia) con su texto. */
  explicar: (titulo: string, pasos: readonly PasoTour[], final?: string) => void;
  /** Una burbuja suelta (clic derecho → Info, ayuda al conectar, esperas largas). */
  decir: (d: Dicho) => void;
  /** Termina lo que esté diciendo con `decir`. */
  callar: () => void;
};

const CLAVE = 'vg-vigia';
const leer = () => { try { return localStorage.getItem(CLAVE) === '1'; } catch { return false; } };
const guardar = (v: boolean) => { try { if (v) localStorage.setItem(CLAVE, '1'); else localStorage.removeItem(CLAVE); } catch { /* sin almacenamiento */ } };

export const CLAVE_BIENVENIDA = 'vg-vigia-bienvenida';
const ESPERA_BIENVENIDA_MS = 900;                     // deja que la pantalla se asiente antes de aparecer
// Sin almacenamiento (modo privado estricto) no se presenta: mejor callar que repetirse en cada visita.
const toca = () => { try { return localStorage.getItem(CLAVE_BIENVENIDA) !== '1'; } catch { return false; } };
const recordar = () => { try { localStorage.setItem(CLAVE_BIENVENIDA, '1'); } catch { /* sin almacenamiento */ } };

const NADA: ApiGuia = { visible: false, invocar: () => {}, despedir: () => {}, alternar: () => {}, recorrer: () => {}, explicar: () => {}, decir: () => {}, callar: () => {} };
const Ctx = createContext<ApiGuia>(NADA);
export const useGuia = () => useContext(Ctx);

type PropsEscena = { org: string; soloLectura: boolean; pedido: Pedido | null; alAtender: () => void; alCerrar: () => void };
// Sin el chunk (despliegue nuevo a medias), no aparece: nada más se rompe.
const Escena = lazy<ComponentType<PropsEscena>>(() => import('./Escena').catch(() => ({ default: () => null })));

/** Un aviso que, si llega, va antes que la bienvenida (que queda para otra visita): p. ej. la sandbox de la demo. Debe
 *  ser estable (useState) y `alMostrar` recuerda que ya se dijo. */
export type AvisoGuia = { dicho: Dicho; alMostrar: () => void };

export function GuiaProvider({ org, soloLectura = false, aviso = null, children }: { org: string; soloLectura?: boolean; aviso?: AvisoGuia | null; children: ReactNode }) {
  const [visible, setVisible] = useState(leer);
  const [pedido, setPedido] = useState<Pedido | null>(null);
  const invocar = useCallback((p: Pedido = { tipo: 'saludo' }) => { setVisible(true); guardar(true); setPedido(p); }, []);
  const despedir = useCallback(() => setPedido({ tipo: 'adios' }), []);
  const cerrada = useCallback(() => { setVisible(false); guardar(false); setPedido(null); }, []);
  const atendido = useCallback(() => setPedido(null), []);
  // Primera visita: se recuerda al aparecer (no al terminar), así una recarga a media presentación no la repite.
  useEffect(() => {
    if (aviso) {
      const t = window.setTimeout(() => { aviso.alMostrar(); invocar({ tipo: 'decir', dicho: aviso.dicho }); }, ESPERA_BIENVENIDA_MS);
      return () => clearTimeout(t);
    }
    if (!toca()) return;
    const t = window.setTimeout(() => { recordar(); invocar({ tipo: 'bienvenida' }); }, ESPERA_BIENVENIDA_MS);
    return () => clearTimeout(t);
  }, [invocar, aviso]);
  const api = useMemo<ApiGuia>(() => ({
    visible, invocar, despedir,
    alternar: () => (visible ? despedir() : invocar()),
    recorrer: (id) => invocar({ tipo: 'tour', id }),
    explicar: (titulo, pasos, final) => invocar({ tipo: 'pasos', titulo, pasos, final }),
    decir: (dicho) => invocar({ tipo: 'decir', dicho }),
    callar: () => { if (visible) setPedido({ tipo: 'callar' }); },
  }), [visible, invocar, despedir]);
  return (
    <Ctx.Provider value={api}>
      {children}
      {visible ? (
        <Suspense fallback={null}>
          <Escena org={org} soloLectura={soloLectura} pedido={pedido} alAtender={atendido} alCerrar={cerrada} />
        </Suspense>
      ) : null}
    </Ctx.Provider>
  );
}
