// «Analizar un ZIP» (F-18, S14 §14.12 y S09 §09.12 D). El ZIP se abre en un Web Worker de esta pestaña y a la API solo
// sube el ZipResult: dependencias y hallazgos ya tapados. El resultado vive en el estado de este componente y se pierde al
// salir de la pantalla: nada en storage, URL, history.state ni caché de Query (L10).
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router';
import { Braces, Check, Circle, FileArchive, FolderOpen, Info, Lock, TriangleAlert, Upload } from 'lucide-react';
import type { ZipResult } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { Spinner } from '@/componentes/ui/spinner';
import { BotonAccion } from '@/componentes/vg/BotonAccion';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { SectorPlegable } from '@/componentes/vg/SectorPlegable';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { esApiError, mensajeDe } from '@/lib/errores';
import { textoErrorZip } from '@/lib/errores-escaneo';
import { SEP, bytes, miles } from '@/lib/formato';
import { subirZip } from '@/lib/mutaciones';
import { porQueImporta } from '@/lib/reglas-texto';
import { severidad } from '@/lib/severidad';
import { cn } from '@/lib/utils';
import { ErrorZip, analizarZipLocal, nombreSeguro, validarZip } from './zip-local';
import type { Analisis, CodigoZip, FaseZip } from './zip/tipos';

const TEXTO_FIJO = 'Tu código nunca sale de tu navegador: abrimos el ZIP aquí, en tu equipo, y solo nos llega la lista de '
  + 'dependencias y los secretos encontrados, ya tapados.';
const PASOS: { fase: FaseZip; texto: string }[] = [
  { fase: 'leyendo', texto: 'Abriendo el ZIP en tu navegador' },
  { fase: 'analizando', texto: 'Buscando secretos y .env' },
];
// S14 §14.12 #6: si se pasa de un tope, la salida es comprimir menos.
const POR_TAMANO = new Set<CodigoZip>(['ZIP_TOO_BIG', 'ZIP_TOO_MANY_ENTRIES', 'ZIP_TOO_BIG_UNCOMPRESSED', 'ZIP_REJECTED']);
// Mismos controles que lib/bidi. En el JSON van como escape \uXXXX: es el mismo JSON y no reordena lo que se ve.
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Alto fijo para reposo, progreso y error: cambiar de uno a otro no mueve la página (L7). 272 px cubren el más alto
// (el reposo de solo lectura, con la línea de SOLO_LECTURA).
const CAJA = 'flex h-68 flex-col items-center justify-center gap-3 rounded-xl border px-6 py-8 text-center';
const LIMITE_CUERPO = 1_048_576;   // bodyLimit de /api (§06.9, E23)

type Archivo = { filename: string; size_bytes: number };
type Estado =
  | { fase: 'reposo' }
  | { fase: 'trabajando'; paso: FaseZip }
  | { fase: 'error'; codigo: CodigoZip }
  | { fase: 'vista'; archivo: Archivo; analisis: Analisis };

const plural = (n: number, uno: string, varios: string) => `${miles(n)} ${n === 1 ? uno : varios}`;

function textoEnvio(e: unknown): string {
  if (esApiError(e) && e.status === 413) return 'Hay demasiados resultados para enviarlos';
  if (esApiError(e) && e.status === 429) return e.message || mensajeDe(e);    // el cupo de ZIP del día lo explica el servidor
  return mensajeDe(e);
}

