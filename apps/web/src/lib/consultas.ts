// Hooks de lectura (S14 §14.8). Intervalos de A7.5: Realtime es la vía normal de frescura y el polling solo el
// respaldo (nunca baja de 10 s), siempre con la pestaña visible (refetchIntervalInBackground: false).
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ConnectionPublic, EstadoModulo, Finding, FixPromptResponse, Me, Overview, ScanRun, type Module, type Severity,
} from '@vanguard/contracts';
import { z } from 'zod';
import { api } from './api';
import { USA_FIXTURES } from './env';
import { useVivo } from './vivo';

const base = { refetchIntervalInBackground: false, placeholderData: keepPreviousData } as const;
// [respaldo, con Realtime] en ms
const intervalo = (vivo: boolean, respaldo: number, conCanal: number) => (vivo ? conCanal : respaldo);

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
    queryKey: ['org', org, 'finding', id], enabled: !!id,
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
  queryKey: ['org', org, 'fix', id], enabled: habilitado, staleTime: Infinity, retry: false,
  queryFn: () => api(`/api/orgs/${org}/findings/${id}/fix-prompt`, { method: 'POST', body: {}, esquema: FixPromptResponse }),
});

// Mientras queued|running: 10 s de respaldo (los pasos llegan por el evento de scan_runs). En fixtures, sin cupo que
// cuidar, 1 s, para ver avanzar la simulación de 12 s.
export const useScan = (org: string, id: string | undefined) => useQuery({
  queryKey: ['org', org, 'scan', id], enabled: !!id, refetchIntervalInBackground: false,
  queryFn: () => api(`/api/orgs/${org}/scans/${id}`, { esquema: ScanRun }),
  refetchInterval: (q) => ['queued', 'running'].includes(q.state.data?.status ?? 'queued') ? (USA_FIXTURES ? 1_000 : 10_000) : false,
});
