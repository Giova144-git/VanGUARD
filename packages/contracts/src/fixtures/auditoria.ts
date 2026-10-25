// «Auditar todo» del sábado (E12): la misma corrida a mitad de camino (scanRunning) y terminada (scanDone).
// Puntaje con score.ts de S15 §15.9: Supabase y Codebase restan su máximo (40 cada uno) → 20, banda roja.
import type { ScanRun } from '../api.ts';
import {
  CONN_GITHUB, CONN_GITHUB_2, F_CB_ENV, F_CB_POSTGRES, F_CB_SERVICE_ROLE, F_SB_POLICY, F_SB_RLS, F_SB_RPC, MODELO_RESUMEN, REPO,
  REPO_2, SCAN_AUDITORIA, T_SCAN_CREADO, T_SCAN_FIN, T_SCAN_INICIO,
} from './ids.ts';

export const scanRunning = {
  id: SCAN_AUDITORIA, kind: 'full_audit', status: 'running', progress: 55, step: 'repo:dependencias',
  steps: [
    { name: 'supabase', status: 'done', findings: 6 },
    { name: 'cloudflare', status: 'done', findings: 0 },
    { name: 'repo', status: 'running' },
    { name: 'resumen_ia', status: 'pending' },
  ],
  score: null, coverage: null, summary: null, error: null,
  created_at: T_SCAN_CREADO, started_at: T_SCAN_INICIO, finished_at: null,
} satisfies ScanRun;

export const scanDone = {
  id: SCAN_AUDITORIA, kind: 'full_audit', status: 'succeeded', progress: 100, step: null,
  steps: [
    { name: 'supabase', status: 'done', findings: 6 },
    { name: 'cloudflare', status: 'done', findings: 0 },
    { name: 'repo', status: 'done', findings: 7 },
    { name: 'resumen_ia', status: 'done' },
  ],
  score: 20,
  coverage: { seen: 4, total: 4, missing: [] },
  summary: {
    resumen: 'Tu blindaje está en 20 de 100 y revisamos las 4 fuentes. El riesgo más grave es que la tabla de pedidos se '
      + 'puede leer completa sin iniciar sesión, y que en el repositorio hay un .env con la clave service_role y la '
      + 'contraseña de la base: con ellas se salta toda la seguridad de Supabase. Además, una dependencia del panel antiguo '
      + 'tiene una vulnerabilidad crítica conocida.\nPrimero rota la clave service_role y la contraseña de Postgres, luego '
      + 'activa RLS en public.pedidos y saca el .env del repositorio. En tu zona de Cloudflare no encontramos fallos de '
      + 'configuración.',
    top: [
      { finding_id: F_SB_RLS, por_que: 'Cualquiera con la clave pública de la web descarga todos los pedidos sin credenciales.' },
      { finding_id: F_CB_SERVICE_ROLE, por_que: 'La clave service_role ignora RLS: quien vea el repositorio controla toda la base.' },
      { finding_id: F_CB_POSTGRES, por_que: 'La contraseña de Postgres da acceso directo como dueño de la base, sin pasar por la API.' },
      { finding_id: F_CB_ENV, por_que: 'El .env subido es el origen de las dos claves filtradas y seguirá en el historial.' },
      { finding_id: F_SB_RPC, por_que: 'enviar_otp se puede llamar sin sesión ni límite: sirve para abusar de envíos.' },
    ],
    relaciones: [
      { finding_ids: [F_CB_SERVICE_ROLE, F_SB_RLS],
        explicacion: 'Aunque actives RLS en public.pedidos, la clave service_role filtrada la ignora: hay que rotarla junto con el arreglo.' },
      { finding_ids: [F_CB_POSTGRES, F_SB_RLS, F_SB_POLICY],
        explicacion: 'Con la contraseña de Postgres se entra a la base sin RLS ni políticas: arreglar las tablas no basta si no se rota.' },
    ],
    model: MODELO_RESUMEN,
  },
  error: null, created_at: T_SCAN_CREADO, started_at: T_SCAN_INICIO, finished_at: T_SCAN_FIN,
} satisfies ScanRun;

// La misma auditoría con dos repos (varias-codebases): el paso repo los miró los dos; el segundo salió limpio, así que
// puntaje, cobertura y resumen no cambian.
export const scanDoneDosRepos = {
  ...scanDone,
  repos: [
    { connection_id: CONN_GITHUB, repo_full_name: REPO, status: 'done', findings: 7 },
    { connection_id: CONN_GITHUB_2, repo_full_name: REPO_2, status: 'done', findings: 0 },
  ],
} satisfies ScanRun;
