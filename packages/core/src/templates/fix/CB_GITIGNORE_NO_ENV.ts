// CB_GITIGNORE_NO_ENV (S09 09.11, A9.2): no hay .gitignore en la raíz o ninguna línea casa ^/?\.env.
import type { HallazgoFix, PlantillaFix } from './index.ts';

export function plantilla(f: HallazgoFix): PlantillaFix {
  const existe = f.evidence.existe_gitignore !== false;
  return {
    contexto: existe
      ? 'El .gitignore del repositorio no excluye .env: cualquier archivo de secretos que crees se puede subir por error con un git add.'
      : 'El repositorio no tiene .gitignore en la raíz: cualquier .env con secretos se puede subir por error con un git add.',
    pasos: [
      `${existe ? 'Añade al .gitignore' : 'Crea un .gitignore en la raíz con'} las líneas \`.env\` y \`.env.*\`, y \`!.env.example\` para conservar la plantilla.`,
      'Comprueba con `git check-ignore .env` que el archivo queda ignorado.',
      'Si .env ya está en el repositorio, sácalo con `git rm --cached .env` (hallazgo CB_ENV_COMMITTED).',
    ],
    prompt_para_tu_ia: `Objetivo: que el .gitignore de este repositorio excluya los archivos .env. ${existe ? 'Añade .env y .env.* al .gitignore, con la excepción !.env.example, sin tocar el resto de reglas.' : 'Crea un .gitignore en la raíz con .env y .env.*, y la excepción !.env.example.'} Muéstrame el diff y espera mi confirmación. Para verificar, git check-ignore .env debe imprimir .env.`,
    prueba_de_aceptacion: '`git check-ignore .env` imprime .env y VanGUARD deja de reportar CB_GITIGNORE_NO_ENV.',
  };
}
