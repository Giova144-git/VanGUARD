-- 0019_medir_ahora.sql · «Medir ahora» de Rendimiento (función 5, PLAN_MAESTRO §10.4): una sola medición en curso por org.
-- E11 mira «en curso» (regla 409) y el cupo diario org_perf_day con un SELECT antes del INSERT, sin candado: varias
-- peticiones a la vez pasaban las dos comprobaciones y encolaban varias mediciones (cada una, hasta 3 llamadas a PSI con
-- los reintentos de la cola), saltándose el tope. Con este índice único parcial, de dos INSERT simultáneos Postgres deja
-- ganar a uno y el otro recibe 23505, que E11 convierte en 409 conflict (apps/api/src/rutas/scans.ts). Con una sola en
-- curso por org, el cupo tampoco se rebasa en ráfaga: la petición siguiente ya cuenta la anterior.
-- Solo kind 'lighthouse': full_audit, zip y los kinds de una fuente siguen con la regla de E11 sin cambios. Una medición
-- que se quede en curso sin avance la cierra el vigilante de 0011 (900 s), así que el índice no bloquea para siempre.
-- Sin datos que choquen al crearlo: hasta esta función E11 respondía not_available para 'lighthouse'.
create unique index if not exists scan_runs_lighthouse_en_curso on public.scan_runs (org_id)
  where kind = 'lighthouse' and status in ('queued', 'running');
