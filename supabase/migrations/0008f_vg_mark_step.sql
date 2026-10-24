-- 0008f_vg_mark_step.sql · la cola vg-jobs (§15.8) marca el resultado de un paso sin reescribir steps[] entero.
-- Por la regla 2 (send(siguiente) ANTES de steps[i]) el paso siguiente puede reclamar y terminar antes de que el anterior
-- escriba: con el array completo desde una copia vieja, uno pisaba el estado del otro (running para siempre, progress
-- hacia atrás). Igual que vg_claim_step (0004): un UPDATE sobre la fila actual que solo cambia el elemento p_paso.
-- p_patch = {status, findings?, error_code?} sustituye el resultado del paso (se conserva el name); un p_patch sin
-- status no toca steps[] (puntaje solo avanza progress). progress nunca retrocede y una auditoría ya cerrada no cambia.
-- `step` no se toca: lo fija vg_claim_step al empezar cada paso y fin lo deja en null.
create or replace function public.vg_mark_step(p_scan uuid, p_paso text, p_patch jsonb, p_progress smallint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.scan_runs s
     set steps = coalesce((select jsonb_agg(case when e->>'name' = p_paso and (p_patch ? 'status')
                                                 then jsonb_build_object('name', e->'name') || (p_patch - 'name')
                                                 else e end order by o)
                             from jsonb_array_elements(s.steps) with ordinality as t(e, o)), '[]'::jsonb),
         progress = greatest(s.progress, p_progress)
   where s.id = p_scan and s.status in ('queued', 'running')
     and jsonb_typeof(p_patch) = 'object'
     and (not (p_patch ? 'status') or p_patch->>'status' in ('pending', 'running', 'done', 'skipped', 'failed'));
  get diagnostics n = row_count;
  return n = 1;
end $$;

revoke all on function public.vg_mark_step(uuid, text, jsonb, smallint) from public, anon, authenticated;
grant execute on function public.vg_mark_step(uuid, text, jsonb, smallint) to service_role;
