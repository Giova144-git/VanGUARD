// Plantillas deterministas de WhatsApp (S12 12.6, S15 15.9 y 15.10): {resumen} por regla con el texto EXACTO de la
// tabla de §12.6 y {header, body, footer} de incident_v1 / incident_up_v1 / reopened_v1. En P0 salen tal cual; en P1
// IA-3 solo puede sustituir {resumen}. Nunca IP completa, claves ni correos: la IP va recortada (186.92.x.x), el UA se
// reduce a la herramienta de una lista fija y todo texto libre pasa por redactString. Los botones llevan nonces que
// genera el despachador (aquí solo se validan y se arman los ids que parsea el webhook). Botones de la revisión de
// código y sus respuestas (asignaciones/avisos-whatsapp-botones.md): al final del archivo.
import type { Module, Severity } from '@vanguard/contracts';
import { hostCanonico, MIN_IPS_BAJO_ATAQUE, TTL_BAJO_ATAQUE_S } from '../bajo-ataque.ts';
import { ipCanonica, ipCorta, recursoCorto, uaParaMensaje } from '../engine/edge.ts';
import { moduloDeRegla, reglaPrincipal, SERVICIO_MODULO, servicioDeReglas } from '../engine/incidente.ts';
import { redactString } from '../redact.ts';
import { generica, plantillaCorreccion } from './fix/index.ts';
import { enCodigo, SEVERIDAD_ES, unaLinea } from './titles.ts';

// ── {resumen} por regla (tabla de §12.6, literal: sin tildes a propósito) ────────────────────────────────────────
export const RESUMEN_REGLA = {
  CF_IP_FLOOD: 'Una IP hizo {n} peticiones en 60 s ({share}% del trafico) contra {host}. Posible ataque de volumen. Accion propuesta: bloquear la IP.',
  CF_UA_TOOL: 'Trafico con herramienta de ataque ({ua}) contra {host}: {n} peticiones en 60 s. Accion propuesta: bloquear la IP.',
  CF_PATH_SCAN: 'Una IP escaneo {paths_4xx} rutas y probo ficheros sensibles en {host}. Posible reconocimiento. Accion propuesta: bloquear la IP.',
  CF_ADMIN_EXPOSED: 'Una ruta de administrador de {host} respondio sin sesion. Acceso no autorizado posible. Revisa /api/admin.',
  SB_DB_DOWN: 'La base de {servicio} no responde sana desde hace 2 minutos. Revisa el estado del proyecto.',
  SB_CPU_HIGH: 'La CPU de la base de {servicio} lleva {min} min por encima del {pct}%. Posible consulta sin indice o ataque.',
} as const;
export type ReglaConResumen = keyof typeof RESUMEN_REGLA;
/** Para una regla sin fila en la tabla (no debería pasar en P0). */
export const RESUMEN_GENERICO = 'Nueva alerta en {servicio}. Abre el panel para ver el detalle.';

