// Pruebas defensivas de leerZip con ZIP manipulados a mano (F-18): cabecera local y directorio central que no casan,
// fin de directorio central que miente, entradas duplicadas, metadatos de macOS y un proyecto dentro de «dist/».
import { describe, expect, it } from 'vitest';
import { zipSync, type Zippable } from 'fflate';
import { leerZip, ZipError } from './leer';

const te = new TextEncoder();
const zip = (z: Zippable) => zipSync(z, { mtime: new Date('2026-01-01T00:00:00Z') });
const claves = (m: Map<string, string>) => [...m.keys()].sort();

function eocd(z: Uint8Array): number {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let e = z.length - 22;
  while (v.getUint32(e, true) !== 0x06054b50) e--;
  return e;
}

// Cambia el nombre de una entrada solo en la cabecera local o solo en el directorio central (mismo largo, para no mover
// nada): así un ZIP «dice» un nombre en un sitio y otro en el otro.
function renombrar(z: Uint8Array, de: string, a: string, donde: 'local' | 'central'): Uint8Array {
  if (de.length !== a.length) throw new Error('mismo largo');
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const e = eocd(z);
  let o = v.getUint32(e + 16, true);
  for (let i = 0, n = v.getUint16(e + 10, true); i < n; i++) {
    const fnl = v.getUint16(o + 28, true), efl = v.getUint16(o + 30, true), cl = v.getUint16(o + 32, true);
    if (new TextDecoder().decode(z.subarray(o + 46, o + 46 + fnl)) === de) {
      const local = v.getUint32(o + 42, true);
      z.set(te.encode(a), donde === 'central' ? o + 46 : local + 30);
    }
    o += 46 + fnl + efl + cl;
  }
  return z;
}

function codigo(f: () => unknown): string {
  try { f(); } catch (e) { return e instanceof ZipError ? e.codigo : `no es ZipError: ${String(e)}`; }
  return 'no lanzó';
}

describe('cabecera local y directorio central que no casan', () => {
  it('central inocente y local «../x.ts»: la entrada no se lee y no aparece ninguna ruta con ..', () => {
    const z = renombrar(zip({ 'safe.ts': te.encode('const a = 1;'), 'b.ts': te.encode('ok') }), 'safe.ts', '../x.ts', 'local');
    const { archivos } = leerZip(z, { origen: 'zip' });
    expect(claves(archivos)).toEqual(['b.ts']);
    expect([...archivos.keys()].some((k) => k.includes('..'))).toBe(false);
  });

  it('central «../x.ts» y local inocente: tampoco se lee (se elige por el directorio central)', () => {
    const z = renombrar(zip({ 'safe.ts': te.encode('const a = 1;'), 'b.ts': te.encode('ok') }), 'safe.ts', '../x.ts', 'central');
    const { archivos, inventario } = leerZip(z, { origen: 'zip' });
    expect(claves(archivos)).toEqual(['b.ts']);
    expect(inventario.rutas.map((r) => r.p)).not.toContain('../x.ts');
  });

  it('central «nota.md» y local «.env.md»: lo que se lee lleva el nombre del directorio central', () => {
    const z = renombrar(zip({ 'nota.md': te.encode('hola') }), 'nota.md', '.env.md', 'local');
    const { archivos } = leerZip(z, { origen: 'zip' });
    expect([...archivos.keys()]).not.toContain('.env.md');
  });
});

