// Escrituras (S14 §14.8). Al terminar invalidan por prefijo ['org', org, …].
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  AlertPrefs, CodeReviewSaved, Contact, ConnectionCreated, type CodeReviewState, ConnectionTest, Finding, FixPromptResponse, McpTokenCreated, type McpTokenCreate, NotificationTestResult, type ContactIn, ProposeResponse, RespuestaEscritura, ScanAccepted, UnderAttackProposal, type UnderAttackPropose, WikiEstimate, WikiRunAccepted, type WikiRepoRef, type WikiRunCreate, type ConnectionCreate, type FindingPatch, type ScanCreate, type ZipResult, type AlertPrefsIn, type CodeReviewPut,
} from '@vanguard/contracts';
import { z } from 'zod';
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

// ZIP en el navegador (F-18): E11 deja el scan en waiting_result y E23 le entrega el ZipResult ya validado en zip-local.ts.
// Sin useMutation, como useConectar: el caché de mutaciones guardaría en `variables` las rutas y los previews de secretos.
// Si E23 falla, el scan se queda esperando y el siguiente E11 del mismo usuario lo reemplaza (ZIP_RESULT_MISSING).
export async function subirZip(org: string, archivo: { filename: string; size_bytes: number }, resultado: ZipResult): Promise<string> {
  const body: ScanCreate = { kind: 'zip', ...archivo };
  const { scan_run_id: id } = await api(`/api/orgs/${org}/scans`, { method: 'POST', body, esquema: ScanAccepted });
  await api(`/api/orgs/${org}/scans/${encodeURIComponent(id)}/zip-result`, { method: 'POST', body: resultado, esquema: ScanAccepted });
  return id;
}

// Incidentes: «Lo estoy viendo» y «Silenciar 1 h». Cuerpo {} explícito: un POST sin cuerpo haría fallar c.req.json() del BACK.
export function useAccionIncidente(org: string) {
  const invalidar = useInvalidar(org);
  return useMutation({
    mutationFn: ({ id, que }: { id: string; que: 'ack' | 'mute' }) =>
      api(`/api/orgs/${org}/incidents/${id}/${que}`, { method: 'POST', body: que === 'mute' ? { minutes: 60 } : {}, esquema: RespuestaEscritura }),
    onSettled: () => invalidar('incident', 'incidents', 'overview'),
  });
}

// Confirmar con el código de un solo uso (E21) y deshacer (E22): los comparten «Bloquear IP» y «Modo bajo ataque», que
// el BACK despacha por el tipo de la aprobación o de la acción. `fin` refresca lo que cada una pinta.
function canjeYDeshacer(org: string, fin: () => Promise<unknown>) {
  return {
    confirmar: async (approvalId: string, code: string) => {
      const r = await api(`/api/orgs/${org}/actions/${approvalId}/confirm`, { method: 'POST', body: { code }, esquema: RespuestaEscritura });
      await fin();
      return r;
    },
    deshacer: async (actionId: string) => {
      const r = await api(`/api/orgs/${org}/actions/${actionId}/undo`, { method: 'POST', body: {}, esquema: RespuestaEscritura });
      await fin();
      return r;
    },
  };
}

// «Bloquear esta IP» (E20–E22): simular → confirmar con el código de un solo uso → deshacer. Sin useMutation para el código.
export function useBloqueo(org: string) {
  const invalidar = useInvalidar(org);
  const fin = () => invalidar('incident', 'incidents', 'overview', 'module');
  return {
    proponer: (body: { incident_id: string; target: string }) =>
      api(`/api/orgs/${org}/actions/propose`, { method: 'POST', body: { ...body, kind: 'block_ip' }, esquema: ProposeResponse }),
    ...canjeYDeshacer(org, fin),
    refrescar: fin,
  };
}

// «Modo bajo ataque» (E56, y E21/E22 como el bloqueo; asignaciones/modo-bajo-ataque.md §9). El host no viaja: el BACK lo
// saca del incidente. fin() también refresca la oferta (E55), así la tarjeta pasa a «Hecho» sin recargar.
export function useBajoAtaque(org: string) {
  const invalidar = useInvalidar(org);
  const fin = () => invalidar('incident', 'incidents', 'overview', 'module', 'under-attack');
  return {
    proponer: async (incidentId: string) => UnderAttackProposal.parse(await api(`/api/orgs/${org}/incidents/${incidentId}/under-attack/propose`,
      { method: 'POST', body: { scope: 'host' } satisfies UnderAttackPropose, esquema: UnderAttackProposal })),
    ...canjeYDeshacer(org, fin),
    refrescar: fin,
  };
}

