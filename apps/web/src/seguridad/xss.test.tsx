// Arnés de XSS del FRONT (PLAN_MAESTRO §14.1, L9): todo texto que llega del servidor (evidencia, logs, repos, user
// agents, salida del modelo) se pinta como TEXTO. Cada componente que lo pinta se renderiza con renderToStaticMarkup y
// datos envenenados (copias de los fixtures de @vanguard/contracts con los campos de texto sustituidos; los fixtures
// compartidos no se tocan) y se comprueba el HTML resultante:
//   1. ningún elemento peligroso (script, img, iframe, object…), ningún atributo on*= ni srcdoc, ningún href/src con un
//      esquema que no sea http(s) ni a un host fuera de la lista (javascript:, data:, //evil.test…), tampoco el
//      javascript: que React 19 neutraliza, ningún style con url();
//   2. la misma estructura (etiquetas y nombres de atributo) que con un texto inocente: la carga no crea elementos;
//   3. la carga sale ESCAPADA como texto (&lt;img …) en los campos que el componente enseña;
//   4. un id envenenado solo llega a un href codificado con encodeURIComponent.
// Cada campo envenenado lleva su nombre al final («carga⟦title⟧») o, con `ruta`, su camino completo
// («carga⟦top_ips[1].ua_top⟧»), para saber qué campo se ve y dónde.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { Database } from 'lucide-react';
import { z } from 'zod';
import {
  fixtures as fx, CheckDato, ConnectionCreated, ConnectionPublic, Contact, EstadoModulo, Finding, FixPromptResponse, GrupoDato,
  Incident, IncidentDetail, Me, Overview, PerfRunExt, ProposeResponse, ScanRun, Traffic, Ts, WikiDoc, WikiEstimate, WikiRun,
  type AccionDato, type CifraDato, type PermCheck, type Severity,
} from '@vanguard/contracts';
import { OrgDePrueba, type OrgActual } from '@/app/guardas';
import AppShell from '@/app/AppShell';
import { Bandeja, FilaProblema, AccionFila } from '@/componentes/vg/Bandeja';
import { ChecksEnCero } from '@/componentes/vg/ChecksEnCero';
import { Cifra } from '@/componentes/vg/Cifra';
import { DiagramaWiki } from '@/componentes/vg/DiagramaWiki';
import { ChapaSeveridad, Etiqueta } from '@/componentes/vg/Etiqueta';
import { FichaFila } from '@/componentes/vg/FichaFila';
import { GraficaTrafico, TablaTopIps } from '@/componentes/vg/GraficaTrafico';
import { LineaTiempo } from '@/componentes/vg/LineaTiempo';
import { ListaChecks } from '@/componentes/vg/ListaChecks';
import { ErrorBloque } from '@/componentes/vg/Vacio';
import { sinBidi } from '@/lib/bidi';
import { ApiError } from '@/lib/errores';
import { Markdown, bloques, enLinea } from '@/lib/markdown';
import { parsearMermaid, partir } from '@/lib/mermaid';
import { rutaDe } from '@/lib/destino';
import type { Rol } from '@/lib/severidad';
import PaginaAjustes, { Verificar } from '@/modulos/ajustes/PaginaAjustes';
import PaginaAuditoria from '@/modulos/auditoria/PaginaAuditoria';
import PaginaCloudflare from '@/modulos/cloudflare/PaginaCloudflare';
import PaginaCodebase from '@/modulos/codebase/PaginaCodebase';
import { Resultado } from '@/modulos/conexiones/Asistente';
import { TarjetaConexion, TarjetaIngesta } from '@/modulos/conexiones/TarjetaConexion';
import PaginaExportar from '@/modulos/exportar/PaginaExportar';
import { DetalleEnPanel } from '@/modulos/hallazgos/DetalleEnPanel';
import { DetalleHallazgo } from '@/modulos/hallazgos/DetalleHallazgo';
import { Propuesta } from '@/modulos/incidentes/BloquearIp';
import { hitosDe, restoDe } from '@/modulos/incidentes/hitos';
import PaginaIncidente from '@/modulos/incidentes/PaginaIncidente';
import PaginaIncidentes from '@/modulos/incidentes/PaginaIncidentes';
import PaginaRendimiento from '@/modulos/rendimiento/PaginaRendimiento';
import PaginaResumen from '@/modulos/resumen/PaginaResumen';
import PaginaWiki, { Estimacion } from '@/modulos/wiki/PaginaWiki';

// supabase-js pide VITE_SUPABASE_URL al importarse; aquí no hay red ni sesión (solo la usan los manejadores de clic).
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
// Plegado no se renderiza el cuerpo (SectorPlegable y Collapsible de Radix), y en SSR los portales de DropdownMenu y Dialog
// (el Sheet es un Dialog) salen vacíos: para revisar lo que hay dentro (menú de orgs, PanelDetalle, PaletaComandos),
// todo abierto y en línea.
vi.mock('@/componentes/vg/SectorPlegable', async () => {
  const { createElement } = await import('react');
  return { SectorPlegable: ({ titulo, children }: { titulo: string; children: ReactNode }) => createElement('section', null, createElement('h3', null, titulo), children) };
});
vi.mock('radix-ui', async (importOriginal) => {
  const real = await importOriginal<typeof import('radix-ui')>();
  const { createElement, Fragment } = await import('react');
  type P = { children?: ReactNode; className?: string; asChild?: boolean };
  const pasa = (tag: string) => ({ children, className }: P) => createElement(tag, { className }, children);
  const suelto = ({ children }: P) => createElement(Fragment, null, children);
  const disparador = ({ children, className, asChild }: P) => (asChild ? children : createElement('button', { className }, children));
  return {
    ...real,
    Collapsible: { ...real.Collapsible, Root: pasa('div'), Trigger: pasa('button'), Content: pasa('div') },
    DropdownMenu: { ...real.DropdownMenu, Root: suelto, Trigger: disparador, Portal: suelto, Content: pasa('div'), Item: pasa('div'),
      Label: pasa('div'), Separator: pasa('div') },
    Dialog: { ...real.Dialog, Root: suelto, Trigger: disparador, Portal: suelto, Overlay: () => null, Content: pasa('div'),
      Title: pasa('h2'), Description: pasa('p'), Close: pasa('button') },
  };
});

// ── Cargas ────────────────────────────────────────────────────────────────────
const IMG = '<img src=x onerror=alert(1)>';
const CARGAS: [string, string][] = [
  ['img onerror', IMG],
  ['script', '<script>alert(1)</script>'],
  ['javascript:', 'javascript:alert(1)'],
  // Sin blancos delante (bloques() los recorta y el caso de Markdown daría un falso positivo): U+0001, tab y mayúsculas.
  ['javascript: ofuscado', '\u0001JaVa\tScRiPt:alert(1)'],
  ['data:', 'data:text/html,<script>alert(1)</script>'],
  ['https a otro host', 'https://evil.test/x'],
  ['protocolo relativo', '//evil.test/x'],
  ['enlace Markdown', '[x](javascript:alert(1))'],
  ['imagen Markdown', '![i](https://evil.test/p.png)'],
  ['svg onload', '"><svg onload=alert(1)>'],
  ['bidi y RTL', '‮exe.txt‬ ⁦שלום⁩ مرحبا ‫txt.exe'],
  ['10 KB', 'A'.repeat(10 * 1024 - IMG.length) + IMG],
];
// Con «:» para que también caiga fuera de la lista blanca de Mermaid: la comparación es con el mismo camino.
const INOCENTE = 'Texto normal: 123';
const marca = (c: string, campo: string) => `${c}⟦${campo}⟧`;
// Claves que Object.prototype ya tiene: un `MAPA[k] ?? respaldo` o un `k in MAPA` no las ve. En el bloque de robustez
// llegan a los enums TAL CUAL, sin ⟦campo⟧ (con la marca nunca serían la clave y el bloque daría verde en falso).
const PROTO = ['__proto__', 'constructor', 'valueOf', 'toString'];
// Así escapa React el texto y los atributos (escapeTextForBrowser).
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
// Lo que pinta FichaFila: JSON.stringify, los controles bidi a la vista (sinBidi) y luego el escape de React.
const enJson = (s: string) => sinBidi(JSON.stringify(s).slice(1, -1));

// ── Envenenar: cada campo de texto que permite el esquema zod ─────────────────
// Recorre el esquema y el valor a la vez: z.string() → carga marcada; z.uuid() → id envenenado (si `ids`); dentro de
// z.unknown() (evidence, details, meta, args) todas las cadenas, una clave extra envenenada y claves con nombre de
// atributo peligroso. Con `rellenar` (por defecto) los opcionales y nullables que vienen null o ausentes y admiten texto
// se sintetizan desde el esquema, para que también reciban carga. Las fechas ISO (Ts es z.string()) se respetan salvo
// con `fechas`, para no mezclar robustez con escape; con `enums`, también los enums y literales llevan la carga.
type Def = { type: string; format?: string; innerType?: Esq; shape?: Record<string, Esq>; element?: Esq; valueType?: Esq;
  options?: Esq[]; entries?: Record<string, string>; values?: unknown[]; in?: Esq };
type Esq = { _zod: { def: Def } };
type Opciones = { ids?: boolean; fechas?: boolean; rellenar?: boolean; enums?: boolean; ruta?: string };
type Lugar = { campo: string; camino: string };
const ISO = /^\d{4}-\d{2}-\d{2}T/;
const FECHA = '2026-10-24T19:00:00.000Z';
const UUID = 'f0000000-0000-4000-8000-0000000000ff';
const hijo = (x: Lugar, k: string): Lugar => ({ campo: k, camino: x.camino ? `${x.camino}.${k}` : k });
const elemento = (x: Lugar, i: number): Lugar => ({ campo: x.campo, camino: `${x.camino}[${i}]` });
const nombre = (x: Lugar, o: Opciones) => (o.ruta === undefined ? x.campo : x.camino);
const esTs = (s: Esq) => (s as unknown) === Ts;
const ENVOLTORIOS = new Set(['optional', 'nullable', 'default', 'readonly', 'nonoptional', 'catch', 'prefault']);

// Un {...evidence} esparcido sobre el DOM convierte estas claves en atributos (y un style de texto hace lanzar a React).
const ATRIBUTOS = { href: 'javascript:alert(1)', src: 'https://evil.test/x', srcDoc: IMG, formAction: 'javascript:alert(1)',
  style: 'background:url(https://evil.test/p.png)' };

