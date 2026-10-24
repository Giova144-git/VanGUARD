// Forma genérica que pinta <PantallaModulo/> en el FRONT (R08 §6; nombres en español por decisión canónica).
import { z } from 'zod';
import { Ts } from './comun.ts';

export const RolDato = z.enum(['mal', 'aviso', 'cola', 'bien', 'neutra']);
export type RolDato = z.infer<typeof RolDato>;
export const ClaseAccion = z.enum(['inmediata', 'barra', 'confirmar', 'navegar', 'copiar', 'prompt']); // P0 usa confirmar|navegar|copiar|prompt
export type ClaseAccion = z.infer<typeof ClaseAccion>;
export const Destino = z.object({ modulo: z.string(), filtro: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  ancla: z.string().optional() });
export type Destino = z.infer<typeof Destino>;
export const AccionDato = z.object({ id: z.string().optional(), verbo: z.string().max(40), clase: ClaseAccion, principal: z.boolean().optional(),
  args: z.record(z.string(), z.unknown()).optional(), destino: Destino.optional(), copiar: z.string().optional(),
  motivo: z.boolean().optional(), simula: z.boolean().optional(), efecto: z.string().optional(), resultado: z.string().optional(),
  n: z.number().optional() });
export type AccionDato = z.infer<typeof AccionDato>;
export const FilaDato = z.object({ clave: z.string(), modulo: z.string(), tipo: z.string(), rol: RolDato, etiqueta: z.string().max(40),
  objeto: z.string().optional(), chips: z.array(z.string()).optional(), sub: z.string().optional(), fraccion: z.number().min(0).max(1).optional(),
  severidad_cve: z.enum(['critical', 'high', 'medium', 'low']).optional(), acciones: z.array(AccionDato) });
export type FilaDato = z.infer<typeof FilaDato>;
// orden: rango de la peor severidad del grupo (5 critical, 4 high, 3 medium, 2 low, 1 info o neutro). Es informativo:
// el servidor entrega `ahora` ya ordenado de mayor a menor y el FRONT pinta en el orden del array, sin reordenar (L1).
export const GrupoDato = z.object({ grupo: z.string(), etiqueta: z.string(), rol: RolDato, n: z.number().int(), orden: z.number().optional(),
  chapas: z.array(z.string()).optional(), filas: z.array(FilaDato) });
export type GrupoDato = z.infer<typeof GrupoDato>;
export const CifraDato = z.object({ tipo: z.string(), etiqueta: z.string(), n: z.number().nullable(), de: z.number().optional(),
  rol: RolDato.optional(), unidad: z.enum(['%', 'ms', 'bytes', 'h', 'd']).optional(), decimales: z.number().int().optional(),
  sub: z.string().optional(), destino: Destino.optional() });
export type CifraDato = z.infer<typeof CifraDato>;
export const CheckDato = z.object({ nombre: z.string(), codigo: z.string(), n: z.number().nullable(), de: z.number().optional(),
  comprobado: z.boolean(), destino: Destino.optional() });
export type CheckDato = z.infer<typeof CheckDato>;
export const Contador = z.object({ rojo: z.number().int().nullable(), aviso: z.number().int().nullable(), cola: z.number().int().nullable() });
export type Contador = z.infer<typeof Contador>;
export const EstadoModulo = z.object({ ok: z.boolean(), error: z.enum(['token_invalido', 'sin_permiso', 'limite_api', 'sin_conexion']).optional(),
  hora: Ts, contador: Contador, cifras: z.array(CifraDato), ahora: z.array(GrupoDato), checks: z.array(CheckDato) });
export type EstadoModulo = z.infer<typeof EstadoModulo>;
