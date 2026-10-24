// /o/:orgId: RequireOrg y, dentro, el cascarón con el riel de módulos (el cascarón pinta las rutas hijas).
import { useParams } from 'react-router';
import AppShell from '../AppShell';
import { RequireOrg } from '../guardas';

export default function ConOrg() {
  const { orgId } = useParams();
  return <RequireOrg key={orgId}><AppShell /></RequireOrg>;
}
