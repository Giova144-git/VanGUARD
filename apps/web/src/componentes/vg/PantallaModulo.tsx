// Página de módulo genérica (S14 §14.12) sobre GET …/modules/:module/state. Orden fijo (R08 R9): barra → cifras →
// «Ahora» → secciones propias → «Revisado» → guía. Una sola para Supabase, Cloudflare y Codebase.
import type { ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ChevronRight, Gauge, KeyRound, RotateCw, X } from 'lucide-react';
import type { EstadoModulo, Module, Provider } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { Spinner } from '@/componentes/ui/spinner';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { DetalleEnPanel } from '@/modulos/hallazgos/DetalleEnPanel';
import { chapaEstado, chapaGithub } from '@/modulos/conexiones/TarjetaConexion';
import { sinBidi } from '@/lib/bidi';
import { useConexiones, useEstadoModulo, useOverview } from '@/lib/consultas';
import { rutaDe } from '@/lib/destino';
import { reposGithub } from '@/lib/repos';
import { cuando } from '@/lib/formato';
import { deMapa } from '@/lib/severidad';
import { entradaNav, type IdNav } from '@/lib/nav';
import { BarraModulo } from './BarraModulo';
import { Bandeja } from './Bandeja';
import { BotonGrande } from './BotonGrande';
import { ChecksEnCero } from './ChecksEnCero';
import { Cifra, FilaCifras } from './Cifra';
import { Etiqueta } from './Etiqueta';
import { GuiaModulo } from './GuiaModulo';
import { Vacio } from './Vacio';

const ERROR_ESTADO: Record<NonNullable<EstadoModulo['error']>, string> = {
  token_invalido: 'Token inválido · Reconectar', sin_permiso: 'Falta un permiso · Ver',
  limite_api: 'Límite de la API · reintentamos en 1 min', sin_conexion: 'Sin conexión activa',
};
const NOMBRE_PROV: Record<Exclude<Provider, 'ingest'>, string> = { supabase: 'Supabase', cloudflare: 'Cloudflare', github: 'GitHub' };
// Cifras «—» mientras carga: tantas como manda el BACK, para que la rejilla no salte al llegar el dato (L7).
const HUECOS: Record<Module, number> = { supabase: 2, cloudflare: 2, codebase: 2, performance: 6 };

