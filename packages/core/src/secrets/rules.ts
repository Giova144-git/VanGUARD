// Reglas de secretos CB_SECRET_* (S09 09.9; regex de R11 §4.2, origen gitleaks MIT salvo las de Supabase) y listas de
// permitidos. Sin mayúsculas/minúsculas SOLO donde gitleaks trae `(?i)`: la clave privada con la bandera `i` y la genérica
// con clases [xX] (ver REGLA_GENERICA); en las demás haría casar `akia…` en minúsculas. Las validaciones extra (rol del
// JWT, host de Postgres) viven en scan.ts.
import type { Severity } from '@vanguard/contracts';
import { entropia } from './entropy.ts';

export type ReglaSecretoId =
  | 'CB_SECRET_SUPABASE_SERVICE_ROLE' | 'CB_SECRET_SB_SECRET' | 'CB_SECRET_AWS' | 'CB_SECRET_STRIPE_LIVE' | 'CB_SECRET_ANTHROPIC'
  | 'CB_SECRET_OPENAI' | 'CB_SECRET_GITHUB_PAT' | 'CB_SECRET_PRIVATE_KEY' | 'CB_SECRET_POSTGRES_URL' | 'CB_SECRET_GENERIC';
export type ReglaSecreto = {
  rule_id: ReglaSecretoId;
  claves: readonly string[];   // prefiltro por palabra clave (`includes`): la regex solo corre si el archivo trae alguna
  re: RegExp;                  // siempre con bandera g (matchAll)
  grupo: number;               // grupo con el valor; 0 = la coincidencia entera
  entropiaMin?: number;
  severity: Severity;          // la de Postgres la ajusta scan.ts según el host
};

// Genérica (gitleaks generic-api-key). Es la MISMA regla que aplica redactString (redact.ts), regex y filtro del valor:
// lo que aquí es hallazgo, allí queda tapado, y así la evidencia de un secreto no lleva en claro otro de su línea.
// · `[ \t]*` en vez del `\s*` de 09.9: con `\s*`, `API_SECRET=` vacío se comía el salto y tomaba la línea siguiente como
//   valor (falso positivo comprobado al auditar nuestro propio repo).
// · Límite derecho de la palabra clave: detrás no puede venir otra minúscula, salvo un plural en s. `tokenizer`, `author`,
//   `keyboard`, `accessible` o `secretary` no son claves; `TOKEN1`, `tokens`, `apiKey`, `githubTokenStaging`, `MASTERKEY`,
//   `monkey` u `oauth` sí (a la izquierda no hay límite: `secretkey`, `masterkey`). Para distinguir mayúsculas va sin la
//   `i`: cada letra de la palabra lleva su clase [xX]. Queda fuera lo pegado en minúsculas (`tokenprod`, `passwordhash`).
const sinMayus = (p: string) => p.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
/** Un carácter del valor de la genérica. */
export const VALOR_GENERICA = '[A-Za-z0-9_\\-+/=.]';
export const REGLA_GENERICA: ReglaSecreto = {
  rule_id: 'CB_SECRET_GENERIC', claves: ['access', 'api', 'auth', 'cred', 'key', 'passw', 'secret', 'token'], grupo: 2,
  entropiaMin: 3.5, severity: 'medium',
  re: new RegExp(`(${sinMayus('(?:access|api|auth(?:orization)?|cred(?:ential|s)|key|passw(?:or)?d|secret|token)s?')})(?![a-z])`
    + `[\\w.-]{0,20}[ \\t]*[:=][ \\t]*['"]?(${VALOR_GENERICA}{16,150})`, 'g'),
};
/** Filtro del valor de la genérica (scan.ts además descarta lo que ya dio una específica): un dígito (fuera identificadores
 *  como `env.SUPABASE_SECRET_KEY` o `actions_org_id_fkey`), no un JWT (anon incluido), no un valor de ejemplo y entropía. */
export const valorGenerico = (v: string): boolean =>
  /\d/.test(v) && !/^ey[A-Za-z0-9_-]*\./.test(v) && !PERMITIDOS.test(v) && entropia(v) >= (REGLA_GENERICA.entropiaMin ?? 0);
/** Un carácter del valor de una asignación con nombre de secreto: todo hasta el primer delimitador (blanco, comillas,
 *  & , ; < > ) [ ] `) o el NUL con el que redact.ts y scan.ts ven nuestros marcadores. Es el valor de ASIGNACION y CAMEL
 *  (redact.ts) y la cola de la genérica. Se para antes de un `Bearer ` o un `Authorization:` pegados: si se los comiera,
 *  los patrones de redact ya no verían esa cabecera y su token, que va tras el blanco, quedaría en claro. Los
 *  delimitadores cortan a propósito un valor SIN comillas (listas `[a, b]`, llamadas, `&` de una query, JSON en línea);
 *  entre comillas el valor llega hasta la de cierre (finComillas). */
