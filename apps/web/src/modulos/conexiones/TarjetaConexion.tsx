// Tarjeta de un proveedor en Conexiones (S14 §14.10): estado, ••••last4, alcances y meta; probar, quitar y reconectar.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ExternalLink, KeyRound, RotateCw } from 'lucide-react';
import type { ConnectionPublic, ConnectionTest, Provider } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { Spinner } from '@/componentes/ui/spinner';
import { BotonGrande } from '@/componentes/vg/BotonGrande';
import { ConfirmarEnSitio } from '@/componentes/vg/ConfirmarEnSitio';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { ListaChecks } from '@/componentes/vg/ListaChecks';
import { SOLO_LECTURA, useOrg } from '@/app/guardas';
import { mensajeDe } from '@/lib/errores';
import { cuando } from '@/lib/formato';
import { GUIAS_CONEXION } from '@/lib/guias';
import { useProbarConexion, useQuitarConexion } from '@/lib/mutaciones';
import type { Rol } from '@/lib/severidad';

const HOSTS_REVOCAR = new Set(['supabase.com', 'dash.cloudflare.com', 'github.com']);
const META_VISIBLE = ['project_ref', 'project_name', 'zone_name', 'plan', 'repo_full_name', 'default_branch', 'hostname'];

export function chapaEstado(c: ConnectionPublic): { texto: string; rol: Rol } {
  switch (c.status) {
    case 'active': return { texto: `Conectado · probado ${cuando(c.last_checked_at)}`, rol: 'bien' };
    case 'error': return { texto: 'La conexión falla', rol: 'mal' };
    case 'expired': return { texto: 'Token vencido', rol: 'mal' };
    case 'revoked': return { texto: 'Token revocado', rol: 'mal' };
  }
}

function urlRevocar(u: string | null): string | null {
  if (!u) return null;
  try { const x = new URL(u); return x.protocol === 'https:' && HOSTS_REVOCAR.has(x.host) ? x.href : null; } catch { return null; }
}

// Una línea de conexión: lectura o modo blindaje.
function LineaConexion({ c, titulo }: { c: ConnectionPublic; titulo?: string }) {
  const org = useOrg();
  const navegar = useNavigate();
  const probar = useProbarConexion(org.id);
  const quitar = useQuitarConexion(org.id);
  const [prueba, setPrueba] = useState<ConnectionTest | null>(null);
  const [quitada, setQuitada] = useState<{ en: string; revocar: string | null } | null>(null);
  const estado = chapaEstado(c);
  const nombre = GUIAS_CONEXION[c.provider].nombre;
  const meta = META_VISIBLE.filter((k) => typeof c.meta[k] === 'string' || typeof c.meta[k] === 'boolean').map((k) => `${k}: ${String(c.meta[k])}`);
  const solo = org.puedeEscribir ? undefined : SOLO_LECTURA;

  if (quitada) {
    const url = urlRevocar(quitada.revocar);
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-sm">
        <span className="font-medium">Quitado · {cuando(quitada.en)}</span>
        {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-info underline underline-offset-4">
          Revoca también el token en {nombre}<ExternalLink className="size-3.5" /></a> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {titulo ? <span className="text-sm font-semibold">{titulo}</span> : null}
        <Etiqueta texto={estado.texto} rol={estado.rol} />
        {c.last4 ? <span className="font-mono text-[13px] text-muted-foreground">••••{c.last4}</span> : null}
        {c.expires_at ? <span className="text-[12.5px] text-texto-3">caduca {cuando(c.expires_at)}</span> : null}
      </div>
      {c.scopes.length ? <div className="flex flex-wrap gap-1.5">{c.scopes.map((s) => <Etiqueta key={s} texto={s} mono />)}</div> : null}
      {meta.length ? <p className="font-mono text-[13px] break-all text-muted-foreground">{meta.join(' · ')}</p> : null}
      {c.last_error && c.status !== 'active' ? <p className="text-sm text-mal">{c.last_error}</p> : null}
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
          <Button variant="principal" disabled={!!solo} onClick={() => navegar(`/o/${org.id}/connections/${c.provider}`)}><KeyRound />Reconectar</Button>
        ) : null}
        <ConfirmarEnSitio verbo="Quitar" deshabilitado={solo}
          aviso={c.kind === 'action' ? 'Sin este token no podrás bloquear IPs desde VanGUARD.' : 'Dejamos de mirar este servicio; los hallazgos se conservan.'}
          onConfirmar={async () => { const r = await quitar.mutateAsync(c.id); setQuitada({ en: new Date().toISOString(), revocar: r.revocar }); }} />
      </div>
      {solo ? <span className="text-[12.5px] text-texto-3">{solo}</span> : null}
    </div>
  );
}

export function TarjetaConexion({ proveedor, conexiones, descripcion, icono }: {
  proveedor: Exclude<Provider, 'ingest'>; conexiones: ConnectionPublic[]; descripcion: string; icono: React.ComponentType<{ className?: string }>;
}) {
  const org = useOrg();
  const navegar = useNavigate();
  const Icono = icono;
  const lectura = conexiones.find((c) => c.provider === proveedor && c.kind === 'read');
  const accion = conexiones.find((c) => c.provider === proveedor && c.kind === 'action');
  const g = GUIAS_CONEXION[proveedor];
  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-5" aria-labelledby={`tarjeta-${proveedor}`}>
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg bg-info-relleno text-info"><Icono className="size-5" /></span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 id={`tarjeta-${proveedor}`} className="text-[17px] font-semibold">{g.nombre}</h3>
          <p className="text-sm text-muted-foreground">{descripcion}</p>
        </div>
        {lectura ? null : <Etiqueta texto="Falta" />}
      </div>
      {lectura ? <>
        <LineaConexion c={lectura} titulo={proveedor === 'cloudflare' ? 'Lectura' : undefined} />
        {proveedor === 'cloudflare' ? (accion
          ? <LineaConexion c={accion} titulo="Modo blindaje (acciones)" />
          : <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-sm">
              <span className="font-semibold">Modo blindaje (acciones)</span><Etiqueta texto="No configurado" />
              <span className="text-muted-foreground">Para bloquear IPs desde VanGUARD, reconecta Cloudflare con los dos tokens.</span>
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
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-5" aria-labelledby="tarjeta-ingest">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="tarjeta-ingest" className="flex-1 text-[17px] font-semibold">Tu app (ingesta en vivo)</h3>
        {ingest.length ? null : <Etiqueta texto="Falta" />}
      </div>
      <p className="text-sm text-muted-foreground">Tu app nos manda sus peticiones firmadas y detectamos ataques en segundos.</p>
      {ingest.map((c) => <LineaConexion key={c.id} c={c} titulo={c.label} />)}
      <div>
        <Button variant={ingest.length ? 'secundaria' : 'principal'} disabled={!org.puedeEscribir} onClick={() => navegar(`/o/${org.id}/connections/ingest`)}>
          <KeyRound />{ingest.length ? 'Conectar otra app' : 'Conectar tu app'}
        </Button>
      </div>
    </section>
  );
}
