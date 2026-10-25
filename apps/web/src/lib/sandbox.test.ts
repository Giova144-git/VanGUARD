// Sandbox de la demo: latido programado y parado, salida con keepalive y la cabecera de api(), unirse con y sin cuenta.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './errores';

vi.mock('./supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'acc-1' } } }) } } }));
vi.mock('./api', () => ({ api: vi.fn() }));

const { AVISO_SANDBOX, avisoPendiente, DEMASIADAS, enviarSalida, ErrorDemo, latir, LATIDO_MS, NO_DISPONIBLE, programarLatido, recordarAviso, RUTA_LATIDO, unirseADemo,
  avisarCierre, escucharCierre, latirAlCargar, recordarCopias, copiasRecordadas, destinoAlCaducar, permitirRecrear, confirmarCaducada, RUTA_RECREAR, RUTA_NO_RECREADA,
  orgDeRuta, esCopiaRecordada, vieneDeCaducada, AVISO_CADUCADA, comoDemoJoin } = await import('./sandbox');

const pestana = () => {
  const m = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } });
  return m;
};

const ORG = '5a000000-0000-4000-8000-000000000001';

describe('programarLatido', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('late al empezar, cada 60 s y al volver la pestaña a primer plano; parar limpia reloj y oyente', () => {
    const latido = vi.fn();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
    const parar = programarLatido(latido, doc);
    expect(latido).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LATIDO_MS * 2);
    expect(latido).toHaveBeenCalledTimes(3);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(latido).toHaveBeenCalledTimes(3);
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(latido).toHaveBeenCalledTimes(4);
    parar();
    vi.advanceTimersByTime(LATIDO_MS * 5);
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(latido).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('latir', () => {
  it('POST /api/demo/latido con su org; un 404 dice que la copia ya no existe; otros fallos se callan', async () => {
    const pedir = vi.fn().mockResolvedValue(undefined);
    expect(await latir(ORG, pedir)).toBe(true);
    expect(pedir).toHaveBeenCalledWith(RUTA_LATIDO, { method: 'POST', body: { org_id: ORG } });
    expect(await latir(ORG, vi.fn().mockRejectedValue(new ApiError(404, 'not_found', 'x')))).toBe(false);
    expect(await latir(ORG, vi.fn().mockRejectedValue(new ApiError(0, 'network', 'x')))).toBe(true);
  });
});

describe('enviarSalida', () => {
  it('fetch keepalive a /api/demo/salir, mismo origen y con la sesión en Authorization', async () => {
    const pedirFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await enviarSalida(ORG, { pedirFetch });
    expect(pedirFetch).toHaveBeenCalledTimes(1);
    const [ruta, init] = pedirFetch.mock.calls[0]! as [string, RequestInit];
    expect(ruta).toBe('/api/demo/salir');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, body: JSON.stringify({ org_id: ORG }) });
    expect(init.headers).toMatchObject({ authorization: 'Bearer acc-1', 'content-type': 'application/json' });
  });
  it('sin red no lanza: la purga por latido la borra igual', async () => {
    await expect(enviarSalida(ORG, { pedirFetch: vi.fn().mockRejectedValue(new TypeError('x')), acceso: async () => null })).resolves.toBeUndefined();
  });
});

