import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanCreate } from '@vanguard/contracts';
import { ErrorZip, analizarZipLocal, nombreSeguro, validarZip } from './zip-local';
import { LIM } from './zip/tipos';

const zip = (bytes: number[], nombre = 'proyecto.zip', relleno = 30) => new File([new Uint8Array([...bytes, ...Array(relleno).fill(0)])], nombre);
const CABECERA = [0x50, 0x4b, 0x03, 0x04];

describe('validarZip', () => {
  it('acepta un .zip con la cabecera local, también en mayúsculas', async () => {
    expect(await validarZip(zip(CABECERA))).toBeNull();
    expect(await validarZip(zip(CABECERA, 'PROYECTO.ZIP'))).toBeNull();
  });

  it('rechaza el nombre que no termina en .zip sin leer el archivo', async () => {
    for (const n of ['proyecto.tar.gz', 'proyecto.zip.exe', 'zip', 'proyecto.zi', 'proyecto'])
      expect(await validarZip(zip(CABECERA, n))).toBe('ZIP_NOT_ZIP_NAME');
  });

  it('pone los topes de ScanCreate: de 22 B a 25 MB', async () => {
    expect(await validarZip(zip(CABECERA, 'a.zip', 17))).toBe('ZIP_TOO_SMALL');      // 21 B
    expect(await validarZip(zip(CABECERA, 'a.zip', 18))).toBeNull();                 // 22 B
    const enorme = (size: number) => ({ name: 'a.zip', size, slice: () => new Blob([new Uint8Array(CABECERA)]) }) as unknown as File;
    expect(await validarZip(enorme(LIM.zip))).toBeNull();
    expect(await validarZip(enorme(LIM.zip + 1))).toBe('ZIP_TOO_BIG');
  });

  it('mira los 4 primeros bytes: GIF, un ZIP vacío o texto no pasan', async () => {
    expect(await validarZip(zip([0x47, 0x49, 0x46, 0x38]))).toBe('ZIP_BAD_MAGIC');
    expect(await validarZip(zip([0x50, 0x4b, 0x05, 0x06]))).toBe('ZIP_BAD_MAGIC');   // solo el fin de directorio central
    expect(await validarZip(zip([0x50, 0x4b, 0x03]))).toBe('ZIP_BAD_MAGIC');
  });

  it('un archivo que ya no se puede leer da ZIP_REJECTED', async () => {
    const roto = { name: 'a.zip', size: 100, slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }) } as unknown as File;
    expect(await validarZip(roto)).toBe('ZIP_REJECTED');
  });
});

describe('nombreSeguro', () => {
  const casa = (n: string) => ScanCreate.safeParse({ kind: 'zip', filename: n, size_bytes: 100 }).success;

  it('deja igual un nombre que ya casa con el contrato', () => {
    expect(nombreSeguro('mi-proyecto (v2)_final.zip')).toBe('mi-proyecto (v2)_final.zip');
  });

  it('cambia por «_» cada carácter fuera de [\\w .()-], uno por carácter y no por unidad UTF-16', () => {
    expect(nombreSeguro('código fuente.zip')).toBe('c_digo fuente.zip');
    expect(nombreSeguro('a/b\\c:d.zip')).toBe('a_b_c_d.zip');
    expect(nombreSeguro('app😀.zip')).toBe('app_.zip');
    expect(nombreSeguro(`${String.fromCodePoint(0x202e)}piz.exe.zip`)).toBe('_piz.exe.zip');   // U+202E (RLO)
    expect(nombreSeguro('a\u0000b<c>.zip')).toBe('a_b_c_.zip');
  });

  it('la extensión sale en minúsculas y un nombre vacío no queda vacío', () => {
    expect(nombreSeguro('PROYECTO.ZIP')).toBe('PROYECTO.zip');
    expect(nombreSeguro('.zip')).toBe('_.zip');
    expect(nombreSeguro('')).toBe('_.zip');
    expect(nombreSeguro('sin-extension')).toBe('sin-extension.zip');
  });

  it('recorta la base a 120 caracteres', () => {
    const n = nombreSeguro(`${'á'.repeat(300)}.zip`);
    expect(n).toBe(`${'_'.repeat(120)}.zip`);
  });

  it('todo lo que devuelve pasa ScanCreate', () => {
    for (const n of ['código.zip', 'a'.repeat(500), '../../etc/passwd.zip', '日本語.ZIP', '', ' .zip', 'x.zip.zip'])
      expect(casa(nombreSeguro(n))).toBe(true);
  });
});

