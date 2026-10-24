import { log } from './lib/log.ts';

// TEMPORAL · prueba de humo de Workers Free (A7.7, S15 15.14). Cada mensaje lee un lockfile de muestra y hace
// 40 fetch a POST https://api.osv.dev/v1/query (gratis, sin clave; el servicio que usará el paso repo).
// Lo que se mide va en Workers Observability: 3 invocaciones queue, 40 subpeticiones cada una, sin
// «Too many subrequests», y el cpu_time_ms de cada consumo (objetivo < 10 ms).
export const HUMO_MENSAJES = 3;
export const HUMO_FETCHES = 40;
const PARALELO = 5; // Workers deja 6 conexiones esperando cabeceras a la vez (S15 15.3)

// package-lock.json v3 recortado: 36 versiones recientes y 4 con avisos conocidos, para que algunas respuestas
// de OSV traigan cuerpo y la medida incluya su JSON.parse.
const DEPS: [string, string][] = [
  ['lodash', '4.17.20'], ['minimist', '1.2.5'], ['axios', '0.21.1'], ['node-fetch', '2.6.0'],
  ['react', '19.2.0'], ['react-dom', '19.2.0'], ['hono', '4.10.0'], ['zod', '4.1.0'],
  ['express', '5.1.0'], ['vite', '7.1.0'], ['typescript', '5.9.2'], ['vitest', '3.2.4'],
  ['commander', '14.0.0'], ['chalk', '5.6.0'], ['debug', '4.4.1'], ['ms', '2.1.3'],
  ['semver', '7.7.2'], ['uuid', '13.0.0'], ['dotenv', '17.2.1'], ['yaml', '2.8.1'],
  ['date-fns', '4.1.0'], ['clsx', '2.1.1'], ['nanoid', '5.1.5'], ['picocolors', '1.1.1'],
  ['undici', '7.15.0'], ['ws', '8.18.3'], ['cookie', '1.0.2'], ['jose', '6.1.0'],
  ['pino', '9.9.0'], ['fastify', '5.5.0'], ['zustand', '5.0.8'], ['immer', '10.1.3'],
  ['tslib', '2.8.1'], ['rxjs', '7.8.2'], ['glob', '11.0.3'], ['minimatch', '10.0.3'],
  ['postcss', '8.5.6'], ['esbuild', '0.25.9'], ['rollup', '4.50.0'], ['prettier', '3.6.2'],
];

export const LOCKFILE_MUESTRA = JSON.stringify({
  name: 'muestra',
  lockfileVersion: 3,
  packages: Object.fromEntries([
    ['', { name: 'muestra', version: '0.0.0' }],
    ...DEPS.map(([n, v]) => [`node_modules/${n}`, { version: v }]),
  ]),
});

type Lock = { packages: Record<string, { version?: string }> };

async function enParalelo<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  const hilo = async () => { while (i < items.length) await fn(items[i++] as T); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, hilo));
}

export async function pasoHumo(msg: { i: number; fetches: number }) {
  const t0 = Date.now();
  const lock = JSON.parse(LOCKFILE_MUESTRA) as Lock;
  const deps = Object.entries(lock.packages)
    .filter(([k]) => k.startsWith('node_modules/'))
    .map(([k, v]) => ({ name: k.slice('node_modules/'.length), version: v.version ?? '' }));
  const lote = deps.slice(0, Math.min(msg.fetches, HUMO_FETCHES));
  let ok = 0, fallos = 0, vulns = 0, bytes = 0;
  await enParalelo(lote, PARALELO, async (d) => {
    try {
      const r = await fetch('https://api.osv.dev/v1/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ package: { name: d.name, ecosystem: 'npm' }, version: d.version }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) { fallos++; await r.body?.cancel(); return; }
      const texto = await r.text();
      bytes += texto.length;
      vulns += (JSON.parse(texto) as { vulns?: unknown[] }).vulns?.length ?? 0;
      ok++;
    } catch {
      fallos++;
    }
  });
  log('info', 'humo.paso', { i: msg.i, deps: deps.length, subpeticiones: lote.length, ok, fallos, vulns, bytes,
    ms: Date.now() - t0 });
}
