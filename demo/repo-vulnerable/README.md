# tienda-demo-pedidos (repo víctima de la demo de VanGUARD)

Repositorio **deliberadamente vulnerable** y **simulado**. Existe solo para que VanGUARD
tenga algo real que auditar en vivo durante el hackatón. No es un proyecto real, no se
despliega a producción y **no contiene ningún secreto real**: las claves que aparecen tras
la siembra son **falsas**, generadas al azar por `demo/sembrar-repo.mjs` en el monorepo de
VanGUARD y empujadas solo al repo **privado** `vanguard-demo-victima`.

## Cómo se arma

Esta carpeta es la **plantilla**: no guarda ningún valor con forma de secreto (ver
`PLAN_MAESTRO.md` §09.13 y §01.6, «Secretos falsos de la víctima»). El script
`demo/sembrar-repo.mjs` la copia a un clon del repo privado, inyecta los valores falsos
por concatenación en tiempo de ejecución, hace los commits en orden y empuja.

## Fallas que la auditoría de Codebase debe encontrar (§09.13)

| Hallazgo | Dónde | Severidad |
|---|---|---|
| `CB_GITIGNORE_NO_ENV` | `.gitignore` no saca `.env` | medium |
| `CB_ENV_COMMITTED` | `.env` commiteado | critical |
| `CB_SECRET_SUPABASE_SERVICE_ROLE` | `.env:2` y `src/lib/supabaseAdmin.ts:4` (mismo JWT falso) | critical |
| `CB_SECRET_POSTGRES_URL` | `.env:3` (host `…supabase.co`) | critical |
| `CB_DEP_VULN` | `jquery@3.4.1` (→ 3.5.0), `lodash@4.17.15` (→ 4.18.0) en `package-lock.json` | medium / high |
| `CB_DEP_VULN` | `facade/ignition@2.5.1` (→ 2.5.2, KEV) en `panel-legacy/composer.lock` | critical |
| `CB_ENV_IN_HISTORY` (P1) | `.env.production` estuvo en el historial (commit 2) y se borró (commit 3) | critical |
| `CB_KEY_REUSE` (P1) | `wrangler.jsonc` reusa el secreto de la conexión de ingesta señuelo | — |
| `CB_SQL_NO_RLS` (P2) | `supabase/migrations/0001_pedidos.sql` crea `pedidos` sin RLS | — |

## Nota sobre el `package-lock.json`

Está escrito a mano con las versiones exactas que necesita la demo (sin correr `npm`). Antes
de la siembra, Gabriel repasa con OSV (`POST https://api.osv.dev/v1/querybatch`) las versiones
de `hono`, `vite` y `@supabase/supabase-js` para que no salgan hallazgos sorpresa (§09.13); si
hace falta, las sube aquí. Si se quiere un árbol completo: `npm install --package-lock-only`.

## Recursos (`public/`)

`public/` lo llena RND-05 copiando **idénticos** los assets de `apps/victima/public/` para que
`locateInRepo` dé `exacta` en el módulo de rendimiento (§10.11). Aquí va solo el marcador.
