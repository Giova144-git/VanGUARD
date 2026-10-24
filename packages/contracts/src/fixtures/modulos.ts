// Estado de cada módulo (E6) que pinta <PantallaModulo/>. Reglas de S15 E6: rol `mal` solo con acción posible,
// chequeo sin correr = `comprobado:false` y `n:null`. Clases de acción de P0: prompt, copiar, navegar, confirmar.
// Destino.modulo usa ids de NAV de S14 §14.5 (o `incidents`/`findings`). Las horas escritas en `sub` van en hora de
// Caracas (horaCaracas), como las pinta el FRONT a partir de `hora` y `created_at` (S14 §14.6).
import type { Module } from '../comun.ts';
import type { EstadoModulo } from '../estado.ts';
import {
  F_CB_DEP_IGNITION, F_CB_DEP_JQUERY, F_CB_DEP_LODASH, F_CB_ENV, F_CB_GITIGNORE, F_CB_POSTGRES, F_CB_SERVICE_ROLE,
  F_SB_ADV_DUP, F_SB_ADV_EVENTOS, F_SB_POLICY, F_SB_RLS, F_SB_RPC, INC_ATAQUE, IP_ATACANTE, T_ESTADO, T_PERF_V2, horaCaracas,
} from './ids.ts';
import { EVENTOS_ATAQUE, PETICIONES_4XX_5M, PETICIONES_5M, incidenteAtaque } from './incidentes.ts';

const generarPrompt = (finding_id: string, principal = true) =>
  ({ verbo: 'Generar prompt', clase: 'prompt', principal, args: { finding_id } }) as const;

