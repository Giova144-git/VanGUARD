// Escrituras (S14 §14.8). Al terminar invalidan por prefijo ['org', org, …].
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ConnectionCreated, ConnectionTest, Finding, FixPromptResponse, ScanAccepted, type ConnectionCreate, type FindingPatch, type ScanCreate,
} from '@vanguard/contracts';
import { api } from './api';

function useInvalidar(org: string) {
  const qc = useQueryClient();
  return (...claves: string[]) => Promise.all(claves.map((k) => qc.invalidateQueries({ queryKey: ['org', org, k] })));
}

// Sin useMutation a propósito: guardaría el cuerpo (con el token) en `variables` del caché de mutaciones.
// El token vive solo en esta llamada y en el campo del formulario, que se vacía al enviar (L10).
export function useConectar(org: string) {
  const invalidar = useInvalidar(org);
  return async (body: ConnectionCreate) => {
    const r = await api(`/api/orgs/${org}/connections`, { method: 'POST', body, esquema: ConnectionCreated });
    await invalidar('connections', 'overview', 'module');
    return r;
  };
}

export function useProbarConexion(org: string) {
  const invalidar = useInvalidar(org);
  return useMutation({
    mutationFn: (id: string) => api(`/api/orgs/${org}/connections/${id}/test`, { method: 'POST', body: {}, esquema: ConnectionTest }),
    onSettled: () => invalidar('connections', 'module'),
  });
}

// DELETE con {crudo:true}: hay que leer X-VG-Revoke-Url aunque la respuesta sea 204.
export function useQuitarConexion(org: string) {
  const invalidar = useInvalidar(org);
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api<Response>(`/api/orgs/${org}/connections/${id}`, { method: 'DELETE', crudo: true });
      return { revocar: res.headers.get('x-vg-revoke-url') };
    },
    onSuccess: () => invalidar('connections', 'overview', 'module'),
  });
}

export function usePatchHallazgo(org: string) {
  const invalidar = useInvalidar(org);
  return useMutation({
    mutationFn: ({ id, ...body }: FindingPatch & { id: string }) =>
      api(`/api/orgs/${org}/findings/${id}`, { method: 'PATCH', body, esquema: Finding }),
    onSuccess: () => invalidar('findings', 'finding', 'overview', 'module'),
  });
}

// Generar el prompt (~10 s). El resultado se guarda en ['org',org,'fix',id] y la lista pasa a has_fix_prompt.
export function useGenerarPrompt(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/orgs/${org}/findings/${id}/fix-prompt`, { method: 'POST', body: {}, esquema: FixPromptResponse }),
    onSuccess: (r, id) => {
      qc.setQueryData(['org', org, 'fix', id], r);
      qc.invalidateQueries({ queryKey: ['org', org, 'findings'] });
      qc.invalidateQueries({ queryKey: ['org', org, 'finding', id] });
    },
  });
}

export function useLanzarScan(org: string) {
  return useMutation({
    mutationFn: (body: ScanCreate) => api(`/api/orgs/${org}/scans`, { method: 'POST', body, esquema: ScanAccepted }),
  });
}
