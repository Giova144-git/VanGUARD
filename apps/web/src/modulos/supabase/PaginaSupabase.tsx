import { BotonRevisar } from '@/componentes/vg/BotonRevisar';
import { PantallaModulo } from '@/componentes/vg/PantallaModulo';

export default function PaginaSupabase() {
  return (
    <PantallaModulo modulo="supabase" proveedor="supabase">
      <BotonRevisar kind="supabase" titulo="Revisar Supabase ahora" descripcion="Advisors, RLS, políticas y funciones sin freno" />
    </PantallaModulo>
  );
}
