// SB_RLS_DISABLED (S07 07.5.2 y 07.7; ejemplo de prompt de 07.7): tabla de public sin RLS y legible por anon.
import { partirRecurso, quoteIdent, quoteLiteral } from '../../rules/supabase.ts';
import { enCodigo, nombreEnCodigo } from '../titles.ts';
import type { HallazgoFix, PlantillaFix } from './index.ts';

const txt = (v: unknown) => (typeof v === 'string' ? v : '');
/** 34000 → «34.000» (separador de miles fijo: no depende del ICU del entorno). */
const miles = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

export function plantilla(f: HallazgoFix): PlantillaFix {
  const [esqR, tabR] = partirRecurso(f.resource);
  const esquema = txt(f.evidence.esquema) || esqR, tabla = txt(f.evidence.tabla) || tabR;
  const T = `${quoteIdent(esquema)}.${quoteIdent(tabla)}`;                 // {T} y {pol} de 07.5.2
  const pol = quoteIdent(`${tabla}_dueno_lee`);
  const n = typeof f.evidence.filas_estimadas === 'number' && f.evidence.filas_estimadas > 0 ? f.evidence.filas_estimadas : null;
  const R = nombreEnCodigo(`${esquema}.${tabla}`);
  const activar = `alter table ${T} enable row level security;`;
  const politica = `create policy ${pol} on ${T} for select to authenticated using ((select auth.uid()) = user_id);`;
  const revocar = `revoke select on ${T} from anon;`;
  const consulta = 'select c.relrowsecurity as rls_activa from pg_catalog.pg_class c join pg_catalog.pg_namespace n '
    + `on n.oid = c.relnamespace where n.nspname = ${quoteLiteral(esquema)} and c.relname = ${quoteLiteral(tabla)};`;
  return {
    contexto: `La tabla ${R} no tiene RLS y el rol anon puede leerla: cualquiera con la clave pública de tu app (la que va en el navegador) puede descargar todas sus filas${n !== null ? ` (≈ ${miles(n)})` : ''} sin iniciar sesión. Si activas RLS sin políticas, tu app deja de leer esa tabla: crea la política antes de desplegar.`,
    pasos: [
      'Crea una migración SQL nueva (no edites las anteriores).',
      `Activa RLS en la tabla: ${enCodigo(activar)}`,
      'Busca en tu código qué columna identifica al dueño de cada fila (aquí se usa user_id); si no existe, añádela antes de crear la política.',
      `Crea una política mínima para usuarios con sesión: ${enCodigo(politica)}`,
      `Si la tabla no debe leerse sin sesión, revoca el acceso de anon: ${enCodigo(revocar)}`,
      'Aplica la migración primero en un entorno de pruebas y comprueba que tu app sigue leyendo la tabla con un usuario con sesión.',
    ],
    prompt_para_tu_ia: `Eres el asistente de código de mi proyecto. Mi base de Supabase tiene la tabla ${R} con RLS desactivada y legible por el rol \`anon\`${n !== null ? ` (unas ${miles(n)} filas)` : ''}. Tarea: (1) crea una migración SQL nueva que active RLS en ${R} (${enCodigo(activar)}); (2) busca en el código las consultas a ${nombreEnCodigo(tabla)} para saber qué columna identifica al dueño de cada fila y crea políticas mínimas con \`(select auth.uid())\`; (3) si la tabla no debe leerse sin sesión, revoca \`select\` a \`anon\`; (4) no borres datos ni toques otras tablas o políticas. Muéstrame el diff y espera mi confirmación antes de aplicar la migración. Prueba de aceptación: esta consulta debe devolver \`rls_activa = true\` para ${R} y la app debe seguir funcionando para un usuario con sesión: ${enCodigo(consulta)}`,
    prueba_de_aceptacion: `Esta consulta debe devolver rls_activa = true: ${enCodigo(consulta)}`,
    sql: [
      activar,
      '-- política mínima: cada usuario ve solo sus filas (cambia user_id por tu columna de dueño)',
      `create policy ${pol} on ${T} for select to authenticated`,
      '  using ((select auth.uid()) = user_id);',
      '-- si la tabla no debe leerse sin sesión:',
      revocar,
    ].join('\n'),
  };
}