// Ids envenenados: a otro host, con query y ancla, o con ../ y %2F. Cada uno lleva su ficha «vgN_» para encontrarlo en un href.
const IDS = new Map<string, string>();
let n = 0;
const idMalo = () => {
  const k = `vg${++n}_`;
  const id = [`//evil.test/${k}`, `${k}?y=1#z`, `../${k}%2F..`][n % 3]!;
  IDS.set(k, id);
  return id;
};

const texto = new WeakMap<Esq, boolean>();
function conTexto(s: Esq): boolean {
  const ya = texto.get(s);
  if (ya !== undefined) return ya;
  const d = s._zod.def;
  const r = d.type === 'string' ? !esTs(s) && d.format !== 'uuid'
    : ENVOLTORIOS.has(d.type) ? conTexto(d.innerType!)
    : d.type === 'pipe' ? conTexto(d.in!)
    : d.type === 'object' ? Object.values(d.shape!).some(conTexto)
    : d.type === 'array' ? conTexto(d.element!)
    : d.type === 'record' ? ['unknown', 'any'].includes(d.valueType!._zod.def.type) || conTexto(d.valueType!)
    : d.type === 'union' ? d.options!.some(conTexto)
    : d.type === 'unknown' || d.type === 'any';
  texto.set(s, r);
  return r;
}

// Valor mínimo que cumple el esquema; las cadenas salen 'x' y poner() las marca después.
function nuevo(s: Esq): unknown {
  const d = s._zod.def;
  switch (d.type) {
    case 'string': return esTs(s) ? FECHA : d.format === 'uuid' ? UUID : 'x';
    case 'number': return 0;
    case 'boolean': return false;
    case 'enum': return Object.values(d.entries!)[0];
    case 'literal': return d.values![0];
    case 'optional': return conTexto(d.innerType!) ? nuevo(d.innerType!) : undefined;
    case 'nullable': return conTexto(d.innerType!) ? nuevo(d.innerType!) : null;
    case 'pipe': return nuevo(d.in!);
    case 'object': return Object.fromEntries(Object.entries(d.shape!).map(([k, x]) => [k, nuevo(x)]).filter(([, v]) => v !== undefined));
    case 'array': return conTexto(d.element!) ? [nuevo(d.element!)] : [];
    case 'union': return nuevo(d.options!.find(conTexto) ?? d.options![0]!);
    case 'record': return {};
    default: return ENVOLTORIOS.has(d.type) ? nuevo(d.innerType!) : 'x';
  }
}

function libre(v: unknown, c: string, x: Lugar, o: Opciones): unknown {
  if (typeof v === 'string') return ISO.test(v) && !o.fechas ? v : marca(c, nombre(x, o));
  if (Array.isArray(v)) return v.map((y, i) => libre(y, c, elemento(x, i), o));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, y]) => [k, libre(y, c, hijo(x, k), o)]));
  return v;
}

function poner(s: Esq, v: unknown, c: string, x: Lugar, o: Opciones): unknown {
  const d = s._zod.def;
  if (ENVOLTORIOS.has(d.type)) {
    if (v == null && !(o.rellenar && conTexto(d.innerType!))) return v;
    return poner(d.innerType!, v ?? nuevo(d.innerType!), c, x, o);
  }
  switch (d.type) {
    case 'string':
      if (typeof v !== 'string') return v;
      if (d.format === 'uuid') return o.ids ? idMalo() : v;
      return ISO.test(v) && !o.fechas ? v : marca(c, nombre(x, o));
    case 'pipe':
      return poner(d.in!, v, c, x, o);
    case 'object': {
      if (!v || typeof v !== 'object') return v;
      const r: Record<string, unknown> = { ...v };
      for (const k of new Set([...Object.keys(v), ...(o.rellenar ? Object.keys(d.shape!) : [])])) {
        if (!d.shape![k]) continue;
        const y = poner(d.shape![k]!, (v as Record<string, unknown>)[k], c, hijo(x, k), o);
        if (y !== undefined || k in v) r[k] = y;
      }
      return r;
    }
    case 'array':
      return Array.isArray(v) ? v.map((y, i) => poner(d.element!, y, c, elemento(x, i), o)) : v;
    case 'record': {
      if (!v || typeof v !== 'object') return v;
      const vt = d.valueType!._zod.def.type;
      const r = Object.fromEntries(Object.entries(v).map(([k, y]) => [k, poner(d.valueType!, y, c, hijo(x, k), o)]));
      return vt === 'unknown' || vt === 'any' ? { ...r, ...ATRIBUTOS, [marca(c, `${nombre(x, o)}.clave`)]: marca(c, `${nombre(x, o)}.valor`) } : r;
    }
    case 'unknown': case 'any':
      return libre(v, c, x, o);
    case 'union':
      return typeof v === 'string' ? marca(c, nombre(x, o)) : libre(v, c, x, o);
    case 'enum': case 'literal':
      return o.enums && typeof v === 'string' ? (PROTO.includes(c) ? c : marca(c, nombre(x, o))) : v;
    default:
      return v;                                                       // number, boolean
  }
}

let ENUMS = false;                                                    // lo enciende el bloque de robustez
function envenenar<S extends z.ZodType>(s: S, v: z.infer<S>, c: string, o: Opciones = {}): z.infer<S> {
  const op: Opciones = { rellenar: true, enums: ENUMS, ...o };
  return poner(s as unknown as Esq, v, c, { campo: 'raiz', camino: op.ruta ?? '' }, op) as z.infer<S>;
}

// ── Revisar el HTML ───────────────────────────────────────────────────────────
type Tag = { nombre: string; attrs: [string, string][] };
const decodificar = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Escáner tolerante: cualquier «<letra» abre una etiqueta, también una inyectada con atributos sin comillas.
function etiquetas(html: string): Tag[] {
  const out: Tag[] = [];
  const nombreRe = /<([a-zA-Z][\w:-]*)/y, attrRe = /[^\s"'>/=]+/y, sinComillas = /[^\s>]*/y;
  for (let i = html.indexOf('<'); i !== -1; i = html.indexOf('<', i + 1)) {
    nombreRe.lastIndex = i;
    const m = nombreRe.exec(html);
    if (!m) continue;
    const attrs: [string, string][] = [];
    let j = nombreRe.lastIndex;
    while (j < html.length && html[j] !== '>') {
      if (/[\s/]/.test(html[j]!)) { j++; continue; }
      attrRe.lastIndex = j;
      const a = attrRe.exec(html);
      if (!a) { j++; continue; }
      j = attrRe.lastIndex;
      let valor = '';
      if (html[j] === '=') {
        j++;
        const q = html[j];
        if (q === '"' || q === "'") { const k = html.indexOf(q, j + 1); valor = html.slice(j + 1, k); j = k + 1; }
        else { sinComillas.lastIndex = j; valor = sinComillas.exec(html)![0]; j = sinComillas.lastIndex; }
      }
      attrs.push([a[0].toLowerCase(), decodificar(valor)]);
    }
    out.push({ nombre: m[1]!.toLowerCase(), attrs });
    i = j;
  }
  return out;
}

const PROHIBIDAS = new Set(['script', 'iframe', 'img', 'image', 'object', 'embed', 'frame', 'frameset', 'base', 'meta', 'link',
  'style', 'foreignobject', 'use', 'animate', 'set', 'math', 'template', 'noscript']);
const ATTR_URL = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'srcset', 'background', 'ping', 'data', 'cite']);
// Destinos externos que el FRONT construye a propósito (referencias CVE/OSV, revocar el token, repo de los jueces, wa.me).
const HOSTS = new Set(['officialvanguard.com', 'www.cve.org', 'osv.dev', 'supabase.com', 'dash.cloudflare.com', 'github.com', 'wa.me']);
const BASE = 'https://officialvanguard.com/o/org/aqui';
// React 19 sustituye un href/src javascript: por esta URL inerte: no se ejecuta, pero el componente se lo pasó.
const BLOQUEO_REACT = "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')";

function peligros(html: string, estricto = false): string[] {
  const p: string[] = [];
  for (const t of etiquetas(html)) {
    if (PROHIBIDAS.has(t.nombre)) p.push(`<${t.nombre}>`);
    for (const [k, v] of t.attrs) {
      if (/^on/i.test(k)) p.push(`<${t.nombre} ${k}=…>`);
      if (k === 'srcdoc') p.push(`<${t.nombre} srcdoc=…>`);
      if (k === 'style' && /url\s*\(|expression\s*\(|javascript:/i.test(v)) p.push(`<${t.nombre} style="${v.slice(0, 60)}">`);
      if (!ATTR_URL.has(k)) continue;
      if (v === BLOQUEO_REACT) { if (estricto) p.push(`<${t.nombre} ${k}> javascript: (bloqueado por React)`); continue; }
      let u: URL;
      try { u = new URL(v, BASE); } catch { continue; }                 // relativo raro: no sale del origen
      if (u.protocol !== 'https:' && u.protocol !== 'http:') p.push(`<${t.nombre} ${k}="${v.slice(0, 60)}"> esquema ${u.protocol}`);
      else if (!HOSTS.has(u.host)) p.push(`<${t.nombre} ${k}="${v.slice(0, 60)}"> host ${u.host}`);
    }
  }
  return p;
}

// Firma estructural: cuántas veces aparece cada etiqueta con cada juego de nombres de atributo.
function estructura(html: string): Record<string, number> {
  const r: Record<string, number> = {};
  for (const t of etiquetas(html)) {
    const k = `${t.nombre}[${t.attrs.map(([a]) => a).sort().join(',')}]`;
    r[k] = (r[k] ?? 0) + 1;
  }
  return r;
}

const hrefs = (html: string) => etiquetas(html).filter((t) => t.nombre === 'a').map((t) => t.attrs.find(([k]) => k === 'href')?.[1] ?? '');
// Un id envenenado solo puede llegar a un href codificado: así no cambia el host, la ruta, la query ni el ancla.
const idsSinCodificar = (html: string) => hrefs(html).filter((h) => [...h.matchAll(/vg\d+_/g)].some(([k]) => !h.includes(encodeURIComponent(IDS.get(k) ?? k))));

// Lo que debe verse escapado. El texto técnico (rutas, IPs, UA, recurso, JSON) va además en un <bdi dir="ltr">: un
// <bdi> sin dir vale dir=auto y una primera letra árabe o hebrea reordenaría la ruta o la IP a la vista.
// Todo texto del servidor que se pinta pasa por sinBidi (lib/bidi.ts): lo esperado se compara ya con los controles
// a la vista («⟨U+202E⟩»), así un control crudo en la página hace fallar el caso. sinBidi es idempotente.
type Ver = string | { ltr: string };
const ltr = (s: string): Ver => ({ ltr: s });
const enBdiLtr = (html: string) => [...html.matchAll(/<bdi dir="ltr">([\s\S]*?)<\/bdi>/g)].map((m) => m[1]!);

function revisar(html: string, carga: string, base: string, ver: Ver[], enlaces: string[] = []) {
  expect(peligros(html, true)).toEqual([]);
  expect(estructura(html)).toEqual(estructura(base));
  for (const crudo of ['<img src=x', '<script>alert', '<svg onload']) expect(html).not.toContain(crudo);
  for (const v of ver) {
    const s = sinBidi(typeof v === 'string' ? v : v.ltr);
    expect(html, `debe verse escapado: ${s.slice(0, 80)}`).toContain(esc(s));
    if (typeof v !== 'string') expect(enBdiLtr(html).some((b) => b.includes(esc(s))), `debe ir en <bdi dir="ltr">: ${s.slice(0, 80)}`).toBe(true);
  }
  expect(idsSinCodificar(html)).toEqual([]);
  // Enlaces que el caso exige: no basta con que ningún href lleve el id sin codificar, el enlace tiene que estar.
  for (const h of enlaces) expect(hrefs(html), `falta el enlace ${h}`).toContain(h);
  if (carga.length >= 10 * 1024) expect(html).toContain('A'.repeat(60));        // la de 10 KB se pinta (o se recorta en su sitio)
}

// ── Render con router, TanStack Query (datos precargados) y la org de prueba ──
const ORG = fx.me.orgs[0]!.id;
// Copias tipadas (parse valida y da el tipo del contrato; el tipo inferido del array literal del fixture no casa con el record).
const CONEXIONES = z.array(ConnectionPublic).parse(fx.connections);
const CONTACTOS = z.array(Contact).parse(fx.contacts);
const LUIS = CONTACTOS[1]!;                                       // sin verificar: trae su enlace de wa.me
const ENLACE_WA = LUIS.verificacion!.enlace;
const orgDe = (extra: Partial<OrgActual> = {}): OrgActual => ({ ...fx.me.orgs[0]!, me: fx.me, puedeEscribir: true, ...extra });

function pintar(nodo: ReactNode, o: { ruta?: string; patron?: string; datos?: [QueryKey, unknown][]; org?: OrgActual } = {}): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [k, v] of o.datos ?? []) qc.setQueryData(k, v);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[o.ruta ?? `/o/${ORG}/overview`]}>
        <OrgDePrueba org={o.org ?? orgDe()}>
          {o.patron ? <Routes><Route path={o.patron} element={nodo} /></Routes> : nodo}
        </OrgDePrueba>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// PanelDetalle lee window.matchMedia y document.activeElement al montar; en el SSR del arnés no existen.
