// Página de módulo genérica (S14 §14.12) sobre GET …/modules/:module/state. Orden fijo (R08 R9): barra → cifras →
// «Ahora» → secciones propias → «Revisado» → guía. Una sola para Supabase, Cloudflare y Codebase.
import type { ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Gauge, KeyRound, RotateCw, X } from 'lucide-react';
import type { EstadoModulo, Module, Provider } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { Spinner } from '@/componentes/ui/spinner';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { DetalleEnPanel } from '@/modulos/hallazgos/DetalleEnPanel';
import { chapaEstado } from '@/modulos/conexiones/TarjetaConexion';
import { useConexiones, useEstadoModulo } from '@/lib/consultas';
import { rutaDe } from '@/lib/destino';
import { cuando } from '@/lib/formato';
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
  limite_api: 'Límite de la API · reintentamos en 1 min', sin_conexion: 'No llegamos al proveedor · Reintentar',
};
const NOMBRE_PROV: Record<Exclude<Provider, 'ingest'>, string> = { supabase: 'Supabase', cloudflare: 'Cloudflare', github: 'GitHub' };

// `proveedor = null` (Rendimiento, S14 §14.13): sin conexión propia; «Sin datos» = ninguna cifra con n → «Aún no medimos tu web».
export function PantallaModulo({ modulo, proveedor, children }: { modulo: Module; proveedor: Exclude<Provider, 'ingest'> | null; children?: ReactNode }) {
  const org = useOrg();
  const navegar = useNavigate();
  const [params, setParams] = useSearchParams();
  const e = entradaNav(modulo)!;
  const q = useEstadoModulo(org.id, modulo);
  const conexiones = useConexiones(org.id);
  const c = proveedor ? conexiones.data?.find((x) => x.provider === proveedor && x.kind === 'read') : undefined;
  const filtro = params.get('filtro');
  const est = q.data;

  const barra = (
    <BarraModulo titulo={e.nombre} descripcion={e.descripcion} contador={est?.contador ?? null} extra={<>
      {c ? <Etiqueta {...chapaEstado(c)} /> : null}
      {est && !est.ok ? <Etiqueta texto={est.error ? ERROR_ESTADO[est.error] : 'No pudimos leer · Reintentar'} rol="mal" /> : null}
      <span className={`text-[12.5px] tabular-nums ${q.isError ? 'text-mal' : 'text-texto-3'}`}>{est ? cuando(est.hora) : '—'}</span>
      <Button variant={q.isError ? 'peligro' : 'secundaria'} size="chico" onClick={() => q.refetch()} aria-busy={q.isFetching || undefined}
        aria-label="Actualizar">{q.isFetching ? <Spinner /> : <RotateCw />}{q.isError ? 'Reintentar' : 'Actualizar'}</Button>
    </>} />
  );

  if (!proveedor && est && est.cifras.every((x) => x.n == null)) return (
    <div className="flex flex-col gap-6">
      {barra}
      <Vacio icono={Gauge} titulo="Aún no medimos tu web" texto={e.descripcion} />
      <GuiaModulo id={modulo as IdNav} />
    </div>
  );

  if (proveedor && conexiones.data && !c) return (
    <div className="flex flex-col gap-6">
      {barra}
      <Vacio icono={KeyRound} titulo={`Conecta ${NOMBRE_PROV[proveedor]} para ver este módulo`} texto={e.descripcion}
        accion={<BotonGrande icono={KeyRound} titulo={`Conectar ${NOMBRE_PROV[proveedor]}`} descripcion="Con un token de solo lectura"
          deshabilitado={org.puedeEscribir ? undefined : SOLO_LECTURA} onClick={() => navegar(`/o/${org.id}/connections/${proveedor}`)} />} />
      <GuiaModulo id={modulo as IdNav} />
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {barra}
      {q.isError && est ? <p role="status" className="text-sm text-mal">Sin conexión · mostramos los datos de las {cuando(est.hora)}</p> : null}
      <FilaCifras>
        {(est?.cifras ?? [null, null, null, null]).map((x, i) => x
          ? <Cifra key={`${x.tipo}-${i}`} etiqueta={x.etiqueta} n={x.n} de={x.de} unidad={x.unidad} decimales={x.decimales} sub={x.sub} rol={x.rol}
              href={x.destino ? rutaDe(org.id, x.destino) : undefined} />
          : <Cifra key={i} etiqueta="—" n={null} />)}
      </FilaCifras>
      <section id="ahora" className="flex scroll-mt-20 flex-col gap-3" aria-labelledby={`ahora-${modulo}`}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`ahora-${modulo}`} className="text-[17px] font-semibold">Ahora</h3>
          {filtro ? (
            <button type="button" onClick={() => { params.delete('filtro'); setParams(params); }}
              className="inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-[12.5px] font-medium hover:bg-muted" aria-label="Quitar filtro">
              Filtro: <span className="font-mono">{filtro}</span><X className="size-3.5" />
            </button>
          ) : null}
        </div>
        <Bandeja grupos={est?.ahora ?? null} puedeEscribir={org.puedeEscribir} filtro={filtro} hora={est?.hora} />
      </section>
      {children}
      {est?.checks.length ? (
        <section className="flex flex-col gap-3" aria-label="Revisado">
          <h3 className="text-[17px] font-semibold">Revisado</h3>
          <ChecksEnCero checks={est.checks} />
        </section>
      ) : null}
      <GuiaModulo id={modulo as IdNav} />
      <DetalleEnPanel />
    </div>
  );
}
