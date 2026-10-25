// Doble mínimo del cliente de supabase-js para probar rutas sin red: registra cada consulta y responde con el
// manejador que da la prueba. Solo cubre los métodos que usa apps/api.
export type Filtro = [columna: string, op: 'eq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'is', valor: unknown];
export type Op = {
  table: string;
  action: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
  columns?: string;
  head?: boolean;
  returning?: string;   // columnas del .select() tras insert/upsert/update/delete (lo que devuelve la escritura)
  filters: Filtro[];
  payload?: unknown;
  options?: unknown;
  single?: 'single' | 'maybe';
  orden?: [columna: string, ascendente: boolean][];   // .order() en el orden pedido
};
export type Resp = { data?: unknown; error?: { code?: string; message?: string } | null; count?: number | null };

type Manejadores = {
  tabla?: (op: Op) => Resp | undefined;
  rpc?: (name: string, args: Record<string, unknown>) => Resp | undefined;
  claims?: (tok: string) => Record<string, unknown> | null;
};

export function dbDoble(h: Manejadores = {}) {
  const ops: Op[] = [];
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];

  function consulta(table: string) {
    const op: Op = { table, action: 'select', filters: [] };
    const b = {
      select(columns?: string, o?: { count?: string; head?: boolean }) {
        if (op.action === 'select') { op.columns = columns; op.head = o?.head; } else op.returning = columns;
        return b;
      },
      insert(payload: unknown) { op.action = 'insert'; op.payload = payload; return b; },
      upsert(payload: unknown, options?: unknown) { op.action = 'upsert'; op.payload = payload; op.options = options; return b; },
      update(payload: unknown) { op.action = 'update'; op.payload = payload; return b; },
      delete() { op.action = 'delete'; return b; },
      eq(col: string, v: unknown) { op.filters.push([col, 'eq', v]); return b; },
      in(col: string, v: unknown) { op.filters.push([col, 'in', v]); return b; },
      gt(col: string, v: unknown) { op.filters.push([col, 'gt', v]); return b; },
      gte(col: string, v: unknown) { op.filters.push([col, 'gte', v]); return b; },
      lt(col: string, v: unknown) { op.filters.push([col, 'lt', v]); return b; },
      lte(col: string, v: unknown) { op.filters.push([col, 'lte', v]); return b; },
      is(col: string, v: unknown) { op.filters.push([col, 'is', v]); return b; },
      order(col: string, o?: { ascending?: boolean }) { (op.orden ??= []).push([col, o?.ascending !== false]); return b; },
      limit() { return b; },
      maybeSingle() { op.single = 'maybe'; return b; },
      single() { op.single = 'single'; return b; },
      then<T>(ok: (r: { data: unknown; error: unknown; count: number | null }) => T, ko?: (e: unknown) => T) {
        ops.push(op);
        const r = h.tabla?.(op) ?? {};
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null }).then(ok, ko);
      },
    };
    return b;
  }

  const client = {
    from: (table: string) => consulta(table),
    async rpc(name: string, args: Record<string, unknown>) {
      rpcs.push({ name, args });
      const r = h.rpc?.(name, args) ?? {};
      return { data: r.data ?? null, error: r.error ?? null };
    },
    auth: {
      async getClaims(tok: string) {
        const claims = h.claims?.(tok) ?? null;
        return claims ? { data: { claims }, error: null } : { data: null, error: { name: 'AuthInvalidJwtError' } };
      },
    },
  };
  return { client, ops, rpcs };
}

// Filtro por columna: valor del primer .eq(col, …) de la consulta, o undefined.
export const eqDe = (op: Op, col: string) => op.filters.find(([c, o]) => c === col && o === 'eq')?.[2];
