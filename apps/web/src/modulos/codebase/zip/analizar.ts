// Análisis local del ZIP (F-18, S09 09.3): los mismos escáneres puros de core que el paso repo (secretos, .env y
// lockfiles), sin huella ni prefijo (el BACK antepone zip:<filename>/). Corre dentro del worker: los valores en claro
// solo viven aquí, y lo que sale cabe en el ZipResult estricto de E23 (sin snippet, ubicaciones, variables ni contenido).
import type { ZipDep, ZipFinding, ZipResult } from '@vanguard/contracts';
import { ANALYZER, escanearSecretos, fromComposerLock, fromPackageLock, porSeveridad, reglasEnv, type ArchivoTexto,
  type BorradorCodebase } from '@vanguard/core';
import type { Analisis, AvisoZip, CodigoAviso, Inventario } from './tipos';

// Topes de ZipResult y ZipFinding (packages/contracts/src/api.ts).
const MAX_DEPS = 2000, MAX_HALLAZGOS = 200, MAX_VISTOS = 20_000;
const MAX_RECURSO = 300, MAX_RUTA = 300, MAX_TITULO = 200, MAX_PREVIEW = 12, MAX_NOMBRE = 214, MAX_VERSION = 64;
const RULE_ZIP = /^CB_(ENV_COMMITTED|GITIGNORE_NO_ENV|SECRET_[A-Z0-9_]+)$/;
// Su preview de core no es 4+4 (la cabecera PEM, la URL con usuario y host) y además pasa de 12.
const SIN_PREVIEW = new Set(['CB_SECRET_PRIVATE_KEY', 'CB_SECRET_POSTGRES_URL']);
// Reglas que la regex de ZipFinding no admite y se quedan como aviso en el navegador; cualquier otra fuera de la lista
// blanca (CB_DEP_VULN, que solo decide el servidor) se descarta sin más.
const AVISO_LOCAL: Readonly<Record<string, CodigoAviso>> = { CB_SENSITIVE_FILE: 'CB_SENSITIVE_FILE', CB_ZIP_HAS_GIT: 'CB_ZIP_HAS_GIT' };
const TEXTO_AVISO = {
  CB_ZIP_HAS_GIT: 'Tu ZIP lleva la carpeta .git con el historial: no la leemos, pero si compartes el ZIP, viaja con él.',
  CB_SENSITIVE_FILE: 'Tu ZIP trae archivos sensibles (claves, credenciales o volcados): revísalos antes de compartirlo.',
} as const;

// FUERA de apps/api/src/scans/repo.ts: un lockfile de una dependencia o de un build no es el del proyecto.
const FUERA = /(^|\/)(node_modules|vendor|dist|build|\.git)\//;
// Un .env dentro de una dependencia no es del usuario. Un ZIP suele traer node_modules y un repo no: sin esto, el mismo
// código daría más CB_ENV_COMMITTED como ZIP que como repo.
const DE_TERCEROS = /(^|\/)(node_modules|vendor)\//;
const LEGIBLES = new Set(['package-lock.json', 'composer.lock']);
const OTROS = new Set(['pnpm-lock.yaml', 'yarn.lock']);   // aún no se leen (tampoco en el paso repo)

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const carpeta = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);
// Un surrogate suelto (de recortar por unidades UTF-16, aquí o en el RESOURCE_MAX de core, o de un nombre mal
// codificado) es JSON válido, pero Postgres jsonb lo rechaza y tumbaría el lote de hallazgos del paso zip: fuera.
const SUELTO = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const sano = (s: string) => s.replace(SUELTO, '');
const recortarIzq = (s: string, max: number) => sano(s.length > max ? '…' + s.slice(s.length - max + 1) : s);   // = RESOURCE_MAX de core
const recortarDer = (s: string, max: number) => sano(s.length > max ? s.slice(0, max - 1) + '…' : s);

