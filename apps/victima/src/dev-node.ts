import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import worker from './worker.ts';

// La víctima en Node 24 (:8788), sin wrangler ni workerd (Norton bloquea ese .exe). Imita al borde en dos cosas:
// sirve public/ antes que el Worker (como los assets) y pone cf-connecting-ip con la IP del socket, para probar
// la ingesta en local contra el apps/api de :8787. Las variables salen de .dev.vars vía --env-file-if-exists.
const PUERTO = 8788;
const PUBLICO = join(import.meta.dirname, '..', 'public');
const TIPOS: Record<string, string> = { '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

const env = { VG_INGEST_URL: process.env.VG_INGEST_URL, VG_INGEST_CONN_ID: process.env.VG_INGEST_CONN_ID,
  VG_INGEST_SECRET: process.env.VG_INGEST_SECRET };
const ctx = { waitUntil(p: Promise<unknown>) { p.catch(() => {}); } };

async function estatico(pathname: string): Promise<Buffer | null> {
  let ruta: string;
  try { ruta = normalize(join(PUBLICO, decodeURIComponent(pathname))); }
  catch { return null; }                                                 // %mal formado (p. ej. /%E0%A4%A): que conteste el Worker
  if (!ruta.startsWith(PUBLICO + sep)) return null;                     // nada fuera de public/
  return readFile(ruta).catch(() => null);
}

// Un error en una petición no puede tumbar el proceso: con --watch quedaría muerto hasta el siguiente cambio
// y el ensayo local de scripts/ataque.mjs se cortaría a medias.
createServer((req, res) => { atender(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); })
  .listen(PUERTO, () => console.log(`victima en http://localhost:${PUERTO}`));

async function atender(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://localhost:${PUERTO}`);
  const lee = req.method === 'GET' || req.method === 'HEAD';
  const archivo = lee ? await estatico(url.pathname) : null;            // el borde sirve los assets también a HEAD
  if (archivo) {
    res.writeHead(200, { 'content-type': TIPOS[extname(url.pathname)] ?? 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : archivo);
    return;
  }
  const trozos: Buffer[] = [];
  for await (const t of req) trozos.push(t as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.set('cf-connecting-ip', (req.socket.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, ''));
  const peticion = new Request(url, { method: req.method, headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(trozos) });
  const r = await worker.fetch(peticion, env, ctx);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(await r.arrayBuffer()));
}
