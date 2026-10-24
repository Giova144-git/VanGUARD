// Evidencia de los hallazgos CB_* (§09). Todo opcional: Finding.evidence es record<string, unknown> en §15.5;
// este esquema la valida en el BACK y en los fixtures.
import { z } from 'zod';
import { Severity } from './comun.ts';

export const CodebaseEvidence = z.object({
  fuente: z.enum(['github', 'zip']).optional(), sha: z.string().max(40).optional(),
  path: z.string().max(512).optional(), line: z.number().int().min(1).optional(), // §13 los usa para `location` (SARIF/export)
  preview: z.string().max(48).optional(), fingerprint_short: z.string().regex(/^[0-9a-f]{8}$/).optional(), snippet: z.string().max(200).optional(),
  ubicaciones: z.array(z.object({ path: z.string().max(512), line: z.number().int().min(1), origen: z.enum(['head', 'historial']) })).max(20).optional(),
  agravante: z.enum(['expuesto_en_bundle']).optional(), en_pruebas: z.boolean().optional(),
  variables: z.array(z.string().max(64)).max(30).optional(), gitignore_lo_lista: z.boolean().optional(), existe_gitignore: z.boolean().optional(),
  primer_commit: z.string().length(7).optional(), tamano: z.number().int().optional(),
  commits: z.array(z.object({ sha7: z.string().length(7), fecha: z.string() })).max(5).optional(),
  paquete: z.object({ ecosystem: z.string(), name: z.string(), version: z.string(), manifest: z.string(), direct: z.boolean(), dev: z.boolean() }).optional(),
  version_arreglo: z.string().nullable().optional(), urgencia: z.enum(['ahora', 'hoy', 'semana', 'backlog']).optional(),
  n_avisos: z.number().int().optional(), sin_detalle: z.boolean().optional(),
  avisos: z.array(z.object({ id: z.string(), aliases: z.array(z.string()).max(5), severidad: Severity, resumen: z.string().max(200),
    arreglo: z.string().nullable(), kev: z.boolean().optional(), epss: z.number().optional(), refs: z.array(z.string()).max(4) })).max(10).optional(),
  conexion: z.object({ id: z.string(), provider: z.string(), label: z.string() }).optional(),
  cwe: z.string().optional(), por_que: z.string().max(600).optional(),
});
export type CodebaseEvidence = z.infer<typeof CodebaseEvidence>;