function conVentana<T>(ancho: boolean, f: () => T): T {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: ancho, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal('document', { activeElement: null });
  try { return f(); } finally { vi.unstubAllGlobals(); }
}

// Documento Markdown con la carga en cada bloque y cada forma en línea que el subconjunto propio reconoce.
const mdCon = (c: string) => [
  `# ${c}`, '', `${c} con **${c}** y \`${c}\``, `[x](javascript:alert(1)) ![i](https://evil.test/p.png) <a href="javascript:alert(1)">a</a>`, '',
  `- ${c}`, `- **${c}**`, '', `1. ${c}`, `2) \`${c}\``, '', `## Mapa visual ${c}`, `### ${c}`, `<iframe src="javascript:alert(1)"></iframe>`,
].join('\n');

// ── Datos envenenados por componente ──────────────────────────────────────────
// El id se queda como UUID: DetalleHallazgo trata cualquier otro id como «no existe» (lib/ids.ts, se prueba aparte).
function hallazgo(c: string) {
  const f = envenenar(Finding, { ...fx.findings[0]!, has_fix_prompt: true, status: 'ignored', status_reason: 'motivo', fix_model: 'modelo' }, c);
  // Referencias que el FRONT construye: solo de un CVE/GHSA válido; nunca una URL de la evidencia.
  return { ...f, evidence: { ...f.evidence, cve: 'CVE-2024-12345', ghsa: 'GHSA-abcd-efgh-ijkl', falso: `CVE-2024-1${IMG}`, url: 'javascript:alert(1)' } };
}

function detalleIncidente(c: string, ip: boolean, o: Opciones = {}) {
  const i = envenenar(IncidentDetail, {
    ...fx.incidentDetail, suspected_injection: true,
    timeline: [...fx.incidentDetail.timeline, { t: fx.incidentDetail.started_at, ms: 30_000, kind: 'call_failed', label: 'fallo' }],
    actions: [{ id: fx.incidentDetail.id, kind: 'block_ip', target: '203.0.113.7', status: 'executed', created_at: fx.incidentDetail.started_at,
      undone_at: null, expires_at: null, approval_id: null }],
  }, c, o);
  return ip ? { ...i, resource: `ip:${marca(c, 'resource')}` } : i;
}

function acciones(c: string): AccionDato[] {
  return [
    { verbo: marca(c, 'verbo'), clase: 'prompt', principal: true, args: { finding_id: `../x%2F${c}` } },
    { verbo: marca(c, 'verbo'), clase: 'copiar', copiar: marca(c, 'copiar') },
    { verbo: marca(c, 'verbo'), clase: 'navegar', destino: { modulo: marca(c, 'modulo'), filtro: `../${c}%2F`, ancla: marca(c, 'ancla') } },
    { verbo: marca(c, 'verbo'), clase: 'navegar', destino: { modulo: 'incidents', filtro: `../../${c}%2F..` } },
    { verbo: marca(c, 'verbo'), clase: 'navegar', destino: { modulo: 'findings', filtro: c } },
    { verbo: marca(c, 'verbo'), clase: 'confirmar', args: { kind: 'block_ip', incident_id: `../%2F${c}` } },
    { verbo: marca(c, 'verbo'), clase: 'confirmar', args: { kind: c } },
    { verbo: marca(c, 'verbo'), clase: 'inmediata' },
  ];
}

const gruposDe = (c: string) => envenenar(z.array(GrupoDato), [...fx.moduleState.cloudflare.ahora, ...fx.moduleState.supabase.ahora], c, { ruta: 'grupos' });
// Lo que la Bandeja enseña de cada grupo y fila (los verbos de copiar y navegar siempre se pintan).
const verBandeja = (c: string) => gruposDe(c).flatMap((g): Ver[] => [sinBidi(g.etiqueta), ...(g.chapas ?? []), ...g.filas.flatMap((f): Ver[] => [
  sinBidi(f.etiqueta), ltr(sinBidi(f.objeto!)), sinBidi(f.sub!), ...(f.chips ?? []), ...f.acciones.filter((a) => a.clase === 'copiar' || a.clase === 'navegar').map((a) => a.verbo)])]);
const rango = (k: number) => Array.from({ length: k }, (_, i) => i);
// Lo que TablaTopIps enseña de cada IP: la IP y el UA recortado a 60 en <bdi dir="ltr">, y el title con el UA entero
// (con los controles bidi a la vista).
const verTopIps = (c: string, raiz: string) => rango(fx.traffic.top_ips.length).flatMap((k): Ver[] => {
  const ua = marca(c, `${raiz}top_ips[${k}].ua_top`);
  return [ltr(sinBidi(marca(c, `${raiz}top_ips[${k}].ip`))), ltr(sinBidi(ua.slice(0, 60))), sinBidi(ua)];
});
// «Ver ahora» del banner de AppShell: el href que se espera con cada carga (el id envenenado sale de idMalo() al pintar).
const VER_AHORA = new Map<string, string>();

// Varias codebases: la org con dos repos (el del fixture y conexionGithub2). Con `ruta`, cada nombre envenenado lleva su
// camino en la marca: los dos repos son distintos y reposGithub no los junta en uno.
const DOS_REPOS = [...CONEXIONES, ConnectionPublic.parse(fx.conexionGithub2)];
const IDX_GH = DOS_REPOS.flatMap((x, i) => (x.provider === 'github' && x.kind === 'read' ? [i] : []));
const REPO_FX = String(DOS_REPOS[IDX_GH[0]!]!.meta.repo_full_name);
const repoEnv = (c: string, i: number) => marca(c, `cx[${i}].meta.repo_full_name`);
const dosRepos = (c: string, cambio: (x: ConnectionPublic) => ConnectionPublic = (x) => x) =>
  envenenar(z.array(ConnectionPublic), DOS_REPOS.map(cambio), c, { ruta: 'cx' });

// ── Casos: un render por componente; cada uno se corre con todas las cargas ──
type Caso = { nombre: string; pintar: (c: string) => string; ver: (c: string) => Ver[]; enlaces?: (c: string) => string[] };