// El Worker de verdad no existe en el entorno node de vitest: lo sustituye uno falso que el test maneja a mano.
class WorkerFalso {
  static todos: WorkerFalso[] = [];
  static falla = false;
  url: URL;
  opciones: WorkerOptions | undefined;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  enviado: unknown[] = [];
  terminado = 0;
  constructor(url: URL, opciones?: WorkerOptions) {
    if (WorkerFalso.falla) throw new Error('SecurityError');
    this.url = url;
    this.opciones = opciones;
    WorkerFalso.todos.push(this);
  }
  postMessage(m: unknown) { this.enviado.push(m); }
  terminate() { this.terminado++; }
  emitir(data: unknown) { this.onmessage?.({ data }); }
}

const RESULTADO = {
  files_seen: 3,
  deps: [{ ecosystem: 'npm', name: 'react', version: '19.3.1', dev: false, direct: true, manifest: 'package.json' }],
  findings: [{ rule_id: 'CB_SECRET_AWS', severity: 'critical', title: 'Clave de AWS en src/a.ts', resource: 'src/a.ts:3',
    evidence: { path: 'src/a.ts', line: 3, preview: 'AKIA…WXYZ' } }],
  analyzer: 'core@0.1.0',
};
const ANALISIS = { resultado: RESULTADO, avisos: [], resumen: { archivos: 3, deps: 1, lockfiles: 1, secretos: 1, env: 0 } };

