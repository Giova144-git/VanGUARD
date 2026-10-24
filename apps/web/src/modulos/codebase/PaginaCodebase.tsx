import { BotonRevisar } from '@/componentes/vg/BotonRevisar';
import { PantallaModulo } from '@/componentes/vg/PantallaModulo';
import { useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { useConexiones } from '@/lib/consultas';
import { cuando } from '@/lib/formato';
import { AnalizarZip } from './AnalizarZip';
import { TarjetaRevisionCodigo } from './TarjetaRevisionCodigo';

export default function PaginaCodebase() {
  const org = useOrg();
  const conexiones = useConexiones(org.id);
  const gh = conexiones.data?.find((c) => c.provider === 'github' && c.kind === 'read');
  const repo = typeof gh?.meta.repo_full_name === 'string' ? gh.meta.repo_full_name : null;
  const rama = typeof gh?.meta.default_branch === 'string' ? gh.meta.default_branch : null;
  // Sin GitHub, PantallaModulo corta en «Conecta GitHub…» y no pinta sus hijos: el ZIP va debajo, que no necesita conexión.
  const sinGithub = !!conexiones.data && !gh;
  return (
    <div className="flex flex-col gap-6">
      <PantallaModulo modulo="codebase" proveedor="github">
        <section className="flex flex-col gap-3" aria-label="Repositorio">
          <h3 className="text-[17px] font-semibold">Repositorio</h3>
          {repo ? (
            <p className="text-[15px]"><bdi dir="ltr" className="font-mono">{sinBidi(repo)}</bdi>
              {rama ? <span className="text-muted-foreground"> · rama <bdi dir="ltr" className="font-mono">{sinBidi(rama)}</bdi></span> : null}
              <span className="text-texto-3"> · probado {cuando(gh?.last_checked_at)}</span></p>
          ) : null}
          <BotonRevisar kind="repo" titulo="Analizar repo ahora" descripcion=".env, secretos y dependencias con CVE" />
        </section>
        {/* Revisión en cada push (§6.1): solo con GitHub; si E45 aún da 404, no se pinta. */}
        {gh ? <TarjetaRevisionCodigo key={org.id} conexion={gh} /> : null}
        {sinGithub ? null : <AnalizarZip key={org.id} />}
      </PantallaModulo>
      {/* key por org: un resultado analizado con una org abierta no se sube a otra al cambiar de org. */}
      {sinGithub ? <AnalizarZip key={org.id} titulo="O analiza un ZIP en tu navegador" /> : null}
    </div>
  );
}
