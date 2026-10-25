// Sandbox de la demo (E4): la copia temporal de la org de demo de cada visitante, con o sin cuenta. Vive mientras late:
// POST /api/demo/latido al cargar, cada 60 s y al volver la pestaña a primer plano; si la base no oye un latido en ~10
// min, la borra (y al invitado, si se queda sin orgs). POST /api/demo/salir la borra ya: lo llama «Salir de la demo».
//
// Cierre en dos pasos: pagehide salta igual al recargar, al navegar fuera y al cerrar, y en ese momento no se pueden
// distinguir. Así que en pagehide va POST /api/demo/cerrando (keepalive): el servidor la marca para borrarla en ~20 s.
// Si era una recarga, el latido que sale nada más cargar (latirAlCargar, desde main.tsx, antes de pedir /api/me) la
// desmarca. Si era un cierre, nadie late y a los ~20 s se borra. El margen de 10 min queda para lo que pagehide no ve
// (el navegador muere, el móvil mata la pestaña).
//
// Si la copia caducó igual (el equipo dormía), la web prepara otra sola, una vez: destinoAlCaducar.
// Solo el tipo: main.tsx importa este módulo y no puede arrastrar el contrato (zod) ni de forma estática (correría antes que
// lib/zod-sin-jit: vg-zod-sin-jit rechaza el build) ni con import() (desde /demo, el chunk del contrato se evalúa en un
// orden circular con el de guardas y lanza). La respuesta de E4 se valida a mano en comoDemoJoin.
import type { DemoJoin } from '@vanguard/contracts';
import { api } from './api';
import { esApiError } from './errores';
import { supabase } from './supabase';

export const LATIDO_MS = 60_000;
export const RUTA_LATIDO = '/api/demo/latido';
export const RUTA_SALIR = '/api/demo/salir';
export const RUTA_CERRANDO = '/api/demo/cerrando';
const FIXTURES = import.meta.env.MODE === 'fixtures' || import.meta.env.VITE_USE_FIXTURES === '1';

type Visible = Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { visibilityState?: DocumentVisibilityState };

/** Programa el latido de una sandbox: uno ya, uno cada `cada` ms y otro al volver la pestaña visible. Devuelve el que lo
 *  para. Con la pestaña oculta también late (el navegador lo espacia, pero no llega a 10 min en segundo plano normal). */
export function programarLatido(latir: () => void, doc: Visible | null = globalThis.document ?? null, cada = LATIDO_MS): () => void {
  latir();
  const reloj = setInterval(latir, cada);
  const alCambiar = () => { if (doc?.visibilityState === 'visible') latir(); };
  doc?.addEventListener('visibilitychange', alCambiar);
  return () => { clearInterval(reloj); doc?.removeEventListener('visibilitychange', alCambiar); };
}

/** Un latido. Un 404 (o 401: el invitado se purgó con ella) dice que la sandbox ya no existe: devuelve false. Los demás
 *  fallos se callan: el siguiente latido lo reintenta. De paso guarda el acceso para el keepalive de pagehide. */
export async function latir(org: string, pedir: typeof api = api): Promise<boolean> {
  void refrescarAcceso();
  try { await pedir(RUTA_LATIDO, { method: 'POST', body: { org_id: org } }); return true; }
  catch (e) { return !(esApiError(e) && (e.status === 404 || e.status === 410 || e.status === 401)); }
}

// ── Las copias de esta pestaña (sessionStorage): para latir al cargar sin esperar a /api/me y para reconocer, ante un
// error, que la org de la URL era una copia que caducó ─────────────────────────────────────────────────────────────
const CLAVE_COPIAS = 'vg-sandbox-copias';
export function copiasRecordadas(): string[] {
  try { return (sessionStorage.getItem(CLAVE_COPIAS) ?? '').split(',').filter(Boolean); } catch { return []; }
}
export function recordarCopias(ids: readonly string[]) {
  try { if (ids.length) sessionStorage.setItem(CLAVE_COPIAS, ids.join(',')); else sessionStorage.removeItem(CLAVE_COPIAS); } catch { /* sin almacenamiento */ }
}
export function olvidarCopia(org: string) { recordarCopias(copiasRecordadas().filter((x) => x !== org)); }

/** El primer latido de una recarga, lo antes posible (main.tsx, sin esperar a /api/me ni al chunk de la ruta): cancela
 *  el «cerrando» que mandó la página anterior antes de sus ~20 s. Devuelve las promesas para las pruebas. */
export function latirAlCargar(pedir: typeof api = api): Promise<boolean>[] {
  return copiasRecordadas().map((org) => latir(org, pedir));
}

/** Cabeceras de lib/api.ts para un fetch a mano (keepalive no pasa por el wrapper). */
export function cabecerasApi(acceso: string | null): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  if (acceso) h.authorization = `Bearer ${acceso}`;
  return h;
}

