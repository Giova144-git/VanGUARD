// Ingesta firmada que manda la víctima a /ingest/v1/events (canónicas §7). Aquí sí se usa
// z.iso.datetime(): la víctima genera las fechas con toISOString().
import { z } from 'zod';

export const EdgeEvent = z.object({ ts: z.iso.datetime(), ip: z.string().max(45), method: z.string().max(10), path: z.string().max(300),
  status: z.number().int().min(100).max(599), ua: z.string().max(200), latency_ms: z.number().int().min(0), auth: z.boolean() });
export type EdgeEvent = z.infer<typeof EdgeEvent>;
export const IngestBatch = z.object({ events: z.array(EdgeEvent).min(1).max(100) });
export type IngestBatch = z.infer<typeof IngestBatch>;
export const IngestAccepted = z.object({ accepted: z.number().int() });
export type IngestAccepted = z.infer<typeof IngestAccepted>;
