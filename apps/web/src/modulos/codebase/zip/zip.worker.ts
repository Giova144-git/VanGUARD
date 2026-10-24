// Web Worker de módulo del ZIP local (F-18, S14 §14.12 #2-#3). Los valores en claro de los secretos solo viven aquí: al
// hilo principal sale el Analisis ya tapado. Sin zod (el ZipResult se valida fuera) y sin console (L10).
import { analizarZip } from './analizar';
import { leerZip, ZipError } from './leer';
import type { EntradaWorker, SalidaWorker } from './tipos';

// El tsconfig no carga la lib WebWorker: basta con lo que este archivo usa del ámbito del worker.
type Ambito = { onmessage: ((e: MessageEvent<EntradaWorker>) => void) | null; postMessage: (m: SalidaWorker) => void; close: () => void };
const ambito = self as unknown as Ambito;
const enviar = (m: SalidaWorker) => ambito.postMessage(m);

ambito.onmessage = async (e) => {
  ambito.onmessage = null;                  // un archivo por worker
  try {
    enviar({ tipo: 'progreso', fase: 'leyendo' });
    let buf: ArrayBuffer | null = await e.data.archivo.arrayBuffer();
    const { archivos, inventario } = leerZip(new Uint8Array(buf), { origen: 'zip' });
    buf = null;                             // hasta 25 MB que el GC ya puede soltar mientras se analiza
    enviar({ tipo: 'progreso', fase: 'analizando' });
    const analisis = await analizarZip(archivos, inventario);
    archivos.clear();
    enviar({ tipo: 'listo', analisis });
  } catch (err) {
    enviar({ tipo: 'error', codigo: err instanceof ZipError ? err.codigo : 'ZIP_INVALID' });
  } finally {
    ambito.close();
  }
};
