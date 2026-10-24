// Conexiones de la org de demo (E7) y resultado de un sondeo de permisos (E8/E9). Solo últimos 4 caracteres,
// alcances y meta: nunca el token. `capabilities` lleva solo booleanos (S15 E7).
import type { ConnectionPublic, PermCheck } from '../api.ts';
import {
  CONN_CF_ACTION, CONN_CF_READ, CONN_GITHUB, CONN_INGEST, CONN_SUPABASE, EXPIRA_TOKENS, HOST_VICTIMA, PROJECT_REF, REPO,
  T_CONEXIONES_PROBADAS, T_ULTIMO_EVENTO, ZONA,
} from './ids.ts';

const ZONE_ID = '023e105f4ecef8ad9ca31a8372d0c353'; // Zone ID de ejemplo de la documentación de Cloudflare

export const connections = [
  {
    id: CONN_SUPABASE, provider: 'supabase', kind: 'read', label: 'Supabase · vanguard-demo', status: 'active', last4: 'a1b2',
    scopes: ['project_admin_read', 'advisors_read', 'database_read', 'analytics_logs_read', 'auth_config_read'],
    meta: { project_ref: PROJECT_REF, project_name: 'vanguard-demo', region: 'us-east-1' },
    capabilities: { project: true, health: true, advisors: true, sql_read_only: true, analytics: true, auth_config: true },
    expires_at: EXPIRA_TOKENS, last_checked_at: T_CONEXIONES_PROBADAS, last_error: null,
  },
  {
    id: CONN_CF_READ, provider: 'cloudflare', kind: 'read', label: `Cloudflare · ${ZONA}`, status: 'active', last4: 'c3d4',
    scopes: ['zone_read', 'zone_settings_read', 'dns_read', 'analytics_read', 'firewall_read', 'waf_read'],
    meta: { zone_id: ZONE_ID, zone_name: ZONA, plan: 'free', zone_status: 'active', token_type: 'user', threshold_factor: 0.1,
      watch_hosts: [HOST_VICTIMA] },
    capabilities: { zone_read: true, zone_settings_read: true, dns_read: true, analytics_read: true, firewall_read: true,
      waf_read: true, bot_read: false, zone_active: true, graphql_client_ip: true },
    expires_at: EXPIRA_TOKENS, last_checked_at: T_CONEXIONES_PROBADAS, last_error: null,
  },
  {
    id: CONN_CF_ACTION, provider: 'cloudflare', kind: 'action', label: `Cloudflare · ${ZONA} · blindaje`, status: 'active',
    last4: 'e5f6', scopes: ['firewall_read'],
    meta: { zone_id: ZONE_ID, zone_name: ZONA, plan: 'free', zone_status: 'active', token_type: 'user' },
    capabilities: { firewall_read: true },
    expires_at: EXPIRA_TOKENS, last_checked_at: T_CONEXIONES_PROBADAS, last_error: null,
  },
  {
    id: CONN_GITHUB, provider: 'github', kind: 'read', label: `GitHub · ${REPO}`, status: 'active', last4: '9c4e',
    scopes: ['metadata:read', 'contents:read'],
    meta: { repo_full_name: REPO, default_branch: 'main', private: true, repo_id: 870000001 },
    capabilities: { metadata: true, contents: true, dependabot_alerts: false },
    expires_at: EXPIRA_TOKENS, last_checked_at: T_CONEXIONES_PROBADAS, last_error: null,
  },
  {
    id: CONN_INGEST, provider: 'ingest', kind: 'read', label: HOST_VICTIMA, status: 'active', last4: 'x7Pq',
    scopes: [], meta: { purpose: 'ingest', hostname: HOST_VICTIMA }, capabilities: {},
    expires_at: null, last_checked_at: T_ULTIMO_EVENTO, last_error: null, // último evento recibido por la ingesta
  },
] satisfies ConnectionPublic[];

// Sondeo del token de lectura de Cloudflare: todo bien salvo un permiso opcional (cuadra con capabilities.bot_read).
export const permChecks = [
  { permission: 'zone_read', ok: true, required: true },
  { permission: 'zone_settings_read', ok: true, required: false },
  { permission: 'dns_read', ok: true, required: false },
  { permission: 'analytics_read', ok: true, required: true },
  { permission: 'firewall_read', ok: true, required: false },
  { permission: 'waf_read', ok: true, required: false },
  { permission: 'bot_read', ok: false, required: false, error_code: 'forbidden' },
] satisfies PermCheck[];