/** Datos de la plantilla. `ua` es el user-agent CRUDO (o ya recortado): se reduce aquí a la herramienta. */
export type DatosResumen = {
  host?: string | null; n?: number | null; share?: number | null; ua?: string | null; paths_4xx?: number | null;
  servicio?: string | null; min?: number | null; pct?: number | null;
};

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** Texto libre para un mensaje: redactado (claves, correos, teléfonos), IPv4 recortadas y en una línea de ≤ max. */
export const textoSeguro = (s: string, max: number): string => unaLinea(redactString(String(s)).replace(IPV4, (m) => ipCorta(m)), max);
const entero = (n: number | null | undefined) => String(typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
const rellenar = (plantilla: string, v: Readonly<Record<string, string>>) =>
  plantilla.replace(/\{([a-z0-9_]+)\}/g, (m, k: string) => v[k] ?? m);   // una pasada: un valor no puede abrir otra variable

export function resumenRegla(ruleId: string, d: DatosResumen = {}): string {
  const servicio = d.servicio?.trim() ? textoSeguro(d.servicio, 40) : servicioDeReglas([ruleId]);
  const v = {
    host: d.host?.trim() ? textoSeguro(d.host, 60) : 'tu sitio', n: entero(d.n), share: entero(Math.min(100, d.share ?? 0)),
    ua: uaParaMensaje(d.ua), paths_4xx: entero(d.paths_4xx), servicio, min: entero(d.min), pct: entero(d.pct),
  };
  const t = (RESUMEN_REGLA as Readonly<Record<string, string>>)[ruleId] ?? RESUMEN_GENERICO;
  return rellenar(t, v);
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x : null);
/** `incidents.details` (jsonb de la base) → datos de la plantilla. share sale de share_pct o de n_60s/total_60s. */
export function datosDeDetalles(details: Readonly<Record<string, unknown>> | null | undefined, host?: string | null): DatosResumen {
  const o = details ?? {};
  const n = num(o.n_60s), total = num(o.total_60s);
  return {
    host: str(o.host) ?? host ?? null, n, ua: str(o.ua_top), paths_4xx: num(o.paths_4xx), servicio: str(o.servicio),
    share: num(o.share_pct) ?? (n !== null && total ? (100 * n) / total : null), min: num(o.min), pct: num(o.pct),
  };
}

// ── Hora de Caracas (UTC−4 fijo desde 2016, sin horario de verano) ───────────────────────────────────────────────
let formato: Intl.DateTimeFormat | null | undefined;
function fmtCaracas(): Intl.DateTimeFormat | null {
  if (formato === undefined) {
    try {
      formato = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch {
      formato = null;
    }
  }
  return formato;
}
/** Hora y minuto en America/Caracas; null si la fecha no es válida. Sin Intl con zonas, cae al desfase fijo −4 h. */
export function partesCaracas(t: string | number | Date): { h: number; m: number } | null {
  const ms = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  const f = fmtCaracas();
  if (f) {
    try {
      const p = f.formatToParts(new Date(ms));
      const h = Number(p.find((x) => x.type === 'hour')?.value), m = Number(p.find((x) => x.type === 'minute')?.value);
      if (Number.isInteger(h) && Number.isInteger(m)) return { h: h % 24, m };
    } catch { /* desfase fijo */ }
  }
  const d = new Date(ms - 4 * 3_600_000);
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}
const dos = (n: number) => String(n).padStart(2, '0');
/** {hora_local} de §12.6: `HH:mm` en America/Caracas; `--:--` si la fecha no es válida. */
export function horaCaracas(t: string | number | Date): string {
  const p = partesCaracas(t);
  return p ? `${dos(p.h)}:${dos(p.m)}` : '--:--';
}

// ── Interactivo de alerta: incident_v1, incident_up_v1, reopened_v1 ──────────────────────────────────────────────
export type PlantillaInteractiva = 'incident_v1' | 'incident_up_v1' | 'reopened_v1';
/** Lo que el despachador lee de incidents (y de la respuesta del upsert) para armar el aviso. */
export type IncidenteParaAviso = {
  code: string; severity: Severity; rule_ids: readonly string[]; resource: string; last_event_at: string | number | Date;
  details?: Readonly<Record<string, unknown>> | null;
};
export type OpcionesMensaje = {
  host?: string | null;      // connections.label si details.host falta
  regla?: string | null;     // fuerza la regla del {resumen} (por defecto, reglaPrincipal)
  resumen?: string | null;   // P1: texto de IA-3 ya filtrado por checkSalidaIA; vacío → plantilla
};
export type MensajeAlerta = { header: string; body: string; footer: string };

const MAX_BODY = 1024;
/** CRÍTICA, ALTA, MEDIA, BAJA, INFORMATIVA. */
export const severidadMayus = (s: Severity): string => (SEVERIDAD_ES[s] ?? String(s)).toUpperCase();
const codigoLimpio = (c: string) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

export function cabeceraAlerta(plantilla: PlantillaInteractiva, severity: Severity, servicio: string): string {
  if (plantilla === 'incident_up_v1') return `SUBIÓ A CRÍTICA · ${servicio}`;
  if (plantilla === 'reopened_v1') return `Volvió a aparecer · ${servicio}`;
  return `ALERTA ${severidadMayus(severity)} · ${servicio}`;
}

/** header/body/footer del interactivo de §12.6 (los botones van aparte, con botonesAlerta). body ≤ 1024: si no cabe,
 *  se recorta el {resumen}, nunca el recurso ni la hora. */
export function mensajeIncidente(i: IncidenteParaAviso, plantilla: PlantillaInteractiva, o: OpcionesMensaje = {}): MensajeAlerta {
  const servicio = servicioDeReglas(i.rule_ids);
  const regla = o.regla ?? reglaPrincipal(i.rule_ids, i.severity) ?? '';
  const ia = o.resumen?.trim() ? textoSeguro(o.resumen, 300) : '';
  const cola = `\n\nRecurso: ${recursoCorto(i.resource)}\nHora: ${horaCaracas(i.last_event_at)}`;
  const resumen = unaLinea(ia || resumenRegla(regla, datosDeDetalles(i.details, o.host)), MAX_BODY - cola.length);
  return { header: cabeceraAlerta(plantilla, i.severity, servicio), body: resumen + cola,
    footer: `Incidente #${codigoLimpio(i.code)} · VanGUARD` };
}

// ── Botones (ids que parsea parsearBoton del webhook: `accion:CODIGO:nonce`, CODIGO [A-Z0-9]{6}, nonce de 16–43 base64url)
// Incidente: ack, snz, blk y su confirmación ok/no. Anexo de botones: fix (enviarme el arreglo), iss (pedir crear issue),
// rvs (silenciar el repo 1 h), rpr (pedir reabrir el PR), uat (pedir modo bajo ataque); la confirmación de las que
// escriben en sistemas del cliente reutiliza ok/no con su aprobación (TITULOS_CONFIRMACION).
export const ACCIONES_BOTON = ['ack', 'snz', 'blk', 'ok', 'no', 'fix', 'iss', 'rvs', 'rpr', 'uat'] as const;
export type AccionBoton = (typeof ACCIONES_BOTON)[number];
export const TITULOS_BOTON: Readonly<Record<AccionBoton, string>> = {
  ack: 'Lo estoy viendo', snz: 'Silenciar 1 h', blk: 'Bloquear IP', ok: 'Sí, bloquear', no: 'Cancelar',
  fix: 'Enviarme el arreglo', iss: 'Crear issue', rvs: 'Silenciar repo 1 h', rpr: 'Reabrir el PR', uat: 'Modo bajo ataque',
};
/** Título del `ok` según la acción que confirma (regla 2 del anexo: toda escritura en sistemas del cliente lleva el 2.º
 *  paso): blk «Bloquear IP», iss «Crear issue», rpr «Reabrir el PR» y uat «Modo bajo ataque». */
export const TITULOS_CONFIRMACION = {
  blk: 'Sí, bloquear', iss: 'Sí, crear', rpr: 'Sí, reabrir', uat: 'Sí, activar',
} as const;
export type AccionConConfirmacion = keyof typeof TITULOS_CONFIRMACION;
export type BotonAlerta = { id: string; title: string };
const CODIGO = /^[A-Z0-9]{6}$/;
const NONCE = /^[A-Za-z0-9_-]{16,43}$/;
/** `accion:CODIGO:nonce`; lanza RangeError si el código o el nonce no casan con la regex del webhook (un botón que no se
 *  puede canjear no se envía). */
export function idBoton(accion: AccionBoton, code: string, nonce: string): string {
  if (!CODIGO.test(code)) throw new RangeError('BOTON_CODIGO');
  if (!NONCE.test(nonce)) throw new RangeError('BOTON_NONCE');
  return `${accion}:${code}:${nonce}`;
}
/** «Lo estoy viendo», «Silenciar 1 h» y, si se pasa su nonce, «Bloquear IP» (solo cuando ofreceBloqueo). Un nonce por
 *  botón; nonces repetidos → RangeError (cada uno es una fila de approvals con su sha256). */
export function botonesAlerta(code: string, nonces: { ack: string; snz: string; blk?: string | null }): BotonAlerta[] {
  const xs: [AccionBoton, string][] = [['ack', nonces.ack], ['snz', nonces.snz]];
  if (nonces.blk) xs.push(['blk', nonces.blk]);
  if (new Set(xs.map(([, n]) => n)).size !== xs.length) throw new RangeError('BOTON_NONCE_REPETIDO');
  return xs.map(([a, n]) => ({ id: idBoton(a, code, n), title: TITULOS_BOTON[a] }));
}
/** Interactivo de E20 por WhatsApp: «Sí, bloquear» y «Cancelar». `accion` elige el título del ok (por defecto blk, el
 *  de hoy: el interactivo del bloqueo no cambia). */
export function botonesAprobacion(code: string, nonces: { ok: string; no: string },
  accion: AccionConConfirmacion = 'blk'): BotonAlerta[] {
  if (nonces.ok === nonces.no) throw new RangeError('BOTON_NONCE_REPETIDO');
  return [{ id: idBoton('ok', code, nonces.ok), title: TITULOS_CONFIRMACION[accion] },
    { id: idBoton('no', code, nonces.no), title: TITULOS_BOTON.no }];
}
/** §12.6: el botón «Bloquear IP» solo va si el incidente es de Cloudflare con resource ip:<ip válida> y la org tiene una
 *  conexión Cloudflare kind:'action' activa (no se ofrece lo que no se puede hacer). */
export function ofreceBloqueo(i: { rule_ids: readonly string[]; resource: string }, conexionAccionActiva: boolean): boolean {
  return conexionAccionActiva && moduloDeRegla(i.rule_ids[0]) === 'cloudflare' && i.resource.startsWith('ip:')
    && ipCanonica(i.resource.slice(3)) !== null;
}

// ── Textos simples ───────────────────────────────────────────────────────────────────────────────────────────────
/** storm_v1 (§12.6): un solo texto al contacto de prioridad 1. «6 alertas nuevas en 2 min: 4 de Cloudflare y 2 de
 *  Supabase. Abre el panel para verlas.» */
export function textoTormenta(k: number, porModulo: Readonly<Partial<Record<Module, number>>>): string {
  const orden = Object.keys(SERVICIO_MODULO) as Module[];
  const partes = orden.map((m) => [m, Math.round(porModulo[m] ?? 0)] as const).filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]).map(([m, n]) => `${n} de ${SERVICIO_MODULO[m]}`);
  const detalle = partes.length === 0 ? 'varios servicios'
    : partes.length === 1 ? partes[0]! : `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]!}`;
  return `${entero(k)} alertas nuevas en 2 min: ${detalle}. Abre el panel para verlas.`;
}
/** Código de E20 por WhatsApp (S15 E20, texto exacto). `codigo` = 6 dígitos de sixDigitCode(). */
export function textoCodigoBloqueo(codigo: string, ip: string, zona: string): string {
  if (!/^\d{6}$/.test(codigo)) throw new RangeError('CODIGO_BLOQUEO');
  return `Código ${codigo} para bloquear la IP ${ipCorta(ip)} durante 1 h en ${textoSeguro(zona, 60)}. Vence en 10 min.`;
}
/** Confirmación tras el botón `ok` (S15 15.10). */
export const textoBloqueada = (ip: string): string => `Bloqueada ${ipCorta(ip)} por 1 h. Puedes deshacerlo en la app.`;
/** Canje sin filas en el webhook (S15 15.10). */
export const TEXTO_CODIGO_VENCIDO = 'Código vencido o ya usado. Abre officialvanguard.com';

