import { Hono } from 'hono';
import type { AppEnv } from '../env.ts';
import { demo } from './demo.ts';
import { health } from './health.ts';
import { humo } from './humo.ts';
import { me } from './me.ts';
import { orgs } from './orgs.ts';

// Un archivo por grupo de rutas (S15 15.2); se montan bajo /api en app.ts.
export const rutas = new Hono<AppEnv>();

rutas.route('/', health);
rutas.route('/', humo);
rutas.route('/', me);
rutas.route('/', orgs);
rutas.route('/', demo);
