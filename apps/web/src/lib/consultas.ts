// Hooks de lectura (S14 §14.8). Intervalos de A7.5: Realtime es la vía normal de frescura y el polling solo el
// respaldo (nunca baja de 10 s), siempre con la pestaña visible (refetchIntervalInBackground: false).
import { keepPreviousData, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AiUsage, AlertPrefs, FIX_REQUEST_ABIERTA, FixRequest, AuditDelta, type CodeReviewState, Evolution, Contact, ConnectionPublic, EstadoModulo, Finding, FixPromptResponse, Incident, IncidentDetail, McpTokenPublic, Me, Overview, PerfRunExt, ScanRun, Traffic, WikiDoc, WikiRun,
  UnderAttackOffer,
  type Module, type Severity,
} from '@vanguard/contracts';
import { z } from 'zod';
import { api } from './api';
import { USA_FIXTURES } from './env';
import { esApiError } from './errores';
import { esId } from './ids';
import { CodeReviewStateTolerante } from './revision-tolerante';
import { useVivo } from './vivo';

const base = { refetchIntervalInBackground: false, placeholderData: keepPreviousData } as const;
// [respaldo, con Realtime] en ms
const intervalo = (vivo: boolean, respaldo: number, conCanal: number) => (vivo ? conCanal : respaldo);
// Un id que dio 404 no va a aparecer sondeando: se deja de pedir (cualquier otro error sigue con su intervalo).
const es404 = (q: { state: { error: unknown } }) => esApiError(q.state.error) && q.state.error.status === 404;

export const useMe = (habilitado = true) => useQuery({
  queryKey: ['me'], queryFn: () => api('/api/me', { esquema: Me }), staleTime: 60_000, enabled: habilitado,
});

export function useOverview(org: string) {
  const vivo = useVivo();
  return useQuery({
    ...base, queryKey: ['org', org, 'overview'], queryFn: () => api(`/api/orgs/${org}/overview`, { esquema: Overview }),
    refetchInterval: intervalo(vivo, 10_000, 60_000),
  });
}

export function useEstadoModulo(org: string, m: Module) {
  const vivo = useVivo();
  return useQuery({
    ...base, queryKey: ['org', org, 'module', m], queryFn: () => api(`/api/orgs/${org}/modules/${m}/state`, { esquema: EstadoModulo }),
    refetchInterval: intervalo(vivo, 10_000, 30_000),
  });
}

export function useConexiones(org: string) {
  const vivo = useVivo();
  return useQuery({
    ...base, queryKey: ['org', org, 'connections'], queryFn: () => api(`/api/orgs/${org}/connections`, { esquema: z.array(ConnectionPublic) }),
    refetchInterval: intervalo(vivo, 30_000, 60_000),
  });
}

export type FiltroHallazgos = { module?: Module; severity?: Severity; status?: 'open' | 'fixed' | 'verified' | 'ignored'; limit?: number };
const consulta = (f: FiltroHallazgos) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v != null) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export function useHallazgos(org: string, f: FiltroHallazgos = {}) {
  const vivo = useVivo();
  return useQuery({
    ...base, queryKey: ['org', org, 'findings', f], queryFn: () => api(`/api/orgs/${org}/findings${consulta(f)}`, { esquema: z.array(Finding) }),
    refetchInterval: intervalo(vivo, 10_000, 30_000),
  });
}

// E13b. initialData sale de cualquier lista ya cargada, para pintar al instante (S14 §14.15).
export function useHallazgo(org: string, id: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['org', org, 'finding', id], enabled: esId(id),
    queryFn: () => api(`/api/orgs/${org}/findings/${id}`, { esquema: Finding }),
    initialData: () => {
      for (const [, lista] of qc.getQueriesData<Finding[]>({ queryKey: ['org', org, 'findings'] })) {
        const f = lista?.find((x) => x.id === id);
        if (f) return f;
      }
      return undefined;
    },
    initialDataUpdatedAt: 0,                                   // se refresca igual al montar
    refetchIntervalInBackground: false,
  });
}

// Con has_fix_prompt el BACK lo devuelve de caché, gratis (cached:true). Se guarda en ['org',org,'fix',id].
export const useFixPrompt = (org: string, id: string, habilitado: boolean) => useQuery({
  queryKey: ['org', org, 'fix', id], enabled: habilitado && esId(id), staleTime: Infinity, retry: false,
  queryFn: () => api(`/api/orgs/${org}/findings/${id}/fix-prompt`, { method: 'POST', body: {}, esquema: FixPromptResponse }),
});

