// zod 4 prueba `Function('')` al crear cada z.object para su JIT: con script-src 'self' deja una violación de CSP
// en cada carga. jitless se lee al construir el schema, así que main.tsx importa esto antes que nada de @vanguard/contracts.
import { z } from 'zod';

z.config({ jitless: true });
