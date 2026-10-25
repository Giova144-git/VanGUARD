// Vigía en el asistente de conexión: el recorrido de «Que Vigía me guíe» y lo que dice tras «Conectar y probar».
// Todo texto es fijo: del servidor solo se leen CÓDIGOS de permiso (PermCheck.permission, details.missing_permissions) y
// solo los que están en EXPLICA_PERMISO llegan a la burbuja (con su nombre de lib/permisos.ts); un código desconocido cae
// a una frase genérica. Ningún mensaje del servidor ni ningún token pasa por aquí.
// Cuándo habla tras una prueba: solo si ya está a la vista (lo decide quien llama con `guia.visible`). Pedir la guía la
// pone a la vista, así que quien la pidió en esta pantalla la oye; quien la despidió, no.
import type { PermCheck, Provider } from '@vanguard/contracts';
import type { Dicho } from '@/componentes/vigia/contexto';
import type { PasoTour } from '@/componentes/vigia/tours';
import { esApiError } from '@/lib/errores';
import { nombrePermiso } from '@/lib/permisos';

export const DURACION_BIEN_MS = 5000;

// Los data-guia que señala (los pinta Asistente.tsx). `conexion-paso-N` es el N-ésimo paso de GUIAS_CONEXION.
export const OBJETIVO = {
  enlace: 'conexion-enlace', proyecto: 'conexion-proyecto', zona: 'conexion-zona', repo: 'conexion-repo', nombre: 'conexion-nombre',
  modo: 'conexion-modo', url: 'conexion-url',
  token: 'conexion-token', accion: 'conexion-token-accion', probar: 'conexion-probar', error: 'conexion-error', permisos: 'conexion-permisos',
} as const;
export const objetivoPermiso = (codigo: string) => `permiso-${codigo}`;   // cada fila de ListaChecks

const PROBAR_LECTURA = 'Aquí se conecta y se prueba cada permiso. En la demo no puedes: lo hace un administrador.';

export const GUIA_VIGIA: Record<Provider, { titulo: string; pasos: readonly PasoTour[]; final: string }> = {
  supabase: { titulo: 'Conectar Supabase', pasos: [
    { objetivo: OBJETIVO.enlace, texto: 'Empieza aquí: abre tus tokens de acceso de Supabase en otra pestaña.' },
    { objetivo: 'conexion-paso-2', texto: '«Generate new token»: elige solo tu proyecto y marca en Read Project Settings, Advisors y Database. Nada en Read-write.' },
    { objetivo: OBJETIVO.proyecto, texto: 'Pega aquí la URL de tu proyecto, la que acaba en supabase.co, o su ref de 20 letras.' },
    { objetivo: OBJETIVO.token, texto: 'Y aquí el token, que empieza por sbp_fc. Después de guardarlo solo verás sus 4 últimos caracteres.' },
    { objetivo: OBJETIVO.probar, texto: 'Pulsa aquí: pruebo cada permiso y, si falta alguno, te digo cuál marcar.', textoLectura: PROBAR_LECTURA },
  ], final: 'Eso es todo. Si algo falla en la prueba, te lo explico.' },
  cloudflare: { titulo: 'Conectar Cloudflare', pasos: [
    { objetivo: OBJETIVO.enlace, texto: 'Abre tus API Tokens de Cloudflare y pulsa «Create Token» y luego «Create Custom Token».' },
    { objetivo: 'conexion-paso-2', texto: 'Permisos, todos Zone · Read: Zone, Zone Settings, DNS, Analytics, Firewall Services y Zone WAF. Y solo tu dominio.' },
    { objetivo: OBJETIVO.zona, texto: 'El Zone ID está en la página de tu dominio, en Overview, columna «API». Pégalo aquí.' },
    { objetivo: OBJETIVO.token, texto: 'Aquí va el token de lectura. Nunca te pediré la Global API Key.' },
    { objetivo: OBJETIVO.accion, texto: 'Este es opcional: un segundo token con Firewall Services · Edit para bloquear IPs cuando tú lo confirmes.' },
    { objetivo: OBJETIVO.probar, texto: 'Pulsa aquí: pruebo cada permiso y, si falta alguno, te digo cuál marcar.', textoLectura: PROBAR_LECTURA },
  ], final: 'Eso es todo. Si algo falla en la prueba, te lo explico.' },
  github: { titulo: 'Conectar GitHub', pasos: [
    { objetivo: OBJETIVO.enlace, texto: 'Este enlace abre GitHub con un token de 30 días y los permisos ya marcados.' },
    { objetivo: 'conexion-paso-2', texto: 'En Repository access elige «Only select repositories» y marca un solo repo.' },
    { objetivo: 'conexion-paso-3', texto: 'Comprueba que Contents y Metadata están en Read-only. Nada en Read and write.' },
    { objetivo: OBJETIVO.repo, texto: 'Escribe aquí el repo como owner/repo, o pega su URL.' },
    { objetivo: OBJETIVO.token, texto: 'Y aquí el token, que empieza por github_pat_. Uno por repo: el mismo no vale para dos.' },
    { objetivo: OBJETIVO.probar, texto: 'Pulsa aquí: pruebo cada permiso y, si falta alguno, te digo cuál marcar.', textoLectura: PROBAR_LECTURA },
  ], final: 'Eso es todo. Si algo falla en la prueba, te lo explico.' },
  ingest: { titulo: 'Conectar tu app', pasos: [
    { objetivo: OBJETIVO.nombre, texto: 'Ponle un nombre a esta conexión, el que te ayude a reconocer tu app.' },
    { objetivo: OBJETIVO.probar, texto: 'Al crearla te enseño un secreto una sola vez: cópialo y ponlo en tu app como VG_INGEST_SECRET.',
      textoLectura: 'Aquí se crea la conexión. En la demo no puedes: lo hace un administrador.' },
  ], final: 'Tu app firmará cada lote de eventos con ese secreto.' },
};

