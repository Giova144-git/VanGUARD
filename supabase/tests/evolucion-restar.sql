-- supabase/tests/evolucion-restar.sql · 0021: una clave (regla + huella) que cambió de línea en una foto y cuya fila
-- vieja se cierra en la siguiente (auditoría parcial entre medias) no sale ni como nueva ni como corregida: se empareja
-- también con las filas que siguen abiertas en las dos fotos. Cubre la foto de auditoría (A → B parcial sin codebase →
-- C completa), E51, la foto de push (vg_restar es la misma), que la huella null, otra huella, otra regla u otra org no
-- se emparejan, que el emparejamiento 1 a 1 de 0015 no cambia, el descuadre por foto que eso deja (y que la cadena
-- cuadra) y las guardas de la función. supabase/tests/evolucion.sql da el MISMO resultado antes y después de 0021.
-- Se corre con execute_sql del MCP o el editor SQL DESPUÉS de aplicar 0021 (o pegado detrás de la migración en la misma
-- llamada, para probarla antes de aplicarla). Usa las orgs idor-a e idor-b. Siempre termina en ERROR a propósito: el
-- mensaje lleva el resultado y la excepción deshace todo (no queda ninguna fila de prueba). «RESULTADO OK …» = todo
-- bien; «RESULTADO DISTINTO …» trae lo obtenido y lo esperado (la variable `esperado` del bloque).
-- Resultado esperado (probado en PGlite 0.3.14 encima de 0001–0019 + 0021; Supabase es la referencia):
--   RESULTADO OK 1 A: open=4 |
--   2 B: vistos=supabase new=3 kept=5 moved=1 r2=true descuadre=1 |
--   3 C: new=0 fixed=2 moved=1 chk=1 r1=true descuadre=-1 cadena=true e51=2/false/5/true |
--   4 D: new=0 fixed=0 moved=1 |
--   5 push: P2=0/1 P3=0/1/0 prev=true |
--   6 idor=true/0 | 7 priv: ejecutar=0 definer=false path=true
-- Con 0015 sola (sin 0021) sale DISTINTO: B new=4 kept=4 moved=0 r2=false descuadre=0; C fixed=3 moved=0 r1=false
-- descuadre=0 e51=3/true/5/true; push P2=0/0 P3=1/0/0.
create or replace function pg_temp.h(p_org uuid, p_mod text, p_rule text, p_sev text, p_res text, p_fp text)
returns uuid language sql as $$
  insert into public.findings (org_id, module, rule_id, severity, title, resource, evidence, dedupe_key)
  values (p_org, p_mod, p_rule, p_sev, 'Prueba ' || p_rule, p_res,
          case when p_fp is null then '{}'::jsonb else jsonb_build_object('fingerprint_short', p_fp) end,
          encode(sha256(convert_to('evr|' || p_org || '|' || p_rule || '|' || p_res, 'UTF8')), 'hex'))
  returning id
$$;
create or replace function pg_temp.aud(p_org uuid, p_steps jsonb) returns uuid language sql as $$
  insert into public.scan_runs (org_id, kind, status, steps, score, finished_at)
  values (p_org, 'full_audit', 'succeeded', p_steps, 50, now())
  returning id
$$;
create or replace function pg_temp.est(p_id uuid, p_status text) returns void language sql as $$
  update public.findings set status = p_status, verified_at = case when p_status = 'verified' then now() end
   where id = p_id
$$;
create or replace function pg_temp.rev(p_org uuid, p_cfg uuid) returns uuid language sql as $$
  insert into public.code_reviews (org_id, config_id, event, branch, base_sha, head_sha, status, new_findings, finished_at)
  values (p_org, p_cfg, 'push', 'main', repeat('0', 39) || '1',
          left(encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 40), 'done', '[]', now())
  returning id
$$;
-- Lo que la identidad de 0015 deja sin explicar en una foto: open − (open anterior + new − fixed − ignored − gone).
create or replace function pg_temp.descuadre(p_scan uuid) returns int language sql stable as $$
  select cardinality(x.open_ids) - (cardinality(y.open_ids) + cardinality(x.new_ids) - cardinality(x.fixed_ids)
                                    - cardinality(x.ignored_ids) - x.gone)
    from public.audit_snapshots x join public.audit_snapshots y on y.scan_run_id = x.prev_scan_run_id
   where x.scan_run_id = p_scan
$$;

