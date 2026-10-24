import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// Escribe dist/_headers con la CSP. El connect-src sale de VITE_SUPABASE_URL (Auth + Realtime).
function cabecerasSeguridad(supabaseUrl: string): Plugin {
  return {
    name: 'vg-headers', apply: 'build',
    generateBundle() {
      const sb = new URL(supabaseUrl).host;
      const csp = [
        "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", // Recharts y shadcn Chart usan estilos en línea
        "img-src 'self' data: blob:", "font-src 'self'",
        // Solo Auth y Realtime: el navegador no habla con /rest/v1, /graphql/v1, /storage/v1 ni /functions/v1 (decisión (a)).
        // Una ruta que termina en «/» casa por prefijo (CSP3).
        `connect-src 'self' https://${sb}/auth/v1/ wss://${sb}/realtime/v1/`,
        "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
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

export default defineConfig(({ mode }) => {
  // Vite NO carga los .env en process.env mientras evalúa la config: todo sale de loadEnv (S03 §03.7).
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const fixtures = mode === 'fixtures' || env.VITE_USE_FIXTURES === '1';
  if (mode === 'production' && !fixtures && !env.VITE_SUPABASE_URL) throw new Error('Falta VITE_SUPABASE_URL');
  const api = env.VITE_API_PROXY || 'http://localhost:8787';           // o https://officialvanguard.com (BACK desplegado; sin previews por PR)
  // Workers Builds inyecta WORKERS_CI_COMMIT_SHA en el build (A2); no es VITE_* ni secreto: solo identifica la versión publicada.
  const commit = (process.env.WORKERS_CI_COMMIT_SHA ?? 'local').slice(0, 7);
  return {
    define: { __VG_COMMIT__: JSON.stringify(commit) },                 // declarado en src/vite-env.d.ts; lo pinta el pie de la portada (§14.22)
    plugins: [react(), tailwindcss(), cabecerasSeguridad(env.VITE_SUPABASE_URL || 'https://invalid.supabase.co')],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: { port: 5173, proxy: Object.fromEntries(['/api', '/ingest', '/mcp'].map((p) => [p, { target: api, changeOrigin: true }])) },
    // Los fixtures no entran en el bundle (F-03) gracias a "sideEffects": false de packages/contracts/package.json.
    build: { outDir: 'dist', sourcemap: true },
  };
});
