// «Gasto IA hoy» en la barra superior (PLAN #13, E28). Solo owner y admin: el viewer no ve gastos y ni siquiera se pide.
// Cambia de color con `level` (escalera del Canon §8). El ámbar y el rojo llevan su acción: el chip abre Ajustes → IA
// (L3). Si E28 aún da 404 o falla, no se pinta nada.
import { Link } from 'react-router';
import type { AiUsage } from '@vanguard/contracts';
import { useUsoIA } from '@/lib/consultas';
import { usd } from '@/lib/formato';
import { TINTE, deMapa, type Rol } from '@/lib/severidad';
import { cn } from '@/lib/utils';

const NIVEL: Record<AiUsage['level'], { texto: string; rol: Rol }> = {
  normal: { texto: 'normal', rol: 'neutra' },
  reduced: { texto: 'síntesis con Sonnet', rol: 'aviso' },
  minimal: { texto: 'solo Haiku', rol: 'aviso' },
  off: { texto: 'apagada', rol: 'mal' },
};

export function ChipGastoIA({ org, puedeEscribir }: { org: string; puedeEscribir: boolean }) {
  const q = useUsoIA(org, puedeEscribir);
  if (!puedeEscribir || !q.data) return null;
  const u = q.data;
  const n = deMapa(NIVEL, u.level, { texto: '—', rol: 'neutra' });
  return (
    <Link to={`/o/${org}/settings#ia`} data-info="gasto-ia" aria-label={`Gasto de IA hoy: ${usd(u.today_usd)} de ${usd(u.cap_usd)} · IA ${n.texto}. Ver en Ajustes`}
      className={cn('inline-flex h-6 shrink-0 items-center gap-1 rounded-lg border px-2 font-mono text-[12.5px] font-medium tracking-[0.08em] uppercase outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring',
        deMapa(TINTE, n.rol, TINTE.neutra))}>
      <span className="sm:hidden">IA {usd(u.today_usd)}</span>
      <span className="hidden sm:inline">Gasto IA hoy · {usd(u.today_usd)} de {usd(u.cap_usd)}</span>
    </Link>
  );
}
