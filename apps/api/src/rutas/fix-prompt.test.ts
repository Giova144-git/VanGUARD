import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError as ApiErrorBody, FixPromptResponse } from '@vanguard/contracts';
import { dbDoble, eqDe, type Op, type Resp } from '../test/db-doble.ts';
import { envDoble, mensajeDoble } from '../test/dobles.ts';

const estado = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db.ts', () => ({ db: () => estado.client }));
const ia = vi.hoisted(() => ({ pedirFixPrompt: vi.fn(), pedirResumen: vi.fn() }));
vi.mock('../ia/claude.ts', () => ia);

const { app } = await import('../app.ts');
const { pasoResumen } = await import('../scans/index.ts');

const ANA = '7b1e0000-0000-4000-8000-000000000001';
const ORG = '0f6c0000-0000-4000-8000-000000000001';
const F = 'c3d40000-0000-4000-8000-000000000001';
const SCAN = '5a1c0000-0000-4000-8000-000000000001';
let rol: string;
let anon: boolean;
let fila: Record<string, unknown>;
let tabla: (op: Op) => Resp | undefined;
let doble: ReturnType<typeof dbDoble>;

const hallazgo = (o: Record<string, unknown> = {}) => ({ id: F, module: 'supabase', rule_id: 'SB_RLS_DISABLED', severity: 'critical',
  confirmed: true, title: 'RLS desactivada en public.pedidos', resource: 'public.pedidos',
  evidence: { tabla: 'public.pedidos', rls_activa: false, anon_select: true }, fix_prompt: null, fix_model: null, ...o });