const CASOS: Caso[] = [
  {
    nombre: 'Markdown (overview_md / resumen_md) con sección «Mapa»',
    pintar: (c) => renderToStaticMarkup(<Markdown md={mdCon(c)} despues={(t) => <span>{t}</span>} />),
    ver: (c) => [c, `Mapa visual ${c}`],
  },
  {
    nombre: 'DiagramaWiki con una etiqueta Mermaid envenenada (cae a <pre>)',
    pintar: (c) => renderToStaticMarkup(<DiagramaWiki fuente={`flowchart LR\nA[${c}] --> B[Fin]\nB -->|${c}| C`} />),
    ver: (c) => [`flowchart LR\nA[${c}] --> B[Fin]\nB -->|${c}| C`],
  },
  {
    nombre: 'FichaFila con evidencia (claves y valores)',
    pintar: (c) => renderToStaticMarkup(<FichaFila rotulo={marca(c, 'rotulo')}
      valor={libre({ ...fx.findings[0]!.evidence, lista: ['a', 1, null], [c]: { anidado: 'b' } }, c, { campo: 'evidencia', camino: 'evidencia' }, {})} />),
    ver: (c) => [marca(c, 'rotulo'), ltr(enJson(c)), ltr(enJson(marca(c, 'anidado')))],
  },
  {
    nombre: 'FichaFila con un valor de texto suelto',
    pintar: (c) => renderToStaticMarkup(<FichaFila valor={c} />),
    ver: (c) => [ltr(enJson(c))],
  },
  {
    nombre: 'LineaTiempo (hitos y el resto de timeline[] desplegado)',
    pintar: (c) => { const i = detalleIncidente(c, false); return renderToStaticMarkup(<LineaTiempo hitos={hitosDe(i)} resto={restoDe(i)} />); },
    ver: (c) => [marca(c, 'label')],
  },
  {
    nombre: 'GraficaTrafico (leyenda) y TablaTopIps (IP, UA recortado a 60 y title completo)',
    pintar: (c) => {
      const t = envenenar(Traffic, fx.traffic, c, { ruta: '' });
      return renderToStaticMarkup(<><GraficaTrafico buckets={t.buckets} />
        <TablaTopIps ips={t.top_ips} resaltar={t.top_ips[0]!.ip} accion={(ip) => <span>{ip}</span>} /></>);
    },
    ver: (c) => verTopIps(c, ''),
  },
  {
    nombre: 'Etiqueta y ChapaSeveridad (también con severidad y rol fuera de contrato)',
    pintar: (c) => renderToStaticMarkup(<>
      <Etiqueta texto={c} /><Etiqueta texto={c} mono grande rol="aviso" /><Etiqueta texto={c} rol={c as Rol} />
      {(['critical', 'high', 'medium', 'low', 'info'] as const).map((s) => <ChapaSeveridad key={s} severity={s} grande />)}
      <ChapaSeveridad severity={c as Severity} />
    </>),
    ver: (c) => [c],
  },
  {
    nombre: 'ListaChecks, ChecksEnCero, Cifra y ErrorBloque',
    pintar: (c) => {
      const checks: PermCheck[] = [{ permission: marca(c, 'permission'), ok: false, required: false, error_code: 'forbidden' },
        { permission: marca(c, 'permission-ok'), ok: true }, { permission: marca(c, 'permission-falta'), ok: false }];
      const enCero = envenenar(z.array(CheckDato), fx.moduleState.supabase.checks, c);
      const cifras: CifraDato[] = envenenar(EstadoModulo, fx.moduleState.supabase, c).cifras;
      return pintar(<>
        <ListaChecks checks={checks} /><ChecksEnCero checks={enCero} />
        {cifras.map((x, i) => <Cifra key={i} etiqueta={x.etiqueta} n={x.n} de={x.de} unidad={x.unidad} decimales={x.decimales} sub={x.sub}
          rol={x.rol} href={x.destino ? rutaDe(ORG, x.destino) : undefined} />)}
        <Cifra etiqueta={marca(c, 'etiqueta')} n={3} sub={marca(c, 'sub')} rol="mal" href={rutaDe(ORG, { modulo: marca(c, 'modulo'), filtro: c, ancla: c })} />
        <ErrorBloque error={new ApiError(500, 'internal', marca(c, 'message'), marca(c, 'request_id'))} />
      </>);
    },
    ver: (c) => [marca(c, 'permission'), marca(c, 'permission-ok'), marca(c, 'nombre'), marca(c, 'codigo'), marca(c, 'etiqueta'), marca(c, 'sub'),
      marca(c, 'message'), marca(c, 'request_id')],
  },
  {
    nombre: 'Bandeja (grupos, chapas, filas, chips, objeto, sub y acciones del servidor)',
    pintar: (c) => pintar(<Bandeja grupos={gruposDe(c)} puedeEscribir hora={fx.moduleState.cloudflare.hora} />, { ruta: `/o/${ORG}/cloudflare` }),
    ver: verBandeja,
  },
  {
    nombre: 'FilaProblema y AccionFila con cada clase de acción (ids y rutas con ../ y %2F)',
    pintar: (c) => {
      const fila = { ...gruposDe(c)[0]!.filas[0]!, acciones: acciones(c) };
      return pintar(<ul>
        <FilaProblema fila={fila} puedeEscribir />
        <FilaProblema fila={fila} puedeEscribir={false} />
        {acciones(c).map((a, i) => <AccionFila key={i} accion={a} puedeEscribir />)}
      </ul>, { ruta: `/o/${ORG}/cloudflare` });
    },
    ver: (c) => [marca(c, 'verbo'), sinBidi(marca(c, 'grupos[0].filas[0].etiqueta')), ltr(sinBidi(marca(c, 'grupos[0].filas[0].objeto')))],
  },
  {
    nombre: 'DetalleHallazgo con PromptCorreccion (texto del prompt en <pre>)',
    pintar: (c) => {
      const f = hallazgo(c);
      const fix = envenenar(FixPromptResponse, { ...fx.fixPrompt, cached: false, injection_flags: ['a', 'b'] }, c);
      return pintar(<DetalleHallazgo org={ORG} id={f.id} puedeEscribir />, { datos: [[['org', ORG, 'finding', f.id], f], [['org', ORG, 'fix', f.id], fix]] });
    },
    ver: (c) => [sinBidi(marca(c, 'title')), ltr(sinBidi(marca(c, 'resource'))), marca(c, 'rule_id'), marca(c, 'status_reason'), marca(c, 'prompt'), marca(c, 'model'),
      ltr(enJson(marca(c, 'evidence.valor'))), `CVE-2024-1${IMG}`],
  },
  {
    nombre: 'DetalleHallazgo de solo lectura sin prompt',
    pintar: (c) => {
      const f = { ...hallazgo(c), has_fix_prompt: false, status: 'open' as const };
      return pintar(<DetalleHallazgo org={ORG} id={f.id} puedeEscribir={false} />, { datos: [[['org', ORG, 'finding', f.id], f]] });
    },
    ver: (c) => [sinBidi(marca(c, 'title')), ltr(sinBidi(marca(c, 'resource')))],
  },
  {
    nombre: 'PanelDetalle en Sheet (estrecho) y en aside (ancho) con el hallazgo de ?finding=',
    pintar: (c) => {
      const f = hallazgo(c);
      const o = { ruta: `/o/${ORG}/supabase?finding=${f.id}`, datos: [[['org', ORG, 'finding', f.id], f]] as [QueryKey, unknown][] };
      return conVentana(false, () => pintar(<DetalleEnPanel />, o)) + conVentana(true, () => pintar(<DetalleEnPanel />, o));
    },
    ver: (c) => [sinBidi(marca(c, 'title')), ltr(sinBidi(marca(c, 'resource'))), marca(c, 'status_reason'), ltr(enJson(marca(c, 'evidence.valor')))],
  },
  {
    nombre: 'TarjetaConexion (meta, alcances, last4 y last_error) y TarjetaIngesta (label)',
    pintar: (c) => {
      const cx = envenenar(z.array(ConnectionPublic), CONEXIONES.map((x, i) => ({ ...x, status: i % 2 ? 'error' as const : 'active' as const, last_error: 'unauthorized' })), c, { ids: true });
      return pintar(<>
        <TarjetaConexion proveedor="supabase" conexiones={cx} descripcion="d" icono={Database} />
        <TarjetaConexion proveedor="cloudflare" conexiones={cx} descripcion="d" icono={Database} />
        <TarjetaConexion proveedor="cloudflare" conexiones={cx.filter((x) => x.kind === 'read')} descripcion="d" icono={Database} />
        <TarjetaConexion proveedor="github" conexiones={cx} descripcion="d" icono={Database} />
        <TarjetaIngesta conexiones={cx} />
      </>, { datos: [[['org', ORG, 'connections'], cx]] });
    },
    ver: (c) => [marca(c, 'project_ref'), marca(c, 'project_name'), marca(c, 'zone_name'), marca(c, 'plan'), marca(c, 'repo_full_name'),
      marca(c, 'default_branch'), marca(c, 'scopes'), marca(c, 'label'), marca(c, 'last4')],
  },
  {
    nombre: 'PaginaWiki: documento (overview_md, títulos, áreas, archivos, avisos), mapa e historial',
    pintar: (c) => {
      const run = envenenar(WikiRun, fx.wikiRunDone, c);
      const doc = envenenar(WikiDoc, fx.wikiDoc, c);
      const d = { ...doc, overview_md: mdCon(c), paginas: doc.paginas.map((p) => ({ ...p, resumen_md: mdCon(c) })) };
      const cx = envenenar(z.array(ConnectionPublic), CONEXIONES, c);
      return pintar(<PaginaWiki />, { ruta: `/o/${ORG}/wiki?run=${run.id}`, patron: '/o/:orgId/wiki', datos: [
        [['org', ORG, 'wiki', 'run', run.id], run], [['org', ORG, 'wiki', 'doc', run.id], d], [['org', ORG, 'connections'], cx],
        [['org', ORG, 'wiki', 'runs', null], envenenar(z.array(WikiRun), fx.wikiRuns, c)]] });
    },
    ver: (c) => [c, marca(c, 'titulo'), ltr(sinBidi(marca(c, 'area'))), ltr(sinBidi(marca(c, 'archivos'))), marca(c, 'avisos'), marca(c, 'repo_full_name'),
      marca(c, 'branch'), marca(c, 'fast'), marca(c, 'smart'), marca(c, 'mermaid'), marca(c, 'commit_sha').slice(0, 7)],
  },
  {
    nombre: 'PaginaWiki: corrida fallida (error del BACK y detalle de cada paso)',
    pintar: (c) => {
      const run = envenenar(WikiRun, { ...fx.wikiRunRunning, status: 'failed', error: 'x', steps: fx.wikiRunRunning.steps.map((s) => ({ ...s, detalle: 'd' })) }, c);
      return pintar(<PaginaWiki />, { ruta: `/o/${ORG}/wiki?run=${run.id}`, patron: '/o/:orgId/wiki', datos: [[['org', ORG, 'wiki', 'run', run.id], run]] });
    },
    ver: (c) => [marca(c, 'error'), marca(c, 'detalle')],
  },
  {
    nombre: 'Estimacion de la wiki (repo, rama, modelos, desglose y avisos)',
    pintar: (c) => pintar(<Estimacion e={envenenar(WikiEstimate, { ...fx.wikiEstimate, truncado: true }, c)} ocupado={false}
      alGenerar={() => {}} alRegenerar={async () => {}} alVer={() => {}} />),
    ver: (c) => [marca(c, 'repo_full_name'), marca(c, 'branch'), marca(c, 'modelo'), marca(c, 'fast'), marca(c, 'smart'), marca(c, 'avisos')],
  },
  ...[false, true].map((ip): Caso => ({
    nombre: `PaginaIncidente (title, ${ip ? 'IP' : 'resource'}, details, user agent, avisos, acciones, reglas)`,
    pintar: (c) => {
      const i = detalleIncidente(c, ip, { ruta: '' });
      return pintar(<PaginaIncidente />, { ruta: `/o/${ORG}/incidents/${i.id}`, patron: '/o/:orgId/incidents/:incidentId', datos: [
        [['org', ORG, 'incident', i.id], i], [['org', ORG, 'traffic'], envenenar(Traffic, fx.traffic, c, { ruta: 'trafico' })],
        [['org', ORG, 'connections'], envenenar(z.array(ConnectionPublic), CONEXIONES, c)]] });
    },
    ver: (c) => [sinBidi(marca(c, 'title')), ltr(sinBidi(marca(c, 'resource'))), marca(c, 'code'), ...fx.incidentDetail.rule_ids.map((_, k) => marca(c, `rule_ids[${k}]`)),
      ...fx.incidentDetail.notifications.map((_, k) => marca(c, `notifications[${k}].recipient_masked`)), ltr(sinBidi(marca(c, 'actions[0].target'))),
      marca(c, 'timeline[7].label'), ltr(enJson(marca(c, 'details.ua_top'))), ltr(enJson(marca(c, 'details.valor'))), ...verTopIps(c, 'trafico.')],
  })),
  {
    nombre: 'PaginaIncidentes (lista: title, code y origen)',
    pintar: (c) => pintar(<PaginaIncidentes />, { ruta: `/o/${ORG}/incidents`, patron: '/o/:orgId/incidents',
      datos: [[['org', ORG, 'incidents', 'open'], envenenar(z.array(Incident), fx.incidents, c, { ids: true, ruta: 'incidentes' })]] }),
    ver: (c) => fx.incidents.flatMap((_, k) => [sinBidi(marca(c, `incidentes[${k}].title`)), marca(c, `incidentes[${k}].code`), marca(c, `incidentes[${k}].resource`)]),
  },
  {
    nombre: 'PaginaAuditoria: resumen de IA-2 (resumen, por_que, explicacion, model) y hallazgos abiertos',
    pintar: (c) => {
      const hs = envenenar(z.array(Finding), fx.findings, c, { ids: true, ruta: 'findings' });
      const r = envenenar(ScanRun, { ...fx.scanDone, summary: { ...fx.scanDone.summary!, suspected_injection: true } }, c, { ids: true, ruta: 'scan' });
      // Los ids envenenados del resumen apuntan a los hallazgos envenenados: así se pintan sus títulos y rule_id.
      const s = r.summary!;
      const run = { ...r, id: fx.scanDone.id, summary: { ...s, top: s.top.map((t, i) => ({ ...t, finding_id: hs[i]?.id ?? t.finding_id })),
        relaciones: s.relaciones.map((x) => ({ ...x, finding_ids: x.finding_ids.map((id, i) => hs[i]?.id ?? id) })) } };
      return pintar(<PaginaAuditoria />, { ruta: `/o/${ORG}/audit/${run.id}`, patron: '/o/:orgId/audit/:scanId', datos: [
        [['org', ORG, 'scan', run.id], run], [['org', ORG, 'findings', { status: 'open' }], hs],
        [['org', ORG, 'overview'], envenenar(Overview, fx.overview, c, { ruta: 'overview' })]] });
    },
    ver: (c) => [marca(c, 'scan.summary.resumen'), ...fx.scanDone.summary!.top.map((_, k) => marca(c, `scan.summary.top[${k}].por_que`)),
      ...fx.scanDone.summary!.relaciones.map((_, k) => marca(c, `scan.summary.relaciones[${k}].explicacion`)), marca(c, 'scan.summary.model'),
      ...rango(5).flatMap((k) => [marca(c, `findings[${k}].title`), marca(c, `findings[${k}].resource`)]), marca(c, 'findings[0].rule_id')],
  },
  {
    nombre: 'PaginaAuditoria: corrida fallida (error y paso actual del servidor)',
    pintar: (c) => {
      const run = { ...envenenar(ScanRun, { ...fx.scanRunning, status: 'failed', error: 'x', step: 'paso' }, c), id: fx.scanRunning.id };
      return pintar(<PaginaAuditoria />, { ruta: `/o/${ORG}/audit/${run.id}`, patron: '/o/:orgId/audit/:scanId', datos: [[['org', ORG, 'scan', run.id], run]] });
    },
    ver: (c) => [marca(c, 'error'), marca(c, 'step')],
  },
  {
    nombre: 'PaginaResumen («Ahora»: title y resource)',
    pintar: (c) => pintar(<PaginaResumen />, { ruta: `/o/${ORG}/overview`, patron: '/o/:orgId/overview', datos: [
      [['org', ORG, 'overview'], envenenar(Overview, fx.overview, c, { ids: true, ruta: 'overview' })],
      [['org', ORG, 'connections'], envenenar(z.array(ConnectionPublic), CONEXIONES, c)]] }),
    ver: (c) => fx.overview.ahora.flatMap((_, k) => [sinBidi(marca(c, `overview.ahora[${k}].title`)), marca(c, `overview.ahora[${k}].resource`)]),
  },
  {
    nombre: 'PantallaModulo vía PaginaCloudflare (?filtro= de la URL, cifras, «Ahora», checks, zona y plan)',
    pintar: (c) => {
      const t = envenenar(Traffic, fx.traffic, c, { ruta: '' });
      const inc = envenenar(z.array(Incident), fx.incidents, c, { ids: true }).map((i, k) => (k === 0 ? { ...i, resource: `ip:${t.top_ips[0]!.ip}` } : i));
      return pintar(<PaginaCloudflare />, { ruta: `/o/${ORG}/cloudflare?filtro=${encodeURIComponent(c)}`, patron: '/o/:orgId/cloudflare', datos: [
        [['org', ORG, 'module', 'cloudflare'], envenenar(EstadoModulo, fx.moduleState.cloudflare, c)], [['org', ORG, 'traffic'], t],
        [['org', ORG, 'connections'], envenenar(z.array(ConnectionPublic), CONEXIONES, c)], [['org', ORG, 'incidents', 'open'], inc]] });
    },
    ver: (c) => [c, marca(c, 'zone_name'), marca(c, 'plan'), marca(c, 'etiqueta'), marca(c, 'nombre'), ...verTopIps(c, '')],
  },
  {
    nombre: 'PaginaExportar (vista previa del Markdown del export)',
    pintar: (c) => pintar(<PaginaExportar />, { ruta: `/o/${ORG}/export`, patron: '/o/:orgId/export', datos: [[['org', ORG, 'export', 'md'], mdCon(c)]] }),
    ver: (c) => [`# ${c}`, `- **${c}**`],
  },
  {
    nombre: 'PaginaRendimiento (histórico: URL, versión y Lighthouse)',
    pintar: (c) => pintar(<PaginaRendimiento />, { ruta: `/o/${ORG}/performance`, patron: '/o/:orgId/performance', datos: [
      [['org', ORG, 'module', 'performance'], envenenar(EstadoModulo, fx.moduleState.performance, c)],
      [['org', ORG, 'perf'], envenenar(z.array(PerfRunExt), fx.perfRuns, c)]] }),
    ver: (c) => [marca(c, 'url'), marca(c, 'version_label'), marca(c, 'lighthouse_version')],
  },
  {
    nombre: 'AppShell (botón y menú de orgs, riel del Sheet, correo, PaletaComandos y banner «Ver ahora» con id envenenado)',
    pintar: (c) => {
      const me = envenenar(Me, { ...fx.me, orgs: [...fx.me.orgs, { ...fx.me.orgs[0]!, id: UUID, is_demo: false }] }, c, { ruta: 'me' });
      // overview.ahora[0] del fixture es un incidente crítico: con `ids`, el banner «Ver ahora» enlaza a un id envenenado.
      const o = envenenar(Overview, fx.overview, c, { ids: true, ruta: 'overview' });
      const critico = o.ahora.find((a) => a.kind === 'incident' && a.severity === 'critical');
      if (critico) VER_AHORA.set(c, `/o/${ORG}/incidents/${encodeURIComponent(critico.id)}`); else VER_AHORA.delete(c);
      return pintar(<AppShell />, { ruta: `/o/${ORG}/overview`, patron: '/o/:orgId/*', org: orgDe({ name: marca(c, 'org.name'), me }),
        datos: [[['org', ORG, 'overview'], o]] });
    },
    ver: (c) => [marca(c, 'org.name'), marca(c, 'me.orgs[0].name'), marca(c, 'me.orgs[1].name'), marca(c, 'me.user.email'),
      sinBidi(marca(c, 'overview.ahora[0].title'))],
    // Absoluto, en la org de la URL y con el id codificado (antes era `incidents/${id}` relativo y sin codificar).
    enlaces: (c) => [VER_AHORA.get(c) ?? 'sin incidente crítico en overview.ahora'],
  },
  {
    nombre: 'PaginaAjustes (org, correo y contactos) y Verificar (código de WhatsApp; solo enlaza a https://wa.me)',
    pintar: (c) => {
      const lista = envenenar(z.array(Contact), CONTACTOS, c, { ruta: 'contacts' });
      // Además del enlace envenenado de cada contacto, uno que parece de wa.me y no lo es.
      const contactos = [...lista, { ...lista[1]!, id: UUID, verificacion: { codigo: marca(c, 'contacts[2].verificacion.codigo'), enlace: 'https://wa.me@evil.test/x' } }];
      const sano = { ...lista[1]!, verificacion: { codigo: marca(c, 'codigo'), enlace: ENLACE_WA } };
      return pintar(<>
        <PaginaAjustes />
        {contactos.map((x) => <Verificar key={x.id} c={x} esperando alAbrir={() => {}} />)}
        <Verificar c={sano} esperando alAbrir={() => {}} />
      </>, { ruta: `/o/${ORG}/settings`, patron: '/o/:orgId/settings', org: orgDe({ name: marca(c, 'org.name'), me: envenenar(Me, fx.me, c, { ruta: 'me' }) }),
        datos: [[['org', ORG, 'overview'], envenenar(Overview, fx.overview, c)], [['org', ORG, 'contacts'], contactos]] });
    },
    ver: (c) => [marca(c, 'org.name'), marca(c, 'me.user.email'), marca(c, 'codigo'), ...rango(3).map((k) => marca(c, `contacts[${k}].verificacion.codigo`))],
  },
  {
    nombre: 'Propuesta de BloquearIp (efecto, avisos, code y error del servidor)',
    pintar: (c) => {
      const p = envenenar(ProposeResponse, { ...fx.actionProposal, delivery: 'in_app', code: '482913' }, c, { ruta: 'propuesta' });
      const resto = { codigo: '12', alCambiarCodigo: () => {}, alConfirmar: () => {}, alCancelar: () => {}, alVencer: () => {} };
      return renderToStaticMarkup(<>
        <Propuesta p={p} {...resto} escribiendo={false} error={marca(c, 'error')} />
        <Propuesta p={{ ...p, delivery: 'whatsapp' }} {...resto} escribiendo />
      </>);
    },
    ver: (c) => [marca(c, 'propuesta.efecto'), ...fx.actionProposal.avisos.map((_, k) => marca(c, `propuesta.avisos[${k}]`)), marca(c, 'propuesta.code'), marca(c, 'error')],
  },
  {
    nombre: 'Resultado de Asistente (last4, permisos comprobados, secreto de ingesta e id de la conexión)',
    pintar: (c) => {
      const r = envenenar(ConnectionCreated, { connection: CONEXIONES[4]!, action_connection: CONEXIONES[2]!, checks: fx.permChecks, ingest_secret: 'vgi_secreto' },
        c, { ids: true, ruta: 'creada' });
      return renderToStaticMarkup(<>
        <Resultado r={r} alTerminar={() => {}} />
        <Resultado r={{ ...r, ingest_secret: null, action_connection: null }} alTerminar={() => {}} />
      </>);
    },
    ver: (c) => [marca(c, 'creada.connection.last4'), marca(c, 'creada.ingest_secret'), ...fx.permChecks.map((_, k) => marca(c, `creada.checks[${k}].permission`))],
  },
  // ── Varias codebases (asignaciones/varias-codebases.md §6): la org con dos repos ──
  {
    nombre: 'Varias codebases: TarjetaConexion de GitHub con dos repos (el repo de título de cada línea y su rama)',
    pintar: (c) => { const cx = dosRepos(c); return pintar(<TarjetaConexion proveedor="github" conexiones={cx} descripcion="d" icono={Database} />, { datos: [[['org', ORG, 'connections'], cx]] }); },
    ver: (c) => IDX_GH.flatMap((i) => [repoEnv(c, i), ltr(marca(c, `cx[${i}].meta.default_branch`))]),
  },
  {
    nombre: 'Varias codebases: PaginaCodebase con dos repos (pestañas, «Repositorio», rama y la revisión del elegido)',
    pintar: (c) => {
      const cx = dosRepos(c);
      const [a, b] = IDX_GH.map((i) => cx[i]!);
      return pintar(<PaginaCodebase />, { ruta: `/o/${ORG}/codebase?repo=${b!.id}`, patron: '/o/:orgId/codebase', datos: [
        [['org', ORG, 'connections'], cx], [['org', ORG, 'module', 'codebase'], fx.moduleState.codebase], [['org', ORG, 'alert-prefs'], fx.alertPrefs],
        [['org', ORG, 'revision', a!.id], fx.codeReviewState], [['org', ORG, 'revision', b!.id], fx.codeReviewStateRepo2]] });
    },
    ver: (c) => [...IDX_GH.map((i) => repoEnv(c, i)), marca(c, `cx[${IDX_GH[1]}].meta.default_branch`)],
  },
  {
    nombre: 'Varias codebases: PaginaWiki con dos repos (lista, «Generar la wiki de», «Otro repo público» y la conexión caída)',
    pintar: (c) => {
      const o = { ruta: `/o/${ORG}/wiki`, patron: '/o/:orgId/wiki' };
      const caidos = dosRepos(c, (x) => (x.provider === 'github' ? { ...x, status: 'revoked' as const } : x));
      return pintar(<PaginaWiki />, { ...o, datos: [[['org', ORG, 'connections'], dosRepos(c)]] })
        + pintar(<PaginaWiki />, { ...o, datos: [[['org', ORG, 'connections'], caidos]] });
    },
    ver: (c) => IDX_GH.map((i) => repoEnv(c, i)),
  },
  {
    nombre: 'Varias codebases: PaginaWiki, estado de la wiki de cada repo (commit y rama de las corridas del servidor)',
    pintar: (c) => {
      const runs = envenenar(z.array(WikiRun), fx.wikiRuns, c, { ruta: 'runs' }).map((r) => ({ ...r, repo_full_name: REPO_FX, status: 'succeeded' as const }));
      return pintar(<PaginaWiki />, { ruta: `/o/${ORG}/wiki`, patron: '/o/:orgId/wiki', datos: [[['org', ORG, 'connections'], DOS_REPOS],
        [['org', ORG, 'wiki', 'runs', REPO_FX], runs], [['org', ORG, 'wiki', 'runs', String(DOS_REPOS.at(-1)!.meta.repo_full_name)], []]] });
    },
    ver: (c) => [marca(c, 'x').slice(0, 7), ...fx.wikiRuns.map((_, k) => ltr(marca(c, `runs[${k}].branch`)))],
  },
  {
    nombre: 'Varias codebases: PaginaAuditoria con una línea por repo (ScanRun.repos)',
    pintar: (c) => {
      const run = { ...envenenar(ScanRun, fx.scanDoneDosRepos, c, { ruta: 'scan' }), id: fx.scanDone.id };
      return pintar(<PaginaAuditoria />, { ruta: `/o/${ORG}/audit/${run.id}`, patron: '/o/:orgId/audit/:scanId', datos: [[['org', ORG, 'scan', run.id], run]] });
    },
    ver: (c) => fx.scanDoneDosRepos.repos.map((_, k) => marca(c, `scan.repos[${k}].repo_full_name`)),
  },
  {
    nombre: 'Varias codebases: chip del repo en «Ahora» del Resumen y en el detalle del hallazgo',
    pintar: (c) => {
      const cx = dosRepos(c);
      const gh = cx[IDX_GH[0]!]!;
      const o = { ...fx.overview, ahora: fx.overview.ahora.map((a) => (a.kind === 'finding' ? { ...a, connection_id: gh.id } : a)) };
      const f = { ...Finding.parse(fx.findings[0]), has_fix_prompt: false, connection_id: gh.id };
      return pintar(<PaginaResumen />, { ruta: `/o/${ORG}/overview`, patron: '/o/:orgId/overview', datos: [[['org', ORG, 'overview'], o], [['org', ORG, 'connections'], cx]] })
        + pintar(<DetalleHallazgo org={ORG} id={f.id} puedeEscribir />, { datos: [[['org', ORG, 'finding', f.id], f], [['org', ORG, 'connections'], cx]] });
    },
    ver: (c) => [repoEnv(c, IDX_GH[0]!)],
  },
];

