import { describe, expect, it } from 'vitest';
import { fixtures as fx } from '@vanguard/contracts';
import { parsearMermaid, partir } from './mermaid';

describe('parsearMermaid', () => {
  it('parsea el diagrama del fixture: 6 nodos y 6 aristas en columnas por camino más largo', () => {
    const g = parsearMermaid(fx.wikiDoc.mermaid!)!;
    expect(g).not.toBeNull();
    expect(g.nodos).toHaveLength(6);
    expect(g.aristas).toHaveLength(6);
    const col = Object.fromEntries(g.nodos.map((n) => [n.id, n.col]));
    expect(col.Cliente).toBe(0);
    expect(col.Tienda).toBe(1);
    expect(col.Admin).toBe(2);
    expect(col.Datos).toBe(3);                              // Cliente → Tienda → Admin → Datos es el camino más largo
    expect(g.nodos.find((n) => n.id === 'Datos')!.etiqueta).toBe('Base de datos Supabase');
    expect(g.aristas.find((a) => a.de === 'Cliente')!.texto).toBe('compra');
  });
  it('rechaza lo que no está en la lista blanca', () => {
    expect(parsearMermaid('graph TD\n  A --> B')).toBeNull();
    expect(parsearMermaid('flowchart LR\n  A[<img src=x onerror=alert(1)>] --> B')).toBeNull();
    expect(parsearMermaid('flowchart LR\n  click A "https://evil.test"')).toBeNull();
    expect(parsearMermaid('flowchart LR\n  A --> B\n  style A fill:#f00')).toBeNull();
  });
  it('no se queda en bucle con ciclos', () => {
    const g = parsearMermaid('flowchart LR\n  A --> B\n  B --> A');
    expect(g?.nodos).toHaveLength(2);
  });
  it('parte etiquetas largas en dos líneas', () => {
    expect(partir('Base de datos Supabase')).toEqual(['Base de datos', 'Supabase']);
    expect(partir('Corto')).toEqual(['Corto']);
  });
});