// Mientras queued|running: 10 s de respaldo (los pasos llegan por el evento de scan_runs); una medición de «Medir ahora»
// (kind lighthouse, una pasada de PSI, ~10 s), cada 2 s (S10 §10.10). En fixtures, sin cupo que cuidar, 1 s, para ver avanzar la simulación.
export const useScan = (org: string, id: string | undefined) => useQuery({
  queryKey: ['org', org, 'scan', id], enabled: esId(id), refetchIntervalInBackground: false,
  queryFn: () => api(`/api/orgs/${org}/scans/${id}`, { esquema: ScanRun }),
  refetchInterval: (q) => !es404(q) && ['queued', 'running'].includes(q.state.data?.status ?? 'queued')
    ? (USA_FIXTURES ? 1_000 : q.state.data?.kind === 'lighthouse' ? 2_000 : 10_000) : false,
});

// Incidentes (E16–E17). `estado = 'all'` no manda status: el BACK devuelve las últimas 24 h.
export function useIncidentes(org: string, estado: 'open' | 'all') {
  const vivo = useVivo();
  return useQuery({
    ...base, queryKey: ['org', org, 'incidents', estado],
    queryFn: () => api(`/api/orgs/${org}/incidents${estado === 'open' ? '?status=open' : ''}`, { esquema: z.array(Incident) }),
    refetchInterval: intervalo(vivo, 10_000, 60_000),
  });
}

export function useIncidente(org: string, id: string) {
  const vivo = useVivo();
  return useQuery({
    ...base, queryKey: ['org', org, 'incident', id], enabled: esId(id), queryFn: () => api(`/api/orgs/${org}/incidents/${id}`, { esquema: IncidentDetail }),
    refetchInterval: (q) => es404(q) ? false : USA_FIXTURES ? 2_000 : intervalo(vivo, 10_000, 60_000),   // fixtures: sin cupo, para ver llenarse los hitos
  });
}

// «Modo bajo ataque» (E55, asignaciones/modo-bajo-ataque.md §9): solo lee la base, sin llamar a Cloudflare. Bandera: un
// 404 (BACK sin la ruta, o quitada en el corte de §13.1) no se sondea y la tarjeta no se pinta. Validado con zod como
// E45. Realtime de incidents también la invalida (un CF_IP_FLOOD de otra IP cambia `ips`); el sondeo es el respaldo.
export function useOfertaBajoAtaque(org: string, incidentId: string) {
  const vivo = useVivo();
  return useQuery({
    queryKey: ['org', org, 'under-attack', incidentId], enabled: esId(incidentId), refetchIntervalInBackground: false,
    queryFn: async () => UnderAttackOffer.parse(await api(`/api/orgs/${org}/incidents/${incidentId}/under-attack`, { esquema: UnderAttackOffer })),
    refetchInterval: (q) => (es404(q) ? false : intervalo(vivo, 15_000, 60_000)),
  });
}

// Cubetas de 10 s: consultar más seguido no trae dato nuevo; edge_hits no emite Realtime (§15.6). Solo montado donde se ve.
export const useTrafico = (org: string) => useQuery({
  ...base, queryKey: ['org', org, 'traffic'], queryFn: () => api(`/api/orgs/${org}/traffic?seconds=300`, { esquema: Traffic }),
  refetchInterval: 10_000,
});

// Export en Markdown precargado al abrir la pantalla: «Copiar para mi IA» copia un texto que ya está en memoria (§14.17).
export const useExportMd = (org: string) => useQuery({
  queryKey: ['org', org, 'export', 'md'], staleTime: 60_000, refetchIntervalInBackground: false,
  queryFn: async () => (await api<Response>(`/api/orgs/${org}/export?format=md`, { crudo: true })).text(),
});

// Cola «Enviar a mi IA» (E58b): el distintivo de cada hallazgo. Llega por Realtime (fix_requests en el broadcast de la
// org); sin canal, sondeo de 10 s solo mientras haya alguna abierta (el MCP la pasa a «arreglando» y la auditoría a
// «corregido»), y si no, 60 s.
export function useColaIA(org: string) {
  const vivo = useVivo();
  return useQuery({
    ...base, queryKey: ['org', org, 'fix-requests'], queryFn: () => api(`/api/orgs/${org}/fix-requests`, { esquema: z.array(FixRequest) }),
    refetchInterval: (q) => (vivo ? 60_000 : q.state.data?.some((x) => FIX_REQUEST_ABIERTA.includes(x.status)) ? 10_000 : 60_000),
  });
}

