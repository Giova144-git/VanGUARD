-- supabase/tests/evolucion.sql · 0015: fotos de auditoría (primera, resta de conjuntos, repetición, orden de la cadena,
-- claves quitadas sin rotar y claves que cambian de línea, filas borradas), E51 (kept vacío en la primera, horas con Z,
-- anterior borrada), fotos de push (primera, corregido entre pushes, repetición, PR y otra org), E52 (punto sin foto,
-- orden, recorte, totales, revisiones, incidentes, tiempo hasta comprobar sin claves, límites), IDOR y privilegios.
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0015 (o pegado detrás de la migración en la misma
-- llamada, para probarla antes de aplicarla). Usa las orgs idor-a e idor-b. Siempre termina en ERROR a propósito: el
-- mensaje lleva el resultado y la excepción deshace todo (no queda ninguna fila de prueba). «RESULTADO OK …» = todo
-- bien; «RESULTADO DISTINTO …» trae lo obtenido y lo esperado (la variable `esperado` del bloque).
-- Resultado esperado (probado en PGlite 0.3.14 encima de 0001–0014; Supabase es la referencia):
--   RESULTADO OK 1 A:true/4/codebase,supabase kept=0/0 |
--   2 B: new=1 kept=1 fixed=2 ign=1 chk=1 mat=1/1/2/1/2 f3=true |
--   3 delta: prev=true/30 kept=1 fixed=2 primero=high z=true/true |
--   4 rep=true new=1 t=true C.prev=B:true B.prev=A:true t=true |
--   5 D: new=3 E: new=0 kept=3 fixed=1 moved=1 gone=1 chk=0 k1=true k2b=true matfixed=1 cuadra=true |
--   6 idor=false/false sin_modulos/scan en_curso/sin_foto |
--   7 push: R1=true/3/2 R2=false/2/2/1/0/0 prev=true/true rep=true pr=false running=false otra_org=false |
--   8 evo: puntos=6 viejo=false/40/null orden=true trunc=false/true/2 tot=6/5/40/4/3/1/1/1 trunc_tot=6
--   revs=3/null inc=1/1 mttr=1 z=true dias=1/90/6 otra_org=1 |
--   9 borrar: foto=0 prev=null fixed=2 | 10 priv: tabla=0 funciones=0
create or replace function pg_temp.h(p_org uuid, p_mod text, p_rule text, p_sev text, p_res text, p_fp text)
returns uuid language sql as $$
  insert into public.findings (org_id, module, rule_id, severity, title, resource, evidence, dedupe_key)
  values (p_org, p_mod, p_rule, p_sev, 'Prueba ' || p_rule, p_res,
          case when p_fp is null then '{}'::jsonb else jsonb_build_object('fingerprint_short', p_fp) end,
          encode(sha256(convert_to('evo|' || p_org || '|' || p_rule || '|' || p_res, 'UTF8')), 'hex'))
  returning id
$$;
create or replace function pg_temp.aud(p_org uuid, p_kind text, p_steps jsonb, p_status text, p_score int)
returns uuid language sql as $$
  insert into public.scan_runs (org_id, kind, status, steps, score, finished_at)
  values (p_org, p_kind, p_status, p_steps, p_score, case when p_status in ('succeeded', 'failed') then now() end)
  returning id
$$;
create or replace function pg_temp.est(p_id uuid, p_status text) returns void language sql as $$
  update public.findings set status = p_status, verified_at = case when p_status = 'verified' then now() end
   where id = p_id
$$;
create or replace function pg_temp.rev(p_org uuid, p_cfg uuid, p_event text, p_status text, p_new jsonb)
returns uuid language sql as $$
  insert into public.code_reviews (org_id, config_id, event, branch, pr_number, base_sha, head_sha, status, new_findings,
                                   finished_at)
  values (p_org, p_cfg, p_event, 'main', case when p_event = 'pull_request' then 7 end, repeat('0', 39) || '1',
          left(encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 40), p_status, p_new, now())
  returning id
$$;
-- Total de una matriz módulo × severidad.
create or replace function pg_temp.tot(m jsonb) returns int language sql immutable as $$
  select coalesce(sum(v.value::int), 0)::int from jsonb_each(m) mo, jsonb_each_text(mo.value) v
$$;

