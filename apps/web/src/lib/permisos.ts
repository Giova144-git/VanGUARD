// Código de permiso → nombre en el panel del proveedor (tablas de S07 §07.2 y S08 §08.2). La API manda códigos.
import type { ProviderErrorCode } from '@vanguard/contracts';

export const PERMISOS: Record<string, string> = {
  // Supabase (ids FGA del PAT con alcance)
  project_admin_read: 'Project Settings', advisors_read: 'Advisors', database_read: 'Database',
  analytics_logs_read: 'Logs', auth_config_read: 'Auth Config',
  // Cloudflare (API Token de zona)
  zone_read: 'Zone · Zone · Read', zone_settings_read: 'Zone · Zone Settings · Read', dns_read: 'Zone · DNS · Read',
  analytics_read: 'Zone · Analytics · Read', firewall_read: 'Zone · Firewall Services · Read', waf_read: 'Zone · Zone WAF · Read',
  bot_read: 'Zone · Bot Management · Read', firewall_edit: 'Zone · Firewall Services · Edit',
  config_rules_edit: 'Zone · Config Rules · Edit', zone_settings_edit: 'Zone · Zone Settings · Edit',   // modo bajo ataque (host y zona)
  // GitHub (fine-grained)
  'metadata:read': 'Metadata · Read-only', 'contents:read': 'Contents · Read-only', 'dependabot_alerts:read': 'Dependabot alerts · Read-only',
};

export const nombrePermiso = (codigo: string) => (Object.hasOwn(PERMISOS, codigo) ? PERMISOS[codigo]! : codigo);

export const FRASE_ERROR: Record<ProviderErrorCode, string> = {
  unauthorized: 'El proveedor no reconoce el token: cópialo de nuevo.',
  forbidden: 'Al token le falta este permiso.',
  not_found: 'No encontramos el recurso con este token: revisa el proyecto, la zona o el repo.',
  rate_limited: 'El proveedor nos pidió esperar: reintentamos en un minuto.',
  unavailable: 'El proveedor no responde ahora.',
  timeout: 'El proveedor tardó demasiado en responder.',
  invalid: 'El proveedor devolvió una respuesta que no entendimos.',
};
