// Portada (S14 §14.9): sin llamadas a la API ni a Supabase, para que siga en 200 aunque caiga el BACK.
import { Link } from 'react-router';
import { Eye, Sparkles } from 'lucide-react';
import { Button } from '@/componentes/ui/button';
import { COMMIT, REPO_JUECES } from '@/lib/env';
import { MARCA } from '@/lib/marca';
import { Marca } from '../Marca';

// La primera tarjeta lleva el símbolo (el ojo VG) en lugar del escudo; las demás, iconos de trazo fino (brand/README.md).
const ICONOS = [null, Eye, Sparkles];

export default function Inicio() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center px-4 py-5 md:px-6">
        <Marca />
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-4 py-8 md:px-6 md:py-16">
        <section className="flex max-w-3xl flex-col gap-5">
          <h1 className="text-4xl font-light tracking-tight md:text-5xl">{MARCA.nombre}</h1>
          <p className="text-lg leading-relaxed text-muted-foreground md:text-xl">{MARCA.portada}</p>
          <div className="mt-2 flex flex-wrap gap-3">
            <Button asChild variant="marca" size="grande"><Link to="/demo">Ver demo en vivo</Link></Button>
            <Button asChild variant="principal" size="grande"><Link to="/login">Entrar</Link></Button>
          </div>
        </section>
        <section className="grid gap-3 md:grid-cols-3" aria-label="Qué hace VanGUARD">
          {MARCA.frases.map((f, i) => {
            const Icono = ICONOS[i];
            return (
              <div key={f} className="flex flex-col gap-3 rounded-xl border bg-card p-5">
                <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-foreground">
                  {Icono ? <Icono className="size-5" strokeWidth={1.5} /> : <span className="logo-vg logo-vg-compacto h-4" aria-hidden />}
                </span>
                <p className="text-[15px] leading-relaxed">{f}</p>
              </div>
            );
          })}
        </section>
      </main>
      <footer className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-6 text-[12.5px] text-texto-3 md:px-6">
        <span>{MARCA.equipo}</span>
        <span>
          versión{' '}
          {COMMIT === 'local'
            ? <span className="font-mono">local</span>
            : <a className="font-mono underline underline-offset-2" href={`${REPO_JUECES}/commit/${COMMIT}`} target="_blank" rel="noopener noreferrer">{COMMIT}</a>}
        </span>
      </footer>
    </div>
  );
}
