import { Hono } from 'hono';
import type { AppEnv } from '../env.ts';
import { health } from './health.ts';
import { humo } from './humo.ts';

// Un archivo por grupo de rutas (S15 15.2); se montan bajo /api en app.ts.
export const rutas = new Hono<AppEnv>();

rutas.route('/', health);
rutas.route('/', humo);
