/// <reference types="vite/client" />

declare const __VG_COMMIT__: string;

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_USE_FIXTURES?: string;
}
