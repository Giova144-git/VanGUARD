// Cliente admin de Supabase (service_role). NO debería acabar en el bundle del navegador.
import { createClient } from '@supabase/supabase-js'

const clave = import.meta.env.VITE_SB_ADMIN ?? '__VG_SERVICE_ROLE_JWT__'
export const supabaseAdmin = createClient(import.meta.env.VITE_SB_URL ?? '', clave)