beforeEach(() => {
  rol = 'owner'; anon = false; fila = hallazgo(); tabla = () => undefined;
  doble = dbDoble({
    tabla: (op) => {
      if (op.table === 'org_members') return { data: { role: rol } };
      if (op.table === 'findings' && op.action === 'select' && eqDe(op, 'id') === F) return { data: fila };
      return tabla(op);
    },
    claims: (t) => (t === 'ok' ? { sub: ANA, email: anon ? '' : 'ana@acme.dev', is_anonymous: anon } : null),
  });
  estado.client = doble.client;
  ia.pedirFixPrompt.mockReset(); ia.pedirResumen.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const post = (body?: unknown) => app.request(`https://officialvanguard.com/api/orgs/${ORG}/findings/${F}/fix-prompt`, {
  method: 'POST', headers: { authorization: 'Bearer ok', 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, envDoble().env);

describe('E15 · fix-prompt', () => {
  it('con caché → cached:true, sin llamar al modelo, también para un anónimo', async () => {
    fila = hallazgo({ fix_prompt: '# Corrige RLS\npasos…', fix_model: 'claude-sonnet-5-5' });
    anon = true; rol = 'viewer';
    const r = await post({ flavor: 'claude_code' });
    expect(r.status).toBe(200);
    const b = FixPromptResponse.parse(await r.json());
    expect(b).toMatchObject({ cached: true, model: 'claude-sonnet-5-5' });
    expect(b.prompt).toContain('# Corrige RLS');
    expect(ia.pedirFixPrompt).not.toHaveBeenCalled();
  });

  it('caché guardada con controles bidi crudos → sale con ⟨U+XXXX⟩ (20 como mucho); si se pasa del máximo, va la plantilla', async () => {
    const rlo = String.fromCharCode(0x202e);
    fila = hallazgo({ fix_prompt: `# Corrige src/${rlo}gnp.js`, fix_model: 'claude-sonnet-5-5' });
    const b = FixPromptResponse.parse(await (await post({ flavor: 'cursor' })).json());
    expect(b).toMatchObject({ cached: true, model: 'claude-sonnet-5-5' });
    expect(b.prompt).toContain('# Corrige src/⟨U+202E⟩gnp.js');
    expect(b.prompt.includes(rlo)).toBe(false);
    fila = hallazgo({ fix_prompt: 'a'.repeat(9000) + rlo.repeat(2800), fix_model: 'claude-sonnet-5-5' });
    const c = FixPromptResponse.parse(await (await post({ flavor: 'claude_code' })).json());
    expect(c.cached).toBe(true);
    expect(c.prompt.split('⟨U+202E⟩').length - 1).toBe(20);
    expect(c.prompt.includes(rlo)).toBe(false);
    fila = hallazgo({ fix_prompt: 'a'.repeat(11_950) + rlo.repeat(20), fix_model: 'claude-sonnet-5-5' });
    const r = await post({ flavor: 'claude_code' });
    expect(r.status).toBe(200);
    const d = FixPromptResponse.parse(await r.json());
    expect(d).toMatchObject({ cached: false, model: 'template' });
    expect(d.prompt.trimEnd().endsWith('</evidencia_no_confiable>')).toBe(true);
    expect(ia.pedirFixPrompt).not.toHaveBeenCalled();
  });

  it('viewer sin caché → 403 sin gastar IA', async () => {
    rol = 'viewer';
    expect((await post()).status).toBe(403);
    expect(ia.pedirFixPrompt).not.toHaveBeenCalled();
  });

  it('admin: la IA responde → se guarda en findings.fix_prompt (filtrado por org) y la 2.ª vez sale de caché', async () => {
    ia.pedirFixPrompt.mockResolvedValue({ ok: true, model: 'claude-sonnet-5-5', cost_usd: 0.03, injection_flags: [],
      data: { contexto: 'La tabla está abierta.', pasos: ['Activa RLS'], prompt_para_tu_ia: 'Activa RLS en public.pedidos',
        prueba_de_aceptacion: 'anon no lee filas' } });
    const r = await post();
    const b = FixPromptResponse.parse(await r.json());
    expect(b).toMatchObject({ cached: false, model: 'claude-sonnet-5-5' });
    const up = doble.ops.find((o) => o.table === 'findings' && o.action === 'update');
    expect(up?.payload).toMatchObject({ fix_model: 'claude-sonnet-5-5' });
    expect(eqDe(up!, 'org_id')).toBe(ORG);
    expect(String((up?.payload as { fix_prompt: string }).fix_prompt)).toContain('Activa RLS');
  });

  it('presupuesto agotado → 429 budget_exceeded con fallback_prompt; IA apagada → 503 ai_disabled', async () => {
    ia.pedirFixPrompt.mockResolvedValue({ ok: false, code: 'budget', injection_flags: [] });
    const r = await post();
    expect(r.status).toBe(429);
    const e = ApiErrorBody.parse(await r.json()).error;
    expect(e.code).toBe('budget_exceeded');
    expect(String(e.details?.fallback_prompt)).toContain('public.pedidos');
    ia.pedirFixPrompt.mockResolvedValue({ ok: false, code: 'disabled', injection_flags: [] });
    expect((await post()).status).toBe(503);
  });

  it('salida filtrada → 200 con model template y las banderas, sin guardar', async () => {
    ia.pedirFixPrompt.mockResolvedValue({ ok: false, code: 'invalid', injection_flags: ['url_no_permitida', 'pipe_a_shell'] });
    const b = FixPromptResponse.parse(await (await post()).json());
    expect(b).toMatchObject({ model: 'template', cached: false, injection_flags: ['url_no_permitida', 'pipe_a_shell'] });
    expect(doble.ops.some((o) => o.action === 'update')).toBe(false);
  });

  it('flavor desconocido → 422', async () => {
    expect((await post({ flavor: 'vim' })).status).toBe(422);
  });
});

describe('paso resumen_ia', () => {
  const msg = () => mensajeDoble({ v: 1, kind: 'scan', scan_run_id: SCAN, org_id: ORG, paso: 'resumen_ia' });
  const hallazgos = [{ id: F, module: 'supabase', rule_id: 'SB_RLS_DISABLED', severity: 'critical', confirmed: true,
    title: 'RLS desactivada', resource: 'public.pedidos' }];

  it('con summary ya escrito no vuelve a llamar a la IA (sin doble gasto)', async () => {
    tabla = (op) => (op.table === 'scan_runs' ? { data: { summary: { resumen: 'ya', top: [], relaciones: [], model: 'x' }, score: 20, coverage: null } } : undefined);
    expect(await pasoResumen(envDoble().env, msg().body as never)).toEqual({ status: 'done' });
    expect(ia.pedirResumen).not.toHaveBeenCalled();
  });

  it('si la IA falla, guarda la plantilla determinista con model template', async () => {
    tabla = (op) => {
      if (op.table === 'scan_runs' && op.action === 'select') return { data: { summary: null, score: 20, coverage: { seen: 4, total: 4, missing: [] } } };
      if (op.table === 'findings') return { data: hallazgos };
      return undefined;
    };
    ia.pedirResumen.mockResolvedValue({ ok: false, code: 'disabled' });
    const r = await pasoResumen(envDoble().env, msg().body as never);
    expect(r).toMatchObject({ status: 'done', error_code: 'ia_disabled' });
    const up = doble.ops.find((o) => o.table === 'scan_runs' && o.action === 'update');
    expect((up?.payload as { summary: { model: string } }).summary.model).toBe('template');
  });
});
