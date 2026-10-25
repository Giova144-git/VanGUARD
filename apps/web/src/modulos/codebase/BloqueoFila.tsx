// El check «VanGUARD» en la fila abierta de una revisión (bloqueo-merge-criticos.md §6.2; anexo de cierre de PR): lo que
// bloquea, qué hacer y, solo para owner y admin, «Dar por bueno» / «Deshacer» (E54 override/revert, con simulación) y
// «Reabrir el PR» (E54 reopen_pr) y, P1, «Publicar de nuevo» (republish). Si E54 da 404 (aún sin desplegar), los botones no
// se ofrecen; si republish da 409 {reason: 'p1'} (E54 en P0), ese botón tampoco.
import { useState } from 'react';
import { CheckCheck, RefreshCw, Undo2 } from 'lucide-react';
import type { CodeReview, MergeGateAction, MergeGateConfig } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { Spinner } from '@/componentes/ui/spinner';
import { ConfirmarEnSitio } from '@/componentes/vg/ConfirmarEnSitio';
import { ChapaSeveridad } from '@/componentes/vg/Etiqueta';
import { CampoTexto } from '@/componentes/vg/FormToken';
import { useOrg } from '@/app/guardas';
import { sinBidi } from '@/lib/bidi';
import { ApiError, esApiError, mensajeDe } from '@/lib/errores';
import { useAccionBloqueo, useRutaAusente } from '@/lib/mutaciones';
import { sePuedeAprobar, sePuedeRepublicar, textoErrorCierre, textoParcialBloqueo } from '@/lib/revision';
import { deMapa } from '@/lib/severidad';
import { PanelConfirmar } from './BloqueoMerge';

// 409 de E54 por `details.reason` (mapa cerrado); si no, el mensaje del servidor.
const RAZON: Record<string, string> = {
  nada_que_aprobar: 'Esta revisión ya no tiene nada que aprobar',
  sin_override: 'No había ninguna aprobación que deshacer',
  apagado: 'El bloqueo está apagado',
  solo_produccion: 'Solo disponible en officialvanguard.com',
  no_cerrado: 'Ese pull request ya no está cerrado por VanGUARD',
  no_es_la_ultima: 'Solo se publica de nuevo la revisión más reciente de ese PR o de ese commit',
  p1: '«Publicar de nuevo» aún no está disponible',
};
function errorAccion(e: unknown): string {
  if (esApiError(e) && e.status === 429) return 'Demasiados intentos: espera un minuto y vuelve a probar';
  const r = esApiError(e) ? deMapa(RAZON, e.details?.reason, '') : '';
  return r || mensajeDe(e);
}

export function DetalleBloqueo({ r, gate, puedeEscribir, alAccion }: {
  r: CodeReview; gate: MergeGateConfig | undefined; puedeEscribir: boolean; alAccion?: () => void;
}) {
  const org = useOrg();
  const sinE54 = useRutaAusente(org.id, 'E54');
  const sinRepublicar = useRutaAusente(org.id, 'E54-republish');
  const g = r.gate;
  if (!g) return null;
  const pr = r.event === 'pull_request';
  const n = typeof g.blocking === 'number' && Number.isFinite(g.blocking) ? g.blocking : 0;
  const mas = n - g.findings.length;
  const rama = <bdi dir="ltr" className="font-mono break-all">{sinBidi(r.branch)}</bdi>;
  // Los botones que AccionesBloqueo ofrecería (mismas condiciones, con la bandera por 404 de E54).
  const acciones = puedeEscribir && !!gate?.enabled && !sinE54
    && (sePuedeAprobar(g) || !!g.override_at || (sePuedeRepublicar(g) && !sinRepublicar) || g.pr_action === 'closed');
  // Sin nada que explicar ni que ofrecer (✓ publicado, «revisando…», PR reabierto) basta el chip de la fila: nada de un
  // recuadro con solo el título.
  const explica = g.findings.length > 0 || (g.state === 'error' && r.status !== 'failed' && r.partial) || g.state === 'failure'
    || g.pr_action === 'closed' || g.pr_action === 'reopened_by_human' || g.pr_action === 'close_failed';
  if (!explica && !acciones) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border px-3 py-3" role="group" aria-label="Check VanGUARD en GitHub">
      <p className="text-sm font-semibold">Check “VanGUARD” en GitHub</p>
      {g.findings.length ? <>
        <p className="text-sm text-muted-foreground">Lo que bloquea</p>
        <ul className="flex flex-col gap-2" aria-label="Lo que bloquea">
          {g.findings.map((f, i) => (
            <li key={`${f.rule_id}-${f.resource}-${i}`} className="flex flex-wrap items-center gap-2">
              <ChapaSeveridad severity={f.severity} />
              <span className="text-[15px] font-medium wrap-anywhere">{sinBidi(f.title)}</span>
              <span className="font-mono text-[13px] text-muted-foreground break-all"><bdi dir="ltr">{sinBidi(f.resource)}</bdi></span>
            </li>
          ))}
        </ul>
        {mas > 0 ? <p className="text-sm text-muted-foreground">y {mas} más</p> : null}
      </> : null}
      {g.state === 'error' && r.status !== 'failed' && r.partial ? (
        <p className="text-sm">
          {textoParcialBloqueo(r.error_code)}. Un push nuevo vuelve a revisar todo el PR: si la causa sigue, el ✗ también. “Redeliver” no lo cambia.
        </p>
      ) : null}
      {g.state === 'failure' && !pr ? (
        <p className="text-sm">
          Este cambio ya está en {rama}. Rota la clave y quítala con un push nuevo. VanGUARD no revierte nada solo. Cuando tu plan lo
          permita, exige pull request en la rama (paso 2 del bloqueo).
        </p>
      ) : null}
      {g.state === 'failure' && pr ? <p className="text-sm">Arréglalo con un push nuevo al PR. Aunque lo quites, la clave quedó en el historial de la rama: rótala.</p> : null}
      {g.pr_action === 'closed' ? <p className="text-sm">VanGUARD cerró este pull request con un comentario. Corrige el código, rota las claves expuestas y vuelve a abrirlo.</p> : null}
      {g.pr_action === 'reopened_by_human' ? <p className="text-sm">Alguien lo reabrió sin commits nuevos: respetamos esa decisión y mantenemos el ✗.</p> : null}
      {g.pr_action === 'close_failed' ? <p className="text-sm">No pudimos cerrar el PR: {textoErrorCierre(g.pr_close_error)}. El ✗ y el aviso por WhatsApp salieron igual.</p> : null}
      {puedeEscribir && gate?.enabled ? <AccionesBloqueo r={r} alAccion={alAccion} /> : null}
    </div>
  );
}

