// Cifrado de sobre AES-256-GCM de credenciales (S05 05.6–05.7, literal). Subruta `@vanguard/core/crypto`: index.ts no lo
// re-exporta y apps/web tiene prohibido importarlo. Solo WebCrypto estándar: corre igual en Workers y en Node 24.
// Con solo los tipos de Node (sin lib DOM) CryptoKey es un valor global, no un tipo: se toma de WebCrypto.
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const te = new TextEncoder(), td = new TextDecoder();
export type Provider = 'supabase' | 'cloudflare' | 'github' | 'ingest';
export type SecretCtx = { orgId: string; connectionId: string; provider: Provider; kind: 'read' | 'action' };
export type Box = { v: 1; kid: string; iv: string; ct: string; ivk: string; wdek: string };
export type Keys = { kid: string; kek: CryptoKey; fpk: CryptoKey };

export const b64 = (u: Uint8Array) => { let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
// Uint8Array<ArrayBuffer> y no <ArrayBufferLike>: con la lib DOM de TS 6 solo el primero es BufferSource (el worker del
// ZIP del navegador compila core con DOM). unb64 escribe sobre su propio ArrayBuffer; TextEncoder siempre devuelve uno.
type Bytes = Uint8Array<ArrayBuffer>;
export const unb64 = (s: string): Bytes => {
  const b = atob(s), u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
};
const utf8 = (s: string) => te.encode(s) as Bytes;
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
export const aadFor = (c: SecretCtx) => utf8(`vanguard|v1|${c.orgId}|${c.connectionId}|${c.provider}|${c.kind}`);

async function hkdfKey(ikmB64: string, saltB64: string, info: string, alg: 'AES-GCM' | 'HMAC'): Promise<CryptoKey> {
  const ikm = unb64(ikmB64), salt = unb64(saltB64);
  if (ikm.length !== 32 || salt.length !== 32) throw new Error('CRYPTO_MATERIAL_BAD_LENGTH');
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  const p = { name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) };
  return alg === 'AES-GCM'
    ? crypto.subtle.deriveKey(p, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    : crypto.subtle.deriveKey(p, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
}
export async function deriveKeys(m: { kid: string; vaultKekB64: string; kekPepperB64: string;
  vaultFpB64: string; fpPepperB64: string }): Promise<Keys> {
  return { kid: m.kid, kek: await hkdfKey(m.vaultKekB64, m.kekPepperB64, `vanguard/kek/${m.kid}`, 'AES-GCM'),
           fpk: await hkdfKey(m.vaultFpB64, m.fpPepperB64, 'vanguard/fp/v1', 'HMAC') };
}
const enc = async (k: CryptoKey, iv: Bytes, ad: Bytes, d: Bytes) =>
  new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, k, d));
const dec = async (k: CryptoKey, iv: Bytes, ad: Bytes, d: Bytes) =>
  new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: ad }, k, d));  // lanza si algo no cuadra

export async function seal(keys: Keys, plaintext: string, ctx: SecretCtx): Promise<Box> {
  const ad = aadFor(ctx), dekRaw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12)), ivk = crypto.getRandomValues(new Uint8Array(12));
  try {
    const dek = await crypto.subtle.importKey('raw', dekRaw, 'AES-GCM', false, ['encrypt']);
    const ct = await enc(dek, iv, ad, utf8(plaintext.trim()));
    return { v: 1, kid: keys.kid, iv: b64(iv), ct: b64(ct), ivk: b64(ivk), wdek: b64(await enc(keys.kek, ivk, ad, dekRaw)) };
  } finally { dekRaw.fill(0); }
}
export async function open(keys: Keys, box: Box, ctx: SecretCtx): Promise<string> {
  if (box.v !== 1 || box.kid !== keys.kid) throw new Error('BOX_KID_MISMATCH');
  const ad = aadFor(ctx), dekRaw = await dec(keys.kek, unb64(box.ivk), ad, unb64(box.wdek));
  try {
    const dek = await crypto.subtle.importKey('raw', dekRaw, 'AES-GCM', false, ['decrypt']);
    return td.decode(await dec(dek, unb64(box.iv), ad, unb64(box.ct)));
  } finally { dekRaw.fill(0); }
}
/** Rotación de KEK: re-envuelve solo la DEK; el token (ct) no se descifra ni se toca. */
export async function rewrap(from: Keys, to: Keys, box: Box, ctx: SecretCtx): Promise<Box> {
  const ad = aadFor(ctx), dekRaw = await dec(from.kek, unb64(box.ivk), ad, unb64(box.wdek));
  try {
    const ivk = crypto.getRandomValues(new Uint8Array(12));
    return { ...box, kid: to.kid, ivk: b64(ivk), wdek: b64(await enc(to.kek, ivk, ad, dekRaw)) };
  } finally { dekRaw.fill(0); }
}
/** Huella con alcance de org (decisión 1 de 05.14). Nunca descifra nada ni se compara entre orgs. */
export async function fingerprint(keys: Keys, orgId: string, secret: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', keys.fpk, te.encode(`${orgId}|${secret.trim()}`))));
}
export const sha256hex = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s))));
export const dedupeKey = (orgId: string, ruleId: string, resource: string) => sha256hex(`${orgId}|${ruleId}|${resource}`);
export function ctEqual(a: string, b: string): boolean {          // tiempo constante para hex de igual longitud
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export const last4 = (s: string) => { const t = s.trim(); return t.length >= 12 ? t.slice(-4) : ''; };
export const newIngestSecret = () =>
  'vgi_' + b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
