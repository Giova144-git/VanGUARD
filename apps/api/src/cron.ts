import { housekeeping } from './engine/housekeeping.ts';
import { log } from './lib/log.ts';

// Los 3 crons de S15 15.7 (de los 5 de la cuenta en Free). El monitor por minuto corre directo aquí, sin cola
// (A7.4: con cola se irían ~13.000 operaciones/día de las 10.000 del plan).
export const CRON_MINUTO = '* * * * *';
export const CRON_HORA = '0 * * * *';
export const CRON_DIA = '0 10 * * *'; // 06:00 Caracas

export async function onCron(cron: string, env: CloudflareBindings, now = new Date()) {
  switch (cron) {
    case CRON_MINUTO: {
      // housekeeping (cierre automático §12.3, vigilante de corridas colgadas y caducidad de bloqueos) en una línea de
      // log; runMonitors (sb_health) llega con su hito.
      const h = await housekeeping(env, now);
      log(h.error ? 'warn' : 'info', 'monitor.minuto', { minuto: now.getUTCMinutes(), trabajos: 1, subpeticiones: h.subpeticiones,
        resueltos: h.resueltos, housekeeping: h.modo, vigilante: h.vigilante, interrumpidas: h.interrumpidas, error: h.error });
      return;
    }
    case CRON_HORA:
      // La red de seguridad de la cola (scan_runs y wiki_runs sin avance → failed) es el vigilante del housekeeping por
      // minuto (engine/housekeeping.ts, 0011).
      log('info', 'mantenimiento.hora', {});
      return;
    case CRON_DIA:
      // startScheduledAudits para orgs con daily_audit (P1).
      log('info', 'reauditoria.dia', { orgs: 0 });
      return;
    default:
      log('warn', 'cron.desconocido', { cron });
  }
}
