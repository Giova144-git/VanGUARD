// Página provisional de cada módulo mientras llegan sus hitos (S14 §14.20): barra, guía y «Conecta» si falta el proveedor.
import { useNavigate } from 'react-router';
import { Construction, KeyRound } from 'lucide-react';
import type { Module, Provider } from '@vanguard/contracts';
import { BarraModulo } from '@/componentes/vg/BarraModulo';
import { BotonGrande } from '@/componentes/vg/BotonGrande';
import { GuiaModulo } from '@/componentes/vg/GuiaModulo';
import { Vacio } from '@/componentes/vg/Vacio';
import { useConexiones, useEstadoModulo } from '@/lib/consultas';
import { entradaNav, type IdNav } from '@/lib/nav';
import { SOLO_LECTURA, useOrg } from '../guardas';

const PROVEEDOR: Record<Exclude<Provider, 'ingest'>, string> = { supabase: 'Supabase', cloudflare: 'Cloudflare', github: 'GitHub' };

function BarraConContador({ org, modulo, titulo, descripcion }: { org: string; modulo: Module; titulo: string; descripcion: string }) {
  const q = useEstadoModulo(org, modulo);
  return <BarraModulo titulo={titulo} descripcion={descripcion} contador={q.data?.contador ?? null} />;
}

export default function PaginaEnCamino({ id, hito }: { id: IdNav; hito: string }) {
  const org = useOrg();
  const navegar = useNavigate();
  const e = entradaNav(id)!;
  const conexiones = useConexiones(org.id);
  const proveedor = 'proveedor' in e ? e.proveedor : null;
  const conectado = !proveedor || conexiones.data?.some((c) => c.provider === proveedor && c.status === 'active');

  return (
    <div className="flex flex-col gap-6">
      {'modulo' in e
        ? <BarraConContador org={org.id} modulo={e.modulo} titulo={e.nombre} descripcion={e.descripcion} />
        : <BarraModulo titulo={e.nombre} descripcion={e.descripcion} />}
      {proveedor && conexiones.data && !conectado
        ? <Vacio icono={KeyRound} titulo={`Conecta ${PROVEEDOR[proveedor]} para ver este módulo`} texto={e.descripcion}
            accion={<BotonGrande icono={KeyRound} titulo={`Conectar ${PROVEEDOR[proveedor]}`} descripcion="Con un token de solo lectura"
              deshabilitado={org.puedeEscribir ? undefined : SOLO_LECTURA} onClick={() => navegar(`/o/${org.id}/connections/${proveedor}`)} />} />
        : <Vacio icono={Construction} titulo="Esta pantalla se completa en el próximo hito" texto={`Llega en ${hito}.`} />}
      <GuiaModulo id={id} />
    </div>
  );
}
