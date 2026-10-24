import type { Context } from 'hono';
import { z } from 'zod';
import { ApiError } from './errors.ts';

// Cuerpo validado con el esquema de @vanguard/contracts (S15 15.3). Sin @hono/zod-validator.
export async function cuerpo<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError('invalid_body', 'El cuerpo de la petición no es JSON válido');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new ApiError('invalid_body', 'Revisa los campos marcados', { field_errors: z.flattenError(r.error).fieldErrors });
  }
  return r.data;
}
