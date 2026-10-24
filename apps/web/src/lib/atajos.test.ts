import { describe, expect, it } from 'vitest';
import { leerTecla } from './atajos';

const t = (key: string, extra: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; target: EventTarget | null }> = {}) =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, ...extra });

describe('leerTecla', () => {
  it('g y luego una letra navega', () => {
    const a = leerTecla(t('g'), false);
    expect(a).toEqual({ accion: { tipo: 'esperar' }, gPendiente: true });
    expect(leerTecla(t('i'), true)).toEqual({ accion: { tipo: 'ir', destino: 'incidents' }, gPendiente: false });
    expect(leerTecla(t('r'), true).accion).toEqual({ tipo: 'ir', destino: 'overview' });
  });
  it('una letra sin g o una letra desconocida no hace nada', () => {
    expect(leerTecla(t('i'), false).accion).toBeNull();
    expect(leerTecla(t('z'), true)).toEqual({ accion: null, gPendiente: false });
  });
  it('Ctrl+K y Cmd+K abren la paleta; Ctrl+F, Ctrl+1 y F5 no se tocan', () => {
    expect(leerTecla(t('k', { ctrlKey: true }), false).accion).toEqual({ tipo: 'paleta' });
    expect(leerTecla(t('K', { metaKey: true }), false).accion).toEqual({ tipo: 'paleta' });
    expect(leerTecla(t('f', { ctrlKey: true }), false).accion).toBeNull();
    expect(leerTecla(t('1', { ctrlKey: true }), false).accion).toBeNull();
    expect(leerTecla(t('F5'), false).accion).toBeNull();
  });
  it('dentro de un campo de texto no hay atajos de letra', () => {
    const input = { tagName: 'INPUT', isContentEditable: false, closest: () => null } as unknown as EventTarget;
    expect(leerTecla(t('g', { target: input }), false).accion).toBeNull();
    const editable = { tagName: 'DIV', isContentEditable: true, closest: () => null } as unknown as EventTarget;
    expect(leerTecla(t('g', { target: editable }), false).accion).toBeNull();
    const boton = { tagName: 'BUTTON', isContentEditable: false, closest: () => null } as unknown as EventTarget;
    expect(leerTecla(t('g', { target: boton }), false).accion).toEqual({ tipo: 'esperar' });
  });
});
