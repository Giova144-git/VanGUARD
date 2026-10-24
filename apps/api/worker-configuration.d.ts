// Escrito a mano (S15 15.2): no hay wrangler local ni CI que corra `wrangler types` (trae workerd.exe).
// Bindings de apps/api/wrangler.jsonc y nombres del catálogo de §03.6. Ningún valor vive aquí.
interface CloudflareBindings {
  // vars de wrangler.jsonc (ORQUESTADOR) y --var del deploy command de Workers Builds
  VG_ENV?: 'local' | 'production';
  APP_ORIGIN?: string;
  VG_VERSION?: string;

  // bindings (BACK)
  JOBS_Q: Queue<import('./src/jobs.ts').JobMsg>;
  RL_API: RateLimit;
  RL_COSTLY: RateLimit;
  RL_INGEST: RateLimit;

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
