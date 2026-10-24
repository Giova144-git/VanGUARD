// Realtime de Supabase (P0 desde A7.5; SQL y política del BACK en 0008b_realtime.sql). Un canal privado por org que
// solo invalida claves de TanStack Query. No gasta peticiones del Worker: el WebSocket va directo a Supabase.
//
// Reintentos (verificado contra realtime-js 2.118 / @supabase/phoenix 0.4.5):
// - CHANNEL_ERROR y TIMED_OUT (p. ej. el tenant de Realtime arrancando): phoenix vuelve a unir el MISMO canal solo, con
//   backoff 1 s, 2 s, 5 s y luego 10 s, y otra vez al reabrir el socket. Aquí solo se pasa al respaldo de 10 s.
// - CLOSED que no provocamos: phoenix ya no reintenta, así que se crea un canal nuevo con BACKOFF_MS.
// - La suscripción es síncrona: devuelve la limpieza al momento. Si no, el doble montaje de StrictMode y el dedupe por
//   topic de supabase.channel() dejaban a la segunda montura con un canal sin callback (Realtime muerto en silencio).
// Verificado con las librerías reales y un WebSocket falso: StrictMode, tenant que rechaza joins, CLOSED del servidor,
// 60 s sin red (sin crecer el sendBuffer) y desmontar con join o reintento pendiente.
import type { QueryClient } from '@tanstack/react-query';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { RealtimeChange } from '@vanguard/contracts';
import { supabase } from './supabase';

const MAPA: Record<string, string[]> = {
  scan_runs: ['scan', 'overview'], findings: ['findings', 'finding', 'module', 'overview', 'revision'],
  incidents: ['incident', 'incidents', 'overview'], notifications: ['incident', 'revision'],   // revision: hallazgo y aviso de un push (E45)
};
export const TODO = ['overview', 'module', 'findings', 'finding', 'incidents', 'incident', 'scan', 'revision'];
export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];   // solo tras CLOSED; el último se repite
export const ESTABLE_MS = 30_000;   // el backoff vuelve a 0 solo tras este tiempo seguido en SUBSCRIBED

export function suscribirOrg(org: string, qc: QueryClient, alCambiar: (vivo: boolean) => void): () => void {
  const topic = `org:${org}`;
  // cancelRefetch: false → no corta las consultas iniciales que ya están en vuelo al entrar el canal.
  const invalidar = (claves: string[]) =>
    claves.forEach((k) => qc.invalidateQueries({ queryKey: ['org', org, k] }, { cancelRefetch: false }));
  const inval = (m: { payload?: unknown }) => {
    const r = RealtimeChange.safeParse(m.payload);                             // si no valida, se invalida todo lo de la org
    invalidar(r.success ? MAPA[r.data.table] ?? TODO : TODO);
  };
  let cerrado = false;
  let vivo = false;
  let intento = 0;
  let actual: RealtimeChannel | null = null;
  let reintento: ReturnType<typeof setTimeout> | undefined;
  let estable: ReturnType<typeof setTimeout> | undefined;
  let avisado: boolean | null = null;
  const avisar = (v: boolean) => { if (!cerrado && avisado !== v) { avisado = v; alCambiar(v); } };   // sin repetir el mismo aviso

  // Si no llega a SUBSCRIBED en 10 s (canal mudo), los hooks siguen con el respaldo sin avisar al usuario.
  const espera = setTimeout(() => { if (!vivo) avisar(false); }, 10_000);

  const programar = () => {
    if (cerrado || reintento) return;
    const ms = BACKOFF_MS[Math.min(intento, BACKOFF_MS.length - 1)]!;
    intento += 1;
    reintento = setTimeout(() => {
      reintento = undefined;
      if (cerrado) return;
      conectar().catch(() => { avisar(false); programar(); });
    }, ms);
  };

  const quitar = (c: RealtimeChannel) => {
    if (actual === c) actual = null;                                         // antes de quitarlo: su CLOSED síncrono se ignora
    void supabase.removeChannel(c);
  };

  async function conectar() {
    try { await supabase.realtime.setAuth(); } catch { /* sin sesión todavía: el join fallará y phoenix reintenta */ }
    if (cerrado) return;
    // Sin «defensa» que quite canales del mismo topic: con la limpieza síncrona y el leave síncrono de phoenix no queda
    // ningún huérfano, y quitar el canal de otra suscripción viva provocaría que se lo robaran la una a la otra sin fin.
    const c = supabase.channel(topic, { config: { private: true } });
    for (const ev of ['INSERT', 'UPDATE', 'DELETE']) c.on('broadcast', { event: ev }, inval);
    actual = c;
    c.subscribe((estado) => {
      if (cerrado || actual !== c) return;                                    // canal ya reemplazado o desmontado
      if (estado === 'SUBSCRIBED') {
        clearTimeout(reintento);
        reintento = undefined;
        if (!vivo) invalidar(TODO);                                           // lo ocurrido sin canal no llegó como evento
        vivo = true;
        // El backoff solo vuelve a 0 si el canal aguanta: un servidor que acepta y cierra enseguida no fuerza ciclos de 1 s.
        clearTimeout(estable);
        estable = setTimeout(() => { intento = 0; }, ESTABLE_MS);
        avisar(true);
        return;
      }
      vivo = false;
      clearTimeout(estable);
      avisar(false);                                                          // respaldo de 10 s mientras tanto
      if (estado === 'CLOSED') { quitar(c); programar(); }                    // phoenix no reintenta tras CLOSED
      // CHANNEL_ERROR y TIMED_OUT: phoenix vuelve a unir este mismo canal con su propio backoff.
    });
  }

  conectar().catch(() => { avisar(false); programar(); });
  return () => {
    cerrado = true;
    clearTimeout(espera);
    clearTimeout(reintento);
    clearTimeout(estable);
    if (actual) quitar(actual);
  };
}
