// /o/:orgId/codebase. Con un repo, como siempre; con varios (varias-codebases §6.2), una pestaña por repo con su análisis
// y su revisión en cada push. El ZIP no cambia: va debajo, fuera de las pestañas.
import { useSearchParams } from 'react-router';
import type { CodeReviewState, ConnectionPublic } from '@vanguard/contracts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/componentes/ui/tabs';
import { BotonRevisar } from '@/componentes/vg/BotonRevisar';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { PantallaModulo } from '@/componentes/vg/PantallaModulo';
import { useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { useConexiones, useRevisionesRepos } from '@/lib/consultas';
import { nombreRepo, reposGithub } from '@/lib/repos';
import type { Chip } from '@/lib/revision';
import { AnalizarZip } from './AnalizarZip';
import { PestanaRepo } from './PestanaRepo';

// «Analizar todos los repos» solo cuando el recorrido de repos del BACK (B3) esté en producción: lo avisa el ORQUESTADOR.
// Antes, la auditoría completa mira el repo principal y el FRONT no promete otra cosa (regla «solo lo que funciona»).
export const ANALIZAR_TODOS = false;

// Chapa de la revisión en cada push de un repo (§6.2): Activa, Apagada, Error o «—» (sin E45, cargando o de otro repo
// porque el BACK aún no tiene B6). Error en ámbar: el arreglo está dentro de la pestaña, no al lado (L3).
export function chipPestana(s: CodeReviewState | undefined, connectionId: string): Chip {
  if (!s || (s.config && s.config.connection_id !== connectionId)) return { texto: '—', rol: 'neutra' };
  if (s.reason === 'conexion_inactiva' || s.config?.state === 'error') return { texto: 'Error', rol: 'aviso' };
  return s.config?.enabled ? { texto: 'Activa', rol: 'bien' } : { texto: 'Apagada', rol: 'neutra' };
}

export function PestanasRepos({ repos }: { repos: ConnectionPublic[] }) {
  const org = useOrg();
  const [params, setParams] = useSearchParams();
  const estados = useRevisionesRepos(org.id, repos.map((c) => c.id));
  // ?repo=<connection_id>; sin él, el enlace del WhatsApp (?revision=<id>) elige la pestaña cuya lista lo trae.
  const revision = params.get('revision');
  const porRevision = revision ? repos.find((_c, i) => estados[i]?.data?.recent.some((r) => r.id === revision)) : undefined;
  const elegida = repos.find((c) => c.id === params.get('repo')) ?? porRevision ?? repos[0]!;
  const cambiar = (id: string) => { const p = new URLSearchParams(params); p.set('repo', id); setParams(p, { replace: true }); };
  return (
    <Tabs value={elegida.id} onValueChange={cambiar} className="gap-6">
      <div className="flex flex-col gap-2">
        {/* El nombre del repo no se recorta: parte en dos líneas. Las pestañas saltan de línea a 375 px. max-w-full: con
            flex-none la pestaña mediría lo que su texto en una línea y un nombre largo se saldría por la derecha. */}
        <TabsList aria-label="Repos de GitHub" className="h-auto w-full flex-wrap justify-start gap-1">
          {repos.map((c, i) => (
            <TabsTrigger key={c.id} value={c.id} className="h-auto min-h-11 max-w-full flex-none flex-wrap gap-x-2 gap-y-1 py-2 text-left whitespace-normal">
              <bdi dir="ltr" className="font-mono break-all">{sinBidi(nombreRepo(c) || c.label)}</bdi>
              <Etiqueta {...chipPestana(estados[i]?.data, c.id)} />
            </TabsTrigger>
          ))}
        </TabsList>
        {ANALIZAR_TODOS
          ? <BotonRevisar kind="repo" titulo={`Analizar todos los repos (${repos.length})`} descripcion="Uno detrás de otro, con su propio token" />
          : <p className="text-sm text-muted-foreground">La auditoría completa revisa el repo principal. Los demás, con su botón.</p>}
      </div>
      {/* Radix monta solo la pestaña elegida: solo su tarjeta sondea E45. */}
      {repos.map((c) => (
        <TabsContent key={c.id} value={c.id} className="flex flex-col gap-6"><PestanaRepo conexion={c} varios /></TabsContent>
      ))}
    </Tabs>
  );
}

export default function PaginaCodebase() {
  const org = useOrg();
  const conexiones = useConexiones(org.id);
  // Un repo por nombre (las parejas viejas de «Reconectar» salen una vez, con la activa).
  const repos = reposGithub(conexiones.data);
  // Sin GitHub, PantallaModulo corta en «Conecta GitHub…» y no pinta sus hijos: el ZIP va debajo, que no necesita conexión.
  const sinGithub = !!conexiones.data && !repos.length;
  return (
    <div className="flex flex-col gap-6">
      <PantallaModulo modulo="codebase" proveedor="github" data-info="modulo-codebase">
        {repos.length >= 2 ? <PestanasRepos repos={repos} /> : repos[0] ? <PestanaRepo conexion={repos[0]} varios={false} /> : null}
        {sinGithub ? null : <AnalizarZip key={org.id} />}
      </PantallaModulo>
      {/* key por org: un resultado analizado con una org abierta no se sube a otra al cambiar de org. */}
      {sinGithub ? <AnalizarZip key={org.id} titulo="O analiza un ZIP en tu navegador" /> : null}
    </div>
  );
}