describe('analizarZipLocal', () => {
  beforeEach(() => {
    WorkerFalso.todos = [];
    WorkerFalso.falla = false;
    vi.stubGlobal('Worker', WorkerFalso);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const ultimo = () => WorkerFalso.todos.at(-1)!;
  const codigoDe = (p: Promise<unknown>) => p.then(() => 'resolvió', (e: unknown) => (e instanceof ErrorZip ? e.codigo : 'otro error'));

  it('abre el worker de módulo del mismo origen, le pasa el File, avisa del progreso y termina el worker', async () => {
    const archivo = zip(CABECERA);
    const fases: string[] = [];
    const p = analizarZipLocal(archivo, (f) => fases.push(f));
    const w = ultimo();
    expect(w.url.href).toMatch(/\/modulos\/codebase\/zip\/zip\.worker\.ts$/);
    expect(w.opciones).toEqual({ type: 'module' });
    expect(w.enviado).toEqual([{ archivo }]);
    w.emitir({ tipo: 'progreso', fase: 'leyendo' });
    w.emitir({ tipo: 'progreso', fase: 'analizando' });
    w.emitir({ tipo: 'listo', analisis: ANALISIS });
    const a = await p;
    expect(fases).toEqual(['leyendo', 'analizando']);
    expect(w.terminado).toBe(1);
    // ZipResult quita lo que sobra en los niveles que no son estrictos (direct y manifest de core).
    expect(a.resultado.deps).toEqual([{ ecosystem: 'npm', name: 'react', version: '19.3.1', dev: false }]);
    expect(a.resultado.findings).toEqual(RESULTADO.findings);
    expect(a.resumen).toEqual(ANALISIS.resumen);
  });

  it('un resultado fuera de contrato da ZIP_INVALID: evidence es estricta y el preview cabe en 12', async () => {
    const malos = [
      { ...RESULTADO, findings: [{ ...RESULTADO.findings[0], evidence: { path: 'src/a.ts', line: 3, preview: 'AKIA…WXYZ', snippet: 'x' } }] },
      { ...RESULTADO, findings: [{ ...RESULTADO.findings[0], evidence: { path: 'id_rsa', preview: '-----BEGIN … PRIVATE KEY-----' } }] },
      { ...RESULTADO, findings: [{ ...RESULTADO.findings[0], rule_id: 'CB_ZIP_HAS_GIT' }] },
      { ...RESULTADO, deps: [{ ecosystem: 'PyPI', name: 'x', version: '1' }] },
    ];
    for (const resultado of malos) {
      const p = analizarZipLocal(zip(CABECERA), () => {});
      const w = ultimo();
      w.emitir({ tipo: 'listo', analisis: { ...ANALISIS, resultado } });
      expect(await codigoDe(p)).toBe('ZIP_INVALID');
      expect(w.terminado).toBe(1);
    }
  });

  it('pasa tal cual el código de error del worker', async () => {
    const p = analizarZipLocal(zip(CABECERA), () => {});
    ultimo().emitir({ tipo: 'error', codigo: 'ZIP_RATIO' });
    expect(await codigoDe(p)).toBe('ZIP_RATIO');
    expect(ultimo().terminado).toBe(1);
  });

  it('si el worker muere o el mensaje no se puede leer, ZIP_REJECTED', async () => {
    const p1 = analizarZipLocal(zip(CABECERA), () => {});
    const prevenir = vi.fn();
    ultimo().onerror?.({ preventDefault: prevenir });
    expect(await codigoDe(p1)).toBe('ZIP_REJECTED');
    expect(prevenir).toHaveBeenCalledOnce();
    expect(ultimo().terminado).toBe(1);

    const p2 = analizarZipLocal(zip(CABECERA), () => {});
    ultimo().onmessageerror?.();
    expect(await codigoDe(p2)).toBe('ZIP_REJECTED');
    expect(ultimo().terminado).toBe(1);
  });

  it('si no se puede crear el worker, ZIP_REJECTED', async () => {
    WorkerFalso.falla = true;
    expect(await codigoDe(analizarZipLocal(zip(CABECERA), () => {}))).toBe('ZIP_REJECTED');
  });

  it('pasado el límite de tiempo, ZIP_REJECTED; lo que llegue después no cuenta', async () => {
    vi.useFakeTimers();
    try {
      const fases: string[] = [];
      const p = analizarZipLocal(zip(CABECERA), (f) => fases.push(f), { limiteMs: 1000 });
      const w = ultimo();
      vi.advanceTimersByTime(999);
      expect(w.terminado).toBe(0);
      vi.advanceTimersByTime(1);
      expect(await codigoDe(p)).toBe('ZIP_REJECTED');
      w.emitir({ tipo: 'progreso', fase: 'analizando' });
      w.emitir({ tipo: 'listo', analisis: ANALISIS });
      expect(fases).toEqual([]);
      expect(w.terminado).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('el límite por defecto es de 120 s', async () => {
    vi.useFakeTimers();
    try {
      const p = analizarZipLocal(zip(CABECERA), () => {});
      vi.advanceTimersByTime(119_999);
      expect(ultimo().terminado).toBe(0);
      vi.advanceTimersByTime(1);
      expect(await codigoDe(p)).toBe('ZIP_REJECTED');
    } finally { vi.useRealTimers(); }
  });

  it('al abortar (el usuario se fue de la pantalla) termina el worker', async () => {
    const c = new AbortController();
    const p = analizarZipLocal(zip(CABECERA), () => {}, { senal: c.signal });
    c.abort();
    expect(await codigoDe(p)).toBe('ZIP_REJECTED');
    expect(ultimo().terminado).toBe(1);
    const antes = WorkerFalso.todos.length;
    expect(await codigoDe(analizarZipLocal(zip(CABECERA), () => {}, { senal: c.signal }))).toBe('ZIP_REJECTED');
    expect(WorkerFalso.todos.length).toBe(antes);       // ya abortada: ni se crea
  });
});
