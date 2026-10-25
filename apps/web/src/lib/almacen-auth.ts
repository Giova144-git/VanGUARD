// Dónde guarda supabase-js la sesión (demo volátil). La de correo, en localStorage, como siempre: sobrevive al cierre y
// la comparten las pestañas. La del invitado de /demo (user.is_anonymous), en sessionStorage: se pierde al cerrar la
// pestaña o el navegador, y con ella su sandbox, que la base purga a los ~20 s del cierre o tras ~10 min sin latir (lib/sandbox.ts).
//
// Un solo cliente y una sola storageKey; el almacén se elige al ESCRIBIR, leyendo la propia sesión que se guarda. Así no
// hace falta una marca previa ni un segundo cliente: entrar con correo desde la pestaña del invitado mueve la sesión a
// localStorage, y una sesión anónima que quedó en localStorage de antes pasa a sessionStorage en su primer refresco.
// Leer mira primero sessionStorage: la pestaña del invitado es invitado aunque otra pestaña tenga sesión de correo.
//
// Límites: sessionStorage es por pestaña. Recargar conserva la sesión (y la sandbox); «Duplicar pestaña» la copia; una
// pestaña nueva que abre /demo crea otro invitado con otra sandbox (el tope por IP de la API lo frena). Se eligió así a
// propósito: compartir la sesión entre pestañas exigiría localStorage, que sobrevive al cierre del navegador.

type Almacen = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const CLAVE_AUTH = 'vg-auth';

// ¿Es la sesión de un invitado? Solo mira user.is_anonymous; cualquier otra cosa (code verifier de PKCE, JSON roto) no.
export function esSesionInvitada(valor: string): boolean {
  try {
    const v = JSON.parse(valor) as { user?: { is_anonymous?: unknown } } | null;
    return v?.user?.is_anonymous === true;
  } catch { return false; }
}

const seguro = <T>(f: () => T, porDefecto: T): T => { try { return f(); } catch { return porDefecto; } };

/** El `storage` de supabase-js: invitado → sessionStorage; el resto → localStorage. */
export function almacenAuth(pestana: Almacen | null, local: Almacen | null): Almacen {
  return {
    getItem: (clave) => seguro(() => pestana?.getItem(clave), null) ?? seguro(() => local?.getItem(clave), null) ?? null,
    setItem: (clave, valor) => {
      const [destino, otro] = esSesionInvitada(valor) ? [pestana, local] : [local, pestana];
      seguro(() => otro?.removeItem(clave), undefined);       // nunca la misma clave en los dos
      seguro(() => destino?.setItem(clave, valor), undefined);
    },
    // Quita la de esta pestaña si la hay; si no, la compartida. Salir del invitado no cierra la sesión de correo.
    removeItem: (clave) => {
      if (seguro(() => pestana?.getItem(clave), null) != null) seguro(() => pestana?.removeItem(clave), undefined);
      else seguro(() => local?.removeItem(clave), undefined);
    },
  };
}

// Sin almacenamiento (modo privado estricto, SSR de las pruebas): null y supabase-js cae en su memoria.
const de = (n: 'sessionStorage' | 'localStorage'): Almacen | null => seguro(() => globalThis[n] ?? null, null);
export const almacenNavegador = () => almacenAuth(de('sessionStorage'), de('localStorage'));

/** user.id de la sesión que ESTA pestaña tiene guardada, o null. Sirve para descartar avisos de otras pestañas. */
export function idSesionGuardada(a: Pick<Almacen, 'getItem'> = almacenNavegador()): string | null {
  const v = a.getItem(CLAVE_AUTH);
  if (!v) return null;
  try { const id = (JSON.parse(v) as { user?: { id?: unknown } } | null)?.user?.id; return typeof id === 'string' ? id : null; }
  catch { return null; }
}
