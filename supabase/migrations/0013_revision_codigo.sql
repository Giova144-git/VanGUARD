-- 0013_revision_codigo.sql · Revisión de código en cada push y en cada pull request (docs/plan_maestro_trabajo/
-- asignaciones/revision-codigo.md §3; con 0013c dentro, decisión D1: el PR entra hoy).
-- Tres tablas solo del servidor (RLS sin políticas y sin grants a anon/authenticated, como 0008h y 0010), una columna y
-- dos checks en notifications y la RPC vg_review_findings. No toca private.looks_like_secret (el secreto vgw_ va sellado
-- y nunca se escribe en claro; ampliar el check sin cambiar a la vez su copia en engine/edge.ts dejaría esquivar alertas
-- del borde) ni webhook_events (la idempotencia la da el unique de code_reviews).

-- 1) Preferencias de aviso por org. En P0 solo las usa la revisión de código; el motor en vivo sigue con su regla fija
-- (high → WhatsApp, critical → llamada) para no tocar la demo del ataque. Sin fila = valores por defecto.
create table if not exists public.alert_prefs (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  review_whatsapp_min text not null default 'high' check (review_whatsapp_min in ('critical','high','medium','low','off')),
  review_voice_min text not null default 'critical' check (review_voice_min in ('critical','high','medium','low','off')),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now());

-- 2) Configuración de la revisión: una por conexión GitHub. El secreto del webhook va sellado aquí (Box de 05.7) con
-- AAD (org_id, id de ESTA fila, 'github', 'read'): no se puede mover a otra fila ni a otra org. Borrar la conexión
-- borra la config y sus revisiones.
create table if not exists public.code_review_configs (
  id uuid primary key,                          -- lo genera el Worker: va en la URL del webhook y en el AAD
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null,
  enabled boolean not null default true,
  branch text not null check (branch ~ '^[A-Za-z0-9._/-]{1,100}$'),
  secret_sealed jsonb not null check (secret_sealed ?& array['v','kid','iv','ct','ivk','wdek']),
  secret_kid text not null check (secret_kid ~ '^v[0-9]{1,3}$'),
  secret_last4 text check (char_length(secret_last4) <= 4),
  hook_events text[] not null default '{}' check (cardinality(hook_events) <= 30),   -- los del último ping
  last_ping_at timestamptz,
  last_event_at timestamptz,
  last_error text check (last_error in ('firma','otro_repo','sin_push','token')),
  last_error_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id),
  unique (id, org_id),
  foreign key (connection_id, org_id) references public.connections (id, org_id) on delete cascade,
  check (secret_sealed->>'kid' = secret_kid));

-- 3) Una fila por revisión. new_findings = hasta 50 nuevos, ya redactados (sin evidencia). reported_keys =
-- 'dedupe_key:huella' de todo lo encontrado (private.clave_revision): el siguiente synchronize del mismo PR no repite
-- el aviso, y el push que fusiona ese PR tampoco (0013c). push_commits = SHA del payload firmado del push (los últimos
-- 49 de `commits` + `after`): dice qué head de PR entró en ESTE push sin pedir nada a GitHub.
create table if not exists public.code_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  config_id uuid not null,
  event text not null check (event in ('push','pull_request','manual')),
  delivery_id text check (delivery_id ~ '^[0-9A-Fa-f-]{36}$'),
  branch text not null check (branch ~ '^[A-Za-z0-9._/-]{1,100}$'),
  pr_number int check (pr_number > 0),
  base_sha text not null check (base_sha ~ '^[0-9a-f]{40}$'),
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  push_commits text[] not null default '{}'
    check (cardinality(push_commits) <= 50 and array_to_string(push_commits, ',') ~ '^([0-9a-f]{40}(,[0-9a-f]{40})*)?$'),
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  error_code text check (error_code ~ '^[a-z_]{2,40}$'),
  partial boolean not null default false,
  files_changed int not null default 0 check (files_changed >= 0),
  lines_added int not null default 0 check (lines_added >= 0),
  counts jsonb not null default '{"critical":0,"high":0,"medium":0,"low":0,"info":0}',
  max_severity text check (max_severity in ('critical','high','medium','low','info')),
  new_findings jsonb not null default '[]'
    check (jsonb_typeof(new_findings) = 'array' and jsonb_array_length(new_findings) <= 50),
  reported_keys text[] not null default '{}'
    check (cardinality(reported_keys) <= 200
           and array_to_string(reported_keys, ',') ~ '^([0-9a-f]{64}:[0-9a-f]{0,16}(,[0-9a-f]{64}:[0-9a-f]{0,16})*)?$'),
  alert_state text not null default 'none' check (alert_state in ('none','pending','sent','not_sent')),
  alert_reason text check (alert_reason ~ '^[a-z_]{2,40}$'),
  voice_pending boolean not null default false,
  notified_at timestamptz,
  created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz,
  foreign key (config_id, org_id) references public.code_review_configs (id, org_id) on delete cascade,
  check (event <> 'pull_request' or pr_number is not null),
  check (event = 'push' or cardinality(push_commits) = 0),
  check (not private.looks_like_secret(new_findings::text)));