// ── Supabase (víctima vanguard-demo, S07 §07.8 y §07.9) ───────────────────────
const supabase = {
  ok: true, hora: T_ESTADO, contador: { rojo: 3, aviso: 0, cola: 2 },
  cifras: [
    { tipo: 'sb_health', etiqueta: 'Servicios', n: 6, de: 6, rol: 'bien',
      sub: `revisado ${horaCaracas(new Date(Date.parse(T_ESTADO) - 60_000).toISOString())}` },
    { tipo: 'sb_cpu', etiqueta: 'CPU', n: 23, unidad: '%', rol: 'bien', sub: 'hace 1 min' },
    { tipo: 'sb_mem', etiqueta: 'RAM', n: 61, unidad: '%', rol: 'neutra' },
    { tipo: 'sb_disk', etiqueta: 'Disco', n: 4, unidad: '%', rol: 'bien' },
    { tipo: 'sb_conn', etiqueta: 'Conexiones', n: 12, unidad: '%', rol: 'bien', sub: '7 de 60' },
    { tipo: 'sb_rls', etiqueta: 'Tablas sin RLS', n: 1, de: 4, rol: 'mal', destino: { modulo: 'supabase', ancla: 'ahora' } },
    { tipo: 'sb_rpc', etiqueta: 'Funciones sin freno', n: 1, rol: 'mal', destino: { modulo: 'supabase', ancla: 'ahora' } },
  ],
  ahora: [
    { grupo: 'SB_RLS_DISABLED', etiqueta: 'Datos abiertos', rol: 'mal', n: 1, orden: 5, filas: [
      { clave: F_SB_RLS, modulo: 'supabase', tipo: 'finding', rol: 'mal', etiqueta: 'RLS desactivada', objeto: 'public.pedidos',
        sub: '≈ 500 filas · legible sin sesión', chips: ['confirmado'],
        acciones: [
          { verbo: 'Generar prompt de corrección', clase: 'prompt', principal: true, args: { finding_id: F_SB_RLS } },
          { verbo: 'Copiar SQL de arreglo', clase: 'copiar',
            copiar: 'alter table "public"."pedidos" enable row level security;\n'
              + '-- política mínima: cada usuario ve solo sus filas (cambia user_id por tu columna de dueño)\n'
              + 'create policy "pedidos_dueno_lee" on "public"."pedidos" for select to authenticated\n'
              + '  using ((select auth.uid()) = user_id);\n'
              + '-- si la tabla no debe leerse sin sesión:\n'
              + 'revoke select on "public"."pedidos" from anon;' },
        ] },
    ] },
    { grupo: 'SB_RPC_ANON_NO_LIMIT', etiqueta: 'Funciones sin freno', rol: 'mal', n: 1, orden: 5, filas: [
      { clave: F_SB_RPC, modulo: 'supabase', tipo: 'finding', rol: 'mal', etiqueta: 'Función pública sin freno',
        objeto: 'public.enviar_otp', sub: 'se llama sin sesión · sin límite de peticiones',
        acciones: [
          generarPrompt(F_SB_RPC),
          { verbo: 'Copiar SQL de arreglo', clase: 'copiar',
            copiar: 'revoke execute on function "public"."enviar_otp"(p_destino text) from public, anon;\n'
              + 'grant execute on function "public"."enviar_otp"(p_destino text) to authenticated;' },
        ] },
    ] },
    { grupo: 'SB_POLICY_ALLOW_ALL', etiqueta: 'Políticas pase-todo', rol: 'mal', n: 1, orden: 4, filas: [
      { clave: F_SB_POLICY, modulo: 'supabase', tipo: 'finding', rol: 'mal', etiqueta: 'Política pase-todo',
        objeto: 'public.perfiles', sub: 'pase_todo · SELECT para anon', chips: ['confirmado'],
        acciones: [
          generarPrompt(F_SB_POLICY),
          { verbo: 'Copiar SQL de arreglo', clase: 'copiar',
            copiar: 'drop policy "pase_todo" on "public"."perfiles";\n'
              + 'create policy "perfiles_dueno" on "public"."perfiles" for select to authenticated\n'
              + '  using ((select auth.uid()) = user_id);' },
        ] },
    ] },
    { grupo: 'SB_ADVISOR', etiqueta: 'Avisos de Supabase', rol: 'cola', n: 2, orden: 1, filas: [
      { clave: F_SB_ADV_EVENTOS, modulo: 'supabase', tipo: 'finding', rol: 'cola', etiqueta: 'RLS activa sin políticas',
        objeto: 'public.eventos', sub: 'advisor de Supabase · INFO', acciones: [generarPrompt(F_SB_ADV_EVENTOS, false)] },
      { clave: F_SB_ADV_DUP, modulo: 'supabase', tipo: 'finding', rol: 'cola', etiqueta: 'RLS desactivada (ya contada)',
        objeto: 'public.pedidos', sub: 'mismo problema que «Datos abiertos»',
        acciones: [{ verbo: 'Ver hallazgo', clase: 'navegar', destino: { modulo: 'findings', filtro: F_SB_RLS } }] },
    ] },
  ],
  checks: [
    { nombre: 'Base sana', codigo: 'SB_DB_DOWN', n: 0, comprobado: true },
    { nombre: 'RLS en todas las tablas', codigo: 'SB_RLS_DISABLED', n: 1, de: 4, comprobado: true },
    { nombre: 'Políticas sin pase-todo', codigo: 'SB_POLICY_ALLOW_ALL', n: 1, comprobado: true },
    { nombre: 'Funciones con freno', codigo: 'SB_RPC_ANON_NO_LIMIT', n: 1, comprobado: true },
    { nombre: 'Ajustes de Auth', codigo: 'SB_AUTH', n: null, comprobado: false },
    { nombre: 'Tablas sin hinchar', codigo: 'SB_TABLE_BLOAT', n: null, comprobado: false },
  ],
} satisfies EstadoModulo;

