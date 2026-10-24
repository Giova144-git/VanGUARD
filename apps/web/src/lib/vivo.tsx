// ¿Está el canal Realtime de la org en SUBSCRIBED? Los hooks eligen su intervalo con esto (S14 §14.8):
// «Respaldo» (10 s) sin canal, «Con Realtime» (30–60 s) con canal, para cubrir solo un evento perdido.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { suscribirOrg } from './realtime';

const Ctx = createContext(false);

export function VivoProvider({ org, children }: { org: string; children: ReactNode }) {
  const qc = useQueryClient();
  const [vivo, setVivo] = useState(false);
  // suscribirOrg devuelve la limpieza al momento: con el doble montaje de StrictMode, la primera montura se cierra antes
  // de crear su canal y la segunda se queda con uno propio.
  useEffect(() => {
    setVivo(false);
    return suscribirOrg(org, qc, setVivo);
  }, [org, qc]);
  return <Ctx.Provider value={vivo}>{children}</Ctx.Provider>;
}

export const useVivo = () => useContext(Ctx);