function aZipFinding(b: BorradorCodebase): ZipFinding {
  const ev = b.evidence;
  const evidence: ZipFinding['evidence'] = { path: recortarIzq(typeof ev.path === 'string' ? ev.path : '', MAX_RUTA) };
  if (typeof ev.line === 'number' && Number.isInteger(ev.line) && ev.line >= 1) evidence.line = ev.line;
  if (typeof ev.preview === 'string' && ev.preview.length <= MAX_PREVIEW && !SIN_PREVIEW.has(b.rule_id)) evidence.preview = sano(ev.preview);
  return { rule_id: b.rule_id, severity: b.severity, title: recortarDer(b.title, MAX_TITULO), resource: recortarIzq(b.resource, MAX_RECURSO), evidence };
}

/** Borradores de core → ZipFinding con solo los campos del contrato; los rule_id locales pasan a aviso. */
export function proyectarHallazgos(borradores: readonly BorradorCodebase[]): { findings: ZipFinding[]; avisos: CodigoAviso[] } {
  const findings: ZipFinding[] = [];
  const avisos: CodigoAviso[] = [];
  for (const b of borradores) {
    if (RULE_ZIP.test(b.rule_id)) { findings.push(aZipFinding(b)); continue; }
    const a = AVISO_LOCAL[b.rule_id];
    if (a && !avisos.includes(a)) avisos.push(a);
  }
  return { findings, avisos };
}

// El lockfile es entrada hostil: name y version pueden no ser texto aunque el tipo de core diga que sí.
const depValida = (d: { ecosystem: unknown; name: unknown; version: unknown }): d is ZipDep =>
  (d.ecosystem === 'npm' || d.ecosystem === 'Packagist')
  && typeof d.name === 'string' && d.name.length >= 1 && d.name.length <= MAX_NOMBRE
  && typeof d.version === 'string' && d.version.length >= 1 && d.version.length <= MAX_VERSION && !d.version.startsWith('file:')
  && sano(d.name) === d.name && sano(d.version) === d.version;   // un nombre con un surrogate suelto no es un paquete real

// leerLockfiles de apps/api/src/scans/repo-paso.ts: deduplica por ecosystem:name@version, solo npm y Packagist, y el
// JSON inválido no lanza. Sin el composer.json hermano: solo da `direct`, que ZipDep no lleva, y uno roto tumbaría su
// composer.lock. `leidos` cuenta los que se interpretaron (uno vacío no cuenta, como en el paso repo).
function leerLockfiles(archivos: readonly ArchivoTexto[]) {
  const deps = new Map<string, ZipDep>();
  let leidos = 0, ilegibles = 0;
  for (const a of archivos) {
    const b = base(a.path);
    if (!LEGIBLES.has(b) || FUERA.test(a.path) || !a.content.trim()) continue;
    try {
      const ds = b === 'package-lock.json' ? fromPackageLock(a.content, a.path) : fromComposerLock(a.content, a.path);
      for (const d of ds) if (depValida(d)) deps.set(`${d.ecosystem}:${d.name}@${d.version}`, { ecosystem: d.ecosystem, name: d.name, version: d.version, dev: !!d.dev });
      leidos++;
    } catch { ilegibles++; }
  }
  return { deps: [...deps.values()], leidos, ilegibles };
}

// CB_NO_LOCKFILE: sin lockfile, con un formato que aún no leemos (pnpm, yarn) en una carpeta sin package-lock.json, o con
// lockfiles listados que no se pudieron leer (más de 1 MB, binarios o JSON inválido). El análisis sigue igual.
function textoLockfiles(rutas: readonly string[], archivos: ReadonlyMap<string, string>, leidos: number, ilegibles: number): string | null {
  const propias = rutas.filter((p) => !FUERA.test(p));
  const conPackageLock = new Set(propias.filter((p) => base(p) === 'package-lock.json').map(carpeta));
  const formatos = [...new Set(propias.filter((p) => OTROS.has(base(p)) && !conPackageLock.has(carpeta(p))).map(base))].sort();
  const sinLeer = propias.filter((p) => LEGIBLES.has(base(p)) && !archivos.has(p)).length + ilegibles;
  const partes: string[] = [];
  if (formatos.length) partes.push(`Aún no leemos ${formatos.join(' ni ')}: sin package-lock.json no podemos revisar esas dependencias.`);
  if (sinLeer === 1) partes.push('Un lockfile no se pudo leer (pasa de 1 MB o no es JSON válido): sus dependencias no se revisan.');
  if (sinLeer > 1) partes.push(`${sinLeer} lockfiles no se pudieron leer (pasan de 1 MB o no son JSON válido): sus dependencias no se revisan.`);
  if (!partes.length && leidos === 0) partes.push('Sin lockfile no podemos revisar dependencias.');
  return partes.length ? partes.join(' ') : null;
}

