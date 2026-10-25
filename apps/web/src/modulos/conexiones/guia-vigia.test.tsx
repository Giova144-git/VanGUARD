// Vigía en el asistente de conexión: cada paso de «Que Vigía me guíe» señala algo que el asistente pinta de verdad, y lo
// que dice tras la prueba son frases fijas: del servidor solo usa códigos de permiso conocidos, nunca su mensaje ni el
// token. Sin jsdom: renderToStaticMarkup, como bidi-conexiones-rendimiento-auditoria.test.tsx.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fixtures as fx, type PermCheck, type Provider } from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import { ApiError } from '@/lib/errores';
import { GUIAS_CONEXION } from '@/lib/guias';
import { nombrePermiso, PERMISOS } from '@/lib/permisos';
import Asistente, { Resultado } from './Asistente';
import { dichoDeChecks, dichoDeError, dichoDeRechazo, EXPLICA_PERMISO, GUIA_VIGIA, GUIA_VIGIA_CF_SITIO, OBJETIVO } from './guia-vigia';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const ORG = fx.me.orgs[0]!.id;
const ADMIN: OrgActual = { ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true };
const PROVEEDORES: Provider[] = ['supabase', 'cloudflare', 'github', 'ingest'];
const guias = (html: string) => new Set([...html.matchAll(/data-guia="([^"]+)"/g)].map((m) => m[1]!));

// `blindaje`: llega desde «Modo blindaje», que abre Cloudflare en modo «Zona»; si no, abre en modo «Sitio».
function pintar(provider: Provider, blindaje = false): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[{ pathname: `/o/${ORG}/connections/${provider}`, state: blindaje ? { blindaje: true } : null }]}>
        <OrgDePrueba org={ADMIN}>
          <Routes><Route path="/o/:orgId/connections/:provider" element={<Asistente />} /></Routes>
        </OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('«Que Vigía me guíe»', () => {
  for (const p of PROVEEDORES) {
    it(`${p}: el botón está y cada paso señala un data-guia que el asistente pinta`, () => {
      const html = pintar(p, p === 'cloudflare');
      expect(html).toContain('Que Vigía me guíe');
      const hay = guias(html);
      for (const paso of GUIA_VIGIA[p].pasos) expect(hay.has(paso.objetivo), `${p}: ${paso.objetivo}`).toBe(true);
    });
  }

  it('cloudflare en modo «Sitio» (el de entrada): cada paso de su guía señala algo que se pinta', () => {
    const hay = guias(pintar('cloudflare'));
    for (const paso of GUIA_VIGIA_CF_SITIO.pasos) expect(hay.has(paso.objetivo), paso.objetivo).toBe(true);
  });

  it('los pasos numerados existen en GUIAS_CONEXION de su proveedor', () => {
    for (const p of PROVEEDORES) for (const paso of GUIA_VIGIA[p].pasos) {
      const n = /^conexion-paso-(\d+)$/.exec(paso.objetivo)?.[1];
      if (n) expect(Number(n)).toBeLessThanOrEqual(GUIAS_CONEXION[p].pasos.length);
    }
  });

  it('textos fijos y cortos (sin plantillas ni marcadores)', () => {
    const textos = [...[...Object.values(GUIA_VIGIA), GUIA_VIGIA_CF_SITIO].flatMap((g) => [g.titulo, g.final, ...g.pasos.flatMap((x) => [x.texto, x.textoLectura ?? ''])]),
      ...Object.values(EXPLICA_PERMISO)].filter(Boolean);
    for (const t of textos) {
      expect(t, t).not.toMatch(/[{}<>$]/);
      expect(t.length, t).toBeLessThanOrEqual(180);
    }
  });

  it('cada código de PERMISOS tiene su explicación en llano', () => {
    for (const c of Object.keys(PERMISOS)) expect(EXPLICA_PERMISO[c], c).toBeTruthy();
  });

  it('la lista de permisos del resultado y cada fila llevan su data-guia', () => {
    const r = { connection: fx.connections[0], action_connection: null, ingest_secret: null,
      checks: [{ permission: 'advisors_read', ok: false }] } as unknown as Parameters<typeof Resultado>[0]['r'];
    const html = renderToStaticMarkup(<MemoryRouter><Resultado r={r} alTerminar={() => {}} /></MemoryRouter>);
    expect(html).toContain(`data-guia="${OBJETIVO.permisos}"`);
    expect(html).toContain('data-guia="permiso-advisors_read"');
  });
});

