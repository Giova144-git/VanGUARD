// DeepWiki («Wiki del repo»): explica un repositorio a un directivo, con diagrama Mermaid, estimación de costo
// antes de correr y caché por commit. Motor en packages/deepwiki; endpoints E40–E44 del BACK.
import { z } from 'zod';
import { Id, Ts } from './comun.ts';

// Misma regla que ConnectionCreate.github (§06.3): sin "." ni ".." como repo.
export const RepoFullName = z.string().regex(/^[A-Za-z0-9-]{1,39}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/);
export type RepoFullName = z.infer<typeof RepoFullName>;
export const CommitSha = z.string().regex(/^[0-9a-f]{40}$/);
export type CommitSha = z.infer<typeof CommitSha>;

// Pasos del trabajo en la cola vg-jobs: uno por invocación, cada uno con <= 40 subpeticiones (Workers Free).
export const WikiPaso = z.enum(['arbol', 'triage', 'area', 'sintesis', 'fin']);
export type WikiPaso = z.infer<typeof WikiPaso>;
export const WikiModelos = z.object({ fast: z.string(), smart: z.string() });
export type WikiModelos = z.infer<typeof WikiModelos>;

// E40 · POST /api/orgs/:org/wiki/estimate (admin): solo lee GitHub, no llama a Claude.
export const WikiRepoRef = z.object({
  repo_full_name: RepoFullName,
  ref: z.string().trim().min(1).max(100).optional(),   // rama o tag; por defecto la rama principal
  connection_id: Id.optional(),                         // conexión GitHub para repos privados
});
export type WikiRepoRef = z.infer<typeof WikiRepoRef>;
export const WikiEstimateRequest = WikiRepoRef;
export type WikiEstimateRequest = z.infer<typeof WikiEstimateRequest>;
export const WikiCostoPaso = z.object({ paso: WikiPaso, modelo: z.string(), llamadas: z.number().int().min(0),
  input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0), usd: z.number().min(0) });
export type WikiCostoPaso = z.infer<typeof WikiCostoPaso>;
export const WikiEstimate = z.object({
  repo_full_name: RepoFullName, branch: z.string(), commit_sha: CommitSha,
  files_total: z.number().int().min(0), files_candidatos: z.number().int().min(0),
  files_a_leer_max: z.number().int().min(0), areas_max: z.number().int().min(0), truncado: z.boolean(),
  est: z.object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0), usd: z.number().min(0),
    desglose: z.array(WikiCostoPaso) }),
  models: WikiModelos,
  cached_run_id: Id.nullable(),                         // ya existe una wiki terminada para ese commit: no se cobra de nuevo
  avisos: z.array(z.string().max(200)).max(10),
});
export type WikiEstimate = z.infer<typeof WikiEstimate>;

// E41 · POST /api/orgs/:org/wiki/runs (admin): encola el trabajo o devuelve la caché del mismo commit.
export const WikiRunCreate = WikiRepoRef.extend({
  max_usd: z.number().positive().max(5).optional(),     // tope que el usuario aceptó tras la estimación
  force: z.boolean().optional(),                        // ignora la caché del commit
});
export type WikiRunCreate = z.infer<typeof WikiRunCreate>;
export const WikiRunAccepted = z.object({ wiki_run_id: Id, cached: z.boolean() });
export type WikiRunAccepted = z.infer<typeof WikiRunAccepted>;

// E42 · GET /api/orgs/:org/wiki/runs/:id y E43 · GET /api/orgs/:org/wiki/runs?repo= (historial por commit)
export const WikiRunStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type WikiRunStatus = z.infer<typeof WikiRunStatus>;
export const WikiRunStep = z.object({ name: WikiPaso, status: z.enum(['pending', 'running', 'done', 'skipped', 'failed']),
  detalle: z.string().max(80).optional(), error_code: z.string().optional() });
export type WikiRunStep = z.infer<typeof WikiRunStep>;
export const WikiRun = z.object({
  id: Id, repo_full_name: RepoFullName, branch: z.string().nullable(), commit_sha: CommitSha.nullable(),
  status: WikiRunStatus, progress: z.number().int().min(0).max(100), steps: z.array(WikiRunStep),
  est_usd: z.number().min(0).nullable(), cost_usd: z.number().min(0).nullable(), models: WikiModelos,
  cached: z.boolean(), error: z.string().max(300).nullable(),
  created_at: Ts, started_at: Ts.nullable(), finished_at: Ts.nullable(),
});
export type WikiRun = z.infer<typeof WikiRun>;

// E44 · GET /api/orgs/:org/wiki/runs/:id/doc: el documento terminado.
export const WikiPagina = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/), area: z.string().max(120), titulo: z.string().max(120),
  resumen_md: z.string().max(4000), archivos: z.array(z.string().max(300)).max(60),
});
export type WikiPagina = z.infer<typeof WikiPagina>;
export const WikiDoc = z.object({
  run_id: Id, repo_full_name: RepoFullName, branch: z.string(), commit_sha: CommitSha, generated_at: Ts,
  models: WikiModelos,
  overview_md: z.string().max(20000),                   // ya saneado: sin HTML, enlaces ni imágenes
  mermaid: z.string().max(4000).nullable(),             // solo si pasó la lista blanca; null si se descartó
  mermaid_descartado: z.boolean(),
  paginas: z.array(WikiPagina).max(13),                 // una por área (máx. 12 + «otros»)
  stats: z.object({ files_total: z.number().int().min(0), files_leidos: z.number().int().min(0),
    areas: z.number().int().min(0), input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0),
    cost_usd: z.number().min(0) }),
  avisos: z.array(z.string().max(200)).max(10),
});
export type WikiDoc = z.infer<typeof WikiDoc>;
