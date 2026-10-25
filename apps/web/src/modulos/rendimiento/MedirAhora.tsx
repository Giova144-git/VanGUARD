// «Medir ahora» (F-17, S10 §10.10) en línea, sin modal (L6): la URL en un campo de texto libre (solo https) con las ya
// medidas de E24 como sugerencias (<datalist>; por defecto, la última medida), estrategia Móvil/Escritorio, etiqueta de
// versión opcional y el botón principal de 56 px. Qué se puede medir lo decide el servidor (urlMedibleOrg): cualquier web
// pública con https, sin zona de Cloudflare. Solo owner y admin: al viewer y al anónimo de «Ver demo» no se les pinta, y
// el resto de Rendimiento queda igual. Los errores salen en su sitio y lo escrito no se pierde.
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import { Input } from '@/componentes/ui/input';
import { BotonAccion } from '@/componentes/vg/BotonAccion';
import { useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { usePerfRuns } from '@/lib/consultas';
import { esApiError } from '@/lib/errores';
import { TEXTO_ROL } from '@/lib/severidad';
import { cn } from '@/lib/utils';
import { Grupo } from './Grupo';
import {
  cuerpoMedir, ejemploUrl, etiquetaPrevia, medir, medirOculto, puedeMedir, urlsConocidas, type Aviso, type ErroresCampo, type Estrategia,
} from './medir';

const ESTRATEGIAS: [Estrategia, string][] = [['mobile', 'Móvil'], ['desktop', 'Escritorio']];
const SUGERENCIAS = 'medir-urls';

// Resultado de E11 que no es un campo: «llega pronto», «Espera un minuto», «Ya hay una medición en curso · Ver la medición»…
export function AvisoMedir({ org, aviso }: { org: string; aviso: Aviso }) {
  return (
    <p role={aviso.rol === 'mal' ? 'alert' : 'status'} className={cn('text-sm font-medium', TEXTO_ROL[aviso.rol])}>
      {aviso.texto}
      {aviso.enCurso ? <> · <Link to={`/o/${org}/audit/${encodeURIComponent(aviso.enCurso)}`} className="underline underline-offset-4">Ver la medición</Link></> : null}
    </p>
  );
}

const ErrorCampo = ({ id, texto }: { id: string; texto: string | undefined }) =>
  texto ? <span id={id} role="alert" className="text-sm text-mal">{texto}</span> : null;

export function MedirAhora() {
  const org = useOrg();
  const q = usePerfRuns(org.id);
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

  // Solo owner y admin; y bandera por 404: sin E24 o con un E11 que respondió 404, no se pinta nada.
  if (!puedeMedir(org) || medirOculto(org.id) || (q.isError && esApiError(q.error) && q.error.status === 404)) return null;

  const enviar = async (ev: FormEvent) => {
    ev.preventDefault();
    if (enviando) return;
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
  // Al escribir otra URL: su error se va (era de la anterior) y la etiqueta vuelve a la de esa URL si no se tocó.
  const cambiarUrl = (u: string) => { setUrl(u); setErrores(({ url: _u, ...resto }) => resto); };
  const ayudaUrl = errores.url ? 'medir-url-ayuda medir-url-error' : 'medir-url-ayuda';

  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-5" aria-labelledby="t-medir">
      <div className="flex flex-col gap-1">
        <h3 id="t-medir" className="text-[17px] font-semibold">Medir ahora</h3>
        <p className="text-sm text-muted-foreground">Lighthouse vía PageSpeed Insights, una estrategia cada vez: suele tardar menos de un minuto.</p>
      </div>
      <form onSubmit={enviar} noValidate className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="medir-url" className="text-sm font-medium">URL (https)</label>
          {/* Texto libre: las URLs ya medidas son solo sugerencias (medibles: sin controles bidi; es lo que se manda en el POST). */}
          <Input id="medir-url" type="url" inputMode="url" dir="ltr" autoComplete="off" spellCheck={false}
            list={urls.length ? SUGERENCIAS : undefined} placeholder={ejemploUrl(org.is_demo)} value={actual}
            onChange={(e) => cambiarUrl(e.target.value)} className="font-mono text-[14px]"
            aria-invalid={errores.url ? true : undefined} aria-describedby={ayudaUrl} />
          {urls.length ? <datalist id={SUGERENCIAS}>{urls.map((u) => <option key={u} value={sinBidi(u)} />)}</datalist> : null}
          <span id="medir-url-ayuda" className="text-[12.5px] text-texto-3">Cualquier web pública con https://. No medimos IPs, localhost ni webs de VanGUARD.</span>
          <ErrorCampo id="medir-url-error" texto={errores.url} />
        </div>
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Estrategia</span>
            <Grupo etiqueta="Estrategia de la medición" valor={estrategia} opciones={ESTRATEGIAS} onCambio={setEstrategia} />
          </div>
          <label className="flex min-w-0 flex-1 basis-56 flex-col gap-1.5">
            <span className="text-sm font-medium">Etiqueta de versión (opcional)</span>
            <Input dir="ltr" spellCheck={false} maxLength={40} placeholder="v3" value={etiqueta} onChange={(e) => setVersion(e.target.value)}
              className="font-mono text-[14px]"
              aria-invalid={errores.version_label ? true : undefined} aria-describedby={errores.version_label ? 'medir-version-error' : undefined} />
            <ErrorCampo id="medir-version-error" texto={errores.version_label} />
          </label>
        </div>
        <div className="flex flex-col items-start gap-2">
          <BotonAccion type="submit" variante="marca" tam="grande" icono={Gauge} ocupado={enviando}>Medir ahora</BotonAccion>
          {aviso ? <AvisoMedir org={org.id} aviso={aviso} /> : null}
        </div>
      </form>
    </section>
  );
}
