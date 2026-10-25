// «Resolver con mi IA» (MCP). El botón principal, «Enviar a mi IA» (EnviarAMiIA.tsx), abre Claude Code (terminal, en el
// clon del repo) con la orden ya escrita, la anota en la cola de la org y Vigía lo cuenta; «Abrir en VS Code» abre una
// pestaña de Claude Code en VS Code (y también la anota). La orden trae del MCP la corrección de VanGUARD para este
// hallazgo (prompt resolver_hallazgo / herramienta get_fix_prompt) y la aplica. Nada se envía solo: el usuario pulsa
// Enter. Copiar queda de respaldo para otras IAs o si el enlace no abre. Solo viaja el id: la evidencia y el prompt los
// lee la IA del MCP, con los secretos ya tapados. Un id que no sea un UUID no sale nunca: lo que llega a la IA es una
// orden, y no puede llevar nada más que el id. Viewer y demo: pueden abrir y copiar, pero no anotar en la cola.
import { Code2, SquareTerminal, Wand2, X } from 'lucide-react';
import { Link } from 'react-router';
import type { FixRequest } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { BotonCopiar } from '@/componentes/vg/BotonCopiar';
import { esId } from '@/lib/ids';
import { comandoClaudeCode, enlaceClaudeCode, enlaceVsCode, pedidoResolver, slugRepo } from '@/lib/mcp';
import { useCancelarEnvioIA } from '@/lib/mutaciones';
import { mensajeDe } from '@/lib/errores';
import { BotonEnviarAMiIA, EstadoEnvioIA, envioAbierto, useEnviarConVigia } from './EnviarAMiIA';

export function ResolverConMcp({ org, findingId, repo, puedeEscribir = false, envio }: {
  org: string; findingId: string; repo?: string | null; puedeEscribir?: boolean; envio?: FixRequest | null;
}) {
  const { enviar } = useEnviarConVigia(org);
  const cancelar = useCancelarEnvioIA(org);
  if (!esId(findingId)) return null;
  const r = slugRepo(repo);
  const comando = comandoClaudeCode('resolver_hallazgo', findingId);
  const abierta = envioAbierto(envio);
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4" aria-labelledby="titulo-resolver-mcp">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="titulo-resolver-mcp" className="flex flex-1 items-center gap-2 text-[15px] font-semibold"><Wand2 className="size-4 text-muted-foreground" />Resolver con mi IA</h3>
        <EstadoEnvioIA envio={envio} />
      </div>
      <p className="text-sm text-muted-foreground">
        «Enviar a mi IA» abre Claude Code {r ? <>en tu repo <bdi dir="ltr" className="font-mono text-foreground">{r}</bdi></> : 'en tu equipo'} con
        la orden ya escrita: trae la corrección de VanGUARD por MCP y te muestra el diff antes de aplicarla. Revisa la orden y pulsa Enter.
      </p>
      <div className="flex flex-wrap items-start gap-3">
        <BotonEnviarAMiIA org={org} findingId={findingId} repo={r} puedeEscribir={puedeEscribir} />
        <Button asChild variant="secundaria">
          <a href={enlaceVsCode(pedidoResolver(findingId))} onClick={puedeEscribir ? (e) => enviar(findingId, 'vscode', e.currentTarget) : undefined}><Code2 />Abrir en VS Code</a>
        </Button>
        {abierta && puedeEscribir ? (
          <Button variant="fantasma" disabled={cancelar.isPending} onClick={() => cancelar.mutate(findingId)}><X />Cancelar envío</Button>
        ) : null}
      </div>
      {cancelar.isError ? <p role="alert" className="text-sm text-mal">{mensajeDe(cancelar.error)}</p> : null}
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">¿No se abre o usas otra IA? Copia la orden</summary>
        <div className="flex flex-wrap gap-3 pt-3">
          {puedeEscribir ? null : <Button asChild variant="secundaria"><a href={enlaceClaudeCode(comando, r)}><SquareTerminal />Abrir en Claude Code</a></Button>}
          <BotonCopiar valor={comando} texto="Copiar para Claude Code" />
          <BotonCopiar valor={pedidoResolver(findingId)} texto="Copiar para otra IA" />
        </div>
        <p className="pt-2 text-[12.5px] text-texto-3">
          El botón de la terminal funciona después de usar Claude Code una vez en ella; si no conoce tu clon, abre en tu carpeta personal.
          Con el prompt «resolver_enviados» tu IA resuelve de una vez todo lo que le hayas enviado.
        </p>
      </details>
      <p className="text-[12.5px] text-texto-3">
        ¿Aún no la conectas? <Link to={`/o/${org}/export`} className="font-medium text-foreground underline underline-offset-4">Crea un token MCP en Llevar a tu IA</Link>.
      </p>
    </section>
  );
}
