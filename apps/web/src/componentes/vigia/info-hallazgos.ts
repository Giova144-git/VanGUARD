// Lo que Vigía cuenta con clic derecho → «Info» sobre un problema concreto (una fila con data-hallazgo="<uuid>").
// Tres piezas:
//   1. Un texto fijo por rule_id (REGLAS): qué es, por qué es peligroso y qué hacer, en 1–3 frases llanas. El catálogo
//      sale de las reglas que emiten packages/core y apps/api; info-hallazgos.test.ts comprueba que ninguna se queda
//      sin texto (lee esos archivos del disco: la web no importa @vanguard/core).
//   2. Si la regla no está (hallazgos de la IA, avisos del advisor sin traducir), uno por módulo (MODULO).
//   3. Los datos que ya enseña la fila: el recurso afectado y la gravedad. El recurso llega del servidor: va recortado,
//      en una sola línea y con los controles bidi a la vista (sinBidi), y Vigía lo pinta como texto React, nunca HTML.
//   4. Sus fechas (historial de fallas, 0025): cuándo se detectó, se corrigió, se verificó, se ignoró o reapareció. La
//      misma regla que el recurso: Vigía solo cita lo saneado. De una fecha del servidor solo se usa el instante que
//      sale de Date.parse, escrito otra vez con Intl (elDia de lib/formato.ts): una cadena que no es fecha no se cita.
// Las filas anotan aquí lo que pintan (marcaHallazgo) para que el menú no tenga que volver a pedir el hallazgo.
import { sinBidi } from '@/lib/bidi';
import { elDia } from '@/lib/formato';
import { esId } from '@/lib/ids';
import type { TextoInfo } from './info';

export type DatosHallazgo = {
  id: string;
  module?: string | null;
  rule_id?: string | null;
  severity?: string | null;
  /** Solo si no hay severity (la bandeja de un módulo trae el rol, no la gravedad). */
  rol?: string | null;
  resource?: string | null;
  connection_id?: string | null;
  /** open, fixed, verified, ignored: solo uno abierto se puede enviar a la IA. */
  status?: string | null;
  /** Fechas ISO del servidor (E13, E13h, E13t). Solo se citan pasadas por elDia. */
  first_seen_at?: string | null;
  fixed_at?: string | null;
  verified_at?: string | null;
  ignored_at?: string | null;
  reopened_at?: string | null;
};