// Cloudflare en modo «Sitio» (por URL de Pages, Workers o dominio): sin Zone ID ni Modo blindaje. El asistente elige
// esta guía o la de GUIA_VIGIA.cloudflare (modo «Zona») según el modo que esté marcado al pedirla.
export const GUIA_VIGIA_CF_SITIO: { titulo: string; pasos: readonly PasoTour[]; final: string } = {
  titulo: 'Conectar Cloudflare', pasos: [
    { objetivo: OBJETIVO.modo, texto: 'Elige qué conectas: tu sitio por su URL, o la zona entera con su Zone ID si quieres bloquear IPs.' },
    { objetivo: OBJETIVO.url, texto: 'Pega la URL de tu sitio: la de Pages, la de Workers o tu dominio.' },
    { objetivo: OBJETIVO.token, texto: 'El token de cuenta es opcional: con él también reviso la configuración del proyecto. Sin él, reviso el sitio por HTTP.' },
    { objetivo: OBJETIVO.probar, texto: 'Pulsa aquí: compruebo que el sitio responde y, con token, cada permiso.', textoLectura: PROBAR_LECTURA },
  ], final: 'Eso es todo. Si algo falla en la prueba, te lo explico.',
};

// Qué marcar y para qué sirve, en llano, por código de permiso (los de lib/permisos.ts).
export const EXPLICA_PERMISO: Record<string, string> = {
  project_admin_read: 'Márcalo en Read: con él leo la configuración de tu proyecto.',
  advisors_read: 'Márcalo en Read: con él leo los avisos de seguridad que ya calcula Supabase.',
  database_read: 'Márcalo en Read: lo uso para revisar tus tablas y sus políticas RLS.',
  analytics_logs_read: 'Es opcional: con él miro los registros de tu proyecto.',
  auth_config_read: 'Es opcional: con él reviso cómo entra la gente a tu app.',
  zone_read: 'Sin él no veo tu zona: añádelo como Zone · Read.',
  zone_settings_read: 'Con él leo cómo está configurada tu zona: añádelo como Zone · Read.',
  dns_read: 'Con él reviso tus registros DNS: añádelo como Zone · Read.',
  analytics_read: 'Con él veo quién visita tu web: añádelo como Zone · Read.',
  firewall_read: 'Con él veo las reglas que frenan ataques: añádelo como Zone · Read.',
  waf_read: 'Con él reviso tu firewall de aplicaciones: añádelo como Zone · Read.',
  bot_read: 'Es opcional: con él veo el tráfico de bots.',
  firewall_edit: 'Va en el token de Modo blindaje, como Edit: es el que bloquea una IP cuando tú lo confirmas.',
  config_rules_edit: 'Va en el token de Modo blindaje, como Edit: activa el modo bajo ataque solo en el host atacado.',
  zone_settings_edit: 'Va en el token de Modo blindaje, como Edit: activa el modo bajo ataque en toda la zona.',
  'metadata:read': 'Ponlo en Read-only: es lo mínimo para que vea tu repo.',
  'contents:read': 'Ponlo en Read-only: con él leo los archivos de riesgo de tu repo.',
  'dependabot_alerts:read': 'Es opcional, en Read-only: con él leo las alertas de Dependabot.',
  'statuses:write': 'Ponlo en Read and write: con él marco el check de VanGUARD en tus commits.',
  'statuses:read': 'Ponlo en Read-only: con él leo los checks de tus commits.',
  'pull_requests:write': 'Ponlo en Read and write: con él cierro los PR con críticos.',
  'issues:write': 'Es opcional, en Read and write: con él creas issues desde el WhatsApp.',
};
const conocido = (c: string) => Object.hasOwn(EXPLICA_PERMISO, c);
const nombre = (c: string) => `«${nombrePermiso(c)}»`;

