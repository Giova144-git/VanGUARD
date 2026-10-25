-- 0024_evolucion_sin_zip.sql · ux-revision-develop P0-5: un ZIP (otro proyecto subido a mano) no es una versión del
-- ecosistema. Su «puntaje 100» salía como punto de partida de la evolución y la auditoría del repo, como «−51 desde la
-- primera del periodo». (1) vg_versiones (E52) ya no cuenta los scan_runs de kind zip. (2) vg_snapshot_audit no toma
-- foto de un ZIP (reason 'zip'): así tampoco es la «anterior» de la siguiente auditoría. Las fotos de ZIP ya tomadas no
-- se borran (son datos), pero vg_versiones ya no las enseña ni sirven de anterior. Mismas firmas y permisos (create or replace).
-- Prueba: supabase/tests/evolucion-sin-zip.sql.

create or replace function private.vg_versiones(p_org uuid, p_desde timestamptz)
returns table (scan_id uuid, kind text, score smallint, steps jsonb, snap boolean, t timestamptz, modules_seen text[],
               is_first boolean, counts jsonb, ignored int, gone int, fixed_checked int)
language sql stable set search_path = '' as $$
  select r.id, r.kind, r.score, r.steps, a.scan_run_id is not null, coalesce(a.taken_at, r.finished_at), a.modules_seen,
         a.is_first, a.counts, cardinality(a.ignored_ids), a.gone, a.fixed_checked
    from public.scan_runs r
    left join public.audit_snapshots a on a.scan_run_id = r.id and a.org_id = p_org
   where r.org_id = p_org and r.kind not in ('lighthouse', 'zip')
     and r.created_at >= p_desde - interval '1 day'    -- una auditoría dura minutos (el vigilante corta a los 15)
     and (a.scan_run_id is not null or (r.status = 'succeeded' and r.score is not null and r.finished_at is not null))
     and coalesce(a.taken_at, r.finished_at) >= p_desde
$$;

create or replace function public.vg_snapshot_audit(p_org uuid, p_scan uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_kind text;
  v_steps jsonb;
  v_seen text[];
  v_at timestamptz;
  v_open uuid[];
  v_prev uuid;
  v_prev_open uuid[];
  v_new uuid[] := '{}';
  v_kept uuid[] := '{}';
  v_fixed uuid[] := '{}';
  v_ign uuid[] := '{}';
  v_moved int := 0;
  v_gone int := 0;
  v_checked int := 0;
  a public.audit_snapshots%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('vg_snap|' || p_org::text));
  select s.kind, s.steps into v_kind, v_steps from public.scan_runs s where s.id = p_scan and s.org_id = p_org;
  if v_kind is null or v_kind = 'lighthouse' then
    return jsonb_build_object('applied', false, 'reason', 'scan');
  end if;
  -- 0024: un ZIP es otro proyecto subido a mano, no una versión del ecosistema: sin foto ni sitio en la cadena.
  if v_kind = 'zip' then
    return jsonb_build_object('applied', false, 'reason', 'zip');
  end if;
  -- Una foto no se rehace: un reintento de puntaje o finalizar devuelven la que hay. Ninguna foto cambia después de que
  -- otra la tomó como anterior.
  select * into a from public.audit_snapshots x where x.scan_run_id = p_scan;
  if a.scan_run_id is not null then
    return jsonb_build_object('applied', true, 'repeated', true, 'first', a.is_first, 'open', cardinality(a.open_ids),
      'new', cardinality(a.new_ids),
      'kept', case when a.is_first then 0 else cardinality(a.open_ids) - cardinality(a.new_ids) end,
      'fixed', cardinality(a.fixed_ids), 'ignored', cardinality(a.ignored_ids), 'moved', a.moved, 'gone', a.gone);
  end if;
  v_seen := private.vg_modulos_vistos(v_steps);
  if cardinality(v_seen) = 0 then
    return jsonb_build_object('applied', false, 'reason', 'sin_modulos');   -- nunca una versión sin mirar nada
  end if;
  v_at := clock_timestamp();
  select coalesce(array_agg(f.id order by f.id), '{}') into v_open
    from public.findings f where f.org_id = p_org and f.status = 'open';
  select x.scan_run_id, x.open_ids into v_prev, v_prev_open from public.audit_snapshots x
   where x.org_id = p_org and x.kind <> 'zip'   -- 0024: una foto de ZIP de antes no es la anterior
   order by x.taken_at desc, x.scan_run_id desc limit 1;
  if v_prev is not null then
    select r.o_new, r.o_fixed, r.o_ignored, r.o_moved, r.o_gone, r.o_checked
      into v_new, v_fixed, v_ign, v_moved, v_gone, v_checked
      from private.vg_restar(p_org, v_prev_open, v_open) r;
    v_kept := array(select unnest(v_open) except select unnest(v_new));   -- incluye las claves que cambiaron de línea
  end if;
  insert into public.audit_snapshots (scan_run_id, org_id, kind, taken_at, modules_seen, open_ids, prev_scan_run_id,
                                      is_first, new_ids, fixed_ids, ignored_ids, moved, gone, counts, fixed_checked)
  values (p_scan, p_org, v_kind, v_at, v_seen, v_open, v_prev, v_prev is null, v_new, v_fixed, v_ign, v_moved, v_gone,
          jsonb_build_object('open', private.vg_matriz(p_org, v_open), 'new', private.vg_matriz(p_org, v_new),
                             'kept', private.vg_matriz(p_org, v_kept), 'fixed', private.vg_matriz(p_org, v_fixed),
                             'ignored', private.vg_matriz(p_org, v_ign)),
          v_checked)
  on conflict (scan_run_id) do nothing;
  return jsonb_build_object('applied', true, 'first', v_prev is null, 'open', cardinality(v_open),
    'new', cardinality(v_new), 'kept', cardinality(v_kept), 'fixed', cardinality(v_fixed),
    'ignored', cardinality(v_ign), 'moved', v_moved, 'gone', v_gone);
end $$;

