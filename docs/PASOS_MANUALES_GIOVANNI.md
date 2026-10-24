# Pasos manuales para Giovanni

Estado al sábado 24-oct, ~06:15 Caracas. Lo hace una persona porque pide entrar a un panel, tener una cuenta o pegar un secreto.

**Reglas para todos los pasos:**
- **Nunca pegues un valor secreto en un chat**, ni en el mío ni en el de FRONT o BACK, ni en `docs/`. Cuando termines un paso, escríbeme solo «listo, paso N» y yo verifico desde aquí sin ver el valor.
- **Mismo valor en local y en el Worker** para todo lo de Supabase: hay un solo proyecto (`accshmgmfrqrxubpuxcl`).
- **Dónde va cada cosa:**
  - *Secret del Worker*: **desde ahora, con `node scripts/subir-secretos-worker.mjs NOMBRE…`**, que lee el valor del `.env` de la raíz. **No uses el panel:** guardar o borrar un secreto ahí publica el código viejo que la página tenía cargado. La excepción es `SUPABASE_SECRET_KEY`, que en el Worker lleva otro valor que en local; si algún día hay que cambiarla, recarga la página del Worker justo antes y avísame para redesplegar.
  - *Local del BACK*: archivo `apps/api/.dev.vars` (no existe aún: cópialo de `apps/api/.dev.vars.example`).
  - *Local del FRONT*: archivo `apps/web/.env.development.local`.
  - *Tu lista maestra*: `.env` de la raíz. Los tres están en `.gitignore`.
- Las rutas de menú de cada panel son aproximadas: si un nombre cambió, busca el más parecido.

---

## Ahora (el backend ya está en vivo desde `fc46a10`)

### Paso 1 · Configurar Auth de Supabase · 5 min · ✅ hecho (sáb ~07:40; el BACK probó login anónimo y canales privados)
Supabase → proyecto **hackaton 22** (`accshmgmfrqrxubpuxcl`):
1. Authentication → URL Configuration:
   - **Site URL**: `https://officialvanguard.com`
   - **Redirect URLs**, exactamente estas 3, sin comodines:
     - `https://officialvanguard.com/auth/callback`
     - `https://vanguard.giovannizm14.workers.dev/auth/callback`
     - `http://localhost:5173/auth/callback`
2. Authentication → Sign In / Providers:
   - **Anonymous sign-ins: ON** (lo usa el botón «Ver demo»).
   - **Confirm email: OFF**.
   - Si aparece el límite de altas anónimas por IP, ponlo en **300 por hora**.
3. Realtime → Settings: **«Allow public access»: OFF**. Enlace directo: `https://supabase.com/dashboard/project/accshmgmfrqrxubpuxcl/realtime/settings`. En el menú está en el ícono **Realtime** de la barra izquierda, pestaña **Settings**, y suele venir bajo el título «Channel Restrictions». Si no lo ves ahí, busca en **Project Settings → Realtime**. Apágalo y pulsa **Save**. No rompe nada: la app solo usa canales privados (`org:<id>`, `private: true`).

Escríbeme «listo, paso 1» y el BACK prueba el login anónimo.

**1b · Contraseñas filtradas (1 min, cuando puedas):** Supabase → `accshmgmfrqrxubpuxcl` → Authentication → **Passwords** (o «Sign In / Providers → Email») → activa **«Prevent use of leaked passwords»**. Limpia un aviso del advisor. Si el panel dice que es solo del plan Pro, no hagas nada: se marca como aviso aceptado con su motivo.

### Paso 2 · Crear las dos claves secretas de Supabase · 3 min · ✅ hecho
Supabase → Project Settings → **API Keys** → pestaña **Secret keys** (la nueva, **no** la de *Legacy*):
1. Crea una llamada **`vanguard-worker`**. Va al panel del Worker.
2. Crea otra llamada **`vanguard-local`**. Va a tu PC.

Las dos empiezan por `sb_secret_`. **Nunca uses la `service_role` de la pestaña Legacy.**

### Paso 3 · Llenar el `.env` de la raíz · 5 min · ✅ hecho (verificado por forma, sin ver valores)
Por ahora **solo este archivo**. El Worker y las carpetas de cada app van después, en el paso 3b.

**Dónde está:** el archivo se llama `.env` y está en la carpeta principal del proyecto, la misma de `package.json`. Ya tiene las 33 líneas, cada una con la forma `NOMBRE=valor`.

**Cómo se escribe:** el valor va pegado después del `=`. Sin espacios, sin comillas, sin cambiar el nombre y sin borrar líneas. Ejemplo: `PSI_API_KEY=AIzaSy…`.

