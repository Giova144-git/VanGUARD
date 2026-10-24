import type { WikiModelos } from '@vanguard/contracts';

// Accesor perezoso único de @vanguard/deepwiki. El motor solo lo usan las rutas de la Wiki (E40/E41) y los pasos 'wiki'
// de la cola: fuera del arranque en frío del Worker (esbuild deja el import() dinámico en el mismo bundle, sin evaluar
// hasta la primera llamada). Una carga por isolate. Aquí solo se importan tipos del motor; los valores, por motor().
export type Motor = typeof import('@vanguard/deepwiki');

let carga: Promise<Motor> | undefined;
let listo: Motor | undefined;

export const motor = (): Promise<Motor> => (carga ??= import('@vanguard/deepwiki').then((m) => (listo = m)));

// El motor ya cargado, o undefined si nadie llamó aún a motor(). Para lo síncrono que corre después de un await motor(),
// como el instanceof de un catch: sin motor cargado, el error no puede ser suyo.
export const motorCargado = (): Motor | undefined => listo;

// Copia literal de MODELOS_POR_DEFECTO del motor (llm-fetch.ts) para lo síncrono que no lo carga (aWikiRun en E42/E43,
// modelosDe antes del paso). corridas.test.ts comprueba que sigue siendo igual a la del motor.
export const MODELOS_POR_DEFECTO: WikiModelos = { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' };