/** POST /api/demo/salir con keepalive: llega aunque la página navegue o se cierre justo después. Mismo origen y
 *  cabeceras que api(). En fixtures va por el wrapper (no hay backend). Nunca lanza: la purga por latido es la red. */
export async function enviarSalida(org: string, deps: { pedirFetch?: typeof fetch; acceso?: () => Promise<string | null> } = {}): Promise<void> {
  olvidarCopia(org);
  if (FIXTURES && !deps.pedirFetch) {
    await api(RUTA_SALIR, { method: 'POST', body: { org_id: org } }).catch(() => {});
    return;
  }
  const acceso = await (deps.acceso ?? accesoActual)();
  await (deps.pedirFetch ?? fetch)(RUTA_SALIR, {
    method: 'POST', keepalive: true, headers: cabecerasApi(acceso), body: JSON.stringify({ org_id: org }),
  }).catch(() => {});
}

async function accesoActual(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

// pagehide no espera promesas: el acceso se lee antes (en cada latido) y aquí solo se usa.
let accesoGuardado: string | null = null;
export async function refrescarAcceso() { accesoGuardado = await accesoActual().catch(() => accesoGuardado); }

/** POST /api/demo/cerrando con keepalive, síncrono (pagehide): «me voy; bórrala en ~20 s si no vuelvo a latir». */
export function avisarCierre(org: string, deps: { pedirFetch?: typeof fetch; acceso?: string | null } = {}): void {
  if (FIXTURES && !deps.pedirFetch) { void api(RUTA_CERRANDO, { method: 'POST', body: { org_id: org } }).catch(() => {}); return; }
  void (deps.pedirFetch ?? fetch)(RUTA_CERRANDO, {
    method: 'POST', keepalive: true, headers: cabecerasApi(deps.acceso === undefined ? accesoGuardado : deps.acceso), body: JSON.stringify({ org_id: org }),
  }).catch(() => {});
}

/** Escucha pagehide (recarga, navegación fuera o cierre) y avisa del cierre de cada copia. Devuelve el que lo quita. */
export function escucharCierre(orgs: () => readonly string[], win: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null = globalThis.window ?? null,
  avisar: (org: string) => void = avisarCierre): () => void {
  const alSalir = () => { for (const org of orgs()) avisar(org); };
  win?.addEventListener('pagehide', alSalir);
  return () => win?.removeEventListener('pagehide', alSalir);
}

// ── La copia caducó: prepara otra, una sola vez ──────────────────────────────────────────────────────────────────────
const CLAVE_RECREANDO = 'vg-sandbox-recreando';
const CLAVE_CADUCADA = 'vg-sandbox-caducada';
export const RAFAGA_MS = 5_000;                // varios errores de la misma caída: una sola decisión
export const UN_INTENTO_MS = 120_000;          // otro intento automático dentro de este plazo sería un bucle
export const RUTA_RECREAR = '/demo?caducada=1';
export const RUTA_NO_RECREADA = '/demo?caducada=fallo';

export const orgDeRuta = (pathname: string): string | null => pathname.match(/^\/o\/([^/]+)/)?.[1] ?? null;
export const esCopiaRecordada = (org: string | null) => !!org && copiasRecordadas().includes(org);

/** A dónde ir cuando la copia caducó: a prepararla de nuevo (primera vez), al aviso con «Volver a la demo» (ya se
 *  intentó hace poco: sin bucles) o null (otro error de la misma ráfaga ya decidió). */
export function destinoAlCaducar(org: string | null, ahora = Date.now()): string | null {
  let previo = 0;
  try { previo = Number(sessionStorage.getItem(CLAVE_RECREANDO)) || 0; } catch { /* sin almacenamiento */ }
  if (ahora - previo < RAFAGA_MS) return null;
  if (org) olvidarCopia(org);
  if (ahora - previo < UN_INTENTO_MS) return RUTA_NO_RECREADA;
  try { sessionStorage.setItem(CLAVE_RECREANDO, String(ahora)); sessionStorage.setItem(CLAVE_CADUCADA, '1'); } catch { /* sin almacenamiento */ }
  return RUTA_RECREAR;
}
/** «Volver a la demo» es a mano: vale otra vez. */
export function permitirRecrear() { try { sessionStorage.removeItem(CLAVE_RECREANDO); } catch { /* sin almacenamiento */ } }

// Un latido por org aunque fallen diez consultas a la vez.
const confirmando = new Map<string, Promise<boolean>>();
/** Un 403/404 dentro de la copia puede ser de otra cosa (un hallazgo que no existe): solo caducó si el latido lo dice. */
export function confirmarCaducada(org: string, pedir: typeof api = api): Promise<boolean> {
  let p = confirmando.get(org);
  if (!p) { p = latir(org, pedir).then((viva) => !viva).finally(() => confirmando.delete(org)); confirmando.set(org, p); }
  return p;
}

// ── Entrar a la demo (/demo) ─────────────────────────────────────────────────────────────────────────────────────
export const NO_DISPONIBLE = 'La demo abierta no está disponible ahora. Entra con la cuenta de demo del README';
export const DEMASIADAS = 'Hay demasiadas demos abiertas desde tu red. Espera unos minutos y vuelve a intentarlo';
export class ErrorDemo extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** E4 (DemoJoin del contrato): { org_id: uuid, sandbox?: boolean }. Cualquier otra forma es «no disponible». */
export function comoDemoJoin(x: unknown): DemoJoin {
  const o = (x && typeof x === 'object' ? x : {}) as { org_id?: unknown; sandbox?: unknown };
  if (typeof o.org_id !== 'string' || !UUID.test(o.org_id)) throw new ErrorDemo(NO_DISPONIBLE);
  return typeof o.sandbox === 'boolean' ? { org_id: o.org_id, sandbox: o.sandbox } : { org_id: o.org_id };
}

type AuthDemo = {
  getSession: () => Promise<{ data: { session: unknown } }>;
  signInAnonymously: () => Promise<{ data: { session: unknown }; error: { status?: number } | null }>;
  signOut: (o?: { scope: 'local' }) => Promise<unknown>;
};

/** Sin sesión entra como invitado (su sesión va a sessionStorage, lib/almacen-auth.ts); con sesión de correo NO la
 *  cierra. En los dos casos POST /api/demo/join crea (o devuelve) SU sandbox, de la que es dueño: la cuenta nunca queda
 *  unida a la demo compartida. Un 403 o 429 propio de la sandbox (tope por IP, cuota global) trae su mensaje. */
export async function unirseADemo(auth: AuthDemo = supabase.auth, pedir: typeof api = api, reintento = true): Promise<DemoJoin> {
  const { data } = await auth.getSession();
  const anonimaVieja = (data.session as { user?: { is_anonymous?: boolean } } | null)?.user?.is_anonymous === true;
  let invitadoNuevo = false;
  if (!data.session) {
    const r = await auth.signInAnonymously();
    if (r.error || !r.data.session) throw new ErrorDemo(r.error?.status === 429 ? DEMASIADAS : NO_DISPONIBLE);
    invitadoNuevo = true;
  }
  try {
    return comoDemoJoin(await pedir<unknown>('/api/demo/join', { method: 'POST', body: {} }));
  } catch (e) {
    // La purga ya borró a este invitado (401 de E4 con su sesión vieja): se olvida y se entra como invitado nuevo, una vez.
    if (anonimaVieja && reintento && esApiError(e) && e.status === 401) {
      await auth.signOut({ scope: 'local' }).catch(() => {});
      return unirseADemo(auth, pedir, false);
    }
    if (invitadoNuevo) await auth.signOut({ scope: 'local' }).catch(() => {});   // un invitado sin sandbox no sirve de nada
    if (esApiError(e) && (e.status === 403 || e.status === 429) && e.message) throw new ErrorDemo(e.message);
    throw new ErrorDemo(NO_DISPONIBLE);                                       // 404 de E4 (sin org de demo) incluido
  }
}

// ── Aviso de Vigía la primera vez en una sandbox (por pestaña, como la sesión del invitado) ───────────────────────────
const CLAVE_AVISO = 'vg-sandbox-avisada';
export function avisoPendiente(org: string): boolean {
  try { return sessionStorage.getItem(CLAVE_AVISO) !== org; } catch { return false; }
}
export function recordarAviso(org: string) {
  try { sessionStorage.setItem(CLAVE_AVISO, org); } catch { /* sin almacenamiento */ }
}
export const AVISO_CADUCADA = {
  titulo: 'Tu copia caducó',
  texto: 'Caducó mientras no estabas, así que te preparé una nueva. Puedes seguir probándolo todo, y se borra sola al cerrar el navegador.',
} as const;
/** ¿La copia nueva viene de una que caducó? Lo lee el aviso de Vigía una vez. */
export function vieneDeCaducada(): boolean {
  try { return sessionStorage.getItem(CLAVE_CADUCADA) === '1'; } catch { return false; }
}
export function olvidarCaducada() { try { sessionStorage.removeItem(CLAVE_CADUCADA); } catch { /* sin almacenamiento */ } }
export const AVISO_SANDBOX = {
  titulo: 'Esta demo es tu copia',
  texto: 'Puedes probarlo todo: conectar, auditar, bloquear. Lo que tocaría Cloudflare y los WhatsApp se simulan, y la copia se borra sola al cerrar el navegador.',
} as const;
