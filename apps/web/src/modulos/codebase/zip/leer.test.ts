// leerZip con ZIP armados en la prueba con zipSync (S09 09.14 #1 y #2, 06.10). Las bombas que mienten se hacen
// parcheando en los bytes del ZIP el tamaño declarado, en la cabecera local y en el directorio central.
import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { LIM, leerZip, normalizarRuta, ZipError } from './leer';

const te = new TextEncoder();
const txt = (s: string) => te.encode(s);
const zip = (z: Zippable) => zipSync(z, { mtime: new Date('2026-01-01T00:00:00Z') });

// Recorre el directorio central y, en las entradas cuyo nombre casa, cambia lo que se pide: el tamaño original o el
// comprimido declarados (en la cabecera local, en el directorio central o en ambos) o el método de compresión.
type Parche = { original?: number; comprimido?: number; metodo?: number; donde?: 'ambos' | 'central' };
function parchear(z: Uint8Array, nombre: RegExp, x: Parche): Uint8Array {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let e = z.length - 22;
  while (v.getUint32(e, true) !== 0x06054b50) e--;
  let o = v.getUint32(e + 16, true);
  for (let i = 0, n = v.getUint16(e + 10, true); i < n; i++) {
    const fnl = v.getUint16(o + 28, true), efl = v.getUint16(o + 30, true), cl = v.getUint16(o + 32, true);
    if (nombre.test(new TextDecoder().decode(z.subarray(o + 46, o + 46 + fnl)))) {
      const local = v.getUint32(o + 42, true), ambos = (x.donde ?? 'ambos') === 'ambos';
      if (x.metodo !== undefined) { v.setUint16(o + 10, x.metodo, true); if (ambos) v.setUint16(local + 8, x.metodo, true); }
      if (x.comprimido !== undefined) { v.setUint32(o + 20, x.comprimido, true); if (ambos) v.setUint32(local + 18, x.comprimido, true); }
      if (x.original !== undefined) { v.setUint32(o + 24, x.original, true); if (ambos) v.setUint32(local + 22, x.original, true); }
    }
    o += 46 + fnl + efl + cl;
  }
  return z;
}

function codigo(f: () => unknown): string {
  try { f(); } catch (e) { return e instanceof ZipError ? e.codigo : `no es ZipError: ${String(e)}`; }
  return 'no lanzó';
}

const claves = (m: Map<string, string>) => [...m.keys()].sort();

describe('normalizarRuta', () => {
  it('descarta rutas hostiles', () => {
    for (const r of ['../x', '/etc/x', 'C:\\x', 'a/../../b', '\u202e', 'src/\u202esj.nimda', 'a\u0000b', 'x'.repeat(513),
      Array(33).fill('d').join('/')]) expect(normalizarRuta(r)).toBeNull();
  });
  it('deja las normales y pasa \\ a /', () => {
    expect(normalizarRuta('src/a.ts')).toBe('src/a.ts');
    expect(normalizarRuta('a\\b.ts')).toBe('a/b.ts');
    expect(normalizarRuta(Array(32).fill('d').join('/'))).not.toBeNull();
  });
});

