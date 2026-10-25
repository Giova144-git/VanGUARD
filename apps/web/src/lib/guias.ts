// Guía en lenguaje llano por pantalla: «¿Cómo leer este módulo?» (S14 §14.12). Textos de UI en español.
import type { Provider } from '@vanguard/contracts';
import type { IdNav } from './nav';

// Asistentes de conexión (S14 §14.10). `enlace` abre el panel del proveedor en una pestaña nueva.
export type PasoConexion = { texto: string; enlace?: { href: string; texto: string } };
export const GUIAS_CONEXION: Record<Provider, { nombre: string; titulo: string; pasos: PasoConexion[] }> = {
  supabase: { nombre: 'Supabase', titulo: 'Conecta tu proyecto de Supabase', pasos: [
    { texto: 'Abre tus tokens de acceso de Supabase.', enlace: { href: 'https://supabase.com/dashboard/account/tokens', texto: 'Abrir tokens de Supabase' } },
    { texto: '«Generate new token» con alcance: elige solo tu proyecto y marca en Read: Project Settings, Advisors y Database (los tres obligatorios). Opcional: Logs y Auth Config. No marques «API Key Secrets», «Data API» ni nada en Read-write. Caducidad: 30 días.' },
    { texto: 'Pega aquí tu proyecto (la URL o el ref) y el token, que empieza por sbp_fc.' },
    { texto: 'Probamos cada permiso y te decimos si falta alguno.' },
  ] },
  cloudflare: { nombre: 'Cloudflare', titulo: 'Conecta tu zona de Cloudflare', pasos: [
    { texto: 'Abre tus API Tokens y pulsa «Create Token» → «Create Custom Token».', enlace: { href: 'https://dash.cloudflare.com/profile/api-tokens', texto: 'Abrir API Tokens de Cloudflare' } },
    { texto: 'Permisos, todos Zone · Read: Zone, Zone Settings, DNS, Analytics, Firewall Services y Zone WAF. En Zone Resources: Include → Specific zone → tu dominio.' },
    { texto: 'Copia el Zone ID: página de tu dominio → Overview → columna «API».' },
    { texto: 'Opcional, «Modo blindaje»: un segundo token con solo Firewall Services · Edit sobre la misma zona. Solo se usa cuando confirmas «Bloquear IP» y nunca se entrega a la IA.' },
    { texto: 'Probamos cada permiso. Nunca te pediremos la Global API Key.' },
  ] },
  github: { nombre: 'GitHub', titulo: 'Conecta tu repositorio de GitHub', pasos: [
    { texto: 'Abre este enlace: crea un token fine-grained de 30 días con los permisos ya marcados.',
      enlace: { href: 'https://github.com/settings/personal-access-tokens/new?name=VanGUARD&description=Solo+lectura+para+VanGUARD&expires_in=30&contents=read', texto: 'Crear token en GitHub' } },
    { texto: 'En Repository access elige «Only select repositories» y marca un solo repo.' },
    { texto: 'Comprueba Contents: Read-only y Metadata: Read-only (opcional: Dependabot alerts: Read-only).' },
    { texto: 'Pega aquí el repo (owner/repo o su URL) y el token, que empieza por github_pat_.' },
  ] },
  ingest: { nombre: 'Tu app', titulo: 'Conecta tu app (ingesta en vivo)', pasos: [
    { texto: 'Ponle un nombre a esta conexión.' },
    { texto: 'Copia el secreto ahora: no se vuelve a mostrar.' },
    { texto: 'Ponlo en tu app como VG_INGEST_SECRET.' },
    { texto: 'Tu app nos manda los eventos en lotes (hasta 100 eventos o cada 2 s), no una petición por evento: así cuidamos el cupo diario del plan gratuito.' },
  ] },
};

// Segundo token de GitHub, el de escritura del bloqueo de merge (bloqueo-merge-criticos.md §1.3 y §6.1; anexo de cierre
// de PR): publica el check «VanGUARD» y cierra los PR con críticos. Lo crea el DUEÑO del repo: en una cuenta personal un
// colaborador no puede. El permiso va por su nombre en la URL (write incluye read; Metadata entra sola) y Repository
// access no se puede prellenar. `owner` llega ya validado (o null: el enlace sale sin target_name).
export const GUIA_ESTADOS_GITHUB = {
  quien: 'Lo crea el dueño del repo en GitHub (o un miembro de la organización dueña, con aprobación si la org la exige). Un colaborador no puede crear este tipo de token para un repo ajeno.',
  crear: 'Crea un token solo para esto: el enlace abre GitHub con los permisos ya marcados y 30 días de caducidad.',
  acceso: 'En Repository access elige «Only select repositories» y marca solo',
  permisos: 'Comprueba que tiene Commit statuses y Pull requests en Read and write (Metadata: Read-only viene sola). Opcional: Issues: Read and write, para «Crear issue» desde el WhatsApp. Si tiene Contents o Administration, lo rechazamos.',
  enlace: (owner: string | null) => 'https://github.com/settings/personal-access-tokens/new?name=VanGUARD+estados'
    + '&description=Estados+de+commit+y+cierre+de+PR+para+VanGUARD&expires_in=30&statuses=write&pull_requests=write'
    + (owner ? `&target_name=${encodeURIComponent(owner)}` : ''),
};

export type Guia = { titulo: string; pasos: string[] };

