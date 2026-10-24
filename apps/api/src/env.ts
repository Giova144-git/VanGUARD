import type { Role } from '@vanguard/contracts';

// Lo que los middlewares de S15 15.3 dejan en el contexto de Hono.
export type Ctx = {
  rid: string;
  userId: string;
  isAnon: boolean;
  orgId: string;
  role: Role;
};

export type AppEnv = { Bindings: CloudflareBindings; Variables: Ctx };
