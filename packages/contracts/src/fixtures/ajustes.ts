// Ajustes: contactos de alerta (E26, solo admin) y gasto de IA del día (E28). Nombres ficticios (nunca los del equipo).
// Teléfonos E.164 ficticios +58412000000N por el relato venezolano: OJO, no son de un rango reservado para ficción
// (el 0412 es numeración real de Digitel). En modo fixtures no hay red y nadie los marca; no copiarlos a una siembra.
import type { AiUsage, Contact } from '../api.ts';
import { CONTACT_1, CONTACT_2 } from './ids.ts';

// El de prioridad 1 recibe WhatsApp y la llamada de los críticos; el 2 solo WhatsApp (canónicas §9.3).
// Ana verificada y Luis no: así la demo con fixtures enseña las dos chapas y el 409 unverified.
export const contacts = [
  { id: CONTACT_1, name: 'Ana', phone_e164: '+584120000001', whatsapp: true, voice: true, priority: 1, verified_at: '2026-10-24T15:00:00.000Z' },
  { id: CONTACT_2, name: 'Luis', phone_e164: '+584120000002', whatsapp: true, voice: false, priority: 2, verified_at: null },
] satisfies Contact[];

// Org de demo: tope de 10 USD/día (S05 §05.11); 0,41 USD ≈ una auditoría con IA-2 (~0,25) y los 4 prompts de IA-1 de la
// demo (~0,033 cada uno: RLS, .env, service_role y lodash; S11 §11.4).
export const aiUsage = { today_usd: 0.41, cap_usd: 10, enabled: true, level: 'normal' } satisfies AiUsage;
