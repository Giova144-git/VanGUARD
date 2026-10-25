// Tarjeta de un proveedor en Conexiones (S14 §14.10): estado, ••••last4, alcances y meta; probar, quitar y reconectar.
// GitHub admite varios repos por org (varias-codebases §6.1): una línea por conexión de lectura, con el repo de título.
import { Fragment, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ExternalLink, KeyRound, RotateCw } from 'lucide-react';
import { MAX_REPOS_GITHUB, type ConnectionPublic, type ConnectionTest, type Provider, type ProviderErrorCode } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { Spinner } from '@/componentes/ui/spinner';
import { BotonGrande } from '@/componentes/vg/BotonGrande';
import { ConfirmarEnSitio } from '@/componentes/vg/ConfirmarEnSitio';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { ListaChecks } from '@/componentes/vg/ListaChecks';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { mensajeDe } from '@/lib/errores';
import { cuando } from '@/lib/formato';
import { GUIAS_CONEXION } from '@/lib/guias';
import { lecturasGithub, nombreRepo, reposGithub } from '@/lib/repos';
import { useProbarConexion, useQuitarConexion } from '@/lib/mutaciones';
import { ActivarBlindaje } from './ActivarBlindaje';
import { FRASE_ERROR, nombrePermiso } from '@/lib/permisos';
import { deMapa, type Rol } from '@/lib/severidad';

const HOSTS_REVOCAR = new Set(['supabase.com', 'dash.cloudflare.com', 'github.com']);
const META_VISIBLE = ['project_ref', 'project_name', 'zone_name', 'plan', 'repo_full_name', 'default_branch', 'hostname', 'site_url', 'project'];
const ROTULO_META: Record<string, string> = {
  project_ref: 'Proyecto', project_name: 'Nombre', zone_name: 'Zona', plan: 'Plan', repo_full_name: 'Repo', default_branch: 'Rama', hostname: 'Host',
  site_url: 'Sitio', project: 'Proyecto',
};
// Cloudflare en modo sitio (cloudflare-por-url.md): meta.mode 'url', sin zona. site_kind fuera de contrato → texto genérico.
const esSitioCf = (c: ConnectionPublic) => c.provider === 'cloudflare' && c.meta.mode === 'url';
const TIPO_SITIO: Record<string, string> = { pages: 'Sitio de Pages', workers: 'Sitio de Workers', custom: 'Sitio con dominio propio' };
// Un dominio propio que resultó ser de un proyecto de Pages o de un Worker trae meta.project_kind.
const DOMINIO_DE: Record<string, string> = { pages: 'Dominio propio de Pages', workers: 'Dominio propio de Workers' };
const tituloSitio = (c: ConnectionPublic) => (c.meta.site_kind === 'custom' ? deMapa(DOMINIO_DE, c.meta.project_kind, '') : '')
  || deMapa(TIPO_SITIO, c.meta.site_kind, 'Sitio de Pages/Workers');

// `last_error` llega como código (unauthorized, excess_scope, http_NNN…): aquí va la frase y qué hacer.
function fraseError(c: ConnectionPublic): string {
  const e = c.last_error ?? '';
  if (Object.hasOwn(FRASE_ERROR, e)) return FRASE_ERROR[e as ProviderErrorCode];
  if (e === 'excess_scope') return 'El token tiene más permisos de los necesarios: créalo de nuevo solo con lectura.';
  return c.status === 'error' && c.provider !== 'ingest' ? 'La conexión falla: pulsa «Probar de nuevo» o reconecta.' : 'La conexión falla: pulsa «Reconectar».';
}

export function chapaEstado(c: ConnectionPublic): { texto: string; rol: Rol } {
  switch (c.status) {
    case 'active': return { texto: `Conectado · probado ${cuando(c.last_checked_at)}`, rol: 'bien' };
    case 'error': return { texto: 'La conexión falla', rol: 'mal' };
    case 'expired': return { texto: 'Token vencido', rol: 'mal' };
    case 'revoked': return { texto: 'Token revocado', rol: 'mal' };
  }
}