describe.each(CARGAS)('XSS · carga «%s»', (_nombre, carga) => {
  it.each(CASOS)('$nombre', (caso) => {
    const html = caso.pintar(carga);
    revisar(html, carga, caso.pintar(INOCENTE), caso.ver(carga), caso.enlaces?.(carga));
  });
});

// ── Robustez: enums y literales fuera de contrato (api() en producción deja pasar el cuerpo) ──
describe('XSS · enums fuera de contrato', () => {
  beforeAll(() => { ENUMS = true; });
  afterAll(() => { ENUMS = false; });
  // Con IMG cada enum lleva la carga marcada; con las claves de PROTO, la clave a secas (poner()). Un mapa leído con
  // `MAPA[k] ?? x` devolvería Object.prototype o una función: React lanza, o la pinta como texto.
  const CARGAS_ENUM = [IMG, ...PROTO];
  const robusto = (caso: Caso) => { for (const c of CARGAS_ENUM) expect(peligros(caso.pintar(c), true), c).toEqual([]); };
  // Antes PaginaAuditoria era un HALLAZGO (ESTADO_SCAN[run.status] y TEXTO_PASO[s.name] sin respaldo lanzaban TypeError);
  // ahora lee con deMapa (pasos.ts textoPaso y estadoScan) y entra en la lista normal.
  it.each(CASOS)('$nombre: no lanza y no pinta nada peligroso', robusto);

  // Un `${MAPA[k]}` sin respaldo no lanza: pinta «undefined», «[object Object]» o «function Object() { [native code] }».
  const BASURA = [/\bundefined\b/, /\[object Object\]/, /\[native code\]/, /\bNaN\b/];
  const sinBasura = (caso: Caso) => {
    for (const c of CARGAS_ENUM) {
      const html = caso.pintar(c);
      for (const b of BASURA) expect(html, `${c} → ${b}`).not.toMatch(b);
    }
  };
  // Incluye el Resultado del Asistente: ListaChecks lee FRASE_ERROR con deMapa, así que un error_code fuera de contrato
  // (o «__proto__») no pinta «undefined» ni «[object Object]».
  it.each(CASOS)('$nombre: no pinta «undefined» ni un objeto como texto', sinBasura);
});