**1. Estas ya están llenas: no las toques.** Las revisé desde aquí sin ver los valores, y tienen la forma correcta.

| Línea | Qué es |
|---|---|
| `VITE_SUPABASE_URL` y `SUPABASE_URL` | La dirección del proyecto de Supabase (las dos iguales) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | La clave pública `sb_publishable_…` |
| `SUPABASE_SECRET_KEY` | La clave secreta `sb_secret_…`: la **`vanguard-local`** del paso 2 |
| `ANTHROPIC_API_KEY` | La key de Claude `sk-ant-…`: la de **`team22-dev`** |
| `VITE_API_PROXY`, `VG_ENV`, `APP_ORIGIN` | Valores fijos de desarrollo local |

**2. Estas cinco las llena un comando.** No salen de ningún panel: se inventan al azar en tu PC. En una terminal, dentro de la carpeta del proyecto:
```bash
node scripts/generar-secretos.mjs
```
Solo escribe en líneas vacías, nunca pisa un valor que ya exista y nunca muestra los valores en pantalla.

| Línea | Para qué |
|---|---|
| `VG_KEK_PEPPER` y `VG_FP_PEPPER` | Las dos «pimientas» del cifrado de las credenciales. **Cópialas también a tu gestor de contraseñas:** si se pierden, lo que guarden los clientes ya no se puede descifrar |
| `VG_HUMO_TOKEN` | Token temporal para medir la CPU del Worker (paso 4) |
| `TEST_USER_A_PASSWORD` y `TEST_USER_B_PASSWORD` | Contraseñas de los usuarios de prueba `idor-a` e `idor-b`. El BACK crea los usuarios con ellas |

**3. Estas se dejan vacías por ahora.** Cada una se llena en su paso.

| Línea | Cuándo |
|---|---|
| `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_WEBHOOK_SECRET` | Paso 7 (WhatsApp) |
| `SUPABASE_HUMO_PAT` | Paso 9 (proyecto víctima) |
| `PSI_API_KEY` | Paso 10 (sábado ~15:00) |
| `ELEVENLABS_…` (4) y `TWILIO_…` (4) | Paso 12 (llamada, P1) |
| `VG_INGEST_URL`, `VG_INGEST_CONN_ID`, `VG_INGEST_SECRET` | Cuando se cree la conexión de ingesta de la app víctima |
| `VG_EDGE_SECRET` | Solo si un paso de la auditoría se muda a una Edge Function (P1) |
| `KAPSO_WABA_ID`, `VG_VERSION`, `IA_CORTE` | **Siempre vacías** (número propio de WhatsApp, versión que pone el deploy e interruptor de emergencia) |

Escríbeme «listo, paso 3». Verifico desde aquí que las líneas estén llenas y con la forma correcta, sin ver los valores.

### Paso 3b · Pasar los valores al Worker y a cada app · 10 min · ✅ hecho (6 secretos en el Worker; `/api/me` con sesión → 200)
1. **A las carpetas de cada app**, con un comando: `node scripts/repartir-env.mjs`. Copia a `apps/api/.dev.vars` y a `apps/web/.env.development.local` solo las líneas que le tocan a cada una.
2. **Al Worker** (Cloudflare → Workers & Pages → `vanguard` → Settings → Variables and Secrets → Add → tipo **Secret**). Mismo nombre que en el `.env`, con dos excepciones marcadas:

| Secret del Worker | Valor |
|---|---|
| `SUPABASE_URL` | Igual que en el `.env` |
| `SUPABASE_SECRET_KEY` | **Distinto:** la clave **`vanguard-worker`** del paso 2, no la del `.env` |
| `ANTHROPIC_API_KEY` | **Distinto:** la key de **`team22-prod`** del paso 5 |
| `VG_KEK_PEPPER`, `VG_FP_PEPPER` | **Exactamente** las del `.env` |
| `VG_HUMO_TOKEN` | La del `.env` (se borra después del paso 4) |

Cuando esté, verifico que `/api/me` responda 401 sin token y el BACK da por aceptado el hito 1.

### Paso 4 · Token de la prueba de humo (temporal) · 2 min · ✅ hecho (prueba a las 11:01Z; secreto borrado del panel)
**Resultado:** cada paso de cola con 40 consultas a OSV gastó 21–25 ms de CPU (wall ~1,2 s), todos «ok». Es más que los 10 ms nominales del plan Free: el BACK baja la carga por paso. El secreto ya se borró y el BACK quitó la ruta del código.

