// CB_ENV_COMMITTED (S09 09.11; orden de S11 11.10.2: primero rotar, porque la clave está comprometida aunque se borre).
// La ruta va citada para shell: un nombre de archivo hostil no se convierte en otro comando al pegarlo.
import { enCodigo, nombreEnCodigo } from '../titles.ts';
import type { HallazgoFix, PlantillaFix } from './index.ts';

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_VARIABLES = 8;
/** Argumento de shell: tal cual si es inocuo; si no, entre comillas simples (cada `'` como `'\''`). */
export function argShell(p: string): string {
  const s = p.startsWith('-') ? `./${p}` : p;
  return /^[A-Za-z0-9._/@+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
const lista = (xs: readonly string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);

export function plantilla(f: HallazgoFix): PlantillaFix {
  const path = (typeof f.evidence.path === 'string' && f.evidence.path) || f.resource.replace(/^zip:[^/]*\//, '') || '.env';
  const todas = (Array.isArray(f.evidence.variables) ? f.evidence.variables : [])
    .filter((v): v is string => typeof v === 'string' && VARIABLE.test(v));
  const vars = todas.slice(0, MAX_VARIABLES).map(enCodigo);
  const varsTxt = vars.length === 0 ? '' : lista(todas.length > MAX_VARIABLES ? [...vars, `${todas.length - MAX_VARIABLES} más`] : vars);
  const p = argShell(path), A = nombreEnCodigo(path);
  const quitar = enCodigo(`git rm --cached ${p}`), comprobar = enCodigo(`git ls-files ${p}`);
  return {
    contexto: `El archivo ${A} está subido al repositorio${varsTxt ? ` con las variables ${varsTxt}` : ''}: quien vea el repo puede usar esos valores. Quitarlo del repositorio no basta, porque ya están expuestos: hay que rotar los secretos.`,
    pasos: [
      'Rota en su proveedor las variables que sean secretas (claves, contraseñas, tokens) antes que nada: están comprometidas aunque quites el archivo.',
      `Quita el archivo del índice sin borrarlo de tu equipo: ${quitar}`,
      'Añade `.env` y `.env.*` al .gitignore, con la excepción `!.env.example`.',
      `Crea \`.env.example\` con las mismas variables vacías${varsTxt ? `: ${varsTxt}` : ''}.`,
      'Valora limpiar el historial con git filter-repo: reescribe la historia, hay que coordinarlo con el equipo y no sustituye a rotar.',
    ],
    prompt_para_tu_ia: `Objetivo: sacar ${A} del repositorio sin perder la configuración local. Ejecuta ${quitar}, añade .env y .env.* (excepto .env.example) al .gitignore y crea .env.example con ${varsTxt ? `las variables ${varsTxt} vacías` : 'las mismas variables, vacías'}. Recuérdame rotar las claves antes de hacer push. Muéstrame el diff y espera mi confirmación. Para verificar, ${comprobar} no debe devolver nada.`,
    prueba_de_aceptacion: `${comprobar} no devuelve nada y VanGUARD deja de reportar CB_ENV_COMMITTED y CB_GITIGNORE_NO_ENV.`,
  };
}
