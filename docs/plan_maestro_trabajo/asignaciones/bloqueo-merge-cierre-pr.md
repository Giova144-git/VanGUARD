# Anexo a «bloqueo-merge-criticos.md»: VanGUARD cierra el PR con críticos

Decisión de Giovanni (sáb 24-oct, ~20:00 de Caracas). Manda sobre lo que diga la especificación principal.

## Por qué

GitHub decide quién puede pulsar «Merge». Un estado ✗ (o una GitHub Action) solo informa. Lo que convierte el ✗ en
bloqueo es la regla «Require status checks to pass before merging» de la protección de rama, que GitHub ofrece gratis
solo en repos **públicos**; en repos **privados** exige Pro, Team o Enterprise
([About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).
El repo de la demo es privado y de una cuenta gratuita, y el bloqueo tiene que funcionar para **cualquier cliente**.
Lo único que impide fusionar en cualquier plan es que el PR esté **cerrado**.

## Qué cambia

1. **Permiso del token de escritura** (el 2.º token de GitHub de la especificación principal): además de
   «Commit statuses: Read and write», **«Pull requests: Read and write»**, y opcional **«Issues: Read and write»** para el botón «Crear issue» del WhatsApp (anexo `avisos-whatsapp-botones.md`). Nada de Contents ni Administration.
   El BACK verifica en la tabla oficial de permisos de los PAT fine-grained que cerrar un PR
   (`PATCH /repos/{o}/{r}/pulls/{n}` con `state: closed`) y comentarlo (`POST /repos/{o}/{r}/issues/{n}/comments`) caben
   en ese permiso; si el comentario exige además «Issues: write», se añade y se dice en la guía.
2. **Cuándo cierra:** en una revisión de `pull_request` (opened, synchronize, reopened, ready_for_review) contra la rama
   vigilada, si hay al menos un hallazgo **nuevo** con severidad ≥ el umbral de bloqueo (crítico por defecto). También en
   PR de forks (cerrar no avisa a nadie y protege más), con el tope de PR de forks que ya existe.
3. **Qué hace, en este orden y una sola vez por revisión y PR** (idempotente por `code_review_id`):
   1. publica el estado `failure` (ya especificado);
   2. comenta con **texto fijo**, sin texto del autor del PR ni de la IA:
      «VanGUARD cerró este pull request: trae {n} hallazgo(s) crítico(s) nuevo(s). Corrige el código, rota las claves
      expuestas y vuelve a abrirlo. Detalle: {URL del panel con ?revision=<id>}». Sin rutas ni valores (una ruta puede
      venir del atacante o contener un secreto);
   3. cierra el PR (`state: closed`).
   Si el comentario falla, igual cierra. Si el cierre falla (permiso, 404, 422), la revisión guarda el motivo y la
   tarjeta lo dice; el WhatsApp sale igual.
4. **Respeto a la decisión humana:** si una persona reabre el PR (evento `reopened` con `sender` humano) **sin commits
   nuevos**, VanGUARD **no** lo vuelve a cerrar: mantiene el ✗ y deja constancia en la revisión («reabierto a mano»). Si
   llegan commits nuevos con un crítico nuevo, se aplica el punto 3 otra vez.
5. **Interruptor por repo** en la tarjeta de revisión: «Cerrar los PR con críticos». Encendido por defecto si el token
   tiene el permiso de pull requests; apagado y con el motivo si no lo tiene. Solo owner y admin lo cambian.
6. **Deshacer:** desde la fila de la revisión, «Reabrir el PR» (owner o admin, con confirmación) hace `state: open` y
   deja el ✗. No borra el comentario.
7. **Push directo a `main`:** no se puede deshacer desde fuera en ningún plan. Se avisa (✗ + WhatsApp) y la tarjeta
   recomienda exigir PR en la rama (protección de rama) cuando el plan lo permita. Con un secreto, lo único que sirve es
   rotarlo: ya quedó en el historial.

## Contrato (lo pone el ORQUESTADOR tras la reconciliación)

Aditivo y opcional, sobre los tipos del bloqueo ya reconciliados:
- en la configuración del bloqueo: `close_pr: boolean` (el interruptor) y `can_close_pr: boolean` (el token tiene el permiso);
- en cada revisión de PR: `pr_action: 'closed' | 'reopened_by_human' | 'close_failed' | null` y `pr_close_error` (código corto, como `delivery_error`);
- en el PUT del bloqueo: `close_pr?: boolean`; y una acción «Reabrir el PR» en el mismo endpoint de «Dar por bueno»/«Deshacer» (E54).

## Demo

PR con la clave falsa (`demo/empujar-revision.mjs` en una rama y PR hacia `main`) → ✗ rojo, PR **cerrado** con el
comentario de VanGUARD y WhatsApp. Se dice: «En repos públicos o de pago, además, GitHub obliga a pasar el check».

## Estimación

BACK ≈ 45 min (permiso en la sonda, cierre y comentario idempotentes, reapertura humana, tests). FRONT ≈ 30 min
(interruptor, chip «PR cerrado por VanGUARD», «Reabrir el PR», texto de la guía del 2.º token).
