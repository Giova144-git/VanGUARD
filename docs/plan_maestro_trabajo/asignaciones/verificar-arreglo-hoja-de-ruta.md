# «Verificar arreglo» (E16): propuesta para la hoja de ruta

Propuesta del BACK (sáb 24-oct, ~17:50 de Caracas). No entra en el hackatón: Giovanni pidió simplificar a lo esencial, y
no se mete una migración nueva (0014) en producción la víspera con el FRONT al límite. Queda escrita tal cual para
retomarla. Al final va un bug real de `vg_upsert_findings` que aparece al diseñarla.

Referencias: PLAN_MAESTRO.md línea ~5953 (botón «Verificar arreglo» de Codebase), §07 («corre solo la fuente de esa
regla y llama con `p_rule`») y §15.12 (`vg_upsert_findings`).

---

## 1. Qué hace

En el detalle de un hallazgo de Codebase, un admin pulsa «Verificar arreglo». VanGUARD vuelve a leer los archivos de
riesgo del repo, corre solo la regla de ese hallazgo y lo marca `verified` si ya no aparece, o lo deja abierto (con
`last_seen_at` nuevo) si sigue ahí.

## 2. Cómo no cuenta como «última auditoría»

Problema: `rutas/overview.ts`, `estado/modulo.ts` y `scans/cobertura.ts` leen el último `scan_runs` de la org sin mirar el
`kind`. Una mini-corrida guardada en `scan_runs` pasaría por «última auditoría» y movería el puntaje y la cobertura. Es el
mismo problema que llevó la revisión de código a su propia tabla, `code_reviews`.

Decisión: **no se crea ninguna fila en `scan_runs`.** Overview, módulo y cobertura no se tocan.

## 3. Diseño

- **Ruta:** `POST /api/orgs/:org/findings/:id/verify`. Solo admin (`requireAdmin`, `anonReadOnly`), `RL_COSTLY` por usuario y `requireColaPropia` (fuera del host real → 403).
- **A qué hallazgos aplica:** solo a los de la auditoría de repo:
  - `module = 'codebase'`;
  - `connection_id` no nulo;
  - conexión GitHub `read` activa;
  - `rule_id` en `CB_SECRET_*`, `CB_ENV_COMMITTED` o `CB_GITIGNORE_NO_ENV`.
- **A cuáles no aplica:** responden 409 con `details.reason` y el texto «Vuelve a analizar el repo».
  - ZIP y revisión de código: `connection_id` nulo.
  - `CB_DEP_VULN`: OSV va en varios mensajes.
  - `CB_ENV_IN_HISTORY`: historial.
- **Cola:** mensaje nuevo `{v:1, kind:'verify', org_id, finding_id}`. El manejador:
  - lee el hallazgo (con `.eq('org_id')`), la conexión y el PAT (`withSecret`);
  - reutiliza `arbolRepo`, `elegirArchivosRiesgo`, `leerContenidos`, `escanearSecretos`, `reglasEnv` y `aFila`, filtrando a la regla del hallazgo;
  - llama a la RPC de abajo.
  - Presupuesto de §09.4: unas 25 subpeticiones como mucho. Un mensaje repetido vuelve a evaluar sin daño.
- **RPC nueva (0014) `vg_verify_finding(p_org, p_finding, p_rows)`:** en una transacción decide SOLO ese hallazgo.
  - Si su `dedupe_key` vuelve a salir, sigue o se reabre como en el upsert: `last_seen_at`, evidencia, `fixed`/`verified` → `open` con `'reapareció'`.
  - Si no, `open`/`fixed` → `verified` con `status_reason = 'no reapareció al verificar'`.
  - `ignored` se respeta.
  - `revoke` a public, anon y authenticated; `grant` a service_role.
- **Resultado para la UI:** llega por Realtime. El broadcast de `findings` ya salta con el update y pasa a `verified` o, si sigue, cambia `last_seen_at`. El FRONT espera hasta 60 s y, si no llega nada, muestra «No pudimos verificar ahora».

