-- supabase/seed/dev-idor.sql · literal de PLAN_MAESTRO §05.11 (BACK; en accshmgmfrqrxubpuxcl, porque no hay otro proyecto).
-- Las dos orgs no son is_demo: «Ver demo» no las alcanza y el jurado no las ve. Antes, apps/api/test/idor.mjs (o Giovanni a
-- mano en Auth → Users) crea idor-a@vanguard.test e idor-b@vanguard.test; sus contraseñas solo viven en apps/api/.dev.vars.
-- Idempotente: si los usuarios aún no existen, las membresías no se insertan y basta re-ejecutarlo cuando existan.
insert into public.orgs (id, name, slug) values
  ('00000000-0000-4000-a000-00000000a001', 'Org A (IDOR)', 'idor-a'),
  ('00000000-0000-4000-a000-00000000b002', 'Org B (IDOR)', 'idor-b') on conflict (id) do nothing;
insert into public.org_members (org_id, user_id, role)
  select '00000000-0000-4000-a000-00000000a001'::uuid, id, 'owner' from auth.users where email = 'idor-a@vanguard.test'
  union all
  select '00000000-0000-4000-a000-00000000b002'::uuid, id, 'owner' from auth.users where email = 'idor-b@vanguard.test'
on conflict do nothing;
insert into public.connections (id, org_id, provider, label, meta) values        -- sin secreto: basta para probar IDOR
  ('00000000-0000-4000-a000-0000000c0a01', '00000000-0000-4000-a000-00000000a001', 'github', 'Repo A', '{"repo_full_name":"vg/a"}'),
  ('00000000-0000-4000-a000-0000000c0b02', '00000000-0000-4000-a000-00000000b002', 'github', 'Repo B', '{"repo_full_name":"vg/b"}')
on conflict (id) do nothing;
insert into public.findings (id, org_id, module, rule_id, severity, title, resource, dedupe_key) values
  ('00000000-0000-4000-a000-0000000f0a01', '00000000-0000-4000-a000-00000000a001', 'codebase', 'CB_ENV_COMMITTED',
   'critical', '.env subido (org A)', '.env', repeat('a', 64)),
  ('00000000-0000-4000-a000-0000000f0b02', '00000000-0000-4000-a000-00000000b002', 'codebase', 'CB_ENV_COMMITTED',
   'critical', '.env subido (org B)', '.env', repeat('b', 64))
on conflict (id) do nothing;
insert into public.scan_runs (id, org_id, kind, status, progress) values
  ('00000000-0000-4000-a000-0000000d0a01', '00000000-0000-4000-a000-00000000a001', 'repo', 'succeeded', 100),
  ('00000000-0000-4000-a000-0000000d0b02', '00000000-0000-4000-a000-00000000b002', 'repo', 'succeeded', 100)
on conflict (id) do nothing;
insert into public.incidents (id, org_id, rule_ids, severity, title, resource, dedupe_key) values
  ('00000000-0000-4000-a000-0000000e0a01', '00000000-0000-4000-a000-00000000a001', '{CF_PATH_SCAN}', 'high',
   'Escaneo (org A)', 'ip:198.51.100.1', repeat('c', 64)),
  ('00000000-0000-4000-a000-0000000e0b02', '00000000-0000-4000-a000-00000000b002', '{CF_PATH_SCAN}', 'high',
   'Escaneo (org B)', 'ip:198.51.100.2', repeat('d', 64))
on conflict (id) do nothing;
insert into public.actions (id, org_id, incident_id, kind, target, status) values
  ('00000000-0000-4000-a000-0000000a0a01', '00000000-0000-4000-a000-00000000a001', '00000000-0000-4000-a000-0000000e0a01',
   'block_ip', '198.51.100.1', 'undone'),
  ('00000000-0000-4000-a000-0000000a0b02', '00000000-0000-4000-a000-00000000b002', '00000000-0000-4000-a000-0000000e0b02',
   'block_ip', '198.51.100.2', 'undone')
on conflict (id) do nothing;