-- Un mismo commit no se revisa dos veces por el mismo evento. Una revisión failed se reabre con UPDATE (E47), no con otra
-- fila. Las manuales (P1) sí pueden repetirse.
create unique index if not exists code_reviews_unica_uidx
  on public.code_reviews (config_id, event, head_sha, coalesce(pr_number, 0)) where event <> 'manual';
create index if not exists code_reviews_org_created_idx on public.code_reviews (org_id, created_at desc);
create index if not exists code_reviews_pr_idx on public.code_reviews (config_id, pr_number, created_at desc)
  where pr_number is not null;

-- 4) notifications: el aviso de una revisión cuelga de la revisión, no de un incidente. Una sola fila por revisión,
-- canal y destinatario (23505 = ya avisado, como el unique de 0005 para incidentes).
alter table public.notifications add column if not exists code_review_id uuid
  references public.code_reviews(id) on delete cascade;
alter table public.notifications drop constraint if exists notifications_incidente_o_prueba;
alter table public.notifications add constraint notifications_incidente_o_prueba
  check (incident_id is not null or template = 'test_v1' or (code_review_id is not null and template = 'code_review_v1'));
alter table public.notifications drop constraint if exists notifications_un_origen;
alter table public.notifications add constraint notifications_un_origen check (incident_id is null or code_review_id is null);
create unique index if not exists notifications_revision_uidx
  on public.notifications (code_review_id, channel, recipient_masked) where code_review_id is not null;

-- 5) Solo el Worker (service_role). Decisión (a): los datos van por /api; anon y authenticated no leen nada.
alter table public.alert_prefs enable row level security;
alter table public.code_review_configs enable row level security;
alter table public.code_reviews enable row level security;
revoke all on public.alert_prefs, public.code_review_configs, public.code_reviews from anon, authenticated;
grant select, insert, update, delete on public.alert_prefs, public.code_review_configs, public.code_reviews to service_role;

-- 6) Clave de lo encontrado para reported_keys: 'dedupe_key:huella' (huella = evidence.fingerprint_short si es hex; si
-- no, vacía). La misma dedupe_key con otra huella es otro valor en la misma línea: vuelve a contar.
create or replace function private.clave_revision(e jsonb) returns text language sql immutable set search_path = '' as $$
  select (e->>'dedupe_key') || ':'
         || case when e->'evidence'->>'fingerprint_short' ~ '^[0-9a-f]{1,16}$' then e->'evidence'->>'fingerprint_short'
                 else '' end
$$;
revoke all on function private.clave_revision(jsonb) from public, anon, authenticated;

