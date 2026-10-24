// Pruebas mínimas de B2 (asignaciones/revision-codigo.md §8.2) para revision/diff.ts. Todo valor con forma de secreto
// se arma en tiempo de ejecución (como secrets/scan.test.ts): ningún escáner encuentra literales en el repo.
import { describe, it, expect } from 'vitest';
import { archivoCompacto, envDelDiff, LIM_DIFF, parsearDiff, secretosDelDiff, type ArchivoCompacto,
  type ArchivoDiff } from './diff.ts';
import { escanearSecretos } from '../secrets/scan.ts';

const RICO = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv';
const R = (n: number, base = RICO) => base.repeat(Math.ceil(n / base.length)).slice(0, n);
const T = {
  stripe: 'sk' + '_live_' + R(24),
  sbSecret: 'sb_' + 'secret_' + R(32),
  generico: R(32, 'Uv0St9Qr8Op7Mn6Kl5Ij4Gh3Ef2Cd1Ab'),
};
const diff = (...ls: string[]) => ls.join('\n') + '\n';
const nuevo = (path: string, ls: readonly string[]) => [`diff --git a/${path} b/${path}`, 'new file mode 100644',
  'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${ls.length} @@`, ...ls.map((l) => '+' + l)];
const compactos = (as: readonly ArchivoDiff[]) => as.map(archivoCompacto).filter((c): c is ArchivoCompacto => c !== null);
const cs0 = (as: readonly ArchivoDiff[]) => compactos(as).map((c) => c.archivo);
const corto = (a: ArchivoDiff) => a.lineas.map((l) => `${l.t}${l.linea ?? '·'}:${l.texto}`);

describe('parsearDiff', () => {
  it('archivo nuevo: added, líneas de head desde 1', () => {
    const r = parsearDiff(diff(...nuevo('src/nuevo.ts', ['const a = 1;', 'const b = 2;', 'export { a, b };'])));
    expect(r.cortado).toBe(false);
    expect(r.archivos).toHaveLength(1);
    expect(r.archivos[0]).toMatchObject({ path: 'src/nuevo.ts', estado: 'added', binario: false });
    expect(corto(r.archivos[0]!)).toEqual(['+1:const a = 1;', '+2:const b = 2;', '+3:export { a, b };']);
  });
  it('modificado con dos hunks: contexto y añadidas con su línea de head, borradas sin línea', () => {
    const r = parsearDiff(diff('diff --git a/src/app.ts b/src/app.ts', 'index 2222222..3333333 100644', '--- a/src/app.ts',
      '+++ b/src/app.ts', '@@ -1,3 +1,4 @@', " import x from 'x';", "+import y from 'y';", ' const a = 1;', ' const b = 2;',
      '@@ -10,2 +11,3 @@ function f() {', ' uno', '-dos', '+DOS', '+tres'));
    expect(r.cortado).toBe(false);
    expect(r.archivos[0]).toMatchObject({ path: 'src/app.ts', estado: 'modified', binario: false });
    expect(corto(r.archivos[0]!)).toEqual([" 1:import x from 'x';", "+2:import y from 'y';", ' 3:const a = 1;', ' 4:const b = 2;',
      ' 11:uno', '-·:dos', '+12:DOS', '+13:tres']);
    expect(archivoCompacto(r.archivos[0]!)).toEqual({ archivo: { path: 'src/app.ts', content: "import y from 'y';\nDOS\ntres" },
      lineas: [2, 12, 13] });
  });
  it('borrado: deleted, sin compacto y sin cortar', () => {
    const r = parsearDiff(diff('diff --git a/viejo.txt b/viejo.txt', 'deleted file mode 100644', 'index 4444444..0000000',
      '--- a/viejo.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b'));
    expect(r).toMatchObject({ cortado: false, archivos: [{ path: 'viejo.txt', estado: 'deleted', binario: false }] });
    expect(corto(r.archivos[0]!)).toEqual(['-·:a', '-·:b']);
    expect(archivoCompacto(r.archivos[0]!)).toBeNull();
  });
  it('renombrado: la ruta nueva, con cambios y al 100 % sin hunks', () => {
    const r = parsearDiff(diff('diff --git a/config/viejo.env b/.env.production', 'similarity index 90%',
      'rename from config/viejo.env', 'rename to .env.production', 'index 5555555..6666666 100644', '--- a/config/viejo.env',
      '+++ b/.env.production', '@@ -1,2 +1,2 @@', ' A=1', '-B=2', '+B=3',
      'diff --git a/src/a.ts b/src/b.ts', 'similarity index 100%', 'rename from src/a.ts', 'rename to src/b.ts'));
    expect(r.cortado).toBe(false);
    expect(r.archivos.map((a) => [a.path, a.estado, a.lineas.length]))
      .toEqual([['.env.production', 'renamed', 3], ['src/b.ts', 'renamed', 0]]);
    expect(corto(r.archivos[0]!)).toEqual([' 1:A=1', '-·:B=2', '+2:B=3']);
  });
  it('binario multimedia: binario sin cortado, también con GIT binary patch', () => {
    const r = parsearDiff(diff('diff --git a/public/logo.png b/public/logo.png', 'new file mode 100644', 'index 0000000..7777777',
      'Binary files /dev/null and b/public/logo.png differ',
      'diff --git a/public/foto.jpg b/public/foto.jpg', 'index 8888888..9999999 100644', 'GIT binary patch', 'literal 12',
      'TcmZ?wbN~PU|0@6g7y<x+', '', 'literal 0', 'HcmV?d00001', ''));
    expect(r.cortado).toBe(false);
    expect(r.archivos.map((a) => [a.path, a.estado, a.binario, a.lineas.length]))
      .toEqual([['public/logo.png', 'added', true, 0], ['public/foto.jpg', 'modified', true, 0]]);
    expect(r.archivos.map(archivoCompacto)).toEqual([null, null]);
  });
  it('.ts binario (un NUL dentro): cortado; el siguiente archivo se lee igual; un binario borrado no corta', () => {
    const bin = parsearDiff(diff('diff --git a/src/raro.ts b/src/raro.ts', 'new file mode 100644', 'index 0000000..aaaaaaa',
      'Binary files /dev/null and b/src/raro.ts differ', ...nuevo('src/ok.ts', ['x'])));
    expect(bin.cortado).toBe(true);
    expect(bin.archivos.map((a) => [a.path, a.binario])).toEqual([['src/raro.ts', true], ['src/ok.ts', false]]);
    expect(archivoCompacto(bin.archivos[0]!)).toBeNull();
    const parche = parsearDiff(diff('diff --git a/src/raro.ts b/src/raro.ts', 'index bbbbbbb..ccccccc 100644', 'GIT binary patch',
      'literal 12', 'TcmZ?wbN~PU|0@6g7y<x+', ''));
    expect(parche).toMatchObject({ cortado: true, archivos: [{ path: 'src/raro.ts', binario: true }] });
    const borrado = parsearDiff(diff('diff --git a/src/raro.ts b/src/raro.ts', 'deleted file mode 100644', 'index ddddddd..0000000',
      'Binary files a/src/raro.ts and /dev/null differ'));
    expect(borrado).toMatchObject({ cortado: false, archivos: [{ path: 'src/raro.ts', estado: 'deleted', binario: true }] });
  });
  it('ruta entre comillas: se salta con cortado y el resto sigue', () => {
    const q = '"a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"';
    const r = parsearDiff(diff(`diff --git ${q}`, 'new file mode 100644', 'index 0000000..eeeeeee', '--- /dev/null',
      '+++ "b/src/caf\\303\\251.ts"', '@@ -0,0 +1 @@', `+const k = "${T.stripe}";`, ...nuevo('src/ok.ts', ['ok'])));
    expect(r.cortado).toBe(true);
    expect(r.archivos.map((a) => a.path)).toEqual(['src/ok.ts']);
    const borrado = parsearDiff(diff(`diff --git ${q}`, 'deleted file mode 100644', 'index eeeeeee..0000000',
      '--- "a/src/caf\\303\\251.ts"', '+++ /dev/null', '@@ -1 +0,0 @@', '-x'));
    expect(borrado).toEqual({ archivos: [], cortado: false });                        // un borrado no añade nada
  });
  it('CRLF: quita el \\r final, sea del archivo (líneas con \\r\\n) o del diff entero', () => {
    const delArchivo = parsearDiff(diff(...nuevo('src/crlf.ts', ['uno\r', 'dos\r'])));
    const delDiff = parsearDiff(nuevo('src/crlf.ts', ['uno', 'dos']).join('\r\n') + '\r\n');
    for (const r of [delArchivo, delDiff]) {
      expect(r.cortado).toBe(false);
      expect(r.archivos[0]).toMatchObject({ path: 'src/crlf.ts', estado: 'added' });
      expect(corto(r.archivos[0]!)).toEqual(['+1:uno', '+2:dos']);
    }
  });
  it('\\ No newline at end of file no es una línea', () => {
    const r = parsearDiff(diff('diff --git a/a.txt b/a.txt', 'index 1111111..2222222 100644', '--- a/a.txt', '+++ b/a.txt',
      '@@ -1 +1 @@', '-viejo', '\\ No newline at end of file', '+nuevo', '\\ No newline at end of file'));
    expect(corto(r.archivos[0]!)).toEqual(['-·:viejo', '+1:nuevo']);
  });
  it('una añadida que parece cabecera (`++ b/x`, `-- a/x`) sigue siendo contenido', () => {
    const r = parsearDiff(diff('diff --git a/n.md b/n.md', 'index 1111111..2222222 100644', '--- a/n.md', '+++ b/n.md',
      '@@ -1,2 +1,2 @@', '--- a/otro.md', '+++ b/otro.md', ' fin'));
    expect(r.archivos.map((a) => a.path)).toEqual(['n.md']);
    expect(corto(r.archivos[0]!)).toEqual(['-·:-- a/otro.md', '+1:++ b/otro.md', ' 2:fin']);
  });
  it('ruta con espacios: git añade un tab tras +++ y la cabecera se parte por la mitad', () => {
    const r = parsearDiff(diff('diff --git a/docs/mi archivo.md b/docs/mi archivo.md', 'new file mode 100644',
      'index 0000000..3333333', '--- /dev/null', '+++ b/docs/mi archivo.md\t', '@@ -0,0 +1 @@', '+hola',
      'diff --git a/img/a b.png b/img/a b.png', 'new file mode 100644', 'index 0000000..4444444',
      'Binary files /dev/null and b/img/a b.png differ'));
    expect(r.archivos.map((a) => a.path)).toEqual(['docs/mi archivo.md', 'img/a b.png']);
    expect(r.cortado).toBe(false);
  });
  it('salta node_modules, vendor, dist, build y .git sin cortar (.github sí se mira)', () => {
    const r = parsearDiff(diff(...nuevo('node_modules/x/index.js', [`k = "${T.stripe}"`]), ...nuevo('vendor/a.php', ['x']),
      ...nuevo('dist/app.js', ['x']), ...nuevo('build/a.js', ['x']), ...nuevo('.git/config', ['x']),
      ...nuevo('.github/workflows/ci.yml', ['on: push'])));
    expect(r).toMatchObject({ cortado: false, archivos: [{ path: '.github/workflows/ci.yml' }] });
    expect(r.archivos).toHaveLength(1);
  });
  it('tope de archivos: el resto no se mira y corta', () => {
    const r = parsearDiff(diff(...nuevo('a.ts', ['1']), ...nuevo('b.ts', ['2']), ...nuevo('c.ts', ['3'])),
      { archivos: 2, bytesAnadidos: 1000 });
    expect(r.cortado).toBe(true);
    expect(r.archivos.map((a) => a.path)).toEqual(['a.ts', 'b.ts']);
    expect(LIM_DIFF).toEqual({ archivos: 300, bytesAnadidos: 128_000 });
  });
  it('con los topes por defecto, más de 128 KB añadidos cortan (la revisión avisa como parcial)', () => {
    const linea = 'x'.repeat(99);                                         // 100 caracteres con el salto
    const r = parsearDiff(diff(...nuevo('grande.ts', Array.from({ length: 1300 }, () => linea))));
    expect(r.cortado).toBe(true);
    expect(r.archivos[0]!.lineas.length).toBe(1280);
    expect(parsearDiff(diff(...nuevo('cabe.ts', Array.from({ length: 1270 }, () => linea)))).cortado).toBe(false);
  });
  it('tope de texto añadido: lo que no cabe no se guarda y corta', () => {
    const r = parsearDiff(diff(...nuevo('a.ts', ['123456789', 'abcdefghi', 'zzz']), ...nuevo('b.ts', ['x'])),
      { archivos: 300, bytesAnadidos: 20 });
    expect(r.cortado).toBe(true);
    expect(r.archivos.map((a) => [a.path, a.lineas.map((l) => l.texto)])).toEqual([['a.ts', ['123456789', 'abcdefghi']]]);
  });
  it('texto que no es un diff → nada, sin lanzar', () => {
    expect(parsearDiff('')).toEqual({ archivos: [], cortado: false });
    expect(parsearDiff('hola\n+++ b/x\n@@ -1 +1 @@\n+y\n')).toEqual({ archivos: [], cortado: false });
  });
});

describe('secretosDelDiff', () => {
  // Archivo de 40 líneas con la misma clave en la 25 y la 31 (añadidas) y otra en la 33 que ya estaba (contexto).
  const ruta = 'src/lib/pagos.ts';
  const relleno = (i: number) => `const v${i} = ${i};`;
  const entero = Array.from({ length: 40 }, (_, i) => i + 1 === 25 || i + 1 === 31 ? `const stripe = "${T.stripe}";`
    : i + 1 === 33 ? `const sb = "${T.sbSecret}";` : relleno(i + 1));
  const hunk = (desde: number, hasta: number, nuevas: readonly number[]) => {
    const ls = [`@@ -${desde},${hasta - desde + 1 - nuevas.length} +${desde},${hasta - desde + 1} @@`];
    for (let n = desde; n <= hasta; n++) ls.push((nuevas.includes(n) ? '+' : ' ') + entero[n - 1]);
    return ls;
  };
  const d = diff(`diff --git a/${ruta} b/${ruta}`, 'index 1111111..2222222 100644', `--- a/${ruta}`, `+++ b/${ruta}`,
    ...hunk(22, 34, [25, 31]));

  it('mismo resource, línea y ubicaciones que escanearSecretos sobre el archivo entero', async () => {
    const huella = (v: string) => (v === T.stripe ? 'ab12cd34' : 'ee56ff78') + '0'.repeat(56);
    const { archivos, cortado } = parsearDiff(d);
    expect(cortado).toBe(false);
    const hs = await secretosDelDiff(compactos(archivos), { huella });
    const { hallazgos } = await escanearSecretos([{ path: ruta, content: entero.join('\n') + '\n' }], { huella });
    const completo = hallazgos.find((h) => h.rule_id === 'CB_SECRET_STRIPE_LIVE')!;
    expect(hs).toHaveLength(1);                                                       // la de la línea 33 no se añadió
    const h = hs[0]!;
    expect(h.resource).toBe(`${ruta}:25`);
    expect(h.dedupe_input).toBe(h.resource);
    for (const k of ['rule_id', 'severity', 'resource', 'dedupe_input', 'title'] as const) expect(h[k], k).toBe(completo[k]);
    expect(h.evidence.line).toBe(25);
    expect(h.evidence.ubicaciones).toEqual([{ path: ruta, line: 25, origen: 'head' }, { path: ruta, line: 31, origen: 'head' }]);
    expect(h.evidence.ubicaciones).toEqual(completo.evidence.ubicaciones);
    expect(h.evidence.fingerprint_short).toBe('ab12cd34');
    expect(h.evidence.preview).toBe(completo.evidence.preview);
    expect(JSON.stringify(hs)).not.toContain(T.stripe);
  });
  it('con prefijo: resource = prefijo + ruta:línea de head', async () => {
    const hs = await secretosDelDiff(compactos(parsearDiff(d).archivos), { prefijo: 'gh:' });
    expect(hs.map((h) => h.resource)).toEqual([`gh:${ruta}:25`]);
  });
  it('una línea añadida en la 150.000 no genera 150.000 líneas', async () => {
    const r = parsearDiff(diff('diff --git a/src/big.ts b/src/big.ts', 'index 1111111..2222222 100644', '--- a/src/big.ts',
      '+++ b/src/big.ts', '@@ -149999,0 +150000 @@', `+const k = "${T.sbSecret}";`));
    const cs = compactos(r.archivos);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.lineas).toEqual([150_000]);
    expect(cs[0]!.archivo.content.split('\n')).toHaveLength(1);
    expect(cs[0]!.archivo.content.length).toBeLessThan(100);
    const hs = await secretosDelDiff(cs);
    expect(hs.map((h) => [h.rule_id, h.resource, h.evidence.line]))
      .toEqual([['CB_SECRET_SB_SECRET', 'src/big.ts:150000', 150_000]]);
  });
  it('una clave live en x.test.ts sigue critical (con en_pruebas); la genérica sí baja a low', async () => {
    const r = parsearDiff(diff(...nuevo('src/x.test.ts', [`const k = "${T.stripe}";`, `const apiKey = "${T.generico}";`])));
    const hs = await secretosDelDiff(compactos(r.archivos));
    const live = hs.find((h) => h.rule_id === 'CB_SECRET_STRIPE_LIVE')!;
    expect(live.severity).toBe('critical');
    expect(live.evidence.en_pruebas).toBe(true);
    expect(live.title.endsWith(' (en pruebas)')).toBe(true);
    expect(live.resource).toBe('src/x.test.ts:1');
    expect(hs.find((h) => h.rule_id === 'CB_SECRET_GENERIC')).toMatchObject({ severity: 'low', resource: 'src/x.test.ts:2' });
    // La auditoría no cambia: el mismo archivo por escanearSecretos baja todo a low.
    const audit = await escanearSecretos(cs0(r.archivos));
    expect(audit.hallazgos.every((h) => h.severity === 'low')).toBe(true);
  });
  it('sin compactos → []', async () => {
    expect(await secretosDelDiff([])).toEqual([]);
  });
});

