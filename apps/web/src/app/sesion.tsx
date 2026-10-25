// Sesión de Supabase Auth para toda la app: una sola suscripción a onAuthStateChange.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { idSesionGuardada } from '@/lib/almacen-auth';
import { USA_FIXTURES } from '@/lib/env';
import { supabase } from '@/lib/supabase';

type Sesion = { cargando: boolean; activa: boolean; anonima: boolean; email: string | null };
const Ctx = createContext<Sesion>({ cargando: true, activa: false, anonima: false, email: null });

type SesionSb = { user?: { id?: string; email?: string | null; is_anonymous?: boolean } } | null;
// supabase-js avisa a TODAS las pestañas (BroadcastChannel de la storageKey), pero la del invitado vive en sessionStorage
// (lib/almacen-auth.ts): el «salí» del invitado de otra pestaña no cierra esta sesión de correo, ni al revés. Un aviso
// cuya sesión no es la que ESTA pestaña tiene guardada es de otra pestaña y se ignora. El doble de fixtures no guarda nada.
export function esDeOtraPestana(sesion: SesionSb, guardada: string | null = idSesionGuardada()): boolean {
  return !USA_FIXTURES && guardada !== (sesion?.user?.id ?? null);
}

const aSesion = (s: SesionSb): Sesion =>
  ({ cargando: false, activa: !!s, anonima: !!s?.user?.is_anonymous, email: s?.user?.email ?? null });

export function SesionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [sesion, setSesion] = useState<Sesion>({ cargando: true, activa: false, anonima: false, email: null });
  useEffect(() => {
    let vivo = true;
    let dueno: string | null = null;                              // user.id de la última sesión vista: la caché es suya
    supabase.auth.getSession().then(({ data }) => {
      if (!vivo) return;
      setSesion(aSesion(data.session));
      dueno ??= data.session?.user.id ?? null;
    });
    const { data } = supabase.auth.onAuthStateChange((evento, s) => {
      if (esDeOtraPestana(s as SesionSb)) return;
      const id = (s as SesionSb)?.user?.id ?? null;
      setSesion(aSesion(s as SesionSb));
      // Nada de otra sesión se queda en caché: al salir, o al entrar otra cuenta sin salir (el anónimo de /demo que entra
      // con correo). TOKEN_REFRESHED y los SIGNED_IN repetidos traen el mismo id y no vacían nada.
      if (evento === 'SIGNED_OUT' || (id && dueno && id !== dueno)) qc.clear();
      dueno = id ?? dueno;
    });
    return () => { vivo = false; data.subscription.unsubscribe(); };
  }, [qc]);
  return <Ctx.Provider value={sesion}>{children}</Ctx.Provider>;
}

export const useSesion = () => useContext(Ctx);