// ── Revisión de código: botones y respuestas (asignaciones/avisos-whatsapp-botones.md) ──────────────────────────────
// Cada botón hace una acción real y toda acción contesta «Hecho: …» o «No se pudo: <motivo corto>». Nada de lo que
// sale aquí lleva texto del autor, valores ni texto de IA: solo frases nuestras, el rule_id (si casa su regex), la
// severidad, la hora, la url del panel (dominio propio) y lo que el anexo fija: número de PR y rama validados, el host
// canónico del ataque y la url del issue de github.com. El cuerpo del issue (GitHub, no WhatsApp) lleva además el archivo
// y la línea, solo si casan una lista corta de caracteres.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGLA = /^(SB|CF|CB|PF)_[A-Z0-9_]{1,60}$/;
const REGLA_REVISION = /^CB_[A-Z0-9_]{1,60}$/;
// La url es nuestra (APP_ORIGIN), pero solo ASCII de URL: ni blancos ni controles (como mensajeRevision).
const URL_PANEL = /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]{1,300}$/;
const MAX_PASOS = 6;

/** CODIGO de 6 caracteres de una revisión. code_reviews no tiene código: sale del id (los 6 primeros hex del uuid v4,
 *  aleatorios, en mayúsculas). Estable y sin columna nueva; solo comprueba que el botón y su aprobación hablan de la misma
 *  revisión (lo que protege es el nonce de un solo uso, como en los incidentes). Id que no es uuid → RangeError. */
