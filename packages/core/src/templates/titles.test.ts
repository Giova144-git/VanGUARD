import { describe, expect, it } from 'vitest';
import { fixtures } from '@vanguard/contracts';
import {
  enCodigo, MAX_TITULO, SEVERIDAD_ES, SUFIJO_DUPLICADO_RLS, tituloAdvisor, tituloDependencia, tituloEnvSubido,
  tituloGitignoreSinEnv, tituloPoliticaPaseTodo, tituloRlsDesactivada, tituloRpcSinFreno, tituloSecreto, TITULOS_ADVISOR,
  tituloZonaPausada, unaLinea,
} from './titles.ts';

const titulo = (rule: string, resource: string) => fixtures.findings.find((f) => f.rule_id === rule && f.resource === resource)?.title;

describe('títulos iguales a los fixtures de contracts', () => {
  it('Supabase', () => {
    expect(tituloRlsDesactivada('public.pedidos')).toBe(titulo('SB_RLS_DISABLED', 'public.pedidos'));
    expect(tituloPoliticaPaseTodo('pase_todo', 'public.perfiles', 'SELECT')).toBe(titulo('SB_POLICY_ALLOW_ALL', 'public.perfiles'));
    expect(tituloRpcSinFreno('public.enviar_otp')).toBe(titulo('SB_RPC_ANON_NO_LIMIT', 'public.enviar_otp'));
    expect(tituloAdvisor('rls_enabled_no_policy', 'RLS Enabled No Policy', 'public.eventos'))
      .toBe(titulo('SB_ADVISOR_RLS_ENABLED_NO_POLICY', 'public.eventos'));
    expect(tituloAdvisor('rls_disabled_in_public', 'RLS Disabled in Public', 'public.pedidos', true))
      .toBe(titulo('SB_ADVISOR_RLS_DISABLED_IN_PUBLIC', 'public.pedidos'));
  });
  it('Codebase', () => {
    expect(tituloEnvSubido('.env')).toBe(titulo('CB_ENV_COMMITTED', '.env'));
    expect(tituloGitignoreSinEnv()).toBe(titulo('CB_GITIGNORE_NO_ENV', '.gitignore'));
    expect(tituloSecreto('CB_SECRET_SUPABASE_SERVICE_ROLE', 'src/lib/supabaseAdmin.ts'))
      .toBe(titulo('CB_SECRET_SUPABASE_SERVICE_ROLE', 'src/lib/supabaseAdmin.ts:4'));
    expect(tituloSecreto('CB_SECRET_POSTGRES_URL', '.env')).toBe(titulo('CB_SECRET_POSTGRES_URL', '.env:3'));
    expect(tituloDependencia('facade/ignition', '2.5.1', [{ id: 'CVE-2021-3129', severidad: 'critical' }]))
      .toBe(titulo('CB_DEP_VULN', 'Packagist:facade/ignition@2.5.1'));
    const seis = ['high', 'medium', 'high', 'low', 'medium', 'medium'] as const;
    expect(tituloDependencia('lodash', '4.17.15', seis.map((s, i) => ({ id: `CVE-${i}`, severidad: s }))))
      .toBe(titulo('CB_DEP_VULN', 'npm:lodash@4.17.15'));
  });
});

describe('variantes', () => {
  it('advisors: 12 traducciones; sin traducción o sin objeto, el original o el texto fijo', () => {
    expect(TITULOS_ADVISOR.size).toBe(12);
    expect(tituloAdvisor('auth_otp_long_expiry', 'Auth OTP long expiry', 'proyecto')).toBe('Auth OTP long expiry');
    expect(tituloAdvisor('unused_index', 'Unused Index', 'proyecto')).toBe('Índice sin uso');
    expect(tituloAdvisor('constructor', 'Original', 'public.x')).toBe('Original');
    expect(tituloAdvisor('nuevo_lint', '', 'proyecto')).toBe('Aviso de Supabase: nuevo_lint');
  });
  it('el sufijo de duplicado sobrevive al recorte', () => {
    const t = tituloAdvisor('rls_disabled_in_public', '', `public.${'t'.repeat(200)}`, true);
    expect(t.length).toBeLessThanOrEqual(MAX_TITULO);
    expect(t.endsWith(SUFIJO_DUPLICADO_RLS)).toBe(true);
  });
  it('política no SELECT → «modificar»; secretos y dependencias', () => {
    expect(tituloPoliticaPaseTodo('p', 'public.t', 'all')).toBe('La política «p» deja modificar public.t sin sesión');
    expect(tituloSecreto('CB_SECRET_GENERIC', 'config/.env.production')).toBe('Posible credencial en .env.production');
    expect(tituloDependencia('jquery', '3.4.1', [{ id: 'CVE-2020-11023', severidad: 'medium', kev: true },
      { id: 'CVE-2020-11022', severidad: 'medium' }]))
      .toBe('jquery 3.4.1 tiene 2 vulnerabilidades; una se explota en la vida real (CVE-2020-11023)');
    expect(tituloDependencia('x', '1.0.0', [{ id: 'GHSA-1', severidad: 'high', kev: true }]))
      .toBe('x 1.0.0 tiene 1 vulnerabilidad alta (GHSA-1), explotada en la vida real');
    expect(tituloGitignoreSinEnv(false)).toBe('El repositorio no tiene .gitignore en la raíz');
    expect(tituloZonaPausada('officialvanguard.com')).toBe('La zona officialvanguard.com de Cloudflare está pausada');
  });
  it('SEVERIDAD_ES', () => {
    expect(SEVERIDAD_ES).toEqual({ critical: 'crítica', high: 'alta', medium: 'media', low: 'baja', info: 'informativa' });
  });
});

describe('ayudas de texto', () => {
  it('unaLinea quita saltos y controles y recorta con «…»', () => {
    const ls = String.fromCharCode(0x2028);
    expect(unaLinea(`a\nb\tc${ls}d\u0000e`)).toBe('a b c d e');
    const t = unaLinea('x'.repeat(500));
    expect(t).toHaveLength(MAX_TITULO);
    expect(t.endsWith('…')).toBe(true);
  });
  it('enCodigo: un acento grave en el nombre no cierra el fragmento', () => {
    expect(enCodigo('ab')).toBe('`ab`');
    expect(enCodigo('a`b')).toBe('`` a`b ``');
    expect(enCodigo('x``y')).toBe('``` x``y ```');
  });
});
