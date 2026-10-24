import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { relative, sep } from 'node:path';

// Escribe dist/_headers con la CSP. El connect-src sale de VITE_SUPABASE_URL (Auth + Realtime).
function cabecerasSeguridad(supabaseUrl: string): Plugin {
  return {
    name: 'vg-headers', apply: 'build',
    generateBundle() {
      const sb = new URL(supabaseUrl).host;
      const csp = [
        "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", // react-remove-scroll-bar (Dialog, Sheet y menús modales de Radix) inyecta un <style>
        "img-src 'self' data: blob:", "font-src 'self'",
        // Solo Auth y Realtime: el navegador no habla con /rest/v1, /graphql/v1, /storage/v1 ni /functions/v1 (decisión (a)).
        // Una ruta que termina en «/» casa por prefijo (CSP3).
        `connect-src 'self' https://${sb}/auth/v1/ wss://${sb}/realtime/v1/`,
        "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
      ].join('; ');
      // Cache-Control solo en bloques que no se solapan: si dos reglas ponen la misma cabecera, Cloudflare las une con coma.
      const source = [
        '/*', `  Content-Security-Policy: ${csp}`, '  X-Content-Type-Options: nosniff',
        '  Referrer-Policy: strict-origin-when-cross-origin', '  X-Frame-Options: DENY',
        '  Cross-Origin-Opener-Policy: same-origin',                                      // pedido por S06 §06.11
        '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()',
        '/', '  Cache-Control: no-cache', '/index.html', '  Cache-Control: no-cache',          // cada deploy se ve al momento (S06)
        '/assets/*', '  Cache-Control: public, max-age=31536000, immutable', '',
      ].join('\n');
      this.emitFile({ type: 'asset', fileName: '_headers', source });
    },
  };
}

// zod prueba Function() al crear el PRIMER z.object de cualquier módulo (contracts o no), así que zod-sin-jit tiene que
// correr antes. Rolldown no garantiza el orden entre chunks (strictExecutionOrder va apagado): un chunk que la entrada
// importa estático se ejecuta ANTES que el cuerpo de la entrada. Por eso el build falla si un módulo que importa zod
// (salvo zod-sin-jit y el propio zod) va en esos chunks o antes que zod-sin-jit en la entrada: tiene que ir con import().
function zodSinJitPrimero(): Plugin {
  const deZod = (id: string) => /[\\/]node_modules[\\/]zod[\\/]/.test(id);
  const sinJit = (id: string) => /[\\/]zod-sin-jit\.ts$/.test(id);
  return {
    name: 'vg-zod-sin-jit', apply: 'build',
    generateBundle(_, bundle) {
      const usaZod = (id: string) => !deZod(id) && !sinJit(id) && !!this.getModuleInfo(id)?.importedIds.some(deZod);
      const chunks = Object.values(bundle).flatMap((c) => (c.type === 'chunk' ? [c] : []));
      const entrada = chunks.find((c) => c.isEntry);
      if (!entrada) return;
      const antes = new Set<string>();                                   // chunks que corren antes que la entrada
      for (const pend = [...entrada.imports]; pend.length;) {
        const f = pend.pop()!;
        if (!antes.has(f)) { antes.add(f); pend.push(...(chunks.find((c) => c.fileName === f)?.imports ?? [])); }
      }
      const i = entrada.moduleIds.findIndex(sinJit);
      const tarde = [
        ...entrada.moduleIds.slice(0, i < 0 ? undefined : i),
        ...chunks.filter((c) => antes.has(c.fileName)).flatMap((c) => c.moduleIds),
      ].filter(usaZod).map((m) => relative(process.cwd(), m).split(sep).join('/'));
      if (i < 0 || tarde.length)
        this.error(`zod-sin-jit no corre antes que ${tarde.join(', ') || 'la entrada'}: zod probaría Function() contra la CSP `
          + 'al crear su primer z.object. Carga esos módulos con import() o deja zod-sin-jit como primer import de main.tsx');
    },
  };
}

// El pie de la portada estática de index.html (§14.22) lleva la misma versión que el de Inicio.tsx: así React la
// sustituye sin cambiar nada y quien no ejecuta JS ve qué commit está publicado.
const REPO_JUECES = 'https://github.com/platanus-hack/platanus-hack-26-ve-team-22';   // = lib/env.ts
function versionEnPortada(commit: string): Plugin {
  const html = !/^[0-9a-f]{7}$/.test(commit) ? '<span class="font-mono">local</span>'   // solo hex: va dentro del HTML
    : `<a class="font-mono underline underline-offset-2" href="${REPO_JUECES}/commit/${commit}" target="_blank" rel="noopener noreferrer">${commit}</a>`;
  return { name: 'vg-version-portada', transformIndexHtml: (h) => h.replace('<!--vg-version-->', html) };
}

export default defineConfig(({ mode }) => {
  // Vite NO carga los .env en process.env mientras evalúa la config: todo sale de loadEnv (S03 §03.7).
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const fixtures = mode === 'fixtures' || env.VITE_USE_FIXTURES === '1';
  // Sin la clave el build termina bien pero la app sale en blanco: lib/supabase.ts lanza al cargar.
  if (mode === 'production' && !fixtures && (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_PUBLISHABLE_KEY))
    throw new Error('Faltan VITE_SUPABASE_URL o VITE_SUPABASE_PUBLISHABLE_KEY');
  const api = env.VITE_API_PROXY || 'http://localhost:8787';           // o https://officialvanguard.com (BACK desplegado; sin previews por PR)
  // Workers Builds inyecta WORKERS_CI_COMMIT_SHA en el build (A2); no es VITE_* ni secreto: solo identifica la versión publicada.
  const commit = (process.env.WORKERS_CI_COMMIT_SHA ?? 'local').slice(0, 7);
  return {
    define: { __VG_COMMIT__: JSON.stringify(commit) },                 // declarado en src/vite-env.d.ts; lo pinta el pie de la portada (§14.22)
    plugins: [react(), tailwindcss(), cabecerasSeguridad(env.VITE_SUPABASE_URL || 'https://invalid.supabase.co'), zodSinJitPrimero(), versionEnPortada(commit)],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: { port: 5173, proxy: Object.fromEntries(['/api', '/ingest', '/mcp'].map((p) => [p, { target: api, changeOrigin: true }])) },
    // Los fixtures no entran en el bundle (F-03) gracias a "sideEffects": false de packages/contracts/package.json.
    build: { outDir: 'dist', sourcemap: true },
  };
});
