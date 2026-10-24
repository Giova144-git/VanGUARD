// Ruta de diseño: todo lo de dentro exige sesión (RequireSession).
import { RequireSession } from '../guardas';

export default function ConSesion() {
  return <RequireSession />;
}