export function codigoRevision(id: string): string {
  if (!UUID.test(String(id))) throw new RangeError('REVISION_ID');
  return id.slice(0, 6).toUpperCase();
}

// Los botones de UN mensaje, en orden (≤ 3: máximo de Meta). Un nonce por botón; repetidos → RangeError (cada uno es una
// fila de approvals con su sha256).
function botones(code: string, xs: readonly (readonly [AccionBoton, string | null | undefined])[]): BotonAlerta[] {
  const ys = xs.filter((x): x is readonly [AccionBoton, string] => x[1] != null);   // '' llega a idBoton y lanza
  if (ys.length > 3) throw new RangeError('BOTONES_DEMASIADOS');
  if (new Set(ys.map(([, n]) => n)).size !== ys.length) throw new RangeError('BOTON_NONCE_REPETIDO');
  return ys.map(([a, n]) => ({ id: idBoton(a, code, n), title: TITULOS_BOTON[a] }));
}

/** Aviso de revisión: «Enviarme el arreglo» (solo si llega su nonce: la revisión trae hallazgos nuevos), «Crear issue»
 *  (solo si llega su nonce: hallazgos nuevos y token de escritura del mismo repo con «Issues: Read and write») y
 *  «Silenciar repo 1 h», en ese orden. */
export function botonesRevision(code: string, nonces: { fix?: string | null; iss?: string | null; rvs: string }):
  BotonAlerta[] {
  return botones(code, [['fix', nonces.fix || null], ['iss', nonces.iss || null], ['rvs', nonces.rvs]]);
}

