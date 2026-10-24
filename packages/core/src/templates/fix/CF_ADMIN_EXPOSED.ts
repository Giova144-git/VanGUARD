// CF_ADMIN_EXPOSED (A9.1, S11 11.10.2 y caso E8 de 11.14: la prueba debe pedir 401 o 403). En incidentes `resource`
// es la IP del atacante (`ip:…`): solo se nombra el host cuando `resource` es un dominio.
import { enCodigo, nombreEnCodigo } from '../titles.ts';
import type { HallazgoFix, PlantillaFix } from './index.ts';

const HOST = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/.*)?$/i;

export function plantilla(f: HallazgoFix): PlantillaFix {
  const host = f.resource.startsWith('ip:') ? null : HOST.exec(f.resource)?.[1] ?? null;
  const H = host ? nombreEnCodigo(host) : null;
  return {
    contexto: `Una ruta de administración de tu sitio${H ? ` ${H}` : ''} respondió con éxito a peticiones sin sesión: cualquiera puede entrar al panel o a su API.`,
    pasos: [
      'Exige sesión de administrador en el servidor para /admin y /api/admin/*: un middleware que responda 401 sin sesión y 403 sin rol de administrador.',
      'Como capa extra, protege esas rutas con Cloudflare Access o con una regla de WAF que solo deje pasar a tu equipo.',
      'Si la IP que lo aprovechó sigue activa, bloquéala desde VanGUARD («Bloquear IP», con confirmación).',
      'Revisa los registros de la app por accesos indebidos a esas rutas.',
    ],
    prompt_para_tu_ia: 'Objetivo: que las rutas de administración de mi app (/admin y /api/admin/*) exijan sesión de administrador. Busca dónde se definen esas rutas y añade una comprobación en el servidor que responda 401 sin sesión y 403 sin rol de administrador, sin cambiar el comportamiento para administradores. No toques otras rutas. Muéstrame el diff y espera mi confirmación antes de desplegar. Para verificar, una petición sin sesión a /admin debe responder 401 o 403.',
    prueba_de_aceptacion: `Una petición sin sesión a /admin${H ? ` de ${H}` : ''} responde 401 o 403${host ? ` (por ejemplo, ${enCodigo(`curl -sI ${host}/admin`)})` : ''}.`,
  };
}
