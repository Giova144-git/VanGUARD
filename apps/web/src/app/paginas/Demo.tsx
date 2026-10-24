// /demo (S14 §14.9): sin sesión → signInAnonymously(); luego POST /api/demo/join → refrescar ['me'] → overview de la demo.
// Con sesión previa (anónima o de correo) solo se une. La contraseña de la cuenta de demo nunca va en el bundle.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { DemoJoin } from '@vanguard/contracts';
import { Eye } from 'lucide-react';
import { Button } from '@/componentes/ui/button';
import { Vacio } from '@/componentes/vg/Vacio';
import { api } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { Marca } from '../Marca';

const NO_DISPONIBLE = 'La demo abierta no está disponible ahora. Entra con la cuenta de demo del README';

export default function Demo() {
  const qc = useQueryClient();
  const navegar = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const iniciado = useRef(false);

  useEffect(() => {
    if (iniciado.current) return;               // StrictMode monta dos veces en desarrollo: una sola unión
    iniciado.current = true;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) {
          const r = await supabase.auth.signInAnonymously();
          if (r.error || !r.data.session) { setError(NO_DISPONIBLE); return; }    // anónimos apagados, 429 por IP…
        }
        const { org_id } = await api('/api/demo/join', { method: 'POST', body: {}, esquema: DemoJoin });
        await qc.refetchQueries({ queryKey: ['me'] });                           // si no, RequireOrg rechaza con el me viejo
        navegar(`/o/${org_id}/overview`, { replace: true });
      } catch {
        setError(NO_DISPONIBLE);                                                 // 404 de E4 (sin org de demo) incluido
      }
    })();
  }, [qc, navegar]);

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-lg flex-col justify-center gap-8 px-4 py-10">
      <Link to="/" aria-label="Volver al inicio"><Marca /></Link>
      {error
        ? <Vacio icono={Eye} titulo="Demo no disponible" texto={error}
            accion={<Button asChild variant="principal" size="grande"><Link to="/login">Entrar con la cuenta de demo</Link></Button>} />
        : <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
            <h1 className="text-[22px] font-semibold">Abriendo la demo…</h1>
            <p className="text-[15px] text-muted-foreground">Entras como invitado, en modo solo lectura, a la organización de demostración.</p>
          </div>}
    </div>
  );
}
