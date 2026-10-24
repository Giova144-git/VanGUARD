import { conVanguard, type EnvIngesta, type Manejador } from './ingesta.ts';
import { paginaAdmin, paginaInicio, paginaLogin, PRODUCTOS } from './paginas.ts';
import { PERF_VERSION, type PerfVersion } from './perf-version.ts';

// Worker vanguard-victima (demo.officialvanguard.com, S03 03.7). Sin Hono para no sumar dependencias ni tocar el
// lockfile: son cuatro rutas. Los recursos de public/ los sirve el borde antes de llegar aquí.
export type Env = EnvIngesta;

const html = (cuerpo: string, status = 200) =>
  new Response(cuerpo, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const texto = (cuerpo: string, status: number, extra: Record<string, string> = {}) =>
  new Response(cuerpo, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...extra } });

function rutear(req: Request, v: PerfVersion): Response {
  const { pathname } = new URL(req.url);
  const lee = req.method === 'GET' || req.method === 'HEAD';
  switch (pathname) {
    case '/':
      return lee ? html(paginaInicio(v)) : texto('Método no permitido', 405, { allow: 'GET, HEAD' });
    case '/login':
      if (lee) return html(paginaLogin());
      // No hay usuarios: el cuerpo ni se lee y todo intento falla igual.
      if (req.method === 'POST') return html(paginaLogin(true), 401);
      return texto('Método no permitido', 405, { allow: 'GET, HEAD, POST' });
    case '/api/productos':
      return lee ? Response.json(PRODUCTOS) : texto('Método no permitido', 405, { allow: 'GET, HEAD' });
    case '/admin':
    case '/admin/':
      return lee ? html(paginaAdmin()) : texto('Método no permitido', 405, { allow: 'GET, HEAD' });
    default:
      return texto('No encontrado', 404);
  }
}

// La app sin ingesta. x-vg-victima marca cada respuesta que SÍ llegó al Worker: scripts/ataque.mjs separa así lo que
// cortó el borde (403/429 de Cloudflare) de lo que respondió la víctima (T02-04, Z2 de S02 02.4).
export function crearApp(v: PerfVersion = PERF_VERSION): Manejador<Env> {
  return {
    fetch(req) {
      const res = rutear(req, v);
      res.headers.set('x-vg-victima', '1');
      return res;
    },
  };
}

export default conVanguard(crearApp());
