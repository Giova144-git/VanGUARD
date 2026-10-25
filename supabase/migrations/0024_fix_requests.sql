-- 0024_fix_requests.sql · cola «Enviar a mi IA»: el usuario pulsa el botón en el detalle de un hallazgo (o en «Ahora») y
-- la web crea una petición; su IA la ve por el MCP (list_fix_requests) y, al pedir la corrección (get_fix_prompt o el
-- prompt resolver_hallazgo), el Worker la pasa a «arreglando». «corregido» lo pone la base cuando el hallazgo deja de
-- estar abierto (auto-verificación de vg_upsert_findings, «Marcar corregido» de E14 o cualquier otra vía); un hallazgo
-- ignorado cancela la suya. Estados: enviado → arreglando → corregido; enviado|arreglando → cancelado (E58 DELETE).
-- Como el resto de public (decisión (a)): el navegador no lee tablas, solo el Worker (service_role) toca la tabla; las
-- políticas dejan escrita la regla de la org por si algún día hay grants (miembros leen; owner/admin no anónimo crean
-- una petición «enviado» suya y solo la cancelan). Una petición abierta por hallazgo como mucho (índice parcial único).
-- Realtime: el broadcast privado org:<id> de 0008b/0008e (solo table, operación e ids). Prueba: tests/fix-requests.sql.

-- La FK compuesta (finding_id, org_id) impide una petición que apunte a un hallazgo de otra org.
create unique index if not exists findings_id_org_uidx on public.findings (id, org_id);

create table if not exists public.fix_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  finding_id uuid not null,
  requested_by uuid references auth.users(id) on delete set null,
  status text not null default 'enviado' check (status in ('enviado','arreglando','corregido','cancelado')),
  client text check (client in ('claude_code','vscode','copiar')),            -- por dónde dijo que lo mandaba
  mcp_token_id uuid references public.mcp_tokens(id) on delete set null,     -- el token que la pasó a «arreglando»
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  closed_at timestamptz,
  foreign key (finding_id, org_id) references public.findings (id, org_id) on delete cascade,
  check ((status in ('enviado','arreglando')) = (closed_at is null)),
  check (status <> 'arreglando' or started_at is not null));
create unique index if not exists fix_requests_abierta_uidx on public.fix_requests (finding_id)
  where status in ('enviado','arreglando');
create index if not exists fix_requests_org_idx on public.fix_requests (org_id, created_at desc);

alter table public.fix_requests enable row level security;
revoke all on public.fix_requests from public, anon, authenticated;
grant select, insert, update, delete on public.fix_requests to service_role;

drop policy if exists fix_requests_sel on public.fix_requests;
create policy fix_requests_sel on public.fix_requests for select to authenticated
  using (org_id in (select private.user_org_ids())
    and (coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
         or org_id in (select private.demo_org_ids())));
drop policy if exists fix_requests_ins on public.fix_requests;
create policy fix_requests_ins on public.fix_requests for insert to authenticated
  with check (org_id in (select private.user_admin_org_ids())
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and requested_by = (select auth.uid()) and status = 'enviado' and mcp_token_id is null);
drop policy if exists fix_requests_upd on public.fix_requests;
create policy fix_requests_upd on public.fix_requests for update to authenticated
  using (org_id in (select private.user_admin_org_ids())
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false)
  with check (org_id in (select private.user_admin_org_ids()) and status = 'cancelado');

-- Transiciones válidas y columnas fijas, para cualquier rol (también service_role): una petición cerrada no se reabre
-- (se crea otra) y nadie la mueve de hallazgo ni de org.
create or replace function private.vg_fix_request_transicion() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.org_id <> old.org_id or new.finding_id <> old.finding_id or new.created_at <> old.created_at
     or new.requested_by is distinct from old.requested_by then
    raise exception 'fix_requests: org, hallazgo, autor y fecha no cambian' using errcode = '23514';
  end if;
  if new.status <> old.status and not (
       (old.status = 'enviado' and new.status in ('arreglando','corregido','cancelado'))
    or (old.status = 'arreglando' and new.status in ('corregido','cancelado'))) then
    raise exception 'fix_requests: transición % → % no válida', old.status, new.status using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke all on function private.vg_fix_request_transicion() from public, anon, authenticated;
drop trigger if exists vg_fix_request_transicion on public.fix_requests;
create trigger vg_fix_request_transicion before update on public.fix_requests
  for each row execute function private.vg_fix_request_transicion();

-- El hallazgo deja de estar abierto → su petición abierta se cierra: fixed/verified = corregido, ignored = cancelado.
-- Cubre la auto-verificación de la auditoría (vg_upsert_findings), «Marcar corregido» (E14) y la revisión de código.
create or replace function private.vg_fix_request_cierre() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.fix_requests
     set status = case when new.status = 'ignored' then 'cancelado' else 'corregido' end, closed_at = now()
   where finding_id = new.id and org_id = new.org_id and status in ('enviado','arreglando');
  return null;
end $$;
revoke all on function private.vg_fix_request_cierre() from public, anon, authenticated;
drop trigger if exists vg_fix_request_cierre on public.findings;
create trigger vg_fix_request_cierre after update of status on public.findings
  for each row when (old.status = 'open' and new.status <> 'open')
  execute function private.vg_fix_request_cierre();

-- Realtime: mismo broadcast que findings (solo table, operación e ids; 0008e).
drop trigger if exists vg_broadcast on public.fix_requests;
create trigger vg_broadcast after insert or update on public.fix_requests
  for each row execute function private.broadcast_org_change();

-- Retención: las cerradas, 90 días (las de un hallazgo purgado se van antes, por la FK en cascada).
select cron.schedule('vg-purge-fix-requests', '25 7 * * *',
  $$delete from public.fix_requests where closed_at < now() - interval '90 days'$$);