do $$
declare
  o uuid := (select id from public.orgs where slug = 'idor-a');
  ob uuid := (select id from public.orgs where slug = 'idor-b');
  pasos jsonb := '[{"name":"supabase","status":"done"},{"name":"cloudflare","status":"failed"},'
                 '{"name":"repo","status":"done"},{"name":"puntaje","status":"done"}]';
  cn uuid := gen_random_uuid();
  cf uuid := gen_random_uuid();
  f1 uuid; f2 uuid; f3 uuid; f5 uuid; f6 uuid; k1 uuid; k2 uuid; k2b uuid; g1 uuid;
  viejo uuid; a uuid; b uuid; c uuid; d uuid; e uuid; sb uuid; x uuid; r1 uuid; r2 uuid; rp uuid;
  j jsonb; j1 jsonb; j2 jsonb;
  t1 timestamptz;
  n int;
  s text := '';
  esperado text := ''
    || '1 A:true/4/codebase,supabase kept=0/0'
    || ' | '
    || '2 B: new=1 kept=1 fixed=2 ign=1 chk=1 mat=1/1/2/1/2 f3=true'
    || ' | '
    || '3 delta: prev=true/30 kept=1 fixed=2 primero=high z=true/true'
    || ' | '
    || '4 rep=true new=1 t=true C.prev=B:true B.prev=A:true t=true'
    || ' | '
    || '5 D: new=3 E: new=0 kept=3 fixed=1 moved=1 gone=1 chk=0 k1=true k2b=true matfixed=1 cuadra=true'
    || ' | '
    || '6 idor=false/false sin_modulos/scan en_curso/sin_foto'
    || ' | '
    || '7 push: R1=true/3/2 R2=false/2/2/1/0/0 prev=true/true rep=true pr=false running=false otra_org=false'
    || ' | '
    || '8 evo: puntos=6 viejo=false/40/null orden=true trunc=false/true/2 tot=6/5/40/4/3/1/1/1 trunc_tot=6'
    || ' revs=3/null inc=1/1 mttr=1 z=true dias=1/90/6 otra_org=1'
    || ' | '
    || '9 borrar: foto=0 prev=null fixed=2'
    || ' | '
    || '10 priv: tabla=0 funciones=0';
