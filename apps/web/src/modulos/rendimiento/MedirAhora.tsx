// «Medir ahora» (F-17, S10 §10.10) en línea, sin modal (L6): URL (por defecto la de la última medición de E24; las ya
// medidas, a un toque), estrategia Móvil/Escritorio, etiqueta de versión opcional y el botón principal de 56 px. Solo
// owner y admin; el viewer y el anónimo lo ven deshabilitado. Los errores salen en su sitio y lo escrito no se pierde.
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Cloud, Gauge } from 'lucide-react';
import { Button } from '@/componentes/ui/button';
import { Input } from '@/componentes/ui/input';
import { BotonAccion } from '@/componentes/vg/BotonAccion';
import { useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { useConexiones, usePerfRuns } from '@/lib/consultas';
import { esApiError } from '@/lib/errores';
import { TEXTO_ROL } from '@/lib/severidad';
import { cn } from '@/lib/utils';
import { Grupo } from './Grupo';
import { cuerpoMedir, etiquetaPrevia, medir, medirOculto, urlsConocidas, type Aviso, type ErroresCampo, type Estrategia } from './medir';

const ESTRATEGIAS: [Estrategia, string][] = [['mobile', 'Móvil'], ['desktop', 'Escritorio']];

// Resultado de E11 que no es un campo: «llega pronto», «Espera un minuto», «Ya hay una medición en curso · Verla»…
export function AvisoMedir({ org, aviso }: { org: string; aviso: Aviso }) {
  return (
    <p role={aviso.rol === 'mal' ? 'alert' : 'status'} className={cn('text-sm font-medium', TEXTO_ROL[aviso.rol])}>
      {aviso.texto}
      {aviso.enCurso ? <> · <Link to={`/o/${org}/audit/${encodeURIComponent(aviso.enCurso)}`} className="underline underline-offset-4">Verla</Link></> : null}
    </p>
  );
}

const ErrorCampo = ({ id, texto }: { id: string; texto: string | undefined }) =>
  texto ? <span id={id} role="alert" className="text-sm text-mal">{texto}</span> : null;

export function MedirAhora() {
  const org = useOrg();
  const q = usePerfRuns(org.id);
  const conexiones = useConexiones(org.id);
  const qc = useQueryClient();
  const navegar = useNavigate();
  const urls = useMemo(() => urlsConocidas(q.data), [q.data]);
  const [url, setUrl] = useState<string | null>(null);           // null: sin tocar → la de la última medición
  const [version, setVersion] = useState<string | null>(null);   // null: sin tocar → la última etiqueta de esa URL
  const [estrategia, setEstrategia] = useState<Estrategia>('mobile');
  const [enviando, setEnviando] = useState(false);
  const [errores, setErrores] = useState<ErroresCampo>({});
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const actual = url ?? urls[0] ?? '';
  const etiqueta = version ?? etiquetaPrevia(q.data, actual);

  // Bandera por 404: sin E24 o con un E11 que respondió 404, no se pinta nada.
  if (medirOculto(org.id) || (q.isError && esApiError(q.error) && q.error.status === 404)) return null;
  const admin = org.puedeEscribir && (org.role === 'owner' || org.role === 'admin');
  const ayuda = org.is_demo || org.me.user.is_anonymous ? 'Solo un admin puede medir. Estás viendo la demo.' : 'Solo un admin puede medir.';
  // Sin zona de Cloudflare activa (read o action) el servidor no sabe que el dominio es tuyo (assertMeasurableUrl, S10
  // §10.9). El botón sigue: quien decide es el servidor (también cuentan los dominios verificados).
  const sinZonas = Array.isArray(conexiones.data) && !conexiones.data.some((c) => c.provider === 'cloudflare' && c.status === 'active');

  const enviar = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!admin || enviando) return;
    const c = cuerpoMedir(actual, estrategia, etiqueta);
    setAviso(null);
    if ('errores' in c) { setErrores(c.errores); return; }
    setErrores({});
    setEnviando(true);
    const r = await medir(org.id, c.body, qc, navegar);
    if (r.tipo === 'creada') return;                              // ya navegó a la auditoría
    setEnviando(false);                                           // con 'oculto', este render ya devuelve null
    if (r.tipo === 'campo') setErrores(r.errores);
    else if (r.tipo === 'aviso') setAviso(r.aviso);
  };
  const elegirUrl = (u: string) => { setUrl(u); setVersion(null); setErrores({}); setAviso(null); };

  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-5" aria-labelledby="t-medir">
      <div className="flex flex-col gap-1">
        <h3 id="t-medir" className="text-[17px] font-semibold">Medir ahora</h3>
        <p className="text-sm text-muted-foreground">Lighthouse vía PageSpeed Insights: 3 repeticiones, ~1 min. Solo dominios de tus zonas de Cloudflare.</p>
      </div>
      {sinZonas ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3">
          <p className="min-w-0 flex-1 basis-64 text-[15px]">Para medir necesitamos saber que el dominio es tuyo: conecta tu zona de Cloudflare.</p>
          {admin ? <Button asChild variant="secundaria" size="fila"><Link to={`/o/${org.id}/connections/cloudflare`}><Cloud />Conectar Cloudflare</Link></Button> : null}
        </div>
      ) : null}
      <form onSubmit={enviar} noValidate className="flex flex-col gap-4">
        {urls.length > 1 ? <Grupo etiqueta="URL ya medidas" valor={actual} desactivado={!admin}
          opciones={urls.map((u) => [u, sinBidi(u.replace(/^https:\/\//, ''))])} onCambio={elegirUrl} /> : null}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">URL (https)</span>
          {/* La URL ya medida va tal cual (medible: sin controles bidi): es lo que se manda en el POST. */}
          <Input type="url" inputMode="url" dir="ltr" autoComplete="url" spellCheck={false} placeholder="https://tu-dominio.com/"
            value={actual} onChange={(e) => setUrl(e.target.value)} disabled={!admin} className="font-mono text-[14px]"
            aria-invalid={errores.url ? true : undefined} aria-describedby={errores.url ? 'medir-url-error' : undefined} />
          <ErrorCampo id="medir-url-error" texto={errores.url} />
        </label>
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Estrategia</span>
            <Grupo etiqueta="Estrategia de la medición" valor={estrategia} opciones={ESTRATEGIAS} onCambio={setEstrategia} desactivado={!admin} />
          </div>
          <label className="flex min-w-0 flex-1 basis-56 flex-col gap-1.5">
            <span className="text-sm font-medium">Etiqueta de versión (opcional)</span>
            <Input dir="ltr" spellCheck={false} maxLength={40} placeholder="v3" value={etiqueta} onChange={(e) => setVersion(e.target.value)}
              disabled={!admin} className="font-mono text-[14px]"
              aria-invalid={errores.version_label ? true : undefined} aria-describedby={errores.version_label ? 'medir-version-error' : undefined} />
            <ErrorCampo id="medir-version-error" texto={errores.version_label} />
          </label>
        </div>
        <div className="flex flex-col items-start gap-2">
          <BotonAccion type="submit" variante="marca" tam="grande" icono={Gauge} ocupado={enviando} disabled={!admin} ayuda={ayuda}>Medir ahora</BotonAccion>
          {aviso ? <AvisoMedir org={org.id} aviso={aviso} /> : null}
        </div>
      </form>
    </section>
  );
}
