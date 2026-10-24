import { describe, expect, it } from 'vitest';
import { armarContactos, normalizarTelefono, type FilaContacto } from './contactos';

const fila = (clave: string, phone: string, name = 'Gabriel'): FilaContacto =>
  ({ clave, name, phone, whatsapp: true, voice: false, verified_at: null });

describe('contactos', () => {
  it('normaliza espacios, guiones y paréntesis', () => {
    expect(normalizarTelefono('+58 (412) 123-4567')).toBe('+584121234567');
  });
  it('rechaza un teléfono sin + y repetidos', () => {
    const r = armarContactos([fila('a', '584121234567'), fila('b', '+58 412 123 4567'), fila('c', '+584121234567')]);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errores.a).toMatch(/código de país/); expect(r.errores.c).toMatch(/ya está/); expect(r.errores.b).toBeUndefined(); }
  });
  it('renumera la prioridad 1…n según el orden', () => {
    const r = armarContactos([fila('a', '+584121234567'), fila('b', '+56912345678', 'Ana')]);
    expect(r.ok && r.lista.map((c) => c.priority)).toEqual([1, 2]);
  });
});
