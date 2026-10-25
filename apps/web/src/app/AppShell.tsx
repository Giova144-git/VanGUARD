// Cascarón (S14 §14.5): riel con módulos en orden fijo, cabecera de 56 px y una sola fila de estado global.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Check, ChevronsUpDown, Clock, LogOut, PanelLeft, Search, Siren, TriangleAlert, WifiOff } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Module, Overview, Role } from '@vanguard/contracts';
import { Button } from '@/componentes/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/componentes/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/componentes/ui/sheet';
import { ChipGastoIA } from '@/componentes/vg/ChipGastoIA';
import { Etiqueta } from '@/componentes/vg/Etiqueta';
import { MarcaNumero, MarcasContador } from '@/componentes/vg/MarcasContador';
import { PaletaComandos } from '@/componentes/vg/PaletaComandos';
import { ESPERA_G_MS, leerTecla } from '@/lib/atajos';
import { useConexiones, useEstadoModulo, useOverview, useUsoIA } from '@/lib/consultas';
import { cuando } from '@/lib/formato';
import { MARCA } from '@/lib/marca';
import { NAV, entradaNav, type EntradaNav, type IdNav } from '@/lib/nav';
import { deMapa } from '@/lib/severidad';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { sinBidi } from '@/lib/bidi';
import { useOrg } from './guardas';
import { Marca } from './Marca';

// Un rol fuera de contrato (o «__proto__») en /api/me sale «—»: deMapa, no ROL_TEXTO[k].
const ROL_TEXTO: Record<Role, string> = { owner: 'Dueño', admin: 'Admin', viewer: 'Solo lectura' };
const CLAVE_RIEL = 'vg-riel';

// Cuenta fallos seguidos de una consulta: se reinicia con cada respuesta buena.
function useFallosSeguidos(q: UseQueryResult<unknown>) {
  const [n, setN] = useState(0);
  const ultimoError = useRef(0);
  useEffect(() => { if (q.errorUpdatedAt && q.errorUpdatedAt !== ultimoError.current) { ultimoError.current = q.errorUpdatedAt; setN((x) => x + 1); } }, [q.errorUpdatedAt]);
  useEffect(() => { if (q.dataUpdatedAt) setN(0); }, [q.dataUpdatedAt]);
  return n;
}

function MarcaModulo({ org, modulo }: { org: string; modulo: Module }) {
  const q = useEstadoModulo(org, modulo);
  return <MarcasContador contador={q.data?.contador} />;
}

function ItemRiel({ entrada, compacto, marca, alNavegar }: { entrada: EntradaNav; compacto: boolean; marca?: ReactNode; alNavegar?: () => void }) {
  const Icono = entrada.icono;
  return (
    <NavLink to={entrada.id} onClick={alNavegar} title={compacto ? entrada.nombre : undefined} aria-label={compacto ? entrada.nombre : undefined}
      className={({ isActive }) => cn(
        'flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
        isActive ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground',
        compacto && 'justify-center px-0',
      )}>
      <Icono className="size-5 shrink-0" />
      {compacto ? null : <><span className="flex-1 truncate">{entrada.nombre}</span>{marca}</>}
    </NavLink>
  );
}

function Rotulo({ texto, compacto }: { texto: string; compacto: boolean }) {
  return compacto ? <div className="mx-3 my-2 h-px bg-border" /> : <div className="px-3 pt-4 pb-1 text-[12.5px] font-medium text-texto-3">{texto}</div>;
}

