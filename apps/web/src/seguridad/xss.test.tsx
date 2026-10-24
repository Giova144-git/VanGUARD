// Arnés de XSS del FRONT (PLAN_MAESTRO §14.1, L9): todo texto que llega del servidor (evidencia, logs, repos, user
// agents, salida del modelo) se pinta como TEXTO. Cada componente que lo pinta se renderiza con renderToStaticMarkup y
// datos envenenados (copias de los fixtures de @vanguard/contracts con los campos de texto sustituidos; los fixtures
// compartidos no se tocan) y se comprueba el HTML resultante:
//   1. ningún elemento peligroso (script, img, iframe, object…), ningún atributo on*=, ningún href/src con un esquema
//      que no sea http(s) ni a un host fuera de la lista (javascript:, data:, //evil.test…), ningún style con url();
//   2. la misma estructura (etiquetas y nombres de atributo) que con un texto inocente: la carga no crea elementos;
//   3. la carga sale ESCAPADA como texto (&lt;img …) en los campos que el componente enseña.
// Cada campo envenenado lleva su nombre al final («carga⟦title⟧») para saber qué campo se ve y dónde.
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { Database } from 'lucide-react';
import { z } from 'zod';
import {
  fixtures as fx, CheckDato, ConnectionPublic, Contact, EstadoModulo, Finding, FixPromptResponse, GrupoDato, Incident,
  IncidentDetail, Me, Overview, PerfRunExt, ScanRun, Traffic, WikiDoc, WikiEstimate, WikiRun, type AccionDato, type CifraDato,
  type PermCheck, type TimelineItem,
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
import { ApiError } from '@/lib/errores';
import { Markdown, bloques, enLinea } from '@/lib/markdown';
import { parsearMermaid } from '@/lib/mermaid';
import { rutaDe } from '@/lib/destino';
import PaginaAjustes, { Verificar } from '@/modulos/ajustes/PaginaAjustes';
import PaginaAuditoria from '@/modulos/auditoria/PaginaAuditoria';
import PaginaCloudflare from '@/modulos/cloudflare/PaginaCloudflare';
import { TarjetaConexion, TarjetaIngesta } from '@/modulos/conexiones/TarjetaConexion';
import PaginaExportar from '@/modulos/exportar/PaginaExportar';
import { DetalleHallazgo } from '@/modulos/hallazgos/DetalleHallazgo';
import { hitosDe, restoDe } from '@/modulos/incidentes/hitos';
import PaginaIncidente from '@/modulos/incidentes/PaginaIncidente';
import PaginaIncidentes from '@/modulos/incidentes/PaginaIncidentes';
import PaginaRendimiento from '@/modulos/rendimiento/PaginaRendimiento';
import PaginaResumen from '@/modulos/resumen/PaginaResumen';
import PaginaWiki, { Estimacion } from '@/modulos/wiki/PaginaWiki';

// supabase-js pide VITE_SUPABASE_URL al importarse; aquí no hay red ni sesión (solo la usan los manejadores de clic).
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
// Plegado no se renderiza el cuerpo (SectorPlegable y Collapsible de Radix): para revisar lo que hay dentro, abiertos.
vi.mock('@/componentes/vg/SectorPlegable', async () => {
  const { createElement } = await import('react');
  return { SectorPlegable: ({ titulo, children }: { titulo: string; children: ReactNode }) => createElement('section', null, createElement('h3', null, titulo), children) };
});
vi.mock('radix-ui', async (importOriginal) => {
  const real = await importOriginal<typeof import('radix-ui')>();
  const { createElement } = await import('react');
  const pasa = (tag: string) => ({ children, className }: { children?: ReactNode; className?: string }) => createElement(tag, { className }, children);
  return { ...real, Collapsible: { ...real.Collapsible, Root: pasa('div'), Trigger: pasa('button'), Content: pasa('div') } };
});

// ── Cargas ────────────────────────────────────────────────────────────────────
const IMG = '<img src=x onerror=alert(1)>';
const CARGAS: [string, string][] = [
  ['img onerror', IMG],
  ['script', '<script>alert(1)</script>'],
  ['javascript:', 'javascript:alert(1)'],
  ['enlace Markdown', '[x](javascript:alert(1))'],
  ['imagen Markdown', '![i](https://evil.test/p.png)'],
  ['svg onload', '"><svg onload=alert(1)>'],
  ['bidi y RTL', '‮exe.txt‬ ⁦שלום⁩ مرحبا ‫txt.exe'],
  ['10 KB', 'A'.repeat(10 * 1024 - IMG.length) + IMG],
];
// Con «:» para que también caiga fuera de la lista blanca de Mermaid: la comparación es con el mismo camino.
const INOCENTE = 'Texto normal: 123';
const marca = (c: string, campo: string) => `${c}⟦${campo}⟧`;
// Así escapa React el texto y los atributos (escapeTextForBrowser).
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
// Lo que pinta FichaFila: JSON.stringify y luego el escape de React.
const enJson = (s: string) => JSON.stringify(s).slice(1, -1);

// ── Envenenar: cada campo de texto que permite el esquema zod ─────────────────
// Recorre el esquema y el valor a la vez: z.string() → carga marcada con el nombre del campo; z.uuid() → «../N%2F..»
// (si `ids`); dentro de z.unknown() (evidence, details, meta, args) todas las cadenas y una clave extra envenenada.
// Las fechas ISO (Ts es z.string()) se respetan salvo con `fechas`, para no mezclar robustez con escape.
type Def = { type: string; format?: string; innerType?: Esq; shape?: Record<string, Esq>; element?: Esq; valueType?: Esq };
type Esq = { _zod: { def: Def } };
type Opciones = { ids?: boolean; fechas?: boolean };
const ISO = /^\d{4}-\d{2}-\d{2}T/;
let n = 0;
const idMalo = () => `../${++n}%2F..`;

function libre(v: unknown, c: string, campo: string, o: Opciones): unknown {
  if (typeof v === 'string') return ISO.test(v) && !o.fechas ? v : marca(c, campo);
  if (Array.isArray(v)) return v.map((x) => libre(x, c, campo, o));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, libre(x, c, k, o)]));
  return v;
}

