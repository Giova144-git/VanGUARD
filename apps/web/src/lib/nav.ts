// Orden fijo del riel (S14 §14.5): no se reordena por gravedad. id = segmento de ruta; descripción = guía en una línea.
import { Activity, BookOpen, Cloud, Database, Gauge, GitBranch, KeyRound, Settings, Share2, ShieldCheck, Siren } from 'lucide-react';

export const NAV = [
  { id: 'overview',    nombre: 'Resumen',        icono: Activity,    grupo: 'portada',    descripcion: 'Lo que está mal ahora en todo tu ecosistema y tu puntaje de blindaje.' },
  { id: 'supabase',    nombre: 'Supabase',       icono: Database,    grupo: 'ecosistema', modulo: 'supabase',    proveedor: 'supabase',   descripcion: 'Salud de tu base, tablas sin RLS, políticas abiertas y funciones sin freno.' },
  { id: 'cloudflare',  nombre: 'Cloudflare',     icono: Cloud,       grupo: 'ecosistema', modulo: 'cloudflare',  proveedor: 'cloudflare', descripcion: 'Quién te está atacando: IPs y user agents insistentes, escaneos y picos.' },
  { id: 'codebase',    nombre: 'Codebase',       icono: GitBranch,   grupo: 'ecosistema', modulo: 'codebase',    proveedor: 'github',     descripcion: 'Tu repo: .env subido, claves en tu configuración y dependencias con CVE.' },
  { id: 'wiki',        nombre: 'Wiki del repo',  icono: BookOpen,    grupo: 'ecosistema', descripcion: 'Tu repo explicado para un directivo: qué es, cómo funciona, sus piezas, el mapa y los riesgos.' },
  { id: 'performance', nombre: 'Rendimiento',    icono: Gauge,       grupo: 'ecosistema', modulo: 'performance', proveedor: null,         descripcion: 'Lighthouse de tu web, comparado con la medición anterior.' },
  { id: 'audit',       nombre: 'Auditoría',      icono: ShieldCheck, grupo: 'respuesta',  descripcion: 'Revisa todo el ecosistema con un botón.' },
  { id: 'incidents',   nombre: 'Incidentes',     icono: Siren,       grupo: 'respuesta',  descripcion: 'Ataques en vivo: aviso por WhatsApp y bloqueo de la IP aprobado desde el mismo mensaje.' },
  { id: 'export',      nombre: 'Llevar a tu IA', icono: Share2,      grupo: 'respuesta',  descripcion: 'Exporta hallazgos y prompts para cualquier IA, o conéctala por MCP.' },
  { id: 'connections', nombre: 'Conexiones',     icono: KeyRound,    grupo: 'pie',        descripcion: 'Tus tokens de solo lectura y tu repo.' },
  { id: 'settings',    nombre: 'Ajustes',        icono: Settings,    grupo: 'pie',        descripcion: 'A quién avisamos, por qué canal y el estado de la IA.' },
] as const;

export type EntradaNav = (typeof NAV)[number];
export type IdNav = EntradaNav['id'];

export const entradaNav = (id: string): EntradaNav | undefined => NAV.find((n) => n.id === id);