/** Aviso «VanGUARD cerró el PR»: «Reabrir el PR», «Enviarme el arreglo» (solo si llega su nonce) y «Silenciar repo 1 h». */
export function botonesPrCerrado(code: string, nonces: { rpr: string; fix?: string | null; rvs: string }): BotonAlerta[] {
  return botones(code, [['rpr', nonces.rpr], ['fix', nonces.fix || null], ['rvs', nonces.rvs]]);
}

/** 2.º mensaje del ataque en el que se puede activar el modo bajo ataque: solo «Modo bajo ataque» (el «Cancelar» va en
 *  su confirmación). `code` = el del incidente. */
export const botonOfertaBajoAtaque = (code: string, uat: string): BotonAlerta[] => botones(code, [['uat', uat]]);

const MAX_PR = 2_147_483_647;
const prValido = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= MAX_PR;
// Como mensajeRevision: sin puntos ni barras (WhatsApp convertiría `pagos.evil.com/login` en un enlace pulsable).
const RAMA = /^[A-Za-z0-9_-]{1,40}$/;
const MIN_BAJO_ATAQUE = Math.max(1, Math.round(TTL_BAJO_ATAQUE_S / 60));

/** Aviso «VanGUARD cerró el PR» (anexo bloqueo-merge-cierre-pr.md), texto FIJO del anexo de botones: «VanGUARD cerró el
 *  PR #{n} hacia {rama}: {k} crítico(s) nuevo(s). Corrige, rota las claves y vuelve a abrirlo.» La rama solo si casa una
 *  lista corta de caracteres (si no, «la rama vigilada»); con el umbral del bloqueo en high, «crítico(s) o alto(s)». Un
 *  número de PR que no es un entero válido → RangeError: no se avisa de algo que no se puede comprobar. */
export function textoPrCerrado(n: number, rama: unknown, k: number, umbral: 'critical' | 'high' = 'critical'): string {
  if (!prValido(n)) throw new RangeError('PR_NUMERO');
  const r = typeof rama === 'string' && RAMA.test(rama) ? rama : 'la rama vigilada';
  const c = Math.max(1, Number(entero(k)));
  const que = umbral === 'high' ? (c === 1 ? 'crítico o alto nuevo' : 'críticos o altos nuevos')
    : c === 1 ? 'crítico nuevo' : 'críticos nuevos';
  return `VanGUARD cerró el PR #${n} hacia ${r}: ${c} ${que}. Corrige, rota las claves y vuelve a abrirlo.`;
}

/** 2.º mensaje de bajo ataque (modo-bajo-ataque.md y el anexo de botones): «Ataque desde {n} IPs en {host}. Puedes poner
 *  ese host en modo bajo ataque 30 min.» host canónico (hostCanonico) y n ≥ 2 (la regla de E55); si no, RangeError: la
 *  oferta no aplica y no se envía. */
export function textoOfertaBajoAtaque(ips: number, host: string): string {
  if (hostCanonico(host) !== host) throw new RangeError('HOST_BAJO_ATAQUE');
  const n = Number(entero(ips));
  if (n < MIN_IPS_BAJO_ATAQUE) throw new RangeError('IPS_BAJO_ATAQUE');
  return `Ataque desde ${n} IPs en ${host}. Puedes poner ese host en modo bajo ataque ${MIN_BAJO_ATAQUE} min.`;
}

