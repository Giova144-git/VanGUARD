// Lint de seguridad del FRONT (S14 §14.6). Node puro, sin dependencias: corre igual en Windows que en Workers Builds.
// Va dentro del script `build`, así que una violación impide el despliegue.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const WEB = join(import.meta.dirname, '..');
const L9 = 'HTML o código sin escapar: pinta el dato como texto (L9)';

// Nombres de secreto. token, secret… valen en cualquier parte del nombre (accessToken, ingest_secret); pat y code, solo
// como palabra suelta (p.code, PAT) o como cola camelCase (authCode, githubPat): así no cazan path, patch ni encodeURI.
// error.code, err.code o statusCode son códigos de error, no secretos.
const SECRETO = [/token|secret|password|codigo|verificacion|vgi_|nonce/i, /(?<![a-z])(?<!\b(?:error|err|e)\.)(pat|code)(?![a-z])/i,
  /\b(?!(?:status|error|key|char|exit|http|response)Code\b)[A-Za-z_$]*[a-z](?:Pat|Code|PAT|CODE)(?![a-z])/];
const secreto = (t) => SECRETO.some((re) => re.test(t));

// Se prueban contra cada línea.
const LINEA = [
  { re: /\bbg-(mal|aviso)(?![-\w/])/, motivo: 'rojo o ámbar sólido: usa bg-mal-relleno / bg-aviso-relleno (L3)' },
  { re: /dangerouslySetInnerHTML/, motivo: L9 },
  { re: /\.(inner|outer)HTML\s*\+?=(?!=)|\[\s*['"`](inner|outer)HTML['"`]\s*\]\s*\+?=(?!=)/, motivo: L9 },   // asignar, no comparar
  { re: /insertAdjacentHTML|createContextualFragment|document\.write|\bsrcdoc\b|\b(set|parse)HTMLUnsafe\b|parseFromString/i, motivo: L9 },
  // Function( con o sin new. Pegado a una comilla o a un acento grave es texto (un comentario que lo nombra), no una llamada.
  { re: /\beval\s*\(|(?<![\w$`'"])Function\s*\(|\[\s*['"`]eval['"`]\s*\]/, motivo: L9 },
  { re: /\b(assign|set)\([^)]*['"`]?\b(inner|outer)HTML\b/, motivo: L9 },   // Object.assign(el, { innerHTML }), Reflect.set(el, 'innerHTML', …)
  { re: /\bindexedDB\b|document\.cookie/, motivo: 'indexedDB o cookie desde JS: nada de tokens ni códigos en el navegador (L10)' },
  { re: /\bhistory\.(push|replace)State\b/, motivo: 'history a mano: la navegación va por react-router y nada de tokens en history.state (L10)' },
  { re: /[?&](access_token|token|secret|codigo|code|pat|nonce|password)=|searchParams\.(set|append)\(\s*['"`](token|secret|codigo|code|pat|nonce|password)\b/i,
    motivo: 'token o código en la URL: queda en el historial, en los logs y en el Referer (L10)' },
  // console por alias (console['log'], console.log.call, const { log } = console) escapa a la regla de la consola.
  { re: /\bconsole\s*\[|\bconsole\.\w+\.(call|apply|bind)\b|=\s*console\s*;?\s*$/, motivo: 'consola por alias: no se puede revisar qué imprime (L10)' },
  // localStorage[k] = v, localStorage.k = v o Reflect.set(localStorage, …) se saltarían la regla de setItem.
  { re: /\b(local|session)Storage\s*(\[[^\]]*\]|\.(?!(get|set|remove)Item\b)[\w$]+)\s*\+?=(?!=)|\b(assign|set|defineProperty)\(\s*(window\.)?(local|session)Storage\b/,
    motivo: 'almacenamiento sin setItem: usa setItem, que es lo que revisa la regla de tokens (L10)' },
];

// Se prueban contra lo que va dentro del paréntesis o la llave que sigue, aunque continúe en las líneas siguientes.
const DENTRO = [
  { re: /\.setItem\s*(?=\()/g, prueba: secreto, motivo: 'token o código en el almacenamiento del navegador (L10)' },
  { re: /\bconsole\.\w+\s*(?=\()/g, prueba: secreto, motivo: 'token o código en la consola (L10)' },
  { re: /\bqueryKey\s*:\s*(?=\[)/g, prueba: secreto, motivo: 'token o código en una clave de TanStack Query: se ve en la caché y en las devtools (L10)' },
  // navigate(…, { state: { … } }) y <Navigate state={{ … }} />: el state acaba guardado en history.state.
  { re: /\bstate\s*(:|=\s*\{)\s*(?=\{)/g, prueba: secreto, motivo: 'token o código en el state de la navegación, que va a history.state (L10)' },
  // Con una cadena o una plantilla, setTimeout y setInterval son un eval. Una función, en línea o por nombre, no.
  { re: /\bset(Timeout|Interval)\s*(?=\()/g, motivo: L9, prueba: (d) => /^\s*['"`]/.test(d) },
];

// Texto entre el (, [ o { de (fila, col) y su cierre, hasta 8 líneas más abajo. No distingue cadenas ni comentarios,
// pero basta para leer nombres de variable.
function dentroDe(lineas, fila, col) {
  const abre = lineas[fila][col], cierra = abre === '(' ? ')' : abre === '[' ? ']' : '}';
  let prof = 0, txt = '';
  for (let f = fila; f < Math.min(lineas.length, fila + 9); f++) {
    const l = f === fila ? lineas[f].slice(col) : lineas[f], desde = f === fila ? 1 : 0;   // sin el ( o { que abre
    for (let k = 0; k < l.length; k++) {
      if (l[k] === abre) prof++;
      else if (l[k] === cierra && --prof === 0) return { txt: txt + l.slice(desde, k), fin: f };
    }
    txt += l.slice(desde) + '\n';
  }
  return { txt, fin: Math.min(lineas.length, fila + 9) - 1 };
}

// Los *.test.ts(x) no van al bundle y el arnés de XSS lleva estas cargas a propósito.
function* archivos(dir, ext) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) yield* archivos(ruta, ext);
    else if (ext.test(e.name) && !/\.test\.tsx?$/.test(e.name)) yield ruta;
  }
}

const violaciones = [];
for (const f of [...archivos(join(WEB, 'src'), /\.tsx?$/), ...archivos(join(WEB, 'public'), /\.m?js$/)]) {
  const rel = relative(WEB, f).split(sep).join('/');
  const lineas = readFileSync(f, 'utf8').split(/\r?\n/);
  lineas.forEach((linea, i) => {
    const anota = (motivo, fin = i) => violaciones.push(`${rel}:${i + 1}${fin > i ? `-${fin + 1}` : ''}: ${motivo}\n    ${linea.trim()}`);
    // Un comentario que nombra la API (// zod prueba Function()…) no es una llamada; «://» y «'//» son de una cadena.
    const codigo = /^\s*(\/\/|\*|\/\*)/.test(linea) ? '' : linea.replace(/(^|[^:'"`\\\w])\/\/.*$/, '$1');
    for (const r of LINEA) if (r.re.test(codigo)) anota(r.motivo);
    for (const r of DENTRO) {
      for (const m of linea.matchAll(r.re)) {
        const { txt, fin } = dentroDe(lineas, i, m.index + m[0].length);
        if (r.prueba(txt, linea)) { anota(r.motivo, fin); break; }
      }
    }
  });
}

if (violaciones.length) {
  console.error('lint:seguridad falló:\n' + violaciones.join('\n'));
  process.exit(1);
}
console.log('lint:seguridad: OK');