export function AnalizarZip({ titulo = 'Analizar un ZIP' }: { titulo?: string }) {
  const org = useOrg();
  const navegar = useNavigate();
  const entrada = useRef<HTMLInputElement>(null);
  const turno = useRef(0);                                   // descarta lo que llegue de un análisis ya sustituido
  const control = useRef<AbortController | null>(null);
  const enviando = useRef(false);
  const [estado, setEstado] = useState<Estado>({ fase: 'reposo' });
  const [envio, setEnvio] = useState<{ ocupado: boolean; error: string | null }>({ ocupado: false, error: null });
  const [verJson, setVerJson] = useState(false);
  const [encima, setEncima] = useState(false);
  const ocupado = estado.fase === 'trabajando' || envio.ocupado;

  // Al salir de la pantalla el worker se termina: los valores en claro no se quedan en memoria.
  useEffect(() => () => { turno.current++; control.current?.abort(); }, []);

  async function empezar(archivo: File) {
    const t = ++turno.current;
    control.current?.abort();
    const c = new AbortController();
    control.current = c;
    setEnvio({ ocupado: false, error: null });
    setVerJson(false);
    setEstado({ fase: 'trabajando', paso: 'leyendo' });
    const codigo = await validarZip(archivo);
    if (t !== turno.current) return;
    if (codigo) return setEstado({ fase: 'error', codigo });
    try {
      const analisis = await analizarZipLocal(archivo, (paso) => { if (t === turno.current) setEstado({ fase: 'trabajando', paso }); }, { senal: c.signal });
      if (t !== turno.current) return;
      setEstado({ fase: 'vista', archivo: { filename: nombreSeguro(archivo.name), size_bytes: archivo.size }, analisis });
    } catch (e) {
      if (t === turno.current) setEstado({ fase: 'error', codigo: e instanceof ErrorZip ? e.codigo : 'ZIP_REJECTED' });
    }
  }

  async function subir(archivo: Archivo, resultado: ZipResult) {
    if (enviando.current) return;                            // un doble clic no crea dos scans
    // Antes de E11: un cuerpo de más de 1 MB daría 413 en E23 y dejaría un scan esperando un resultado que no llega.
    if (new TextEncoder().encode(JSON.stringify(resultado)).length > LIMITE_CUERPO) {
      setEnvio({ ocupado: false, error: 'Hay demasiados resultados para enviarlos' });
      return;
    }
    const t = turno.current;
    enviando.current = true;
    setEnvio({ ocupado: true, error: null });
    try {
      const id = await subirZip(org.id, archivo, resultado);
      if (t === turno.current) navegar(`/o/${org.id}/audit/${encodeURIComponent(id)}`);   // no si ya se salió de aquí
    } catch (e) {
      if (t === turno.current) setEnvio({ ocupado: false, error: textoEnvio(e) });
    } finally {
      enviando.current = false;
    }
  }

  const elegir = () => entrada.current?.click();
  // preventDefault también mientras trabaja: si no, soltar un archivo aquí haría que el navegador lo abriera o descargara.
  const arrastre = org.puedeEscribir ? {
    onDragOver: (e: DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = ocupado ? 'none' : 'copy'; setEncima(!ocupado); },
    onDragLeave: (e: DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEncima(false); },
    onDrop: (e: DragEvent) => { e.preventDefault(); setEncima(false); const f = e.dataTransfer.files[0]; if (f && !ocupado) void empezar(f); },
  } : {};

  return (
    <section className="flex flex-col gap-3" aria-labelledby="zip-titulo">
      <h3 id="zip-titulo" className="text-[17px] font-semibold">{titulo}</h3>
      <p className="flex gap-2 text-[15px] text-muted-foreground"><Lock className="mt-0.5 size-4 shrink-0" />{TEXTO_FIJO}</p>
      {org.puedeEscribir ? (
        <input ref={entrada} type="file" accept=".zip,application/zip" className="sr-only" tabIndex={-1} aria-label="Archivo ZIP de tu proyecto"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void empezar(f); }} />
      ) : null}
      <div {...arrastre} className={cn('rounded-xl', encima && 'ring-2 ring-info')}>
        {estado.fase === 'reposo' ? (
          <div className={cn(CAJA, 'border-dashed bg-card', encima && 'border-info bg-info-relleno')}>
            <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground"><FileArchive className="size-6" /></span>
            <p className="text-[15px]">{org.puedeEscribir ? 'Arrastra aquí el ZIP de tu proyecto o elígelo' : 'Analiza el ZIP de tu proyecto sin subirlo'}</p>
            <BotonAccion variante="principal" tam="grande" icono={FolderOpen} onClick={elegir}
              disabled={!org.puedeEscribir} ayuda={SOLO_LECTURA}>Analizar un ZIP</BotonAccion>
            <p className="text-[12.5px] text-texto-3">Un .zip de hasta 25 MB</p>
          </div>
        ) : estado.fase === 'trabajando' ? (
          <div className={cn(CAJA, 'bg-card')} role="status" aria-live="polite">
            <ol className="flex flex-col gap-2 text-left">
              {PASOS.map((p, i) => {
                const actual = PASOS.findIndex((x) => x.fase === estado.paso);
                return (
                  <li key={p.fase} className={cn('flex items-center gap-2 text-[15px]', i === actual ? 'font-medium' : 'text-muted-foreground')}>
                    {i < actual ? <Check className="size-4" aria-label="Hecho" /> : i === actual ? <Spinner className="size-4" aria-hidden />
                      : <Circle className="size-4 text-texto-3" aria-hidden />}
                    {p.texto}
                  </li>
                );
              })}
            </ol>
          </div>
        ) : estado.fase === 'error' ? (
          // Mismo tinte que ErrorBloque; va en rojo porque lleva su acción al lado (L3).
          <div role="alert" className={cn(CAJA, 'border-mal-borde bg-mal-relleno text-mal')}>
            <TriangleAlert className="size-6" />
            <p className="text-[15px] font-medium">{textoErrorZip(estado.codigo)}</p>
            {POR_TAMANO.has(estado.codigo) ? <p className="text-sm">Comprime solo tu código, sin node_modules.</p> : null}
            <Button variant="peligro" size="fila" onClick={elegir}><FolderOpen />Elegir otro archivo</Button>
          </div>
        ) : (
          <VistaPrevia archivo={estado.archivo} analisis={estado.analisis} verJson={verJson} alVerJson={() => setVerJson((v) => !v)}
            envio={envio} alSubir={() => void subir(estado.archivo, estado.analisis.resultado)} alElegir={elegir} />
        )}
      </div>
    </section>
  );
}