/** El envío a la IA de un hallazgo (el último), o null. */
export function useEnvioIA(org: string, findingId: string | null | undefined): FixRequest | null {
  const q = useColaIA(org);
  return (findingId && q.data?.find((x) => x.finding_id === findingId)) || null;
}

// Tokens MCP (E29b): solo admin; para el viewer no se llama. Nunca traen el token, solo sus 4 últimos caracteres.
export const useTokensMcp = (org: string, habilitado: boolean) => useQuery({
  queryKey: ['org', org, 'mcp'], enabled: habilitado, refetchIntervalInBackground: false,
  queryFn: () => api(`/api/orgs/${org}/mcp-tokens`, { esquema: z.array(McpTokenPublic) }),
});

// Contactos: solo admin (E26). Para el viewer no se llama: el bloque dice que solo los ve un administrador.
// `cadaMs`: espera activa mientras alguien verifica su teléfono por WhatsApp (5 s, solo con la pestaña visible).
// gcTime de 1 min: el código de verificación no se queda 5 min en memoria tras salir de Ajustes.
export const useContactos = (org: string, habilitado: boolean, cadaMs: number | false = false) => useQuery({
  queryKey: ['org', org, 'contacts'], enabled: habilitado, gcTime: 60_000, refetchIntervalInBackground: false, refetchInterval: cadaMs,
  queryFn: () => api(`/api/orgs/${org}/contacts`, { esquema: z.array(Contact) }),
});

// E24: repeticiones crudas para el histórico de solo lectura (P0-lite). Sin polling: las mediciones son sembradas.
export const usePerfRuns = (org: string) => useQuery({
  queryKey: ['org', org, 'perf'], staleTime: 60_000, refetchIntervalInBackground: false,
  queryFn: () => api(`/api/orgs/${org}/perf/runs?limit=30`, { esquema: z.array(PerfRunExt) }),
});

