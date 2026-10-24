import { log } from './lib/log.ts';

// Los 3 crons de S15 15.7 (de los 5 de la cuenta en Free). El monitor por minuto corre directo aquí, sin cola
// (A7.4: con cola se irían ~13.000 operaciones/día de las 10.000 del plan).
export const CRON_MINUTO = '* * * * *';
export const CRON_HORA = '0 * * * *';
export const CRON_DIA = '0 10 * * *'; // 06:00 Caracas

export async function onCron(cron: string, _env: CloudflareBindings, now = new Date()) {
  switch (cron) {
    case CRON_MINUTO:
      // runMonitors + housekeeping llegan con sus tablas (hitos 2 y 5).
      log('info', 'monitor.minuto', { minuto: now.getUTCMinutes(), trabajos: 0, subpeticiones: 0 });
      return;
    case CRON_HORA:
      // Red de seguridad de la cola: scan_runs running sin avance > 15 min → failed (P1).
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
