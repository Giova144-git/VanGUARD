// /login (S14 §14.9): «Entrar» / «Crear cuenta» con correo y contraseña. Sin confirmación de correo (lo configura el BACK).
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Me } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { Input } from '@/componentes/ui/input';
import { Label } from '@/componentes/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/componentes/ui/tabs';
import { Spinner } from '@/componentes/ui/spinner';
import { api } from '@/lib/api';
import { destinoTrasEntrar } from '@/lib/aterrizaje';
import { mensajeDe } from '@/lib/errores';
import { supabase } from '@/lib/supabase';
import { Marca } from '../Marca';

type Modo = 'entrar' | 'crear';

// Propuesta de S06 §06.6: mínimo 10 caracteres con letras y dígitos (si el panel de Auth exige otra cosa, manda el panel).
export const claveValida = (c: string) => c.length >= 10 && /[A-Za-z]/.test(c) && /\d/.test(c);

function traducir(e: { message?: string; code?: string } | null, modo: Modo): string {
  if (!e) return 'Algo falló';
  if (e.code === 'invalid_credentials' || /invalid login credentials/i.test(e.message ?? '')) return 'Correo o contraseña incorrectos';
  if (e.code === 'user_already_exists' || /already registered/i.test(e.message ?? '')) return 'Ese correo ya tiene cuenta: entra';
  if (modo === 'crear' && e.code === 'weak_password') return 'La contraseña es muy débil: usa al menos 10 caracteres con letras y números';
  if (e.code === 'email_address_invalid' || e.code === 'validation_failed') return 'Ese correo no es válido';
  if (e.code === 'over_email_send_rate_limit' || e.code === 'over_request_rate_limit') return 'Demasiados intentos: espera un minuto';
  if (e.code === 'signup_disabled') return 'Ahora no se pueden crear cuentas: usa «Ver la demo»';
  // El resto llega en inglés desde Supabase Auth: respaldo en español.
  return modo === 'crear' ? 'No pudimos crear la cuenta: inténtalo de nuevo' : 'No pudimos entrar: inténtalo de nuevo';
}

function Formulario({ modo }: { modo: Modo }) {
  const [email, setEmail] = useState('');
  const [clave, setClave] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const qc = useQueryClient();
  const navegar = useNavigate();
  const [params] = useSearchParams();

  const enviar = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    if (modo === 'crear' && !claveValida(clave)) { setError('Usa al menos 10 caracteres, con letras y números'); return; }
    setOcupado(true);
    try {
      const r = modo === 'entrar'
        ? await supabase.auth.signInWithPassword({ email: email.trim(), password: clave })
        : await supabase.auth.signUp({ email: email.trim(), password: clave });
      if (r.error) { setError(traducir(r.error, modo)); return; }
      if (!r.data.session) { setError('Tu cuenta quedó creada, pero falta confirmarla. Escríbenos si no te llega nada.'); return; }
      const me = await qc.fetchQuery({ queryKey: ['me'], queryFn: () => api('/api/me', { esquema: Me }), staleTime: 0 });
      navegar(destinoTrasEntrar(me, params.get('next')), { replace: true });
    } catch (e) {
      setError(mensajeDe(e));
    } finally {
      setClave('');
      setOcupado(false);
    }
  };

  return (
    <form onSubmit={enviar} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${modo}-email`}>Correo</Label>
        <Input id={`${modo}-email`} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${modo}-clave`}>Contraseña</Label>
        <Input id={`${modo}-clave`} type="password" required value={clave} onChange={(e) => setClave(e.target.value)}
          autoComplete={modo === 'entrar' ? 'current-password' : 'new-password'} aria-invalid={!!error || undefined}
          aria-describedby={modo === 'crear' ? 'crear-ayuda' : undefined} />
        {modo === 'crear' ? <span id="crear-ayuda" className="text-[12.5px] text-texto-3">Mínimo 10 caracteres, con letras y números.</span> : null}
      </div>
      {error ? <p role="alert" className="rounded-lg border border-mal-borde bg-mal-relleno px-3 py-2 text-sm font-medium text-mal">{error}</p> : null}
      <Button type="submit" variant="principal" size="grande" aria-busy={ocupado || undefined} disabled={!email || !clave}>
        {ocupado ? <Spinner /> : null}{modo === 'entrar' ? 'Entrar' : 'Crear cuenta'}
      </Button>
    </form>
  );
}

export default function Login() {
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center gap-8 px-4 py-10">
      <Link to="/" aria-label="Volver al inicio"><Marca /></Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-[22px] font-semibold">Entra a tu panel</h1>
        <p className="text-[15px] text-muted-foreground">¿Solo quieres mirar? <Link to="/demo" className="font-medium text-info underline underline-offset-4">Ver la demo sin cuenta</Link></p>
      </div>
      <Tabs defaultValue="entrar">
        <TabsList className="w-full">
          <TabsTrigger value="entrar">Entrar</TabsTrigger>
          <TabsTrigger value="crear">Crear cuenta</TabsTrigger>
        </TabsList>
        <TabsContent value="entrar"><Formulario modo="entrar" /></TabsContent>
        <TabsContent value="crear"><Formulario modo="crear" /></TabsContent>
      </Tabs>
    </div>
  );
}
