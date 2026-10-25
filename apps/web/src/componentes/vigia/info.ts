// Lo que Vigía cuenta con clic derecho → «Info» (MenuContextual.tsx). Cada clave es el valor de un data-info que algún
// componente pinta; info.test.ts comprueba que no falta ni sobra ninguna. Textos fijos, cortos (1–3 frases) y en
// lenguaje llano: nunca llevan datos del servidor. Las entradas del riel van como «nav-<id de lib/nav.ts>».
export type TextoInfo = { titulo: string; texto: string };

export const INFO = {
  // Riel de navegación (AppShell: data-info={`nav-${id}`}).
  'nav-overview': { titulo: 'Resumen', texto: 'Tu portada: el puntaje de blindaje, cuántos problemas tienes por gravedad y lo más urgente ahora mismo, de todos tus servicios a la vez.' },
  'nav-supabase': { titulo: 'Supabase', texto: 'Reviso tu base de datos: tablas que cualquiera podría leer, permisos demasiado abiertos y funciones sin freno. Solo con permiso de lectura.' },
  'nav-cloudflare': { titulo: 'Cloudflare', texto: 'Miro el tráfico que llega a tu web: quién insiste, quién te escanea y si hay picos raros. Cloudflare es el escudo que tienes delante de tu web.' },
  'nav-codebase': { titulo: 'Codebase', texto: 'Reviso el código de tu repo de GitHub: archivos .env subidos por error, claves escritas en el código y librerías con fallos de seguridad conocidos.' },
  'nav-wiki': { titulo: 'Wiki del repo', texto: 'Una IA lee tu repo y lo explica para alguien que no programa: qué hace, cómo funciona, sus piezas y sus riesgos.' },
  'nav-performance': { titulo: 'Rendimiento', texto: 'Mido lo rápido que carga tu web con Lighthouse, la herramienta de Google, y te digo si mejoró o empeoró desde la última vez.' },
  'nav-audit': { titulo: 'Auditoría', texto: 'Una revisión completa de todo lo que conectaste, con un solo botón. Al terminar te dice qué arreglar primero.' },
  'nav-evolution': { titulo: 'Evolución', texto: 'Cómo cambia tu seguridad con el tiempo: qué problemas aparecieron, cuáles se corrigieron y cómo se movió tu puntaje.' },
  'nav-incidents': { titulo: 'Incidentes', texto: 'Ataques en vivo contra tu app. Te aviso por WhatsApp y puedes bloquear al atacante desde el mismo mensaje.' },
  'nav-export': { titulo: 'Llevar a tu IA', texto: 'Saca tus hallazgos para dárselos a la IA que ya usas, o conéctala por MCP para que los consulte y te ayude a arreglarlos.' },
  'nav-connections': { titulo: 'Conexiones', texto: 'Aquí conectas tus servicios con tokens de solo lectura: VanGUARD puede mirar, pero no cambiar nada.' },
  'nav-settings': { titulo: 'Ajustes', texto: 'A quién avisamos, por qué canal (WhatsApp, correo) y cuánto puede gastar la IA al día.' },

  // Cabecera.
  'demo-solo-lectura': { titulo: 'Demo · solo lectura', texto: 'Estás viendo una organización de ejemplo. Puedes mirarlo todo, pero los botones que cambian algo están apagados.' },
  'ia-en-pausa': { titulo: 'IA en pausa', texto: 'La IA está apagada por ahora, por ajuste o porque se llegó al tope de gasto del día. Las revisiones siguen; solo faltan los textos que escribe la IA.' },
  'gasto-ia': { titulo: 'Gasto de IA hoy', texto: 'Lo que lleva gastado hoy la IA frente al tope diario que pusiste. Si se acerca al tope, uso modelos más baratos; al llegar, la pauso.' },

  // Resumen.
  'puntaje-blindaje': { titulo: 'Puntaje de blindaje', texto: 'Una nota de 0 a 100 sobre lo protegido que está tu ecosistema: más alto es mejor. Al lado ves cuántas fuentes miramos; con fuentes sin conectar, la nota no cuenta toda la historia.' },
  'auditar-todo': { titulo: 'Auditar todo', texto: 'Revisa a la vez Supabase, Cloudflare, tu repo y el rendimiento. Tarda unos minutos y al acabar actualiza tu puntaje.' },
  'barra-severidad': { titulo: 'Problemas por gravedad', texto: 'Cada color es una gravedad: cuanto más ancho el tramo, más problemas de ese tipo. Lo ideal es que el rojo desaparezca.' },
  'cifra-criticos': { titulo: 'Críticos abiertos', texto: 'Problemas tan graves que alguien podría aprovecharlos ya, por ejemplo para leer tus datos. Son lo primero que conviene arreglar.' },
  'cifra-altos': { titulo: 'Altos', texto: 'Problemas serios que no son una puerta abierta inmediata, pero que conviene arreglar esta semana.' },
  'cifra-incidentes': { titulo: 'Incidentes abiertos', texto: 'Ataques en vivo que siguen sin cerrar. Tócalo para verlos y decidir si bloqueas al atacante.' },
  'cifra-fuentes': { titulo: 'Fuentes', texto: 'Cuántos de tus servicios estamos mirando de todos los posibles. Con todo conectado, el puntaje es completo.' },
  'cifra-ultima-auditoria': { titulo: 'Última auditoría', texto: 'Cuándo terminó la última revisión completa. Si hace mucho, lanza otra con «Auditar todo».' },
  ahora: { titulo: 'Ahora', texto: 'Lo que necesita tu atención en este momento, lo más grave primero. Cada fila lleva al detalle y a cómo corregirlo.' },
  severidad: { titulo: 'Gravedad', texto: 'Crítica: arréglalo hoy; alta: esta semana; media y baja: cuando puedas. Info es solo un dato, no un problema.' },

  // Módulos (la barra de cada pantalla).
  'modulo-supabase': { titulo: 'Supabase: lo que reviso', texto: 'Sobre todo RLS: las reglas que deciden qué filas puede ver cada usuario. Una tabla sin RLS la puede leer cualquiera con tu clave pública. La clave service_role se salta esas reglas: nunca debe estar en tu web.' },
  'modulo-cloudflare': { titulo: 'Cloudflare: lo que reviso', texto: 'Tu configuración y el tráfico que llega a tu web. El WAF es el filtro de Cloudflare que frena ataques conocidos antes de que lleguen a tu app; te digo si está activo.' },
  'modulo-codebase': { titulo: 'Codebase: lo que reviso', texto: 'Contraseñas y claves escritas en el código, archivos .env subidos al repo y dependencias vulnerables: librerías que usas en una versión con un fallo de seguridad público (un CVE).' },
  'modulo-rendimiento': { titulo: 'Rendimiento: lo que mido', texto: 'Lo rápido que carga tu web en móvil y en escritorio, con Lighthouse. Una web lenta pierde visitas; aquí ves si va a mejor o a peor.' },
  revisado: { titulo: 'Revisado', texto: 'Lo que comprobé y salió bien. Un cero aquí es una buena noticia: ese problema no está en tu sistema.' },

  // Cloudflare.
  'trafico-vivo': { titulo: 'Tráfico en vivo', texto: 'Las peticiones que recibe tu web en los últimos 5 minutos y las IPs que más piden. Una IP que pide muchísimo puede ser un ataque.' },
  'sensor-ingesta': { titulo: 'Sensor de ingesta', texto: 'Un trocito de código en tu app que nos cuenta cada petición al momento. Sin él, solo vemos las cifras de Cloudflare cada 5 minutos.' },
  'modo-blindaje': { titulo: 'Modo blindaje', texto: 'Un permiso extra, aparte del de lectura, que deja a VanGUARD bloquear una IP atacante o activar el modo bajo ataque, siempre con tu aprobación.' },

  // Incidentes.
  cronometro: { titulo: 'Cronómetro', texto: 'El tiempo desde el primer ataque hasta ahora, o hasta que se bloqueó. Cuanto menos, mejor.' },
  'bloquear-ip': { titulo: 'Bloquear IP', texto: 'Le pide a Cloudflare que no deje pasar a esa dirección durante un tiempo. Puedes deshacerlo cuando quieras.' },
  'bajo-ataque': { titulo: 'Modo bajo ataque', texto: 'Cuando el ataque viene de muchas IPs a la vez, Cloudflare hace una comprobación rápida a cada visitante antes de dejarle pasar. Los humanos pasan; los bots, casi nunca.' },

  // Codebase.
  'revision-codigo': { titulo: 'Revisión automática de código', texto: 'Cada vez que alguien sube cambios a GitHub, reviso solo lo nuevo y aviso si trae un problema de seguridad antes de que llegue a producción.' },
  'analizar-zip': { titulo: 'Analizar un ZIP', texto: 'Revisa una copia de tu código sin conectar GitHub. El análisis se hace en tu navegador: el código no sale de tu equipo.' },

  // Wiki, evolución, rendimiento y hallazgos.
  'wiki-estimacion': { titulo: 'Estimación', texto: 'Antes de generar la wiki te digo cuánto costará en IA, según el tamaño del repo. Nada se gasta hasta que confirmas.' },
  lighthouse: { titulo: 'Lighthouse', texto: 'La prueba de velocidad de Google. Da una nota de 0 a 100 y mide, por ejemplo, cuánto tarda en verse lo principal de tu página.' },
  'confianza-hallazgo': { titulo: 'Confirmado o posible', texto: 'Confirmado: una regla lo comprobó sin dudas. Posible: hay señales, pero conviene que una persona lo revise.' },

  // Llevar a tu IA.
  'exportar-ia': { titulo: 'Para tu IA', texto: 'Copia o descarga tus hallazgos con instrucciones para arreglarlos. Las claves y secretos salen tapados.' },
  'estado-correccion': { titulo: 'Enviado a tu IA', texto: 'Muestra en qué va el arreglo que mandaste a tu IA: «Enviado» si aún no lo ha pedido, «Arreglando» si ya pidió la corrección y «Corregido» si la auditoría ya no ve el problema.' },
  mcp: { titulo: 'MCP', texto: 'MCP es un enchufe estándar para que una IA, como Claude o Cursor, consulte VanGUARD por sí sola. Solo puede leer: nunca cambia nada.' },
  'mcp-tokens': { titulo: 'Tokens MCP', texto: 'La llave que le das a tu IA para conectarse. Crea una por cada IA o persona; si una se pierde, revócala y crea otra.' },
} as const satisfies Record<string, TextoInfo>;

export type IdInfo = keyof typeof INFO;
export const esIdInfo = (id: unknown): id is IdInfo => typeof id === 'string' && Object.hasOwn(INFO, id);
