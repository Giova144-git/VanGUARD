import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv, McpCtx, McpScope } from '../env.ts';
import { log } from '../lib/log.ts';

// Servidor MCP propio (S13 §13.7): Streamable HTTP SIN estado y con respuesta JSON (sin SSE), escrito a mano sobre
// JSON-RPC 2.0 en vez del SDK: cero dependencias nuevas en el bundle del Worker, ~0,1 ms de CPU por mensaje y nada de
// eval (el validador es zod). Cada POST trae un mensaje (o un lote) y se responde en el acto; GET no abre stream (405).
// Métodos: initialize, ping, tools/list, tools/call, prompts/list y prompts/get. Ninguno llama a Claude ni escribe.
export const VERSIONES = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MAX_TEXTO = 100_000;   // > 100 KB → isError en vez de un JSON cortado (S13 §13.7)

export type Herramienta = {
  name: string; title: string; description: string; scope: McpScope; input: z.ZodObject;
  run: (args: Record<string, unknown>, c: Context<AppEnv>) => Promise<unknown>;
};
export type ArgumentoPrompt = { name: string; description: string; required?: boolean };
export type Prompt = {
  name: string; title: string; description: string; scope: McpScope; arguments: ArgumentoPrompt[];
  get: (args: Record<string, string>, c: Context<AppEnv>) => Promise<{ description: string; text: string }>;
};
export type Servidor = { nombre: string; titulo: string; version: string; instrucciones: string; herramientas: Herramienta[]; prompts: Prompt[] };

/** Error de una herramienta o prompt que se le puede contar al cliente tal cual (no encontrado, sin permiso…). */
export class McpFallo extends Error {}

type Mensaje = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type Respuesta = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };
const ok = (id: Respuesta['id'], result: unknown): Respuesta => ({ jsonrpc: '2.0', id, result });
const ko = (id: Respuesta['id'], code: number, message: string): Respuesta => ({ jsonrpc: '2.0', id, error: { code, message } });
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {});
const idValido = (x: unknown): x is string | number => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x));

// inputSchema de cada herramienta: JSON Schema del lado de entrada (los .default() no son obligatorios), una vez por isolate.
const esquemas = new WeakMap<z.ZodObject, Record<string, unknown>>();
function esquemaDe(s: z.ZodObject): Record<string, unknown> {
  let e = esquemas.get(s);
  if (!e) {
    const { $schema: _, ...resto } = z.toJSONSchema(s, { io: 'input' }) as Record<string, unknown>;
    e = resto;
    esquemas.set(s, e);
  }
  return e;
}

const ANOTACIONES = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const texto = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function llamar(s: Servidor, ctx: McpCtx, p: Record<string, unknown>, c: Context<AppEnv>) {
  const h = s.herramientas.find((x) => x.name === p.name);
  if (!h) return null;
  const t0 = Date.now();
  const fin = (ok: boolean, code?: string) => log(ok ? 'info' : 'warn', 'mcp_call', { token_id: ctx.tokenId, tool: h.name, ms: Date.now() - t0, ok, code });
  if (!ctx.scopes.includes(h.scope)) { fin(false, 'scope'); return texto(`Este token no tiene el permiso ${h.scope}.`, true); }
  const a = h.input.safeParse(obj(p.arguments));
  if (!a.success) {
    fin(false, 'invalid_args');
    return texto(`Argumentos no válidos: ${a.error.issues.slice(0, 5).map((i) => i.path.join('.') || '(raíz)').join(', ')}.`, true);
  }
  try {
    const out = await h.run(a.data as Record<string, unknown>, c);
    const t = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    if (t.length > MAX_TEXTO) { fin(false, 'too_large'); return texto('Respuesta demasiado grande: usa un limit menor o filtra por module.', true); }
    fin(true);
    return texto(t);
  } catch (e) {
    fin(false, e instanceof McpFallo ? 'fallo' : 'internal');
    return texto(e instanceof McpFallo ? e.message : 'Error interno de VanGUARD. Prueba de nuevo en un minuto.', true);
  }
}