// ── El detector detecta: sin esto, un arnés que no ve nada pasaría siempre ────
describe('XSS · el detector del arnés', () => {
  it.each([
    ['<img> con onerror sin comillas', `<div>${IMG}</div>`, ['<img>', '<img onerror=…>']],
    ['<script>', '<p><script>alert(1)</script></p>', ['<script>']],
    ['<svg onload>', '<span>"><svg onload=alert(1)></span>', ['<svg onload=…>']],
    ['<iframe>', '<iframe src="https://officialvanguard.com/x"></iframe>', ['<iframe>']],
    ['srcdoc', '<iframe srcdoc="&lt;b&gt;"></iframe>', ['<iframe>', '<iframe srcdoc=…>']],
    ['href javascript: con espacios y mayúsculas', '<a href=" JaVaScRiPt:alert(1)">x</a>', ['<a href=" JaVaScRiPt:alert(1)"> esquema javascript:']],
    ['href javascript: con entidades', '<a href="java&#x73;cript:alert(1)">x</a>', ['<a href="javascript:alert(1)"> esquema javascript:']],
    ['href data:', '<a href="data:text/html,x">x</a>', ['<a href="data:text/html,x"> esquema data:']],
    ['href a otro host por protocolo relativo', '<a href="//evil.test/p">x</a>', ['<a href="//evil.test/p"> host evil.test']],
    ['style con url()', '<div style="background:url(https://evil.test/p.png)"></div>', ['<div style="background:url(https://evil.test/p.png)">']],
  ])('%s', (_n, html, esperado) => {
    expect(peligros(html)).toEqual(esperado);
  });

  it('el href javascript: que React 19 neutraliza solo pasa en modo no estricto', () => {
    const html = renderToStaticMarkup(<a href="javascript:alert(1)">x</a>);
    expect(html).toContain('React has blocked a javascript: URL');
    expect(peligros(html)).toEqual([]);
    expect(peligros(html, true)).toHaveLength(1);
  });

  it('un renderizador ingenuo que convierte [x](url) en <a> cambia la estructura frente al texto inocente', () => {
    const Ingenuo = ({ t }: { t: string }) => { const m = /\[(.*)\]\((.*)\)/.exec(t); return <p>{m ? <a href={m[2]}>{m[1]}</a> : t}</p>; };
    expect(estructura(renderToStaticMarkup(<Ingenuo t="[x](javascript:alert(1))" />))).not.toEqual(estructura(renderToStaticMarkup(<Ingenuo t={INOCENTE} />)));
  });

  it('el texto escapado por React no cuenta como etiqueta', () => {
    const html = renderToStaticMarkup(<span title={IMG}>{IMG}{'"><svg onload=alert(1)>'}</span>);
    expect(peligros(html, true)).toEqual([]);
    expect(etiquetas(html).map((t) => t.nombre)).toEqual(['span']);
    expect(html).toContain(esc(IMG));
  });

  it('un id envenenado en un href sin codificar se detecta; codificado, no', () => {
    const ids = [idMalo(), idMalo(), idMalo()];
    const html = (id: string) => renderToStaticMarkup(<a href={`/o/${ORG}/incidents/${id}`}>x</a>);
    for (const id of ids) {
      expect(idsSinCodificar(html(id))).toHaveLength(1);
      expect(idsSinCodificar(html(encodeURIComponent(id)))).toEqual([]);
    }
  });

  it('con enums, una clave del prototipo llega a secas a los enums y marcada al texto; IMG llega marcada a los dos', () => {
    for (const c of PROTO) {
      const i = envenenar(Incident, { ...fx.incidents[0]!, acked_via: 'in_app' }, c, { enums: true });   // un null se queda null
      expect([i.status, i.severity, i.module, i.acked_via]).toEqual([c, c, c, c]);
      expect(i.title).toBe(marca(c, 'title'));
      expect(Object.hasOwn(i, 'status')).toBe(true);                    // propiedad propia, no el prototipo
    }
    const img = envenenar(Incident, fx.incidents[0]!, IMG, { enums: true });
    expect(img.status).toBe(marca(IMG, 'status'));
    expect(envenenar(Incident, fx.incidents[0]!, '__proto__').status).toBe(fx.incidents[0]!.status);   // sin enums, intacto
  });

  it('rellenar sintetiza los opcionales y nullables con texto (y deja null los que no lo admiten)', () => {
    const t = envenenar(Traffic, fx.traffic, IMG, { ruta: '' });
    expect(fx.traffic.top_ips[3]!.ua_top).toBeNull();
    expect(t.top_ips[3]!.ua_top).toBe(marca(IMG, 'top_ips[3].ua_top'));
    const g = envenenar(GrupoDato, fx.moduleState.cloudflare.ahora[2]!, IMG);
    expect(g.chapas).toEqual([marca(IMG, 'chapas')]);
    const s = envenenar(ScanRun, fx.scanRunning, IMG);
    expect(s.error).toBe(marca(IMG, 'error'));
    expect(s.steps.map((x) => x.error_code)).toEqual(s.steps.map(() => marca(IMG, 'error_code')));
    expect(s.coverage).toEqual(fx.scanRunning.coverage);                // sin texto: se queda como venía
    expect(s.finished_at).toBeNull();                                   // Ts: no se inventa una fecha
    expect(envenenar(ScanRun, fx.scanRunning, IMG, { rellenar: false }).error).toBeNull();
  });
});