// Revisión de ataque: lo que pasaba sin aviso y sin `cortado` aunque la auditoría del mismo head sí lo encontraba.
describe('revisión de ataque', () => {
  const cab = (ruta: string, hunk: string) => [`diff --git a/${ruta} b/${ruta}`, 'index 1111111..2222222 100644', `--- a/${ruta}`,
    `+++ b/${ruta}`, hunk];
  const huella = (v: string) => {
    let h = 0;
    for (const c of v) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
    return h.toString(16).padStart(8, '0') + '0'.repeat(56);
  };

  it('un NUL en una línea añadida no esconde las claves del archivo (git lo dio por texto)', async () => {
    const NUL = String.fromCharCode(0), ruta = 'src/pagos.ts';
    const r = parsearDiff(diff(...cab(ruta, '@@ -300 +300,3 @@'), ' export const v299 = 299;', `+const z = "${NUL}";`,
      `+const k = "${T.stripe}";`));
    expect(r.cortado).toBe(false);
    const cs = compactos(r.archivos);
    expect(cs[0]!.archivo.content.includes(NUL)).toBe(false);
    expect(cs[0]!.lineas).toEqual([301, 302]);
    const hs = await secretosDelDiff(cs);
    expect(hs.map((h) => [h.rule_id, h.resource, h.severity])).toEqual([['CB_SECRET_STRIPE_LIVE', `${ruta}:302`, 'critical']]);
    expect(hs[0]!.evidence.snippet?.includes(NUL)).toBe(false);
  });

  describe('clave privada', () => {
    const D5 = '-'.repeat(5), ruta = 'src/clave.ts';
    const ini = `${D5}BEGIN ` + `RSA PRIVATE KEY${D5}`, fin = `${D5}END ` + `RSA PRIVATE KEY${D5}`;
    const cuerpo = (b: string) => [R(64, b), R(64, b.slice(3) + b), R(40, b.slice(7) + b)];
    const viejo = cuerpo(RICO), nuevoC = cuerpo('Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0');
    const pre = ['// credenciales del servicio', 'export const KEY = `'], post = ['`;', 'export default KEY;'];
    const ctx = (ls: readonly string[]) => ls.map((l) => ' ' + l);

    it('rotada (cambia el cuerpo; BEGIN y END son contexto): critical con el resource y la huella de la auditoría', async () => {
      const r = parsearDiff(diff(...cab(ruta, '@@ -1,9 +1,9 @@'), ...ctx(pre), ' ' + ini, ...viejo.map((l) => '-' + l),
        ...nuevoC.map((l) => '+' + l), ' ' + fin, ...ctx(post)));
      expect(r.cortado).toBe(false);
      const cs = compactos(r.archivos);
      expect(cs[0]!.lineas).toEqual([3, 4, 5, 6, 7]);                                  // BEGIN, cuerpo nuevo y END
      const hs = await secretosDelDiff(cs, { huella });
      const head = [...pre, ini, ...nuevoC, fin, ...post].join('\n') + '\n';
      const audit = (await escanearSecretos([{ path: ruta, content: head }], { huella })).hallazgos;
      const clave = (h: (typeof hs)[number]) => [h.rule_id, h.severity, h.resource, h.evidence.line, h.evidence.fingerprint_short];
      expect(hs.map(clave)).toEqual([['CB_SECRET_PRIVATE_KEY', 'critical', `${ruta}:3`, 3, huella(head.slice(head.indexOf(ini),
        head.indexOf(fin) + fin.length)).slice(0, 8)]]);
      expect(hs.map(clave)).toEqual(audit.map(clave));
    });
    it('un bloque que no se toca no entra en el compacto ni corta', async () => {
      const r = parsearDiff(diff(...cab(ruta, '@@ -3,6 +3,7 @@'), ' ' + ini, ...ctx(viejo), ' ' + fin, ' `;',
        '+const x = 1;'));
      expect(r.cortado).toBe(false);
      expect(compactos(r.archivos).map((c) => [c.archivo.content, c.lineas])).toEqual([['const x = 1;', [9]]]);
      expect(await secretosDelDiff(compactos(r.archivos))).toEqual([]);
    });
    it('añadidas dentro de un bloque cuyo BEGIN o END no sale en el hunk → cortado', () => {
      const sinIni = parsearDiff(diff(...cab(ruta, '@@ -10,3 +10,4 @@'), ...ctx(viejo.slice(0, 2)), '+' + nuevoC[0],
        ' ' + fin));
      expect(sinIni.cortado).toBe(true);
      const sinFin = parsearDiff(diff(...cab(ruta, '@@ -1,4 +1,5 @@'), ' // x', ' ' + ini, '+' + nuevoC[0],
        ...ctx(viejo.slice(0, 2))));
      expect(sinFin.cortado).toBe(true);
      const lejos = parsearDiff(diff(...cab(ruta, '@@ -1,2 +1,3 @@'), ' ' + ini, '+' + nuevoC[0], ' ' + viejo[0],
        '@@ -20,2 +21,2 @@', ' ' + viejo[2], ' ' + fin));                               // el END está en otro hunk
      expect(lejos.cortado).toBe(true);
    });
  });

  it('binarios de verdad con extensión de medios del escáner (.avif, .otf, .webm, .bmp, .sqlite): sin cortado', () => {
    const r = parsearDiff(diff(...['public/hero.avif', 'fonts/a.otf', 'media/v.webm', 'img/a.bmp', 'data/dev.sqlite'].flatMap((p) =>
      [`diff --git a/${p} b/${p}`, 'new file mode 100644', 'index 0000000..1111111', `Binary files /dev/null and b/${p} differ`])));
    expect(r.cortado).toBe(false);
    expect(r.archivos.every((a) => a.binario)).toBe(true);
  });
  it('TEXTO (git da hunks) con una extensión que el escáner salta (.pdf, .bmp): cortado; borrarlo no corta', () => {
    for (const p of ['docs/claves.pdf', 'docs/claves.bmp']) {
      const r = parsearDiff(diff(...nuevo(p, [`k = "${T.stripe}"`])));
      expect(r).toMatchObject({ cortado: true, archivos: [{ path: p, binario: false }] });
    }
    const borrado = parsearDiff(diff('diff --git a/docs/a.pdf b/docs/a.pdf', 'deleted file mode 100644', 'index 1111111..0000000',
      '--- a/docs/a.pdf', '+++ /dev/null', '@@ -1 +0,0 @@', '-x', ...cab('docs/b.pdf', '@@ -1,2 +1 @@'), ' a', '-b'));
    expect(borrado.cortado).toBe(false);
  });
});