// ── 1. Por regla ──────────────────────────────────────────────────────────────────────────────────────────────────
export const REGLAS: Readonly<Record<string, TextoInfo>> = {
  // Supabase
  SB_RLS_DISABLED: { titulo: 'Tabla sin RLS', texto: 'Esta tabla no tiene RLS, las reglas que deciden quién ve cada fila. Cualquiera con tu clave pública puede leerla entera. Activa RLS y crea una política que solo deje ver lo propio.' },
  SB_POLICY_ALLOW_ALL: { titulo: 'Política que deja pasar a todos', texto: 'La tabla tiene RLS, pero esta política dice «sí» a cualquiera, así que no protege nada. Cámbiala para que cada usuario solo vea o toque sus propias filas.' },
  SB_RPC_ANON_NO_LIMIT: { titulo: 'Función sin freno', texto: 'Cualquiera puede llamar a esta función de tu base sin iniciar sesión y sin límite. Alguien podría usarla en bucle para cambiar datos o gastar tus recursos: exige sesión o ponle un límite.' },
  SB_DB_DOWN: { titulo: 'Base de datos caída', texto: 'Tu base de datos o su API no responden bien, así que tu app no puede leer ni guardar nada. Mira el estado del proyecto en Supabase y sus registros.' },
  SB_CPU_HIGH: { titulo: 'CPU al límite', texto: 'El servidor de tu base va al límite de CPU: las peticiones se vuelven lentas o fallan. Busca las consultas más pesadas o sube de plan.' },
  SB_DISK_HIGH: { titulo: 'Disco casi lleno', texto: 'El disco de tu base está casi lleno. Si se llena, deja de guardar datos: borra lo que sobre o amplía el disco.' },
  SB_CONN_HIGH: { titulo: 'Demasiadas conexiones', texto: 'Tu base está cerca del máximo de conexiones a la vez. Al llegar, rechaza peticiones nuevas: usa el pooler de Supabase o cierra conexiones que se quedan abiertas.' },
  SB_TABLE_BLOAT: { titulo: 'Tabla hinchada', texto: 'Esta tabla arrastra filas muertas o índices sin uso que ocupan sitio y la hacen más lenta. No es un peligro de seguridad: limpiarla (VACUUM) la deja ágil.' },
  SB_EXPOSURE_REGRESSION: { titulo: 'Tabla que se ha abierto', texto: 'Esta tabla antes estaba protegida y ahora cualquiera con tu clave pública puede leerla. Algún cambio reciente la abrió: revisa sus reglas RLS cuanto antes.' },
  // Avisos del advisor de Supabase (SB_ADVISOR_<lint>): los que VanGUARD traduce. El resto va por módulo.
  SB_ADVISOR_RLS_DISABLED_IN_PUBLIC: { titulo: 'Aviso: RLS desactivada', texto: 'Supabase avisa de que esta tabla pública no tiene RLS. Sin esas reglas, cualquiera con tu clave pública puede leerla: actívala y añade políticas.' },
  SB_ADVISOR_RLS_ENABLED_NO_POLICY: { titulo: 'Aviso: RLS sin políticas', texto: 'La tabla tiene RLS activa pero ninguna política, así que nadie puede leerla desde la app. No es una fuga, pero seguramente falta una política que deje ver lo propio.' },
  SB_ADVISOR_POLICY_EXISTS_RLS_DISABLED: { titulo: 'Aviso: políticas sin RLS', texto: 'Escribiste políticas para esta tabla, pero RLS está apagada y no se aplican. La tabla queda abierta: activa RLS para que tus políticas cuenten.' },
  SB_ADVISOR_SECURITY_DEFINER_VIEW: { titulo: 'Aviso: vista con SECURITY DEFINER', texto: 'Esta vista se ejecuta con los permisos de quien la creó, no con los de quien la consulta. Puede saltarse tus reglas RLS: créala con security_invoker.' },
  SB_ADVISOR_FUNCTION_SEARCH_PATH_MUTABLE: { titulo: 'Aviso: search_path mutable', texto: 'Esta función no fija dónde busca las tablas. Alguien con acceso podría colarle una tabla falsa: fija su search_path.' },
  SB_ADVISOR_AUTH_USERS_EXPOSED: { titulo: 'Aviso: auth.users expuesta', texto: 'Los datos de tus usuarios (correos, fechas de alta) se pueden leer a través de la API. Quita esa vista o protégela para que no salga de la base.' },
  SB_ADVISOR_EXTENSION_IN_PUBLIC: { titulo: 'Aviso: extensión en public', texto: 'Hay una extensión instalada en el esquema public, el que expone la API. Muévela a su propio esquema para no abrir funciones de más.' },
  SB_ADVISOR_AUTH_LEAKED_PASSWORD_PROTECTION: { titulo: 'Aviso: contraseñas filtradas', texto: 'Tu login deja usar contraseñas que ya aparecieron en filtraciones públicas. Activa la protección de contraseñas filtradas en Auth de Supabase.' },
  SB_ADVISOR_UNINDEXED_FOREIGN_KEYS: { titulo: 'Aviso: clave foránea sin índice', texto: 'Una relación entre tablas no tiene índice y las consultas que la usan van más lentas. No es de seguridad: crear el índice lo arregla.' },
  SB_ADVISOR_UNUSED_INDEX: { titulo: 'Aviso: índice sin uso', texto: 'Este índice no se usa y ocupa sitio y tiempo en cada escritura. No es de seguridad: si de verdad sobra, bórralo.' },
  SB_ADVISOR_DUPLICATE_INDEX: { titulo: 'Aviso: índices duplicados', texto: 'Hay dos índices iguales en la misma tabla: uno sobra y hace más lentas las escrituras. Borra el repetido.' },
  SB_ADVISOR_MULTIPLE_PERMISSIVE_POLICIES: { titulo: 'Aviso: políticas repetidas', texto: 'Varias políticas permiten lo mismo al mismo rol, lo que hace más difícil saber quién ve qué y más lentas las consultas. Júntalas en una.' },

  // Cloudflare
  CF_ADMIN_EXPOSED: { titulo: 'Panel de administración abierto', texto: 'Tu ruta de administración responde a cualquiera desde internet, sin pedir sesión. Es la puerta que más buscan los atacantes: protégela con login o con Cloudflare Access.' },
  CF_PATH_SCAN: { titulo: 'Escaneo de rutas', texto: 'Una IP está probando rutas una tras otra, como /.env o /.git: busca archivos olvidados o puntos débiles. Puedes bloquearla y comprobar que esas rutas no existen.' },
  CF_UA_TOOL: { titulo: 'Herramienta de ataque', texto: 'Llega tráfico de una herramienta automática de escaneo o de ataque, no de una persona. Bloquéala en Cloudflare si insiste.' },
  CF_IP_FLOOD: { titulo: 'Avalancha de peticiones', texto: 'Una IP te manda muchísimas más peticiones de lo normal y puede tumbar tu web. Bloquéala o activa el modo bajo ataque.' },
  CF_ZONE_01: { titulo: 'Zona de Cloudflare pausada', texto: 'Cloudflare está en pausa para tu dominio: el tráfico llega directo a tu servidor, sin su escudo. Reactiva la zona en el panel de Cloudflare.' },
  CF_WAF_01: { titulo: 'WAF apagado', texto: 'Las reglas gratuitas del WAF, el filtro de Cloudflare que frena ataques conocidos, no están activas. Actívalas: cuestan cero y paran lo más común.' },
  CF_SITE_EXPOSED: { titulo: 'Archivo sensible a la vista', texto: 'Tu web sirve a cualquiera un archivo que debería ser privado, como un .env o la carpeta .git. Ahí suele haber claves: bórralo del servidor y cambia esas claves.' },
  CF_SITE_CORS: { titulo: 'CORS abierto', texto: 'Tu web deja que cualquier otra página lea sus respuestas con la sesión del usuario. Una web maliciosa podría sacar sus datos: permite solo tus propios dominios.' },
  CF_SITE_HSTS: { titulo: 'Sin HSTS', texto: 'Tu web no obliga al navegador a usar siempre HTTPS. En una red pública alguien podría desviar la primera visita: añade la cabecera Strict-Transport-Security.' },
  CF_SITE_CSP: { titulo: 'Sin CSP', texto: 'Tu web no dice desde dónde puede cargar scripts. Si alguien logra colar código, nada lo frena: añade una cabecera Content-Security-Policy.' },
  CF_SITE_FRAME: { titulo: 'Se puede incrustar', texto: 'Cualquier web puede meter la tuya dentro de un marco invisible y engañar a tus usuarios para que hagan clic donde no quieren. Añade frame-ancestors o X-Frame-Options.' },
  CF_SITE_NOSNIFF: { titulo: 'Sin nosniff', texto: 'El navegador puede adivinar el tipo de tus archivos y ejecutar como código algo que no lo es. Añade la cabecera X-Content-Type-Options: nosniff.' },
  CF_SITE_HTTP: { titulo: 'Sin redirección a HTTPS', texto: 'Tu web sigue respondiendo por HTTP sin candado, donde el tráfico viaja sin cifrar. Activa «Always Use HTTPS» en Cloudflare.' },
  CF_PAGES_PLAINTEXT: { titulo: 'Secreto a la vista en Pages', texto: 'Una variable de tu proyecto de Cloudflare Pages guarda un secreto como texto normal, visible para quien entre al panel. Pásala a secreto cifrado y cámbiala.' },
  CF_WORKER_PLAINTEXT: { titulo: 'Secreto a la vista en un Worker', texto: 'Tu Worker guarda un secreto como variable de texto normal, visible en el panel y en la configuración. Pásalo a secreto cifrado y cámbialo.' },
  CF_WORKER_DEVSUBDOMAIN: { titulo: 'Worker con dirección de pruebas', texto: 'Tu Worker sigue respondiendo en su dirección *.workers.dev además de en tu dominio. Por ahí se salta tus reglas de Cloudflare: desactívala.' },

  // Codebase
  CB_ENV_COMMITTED: { titulo: '.env subido al repo', texto: 'Subiste un archivo .env al repositorio: quien vea el repo ve tus claves. Cámbialas todas, borra el archivo y añádelo al .gitignore.' },
  CB_GITIGNORE_NO_ENV: { titulo: '.gitignore sin .env', texto: 'Tu .gitignore no excluye los archivos .env, así que el próximo commit puede subir tus claves sin querer. Añade .env a la lista.' },
  CB_DEP_VULN: { titulo: 'Librería con fallo conocido', texto: 'Usas una versión de esta librería con una vulnerabilidad pública: los atacantes ya saben cómo aprovecharla. Actualízala a una versión corregida.' },
  CB_KEY_REUSE: { titulo: 'Clave repetida', texto: 'La misma clave está escrita en tu repo y en una conexión de VanGUARD. Si se filtra una, caen las dos: crea una clave nueva para cada sitio.' },
  CB_SECRET_SUPABASE_SERVICE_ROLE: { titulo: 'Clave service_role en el código', texto: 'La clave service_role de Supabase se salta todas tus reglas RLS: con ella se lee y se borra todo. Rótala ya en Supabase y sácala del código.' },
  CB_SECRET_SB_SECRET: { titulo: 'Clave secreta de Supabase', texto: 'Hay una clave secreta de Supabase en el código: da acceso total a tu base. Rótala en Supabase y guárdala como secreto del servidor.' },
  CB_SECRET_AWS: { titulo: 'Clave de AWS en el código', texto: 'Hay una clave de acceso de AWS en el código. Con ella alguien puede usar tu cuenta y dejarte la factura: desactívala en AWS y sácala del repo.' },
  CB_SECRET_STRIPE_LIVE: { titulo: 'Clave live de Stripe', texto: 'Hay una clave real de Stripe en el código: con ella se pueden hacer cobros y reembolsos en tu nombre. Rótala en Stripe y sácala del repo.' },
  CB_SECRET_ANTHROPIC: { titulo: 'Clave de Anthropic', texto: 'Hay una clave de la API de Anthropic en el código: cualquiera puede gastar tu saldo con ella. Revócala en la consola de Anthropic y sácala del repo.' },
  CB_SECRET_OPENAI: { titulo: 'Clave de OpenAI', texto: 'Hay una clave de la API de OpenAI en el código: cualquiera puede gastar tu saldo con ella. Revócala en OpenAI y sácala del repo.' },
  CB_SECRET_GITHUB_PAT: { titulo: 'Token de GitHub', texto: 'Hay un token personal de GitHub en el código: da acceso a tus repos con tus permisos. Revócalo en GitHub y sácalo del repo.' },
  CB_SECRET_PRIVATE_KEY: { titulo: 'Clave privada en el código', texto: 'Hay una clave privada en el repo: con ella alguien puede hacerse pasar por tu servidor o entrar donde la uses. Genera otra y saca esta del repo.' },
  CB_SECRET_POSTGRES_URL: { titulo: 'Contraseña de la base', texto: 'Hay una dirección de tu base de datos con la contraseña dentro. Con ella se entra directo a la base: cambia la contraseña y guárdala como secreto.' },
  CB_SECRET_GENERIC: { titulo: 'Posible credencial', texto: 'Parece una clave o contraseña escrita en el código. Si es real, quien vea el repo puede usarla: rótala y pásala a una variable de entorno.' },

  // Rendimiento
  PF_REGRESSION: { titulo: 'Tu web va más lenta', texto: 'Una métrica de velocidad empeoró desde la medición anterior. Una web lenta pierde visitas: revisa qué cambió desde entonces y vuelve a medir.' },
};

