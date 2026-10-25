import { Hono } from 'hono';
import type { AppEnv } from '../env.ts';
import { actions } from './actions.ts';
import { connections } from './connections.ts';
import { contacts } from './contacts.ts';
import { demo } from './demo.ts';
import { evolucion } from './evolucion.ts';
import { exportRuta } from './export.ts';
import { findings } from './findings.ts';
import { incidents } from './incidents.ts';
import { modules } from './modules.ts';
import { notifications } from './notifications.ts';
import { overview } from './overview.ts';
import { perf } from './perf.ts';
import { revision } from './revision.ts';
import { scans } from './scans.ts';
import { traffic } from './traffic.ts';
import { wiki } from './wiki.ts';
import { health } from './health.ts';
import { ia } from './ia.ts';
import { mcpTokens } from './mcp-tokens.ts';
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
rutas.route('/', evolucion);   // E51 (scans/:id/delta) y E52 (evolution)
rutas.route('/', findings);
rutas.route('/', overview);
rutas.route('/', modules);
rutas.route('/', contacts);
rutas.route('/', notifications);
rutas.route('/', traffic);
rutas.route('/', incidents);
rutas.route('/', actions);
rutas.route('/', wiki);
rutas.route('/', exportRuta);
rutas.route('/', mcpTokens);
rutas.route('/', perf);
rutas.route('/', revision);
rutas.route('/', ia);
