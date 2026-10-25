// Ruta de diseño: todo lo de dentro exige sesión (RequireSession). Aquí late la sandbox de la demo (lib/sandbox.ts):
// en cualquier pantalla con sesión, no solo dentro de la org, para que pasar por /start no la deje morir. También avisa
// del cierre en pagehide (/api/demo/cerrando) y, si un latido dice que la copia de la URL caducó, prepara otra.
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useMe } from '@/lib/consultas';
import { copiasRecordadas, destinoAlCaducar, escucharCierre, latir, orgDeRuta, programarLatido, recordarCopias } from '@/lib/sandbox';
import { RequireSession } from '../guardas';
import { useSesion } from '../sesion';

export function LatidoSandbox() {
  const qc = useQueryClient();
  const me = useMe();
  const navegar = useNavigate();
  const { pathname } = useLocation();
  // Ids ordenados como dependencia: un refetch de /api/me con las mismas sandboxes no reinicia el reloj.
  const ids = (me.data?.orgs ?? []).filter((o) => o.sandbox === true).map((o) => o.id).sort().join(',');
  const enRuta = useRef<string | null>(null);
  enRuta.current = orgDeRuta(pathname);                 // ref: cambiar de pantalla no reinicia el reloj del latido
  useEffect(() => { if (me.data) recordarCopias(ids ? ids.split(',') : []); }, [me.data, ids]);
  useEffect(() => escucharCierre(copiasRecordadas), []);
  useEffect(() => {
    if (!ids) return;
    const paradas = ids.split(',').map((org) => programarLatido(() => {
      void latir(org).then((viva) => {
        if (viva) return;
        const destino = org === enRuta.current ? destinoAlCaducar(org) : null;
        if (destino) void navegar(destino, { replace: true });
        else void qc.invalidateQueries({ queryKey: ['me'] });
      });
    }));
    return () => paradas.forEach((p) => p());
  }, [ids, qc, navegar]);
  return null;
}

export default function ConSesion() {
  const s = useSesion();
  return <>{s.activa ? <LatidoSandbox /> : null}<RequireSession /></>;
}