// Chapa de GitHub con varios repos (§6.1 y §6.2): «N repos» en verde, o la del primero que falla (con su «Reconectar»
// al lado en PantallaModulo). Con uno, la de su conexión, como siempre. `repos` sale de reposGithub (sin repetidos).
export function chapaGithub(repos: ConnectionPublic[]): { texto: string; rol: Rol } | null {
  if (repos.length < 2) return repos[0] ? chapaEstado(repos[0]) : null;
  const peor = repos.find((c) => c.status !== 'active');
  return peor ? chapaEstado(peor) : { texto: `${repos.length} repos`, rol: 'bien' };
}

function urlRevocar(u: string | null): string | null {
  if (!u) return null;
  try { const x = new URL(u); return x.protocol === 'https:' && HOSTS_REVOCAR.has(x.host) ? x.href : null; } catch { return null; }
}

type Quitada = { en: string; revocar: string | null; nombre: string };

// El aviso de «Quitar» se elige por proveedor Y tipo (bloqueo-merge-criticos.md §6.3): el token de estados del bloqueo de
// merge también es de GitHub kind 'action' y no bloquea IPs. `conEstados`: es el repo del token de estados, que cae con él.
export function avisoQuitar(c: Pick<ConnectionPublic, 'provider' | 'kind'>, conEstados = false): string {
  if (c.kind === 'action' && c.provider === 'cloudflare') return 'Sin este token no podrás bloquear IPs desde VanGUARD.';
  if (c.kind === 'action' && c.provider === 'github')
    return 'Sin este token no marcamos ✗ en GitHub ni cerramos los PR con críticos. Si GitHub exige el check “VanGUARD”, los pull requests quedarán esperando.';
  return `Dejamos de mirar este servicio; los hallazgos se conservan.${conEstados ? ' También quitamos el token de estados.' : ''}`;
}

// ¿Es este el repo del token de estados? Por meta.repo_id si los dos lo traen; si no, por nombre en minúsculas
// (varias-codebases §2.6, punto 6).
function mismoRepo(lectura: ConnectionPublic, estados: ConnectionPublic) {
  const a = lectura.meta.repo_id, b = estados.meta.repo_id;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return !!nombreRepo(lectura) && nombreRepo(lectura).toLowerCase() === nombreRepo(estados).toLowerCase();
}

// «Quitado · 21:41 · Revoca también el token en {proveedor} ›» (S14 §14.10). Vive en la tarjeta: la línea desaparece al refrescar.
function AvisoQuitada({ q }: { q: Quitada }) {
  const url = urlRevocar(q.revocar);
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-sm">
      <span className="font-medium">Quitado · {cuando(q.en)}</span>
      {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4">
        Revoca también el token en {q.nombre}<ExternalLink className="size-3.5" /></a> : null}
    </div>
  );
}

