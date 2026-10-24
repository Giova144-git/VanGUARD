// Botones que existen SOLO en modo fixtures (S14 §14.19, §14.22): ensayar el tramo de incidentes del guion sin BACK.
// El import dinámico va dentro de la condición escrita en línea, para que Vite la sustituya por literales y el
// enrutador falso no entre en el bundle de producción (F-03).
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/componentes/ui/button';
import { USA_FIXTURES } from '@/lib/env';

async function cargar() {
  if (import.meta.env.MODE === 'fixtures' || import.meta.env.VITE_USE_FIXTURES === '1') return import('@/lib/fixtures/router');
  return null;
}

export function BotonSimularAtaque({ org }: { org: string }) {
  const qc = useQueryClient();
  const navegar = useNavigate();
  if (!USA_FIXTURES) return null;
  return (
    <Button variant="secundaria" onClick={async () => {
      const m = await cargar();
      if (!m) return;
      const id = m.simularAtaque(org);
      await qc.invalidateQueries({ queryKey: ['org', org] });            // sin Realtime en fixtures: se invalida al momento
      navegar(`/o/${org}/incidents/${id}`);
    }}><FlaskConical />Simular ataque</Button>
  );
}

export function BotonSimularWhatsApp({ org, incidentId }: { org: string; incidentId: string }) {
  const qc = useQueryClient();
  if (!USA_FIXTURES) return null;
  return (
    <Button variant="secundaria" onClick={async () => {
      const m = await cargar();
      if (!m) return;
      m.simularAprobacionWhatsApp(org, incidentId);
      await qc.invalidateQueries({ queryKey: ['org', org] });
    }}><FlaskConical />Simular aprobación por WhatsApp</Button>
  );
}
