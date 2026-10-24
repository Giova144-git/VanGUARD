import { describe, expect, it, vi } from 'vitest';
import { conRecarga, VENTANA_MS } from './recarga';

const entorno = (t0: number) => {
  const datos = new Map<string, string>();
  let t = t0;
  return {
    e: { ahora: () => t, recargar: vi.fn(), almacen: { getItem: (k: string) => datos.get(k) ?? null, setItem: (k: string, v: string) => void datos.set(k, v) } },
    avanzar: (ms: number) => { t += ms; },
  };
};
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('conRecarga', () => {
  it('si el chunk carga, devuelve el módulo y no recarga', async () => {
    const { e } = entorno(1_000_000);
    await expect(conRecarga(async () => 'modulo', e)).resolves.toBe('modulo');
    expect(e.recargar).not.toHaveBeenCalled();
  });

  it('un chunk que falla recarga una vez y no resuelve (la página se va)', async () => {
    const { e } = entorno(1_000_000);
    let resuelto = false;
    void conRecarga(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')), e).then(() => { resuelto = true; });
    await espera(0);
    expect(e.recargar).toHaveBeenCalledTimes(1);
    expect(resuelto).toBe(false);
  });

  it('si vuelve a fallar dentro de la ventana, lanza en vez de recargar en bucle', async () => {
    const { e, avanzar } = entorno(1_000_000);
    const falla = () => Promise.reject(new Error('chunk'));
    void conRecarga(falla, e);
    await espera(0);
    avanzar(VENTANA_MS - 1);
    await expect(conRecarga(falla, e)).rejects.toThrow('chunk');
    expect(e.recargar).toHaveBeenCalledTimes(1);
  });

  it('pasada la ventana, otro despliegue vuelve a recargar', async () => {
    const { e, avanzar } = entorno(1_000_000);
    const falla = () => Promise.reject(new Error('chunk'));
    void conRecarga(falla, e);
    await espera(0);
    avanzar(VENTANA_MS + 1);
    void conRecarga(falla, e);
    await espera(0);
    expect(e.recargar).toHaveBeenCalledTimes(2);
  });

  it('sin almacén (modo privado) recarga igual', async () => {
    const { e } = entorno(1_000_000);
    void conRecarga(() => Promise.reject(new Error('chunk')), { ...e, almacen: null });
    await espera(0);
    expect(e.recargar).toHaveBeenCalledTimes(1);
  });
});