// Familias: un tipo nuevo de la misma regla (un CB_SECRET_* que aún no tiene texto propio) se explica igual.
const FAMILIAS: ReadonlyArray<readonly [string, TextoInfo]> = [
  ['CB_SECRET_', { titulo: 'Clave en el código', texto: 'Hay una clave o contraseña escrita en el código: quien vea el repo puede usarla. Rótala donde se creó y pásala a una variable de entorno.' }],
  ['CF_DNS_', { titulo: 'DNS mejorable', texto: 'Un ajuste de DNS de tu dominio deja un hueco, como un servidor alcanzable sin el escudo de Cloudflare. Revísalo en el panel DNS de Cloudflare.' }],
  ['CF_TLS_', { titulo: 'HTTPS mejorable', texto: 'Un ajuste de HTTPS de tu dominio es débil y el tráfico podría leerse o cambiarse por el camino. Revísalo en SSL/TLS de Cloudflare.' }],
];

/** Texto fijo de la regla (o de su familia), o null. hasOwn: un rule_id «__proto__» no da con el prototipo. */
export function textoRegla(rule: unknown): TextoInfo | null {
  if (typeof rule !== 'string') return null;
  if (Object.hasOwn(REGLAS, rule)) return REGLAS[rule]!;
  return FAMILIAS.find(([p]) => rule.startsWith(p) && rule.length > p.length)?.[1] ?? null;
}