describe('envDelDiff', () => {
  it('.env añadido → CB_ENV_COMMITTED critical con variables y SIN gitignore_lo_lista; sin CB_GITIGNORE_NO_ENV', () => {
    const r = parsearDiff(diff(...nuevo('.env', ['DB_PASS=' + R(20), 'API_URL=https://api.ejemplo.dev'])));
    const hs = envDelDiff(r.archivos, compactos(r.archivos));
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ rule_id: 'CB_ENV_COMMITTED', severity: 'critical', resource: '.env', dedupe_input: '.env',
      evidence: { path: '.env', variables: ['DB_PASS', 'API_URL'] } });
    expect('gitignore_lo_lista' in hs[0]!.evidence).toBe(false);
    expect(JSON.stringify(hs)).not.toContain(R(20));
  });
  it('renombrado a .env.staging entra; modificado, plantilla y borrado no', () => {
    const r = parsearDiff(diff('diff --git a/config/x b/.env.staging', 'similarity index 100%', 'rename from config/x',
      'rename to .env.staging', 'diff --git a/.env b/.env', 'index 1111111..2222222 100644', '--- a/.env', '+++ b/.env',
      '@@ -1 +1,2 @@', ' A=1', '+B=2', ...nuevo('.env.example', ['A=']),
      'diff --git a/api/.env.local b/api/.env.local', 'deleted file mode 100644', 'index 3333333..0000000', '--- a/api/.env.local',
      '+++ /dev/null', '@@ -1 +0,0 @@', '-A=1'));
    const hs = envDelDiff(r.archivos, compactos(r.archivos));
    expect(hs.map((h) => h.resource)).toEqual(['.env.staging']);
    expect(hs[0]!.evidence).toEqual({ path: '.env.staging' });                       // sin compacto: sin variables
  });
  it('sin .env → []', () => {
    const r = parsearDiff(diff(...nuevo('src/a.ts', ['x'])));
    expect(envDelDiff(r.archivos, compactos(r.archivos))).toEqual([]);
  });
});