Sirve para medir cuánta CPU gasta cada paso del Worker: es la evidencia de que «corre en el plan gratuito».
1. El valor ya lo creó `node scripts/generar-secretos.mjs` en el paso 3 (línea `VG_HUMO_TOKEN` del `.env`).
2. En el paso 3b se copia al Worker como Secret con el mismo nombre.
3. Escríbeme «listo, paso 4». Yo corro la prueba, anotamos las cifras y después **borras ese secreto** del panel.

### Paso 5 · Claves de Claude (Anthropic) · ✅ hecho, con una sola key
**Decidido por Giovanni:** se usa **una sola key** de Claude, la misma en el `.env` y en el Worker. Lo de abajo (dos workspaces) queda solo como referencia. El tope de gasto de esa key es la barrera final; los topes diarios por org de la app son la primera.

platform.claude.com → Settings → **Workspaces**:
1. Crea dos workspaces: **`team22-dev`** (tope de gasto **100 USD**) y **`team22-prod`** (tope **150 USD**). El tope es la barrera final si algo se descontrola.
2. En cada uno, API keys → crea una key.
3. Dónde va cada una:
   - **`team22-prod`** → Secret del Worker `ANTHROPIC_API_KEY`.
   - **`team22-dev`** → `ANTHROPIC_API_KEY` en `apps/api/.dev.vars` **y** en el `.env` de la raíz (este último lo usa la CLI de DeepWiki para la prueba real).
4. **No** crees `IA_CORTE` todavía: es el interruptor de emergencia y solo se toca si hay que apagar la IA.

### Paso 6 · Aprobar una decisión de seguridad del BACK · 1 min · ✅ aprobada la (b)
Supabase marca un aviso porque la función `join_demo_org()` (el plan B del botón «Ver demo») la puede ejecutar cualquier usuario autenticado. El BACK propone **quitar ese permiso con una migración nueva en cuanto el botón «Ver demo» funcione en producción**. Respóndeme «apruebo la (b)», o dime si prefieres dejarlo marcado como aceptado.

---

## Esta mañana (antes de las 12:00)

### Paso 7 · WhatsApp con Kapso (P0: el centro de la demo) · 20 min
Va en dos tiempos: **7A a 7D ahora**, y **7E (el webhook) cuando el BACK publique la ruta `/webhooks/kapso`**, que hoy responde 404. Si el webhook se crea antes, Kapso falla al entregar y lo pausa solo.

**7A · Unir tu teléfono al sandbox** (los menús de Kapso pueden variar un poco)
1. En Kapso, entra a tu proyecto → **WhatsApp** → **Sandbox** → **Add Test Number**.
2. Escribe **tu número de WhatsApp** con código de país (+58…) → **Create**.
3. Kapso muestra un **código de 6 caracteres** (distingue mayúsculas y **caduca en 15 min**), el número del sandbox y el botón **Open WhatsApp**.
4. Pulsa **Open WhatsApp**, envía el código desde **ese mismo teléfono** y espera la respuesta de confirmación.
5. El sandbox solo envía a números unidos. Es el teléfono que recibirá las alertas en la demo. **Repite la unión 30 min antes del pitch** para que la ventana siga abierta.

**7B · API key del proyecto**
1. Kapso → tu proyecto → **API keys** (en la configuración del proyecto) → crea una key.
2. Pégala en el `.env` de la raíz, en la línea **`KAPSO_API_KEY`**. Nunca en un chat.

**7C · Id del número y secreto del webhook, con un comando**
```bash
node scripts/kapso-config.mjs
```
Busca en tu proyecto de Kapso el número sandbox y escribe **`KAPSO_PHONE_NUMBER_ID`**. Además genera **`KAPSO_WEBHOOK_SECRET`**: ese secreto lo elegimos nosotros y Kapso firma con él cada aviso. Solo llena líneas vacías y no muestra ni la key ni el secreto.

**7D · Al Worker y a la app**
1. **No uses el panel de Cloudflare para secretos.** Al guardar un secreto ahí se publica una versión nueva con el código que la página tenía cargado, y producción vuelve a un commit viejo. Pasó el sábado a las 11:05Z. Sube los 3 con este comando, que parte de la versión desplegada:
   ```bash
   node scripts/subir-secretos-worker.mjs KAPSO_API_KEY KAPSO_PHONE_NUMBER_ID KAPSO_WEBHOOK_SECRET
   ```
2. `node scripts/repartir-env.mjs` para copiarlos a `apps/api/.dev.vars`.
3. **No** llenes `KAPSO_WABA_ID`: es para número propio, no para el sandbox.
4. Escríbeme «listo, paso 7». Yo verifico los nombres en el Worker y coordino con el BACK la primera prueba de envío.