// ── 2. Por módulo ─────────────────────────────────────────────────────────────────────────────────────────────────
export const MODULO: Readonly<Record<'supabase' | 'cloudflare' | 'codebase' | 'performance', TextoInfo>> = {
  supabase: { titulo: 'Problema en tu base de datos', texto: 'Algo en tu Supabase puede dejar datos a la vista o permitir cambios que no deberían. Abre el detalle: ahí ves la evidencia y el arreglo.' },
  cloudflare: { titulo: 'Problema en tu web', texto: 'Algo en tu Cloudflare o en tu web deja un hueco por donde podrían atacarte. Abre el detalle: ahí ves la evidencia y el arreglo.' },
  codebase: { titulo: 'Problema en tu código', texto: 'Algo en tu repo puede dar a otros acceso a tus claves o a tu app. Abre el detalle: ahí ves la evidencia y el arreglo.' },
  performance: { titulo: 'Problema de velocidad', texto: 'Tu web carga más lenta de lo que debería, y eso hace que se vayan visitas. Abre el detalle: ahí ves qué medimos y cómo mejorarlo.' },
};
const GENERICO: TextoInfo = { titulo: 'Problema', texto: 'Un problema que encontré en lo que tienes conectado. Abre el detalle: ahí ves la evidencia y el arreglo.' };

