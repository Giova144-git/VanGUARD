-- 0026_sandbox_demo.sql · «Ver demo» por visitante y volátil (sandbox). Hasta ahora E4 unía al usuario como viewer a la
-- ÚNICA org is_demo: todos veían lo mismo, nadie podía tocar nada y una cuenta real que pulsaba «Ver demo» quedaba unida
-- para siempre. Ahora cada usuario (anónimo o con cuenta) recibe SU copia de la demo, como owner, y la copia vive
-- mientras la web late (E4b POST /api/demo/latido); si deja de latir 10 min, la purga por minuto la borra en cascada, y
-- con ella al usuario anónimo que se quede sin orgs. E4c POST /api/demo/salir la borra ya (vg_sandbox_salir).
--
-- Qué se copia (private.vg_clone_demo): conexiones de LECTURA (marcadas meta.demostracion = true, sin secretos: no
-- auditables; las acciones nunca), auditorías y sus fotos (audit_snapshots, con los ids remapeados), hallazgos,
-- incidentes con sus avisos (sin provider_id) y acciones (en seco: provider_ref simulado), métricas recientes,
-- rendimiento, wiki, revisiones de código (con su config apagada), peticiones «Enviar a mi IA» y preferencias de aviso.
-- Qué NO se copia: connection_secrets (el AAD lleva el orgId: no se abrirían), contacts (teléfonos del equipo),
-- approvals (hashes de códigos), mcp_tokens, ai_usage, edge_eval_state y edge_hits (IP reales). Los ids nuevos salen de
-- private.vg_uuid_de(org nueva, id viejo): deterministas, con forma de uuid v4 (el contrato valida z.uuid()), y con ellos
-- cada FK se remapea sin tablas de paso. La copia es genérica por columnas (private.vg_copiar): una columna que añada
-- otra migración (p. ej. el historial de 0025 en findings) viaja sola.
--
-- Cierre: E4d POST /api/demo/cerrando (pagehide) pone cierra_en = now() + 20 s; un latido posterior lo anula.
--
-- Topes: una sandbox viva por usuario (candado por usuario), 10 creadas por IP y hora (libro private.sandbox_altas, que
-- sobrevive al borrado de la sandbox: salir y volver a entrar sigue contando) y 200 vivas en total. IA: la sandbox no es
-- is_demo, así que vg_ai_reserve le aplica least(ai_daily_cap_usd = 0,20, org_usd_day).
--
-- RLS: private.demo_org_ids() (0008e) pasa a ser «las orgs que una sesión anónima puede ver»: la demo y las sandboxes.
-- Todas las políticas *_sel lo cruzan con private.user_org_ids(), así que el anónimo ve SU sandbox y ninguna otra.
-- Además: un trigger impide conexiones kind 'action' en una sandbox (ni token de acciones de Cloudflare ni de GitHub),
-- notifications admite status 'skipped' con el texto que habría salido (preview), y se limpian las membresías viewer de
-- usuarios NO anónimos en la demo (el bug de E4). Prueba: supabase/tests/sandbox.sql.

-- 1) Columnas de orgs ─────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.orgs add column if not exists sandbox_of uuid references public.orgs(id) on delete cascade;
alter table public.orgs add column if not exists last_seen_at timestamptz;
alter table public.orgs add column if not exists creator_ip_hash text;
-- Cierre en dos pasos: E4d (pagehide) la marca para borrarse en 20 s; un latido posterior (la recarga) lo anula.
alter table public.orgs add column if not exists cierra_en timestamptz;
alter table public.orgs drop constraint if exists orgs_sandbox_coherente;
alter table public.orgs add constraint orgs_sandbox_coherente
  check (sandbox_of is null or (not is_demo and last_seen_at is not null));
