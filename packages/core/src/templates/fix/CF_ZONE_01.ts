// CF_ZONE_01 (S08 08.7, P0): zona pausada → Cloudflare solo resuelve DNS, sin proxy ni WAF. Corrección: reactivarla.
// resource = 'cf:<zona>:zone', evidence = {setting, value, expected}. Sin cabeceras ni tokens en el texto.
import { enCodigo, nombreEnCodigo } from '../titles.ts';
import type { HallazgoFix, PlantillaFix } from './index.ts';

const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export function plantilla(f: HallazgoFix): PlantillaFix {
  const zona = /^cf:([^:]+):zone$/.exec(f.resource)?.[1] ?? '';
  const Z = HOST.test(zona) ? nombreEnCodigo(zona) : 'de Cloudflare';
  const api = 'https://api.cloudflare.com/client/v4/zones/<zone_id>';
  return {
    contexto: `Tu zona ${Z} está pausada: Cloudflare solo resuelve el DNS y el tráfico llega directo a tu servidor, sin proxy, sin WAF, sin caché y sin tus reglas de bloqueo (tampoco las de VanGUARD).`,
    pasos: [
      `En el panel de Cloudflare abre la zona ${Z} y, en su página de resumen (Overview), reactiva Cloudflare en el sitio desde las acciones avanzadas.`,
      `O por la API: PATCH a ${api} con el cuerpo ${enCodigo('{"paused": false}')}, usando un token con permiso de edición de la zona.`,
      'Comprueba que los registros web (@, www, app, api) tienen el proxy activo (nube naranja).',
      'Vuelve a auditar con VanGUARD.',
    ],
    prompt_para_tu_ia: `Objetivo: reactivar el proxy de Cloudflare en mi zona ${Z}, que está pausada. Guíame paso a paso para reanudarla en el panel de Cloudflare (o con un PATCH a la API de zonas con paused = false) sin cambiar ningún otro ajuste. Si este repositorio guarda configuración de Cloudflare (por ejemplo wrangler.jsonc o Terraform), revisa que no fije la zona como pausada y muéstrame el diff antes de cambiar nada. Para verificar, la API de la zona debe devolver "paused": false.`,
    prueba_de_aceptacion: `${enCodigo(`GET ${api}`)} devuelve ${enCodigo('"paused": false')} y el chequeo «Zona activa» de VanGUARD sale sin hallazgos.`,
  };
}