// ── 3. Datos de la fila ───────────────────────────────────────────────────────────────────────────────────────────
const GRAVEDAD: Readonly<Record<string, string>> = {
  critical: 'Gravedad crítica: arréglalo hoy.', high: 'Gravedad alta: arréglalo esta semana.',
  medium: 'Gravedad media: arréglalo cuando puedas.', low: 'Gravedad baja: puede esperar.', info: 'Es solo un aviso, no un fallo.',
};
// La bandeja de un módulo no trae la gravedad, sino su rol (estado/modulo.ts: crítica y alta → mal, media → aviso).
const POR_ROL: Readonly<Record<string, string>> = {
  mal: 'Es urgente: arréglalo cuanto antes.', aviso: 'Gravedad media: arréglalo cuando puedas.', cola: 'Puede esperar.',
};

export const MAX_RECURSO = 80;
/** Recurso del servidor para la burbuja: una línea, ≤ MAX_RECURSO caracteres con «…» y los controles bidi a la vista. */
export function recursoCorto(s: unknown): string {
  if (typeof s !== 'string') return '';
  const l = s.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const cp = Array.from(l);
  return sinBidi(cp.length > MAX_RECURSO ? cp.slice(0, MAX_RECURSO - 1).join('') + '…' : l);
}

// ── 4. Fechas ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Una frase con las fechas del problema según su estado, o null si no hay ninguna fecha válida. Sin la gravedad: un
 *  problema que ya no está abierto no corre prisa. */
