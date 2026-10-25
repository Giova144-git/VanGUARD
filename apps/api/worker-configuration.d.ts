// Escrito a mano (S15 15.2): no hay wrangler local ni CI que corra `wrangler types` (trae workerd.exe).
// Bindings de apps/api/wrangler.jsonc y nombres del catálogo de §03.6. Ningún valor vive aquí.
interface CloudflareBindings {
  // vars de wrangler.jsonc (ORQUESTADOR) y --var del deploy command de Workers Builds
  VG_ENV?: 'local' | 'production';
  APP_ORIGIN?: string;
  VG_VERSION?: string;
  // WhatsApp real (asignaciones/back-whatsapp-real.md): '1' mientras la demo vaya por el sandbox (E27 y el despachador no
  // exigen la ventana de 24 h); número visible de VanGUARD, solo dígitos, para los enlaces wa.me de E26.
  KAPSO_SANDBOX?: string;
  KAPSO_DISPLAY_NUMBER?: string;
  // Servidor de voz de Guardia (apps/voz en Railway, asignaciones/llamada-ataque.md): https://<app>.up.railway.app.
  VOZ_URL?: string;

  // bindings (BACK)
  JOBS_Q: Queue<import('./src/jobs.ts').JobMsg>;
  RL_API: RateLimit;
  RL_COSTLY: RateLimit;
  RL_INGEST: RateLimit;
  RL_WA: RateLimit;   // respuestas de E31 a un mismo teléfono (3 / 60 s)

  // secretos de runtime: los carga Giovanni en el panel del Worker tras el primer deploy con main
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  VG_KEK_PEPPER?: string;
  VG_FP_PEPPER?: string;
  ANTHROPIC_API_KEY?: string;
  IA_CORTE?: string;
  KAPSO_API_KEY?: string;
  KAPSO_PHONE_NUMBER_ID?: string;
  KAPSO_WABA_ID?: string;
  KAPSO_WEBHOOK_SECRET?: string;
  VOZ_OPERATOR_TOKEN?: string;   // Bearer del servidor de voz (lo sube Giovanni con scripts/subir-secretos-worker.mjs)
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_AGENT_ID?: string;
  ELEVENLABS_PHONE_NUMBER_ID?: string;
  ELEVENLABS_WEBHOOK_SECRET?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_API_KEY?: string;
  TWILIO_API_SECRET?: string;
  TWILIO_FROM?: string;
  PSI_API_KEY?: string;
  VG_EDGE_SECRET?: string;
}
