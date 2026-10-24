// Sesión: E2 GET /api/me. `me` es el admin de la org de demo (el correo de la sesión falsa de S14 §14.8);
// `meViewer` es el anónimo de «Ver demo» con rol viewer (E4).
import type { Me } from '../api.ts';
import { ORG_DEMO, ORG_NOMBRE, USER_ADMIN, USER_ANON } from './ids.ts';

export const me = {
  user: { id: USER_ADMIN, email: 'demo@vanguard.test', is_anonymous: false },
  orgs: [{ id: ORG_DEMO, name: ORG_NOMBRE, role: 'owner', is_demo: true }],
} satisfies Me;

export const meViewer = {
  user: { id: USER_ANON, email: null, is_anonymous: true },
  orgs: [{ id: ORG_DEMO, name: ORG_NOMBRE, role: 'viewer', is_demo: true }],
} satisfies Me;
