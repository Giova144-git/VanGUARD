-- 0025_historial_hallazgos.sql · historial de fallas (E13h y E13t). findings guardaba cuándo se vio una falla por
-- primera y por última vez y cuándo la verificó una auditoría, pero no cuándo se marcó corregida a mano, cuándo se
-- ignoró ni si reapareció tras corregirse (vg_upsert_findings y vg_review_findings la reabren y borran verified_at).
-- Eso no se puede sacar de lo que hay: audit_snapshots solo dice qué estaba abierto al cerrar cada auditoría (una cota,
-- no la hora) y no ve lo que se marca o reabre entre dos auditorías. Esta migración es aditiva:
--   - cinco columnas nulas o con valor por defecto en findings (fixed_at, ignored_at, reopened_at, reopen_count y
--     status_changed_at, el orden del historial) y un índice por org y fecha;
--   - un trigger BEFORE UPDATE OF status que las escribe en cada cambio de estado, venga de donde venga (E14, la
--     auto-verificación, la reapertura de una auditoría o de una revisión de código). No redefine ninguna función;
--   - un relleno de las filas que ya existían con lo que dicen las fotos de audit_snapshots (0015): la última foto que ya
--     no la vio (corregida a más tardar entonces), la que la vio ignorada y las que la vieron nueva tras salir.
-- RLS: findings ya la tiene (0008) y las columnas nuevas no llevan grants: anon y authenticated no leen findings
-- (0008h, decisión (a)); solo el Worker con service_role. Sin trigger de Realtime nuevo: el vg_broadcast de findings ya
-- emite cada UPDATE (durante el relleno se apaga, para no mandar un aviso por fila). Va ANTES del Worker que pide estas
-- columnas en E13h/E13t (sin ellas, PostgREST rechaza la consulta entera; E13, E13b y E14 no cambian).
-- Prueba: supabase/tests/historial-hallazgos.sql (pegada detrás, «RESULTADO …»).

alter table public.findings add column if not exists fixed_at timestamptz;
alter table public.findings add column if not exists ignored_at timestamptz;
alter table public.findings add column if not exists reopened_at timestamptz;
alter table public.findings add column if not exists reopen_count int not null default 0 check (reopen_count >= 0);
alter table public.findings add column if not exists status_changed_at timestamptz not null default now();
create index if not exists findings_org_cambio_idx on public.findings (org_id, status_changed_at desc, id);

-- 1) Cada cambio de estado deja su fecha. «reapareció…» es el motivo que ponen vg_upsert_findings (0004) y
-- vg_review_findings (0013) al reabrir una corregida o verificada: eso cuenta como reaparición. Cualquier otro paso a
-- open es «Reabrir» a mano (E14): deshace la marca de corregida o de ignorada.
create or replace function private.vg_findings_historial() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  new.status_changed_at := now();
  if new.status = 'fixed' then
    new.fixed_at := now();
  elsif new.status = 'ignored' then
    new.ignored_at := now();
  elsif new.status = 'open' then
    if old.status in ('fixed', 'verified') and starts_with(coalesce(new.status_reason, ''), 'reapareció') then
      new.reopened_at := now();
      new.reopen_count := old.reopen_count + 1;
    else
      if old.status = 'fixed' then new.fixed_at := null; end if;
      if old.status = 'ignored' then new.ignored_at := null; end if;
    end if;
  end if;
  -- 'verified': verified_at ya lo pone quien verifica; fixed_at se queda (corregida a mano y luego comprobada).
  return new;
end $$;
revoke all on function private.vg_findings_historial() from public, anon, authenticated;
drop trigger if exists vg_findings_historial on public.findings;
create trigger vg_findings_historial before update of status on public.findings
  for each row execute function private.vg_findings_historial();

-- 2) Relleno desde las fotos (solo las filas que aún no lo tienen: reopen_count 0 y sin fechas nuevas). p_org null =
-- todas las orgs. Las fechas son las de la foto, es decir, «a más tardar»: la hora exacta no se guardó. Una falla que
-- se marcó corregida o se ignoró después de la última foto se queda sin fecha (null): no se inventa.
create or replace function private.vg_rellenar_historial(p_org uuid default null) returns int
language plpgsql set search_path = '' as $$
declare n int;
begin
  with fotos as (
    select f.id,
      (select max(s.taken_at) from public.audit_snapshots s
        where s.org_id = f.org_id and f.id = any(s.fixed_ids)) as salio,
      (select max(s.taken_at) from public.audit_snapshots s
        where s.org_id = f.org_id and f.id = any(s.ignored_ids)) as ignoro,
      (select array_agg(s.taken_at order by s.taken_at) from public.audit_snapshots s
        where s.org_id = f.org_id and f.id = any(s.new_ids)
          and exists (select 1 from public.audit_snapshots p
                       where p.org_id = f.org_id and f.id = any(p.fixed_ids) and p.taken_at < s.taken_at)) as vuelve
      from public.findings f
     where (p_org is null or f.org_id = p_org) and f.reopen_count = 0
       and f.fixed_at is null and f.ignored_at is null and f.reopened_at is null),
  calc as (
    select x.id,
           case when f.status = 'fixed' and x.salio > coalesce(x.vuelve[cardinality(x.vuelve)], f.first_seen_at)
                then x.salio end as fixed_at,
           case when f.status = 'ignored' then x.ignoro end as ignored_at,
           x.vuelve[cardinality(x.vuelve)] as reopened_at,
           coalesce(cardinality(x.vuelve), 0) as reopen_count
      from fotos x join public.findings f on f.id = x.id)
  update public.findings f
     set fixed_at = c.fixed_at, ignored_at = c.ignored_at, reopened_at = c.reopened_at, reopen_count = c.reopen_count,
         status_changed_at = greatest(f.first_seen_at, c.fixed_at, f.verified_at, c.ignored_at, c.reopened_at)
    from calc c
   where f.id = c.id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function private.vg_rellenar_historial(uuid) from public, anon, authenticated;

alter table public.findings disable trigger vg_broadcast;
select private.vg_rellenar_historial();
alter table public.findings enable trigger vg_broadcast;