**7E · Webhook (cuando te avise que la ruta existe)**
```bash
node scripts/kapso-config.mjs --webhook
```
Crea el webhook hacia `https://officialvanguard.com/webhooks/kapso` con los eventos recibido, entregado, leído y fallido, firmado con `KAPSO_WEBHOOK_SECRET` y sin buffering. Si ya existe uno, no lo duplica.

**7F · Tu teléfono como contacto de alerta en VanGUARD** (cuando la app web esté en `officialvanguard.com`)
Las alertas de un incidente van a los **contactos de la org** donde pasó; en la demo, la org «Tienda Demo». Para que te llegue un WhatsApp hacen falta **tres llaves**: que estés como contacto, que ese contacto esté **verificado** y que tu teléfono esté **unido al sandbox** de Kapso (7A, ya hecho).
1. **Regístrate** en `https://officialvanguard.com` con tu correo.
2. **Hazte dueño de la org de demo:** dime con qué correo te registraste y yo corro el `insert` en `org_members` (§05.11). Ese SQL no se versiona porque lleva correos.
3. En VanGUARD → **Ajustes → Contactos**: tu nombre, tu teléfono en formato **+58…**, **WhatsApp ✓**, prioridad **1** → **Guardar**. La chapa dirá «Sin verificar».
4. **Verificación:** escríbeme «verifica mi contacto». Yo marco `verified_at` en la base, sin escribir tu teléfono en ningún archivo, y la chapa pasa a «Verificado». Es la defensa contra que alguien use VanGUARD para escribirle a terceros.
5. **Prueba:** Ajustes → **Probar WhatsApp**, cuando el BACK haya desplegado Kapso y el webhook esté creado (7E). Cada prueba gasta crédito del sandbox.

**7H · Cuenta NUEVA de Kapso (sáb ~09:00, 20 USD de crédito): rehacer la configuración**
Qué cambia en el `.env` de la raíz:

| Variable | Qué hacer |
|---|---|
| `KAPSO_API_KEY` | **Cambia:** la key del proyecto de la cuenta nueva |
| `KAPSO_PHONE_NUMBER_ID` | **Cambia:** lo escribe el script (déjala como está; `--real` la pisa) |
| `KAPSO_WABA_ID` | **Nueva:** la escribe el script |
| `KAPSO_DISPLAY_NUMBER` | **Nueva:** el número visible de VanGUARD, solo dígitos; la escribe el script. No es secreto: avísame y lo pongo yo en `wrangler.jsonc` (no va con el script de secretos) |
| `KAPSO_WEBHOOK_SECRET` | **Se rota:** bórrale el valor (deja `KAPSO_WEBHOOK_SECRET=`) y el script genera uno nuevo. Así el webhook de la cuenta vieja deja de servir |
| `KAPSO_TEST_TO` | No cambia |

1. En la cuenta nueva: crea (o abre) el **primer proyecto**. Tiene que ser el primero para que el número gratis aplique.
2. **API key:** proyecto → API keys → crea una → pégala en `KAPSO_API_KEY`. Vacía `KAPSO_WEBHOOK_SECRET=`.
3. **Número real:** sigue el 7G, pasos 1 a 5 (Connected numbers → Connect new number → Instant setup → número con chapa **Verified**).
4. En tu PC:
   ```bash
   node scripts/kapso-config.mjs --real --webhook
   ```
5. Al Worker, los 4:
   ```bash
   node scripts/subir-secretos-worker.mjs KAPSO_API_KEY KAPSO_PHONE_NUMBER_ID KAPSO_WABA_ID KAPSO_WEBHOOK_SECRET
   ```
6. A la app local: `node scripts/repartir-env.mjs`.
7. **Primera prueba sin plantilla:** desde tu teléfono escribe «hola» al número nuevo de VanGUARD (abre la ventana de 24 h). Escríbeme «listo, Kapso nuevo» y el BACK te manda el interactivo; pulsa un botón.
8. Si todavía tienes acceso a la cuenta vieja, **revoca su API key y borra su webhook**.

**Si Meta dice «tu cuenta de WhatsApp Business está restringida»** (pasó el sáb ~09:30):
1. Repite el alta y, en **WhatsApp Business account**, elige **Create a WhatsApp Business account** (una NUEVA), no la existente. Si vuelve a fallar, crea también un **Business portfolio** nuevo en el mismo flujo.
2. Mira el motivo en `https://business.facebook.com/latest/whatsapp_manager/phone_numbers` y en `https://business.facebook.com/latest/settings/whatsapp_account`. Si aparece **Request Review**, pídela. Kapso no puede apelar por nosotros y Meta no da plazos.
3. Si sigue restringida: la demo va por el **sandbox de la cuenta nueva** (7A con la API key nueva, `KAPSO_PHONE_NUMBER_ID=` vacío y `node scripts/kapso-config.mjs --webhook`, sin `--real`). El número real queda pedido en paralelo.

