// ¿Está el canal Realtime de la org en SUBSCRIBED? Los hooks eligen su intervalo con esto (S14 §14.8):
// «Respaldo» (10 s) sin canal, «Con Realtime» (30–60 s) con canal, para cubrir solo un evento perdido.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { suscribirOrg } from './realtime';

const Ctx = createContext(false);

export function VivoProvider({ org, children }: { org: string; children: ReactNode }) {
  const qc = useQueryClient();
  const [vivo, setVivo] = useState(false);
  useEffect(() => {
    let cerrar: (() => void) | undefined;
    let activo = true;
    suscribirOrg(org, qc, (v) => { if (activo) setVivo(v); })
      .then((c) => { if (activo) cerrar = c; else c(); })
      .catch(() => setVivo(false));
    return () => { activo = false; cerrar?.(); };
  }, [org, qc]);
  return <Ctx.Provider value={vivo}>{children}</Ctx.Provider>;
}

export const useVivo = () => useContext(Ctx);