// Una línea de conexión: lectura, modo blindaje o token de estados del bloqueo de merge.
function LineaConexion({ c, titulo, alQuitar, conEstados }: { c: ConnectionPublic; titulo?: ReactNode; alQuitar: (q: Quitada) => void; conEstados?: boolean }) {
  const org = useOrg();
  const navegar = useNavigate();
  const probar = useProbarConexion(org.id);
  const quitar = useQuitarConexion(org.id);
  const [prueba, setPrueba] = useState<ConnectionTest | null>(null);
  const estado = chapaEstado(c);
  const nombre = GUIAS_CONEXION[c.provider].nombre;
  // Valores copiados de Supabase, Cloudflare y GitHub (nombre del proyecto, zona, repo, rama…): los controles bidi se ven
  // y cada valor va aislado en su <bdi>, para que no reordene los rótulos vecinos del mismo párrafo.
  const meta = META_VISIBLE.filter((k) => typeof c.meta[k] === 'string' || typeof c.meta[k] === 'boolean')
    .map((k) => ({ k, rotulo: ROTULO_META[k] ?? k, valor: sinBidi(String(c.meta[k])) }));
  const solo = org.puedeEscribir ? undefined : SOLO_LECTURA;

  return (
    <div className="flex flex-col gap-3 rounded-lg border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {titulo ? <span className="text-sm font-semibold">{titulo}</span> : null}
        <Etiqueta texto={estado.texto} rol={estado.rol} />
        {c.last4 ? <span className="font-mono text-[13px] text-muted-foreground">••••<bdi dir="ltr">{sinBidi(c.last4)}</bdi></span> : null}
        {c.expires_at ? <span className="text-[12.5px] text-texto-3">caduca {cuando(c.expires_at)}</span> : null}
      </div>
      {c.scopes.length ? <div className="flex flex-wrap gap-1.5">{c.scopes.map((s) => <Etiqueta key={s} texto={sinBidi(nombrePermiso(s))} />)}</div> : null}
      {meta.length ? <p className="font-mono text-[13px] break-all text-muted-foreground">
        {meta.map((m, i) => <Fragment key={m.k}>{i ? ' · ' : ''}{m.rotulo}: <bdi dir="ltr">{m.valor}</bdi></Fragment>)}</p> : null}
      {c.last_error && c.status !== 'active' ? <p className="text-sm text-mal">{fraseError(c)}</p> : null}
      {prueba ? <ListaChecks checks={prueba.checks} /> : null}
      {probar.isError ? <p role="alert" className="text-sm text-mal">{mensajeDe(probar.error)}</p> : null}
      <div className="flex flex-wrap items-start gap-2">
        {c.provider !== 'ingest' && (c.status === 'active' || c.status === 'error') ? (
          <span className="inline-flex flex-col gap-1">
            <Button variant={c.status === 'error' ? 'principal' : 'secundaria'} disabled={!!solo} aria-busy={probar.isPending || undefined}
              onClick={() => probar.mutate(c.id, { onSuccess: setPrueba })}>
              {probar.isPending ? <Spinner /> : <RotateCw />}{c.status === 'error' ? 'Probar de nuevo' : 'Probar conexión'}
            </Button>
          </span>
        ) : null}
        {c.status !== 'active' ? (
          // GitHub: el asistente llega con el repo puesto y E8 reconecta la MISMA conexión (mismo id, hallazgos y revisión).
          // El token de estados no pasa por el asistente: se pega de nuevo en Codebase (E53 rota el de la misma conexión).
          <Button variant="principal" disabled={!!solo} onClick={() => navegar(c.provider === 'github' && c.kind === 'action' ? `/o/${org.id}/codebase#revision-codigo`
            : `/o/${org.id}/connections/${c.provider}${c.provider === 'github' && nombreRepo(c) ? `?repo=${encodeURIComponent(nombreRepo(c))}` : ''}`)}><KeyRound />Reconectar</Button>
        ) : null}
        <ConfirmarEnSitio verbo="Quitar" deshabilitado={solo}
          aviso={avisoQuitar(c, conEstados)}
          onConfirmar={async () => { const r = await quitar.mutateAsync(c.id); alQuitar({ en: new Date().toISOString(), revocar: r.revocar, nombre }); }} />
      </div>
      {solo ? <span className="text-[12.5px] text-texto-3">{solo}</span> : null}
    </div>
  );
}

