// zip.worker.ts de punta a punta con leerZip y analizarZip de verdad, sobre un ZIP armado con zipSync. El ámbito del
// worker se sustituye por un objeto que guarda lo que se envía. Los secretos se arman en tiempo de ejecución.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { ZipResult } from '@vanguard/contracts';
import type { SalidaWorker } from './tipos';

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const RICO = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv';
const R = (n: number, base = RICO) => base.repeat(Math.ceil(n / base.length)).slice(0, n);
const SERVICE_ROLE = b64url({ alg: 'HS256', typ: 'JWT' }) + '.'
  + b64url({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role: 'service_role', iat: 1761300000, exp: 2076876000 }) + '.' + R(43, 'Zx9Yw8Vu7Ts6');
const PRIVADA = '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + R(64) + '\n' + R(64, 'Mn7Op8Qr9St0Uv') + '\n-----END ' + 'RSA PRIVATE KEY-----';
const LOCK = JSON.stringify({ name: 'app', lockfileVersion: 3, requires: true,
  packages: { '': { name: 'app' }, 'node_modules/react': { version: '19.3.1' }, 'node_modules/vitest': { version: '4.1.12', dev: true } } });

const zip = (archivos: Record<string, string>) => {
  const u8 = zipSync(Object.fromEntries(Object.entries(archivos).map(([k, v]) => [k, strToU8(v)])));
  return new File([u8], 'proyecto.zip');
};

async function correr(archivo: File) {
  const enviado: SalidaWorker[] = [];
  const ambito = {
    onmessage: null as ((e: { data: { archivo: File } }) => Promise<void>) | null,
    postMessage: (m: SalidaWorker) => { enviado.push(structuredClone(m)); },
    close: vi.fn(),
  };
  vi.stubGlobal('self', ambito);
  vi.resetModules();
  await import('./zip.worker');
  const alRecibir = ambito.onmessage!;
  await alRecibir({ data: { archivo } });
  return { enviado, ambito };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('zip.worker', () => {
  it('lee, analiza y manda solo el Analisis tapado; después se cierra', async () => {
    const { enviado, ambito } = await correr(zip({
      'proyecto/.env': `SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE}\n`,
      'proyecto/.gitignore': 'node_modules/\n',
      'proyecto/id_rsa.pem': PRIVADA,
      'proyecto/package-lock.json': LOCK,
      'proyecto/src/a.ts': 'export const a = 1;\n',
    }));
    expect(enviado.map((m) => (m.tipo === 'progreso' ? m.fase : m.tipo))).toEqual(['leyendo', 'analizando', 'listo']);
    const listo = enviado[2]!;
    if (listo.tipo !== 'listo') throw new Error('sin resultado');
    const r = ZipResult.parse(listo.analisis.resultado);
    expect(r.deps.map((d) => `${d.name}@${d.version}`).sort()).toEqual(['react@19.3.1', 'vitest@4.1.12']);
    expect(r.findings.map((f) => f.rule_id)).toEqual(expect.arrayContaining(['CB_ENV_COMMITTED', 'CB_SECRET_SUPABASE_SERVICE_ROLE', 'CB_SECRET_PRIVATE_KEY']));
    // Ningún valor en claro sale del worker, ni en el resultado ni en los avisos.
    const todo = JSON.stringify(enviado);
    for (const s of [SERVICE_ROLE, SERVICE_ROLE.split('.')[1]!, SERVICE_ROLE.split('.')[2]!, R(64), 'BEGIN RSA', 'SUPABASE_SERVICE_ROLE_KEY'])
      expect(todo).not.toContain(s);
    expect(r.findings.find((f) => f.rule_id === 'CB_SECRET_PRIVATE_KEY')?.evidence.preview).toBeUndefined();
    expect(ambito.close).toHaveBeenCalledOnce();
    expect(ambito.onmessage).toBeNull();            // un archivo por worker
  }, 30_000);   // ~0,6 s solo, pero pasó de 5 s con todos los paquetes del gate corriendo a la vez
  it('un ZipError sale con su código y se cierra igual', async () => {
    const gif = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, ...Array(40).fill(0)])], 'x.zip');
    const { enviado, ambito } = await correr(gif);
    expect(enviado.at(-1)).toEqual({ tipo: 'error', codigo: 'ZIP_BAD_MAGIC' });
    expect(ambito.close).toHaveBeenCalledOnce();
  });

  it('cualquier otro fallo se queda en ZIP_INVALID, sin el mensaje del error', async () => {
    const roto = { arrayBuffer: () => Promise.reject(new Error('NotReadableError: /home/u/secreto')) } as unknown as File;
    const { enviado, ambito } = await correr(roto);
    expect(enviado).toEqual([{ tipo: 'progreso', fase: 'leyendo' }, { tipo: 'error', codigo: 'ZIP_INVALID' }]);
    expect(ambito.close).toHaveBeenCalledOnce();
  });
});
