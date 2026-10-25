-- 0016_bloqueo_merge.sql · Bloqueo de merge con críticos (docs/plan_maestro_trabajo/asignaciones/bloqueo-merge-criticos.md
-- §3) y su anexo «VanGUARD cierra el PR con críticos» (bloqueo-merge-cierre-pr.md).
-- Sin tablas nuevas: (1) GitHub admite un token de acciones (estados de commit y, con el anexo, cerrar y reabrir PR), uno
-- por org; (2) configuración del bloqueo en code_review_configs; (3) lo que bloquea, lo publicado y lo hecho con el PR,
-- por revisión. Las tablas siguen solo del servidor: RLS sin políticas y nada para anon ni authenticated (0008h, 0013);
-- las columnas nuevas heredan los grants de su tabla. No toca vg_review_findings: lo que bloquea lo calcula el paso diff
-- y lo escribe antes de cerrar. Se aplica ANTES del deploy que lee las columnas gate_* (E45 las pide). No lleva
-- muted_until («Silenciar repo 1 h»): va en la 0018 de los botones de WhatsApp.

-- 1) connections: el check sin nombre de 0003 «kind = 'read' or provider = 'cloudflare'» pasa a admitir GitHub. Se
-- busca por su definición (Postgres le dio un nombre automático) y se cambia por uno con nombre.
do $$
declare
  v text[];
begin
  select coalesce(array_agg(c.conname), '{}') into v
    from pg_constraint c
   where c.conrelid = 'public.connections'::regclass and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%kind = ''read''::text%'
     and pg_get_constraintdef(c.oid) like '%provider = ''cloudflare''::text%';
  if cardinality(v) > 1 then raise exception 'más de un check kind/provider en connections: %', v; end if;
  if cardinality(v) = 1 then execute format('alter table public.connections drop constraint %I', v[1]); end if;
end $$;
alter table public.connections drop constraint if exists connections_accion_proveedor;
alter table public.connections add constraint connections_accion_proveedor
  check (kind = 'read' or provider in ('cloudflare', 'github'));
-- Un solo token de acciones de GitHub por org: E53 lo rota con vg_rotate_secret (mismo id) en vez de crear otro.
create unique index if not exists connections_github_accion_uidx on public.connections (org_id)
  where provider = 'github' and kind = 'action';

-- 2) Configuración del bloqueo, una por config de revisión. gate_min = severidad mínima que bloquea. gate_required,
-- gate_admins y gate_pr_required = lo que E53 leerá de GitHub con el token de LECTURA (P1; null = sin comprobar).
-- gate_last_error = el último fallo del TOKEN de estados al publicar: 401, 403 o 404 (lo borra una publicación buena o
-- E53). Un 422 es de un solo commit y va solo en code_reviews.gate_error. gate_close_pr = interruptor «Cerrar los PR
-- con críticos» (anexo): encendido por defecto; solo actúa si el token tiene «Pull requests: Read and write»
-- (connections.capabilities.pull_requests, lo comprueba E53).
alter table public.code_review_configs
  add column if not exists gate_enabled boolean not null default false,
  add column if not exists gate_min text not null default 'critical' check (gate_min in ('critical','high')),
  add column if not exists gate_required text check (gate_required in ('yes','no','other_source','unknown')),
  add column if not exists gate_admins text check (gate_admins in ('enforced','bypass','unknown')),
  add column if not exists gate_pr_required text check (gate_pr_required in ('yes','no','unknown')),
  add column if not exists gate_checked_at timestamptz,
  add column if not exists gate_last_error text check (gate_last_error in ('token','forbidden','not_found')),
  add column if not exists gate_last_error_at timestamptz,
  add column if not exists gate_close_pr boolean not null default true;

-- 3) Por revisión. gate_blocking = hallazgos de lo AÑADIDO con severidad ≥ gate_min que no tapa un ignored con el mismo
-- valor (null = no se calculó). OJO: no es counts (los NUEVOS; en un PR excluyen lo visto en el push anterior).
-- gate_findings = hasta 20 de esos, redactados como new_findings. gate_state = lo último que GitHub aceptó (201).
-- gate_error = por qué no se publicó. gate_override_* = «Dar por bueno» (E54).
-- Anexo de cierre de PR: gate_pr_action = closed (VanGUARD lo cerró) · reopened_by_human (alguien lo reabrió sin commits
-- nuevos: no se vuelve a cerrar) · reopened («Reabrir el PR» de E54 o del WhatsApp) · close_failed (ver gate_pr_error,
-- código corto como delivery_error). gate_pr_at = cuándo VanGUARD reclamó el cierre: con él, el comentario sale una sola
-- vez por revisión aunque el paso se repita. E47 pone todas estas columnas a null (gate_findings a '[]') al reabrir una
-- revisión failed con «Redeliver».
alter table public.code_reviews
  add column if not exists gate_blocking int check (gate_blocking >= 0),
  add column if not exists gate_findings jsonb not null default '[]'
    check (jsonb_typeof(gate_findings) = 'array' and jsonb_array_length(gate_findings) <= 20),
  add column if not exists gate_state text check (gate_state in ('pending','success','failure','error')),
  add column if not exists gate_published_at timestamptz,
  add column if not exists gate_error text check (gate_error ~ '^[a-z_]{2,40}$'),
  add column if not exists gate_override_by uuid references auth.users(id) on delete set null,
  add column if not exists gate_override_at timestamptz,
  add column if not exists gate_override_reason text check (char_length(gate_override_reason) between 3 and 200),
  add column if not exists gate_pr_action text
    check (gate_pr_action in ('closed','reopened_by_human','reopened','close_failed')),
  add column if not exists gate_pr_error text check (gate_pr_error ~ '^[a-z_]{2,40}$'),
  add column if not exists gate_pr_at timestamptz;
alter table public.code_reviews drop constraint if exists code_reviews_gate_limpio;
alter table public.code_reviews add constraint code_reviews_gate_limpio
  check (not private.looks_like_secret(gate_findings::text) and not private.looks_like_secret(gate_override_reason));
