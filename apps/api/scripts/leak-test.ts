// Prueba de fuga, caso (c) de §15.11 / §05.12. Se corre desde apps/api con:
//   node --env-file=.dev.vars scripts/leak-test.ts
// Necesita SUPABASE_URL, SUPABASE_SECRET_KEY, VG_KEK_PEPPER y VG_FP_PEPPER en el entorno (el chat no abre .dev.vars).
// Sella el canario en la org IDOR A sin sondeo, lo abre con withSecret, comprueba que el Box guardado no contiene
// el canario y borra la conexión de prueba. Nunca imprime el canario descifrado ni ningún secreto: solo conteos.
import { createConnectionWithSecret, withSecret } from '../src/lib/credentials.ts';
import { db } from '../src/lib/db.ts';

const CANARIO = 'vg_test_LEAK_7Q2X';
const ORG_A = '00000000-0000-4000-a000-00000000a001';
const LABEL = 'leak-test';

const env = process.env as unknown as CloudflareBindings;
const admin = db(env);
let fallos = 0;
const ok = (nombre: string, bien: boolean) => { console.log(`${bien ? 'OK ' : 'MAL'} ${nombre}`); if (!bien) fallos++; };

async function limpiar() {
  const { error } = await admin.from('connections').delete().eq('org_id', ORG_A).eq('label', LABEL);
  if (error) throw new Error(`no se pudo limpiar la conexión de prueba (${error.code})`);
}

try {
  await limpiar();   // un intento anterior cortado no debe chocar con la huella única (org_id, fingerprint)
  const connectionId = crypto.randomUUID();
  await createConnectionWithSecret(env, admin, { orgId: ORG_A, connectionId, provider: 'github', kind: 'read', label: LABEL,
    meta: { repo_full_name: 'vg/leak-test' }, scopes: [], capabilities: {}, expiresAt: null,
    createdBy: null as unknown as string }, CANARIO);
  const ctx = { orgId: ORG_A, connectionId, provider: 'github' as const, kind: 'read' as const };
  ok('ida y vuelta con withSecret', await withSecret(env, admin, ctx, async (t) => t === CANARIO));

  const { data, error } = await admin.from('connection_secrets').select('sealed').eq('connection_id', connectionId).eq('org_id', ORG_A);
  if (error) throw new Error(`no se pudo leer connection_secrets (${error.code})`);
  const sellado = JSON.stringify(data ?? []);
  ok('connection_secrets.sealed sin el canario (0 apariciones)', !sellado.includes('LEAK'));
  const { data: fila } = await admin.from('connections').select('meta, last4, label').eq('id', connectionId).maybeSingle();
  ok('connections sin el canario (solo last4)', !JSON.stringify(fila ?? {}).includes('LEAK'));

  const otra = { ...ctx, orgId: '00000000-0000-4000-a000-00000000b002' };
  ok('el Box no abre desde otra org', await withSecret(env, admin, otra, async () => false).catch(() => true));
} catch (e) {
  fallos++;
  console.log(`MAL error: ${(e as Error)?.message ?? 'desconocido'}`);
} finally {
  await limpiar().catch(() => { fallos++; console.log('MAL no se pudo borrar la conexión de prueba'); });
}
console.log(fallos ? `Prueba de fuga: ${fallos} fallo(s)` : 'Prueba de fuga (c): 0 apariciones');
process.exitCode = fallos ? 1 : 0;
