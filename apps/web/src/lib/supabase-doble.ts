// Doble de supabase-js para el modo fixtures (S14 §14.8): sin red. Sesión falsa demo@vanguard.test o anónima.
// Solo guarda el TIPO de sesión en sessionStorage para sobrevivir a una recarga; nunca un token.
type Tipo = 'correo' | 'anonima';
type Oyente = (evento: string, sesion: unknown) => void;

const CLAVE = 'vg-fx-sesion';
const leer = (): Tipo | null => {
  try { const v = sessionStorage.getItem(CLAVE); return v === 'correo' || v === 'anonima' ? v : null; } catch { return null; }
};
let tipo: Tipo | null = leer();
const oyentes = new Set<Oyente>();

const sesion = () => tipo && {
  access_token: 'fixture', token_type: 'bearer', expires_in: 3600, refresh_token: 'fixture',
  user: tipo === 'correo'
    ? { id: 'fx-admin', email: 'demo@vanguard.test', is_anonymous: false }
    : { id: 'fx-anon', email: undefined, is_anonymous: true },
};
const poner = (t: Tipo | null) => {
  tipo = t;
  try { if (t) sessionStorage.setItem(CLAVE, t); else sessionStorage.removeItem(CLAVE); } catch { /* sin almacenamiento */ }
  oyentes.forEach((o) => o(t ? 'SIGNED_IN' : 'SIGNED_OUT', sesion()));
  return { data: { session: sesion(), user: sesion()?.user ?? null }, error: null };
};
const fallo = (message: string, code: string) => ({ data: { session: null, user: null }, error: { message, code, status: 400 } });

export const tipoSesionFalsa = () => tipo;

export function dobleSupabase() {
  const canal = { on() { return canal; }, subscribe(cb?: (e: string) => void) { cb?.('CLOSED'); return canal; } };
  return {
    auth: {
      getSession: async () => ({ data: { session: sesion() }, error: null }),
      refreshSession: async () => ({ data: { session: sesion(), user: sesion()?.user ?? null }, error: null }),
      signInWithPassword: async ({ password }: { email: string; password: string }) =>
        password.length < 6 ? fallo('Invalid login credentials', 'invalid_credentials') : poner('correo'),
      signUp: async ({ email }: { email: string; password: string }) =>
        email === 'demo@vanguard.test' ? fallo('User already registered', 'user_already_exists') : poner('correo'),
      signInAnonymously: async () => poner('anonima'),
      signOut: async () => { poner(null); return { error: null }; },
      onAuthStateChange: (cb: Oyente) => {
        oyentes.add(cb);
        return { data: { subscription: { unsubscribe: () => { oyentes.delete(cb); } } } };
      },
    },
    realtime: { setAuth: async () => {} },
    channel: () => canal,
    removeChannel: async () => 'ok',
  };
}
