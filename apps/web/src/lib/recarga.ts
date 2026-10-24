// Tras un despliegue, una pestaña abierta pide chunks con el hash viejo: ya no existen, el respaldo de la SPA responde
// index.html y el import() falla («Failed to load module script»). Se recarga una vez para traer el index nuevo; si
// vuelve a fallar en menos de 10 s, el error sigue su camino (ErrorRuta) en vez de recargar en bucle.
const CLAVE = 'vg-recarga-chunk';
export const VENTANA_MS = 10_000;

type Entorno = { ahora: () => number; recargar: () => void; almacen: Pick<Storage, 'getItem' | 'setItem'> | null };

const navegador = (): Entorno => ({
  ahora: () => Date.now(),
  recargar: () => location.reload(),
  almacen: (() => { try { return sessionStorage; } catch { return null; } })(),
});

export async function conRecarga<T>(cargar: () => Promise<T>, e: Entorno = navegador()): Promise<T> {
  try {
    return await cargar();
  } catch (error) {
    let ultima = 0;
    try { ultima = Number(e.almacen?.getItem(CLAVE)) || 0; } catch { /* sin almacén: se recarga igual */ }
    if (e.ahora() - ultima < VENTANA_MS) throw error;
    try { e.almacen?.setItem(CLAVE, String(e.ahora())); } catch { /* idem */ }
    e.recargar();
    return new Promise<T>(() => {});   // la página se va: que react-router no pinte el error mientras tanto
  }
}
