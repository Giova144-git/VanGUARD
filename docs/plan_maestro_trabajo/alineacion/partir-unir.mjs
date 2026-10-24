// Parte PLAN_MAESTRO.md en trozos por sección numerada (## NN. / ## Anexo X.) y los vuelve a unir.
// Uso: node partir-unir.mjs partir   → alineacion/partes/P00.md … P16.md, PAA.md, PAB.md + copia de respaldo
//      node partir-unir.mjs unir     → reescribe PLAN_MAESTRO.md con los trozos en orden
//      node partir-unir.mjs comprobar → verifica que unir(partir(x)) === x sin escribir nada
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const AQUI = import.meta.dirname;
const PLAN = join(AQUI, '..', '..', '..', 'PLAN_MAESTRO.md');
const PARTES = join(AQUI, 'partes');
const CABECERA = /^## (\d{2})\. |^## Anexo ([A-Z])\. /;

function trozos(texto) {
  const lineas = texto.split('\n');
  const inicios = [];
  let enCodigo = false;
  lineas.forEach((l, i) => {
    if (/^\s*```/.test(l)) enCodigo = !enCodigo;
    if (!enCodigo && CABECERA.test(l)) inicios.push(i);
  });
  return inicios.map((ini, k) => {
    const m = lineas[ini].match(CABECERA);
    const nombre = m[1] ? 'P' + m[1] : 'PA' + m[2];
    const desde = k === 0 ? 0 : ini; // la portada se lleva el título del documento
    const hasta = k + 1 < inicios.length ? inicios[k + 1] : lineas.length;
    return { nombre, texto: lineas.slice(desde, hasta).join('\n') };
  });
}

const orden = (a, b) => a.localeCompare(b, 'en');
const modo = process.argv[2];
const original = readFileSync(PLAN, 'utf8');

if (modo === 'partir') {
  mkdirSync(PARTES, { recursive: true });
  copyFileSync(PLAN, join(AQUI, 'PLAN_MAESTRO.antes-alineacion.md'));
  const t = trozos(original);
  for (const p of t) writeFileSync(join(PARTES, p.nombre + '.md'), p.texto);
  console.log('partes:', t.map((p) => `${p.nombre}(${p.texto.split('\n').length})`).join(' '));
} else if (modo === 'unir') {
  const nombres = readdirSync(PARTES).filter((f) => /^P(\d{2}|A[A-Z])\.md$/.test(f)).sort(orden);
  const texto = nombres.map((f) => readFileSync(join(PARTES, f), 'utf8')).join('\n');
  writeFileSync(PLAN, texto);
  console.log('unido:', nombres.length, 'partes,', texto.split('\n').length, 'líneas');
} else if (modo === 'comprobar') {
  const t = trozos(original);
  const reunido = t.sort((a, b) => orden(a.nombre, b.nombre)).map((p) => p.texto).join('\n');
  console.log(reunido === original ? `OK: ${t.length} partes, ida y vuelta idéntica` : 'DIFERENTE: no usar');
} else {
  console.log('uso: node partir-unir.mjs partir|unir|comprobar');
}