**7G · WhatsApp REAL: número de EE. UU. de Kapso, gratis** (decidido por Giovanni: opción 1)
El plan Free trae **un número gestionado por Kapso sin depósito**: vale una vez por usuario, en tu primer proyecto, y se libera solo si pasa **30 días sin mensajes de producción**. Necesitas una cuenta de **Facebook**; la cuenta de Meta Business (portfolio) se crea en el mismo flujo si no la tienes.
1. Kapso → **Connected numbers** → **Connect new number** → **Instant setup**. Confirma el aviso de elegir un número preverificado y pulsa para abrir el alta de Meta.
2. Entra con tu Facebook. En **Seamlessly connect your account to Kapso** → **Continue**.
3. En **Add your WhatsApp phone number**, abre el desplegable **Phone number** (empieza en «Enter a new phone number») y elige un número con el maletín y la chapa **Verified**. **No** elijas «Use a display name with a virtual number instead» ni «Enter a new phone number» → **Next**.
4. **Business portfolio**: elige el tuyo o créalo. **WhatsApp Business account**: **Create a WhatsApp Business account** (nombre: VanGUARD) → **Next** → **Confirm**.
5. Cuando Meta diga **Your account is connected to Kapso** → **Finish**. Tarda unos 5 min; si Meta revisa la cuenta, el número queda pendiente un rato y Kapso reintenta solo.
6. En tu PC:
   ```bash
   node scripts/kapso-config.mjs --real --webhook
   ```
   Cambia `KAPSO_PHONE_NUMBER_ID` al número real, escribe `KAPSO_WABA_ID` y crea el webhook de ese número.
7. Al Worker: `node scripts/subir-secretos-worker.mjs KAPSO_PHONE_NUMBER_ID KAPSO_WABA_ID`.
8. Escríbeme «listo, número real». Después viene la plantilla de Meta (te paso el texto exacto) y el BACK cambia el envío.

**Ojo:** aunque el número quede conectado, Meta todavía puede frenar los envíos por la revisión del nombre visible, de la cuenta o de la plantilla. Hasta que la plantilla esté aprobada, solo se le puede escribir a quien te haya escrito primero en las últimas 24 h.

**Saldo:** el plan Free de Kapso trae **2 USD de crédito** y cada mensaje del sandbox lo gasta. Con saldo en 0, Kapso pausa los envíos. Antes de cada ensayo, mira el saldo en el panel.

### Paso 8 · Las dos pimientas del cifrado · 3 min (el BACK ya pasó el hito 2)
1. Ya las creó `node scripts/generar-secretos.mjs` en el paso 3 (`VG_KEK_PEPPER` y `VG_FP_PEPPER` del `.env`).
2. En el paso 3b van al Worker y a `apps/api/.dev.vars`. **El mismo valor en los tres sitios.**
3. **Guárdalas también en tu gestor de contraseñas.** Si se pierden, las credenciales que guarden los clientes no se pueden descifrar.
4. **Nunca las cambies** después de que alguien guarde una conexión: las credenciales ya cifradas dejarían de abrirse.

### Paso 9 · Proyecto víctima de la demo (lo hace Gabriel, en SU cuenta) · 40 min
**Decidido por Giovanni:** la víctima va en un proyecto Supabase aparte, en otra cuenta.

**Quién y por qué.** Lo hace **Gabriel**, en su propia cuenta de Supabase y en su propio GitHub. El plan le asigna el proyecto `vanguard-demo`, su token y el repo `vanguard-demo-victima`. Va aparte porque la víctima está rota a propósito y nuestro único proyecto (`accshmgmfrqrxubpuxcl`) es dev y prod a la vez. Si se siembran fallas ahí, quedan datos abiertos en producción.

**No es de este paso:** la app víctima (`demo.officialvanguard.com`) y el script del atacante son del ORQUESTADOR y de Giovanni. La clave PSI también la crea Gabriel, pero es el paso 10.

**Antes de empezar**
1. Gabriel necesita un hueco libre en su cuenta: Free permite **2 proyectos activos** contando todas las organizaciones donde es Owner/Admin (los pausados no cuentan). Si ya tiene 2, pausa uno o usa otra organización Free suya.
2. El ORQUESTADOR le pasa por canal privado `demo/seed-victima.sql`, el SQL de siembra.

