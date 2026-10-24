-- 0005_incidents_alerts.sql · literal de PLAN_MAESTRO §05.4 + vg_upsert_incident de §15.12 (bloque «0005»).
-- Los check ya incluyen los valores P1 de las decisiones §6 para no migrar el domingo.
create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 6)) check (code ~ '^[0-9A-F]{6}$'),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid references public.connections(id) on delete set null,
  rule_ids text[] not null check (cardinality(rule_ids) >= 1),
  severity text not null check (severity in ('critical','high','medium','low','info')),
  severity_rank smallint generated always as (case severity when 'critical' then 5 when 'high' then 4
                 when 'medium' then 3 when 'low' then 2 else 1 end) stored,
  title text not null check (char_length(title) <= 200),
  resource text not null check (char_length(resource) <= 120),      -- ip:203.0.113.7 · supabase:<ref>:db
  status text not null default 'open' check (status in ('open','ack','mitigated','resolved')),
  event_count int not null default 1 check (event_count >= 1),
  details jsonb not null default '{}',                              -- sin secretos ni PII
  dedupe_key text not null check (dedupe_key ~ '^[0-9a-f]{64}$'),   -- sha256(org_id|edge|ip)
  started_at timestamptz not null default now(), last_event_at timestamptz not null default now(),
  notified_at timestamptz, acked_at timestamptz,
  acked_via text check (acked_via in ('in_app','whatsapp','voice')),
  muted_until timestamptz, mitigated_at timestamptz, resolved_at timestamptz,
  suspected_injection boolean not null default false,
  check (not private.looks_like_secret(details::text || ' ' || title)));
create unique index if not exists incidents_open_dedupe on public.incidents (org_id, dedupe_key) where status <> 'resolved';
create index if not exists incidents_org_status_idx on public.incidents (org_id, status, last_event_at desc);

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  whatsapp boolean not null default true, voice boolean not null default false,
  priority smallint not null default 1 check (priority between 1 and 9),
  verified_at timestamptz, created_at timestamptz not null default now(),
  unique (org_id, phone_e164));

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  incident_id uuid not null references public.incidents(id) on delete cascade,
  channel text not null check (channel in ('in_app','whatsapp','voice','telegram','email')),
  recipient_masked text not null check (recipient_masked ~ '^(\+[0-9]{2}•+[0-9]{4}|in_app)$'),   -- +58•••••4567
  template text not null check (template ~ '^[a-z0-9_]{3,40}$'),
  status text not null default 'queued' check (status in ('queued','sent','delivered','read','failed','skipped_cap')),
  provider_id text check (char_length(provider_id) <= 120),        -- wamid, conversation_id, callSid
  error text check (char_length(error) <= 200),
  created_at timestamptz not null default now(), sent_at timestamptz, delivered_at timestamptz, read_at timestamptz,
  unique (incident_id, channel, recipient_masked, template));   -- 23505 = «ya avisado»: el despachador lo trata como éxito.
  -- Para que una subida de severidad pueda volver a avisar, la plantilla lleva la severidad en el nombre (edge_high_v1, edge_critical_v1).
create index if not exists notifications_provider_idx on public.notifications (provider_id) where provider_id is not null;
create index if not exists notifications_caps_idx on public.notifications (org_id, channel, created_at desc);   -- topes por hora

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  incident_id uuid references public.incidents(id) on delete cascade,
  action_kind text not null check (action_kind in ('block_ip','unblock_ip','under_attack_on','under_attack_off','rate_limit',
                                                   'ack','mute')),  -- ack/mute: botones «Lo estoy viendo» y «Silenciar 1 h» (§15.10)
  params jsonb not null default '{}',                               -- {"target":"203.0.113.7","incident_id":"…","group":"…","connection_id":"…"}
  channel text not null check (channel in ('in_app','whatsapp')),
  recipient text not null check (char_length(recipient) <= 64),     -- whatsapp: E.164 SIN '+' (igual que el from del webhook); in_app: user_id
  nonce_hash bytea not null unique check (octet_length(nonce_hash) = 32),   -- 32 bytes: SHA-256 (botones) o HMAC-SHA256 (código de la app), decisión 3 de 05.14
  attempts smallint not null default 0 check (attempts between 0 and 5),   -- añadido: tope a fuerza bruta del código de 6 dígitos
  expires_at timestamptz not null default now() + interval '10 minutes',
  used_at timestamptz, result jsonb, created_at timestamptz not null default now());

