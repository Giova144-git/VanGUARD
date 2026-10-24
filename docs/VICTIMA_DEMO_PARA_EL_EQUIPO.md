# Víctima de la demo: proyecto Supabase y repo privado

**Para:** Gabriel (o quien del equipo se encargue). **De:** Giovanni y el chat ORQUESTADOR.
**Cuándo:** el **repo**, antes de las **14:00** del sábado; el **proyecto Supabase**, antes de las **16:00** (mejor ya).
**Tiempo:** unos 40 minutos en total.

## Qué es esto y por qué va en TU cuenta

VanGUARD audita el Supabase, el Cloudflare y el repo de GitHub de un cliente. Para la demo necesitamos un «cliente» **falso** con fallas sembradas a propósito: una base con tablas abiertas y un repo con un `.env` subido y dependencias vulnerables.

- Va en **tu propia cuenta** de Supabase y de GitHub, **no** en la del producto (`accshmgmfrqrxubpuxcl`). La víctima está rota a propósito y nuestra base es la de producción.
- **Todo es falso:** datos de prueba y claves inventadas al azar. No pongas nada real.

## Reglas (importantes)

1. **Ningún token en un chat, un correo, un commit ni un documento.** Los dos tokens que vas a crear se los pasas a Giovanni **compartiéndolos desde un gestor de contraseñas** (Bitwarden, 1Password o similar).
2. El **Project ref** (20 letras) **no es secreto**: puedes mandarlo por mensaje.
3. No invites a nadie del equipo como Owner o Admin a tu organización de Supabase.
4. Si algo no sale como dice aquí, para y avisa: no improvises con tokens.

## Antes de empezar

- Cuenta de **Supabase** propia, con un hueco libre: el plan Free permite **2 proyectos activos**, contando todas tus organizaciones donde seas Owner o Admin. Los pausados no cuentan.
- Cuenta de **GitHub** propia.
- En tu PC: **git** y **Node 24.12 o más** (`node -v` para comprobarlo).
- Si usas Norton u otro antivirus que intercepta HTTPS y `git push` falla por certificado, avisa.

---

## Parte A · Proyecto Supabase `vanguard-demo` (antes de las 16:00)

### A1. Crear el proyecto (5 min)
1. Supabase → **New project**, en una organización tuya en plan **Free**.
2. **Nombre:** `vanguard-demo` (exacto). **Región:** una de América (East US o São Paulo).
3. **Database password:** genera una fuerte y guárdala en tu gestor de contraseñas. No la vamos a necesitar, pero no la pierdas.
4. Espera a que el proyecto termine de crearse (1–2 min).

### A2. Copiar el Project ref
Es la parte de la URL del panel después de `/project/`: 20 letras minúsculas, por ejemplo `abcdefghijklmnopqrst`. **Mándaselo a Giovanni por mensaje:** lo necesitas también para la Parte B.

### A3. Sembrar las fallas (3 min)
1. En el proyecto, abre **SQL Editor** → **New query**.
2. **Antes de ejecutar, mira la URL del navegador:** tiene que tener el ref de `vanguard-demo`, **nunca** `accshmgmfrqrxubpuxcl`. El SQL trae una guarda que aborta si se pega en la base del producto, pero mira igual.
3. Pega este SQL completo y pulsa **Run**. Tarda unos segundos porque inserta 200.000 filas. Es el mismo archivo que `demo/seed-victima.sql` del repo.