export function VistaPrevia({ archivo, analisis, verJson, alVerJson, envio, alSubir, alElegir }: {
  archivo: Archivo; analisis: Analisis; verJson: boolean; alVerJson: () => void;
  envio: { ocupado: boolean; error: string | null }; alSubir: () => void; alElegir: () => void;
}) {
  const { resultado: r, resumen: s, avisos } = analisis;
  const json = JSON.stringify(r, null, 2).replace(BIDI, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-col gap-1">
        <p className="text-[15px] font-semibold">
          Esto es lo que enviaremos: {plural(s.deps, 'dependencia', 'dependencias')} de {plural(s.lockfiles, 'lockfile', 'lockfiles')}
          {SEP}{plural(s.secretos, 'secreto, tapado', 'secretos, tapados')}{SEP}{plural(s.env, '.env subido', '.env subidos')}
        </p>
        <p className="text-sm text-muted-foreground">
          <bdi dir="ltr" className="font-mono">{sinBidi(archivo.filename)}</bdi>{SEP}{bytes(archivo.size_bytes)}{SEP}{plural(r.files_seen, 'entrada', 'entradas')}
        </p>
      </div>

      {r.findings.length ? (
        <ul className="flex flex-col divide-y rounded-xl border" aria-label="Hallazgos que enviaremos">
          {r.findings.map((f, i) => {
            const ubicacion = f.evidence.line ? `${f.evidence.path}:${f.evidence.line}` : f.evidence.path;
            const porQue = porQueImporta(f.rule_id);
            return (
              <li key={`${f.rule_id}-${f.resource}-${i}`} className="flex flex-col gap-1 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Neutra: aquí aún no hay nada que arreglar (L3); la severidad que vale la recalcula el servidor. */}
                  <Etiqueta texto={severidad(f.severity).etiqueta} />
                  <span className="text-[15px] font-medium">{sinBidi(f.title)}</span>
                </div>
                {porQue ? <p className="text-sm text-muted-foreground">{porQue}</p> : null}
                <p className="font-mono text-[13px] break-all">
                  <bdi dir="ltr">{sinBidi(ubicacion)}</bdi>
                  {f.evidence.preview ? <>{SEP}<bdi dir="ltr">{sinBidi(f.evidence.preview)}</bdi></> : null}
                </p>
              </li>
            );
          })}
        </ul>
      ) : <p className="text-[15px] text-muted-foreground">No encontramos secretos ni archivos .env subidos.</p>}

      {r.deps.length ? (
        <SectorPlegable titulo={`Dependencias (${miles(r.deps.length)})`}>
          <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {r.deps.map((d) => (
              <li key={`${d.ecosystem}:${d.name}@${d.version}`} className="font-mono text-[13px] break-all">
                <bdi dir="ltr">{sinBidi(`${d.name}@${d.version}`)}</bdi>
                <span className="text-texto-3">{SEP}{d.ecosystem}{d.dev ? `${SEP}dev` : ''}</span>
              </li>
            ))}
          </ul>
        </SectorPlegable>
      ) : null}

      {avisos.length ? (
        <ul className="flex flex-col gap-2" aria-label="Avisos que no se envían">
          {avisos.map((a) => (
            <li key={a.codigo} className="flex gap-2 text-sm text-muted-foreground"><Info className="mt-0.5 size-4 shrink-0" />{a.texto}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col gap-2">
        <Button variant="secundaria" size="fila" className="self-start" onClick={alVerJson} aria-expanded={verJson} aria-controls="zip-json">
          <Braces />{verJson ? 'Ocultar lo que se envía' : 'Ver lo que se envía'}</Button>
        {verJson ? (
          <pre id="zip-json" dir="ltr" className="max-h-96 overflow-auto rounded-lg border bg-muted p-3 font-mono text-[12.5px] whitespace-pre">{json}</pre>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start gap-3">
          <BotonAccion variante="marca" tam="grande" icono={Upload} ocupado={envio.ocupado} onClick={alSubir}>Subir resultado</BotonAccion>
          <BotonAccion variante="secundaria" tam="grande" icono={FolderOpen} disabled={envio.ocupado} onClick={alElegir}>Elegir otro archivo</BotonAccion>
        </div>
        {/* Línea reservada: el error del envío aparece sin empujar nada (L7). */}
        <p role="alert" className="min-h-5 text-sm text-mal">{envio.error ?? ''}</p>
      </div>
    </div>
  );
}
