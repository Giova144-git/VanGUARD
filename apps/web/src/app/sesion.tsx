// Sesión de Supabase Auth para toda la app: una sola suscripción a onAuthStateChange.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

type Sesion = { cargando: boolean; activa: boolean; anonima: boolean; email: string | null };
const Ctx = createContext<Sesion>({ cargando: true, activa: false, anonima: false, email: null });

type SesionSb = { user?: { email?: string | null; is_anonymous?: boolean } } | null;
const aSesion = (s: SesionSb): Sesion =>
  ({ cargando: false, activa: !!s, anonima: !!s?.user?.is_anonymous, email: s?.user?.email ?? null });

export function SesionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [sesion, setSesion] = useState<Sesion>({ cargando: true, activa: false, anonima: false, email: null });
  useEffect(() => {
    let vivo = true;
    supabase.auth.getSession().then(({ data }) => { if (vivo) setSesion(aSesion(data.session)); });
    const { data } = supabase.auth.onAuthStateChange((evento, s) => {
      setSesion(aSesion(s as SesionSb));
      if (evento === 'SIGNED_OUT') qc.clear();                    // nada de otra sesión se queda en caché
    });
    return () => { vivo = false; data.subscription.unsubscribe(); };
  }, [qc]);
  return <Ctx.Provider value={sesion}>{children}</Ctx.Provider>;
}

export const useSesion = () => useContext(Ctx);
