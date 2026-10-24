import type { WikiModelos } from '@vanguard/contracts';
import type { Llm, Tarea } from '@vanguard/deepwiki';
import { llamarIATexto, type RutaWiki } from '../ia/claude.ts';
import { motor } from './motor.ts';

// Deps.llm de DeepWiki en el Worker (packages/deepwiki/LEEME.md, punto 7): cada tarea del motor va por ia/claude.ts con
// su ruta de ai_usage (wiki_triage | wiki_area | wiki_sintesis), así pasa por el interruptor IA_CORTE, la escalera de
// vg_ai_status, la reserva del peor caso y la liquidación. El modelo sale de modeloPara(tarea, modelos de la corrida) y
// max_tokens es el del motor. Nunca temperature, top_p, top_k ni tool_choice (lo garantiza claude.ts).

export type CodigoLlmWiki = 'sin_llm' | 'ia_sin_presupuesto' | 'ia_ritmo' | 'ia_no_disponible' | 'ia_invalida';

// Textos propios: nunca el mensaje del proveedor.
const TEXTO: Record<CodigoLlmWiki, string> = {
  sin_llm: 'La IA está apagada o no está configurada.',
  ia_sin_presupuesto: 'Se alcanzó el tope de gasto en IA.',
  ia_ritmo: 'Demasiadas llamadas a la IA en el último minuto.',
  ia_no_disponible: 'El servicio de IA no respondió.',
  ia_invalida: 'El servicio de IA rechazó la petición.',
};

// `reintentable`: la cola reintenta el paso (esperaS = retraso pedido; null = el escalonado normal). Si no, la corrida
// falla con `codigo` (WikiRunStep.error_code). Ninguno de los no reintentables gastó: falla sin coste.
export class ErrorLlmWiki extends Error {
  readonly codigo: CodigoLlmWiki;
  readonly reintentable: boolean;
  readonly esperaS: number | null;
  constructor(codigo: CodigoLlmWiki, reintentable = false, esperaS: number | null = null) {
    super(TEXTO[codigo]);
    this.name = 'ErrorLlmWiki';
    this.codigo = codigo;
    this.reintentable = reintentable;
    this.esperaS = esperaS;
  }
}

const RUTA: Record<Tarea, RutaWiki> = { wiki_triage: 'wiki_triage', wiki_area: 'wiki_area', wiki_sintesis: 'wiki_sintesis' };
// El ritmo por minuto (10 llamadas por org) se libera solo: se espera un minuto en vez de gastar el reintento ya.
const ESPERA_RITMO_S = 60;

export type LlamarTexto = typeof llamarIATexto;

export function llmWiki(env: CloudflareBindings, orgId: string, modelos: WikiModelos,
  llamar: LlamarTexto = llamarIATexto): Llm {
  return async (p) => {
    const ruta = RUTA[p.tarea];
    if (!ruta) throw new ErrorLlmWiki('ia_invalida');
    const { modeloPara } = await motor();
    const r = await llamar(env, { org_id: orgId, ruta, modelo: modeloPara(p.tarea, modelos), sistema: p.system,
      usuario: p.user, maxTokens: p.maxTokens });
    if (r.ok) return { texto: r.texto, modelo: r.model, uso: r.uso, ...(r.stop_reason ? { stop_reason: r.stop_reason } : {}) };
    switch (r.code) {
      case 'disabled': throw new ErrorLlmWiki('sin_llm');
      case 'budget': throw r.reintentar ? new ErrorLlmWiki('ia_ritmo', true, ESPERA_RITMO_S) : new ErrorLlmWiki('ia_sin_presupuesto');
      case 'timeout': throw new ErrorLlmWiki('ia_no_disponible', true);
      default: throw new ErrorLlmWiki('ia_invalida');
    }
  };
}
