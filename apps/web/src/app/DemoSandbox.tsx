// La sandbox de la demo en el cascarón: la etiqueta «Demo · tu copia temporal», el botón «Salir de la demo» y el aviso de
// Vigía la primera vez que se entra en la copia (por pestaña). El latido vive en ConSesion; la lógica, en lib/sandbox.ts.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { Button } from '@/componentes/ui/button';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import type { AvisoGuia } from '@/componentes/vigia/contexto';
import { destinoTrasEntrar } from '@/lib/aterrizaje';
import { AVISO_CADUCADA, AVISO_SANDBOX, avisoPendiente, enviarSalida, olvidarCaducada, recordarAviso, vieneDeCaducada } from '@/lib/sandbox';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import type { OrgActual } from './guardas';

/** `corta` para el móvil, donde la cabecera no tiene sitio para el texto entero. */
export function EtiquetaSandbox({ corta = false }: { corta?: boolean }) {
  return <Etiqueta texto={corta ? 'Copia' : 'Demo · tu copia temporal'} rol="info" data-info="demo-sandbox" />;
}

/** Borra la sandbox ya (keepalive) y sale: el invitado cierra su sesión y vuelve a la portada; con cuenta, a su org
 *  (o a /start). Primero se navega y luego se cierra o refresca: así RequireOrg no ve un instante la org ya borrada. */
export function useSalirDeLaDemo(org: OrgActual) {
  const qc = useQueryClient();
  const navegar = useNavigate();
  const [saliendo, setSaliendo] = useState(false);
  const salir = async () => {
    if (saliendo) return;
    setSaliendo(true);
    await enviarSalida(org.id);
    if (org.me.user.is_anonymous) {
      // flushSync: la portada ya está pintada cuando llega SIGNED_OUT. Si no, la navegación (en una transición) pierde
      // con ese aviso y RequireSession, aún montado, manda a /login?next= la org que se acaba de borrar.
      await navegar('/', { replace: true, flushSync: true });
      // scope local: salir ya borró al invitado en la base; no hace falta (ni sirve) revocar en el servidor.
      await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
      return;
    }
    await navegar(destinoTrasEntrar({ ...org.me, orgs: org.me.orgs.filter((o) => o.id !== org.id) }, null), { replace: true, flushSync: true });
    await qc.invalidateQueries({ queryKey: ['me'] });
  };
  return { salir, saliendo };
}

export function BotonSalirDemo({ org, compacto = false, className }: { org: OrgActual; compacto?: boolean; className?: string }) {
  const { salir, saliendo } = useSalirDeLaDemo(org);
  return (
    <Button variant="secundaria" size="fila" onClick={() => void salir()} disabled={saliendo} className={cn(compacto && 'size-11 justify-center px-0', className)}
      aria-label="Salir de la demo" title="Salir de la demo: borra tu copia ahora">
      <LogOut />{compacto ? null : 'Salir de la demo'}
    </Button>
  );
}

/** El aviso de Vigía para GuiaProvider, una vez por pestaña y sandbox; si la copia sustituye a una que caducó, lo cuenta.
 *  useState: estable y decidido al montar. */
export function useAvisoSandbox(org: Pick<OrgActual, 'id' | 'sandbox'>): AvisoGuia | null {
  const [aviso] = useState<AvisoGuia | null>(() => (org.sandbox === true && avisoPendiente(org.id)
    ? { dicho: { ...(vieneDeCaducada() ? AVISO_CADUCADA : AVISO_SANDBOX), pose: 'saludar' },
        alMostrar: () => { recordarAviso(org.id); olvidarCaducada(); } }
    : null));
  return aviso;
}