function AccionesBloqueo({ r, alAccion }: { r: CodeReview; alAccion?: () => void }) {
  const org = useOrg();
  const accion = useAccionBloqueo(org.id);
  const sinRuta = useRutaAusente(org.id, 'E54');
  const sinRepublicar = useRutaAusente(org.id, 'E54-republish');
  const [aprobando, setAprobando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);
  const g = r.gate;
  if (sinRuta || !g) return null;

  // Un fallo de «Reabrir el PR» lo pinta ConfirmarEnSitio (lanza); el resto, la línea de error de abajo.
  const ejecutar = async (a: MergeGateAction, listo: string, lanzar = false) => {
    setError(null);
    setHecho(null);
    try {
      const res = await accion.mutateAsync({ id: r.id, accion: a });
      // error de RespuestaEscritura: llega como dato; ApiError pone a la vista sus controles bidi.
      if (res && res.ok === false) throw new ApiError(200, 'gate_action', typeof res.error === 'string' ? res.error : 'No pudimos hacerlo');
      setHecho(listo);
      setAprobando(false);
      setMotivo('');
      alAccion?.();
    } catch (e) {
      const m = errorAccion(e);
      if (lanzar) throw new ApiError(0, 'gate_action', m);
      setError(m);
    }
  };
  const largo = motivo.trim().length;
  const sha7 = <span className="font-mono">{r.head_sha.slice(0, 7)}</span>;
  return (
    <div className="flex flex-col gap-2">
      {sePuedeAprobar(g) && !aprobando ? (
        <div><Button variant="secundaria" onClick={() => { setError(null); setHecho(null); setAprobando(true); }}><CheckCheck />Dar por bueno este commit</Button></div>
      ) : null}
      {sePuedeAprobar(g) && aprobando ? (
        <PanelConfirmar etiqueta="Dar por bueno este commit" verbo="Dar por bueno" ocupado={accion.isPending} deshabilitado={largo < 3 || largo > 200}
          onCancelar={() => setAprobando(false)}
          onConfirmar={() => void ejecutar({ op: 'override', reason: motivo.trim() }, 'Aprobado a mano: publicamos el ✓ en GitHub en unos segundos')}>
          <p>
            Publicaremos ✓ “VanGUARD — Aprobado a mano en VanGUARD por un admin” en {sha7}. Un push nuevo se revisa otra vez. Puedes deshacerlo.
          </p>
          <CampoTexto id={`motivo-${r.id}`} etiqueta="Motivo (de 3 a 200 caracteres)" valor={motivo} onCambio={(v) => setMotivo(v.slice(0, 200))}
            placeholder="Falso positivo: es una clave de prueba" />
        </PanelConfirmar>
      ) : null}
      {g.override_at ? (
        <div>
          <Button variant="secundaria" aria-busy={accion.isPending || undefined}
            onClick={accion.isPending ? undefined : () => void ejecutar({ op: 'revert' }, 'Deshecho: vuelve el estado de la regla en unos segundos')}>
            {accion.isPending ? <Spinner /> : <Undo2 />}Deshacer la aprobación
          </Button>
        </div>
      ) : null}
      {/* P1: tras pegar el token con PR ya abiertos (o tras un fallo de red), la revisión más reciente se publica de nuevo. */}
      {sePuedeRepublicar(g) && !sinRepublicar ? (
        <div>
          <Button variant="secundaria" aria-busy={accion.isPending || undefined}
            onClick={accion.isPending ? undefined : () => void ejecutar({ op: 'republish' }, 'Encolado: lo publicamos en GitHub en unos segundos')}>
            {accion.isPending ? <Spinner /> : <RefreshCw />}Publicar de nuevo
          </Button>
        </div>
      ) : null}
      {g.pr_action === 'closed' ? (
        <ConfirmarEnSitio verbo="Reabrir el PR" aviso="Lo reabrimos en GitHub y el ✗ se queda. El comentario de VanGUARD no se borra."
          deshabilitado={accion.isPending ? 'Guardando…' : undefined}
          onConfirmar={() => ejecutar({ op: 'reopen_pr' }, 'Reabriendo el PR en GitHub…', true)} />
      ) : null}
      <p role="status" className="text-sm">{hecho ?? ''}</p>
      {error ? <p role="alert" className="text-sm text-mal">{error}</p> : null}
    </div>
  );
}
