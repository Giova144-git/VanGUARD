import { Hono } from 'hono';
import type { AppEnv } from '../env.ts';
import { connections } from './connections.ts';
import { demo } from './demo.ts';
import { findings } from './findings.ts';
import { modules } from './modules.ts';
import { overview } from './overview.ts';
import { scans } from './scans.ts';
import { health } from './health.ts';
import { me } from './me.ts';
import { orgs } from './orgs.ts';

// Un archivo por grupo de rutas (S15 15.2); se montan bajo /api en app.ts.
export const rutas = new Hono<AppEnv>();

rutas.route('/', health);
rutas.route('/', me);
rutas.route('/', orgs);
rutas.route('/', demo);
rutas.route('/', connections);
rutas.route('/', scans);
rutas.route('/', findings);
rutas.route('/', overview);
rutas.route('/', modules);