// ── Cloudflare (zona officialvanguard.com, S08 §08.9) ─────────────────────────
const pct = (n: number) => Math.round((1000 * n) / PETICIONES_5M) / 10;
const cloudflare = {
  ok: true, hora: T_ESTADO, contador: { rojo: 1, aviso: 0, cola: 0 },
  cifras: [
    { tipo: 'peticiones_5m', etiqueta: 'Peticiones (5 min)', n: PETICIONES_5M, sub: 'muestreo 1:1' },
    { tipo: 'frenadas_pct', etiqueta: 'Frenadas por Cloudflare', n: 0, unidad: '%', decimales: 1, rol: 'neutra' },
    { tipo: 'tasa_4xx', etiqueta: 'Errores 4xx', n: pct(PETICIONES_4XX_5M), unidad: '%', decimales: 1, rol: 'neutra' },
    { tipo: 'tasa_5xx', etiqueta: 'Errores 5xx', n: 0, unidad: '%', decimales: 2, rol: 'bien' },
    { tipo: 'bloqueos_vanguard', etiqueta: 'IPs bloqueadas por VanGUARD', n: 0, rol: 'neutra' },
    { tipo: 'incidentes_abiertos', etiqueta: 'Incidentes abiertos', n: 1, rol: 'mal', destino: { modulo: 'incidents' } },
  ],
  ahora: [
    { grupo: 'incidentes', etiqueta: 'Ataques en curso', rol: 'mal', n: 1, orden: 4, filas: [
      { clave: INC_ATAQUE, modulo: 'cloudflare', tipo: 'incident', rol: 'mal', etiqueta: 'Escaneo y /admin abierto',
        objeto: IP_ATACANTE, chips: incidenteAtaque.rule_ids,
        sub: `${EVENTOS_ATAQUE} peticiones · /admin respondió 200 sin sesión`,
        acciones: [
          { verbo: 'Bloquear esta IP', clase: 'confirmar', principal: true, simula: true,
            args: { incident_id: INC_ATAQUE, kind: 'block_ip', target: IP_ATACANTE } },
          { verbo: 'Ver incidente', clase: 'navegar', destino: { modulo: 'incidents', filtro: INC_ATAQUE } },
        ] },
    ] },
    { grupo: 'top_ips', etiqueta: 'IPs con más peticiones', rol: 'neutra', n: 3, orden: 1, filas: [
      { clave: `ip:${IP_ATACANTE}`, modulo: 'cloudflare', tipo: 'top_ip', rol: 'neutra', etiqueta: 'Herramienta de ataque',
        objeto: IP_ATACANTE, chips: ['herramienta'], sub: `${EVENTOS_ATAQUE} peticiones en 5 min`,
        acciones: [
          { verbo: 'Copiar IP', clase: 'copiar', copiar: IP_ATACANTE },
          { verbo: 'Ver incidente', clase: 'navegar', destino: { modulo: 'incidents', filtro: INC_ATAQUE } },
        ] },
      { clave: 'ip:198.51.100.40', modulo: 'cloudflare', tipo: 'top_ip', rol: 'neutra', etiqueta: 'IP · navegador',
        objeto: '198.51.100.40', sub: '48 peticiones en 5 min', acciones: [{ verbo: 'Copiar IP', clase: 'copiar', copiar: '198.51.100.40' }] },
      { clave: 'ip:192.0.2.15', modulo: 'cloudflare', tipo: 'top_ip', rol: 'neutra', etiqueta: 'IP · móvil',
        objeto: '192.0.2.15', sub: '31 peticiones en 5 min', acciones: [{ verbo: 'Copiar IP', clase: 'copiar', copiar: '192.0.2.15' }] },
    ] },
    { grupo: 'top_uas', etiqueta: 'User agents más activos', rol: 'neutra', n: 2, orden: 1, filas: [
      { clave: 'ua:sqlmap', modulo: 'cloudflare', tipo: 'top_ua', rol: 'neutra', etiqueta: 'Herramienta de ataque',
        objeto: 'sqlmap/1.8', chips: ['herramienta'], sub: `${EVENTOS_ATAQUE} peticiones · 1 IP`,
        acciones: [{ verbo: 'Copiar user agent', clase: 'copiar', copiar: 'sqlmap/1.8' }] },
      { clave: 'ua:windows', modulo: 'cloudflare', tipo: 'top_ua', rol: 'neutra', etiqueta: 'Navegador de escritorio',
        objeto: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', sub: '48 peticiones · 1 IP',
        acciones: [{ verbo: 'Copiar user agent', clase: 'copiar', copiar: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }] },
    ] },
  ],
  checks: [
    { nombre: 'Zona activa', codigo: 'CF_ZONE_01', n: 0, comprobado: true },
    { nombre: 'SSL Full (strict)', codigo: 'CF_TLS_01', n: null, comprobado: false },
    { nombre: 'Reglas administradas del WAF', codigo: 'CF_WAF_01', n: null, comprobado: false },
    { nombre: 'Origen detrás del proxy', codigo: 'CF_DNS_01', n: null, comprobado: false },
  ],
} satisfies EstadoModulo;