// ── Confirmaciones de lo que escribe en sistemas del cliente (regla 2 del anexo) y sus respuestas ──────────────────
/** Cuerpo del interactivo «Sí, crear» / «Cancelar». */
export const TEXTO_CONFIRMAR_ISSUE = '¿Creo un issue en GitHub con lo más grave de esta revisión? Llevará la regla, el '
  + 'archivo y la línea (sin el valor), los pasos para corregirlo y la etiqueta vanguard. Vence en 10 min.';
/** Cuerpo del interactivo «Sí, reabrir» / «Cancelar». */
export function textoConfirmarReabrir(n: number): string {
  if (!prValido(n)) throw new RangeError('PR_NUMERO');
  return `¿Reabro el PR #${n}? El ✗ de VanGUARD se queda hasta que lo corrijas. Vence en 10 min.`;
}
/** Cuerpo del interactivo «Sí, activar» / «Cancelar» (el host ya pasó hostCanonico; si no, RangeError). */
export function textoConfirmarBajoAtaque(host: string): string {
  if (hostCanonico(host) !== host) throw new RangeError('HOST_BAJO_ATAQUE');
  return `¿Activo el modo bajo ataque en ${host} durante ${MIN_BAJO_ATAQUE} min? Cada visitante pasará un desafío de `
    + 'Cloudflare y las llamadas de API, webhooks y apps a ese host fallarán mientras dure. Vence en 10 min.';
}

const URL_ISSUE = /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]{0,9}$/;
/** «Hecho: issue #n <url>». La url solo si es la de un issue de github.com (crearIssue ya exige el repo del token). */
export function textoIssueCreado(numero: number | null, url?: string | null): string {
  const n = prValido(numero) ? ` #${numero}` : '';
  if (n && typeof url === 'string' && URL_ISSUE.test(url)) return `Hecho: issue${n} ${url}`;
  return `Hecho: issue${n} creado en GitHub con la etiqueta vanguard. Lo ves en el repo.`;
}
/** «Hecho: PR #n reabierto.» */
export const textoPrReabierto = (n: number | null): string =>
  `Hecho: PR${prValido(n) ? ` #${n}` : ''} reabierto. El ✗ de VanGUARD se queda hasta que lo corrijas.`;
/** Modo bajo ataque puesto (o ya puesto), con la hora de fin en Caracas y cómo deshacerlo. */
export function textoBajoAtaqueActivo(host: string, hasta: string | number | Date, yaEstaba = false): string {
  const h = hostCanonico(host) ?? 'ese host';
  const que = yaEstaba ? `el modo bajo ataque ya estaba activo en ${h}` : `modo bajo ataque activo en ${h}`;
  return `Hecho: ${que} hasta las ${horaCaracas(hasta)} (hora de Caracas). Se quita solo a esa hora; para quitarlo `
    + 'antes, pulsa «Desactivar ahora» en el incidente, en la app.';
}
/** El modo de esa aprobación ya se retiró (executeUnderAttack devuelve la fila undone). */
export const TEXTO_BAJO_ATAQUE_YA_RETIRADO = 'Hecho: ese modo bajo ataque ya se retiró. Si el ataque sigue, vuelve a '
  + 'activarlo desde la app.';
/** «Cancelar» de cada confirmación; y si la confirmación ganó antes (el «Sí, …» ya se usó), lo dice. */
export const TEXTOS_CANCELADO = {
  iss: 'Cancelado: no creé el issue.', rpr: 'Cancelado: el PR sigue cerrado.',
  uat: 'Cancelado: no activé el modo bajo ataque.',
} as const;
export const TEXTO_YA_CONFIRMADO = 'No cancelé: esa acción ya estaba confirmada. Mira su resultado en la app.';

const RECURSO_ISSUE = /^[A-Za-z0-9_./@+-]{1,200}:[1-9][0-9]{0,6}$/;
/** «Crear issue»: título y cuerpo FIJOS para GitHub con el hallazgo nuevo más grave. Solo llevan la regla (si casa su
 *  regex), la severidad, el archivo y la línea (si casan una lista corta de caracteres, sin `..` y redactString no los
 *  toca; si no, «míralos en el panel»), los pasos de la plantilla (pasosArreglo, los mismos de «Enviarme el arreglo»), el
 *  número de los demás y el enlace al panel. Nunca el valor, la evidencia, el título del hallazgo ni texto del autor o de
 *  la IA (crearIssue vuelve a mirar que no lleve nada con forma de secreto ni controles bidi). */