function SelectorOrg({ compacto }: { compacto: boolean }) {
  const org = useOrg();
  const navegar = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`Organización: ${sinBidi(org.name)}`}
          className={cn('flex h-12 w-full items-center gap-2 rounded-lg border bg-card px-3 text-left text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring', compacto && 'justify-center px-0')}>
          {compacto ? <span className="text-[15px] font-semibold">{sinBidi(org.name).slice(0, 1).toUpperCase()}</span> : <>
            <span className="flex-1 truncate">{sinBidi(org.name)}</span>
            {org.is_demo ? <Etiqueta texto="Demo" rol="info" /> : null}
            <ChevronsUpDown className="size-4 text-texto-3" />
          </>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Tus organizaciones</DropdownMenuLabel>
        {org.me.orgs.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => navegar(`/o/${o.id}`)}>
            <span className="flex-1 truncate">{sinBidi(o.name)}</span>
            {o.is_demo ? <Etiqueta texto="Demo" rol="info" /> : null}
            {o.id === org.id ? <Check className="size-4 text-foreground" /> : null}
          </DropdownMenuItem>
        ))}
        {org.me.user.is_anonymous ? null : <DropdownMenuItem onSelect={() => navegar('/start')}>Crear organización</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Riel({ compacto, overview, alNavegar }: { compacto: boolean; overview: UseQueryResult<Overview>; alNavegar?: () => void }) {
  const org = useOrg();
  const conexiones = useConexiones(org.id);
  const activas = conexiones.data?.filter((c) => c.status === 'active').length;
  const salir = async () => { await supabase.auth.signOut(); };
  const item = (id: string, marca?: ReactNode) => {
    const e = entradaNav(id);
    return e ? <ItemRiel key={id} entrada={e} compacto={compacto} marca={marca} alNavegar={alNavegar} /> : null;
  };
  return (
    <div className="flex h-full flex-col gap-1 p-3">
      <Link to="overview" onClick={alNavegar} className={cn('mb-2 flex h-12 items-center px-1', compacto && 'justify-center px-0')} aria-label={MARCA.nombre}>
        <Marca compacta={compacto} />
      </Link>
      <SelectorOrg compacto={compacto} />
      <nav aria-label="Módulos" className="mt-2 flex flex-col gap-0.5">
        {item('overview')}
        <Rotulo texto="Tu ecosistema" compacto={compacto} />
        {NAV.filter((n) => n.grupo === 'ecosistema').map((n) => item(n.id, 'modulo' in n ? <MarcaModulo org={org.id} modulo={n.modulo} /> : null))}
        <Rotulo texto="Respuesta" compacto={compacto} />
        {item('audit')}
        {item('evolution')}
        {item('incidents', <MarcaNumero n={overview.data?.open_incidents} rojo />)}
        {item('export')}
      </nav>
      <div className="flex-1" />
      <nav aria-label="Cuenta" className="flex flex-col gap-0.5">
        {item('connections', activas === 0 ? <MarcaNumero n={1} rojo /> : null)}
        {item('settings')}
      </nav>
      <div className={cn('mt-2 flex flex-col gap-1 border-t pt-3', compacto && 'items-center')}>
        <span className={cn('flex items-center gap-1.5 px-1 text-[12.5px] tabular-nums', overview.isError ? 'text-mal' : 'text-texto-3')}
          title="Hora del último resumen bueno">
          <Clock className="size-3.5" />{cuando(overview.dataUpdatedAt || null)}
        </span>
        {compacto ? null : <div className="flex items-center gap-2 px-1">
          <span className="flex-1 truncate text-sm">{org.me.user.email ? <bdi dir="ltr">{sinBidi(org.me.user.email)}</bdi> : 'Invitado · demo'}</span>
          <Etiqueta texto={deMapa(ROL_TEXTO, org.role, '—')} rol={org.role === 'owner' || org.role === 'admin' ? 'info' : 'neutra'} />
        </div>}
        <Button variant="fantasma" size="fila" onClick={salir} className={cn('justify-start text-muted-foreground', compacto && 'size-11 justify-center px-0')} aria-label="Cerrar sesión">
          <LogOut />{compacto ? null : 'Cerrar sesión'}
        </Button>
      </div>
    </div>
  );
}

function FilaEstado({ overview, fallos, sinConexiones }: { overview: UseQueryResult<Overview>; fallos: number; sinConexiones: boolean }) {
  const org = useOrg();
  const critico = overview.data?.ahora.find((a) => a.kind === 'incident' && a.severity === 'critical');
  let contenido: ReactNode = null;
  if (critico) contenido = (
    <div className="flex flex-wrap items-center gap-3 border-b border-mal-borde bg-mal-relleno px-4 py-2.5 text-mal md:px-6">
      <Siren className="size-5 shrink-0" />
      <span className="flex-1 text-sm font-semibold">Incidente crítico en curso: {sinBidi(critico.title)}</span>
      {/* Absoluta y codificada, como FilaAhora: un id con «../», «?» o «#» no cambia de org, de ruta ni de query. */}
      <Link to={`/o/${org.id}/incidents/${encodeURIComponent(critico.id)}`} className="text-sm font-semibold underline underline-offset-4">Ver ahora</Link>
    </div>
  );
  else if (fallos >= 2) contenido = (
    <div className="flex flex-wrap items-center gap-3 border-b bg-muted px-4 py-2.5 md:px-6">
      <WifiOff className="size-5 shrink-0 text-mal" />
      <span className="flex-1 text-sm font-medium">Sin conexión con VanGUARD</span>
      <Button variant="secundaria" size="fila" onClick={() => overview.refetch()}>Reintentar</Button>
    </div>
  );
  else if (sinConexiones) contenido = (
    <div className="flex flex-wrap items-center gap-3 border-b bg-info-relleno px-4 py-2.5 md:px-6">
      <TriangleAlert className="size-5 shrink-0 text-info" />
      <span className="flex-1 text-sm font-medium">Conecta tu primer servicio</span>
      <Link to="connections" className="text-sm font-semibold text-foreground underline underline-offset-4">Conectar</Link>
    </div>
  );
  return <div role="status" aria-live="polite">{contenido}</div>;
}

export default function AppShell() {
  const org = useOrg();
  const loc = useLocation();
  const overview = useOverview(org.id);
  const conexiones = useConexiones(org.id);
  const fallos = useFallosSeguidos(overview);
  const [compacto, setCompacto] = useState(() => { try { return localStorage.getItem(CLAVE_RIEL) === 'icono'; } catch { return false; } });
  const [movilAbierto, setMovilAbierto] = useState(false);

  const segmento = loc.pathname.split('/')[3] ?? 'overview';
  const vista = entradaNav(segmento)?.nombre ?? (segmento === 'findings' ? 'Hallazgo' : 'Resumen');   // /findings/:id no está en NAV
  const abiertos = overview.data?.open_incidents ?? 0;
  useEffect(() => { document.title = `${abiertos > 0 ? `(${abiertos}) ` : ''}${MARCA.nombre} · ${vista}`; }, [abiertos, vista]);
  useEffect(() => () => { document.title = MARCA.nombre; }, []);

  const alternar = useCallback(() => {
    if (window.matchMedia('(min-width: 768px)').matches) setCompacto((c) => {
      try { localStorage.setItem(CLAVE_RIEL, c ? 'ancho' : 'icono'); } catch { /* sin almacenamiento */ }
      return !c;
    });
    else setMovilAbierto((a) => !a);
  }, []);
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); alternar(); } };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [alternar]);

  // «g» + letra y Ctrl+K (P1, §14.5). La lógica pura vive en lib/atajos.ts; aquí solo el temporizador de la «g».
  const navegar = useNavigate();
  const [paleta, setPaleta] = useState(false);
  const irA = useCallback((id: IdNav) => navegar(`/o/${org.id}/${id}`), [navegar, org.id]);
  useEffect(() => {
    let pendiente = false;
    let reloj: ReturnType<typeof setTimeout> | undefined;
    const tecla = (e: KeyboardEvent) => {
      if (paleta || e.defaultPrevented) return;                               // la paleta maneja sus propias teclas
      const r = leerTecla(e, pendiente);
      clearTimeout(reloj);
      pendiente = r.gPendiente;
      if (pendiente) reloj = setTimeout(() => { pendiente = false; }, ESPERA_G_MS);
      if (r.accion?.tipo === 'paleta') { e.preventDefault(); setPaleta(true); }
      else if (r.accion?.tipo === 'ir') { e.preventDefault(); irA(r.accion.destino); }
    };
    window.addEventListener('keydown', tecla);
    return () => { clearTimeout(reloj); window.removeEventListener('keydown', tecla); };
  }, [paleta, irA]);

  const usoIA = useUsoIA(org.id, org.puedeEscribir);   // misma consulta que ChipGastoIA (se comparte por clave)
  return (
    <div className="flex min-h-svh bg-background">
      <aside className={cn('sticky top-0 hidden h-svh shrink-0 border-r bg-sidebar transition-[width] md:block', compacto ? 'w-[4.5rem]' : 'w-60')}>
        <Riel compacto={compacto} overview={overview} />
      </aside>
      <Sheet open={movilAbierto} onOpenChange={setMovilAbierto}>
        <SheetContent side="left">
          <SheetTitle className="sr-only">Menú</SheetTitle>
          <SheetDescription className="sr-only">Módulos de VanGUARD</SheetDescription>
          <Riel compacto={false} overview={overview} alNavegar={() => setMovilAbierto(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-3 backdrop-blur md:px-4">
          <Button variant="fantasma" size="icono" onClick={alternar} aria-label="Mostrar u ocultar el menú (Ctrl+B)"><PanelLeft className="size-5" /></Button>
          <h1 className="flex-1 truncate text-[17px] font-semibold">{vista}</h1>
          <Button variant="fantasma" size="icono" onClick={() => setPaleta(true)} aria-label="Ir a una pantalla (Ctrl+K)" title="Ir a… (Ctrl+K)">
            <Search className="size-5" />
          </Button>
          {org.puedeEscribir ? null : <Etiqueta texto="Demo · solo lectura" rol="info" />}
          {/* «IA en pausa» no trae acción al lado: neutra (L3). La dice E5 (overview.ai) o, para admin, E28. */}
          {overview.data?.ai?.enabled === false || usoIA.data?.enabled === false ? <Etiqueta texto="IA en pausa" rol="neutra" /> : null}
          <ChipGastoIA org={org.id} puedeEscribir={org.puedeEscribir} />
        </header>
        <FilaEstado overview={overview} fallos={fallos} sinConexiones={conexiones.data?.length === 0} />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-6">
          <Outlet />
        </main>
      </div>
      <PaletaComandos abierta={paleta} onCambio={setPaleta} alIr={irA} />
    </div>
  );
}
