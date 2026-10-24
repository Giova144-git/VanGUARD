# VanGUARD

**Una herramienta que protege tu producto.** Analizamos tu ecosistema contra los puntos débiles conocidos, te avisamos en tiempo real cuando algo va mal y te damos cómo corregirlo.

## El problema

Hoy una startup lanza su producto en días sobre Supabase, Cloudflare, Vercel y GitHub, muchas veces con código escrito con ayuda de IA. Esa velocidad deja huecos que nadie revisa: tablas sin RLS que cualquiera puede leer con la clave pública, funciones sin límite de tasa, un `.env` subido al repositorio, dependencias con CVE conocidos o un ataque que satura el servidor un sábado a las 4 de la mañana. Cada proveedor muestra su parte en su propio panel, y casi ningún equipo pequeño tiene a alguien de seguridad mirando todo a la vez.

## Qué hace

VanGUARD junta todo tu ecosistema en un solo panel, organizado por módulos con botones grandes y una guía paso a paso. Solo cargas tus tokens o conectas tu repo.

- **Supabase:** salud y rendimiento de la base (CPU, memoria, disco y conexiones), tablas con RLS desactivada, políticas permisivas, funciones expuestas sin límite de tasa, tablas hinchadas, índices que faltan o sobran, y redundancia.
- **Cloudflare:** IPs y user agents insistentes, escaneo de rutas, picos de tráfico y posibles DDoS, y configuración débil (SSL, TLS, DNS que expone el servidor de origen).
- **Codebase:** conecta un repo de GitHub. Detectamos el stack, cruzamos las versiones de tus dependencias con las bases públicas de vulnerabilidades (CVE), revisamos el `.gitignore`, buscamos archivos `.env` subidos y credenciales filtradas en el código. También puedes analizar un ZIP en tu navegador, sin que tu código salga de tu equipo: te mostramos los `.env` subidos, las credenciales filtradas y tus dependencias. Próximamente: guardar ese análisis en tu panel.
- **Revisión de código en cada push:** cada push, merge y pull request a `main` se revisa en segundos. Si aparece una clave o un `.env` nuevo, te avisamos por WhatsApp según la severidad mínima que elijas en Ajustes.
- **Rendimiento (próximamente):** mediciones de tu web con Lighthouse (vía PageSpeed Insights) en móvil y escritorio, y un histórico que compara cada medición con la anterior y marca en ámbar la métrica que empeoró. Más adelante, tiempos de compilación, errores por versión y el diagnóstico del cuello de botella.
- **Auditoría con un botón:** revisa todo el ecosistema de una vez y lo resume en un puntaje de blindaje.

## Alertas y corrección

Un motor de reglas vigila en tiempo real y, ante un ataque o una falla crítica, te escribe por WhatsApp (Kapso). Cada alerta trae una acción propuesta para neutralizar el problema, que solo se ejecuta con tu confirmación. Próximamente: también te llamará con una voz (ElevenLabs) que explica qué pasó.

Claude explica cada hallazgo en lenguaje claro y genera un **prompt de corrección** listo para pegar en la IA que use tu equipo. Además, todos los hallazgos se pueden exportar a cualquier IA, para que alguien que nunca usó la plataforma también pueda auditar su proyecto.

## Seguro por diseño

- Las credenciales nunca se guardan en claro: se cifran y la clave maestra vive en Supabase Vault.
- Las integraciones piden permisos de solo lectura. Las acciones de escritura son opcionales y se confirman aparte.
- Quien decide si se alerta es el motor de reglas, no el modelo, así que un texto malicioso en un log no puede apagar una alerta.
- A la IA y a la mensajería solo llegan resúmenes, con los secretos redactados.

## Stack

Supabase (base de datos, autenticación, Vault y tiempo real), Claude API como motor de análisis, Kapso para WhatsApp y las APIs de Supabase, Cloudflare y GitHub para las integraciones. Próximamente: PageSpeed Insights (Lighthouse) para el rendimiento y ElevenLabs para las llamadas de voz.

## Equipo

team-22, Platanus Hack 26 Caracas, track AI Security: Carlos Bastidas, Giovanni Zarbo De Michele, Daniel Alejandro Barreda López, Andrés Valero y Gabriel Enrique García Ruíz.
