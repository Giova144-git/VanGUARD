// Historial de fallas (E13h/E13t, 0025_historial_hallazgos.sql): textos de estados e hitos y los filtros de la vista.
// Todo texto fijo; las fechas pasan por lib/formato.ts y nunca se pintan como HTML.
import type { FindingEvent, FindingEventKind, FindingHistoryItem, FindingStatus, FixRequestClient, Module, Severity } from '@vanguard/contracts';
import type { Rol } from './severidad';

export const ESTADO_FALLA: Readonly<Record<FindingStatus, { texto: string; rol: Rol }>> = {
  open: { texto: 'Abierta', rol: 'aviso' }, fixed: { texto: 'Corregida', rol: 'neutra' },
  verified: { texto: 'Verificada ✓', rol: 'bien' }, ignored: { texto: 'Ignorada', rol: 'neutra' },
};

export const EVENTO_FALLA: Readonly<Record<FindingEventKind, { texto: string; rol: Rol }>> = {
  detectado: { texto: 'Detectada', rol: 'mal' },
  enviado_ia: { texto: 'Enviada a tu IA', rol: 'info' },
  arreglando: { texto: 'Tu IA empezó a arreglarla', rol: 'info' },
  envio_cancelado: { texto: 'Envío a tu IA cancelado', rol: 'neutra' },
  corregido: { texto: 'Marcada corregida', rol: 'bien' },
  verificado: { texto: 'Una auditoría verificó que ya no está', rol: 'bien' },
  salio: { texto: 'Una auditoría ya no la vio', rol: 'bien' },
  ignorado: { texto: 'Ignorada', rol: 'neutra' },
  reaparecido: { texto: 'Reapareció', rol: 'mal' },
  visto: { texto: 'Vista por última vez', rol: 'neutra' },
};
const CLIENTE: Readonly<Record<FixRequestClient, string>> = { claude_code: 'por Claude Code', vscode: 'por VS Code', copiar: 'copiando el prompt' };
export const detalleEvento = (e: Pick<FindingEvent, 'kind' | 'client'>) =>
  e.kind === 'enviado_ia' && e.client && Object.hasOwn(CLIENTE, e.client) ? CLIENTE[e.client] : null;

// Filtros de la vista (valor '' = todos).
export type FiltroEstado = FindingStatus | '';
export const ESTADOS_FILTRO: [FiltroEstado, string][] = [['', 'Todas'], ['open', 'Abiertas'], ['fixed', 'Corregidas'],
  ['verified', 'Verificadas'], ['ignored', 'Ignoradas']];
export const MODULOS_FILTRO: [Module | '', string][] = [['', 'Todos'], ['supabase', 'Supabase'], ['cloudflare', 'Cloudflare'],
  ['codebase', 'Codebase'], ['performance', 'Rendimiento']];
export const SEVERIDADES_FILTRO: [Severity | '', string][] = [['', 'Todas'], ['critical', 'Crítica'], ['high', 'Alta'],
  ['medium', 'Media'], ['low', 'Baja'], ['info', 'Info']];
export const esFiltro = <T extends string>(opciones: [T, string][], v: unknown): v is T => opciones.some(([x]) => x === v);

/** Cuándo dejó de estar abierta (marcada o verificada, lo primero), o null. */
export const resueltaEn = (f: Pick<FindingHistoryItem, 'fixed_at' | 'verified_at'>) => f.fixed_at ?? f.verified_at;

const ms = (t: string | null | undefined) => (t ? Date.parse(t) : Number.NaN);
/** ¿Apareció dentro de los últimos `dias`? (las «nuevas» del periodo de Evolución) */
export const nuevaEnPeriodo = (f: Pick<FindingHistoryItem, 'first_seen_at' | 'reopened_at'>, dias: number, ahora = Date.now()) =>
  [f.first_seen_at, f.reopened_at].some((t) => ms(t) >= ahora - dias * 86_400_000);
/** ¿Se corrigió dentro de los últimos `dias` y sigue sin estar abierta? (las «corregidas» del periodo) */
export const corregidaEnPeriodo = (f: Pick<FindingHistoryItem, 'status' | 'fixed_at' | 'verified_at'>, dias: number, ahora = Date.now()) =>
  (f.status === 'fixed' || f.status === 'verified') && ms(resueltaEn(f)) >= ahora - dias * 86_400_000;