function poner(s: Esq, v: unknown, c: string, campo: string, o: Opciones): unknown {
  const d = s._zod.def;
  switch (d.type) {
    case 'string':
      if (typeof v !== 'string') return v;
      if (d.format === 'uuid') return o.ids ? idMalo() : v;
      return ISO.test(v) && !o.fechas ? v : marca(c, campo);
    case 'optional': case 'nullable': case 'default': case 'readonly': case 'nonoptional':
      return v == null ? v : poner(d.innerType!, v, c, campo, o);
    case 'object':
      return v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, d.shape![k] ? poner(d.shape![k]!, x, c, k, o) : x])) : v;
    case 'array':
      return Array.isArray(v) ? v.map((x) => poner(d.element!, x, c, campo, o)) : v;
    case 'record': {
      if (!v || typeof v !== 'object') return v;
      const vt = d.valueType!._zod.def.type;
      const r = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, poner(d.valueType!, x, c, k, o)]));
      return vt === 'unknown' || vt === 'any' ? { ...r, [marca(c, `${campo}.clave`)]: marca(c, `${campo}.valor`) } : r;
    }
    case 'unknown': case 'any':
      return libre(v, c, campo, o);
    case 'union':
      return typeof v === 'string' ? marca(c, campo) : libre(v, c, campo, o);
    default:
      return v;                                                       // enum, literal, number, boolean
  }
}