describe('dichoDeChecks', () => {
  const ok = (permission: string, extra: Partial<PermCheck> = {}): PermCheck => ({ permission, ok: true, ...extra });
  it('todo bien: celebra, se calla sola y señala la lista', () => {
    const d = dichoDeChecks([ok('project_admin_read'), ok('advisors_read')]);
    expect(d).toMatchObject({ pose: 'celebrar', objetivo: OBJETIVO.permisos });
    expect(d.duracion).toBeGreaterThan(0);
  });

  it('falta uno obligatorio: alerta, señala esa fila y dice qué marcar', () => {
    const d = dichoDeChecks([ok('project_admin_read'), ok('advisors_read', { ok: false, error_code: 'forbidden' })]);
    expect(d).toMatchObject({ pose: 'alerta', objetivo: 'permiso-advisors_read' });
    expect(d.texto).toContain(`«${nombrePermiso('advisors_read')}»`);
    expect(d.texto).toContain(EXPLICA_PERMISO.advisors_read);
    expect(d.duracion).toBeUndefined();
  });

  it('solo falta uno opcional: pensando, y lo dice como opcional; el obligatorio va antes', () => {
    expect(dichoDeChecks([ok('database_read'), ok('auth_config_read', { ok: false, required: false })])).toMatchObject({ pose: 'pensar', objetivo: 'permiso-auth_config_read' });
    expect(dichoDeChecks([ok('auth_config_read', { ok: false, required: false }), ok('database_read', { ok: false })]).objetivo).toBe('permiso-database_read');
  });

  it('un código desconocido (o con controles bidi) no llega a la burbuja: frase genérica sobre la lista', () => {
    const raro = 'evil‮<img src=x onerror=alert(1)>';
    const d = dichoDeChecks([ok(raro, { ok: false })]);
    expect(d.texto).not.toContain('evil');
    expect(d.texto).not.toMatch(/[<>‮]/);
    expect(d.objetivo).toBe(OBJETIVO.permisos);
    expect(dichoDeChecks([ok(raro, { ok: false }), ok('dns_read', { ok: false })]).texto).not.toContain('evil');
  });
});

describe('dichoDeError', () => {
  const TOKEN = 'sbp_fc0123456789abcdef0123456789abcdef0123';
  it('nunca repite el mensaje del servidor ni nada que no sea un código conocido', () => {
    const errores = [
      new ApiError(422, 'provider_rejected', `Tu token ${TOKEN} no vale`, undefined, { missing_permissions: ['database_read', TOKEN] }),
      new ApiError(422, 'provider_rejected', `Mensaje ${TOKEN}`, undefined, { missing_permissions: [TOKEN] }),
      new ApiError(422, 'key_rejected', `Clave ${TOKEN}`),
      new ApiError(400, 'invalid_body', `Campo ${TOKEN}`, undefined, { field_errors: { pat: [TOKEN] } }),
      new ApiError(500, 'internal', `Error ${TOKEN}`),
      new Error(TOKEN),
    ];
    for (const e of errores) {
      const d = dichoDeError(e);
      expect(JSON.stringify(d)).not.toContain(TOKEN);
      expect(JSON.stringify(d)).not.toContain('no vale');
    }
  });

  it('permiso que falta → alerta sobre el aviso rojo, con el nombre del primero conocido', () => {
    const d = dichoDeError(new ApiError(422, 'provider_rejected', 'x', undefined, { missing_permissions: ['contents:read', 'metadata:read'] }));
    expect(d).toMatchObject({ pose: 'alerta', objetivo: OBJETIVO.error });
    expect(d.texto).toContain('«Contents · Read-only»');
    expect(d.texto).toContain('otro más');
  });

  it('clave rechazada → el campo del token; fallo de red → el botón de probar', () => {
    expect(dichoDeError(new ApiError(422, 'key_rejected', 'x')).objetivo).toBe(OBJETIVO.token);
    expect(dichoDeError(new TypeError('fetch failed')).objetivo).toBe(OBJETIVO.probar);
  });
});

describe('dichoDeRechazo', () => {
  it('señala el primer campo que falla, en el orden del formulario; sin errores, nada', () => {
    expect(dichoDeRechazo({ token: 'x', ref: 'y' })?.objetivo).toBe(OBJETIVO.proyecto);
    expect(dichoDeRechazo({ accion: 'x' })?.objetivo).toBe(OBJETIVO.accion);
    expect(dichoDeRechazo({})).toBeNull();
  });
});
