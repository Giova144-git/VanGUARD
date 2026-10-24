-- YA APLICADA el sáb 24-oct (versión 20261024074929 en accshmgmfrqrxubpuxcl), antes de 0001: se versiona aquí para que
-- el repo y la base digan lo mismo. El proyecto trae el event trigger ensure_rls, que activa RLS en cada tabla nueva
-- llamando a public.rls_auto_enable() (security definer). El advisor la marcaba como RPC ejecutable por anon y
-- authenticated (/rest/v1/rpc/rls_auto_enable); solo debe correr desde el trigger, que no necesita EXECUTE.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
