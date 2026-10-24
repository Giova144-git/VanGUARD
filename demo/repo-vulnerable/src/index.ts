// Panel de pedidos de la tienda demo (Hono sobre Cloudflare Workers).
// Copia reducida de apps/victima: /admin queda SIN autenticación a propósito (lo usa la demo en vivo).
import { Hono } from 'hono'
import { supabaseAdmin } from './lib/supabaseAdmin'

const app = new Hono()

app.get('/', (c) => c.html('<h1>Tienda demo</h1><p>Panel de pedidos</p>'))

// /admin sin auth: cualquiera lista los pedidos usando la clave service_role del servidor.
app.get('/admin', async (c) => {
  const { data } = await supabaseAdmin.from('pedidos').select('*').limit(100)
  return c.json({ pedidos: data ?? [] })
})

export default app
