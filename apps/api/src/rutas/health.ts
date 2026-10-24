import { Hono } from 'hono';
import { Health } from '@vanguard/contracts';
import type { AppEnv } from '../env.ts';

// E1 · GET /api/health · public · P0. No toca Supabase: el validador del hackatón debe recibir 200 aunque la base caiga.
// `||` a propósito: una VG_VERSION vacía también da "dev".
export const health = new Hono<AppEnv>();

health.get('/health', (c) =>
  c.json(Health.parse({ ok: true, version: c.env.VG_VERSION || 'dev', time: new Date().toISOString() })));
