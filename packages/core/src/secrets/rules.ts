// Reglas de secretos CB_SECRET_* (S09 09.9; regex de R11 §4.2, origen gitleaks MIT salvo las de Supabase) y listas de
// permitidos. La bandera `i` va SOLO donde gitleaks trae `(?i)` (clave privada y genérica): en las demás haría casar
// `akia…` en minúsculas. Las validaciones extra (rol del JWT, host de Postgres) viven en scan.ts.
import type { Severity } from '@vanguard/contracts';

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
  { rule_id: 'CB_SECRET_POSTGRES_URL', claves: ['postgres'], grupo: 1, severity: 'high',
    re: /\b(postgres(?:ql)?:\/\/[^:\s\/]+:([^@\s\/]{6,})@[^\s'"\x60]+)/g },
  // `[ \t]*` en vez del `\s*` de 09.9: con `\s*`, `API_SECRET=` vacío se comía el salto y tomaba la línea siguiente
  // como valor (falso positivo comprobado al auditar nuestro propio repo). scan.ts además exige un dígito en el valor.
  { rule_id: 'CB_SECRET_GENERIC', claves: ['secret', 'token', 'key', 'passw', 'auth', 'credential'], grupo: 2, entropiaMin: 3.5,
    severity: 'medium',
    re: /(access|auth|api|credential|creds|key|passw(?:or)?d|secret|token)[\w.-]{0,20}[ \t]*[:=][ \t]*['"]?([A-Za-z0-9_\-+/=.]{16,150})/gi },
];

/** Valores de ejemplo que se descartan (09.9, R11 §4.3). */
export const PERMITIDOS = /(example|sample|dummy|placeholder|changeme|your[_-]?(api[_-]?)?key|x{6,}|<[^>]+>|\$\{[^}]+\}|process\.env|import\.meta\.env)/i;
/** Nuestros propios marcadores (A9, dogfooding): `[SECRET:<regla>]`, `[REDACTADO]`/`[REDACTADO:x]` de redact() y la máscara `•••`.
 *  scan.ts los cambia por un espacio antes de correr cualquier regex. */
export const MARCADORES = /\[SECRET:[A-Z0-9_]{1,64}\]|\[REDACTADO(?::[a-z0-9_]{1,32})?\]|•{3,}/g;
/** Hosts de Postgres que no cuentan: desarrollo local o el servicio de docker-compose. `db.<ref>.supabase.co` sí cuenta. */
export const HOSTS_PG_LOCALES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', 'db', 'postgres']);
/** Rutas de prueba: no se descartan, bajan a `low` con `en_pruebas:true`. */
export const RUTA_PRUEBAS = /(^|\/)(__tests__|fixtures)\/|\.(test|spec)\.[^/]+$/;