export async function analizarZip(archivos: Map<string, string>, inventario: Inventario): Promise<Analisis> {
  const lista: ArchivoTexto[] = [...archivos].map(([path, content]) => ({ path, content }));
  const rutas = [...new Set([...inventario.rutas.map((r) => r.p), ...archivos.keys()])];

  // Secretos y .env compuestos como en el paso repo (repo-paso.ts). Sin huella, core agrupa por valor en memoria.
  const secretos = await escanearSecretos(lista);
  const rutasEnv = rutas.filter((p) => !DE_TERCEROS.test(p) && (p === '.gitignore' || /(^|\/)\.env/.test(p)));
  // Un .gitignore listado pero sin leer (más de 1 MB, binario): no se sabe si cubre .env. ZIP vacío: nada que ignorar.
  const gitignoreSabido = archivos.has('.gitignore') || !rutasEnv.includes('.gitignore');
  const env = rutas.length === 0 ? [] : reglasEnv(rutasEnv, lista).filter((b) => gitignoreSabido || b.rule_id !== 'CB_GITIGNORE_NO_ENV');

  const proyectados = proyectarHallazgos([...secretos.hallazgos, ...env]);
  // Sort estable: dentro de cada severidad se conserva el orden de core.
  const findings = [...proyectados.findings].sort((a, b) => porSeveridad(a.severity, b.severity)).slice(0, MAX_HALLAZGOS);
  const lk = leerLockfiles(lista);
  const deps = lk.deps.slice(0, MAX_DEPS);

  const avisos: AvisoZip[] = [];
  if (inventario.tiene_git || proyectados.avisos.includes('CB_ZIP_HAS_GIT')) avisos.push({ codigo: 'CB_ZIP_HAS_GIT', texto: TEXTO_AVISO.CB_ZIP_HAS_GIT });
  if (proyectados.avisos.includes('CB_SENSITIVE_FILE')) avisos.push({ codigo: 'CB_SENSITIVE_FILE', texto: TEXTO_AVISO.CB_SENSITIVE_FILE });
  const lockfiles = textoLockfiles(rutas, archivos, lk.leidos, lk.ilegibles);
  if (lockfiles) avisos.push({ codigo: 'CB_NO_LOCKFILE', texto: lockfiles });
  const recortes: string[] = [];
  if (proyectados.findings.length > MAX_HALLAZGOS)
    recortes.push(`Encontramos ${proyectados.findings.length} hallazgos: enviamos los ${MAX_HALLAZGOS} más graves.`);
  if (lk.deps.length > MAX_DEPS) recortes.push(`Hay ${lk.deps.length} dependencias: enviamos las primeras ${MAX_DEPS}.`);
  if (recortes.length) avisos.push({ codigo: 'RECORTADO', texto: recortes.join(' ') });

  const resultado: ZipResult = {
    files_seen: Math.min(MAX_VISTOS, Math.max(0, Math.trunc(inventario.entradas) || 0)), deps, findings, analyzer: ANALYZER,
  };
  return {
    resultado, avisos,
    resumen: { archivos: archivos.size, deps: deps.length, lockfiles: lk.leidos,
      secretos: findings.filter((f) => f.rule_id.startsWith('CB_SECRET_')).length,
      env: findings.filter((f) => f.rule_id === 'CB_ENV_COMMITTED').length },
  };
}
