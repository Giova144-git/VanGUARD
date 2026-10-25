// La conexión ingest del simulador de ataques (E57, meta.simulador = true, revoked y sin secreto) solo existe para que
// los edge_hits sintéticos tengan conexión: no es una conexión del cliente, así que ni E7 ni el estado de los módulos
// la enseñan ni la cuentan.
export const esConexionSimulador = (fila: unknown): boolean => {
  const meta = (fila as { meta?: unknown } | null | undefined)?.meta;
  return !!meta && typeof meta === 'object' && (meta as Record<string, unknown>).simulador === true;
};
