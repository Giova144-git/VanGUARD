// Análisis local del ZIP desde el hilo principal (F-18, S14 §14.12 #1-#2). Valida sin red ni Worker, abre el worker de
// módulo (mismo origen: la CSP script-src 'self' lo deja correr; uno blob: no) y valida el ZipResult aquí, ya sin JIT.
// Nada de importar zip/leer, zip/analizar ni el worker de forma estática: meterían core y fflate en el bundle (lint-imports).
import { ZipResult } from '@vanguard/contracts';
import { LIM, ZIP_MIN, type Analisis, type CodigoZip, type EntradaWorker, type FaseZip, type SalidaWorker } from './zip/tipos';

export class ErrorZip extends Error {
  readonly codigo: CodigoZip;
  constructor(codigo: CodigoZip) {
    super(codigo);
    this.name = 'ErrorZip';
    this.codigo = codigo;
  }
}

const MAGIC = [0x50, 0x4b, 0x03, 0x04];     // cabecera local del primer archivo

// Antes de abrir nada: nombre, tamaño (los topes de ScanCreate) y los 4 primeros bytes. Sin red ni Worker.
export async function validarZip(archivo: File): Promise<CodigoZip | null> {
  if (!/\.zip$/i.test(archivo.name)) return 'ZIP_NOT_ZIP_NAME';
  if (archivo.size < ZIP_MIN) return 'ZIP_TOO_SMALL';
  if (archivo.size > LIM.zip) return 'ZIP_TOO_BIG';
  try {
    const cab = new Uint8Array(await archivo.slice(0, 4).arrayBuffer());
    return MAGIC.every((b, i) => cab[i] === b) ? null : 'ZIP_BAD_MAGIC';
  } catch {
    return 'ZIP_REJECTED';                  // el archivo cambió o se borró después de elegirlo
  }
}

// filename de ScanCreate: /^[\w .()-]{1,120}\.zip$/i, con \w solo ASCII. Cada carácter fuera pasa a «_».
export function nombreSeguro(n: string): string {
  const base = [...n.replace(/\.zip$/i, '')].map((c) => (/^[\w .()-]$/.test(c) ? c : '_')).join('').slice(0, 120);
  return `${base || '_'}.zip`;
}

const LIMITE_MS = 120_000;

// El Worker termina siempre, salga bien o mal. `senal` lo corta si el usuario se va de la pantalla.
export function analizarZipLocal(archivo: File, alProgreso: (f: FaseZip) => void,
  opts: { limiteMs?: number; senal?: AbortSignal } = {}): Promise<Analisis> {
  return new Promise<Analisis>((resolver, rechazar) => {
    let worker: Worker | null = null;
    let reloj: ReturnType<typeof setTimeout> | undefined;
    const acabar = (fin: () => void) => {
      if (!worker) return;
      clearTimeout(reloj);
      opts.senal?.removeEventListener('abort', cortar);
      worker.terminate();
      worker = null;
      fin();
    };
    const fallar = (codigo: CodigoZip) => acabar(() => rechazar(new ErrorZip(codigo)));
    const cortar = () => fallar('ZIP_REJECTED');
    if (opts.senal?.aborted) return rechazar(new ErrorZip('ZIP_REJECTED'));
    try {
      worker = new Worker(new URL('./zip/zip.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return rechazar(new ErrorZip('ZIP_REJECTED'));
    }
    reloj = setTimeout(cortar, opts.limiteMs ?? LIMITE_MS);
    opts.senal?.addEventListener('abort', cortar);
    // Sin memoria, CSP o un fallo al cargar el módulo: preventDefault para que no salga en la consola como error sin atrapar.
    worker.onerror = (e) => { e.preventDefault(); cortar(); };
    worker.onmessageerror = cortar;
    worker.onmessage = (e: MessageEvent<SalidaWorker>) => {
      const m = e.data;
      if (m.tipo === 'progreso') { if (worker) alProgreso(m.fase); return; }
      if (m.tipo === 'error') return fallar(m.codigo);
      // El worker no lleva zod: el contrato se comprueba aquí y lo que sobre a nivel de objeto normal se quita.
      const r = ZipResult.safeParse(m.analisis.resultado);
      if (!r.success) return fallar('ZIP_INVALID');
      acabar(() => resolver({ ...m.analisis, resultado: r.data }));
    };
    worker.postMessage({ archivo } satisfies EntradaWorker);
  });
}
