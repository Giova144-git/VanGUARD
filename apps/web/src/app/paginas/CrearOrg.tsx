// /start (S14 §14.9): crear la organización y pasar a Conexiones.
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Org } from '@vanguard/contracts';
import { UserRound } from 'lucide-react';
import { Button } from '@/componentes/ui/button';
import { Input } from '@/componentes/ui/input';
import { Label } from '@/componentes/ui/label';
import { Spinner } from '@/componentes/ui/spinner';
import { Vacio } from '@/componentes/vg/Vacio';
import { api } from '@/lib/api';
import { mensajeDe } from '@/lib/errores';
import { supabase } from '@/lib/supabase';
import { Marca } from '../Marca';
import { useSesion } from '../sesion';

export default function CrearOrg() {
  const sesion = useSesion();
  const qc = useQueryClient();
  const navegar = useNavigate();
  const [nombre, setNombre] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const largo = nombre.trim().length;

  const enviar = async (ev: FormEvent) => {
    ev.preventDefault();
    if (largo < 2 || largo > 80) { setError('Entre 2 y 80 caracteres'); return; }
    setError(null); setOcupado(true);
    try {
      const org = await api('/api/orgs', { method: 'POST', body: { name: nombre.trim() }, esquema: Org });
      await qc.refetchQueries({ queryKey: ['me'] });
      navegar(`/o/${org.id}/connections`, { replace: true });
    } catch (e) { setError(mensajeDe(e)); } finally { setOcupado(false); }
  };

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center gap-8 px-4 py-10">
      <Link to="/" aria-label="Volver al inicio"><Marca /></Link>
      {sesion.anonima
        ? <Vacio icono={UserRound} titulo="Crea una cuenta con correo para conectar tus servicios"
            texto="La demo es de solo lectura. Con una cuenta propia conectas tu Supabase, tu Cloudflare y tu repo."
            accion={<Button variant="principal" size="grande" onClick={async () => { await supabase.auth.signOut(); navegar('/login'); }}>Crear cuenta</Button>} />
        : <form onSubmit={enviar} className="flex flex-col gap-5" noValidate>
            <div className="flex flex-col gap-2">
              <h1 className="text-[22px] font-semibold">Crea tu organización</h1>
              <p className="text-[15px] text-muted-foreground">Después conectas tus servicios con tokens de solo lectura.</p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="org-nombre">Nombre de tu empresa o proyecto</Label>
              <Input id="org-nombre" value={nombre} maxLength={80} onChange={(e) => setNombre(e.target.value)} aria-invalid={!!error || undefined} />
            </div>
            {error ? <p role="alert" className="rounded-lg border border-mal-borde bg-mal-relleno px-3 py-2 text-sm font-medium text-mal">{error}</p> : null}
            <Button type="submit" variant="principal" size="grande" aria-busy={ocupado || undefined} disabled={largo < 2}>
              {ocupado ? <Spinner /> : null}Crear y conectar mis servicios
            </Button>
          </form>}
    </div>
  );
}