do $$
declare
  o uuid := (select id from public.orgs where slug = 'idor-a');
  ob uuid := (select id from public.orgs where slug = 'idor-b');
  completa jsonb := '[{"name":"supabase","status":"done"},{"name":"repo","status":"done"},'
                    '{"name":"puntaje","status":"done"}]';
  parcial jsonb := '[{"name":"supabase","status":"done"},{"name":"repo","status":"failed"},'
                   '{"name":"puntaje","status":"done"}]';
  cn uuid := gen_random_uuid();
  cf uuid := gen_random_uuid();
  n1 uuid; r1 uuid; r2 uuid; r3 uuid; r4 uuid; d1 uuid; d2 uuid; k1 uuid; k2 uuid; k3 uuid; xb uuid;
  a uuid; b uuid; c uuid; d uuid; p1 uuid; p2 uuid; p3 uuid;
  j jsonb; j2 jsonb; j3 jsonb;
  n int;
  s text := '';
  esperado text := ''
    || '1 A: open=4'
    || ' | '
    || '2 B: vistos=supabase new=3 kept=5 moved=1 r2=true descuadre=1'
    || ' | '
    || '3 C: new=0 fixed=2 moved=1 chk=1 r1=true descuadre=-1 cadena=true e51=2/false/5/true'
    || ' | '
    || '4 D: new=0 fixed=0 moved=1'
    || ' | '
    || '5 push: P2=0/1 P3=0/1/0 prev=true'
    || ' | '
    || '6 idor=true/0'
    || ' | '
    || '7 priv: ejecutar=0 definer=false path=true';
