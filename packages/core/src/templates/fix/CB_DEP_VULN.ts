// CB_DEP_VULN (S09 09.11, con el texto exacto de `prompt_para_tu_ia`; S11 11.10.2: sin versión corregida, mitigación).
// Nombre, versión e ids solo entran en el comando y en el enlace a osv.dev si pasan su patrón; si no, no hay comando.
import { enCodigo, nombreEnCodigo, SEVERIDAD_ES } from '../titles.ts';
import type { HallazgoFix, PlantillaFix } from './index.ts';

const NPM = /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i;
const COMPOSER = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/;
const AVISO = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/;
const txt = (v: unknown) => (typeof v === 'string' ? v : '');
const lista = (xs: readonly string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);

/** `npm:lodash@4.17.15` / `Packagist:facade/ignition@2.5.1` → partes (respaldo si la evidencia no trae `paquete`). */
function desdeRecurso(resource: string) {
  const m = /^([^:]+):(.+)@([^@]+)$/.exec(resource.replace(/^zip:[^/]*\//, ''));
  return m ? { ecosystem: m[1] ?? '', name: m[2] ?? '', version: m[3] ?? '' } : { ecosystem: '', name: '', version: '' };
}

export function plantilla(f: HallazgoFix): PlantillaFix {
  const ev = f.evidence;
  const pq = (ev.paquete && typeof ev.paquete === 'object' ? ev.paquete : {}) as Record<string, unknown>;
  const r = desdeRecurso(f.resource);
  const ecosystem = txt(pq.ecosystem) || r.ecosystem, name = txt(pq.name) || r.name, version = txt(pq.version) || r.version;
  const manifest = txt(pq.manifest) || txt(ev.path) || 'el manifiesto';
  const avisos = (Array.isArray(ev.avisos) ? ev.avisos : []) as Array<Record<string, unknown>>;
  const ids = avisos.map((a) => txt(a?.id)).filter((id) => AVISO.test(id)).slice(0, 10);
  const alias = (Array.isArray(avisos[0]?.aliases) ? avisos[0].aliases : []).map(txt);
  const osvId = alias.find((a) => a.startsWith('GHSA-') && AVISO.test(a)) ?? ids[0];
  const osv = osvId ? `https://osv.dev/vulnerability/${osvId}` : 'https://osv.dev';
  const arreglo = VERSION.test(txt(ev.version_arreglo)) ? txt(ev.version_arreglo) : null;
  const composer = ecosystem === 'Packagist';
  const valido = (composer ? COMPOSER : NPM).test(name) && VERSION.test(version);
  const instalar = !valido || !arreglo ? null
    : composer ? `composer require ${name}:^${arreglo}`
    : manifest.endsWith('pnpm-lock.yaml') ? `pnpm add ${name}@${arreglo}` : `npm install ${name}@${arreglo}`;
  const carpeta = manifest.includes('/') ? manifest.slice(0, manifest.lastIndexOf('/')) : null;
  const N = nombreEnCodigo(name || 'la dependencia'), V = nombreEnCodigo(version || '?'), M = nombreEnCodigo(manifest);
  const idsTxt = ids.length > 0 ? ids.map(enCodigo).join(', ') : 'avisos publicados';
  const sev = (SEVERIDAD_ES as Record<string, string>)[txt(avisos[0]?.severidad)];

  if (arreglo) {
    const A = enCodigo(arreglo);
    return {
      contexto: `${N} ${V}, declarada en ${M}, está afectada por ${ids.length > 0 ? lista(ids.map(enCodigo)) : 'avisos de seguridad publicados'}${sev ? ` (la primera, ${sev})` : ''}. Existe versión corregida: ${A}.`,
      pasos: [
        `Sube ${N} de ${V} a ${A} en ${M}${instalar ? `: ${enCodigo(instalar)}${carpeta ? ` (desde ${nombreEnCodigo(`${carpeta}/`)})` : ''}` : ''}.`,
        'Ejecuta las pruebas del proyecto.',
        'Revisa el changelog de la dependencia por cambios que rompan.',
      ],
      prompt_para_tu_ia: `Soy el dueño de este repo y quiero corregir una dependencia vulnerable. En ${M} uso ${N} ${V}, afectada por ${idsTxt} (detalle: ${osv}). Actualízala a ${A} o superior, ajusta el código que rompa por el cambio de versión, y dime qué pruebas correr. No toques otras dependencias.`,
      prueba_de_aceptacion: `OSV no devuelve avisos para ${enCodigo(`${name}@${arreglo}`)}.`,
    };
  }
  return {
    contexto: `${N} ${V}, declarada en ${M}, está afectada por ${ids.length > 0 ? lista(ids.map(enCodigo)) : 'avisos de seguridad publicados'} y todavía no hay versión corregida.`,
    pasos: [
      `Lee el aviso en ${osv} y aplica la mitigación que indique.`,
      'Comprueba si tu código usa la parte afectada de la dependencia; si no la usa, documéntalo.',
      'Si la dependencia es directa y el riesgo es alto, valora sustituirla.',
      'Vigila el aviso para subir de versión en cuanto haya una corregida.',
    ],
    prompt_para_tu_ia: `Soy el dueño de este repo y una dependencia tiene una vulnerabilidad sin versión corregida. En ${M} uso ${N} ${V}, afectada por ${idsTxt} (detalle: ${osv}). Revisa si mi código usa la parte afectada, propón la mitigación mínima que indique el aviso y dime qué pruebas correr. No toques otras dependencias.`,
    prueba_de_aceptacion: `La mitigación del aviso está aplicada y, en cuanto exista versión corregida, OSV no devuelve avisos para la versión instalada de ${N}.`,
  };
}