export const GUIAS: Record<IdNav, Guia> = {
  overview: { titulo: '¿Cómo leer el resumen?', pasos: [
    'El número grande es tu puntaje de blindaje (0 a 100). Al lado te decimos cuántas de tus 4 fuentes pudimos mirar: un puntaje sin todas las fuentes no está completo.',
    '«Ahora» es la lista de lo que conviene atender primero. Cada fila trae su botón para verlo y corregirlo.',
    '«Auditar todo» revisa Supabase, Cloudflare y tu repo de una vez y actualiza esta pantalla.',
  ] },
  supabase: { titulo: '¿Cómo leer este módulo?', pasos: [
    'Miramos tu proyecto con un token de solo lectura: nunca podemos cambiar nada de tu base.',
    'Rojo es lo que deja tus datos a la vista de cualquiera (tablas sin RLS, políticas que dejan pasar a todos). Ámbar es lo que conviene revisar pronto.',
    'Cada problema trae «Generar prompt»: te damos el arreglo listo para pegar en tu IA.',
  ] },
  cloudflare: { titulo: '¿Cómo leer este módulo?', pasos: [
    'Aquí ves quién está tocando tu web: las IPs y los programas que más insisten, y los escaneos de rutas de administración.',
    'Cuando un ataque cruza el umbral abrimos un incidente y te avisamos por WhatsApp.',
    'Con el «Modo blindaje» puedes bloquear la IP desde aquí o desde el mismo mensaje de WhatsApp, y deshacerlo con un botón.',
  ] },
  codebase: { titulo: '¿Cómo leer este módulo?', pasos: [
    'Revisamos solo los archivos de riesgo de tu repo: .env subidos, claves en la configuración y lockfiles. Nunca el código entero.',
    'Las dependencias se cruzan con la base pública de vulnerabilidades (OSV) por su versión exacta.',
    'Los secretos que encontramos se muestran tapados: nunca los copiamos completos.',
  ] },
  wiki: { titulo: '¿Cómo funciona la wiki?', pasos: [
    'Leemos tu repo en GitHub y una IA lo explica en lenguaje llano: qué es, cómo funciona, sus piezas, un mapa y los riesgos.',
    'Antes de gastar nada te decimos cuánto costará. Si ese mismo commit ya tiene wiki, verla es gratis.',
    'Lo que escribe la IA se muestra como texto: nunca ejecutamos nada de lo que traiga el documento.',
  ] },
  performance: { titulo: '¿Cómo leer este módulo?', pasos: [   // los tres pasos de S10 §10.10
    'Escribe la URL de cualquier web pública con https:// (no medimos IPs, localhost ni webs de VanGUARD).',
    'Elige móvil o escritorio y pulsa «Medir ahora»: Lighthouse (el mismo de PageSpeed Insights) suele tardar menos de un minuto.',
    'Mira qué empeoró frente a la medición anterior (en ámbar) y copia el arreglo para tu IA.',
  ] },
  audit: { titulo: '¿Cómo funciona la auditoría?', pasos: [
    'Un botón revisa todo tu ecosistema por pasos: Supabase, Cloudflare y tu repo.',
    'Verás cada paso avanzar en vivo. Si una fuente no está conectada, ese paso sale «sin mirar» y el puntaje lo dice.',
    'Al final, una IA resume lo encontrado en lenguaje llano. Si la IA está en pausa, sale un resumen automático.',
  ] },
  evolution: { titulo: '¿Cómo leer la evolución?', pasos: [
    'Cada punto es una auditoría terminada. El puntaje es el que tenía en ese momento.',
    'Nuevos: abiertos que no estaban abiertos en la auditoría anterior. Se mantienen: siguen abiertos. Corregidos: estaban abiertos y ya no; "comprobado" si la auditoría ya no los encontró, "marcado a mano" si alguien lo marcó.',
    'Una clave que ya no está en el código no está arreglada hasta que la rotas: por eso no cuenta como comprobada.',
    'Un módulo que no se pudo revisar deja sus hallazgos como estaban: no cuentan como corregidos.',
    'Cada push a main muestra lo nuevo que trajo, lo que sigue abierto y lo corregido desde el push anterior.',
  ] },
  incidents: { titulo: '¿Cómo funcionan los incidentes?', pasos: [
    'Cuando detectamos un ataque abrimos un incidente y el cronómetro empieza a correr.',
    'Te avisamos primero por WhatsApp; desde el mismo mensaje puedes aprobar «Bloquear IP» con un código de un solo uso.',
    'La línea de tiempo muestra cuánto tardó cada paso: detección, aviso, aprobación y bloqueo.',
  ] },
  export: { titulo: '¿Cómo llevar esto a tu IA?', pasos: [
    'Descarga tus hallazgos en Markdown o JSON, o pulsa «Copiar para mi IA» y pégalo en el chat que uses.',
    'El informe va redactado: los secretos nunca salen completos.',
  ] },
  connections: { titulo: '¿Qué te pedimos?', pasos: [
    'Tokens de solo lectura: con ellos podemos mirar, nunca escribir. La única excepción es el token opcional de Modo blindaje, que solo bloquea una IP cuando tú lo confirmas.',
    'Si pegas una clave que puede escribir (como la secreta de Supabase o un token clásico de GitHub), la rechazamos sin que salga de tu navegador.',
    'Después de guardar, solo verás los últimos 4 caracteres del token.',
  ] },
  settings: { titulo: '¿Qué puedes ajustar?', pasos: [
    'A quién avisamos y por qué canal: hoy por WhatsApp; la llamada llega próximamente.',
    'Prueba WhatsApp antes de una emergencia para saber que el aviso llega.',
  ] },
};

// Texto para unirse al sandbox de Kapso (S12). Lo rellena el ORQUESTADOR con los datos de la cuenta de Gabriel.
export const SANDBOX_KAPSO: string | null = null;
