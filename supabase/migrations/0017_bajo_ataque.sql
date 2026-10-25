-- 0017_bajo_ataque.sql · «Modo bajo ataque» (asignaciones/modo-bajo-ataque.md §4). Sin tablas nuevas: reusa actions y
-- approvals (0005), cuyos check ya admiten under_attack_on y under_attack_off. Sin grants nuevos: 0008 dejó RLS en
-- actions y 0008h quitó todo a anon y authenticated en public; el Worker usa service_role (0008c). Reaplicable.
-- Prueba: supabase/tests/bajo-ataque.sql.

-- D7: un solo modo bajo ataque vivo (en curso o activo) por org y objetivo (host o zona). Dos aprobaciones confirmadas a
-- la vez no crean dos reglas en Cloudflare: la segunda inserción da 23505 y executeUnderAttack devuelve la primera.
-- Cuenta CUALQUIER proposed: E55 y E56 la tratan como en_curso y housekeeping limpia la huérfana a los 2 min (EN_CURSO_MS).
create unique index if not exists actions_bajo_ataque_vivo_uq on public.actions (org_id, target)
  where kind = 'under_attack_on' and status in ('proposed', 'executed');

-- D8: una fila de bajo ataque nace sabiendo deshacerse (conexión, zona y alcance en previous, ya en proposed).
-- coalesce en scope: sin él, un previous sin scope daría null en el «in» y el check lo dejaría pasar.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'actions_bajo_ataque_previous_chk' and conrelid = 'public.actions'::regclass) then
    alter table public.actions add constraint actions_bajo_ataque_previous_chk check (
      kind <> 'under_attack_on'
      or (previous is not null and jsonb_typeof(previous) = 'object' and previous ? 'connection_id' and previous ? 'zone_id'
          and coalesce(previous->>'scope', '') in ('host', 'zone')));
  end if;
end $$;
