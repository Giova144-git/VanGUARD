import type { PermCheck } from '@vanguard/contracts';

// Resultado común de los sondeos de E8/E9 (§07.2, §08.2, §09.2). La ruta decide qué responder: un sondeo nunca lanza
// ApiError, para que E9 pueda guardar los checks también cuando la conexión ya no sirve.
export type Sondeo = {
  estado: 'ok' | 'rechazado' | 'caido';
  motivo?: string;               // details.reason de provider_rejected (unauthorized, project_not_in_token…)
  faltan: string[];              // details.missing_permissions (códigos snake_case)
  mensaje?: string;              // error.message en español para la UI
  checks: PermCheck[];
  capabilities: Record<string, boolean>;
  scopes: string[];
  meta: Record<string, unknown>;
  label: string;
  expiresAt: string | null;
};

export const sondeoFallido = (estado: 'rechazado' | 'caido', checks: PermCheck[], extra: Partial<Sondeo> = {}): Sondeo =>
  ({ estado, faltan: [], checks, capabilities: {}, scopes: [], meta: {}, label: '', expiresAt: null, ...extra });

// Con los checks ya hechos: faltan los obligatorios con 401/403/404 → rechazado; un obligatorio caído por red, plazo,
// 429 o 5xx → caido (502); si no, ok.
export function veredicto(checks: PermCheck[]): Pick<Sondeo, 'estado' | 'faltan' | 'motivo'> {
  if (checks.some((c) => c.error_code === 'unauthorized')) return { estado: 'rechazado', faltan: [], motivo: 'unauthorized' };
  const malos = checks.filter((c) => c.required && !c.ok);
  const faltan = malos.filter((c) => c.error_code === 'forbidden' || c.error_code === 'not_found').map((c) => c.permission);
  if (faltan.length) return { estado: 'rechazado', faltan };
  if (malos.length) return { estado: 'caido', faltan: [] };
  return { estado: 'ok', faltan: [] };
}