// DeepWiki (E42–E44). wiki_runs no tiene Realtime: 3 s mientras queued|running y solo con la pestaña visible.
export const useWikiRuns = (org: string, repo: string | null, habilitado = true) => useQuery({
  ...base, queryKey: ['org', org, 'wiki', 'runs', repo], refetchInterval: 30_000, enabled: habilitado,
  queryFn: () => api(`/api/orgs/${org}/wiki/runs${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, { esquema: z.array(WikiRun) }),
});

// `lento`: la corrida lleva 3 min sin avanzar (useEstancada); se sigue mirando, pero cada 15 s.
export const useWikiRun = (org: string, id: string | null, lento = false) => useQuery({
  queryKey: ['org', org, 'wiki', 'run', id], enabled: esId(id), refetchIntervalInBackground: false,
  queryFn: () => api(`/api/orgs/${org}/wiki/runs/${id}`, { esquema: WikiRun }),
  refetchInterval: (q) => !es404(q) && ['queued', 'running'].includes(q.state.data?.status ?? 'queued') ? (lento ? 15_000 : 3_000) : false,
});

export const useWikiDoc = (org: string, id: string | null, listo: boolean) => useQuery({
  queryKey: ['org', org, 'wiki', 'doc', id], enabled: esId(id) && listo, staleTime: Infinity,
  queryFn: () => api(`/api/orgs/${org}/wiki/runs/${id}/doc`, { esquema: WikiDoc }),
});

// Revisión de código en cada push (E45, asignaciones/revision-codigo.md §6.1). Realtime (findings y notifications) la
// refresca al momento; el sondeo es el respaldo, siempre con la pestaña visible: cada 5 s hasta `rapidoHasta` (al montar
// o volver a la pestaña, y tras activar) o mientras haya una revisión en curso de menos de 2 min; si no, cada 30 s.
// Un 404 (E45 aún sin desplegar) no se sondea: la tarjeta no se pinta. Los reintentos, los de main.tsx (solo 5xx). El cuerpo
// se valida aquí con zod aunque api() en producción solo avise. E45 con el esquema tolerante (revision-tolerante.ts): un
// valor nuevo del BACK degrada su pieza y la tarjeta se sigue pintando; un E48 fuera de contrato, o un E45 roto de
// verdad, deja la consulta en error y la tarjeta no se pinta, en vez de tumbar la página de Codebase en el render. La clave es 'revision' (no
// 'code-review', que la espec propone): lint-seguridad lee «code» como un secreto en una clave de Query.
// Varias codebases (§6.2): siempre por conexión, también con un solo repo (un BACK sin B6 ignora el parámetro), y la
// conexión va en la clave: setQueryData de E46 escribe en la de su pestaña.
const revisando = (s: CodeReviewState | undefined) => (s?.recent ?? []).some((r) =>
  (r.status === 'queued' || r.status === 'running') && Date.now() - Date.parse(r.created_at) < 120_000);
const consultaRevision = (org: string, connectionId: string) => ({
  queryKey: ['org', org, 'revision', connectionId], refetchIntervalInBackground: false,
  queryFn: async () => CodeReviewStateTolerante.parse(await api(`/api/orgs/${org}/code-review?connection_id=${encodeURIComponent(connectionId)}`, { esquema: CodeReviewStateTolerante })),
});
export const useRevisionCodigo = (org: string, rapidoHasta: number, connectionId: string) => useQuery({
  ...consultaRevision(org, connectionId),
  refetchInterval: (q) => (es404(q) ? false : Date.now() < rapidoHasta || revisando(q.state.data) ? 5_000 : 30_000),
});
// La chapa de cada pestaña de Codebase: E45 de cada repo, pedido una vez y sin sondeo (solo la pestaña elegida sondea,
// con useRevisionCodigo sobre la misma clave).
export const useRevisionesRepos = (org: string, ids: readonly string[]) => useQueries({
  queries: ids.map((id) => ({ ...consultaRevision(org, id), refetchInterval: false as const })),
});

// Preferencias de avisos (E48): las lee Ajustes y la tarjeta de la revisión (el umbral de WhatsApp). 404 → no se pinta.
export const usePrefsAvisos = (org: string) => useQuery({
  queryKey: ['org', org, 'alert-prefs'], refetchIntervalInBackground: false, staleTime: 30_000,
  queryFn: async () => AlertPrefs.parse(await api(`/api/orgs/${org}/alert-prefs`, { esquema: AlertPrefs })),
});

// Gasto de IA de la org (E28, PLAN #13): solo owner y admin (`habilitado`); cada 30 s con la pestaña visible. Validado
// con zod como E45: un cuerpo fuera de contrato no pinta el chip. Un 404 (E28 aún sin desplegar) deja de sondear.
export const useUsoIA = (org: string, habilitado: boolean) => useQuery({
  queryKey: ['org', org, 'ai'], enabled: habilitado, staleTime: 30_000, refetchIntervalInBackground: false,
  queryFn: async () => AiUsage.parse(await api(`/api/orgs/${org}/ai/usage`, { esquema: AiUsage })),
  refetchInterval: (q) => (es404(q) ? false : 30_000),
});

// Evolución entre revisiones (E51/E52, asignaciones/evolucion-entre-revisiones.md §6.1). Validadas con zod como E45: un
// cuerpo fuera de contrato deja la consulta en error y el bloque no se pinta. Un 404 (aún sin desplegar) no se sondea.
// E51 cuelga de la clave de la auditoría: el evento de scan_runs ya invalida el prefijo 'scan'. Solo con la auditoría
// terminada (`habilitado`); 10 s de sondeo solo mientras llega 'en_curso'.
export const useDeltaAuditoria = (org: string, id: string | undefined, habilitado: boolean) => useQuery({
  queryKey: ['org', org, 'scan', id, 'delta'], enabled: habilitado && esId(id), staleTime: 60_000, refetchIntervalInBackground: false,
  queryFn: async () => AuditDelta.parse(await api(`/api/orgs/${org}/scans/${id}/delta`, { esquema: AuditDelta })),
  refetchInterval: (q) => (!es404(q) && q.state.data?.available === false && q.state.data.reason === 'en_curso' ? 10_000 : false),
});

// E52 sin `limit` (el BACK da 30 versiones; las cifras del periodo vienen en `totals`). Sin sondeo: Realtime (scan_runs,
// findings y notifications) y volver a la pestaña la refrescan.
export const useEvolucion = (org: string, dias: number) => useQuery({
  ...base, queryKey: ['org', org, 'evolution', dias], staleTime: 60_000,
  queryFn: async () => Evolution.parse(await api(`/api/orgs/${org}/evolution?days=${dias}`, { esquema: Evolution })),
});
