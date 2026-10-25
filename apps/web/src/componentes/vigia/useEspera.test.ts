// Vigía en las esperas largas: comenta solo si ya estaba a la vista, rota las frases, cambia con el paso, celebra o avisa
// al final, se calla si la despiden o si la espera se va, y no deja timers vivos. Las frases son fijas.
import { describe, expect, it } from 'vitest';
import type { Dicho } from './contexto';
import { CADA_MS, DURACION_FIN_MS, ESPERAS, textosEspera } from './esperas';
import { crearEspera } from './useEspera';

function montar(visible = true) {
  const dichos: Dicho[] = [];
  let calladas = 0;
  const guia = { visible, decir: (d: Dicho) => { dichos.push(d); }, callar: () => { calladas++; } };
  const timers = new Map<number, () => void>();
  let n = 0;
  const reloj = { cada: (f: () => void) => { timers.set(++n, f); return n; }, parar: (t: unknown) => { timers.delete(t as number); } };
  const espera = crearEspera(() => guia, { reloj });
  const tic = () => { for (const f of [...timers.values()]) f(); };
  return { guia, dichos, espera, timers, tic, calladas: () => calladas };
}
const A = ['uno', 'dos', 'tres'];
const FIN = ESPERAS.auditoria.fin;

describe('crearEspera', () => {
  it('a la vista: dice la primera frase en discreto y pensando, y rota en bucle con cada tic', () => {
    const m = montar();
    m.espera.actualizar('esperando', A, FIN);
    expect(m.dichos[0]).toEqual({ texto: 'uno', pose: 'pensar', discreto: true });
    m.tic(); m.tic(); m.tic();
    expect(m.dichos.map((d) => d.texto)).toEqual(['uno', 'dos', 'tres', 'uno']);
    expect(m.timers.size).toBe(1);
  });

  it('las mismas frases (otro array) no reinician; frases nuevas empiezan por la primera', () => {
    const m = montar();
    m.espera.actualizar('esperando', A, FIN);
    m.tic();
    m.espera.actualizar('esperando', [...A], FIN);
    expect(m.dichos).toHaveLength(2);
    m.espera.actualizar('esperando', ['x', 'y'], FIN);
    expect(m.dichos.at(-1)?.texto).toBe('x');
    expect(m.timers.size).toBe(1);
  });

  it('con una sola frase no hace falta timer', () => {
    const m = montar();
    m.espera.actualizar('esperando', ['sola'], FIN);
    expect(m.timers.size).toBe(0);
  });

  it('despedida al empezar: la espera pasa en silencio, aunque la llamen a mitad, y sin final', () => {
    const m = montar(false);
    m.espera.actualizar('esperando', A, FIN);
    m.guia.visible = true;
    m.espera.actualizar('esperando', ['otra'], FIN);
    m.espera.actualizar('bien', A, FIN);
    expect(m.dichos).toEqual([]);
    expect(m.timers.size).toBe(0);
  });

  it('si la despiden a mitad, deja de rotar y no dice el final', () => {
    const m = montar();
    m.espera.actualizar('esperando', A, FIN);
    m.guia.visible = false;
    m.tic();
    expect(m.timers.size).toBe(0);
    m.guia.visible = true;
    m.espera.actualizar('bien', A, FIN);
    expect(m.dichos).toHaveLength(1);
  });

  it('al terminar bien, celebra con duración; con críticos, alerta; si falla, un aviso breve', () => {
    for (const [fase, pose] of [['bien', 'celebrar'], ['alerta', 'alerta'], ['fallo', 'alerta']] as const) {
      const m = montar();
      m.espera.actualizar('esperando', A, FIN);
      m.espera.actualizar(fase, A, FIN);
      expect(m.dichos.at(-1)).toEqual({ texto: FIN[fase], pose, duracion: DURACION_FIN_MS, discreto: true });
      expect(m.timers.size).toBe(0);
    }
  });

  it('abrir algo ya terminado no lo celebra', () => {
    const m = montar();
    m.espera.actualizar('inactiva', [], FIN);
    m.espera.actualizar('bien', A, FIN);
    expect(m.dichos).toEqual([]);
    expect(m.calladas()).toBe(0);
  });

  it('si la espera se va sin final, o se desmonta, se calla y no quedan timers', () => {
    const a = montar();
    a.espera.actualizar('esperando', A, FIN);
    a.espera.actualizar('inactiva', A, FIN);
    expect(a.calladas()).toBe(1);
    expect(a.timers.size).toBe(0);
    const b = montar();
    b.espera.actualizar('esperando', A, FIN);
    b.espera.parar();
    expect(b.calladas()).toBe(1);
    expect(b.timers.size).toBe(0);
    b.espera.parar();                       // sin espera en curso, no se calla de nuevo
    expect(b.calladas()).toBe(1);
  });

  it('tras un final, una espera nueva vuelve a decidir', () => {
    const m = montar();
    m.espera.actualizar('esperando', A, FIN);
    m.espera.actualizar('bien', A, FIN);
    m.espera.actualizar('esperando', ['otra vez'], FIN);
    expect(m.dichos.at(-1)?.texto).toBe('otra vez');
  });

  it('rota cada ~4 s', () => {
    expect(CADA_MS).toBe(4000);
  });
});

describe('textosEspera', () => {
  it('por paso, por subpaso y sin repetir; un paso desconocido o vacío cae a las generales', () => {
    expect(textosEspera(['supabase'], ESPERAS.auditoria)[0]).toMatch(/RLS/);
    expect(textosEspera(['repo:dependencias', 'repo'], ESPERAS.auditoria)[0]).toMatch(/dependencias/);
    const t = textosEspera(['repo:dependencias', 'repo'], ESPERAS.auditoria);
    expect(new Set(t).size).toBe(t.length);
    expect(textosEspera(['repo:otra'], ESPERAS.auditoria)[0]).toMatch(/claves expuestas/);
    expect(textosEspera([null, undefined, '', '__proto__', 'constructor'], ESPERAS.auditoria)).toBe(ESPERAS.auditoria.general);
  });

  it('los textos son fijos y caben en la burbuja', () => {
    const pasos = ['supabase', 'cloudflare', 'repo', 'zip', 'psi', 'resumen_ia', 'repo:dependencias', 'waiting_result'];
    const todos = [...pasos.flatMap((p) => textosEspera([p], ESPERAS.auditoria)),
      ...Object.values(ESPERAS).flatMap((e) => [...e.general, ...Object.values(e.fin)])];
    for (const t of todos) {
      expect(t, t).not.toMatch(/[{}<>$]/);
      expect(t.length, t).toBeLessThanOrEqual(180);
    }
  });
});
