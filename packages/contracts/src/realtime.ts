// Payload de Broadcast privado `org:<org_id>` (P1, S15 §15.6). El FRONT solo invalida claves;
// si el payload no valida, invalida todo lo de la org.
import { z } from 'zod';
import { Id } from './comun.ts';

export const RealtimeChange = z.object({ table: z.enum(['scan_runs', 'findings', 'incidents', 'notifications']),
  operation: z.enum(['INSERT', 'UPDATE', 'DELETE']),
  record: z.looseObject({ id: Id, org_id: Id }).nullable(), old_record: z.looseObject({ id: Id }).nullable() });
export type RealtimeChange = z.infer<typeof RealtimeChange>;