function envenenar<S extends z.ZodType>(s: S, v: z.infer<S>, c: string, o: Opciones = {}): z.infer<S> {
  return poner(s as unknown as Esq, v, c, 'raiz', o) as z.infer<S>;
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

function revisar(html: string, carga: string, base: string, ver: string[]) {
  expect(peligros(html)).toEqual([]);
  expect(estructura(html)).toEqual(estructura(base));
  for (const crudo of ['<img src=x', '<script>alert', '<svg onload']) expect(html).not.toContain(crudo);
  for (const v of ver) expect(html, `debe verse escapado: ${v.slice(0, 80)}`).toContain(esc(v));
  if (carga.length >= 10 * 1024) expect(html).toContain('A'.repeat(60));        // la de 10 KB se pinta (o se recorta en su sitio)
}

// ── Render con router, TanStack Query (datos precargados) y la org de prueba ──
const ORG = fx.me.orgs[0]!.id;
// Copias tipadas (parse valida y da el tipo del contrato; el tipo inferido del array literal del fixture no casa con el record).
const CONEXIONES = z.array(ConnectionPublic).parse(fx.connections);
const LUIS = Contact.parse(fx.contacts[1]);                       // sin verificar: trae su enlace de wa.me
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

function detalleIncidente(c: string, ip: boolean) {
  const i = envenenar(IncidentDetail, {
    ...fx.incidentDetail, suspected_injection: true,
    timeline: [...fx.incidentDetail.timeline, { t: fx.incidentDetail.started_at, ms: 30_000, kind: 'call_failed', label: 'fallo' }],
    actions: [{ id: fx.incidentDetail.id, kind: 'block_ip', target: '203.0.113.7', status: 'executed', created_at: fx.incidentDetail.started_at,
      undone_at: null, expires_at: null, approval_id: null }],
  }, c);
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

const gruposDe = (c: string) => envenenar(z.array(GrupoDato), [...fx.moduleState.cloudflare.ahora, ...fx.moduleState.supabase.ahora], c);

// ── Casos: un render por componente; cada uno se corre con todas las cargas ──
type Caso = { nombre: string; pintar: (c: string) => string; ver: (c: string) => string[] };

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
    pintar: (c) => renderToStaticMarkup(<FichaFila rotulo={marca(c, 'rotulo')} valor={libre({ ...fx.findings[0]!.evidence, lista: ['a', 1, null], [c]: { anidado: 'b' } }, c, 'evidencia', {})} />),
    ver: (c) => [marca(c, 'rotulo'), enJson(c), enJson(marca(c, 'anidado'))],
  },
  {
    nombre: 'FichaFila con un valor de texto suelto',
    pintar: (c) => renderToStaticMarkup(<FichaFila valor={c} />),
    ver: (c) => [enJson(c)],
  },
  {
    nombre: 'LineaTiempo (hitos y el resto de timeline[] desplegado)',
    pintar: (c) => { const i = detalleIncidente(c, false); return renderToStaticMarkup(<LineaTiempo hitos={hitosDe(i)} resto={restoDe(i)} />); },
    ver: (c) => [marca(c, 'label')],
  },
  {
    nombre: 'GraficaTrafico (leyenda) y TablaTopIps (IP, UA recortado a 60 y title completo)',
    pintar: (c) => {
      const t = envenenar(Traffic, fx.traffic, c);
      return renderToStaticMarkup(<><GraficaTrafico buckets={t.buckets} />
        <TablaTopIps ips={t.top_ips} resaltar={t.top_ips[0]!.ip} accion={(ip) => <span>{ip}</span>} /></>);
    },
    ver: (c) => [marca(c, 'ip'), marca(c, 'ua_top'), marca(c, 'ua_top').slice(0, 60)],
  },
  {
    nombre: 'Etiqueta y ChapaSeveridad',
    pintar: (c) => renderToStaticMarkup(<>
      <Etiqueta texto={c} /><Etiqueta texto={c} mono grande rol="aviso" />
      {(['critical', 'high', 'medium', 'low', 'info'] as const).map((s) => <ChapaSeveridad key={s} severity={s} grande />)}
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
    nombre: 'Bandeja (grupos, filas, chips, objeto, sub y acciones del servidor)',
    pintar: (c) => pintar(<Bandeja grupos={gruposDe(c)} puedeEscribir hora={fx.moduleState.cloudflare.hora} />, { ruta: `/o/${ORG}/cloudflare` }),
    ver: (c) => [marca(c, 'etiqueta'), marca(c, 'objeto'), marca(c, 'sub'), marca(c, 'chips'), marca(c, 'verbo')],
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
    ver: (c) => [marca(c, 'verbo'), marca(c, 'etiqueta')],
  },
  {
    nombre: 'DetalleHallazgo con PromptCorreccion (texto del prompt en <pre>)',
    pintar: (c) => {
      const f = hallazgo(c);
      const fix = envenenar(FixPromptResponse, { ...fx.fixPrompt, cached: false, injection_flags: ['a', 'b'] }, c);
      return pintar(<DetalleHallazgo org={ORG} id={f.id} puedeEscribir />, { datos: [[['org', ORG, 'finding', f.id], f], [['org', ORG, 'fix', f.id], fix]] });
    },
    ver: (c) => [marca(c, 'title'), marca(c, 'resource'), marca(c, 'rule_id'), marca(c, 'status_reason'), marca(c, 'prompt'), marca(c, 'model'),
      enJson(marca(c, 'evidence.valor')), `CVE-2024-1${IMG}`],
  },
  {
    nombre: 'DetalleHallazgo de solo lectura sin prompt',
    pintar: (c) => {
      const f = { ...hallazgo(c), has_fix_prompt: false, status: 'open' as const };
      return pintar(<DetalleHallazgo org={ORG} id={f.id} puedeEscribir={false} />, { datos: [[['org', ORG, 'finding', f.id], f]] });
    },
    ver: (c) => [marca(c, 'title'), marca(c, 'resource')],
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
    ver: (c) => [c, marca(c, 'titulo'), marca(c, 'area'), marca(c, 'archivos'), marca(c, 'avisos'), marca(c, 'repo_full_name'), marca(c, 'branch'),
      marca(c, 'fast'), marca(c, 'smart'), marca(c, 'mermaid'), marca(c, 'commit_sha').slice(0, 7)],
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
      const i = detalleIncidente(c, ip);
      return pintar(<PaginaIncidente />, { ruta: `/o/${ORG}/incidents/${i.id}`, patron: '/o/:orgId/incidents/:incidentId', datos: [
        [['org', ORG, 'incident', i.id], i], [['org', ORG, 'traffic'], envenenar(Traffic, fx.traffic, c)],
        [['org', ORG, 'connections'], envenenar(z.array(ConnectionPublic), CONEXIONES, c)]] });
    },
    ver: (c) => [marca(c, 'title'), marca(c, 'resource'), marca(c, 'recipient_masked'), marca(c, 'target'), marca(c, 'label'), marca(c, 'rule_ids'),
      marca(c, 'code'), marca(c, 'ua_top').slice(0, 60), enJson(marca(c, 'ua_top')), enJson(marca(c, 'details.valor'))],
  })),
  {
    nombre: 'PaginaIncidentes (lista: title, code y origen)',
    pintar: (c) => pintar(<PaginaIncidentes />, { ruta: `/o/${ORG}/incidents`, patron: '/o/:orgId/incidents',
      datos: [[['org', ORG, 'incidents', 'open'], envenenar(z.array(Incident), fx.incidents, c, { ids: true })]] }),
    ver: (c) => [marca(c, 'title'), marca(c, 'code'), marca(c, 'resource')],
  },
  {
    nombre: 'PaginaAuditoria: resumen de IA-2 (resumen, por_que, explicacion, model) y hallazgos abiertos',
    pintar: (c) => {
      const hs = envenenar(z.array(Finding), fx.findings, c, { ids: true });
      const r = envenenar(ScanRun, { ...fx.scanDone, summary: { ...fx.scanDone.summary, suspected_injection: true } }, c, { ids: true });
      // Los ids envenenados del resumen apuntan a los hallazgos envenenados: así se pintan sus títulos y rule_id.
      const s = r.summary!;
      const run = { ...r, id: fx.scanDone.id, summary: { ...s, top: s.top.map((t, i) => ({ ...t, finding_id: hs[i]?.id ?? t.finding_id })),
        relaciones: s.relaciones.map((x) => ({ ...x, finding_ids: x.finding_ids.map((id, i) => hs[i]?.id ?? id) })) } };
      return pintar(<PaginaAuditoria />, { ruta: `/o/${ORG}/audit/${run.id}`, patron: '/o/:orgId/audit/:scanId', datos: [
        [['org', ORG, 'scan', run.id], run], [['org', ORG, 'findings', { status: 'open' }], hs], [['org', ORG, 'overview'], envenenar(Overview, fx.overview, c)]] });
    },
    ver: (c) => [marca(c, 'resumen'), marca(c, 'por_que'), marca(c, 'explicacion'), marca(c, 'model'), marca(c, 'title'), marca(c, 'resource'), marca(c, 'rule_id')],
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
      [['org', ORG, 'overview'], envenenar(Overview, fx.overview, c, { ids: true })], [['org', ORG, 'connections'], envenenar(z.array(ConnectionPublic), CONEXIONES, c)]] }),
    ver: (c) => [marca(c, 'title'), marca(c, 'resource')],
  },
  {
    nombre: 'PantallaModulo vía PaginaCloudflare (?filtro= de la URL, cifras, «Ahora», checks, zona y plan)',
    pintar: (c) => {
      const t = envenenar(Traffic, fx.traffic, c);
      const inc = envenenar(z.array(Incident), fx.incidents, c).map((i, k) => (k === 0 ? { ...i, resource: `ip:${t.top_ips[0]!.ip}` } : i));
      return pintar(<PaginaCloudflare />, { ruta: `/o/${ORG}/cloudflare?filtro=${encodeURIComponent(c)}`, patron: '/o/:orgId/cloudflare', datos: [
        [['org', ORG, 'module', 'cloudflare'], envenenar(EstadoModulo, fx.moduleState.cloudflare, c)], [['org', ORG, 'traffic'], t],
        [['org', ORG, 'connections'], envenenar(z.array(ConnectionPublic), CONEXIONES, c)], [['org', ORG, 'incidents', 'open'], inc]] });
    },
    ver: (c) => [c, marca(c, 'zone_name'), marca(c, 'plan'), marca(c, 'etiqueta'), marca(c, 'nombre'), marca(c, 'ip')],
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
    nombre: 'AppShell (nombre de la org y correo del usuario)',
    pintar: (c) => pintar(<AppShell />, { ruta: `/o/${ORG}/overview`, patron: '/o/:orgId/*',
      org: orgDe({ name: marca(c, 'name'), me: envenenar(Me, fx.me, c) }), datos: [[['org', ORG, 'overview'], envenenar(Overview, fx.overview, c)]] }),
    ver: (c) => [marca(c, 'name'), marca(c, 'email')],
  },
  {
    nombre: 'PaginaAjustes (org y correo) y Verificar (código de WhatsApp)',
    pintar: (c) => {
      const contacto = { ...envenenar(Contact, LUIS, c), verificacion: { codigo: marca(c, 'codigo'), enlace: ENLACE_WA } };
      return pintar(<><PaginaAjustes /><Verificar c={contacto} esperando alAbrir={() => {}} /></>, { ruta: `/o/${ORG}/settings`, patron: '/o/:orgId/settings',
        org: orgDe({ name: marca(c, 'name'), me: envenenar(Me, fx.me, c) }), datos: [[['org', ORG, 'overview'], fx.overview]] });
    },
    ver: (c) => [marca(c, 'name'), marca(c, 'email'), marca(c, 'codigo')],
  },
];