alter table public.orgs drop constraint if exists orgs_creator_ip_hash_chk;
alter table public.orgs add constraint orgs_creator_ip_hash_chk check (creator_ip_hash ~ '^[0-9a-f]{64}$');
create index if not exists orgs_sandbox_seen_idx on public.orgs (last_seen_at) where sandbox_of is not null;   -- la purga
create index if not exists orgs_sandbox_cierra_idx on public.orgs (cierra_en) where sandbox_of is not null and cierra_en is not null;
create index if not exists orgs_sandbox_ip_idx on public.orgs (creator_ip_hash, created_at) where sandbox_of is not null;
comment on column public.orgs.sandbox_of is 'Sandbox de «Ver demo»: la org de demo de la que es copia (null = org normal)';
comment on column public.orgs.last_seen_at is 'Último latido de la sandbox; sin latido 10 min, vg_purgar_sandboxes la borra';
comment on column public.orgs.creator_ip_hash is 'HMAC de la IP que creó la sandbox (nunca la IP)';
comment on column public.orgs.cierra_en is 'La web se cerró (pagehide, E4d): la purga la borra tras esta hora si no llega otro latido';

-- Libro de altas por IP: el tope por hora no puede vivir en orgs, que se borra al salir. Solo lo tocan las funciones.
create table if not exists private.sandbox_altas (
  id bigint generated always as identity primary key,
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now());
create index if not exists sandbox_altas_ip_idx on private.sandbox_altas (ip_hash, created_at);
revoke all on private.sandbox_altas from public, anon, authenticated;

-- 2) notifications: 'skipped' (no salió porque la org es una sandbox) y el texto que habría llegado ─────────────────────
alter table public.notifications add column if not exists preview text
  check (char_length(preview) <= 2000 and not private.looks_like_secret(preview));
do $$
declare v_nombre text;
begin
  for v_nombre in select c.conname from pg_constraint c
                   where c.conrelid = 'public.notifications'::regclass and c.contype = 'c'
                     and pg_get_constraintdef(c.oid) like '%skipped_cap%' loop
    execute format('alter table public.notifications drop constraint %I', v_nombre);
  end loop;
end $$;
alter table public.notifications drop constraint if exists notifications_status_check;
alter table public.notifications add constraint notifications_status_check
  check (status in ('queued','sent','delivered','read','failed','skipped_cap','skipped'));

-- 3) Una sandbox nunca tiene conexiones de acciones (token de Cloudflare o de GitHub) ─────────────────────────────────
create or replace function private.vg_sandbox_sin_acciones() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'action' and exists (select 1 from public.orgs o where o.id = new.org_id and o.sandbox_of is not null) then
    raise exception 'sandbox_sin_acciones' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.vg_sandbox_sin_acciones() from public, anon, authenticated;
drop trigger if exists vg_sandbox_sin_acciones on public.connections;
create trigger vg_sandbox_sin_acciones before insert or update of kind, org_id on public.connections
  for each row execute function private.vg_sandbox_sin_acciones();

-- 4) RLS: el anónimo ve la demo y SU sandbox ──────────────────────────────────────────────────────────────────────────
create or replace function private.demo_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select id from public.orgs where is_demo or sandbox_of is not null $$;
alter policy orgs_sel on public.orgs using (id in (select private.user_org_ids())
  and (coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false or is_demo or sandbox_of is not null));

-- 5) Piezas de la copia ───────────────────────────────────────────────────────────────────────────────────────────────
-- Id nuevo determinista con forma de uuid v4 (versión 4, variante 8–b): md5(org nueva || id viejo). strict: null → null.
create or replace function private.vg_uuid_de(p_ns uuid, p_id uuid) returns uuid
language sql immutable strict set search_path = '' as $$
  select (substr(h, 1, 12) || '4' || substr(h, 14, 3) || substr('89ab', (('x' || substr(h, 17, 1))::bit(4)::int % 4) + 1, 1)
          || substr(h, 18, 15))::uuid
    from (select md5(p_ns::text || '|' || p_id::text) as h) x $$;
revoke all on function private.vg_uuid_de(uuid, uuid) from public, anon, authenticated;

