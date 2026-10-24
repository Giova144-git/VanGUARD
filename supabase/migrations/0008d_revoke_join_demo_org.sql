-- 0008d_revoke_join_demo_org.sql · propuesta (b) aprobada por Giovanni («el paso 6 apruebo b»).
-- «Ver demo» funciona en producción por la vía principal (E4 POST /api/demo/join con el cliente admin; el FRONT ya no usa
-- la RPC). join_demo_org() deja de ser ejecutable por authenticated: el advisor 0029 (security definer ejecutable por
-- usuarios con sesión) desaparece y el proyecto queda limpio en el dogfooding. La función se conserva, sin grant.
revoke execute on function public.join_demo_org() from authenticated;