describe('leerZip', () => {
  it('reexporta los topes y su error lleva el código', () => {
    expect(LIM.archivo).toBe(1_000_000);
    const e = new ZipError('ZIP_RATIO');
    expect(e).toBeInstanceOf(Error);
    expect(e.codigo).toBe('ZIP_RATIO');
  });

  it('ignora las entradas con ruta hostil (../, unidad, U+202E)', () => {
    const z = zip({ 'README.md': txt('# hola'), 'src/a.ts': txt('export const a = 1;'), '../x.js': txt('malo'),
      'C:\\x.js': txt('malo'), 'evil\u202etxt.ts': txt('malo') });
    const { archivos, inventario } = leerZip(z, { origen: 'zip' });
    expect(claves(archivos)).toEqual(['README.md', 'src/a.ts']);
    expect(inventario.rutas.map((r) => r.p).sort()).toEqual(['README.md', 'src/a.ts']);
    expect(inventario).toMatchObject({ entradas: 5, leidos: 2, omitidos: 3, tiene_git: false });
  });

  it('20 001 entradas → ZIP_TOO_MANY_ENTRIES antes de mirar ninguna', () => {
    // La primera es una bomba de ratio: si se contara entrada a entrada, saltaría antes ZIP_RATIO.
    const z: Zippable = { 'a/ceros.txt': [new Uint8Array(5_000_000), { level: 1 }] };
    for (let i = 0; i < 20_000; i++) z[`v/${i}`] = [new Uint8Array(0), { level: 0 }];
    expect(codigo(() => leerZip(zip(z), { origen: 'zip' }))).toBe('ZIP_TOO_MANY_ENTRIES');
  });

  it('20 000 entradas diminutas (el tope) se leen sin desbordar la pila', () => {
    const z: Zippable = { 'src/a.ts': txt('export const a = 1;') };
    for (let i = 1; i < 20_000; i++) z[`v/${i}`] = [new Uint8Array(0), { level: 0 }];
    const { archivos, inventario } = leerZip(zip(z), { origen: 'zip' });
    expect(claves(archivos)).toEqual(['src/a.ts']);
    expect(inventario).toMatchObject({ entradas: 20_000, leidos: 1, omitidos: 19_999 });
  });

  it('costes declarados de más de 40 MB → ZIP_TOO_BIG_UNCOMPRESSED (archivos de 900 KB, sin bomba)', () => {
    let s = '';
    for (let i = 0; s.length < 900_000; i++) s += `export const valor${i % 50} = 'relleno del ejemplo número ${i % 50}';\n`;
    const b = txt(s.slice(0, 900_000)), z: Zippable = {};
    for (let i = 0; i < 47; i++) z[`src/m${i}.ts`] = [b, { level: 1 }];   // 47 × 900 KB = 42,3 MB; ratio ~50
    const comprimido = zip(z);
    expect(comprimido.length).toBeLessThan(LIM.zip);
    expect(codigo(() => leerZip(comprimido, { origen: 'zip' }))).toBe('ZIP_TOO_BIG_UNCOMPRESSED');
  });

  it('5 MB de ceros: ZIP_RATIO si es el ZIP del usuario, omitido si viene del repo', () => {
    const z = zip({ 'datos/ceros.txt': new Uint8Array(5_000_000), 'src/a.ts': txt('export const a = 1;') });
    expect(codigo(() => leerZip(z, { origen: 'zip' }))).toBe('ZIP_RATIO');
    const { archivos, inventario } = leerZip(z, { origen: 'repo' });
    expect(claves(archivos)).toEqual(['src/a.ts']);
    expect(inventario.rutas).toContainEqual({ p: 'datos/ceros.txt', s: 5_000_000 });
  });

  it('stored que declara 10 B y ocupa 2 MB → se lista y no se lee (cuenta su size)', () => {
    const z = parchear(zip({ 'notas.txt': [new Uint8Array(2_000_000).fill(97), { level: 0 }], 'src/a.ts': txt('export const a = 1;') }),
      /^notas\.txt$/, { original: 10 });
    const { archivos, inventario } = leerZip(z, { origen: 'zip' });
    expect(claves(archivos)).toEqual(['src/a.ts']);
    expect(inventario.rutas).toContainEqual({ p: 'notas.txt', s: 10 });
  });

  it('stored cuyo directorio central declara 10 B pero la cabecera local trae 2 MB → se corta por bytes reales', () => {
    const z = parchear(zip({ 'notas.txt': [new Uint8Array(2_000_000).fill(97), { level: 0 }], 'src/a.ts': txt('export const a = 1;') }),
      /^notas\.txt$/, { original: 10, comprimido: 10, donde: 'central' });
    const { archivos } = leerZip(z, { origen: 'zip' });
    expect(claves(archivos)).toEqual(['src/a.ts']);
  });

  it('rechaza lo que no es un ZIP, el ZIP vacío, el truncado y el que pasa de 25 MB', () => {
    expect(codigo(() => leerZip(txt('GIF89a....'), { origen: 'zip' }))).toBe('ZIP_BAD_MAGIC');
    const vacio = zipSync({});
    expect(vacio.length).toBe(22);
    expect(codigo(() => leerZip(vacio, { origen: 'zip' }))).toBe('ZIP_BAD_MAGIC');
    expect(codigo(() => leerZip(new Uint8Array(0), { origen: 'zip' }))).toBe('ZIP_BAD_MAGIC');
    const z = zip({ 'src/a.ts': txt('export const a = 1;\n'.repeat(500)), 'README.md': txt('# hola') });
    expect(codigo(() => leerZip(z.subarray(0, z.length >> 1), { origen: 'zip' }))).toBe('ZIP_INVALID');
    const grande = new Uint8Array(LIM.zip + 1);
    grande.set([0x50, 0x4b, 0x03, 0x04]);
    expect(codigo(() => leerZip(grande, { origen: 'zip' }))).toBe('ZIP_TOO_BIG');
  });

  it('un deflate roto en una entrada elegida → ZIP_INVALID', () => {
    const z = zip({ 'src/a.ts': txt('export const a = 1;\n'.repeat(500)), 'README.md': txt('# hola') });
    const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
    const datos = 30 + v.getUint16(26, true) + v.getUint16(28, true);   // la primera entrada empieza en 0
    z.fill(0xff, datos, datos + 8);                                      // BTYPE = 3: tipo de bloque inválido
    expect(codigo(() => leerZip(z, { origen: 'zip' }))).toBe('ZIP_INVALID');
  });

  it('solo lee los métodos 0 y 8', () => {
    const z = parchear(zip({ 'src/a.ts': txt('export const a = 1;'), 'src/b.ts': txt('export const b = 2;'), 'README.md': txt('#') }),
      /^src\/b\.ts$/, { metodo: 12 });
    const { archivos, inventario } = leerZip(z, { origen: 'zip' });
    expect(claves(archivos)).toEqual(['README.md', 'src/a.ts']);
    expect(inventario.rutas.map((r) => r.p)).toContain('src/b.ts');
  });

  it('zipball: quita la raíz, marca .git, lee wrangler.jsonc y .env y omite binarios, dependencias y ZIP anidados', () => {
    const r = 'o-r-abc1234/';
    const z = zip({
      [r]: new Uint8Array(0),
      [`${r}wrangler.jsonc`]: txt('{ "name": "victima" }'),
      [`${r}.env`]: txt('API_URL=https://example.com\n'),
      [`${r}.git/config`]: txt('[core]\n'),
      [`${r}src/index.ts`]: txt('export default {};'),
      [`${r}src/datos.json`]: new Uint8Array([123, 0, 125]),
      [`${r}node_modules/x/index.js`]: txt('module.exports = 1;'),
      [`${r}public/app.min.js`]: txt('!function(){}()'),
      [`${r}interno.zip`]: zip({ 'secreto.ts': txt('x') }),
    });
    const { archivos, inventario } = leerZip(z, { origen: 'zip' });
    expect(claves(archivos)).toEqual(['.env', 'src/index.ts', 'wrangler.jsonc']);
    expect(archivos.get('wrangler.jsonc')).toBe('{ "name": "victima" }');
    expect(inventario.tiene_git).toBe(true);
    expect(inventario.rutas.map((x) => x.p).sort()).toEqual(['.env', '.git/config', 'interno.zip', 'node_modules/x/index.js',
      'public/app.min.js', 'src/datos.json', 'src/index.ts', 'wrangler.jsonc']);
    expect(inventario).toMatchObject({ entradas: 9, leidos: 3, omitidos: 6 });
  });

  describe('bomba que miente en su tamaño', () => {
    const bomba = (datos: Uint8Array) => parchear(zip({ 'src/bomba.ts': datos, 'src/ok.ts': txt('export const ok = 1;'),
      'README.md': txt('#') }), /bomba/, { original: 100 });

    it('un .ts de 3 MB de ceros que declara 100 B → se omite: no salen más de LIM.archivo bytes', () => {
      const z = bomba(new Uint8Array(3_000_000));
      // unzipSync se fía de lo declarado: reserva 100 B y devuelve el archivo truncado, sin error (ver cabecera de leer.ts).
      expect(unzipSync(z)['src/bomba.ts']?.length).toBe(100);
      const { archivos, inventario } = leerZip(z, { origen: 'zip' });
      expect(claves(archivos)).toEqual(['README.md', 'src/ok.ts']);
      expect(inventario.rutas).toContainEqual({ p: 'src/bomba.ts', s: 100 });
      expect(inventario).toMatchObject({ leidos: 2, omitidos: 1 });
    });

    it('con texto ("0" × 3 MB, sin NUL) también se omite: la para el corte por bytes reales, no el filtro de binarios', () => {
      const { archivos } = leerZip(bomba(new Uint8Array(3_000_000).fill(0x30)), { origen: 'zip' });
      expect(claves(archivos)).toEqual(['README.md', 'src/ok.ts']);
    });

    it('si miente pero trae ≤ LIM.archivo bytes reales, se lee entera', () => {
      const { archivos } = leerZip(bomba(new Uint8Array(LIM.archivo).fill(0x30)), { origen: 'zip' });
      expect(archivos.get('src/bomba.ts')?.length).toBe(LIM.archivo);
    });

    it('pocas así: todas omitidas; tantas que pasan de 40 MB reales → ZIP_TOO_BIG_UNCOMPRESSED', () => {
      const ceros = new Uint8Array(1_100_000).fill(0x30);
      const pocas: Zippable = { 'src/ok.ts': txt('export const ok = 1;'), 'README.md': txt('#') };
      for (let i = 0; i < 3; i++) pocas[`src/b${i}.ts`] = [ceros, { level: 1 }];
      const { archivos } = leerZip(parchear(zip(pocas), /\/b\d+\.ts$/, { original: 100 }), { origen: 'zip' });
      expect(claves(archivos)).toEqual(['README.md', 'src/ok.ts']);
      // Cada una se corta al pasar de 1 MB reales: 42 suman más de 42 000 000 B > LIM.total, aunque declaren 4 200 B.
      const muchas: Zippable = {};
      for (let i = 0; i < 42; i++) muchas[`src/b${i}.ts`] = [ceros, { level: 1 }];
      const z = parchear(zip(muchas), /\/b\d+\.ts$/, { original: 100 });
      expect(codigo(() => leerZip(z, { origen: 'zip' }))).toBe('ZIP_TOO_BIG_UNCOMPRESSED');
    });
  });
});