// gcTime de 1 min, como useContactos: la respuesta trae verificacion.codigo y no se queda 5 min en el caché de mutaciones.
export function useGuardarContactos(org: string) {
  const qc = useQueryClient();
  return useMutation({
    gcTime: 60_000,
    mutationFn: (lista: ContactIn[]) => api(`/api/orgs/${org}/contacts`, { method: 'PUT', body: lista, esquema: z.array(Contact) }),
    onSuccess: (r) => qc.setQueryData(['org', org, 'contacts'], r),
  });
}

// E46: activar o apagar la revisión de código. El alta trae webhook_secret, que se ve UNA sola vez (§6.1). El onSuccess
// de las opciones (corre aunque la tarjeta ya se haya desmontado, a diferencia del de mutate()) lo deja en un contenedor
// en memoria por org y la tarjeta lo toma una vez con tomarSecreto(): si el admin cambia de pantalla justo al activar, lo
// encuentra al volver. gcTime 0 y reset() lo sacan del MutationCache; nunca va a storage, a la URL ni a la caché de
// consultas (la config de la respuesta entra sin el secreto y E45 no lo trae). La mutación no espera el refetch de E45.
const secretos = new Map<string, string>();
export function tomarSecreto(org: string): string | null {
  const s = secretos.get(org) ?? null;
  secretos.delete(org);
  return s;
}
export const opcionesGuardarRevision = (org: string, qc: QueryClient) => ({
  gcTime: 0,
  mutationFn: (body: CodeReviewPut) => api(`/api/orgs/${org}/code-review`, { method: 'PUT', body, esquema: CodeReviewSaved }),
  onSuccess: (r: CodeReviewSaved) => {
    if (typeof r.webhook_secret === 'string') secretos.set(org, r.webhook_secret);
    qc.setQueryData<CodeReviewState>(['org', org, 'revision'], (s) => (s && r.config ? { ...s, config: r.config } : s));
  },
  onSettled: () => { void qc.invalidateQueries({ queryKey: ['org', org, 'revision'] }); },
});
export function useGuardarRevision(org: string) {
  const qc = useQueryClient();
  return useMutation(opcionesGuardarRevision(org, qc));
}

// E49: umbrales de aviso de la revisión de código (WhatsApp y llamada).
export function useGuardarPrefsAvisos(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AlertPrefsIn) => api(`/api/orgs/${org}/alert-prefs`, { method: 'PUT', body, esquema: AlertPrefs }),
    onSuccess: (r) => qc.setQueryData(['org', org, 'alert-prefs'], r),
  });
}

export const useProbarCanal = (org: string) => useMutation({
  mutationFn: (channel: 'whatsapp' | 'voice') =>
    api(`/api/orgs/${org}/notifications/test`, { method: 'POST', body: { channel }, esquema: NotificationTestResult }),
});

// E29: el token vgk_ sale una sola vez. Sin useMutation, como useConectar: el caché de mutaciones lo guardaría en `data`;
// vive solo en el estado del panel, que lo borra al pulsar «Ya lo guardé».
export function useCrearTokenMcp(org: string) {
  const invalidar = useInvalidar(org);
  return async (body: McpTokenCreate) => {
    const r = await api(`/api/orgs/${org}/mcp-tokens`, { method: 'POST', body, esquema: McpTokenCreated });
    await invalidar('mcp');
    return r;
  };
}

export function useRevocarTokenMcp(org: string) {
  const invalidar = useInvalidar(org);
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/orgs/${org}/mcp-tokens/${id}`, { method: 'DELETE' }),
    onSettled: () => invalidar('mcp'),
  });
}

// Descarga autenticada (§14.17): un <a href> directo daría 401 porque la API usa Bearer, no cookie.
export async function descargarExport(org: string, formato: 'md' | 'json') {
  const res = await api<Response>(`/api/orgs/${org}/export?format=${formato}`, { crudo: true });
  const cd = res.headers.get('content-disposition') ?? '';
  const hoy = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const nombre = cd.match(/filename="?([^";]+)"?/)?.[1] ?? `vanguard-export-${hoy}.${formato}`;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return nombre;
}

// DeepWiki: estimar (E40, solo lee GitHub) y generar (E41, gasta IA con el tope que el usuario aceptó).
export const useEstimarWiki = (org: string) => useMutation({
  mutationFn: (body: WikiRepoRef) => api(`/api/orgs/${org}/wiki/estimate`, { method: 'POST', body, esquema: WikiEstimate }),
});
export function useGenerarWiki(org: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WikiRunCreate) => api(`/api/orgs/${org}/wiki/runs`, { method: 'POST', body, esquema: WikiRunAccepted }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org', org, 'wiki', 'runs'] }),
  });
}
