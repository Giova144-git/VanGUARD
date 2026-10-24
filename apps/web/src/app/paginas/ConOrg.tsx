// /o/:orgId: RequireOrg, el canal Realtime de la org (P0, A7.5) y, dentro, el cascarón que pinta las rutas hijas.
import { useParams } from 'react-router';
import { VivoProvider } from '@/lib/vivo';
import AppShell from '../AppShell';
import { RequireOrg } from '../guardas';

export default function ConOrg() {
  const { orgId = '' } = useParams();
  return <RequireOrg key={orgId}><VivoProvider org={orgId}><AppShell /></VivoProvider></RequireOrg>;
}