**9A · Crear el proyecto (lo antes posible)**
1. Supabase → **New project**, en una organización Free suya. Nombre exacto **`vanguard-demo`**, plan **Free**, región Americas.
2. La **contraseña de la base**, fuerte y guardada en **su gestor de contraseñas**. Nunca en un chat.
3. Copia el **Project ref**: las 20 letras de la URL del proyecto. **No es secreto.** Pásaselo al ORQUESTADOR; hace falta para el repo víctima y la app víctima.

**9B · Sembrar las fallas**
1. Abre el **SQL Editor** de `vanguard-demo`. **Antes de ejecutar, mira que la URL tenga el ref de `vanguard-demo` y no `accshmgmfrqrxubpuxcl`.**
2. Pega `demo/seed-victima.sql` tal cual y ejecútalo. El SQL trae una guarda que aborta si por error se pega en la base del producto.
3. Authentication de `vanguard-demo` → **longitud mínima de contraseña 6** y **captcha apagado** (son fallas sembradas a propósito).

**9C · Token de solo lectura del proyecto**
Supabase permite hoy un token limitado a un proyecto y a solo lectura: el **scoped PAT**, que empieza por **`sbp_fc`**.
1. Abre `https://supabase.com/dashboard/account/tokens` → **Generate new token**.
2. **Resources:** «selected projects in one organization» → marca **solo `vanguard-demo`**.
3. **Permissions**, estos cinco en **Read** (los nombres del panel pueden variar un poco): **Project Settings**, **Advisors**, **Database**, **Logs** y **Auth Config**. El acceso del token no se puede editar después: si falta uno, hay que borrarlo y crear otro.
4. **Expiry:** fecha personalizada **2026-11-23**, para que dure hasta la revisión del jurado. No elijas «never».
5. Copia el valor `sbp_fc…`. **Solo se ve una vez.**
6. **Prohibido:**
   - un token **Legacy** o de cuenta completa;
   - marcar **API Key Secrets**, **Data API**, **Edge Function Secrets**, **Database JIT** o cualquier permiso **Read-write**.

   VanGUARD rechaza esos tokens al conectarlos.

**9D · Repo privado de la víctima**
1. En el GitHub de Gabriel, crea el repo **privado** vacío **`vanguard-demo-victima`**. Es privado porque lleva secretos **falsos** con forma real, y Supabase revoca las claves que aparecen en repos públicos.
2. El ORQUESTADOR lo llena con `demo/sembrar-repo.mjs`, usando el ref de 9A. Los secretos falsos se arman por concatenación y el script no imprime nada.
3. Crea un **PAT fine-grained solo de ese repo**, con **Contents: Read-only** y **Metadata: Read-only**, por 30 días. Nunca un token clásico `ghp_`.

**A dónde va cada valor (nunca por chat ni git)**
- **Token `sbp_fc…` de Supabase:**
  1. Gabriel se lo pasa a Giovanni compartiéndolo desde el gestor de contraseñas.
  2. Giovanni lo pega en el `.env` de la raíz, en la línea **`SUPABASE_HUMO_PAT`**. El paso 3b lo copia después a `apps/api/.dev.vars`.
  3. **No va al Worker.**
  4. En la demo, Gabriel lo pega en **Conexiones** de VanGUARD, en la org de demo.
- **PAT de GitHub:** Gabriel lo pega directamente en **Conexiones** de VanGUARD. No pasa por ningún `.env`.
- **Project ref:** no es secreto; puede ir al ORQUESTADOR por mensaje privado.

**Qué NO hacer**
- No invitar a nadie de nuestro equipo como Owner/Admin a la organización de la víctima: consume cupo Free, y en Free el rol Developer ve la service key.
- No conectar `vanguard-demo` al MCP de los chats.
- No sembrar nada en `accshmgmfrqrxubpuxcl`.

**Plan B:** si Gabriel no puede, Giovanni crea **otra organización Free suya** para la víctima. Nunca dentro del proyecto del producto.

**Cómo avisar:** «listo, paso 9» cuando el proyecto esté sembrado y el token esté en el `.env`. El BACK lo verifica con su prueba de humo. Aparte, «listo, repo víctima» cuando el repo y su PAT estén creados.

### Paso 10 · Clave de PageSpeed Insights · 10 min (sábado ~15:00)
1. En Google Cloud, crea un proyecto y habilita **PageSpeed Insights API**.
2. En Credentials, crea una **API key restringida solo a esa API**.
3. Guárdala como Secret del Worker **`PSI_API_KEY`** (y en `.dev.vars`).

### Paso 11 · Dominio en Squarespace · 3 min
1. **Verifica el correo del titular.** Busca el correo de Squarespace y confírmalo: si no, suspenden el dominio a los 15 días.
2. Deja activada la **renovación automática**.

---