create table if not exists public.actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  incident_id uuid references public.incidents(id) on delete set null,
  approval_id uuid unique references public.approvals(id) on delete set null,   -- idempotencia: una ejecución por aprobación
  kind text not null check (kind in ('block_ip','unblock_ip','under_attack_on','under_attack_off','rate_limit')),
  target text not null check (char_length(target) <= 120),
  status text not null default 'proposed' check (status in ('proposed','executed','undone','failed')),
  provider_ref text, previous jsonb,
  requested_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), undone_at timestamptz, expires_at timestamptz);
create index if not exists actions_org_idx on public.actions (org_id, created_at desc);
create index if not exists actions_expiring_idx on public.actions (expires_at) where status = 'executed';   -- auto-deshacer a 1 h

create table if not exists public.webhook_events (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('kapso','elevenlabs','cloudflare')),   -- cloudflare: webhook dos_attack_l7 (P1, §08)
  external_id text not null check (char_length(external_id) <= 200),   -- X-Idempotency-Key / conversation_id
  payload_redacted jsonb not null default '{}',
  received_at timestamptz not null default now(),
  unique (provider, external_id),
  check (not private.looks_like_secret(payload_redacted::text)));

-- Canje atómico del código de un solo uso. WhatsApp: p_approval null, hash = sha256(nonce de 16 bytes), recipient = from
-- del webhook (sin '+'). App: p_approval = id (el Worker genera el id con crypto.randomUUID() ANTES de insertar, porque entra
-- en el hash), hash = HMAC-SHA256(FPK, 'otp|' || approval_id || '|' || código) (decisión 3 de 05.14), recipient = user_id.
-- La función no filtra por org: E21 hace antes una pre-lectura por id + org_id + channel 'in_app' + recipient (§15).
-- Devuelve la fila canjeada (0 filas = vencido, usado, quemado o código malo). Al 5.º fallo en la app queda quemada.
create or replace function public.vg_redeem_approval(p_approval uuid, p_nonce_hash bytea, p_recipient text)
returns setof public.approvals language plpgsql security definer set search_path = '' as $$
begin
  return query with u as (
    update public.approvals a set used_at = now()
     where a.nonce_hash = p_nonce_hash and a.used_at is null and a.expires_at > now() and a.attempts < 5
       and a.recipient = p_recipient and (p_approval is null or a.id = p_approval)
    returning a.*) select * from u;
  if not found and p_approval is not null then
    update public.approvals set attempts = attempts + 1 where id = p_approval and used_at is null and attempts < 5;
  end if;
end $$;
revoke all on function public.vg_redeem_approval(uuid, bytea, text) from public, anon, authenticated;
grant execute on function public.vg_redeem_approval(uuid, bytea, text) to service_role;

-- §15.12 «0005»: agrupación de incidentes, reapertura < 10 min y conteo de eventos de la IP. Lee edge_hits (0006):
-- PL/pgSQL resuelve las tablas al ejecutar. Si llega p_started null, se usa now(): started_at es not null.
create or replace function public.vg_upsert_incident(p_org uuid, p_conn uuid, p_dedupe text, p_rules text[], p_severity text,
  p_title text, p_resource text, p_details jsonb, p_ip inet, p_started timestamptz)