begin
  -- Hermética: la siembra de idor-a/idor-b trae 1 hallazgo abierto y 1 incidente resuelto por org que sumarían +1 a
  -- los conteos. Se quitan aquí dentro; el raise final lo deshace todo y la siembra vuelve a su sitio.
  delete from public.incidents where org_id in (select id from public.orgs where slug in ('idor-a','idor-b'));
  delete from public.findings where org_id in (select id from public.orgs where slug in ('idor-a','idor-b'));

  -- 1) A (completa): la clave K en src/a.ts:10 (r1), dos dependencias sin huella y un hallazgo de Supabase
  n1 := pg_temp.h(o, 'supabase', 'SB_RLS_DISABLED', 'high', 'public.a', null);
  r1 := pg_temp.h(o, 'codebase', 'CB_SECRET_STRIPE_LIVE', 'critical', 'src/a.ts:10', 'a1a1a1a1');
  d1 := pg_temp.h(o, 'codebase', 'CB_DEP_VULN', 'high', 'npm:a@1', null);
  d2 := pg_temp.h(o, 'codebase', 'CB_DEP_VULN', 'high', 'npm:b@1', null);
  a := pg_temp.aud(o, completa);
  j := public.vg_snapshot_audit(o, a);
  s := s || '1 A: open=' || (j->>'open') || ' | ';

  -- 2) B: auditoría parcial sin codebase (repo falló después de guardar lo que leyó, sin auto-verificar): K aparece en
  -- src/a.ts:20 (r2) y r1 sigue abierto. r2 no es nuevo: la misma clave ya estaba abierta en r1. Sí son nuevas otra
  -- huella con la misma regla (k1), la misma huella con otra regla (k2) y una clave que solo está abierta en OTRA org (k3)
  r2 := pg_temp.h(o, 'codebase', 'CB_SECRET_STRIPE_LIVE', 'critical', 'src/a.ts:20', 'a1a1a1a1');
  k1 := pg_temp.h(o, 'codebase', 'CB_SECRET_STRIPE_LIVE', 'critical', 'src/b.ts:5', 'b2b2b2b2');
  k2 := pg_temp.h(o, 'codebase', 'CB_SECRET_AWS', 'critical', 'src/c.ts:1', 'a1a1a1a1');
  xb := pg_temp.h(ob, 'codebase', 'CB_SECRET_GITHUB', 'critical', 'src/x.ts:1', 'c3c3c3c3');
  k3 := pg_temp.h(o, 'codebase', 'CB_SECRET_GITHUB', 'critical', 'src/x.ts:1', 'c3c3c3c3');
  b := pg_temp.aud(o, parcial);
  j := public.vg_snapshot_audit(o, b);
  s := s || '2 B: vistos=' || (select array_to_string(x.modules_seen, ',') from public.audit_snapshots x
                                where x.scan_run_id = b)
         || ' new=' || (j->>'new') || ' kept=' || (j->>'kept') || ' moved=' || (j->>'moved')
         || (select ' r2=' || (r2 = any(x.open_ids) and not r2 = any(x.new_ids))::text
               from public.audit_snapshots x where x.scan_run_id = b)
         || ' descuadre=' || pg_temp.descuadre(b) || ' | ';

  -- 3) C (completa): verifica r1 (K ya no está en la línea 10), k1 (quitada sin rotar, sin otra fila abierta) y d1
  -- (comprobado; la otra dependencia sin huella no lo empareja). r1 no es corregido: K sigue abierta en r2. La cadena
  -- A → C cuadra: el +1 de B y el −1 de C se compensan
  perform pg_temp.est(r1, 'verified');
  perform pg_temp.est(k1, 'verified');
  perform pg_temp.est(d1, 'verified');
  c := pg_temp.aud(o, completa);
  j := public.vg_snapshot_audit(o, c);
  s := s || '3 C: new=' || (j->>'new') || ' fixed=' || (j->>'fixed') || ' moved=' || (j->>'moved')
         || (select ' chk=' || x.fixed_checked || ' r1=' || (not r1 = any(x.fixed_ids) and not r1 = any(x.open_ids))::text
               from public.audit_snapshots x where x.scan_run_id = c)
         || ' descuadre=' || pg_temp.descuadre(c)
         || ' cadena=' || ((select cardinality(x.open_ids) from public.audit_snapshots x where x.scan_run_id = c)
                           = (select cardinality(x.open_ids) from public.audit_snapshots x where x.scan_run_id = a)
                             + (select sum(cardinality(x.new_ids) - cardinality(x.fixed_ids) - cardinality(x.ignored_ids)
                                           - x.gone)
                                  from public.audit_snapshots x where x.scan_run_id in (b, c)))::text;
  j := public.vg_audit_delta(o, c, 50);
  s := s || ' e51=' || (j->'fixed'->>'total') || '/'
         || exists (select 1 from jsonb_array_elements(j->'fixed'->'items') i where (i->>'finding_id')::uuid = r1)::text
         || '/' || (j->'kept'->>'total') || '/'
         || exists (select 1 from jsonb_array_elements(j->'kept'->'items') i where (i->>'finding_id')::uuid = r2)::text
         || ' | ';

  -- 4) D (completa): K cambia de línea dentro de un mismo intervalo (r2 verified, r3 entra): el 1 a 1 de 0015, igual
  -- que antes (una pareja, ni nueva ni corregida)
  perform pg_temp.est(r2, 'verified');
  r3 := pg_temp.h(o, 'codebase', 'CB_SECRET_STRIPE_LIVE', 'critical', 'src/a.ts:30', 'a1a1a1a1');
  d := pg_temp.aud(o, completa);
  j := public.vg_snapshot_audit(o, d);
  s := s || '4 D: new=' || (j->>'new') || ' fixed=' || (j->>'fixed') || ' moved=' || (j->>'moved') || ' | ';

  -- 5) Fotos de push (la misma resta). P1 con r3 abierto; una auditoría parcial trae K en src/a.ts:40 (r4) sin cerrar
  -- r3 → P2; otra auditoría verifica r3 → P3: r3 no es corregido porque K sigue abierta en r4
  insert into public.connections (id, org_id, provider, kind, label, meta)
    values (cn, o, 'github', 'read', 'repo de prueba', '{"repo_full_name":"acme/evr","default_branch":"main"}');
  insert into public.code_review_configs (id, org_id, connection_id, branch, secret_sealed, secret_kid)
    values (cf, o, cn, 'main', '{"v":1,"kid":"v1","iv":"x","ct":"x","ivk":"x","wdek":"x"}', 'v1');
  p1 := pg_temp.rev(o, cf);
  perform public.vg_review_snapshot(o, p1);
  r4 := pg_temp.h(o, 'codebase', 'CB_SECRET_STRIPE_LIVE', 'critical', 'src/a.ts:40', 'a1a1a1a1');
  p2 := pg_temp.rev(o, cf);
  j2 := public.vg_review_snapshot(o, p2);
  perform pg_temp.est(r3, 'verified');
  p3 := pg_temp.rev(o, cf);
  j3 := public.vg_review_snapshot(o, p3);
  s := s || '5 push: P2=' || (j2->>'fixed') || '/' || (j2->>'moved')
         || ' P3=' || (j3->>'fixed') || '/' || (j3->>'moved') || '/' || (j3->>'fixed_checked')
         || ' prev=' || ((j3->>'previous_review_id')::uuid = p2)::text || ' | ';

  -- 6) Solo filas de la org: con una fila de OTRA org (misma regla y huella) en las dos listas, k3 sigue siendo nuevo
  s := s || '6 idor=' || (select (x.o_new = array[k3])::text || '/' || x.o_moved
                            from private.vg_restar(o, array[xb], array[xb, k3]) x) || ' | ';

  -- 7) Guardas de 0015: anon y authenticated no la ejecutan, sin security definer y con search_path vacío
  select count(*) into n from (values ('anon'), ('authenticated')) ro(rol)
   where has_function_privilege(ro.rol, 'private.vg_restar(uuid, uuid[], uuid[])', 'execute');
  s := s || '7 priv: ejecutar=' || n
         || (select ' definer=' || p.prosecdef::text || ' path=' || (p.proconfig = array['search_path=""'])::text
               from pg_proc p where p.oid = 'private.vg_restar(uuid, uuid[], uuid[])'::regprocedure);

  raise exception 'RESULTADO %',
    case when s = esperado then 'OK ' || s else 'DISTINTO: ' || s || ' ≠ esperado: ' || esperado end;
end $$;