-- 7) Cierre del paso 'diff' en UNA transacción. p_rows = filas ya pasadas por aFila (redact, dedupe_key) y ocultarRutas.
-- p_write = true en push (escribe en findings), false en PR. p_meta = {files_changed, lines_added, partial, error_code,
-- sin_aviso}; sin_aviso ('fork') deja la revisión en la app sin avisar. Candado por org: dos revisiones a la vez no
-- cuentan el mismo hallazgo como nuevo. CAS: solo cierra una revisión en 'running' de ESA org, una vez.
create or replace function public.vg_review_findings(p_org uuid, p_review uuid, p_rows jsonb, p_write boolean, p_meta jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v public.code_reviews%rowtype;
  v_rows jsonb := coalesce(p_rows, '[]'::jsonb);
  v_parcial boolean := coalesce((p_meta->>'partial')::boolean, false);
  v_sin_aviso text := nullif(p_meta->>'sin_aviso', '');
  v_previas text[] := '{}';      -- PR: lo encontrado en la revisión anterior del mismo PR (no es nuevo)
  v_avisadas text[] := '{}';     -- push: lo ya avisado en un PR cuyo head entra en este push (nuevo, pero sin aviso)
  v_new jsonb;
  v_max text;
  v_max_aviso text;
  v_wa text;
  v_voz text;
  v_alert text := 'none';
  v_reason text;
begin
  if jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) > 200 then
    raise exception 'p_rows' using errcode = '22023';
  end if;
  if v_sin_aviso is not null and v_sin_aviso !~ '^[a-z_]{2,40}$' then
    raise exception 'p_meta.sin_aviso' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('vg_review|' || p_org::text));
  select * into v from public.code_reviews r
   where r.id = p_review and r.org_id = p_org and r.status = 'running' for update;
  if v.id is null then return jsonb_build_object('applied', false); end if;

  if v.event = 'pull_request' then
    select r.reported_keys into v_previas from public.code_reviews r
     where r.org_id = p_org and r.config_id = v.config_id and r.event = 'pull_request' and r.pr_number = v.pr_number
       and r.status = 'done' and r.id <> v.id and r.created_at <= v.created_at
     order by r.created_at desc limit 1;
    v_previas := coalesce(v_previas, '{}');
  elsif v.event = 'push' and cardinality(v.push_commits) > 0 then
    -- 0013c: solo el PR fusionado (su head está en los commits firmados de ESTE push) y con la misma huella. Un squash
    -- o un rebase crean SHA nuevos: no casan y el push vuelve a avisar (lo prudente).
    select coalesce(array_agg(distinct k), '{}') into v_avisadas
      from public.code_reviews r, unnest(r.reported_keys) k
     where r.org_id = p_org and r.config_id = v.config_id and r.event = 'pull_request' and r.status = 'done'
       and r.alert_state = 'sent' and r.head_sha = any(v.push_commits) and r.created_at > now() - interval '30 days';
  end if;

  -- Nuevo (§2.5), ANTES del upsert. fp = evidence.fingerprint_short (solo CB_SECRET_*). No es nuevo si hay una fila
  -- open/ignored (a) en el mismo sitio con el mismo valor, o sin huella en alguno de los dos lados, o (b) del mismo
  -- secreto (regla + huella) en otro sitio, o (c) en un PR, si ya salió en la revisión anterior del mismo PR.
  -- fixed/verified en el mismo sitio reaparece; otro valor en el mismo sitio es nuevo.
  select coalesce(jsonb_agg(d.x order by private.sev_rank(d.x->>'severity') desc, d.x->>'dedupe_key'), '[]'::jsonb)
    into v_new
    from (select distinct on (e->>'dedupe_key') e as x from jsonb_array_elements(v_rows) e order by e->>'dedupe_key') d
   where not exists (select 1 from public.findings g
                      where g.org_id = p_org and g.dedupe_key = d.x->>'dedupe_key' and g.status in ('open', 'ignored')
                        and (g.evidence->>'fingerprint_short' is null
                             or d.x->'evidence'->>'fingerprint_short' is null
                             or g.evidence->>'fingerprint_short' = d.x->'evidence'->>'fingerprint_short'))
     and not exists (select 1 from public.findings g
                      where g.org_id = p_org and g.rule_id = d.x->>'rule_id' and g.status in ('open', 'ignored')
                        and g.dedupe_key <> d.x->>'dedupe_key'
                        and g.evidence->>'fingerprint_short' = d.x->'evidence'->>'fingerprint_short')
     and not private.clave_revision(d.x) = any(v_previas);

  if p_write then
    -- connection_id null a propósito: la auto-verificación de la auditoría (vg_upsert_findings) no los toca. El mismo
    -- secreto ya open/ignored en otro sitio (b) no se inserta. Reabre = fila fixed/verified, o open/ignored con OTRO valor
    -- (las dos huellas existen y difieren; con una null, la comparación da null y cuenta como no).
    insert into public.findings as f (org_id, scan_run_id, connection_id, module, rule_id, severity, confirmed, origin,
                                      title, resource, evidence, dedupe_key, suspected_injection)
    select distinct on (e->>'dedupe_key') p_org, null, null, 'codebase', e->>'rule_id', e->>'severity',
           coalesce((e->>'confirmed')::boolean, false), coalesce(e->>'origin', 'rule'), e->>'title', e->>'resource',
           coalesce(e->'evidence', '{}'::jsonb), e->>'dedupe_key', coalesce((e->>'suspected_injection')::boolean, false)
      from jsonb_array_elements(v_rows) e
     where not exists (select 1 from public.findings g
                        where g.org_id = p_org and g.rule_id = e->>'rule_id' and g.status in ('open', 'ignored')
                          and g.dedupe_key <> e->>'dedupe_key'
                          and g.evidence->>'fingerprint_short' = e->'evidence'->>'fingerprint_short')
     order by e->>'dedupe_key'
    on conflict (org_id, dedupe_key) do update set
      last_seen_at  = now(),
      severity      = case when f.status in ('fixed','verified')
                             or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short'
                           then excluded.severity else f.severity end,
      confirmed     = case when f.status in ('fixed','verified')
                             or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short'
                           then excluded.confirmed else f.confirmed end,
      title         = case when f.status in ('fixed','verified')
                             or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short'
                           then excluded.title else f.title end,
      evidence      = case when f.status in ('fixed','verified')
                             or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short'
                           then excluded.evidence else f.evidence end,
      fix_prompt    = case when (f.status in ('fixed','verified')
                                 or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short')
                            and f.evidence is distinct from excluded.evidence then null else f.fix_prompt end,
      fix_model     = case when (f.status in ('fixed','verified')
                                 or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short')
                            and f.evidence is distinct from excluded.evidence then null else f.fix_model end,
      status        = case when f.status in ('fixed','verified')
                             or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short'
                           then 'open' else f.status end,
      status_reason = case when f.status in ('fixed','verified') then 'reapareció en una revisión de código'
                           when f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short'
                             then 'otro valor en la misma línea (revisión de código)'
                           else f.status_reason end,
      verified_at   = case when f.status in ('fixed','verified')
                             or f.evidence->>'fingerprint_short' <> excluded.evidence->>'fingerprint_short'
                           then null else f.verified_at end;
  end if;

  select e->>'severity' into v_max from jsonb_array_elements(v_new) e
   order by private.sev_rank(e->>'severity') desc limit 1;
  select e->>'severity' into v_max_aviso from jsonb_array_elements(v_new) e
   where not private.clave_revision(e) = any(v_avisadas)
   order by private.sev_rank(e->>'severity') desc limit 1;
  select p.review_whatsapp_min, p.review_voice_min into v_wa, v_voz from public.alert_prefs p where p.org_id = p_org;
  v_wa := coalesce(v_wa, 'high');            -- sin fila, SELECT INTO deja null
  v_voz := coalesce(v_voz, 'critical');
  -- Cualquiera de los dos umbrales: mientras no haya llamadas, el paso aviso manda por WhatsApp (§5).
  if v_sin_aviso is not null then
    v_reason := case when v_max is not null or v_parcial then v_sin_aviso end;   -- PR de un fork: solo en la app
  elsif v_max_aviso is not null and ((v_wa <> 'off' and private.sev_rank(v_max_aviso) >= private.sev_rank(v_wa))
                         or (v_voz <> 'off' and private.sev_rank(v_max_aviso) >= private.sev_rank(v_voz))) then
    v_alert := 'pending';
  elsif v_parcial and (v_wa <> 'off' or v_voz <> 'off') then
    v_alert := 'pending';                    -- revisión incompleta: avisa aunque no haya nuevos (§2.2)
  elsif v_max_aviso is not null then
    v_reason := 'bajo_umbral';
  elsif v_max is not null then
    v_reason := 'ya_avisado_pr';             -- todo lo nuevo ya se avisó en el PR que este push fusiona
  end if;

  update public.code_reviews r set
    status = 'done', finished_at = now(),
    partial = v_parcial,
    error_code = nullif(p_meta->>'error_code', ''),
    files_changed = greatest(coalesce((p_meta->>'files_changed')::int, 0), 0),
    lines_added = greatest(coalesce((p_meta->>'lines_added')::int, 0), 0),
    max_severity = v_max,
    counts = (select jsonb_build_object(
                'critical', count(*) filter (where e->>'severity' = 'critical'),
                'high',     count(*) filter (where e->>'severity' = 'high'),
                'medium',   count(*) filter (where e->>'severity' = 'medium'),
                'low',      count(*) filter (where e->>'severity' = 'low'),
                'info',     count(*) filter (where e->>'severity' = 'info'))
                from jsonb_array_elements(v_new) e),
    new_findings = (select coalesce(jsonb_agg(jsonb_build_object('finding_id', g.id, 'rule_id', t.e->>'rule_id',
                      'severity', t.e->>'severity', 'title', t.e->>'title', 'resource', t.e->>'resource') order by t.o),
                      '[]'::jsonb)
                      from jsonb_array_elements(v_new) with ordinality as t(e, o)
                      left join public.findings g on p_write and g.org_id = p_org and g.dedupe_key = t.e->>'dedupe_key'
                     where t.o <= 50),
    reported_keys = array(select distinct private.clave_revision(e) from jsonb_array_elements(v_rows) e limit 200),
    alert_state = v_alert,
    alert_reason = v_reason
  where r.id = v.id;
  return jsonb_build_object('applied', true, 'nuevos', jsonb_array_length(v_new), 'max_severity', v_max,
                            'alert_state', v_alert, 'parcial', v_parcial);
end $$;

revoke all on function public.vg_review_findings(uuid, uuid, jsonb, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.vg_review_findings(uuid, uuid, jsonb, boolean, jsonb) to service_role;
