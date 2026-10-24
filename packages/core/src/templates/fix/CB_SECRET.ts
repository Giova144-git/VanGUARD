// CB_SECRET_* genérica (S09 09.11; orden de S11 11.10.2): rotar → variable de entorno de servidor → leerla del entorno
// → (opcional) limpiar el historial, que no sustituye a rotar. Nunca lleva el valor: la evidencia solo trae una vista.
import { nombreEnCodigo } from '../titles.ts';
import type { HallazgoFix, PlantillaFix } from './index.ts';

const DONDE_ROTAR: ReadonlyArray<readonly [RegExp, string]> = [
  [/POSTGRES/, 'cambia la contraseña de la base (en Supabase: Database → Settings)'],
  [/SUPABASE/, 'en Supabase: Settings → API keys'],
  [/GITHUB/, 'en GitHub: revoca el token en Settings → Developer settings'],
  [/AWS/, 'en AWS: desactiva la clave de acceso en IAM y crea otra'],
  [/STRIPE/, 'en Stripe: rota la clave en Developers → API keys'],
  [/ANTHROPIC/, 'en la consola de Anthropic: revoca la clave y crea otra'],
  [/OPENAI/, 'en el panel de OpenAI: revoca la clave y crea otra'],
  [/PRIVATE_KEY/, 'genera un par de claves nuevo y retira la clave pública antigua donde esté registrada'],
];

export function plantilla(f: HallazgoFix): PlantillaFix {
  const regla = /^CB_SECRET_[A-Z0-9_]+$/.test(f.rule_id) ? f.rule_id : 'CB_SECRET';
  const donde = DONDE_ROTAR.find(([re]) => re.test(regla))?.[1] ?? 'en el panel del proveedor que la emitió';
  const R = nombreEnCodigo(f.resource || 'el repositorio');
  const bundle = f.evidence.agravante === 'expuesto_en_bundle';
  return {
    contexto: `En ${R} hay una credencial escrita (${regla}). Quien vea el repositorio puede usarla para entrar directamente al servicio, y sigue comprometida aunque la quites del código.${bundle ? ' Además el código la publica en el paquete que descarga el navegador.' : ''}`,
    pasos: [
      `Rota la credencial antes que nada (${donde}): la actual ya está comprometida.`,
      'Saca el valor del código a una variable de entorno del servidor (`wrangler secret put`), nunca con prefijo VITE_ o NEXT_PUBLIC_.',
      'Cambia el código para leer la credencial del entorno y deja en el navegador solo claves públicas.',
      'Si quieres, limpia el historial con git filter-repo: reescribe la historia, hay que coordinarlo con el equipo y no sustituye a rotar.',
    ],
    prompt_para_tu_ia: `Objetivo: sacar del repositorio la credencial que VanGUARD encontró en ${R} (${regla}). Sustituye el valor escrito por la lectura de una variable de entorno del servidor, sin prefijos públicos como VITE_ o NEXT_PUBLIC_, añade esa variable vacía a .env.example y recuérdame rotar la credencial en su proveedor antes de hacer push. No cambies nada más. Muéstrame el diff y espera mi confirmación. Para verificar, el valor ya no debe aparecer en el repositorio.`,
    prueba_de_aceptacion: `VanGUARD vuelve a escanear y ${regla} pasa a verificado; la credencial antigua ya no da acceso (responde 401).`,
  };
}
