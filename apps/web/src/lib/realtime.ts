// Realtime de Supabase (P0 desde A7.5; SQL y política del BACK en 0008b_realtime.sql). Un canal privado por org que
// solo invalida claves de TanStack Query. No gasta peticiones del Worker: el WebSocket va directo a Supabase.
import type { QueryClient } from '@tanstack/react-query';
import { RealtimeChange } from '@vanguard/contracts';
import { supabase } from './supabase';

const MAPA: Record<string, string[]> = {
  scan_runs: ['scan', 'overview'], findings: ['findings', 'finding', 'module', 'overview'],
  incidents: ['incident', 'incidents', 'overview'], notifications: ['incident'],
};
const TODO = ['overview', 'module', 'findings', 'finding', 'incidents', 'incident', 'scan'];

export async function suscribirOrg(org: string, qc: QueryClient, alCambiar: (vivo: boolean) => void) {
  const invalidar = (claves: string[]) => claves.forEach((k) => qc.invalidateQueries({ queryKey: ['org', org, k] }));
  const inval = (m: { payload?: unknown }) => {
    const r = RealtimeChange.safeParse(m.payload);                             // si no valida, se invalida todo lo de la org
    invalidar(r.success ? MAPA[r.data.table] ?? TODO : TODO);
  };
  await supabase.realtime.setAuth();                                           // obligatorio en canales privados
  const ch = supabase.channel(`org:${org}`, { config: { private: true } });
  for (const ev of ['INSERT', 'UPDATE', 'DELETE']) ch.on('broadcast', { event: ev }, inval);
  let estuvo = false;
  // Si no llega a SUBSCRIBED en 10 s, los hooks siguen con el respaldo de 10 s sin avisar al usuario.
  const espera = setTimeout(() => { if (!estuvo) alCambiar(false); }, 10_000);
  ch.subscribe((estado) => {
    const vivo = estado === 'SUBSCRIBED';
    if (vivo && estuvo === false) invalidar(TODO);                             // lo ocurrido con el canal caído no llegó como evento
    estuvo = vivo;
    alCambiar(vivo);
  });
  return () => { clearTimeout(espera); supabase.removeChannel(ch); };
}
