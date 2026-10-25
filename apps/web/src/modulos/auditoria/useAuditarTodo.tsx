// «Auditar todo» (full_audit) en un solo sitio: Resumen, Auditoría (lanzar y reintentar) y Evolución. Sin ninguna fuente
// que revisar no llama a la API: deja el aviso con enlaces a Conexiones y a Codebase (el ZIP) y Vigía lo dice señalando
// Conexiones. El criterio es el del servidor (rutas/scans.ts): una conexión de lectura activa de Supabase, Cloudflare o
// GitHub. El ZIP (kind 'zip', AnalizarZip) y la medición (kind 'lighthouse') no pasan por aquí ni necesitan conexión.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ConnectionPublic, ScanAccepted, ScanCreate } from '@vanguard/contracts';
import { useOrg } from '@/app/guardas';
import { useGuia, type Dicho } from '@/componentes/vigia/contexto';
import { useConexiones } from '@/lib/consultas';
import { esApiError, mensajeDe } from '@/lib/errores';
import { useLanzarScan } from '@/lib/mutaciones';

export const PROVEEDORES_AUDITABLES: readonly ConnectionPublic['provider'][] = ['supabase', 'cloudflare', 'github'];

type ConexionMin = Pick<ConnectionPublic, 'provider' | 'kind' | 'status'>;
/** Una conexión que full_audit puede revisar: de lectura, activa y de Supabase, Cloudflare o GitHub. */
export const esAuditable = (c: ConexionMin) => c.kind === 'read' && c.status === 'active' && PROVEEDORES_AUDITABLES.includes(c.provider);
/** true solo con la lista ya cargada y sin ninguna auditable. Sin datos (cargando o con error) decide el servidor. */
export const sinFuentesDe = (conexiones: readonly ConexionMin[] | undefined) => conexiones !== undefined && !conexiones.some(esAuditable);

/** El 409 de «no hay ninguna conexión que auditar»: conflict sin scan_run_id (con él es «ya hay una en curso»). */
export const esSinFuentes = (e: unknown) =>
  esApiError(e) && e.code === 'conflict' && typeof e.details?.scan_run_id !== 'string';

export const DICHO_SIN_FUENTES: Dicho = {
  titulo: 'Nada que revisar todavía',
  texto: 'No tienes ninguna fuente conectada que revisar. Conecta Supabase, Cloudflare o tu repo de GitHub en Conexiones, '
    + 'o sube un ZIP de tu código en Codebase para analizarlo.',
};

// En escritorio señala «Conexiones» en el riel; en móvil el riel va en un Sheet cerrado y se señala el botón del menú.
// Si tampoco se ve, Escena habla desde el rincón.
const seVe = (guia: string) => typeof document !== 'undefined' && [...document.querySelectorAll(`[data-guia="${guia}"]`)]
  .some((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
export const objetivoSinFuentes = () => (seVe('nav-connections') ? 'nav-connections' : 'menu');

type Lanzar = (body: ScanCreate, cb: { onSuccess: (r: ScanAccepted) => void; onError: (e: unknown) => void }) => void;
type Pasos = {
  sinFuentes: boolean;
  lanzar: Lanzar;
  irA: (scanRunId: string) => void;
  setError: (e: string | null) => void;
  /** Sin fuentes (antes de llamar o por el 409 de la carrera): Vigía habla y el aviso se queda a la vista. */
  avisar: (carrera: boolean) => void;
};

/** La decisión de un clic, sin React (se prueba con dobles). */
export function auditarTodo({ sinFuentes, lanzar, irA, setError, avisar }: Pasos) {
  setError(null);
  if (sinFuentes) { avisar(false); return; }
  lanzar({ kind: 'full_audit' }, {
    onSuccess: (r) => irA(r.scan_run_id),
    onError: (e) => {
      const enCurso = esApiError(e) && e.code === 'conflict' && typeof e.details?.scan_run_id === 'string' ? e.details.scan_run_id : null;
      if (enCurso) irA(enCurso);                       // ya hay una del mismo tipo corriendo
      else if (esSinFuentes(e)) avisar(true);          // alguien desconectó la última fuente entre medias
      else setError(mensajeDe(e));                     // 429 budget_exceeded y el resto: el mensaje del servidor
    },
  });
}

export function useAuditarTodo() {
  const org = useOrg();
  const navegar = useNavigate();
  const qc = useQueryClient();
  const guia = useGuia();
  const conexiones = useConexiones(org.id);
  const lanzar = useLanzarScan(org.id);
  const [error, setError] = useState<string | null>(null);
  // El 409 de la carrera vale para la lista que había al pulsar: en cuanto llega otra, decide la lista.
  const [carrera, setCarrera] = useState<number | null>(null);
  const sinFuentes = sinFuentesDe(conexiones.data) || (carrera !== null && carrera === conexiones.dataUpdatedAt);
  const auditar = () => auditarTodo({
    sinFuentes,
    lanzar: (body, cb) => lanzar.mutate(body, cb),
    irA: (id) => navegar(`/o/${org.id}/audit/${encodeURIComponent(id)}`),
    setError,
    avisar: (deCarrera) => {
      if (deCarrera) { setCarrera(conexiones.dataUpdatedAt); void qc.invalidateQueries({ queryKey: ['org', org.id, 'connections'] }); }
      // Aunque Vigía esté oculta: decir() la invoca, y el usuario acaba de pulsar.
      guia.decir({ ...DICHO_SIN_FUENTES, objetivo: objetivoSinFuentes() });
    },
  });
  return { auditar, ocupado: lanzar.isPending, error, sinFuentes };
}

/** Bajo el botón cuando no hay fuentes: el botón sigue activo para que el clic haga hablar a Vigía. */
export function AvisoSinFuentes({ className }: { className?: string }) {
  const org = useOrg();
  const enlace = 'font-medium text-foreground underline underline-offset-4';
  return (
    <p role="status" className={className ?? 'max-w-xs text-sm text-muted-foreground'}>
      No tienes ninguna fuente conectada que revisar.{' '}
      <Link className={enlace} to={`/o/${org.id}/connections`}>Conecta una en Conexiones</Link> o{' '}
      <Link className={enlace} to={`/o/${org.id}/codebase`}>sube un ZIP en Codebase</Link>.
    </p>
  );
}