// ── Codebase (repo vanguard-demo-victima, S09 §09.12 y §09.13) ────────────────
const codebase = {
  ok: true, hora: T_ESTADO, contador: { rojo: 5, aviso: 2, cola: 0 },
  cifras: [
    { tipo: 'cb_archivos', etiqueta: 'Archivos revisados', n: 38, de: 41 },
    { tipo: 'cb_deps', etiqueta: 'Dependencias', n: 214, sub: 'en 2 lockfiles' },
    { tipo: 'cb_vulnerables', etiqueta: 'Con vulnerabilidades', n: 3, rol: 'mal', destino: { modulo: 'codebase', ancla: 'ahora' } },
    { tipo: 'cb_secretos', etiqueta: 'Secretos en el código', n: 2, rol: 'mal', destino: { modulo: 'codebase', ancla: 'ahora' } },
    { tipo: 'cb_kev', etiqueta: 'Explotadas activamente', n: null, sub: 'llega en P1' },
  ],
  ahora: [
    { grupo: 'secretos', etiqueta: 'Secretos y archivos .env', rol: 'mal', n: 3, orden: 5, filas: [
      { clave: F_CB_SERVICE_ROLE, modulo: 'codebase', tipo: 'finding', rol: 'mal', etiqueta: 'Clave service_role en el código',
        objeto: 'src/lib/supabaseAdmin.ts:4', sub: 'también en .env:2 · rótala ya', acciones: [generarPrompt(F_CB_SERVICE_ROLE)] },
      { clave: F_CB_ENV, modulo: 'codebase', tipo: 'finding', rol: 'mal', etiqueta: '.env subido al repo', objeto: '.env',
        sub: '3 variables · el .gitignore no lo excluye', acciones: [generarPrompt(F_CB_ENV)] },
      { clave: F_CB_POSTGRES, modulo: 'codebase', tipo: 'finding', rol: 'mal', etiqueta: 'Contraseña de Postgres en .env',
        objeto: '.env:3', sub: 'host de Supabase · rótala', acciones: [generarPrompt(F_CB_POSTGRES)] },
    ] },
    { grupo: 'dependencias', etiqueta: 'Dependencias con vulnerabilidades', rol: 'mal', n: 3, orden: 5, filas: [
      { clave: F_CB_DEP_IGNITION, modulo: 'codebase', tipo: 'finding', rol: 'mal', etiqueta: 'facade/ignition 2.5.1 → 2.5.2',
        objeto: 'Packagist:facade/ignition@2.5.1', chips: ['CVE-2021-3129'], severidad_cve: 'critical', sub: '1 aviso crítico',
        acciones: [generarPrompt(F_CB_DEP_IGNITION)] },
      { clave: F_CB_DEP_LODASH, modulo: 'codebase', tipo: 'finding', rol: 'mal', etiqueta: 'lodash 4.17.15 → 4.18.0',
        objeto: 'npm:lodash@4.17.15', chips: ['CVE-2021-23337'], severidad_cve: 'high', sub: '6 avisos · 3 altos',
        acciones: [generarPrompt(F_CB_DEP_LODASH)] },
      { clave: F_CB_DEP_JQUERY, modulo: 'codebase', tipo: 'finding', rol: 'aviso', etiqueta: 'jquery 3.4.1 → 3.5.0',
        objeto: 'npm:jquery@3.4.1', chips: ['CVE-2020-11023', 'CVE-2020-11022'], severidad_cve: 'medium', sub: '2 avisos · XSS',
        acciones: [generarPrompt(F_CB_DEP_JQUERY)] },
    ] },
    { grupo: 'config', etiqueta: 'Configuración del repo', rol: 'aviso', n: 1, orden: 3, filas: [
      { clave: F_CB_GITIGNORE, modulo: 'codebase', tipo: 'finding', rol: 'aviso', etiqueta: '.gitignore no cubre .env',
        objeto: '.gitignore', sub: 'añade .env y .env.*', acciones: [generarPrompt(F_CB_GITIGNORE)] },
    ] },
  ],
  checks: [
    { nombre: '.env fuera del repo', codigo: 'CB_ENV_COMMITTED', n: 1, comprobado: true },
    { nombre: '.gitignore cubre .env', codigo: 'CB_GITIGNORE_NO_ENV', n: 1, comprobado: true },
    { nombre: 'Sin secretos en el código', codigo: 'CB_SECRET', n: 2, comprobado: true },
    { nombre: 'Dependencias sin CVE conocidos', codigo: 'CB_DEP_VULN', n: 3, comprobado: true },
    { nombre: 'Historial sin .env', codigo: 'CB_ENV_IN_HISTORY', n: null, comprobado: false },
    { nombre: 'Nada explotado activamente', codigo: 'CB_KEV', n: null, comprobado: false },
  ],
} satisfies EstadoModulo;

