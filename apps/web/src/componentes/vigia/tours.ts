// Recorridos de Vigía. Cada paso señala un elemento con data-guia="<objetivo>" (los pone el componente que lo pinta) y,
// si hace falta, antes navega a `ruta` (relativa a /o/:orgId/). Los textos son fijos: nunca llevan datos del servidor.
// `textoLectura` sustituye al texto en la demo de solo lectura. tours.test.ts comprueba que cada objetivo existe en algún
// componente. BIENVENIDA son las frases de la presentación de la primera visita (Escena.tsx la encadena con el recorrido
// «bienvenida»).
export type PasoTour = { objetivo: string; texto: string; textoLectura?: string; ruta?: string };
export type Tour = { titulo: string; resumen: string; pasos: readonly PasoTour[]; final: string };

export const TOURS = {
  'primeros-pasos': {
    titulo: 'Primeros pasos',
    resumen: 'Un paseo por VanGUARD en un minuto.',
    pasos: [
      { objetivo: 'nav-connections', texto: 'Todo empieza aquí: conecta tu Supabase, tu Cloudflare o tu repo de GitHub. Solo pido permisos de lectura.',
        textoLectura: 'Todo empieza aquí: se conectan Supabase, Cloudflare y el repo de GitHub, siempre con permisos de lectura. En la demo ya están conectados.' },
      { objetivo: 'nav-audit', texto: 'Con algo conectado, lanza «Auditar todo»: reviso tu ecosistema y te doy un puntaje de blindaje.',
        textoLectura: 'Aquí está la última auditoría: reviso todo el ecosistema y doy un puntaje de blindaje.' },
      { objetivo: 'nav-overview', texto: 'En el Resumen ves tu puntaje y lo más urgente ahora mismo.' },
      { objetivo: 'nav-incidents', texto: 'Si alguien ataca tu app en vivo, aparece aquí y te aviso por WhatsApp.' },
      { objetivo: 'nav-export', texto: 'Aquí llevas tus hallazgos a tu IA, o la conectas por MCP para que los arregle.' },
      { objetivo: 'buscar', texto: 'Un truco: Ctrl+K te lleva a cualquier pantalla.' },
    ],
    final: '¡Listo! Cuando me necesites, toca el ojo de arriba.',
  },
  'conectar-ia': {
    titulo: 'Arreglar con tu IA',
    resumen: 'Conecta Claude Code o Cursor por MCP y resuelve con un botón.',
    pasos: [
      { ruta: 'export', objetivo: 'mcp-tokens', texto: 'Crea aquí un token MCP de solo lectura. Lo verás una sola vez: guárdalo.',
        textoLectura: 'Aquí se crean los tokens MCP de solo lectura. En la demo no puedes crearlos: lo hace un administrador.' },
      { ruta: 'export', objetivo: 'mcp-guias', texto: 'Abre la guía de tu IA y copia el comando o la configuración con el token.' },
      { ruta: 'export', objetivo: 'mcp-resolver', texto: 'Con tu IA conectada, este botón la pone a resolver lo más grave, uno por uno y enseñándote el diff.' },
    ],
    final: 'Hecho. En cada hallazgo también tienes «Resolver con mi IA».',
  },
  bienvenida: {
    titulo: 'Bienvenida',
    resumen: 'Te presento VanGUARD zona por zona.',
    pasos: [
      { objetivo: 'nav-overview', texto: 'Esto es el Resumen: tu puntaje de blindaje y lo más urgente, de un vistazo.' },
      { objetivo: 'nav-supabase', texto: 'Aquí empieza tu ecosistema: Supabase, Cloudflare, tu repo y el rendimiento de tu web, cada uno con su pantalla.' },
      { objetivo: 'nav-audit', texto: '«Auditoría» lo revisa todo con un botón y te dice qué arreglar primero.',
        textoLectura: 'En «Auditoría» está la última revisión completa y qué arreglar primero.' },
      { objetivo: 'nav-incidents', texto: 'Si alguien ataca tu app en vivo, lo verás aquí. Y te aviso por WhatsApp.' },
      { objetivo: 'nav-export', texto: 'En «Llevar a tu IA» conectas tu IA por MCP. Es lo que me hará falta para que, más adelante, la pongamos a arreglar problemas.' },
      { objetivo: 'nav-connections', texto: 'Aquí conectas tus servicios. Solo pido permisos de lectura.',
        textoLectura: 'Aquí se conectan los servicios, siempre con permisos de lectura. En la demo ya están conectados.' },
      { objetivo: 'buscar', texto: 'Un truco: con la lupa, o con Ctrl+K, saltas a cualquier pantalla.' },
      { objetivo: 'vigia', texto: 'Y este ojo soy yo: tócalo cuando quieras que te explique algo.' },
    ],
    final: '¡Ya conoces VanGUARD! Aquí estaré.',
  },
} satisfies Record<string, Tour>;
export type IdTour = keyof typeof TOURS;
export const ID_TOURS = Object.keys(TOURS) as IdTour[];

/** Frases de la presentación (primera visita), en orden. */
export const BIENVENIDA = {
  saludo: '¡Hola! Soy Vigía, tu guía en VanGUARD. Te acompaño mientras vigilas tu Supabase, tu Cloudflare y tu repo.',
  ayuda: 'Cuando quieras que te explique algo, toca el ojo de arriba: te enseño cualquier pantalla paso a paso.',
  futuro: 'Y muy pronto podrás arrastrarme sobre un problema de seguridad para que tu IA lo arregle. Para eso, antes, conéctala por MCP en «Llevar a tu IA».',
  oferta: '¿Te enseño la app? Es un minuto.',
  despedida: 'Vale. Cuando me necesites, toca el ojo de arriba.',
} as const;

/** En móvil el riel vive plegado en un menú: los pasos que señalan sus entradas se cambian por uno solo que señala el
 *  botón del menú (data-guia="menu"). */
export const PASO_MENU: PasoTour = {
  objetivo: 'menu',
  texto: 'En pantallas pequeñas, los módulos viven en este menú: el Resumen, tu ecosistema, Auditoría, Incidentes y «Llevar a tu IA».',
};

/** Pasos listos para la pantalla: si el riel no se ve, las entradas del riel se juntan en PASO_MENU (donde estaba la
 *  primera); el resto queda igual. */
export function adaptarPasos(pasos: readonly PasoTour[], rielVisible: boolean): PasoTour[] {
  if (rielVisible) return [...pasos];
  const fuera = (p: PasoTour) => p.objetivo.startsWith('nav-') && !p.ruta;
  const i = pasos.findIndex(fuera);
  if (i < 0) return [...pasos];
  return pasos.flatMap((p, k) => (k === i ? [PASO_MENU] : fuera(p) ? [] : [p]));
}

/** El texto que toca: el de solo lectura en la demo, si el paso lo trae. */
export const textoDe = (p: PasoTour, soloLectura: boolean) => (soloLectura && p.textoLectura ? p.textoLectura : p.texto);
