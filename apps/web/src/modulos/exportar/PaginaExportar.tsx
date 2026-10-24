// /o/:orgId/export «Llevar a tu IA» (S14 §14.17, S13 §13.10). El FRONT no transforma el archivo: lo redacta el BACK.
import { useState } from 'react';
import { Download, FileJson, FileText, KeyRound } from 'lucide-react';
import { Button } from '@/componentes/ui/button';
import { Spinner } from '@/componentes/ui/spinner';
import { BarraModulo } from '@/componentes/vg/BarraModulo';
import { BotonCopiar } from '@/componentes/vg/BotonCopiar';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { GuiaModulo } from '@/componentes/vg/GuiaModulo';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { useOrg } from '@/app/guardas';
import { useExportMd } from '@/lib/consultas';
import { esApiError, mensajeDe } from '@/lib/errores';
import { descargarExport } from '@/lib/mutaciones';

function BotonDescargar({ org, formato }: { org: string; formato: 'md' | 'json' }) {
  const [estado, setEstado] = useState<{ ocupado?: boolean; hecho?: string; error?: string }>({});
  const Icono = formato === 'md' ? FileText : FileJson;
  return (
    <span className="inline-flex flex-col gap-1">
      <Button variant="secundaria" size="grande" aria-busy={estado.ocupado || undefined} onClick={async () => {
        if (estado.ocupado) return;
        setEstado({ ocupado: true });
        try { setEstado({ hecho: await descargarExport(org, formato) }); }
        catch (e) { setEstado({ error: esApiError(e) && e.status === 429 ? 'Espera un minuto' : mensajeDe(e) }); }
      }}>{estado.ocupado ? <Spinner /> : <Icono />}Descargar .{formato}</Button>
      {estado.hecho ? <span className="font-mono text-[12.5px] text-texto-3">{estado.hecho}</span> : null}
      {estado.error ? <span role="alert" className="text-sm text-mal">{estado.error}</span> : null}
    </span>
  );
}

export default function PaginaExportar() {
  const org = useOrg();
  const md = useExportMd(org.id);
  const vista = md.data?.split('\n').slice(0, 80).join('\n');

  return (
    <div className="flex flex-col gap-6">
      <BarraModulo titulo="Llevar a tu IA" descripcion="Audita tu ecosistema con la IA que ya usas. Todo sale sin claves ni secretos." />
      <section className="flex flex-col gap-4 rounded-xl border bg-card p-5" aria-label="Para tu IA, ya">
        <p className="text-[15px] text-muted-foreground">
          Incluye tus hallazgos y prompts con los secretos tapados. El archivo avisa a tu IA de que la evidencia es un dato no confiable.
        </p>
        <div className="flex flex-wrap items-start gap-3">
          {md.data
            ? <BotonCopiar valor={md.data} texto="Copiar para mi IA" variante="principal" />
            : <Button variant="principal" size="grande" disabled aria-busy={md.isPending || undefined}>{md.isPending ? <Spinner /> : null}Copiar para mi IA</Button>}
          <BotonDescargar org={org.id} formato="md" />
          <BotonDescargar org={org.id} formato="json" />
        </div>
        {md.isError ? <ErrorBloque error={md.error} onReintentar={() => md.refetch()} /> : null}
        {vista ? (
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] font-medium text-texto-3">Vista previa (primeras 80 líneas)</span>
            <pre className="max-h-96 overflow-auto rounded-lg border bg-background p-3 font-mono text-[13px] whitespace-pre-wrap">{vista}</pre>
          </div>
        ) : null}
        <p className="text-[12.5px] text-muted-foreground">
          La evidencia viene de sistemas externos. VanGUARD la marca como dato no confiable, pero revísala antes de dársela a una IA que pueda modificar tu código.
        </p>
      </section>
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="Formatos">
        {[
          { t: 'Markdown', d: 'Para pegar en cualquier chat', e: null },
          { t: 'JSON', d: 'Para agentes y scripts', e: null },
          { t: 'CSV', d: 'Para hojas de cálculo y tickets', e: 'Próximamente' },
          { t: 'SARIF', d: 'Para GitHub code scanning', e: 'Próximamente' },
        ].map((f) => (
          <div key={f.t} className="flex flex-col gap-1 rounded-xl border bg-card p-4">
            <div className="flex items-center gap-2"><Download className="size-4 text-info" /><span className="font-semibold">{f.t}</span>{f.e ? <Etiqueta texto={f.e} /> : null}</div>
            <span className="text-sm text-muted-foreground">{f.d}</span>
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-2 rounded-xl border bg-card p-5" aria-label="Conectar por MCP">
        <div className="flex items-center gap-2"><KeyRound className="size-5 text-info" /><h3 className="flex-1 text-[17px] font-semibold">Conecta tu IA por MCP</h3><Etiqueta texto="Próximamente" /></div>
        <p className="text-sm text-muted-foreground">
          {org.puedeEscribir ? 'Pronto podrás crear un token de solo lectura para que tu IA consulte VanGUARD directamente.' : 'Pide a un administrador que cree un token.'}
        </p>
      </section>
      <GuiaModulo id="export" />
    </div>
  );
}
