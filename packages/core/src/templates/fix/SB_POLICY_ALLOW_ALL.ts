// SB_POLICY_ALLOW_ALL (S07 07.5.3 y 07.7): política `using (true)` / `with check (true)` para anon o public.
// La cláusula depende de `cmd`: Postgres rechaza `using` en políticas INSERT, así que se emite solo la variante que toca.
import { partirRecurso, quoteIdent, quoteLiteral } from '../../rules/supabase.ts';
import { enCodigo, nombreEnCodigo } from '../titles.ts';
import type { HallazgoFix, PlantillaFix } from './index.ts';

const CMDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL']);
const DUENO = '((select auth.uid()) = user_id)';

export function plantilla(f: HallazgoFix): PlantillaFix {
  const [esquema, tabla] = partirRecurso(f.resource);
  const policyname = typeof f.evidence.policyname === 'string' ? f.evidence.policyname : '';
  const c = typeof f.evidence.cmd === 'string' ? f.evidence.cmd.toUpperCase() : '';
  const cmd = CMDS.has(c) ? c : 'ALL';                                   // desconocido → la variante más estricta
  const T = `${quoteIdent(esquema)}.${quoteIdent(tabla)}`;
  const cabeza = `create policy ${quoteIdent(`${tabla}_dueno`)} on ${T} for ${cmd.toLowerCase()} to authenticated`;
  const clausula = cmd === 'INSERT' ? `with check ${DUENO}`
    : cmd === 'SELECT' || cmd === 'DELETE' ? `using ${DUENO}` : `using ${DUENO} with check ${DUENO}`;
  const borrar = `drop policy ${quoteIdent(policyname)} on ${T};`;
  const crear = `${cabeza} ${clausula};`;
  const verbo = cmd === 'SELECT' ? 'leer' : 'modificar';
  const R = nombreEnCodigo(`${esquema}.${tabla}`), P = nombreEnCodigo(policyname);
  const consulta = `select policyname from pg_catalog.pg_policies where schemaname = ${quoteLiteral(esquema)} and tablename = ${quoteLiteral(tabla)} and (qual = 'true' or with_check = 'true') and ('anon' = any(roles) or 'public' = any(roles));`;
  return {
    contexto: `La regla ${P} deja a cualquiera ${verbo} todas las filas de ${R} sin iniciar sesión: RLS está activa, pero esa política no protege nada. Si la tabla es un catálogo público a propósito (por ejemplo, precios), puedes ignorar el hallazgo indicando el motivo.`,
    pasos: [
      'Crea una migración SQL nueva (no edites las anteriores).',
      `Quita la política pase-todo: ${enCodigo(borrar)}`,
      `Crea una política mínima para usuarios con sesión (cambia user_id por tu columna de dueño): ${enCodigo(crear)}`,
      `Comprueba en un entorno de pruebas que cada usuario solo puede ${verbo} sus propias filas.`,
    ],
    prompt_para_tu_ia: `Objetivo: cerrar la política ${P} de ${R}, que deja a cualquiera ${verbo} todas sus filas sin sesión. Busca en el código las consultas a ${nombreEnCodigo(tabla)} para saber qué columna identifica al dueño de cada fila. Crea una migración SQL nueva que quite esa política con drop policy y cree en su lugar una política ${cmd} para authenticated basada en (select auth.uid()). No borres datos ni toques otras tablas. Muéstrame el diff y espera mi confirmación antes de aplicar la migración. Para verificar, la consulta de la prueba de aceptación no debe devolver filas.`,
    prueba_de_aceptacion: `Esta consulta no debe devolver filas: ${enCodigo(consulta)}`,
    sql: [borrar, '-- política mínima: cada usuario solo sus filas (cambia user_id por tu columna de dueño)', cabeza,
      `  ${clausula};`].join('\n'),
  };
}
