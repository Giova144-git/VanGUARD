// Contactos de alerta (S14 §14.18): normalización E.164 y validación local antes del PUT (la autoridad es ContactsPut).
import type { ContactIn } from '@vanguard/contracts';

export const E164 = /^\+[1-9]\d{7,14}$/;
export const normalizarTelefono = (t: string) => t.replace(/[\s\-().]/g, '');

export type FilaContacto = { clave: string; id?: string; name: string; phone: string; whatsapp: boolean; voice: boolean; verified_at: string | null };

// Devuelve la lista lista para el PUT (prioridad = orden 1…n) o los errores por fila.
export function armarContactos(filas: FilaContacto[]): { ok: true; lista: ContactIn[] } | { ok: false; errores: Record<string, string> } {
  const errores: Record<string, string> = {};
  const vistos = new Set<string>();
  const lista = filas.map((f, i) => {
    const phone = normalizarTelefono(f.phone);
    const name = f.name.trim();
    if (name.length < 2 || name.length > 60) errores[f.clave] = 'El nombre va de 2 a 60 caracteres';
    else if (!E164.test(phone)) errores[f.clave] = 'Teléfono con + y código de país, por ejemplo +58 412 123 4567';
    else if (vistos.has(phone)) errores[f.clave] = 'Ese teléfono ya está en la lista';
    vistos.add(phone);
    return { name, phone_e164: phone, whatsapp: f.whatsapp, voice: f.voice, priority: i + 1 };
  });
  if (filas.length > 5) errores._ = 'Máximo 5 contactos';
  return Object.keys(errores).length ? { ok: false, errores } : { ok: true, lista };
}