// ── Rendimiento (medición sembrada v2-regresion contra v1-sana, S10 §10.10 y §10.11) ──
// objeto = repo_file ?? resource_key (§10.10): locateInRepo('/img/hero-original.jpg') da public/img/hero-original.jpg
// con confianza `exacta` (§10.7); index.html, donde se arregla el atributo, solo aparece en el texto para la IA.
const copiaCausa = (arreglo: string, archivo: string) =>
  `En demo.officialvanguard.com/ (móvil) Lighthouse marca: ${arreglo} Archivo probable: ${archivo}. `
  + 'Haz el cambio mínimo, muéstrame el diff y luego vuelve a medir: LCP < 2500 ms, TBT < 200 ms y CLS < 0,1.';
const performance = {
  ok: true, hora: T_ESTADO, contador: { rojo: 0, aviso: 3, cola: 0 },
  cifras: [
    { tipo: 'perf_score_mobile', etiqueta: 'Puntaje móvil', n: 41, de: 100, rol: 'mal',
      sub: `v2-regresion · sáb ${horaCaracas(T_PERF_V2)} · mediana de 3 · Lighthouse 13.5` },
    { tipo: 'perf_score_desktop', etiqueta: 'Puntaje escritorio', n: 68, de: 100, rol: 'aviso',
      sub: `v2-regresion · sáb ${horaCaracas(T_PERF_V2)} · mediana de 3` },
    { tipo: 'lcp_mobile', etiqueta: 'LCP móvil', n: 6200, unidad: 'ms', rol: 'mal', sub: 'antes 1450 ms (v1-sana)' },
    { tipo: 'tbt_mobile', etiqueta: 'TBT móvil', n: 820, unidad: 'ms', rol: 'mal', sub: 'antes 40 ms (v1-sana)' },
    { tipo: 'cls_mobile', etiqueta: 'CLS móvil', n: 0.31, decimales: 2, rol: 'mal', sub: 'antes 0,00 (v1-sana)' },
    { tipo: 'ttfb_mobile', etiqueta: 'TTFB móvil', n: 130, unidad: 'ms', rol: 'bien' },
  ],
  ahora: [
    { grupo: 'causas', etiqueta: 'Qué la hace lenta', rol: 'mal', n: 6, orden: 4, filas: [
      { clave: 'imagen_pesada|/img/hero-original.jpg', modulo: 'performance', tipo: 'causa', rol: 'mal',
        etiqueta: 'Imagen pesada o en formato antiguo', objeto: 'public/img/hero-original.jpg',
        sub: 'ahorro ≈ 3,9 s de LCP · introducido en esta versión', chips: ['exacta'],
        acciones: [{ verbo: 'Copiar para mi IA', clase: 'copiar',
          copiar: copiaCausa('imagen principal de 3,4 MB en JPEG; usa WebP/AVIF con srcset y su tamaño real.', 'public/img/hero-original.jpg') }] },
      { clave: 'bloqueo_render|/css/tema-pesado.css', modulo: 'performance', tipo: 'causa', rol: 'mal',
        etiqueta: 'CSS/JS bloquea el primer pintado', objeto: 'public/css/tema-pesado.css',
        sub: 'ahorro ≈ 1,8 s de LCP · introducido en esta versión', chips: ['exacta'],
        acciones: [{ verbo: 'Copiar para mi IA', clase: 'copiar',
          copiar: copiaCausa('hoja de estilos de 150 KB que bloquea el render; pon el CSS crítico en línea y carga el resto diferido.', 'public/css/tema-pesado.css') }] },
      { clave: 'lcp_tardio|/img/hero-original.jpg', modulo: 'performance', tipo: 'causa', rol: 'mal',
        etiqueta: 'La imagen principal se descubre tarde', objeto: 'public/img/hero-original.jpg',
        sub: 'ahorro ≈ 1,2 s de LCP · loading=lazy en la imagen LCP', chips: ['exacta'],
        acciones: [{ verbo: 'Copiar para mi IA', clase: 'copiar',
          copiar: copiaCausa('la imagen LCP lleva loading="lazy" en public/index.html; quítalo y añade fetchpriority="high".',
            'public/img/hero-original.jpg') }] },
      { clave: 'js_legado|/js/polyfills-legacy.js', modulo: 'performance', tipo: 'causa', rol: 'aviso',
        etiqueta: 'Polyfills o JS duplicado innecesario', objeto: 'public/js/polyfills-legacy.js',
        sub: 'ahorro ≈ 0,7 s de LCP · introducido en esta versión', chips: ['exacta'],
        acciones: [{ verbo: 'Copiar para mi IA', clase: 'copiar',
          copiar: copiaCausa('script de polyfills de 120 KB bloqueante en <head>; quítalo o cárgalo con defer.', 'public/js/polyfills-legacy.js') }] },
      { clave: 'hilo_principal|/js/widget-pesado.js', modulo: 'performance', tipo: 'causa', rol: 'aviso',
        etiqueta: 'Un script bloquea el hilo principal', objeto: 'public/js/widget-pesado.js',
        sub: 'ahorro ≈ 610 ms de TBT · introducido en esta versión', chips: ['exacta'],
        acciones: [{ verbo: 'Copiar para mi IA', clase: 'copiar',
          copiar: copiaCausa('tarea larga de ~250 ms al cargar; pártela o difiérela tras la interacción.', 'public/js/widget-pesado.js') }] },
      { clave: 'layout_inestable|/img/hero-original.jpg', modulo: 'performance', tipo: 'causa', rol: 'aviso',
        etiqueta: 'Elementos que se mueven al cargar', objeto: 'public/img/hero-original.jpg',
        sub: 'CLS 0,31 · imagen sin width/height', chips: ['exacta'],
        acciones: [{ verbo: 'Copiar para mi IA', clase: 'copiar',
          copiar: copiaCausa('la imagen principal no declara width/height en public/index.html; añádelos o usa aspect-ratio.',
            'public/img/hero-original.jpg') }] },
    ] },
  ],
  checks: [
    { nombre: 'LCP móvil bajo 2,5 s', codigo: 'PF_LCP', n: 1, de: 1, comprobado: true },
    { nombre: 'TBT móvil bajo 200 ms', codigo: 'PF_TBT', n: 1, de: 1, comprobado: true },
    { nombre: 'CLS móvil bajo 0,1', codigo: 'PF_CLS', n: 1, de: 1, comprobado: true },
    { nombre: 'Medición de hace ≤ 7 días', codigo: 'PF_FRESH', n: 0, de: 1, comprobado: true },
  ],
} satisfies EstadoModulo;

export const moduleState = { supabase, cloudflare, codebase, performance } satisfies Record<Module, EstadoModulo>;
