// Port de KUADRA ui2/formato.dart (S14 §14.6), hora de Caracas UTC−4. Sin Intl.NumberFormat para miles.
export const SIN_DATO = '—', SEP = ' · ';
export const miles = (n?: number | null) => n == null || !Number.isFinite(n) ? SIN_DATO
  : (n < 0 ? '-' : '') + Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');       // 9.000
export const decimal = (x?: number | null, d = 1) => {                                                   // 0,2
  if (x == null || !Number.isFinite(x)) return SIN_DATO;
  const [e, f] = Math.abs(x).toFixed(d).split('.'); return (x < 0 ? '-' : '') + miles(Number(e)) + (f ? ',' + f : '');
};
export const pct = (p?: number | null) => p == null ? SIN_DATO : `${miles(p)} %`;                       // 90 %
export const usd = (x?: number | null) => x == null ? SIN_DATO : `${decimal(x, 2)} USD`;               // 0,42 USD
export function duracion(ms?: number | null) {                                                         // 344 ms · 5,0 s · 2 min 4 s
  if (ms == null || !Number.isFinite(ms)) return SIN_DATO; if (ms < 1000) return `${miles(ms)} ms`;
  const s = ms / 1000; if (s < 60) return `${decimal(s)} s`;
  const t = Math.round(s), m = Math.floor(t / 60);                                                      // redondear antes: nunca «1 min 60 s»
  return m < 60 ? `${m} min ${t % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
export function bytes(b?: number | null) {                                                             // 512 B · 1,4 MB
  if (b == null || !Number.isFinite(b)) return SIN_DATO; const u = ['B', 'KB', 'MB', 'GB']; let i = 0, x = b;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; } return i === 0 ? `${miles(x)} B` : `${decimal(x)} ${u[i]}`;
}
// CifraDato.unidad → formato (lo usa <Cifra/>): '%' pct · 'ms' duracion · 'bytes' bytes · 'h' `${n} h` · 'd' `${n} d`;
// sin unidad: decimales != null ? decimal(n, decimales) : miles(n); con `de`: «6 de 6».
export function cifra(c: { n: number | null; de?: number; unidad?: '%' | 'ms' | 'bytes' | 'h' | 'd'; decimales?: number }) {
  if (c.n == null) return SIN_DATO;
  const v = c.unidad === '%' ? pct(c.n) : c.unidad === 'ms' ? duracion(c.n) : c.unidad === 'bytes' ? bytes(c.n)
    : c.unidad === 'h' ? `${miles(c.n)} h` : c.unidad === 'd' ? `${miles(c.n)} d`
    : c.decimales != null ? decimal(c.n, c.decimales) : miles(c.n);
  return c.de != null ? `${v} de ${miles(c.de)}` : v;
}
// Un solo formato de hora en toda la app (UX P1-13), en hora de Caracas (UTC−4, sin horario de verano): «hoy 04:46»,
// «ayer 23:32», «24-oct 23:32» y, de otro año, «24-oct-2025 23:32». La fecha completa con la zona, en horaCompleta().
const hhmm = new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', hour12: false });
const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' });
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fecha = (t?: string | Date | number | null) => {
  if (t == null || t === '' || t === 0) return null;
  const d = t instanceof Date ? t : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
};
export function cuando(t?: string | Date | number | null, ahora = new Date()) {
  const d = fecha(t);
  if (!d) return SIN_DATO;
  const dia = ymd.format(d), hora = hhmm.format(d);
  if (dia === ymd.format(ahora)) return `hoy ${hora}`;
  if (dia === ymd.format(new Date(ahora.getTime() - 86_400_000))) return `ayer ${hora}`;
  const [y, m, dd] = dia.split('-');
  return `${dd}-${MESES[Number(m) - 1] ?? m}${y === ymd.format(ahora).slice(0, 4) ? '' : `-${y}`} ${hora}`;
}
const larga = new Intl.DateTimeFormat('es-VE', { timeZone: 'America/Caracas', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
/** Para el tooltip de una hora: «domingo, 25 de octubre de 2026, 04:46 · hora de Caracas (UTC−4)». */
export const horaCompleta = (t?: string | Date | number | null) => { const d = fecha(t); return d ? `${larga.format(d)} · hora de Caracas (UTC−4)` : undefined; };
// «hace un momento» · «hace 5 min» · «hace 3 h» · «hace 2 d».
export function hace(t?: string | Date | number | null, ahora = new Date()) {
  if (t == null) return SIN_DATO;
  const min = Math.floor((ahora.getTime() - new Date(t).getTime()) / 60_000);
  if (!Number.isFinite(min)) return SIN_DATO;
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d`;
}
export const cronometro = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };      // 01:12