export function issueDeRevision(h: { rule_id: string; severity: string; resource?: string | null }, url: string,
  otros = 0): { titulo: string; cuerpo: string } {
  const r = String(h.rule_id ?? '');
  const regla = REGLA.test(r) ? r : null;
  const s = String(h.severity);
  const sev = Object.hasOwn(SEVERIDAD_ES, s) ? ` de severidad ${SEVERIDAD_ES[s as Severity]}` : '';
  const x = typeof h.resource === 'string' ? h.resource : '';
  const recurso = RECURSO_ISSUE.test(x) && !x.includes('..') && redactString(x) === x ? x : null;
  const mas = Number(entero(otros));
  const lineas = [
    `VanGUARD encontró un hallazgo nuevo${sev} en un cambio de este repo.`, '',
    `- Regla: ${regla ? enCodigo(regla) : 'mírala en el panel de VanGUARD'}`,
    `- Archivo y línea: ${recurso ? enCodigo(recurso) : 'míralos en el panel de VanGUARD'}`,
    '- El valor no se copia aquí a propósito.',
    ...(mas ? [`- La misma revisión trae ${mas} ${mas === 1 ? 'hallazgo nuevo más' : 'hallazgos nuevos más'}: `
      + 'están en el panel.'] : []),
    '', 'Cómo corregirlo:', ...pasosArreglo(r).map((p, i) => `${i + 1}. ${p}`),
    ...(typeof url === 'string' && URL_PANEL.test(url) ? ['', `Detalle en VanGUARD (pide sesión): ${url}`] : []),
    '', 'Lo creó VanGUARD desde WhatsApp, a petición de un contacto verificado de la organización.',
  ];
  return { titulo: unaLinea(`VanGUARD: hallazgo${sev} en un cambio${regla ? ` (${regla})` : ''}`, 200),
    cuerpo: lineas.join('\n').slice(0, 10_000) };
}

/** Pasos cuando la regla no tiene plantilla propia: los de la genérica hablan de «la evidencia de abajo», que aquí no va. */
export const PASOS_ARREGLO_GENERICO: readonly string[] = [
  'Abre el hallazgo en el panel: ahí están el archivo y la línea.',
  'Aplica el cambio mínimo y reversible en un entorno de pruebas.',
  'Haz push con el arreglo: VanGUARD lo revisa y deja de avisar cuando quede resuelto.',
];

/** Pasos FIJOS de corrección para WhatsApp: los de la plantilla determinista de templates/fix (la del fallback de E15)
 *  llamada con recurso, evidencia y título VACÍOS, así que no pueden llevar valores, rutas ni texto del autor. Solo las
 *  CB_ (las que produce la revisión); otra regla, o una CB_ sin plantilla propia, → PASOS_ARREGLO_GENERICO. */
export function pasosArreglo(ruleId: string): string[] {
  const regla = String(ruleId ?? '');
  if (!REGLA_REVISION.test(regla)) return [...PASOS_ARREGLO_GENERICO];
  const h = { rule_id: regla, resource: '', evidence: {}, title: '' };
  const pasos = plantillaCorreccion(h).pasos;
  const gen = generica(h).pasos;
  if (pasos.length === gen.length && pasos.every((p, i) => p === gen[i])) return [...PASOS_ARREGLO_GENERICO];
  return pasos.slice(0, MAX_PASOS).map((p) => unaLinea(p, 400));
}

/** Respuesta de «Enviarme el arreglo» (fix): «Hecho: …» con la regla del hallazgo nuevo más grave (como código), su
 *  severidad, los pasos numerados y el enlace al panel (APP_ORIGIN/o/<org>/codebase?revision=<id>). ≤ 4096 (texto
 *  simple de Meta): ≤ 6 pasos de ≤ 400. */