begin
  -- Hermética: la siembra de idor-a/idor-b trae 1 hallazgo abierto y 1 incidente resuelto por org que sumarían +1 a
  -- los conteos. Se quitan aquí dentro; el raise final lo deshace todo y la siembra vuelve a su sitio.
  delete from public.incidents where org_id in (select id from public.orgs where slug in ('idor-a','idor-b'));
  delete from public.findings where org_id in (select id from public.orgs where slug in ('idor-a','idor-b'));

  -- 0) Una auditoría anterior a 0015: terminada, con puntaje 40 y sin foto
  viejo := pg_temp.aud(o, 'full_audit', pasos, 'succeeded', 40);

  -- 1) A: primera foto. Cloudflare falló: no está en modules_seen. E51 de la primera: kept vacío y en 0
  f1 := pg_temp.h(o, 'supabase', 'SB_RLS_DISABLED', 'high', 'public.a', null);
  f2 := pg_temp.h(o, 'codebase', 'CB_DEP_VULN', 'low', 'npm:a@1', null);
  f5 := pg_temp.h(o, 'codebase', 'CB_GITIGNORE_NO_ENV', 'medium', '.gitignore', null);
  f6 := pg_temp.h(o, 'supabase', 'SB_ADVISOR_X', 'low', 'public.b', null);
  a := pg_temp.aud(o, 'full_audit', pasos, 'succeeded', 30);
  j := public.vg_snapshot_audit(o, a);
  s := s || '1 A:' || (j->>'first') || '/' || (j->>'open') || '/'
         || (select array_to_string(x.modules_seen, ',') from public.audit_snapshots x where x.scan_run_id = a);
  j := public.vg_audit_delta(o, a, 50);
  s := s || ' kept=' || (j->'kept'->>'total') || '/' || pg_temp.tot(j->'counts'->'kept') || ' | ';

  -- 2) Entre A y B: f1 verified, f5 fixed (a mano), f6 ignored, f3 nuevo, f2 sigue. scan_run_id es null en todos: no
  -- depende de él
  perform pg_temp.est(f1, 'verified');
  perform pg_temp.est(f5, 'fixed');
  perform pg_temp.est(f6, 'ignored');
  f3 := pg_temp.h(o, 'codebase', 'CB_DEP_VULN', 'critical', 'npm:b@1', null);
  b := pg_temp.aud(o, 'full_audit', pasos, 'succeeded', 45);
  j := public.vg_snapshot_audit(o, b);
  s := s || '2 B: new=' || (j->>'new') || ' kept=' || (j->>'kept') || ' fixed=' || (j->>'fixed')
         || ' ign=' || (j->>'ignored')
         || (select ' chk=' || x.fixed_checked || ' mat=' || pg_temp.tot(x.counts->'new') || '/'
                    || pg_temp.tot(x.counts->'kept') || '/' || pg_temp.tot(x.counts->'fixed') || '/'
                    || pg_temp.tot(x.counts->'ignored') || '/' || pg_temp.tot(x.counts->'open')
                    || ' f3=' || (x.new_ids = array[f3])::text
               from public.audit_snapshots x where x.scan_run_id = b) || ' | ';

  -- 3) E51 de B: anterior = A con su puntaje; listas en el orden de E13; horas con Z
  j := public.vg_audit_delta(o, b, 50);
  s := s || '3 delta: prev=' || ((j->'previous'->>'scan_run_id')::uuid = a)::text || '/' || (j->'previous'->>'score')
         || ' kept=' || (j->'kept'->>'total') || ' fixed=' || jsonb_array_length(j->'fixed'->'items')
         || ' primero=' || (j->'fixed'->'items'->0->>'severity')
         || ' z=' || ((j->>'taken_at') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')::text
         || '/' || ((j->'previous'->>'finished_at') ~ 'Z$')::text || ' | ';

  -- 4) Repetir B: la misma foto (no se rehace). C después de B; repetir B otra vez no la mueve y C sigue apuntando a B
  t1 := (select x.taken_at from public.audit_snapshots x where x.scan_run_id = b);
  j := public.vg_snapshot_audit(o, b);
  s := s || '4 rep=' || coalesce(j->>'repeated', 'no') || ' new=' || (j->>'new')
         || ' t=' || ((select x.taken_at from public.audit_snapshots x where x.scan_run_id = b) = t1)::text;
  c := pg_temp.aud(o, 'supabase', '[{"name":"supabase","status":"done"},{"name":"puntaje","status":"done"}]',
                   'succeeded', 45);
  perform public.vg_snapshot_audit(o, c);
  perform public.vg_snapshot_audit(o, b);
  s := s || ' C.prev=B:' || ((select x.prev_scan_run_id from public.audit_snapshots x where x.scan_run_id = c) = b)::text
         || ' B.prev=A:' || ((select x.prev_scan_run_id from public.audit_snapshots x where x.scan_run_id = b) = a)::text
         || ' t=' || ((select x.taken_at from public.audit_snapshots x where x.scan_run_id = b) = t1)::text || ' | ';

  -- 5) Claves y filas borradas. D trae k1, k2 y g1. Antes de E: k1 se quita de HEAD sin rotar (la auditoría la da por
  -- verified): corregida, pero no «comprobada»; k2 cambia de línea (otra fila, misma regla y huella): se mantiene; g1 se
  -- cierra y la retención borra su fila: gone, ni corregido ni ignorado. open(E) = open(D) + new − fixed − ign − gone
  k1 := pg_temp.h(o, 'codebase', 'CB_SECRET_STRIPE_LIVE', 'critical', 'src/a.ts:1', 'aaaaaaaa');
  k2 := pg_temp.h(o, 'codebase', 'CB_SECRET_AWS', 'critical', 'src/b.ts:2', 'bbbbbbbb');
  g1 := pg_temp.h(o, 'supabase', 'SB_ADVISOR_Y', 'info', 'public.c', null);
  d := pg_temp.aud(o, 'full_audit', pasos, 'succeeded', 20);
  j := public.vg_snapshot_audit(o, d);
  s := s || '5 D: new=' || (j->>'new');
  perform pg_temp.est(k1, 'verified');
  perform pg_temp.est(k2, 'verified');
  k2b := pg_temp.h(o, 'codebase', 'CB_SECRET_AWS', 'critical', 'src/b.ts:9', 'bbbbbbbb');
  perform pg_temp.est(g1, 'fixed');
  delete from public.findings where id = g1;
  e := pg_temp.aud(o, 'full_audit', pasos, 'succeeded', 25);
  j := public.vg_snapshot_audit(o, e);
  s := s || ' E: new=' || (j->>'new') || ' kept=' || (j->>'kept') || ' fixed=' || (j->>'fixed')
         || ' moved=' || (j->>'moved') || ' gone=' || (j->>'gone')
         || (select ' chk=' || x.fixed_checked || ' k1=' || (x.fixed_ids = array[k1])::text
                    || ' k2b=' || (k2b = any(x.open_ids) and not k2b = any(x.new_ids))::text
                    || ' matfixed=' || pg_temp.tot(x.counts->'fixed')
                    || ' cuadra=' || (cardinality(x.open_ids) = (select cardinality(y.open_ids) from public.audit_snapshots y
                                                                   where y.scan_run_id = d)
                                      + cardinality(x.new_ids) - cardinality(x.fixed_ids) - cardinality(x.ignored_ids)
                                      - x.gone)::text
               from public.audit_snapshots x where x.scan_run_id = e) || ' | ';

  -- 6) IDOR, sin módulos, lighthouse, en_curso y sin_foto
  sb := pg_temp.aud(ob, 'full_audit', pasos, 'succeeded', 50);
  s := s || '6 idor=' || (public.vg_snapshot_audit(o, sb)->>'applied') || '/' || (public.vg_audit_delta(o, sb, 50)->>'found');
  x := pg_temp.aud(o, 'full_audit', '[{"name":"supabase","status":"failed"},{"name":"repo","status":"failed"}]',
                   'succeeded', null);
  s := s || ' ' || (public.vg_snapshot_audit(o, x)->>'reason');
  x := pg_temp.aud(o, 'lighthouse', '[]', 'succeeded', null);
  s := s || '/' || (public.vg_snapshot_audit(o, x)->>'reason');
  x := pg_temp.aud(o, 'full_audit', pasos, 'running', null);
  s := s || ' ' || (public.vg_audit_delta(o, x, 50)->>'reason') || '/' || (public.vg_audit_delta(o, viejo, 50)->>'reason')
         || ' | ';

  -- 7) Fotos de push (Codebase de toda la org). R1: primera; k2b es su nuevo. Se marca f2 a mano. R2: limpio, 1 corregido.
  -- Repetir R2 no la rehace. Un PR, un push que sigue running y otra org no hacen foto
  insert into public.connections (id, org_id, provider, kind, label, meta)
    values (cn, o, 'github', 'read', 'repo de prueba', '{"repo_full_name":"acme/evo","default_branch":"main"}');
  insert into public.code_review_configs (id, org_id, connection_id, branch, secret_sealed, secret_kid)
    values (cf, o, cn, 'main', '{"v":1,"kid":"v1","iv":"x","ct":"x","ivk":"x","wdek":"x"}', 'v1');
  r1 := pg_temp.rev(o, cf, 'push', 'done', jsonb_build_array(jsonb_build_object('finding_id', k2b,
          'rule_id', 'CB_SECRET_AWS', 'severity', 'critical', 'title', 'Prueba', 'resource', 'src/b.ts:9')));
  j1 := public.vg_review_snapshot(o, r1);
  perform pg_temp.est(f2, 'fixed');
  r2 := pg_temp.rev(o, cf, 'push', 'done', '[]');
  j2 := public.vg_review_snapshot(o, r2);
  rp := pg_temp.rev(o, cf, 'pull_request', 'done', '[]');
  x := pg_temp.rev(o, cf, 'push', 'running', '[]');
  s := s || '7 push: R1=' || (j1->>'first') || '/' || (j1->>'open') || '/' || (j1->>'kept')
         || ' R2=' || (j2->>'first') || '/' || (j2->>'open') || '/' || (j2->>'kept') || '/' || (j2->>'fixed')
         || '/' || (j2->>'fixed_checked') || '/' || (j2->>'ignored')
         || ' prev=' || ((j2->>'previous_review_id')::uuid = r1)::text || '/' || ((j2->>'previous_at') ~ 'Z$')::text
         || ' rep=' || (public.vg_review_snapshot(o, r2)->>'repeated')
         || ' pr=' || (public.vg_review_snapshot(o, rp)->>'applied')
         || ' running=' || (public.vg_review_snapshot(o, x)->>'applied')
         || ' otra_org=' || (public.vg_review_snapshot(ob, r1)->>'applied') || ' | ';
  update public.code_reviews set status = 'failed' where id = x;

  -- 8) E52: el punto sin foto va primero (score 40, open null); A, B, C, D y E en orden; recorte con limit 2; totales
  -- de todo el periodo; revisiones = R1, R2 y el PR (sin el failed), el PR con delta null; un incidente; el tiempo hasta
  -- comprobar cuenta f1 y no las claves; límites de days y limit
  insert into public.incidents (org_id, rule_ids, severity, title, resource, dedupe_key)
    values (o, '{CF_IP_FLOOD}', 'high', 'Prueba de incidente', 'ip:203.0.113.7', repeat('a', 64));
  j := public.vg_evolution(o, 30, 30);
  s := s || '8 evo: puntos=' || jsonb_array_length(j->'points')
         || ' viejo=' || (j->'points'->0->>'snapshot') || '/' || (j->'points'->0->>'score') || '/'
         || coalesce(j->'points'->0->>'open', 'null')
         || ' orden=' || ((j->'points'->1->>'scan_run_id')::uuid = a and (j->'points'->5->>'scan_run_id')::uuid = e)::text
         || ' trunc=' || (j->>'truncated') || '/' || (public.vg_evolution(o, 30, 2)->>'truncated')
         || '/' || jsonb_array_length(public.vg_evolution(o, 30, 2)->'points')
         || ' tot=' || (j->'totals'->>'versions') || '/' || (j->'totals'->>'snapshots') || '/'
         || (j->'totals'->>'score_first') || '/' || pg_temp.tot(j->'totals'->'new') || '/'
         || pg_temp.tot(j->'totals'->'fixed') || '/' || (j->'totals'->>'fixed_checked') || '/'
         || (j->'totals'->>'ignored') || '/' || (j->'totals'->>'gone')
         || ' trunc_tot=' || (public.vg_evolution(o, 30, 2)->'totals'->>'versions')
         || ' revs=' || jsonb_array_length(j->'reviews') || '/'
         || coalesce((select r->>'delta' from jsonb_array_elements(j->'reviews') r where r->>'event' = 'pull_request'), 'null')
         || ' inc=' || jsonb_array_length(j->'incidents') || '/' || (j->'incidents'->0->'counts'->>'high')
         || ' mttr=' || (j->'mttr'->>'verified')
         || ' z=' || ((j->'points'->0->>'at') ~ 'Z$' and (j->'reviews'->0->>'at') ~ 'Z$')::text
         || ' dias=' || (public.vg_evolution(o, 0, 0)->>'days') || '/' || (public.vg_evolution(o, 500, 500)->>'days')
         || '/' || jsonb_array_length(public.vg_evolution(o, 500, 500)->'points')
         || ' otra_org=' || jsonb_array_length(public.vg_evolution(ob, 30, 30)->'points') || ' | ';

  -- 9) Borrar A: su foto desaparece; E51 de B sigue con su delta y previous null
  delete from public.scan_runs where id = a;
  j := public.vg_audit_delta(o, b, 50);
  s := s || '9 borrar: foto=' || (select count(*) from public.audit_snapshots x where x.scan_run_id = a)
         || ' prev=' || coalesce(j->>'previous', 'null') || ' fixed=' || (j->'fixed'->>'total') || ' | ';

  -- 10) Privilegios: anon y authenticated no leen la tabla ni ejecutan las 4 RPC ni las 8 piezas
  select count(*) into n from (values ('anon'), ('authenticated')) ro(rol)
   where has_table_privilege(ro.rol, 'public.audit_snapshots', 'select');
  s := s || '10 priv: tabla=' || n;
  select count(*) into n from (values ('anon'), ('authenticated')) ro(rol),
         (values ('public.vg_snapshot_audit(uuid, uuid)'), ('public.vg_review_snapshot(uuid, uuid)'),
                 ('public.vg_audit_delta(uuid, uuid, int)'), ('public.vg_evolution(uuid, int, int)'),
                 ('private.vg_iso(timestamptz)'), ('private.vg_es_clave(text)'), ('private.vg_modulos_vistos(jsonb)'),
                 ('private.vg_matriz(uuid, uuid[])'), ('private.vg_lista_delta(uuid, uuid[], int)'),
                 ('private.vg_restar(uuid, uuid[], uuid[])'), ('private.vg_versiones(uuid, timestamptz)'),
                 ('private.vg_suma(uuid, timestamptz, text)')) f(fn)
   where has_function_privilege(ro.rol, f.fn, 'execute');
  s := s || ' funciones=' || n;

  raise exception 'RESULTADO %',
    case when s = esperado then 'OK ' || s else 'DISTINTO: ' || s || ' ≠ esperado: ' || esperado end;
end $$;