## 4. Contrato propuesto (`packages/contracts/src/api.ts`)

```ts
// E16 · POST /api/orgs/:org/findings/:id/verify · admin · P1. Sin cuerpo. 202: encolado; el resultado llega por
// Realtime en findings (status 'verified' si no reapareció; si sigue, last_seen_at nuevo y status 'open').
export const FindingVerifyAccepted = z.object({ finding_id: Id, status: z.literal('queued') });
export type FindingVerifyAccepted = z.infer<typeof FindingVerifyAccepted>;
// 409 conflict con details.reason (ApiError de siempre): por qué este hallazgo no se puede verificar solo.
export const FindingVerifyNoAplica = z.enum(['zip', 'revision_codigo', 'regla', 'sin_conexion', 'conexion_inactiva']);
export type FindingVerifyNoAplica = z.infer<typeof FindingVerifyNoAplica>;
```

Errores:

| Código | Cuándo |
|---|---|
| 404 `not_found` | El hallazgo no es de la org |
| 403 `forbidden` | Viewer, anónimo, o fuera del host real |
| 409 `conflict` con `details.reason` | El hallazgo no se puede verificar solo (`FindingVerifyNoAplica`) |
| 429 `rate_limited` | `RL_COSTLY` por usuario |

## 5. Pruebas mínimas

- Hallazgo que ya no está → `verified`. El que sigue → `open` con `last_seen_at` nuevo. `ignored` → igual.
- 409 en ZIP, revisión de código, `CB_DEP_VULN`, `CB_ENV_IN_HISTORY`, sin conexión y conexión inactiva.
- 404 con un hallazgo de otra org (IDOR).
- Viewer y anónimo → 403.
- Sin fila en `scan_runs`: overview y cobertura no cambian.
- Dos verificaciones seguidas del mismo hallazgo dan el resultado correcto, lo que cubre el bug de §6.

Estimación: ≈ 1 h 45 con 0014, pruebas y verificación adversarial.

---

## 6. Bug real de `vg_upsert_findings` con `p_scan` nulo (0004)

`supabase/migrations/0004_scans_findings.sql`, auto-verificación:

```sql
update public.findings g set status = 'verified', verified_at = now(), status_reason = 'no reapareció en la auditoría'
 where g.org_id = p_org and g.module = p_module and g.status in ('open', 'fixed')
   and g.connection_id is not distinct from p_conn
   and g.scan_run_id is distinct from p_scan and (p_rule is null or g.rule_id = p_rule);
```

y el upsert hace `scan_run_id = excluded.scan_run_id` en cada fila que vuelve a salir.

**Qué falla:** quien llame con `p_scan = null` (una corrida sin fila en `scan_runs`, como la de E16 si se hiciera así)
deja `scan_run_id = null` en todo lo que reaparece. En la siguiente corrida con `p_scan = null`, `null is distinct from
null` es `false`, así que esas filas **nunca** pasan a `verified` aunque ya no aparezcan.

Ejemplo:
1. La primera verificación encuentra el secreto, que queda `open` con `scan_run_id = null`.
2. El usuario lo arregla.
3. La segunda verificación ya no lo encuentra, pero la fila sigue `open`.

Lo mismo pasa con cualquier hallazgo cuya corrida se borró: la FK es `on delete set null`.

**Hoy no se dispara:** las auditorías siempre pasan un `scan_run_id` real. Lo dispararía cualquier llamada futura sin
corrida, o una corrida borrada (retención) seguida de una auditoría completa: esta sí lo cierra, porque `p_scan` no es
nulo y `null is distinct from <uuid>` es `true`.

**Arreglos posibles:**
- (a) No llamar a `vg_upsert_findings` sin corrida. Para E16, la RPC propia de §3.
- (b) Cambiar el filtro a `(p_scan is null and g.last_seen_at < <inicio de esta llamada>) or (p_scan is not null and g.scan_run_id is distinct from p_scan)`, y tocar `last_seen_at` en el upsert. Cambia el comportamiento de todas las auditorías, así que necesita sus pruebas SQL.
