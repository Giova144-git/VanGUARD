// Vigía acompaña una espera larga (auditoría, medición; luego la wiki): mientras dura, comenta en voz baja qué se está
// revisando y, al terminar, lo celebra o avisa. Reglas:
// - Solo habla si ya estaba a la vista cuando empezó la espera. No aparece sola: si alguien la tenía despedida, la espera
//   pasa en silencio. Si se la llama a mitad, tampoco interrumpe (atiende lo que le pidan).
// - Las frases van con `discreto: true` (no roban el foco ni oscurecen) y rotan cada CADA_MS, en orden y en bucle. Si
//   cambian (otro paso), empieza por la primera de las nuevas.
// - Si alguien la despide a mitad, deja de comentar esa espera y tampoco dice el final.
// - Al terminar: 'bien' → celebrar; 'alerta' → alerta; 'fallo' → un aviso breve. Las tres con DURACION_FIN_MS, y solo si
//   estuvo comentando esa espera (abrir una auditoría ya terminada no la celebra).
// - Si la espera desaparece sin final (se sale de la pantalla, se desmonta), se calla.
// La lógica vive en crearEspera (sin React, se prueba con relojes falsos); useEspera solo la ata al ciclo del componente.
import { useEffect, useRef, useState } from 'react';
import { useGuia, type ApiGuia } from './contexto';
import { CADA_MS, DURACION_FIN_MS, type FinEspera } from './esperas';

export type FaseEspera = 'inactiva' | 'esperando' | 'bien' | 'alerta' | 'fallo';
type Guia = Pick<ApiGuia, 'visible' | 'decir' | 'callar'>;
type Reloj = { cada: (f: () => void, ms: number) => unknown; parar: (t: unknown) => void };
const RELOJ: Reloj = { cada: (f, ms) => setInterval(f, ms), parar: (t) => clearInterval(t as ReturnType<typeof setInterval>) };

export function crearEspera(guia: () => Guia, o: { cadaMs?: number; reloj?: Reloj } = {}) {
  const cadaMs = o.cadaMs ?? CADA_MS;
  const reloj = o.reloj ?? RELOJ;
  let decidida = false;        // ya se miró, al empezar esta espera, si Vigía estaba a la vista
  let hablando = false;        // comenta esta espera
  let clave = '';
  let textos: readonly string[] = [];
  let i = 0;
  let timer: unknown = null;

  const pararTimer = () => { if (timer !== null) reloj.parar(timer); timer = null; };
  const decirTexto = () => guia().decir({ texto: textos[i % textos.length]!, pose: 'pensar', discreto: true });
  const tic = () => {
    if (!guia().visible) { pararTimer(); hablando = false; return; }   // la despidieron: esta espera ya no la comenta
    i = (i + 1) % textos.length;
    decirTexto();
  };
  const empezar = (t: readonly string[]) => {
    pararTimer();
    textos = t; clave = t.join('\n'); i = 0;
    decirTexto();
    if (t.length > 1) timer = reloj.cada(tic, cadaMs);
  };
  const reiniciar = () => { pararTimer(); decidida = false; hablando = false; clave = ''; textos = []; i = 0; };

  return {
    actualizar(fase: FaseEspera, t: readonly string[], fin: FinEspera) {
      if (fase === 'esperando') {
        if (!decidida) { decidida = true; hablando = guia().visible && t.length > 0; if (hablando) empezar(t); return; }
        if (hablando && t.length > 0 && t.join('\n') !== clave) empezar(t);
        return;
      }
      const habia = hablando;
      reiniciar();
      if (!habia) return;
      if (fase === 'inactiva') { guia().callar(); return; }
      if (!guia().visible) return;
      const pose = fase === 'bien' ? 'celebrar' : 'alerta';
      guia().decir({ texto: fin[fase], pose, duracion: DURACION_FIN_MS, discreto: true });
    },
    /** Al desmontar: sin timers; si estaba comentando, se calla. */
    parar() { const habia = hablando; reiniciar(); if (habia) guia().callar(); },
  };
}

/** `textos`: las frases de ahora (textosEspera); `fin`: las del final (ESPERAS[id].fin). */
export function useEspera(fase: FaseEspera, textos: readonly string[], fin: FinEspera) {
  const guia = useGuia();
  const actual = useRef<Guia>(guia);
  useEffect(() => { actual.current = guia; }, [guia]);
  const [espera] = useState(() => crearEspera(() => actual.current));
  const clave = textos.join('\n');
  const ultimo = useRef({ textos, fin });
  useEffect(() => { ultimo.current = { textos, fin }; });
  // Solo la fase y el contenido de las frases mueven la espera: un array nuevo con las mismas frases no la reinicia.
  useEffect(() => { espera.actualizar(fase, ultimo.current.textos, ultimo.current.fin); }, [espera, fase, clave]);
  useEffect(() => () => espera.parar(), [espera]);
}
