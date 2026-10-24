// Hooks de lectura (S14 §14.8). Respaldo de 10 s y solo con la pestaña visible (cupo de Workers Free, A7.5).
// Realtime (F-16) llega en el hito 4: hasta entonces se usa siempre la columna «Respaldo».
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ConnectionPublic, EstadoModulo, Me, Overview, type Module } from '@vanguard/contracts';
import { z } from 'zod';
import { api } from './api';

const base = { refetchIntervalInBackground: false, placeholderData: keepPreviousData } as const;

export const useMe = (habilitado = true) => useQuery({
  queryKey: ['me'], queryFn: () => api('/api/me', { esquema: Me }), staleTime: 60_000, enabled: habilitado,
});

export const useOverview = (org: string) => useQuery({
  ...base, queryKey: ['org', org, 'overview'], queryFn: () => api(`/api/orgs/${org}/overview`, { esquema: Overview }),
  refetchInterval: 10_000,
});

export const useEstadoModulo = (org: string, m: Module) => useQuery({
  ...base, queryKey: ['org', org, 'module', m], queryFn: () => api(`/api/orgs/${org}/modules/${m}/state`, { esquema: EstadoModulo }),
  refetchInterval: 10_000,
});

export const useConexiones = (org: string) => useQuery({
  ...base, queryKey: ['org', org, 'connections'], queryFn: () => api(`/api/orgs/${org}/connections`, { esquema: z.array(ConnectionPublic) }),
  refetchInterval: 30_000,
});
