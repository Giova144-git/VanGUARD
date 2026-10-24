// Ids que llegan por la URL (/incidents/:id, /findings/:id, /audit/:id, ?finding=, ?run=). Todo id de VanGUARD es un
// UUID: cualquier otra cosa se trata como «no existe» sin llamar a la API, así un enlace preparado con «../», «%2F» o
// «?» no puede desviar la petición autenticada a otro endpoint (path traversal del lado del cliente, F-14).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const esId = (v: string | null | undefined): v is string => typeof v === 'string' && UUID.test(v);

// Camino de la API (lo de antes de «?»): solo segmentos [A-Za-z0-9_-]. Nada de «.», «..», «%», «\» ni «//».
const CAMINO = /^\/api(?:\/[\w-]+)+$/;
export const caminoValido = (ruta: string) => CAMINO.test(ruta.split('?', 1)[0]!) && !ruta.includes('#');
