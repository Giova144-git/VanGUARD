-- 0021_evolucion_restar.sql · La resta de 0015 (private.vg_restar) solo emparejaba una clave movida (misma regla y
-- huella) entre las filas que salen y las que entran en el MISMO intervalo. Si la mudanza se reparte entre dos fotos
-- (una auditoría parcial o sin codebase guarda la clave en la línea nueva sin cerrar la vieja, y la siguiente completa
-- verifica la vieja), la clave salía como «nueva» en una foto y como «corregida · ya no está en el código» en la otra
-- mientras seguía abierta (asignaciones/evolucion-entre-revisiones.md §2.3 y §2.6: una clave que cambió de línea se
-- mantiene; nunca se afirma una corrección que no ocurrió). Ahora, después del 1 a 1 de 0015 (sin cambios), lo que sobra
-- se empareja también con las claves ABIERTAS EN LAS DOS FOTOS: una fila que entra con la regla y la huella de una que
-- ya estaba abierta y sigue abierta no es nueva; una que sale fixed/verified con las de una que sigue abierta no es
-- corregida. Las dos cuentan en moved («se mantiene»), como en 0013 (b): el mismo secreto abierto en otro sitio no es
-- nuevo. Las que salen ignored o borradas siguen como antes. Solo filas de la org (p_prev y p_open ya lo son, y el join
-- vuelve a filtrar por org_id). Precio: en la foto donde se empareja con una abierta, open = open anterior + new − fixed
-- − ignored − gone deja de cuadrar por esas filas (+1 la que entra, −1 la que sale); en la cadena se compensa cuando la
-- fila vieja se cierra. Sin el emparejamiento nuevo, todo da lo mismo que 0015 (tests/evolucion.sql, igual resultado).
-- Mismas firma, salidas, search_path vacío y revoke que en 0015; sin security definer (solo la llaman vg_snapshot_audit
-- y vg_review_snapshot, que ya corren como dueño): create or replace conserva sus permisos y el revoke se repite por si
-- acaso. Las fotos ya tomadas no se rehacen. Prueba: supabase/tests/evolucion-restar.sql (pegada detrás, «RESULTADO OK …»).
create or replace function private.vg_restar(p_org uuid, p_prev uuid[], p_open uuid[], out o_new uuid[],
  out o_fixed uuid[], out o_ignored uuid[], out o_moved int, out o_gone int, out o_checked int)
language sql stable set search_path = '' as $$
  with salen as (
    select g.id, f.status, f.rule_id, f.evidence->>'fingerprint_short' as fp
      from unnest(array(select unnest(p_prev) except select unnest(p_open))) as g(id)
      left join public.findings f on f.id = g.id and f.org_id = p_org),
  entran as (
    select g.id, f.rule_id, f.evidence->>'fingerprint_short' as fp
      from unnest(array(select unnest(p_open) except select unnest(p_prev))) as g(id)
      left join public.findings f on f.id = g.id and f.org_id = p_org),
  -- Claves (regla + huella) con alguna fila abierta en las dos fotos.
  siguen as (
    select distinct f.rule_id, f.evidence->>'fingerprint_short' as fp
      from unnest(array(select unnest(p_prev) intersect select unnest(p_open))) as g(id)
      join public.findings f on f.id = g.id and f.org_id = p_org
     where f.evidence->>'fingerprint_short' is not null),
  s as (select x.id, x.rule_id, x.fp, row_number() over (partition by x.rule_id, x.fp order by x.id) as n
          from salen x where x.fp is not null and x.status in ('fixed', 'verified')),
  e as (select x.id, x.rule_id, x.fp, row_number() over (partition by x.rule_id, x.fp order by x.id) as n
          from entran x where x.fp is not null),
  pares as (select s.id as sale, e.id as entra from s join e on e.rule_id = s.rule_id and e.fp = s.fp and e.n = s.n),
  -- Lo que sobra del 1 a 1 y casa con una clave que sigue abierta: cada fila cuenta una vez en moved.
  sobran as (
    select x.id as sale, null::uuid as entra from s x
     where not exists (select 1 from pares p where p.sale = x.id)
       and exists (select 1 from siguen k where k.rule_id = x.rule_id and k.fp = x.fp)
    union all
    select null::uuid, x.id from e x
     where not exists (select 1 from pares p where p.entra = x.id)
       and exists (select 1 from siguen k where k.rule_id = x.rule_id and k.fp = x.fp)),
  movidas as (select p.sale, p.entra from pares p union all select m.sale, m.entra from sobran m)
  select coalesce((select array_agg(x.id order by x.id) from entran x
                    where not exists (select 1 from movidas p where p.entra = x.id)), '{}'),
         coalesce((select array_agg(x.id order by x.id) from salen x where x.status in ('fixed', 'verified')
                    and not exists (select 1 from movidas p where p.sale = x.id)), '{}'),
         coalesce((select array_agg(x.id order by x.id) from salen x where x.status = 'ignored'), '{}'),
         (select count(*)::int from movidas),
         (select count(*)::int from salen x where x.status is null),
         (select count(*)::int from salen x where x.status = 'verified' and not private.vg_es_clave(x.rule_id)
             and not exists (select 1 from movidas p where p.sale = x.id))
$$;

revoke all on function private.vg_restar(uuid, uuid[], uuid[]) from public, anon, authenticated;