### Paso 13 · Desplegar la app víctima en `demo.officialvanguard.com` · 10 min (sáb, antes de las 16:00)
El código ya está en `main` (`apps/victima`). Se despliega como un **segundo Worker** con su propio Workers Builds, desde el mismo espejo.
1. Cloudflare → **Workers & Pages** → **Create** → **Import a repository** → GitHub → **`Giova144-git/VanGUARD`**.
2. **Project name:** `vanguard-victima` (exacto: tiene que coincidir con `apps/victima/wrangler.jsonc`).
3. **Build command:** vacío. **Deploy command:** `npx wrangler@4.152.0 deploy -c apps/victima/wrangler.jsonc`. **Root directory:** `/` (la raíz del repo). Rama: `main`.
4. Si el panel ofrece **Build watch paths**, pon `apps/victima/*`, así no se redespliega con cada push del producto.
5. **Save and Deploy.** El dominio `demo.officialvanguard.com` lo crea el propio deploy (custom domain); no toques DNS.
6. Comprueba: `https://demo.officialvanguard.com/` carga la tienda de prueba. Escríbeme «listo, víctima».
7. **No** cargues secretos ni variables en su panel: `VG_INGEST_SECRET` lo subo con `node scripts/subir-secretos-worker.mjs --worker=vanguard-victima VG_INGEST_SECRET` cuando el BACK publique la ingesta y creemos la conexión.

### Paso 14 · Regla de Cloudflare para la víctima (T02-04) · 2 min
Sin ella, Cloudflare desafía al atacante del simulacro (user agent no estándar) y su tráfico nunca llega a la víctima, así que no hay incidente que mostrar. Solo afecta a `demo.officialvanguard.com`; `officialvanguard.com` sigue igual.
1. Cloudflare → zona `officialvanguard.com` → **Rules** → **Configuration Rules** → **Create rule**.
2. Nombre: `T02-04 victima sin BIC`. **If incoming requests match:** Field **Hostname** · Operator **equals** · Value `demo.officialvanguard.com`.
3. **Then the settings are:** **Browser Integrity Check** → **Off**. **Deploy**.
(Esta regla es de la zona, no del Worker: no publica ninguna versión ni revierte código.)

## Después de que WhatsApp funcione de punta a punta (P1)

### Paso 12 · Llamada de voz (ElevenLabs + Twilio de prueba) · 30 min
1. **Twilio, cuenta de prueba, sin pagar:**
   - Verifica los teléfonos del equipo que van a recibir la llamada.
   - Activa el permiso geográfico para **Venezuela**.
   - Si la cuenta de prueba no deja llamar a +58, avísame y usamos la voz dentro de la app, que no necesita número.
2. **ElevenLabs:**
   - Crea el agente **«VanGUARD»** e importa el número de Twilio.
   - Crea una API key con tope de créditos.
3. **Secrets del Worker:** `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` y `ELEVENLABS_PHONE_NUMBER_ID`.
4. **No pagues Twilio** sin decidirlo antes (presupuesto en efectivo = 0).

---

## Domingo por la mañana (trabajo de personas, no de chats)
- **README:** escrito a mano por una persona (regla del hackatón). El plan trae el esquema en la sección 16.9.
- **Video de respaldo** de la demo, de 3 minutos, con el WhatsApp real. Guárdalo en la nube del equipo y en un pendrive, **no** en git.
- **Logo** de VanGUARD de 1000×1000 px y máx. 500 KB, para reemplazar `project-logo.png`.
- **Pitch** y ensayo del guion: sección 16.7 del plan.

---

## Anexo · De dónde sale cada variable del `.env`

