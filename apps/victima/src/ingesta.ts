// Ingesta de borde firmada y en lotes (S02 02.5.2, M14; contrato E30 de S15). Es la MISMA función que el panel
// «Tu app (ingesta)» da a copiar: lo que se demuestra en el pitch es lo que el cliente pega en su Worker.
// Diferencias con el fragmento, todas para no romper la víctima: tipos propios (sin @cloudflare/workers-types),
// no envía si falta alguna variable (primer deploy sin secreto, 03.7), avisa del estado si el ingest no da 2xx
// y corta el fetch a los 10 s. Firma, cabeceras, cuerpo y topes son los del fragmento, sin cambios.

// Nombres del catálogo de S03 03.6. URL en producción: https://officialvanguard.com/ingest/v1/events
export interface EnvIngesta { VG_INGEST_SECRET?: string; VG_INGEST_CONN_ID?: string; VG_INGEST_URL?: string }

// Lo único de ExecutionContext/ExportedHandler de Workers que se usa aquí.
export interface Ctx { waitUntil(p: Promise<unknown>): void }
export interface Manejador<E> { fetch(req: Request, env: E, ctx: Ctx): Response | Promise<Response> }

const te = new TextEncoder();

// hex(HMAC-SHA256(secreto, `${ts}.${cuerpo}`)); la clave son los bytes UTF-8 del vgi_… completo (ingestKey, 05.7).
export async function firmar(secreto: string, ts: string, cuerpo: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', te.encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, te.encode(`${ts}.${cuerpo}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Búfer por isolate: se vacía al llegar a 100 eventos o a ~56 KB, o 2 s después del primer evento (A7 #5).
// Solo guarda cadenas JSON, nunca un Request/Response: un objeto de otra petición daría
// «Cannot perform I/O on behalf of a different request».
export const MAX_EVENTOS = 100, MAX_BYTES = 56_000, ESPERA_MS = 2_000;   // E30: 1–100 EdgeEvent y cuerpo ≤ 64 KB (si no, 413)
let buf: string[] = [], bytes = 0, programadoEn = 0;                     // programadoEn = 0: no hay vaciado por tiempo pendiente

function listo(env: EnvIngesta): env is Required<EnvIngesta> {
  return !!(env.VG_INGEST_SECRET && env.VG_INGEST_CONN_ID && env.VG_INGEST_URL);
}

export function vaciar(env: EnvIngesta): Promise<void> {
  if (buf.length === 0 || !listo(env)) return Promise.resolve();
  const cuerpo = `{"events":[${buf.join(',')}]}`;                        // se vacía en síncrono: lo que llegue después va al lote siguiente
  buf = []; bytes = 0;
  const ts = String(Math.floor(Date.now() / 1000));
  const { VG_INGEST_SECRET, VG_INGEST_CONN_ID, VG_INGEST_URL } = env;
  return firmar(VG_INGEST_SECRET, ts, cuerpo)
    .then((sig) => fetch(VG_INGEST_URL, { method: 'POST', body: cuerpo, signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-vg-conn': VG_INGEST_CONN_ID, 'x-vg-ts': ts, 'x-vg-sig': sig } }))
    .then(async (r) => {
      if (!r.ok) console.warn('ingesta.rechazada', r.status);           // 401/413/429: se descarta, sin reintento (S06)
      await r.body?.cancel();
    })
    .catch(() => {});                                                     // nunca rompe la respuesta de la app
}

export function conVanguard<E extends EnvIngesta>(h: Manejador<E>): Manejador<E> {
  return { ...h, async fetch(req, env, ctx) {
    const t0 = Date.now();
    const res = await h.fetch(req, env, ctx);
    const ip = req.headers.get('cf-connecting-ip');
    if (!ip || !listo(env)) return res;                                  // sin IP (p. ej. wrangler dev) o sin secreto: no se envía
    const ev = JSON.stringify({ ts: new Date(t0).toISOString(), ip,
      method: req.method.slice(0, 10), path: new URL(req.url).pathname.slice(0, 300), status: res.status, // sin query
      ua: (req.headers.get('user-agent') ?? '').slice(0, 200), latency_ms: Date.now() - t0,
      auth: req.headers.has('authorization') });                          // igual que el fragmento; la víctima no valida nada: /admin sin esa cabecera va con auth false
    const n = te.encode(ev).length + 1;
    if (bytes + n > MAX_BYTES) ctx.waitUntil(vaciar(env));               // el que no cabe abre el lote siguiente
    buf.push(ev); bytes += n;
    if (buf.length >= MAX_EVENTOS) ctx.waitUntil(vaciar(env));            // por tamaño
    else if (Date.now() - programadoEn > 3 * ESPERA_MS) {                 // por tiempo (≤ 2 s de retraso); se reprograma si un temporizador se perdió
      programadoEn = Date.now();
      ctx.waitUntil(new Promise<void>((r) => setTimeout(r, ESPERA_MS)).then(() => { programadoEn = 0; return vaciar(env); }));
    }
    return res;
  } };
}
