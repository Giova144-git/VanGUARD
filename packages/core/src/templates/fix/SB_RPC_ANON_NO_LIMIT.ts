// SB_RPC_ANON_NO_LIMIT (S07 07.5.4 y 07.7): función de public ejecutable por anon, VOLATILE y sin pgrst.db_pre_request.
// Opción A literal (revocar a public y anon, porque anon lo hereda de public). La opción B (LIMITADOR_PRE_REQUEST de
// R03 §9.5) no llegó al repo: sale solo el enlace a la guía oficial, como prevé 07.5.4.
import { partirRecurso, quoteIdent, quoteLiteral } from '../../rules/supabase.ts';
import { enCodigo, nombreEnCodigo } from '../titles.ts';
import type { HallazgoFix, PlantillaFix } from './index.ts';

export const GUIA_LIMITADOR = 'https://supabase.com/docs/guides/api/securing-your-api';
/** `args` viene de pg_get_function_identity_arguments (SQL 3b), que ya cita los nombres raros. Aun así, si trae algo
 *  que pueda cerrar la sentencia, se omite la lista (Postgres acepta el nombre solo si no hay sobrecargas). */
const argsSeguros = (a: unknown): string | null =>
  typeof a === 'string' && a.length <= 500 && !/[;\r\n]|--|\/\*/.test(a) ? a : null;

export function plantilla(f: HallazgoFix): PlantillaFix {
  const [esquema, fnR] = partirRecurso(f.resource);
  const funcion = typeof f.evidence.funcion === 'string' && f.evidence.funcion ? f.evidence.funcion : fnR;
  const otras = Array.isArray(f.evidence.otras_firmas) ? f.evidence.otras_firmas : [];
  const firmas = 'args' in f.evidence ? [f.evidence.args, ...otras].map(argsSeguros) : [null];
  const objetivo = (a: string | null) => `${quoteIdent(esquema)}.${quoteIdent(funcion)}${a === null ? '' : `(${a})`}`;
  const objetivos = [...new Set(firmas.map(objetivo))];
  const revocar = objetivos.map((o) => `revoke execute on function ${o} from public, anon;`);
  const conceder = objetivos.map((o) => `grant execute on function ${o} to authenticated;`);
  const R = nombreEnCodigo(`${esquema}.${funcion}`);
  const definer = f.evidence.definer === true;
  const consulta = 'select p.oid::regprocedure as firma, pg_catalog.has_function_privilege(\'anon\', p.oid, \'EXECUTE\') as anon_puede '
    + 'from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace '
    + `where n.nspname = ${quoteLiteral(esquema)} and p.proname = ${quoteLiteral(funcion)};`;
  return {
    contexto: `${R} se puede llamar sin iniciar sesión por ${nombreEnCodigo(`/rest/v1/rpc/${funcion}`)} y la base no tiene ningún freno de peticiones${definer ? '; además corre con SECURITY DEFINER y se salta RLS' : ''}. Cualquiera puede dispararla en bucle: envíos, cobros o cambios masivos a tu costa.`,
    pasos: [
      'Crea una migración SQL nueva (no edites las anteriores).',
      `Si la función no debe ser pública, revoca el permiso a public y anon (anon lo hereda de public): ${revocar.map(enCodigo).join(' ')}`,
      `Da permiso solo a usuarios con sesión: ${conceder.map(enCodigo).join(' ')}`,
      `Si debe seguir pública, añade un limitador con pgrst.db_pre_request (techo sugerido: envíos y códigos 5 por minuto, dinero 12, resto 60) siguiendo ${GUIA_LIMITADOR}`,
      'Antes de aplicar, revisa qué partes de tu app la llaman sin sesión.',
    ],
    prompt_para_tu_ia: `Objetivo: que la función ${R} de mi proyecto de Supabase no se pueda llamar sin sesión ni sin límite. Crea una migración SQL nueva que revoque EXECUTE sobre ${objetivos.map(enCodigo).join(', ')} a public y anon y lo conceda a authenticated. Busca en el código las llamadas a ${enCodigo(`rpc('${funcion}')`)} y dime si alguna se hace sin sesión; si la función debe seguir pública, propón en su lugar un limitador con pgrst.db_pre_request según ${GUIA_LIMITADOR}. No toques otras funciones ni datos. Muéstrame el diff y espera mi confirmación antes de aplicar la migración. Para verificar, la consulta de la prueba de aceptación debe devolver anon_puede = false en todas sus filas.`,
    prueba_de_aceptacion: `Esta consulta debe devolver anon_puede = false en todas sus filas (si la función sigue pública con limitador, VanGUARD deja de marcarla en la siguiente auditoría): ${enCodigo(consulta)}`,
    sql: ['-- Opción A (la función no debe ser pública): revoca a public y anon y concede solo a authenticated',
      ...revocar, ...conceder,
      `-- Opción B (debe seguir pública): limitador con pgrst.db_pre_request, guía oficial: ${GUIA_LIMITADOR}`].join('\n'),
  };
}