export function textoArreglo(ruleId: string, severity: Severity | string | null, url: string): string {
  const r = String(ruleId ?? '');
  const regla = REGLA.test(r) ? enCodigo(r) : 'el hallazgo';
  const s = String(severity);
  const sev = Object.hasOwn(SEVERIDAD_ES, s) ? ` (severidad ${SEVERIDAD_ES[s as Severity]})` : '';
  const pasos = pasosArreglo(r).map((p, i) => `${i + 1}. ${p}`).join('\n');
  const donde = 'El hallazgo, con su archivo y su línea, está en el panel';
  const enlace = typeof url === 'string' && URL_PANEL.test(url) ? `${donde}: ${url}` : `${donde} de VanGUARD.`;
  return `Hecho: así se corrige ${regla}${sev}, lo más grave de esta revisión.\n\n${pasos}\n\n${enlace}`;
}

/** Respuesta de «Silenciar repo 1 h» (rvs), con la hora de fin en Caracas. */
export const textoRepoSilenciado = (hasta: string | number | Date): string =>
  `Hecho: no te mandaré avisos de revisión de este repo hasta las ${horaCaracas(hasta)} (hora de Caracas). `
  + 'Las revisiones siguen y las ves en la app.';

/** Ya sin uso en E31 (iss, rpr y uat tienen su acción); se conserva por si un botón futuro se registra antes de tenerla. */
export const TEXTO_ACCION_PRONTO = 'Esta acción llega pronto. Mientras tanto, la tienes en la app de VanGUARD.';
/** Canje sin filas de un botón de la revisión o de iss, rpr y uat (vencido, ya usado o de otro teléfono). */
export const TEXTO_BOTON_VENCIDO = 'No se pudo: el botón venció o ya se usó. Abre officialvanguard.com';
/** Motivos fijos de «No se pudo: <motivo corto>.» (nunca el texto de un proveedor ni del usuario). */
export const MOTIVOS_NO_SE_PUDO = {
  tipo_distinto: 'ese botón no corresponde a esta acción',
  otra_revision: 'no encontré esa revisión',
  sin_hallazgos: 'esta revisión no trae hallazgos nuevos que arreglar',
  sin_config: 'ese repo ya no tiene la revisión de código activa',
  error: 'no pude guardarlo, inténtalo desde la app',
  // «Crear issue» y «Reabrir el PR» (motivos de crearIssue y reabrirPr, revision/acciones-pr.ts)
  dry_run: 'fuera de producción VanGUARD no escribe en tus sistemas',
  sin_token: 'falta el token de escritura de GitHub del bloqueo de merge',
  otro_repo: 'el token de escritura de GitHub es de otro repo',
  sin_permiso_issues: 'el token de escritura no tiene «Issues: Read and write»',
  sin_permiso_pr: 'el token de escritura no tiene «Pull requests: Read and write»',
  sin_credencial: 'no pude abrir el token; inténtalo de nuevo en un rato',
  gh_token: 'GitHub rechazó el token; vuelve a conectarlo en la app',
  gh_permiso: 'GitHub no dio permiso para hacerlo',
  gh_no_encontrado: 'GitHub no encontró el repo o el PR',
  gh_rechazo: 'GitHub rechazó la petición',
  gh_red: 'GitHub no respondió; inténtalo de nuevo en un rato',
  no_es_pr: 'esa revisión no es de un pull request',
  ya_abierto: 'ese PR ya está abierto',
  no_cerrado: 'ese PR no lo cerró VanGUARD',
  texto_rechazado: 'el texto del issue no pasó los filtros de seguridad',
  // «Modo bajo ataque» (motivos de proponerBajoAtaque y executeUnderAttack, actions/under-attack.ts)
  otro_incidente: 'no encontré ese incidente',
  bajo_ataque_no_aplica: 'ese ataque ya no cumple las condiciones del modo bajo ataque',
  bajo_ataque_activo: 'el modo bajo ataque ya está activo en ese host',
  bajo_ataque_en_curso: 'el modo bajo ataque ya se está activando; míralo en la app',
  sin_conexion_cf: 'falta el token de acciones de Cloudflare (Modo blindaje)',
  cf_permiso: 'al token de Modo blindaje le falta Zone · Config Rules · Edit',
  cf_token: 'el token de acciones de Cloudflare ya no es válido',
  cf_cupo: 'tu plan de Cloudflare ya usa todas sus reglas de configuración',
  cf_rechazo: 'Cloudflare no aceptó la regla',
  cf_red: 'Cloudflare no respondió; vuelve a intentarlo desde la app',
} as const;
export type MotivoNoSePudo = keyof typeof MOTIVOS_NO_SE_PUDO;
export const textoNoSePudo = (m: MotivoNoSePudo): string => `No se pudo: ${MOTIVOS_NO_SE_PUDO[m]}.`;