export function TarjetaConexion({ proveedor, conexiones, descripcion, icono }: {
  proveedor: Exclude<Provider, 'ingest'>; conexiones: ConnectionPublic[]; descripcion: string; icono: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}) {
  const org = useOrg();
  const navegar = useNavigate();
  const Icono = icono;
  const [quitada, setQuitada] = useState<Quitada | null>(null);
  const lectura = conexiones.find((c) => c.provider === proveedor && c.kind === 'read');
  const accion = conexiones.find((c) => c.provider === proveedor && c.kind === 'action');
  const g = GUIAS_CONEXION[proveedor];
  // GitHub: todas las conexiones de lectura (también las viejas de «Reconectar», para poder quitarlas); el tope y la
  // chapa cuentan nombres de repo distintos.
  const repos = proveedor === 'github' ? reposGithub(conexiones).length : 0;
  const tope = repos >= MAX_REPOS_GITHUB ? `Tope de ${MAX_REPOS_GITHUB} repos por organización` : undefined;
  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-5" aria-labelledby={`tarjeta-${proveedor}`}>
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-foreground"><Icono className="size-5" strokeWidth={1.5} /></span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 id={`tarjeta-${proveedor}`} className="text-[17px] font-semibold">{g.nombre}</h3>
          <p className="text-sm text-muted-foreground">{descripcion}</p>
        </div>
        {lectura ? null : <Etiqueta texto="Falta" />}
        {repos >= 2 ? <Etiqueta texto={`${repos} repos`} /> : null}
      </div>
      {quitada ? <AvisoQuitada q={quitada} /> : null}
      {lectura && proveedor === 'github' ? <>
        {lecturasGithub(conexiones).map((c) => (
          <LineaConexion key={c.id} c={c} alQuitar={setQuitada} conEstados={!!accion && mismoRepo(c, accion)}
            titulo={<bdi dir="ltr" className="font-mono break-all">{sinBidi(nombreRepo(c) || c.label)}</bdi>} />
        ))}
        {/* Bloqueo de merge (bloqueo-merge-criticos.md §6.3): el token de estados se da de alta en Codebase (E53), no aquí. */}
        {accion
          ? <LineaConexion c={accion} titulo="Estados de commit (bloqueo de merge)" alQuitar={setQuitada} />
          : <p className="text-sm text-muted-foreground">
              Bloqueo de merge con críticos: se configura en <Link to={`/o/${org.id}/codebase#revision-codigo`} className="font-medium text-foreground underline underline-offset-4">Codebase → Revisión automática</Link>.
            </p>}
        <div className="flex flex-col gap-1">
          <div>
            <Button variant="secundaria" disabled={!org.puedeEscribir || !!tope} onClick={() => navegar(`/o/${org.id}/connections/github`)}>
              <KeyRound />Conectar otro repo
            </Button>
          </div>
          {org.puedeEscribir ? (tope ? <span className="text-[12.5px] text-texto-3">{tope}</span> : null)
            : <span className="text-[12.5px] text-texto-3">{SOLO_LECTURA}</span>}
        </div>
      </> : lectura ? <>
        <LineaConexion c={lectura} titulo={esSitioCf(lectura) ? tituloSitio(lectura) : proveedor === 'cloudflare' ? 'Lectura' : undefined} alQuitar={setQuitada} />
        {esSitioCf(lectura) ? <>
          <p className="text-sm text-muted-foreground">
            {lectura.meta.config_read === true ? 'Revisamos el sitio por HTTP y la configuración del proyecto.'
              : 'Revisamos el sitio por HTTP. Con un token de cuenta (Pages · Read y Workers Scripts · Read) revisaríamos también la configuración del proyecto.'}
          </p>
          <p className="text-sm text-muted-foreground">Bloquear IPs y el modo bajo ataque necesitan una zona propia de Cloudflare (conexión en modo «Zona»).</p>
        </> : proveedor === 'cloudflare' ? (accion
          ? <LineaConexion c={accion} titulo="Modo blindaje (acciones)" alQuitar={setQuitada} />
          : <div className="flex flex-col gap-3 rounded-lg border border-dashed px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">Modo blindaje (acciones)</span><Etiqueta texto="No configurado" />
              </div>
              <span className="text-muted-foreground">Para bloquear IPs desde VanGUARD hace falta un segundo token, solo para eso.</span>
              <ActivarBlindaje forma="fila" />
            </div>) : null}
      </> : (
        <BotonGrande icono={KeyRound} titulo={`Conectar ${g.nombre}`} descripcion="Con un token de solo lectura"
          deshabilitado={org.puedeEscribir ? undefined : SOLO_LECTURA} onClick={() => navegar(`/o/${org.id}/connections/${proveedor}`)} />
      )}
    </section>
  );
}

export function TarjetaIngesta({ conexiones }: { conexiones: ConnectionPublic[] }) {
  const org = useOrg();
  const navegar = useNavigate();
  const ingest = conexiones.filter((c) => c.provider === 'ingest');
  const [quitada, setQuitada] = useState<Quitada | null>(null);
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-5" aria-labelledby="tarjeta-ingest">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="tarjeta-ingest" className="flex-1 text-[17px] font-semibold">Tu app (ingesta en vivo)</h3>
        {ingest.length ? null : <Etiqueta texto="Falta" />}
      </div>
      <p className="text-sm text-muted-foreground">Tu app nos manda sus peticiones firmadas y detectamos ataques en segundos.</p>
      {quitada ? <AvisoQuitada q={quitada} /> : null}
      {/* El «Nombre de tu app» lo escribió un miembro y lo ven todos: los controles bidi se ven. */}
      {ingest.map((c) => <LineaConexion key={c.id} c={c} titulo={sinBidi(c.label)} alQuitar={setQuitada} />)}
      <div>
        <Button variant={ingest.length ? 'secundaria' : 'principal'} disabled={!org.puedeEscribir} onClick={() => navegar(`/o/${org.id}/connections/ingest`)}>
          <KeyRound />{ingest.length ? 'Conectar otra app' : 'Conectar tu app'}
        </Button>
      </div>
    </section>
  );
}