-- Copia las filas de p_tabla de la org $1 a la org $2. p_cambios = expresión jsonb sobre la fila r (con $1 y $2) que se
-- funde encima de to_jsonb(r); p_filtro = condición extra sobre r. Columnas: todas menos las generadas y las identity
-- (que toman valor nuevo). Sin security definer: solo la llaman las funciones de abajo, que ya corren como dueño.
create or replace function private.vg_copiar(p_tabla regclass, p_desde uuid, p_hacia uuid, p_cambios text,
  p_filtro text default 'true') returns int
language plpgsql set search_path = '' as $$
declare v_cols text; n int;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
    from pg_attribute a
   where a.attrelid = p_tabla and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity = '';
  execute format('insert into %s (%s) select %s from (select (jsonb_populate_record(null::%s, to_jsonb(r) || (%s))).* '
                 || 'from %s r where r.org_id = $1 and (%s)) x', p_tabla, v_cols, v_cols, p_tabla, p_cambios, p_tabla, p_filtro)
    using p_desde, p_hacia;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function private.vg_copiar(regclass, uuid, uuid, text, text) from public, anon, authenticated;

-- 6) Crear (o devolver) la sandbox de un usuario ─────────────────────────────────────────────────────────────────────
-- Solo service_role (E4). Candado por usuario: dos E4 a la vez devuelven la misma. Una sandbox caducada que la purga aún
-- no borró se borra aquí y se crea otra. Errores: P0002 demo_org_missing · P0001 sandbox_cupo_ip | sandbox_cupo_global
-- · 23503 si el usuario ya no existe (la purga lo borró: su sesión es vieja).
create or replace function private.vg_clone_demo(p_owner uuid, p_ip_hash text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_demo public.orgs%rowtype;
  v_org uuid;
  v_vieja uuid;
  v_host text;
  m text := 'private.vg_uuid_de($2, %s)';
  -- La conexión copiada (solo las de lectura) o null.
  c text := '(select private.vg_uuid_de($2, k.id) from public.connections k where k.id = r.connection_id and k.kind = ''read'')';
begin
  if p_owner is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('vg_sandbox|' || p_owner::text));
  select o.id into v_vieja from public.orgs o
    join public.org_members mm on mm.org_id = o.id and mm.user_id = p_owner and mm.role = 'owner'
   where o.sandbox_of is not null order by o.last_seen_at desc limit 1;
  if v_vieja is not null then
    update public.orgs set last_seen_at = now(), cierra_en = null where id = v_vieja and last_seen_at >= now() - interval '10 minutes'
       and (cierra_en is null or cierra_en >= now());
    if found then return v_vieja; end if;
    delete from public.orgs where id = v_vieja;                              -- caducada: se rehace desde la demo
  end if;

  select * into v_demo from public.orgs where is_demo;
  if v_demo.id is null then raise exception 'demo_org_missing' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtext('vg_sandbox_cupos'));                -- los dos cupos, sin carreras
  if (select count(*) from public.orgs where sandbox_of is not null and last_seen_at >= now() - interval '10 minutes'
        and (cierra_en is null or cierra_en >= now())) >= 200 then
    raise exception 'sandbox_cupo_global' using errcode = 'P0001';
  end if;
  if p_ip_hash is not null then
    if (select count(*) from private.sandbox_altas where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 10 then
      raise exception 'sandbox_cupo_ip' using errcode = 'P0001';
    end if;
    insert into private.sandbox_altas (ip_hash) values (p_ip_hash);
  end if;

  insert into public.orgs (name, slug, is_demo, daily_audit, ai_daily_cap_usd, sandbox_of, last_seen_at, creator_ip_hash)
  values (v_demo.name, 'sbx-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16), false, false, 0.20, v_demo.id,
          now(), p_ip_hash)
  returning id into v_org;
  insert into public.org_members (org_id, user_id, role) values (v_org, p_owner, 'owner');

  -- Conexiones de lectura, «de demostración»: sin secreto y sin caducidad. Las de acciones no se copian.
  perform private.vg_copiar('public.connections', v_demo.id, v_org,
    format('jsonb_build_object(''id'', %s, ''org_id'', $2, ''created_by'', null, ''expires_at'', null, '
           || '''meta'', r.meta || ''{"demostracion": true}''::jsonb)', format(m, 'r.id')), 'r.kind = ''read''');
  -- Conexión del simulador de ataques (E57), si la demo no trae una.
  if not exists (select 1 from public.connections where org_id = v_org and provider = 'ingest' and meta->>'simulador' = 'true') then
    select meta->>'hostname' into v_host from public.connections
     where org_id = v_org and provider = 'ingest' and meta ? 'hostname' order by created_at limit 1;
    insert into public.connections (id, org_id, provider, kind, label, meta)
    values (gen_random_uuid(), v_org, 'ingest', 'read', coalesce(v_host, 'demo.officialvanguard.com'),
            jsonb_build_object('hostname', coalesce(v_host, 'demo.officialvanguard.com'), 'simulador', true, 'demostracion', true));
  end if;

  -- Auditorías (las que estaban en curso se copian cerradas) y sus fotos.
  perform private.vg_copiar('public.scan_runs', v_demo.id, v_org, format(
    'jsonb_build_object(''id'', %s, ''org_id'', $2, ''requested_by'', null, ''step'', null, '
    || '''status'', case when r.status in (''queued'', ''running'') then ''failed'' else r.status end, '
    || '''error'', case when r.status in (''queued'', ''running'') then ''La auditoría se interrumpió; vuelve a lanzarla'' else r.error end, '
    || '''finished_at'', coalesce(r.finished_at, now()), '
    || '''params'', case when r.params ? ''connection_id'' then r.params || jsonb_build_object(''connection_id'', '
    || 'private.vg_uuid_de($2, (r.params->>''connection_id'')::uuid)) else r.params end)', format(m, 'r.id')));
  perform private.vg_copiar('public.findings', v_demo.id, v_org, format(
    'jsonb_build_object(''id'', %s, ''org_id'', $2, ''scan_run_id'', %s, ''connection_id'', %s)',
    format(m, 'r.id'), format(m, 'r.scan_run_id'), c));
  perform private.vg_copiar('public.audit_snapshots', v_demo.id, v_org,
    'jsonb_build_object(''scan_run_id'', private.vg_uuid_de($2, r.scan_run_id), ''org_id'', $2, '
    || '''prev_scan_run_id'', private.vg_uuid_de($2, r.prev_scan_run_id), '
    || '''open_ids'', array(select private.vg_uuid_de($2, x) from unnest(r.open_ids) x), '
    || '''new_ids'', array(select private.vg_uuid_de($2, x) from unnest(r.new_ids) x), '
    || '''fixed_ids'', array(select private.vg_uuid_de($2, x) from unnest(r.fixed_ids) x), '
    || '''ignored_ids'', array(select private.vg_uuid_de($2, x) from unnest(r.ignored_ids) x))');
  perform private.vg_copiar('public.perf_runs', v_demo.id, v_org, format(
    'jsonb_build_object(''id'', %s, ''org_id'', $2, ''scan_run_id'', %s)', format(m, 'r.id'), format(m, 'r.scan_run_id')));
  -- Métricas de las últimas 6 h. edge_hits NO: llevan las IP reales del tráfico (la del ataque de la demo sale del hotspot
  -- de un integrante, S13 13.2) y el gráfico de tráfico solo mira los últimos minutos.
  perform private.vg_copiar('public.metric_samples', v_demo.id, v_org, format(
    'jsonb_build_object(''org_id'', $2, ''connection_id'', %s)', c),
    'r.ts > now() - interval ''6 hours'' and exists (select 1 from public.connections k where k.id = r.connection_id and k.kind = ''read'')');

  -- Incidentes (código nuevo: es único en toda la base), revisiones de código y avisos (sin provider_id: E31 no debe
  -- casar un estado de WhatsApp con la copia).
  perform private.vg_copiar('public.incidents', v_demo.id, v_org, format(
    'jsonb_build_object(''id'', %s, ''org_id'', $2, ''connection_id'', %s, '
    || '''code'', upper(substr(md5(gen_random_uuid()::text), 1, 6)))', format(m, 'r.id'), c));
  -- Config de revisión apagada: su secreto sellado lleva en el AAD la org y el id viejos, así que no abre (un webhook a
  -- la URL nueva falla la firma).
  perform private.vg_copiar('public.code_review_configs', v_demo.id, v_org, format(
    'jsonb_build_object(''id'', %s, ''org_id'', $2, ''connection_id'', private.vg_uuid_de($2, r.connection_id), '
    || '''enabled'', false, ''gate_enabled'', false, ''created_by'', null)', format(m, 'r.id')),
    'exists (select 1 from public.connections k where k.id = r.connection_id and k.kind = ''read'')');
  perform private.vg_copiar('public.code_reviews', v_demo.id, v_org, format(
    'jsonb_build_object(''id'', %s, ''org_id'', $2, ''config_id'', %s, ''gate_override_by'', null, '
    || '''status'', case when r.status in (''queued'', ''running'') then ''failed'' else r.status end, '
    || '''snap_open_ids'', case when r.snap_open_ids is null then null '
    || 'else array(select private.vg_uuid_de($2, x) from unnest(r.snap_open_ids) x) end)', format(m, 'r.id'), format(m, 'r.config_id')),
    'exists (select 1 from public.code_review_configs k join public.connections q on q.id = k.connection_id '
    || 'where k.id = r.config_id and q.kind = ''read'')');
  perform private.vg_copiar('public.notifications', v_demo.id, v_org, format(
    'jsonb_build_object(''id'', %s, ''org_id'', $2, ''incident_id'', %s, ''provider_id'', null, ''code_review_id'', '
    || '(select z.id from public.code_reviews z where z.id = private.vg_uuid_de($2, r.code_review_id)))',
    format(m, 'r.id'), format(m, 'r.incident_id')),
    'r.code_review_id is null or exists (select 1 from public.code_reviews z where z.id = private.vg_uuid_de($2, r.code_review_id))');
  -- Acciones en seco: nunca una regla real de Cloudflare (provider_ref simulado, previous.simulado). Una en curso se
  -- copia fallida; las de bajo ataque conservan las claves que pide su check (0017).
  perform private.vg_copiar('public.actions', v_demo.id, v_org, format(
    'jsonb_build_object(''id'', %s, ''org_id'', $2, ''incident_id'', %s, ''approval_id'', null, ''requested_by'', null, '
    || '''status'', case when r.status = ''proposed'' then ''failed'' else r.status end, '
    || '''provider_ref'', case when r.provider_ref is null then null else ''simulado:'' || %s end, '
    || '''previous'', case when r.kind = ''under_attack_on'' then jsonb_build_object(''simulado'', true, '
    || '''connection_id'', null, ''zone_id'', coalesce(r.previous->''zone_id'', ''"simulado"''::jsonb), '
    || '''zone_name'', r.previous->''zone_name'', ''scope'', coalesce(r.previous->>''scope'', ''host'')) '
    || 'else jsonb_build_object(''simulado'', true) end)', format(m, 'r.id'), format(m, 'r.incident_id'), format(m, 'r.id')));
  perform private.vg_copiar('public.wiki_runs', v_demo.id, v_org, format(
    'jsonb_build_object(''id'', %s, ''org_id'', $2, ''connection_id'', %s, ''requested_by'', null)', format(m, 'r.id'), c),
    'r.status in (''succeeded'', ''failed'')');
  perform private.vg_copiar('public.fix_requests', v_demo.id, v_org, format(
    'jsonb_build_object(''id'', %s, ''org_id'', $2, ''finding_id'', %s, ''requested_by'', null, ''mcp_token_id'', null)',
    format(m, 'r.id'), format(m, 'r.finding_id')));
  perform private.vg_copiar('public.alert_prefs', v_demo.id, v_org, 'jsonb_build_object(''org_id'', $2, ''updated_by'', null)');
  return v_org;
end $$;
revoke all on function private.vg_clone_demo(uuid, text) from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.vg_clone_demo(uuid, text) to service_role;

-- Envoltorios en public para PostgREST (el Worker llama por .rpc(); private no está expuesto). Solo service_role.
create or replace function public.vg_sandbox_join(p_user uuid, p_ip_hash text) returns uuid
language sql security definer set search_path = '' as $$ select private.vg_clone_demo(p_user, p_ip_hash) $$;

-- E4b: latido. true = la sandbox es de p_user (owner) y sigue en la base.
create or replace function public.vg_sandbox_latido(p_org uuid, p_user uuid) returns boolean
language sql security definer set search_path = '' as $$
  update public.orgs o set last_seen_at = now(), cierra_en = null          -- un latido anula un cierre pendiente (recarga)
   where o.id = p_org and o.sandbox_of is not null
     and exists (select 1 from public.org_members m where m.org_id = o.id and m.user_id = p_user and m.role = 'owner')
  returning true $$;

-- E4d: cerrando (pagehide). No borra: marca la sandbox para que la purga la borre en 20 s si no llega otro latido (una
-- recarga lo manda en cuanto carga y lo anula). Idempotente; true = era su sandbox (owner) y sigue en la base.
create or replace function public.vg_sandbox_cerrando(p_org uuid, p_user uuid) returns boolean
language sql security definer set search_path = '' as $$
  update public.orgs o set cierra_en = now() + interval '20 seconds'
   where o.id = p_org and o.sandbox_of is not null
     and exists (select 1 from public.org_members m where m.org_id = o.id and m.user_id = p_user and m.role = 'owner')
  returning true $$;

-- E4c: salir. Borra la sandbox si es de p_user (cascada) y, si p_user es anónimo y ya no le queda ninguna org, borra
-- también al usuario de auth.users. Idempotente: una org que no existe o no es suya no se toca.
create or replace function public.vg_sandbox_salir(p_org uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_borrada boolean := false; v_usuario boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext('vg_sandbox|' || p_user::text));
  delete from public.orgs o where o.id = p_org and o.sandbox_of is not null
     and exists (select 1 from public.org_members m where m.org_id = o.id and m.user_id = p_user and m.role = 'owner');
  v_borrada := found;
  delete from auth.users u where u.id = p_user and u.is_anonymous is true
     and not exists (select 1 from public.org_members m where m.user_id = u.id);
  v_usuario := found;
  return jsonb_build_object('borrada', v_borrada, 'usuario_borrado', v_usuario);
end $$;

revoke all on function public.vg_sandbox_join(uuid, text), public.vg_sandbox_latido(uuid, uuid),
  public.vg_sandbox_cerrando(uuid, uuid), public.vg_sandbox_salir(uuid, uuid) from public, anon, authenticated;
grant execute on function public.vg_sandbox_join(uuid, text), public.vg_sandbox_latido(uuid, uuid),
  public.vg_sandbox_cerrando(uuid, uuid), public.vg_sandbox_salir(uuid, uuid) to service_role;

-- 7) «Replay» de auditoría (E11 en una sandbox sin conexiones reales) ─────────────────────────────────────────────────
-- Una auditoría completa nueva, ya cerrada, con los pasos, la cobertura, el puntaje y el resumen de la última completa
-- de la sandbox (los de la demo, copiados); los hallazgos abiertos se dan por vistos en ella y queda su foto (Evolución).
-- No llama a nadie. null = la sandbox no tiene ninguna auditoría completa de la que partir.
create or replace function public.vg_sandbox_replay(p_org uuid, p_user uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_base public.scan_runs%rowtype; v_id uuid;
begin
  if not exists (select 1 from public.orgs where id = p_org and sandbox_of is not null) then
    raise exception 'no_sandbox' using errcode = 'P0002';
  end if;
  select * into v_base from public.scan_runs where org_id = p_org and kind = 'full_audit' and status = 'succeeded'
   order by created_at desc limit 1;
  if v_base.id is null then return null; end if;
  insert into public.scan_runs (org_id, kind, status, progress, steps, params, summary, score, coverage, requested_by,
                                started_at, finished_at)
  values (p_org, 'full_audit', 'succeeded', 100, v_base.steps, jsonb_build_object('replay', true), v_base.summary,
          v_base.score, v_base.coverage, p_user, now(), now())
  returning id into v_id;
  update public.findings set scan_run_id = v_id, last_seen_at = now() where org_id = p_org and status = 'open';
  perform public.vg_snapshot_audit(p_org, v_id);
  return v_id;
end $$;
revoke all on function public.vg_sandbox_replay(uuid, uuid) from public, anon, authenticated;
grant execute on function public.vg_sandbox_replay(uuid, uuid) to service_role;

-- 8) Purga volátil, cada minuto ──────────────────────────────────────────────────────────────────────────────────────
-- Borra las sandboxes sin latido desde hace 10 min (margen para pestañas en segundo plano, que el navegador espacia) y las
-- que la web marcó al cerrarse (E4d, cierra_en vencido: 20 s sin que una recarga mandara otro latido).
-- Por qué es seguro: (1) solo borra orgs con sandbox_of (nunca una org normal ni la demo; el check exige last_seen_at);
-- (2) el delete vuelve a evaluar last_seen_at y cierra_en tras esperar el candado de fila (READ COMMITTED), así que un
-- latido que llega a la vez (y anula cierra_en) gana y la sandbox sigue; (3) los usuarios que borra son SOLO los dueños de las sandboxes que acaba de
-- borrar, anónimos y sin ninguna otra org: un usuario con cuenta nunca, ni un anónimo recién llegado que aún no hizo E4;
-- (4) pg_try_advisory_xact_lock salta al usuario que esté creando su sandbox en ese momento (vg_clone_demo tiene el
-- candado): se mira en el minuto siguiente; (5) acotada a 500 sandboxes por pasada. El libro de altas se purga a 1 día.
create or replace function private.vg_purgar_sandboxes() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_duenos uuid[]; v_orgs int; v_users int;
begin
  with c as (
    select o.id from public.orgs o
     where o.sandbox_of is not null and (o.last_seen_at < now() - interval '10 minutes' or o.cierra_en < now())
     order by o.last_seen_at limit 500
     for update skip locked),
  d as (select m.user_id from public.org_members m join c on c.id = m.org_id where m.role = 'owner'),
  b as (delete from public.orgs o using c where o.id = c.id
                  and (o.last_seen_at < now() - interval '10 minutes' or o.cierra_en < now()) returning o.id)
  select coalesce((select array_agg(distinct d.user_id) from d), '{}'), (select count(*) from b) into v_duenos, v_orgs;
  delete from auth.users u where u.id = any(v_duenos) and u.is_anonymous is true
     and not exists (select 1 from public.org_members m where m.user_id = u.id)
     and pg_try_advisory_xact_lock(hashtext('vg_sandbox|' || u.id::text));
  get diagnostics v_users = row_count;
  delete from private.sandbox_altas where created_at < now() - interval '1 day';
  return jsonb_build_object('orgs', v_orgs, 'usuarios', v_users);
end $$;
revoke all on function private.vg_purgar_sandboxes() from public, anon, authenticated;
select cron.schedule('vg-purge-sandboxes', '* * * * *', $$select private.vg_purgar_sandboxes()$$);

-- 9) Limpieza del bug de E4: las cuentas reales que pulsaron «Ver demo» quedaron como viewer de la demo. Solo viewer y
-- solo usuarios NO anónimos: owner y admin (el equipo) no se tocan; los anónimos los purga vg_purge_daily a los 7 días.
delete from public.org_members m using public.orgs o, auth.users u
 where o.id = m.org_id and u.id = m.user_id and o.is_demo and m.role = 'viewer' and u.is_anonymous is not true;