```sql
-- demo/seed-victima.sql · SOLO para vanguard-demo · fallas SIMULADAS · datos FALSOS
-- 0) Guarda: aborta si esto es la base de VanGUARD (ahí viven nuestras RPC vg_*)
do $$ begin
  if exists (select 1 from pg_catalog.pg_proc where proname like 'vg\_%') then
    raise exception 'Esta es la base de VanGUARD (accshmgmfrqrxubpuxcl), no vanguard-demo: no se siembra';
  end if;
end $$;
-- 1) SB_RLS_DISABLED (critical): tabla legible por anon sin RLS
create table public.pedidos (
  id bigint generated always as identity primary key,
  cliente text not null, producto text not null, monto numeric(10,2) not null,
  created_at timestamptz not null default now());
comment on table public.pedidos is 'VanGUARD demo: falla SIMULADA (RLS desactivada)';
alter table public.pedidos disable row level security;          -- por si el proyecto activa RLS por defecto
grant select on public.pedidos to anon;
insert into public.pedidos (cliente, producto, monto)
select 'Cliente Falso ' || g, 'Producto ' || (g % 7), (g % 90) + 10 from generate_series(1, 500) g;

-- 2) SB_POLICY_ALLOW_ALL (high): política pase-todo para anon
create table public.perfiles (
  id uuid primary key default gen_random_uuid(), user_id uuid, alias text, created_at timestamptz default now());
comment on table public.perfiles is 'VanGUARD demo: falla SIMULADA (politica using true)';
alter table public.perfiles enable row level security;
create policy "pase_todo" on public.perfiles for select to anon, authenticated using (true);
grant select on public.perfiles to anon, authenticated;
insert into public.perfiles (alias) select 'alias_falso_' || g from generate_series(1, 50) g;

-- 3) SB_RPC_ANON_NO_LIMIT (critical por nombre "otp"): función pública sin freno; NO envía nada
create table public.codigos_solicitados (
  id bigint generated always as identity primary key, destino text, created_at timestamptz default now());
alter table public.codigos_solicitados enable row level security;  -- sin políticas: nadie la lee por la API
create or replace function public.enviar_otp(p_destino text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  insert into public.codigos_solicitados (destino) values (left(p_destino, 100));  -- simulada: no manda correo ni SMS
end $$;
comment on function public.enviar_otp(text) is 'VanGUARD demo: falla SIMULADA (RPC sin freno)';
grant execute on function public.enviar_otp(text) to anon;

-- 4) P1 · SB_TABLE_BLOAT (high): ~30 MB con 60 % de filas muertas
create table public.eventos (
  id bigint generated always as identity primary key, tipo text, payload text, created_at timestamptz default now())
  with (autovacuum_enabled = false);
comment on table public.eventos is 'VanGUARD demo: falla SIMULADA (tabla hinchada)';
alter table public.eventos enable row level security;
insert into public.eventos (tipo, payload) select 'evento_falso', repeat('x', 100) from generate_series(1, 200000);
delete from public.eventos where id % 10 < 6;
```

### A4. Comprobar que quedó bien (2 min)
En una consulta nueva del SQL Editor, pega esto y pulsa Run:

```sql
select 'pedidos sin RLS y legible por anon' as falla,
       (select not relrowsecurity from pg_class where oid = 'public.pedidos'::regclass)
       and has_table_privilege('anon', 'public.pedidos', 'select') as ok
union all
select 'politica pase_todo en perfiles',
       exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'perfiles' and policyname = 'pase_todo')
union all
select 'enviar_otp ejecutable por anon',
       has_function_privilege('anon', 'public.enviar_otp(text)', 'execute')
union all
select 'eventos con ~120.000 filas muertas (puede tardar 1 min en verse)',
       coalesce((select n_dead_tup > 50000 from pg_stat_user_tables where relname = 'eventos'), false);
```

Las tres primeras filas tienen que dar `ok = true`. La cuarta puede dar `false` el primer minuto; vuelve a correrla después.

### A5. Ajustes de Auth: fallas sembradas a propósito (1 min)
En `vanguard-demo` → **Authentication**:
- **Passwords** (o «Sign In / Providers → Email»): **longitud mínima de contraseña 6**.
- **Attack Protection** → **CAPTCHA**: **apagado** (suele venir así).

### A6. Token de SOLO LECTURA de este proyecto (5 min)
Supabase permite un token limitado a un solo proyecto y de solo lectura: el **scoped PAT**, que empieza por **`sbp_fc`**.
1. Abre `https://supabase.com/dashboard/account/tokens` → **Generate new token**.
2. **Resources:** «selected projects in one organization» → marca **solo `vanguard-demo`**.
3. **Permissions**, estos cinco en **Read**, y nada más (los nombres pueden variar un poco):
   - **Project Settings**
   - **Advisors**
   - **Database**
   - **Logs**
   - **Auth Config**
4. **Expiry:** fecha personalizada **2026-11-23**. No elijas «never».
5. Copia el valor `sbp_fc…`. **Solo se ve una vez.** Guárdalo en tu gestor de contraseñas.

**Prohibido:**
- un token **Legacy** o de cuenta completa, que empieza por `sbp_` pero no por `sbp_fc`;
- marcar **API Key Secrets**, **Data API**, **Edge Function Secrets**, **Database JIT** o cualquier permiso **Read-write**.

VanGUARD rechaza esos tokens al conectarlos. El acceso de un token no se puede editar después: si te equivocas, bórralo y crea otro.

### A7. Entrega de la Parte A
- **A Giovanni, por mensaje:** el **Project ref**.
- **A Giovanni, compartido desde el gestor de contraseñas:** el token **`sbp_fc…`**.

---

## Parte B · Repo privado `vanguard-demo-victima` (antes de las 14:00)

