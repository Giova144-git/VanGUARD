// Prompt de corrección (S14 §14.15). Un único texto armado por el BACK con su envoltorio determinista: se pinta en
// <pre> (L9, nada de Markdown) con los controles bidi a la vista (lib/bidi.ts), y «Copiar para mi IA» lo copia entero,
// sin transformarlo.
import { Sparkles } from 'lucide-react';
import type { Finding, FixPromptResponse } from '@vanguard/contracts';
import { BotonAccion } from '@/componentes/vg/BotonAccion';
import { BotonCopiar } from '@/componentes/vg/BotonCopiar';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { sinBidi } from '@/lib/bidi';
import { useFixPrompt } from '@/lib/consultas';
import { esApiError } from '@/lib/errores';
import { useGenerarPrompt } from '@/lib/mutaciones';

function TextoPrompt({ r, plantilla }: { r: Pick<FixPromptResponse, 'prompt' | 'model' | 'cached' | 'injection_flags'>; plantilla?: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {plantilla ? <Etiqueta texto="Plantilla · IA en pausa" rol="aviso" /> : r.model === 'template' ? <Etiqueta texto="Plantilla fija" /> : null}
        {r.injection_flags.length > 0 ? <Etiqueta texto={`Quitamos ${r.injection_flags.length} ${r.injection_flags.length === 1 ? 'instrucción sospechosa' : 'instrucciones sospechosas'} de la evidencia`} rol="aviso" /> : null}
      </div>
      {/* El botón y su aviso van antes del texto: el prompt mide hasta 28rem y, en la demo (1280×720), «Copiar para mi
          IA» quedaba casi dos pantallas más abajo (F-15). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <BotonCopiar valor={r.prompt} texto="Copiar para mi IA" variante="principal" tam="grande" />
        {plantilla ? null : <p className="text-[12.5px] text-texto-3">Generado por <span className="font-mono"><bdi dir="ltr">{sinBidi(r.model)}</bdi></span> · {r.cached ? 'guardado' : 'nuevo'}</p>}
      </div>
      <p className="text-[12.5px] text-muted-foreground">
        Este texto incluye evidencia de sistemas externos. Léelo antes de dárselo a una IA que pueda escribir en tu código o tu base.
      </p>
      <pre className="max-h-[28rem] overflow-auto rounded-lg border bg-background p-3 font-mono text-[13px] whitespace-pre-wrap"><bdi dir="ltr">{sinBidi(r.prompt)}</bdi></pre>
    </div>
  );
}

export function PromptCorreccion({ org, finding, puedeEscribir }: { org: string; finding: Finding; puedeEscribir: boolean }) {
  // Con has_fix_prompt se pide solo al abrir: viene de caché, sin gastar IA.
  const guardado = useFixPrompt(org, finding.id, finding.has_fix_prompt);
  const generar = useGenerarPrompt(org);
  const r = guardado.data ?? generar.data;
  const error = generar.error ?? guardado.error;
  const plantilla = esApiError(error) && typeof error.details?.fallback_prompt === 'string' ? error.details.fallback_prompt : null;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="titulo-prompt">
      <h3 id="titulo-prompt" className="text-[15px] font-semibold">Prompt de corrección</h3>
      {/* Aviso corto para el lector: la región live no envuelve el <pre>, que tiene varios KB. */}
      <p className="sr-only" role="status">{r || plantilla ? 'Prompt listo' : ''}</p>
      {r ? <TextoPrompt r={r} />
        : plantilla ? <TextoPrompt r={{ prompt: plantilla, model: 'template', cached: false, injection_flags: [] }} plantilla />
        : finding.has_fix_prompt && guardado.isPending ? <p className="text-texto-3" aria-busy="true">—</p>
        : !puedeEscribir ? <p className="text-sm text-muted-foreground">Este hallazgo aún no tiene prompt: lo genera un administrador.</p>
        : <>
            <BotonAccion variante="principal" tam="grande" icono={Sparkles} ocupado={generar.isPending} onClick={() => generar.mutate(finding.id)}>
              {generar.isPending ? 'Redactando el arreglo…' : 'Generar prompt de corrección'}
            </BotonAccion>
            {error && !plantilla ? <ErrorBloque error={error} /> : null}
          </>}
    </section>
  );
}