returns table (id uuid, code text, severity text, prev_severity text, is_new boolean, reopened boolean, status text, muted_until timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v public.incidents%rowtype; v_prev text; v_new boolean := false; v_reo boolean := false; v_n int;
begin
  select * into v from public.incidents i where i.org_id = p_org and i.dedupe_key = p_dedupe and i.status <> 'resolved' for update;
  if v.id is null then
    select * into v from public.incidents i where i.org_id = p_org and i.dedupe_key = p_dedupe and i.status = 'resolved'
       and i.resolved_at > now() - interval '10 minutes' order by i.resolved_at desc limit 1 for update;
    v_reo := v.id is not null;
  end if;
  if p_ip is not null then
    select count(*) into v_n from public.edge_hits h where h.org_id = p_org and h.ip = p_ip and h.ts >= coalesce(v.started_at, p_started);
  end if;
  if v.id is null then
    insert into public.incidents (org_id, connection_id, rule_ids, severity, title, resource, details, dedupe_key, started_at, event_count)
    values (p_org, p_conn, p_rules, p_severity, p_title, p_resource,
            p_details || jsonb_build_object('detected_at', now()),        -- hito «detected» (incidents no tiene created_at)
            p_dedupe, coalesce(p_started, now()), greatest(coalesce(v_n, 1), 1))   -- started_at es not null
    returning * into v;
    v_new := true;
  else
    v_prev := v.severity;
    update public.incidents i set
      rule_ids = (select array_agg(distinct x order by x) from unnest(i.rule_ids || p_rules) x),
      severity = case when private.sev_rank(p_severity) > i.severity_rank then p_severity else i.severity end,
      title    = case when private.sev_rank(p_severity) > i.severity_rank then p_title else i.title end,
      -- details se renueva, pero se conservan nuestras marcas de tiempo para la línea de tiempo (E17)
      details = p_details || jsonb_strip_nulls(jsonb_build_object(
                  'detected_at', coalesce(i.details->'detected_at', to_jsonb(now())),
                  'muted_at', i.details->'muted_at',
                  'contexto', i.details->'contexto',                                 -- M24 de §02 (P1/P2)
                  'severity_up_at', case when private.sev_rank(p_severity) > i.severity_rank then to_jsonb(now())
                                         else i.details->'severity_up_at' end)),
      last_event_at = now(),
      event_count = case when p_ip is not null then greatest(coalesce(v_n, 1), i.event_count) else i.event_count + 1 end,
      status = case when v_reo then 'open' else i.status end,
      resolved_at = case when v_reo then null else i.resolved_at end
    where i.id = v.id returning * into v;
  end if;
  return query select v.id, v.code, v.severity, v_prev, v_new, v_reo, v.status, v.muted_until;
end $$;

-- PUT /api/orgs/:org/contacts (E26) reemplaza la lista en UNA transacción (un 23505 no deja la org sin contactos).
-- Upsert por (org_id, phone_e164): conserva verified_at de los teléfonos que no cambian (§06: solo se envía a verificados)
-- y borra los que faltan. Nunca delete + insert de todo, que dejaría verified_at en null en cada PUT.
create or replace function public.vg_replace_contacts(p_org uuid, p_rows jsonb) returns setof public.contacts
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.contacts c where c.org_id = p_org
     and c.phone_e164 not in (select r->>'phone_e164' from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r);
  return query with up as (
    insert into public.contacts as c (org_id, name, phone_e164, whatsapp, voice, priority)
    select p_org, r->>'name', r->>'phone_e164', coalesce((r->>'whatsapp')::boolean, true),
           coalesce((r->>'voice')::boolean, false), coalesce((r->>'priority')::smallint, 1)
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
    on conflict (org_id, phone_e164) do update
      set name = excluded.name, whatsapp = excluded.whatsapp, voice = excluded.voice, priority = excluded.priority
    returning *) select * from up order by up.priority;                      -- verified_at no se toca
end $$;

revoke all on function public.vg_upsert_incident(uuid, uuid, text, text[], text, text, text, jsonb, inet, timestamptz),
  public.vg_replace_contacts(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.vg_upsert_incident(uuid, uuid, text, text[], text, text, text, jsonb, inet, timestamptz),
  public.vg_replace_contacts(uuid, jsonb) to service_role;
alter table public.incidents enable row level security;   alter table public.contacts enable row level security;
alter table public.notifications enable row level security; alter table public.approvals enable row level security;
alter table public.actions enable row level security;     alter table public.webhook_events enable row level security;
