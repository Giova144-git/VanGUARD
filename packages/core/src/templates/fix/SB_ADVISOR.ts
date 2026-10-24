// SB_ADVISOR_* genérica (S07 07.7): sin SQL; la guía oficial del lint (`remediation`) como paso y «el lint desaparece
// de advisors» como prueba. El `detail` de Supabase no se interpola: queda en el bloque de evidencia cercado.
// Variantes para el duplicado de SB_RLS_DISABLED (anti-doble conteo de 07.5) y para rls_enabled_no_policy (demo, 07.9).
import { nombreEnCodigo } from '../titles.ts';
import type { HallazgoFix, PlantillaFix } from './index.ts';

const GUIA_LINTER = 'https://supabase.com/docs/guides/database/database-linter';
const GUIA_SUPABASE = /^https:\/\/supabase\.com\/docs\/[A-Za-z0-9/_.#?=&%-]*$/;
const NIVELES = new Set(['ERROR', 'WARN', 'INFO']);

export function plantilla(f: HallazgoFix): PlantillaFix {
  const ev = f.evidence;
  const lintEv = typeof ev.lint === 'string' && /^[a-z0-9_]+$/.test(ev.lint) ? ev.lint : '';
  const lint = lintEv || f.rule_id.replace(/^SB_ADVISOR_/, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  const nivel = typeof ev.nivel === 'string' && NIVELES.has(ev.nivel) ? ev.nivel : null;
  const guia = typeof ev.remediacion === 'string' && GUIA_SUPABASE.test(ev.remediacion) ? ev.remediacion : GUIA_LINTER;
  const L = nombreEnCodigo(lint);
  const obj = f.resource && f.resource !== 'proyecto' ? nombreEnCodigo(f.resource) : 'tu proyecto';
  const prueba = `El lint ${L} de ${obj} desaparece de los advisors de Supabase en la siguiente auditoría.`;

  if (typeof ev.duplicado_de === 'string' && /^SB_[A-Z0-9_]+$/.test(ev.duplicado_de)) return {
    contexto: `Los advisors de Supabase (lint ${L}${nivel ? `, nivel ${nivel}` : ''}) marcan ${obj}. Es el mismo problema que el hallazgo ${ev.duplicado_de}: al corregir aquel, este desaparece.`,
    pasos: [`Aplica la corrección del hallazgo ${ev.duplicado_de} para ${obj}.`, 'Vuelve a auditar con VanGUARD.'],
    prompt_para_tu_ia: `Objetivo: corregir ${obj}, que los advisors de Supabase marcan con el lint ${L}. Es el mismo arreglo que el hallazgo ${ev.duplicado_de}: ${ev.duplicado_de === 'SB_RLS_DISABLED' ? `crea una migración SQL nueva que active RLS en ${obj} y añada una política de select para authenticated basada en (select auth.uid())` : 'aplica la corrección de ese hallazgo con el cambio mínimo y reversible'}. No borres datos ni toques otras tablas. Muéstrame el diff y espera mi confirmación antes de aplicar la migración. Para verificar, el lint ${L} debe desaparecer de los advisors de Supabase.`,
    prueba_de_aceptacion: prueba,
  };

  if (lint === 'rls_enabled_no_policy') return {
    contexto: `Los advisors de Supabase (lint ${L}${nivel ? `, nivel ${nivel}` : ''}) avisan de que ${obj} tiene RLS activa pero ninguna política: nadie puede leerla ni escribirla por la API, ni siquiera con sesión.`,
    pasos: [
      `Decide si tu app necesita leer o escribir ${obj} por la API.`,
      'Si la necesita, crea en una migración nueva una política explícita para authenticated basada en (select auth.uid()).',
      'Si es una tabla interna, déjala así e ignora el hallazgo indicando el motivo.',
      `Consulta la guía oficial del lint: ${guia}`,
    ],
    prompt_para_tu_ia: `Objetivo: revisar ${obj}, que tiene RLS activa sin ninguna política. Busca en el código si la app la lee o la escribe por la API de Supabase. Si lo hace, crea una migración SQL nueva con la política mínima necesaria para authenticated basada en (select auth.uid()); si no, dímelo y no cambies nada. No desactives RLS ni toques otras tablas. Muéstrame el diff y espera mi confirmación antes de aplicar la migración. Para verificar, el lint ${L} debe desaparecer de los advisors de Supabase.`,
    prueba_de_aceptacion: prueba,
  };

  return {
    contexto: `Los advisors oficiales de Supabase (lint ${L}${nivel ? `, nivel ${nivel}` : ''}) marcan ${obj}. El detalle que da Supabase va en el bloque de evidencia de abajo.`,
    pasos: [
      `Lee la guía oficial del lint: ${guia}`,
      `Aplica el cambio mínimo que indica la guía para ${obj}: en una migración SQL nueva si es de la base, o en el panel de Supabase si es de configuración.`,
      'Vuelve a auditar con VanGUARD.',
    ],
    prompt_para_tu_ia: `Objetivo: corregir el aviso ${L} que los advisors de Supabase marcan en ${obj}. Lee la guía oficial (${guia}) y el detalle del bloque de evidencia, busca en el código y en las migraciones lo que lo provoca y propón el cambio mínimo y reversible en una migración SQL nueva. No desactives RLS ni toques otras tablas. Muéstrame el diff y espera mi confirmación antes de aplicar la migración. Para verificar, el lint ${L} debe desaparecer de los advisors de Supabase.`,
    prueba_de_aceptacion: prueba,
  };
}
