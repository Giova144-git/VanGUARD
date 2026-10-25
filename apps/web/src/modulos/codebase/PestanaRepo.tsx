// Lo de UN repo en Codebase (varias-codebases §6.2): «Repositorio», «Analizar este repo» y su revisión en cada push.
// Recibe SU conexión: con un repo se pinta tal cual (como antes de varias codebases) y con varios va dentro de su pestaña.
// El bloqueo de merge y la evolución por push montan lo suyo dentro de TarjetaRevisionCodigo, que ya va por conexión.
import type { ConnectionPublic } from '@vanguard/contracts';
import { BotonRevisar } from '@/componentes/vg/BotonRevisar';
import { useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { cuando } from '@/lib/formato';
import { nombreRepo } from '@/lib/repos';
import { TarjetaRevisionCodigo } from './TarjetaRevisionCodigo';

export function PestanaRepo({ conexion, varios }: { conexion: ConnectionPublic; varios: boolean }) {
  const org = useOrg();
  const repo = nombreRepo(conexion) || null;
  const rama = typeof conexion.meta.default_branch === 'string' ? conexion.meta.default_branch : null;
  return (
    <>
      <section className="flex flex-col gap-3" aria-label="Repositorio">
        <h3 className="text-[17px] font-semibold">Repositorio</h3>
        {repo ? (
          <p className="text-[15px]"><bdi dir="ltr" className="font-mono break-all">{sinBidi(repo)}</bdi>
            {rama ? <span className="text-muted-foreground"> · rama <bdi dir="ltr" className="font-mono">{sinBidi(rama)}</bdi></span> : null}
            <span className="text-texto-3"> · probado {cuando(conexion.last_checked_at)}</span></p>
        ) : null}
        {/* Con un repo, el botón de siempre (E11 elige el principal); con varios, el de ESTE repo. */}
        <BotonRevisar kind="repo" titulo={varios ? 'Analizar este repo' : 'Analizar repo ahora'} descripcion=".env, secretos y dependencias con CVE"
          connectionId={varios ? conexion.id : undefined} />
      </section>
      {/* Revisión en cada push (§6.1): si E45 aún da 404, no se pinta. key por org y conexión: nada salta de un repo a otro. */}
      <TarjetaRevisionCodigo key={`${org.id}:${conexion.id}`} conexion={conexion} varios={varios} />
    </>
  );
}
