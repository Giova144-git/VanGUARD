// /o/:orgId/connections (S14 §14.10): guía de 4 pasos, tres tarjetas grandes y la tarjeta de ingesta.
import { Cloud, Database, GitBranch } from 'lucide-react';
import { BarraModulo } from '@/componentes/vg/BarraModulo';
import { GuiaModulo } from '@/componentes/vg/GuiaModulo';
import { GuiaPasos } from '@/componentes/vg/GuiaPasos';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { useOrg } from '@/app/guardas';
import { useConexiones, useOverview } from '@/lib/consultas';
import { TarjetaConexion, TarjetaIngesta } from './TarjetaConexion';

export default function PaginaConexiones() {
  const org = useOrg();
  const q = useConexiones(org.id);
  const overview = useOverview(org.id);
  const lista = q.data ?? [];
  const activa = (p: string) => lista.some((c) => c.provider === p && c.kind === 'read' && c.status === 'active');

  return (
    <div className="flex flex-col gap-6">
      <BarraModulo titulo="Conexiones" descripcion="Solo lectura: con estos tokens podemos mirar, nunca escribir. La única excepción es el token opcional de Modo blindaje, que solo bloquea una IP cuando tú lo confirmas." />
      <GuiaPasos pasos={[
        { texto: 'Conecta Supabase', hecho: activa('supabase') },
        { texto: 'Conecta Cloudflare', hecho: activa('cloudflare') },
        { texto: 'Conecta tu repo', hecho: activa('github') },
        { texto: 'Audita todo', hecho: !!overview.data?.last_scan },
      ]} />
      {q.isError ? <ErrorBloque error={q.error} onReintentar={() => q.refetch()} /> : null}
      {q.isPending ? <div className="text-texto-3" aria-busy="true">—</div> : <>
        <div className="grid gap-4 lg:grid-cols-3">
          <TarjetaConexion proveedor="supabase" conexiones={lista} icono={Database} descripcion="Tu base: RLS, políticas, funciones y salud." />
          <TarjetaConexion proveedor="cloudflare" conexiones={lista} icono={Cloud} descripcion="Tu zona o tu sitio de Pages/Workers: tráfico, ataques y bloqueo de IPs." />
          <TarjetaConexion proveedor="github" conexiones={lista} icono={GitBranch} descripcion="Tu repo: secretos, .env y dependencias con CVE." />
        </div>
        <TarjetaIngesta conexiones={lista} />
      </>}
      <GuiaModulo id="connections" />
    </div>
  );
}