function faltan(codigos: readonly string[], opcionales: boolean, objetivo: (c: string) => Dicho['objetivo']): Dicho {
  const conocidos = codigos.filter(conocido);
  if (!conocidos.length) {
    return opcionales
      ? { titulo: 'Funciona, con un aviso', pose: 'pensar', objetivo: objetivo(''),
          texto: 'La conexión funciona, pero falta un permiso opcional. Mira la lista: si lo quieres, crea el token de nuevo marcándolo.' }
      : { titulo: 'Falta un permiso', pose: 'alerta', objetivo: objetivo(''),
          texto: 'Al token le falta un permiso. Mira la lista en rojo, crea el token de nuevo marcándolo y pégalo otra vez.' };
  }
  const c = conocidos[0]!;
  const mas = codigos.length > 1 ? ` Y ${codigos.length - 1 === 1 ? 'otro más' : `${codigos.length - 1} más`}: los tienes en la lista.` : '';
  return opcionales
    ? { titulo: 'Funciona, con un aviso', pose: 'pensar', objetivo: objetivo(c),
        texto: `La conexión funciona, pero falta ${nombre(c)}. ${EXPLICA_PERMISO[c]}${mas}` }
    : { titulo: 'Falta un permiso', pose: 'alerta', objetivo: objetivo(c),
        texto: `Al token le falta ${nombre(c)}. ${EXPLICA_PERMISO[c]} Crea el token de nuevo y pégalo otra vez.${mas}` };
}

/** Tras una prueba con resultado (alta con E8 o «Probar conexión» con E9): qué decir y a quién señalar.
 *  `objetivo(código)` da el elemento de ese permiso ('' = la lista entera). */
export function dichoDeChecks(checks: readonly PermCheck[], objetivo: (c: string) => Dicho['objetivo'] = (c) => (c ? objetivoPermiso(c) : OBJETIVO.permisos)): Dicho {
  const lista = Array.isArray(checks) ? checks.filter((c) => !!c && typeof c.permission === 'string') : [];
  const obligatorios = lista.filter((c) => !c.ok && c.required !== false).map((c) => c.permission);
  if (obligatorios.length) return faltan(obligatorios, false, objetivo);
  const opcionales = lista.filter((c) => !c.ok).map((c) => c.permission);
  if (opcionales.length) return faltan(opcionales, true, objetivo);
  return { titulo: '¡Conectado!', pose: 'celebrar', duracion: DURACION_BIEN_MS, objetivo: objetivo(''),
    texto: lista.length ? 'Probé cada permiso y todos están bien. Ya puedo revisar este servicio.' : '¡Listo! La conexión quedó guardada.' };
}

