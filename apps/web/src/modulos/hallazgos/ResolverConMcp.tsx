// «Resolver con mi IA» (MCP): un botón copia el comando que, en la IA conectada por MCP y abierta en el repo, trae la
// corrección de VanGUARD para este hallazgo (prompt resolver_hallazgo / herramienta get_fix_prompt) y la aplica.
// Solo viaja el id: la evidencia y el prompt los lee la IA del MCP, con los secretos ya tapados. Un id que no sea un
// UUID no se copia nunca: lo que se pega en la IA es una orden, y no puede llevar nada más que el id.
import { Wand2 } from 'lucide-react';
import { Link } from 'react-router';
import { BotonCopiar } from '@/componentes/vg/BotonCopiar';
import { esId } from '@/lib/ids';
import { comandoClaudeCode, pedidoResolver } from '@/lib/mcp';

export function ResolverConMcp({ org, findingId }: { org: string; findingId: string }) {
  if (!esId(findingId)) return null;
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4" aria-labelledby="titulo-resolver-mcp">
      <h3 id="titulo-resolver-mcp" className="flex items-center gap-2 text-[15px] font-semibold"><Wand2 className="size-4 text-muted-foreground" />Resolver con mi IA</h3>
      <p className="text-sm text-muted-foreground">
        Si tu IA ya tiene el MCP de VanGUARD, pega esto en ella con tu repo abierto: trae la corrección y te muestra el diff antes de aplicarla.
      </p>
      <div className="flex flex-wrap gap-3">
        <BotonCopiar valor={comandoClaudeCode('resolver_hallazgo', findingId)} texto="Resolver con Claude Code" variante="principal" />
        <BotonCopiar valor={pedidoResolver(findingId)} texto="Resolver con otra IA" />
      </div>
      <p className="text-[12.5px] text-texto-3">
        ¿Aún no la conectas? <Link to={`/o/${org}/export`} className="font-medium text-foreground underline underline-offset-4">Crea un token MCP en Llevar a tu IA</Link>.
      </p>
    </section>
  );
}