export function fechasDeHallazgo(h: Partial<DatosHallazgo> | null | undefined, ahora = new Date()): string | null {
  const d = (t: unknown) => (typeof t === 'string' ? elDia(t, ahora) : null);
  const [visto, corregido, verificado, ignorado, reaparecio] = [d(h?.first_seen_at), d(h?.fixed_at), d(h?.verified_at),
    d(h?.ignored_at), d(h?.reopened_at)];
  const detectado = visto ? `Se detectó ${visto}` : null;
  const unir = (...p: (string | null)[]) => { const t = p.filter(Boolean).join(' y '); return t ? `${t[0]!.toUpperCase()}${t.slice(1)}` : null; };
  switch (h?.status) {
    case 'open': {
      const base = unir(detectado, 'sigue abierto');
      return reaparecio ? `${base}: reapareció ${reaparecio}, después de corregirse.` : visto ? `${base}.` : null;
    }
    case 'fixed': {
      const t = unir(detectado, corregido ? `se marcó corregido ${corregido}` : 'se marcó corregido');
      return `${t}; falta que una auditoría lo compruebe.`;
    }
    case 'verified': {
      const t = unir(detectado, corregido ? `se corrigió ${corregido}` : null);
      const v = verificado ? `una auditoría lo verificó ${verificado}` : 'una auditoría verificó que ya no está';
      return t ? `${t}; ${v}.` : `${v[0]!.toUpperCase()}${v.slice(1)}.`;
    }
    case 'ignored': {
      const t = unir(detectado, ignorado ? `se ignoró ${ignorado}` : 'se ignoró');
      return `${t}: ya no cuenta en tu puntaje.`;
    }
    default:
      return detectado ? `${detectado}.` : null;
  }
}

/** Título y texto de «Info» para un hallazgo: la regla (o su módulo), dónde está, sus fechas y cuánto corre prisa (esto
 *  último solo si sigue abierto o no se sabe su estado). */
export function infoDeHallazgo(h: Partial<DatosHallazgo> | null | undefined, ahora = new Date()): TextoInfo {
  const base = textoRegla(h?.rule_id)
    ?? (typeof h?.module === 'string' && Object.hasOwn(MODULO, h.module) ? MODULO[h.module as keyof typeof MODULO] : GENERICO);
  const recurso = recursoCorto(h?.resource);
  const cerrado = h?.status === 'fixed' || h?.status === 'verified' || h?.status === 'ignored';
  const prisa = cerrado ? null : typeof h?.severity === 'string' && Object.hasOwn(GRAVEDAD, h.severity) ? GRAVEDAD[h.severity]
    : typeof h?.rol === 'string' && Object.hasOwn(POR_ROL, h.rol) ? POR_ROL[h.rol] : null;
  return { titulo: base.titulo,
    texto: [base.texto, recurso ? `Afecta a «${recurso}».` : null, fechasDeHallazgo(h, ahora), prisa].filter(Boolean).join(' ') };
}

// ── Registro de lo que pintan las filas ───────────────────────────────────────────────────────────────────────────
const MAX_VISTOS = 500;
const CAMPOS = ['module', 'rule_id', 'severity', 'rol', 'resource', 'connection_id', 'status', 'first_seen_at', 'fixed_at',
  'verified_at', 'ignored_at', 'reopened_at'] as const;
const vistos = new Map<string, DatosHallazgo>();

/** La fila anota lo que enseña y recibe su atributo: `<li {...marcaHallazgo(d)}>`. Sin un UUID, nada (ni atributo). */
export function marcaHallazgo(d: DatosHallazgo): { 'data-hallazgo'?: string } {
  if (!esId(d.id)) return {};
  const antes = vistos.get(d.id);
  vistos.delete(d.id);                                  // al final: lo más reciente es lo último en salir
  // Solo los campos de DatosHallazgo (una fila puede pasar el hallazgo entero, con su evidencia): nada más se guarda.
  const nuevos = Object.fromEntries(CAMPOS.flatMap((k) => (typeof d[k] === 'string' ? [[k, d[k]]] : [])));
  vistos.set(d.id, { ...antes, ...nuevos, id: d.id });
  if (vistos.size > MAX_VISTOS) vistos.delete(vistos.keys().next().value!);
  return { 'data-hallazgo': d.id };
}
export const hallazgoVisto = (id: string): DatosHallazgo | null => vistos.get(id) ?? null;