// ── Mermaid: etiquetas con <b>, click, style y javascript: ─────────────────────
describe('XSS · Mermaid de la wiki', () => {
  const pre = (fuente: string) => {
    const html = renderToStaticMarkup(<DiagramaWiki fuente={fuente} />);
    expect(parsearMermaid(fuente)).toBeNull();
    expect(html.startsWith('<pre')).toBe(true);                     // fuera de la lista blanca: código, no dibujo
    expect(html).toContain(esc(sinBidi(fuente)));
    expect(peligros(html, true)).toEqual([]);
    expect(etiquetas(html).map((t) => t.nombre)).toEqual(['pre']);
    return html;
  };

  // Si alguien relaja ETQ/TEXTO de lib/mermaid.ts para dejar pasar < o &, este caso tiene que romperse.
  it.each([
    ['<b> en la etiqueta', 'flowchart LR\nA[<b>negrita</b>] --> B[Fin]'],
    ['click con javascript:', 'flowchart LR\nA[Inicio] --> B[Fin]\nclick A "javascript:alert(1)"'],
    ['click a función', 'flowchart LR\nA[Inicio] --> B[Fin]\nclick A callback "tooltip"'],
    ['style con url(javascript:)', 'flowchart LR\nA[Inicio] --> B[Fin]\nstyle A fill:#f00,stroke:url(javascript:alert(1))'],
    ['classDef', 'flowchart LR\nA[Inicio] --> B[Fin]\nclassDef rojo fill:#f00\nclass A rojo'],
    ['javascript: en la etiqueta', 'flowchart LR\nA[javascript:alert(1)] --> B[Fin]'],
    ['etiqueta entre comillas con HTML', 'flowchart LR\nA["<img src=x onerror=alert(1)>"] --> B'],
    ['texto de flecha con <script>', 'flowchart LR\nA[Inicio] -->|<script>alert(1)</script>| B[Fin]'],
    ['directiva init con securityLevel loose', '%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\nA --> B'],
    ['href en el nodo', 'flowchart LR\nA[Inicio] --> B[Fin]\nclick B href "https://evil.test" _blank'],
    ['id con ../ y %2F', 'flowchart LR\n../A[Inicio] --> B%2F[Fin]'],
    ['caracteres bidi', 'flowchart LR\nA[‮exe.txt] --> B[Fin]'],
  ])('%s → se muestra como código escapado', (_n, fuente) => { pre(fuente); });

  it('palabras «click», «style», «javascript» y «onload» como etiquetas válidas se dibujan como <text>, sin enlaces ni manejadores', () => {
    const fuente = 'flowchart LR\nA[click] -->|javascript| B[style]\nB --> C[onload]\nC --> A';
    const g = parsearMermaid(fuente);
    expect(g?.nodos.map((x) => x.etiqueta)).toEqual(['click', 'style', 'onload']);
    const html = renderToStaticMarkup(<DiagramaWiki fuente={fuente} />);
    expect(peligros(html, true)).toEqual([]);
    const nombres = new Set(etiquetas(html).map((t) => t.nombre));
    expect([...nombres].sort()).toEqual(['defs', 'div', 'g', 'marker', 'path', 'rect', 'svg', 'text']);
    for (const p of ['click', 'style', 'onload', 'javascript']) expect(html).toMatch(new RegExp(`<text[^>]*>${p}</text>`));
    // Ningún atributo con nombre o valor sacado de la etiqueta (salvo el aria-label, que es texto escapado).
    for (const t of etiquetas(html)) for (const [k, v] of t.attrs) if (k !== 'aria-label') expect(v).not.toMatch(/click|onload|javascript/);
  });

  it('PaginaWiki con un Mermaid válido en el borde de la lista blanca (16 nodos, 60 caracteres, tildes y «.,_-»): <text> y aria-label', () => {
    const PALABRAS = ['javascript.alert-1 onerror_x onload, click style href src', 'ÁÉÍÓÚÜÑ áéíóúüñ img src.x onerror.alert-1 script iframe',
      'data.text_html, evil.test, x.y-z svg onload_alert-1', 'formaction srcdoc xlink_href use foreignObject animate set'];
    const etq = (i: number) => `${PALABRAS[i % PALABRAS.length]} ${i}`.padEnd(60, '_').slice(0, 60);
    const txt = (i: number) => `${PALABRAS[(i + 1) % PALABRAS.length]} ${i}`.slice(0, 60);
    const fuente = ['flowchart LR', ...rango(15).map((i) => `N${i}[${etq(i)}] -->|${txt(i)}| N${i + 1}[${etq(i + 1)}]`)].join('\n');
    expect(parsearMermaid(fuente)?.nodos).toHaveLength(16);
    const run = { ...fx.wikiRunDone };
    const html = pintar(<PaginaWiki />, { ruta: `/o/${ORG}/wiki?run=${run.id}`, patron: '/o/:orgId/wiki', datos: [
      [['org', ORG, 'wiki', 'run', run.id], run], [['org', ORG, 'wiki', 'doc', run.id], { ...fx.wikiDoc, mermaid: fuente }]] });
    const i0 = html.lastIndexOf('<svg', html.indexOf('aria-label="Mapa del repositorio: '));
    const svg = html.slice(i0, html.indexOf('</svg>', i0) + 6);
    expect(i0).toBeGreaterThan(-1);
    expect(peligros(html, true)).toEqual([]);
    expect([...new Set(etiquetas(svg).map((t) => t.nombre))].sort()).toEqual(['defs', 'g', 'marker', 'path', 'rect', 'svg', 'text']);
    for (const i of rango(16)) for (const l of partir(etq(i))) expect(svg).toContain(`>${esc(l)}</text>`);
    for (const i of rango(15)) {
      expect(svg).toContain(`>${esc(txt(i))}</text>`);
      expect(svg).toContain(esc(`${etq(i)} → ${etq(i + 1)} (${txt(i)})`));     // aria-label del <svg>
    }
    for (const t of etiquetas(svg)) for (const [k, v] of t.attrs) if (k !== 'aria-label') expect(v).not.toMatch(/javascript|onerror|onload|click|srcdoc|evil/i);
  });

  it('10 KB de Mermaid (demasiados nodos) no rompe el render y cae a código', () => {
    const lineas = Array.from({ length: 400 }, (_, i) => `N${i}[Nodo ${i}] --> N${i + 1}[Nodo ${i + 1}]`);
    const fuente = ['flowchart LR', ...lineas].join('\n');
    expect(fuente.length).toBeGreaterThan(10 * 1024);
    const t0 = performance.now();
    pre(fuente);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

// ── Markdown: el subconjunto propio deja HTML, enlaces e imágenes como texto ──
describe('XSS · Markdown propio', () => {
  it('enlaces, imágenes y HTML quedan como un solo nodo de texto', () => {
    for (const [, c] of CARGAS) {
      expect(enLinea(c)).toEqual([c]);
      expect(bloques(c)).toEqual([{ t: 'p', texto: c }]);
    }
  });
  it('entrada adversaria de 10 KB (asteriscos, backticks, almohadillas) se procesa en tiempo lineal', () => {
    const t0 = performance.now();
    for (const s of ['*'.repeat(10_240), '`'.repeat(10_240), '**a'.repeat(3_400), '#'.repeat(10_240), '- '.repeat(5_120), '1. '.repeat(3_400)]) {
      const html = renderToStaticMarkup(<Markdown md={s} />);
      expect(peligros(html, true)).toEqual([]);
    }
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

// ── Enlaces que el FRONT construye con datos del servidor ──────────────────────
describe('XSS · enlaces', () => {
  it('las referencias del hallazgo salen solo de un CVE/GHSA válido y van a cve.org / osv.dev', () => {
    const f = hallazgo(IMG);
    const html = pintar(<DetalleHallazgo org={ORG} id={f.id} puedeEscribir />, { datos: [[['org', ORG, 'finding', f.id], f]] });
    expect(hrefs(html).sort()).toEqual([
      'https://osv.dev/vulnerability/CVE-2024-12345', 'https://osv.dev/vulnerability/GHSA-abcd-efgh-ijkl', 'https://www.cve.org/CVERecord?id=CVE-2024-12345',
    ]);
  });

  it.each(['../../x%2Fy', '..%2F..%2Fadmin', '%2F%2Fevil.test', `${fx.findings[0]!.id}/../x`])(
    'un id de hallazgo que no es UUID (%s) se trata como «no existe» y no pinta datos de la caché', (id) => {
      const f = { ...hallazgo(IMG), id };
      const html = pintar(<DetalleHallazgo org={ORG} id={id} puedeEscribir />, { datos: [[['org', ORG, 'finding', id], f]] });
      expect(html).toContain('Este hallazgo no existe');
      expect(html).not.toContain(esc(marca(IMG, 'title')));
    });

  it('AccionFila y rutaDe codifican ids y rutas con ../ y %2F (el enlace se queda en su ruta)', () => {
    const html = pintar(<>{acciones(IMG).map((a, i) => <AccionFila key={i} accion={a} puedeEscribir />)}</>, { ruta: `/o/${ORG}/cloudflare` });
    const hs = hrefs(html);
    const e = encodeURIComponent;
    // Un «%2F» de la carga llega como «%252F» y un «/» como «%2F»: nunca un segmento ni un parámetro nuevo.
    expect(hs.sort()).toEqual([
      `/o/${ORG}/cloudflare?finding=${e(`../x%2F${IMG}`)}`,
      `/o/${ORG}/cloudflare?finding=${e(IMG)}`,
      `/o/${ORG}/${e(marca(IMG, 'modulo'))}?filtro=${e(`../${IMG}%2F`)}#${e(marca(IMG, 'ancla'))}`,
      `/o/${ORG}/incidents/${e(`../%2F${IMG}`)}`,
      `/o/${ORG}/incidents/${e(`../../${IMG}%2F..`)}`,
    ].sort());
    for (const h of hs) expect(h).not.toContain('../');
  });

  it('el enlace de verificación por WhatsApp de un contacto sano va a https://wa.me/', () => {
    const html = pintar(<Verificar c={LUIS} esperando={false} alAbrir={() => {}} />);
    expect(hrefs(html)).toEqual([ENLACE_WA]);
    expect(peligros(html, true)).toEqual([]);
  });

  // Antes era un HALLAZGO (Verificar pintaba `verificacion.enlace` sin validar; api() en producción no corta un cuerpo
  // fuera de contrato). Ahora solo enlaza a https://wa.me sin credenciales ni puerto, y si no, deja el código para copiar.
  it.each([
    ['javascript:', 'javascript:alert(1)'], ['data:', 'data:text/html,<script>alert(1)</script>'], ['otro host', 'https://evil.test/wa'],
    ['protocolo relativo', '//evil.test/wa'], ['con credenciales', 'https://wa.me@evil.test/wa'], ['con puerto', 'https://wa.me:8443/x'],
    ['http', 'http://wa.me/x'], ['subdominio parecido', 'https://wa.me.evil.test/x'],
  ])('Verificar: un enlace %s del servidor no llega al href y el código sigue a la vista', (_n, enlace) => {
    const c: Contact = { ...LUIS, verificacion: { codigo: '7C2A9F', enlace } };
    const html = pintar(<Verificar c={c} esperando={false} alAbrir={() => {}} />);
    expect(peligros(html, true)).toEqual([]);
    expect(hrefs(html)).toEqual([]);
    expect(html).toContain('VERIFICAR 7C2A9F');
  });

  // Antes era un HALLAZGO (`<Link to={i.id}>` relativo: un id «//evil.test/x» salía como enlace externo). Ahora el enlace es
  // absoluto y el id va con encodeURIComponent. La matriz de arriba lo comprueba también en Resumen, Auditoría y Cloudflare.
  it('el enlace de cada incidente de la lista apunta a su propio id, codificado', () => {
    const ids = ['//evil.test/x', '../../x%2Fy', 'x?y=1#z'];
    const lista = ids.map((id, k) => ({ ...fx.incidents[k % fx.incidents.length]!, id }));
    const html = pintar(<PaginaIncidentes />, { ruta: `/o/${ORG}/incidents`, patron: '/o/:orgId/incidents', datos: [[['org', ORG, 'incidents', 'open'], lista]] });
    expect(peligros(html, true)).toEqual([]);
    const propios = hrefs(html).filter((x) => x.startsWith(`/o/${ORG}/incidents/`));
    expect(propios).toEqual(ids.map((id) => `/o/${ORG}/incidents/${encodeURIComponent(id)}`));
    for (const h of hrefs(html)) expect(h.startsWith(`/o/${ORG}/`)).toBe(true);
  });

  // Antes era un HALLAZGO: el banner usaba `incidents/${id}` relativo y sin codificar, y con el mismo item de
  // overview.ahora llevaba a otro sitio que FilaAhora del Resumen ('../../../login' daba /login).
  it.each(['x?finding=y#z', '../../../login', '../../otra-org/settings', '//evil.test/x'])(
    'el banner «Ver ahora» de AppShell enlaza al incidente %s codificado, igual que FilaAhora del Resumen', (id) => {
      const o = { ...fx.overview, ahora: fx.overview.ahora.map((a, k) => (k === 0 ? { ...a, id } : a)) };
      const esperado = `/o/${ORG}/incidents/${encodeURIComponent(id)}`;
      const shell = pintar(<AppShell />, { ruta: `/o/${ORG}/overview`, patron: '/o/:orgId/*', datos: [[['org', ORG, 'overview'], o]] });
      expect(shell).toContain('Ver ahora');
      expect(hrefs(shell)).toContain(esperado);
      const resumen = pintar(<PaginaResumen />, { ruta: `/o/${ORG}/overview`, patron: '/o/:orgId/overview', datos: [[['org', ORG, 'overview'], o]] });
      expect(hrefs(resumen)).toContain(esperado);
      for (const h of [...hrefs(shell), ...hrefs(resumen)]) expect(h).not.toContain(id);          // nunca el id crudo
    });
});

// ── Bidi: el texto RTL se pinta como texto y los controles de dirección se ven ──
describe('XSS · controles bidi', () => {
  // Antes era un HALLAZGO (suplantación visual tipo «Trojan Source»): «src/lib/U+202E sj.nimda» se leía «src/lib/admin.js».
  // Ahora los campos mono (Dónde, FichaFila, TablaTopIps, archivos de la wiki, IP y recurso del incidente) pasan por
  // sinBidi dentro de <bdi dir="ltr">: sin dir, el <bdi> vale dir=auto y la primera letra fuerte decide la dirección.
  // La matriz de arriba lo exige con ltr() en cada campo técnico.
  it('un U+202E del servidor no llega crudo a «Dónde» del hallazgo: se ve ⟨U+202E⟩ y va aislado en <bdi dir="ltr">', () => {
    const f = { ...hallazgo(INOCENTE), resource: 'src/lib/‮sj.nimda' };
    const html = pintar(<DetalleHallazgo org={ORG} id={f.id} puedeEscribir />, { datos: [[['org', ORG, 'finding', f.id], f]] });
    expect(html).not.toContain('‮');
    expect(html).toContain('<bdi dir="ltr">src/lib/⟨U+202E⟩sj.nimda</bdi>');
  });

  it('una ruta que empieza por una letra árabe va en <bdi dir="ltr"> (no en dir=auto) en «Dónde» y en el recurso del incidente', () => {
    const ruta = 'مجلد/admin.js';
    const f = { ...hallazgo(INOCENTE), resource: ruta };
    const html = pintar(<DetalleHallazgo org={ORG} id={f.id} puedeEscribir />, { datos: [[['org', ORG, 'finding', f.id], f]] });
    const i = { ...detalleIncidente(INOCENTE, false), resource: ruta };
    const inc = pintar(<PaginaIncidente />, { ruta: `/o/${ORG}/incidents/${i.id}`, patron: '/o/:orgId/incidents/:incidentId', datos: [[['org', ORG, 'incident', i.id], i]] });
    for (const h of [html, inc]) {
      expect(h).toContain(`<bdi dir="ltr">${ruta}</bdi>`);
      expect(h).not.toContain(`<bdi>${ruta}</bdi>`);
    }
  });
});

// ── Robustez: fechas envenenadas (Ts es z.string() en el contrato) ────────────
describe('XSS · fechas con la carga (Ts es z.string())', () => {
  it.each(CARGAS)('«%s» en las fechas no rompe el detalle del hallazgo, la línea de tiempo ni el detalle del incidente', (_n, c) => {
    const f = envenenar(Finding, fx.findings[0]!, c, { fechas: true });
    const i = envenenar(IncidentDetail, fx.incidentDetail, c, { fechas: true });
    const html = pintar(<>
      <DetalleHallazgo org={ORG} id={f.id} puedeEscribir />
      <LineaTiempo hitos={hitosDe(i)} resto={restoDe(i)} />
    </>, { datos: [[['org', ORG, 'finding', f.id], f]] });
    expect(peligros(html, true)).toEqual([]);
    const inc = pintar(<PaginaIncidente />, { ruta: `/o/${ORG}/incidents/${i.id}`, patron: '/o/:orgId/incidents/:incidentId', datos: [
      [['org', ORG, 'incident', i.id], i], [['org', ORG, 'traffic'], envenenar(Traffic, fx.traffic, c, { fechas: true })]] });
    expect(peligros(inc, true)).toEqual([]);
    for (const crudo of ['<img src=x', '<script>alert', '<svg onload']) { expect(html).not.toContain(crudo); expect(inc).not.toContain(crudo); }
  });

  // Antes era un HALLAZGO: Intl.DateTimeFormat.format lanzaba RangeError con una cubeta de fecha inválida y tumbaba el
  // incidente y Cloudflare. Ahora esa cubeta sale «—».
  it('GraficaTrafico: una cubeta con fecha inválida no rompe el render', () => {
    const t = envenenar(Traffic, fx.traffic, IMG, { fechas: true });
    expect(() => renderToStaticMarkup(<GraficaTrafico buckets={t.buckets} />)).not.toThrow();
  });
});
