// Lo que Vigía cuenta durante una espera larga (useEspera.ts): una frase cada CADA_MS, según el paso que corre, y la
// frase del final. Textos fijos: nunca llevan datos del servidor (ni nombres de tablas, ni repos, ni mensajes de error).
// Un paso desconocido no se nombra: cae a las frases generales de esa espera.
import type { ScanStep } from '@vanguard/contracts';

export const CADA_MS = 4000;          // cada cuánto cambia la frase
export const DURACION_FIN_MS = 6000;  // cuánto dura la frase del final antes de callarse sola

/** Frases del final. `alerta` es para «terminó, pero hay algo urgente» (p. ej. críticos nuevos). */
export type FinEspera = { bien: string; alerta: string; fallo: string };
export type Espera = { general: readonly string[]; fin: FinEspera };

// Por paso de ScanRun.steps[] (E12). Cada lista rota en orden; la primera es la que se oye al empezar el paso.
const POR_PASO: Record<ScanStep['name'], readonly string[]> = {
  supabase: [
    'Reviso las políticas RLS de tus tablas…',
    'Miro si alguna tabla queda a la vista de cualquiera…',
    'Repaso los avisos de seguridad que ya calcula Supabase…',
    'Busco funciones que se salten las políticas…',
  ],
  cloudflare: [
    'Miro el tráfico de tu zona en Cloudflare…',
    'Busco IPs y programas que insisten demasiado…',
    'Reviso la configuración de seguridad de tu zona…',
  ],
  repo: [
    'Miro si tu repo tiene claves expuestas…',
    'Busco archivos .env subidos por error…',
    'Cruzo tus dependencias con la base pública de vulnerabilidades…',
  ],
  zip: [
    'Abro tu ZIP en tu navegador: no sale de tu equipo…',
    'Cruzo las dependencias del ZIP con la base pública de vulnerabilidades…',
  ],
  psi: [
    'Lighthouse está cargando tu web, como lo haría un visitante…',
    'Mido cuánto tarda en verse lo principal…',
    'Cuento cuánto se queda bloqueada la página al cargar…',
    'Miro si algo salta de sitio mientras carga…',
  ],
  resumen_ia: [
    'Claude está ordenando lo que encontré…',
    'Relaciono los hallazgos para decirte qué va primero…',
  ],
};

// Subpasos que el BACK escribe en ScanRun.step como «paso:subpaso». Sin entrada, cuenta el paso de antes de los dos puntos.
const POR_SUBPASO: Record<string, readonly string[]> = {
  'repo:dependencias': [
    'Cruzo tus dependencias con la base pública de vulnerabilidades…',
    'Comparo cada versión exacta de tus paquetes con los fallos conocidos…',
  ],
  waiting_result: ['Espero el resultado de tu ZIP: lo estás analizando en tu navegador…'],
};

export const ESPERAS = {
  auditoria: {
    general: ['Preparo la auditoría…', 'Reviso tu ecosistema paso a paso…'],
    fin: {
      bien: '¡Auditoría terminada! Abajo tienes tu puntaje y lo más urgente.',
      alerta: 'Auditoría terminada, pero hay críticos nuevos. Empieza por los marcados como «Nuevo».',
      fallo: 'La auditoría se cortó. Abajo te digo dónde, y puedes reintentarla.',
    },
  },
  medicion: {
    general: ['Preparo la medición…', 'Lighthouse está cargando tu web, como lo haría un visitante…'],
    fin: {
      bien: '¡Medición lista! Las cifras y la comparación están en Rendimiento.',
      alerta: 'Medición lista: algo empeoró. Míralo en Rendimiento.',
      fallo: 'La medición no salió. Vuelve a Rendimiento para repetirla.',
    },
  },
  // Para la generación de la wiki (aún sin conectar): rota estas frases mientras se escribe.
  wiki: {
    general: [
      'Leo la estructura de tu repo…',
      'Explico en llano qué hace cada pieza…',
      'Dibujo el mapa de cómo se conectan…',
      'Anoto los riesgos que veo por el camino…',
    ],
    fin: {
      bien: '¡Tu wiki está lista!',
      alerta: 'La wiki está lista, aunque una parte quedó incompleta.',
      fallo: 'No pude terminar la wiki. Puedes intentarlo de nuevo.',
    },
  },
} satisfies Record<string, Espera>;
export type IdEspera = keyof typeof ESPERAS;

const lista = (paso: string): readonly string[] => {
  if (Object.hasOwn(POR_SUBPASO, paso)) return POR_SUBPASO[paso]!;
  const base = paso.split(':')[0]!;
  return Object.hasOwn(POR_PASO, base) ? POR_PASO[base as ScanStep['name']] : [];
};

/** Las frases para los pasos que corren ahora (ScanRun.step y los steps[] en 'running'), sin repetir; sin ninguno
 *  conocido, las generales de la espera. */
export function textosEspera(pasos: readonly unknown[], espera: Espera): readonly string[] {
  const nombres = [...new Set(pasos.filter((p): p is string => typeof p === 'string' && p.length > 0))];
  const textos = [...new Set(nombres.flatMap(lista))];
  return textos.length ? textos : espera.general;
}