describe.each(CARGAS)('XSS · carga «%s»', (_nombre, carga) => {
  it.each(CASOS)('$nombre', (caso) => {
    const html = caso.pintar(carga);
    revisar(html, carga, caso.pintar(INOCENTE), caso.ver(carga));
  });
});

// ── El detector detecta: sin esto, un arnés que no ve nada pasaría siempre ────
describe('XSS · el detector del arnés', () => {
  it.each([
    ['<img> con onerror sin comillas', `<div>${IMG}</div>`, ['<img>', '<img onerror=…>']],
    ['<script>', '<p><script>alert(1)</script></p>', ['<script>']],
    ['<svg onload>', '<span>"><svg onload=alert(1)></span>', ['<svg onload=…>']],
    ['<iframe>', '<iframe src="https://officialvanguard.com/x"></iframe>', ['<iframe>']],
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
});

// ── Mermaid: etiquetas con <b>, click, style y javascript: ─────────────────────
describe('XSS · Mermaid de la wiki', () => {
  const pre = (fuente: string) => {
    const html = renderToStaticMarkup(<DiagramaWiki fuente={fuente} />);
    expect(parsearMermaid(fuente)).toBeNull();
    expect(html.startsWith('<pre')).toBe(true);                     // fuera de la lista blanca: código, no dibujo
    expect(html).toContain(esc(fuente));
    expect(peligros(html, true)).toEqual([]);
    expect(etiquetas(html).map((t) => t.nombre)).toEqual(['pre']);
    return html;
  };

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

  // HALLAZGO (media): PaginaAjustes.tsx (Verificar) pinta `verificacion.enlace` del servidor como href sin validarlo. El contrato
  // exige https://wa.me/, pero api() en producción devuelve el cuerpo aunque no cumpla el esquema (contract_mismatch). React
  // 19 neutraliza javascript:, no data: ni un https a otro host. Arreglo: validar como urlRevocar (new URL, https: y host
  // wa.me) y, si no, no pintar el botón.
  it.skip.each([
    ['javascript:', 'javascript:alert(1)'], ['data:', 'data:text/html,<script>alert(1)</script>'], ['otro host', 'https://evil.test/wa'],
    ['protocolo relativo', '//evil.test/wa'],
  ])('HALLAZGO Verificar: un enlace %s del servidor no llega al href', (_n, enlace) => {
    const c: Contact = { ...LUIS, verificacion: { codigo: '7C2A9F', enlace } };
    const html = pintar(<Verificar c={c} esperando={false} alAbrir={() => {}} />);
    expect(peligros(html, true)).toEqual([]);
  });

  // HALLAZGO (baja): ids del servidor en enlaces sin encodeURIComponent: PaginaIncidentes.tsx (`<Link to={i.id}>`, relativo),
  // PaginaResumen.tsx (FilaAhora: `/incidents/${item.id}` y `?finding=${item.id}`), PaginaAuditoria.tsx (`?finding=${t.finding_id}`,
  // `?finding=${id}`, `?finding=${f.id}`, `/audit/${ultima.id}`) y PaginaCloudflare.tsx (verIncidente). No ejecuta código (React 19
  // bloquea javascript:), pero un id con «../», «?» o «#» cambia el destino dentro del origen, y uno con «//host» en
  // `to={i.id}` sale como enlace EXTERNO (React Router lo trata como URL absoluta). Los ids son uuid en la base y api() los
  // valida en DEV; arreglo: encodeURIComponent como en rutaDe (o esId antes de pintar el enlace).
  it.skip('HALLAZGO ids sin codificar: el enlace de cada incidente de la lista apunta a su propio id', () => {
    const lista = fx.incidents.map((i, k) => ({ ...i, id: k ? '//evil.test/x' : '../../x%2Fy' }));
    const html = pintar(<PaginaIncidentes />, { ruta: `/o/${ORG}/incidents`, patron: '/o/:orgId/incidents', datos: [[['org', ORG, 'incidents', 'open'], lista]] });
    expect(peligros(html, true)).toEqual([]);
    for (const h of hrefs(html).filter((x) => x !== `/o/${ORG}/incidents`)) expect(h.startsWith(`/o/${ORG}/incidents/`)).toBe(true);
  });
});

// ── Bidi: el texto RTL se pinta como texto (arriba), pero los controles bidi no se aíslan ──
describe('XSS · controles bidi', () => {
  // HALLAZGO (baja, suplantación visual tipo «Trojan Source»): resource, rutas de archivos, UA, IPs y nombres llegan con
  // U+202A–U+202E / U+2066–U+2069 tal cual y sin aislar (ni <bdi> ni unicode-bidi: isolate), así que «src/lib/U+202E
  // sj.nimda» se lee «src/lib/admin.js» y puede reordenar el texto que va detrás en la misma línea. No ejecuta nada.
  // Arreglo: en los campos mono (DetalleHallazgo «Dónde», FichaFila, TablaTopIps, archivos de la wiki) envolver en <bdi>
  // o aplicar unicode-bidi: isolate y hacer visibles los controles (p. ej. «⟨U+202E⟩»). Si se arregla sustituyéndolos,
  // ajustar también los `ver` de la carga «bidi y RTL» de arriba.
  it.skip('HALLAZGO bidi: un U+202E del servidor no llega crudo a «Dónde» del hallazgo', () => {
    const f = { ...hallazgo(INOCENTE), resource: 'src/lib/‮sj.nimda' };
    const html = pintar(<DetalleHallazgo org={ORG} id={f.id} puedeEscribir />, { datos: [[['org', ORG, 'finding', f.id], f]] });
    expect(html).not.toContain('‮');
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
    expect(peligros(html)).toEqual([]);
    const inc = pintar(<PaginaIncidente />, { ruta: `/o/${ORG}/incidents/${i.id}`, patron: '/o/:orgId/incidents/:incidentId', datos: [[['org', ORG, 'incident', i.id], i]] });
    expect(peligros(inc)).toEqual([]);
    for (const crudo of ['<img src=x', '<script>alert', '<svg onload']) { expect(html).not.toContain(crudo); expect(inc).not.toContain(crudo); }
  });

  // HALLAZGO (baja, robustez): GraficaTrafico.tsx formatea `b.t` con Intl.DateTimeFormat.format(new Date(b.t)), que
  // lanza RangeError con una fecha inválida y tumba la página del incidente y la de Cloudflare. Arreglo: usar cuando()/un
  // guardia Number.isNaN(d.getTime()) → '—' como en lib/formato.ts.
  it.skip('HALLAZGO GraficaTrafico: una cubeta con fecha inválida no rompe el render', () => {
    const t = envenenar(Traffic, fx.traffic, IMG, { fechas: true });
    expect(() => renderToStaticMarkup(<GraficaTrafico buckets={t.buckets} />)).not.toThrow();
  });
});