async function despachar(s: Servidor, m: Mensaje, c: Context<AppEnv>): Promise<Respuesta | null> {
  const ctx = c.get('mcp');
  const esPeticion = 'id' in m && m.id !== null && m.id !== undefined;
  // Notificaciones (notifications/initialized, cancelled…) y respuestas del cliente: no se contestan.
  if (!esPeticion) return null;
  if (!idValido(m.id) || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return ko(idValido(m.id) ? m.id : null, -32600, 'Petición JSON-RPC no válida');
  const id = m.id;
  const p = obj(m.params);
  switch (m.method) {
    case 'initialize': {
      const pedida = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
      return ok(id, {
        protocolVersion: (VERSIONES as readonly string[]).includes(pedida) ? pedida : VERSIONES[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: s.nombre, title: s.titulo, version: s.version },
        instructions: s.instrucciones,
      });
    }
    case 'ping': return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: s.herramientas.map((h) => ({ name: h.name, title: h.title, description: h.description,
        inputSchema: esquemaDe(h.input), annotations: { title: h.title, ...ANOTACIONES } })) });
    case 'tools/call': {
      const r = await llamar(s, ctx, p, c);
      return r ? ok(id, r) : ko(id, -32602, `Herramienta desconocida: ${String(p.name).slice(0, 60)}`);
    }
    case 'prompts/list':
      return ok(id, { prompts: s.prompts.map((x) => ({ name: x.name, title: x.title, description: x.description, arguments: x.arguments })) });
    case 'prompts/get': {
      const x = s.prompts.find((y) => y.name === p.name);
      if (!x) return ko(id, -32602, `Prompt desconocido: ${String(p.name).slice(0, 60)}`);
      if (!ctx.scopes.includes(x.scope)) return ko(id, -32602, `Este token no tiene el permiso ${x.scope}.`);
      const args = Object.fromEntries(Object.entries(obj(p.arguments)).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])));
      const falta = x.arguments.find((a) => a.required && !args[a.name]?.trim());
      if (falta) return ko(id, -32602, `Falta el argumento ${falta.name}`);
      try {
        const r = await x.get(args, c);
        log('info', 'mcp_prompt', { token_id: ctx.tokenId, prompt: x.name, ok: true });
        return ok(id, { description: r.description, messages: [{ role: 'user', content: { type: 'text', text: r.text } }] });
      } catch (e) {
        log('warn', 'mcp_prompt', { token_id: ctx.tokenId, prompt: x.name, ok: false });
        return ko(id, e instanceof McpFallo ? -32602 : -32603, e instanceof McpFallo ? e.message : 'Error interno de VanGUARD');
      }
    }
    default: return ko(id, -32601, `Método no soportado: ${m.method.slice(0, 60)}`);
  }
}

/** Manejador de /mcp (tras mcpAuth). Un lote se contesta con un arreglo; si todo eran notificaciones, 202 sin cuerpo. */
export function manejadorMcp(s: Servidor) {
  return async (c: Context<AppEnv>) => {
    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST');
      return c.json(ko(null, -32000, 'Este servidor MCP no abre streams: usa POST'), 405);
    }
    let cuerpo: unknown;
    try { cuerpo = await c.req.json(); } catch { return c.json(ko(null, -32700, 'El cuerpo no es JSON válido'), 400); }
    const lote = Array.isArray(cuerpo);
    const mensajes = (lote ? cuerpo : [cuerpo]) as unknown[];
    if (!mensajes.length || mensajes.length > 20) return c.json(ko(null, -32600, 'Lote vacío o de más de 20 mensajes'), 400);
    const respuestas: Respuesta[] = [];
    for (const m of mensajes) {   // en serie: cada herramienta ya hace sus lecturas en paralelo
      const r = await despachar(s, obj(m) as Mensaje, c);
      if (r) respuestas.push(r);
    }
    if (!respuestas.length) return c.body(null, 202);
    return c.json(lote ? respuestas : respuestas[0]);
  };
}
