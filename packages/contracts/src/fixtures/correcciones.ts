// Cola «Enviar a mi IA» de la demo (E58b): una petición en cada estado visible. «enviado» y «arreglando» van en dos
// hallazgos abiertos de «Ahora» (el .env y la contraseña de postgres); «corregido», en el índice que verificó la
// auditoría del viernes (hallazgosCorregidos: se ve en su detalle).
import type { FixRequest } from '../api.ts';
import {
  F_CB_ENV, F_CB_POSTGRES, F_SB_INDICE, FIX_REQ_ARREGLANDO, FIX_REQ_CORREGIDO, FIX_REQ_ENVIADO, T_EV_MIE, T_EV_VIE,
  T_FIX_REQ_ARREGLANDO, T_FIX_REQ_ENVIADO,
} from './ids.ts';

export const fixRequests = [
  { id: FIX_REQ_ARREGLANDO, finding_id: F_CB_ENV, status: 'arreglando', client: 'claude_code', created_at: T_FIX_REQ_ENVIADO,
    started_at: T_FIX_REQ_ARREGLANDO, closed_at: null },
  { id: FIX_REQ_ENVIADO, finding_id: F_CB_POSTGRES, status: 'enviado', client: 'vscode', created_at: T_FIX_REQ_ARREGLANDO,
    started_at: null, closed_at: null },
  { id: FIX_REQ_CORREGIDO, finding_id: F_SB_INDICE, status: 'corregido', client: 'claude_code', created_at: T_EV_MIE,
    started_at: T_EV_MIE, closed_at: T_EV_VIE },
] satisfies FixRequest[];
