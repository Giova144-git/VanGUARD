// /demo (S14 §14.9, E4): cada visitante tiene SU copia temporal de la demo (sandbox), de la que es dueño. Sin sesión
// entra como invitado (sesión volátil en sessionStorage); con sesión de correo la conserva y solo se une a su sandbox.
// Luego refresca ['me'] y va al resumen de la copia. La lógica vive en lib/sandbox.ts (unirseADemo).
// ?caducada=1: la copia anterior caducó y se prepara otra sola (Vigía lo cuenta). ?caducada=fallo: ya se intentó hace
// nada; sin otro intento automático (nada de bucles), solo el botón «Volver a la demo».
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { Button } from '@/componentes/ui/button';
import { Vacio } from '@/componentes/vg/Vacio';
import { Vigia } from '@/componentes/vigia/Vigia';
import { ErrorDemo, NO_DISPONIBLE, permitirRecrear, unirseADemo } from '@/lib/sandbox';
import { Marca } from '../Marca';

export const PREPARANDO_OTRA = 'Tu copia caducó mientras no estabas: te preparo una nueva.';
export const NO_RECREADA = 'Tu copia caducó y no pude preparar otra sola. Vuelve a intentarlo cuando quieras.';

type Props = { error: string | null; caducada?: boolean; alReintentar?: () => void };

export function VistaDemo({ error, caducada = false, alReintentar }: Props) {
  // Tras una copia caducada, el botón es «Volver a la demo» (otro intento, a mano); si no, la cuenta de demo del README.
  const accion = caducada && alReintentar
    ? <Button variant="principal" size="grande" onClick={alReintentar}>Volver a la demo</Button>
    : <Button asChild variant="principal" size="grande"><Link to="/login">Entrar con la cuenta de demo</Link></Button>;
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-lg flex-col justify-center gap-8 px-4 py-10">
      <Link to="/" aria-label="Volver al inicio"><Marca /></Link>
      {error
        ? <Vacio icono={Eye} titulo={caducada ? 'Tu copia caducó' : 'Demo no disponible'} texto={error} accion={accion} />
        : caducada
          ? <div className="flex items-center gap-4" aria-busy="true" aria-live="polite">
              <Vigia pose="pensar" expresion="neutral" seguirPuntero={false} className="h-[120px] w-[105px] shrink-0" />
              <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
                <p className="text-[12.5px] font-medium text-texto-3">Vigía</p>
                <p className="text-[15px]">{PREPARANDO_OTRA}</p>
              </div>
            </div>
          : <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
              <h1 className="text-[22px] font-semibold">Preparando tu copia de la demo…</h1>
              <p className="text-[15px] text-muted-foreground">Es solo tuya: puedes probarlo todo. Las acciones sobre Cloudflare y los WhatsApp se simulan, y la copia se borra al cerrar el navegador.</p>
            </div>}
    </div>
  );
}

export default function Demo() {
  const qc = useQueryClient();
  const navegar = useNavigate();
  const [params] = useSearchParams();
  const caducada = params.get('caducada');
  // ?caducada=fallo no intenta solo: espera al botón (intento 1).
  const [intento, setIntento] = useState(caducada === 'fallo' ? 0 : 1);
  const [error, setError] = useState<string | null>(caducada === 'fallo' ? NO_RECREADA : null);

  const lanzado = useRef(0);
  useEffect(() => {
    if (intento === 0 || lanzado.current === intento) return;     // StrictMode monta dos veces: un solo invitado y join
    lanzado.current = intento;
    (async () => {
      try {
        const { org_id } = await unirseADemo();
        await qc.refetchQueries({ queryKey: ['me'] });                           // si no, RequireOrg rechaza con el me viejo
        navegar(`/o/${org_id}/overview`, { replace: true });
      } catch (e) {
        setError(e instanceof ErrorDemo ? e.message : NO_DISPONIBLE);
      }
    })();
  }, [qc, navegar, intento]);

  const reintentar = () => { permitirRecrear(); setError(null); setIntento((n) => n + 1); };
  return <VistaDemo error={error} caducada={caducada !== null} alReintentar={reintentar} />;
}