describe('unirseADemo', () => {
  const auth = (session: unknown, anon: { session: unknown; error: { status?: number } | null } = { session: { access_token: 'a' }, error: null }) => ({
    getSession: vi.fn(async () => ({ data: { session } })),
    signInAnonymously: vi.fn(async () => ({ data: { session: anon.session }, error: anon.error })),
    signOut: vi.fn(async () => ({ error: null })),
  });

  it('con sesión de correo no la cierra ni entra como invitado: join crea SU sandbox (dueño, no viewer de la compartida)', async () => {
    const a = auth({ access_token: 'correo' });
    const pedir = vi.fn().mockResolvedValue({ org_id: ORG, sandbox: true });
    expect(await unirseADemo(a, pedir)).toEqual({ org_id: ORG, sandbox: true });
    expect(a.signInAnonymously).not.toHaveBeenCalled();
    expect(a.signOut).not.toHaveBeenCalled();
    expect(pedir).toHaveBeenCalledWith('/api/demo/join', expect.objectContaining({ method: 'POST' }));
  });

  it('sin sesión entra como invitado y se une; si join falla, cierra ese invitado y enseña el 403/429 de la API', async () => {
    const a = auth(null);
    await unirseADemo(a, vi.fn().mockResolvedValue({ org_id: ORG, sandbox: true }));
    expect(a.signInAnonymously).toHaveBeenCalledTimes(1);

    const b = auth(null);
    const tope = new ApiError(429, 'rate_limited', 'Ya hay 3 demos abiertas desde tu red');
    await expect(unirseADemo(b, vi.fn().mockRejectedValue(tope))).rejects.toThrow('Ya hay 3 demos abiertas desde tu red');
    expect(b.signOut).toHaveBeenCalledTimes(1);
    await expect(unirseADemo(auth(null), vi.fn().mockRejectedValue(new ApiError(403, 'forbidden', 'La demo está llena por hoy')))).rejects.toThrow('La demo está llena por hoy');
    await expect(unirseADemo(auth(null), vi.fn().mockRejectedValue(new ApiError(404, 'not_found', 'x')))).rejects.toThrow(NO_DISPONIBLE);
  });

  it('un invitado viejo que la purga ya borró (401) se olvida y entra como invitado nuevo, una sola vez', async () => {
    let sesion: unknown = { user: { is_anonymous: true } };
    const a = { ...auth(null), getSession: vi.fn(async () => ({ data: { session: sesion } })),
      signOut: vi.fn(async () => { sesion = null; return { error: null }; }) };
    const pedir = vi.fn().mockRejectedValueOnce(new ApiError(401, 'unauthorized', 'Tu sesión de demo terminó')).mockResolvedValue({ org_id: ORG, sandbox: true });
    expect(await unirseADemo(a, pedir)).toEqual({ org_id: ORG, sandbox: true });
    expect(a.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(a.signInAnonymously).toHaveBeenCalledTimes(1);
    // Con cuenta de correo, un 401 no la cambia por un invitado.
    const correo = auth({ user: { is_anonymous: false } });
    await expect(unirseADemo(correo, vi.fn().mockRejectedValue(new ApiError(401, 'unauthorized', 'x')))).rejects.toThrow(NO_DISPONIBLE);
    expect(correo.signOut).not.toHaveBeenCalled();
  });

  it('el 429 de Supabase Auth al crear el invitado tiene su mensaje', async () => {
    await expect(unirseADemo(auth(null, { session: null, error: { status: 429 } }), vi.fn())).rejects.toThrow(DEMASIADAS);
    await expect(unirseADemo(auth(null, { session: null, error: { status: 422 } }), vi.fn())).rejects.toBeInstanceOf(ErrorDemo);
  });
});

describe('aviso de Vigía en la sandbox', () => {
  it('una vez por pestaña y copia; dice que se simula y que se borra al cerrar', () => {
    const m = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } });
    expect(avisoPendiente(ORG)).toBe(true);
    recordarAviso(ORG);
    expect(avisoPendiente(ORG)).toBe(false);
    expect(avisoPendiente('otra')).toBe(true);
    vi.unstubAllGlobals();
    expect(AVISO_SANDBOX.texto).toMatch(/Cloudflare/);
    expect(AVISO_SANDBOX.texto).toMatch(/WhatsApp/);
    expect(AVISO_SANDBOX.texto).toMatch(/cerrar el navegador/);
  });
});

describe('cierre en dos pasos', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('pagehide (recarga o cierre) avisa «cerrando» de cada copia; quitar el oyente lo calla', () => {
    const win = new EventTarget();
    const avisar = vi.fn();
    const quitar = escucharCierre(() => [ORG, 'otra'], win, avisar);
    win.dispatchEvent(new Event('pagehide'));
    expect(avisar.mock.calls).toEqual([[ORG], ['otra']]);
    quitar();
    win.dispatchEvent(new Event('pagehide'));
    expect(avisar).toHaveBeenCalledTimes(2);
  });

  it('cerrando va con fetch keepalive, síncrono, a /api/demo/cerrando y con la sesión en Authorization', () => {
    const pedirFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    avisarCierre(ORG, { pedirFetch, acceso: 'acc-2' });
    expect(pedirFetch).toHaveBeenCalledTimes(1);                         // sin await: pagehide no espera promesas
    const [ruta, init] = pedirFetch.mock.calls[0]! as [string, RequestInit];
    expect(ruta).toBe('/api/demo/cerrando');
    expect(init).toMatchObject({ method: 'POST', keepalive: true, body: JSON.stringify({ org_id: ORG }) });
    expect(init.headers).toMatchObject({ authorization: 'Bearer acc-2', 'content-type': 'application/json' });
  });

  it('al cargar, el latido de cada copia recordada sale enseguida (síncrono, sin esperar a /api/me)', async () => {
    pestana();
    recordarCopias([ORG]);
    const pedir = vi.fn().mockResolvedValue(undefined);
    const latidos = latirAlCargar(pedir);
    expect(pedir).toHaveBeenCalledWith(RUTA_LATIDO, { method: 'POST', body: { org_id: ORG } });
    expect(await Promise.all(latidos)).toEqual([true]);
    recordarCopias([]);
    expect(latirAlCargar(vi.fn())).toEqual([]);
  });
});

