import { BotonCopiar } from './BotonCopiar';

// JSON con sangría 2 en <pre> (S14 §14.7, L9): la evidencia es dato no confiable y se pinta como texto.
export function FichaFila({ valor, rotulo }: { valor: unknown; rotulo?: string }) {
  const texto = valor === null ? 'null' : valor === '' ? '""' : JSON.stringify(valor, null, 2) ?? String(valor);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {rotulo ? <span className="flex-1 text-[12.5px] font-medium text-texto-3">{rotulo}</span> : <span className="flex-1" />}
        <BotonCopiar valor={texto} />
      </div>
      <pre className={`max-h-80 overflow-auto rounded-lg border bg-background p-3 font-mono text-[13px] whitespace-pre-wrap break-all ${valor == null || valor === '' ? 'text-texto-3' : ''}`}>{texto}</pre>
    </div>
  );
}
