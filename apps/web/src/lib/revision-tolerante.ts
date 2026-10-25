// E45 tolerante (riesgo (a) del informe de pausa del FRONT). CodeReviewState del contrato es estricto: un valor nuevo
// del BACK en `gate.error`, en CommitStatusState o en el estado del hook dejaba la consulta en error y la tarjeta de
// revisión entera desaparecía. Este esquema se deriva del contrato sin tocarlo y degrada pieza a pieza:
// - estado del hook desconocido: se deja pasar; chipHook lo pinta «—» y no hay texto de error;
// - last_error del hook, delivery y delivery_error desconocidos: null (los textos por defecto ya existen);
// - gate de la revisión: state desconocido → null («nada todavía»); error o pr_close_error con otro formato → 'otro'
//   (textoErrorBloqueo y el de cierre dan su texto por defecto);
// - config.gate que no cumple: se quita (no se pinta la sección de bloqueo, la tarjeta sí);
// - revisiones o hallazgos de revisión que aun así no cumplen: se saltan uno a uno.
import { z } from 'zod';
import {
  CodeReview, CodeReviewAlert, CodeReviewConfig, CodeReviewDelta, CodeReviewFinding, CodeReviewHookError,
  CodeReviewHookState, CodeReviewState, CommitStatusState, MergeGateConfig, MergeGateReview, NotificationStatus,
} from '@vanguard/contracts';

// Filtra una lista: lo que no cumple `s` se salta en vez de tumbar la lista entera.
const listaQueCumple = <T extends z.ZodType>(s: T, max: number) => z.array(z.unknown()).max(max)
  .transform((xs) => xs.flatMap((x) => { const r = s.safeParse(x); return r.success ? [r.data as z.output<T>] : []; }));

const Hallazgos = listaQueCumple(CodeReviewFinding, 50);

const GateRevision = MergeGateReview.extend({
  findings: listaQueCumple(CodeReviewFinding, 20),
  state: CommitStatusState.nullable().catch(null),
  error: MergeGateReview.shape.error.catch('otro'),
  pr_close_error: MergeGateReview.shape.pr_close_error.catch('otro'),
});

const Aviso = CodeReviewAlert.extend({
  state: CodeReviewAlert.shape.state.catch('none'),
  delivery: NotificationStatus.nullable().catch(null),
  delivery_error: CodeReviewAlert.shape.delivery_error.catch(null),
});

const Revision = CodeReview.extend({
  findings: Hallazgos, alert: Aviso,
  gate: GateRevision.optional().catch(undefined),
  delta: CodeReviewDelta.nullable().optional().catch(null),
});

const Config = CodeReviewConfig.extend({
  // Un estado nuevo llega tal cual: chipHook tiene `default` («—») y la tarjeta solo compara con valores conocidos.
  state: CodeReviewHookState.catch((c) => (typeof c.input === 'string' ? c.input.slice(0, 40) : 'off') as CodeReviewHookState),
  last_error: CodeReviewHookError.nullable().catch(null),
  gate: MergeGateConfig.optional().catch(undefined),
});

export const CodeReviewStateTolerante = CodeReviewState.extend({
  reason: CodeReviewState.shape.reason.catch(null),
  config: Config.nullable(),
  recent: listaQueCumple(Revision, 10),
}) as unknown as z.ZodType<CodeReviewState>;