El contenido lo arma un script del monorepo. La plantilla no tiene ningún secreto: el script inventa las claves falsas al azar al copiarla, hace 4 commits en orden y los empuja a TU repo. **Necesitas el Project ref de A2**, porque las claves falsas lo usan.

### B1. Crear el repo vacío (1 min)
GitHub → **New repository**:
- **Owner:** tu usuario. **Nombre:** `vanguard-demo-victima` (exacto).
- **Private** (obligatorio: lleva claves falsas con forma real, y GitHub o Supabase revocan o marcan las que ven en repos públicos).
- **No** marques README, .gitignore ni licencia: tiene que quedar **vacío**.

### B2. Clonar los dos repos (2 min)
En una terminal, en una carpeta de trabajo:

```bash
git clone https://github.com/platanus-hack/platanus-hack-26-ve-team-22.git
git clone https://github.com/TU_USUARIO/vanguard-demo-victima.git
```

Cambia `TU_USUARIO` por tu usuario de GitHub. GitHub avisa que el repo está vacío: es lo esperado.

### B3. Sembrar y empujar (2 min)
Desde la carpeta del monorepo:

```bash
cd platanus-hack-26-ve-team-22
node demo/sembrar-repo.mjs ../vanguard-demo-victima --ref TU_PROJECT_REF
```

- No hace falta `pnpm install`: el script solo usa Node y git.
- Cambia `TU_PROJECT_REF` por el ref de A2: 20 letras minúsculas.
- El script **se niega** si el repo de destino no es `vanguard-demo-victima`, para no sembrar nunca otro repo por error.
- No imprime ningún valor: solo dice qué fallas quedaron sembradas y si empujó.
- Empuja con **tus** credenciales de git. Si te pide usuario y contraseña, usa tu usuario y un token de GitHub, o inicia sesión con GitHub CLI (`gh auth login`).
- Si GitHub bloquea el push porque «detectó un secreto», avisa antes de forzar nada: no debería pasar en un repo privado.

### B4. Comprobar en GitHub (1 min)
En `github.com/TU_USUARIO/vanguard-demo-victima` tienen que verse **4 commits** y, entre otros:
- `.env`
- `src/lib/supabaseAdmin.ts`
- `package.json` y `package-lock.json` (con `lodash` 4.17.15 y `jquery` 3.4.1)
- `panel-legacy/composer.lock` (con `facade/ignition` 2.5.1)
- `supabase/migrations/0001_pedidos.sql`

### B5. Token de SOLO LECTURA de ese repo (3 min)
GitHub → foto de perfil → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**:
1. **Token name:** `vanguard-demo`. **Expiration:** 30 días.
2. **Resource owner:** tu usuario.
3. **Repository access:** **Only select repositories** → `vanguard-demo-victima`.
4. **Permissions → Repository permissions:**
   - **Contents:** **Read-only**
   - **Metadata:** **Read-only** (se marca solo)
   - Nada más.
5. **Generate token** → copia el valor `github_pat_…`. **Solo se ve una vez.** Guárdalo en tu gestor de contraseñas.

**Prohibido:** un token clásico (`ghp_…`) o uno con permisos de escritura. VanGUARD los rechaza.

### B6. Entrega de la Parte B
- **A Giovanni, compartido desde el gestor de contraseñas:** el token **`github_pat_…`**.
- **A Giovanni, por mensaje:** «listo, repo víctima» con el nombre `TU_USUARIO/vanguard-demo-victima`.

---

## Qué hace Giovanni con todo esto

En `officialvanguard.com`, org **Tienda Demo** → **Conexiones**:
- **Supabase:** el Project ref y el token `sbp_fc…`.
- **GitHub:** `TU_USUARIO/vanguard-demo-victima` y el token `github_pat_…`.

Después lanza «Auditar todo». Lo esperado:
- **Supabase:** 2 críticos (`pedidos` sin RLS y `enviar_otp` sin freno) y 1 alto (la política `pase_todo`), más los avisos del propio Supabase.
- **Codebase:** el `.env` subido, la clave con forma de `service_role`, la URL de Postgres y las tres dependencias vulnerables.

## Lista final

- [ ] A1–A5: `vanguard-demo` creado y sembrado, con la comprobación de A4 en `ok = true`.
- [ ] A6: token `sbp_fc…` con 5 permisos Read, caducidad 2026-11-23.
- [ ] A7: ref por mensaje y token por gestor de contraseñas a Giovanni.
- [ ] B1–B4: repo privado `vanguard-demo-victima` con sus 4 commits.
- [ ] B5: token `github_pat_…` de solo lectura de ese repo.
- [ ] B6: token por gestor de contraseñas y «listo, repo víctima» a Giovanni.
