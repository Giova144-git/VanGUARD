// Markdown mínimo y seguro para la wiki (L9): el texto del modelo es dato no confiable aunque el BACK ya lo sanee.
// Subconjunto propio → elementos de React con texto: «#»/«##»/«###», párrafos, listas «-» y «1.», **negrita** y
// `código`. Nada de HTML, enlaces ni imágenes: un «<script>» o un «[x](javascript:…)» se pinta como texto literal.
import type { ReactNode } from 'react';
import { sinBidi } from './bidi';

export type Bloque =
  | { t: 'h'; nivel: 1 | 2 | 3; texto: string }
  | { t: 'p'; texto: string }
  | { t: 'ul' | 'ol'; items: string[] };

export function bloques(md: string): Bloque[] {
  const out: Bloque[] = [];
  let parrafo: string[] = [];
  let lista: { t: 'ul' | 'ol'; items: string[] } | null = null;
  const cerrar = () => {
    if (parrafo.length) { out.push({ t: 'p', texto: parrafo.join(' ') }); parrafo = []; }
    if (lista) { out.push(lista); lista = null; }
  };
  for (const crudo of md.replace(/\r/g, '').split('\n')) {
    const l = crudo.trim();
    if (!l) { cerrar(); continue; }
    const h = l.match(/^(#{1,3})\s+(.+)$/);
    if (h) { cerrar(); out.push({ t: 'h', nivel: h[1]!.length as 1 | 2 | 3, texto: h[2]! }); continue; }
    const ul = l.match(/^[-*]\s+(.+)$/);
    const ol = l.match(/^\d{1,2}[.)]\s+(.+)$/);
    if (ul || ol) {
      const t = ul ? 'ul' : 'ol';
      if (parrafo.length) { out.push({ t: 'p', texto: parrafo.join(' ') }); parrafo = []; }
      if (lista && lista.t !== t) { out.push(lista); lista = null; }
      lista ??= { t, items: [] };
      lista.items.push((ul ?? ol)![1]!);
      continue;
    }
    if (lista) { out.push(lista); lista = null; }
    parrafo.push(l);
  }
  cerrar();
  return out;
}

// **negrita** y `código` en línea; todo lo demás, texto.
export function enLinea(texto: string): ReactNode[] {
  const partes: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let i = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(texto))) {
    if (m.index > i) partes.push(texto.slice(i, m.index));
    partes.push(m[1] != null ? <strong key={k++} className="font-semibold">{m[1]}</strong>
      : <code key={k++} className="rounded bg-muted px-1 font-mono text-[13px]">{m[2]}</code>);
    i = m.index + m[0].length;
  }
  if (i < texto.length) partes.push(texto.slice(i));
  return partes;
}

// Pinta los bloques; `despues(titulo)` permite insertar algo al final de una sección «##» (p. ej. el diagrama).
export function Markdown({ md, despues }: { md: string; despues?: (titulo: string) => ReactNode }) {
  const bs = bloques(sinBidi(md));   // los controles bidi del modelo se ven (lib/bidi.ts), también en títulos y `código`
  const nodos: ReactNode[] = [];
  let seccion: string | null = null;
  const cerrarSeccion = (k: string) => { if (seccion && despues) { const x = despues(seccion); if (x) nodos.push(<div key={`d-${k}`}>{x}</div>); } };
  bs.forEach((b, i) => {
    if (b.t === 'h' && b.nivel <= 2) { cerrarSeccion(String(i)); seccion = b.nivel === 2 ? b.texto : null; }
    if (b.t === 'h') {
      const cls = b.nivel === 1 ? 'text-[22px] font-semibold' : b.nivel === 2 ? 'mt-2 text-[17px] font-semibold' : 'text-[15px] font-semibold';
      nodos.push(b.nivel === 1 ? <h2 key={i} className={cls}>{enLinea(b.texto)}</h2> : b.nivel === 2 ? <h3 key={i} className={cls}>{enLinea(b.texto)}</h3> : <h4 key={i} className={cls}>{enLinea(b.texto)}</h4>);
    } else if (b.t === 'p') nodos.push(<p key={i} className="text-[15px] leading-relaxed">{enLinea(b.texto)}</p>);
    else {
      const Lista = b.t === 'ul' ? 'ul' : 'ol';
      nodos.push(<Lista key={i} className={`flex flex-col gap-1.5 pl-5 text-[15px] leading-relaxed ${b.t === 'ul' ? 'list-disc' : 'list-decimal'}`}>
        {b.items.map((it, j) => <li key={j}>{enLinea(it)}</li>)}
      </Lista>);
    }
  });
  cerrarSeccion('fin');
  return <div className="flex flex-col gap-3">{nodos}</div>;
}
