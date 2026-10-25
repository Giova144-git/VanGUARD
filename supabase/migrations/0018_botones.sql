-- 0018_botones.sql · Botones de acción rápida en los avisos de revisión por WhatsApp (docs/plan_maestro_trabajo/
-- asignaciones/avisos-whatsapp-botones.md). Reaplicable y sin tablas nuevas: una columna en code_review_configs, dos en
-- code_reviews y una en approvals, con sus checks. vg_redeem_approval (0005) no cambia: devuelve a.* y la columna nueva
-- viaja sola. Sin grants nuevos: las tres tablas ya son solo del Worker (0008 y 0013: RLS sin políticas, nada a anon ni
-- authenticated). El CODIGO de 6 caracteres de los botones de una revisión no lleva columna: sale de su id (los 6
-- primeros hex del uuid v4, codigoRevision en core/templates/whatsapp.ts).

-- 1) «Silenciar repo 1 h» (botón rvs): hasta cuándo el paso 'aviso' de la revisión de esa configuración no manda
-- WhatsApp (cierra not_sent/silenciado; la revisión, los hallazgos, el ✗ y el cierre de PR siguen). La RECONCILIACIÓN
-- la ponía en 0016: con if not exists conviven sin choque, se apliquen en el orden que sea.
alter table public.code_review_configs add column if not exists muted_until timestamptz;

-- 2) Lo último que se hizo con un botón del WhatsApp de esa revisión (CodeReviewAlert.whatsapp_action del contrato; la
-- app lo muestra como «Arreglo enviado por WhatsApp», «Silenciado 1 h», …).
alter table public.code_reviews add column if not exists whatsapp_action text;
alter table public.code_reviews add column if not exists whatsapp_action_at timestamptz;
alter table public.code_reviews drop constraint if exists code_reviews_whatsapp_action_chk;
alter table public.code_reviews add constraint code_reviews_whatsapp_action_chk
  check (whatsapp_action is null
         or (whatsapp_action in ('fix_sent', 'issue_created', 'muted', 'pr_reopened') and whatsapp_action_at is not null));

-- 3) approvals: un botón cuelga de un incidente (0005) o de una revisión, nunca de los dos. Borrar la revisión borra
-- sus botones (como incident_id). Acciones nuevas: send_fix («Enviarme el arreglo»), mute_repo («Silenciar repo 1 h»)
-- y, para cuando existan, create_issue («Crear issue») y reopen_pr («Reabrir el PR»); «Modo bajo ataque» usa
-- under_attack_on, que ya estaba. La lista de 0005 se conserva entera.
alter table public.approvals add column if not exists code_review_id uuid
  references public.code_reviews(id) on delete cascade;
alter table public.approvals drop constraint if exists approvals_action_kind_check;
alter table public.approvals add constraint approvals_action_kind_check
  check (action_kind in ('block_ip', 'unblock_ip', 'under_attack_on', 'under_attack_off', 'rate_limit', 'ack', 'mute',
                         'send_fix', 'mute_repo', 'create_issue', 'reopen_pr'));
alter table public.approvals drop constraint if exists approvals_un_origen;
alter table public.approvals add constraint approvals_un_origen check (incident_id is null or code_review_id is null);
alter table public.approvals drop constraint if exists approvals_revision_con_revision;
alter table public.approvals add constraint approvals_revision_con_revision
  check (action_kind not in ('send_fix', 'mute_repo', 'create_issue', 'reopen_pr') or code_review_id is not null);
-- El borrado en cascada de una revisión busca sus botones por esta columna.
create index if not exists approvals_code_review_idx on public.approvals (code_review_id) where code_review_id is not null;
