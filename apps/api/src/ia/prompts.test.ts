// Prompts congelados (S11 11.10), esquemas de salida (11.5) y canario (11.11 capa 8). Sin red.
import { describe, it, expect } from 'vitest';
import { CANARIO } from '@vanguard/core';
import { NUCLEO } from './prompts/nucleo.ts';
import { SISTEMA_FIX, INSTRUCCION_FINAL as FINAL_FIX } from './prompts/fix_prompt.ts';
import { SISTEMA_RESUMEN, INSTRUCCION_FINAL as FINAL_RESUMEN } from './prompts/audit_summary.ts';
import { SISTEMA_ALERTA, INSTRUCCION_FINAL as FINAL_ALERTA } from './prompts/alert_text.ts';
import { ESQUEMAS_JSON, INSTRUCCION_FINAL, FixPromptIA, AuditSummaryIA, AlertTextIA } from './claude.ts';

const SISTEMAS = { NUCLEO, SISTEMA_FIX, SISTEMA_RESUMEN, SISTEMA_ALERTA };

describe('prompts congelados', () => {
  it('el núcleo lleva el canario de untrusted.ts', () => {
    expect(NUCLEO.includes(CANARIO)).toBe(true);
  });
  it('el núcleo pasa holgado del mínimo cacheable (≥ 600 tokens; aquí la cota por caracteres, el smoke usa count_tokens)', () => {
    expect(NUCLEO.length).toBeGreaterThan(4000);
  });
  it('sin invalidadores de caché: ni fechas, ni uuids, ni restos de interpolación', () => {
    for (const [n, t] of Object.entries(SISTEMAS)) {
      expect(t, n).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(t, n).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(t, n).not.toContain('${');
    }
  });
  it('nunca piden un campo «razonamiento» (dispara rechazos reasoning_extraction, 11.5)', () => {
    for (const [n, t] of Object.entries(SISTEMAS)) expect(t.toLowerCase(), n).not.toContain('razonamiento');
  });
  it('una instrucción final fija por ruta', () => {
    expect(INSTRUCCION_FINAL).toEqual({ fix_prompt: FINAL_FIX, audit_summary: FINAL_RESUMEN, alert_text: FINAL_ALERTA });
    for (const t of Object.values(INSTRUCCION_FINAL)) expect(t.length).toBeGreaterThan(20);
  });
});

describe('esquemas JSON escritos a mano (11.5)', () => {
  // Límites del API: additionalProperties false, todo requerido, sin minLength/maxLength/minimum/maximum/multipleOf
  function revisar(nodo: unknown, ruta: string): void {
    if (!nodo || typeof nodo !== 'object') return;
    const o = nodo as Record<string, unknown>;
    for (const k of ['minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'minItems', 'maxItems'])
      expect(o[k], `${ruta}.${k}`).toBeUndefined();
    if (o.type === 'object') {
      expect(o.additionalProperties, ruta).toBe(false);
      expect([...(o.required as string[])].sort(), ruta).toEqual(Object.keys(o.properties as object).sort());
      for (const [k, v] of Object.entries(o.properties as object)) revisar(v, `${ruta}.${k}`);
    }
    if (o.type === 'array') revisar(o.items, `${ruta}[]`);
  }
  it('las tres rutas cumplen los límites del API y piden sospecha_inyeccion', () => {
    for (const [ruta, esquema] of Object.entries(ESQUEMAS_JSON)) {
      revisar(esquema, ruta);
      expect(Object.keys(esquema.properties)).toContain('sospecha_inyeccion');
    }
  });
});

describe('zod de salida (límites que el API no impone)', () => {
  const ID = '7b1e0000-0000-4000-8000-000000000001', ID2 = '7b1e0000-0000-4000-8000-000000000002';
  it('FixPromptIA: acepta una salida buena y rechaza pasos insuficientes', () => {
    const ok = { contexto: 'La tabla public.pedidos no tiene RLS.', pasos: ['Abre el editor SQL.', 'Ejecuta la migración.'],
      prompt_para_tu_ia: 'Activa RLS en public.pedidos con una migración nueva. '.repeat(3), prueba_de_aceptacion: 'Debe devolver true.',
      sospecha_inyeccion: false };
    expect(FixPromptIA.safeParse(ok).success).toBe(true);
    expect(FixPromptIA.safeParse({ ...ok, pasos: ['Abre el editor SQL.'] }).success).toBe(false);
  });
  it('AuditSummaryIA: top de 1 a 5 con uuid; relaciones con ≥ 2 ids', () => {
    const ok = { resumen: 'Puntaje 41/100. '.repeat(6), top: [{ finding_id: ID, por_que: 'Legible por anon.' }],
      relaciones: [{ finding_ids: [ID, ID2], explicacion: 'La clave anula RLS.' }], sospecha_inyeccion: false };
    expect(AuditSummaryIA.safeParse(ok).success).toBe(true);
    expect(AuditSummaryIA.safeParse({ ...ok, top: [] }).success).toBe(false);
    expect(AuditSummaryIA.safeParse({ ...ok, top: [{ finding_id: 'no-es-uuid', por_que: 'x' }] }).success).toBe(false);
    expect(AuditSummaryIA.safeParse({ ...ok, relaciones: [{ finding_ids: [ID], explicacion: 'x' }] }).success).toBe(false);
  });
  it('AlertTextIA: sin IP, enlace ni correo; la voz sin dígitos', () => {
    const ok = { whatsapp: 'Una sola dirección concentra casi todo el tráfico de tu tienda.',
      voz: 'Una sola dirección está enviando casi todo el tráfico de tu aplicación.', sospecha_inyeccion: false };
    expect(AlertTextIA.safeParse(ok).success).toBe(true);
    expect(AlertTextIA.safeParse({ ...ok, whatsapp: 'La IP 186.92.10.4 satura tu tienda desde hace rato.' }).success).toBe(false);
    expect(AlertTextIA.safeParse({ ...ok, whatsapp: 'Mira https://cloudflare.com ahora mismo, por favor.' }).success).toBe(false);
    expect(AlertTextIA.safeParse({ ...ok, voz: 'Recibiste 4000 peticiones en cinco minutos en tu tienda.' }).success).toBe(false);
  });
});
