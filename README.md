# VanGUARD

<img src="./project-logo.png" alt="Logo de VanGUARD" width="160" />

Panel de seguridad para startups que viven en la nube. Conectas tu repo de GitHub, tu Supabase y tu Cloudflare con
permisos de **solo lectura**, y VanGUARD encuentra lo que está expuesto, te avisa por WhatsApp y te da el arreglo listo
para pegarlo en tu IA.

**Pruébalo:** https://officialvanguard.com → **«Ver demo»** (sin cuenta, solo lectura).

Track **AI Security** · Platanus Hack 26 Caracas · team-22

- Carlos Bastidas ([@cbastidas707](https://github.com/cbastidas707))
- Giovanni Zarbo De Michele ([@giova144-git](https://github.com/giova144-git))
- Daniel Alejandro Barreda López ([@danbarreda](https://github.com/danbarreda))
- Andrés Valero ([@andres89018-hash](https://github.com/andres89018-hash))
- Gabriel Enrique García Ruíz ([@gabgaru1](https://github.com/gabgaru1))

## Qué hace hoy (en producción)

- **Auditoría con un botón** y un puntaje de 0 a 100 que dice cuántas de las fuentes pudo mirar. Nunca pinta verde sin
  haber mirado.
  - **Supabase:** tablas con RLS desactivada que se leen con la clave pública, políticas que dejan pasar a cualquiera,
    funciones expuestas sin freno y los avisos de seguridad y rendimiento de Supabase.
  - **Codebase:** claves y tokens filtrados, archivos `.env` subidos, `.gitignore` que no los excluye y dependencias con
    vulnerabilidades conocidas (OSV).
  - **Cloudflare:** estado de la zona y, si tu app nos manda su tráfico firmado, escaneos de rutas, herramientas de
    ataque e inundaciones desde una IP, en vivo.
- **Revisión de código en cada push, merge y pull request a `main`** (webhook de GitHub). Si aparece una clave o un
  `.env`, te avisa por WhatsApp según la severidad mínima que elijas en Ajustes. El aviso trae botones con acción real:
  **«Enviarme el arreglo»** y **«Silenciar repo 1 h»**.
- **Bloqueo de merge:** un pull request con un hallazgo crítico queda con el estado en rojo y, en repos privados del plan
  gratuito de GitHub (que no deja exigir el check), VanGUARD lo cierra y comenta el motivo.
- **Evolución entre revisiones:** cada auditoría y cada push dejan una foto; VanGUARD compara cada una con la anterior y
  dice qué empeoró y qué se corrigió.
- **Rendimiento:** «Medir ahora» lanza una medición real con PageSpeed Insights (Lighthouse) en móvil o escritorio, y el
  histórico marca la métrica que empeoró.
- **Varias codebases por organización**, cada repo con su **wiki** generada por IA y los hallazgos cruzados.
- **Prompt de corrección** por hallazgo, escrito por Claude, y **exportación** a cualquier IA (`.md` o `.json`, con los
  secretos tapados), o consulta desde tu IA con nuestro **servidor MCP** (`/mcp`, con token propio).
- **Análisis de un ZIP en el navegador:** el código no sale de tu equipo.
- **Modo blindaje:** bloquear una IP atacante en Cloudflare con un token aparte y confirmación por código; se deshace sola
  en una hora. El **modo bajo ataque** propone un desafío temporal para un host, con vista previa, confirmación, TTL y
  Deshacer.

**Próximamente:** llamada de voz, salud de la base (CPU, memoria y disco), «Verificar arreglo» y avisos de WhatsApp fuera
de la ventana de 24 h (plantilla de Meta en revisión).

## Seguro por diseño

- **La IA no decide:** detectar, puntuar y alertar lo hacen reglas deterministas. Un texto malicioso en un log o en el
  código no apaga una alerta.
- **Credenciales cifradas** con AES-256-GCM; la clave maestra se arma con una mitad en Supabase Vault y otra en el
  Worker. Robar la base no basta.
- **Solo lectura** en las integraciones. Las escrituras (bloquear una IP, modo bajo ataque, estado y cierre del PR) usan
  un segundo token opcional y se confirman aparte.
- **Nada sensible sale:** los secretos se redactan antes de llegar a logs, a la IA o a WhatsApp; CSP estricta sin
  scripts de terceros.

Detalle y pruebas: [SECURITY.md](SECURITY.md) · [THREAT_MODEL.md](THREAT_MODEL.md) · [ARQUITECTURA.md](ARQUITECTURA.md).

## Stack

Cloudflare Workers (plan gratuito) con Hono, que sirve la API y la SPA (React 19 + Vite) · Supabase (Postgres, Auth,
Vault y Realtime) · Claude API · Kapso (WhatsApp) · OSV · PageSpeed Insights · contratos compartidos con zod ·
monorepo pnpm.

| Carpeta | Qué hay |
|---|---|
| `apps/web` | La SPA |
| `apps/api` | El Worker: API, webhooks, cola de auditoría y crons |
| `apps/victima` | La tienda vulnerable de la demo, que envía su tráfico firmado |
| `packages/core` | Reglas, escáneres, cifrado y redacción (código puro, con pruebas) |
| `packages/contracts` | Esquemas zod que comparten la API y la web |
| `packages/deepwiki` | El motor de la wiki del repositorio |
| `supabase/migrations` | Esquema, RLS y funciones de la base |
| `demo/` | Guion de la demo y scripts para sembrar el repo víctima y hacer el push de la revisión |

## Correr en local

```bash
pnpm install
pnpm --filter @vanguard/web dev:fixtures   # la web sin backend, con datos de ejemplo
pnpm test                                  # todas las pruebas del monorepo
```

Con backend: copia `.env.example` a `.env` y `apps/api/.dev.vars.example` a `apps/api/.dev.vars`, llénalos, y corre
`pnpm dev:api` y `pnpm dev:web`.