**Leyenda:**
- **Cuándo:** **Ya** = ahora · **Mañana** = esta mañana · **P1** = después de que WhatsApp funcione · **Vacía** = se deja así.
- **Generar** = lo llena `node scripts/generar-secretos.mjs` (paso 3). La única excepción es `VG_EDGE_SECRET`, que se genera aparte y solo si hace falta, con `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.

| Variable | De dónde sale | Cuándo |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase → Project Settings → Data API → Project URL: `https://accshmgmfrqrxubpuxcl.supabase.co` | Ya ✅ |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase → Project Settings → API Keys → **Publishable key** (`sb_publishable_…`) | Ya ✅ |
| `VITE_API_PROXY` | Fijo: `http://localhost:8787` (lo pone el script) | Ya |
| `VG_ENV` | Fijo: `local` (lo pone el script) | Ya |
| `APP_ORIGIN` | Fijo: `http://localhost:5173` (lo pone el script) | Ya |
| `VG_VERSION` | Nada: en producción la pone el deploy | Vacía |
| `SUPABASE_URL` | Igual que `VITE_SUPABASE_URL` | Ya ✅ |
| `SUPABASE_SECRET_KEY` | Supabase → API Keys → **Secret keys** → crear `vanguard-local` (en local) y `vanguard-worker` (en el Worker). **No** la `service_role` legacy | Ya ✅ |
| `ANTHROPIC_API_KEY` | platform.claude.com → Settings → Workspaces → `team22-dev` (local) y `team22-prod` (Worker) → API keys | Ya ✅ |
| `VG_HUMO_TOKEN` | **Generar** (temporal; se borra tras la prueba) | Ya (paso 4) |
| `VG_KEK_PEPPER` | **Generar**. El mismo valor en local y en el Worker; guárdalo en tu gestor de contraseñas | Mañana (hito 2) |
| `VG_FP_PEPPER` | **Generar** otro distinto. Igual que la anterior | Mañana (hito 2) |
| `KAPSO_API_KEY` | Kapso → tu proyecto → API keys | Mañana (paso 7) |
| `KAPSO_PHONE_NUMBER_ID` | Kapso → WhatsApp → Sandbox: id del número del sandbox | Mañana (paso 7) |
| `KAPSO_WEBHOOK_SECRET` | Kapso → Webhooks → crear uno con URL `https://officialvanguard.com/webhooks/kapso` → copiar su secreto | Mañana (paso 7) |
| `KAPSO_WABA_ID` | Solo con número propio de WhatsApp Business (no con el sandbox) | Vacía |
| `SUPABASE_HUMO_PAT` | Supabase (cuenta de Gabriel) → Account → Access Tokens → **scoped PAT** (`sbp_fc…`) solo del proyecto `vanguard-demo`, con 5 permisos en Read y caducidad 2026-11-23 (detalle en el paso 9). Solo local, nunca en el Worker | Paso 9 |
| `PSI_API_KEY` | Google Cloud → APIs & Services → habilitar **PageSpeed Insights API** → Credentials → API key restringida a esa API | Sáb ~15:00 (paso 10) |
| `TEST_USER_A_PASSWORD`, `TEST_USER_B_PASSWORD` | **Generar** dos contraseñas cualesquiera; el BACK crea con ellas los usuarios de prueba `idor-a@vanguard.test` e `idor-b@vanguard.test`. Solo local | Cuando el BACK las pida |
| `VG_EDGE_SECRET` | **Generar**. Solo si un paso de la auditoría se muda a una Edge Function de Supabase | Vacía por ahora |
| `ELEVENLABS_API_KEY` | elevenlabs.io → Developers → API Keys (con tope de créditos) | P1 (paso 12) |
| `ELEVENLABS_AGENT_ID` | ElevenLabs → Agents → agente «VanGUARD» → su id | P1 |
| `ELEVENLABS_PHONE_NUMBER_ID` | ElevenLabs → Phone Numbers → el número de Twilio importado | P1 |
| `ELEVENLABS_WEBHOOK_SECRET` | ElevenLabs → Agents → Webhooks | P1 |
| `TWILIO_ACCOUNT_SID` | console.twilio.com → Account Info (`AC…`), cuenta de **prueba** | P1 |
| `TWILIO_API_KEY`, `TWILIO_API_SECRET` | Twilio → Account → API keys & tokens → crear (`SK…` y su secreto) | P1 |
| `TWILIO_FROM` | Twilio → Phone Numbers → el número de prueba, en formato `+1…` | P1 |
| `IA_CORTE` | Nada: es el interruptor de emergencia de la IA y solo se pone en `1`, en el panel del Worker, si hay que apagarla | Vacía |
| `VG_INGEST_URL` | Lo usa la app víctima; en producción, `https://officialvanguard.com/ingest/v1/events` | Sáb ~15:00 (app víctima) |
| `VG_INGEST_CONN_ID` | Se ve al crear la conexión «ingesta» en Conexiones de VanGUARD | Sáb ~15:00 |
| `VG_INGEST_SECRET` | Se muestra **una sola vez** al crear esa conexión (`vgi_…`) | Sáb ~15:00 |

## Ya está hecho (no tienes que hacer nada)
- **Dominio y zona:** `officialvanguard.com` en Cloudflare, con DNSSEC, HTTPS estricto, SPF y DMARC.
- **Deploy automático:** cada push a `main` despliega con Workers Builds.
- **Colas** `vg-jobs` y `vg-jobs-dlq` creadas.
- **Variables de build** `VITE_SUPABASE_*` cargadas.
- **Base de datos:** migraciones `0001`–`0003` aplicadas y el backend en vivo (`/api/health` → 200).
