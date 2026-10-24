// Guía en lenguaje llano por pantalla: «¿Cómo leer este módulo?» (S14 §14.12). Textos de UI en español.
import type { IdNav } from './nav';

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
    'Cada problema trae «Ver y corregir»: te damos el arreglo listo para pegar en tu IA.',
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
  performance: { titulo: '¿Cómo leer este módulo?', pasos: [
    'Medimos tu web con Lighthouse (el mismo de PageSpeed Insights) y la comparamos con la medición anterior.',
    'Si una métrica empeora frente a la anterior, la marcamos en ámbar para que sepas qué cambio la causó.',
  ] },
  audit: { titulo: '¿Cómo funciona la auditoría?', pasos: [
    'Un botón revisa todo tu ecosistema por pasos: Supabase, Cloudflare, tu repo y el rendimiento.',
    'Verás cada paso avanzar en vivo. Si una fuente no está conectada, ese paso sale «sin mirar» y el puntaje lo dice.',
    'Al final, una IA resume lo encontrado en lenguaje llano. Si la IA está en pausa, sale un resumen automático.',
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
    'Solo tokens de solo lectura: con ellos podemos mirar, nunca escribir.',
    'Si pegas una clave que puede escribir (como la secreta de Supabase o un token clásico de GitHub), la rechazamos sin que salga de tu navegador.',
    'Después de guardar, solo verás los últimos 4 caracteres del token.',
  ] },
  settings: { titulo: '¿Qué puedes ajustar?', pasos: [
    'A quién avisamos y por qué canal: WhatsApp primero y, si hace falta, una llamada.',
    'Prueba cada canal antes de una emergencia para saber que el aviso llega.',
  ] },
};