describe('recrear la copia si caducó', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('la org de la URL y si es una copia de esta pestaña', () => {
    pestana();
    recordarCopias([ORG]);
    expect(orgDeRuta(`/o/${ORG}/findings/x`)).toBe(ORG);
    expect(orgDeRuta('/start')).toBeNull();
    expect(esCopiaRecordada(ORG)).toBe(true);
    expect(esCopiaRecordada('otra')).toBe(false);
  });

  it('un solo intento automático: la ráfaga se ignora, un segundo intento muestra el aviso; «Volver a la demo» lo permite', () => {
    pestana();
    recordarCopias([ORG]);
    const t = 1_000_000;
    expect(destinoAlCaducar(ORG, t)).toBe(RUTA_RECREAR);
    expect(copiasRecordadas()).toEqual([]);                               // la caducada se olvida
    expect(vieneDeCaducada()).toBe(true);                                 // Vigía lo contará en la copia nueva
    expect(destinoAlCaducar(ORG, t + 1_000)).toBeNull();                  // otros errores de la misma caída
    expect(destinoAlCaducar('nueva', t + 30_000)).toBe(RUTA_NO_RECREADA); // la nueva también cayó: sin bucle
    expect(destinoAlCaducar('nueva', t + 31_000)).toBe(RUTA_NO_RECREADA);
    permitirRecrear();
    expect(destinoAlCaducar('nueva', t + 32_000)).toBe(RUTA_RECREAR);
    expect(destinoAlCaducar('otra', t + 32_000 + 121_000)).toBe(RUTA_RECREAR);   // mucho después, vale otro intento
    expect(AVISO_CADUCADA.texto).toMatch(/nueva/);
  });

  it('un 403/404 dentro de la copia solo cuenta si el latido lo confirma (404 o 401), y diez errores son un latido', async () => {
    const muerta = vi.fn().mockRejectedValue(new ApiError(404, 'not_found', 'x'));
    expect(await Promise.all(Array.from({ length: 10 }, () => confirmarCaducada(ORG, muerta)))).toEqual(Array(10).fill(true));
    expect(muerta).toHaveBeenCalledTimes(1);
    expect(await confirmarCaducada(ORG, vi.fn().mockRejectedValue(new ApiError(401, 'unauthorized', 'x')))).toBe(true);
    expect(await confirmarCaducada(ORG, vi.fn().mockResolvedValue(undefined))).toBe(false);
  });
});

// E4 validado a mano (lib/sandbox no puede cargar el contrato en tiempo de ejecución): la misma forma que DemoJoin.
describe('comoDemoJoin', () => {
  it('uuid válido: devuelve org_id y, si es booleano, sandbox', () => {
    expect(comoDemoJoin({ org_id: ORG })).toEqual({ org_id: ORG });
    expect(comoDemoJoin({ org_id: ORG, sandbox: true })).toEqual({ org_id: ORG, sandbox: true });
    expect(comoDemoJoin({ org_id: ORG.toUpperCase(), sandbox: false })).toEqual({ org_id: ORG.toUpperCase(), sandbox: false });
  });
  it('sin org_id, con un org_id que no es uuid o con una respuesta que no es objeto: «no disponible»', () => {
    for (const x of [{}, { sandbox: true }, { org_id: 'no-es-uuid' }, { org_id: `${ORG}x` }, { org_id: 7 }, null, undefined, 'texto', [ORG]]) {
      expect(() => comoDemoJoin(x)).toThrow(ErrorDemo);
      expect(() => comoDemoJoin(x)).toThrow(NO_DISPONIBLE);
    }
  });
  it('un sandbox que no es booleano se descarta, sin tumbar la entrada', () => {
    for (const sandbox of ['true', 1, null, {}]) expect(comoDemoJoin({ org_id: ORG, sandbox })).toEqual({ org_id: ORG });
  });
});