export const CARACTER_VALOR = `(?:(?!${sinMayus('bearer')}\\s|${sinMayus('authorization')}\\s{0,8}[:=])[^\\s"'&,;<>)[\\]\`\\0])`;
const MAX_COMILLAS = 256;
/** Fin de un valor que empieza en `ini` y que la regex dio hasta `fin`. Si va entre comillas (`"…"` o `'…'`), llega hasta
 *  la de cierre, en la misma línea y a menos de MAX_COMILLAS car.: dentro caben `; , ) [ & <` y blancos, y lo de detrás
 *  sigue siendo la contraseña. Sin cierre a la vista, `fin`. Coste acotado por valor: lineal en el texto. */
export function finComillas(t: string, ini: number, fin: number): number {
  const q = t[ini - 1];
  if (q !== '"' && q !== "'") return fin;
  for (let i = fin, tope = Math.min(t.length, fin + MAX_COMILLAS); i < tope; i++) {
    const c = t[i];
    if (c === q) return i;
    if (c === '\n' || c === '\r') return fin;
  }
  return fin;
}
const COLA_GENERICA = new RegExp(`${CARACTER_VALOR}*`, 'y');
/** Fin del tramo secreto de un valor de la genérica que acaba en `desde`. La regla corta a 150 car. y en el primer
 *  símbolo, pero lo que sigue hasta el delimitador es del mismo secreto (base64 largo, contraseña con # ! $ @ ~ :):
 *  redact.ts tapa y scan.ts marca [inicio del valor, finColaGenerica). */
export function finColaGenerica(t: string, desde: number): number {
  COLA_GENERICA.lastIndex = desde;
  return COLA_GENERICA.exec(t) ? COLA_GENERICA.lastIndex : desde;
}

// Orden: las específicas primero; la genérica al final, porque descarta lo que ya casó una específica.
export const REGLAS_SECRETO: readonly ReglaSecreto[] = [
  { rule_id: 'CB_SECRET_SUPABASE_SERVICE_ROLE', claves: ['eyJ'], grupo: 1, severity: 'critical',
    re: /\b(ey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9\/\\_-]{17,}\.[a-zA-Z0-9\/\\_-]{10,}={0,2})/g },
  { rule_id: 'CB_SECRET_SB_SECRET', claves: ['sb_secret_'], grupo: 1, severity: 'critical',
    re: /\b(sb_secret_[A-Za-z0-9_-]{20,})/g },
  { rule_id: 'CB_SECRET_AWS', claves: ['AKIA', 'ASIA', 'ABIA', 'ACCA', 'A3T'], grupo: 1, entropiaMin: 3, severity: 'critical',
    re: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/g },
  { rule_id: 'CB_SECRET_STRIPE_LIVE', claves: ['_live_', '_prod_'], grupo: 1, severity: 'critical',
    re: /\b((?:sk|rk)_(?:live|prod)_[a-zA-Z0-9]{10,99})/g },
  { rule_id: 'CB_SECRET_ANTHROPIC', claves: ['sk-ant-'], grupo: 1, severity: 'critical',
    re: /\b(sk-ant-(?:api03|admin01)-[a-zA-Z0-9_\-]{93}AA)/g },
  { rule_id: 'CB_SECRET_OPENAI', claves: ['T3BlbkFJ'], grupo: 1, entropiaMin: 3, severity: 'critical',
    re: /\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})/g },
  { rule_id: 'CB_SECRET_GITHUB_PAT', claves: ['ghp_', 'github_pat_'], grupo: 1, entropiaMin: 3, severity: 'critical',
    re: /\b(ghp_[0-9a-zA-Z]{36}|github_pat_\w{82})/g },
  { rule_id: 'CB_SECRET_PRIVATE_KEY', claves: ['PRIVATE KEY'], grupo: 0, severity: 'critical',
    re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----/gi },
  // \0 fuera de las clases: es el relleno de nuestros marcadores en scan.ts (`u:abc[REDACTADO]def@h` no es una contraseña).
  { rule_id: 'CB_SECRET_POSTGRES_URL', claves: ['postgres'], grupo: 1, severity: 'high',
    re: /\b(postgres(?:ql)?:\/\/[^:\s\/\0]+:([^@\s\/\0]{6,})@[^\s'"\x60\0]+)/g },
  REGLA_GENERICA,
];

/** Valores de ejemplo que se descartan (09.9, R11 §4.3). */
export const PERMITIDOS = /(example|sample|dummy|placeholder|changeme|your[_-]?(api[_-]?)?key|x{6,}|<[^>]+>|\$\{[^}]+\}|process\.env|import\.meta\.env)/i;
/** Nuestros propios marcadores (A9, dogfooding): `[SECRET:<regla>]`, `[REDACTADO]`/`[REDACTADO:x]` de redact() y la máscara `•••`.
 *  scan.ts los cambia por un NUL (inerte, como en redactString) antes de correr cualquier regex. */
export const MARCADORES = /\[SECRET:[A-Z0-9_]{1,64}\]|\[REDACTADO(?::[a-z0-9_]{1,32})?\]|•{3,}/g;
/** Hosts de Postgres que no cuentan: desarrollo local o el servicio de docker-compose. `db.<ref>.supabase.co` sí cuenta. */
export const HOSTS_PG_LOCALES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', 'db', 'postgres']);
/** Rutas de prueba: no se descartan, bajan a `low` con `en_pruebas:true`. */
export const RUTA_PRUEBAS = /(^|\/)(__tests__|fixtures)\/|\.(test|spec)\.[^/]+$/;