// `proveedor = null` (Rendimiento, S14 §14.13): sin conexión propia; «Sin datos» = ninguna cifra con n → «Aún no medimos tu web».
// `arriba`: la acción propia del módulo justo bajo la barra («Medir ahora» de Rendimiento); también con «Aún no medimos».
// `data-info`: lo que Vigía cuenta del módulo con clic derecho → «Info» sobre su título (vigia/info.ts).
export function PantallaModulo({ modulo, proveedor, arriba, children, 'data-info': info }: {
  modulo: Module; proveedor: Exclude<Provider, 'ingest'> | null; arriba?: ReactNode; children?: ReactNode; 'data-info'?: string;
}) {
  const org = useOrg();
  const navegar = useNavigate();
  const [params, setParams] = useSearchParams();
  const e = entradaNav(modulo)!;
  const q = useEstadoModulo(org.id, modulo);
  const conexiones = useConexiones(org.id);
  // GitHub admite varios repos (varias-codebases §6.2): uno por nombre, con la chapa «N repos» o la del que falla.
  const repos = proveedor === 'github' ? reposGithub(conexiones.data) : [];
  const c = proveedor === 'github' ? repos[0] : proveedor ? conexiones.data?.find((x) => x.provider === proveedor && x.kind === 'read') : undefined;
  const chapa = proveedor === 'github' ? chapaGithub(repos) : c ? chapaEstado(c) : null;
  const caida = proveedor === 'github' ? repos.some((x) => x.status !== 'active') : !!c && c.status !== 'active';
  const filtro = params.get('filtro');
  const est = q.data;
  // UX P0-1: «✓ Nada que atender» solo si el módulo se miró en la última auditoría terminada. Lo dice
  // Overview.module_checks (6782e5b); sin él, que ningún chequeo esté comprobado.
  const visto = useOverview(org.id).data?.module_checks?.[modulo];
  const sinRevisar = visto !== undefined ? visto !== 'done' : !!est && est.checks.length > 0 && !est.checks.some((x) => x.comprobado);
  // L3: la chapa roja de la conexión lleva al lado la acción que la arregla.
  const arreglo = !proveedor ? null
    : est?.error === 'token_invalido' || caida ? 'Reconectar'
    : est?.error === 'sin_permiso' ? 'Ver' : null;

  const barra = (
    <BarraModulo titulo={e.nombre} descripcion={e.descripcion} contador={est?.contador ?? null} data-info={info} extra={<>
      {chapa ? <Etiqueta {...chapa} /> : null}
      {/* sin_conexion = aún no hay conexión (estado/modulo.ts del BACK): no es un fallo; lo explica el «Conecta …» de abajo (L3). */}
      {est && !est.ok && est.error === 'sin_conexion' ? (c ? <Etiqueta texto="Sin conexión activa" rol="neutra" /> : null)
        // limite_api se reintenta solo: no pide nada al usuario, así que no va en rojo (L3).
        : est && !est.ok ? <Etiqueta texto={deMapa(ERROR_ESTADO, est.error, 'No pudimos leer')} rol={est.error === 'limite_api' ? 'neutra' : 'mal'} /> : null}
      {arreglo ? (
        <Link to={`/o/${org.id}/connections/${proveedor}`}
          className="inline-flex h-11 items-center gap-1 rounded-full border border-mal-borde bg-mal-relleno px-4 font-mono text-[13px] uppercase tracking-[0.06em] font-medium text-mal outline-none hover:bg-mal/15 focus-visible:ring-2 focus-visible:ring-ring">
          {arreglo}<ChevronRight className="size-4" /></Link>
      ) : null}
      <span className={`text-[12.5px] tabular-nums ${q.isError ? 'text-mal' : 'text-texto-3'}`}>{est ? cuando(est.hora) : '—'}</span>
      <Button variant={q.isError ? 'peligro' : 'secundaria'} size="fila" onClick={() => q.refetch()} aria-busy={q.isFetching || undefined}>
        {q.isFetching ? <Spinner /> : <RotateCw />}{q.isError ? 'Reintentar' : 'Actualizar'}</Button>
    </>} />
  );

  if (!proveedor && est && est.cifras.every((x) => x.n == null)) return (
    <div className="flex flex-col gap-6">
      {barra}
      {arriba}
      <Vacio icono={Gauge} titulo="Aún no medimos tu web" texto={e.descripcion} />
      <GuiaModulo id={modulo as IdNav} soloLectura={!org.puedeEscribir} />
    </div>
  );

  if (proveedor && conexiones.data && !c) return (
    <div className="flex flex-col gap-6">
      {barra}
      <Vacio icono={KeyRound} titulo={`Conecta ${NOMBRE_PROV[proveedor]} para ver este módulo`} texto={e.descripcion}
        accion={<BotonGrande icono={KeyRound} titulo={`Conectar ${NOMBRE_PROV[proveedor]}`} descripcion="Con un token de solo lectura"
          deshabilitado={org.puedeEscribir ? undefined : SOLO_LECTURA} onClick={() => navegar(`/o/${org.id}/connections/${proveedor}`)} />} />
      <GuiaModulo id={modulo as IdNav} soloLectura={!org.puedeEscribir} />
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {barra}
      {arriba}
      {q.isError && est ? <p role="status" className="text-sm text-mal">Sin conexión · mostramos los datos de las {cuando(est.hora)}</p> : null}
      <FilaCifras>
        {(est?.cifras ?? Array<null>(HUECOS[modulo]).fill(null)).map((x, i) => x
          ? <Cifra key={`${x.tipo}-${i}`} etiqueta={x.etiqueta} n={x.n} de={x.de} unidad={x.unidad} decimales={x.decimales} sub={x.sub} rol={x.rol}
              href={x.destino ? rutaDe(org.id, x.destino) : undefined} />
          : <Cifra key={i} etiqueta="—" n={null} />)}
      </FilaCifras>
      <section id="ahora" className="flex scroll-mt-20 flex-col gap-3" aria-labelledby={`ahora-${modulo}`} data-info="ahora">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`ahora-${modulo}`} className="text-[17px] font-semibold">Ahora</h3>
          {filtro ? (
            // Se ve como chapa, pero la zona de toque mide 44 px (L8) sin agrandar la fila.
            // ?filtro= lo puede armar un enlace ajeno: sus controles bidi se ven (lib/bidi.ts), también en el aria-label.
            <button type="button" onClick={() => { params.delete('filtro'); setParams(params); }}
              className="group -my-2 inline-flex h-11 items-center outline-none" aria-label={`Quitar filtro: ${sinBidi(filtro)}`}>
              <span className="inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-[12.5px] font-medium group-hover:bg-muted group-focus-visible:ring-2 group-focus-visible:ring-ring">
                Filtro: <span className="font-mono"><bdi dir="ltr">{sinBidi(filtro)}</bdi></span><X className="size-3.5" />
              </span>
            </button>
          ) : null}
        </div>
        <Bandeja grupos={est?.ahora ?? null} puedeEscribir={org.puedeEscribir} filtro={filtro}
          sinRevisar={sinRevisar} enlaceRevisar={`/o/${org.id}/audit`} />
      </section>
      {children}
      {est?.checks.length ? (
        <section className="flex flex-col gap-3" aria-label="Revisado">
          <h3 className="text-[17px] font-semibold" data-info="revisado">Revisado</h3>
          <ChecksEnCero checks={est.checks} />
        </section>
      ) : null}
      <GuiaModulo id={modulo as IdNav} soloLectura={!org.puedeEscribir} />
      <DetalleEnPanel />
    </div>
  );
}