/** Tras un error de «Conectar y probar». Solo se mira el `code` del error y los códigos de `missing_permissions`. */
export function dichoDeError(e: unknown): Dicho {
  if (esApiError(e) && e.code === 'key_rejected')
    return { titulo: 'Esa clave no sirve', pose: 'alerta', objetivo: OBJETIVO.token,
      texto: 'Esa clave puede escribir o no es del tipo que pido. Crea un token nuevo de solo lectura con el enlace de los pasos.' };
  if (esApiError(e) && e.code === 'provider_rejected') {
    const d = e.details?.missing_permissions;
    const codigos = Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : [];
    if (codigos.length) return faltan(codigos, false, () => OBJETIVO.error);
    return { titulo: 'El proveedor dijo que no', pose: 'alerta', objetivo: OBJETIVO.error,
      texto: 'El proveedor no aceptó el token. Cópialo de nuevo con cuidado o crea uno nuevo, y revisa que sea del proyecto, la zona o el repo correctos.' };
  }
  if (esApiError(e) && e.code === 'invalid_body')
    return { titulo: 'Algo no cuadra', pose: 'pensar', objetivo: OBJETIVO.error,
      texto: 'Algún dato no tiene la forma que espero. Revisa lo que marqué en rojo y vuelve a probar.' };
  return { titulo: 'No pude terminar la prueba', pose: 'pensar', objetivo: OBJETIVO.probar,
    texto: 'No pude terminar la prueba. Espera un momento y vuelve a pulsar el botón.' };
}

// Rechazo local (pre-guardas), antes de que nada salga del navegador: señala el primer campo que falla.
type Campo = 'ref' | 'zona' | 'repo' | 'label' | 'token' | 'accion';
const RECHAZO_LOCAL: Record<Campo, Dicho> = {
  ref: { titulo: 'Revisa el proyecto', pose: 'pensar', objetivo: OBJETIVO.proyecto,
    texto: 'Pega la URL de tu proyecto, la que acaba en supabase.co, o su ref de 20 letras.' },
  zona: { titulo: 'Revisa el Zone ID', pose: 'pensar', objetivo: OBJETIVO.zona,
    texto: 'El Zone ID son 32 letras y números. Cópialo de Overview, columna «API», en la página de tu dominio.' },
  repo: { titulo: 'Revisa el repo', pose: 'pensar', objetivo: OBJETIVO.repo, texto: 'Escribe el repo como owner/repo o pega su URL de GitHub.' },
  label: { titulo: 'Revisa el nombre', pose: 'pensar', objetivo: OBJETIVO.nombre, texto: 'El nombre va de 2 a 40 caracteres.' },
  token: { titulo: 'Esa clave no sirve', pose: 'alerta', objetivo: OBJETIVO.token,
    texto: 'Esa clave no es un token de solo lectura del tipo que pido. Ni siquiera salió de tu navegador. Crea uno con el enlace de los pasos.' },
  accion: { titulo: 'Revisa el token de blindaje', pose: 'pensar', objetivo: OBJETIVO.accion,
    texto: 'El token de Modo blindaje es otro distinto del de lectura, con Firewall Services · Edit.' },
};
const ORDEN_CAMPOS: Campo[] = ['ref', 'zona', 'repo', 'label', 'token', 'accion'];
export function dichoDeRechazo(errores: Partial<Record<Campo, unknown>>): Dicho | null {
  const c = ORDEN_CAMPOS.find((k) => !!errores[k]);
  return c ? RECHAZO_LOCAL[c] : null;
}
