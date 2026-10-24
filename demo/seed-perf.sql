-- demo/seed-perf.sql · siembra de Rendimiento de la demo (PLAN_MAESTRO §10.11, RND-06) · ORQUESTADOR
-- Lo GENERA scripts/perf-medir.ts: no se escribe a mano ni se inventan filas. Cada bloque «>>> medicion <run_group>» es
-- una medición real de PageSpeed Insights (una URL, una estrategia, 3 repeticiones o las de --reps) con su hora real
-- (created_at = lighthouseResult.fetchTime), trigger 'seed', scan_run_id null y la version_label de --version.
-- Dónde: accshmgmfrqrxubpuxcl (editor SQL o MCP de Supabase), después de 0007 y de supabase/seed/demo.sql (§05.11).
-- Re-aplicarlo entero es seguro: cada bloque borra su run_group y lo vuelve a insertar, y el run_group sale de lo medido
-- (no del azar), así que regenerar con --from-dir reemplaza el bloque en lugar de duplicarlo.
-- Sin claves: solo cifras, URLs de nuestras zonas, la versión y, cuando exista packages/core/src/perf, el diagnóstico.
-- Si a las 19:00 no hay ningún bloque debajo, vale el plan B: las filas manuales de supabase/seed/demo.sql.
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'perf_runs' and column_name = 'run_group') then
    raise exception 'perf_runs sin las columnas de §10.5: esta no es la base de VanGUARD o falta 0007';
  end if;
  if not exists (select 1 from public.orgs where id = '00000000-0000-4000-a000-00000000de00' and is_demo) then
    raise exception 'Falta la org de demo: aplica antes supabase/seed/demo.sql (§05.11)';
  end if;
end $$;