describe('fin de directorio central que miente', () => {
  it('declara 1 entrada con 20 001 detrás: o lanza ZIP_TOO_MANY_ENTRIES o solo lee la que declara', () => {
    const z: Zippable = { '.env': te.encode('A=1') };
    for (let i = 0; i < 20_001; i++) z[`f${i}.ts`] = te.encode('');
    const b = zip(z);
    const e = eocd(b);
    new DataView(b.buffer, b.byteOffset).setUint16(e + 8, 1, true);
    new DataView(b.buffer, b.byteOffset).setUint16(e + 10, 1, true);
    let leidas: string[] | null = null;
    const c = codigo(() => { leidas = claves(leerZip(b, { origen: 'zip' }).archivos); });
    if (c === 'no lanzó') expect(leidas!.length).toBeLessThanOrEqual(1);
    else expect(['ZIP_TOO_MANY_ENTRIES', 'ZIP_INVALID']).toContain(c);
  }, 30_000);   // armar 20 001 entradas tarda ~1,5 s solo, pero pasó de 5 s con `pnpm -r test` corriendo los paquetes a la vez

  it('un comentario del ZIP con una firma EOCD falsa no rompe el tope ni deja pasar nada', () => {
    const b = zip({ 'a.ts': te.encode('x') });
    // Comentario de 22 B que imita un EOCD con 0xFFFF entradas: el último EOCD real va antes; el falso queda detrás.
    const falso = new Uint8Array(22);
    new DataView(falso.buffer).setUint32(0, 0x06054b50, true);
    new DataView(falso.buffer).setUint16(8, 0xffff, true);
    new DataView(falso.buffer).setUint16(10, 0xffff, true);
    const conCom = new Uint8Array(b.length + falso.length);
    conCom.set(b);
    conCom.set(falso, b.length);
    new DataView(conCom.buffer).setUint16(eocd(b) + 20, falso.length, true);   // longitud del comentario
    expect(['ZIP_TOO_MANY_ENTRIES', 'ZIP_INVALID', 'no lanzó']).toContain(codigo(() => leerZip(conCom, { origen: 'zip' })));
  });
});

describe('entradas duplicadas y nombres raros', () => {
  it('dos entradas con el mismo nombre: no lanza y queda una sola clave', () => {
    const a = zip({ '.env': te.encode('A=1') });
    const b = renombrar(zip({ '.env': te.encode('A=1'), '.enw': te.encode('B=2') }), '.enw', '.env', 'central');
    for (const z of [a, renombrar(b, '.enw', '.env', 'local')]) {
      const { archivos } = leerZip(z, { origen: 'zip' });
      expect(claves(archivos)).toEqual(['.env']);
    }
  });

  it('«./src/a.ts», mayúsculas y barra invertida se normalizan o se descartan, nunca salen tal cual', () => {
    const { archivos } = leerZip(zip({ 'src\\a.ts': te.encode('1'), '.ENV': te.encode('A=1') }), { origen: 'zip' });
    expect(claves(archivos)).toEqual(['.ENV', 'src/a.ts']);
  });
});

describe('macOS y carpetas con nombre de las que se saltan', () => {
  it('«Comprimir» del Finder: __MACOSX y .DS_Store no cuentan y la raíz del proyecto se quita', () => {
    const { archivos, inventario } = leerZip(zip({
      'proyecto/.gitignore': te.encode('.env\n'),
      'proyecto/.env': te.encode('A=1'),
      'proyecto/.DS_Store': new Uint8Array([0, 0, 0, 1]),
      '__MACOSX/proyecto/._.env': new Uint8Array([0, 5, 22, 7, 0, 2]),
      '__MACOSX/proyecto/._.gitignore': new Uint8Array([0, 5, 22, 7, 0, 2]),
    }), { origen: 'zip' });
    expect(claves(archivos)).toEqual(['.env', '.gitignore']);
    expect(inventario.rutas.map((r) => r.p).sort()).toEqual(['.env', '.gitignore']);
  });

  it('un proyecto dentro de una carpeta «dist» o «build» no se salta entero', () => {
    for (const raiz of ['dist', 'build', 'vendor']) {
      const { archivos } = leerZip(zip({ [`${raiz}/package-lock.json`]: te.encode('{}'), [`${raiz}/src/a.ts`]: te.encode('1'),
        [`${raiz}/node_modules/x/index.js`]: te.encode('1') }), { origen: 'zip' });
      expect(claves(archivos)).toEqual(['package-lock.json', 'src/a.ts']);
    }
  });
});
