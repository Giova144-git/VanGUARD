# R03 — KUADRA «Freno de tasa»: modelo de datos y chequeos portables para detectar «función expuesta sin rate limit»

Etapa 1 de 4 del plan maestro, team-22, Platanus Hack 26. Lectura en SOLO LECTURA de KUADRA (no se tocó nada).

**Fuentes leídas:**
- `KUADRA CRM/kuadra_crm/lib/modulos/freno/` completo (25 ficheros, 12.162 líneas): `servicio.dart`, `modelo_estado.dart`,
  `acciones.dart`, `ahora.dart`, `controlador.dart`, `cabecera.dart`, `pantalla.dart`, `sectores_freno.dart`, `modulo.dart`,
  `listas/*` (datos, edges, orígenes por IP, auditoría, clases, funciones, controlador) y `detalle/*` (lectura, función,
  clase, cambios, enganche).
- El Dart **no decide nada**: pinta lo que devuelven 22 RPC `plataforma.crm_freno_*` de la base. Por eso se leyó también el
  SQL que las define en `KUADRA MASTER/supabase/migrations/`: `20260830100000_rate_limit_en_la_base_guardia_peticion.sql`
  (guardia v1), `20260926233228_crm_ola2b_za_motor_freno_sombra.sql` (catálogo, clases, reglas, resolvedor),
  `20260927171750_crm_ola2b_etapa3_guardia_nuevo.sql` (guardia vivo), `20260927174307_crm_ola2b_e3_llamadores_arreglos.sql`
  (cobertura C1-C15), `20260927004717_crm_ola2b_zd1_lecturas_panel.sql` (huella, sugerido, aceptados),
  `20260927002338/005032_crm_ola2b_zf_*` (inventario de edges), `20260926232301_crm_ola2b_zc_rastro.sql` (rastro por hora),
  `20260830110000_*` y `20260830225900_*` (contador y su incidente), `20261018001431_crm_ola4_b_freno_c6_y_propio.sql`,
  `supabase/functions/_compartido/freno.ts` (limitador de edges) y `kuadra_crm/lib/nucleo/supabase_gestion_api.dart`.

**Marcas:** `[KUADRA: fichero]` = sale del código de KUADRA (los comentarios dicen cuándo algo se midió por HTTP contra su
proyecto real). `[verificado: URL]` = comprobado hoy en doc oficial o en el OpenAPI oficial
(`https://api.supabase.com/api/v1-json`, descargado el 2026-10-24). `[no verificado]` = no se pudo comprobar.

---

## 1. Lo esencial en 8 líneas

1. KUADRA frena **en la base**, no en Cloudflare: un gancho `pgrst.db_pre_request` (`plataforma.guardia_peticion`) corre antes
   de cada petición de PostgREST y corta con `PT429` → HTTP 429 `[KUADRA: guardia v1, medido por HTTP]`.
2. Hay **tres superficies** y cada una necesita su freno: RPC de PostgREST, tablas escribibles por REST y Edge Functions
   (estas no pasan por el gancho; llevan `freno.ts` en su código) `[KUADRA: guardia v1, cabecera «LO QUE NO TAPA»]`.
3. Qué está expuesto se **calcula del catálogo de Postgres**, no se escribe a mano: `pg_proc` + `has_function_privilege('anon'|
   'authenticated', oid, 'EXECUTE')` dentro de los esquemas expuestos (`plataforma.freno_resolver()`).
4. Cada ruta cae en una **clase** por reglas ordenadas (quién la llama × volatilidad × regex de nombre × regex de argumentos):
   24 clases con techo por minuto, de 3/min (irreversible) a 600/min (lecturas del POS).
5. La «auditoría» son **15 invariantes C1-C15** calculados en SQL; los que tocan exposición son C5-C10, C13 y C14.
6. Origen por IP: `cf-connecting-ip` → `sb-forwarded-for` → **último** elemento de `x-forwarded-for`. La guía oficial de
   Supabase usa el **primero**, que lo elige el cliente: eso es un chequeo en sí mismo (RL-05).
7. Para un cliente cualquiera todo se puede detectar **en solo lectura**: una consulta SQL al catálogo
   (`POST /v1/projects/{ref}/database/query/read-only`, Beta) + `GET /v1/projects/{ref}/functions` y su `/body`.
8. No hace falta IA para detectar: son reglas deterministas. Claude solo redacta la explicación y el prompt de corrección.

---

## 2. Cómo está montado en KUADRA

### 2.1 Transporte del panel `[KUADRA: servicio.dart]`
- Todo va por `POST {SUPABASE_URL}/rest/v1/rpc/<nombre>` con `apikey` y `Authorization: Bearer <service_role>`,
  `Content-Profile: plataforma` (sin esa cabecera PostgREST busca en `public` y da 404), timeout 20 s.
- Lista blanca de RPC en el cliente (`rpcDelFreno`, 22 nombres): una acción que proponga la base con otro nombre se rechaza
  con `rpc_no_permitida`. Las de escritura llevan `p_simular` y **por defecto `true`** (vista previa = misma llamada sin escribir).
- Respuesta estándar: `jsonb` con `ok`; `{ok:false, error:'<código>'}` se traduce a etiqueta corta (`acciones.dart`, 50 códigos).
- Ciclo (`controlador.dart`): al abrir la pestaña y con «Actualizar» → `crm_freno_sincronizar(p_forzar:false)` + inventario de
  edges + lecturas; un reloj de **30 s solo lee** y solo con la pestaña visible. Las edges se releen al abrir, al cambiar de
  rango y tras una escritura que las toca, nunca en el tic.

### 2.2 Las RPC (contrato D) `[KUADRA: servicio.dart]`

| RPC | Para qué | Args clave |
|---|---|---|
| `crm_freno_estado` | cifras, cobertura, guardia, checks, filas de «Ahora» | `p_horas` 1-720 |
| `crm_freno_lista` | tabla Funciones con chips por tramo | `p_tipo`, `p_filtro{buscar,clase,chip,orden}`, `p_horas` |
| `crm_freno_detalle` | detalle de una ruta | `p_ruta`, `p_horas` |
| `crm_freno_topes` | orígenes por `ip`, `ruta` o `clase` | `p_desde`, `p_hasta`, `p_por` |
| `crm_freno_clases` / `crm_freno_edges` / `crm_freno_cobertura` / `crm_freno_historial` | listas | — |
| `freno_edges_inventario` | vuelca la lista cruda de la Management API | `p_json`, `p_fuente:'management_api'`, `p_completo:true` |
| `crm_freno_fijar` / `soltar` / `adoptar` / `clase` / `general` / `lote` | cambiar techos (lote ≤ 50 ops) | `p_ruta`, `p_max`, `p_ventana`, `p_motivo`, `p_simular` |
| `crm_freno_aceptar` / `visto` / `edge_exenta` | aceptar un invariante con motivo (3-120 chars) | `p_invariante`, `p_objeto`, `p_motivo` |
| `crm_freno_quitar_anon` / `crm_freno_volatil` | los dos DDL estrechos (revocar `anon`; pasar a VOLATILE) | `p_ruta` |
| `crm_guardia` | encender (inmediato) / apagar con plazo 15-360 min | `p_encender`, `p_minutos`, `p_motivo` |

---

## 3. Modelo de datos del freno

### 3.1 `freno_clase` — 24 clases (la siembra real) `[KUADRA: za_motor_freno_sombra.sql §4.1]`

`clase text pk, tipo ('rpc'|'tabla'|'edge'|'cualquiera'), max int (1-100000), ventana interval (1 s-1 día, defecto 1 min),
contable bool (= max no nulo), sensible bool, manual bool, secuencia regclass (contador de rechazadas), etiqueta`.

| Clase | Techo/min | Sensible | Uso |
|---|---|---|---|
| `irreversible` | 3 | sí | `eliminar_mi_cuenta`, `migrar_*`, `purgar_*`, `vaciar_*` |
| `envio` / `credencial_critica` | 5 / 5 | sí | manda correo/SMS; cambia password/pin/clave |
| `export` | 6 | sí | `*_export`, `exportar_*` |
| `credencial` / `edge_envio` / `edge_credencial` / `publico_escritura` | 10 | sí (salvo pública) | passkey, código, dispositivo |
| `comensal_dinero` | 12 | sí | pagar/cobrar desde la app |
| `pos_dinero_critico` | 20 | sí | anular/corregir/reembolsar cobro |
| `edge_publica` | 30 | no | edge sin otra clase |
| `login` | 50 | sí | `login_*` |
| `pos_dinero` / `comensal_escritura` / `publico_lectura` / `edge_interna` | 60 | mixto | |
| `tabla_escritura` | 120 | no | INSERT/UPDATE/DELETE por REST |
| `pos_escritura` | 300 | no | |
| `pos_lectura` / `comensal_lectura` / `sistema` | 600 | no/sí | lecturas por sondeo |
| `servicio` | — (no contable) | — | nadie de fuera la ejecuta |
| `no_contable` | — | — | STABLE/IMMUTABLE: solo bloqueo por IP |
| `exenta` | — | — | sin techo a propósito, con motivo |
| general `*` / `@ip` | 120 (v1) | — | techo por defecto de toda RPC sin fila / techo global por IP |

### 3.2 `freno_regla` — clasificación por reglas ordenadas `[KUADRA: za §4.2]`

`orden smallint pk, tipo, clase fk, quien text[] (servicio|pos|comensal|publico), volatil text[] ('v','s','i'),
nombre_re text (≤600), args_re text (≤300)`. **Gana la de menor orden que case.** Un disparador diferido exige que cada tipo
quede cubierto por una regla sin filtros (siempre casa alguna). Reglas literales (resumidas; las regex son exactas):

| Orden | Clase | Condición |
|---|---|---|
| 10 | servicio | `quien = servicio` |
| 20 | no_contable | `volatil in (s,i)` |
| 30 | irreversible | `^(eliminar_mi_cuenta$|migrar_|purgar_|vaciar_)` |
| 40 | envio | `^(enviar_|reenviar_|solicitar_codigo)` |
| 50 | export | `_export$|^export(ar)?_` |
| 60 | login | `^login(_|$)` |
| 70/71 | credencial_critica | `(^|_)(cambiar|fijar|resetear|restablecer)_(password|pin|clave)(_|$)|^rotar_` · args `(^|,)p_(password_nueva|pin_nuevo)(,|$)` |
| 80-82 | {pos,comensal,publico}_lectura | `^(get_|listar_|cargar_|consultar_|check_|estado_|hay_|validate_|…)|(^|_)(ver|buscar)_|_(resumen|historico|detalle|pendientes|…)$` |
| 90 | pos_dinero_critico | `(anular|corregir|revertir|reembolsar|devolver)_cobro|_cobro_local$` |
| 100/101 | credencial | `(passkey|credencial|biometri|huella|codigo|confirmar_registro|token_fusion|fusionar|(^|_)metodo(_|$)|…)` · args `(^|,)p_password(,|$)` |
| 110-121 | {pos,comensal}_dinero | `(^|_)(pagar|pago|cobrar|cobro|aporte|transaccion|propina|servicio_pct|reembolsar|reembolso|devolver|devolucion|saldar|abonar)(_|$)` · args `(^|,)p_(monto|metodo_pago|recibido|propina|total_ves)` |
| 130-150 | {pos,comensal,publico}_escritura | resto VOLATILE según quién |
| 200 | tabla_escritura | toda tabla escribible |
| 300-330 | edge_envio / edge_credencial / edge_interna / edge_publica | slug `^(enviar|notificar)` · `(otp|webauthn|passkey|login|cedula|kyc)` · `^(refrescar|factura|cron)` · resto |

**Quién llama** (`freno_resolver`): sin EXECUTE de `anon` ni `authenticated` → `servicio`; `anon` + argumento `p_token` →
`pos` (específico de KUADRA: su POS valida un token propio); `anon` → `publico`; solo `authenticated` → `comensal`.

### 3.3 `freno_catalogo` — una fila por ruta `[KUADRA: za §3.4]`
- `ruta` pk con forma validada: `*`, `@ip`, `/rpc/<nombre>`, `/<tabla>`, `edge:<slug>[:<accion>]`. **La ruta no lleva esquema**
  (PostgREST manda el esquema en `Content-Profile`): `/rpc/get_x` cubre la de `public` y la de cualquier otro esquema expuesto.
- Rasgos (los escribe la sincronización): `esquema, nombre, identidad (regprocedure), quien, volatil, args, expuesta`.
- Decisión: `clase_regla, origen_regla` (la regla) y `clase_fijada, max_fijado, ventana_fijada` (a mano, **con nota obligatoria**).
- Efectivo (solo lo escribe un BEFORE trigger): `clase, max, ventana, contable, secuencia`.
- Edges: `freno_estado ∈ {catalogo, codigo, propio, ninguno}`, `freno_version` (md5 de `freno.ts`), `freno_visto_en`.
- Vida: `alta_en, desaparecida_en, usado_hasta, legado`.
- **Tramos de cobertura** (`tramoDe`, `listas_datos.dart`; el orden importa): `clase='servicio'` → `solo_servidor`; edge con
  `freno_estado='ninguno'` y no exenta → `sin_freno`; `exenta` → `exenta`; `no_contable` → `solo_ip`; edge → `edges`;
  legado → `sin_revisar`; max/ventana fijados → `propio`; resto → `clase`. `con_freno + sin_freno + exenta = total expuestas`.

### 3.4 Piezas de apoyo
- `freno_estado` (fila única): `firma` (md5 de esquemas+ACL+reglas), `ultima_sync`, `ultimo_fallo`, `retenida`.
- `freno_sucio(tx)` + **event trigger** `freno_ddl` + constraint trigger diferido: toda migración re-sincroniza el catálogo al
  COMMIT y **aborta** si deja una función interna expuesta (`_freno_asercion_cerrada`). Ningún cron.
- `rate_limits_objetivo(clave sha256, accion, bucket, conteo, visto_en)`: contador de **ventana fija**
  (`bucket = floor(epoch/ventana)`), clave hasheada (no guarda uid/IP), barrido probabilístico 0,5 %
  `[KUADRA: 20260830110000]`.
- `freno_hora` (rastro, cubo por hora): `pk (hora, ruta, ip)`, `clase, techo, topes, rechazadas, pico, muestra text[≤5],
  revisado, primera, ultima`; retención 30 d, purga a 45.000 filas `[KUADRA: zc_rastro.sql]`.
- `invariante_aceptado(invariante, objeto, huella, motivo)`: aceptar un hallazgo guarda la **huella**; si la función cambia
  (args, volatilidad, ACL o clase: `freno_huella`) el hallazgo vuelve a salir.
- `freno_edge_ficha(slug, version, estado_despliegue, verify_jwt, ezbr_sha256, md5_freno_ts, desplegada_en)`.

---

## 4. Cómo detecta lo expuesto (el resolvedor)

### 4.1 Esquemas expuestos `[KUADRA: za §3.6 _freno_esquemas]`
```sql
select string_to_array(replace(substring(c from '^pgrst\.db_schemas=(.*)$'), ' ', ''), ',')
  from pg_catalog.pg_roles r, unnest(r.rolconfig) c
 where r.rolname = 'authenticator' and c like 'pgrst.db_schemas=%' limit 1;
```
En el proyecto de KUADRA (Supabase alojado) esa clave existe: la sincronización aborta con `db_schemas_ilegible` si no lee
`public`. Que exista en **todo** proyecto alojado `[no verificado]`. Respaldo: `GET /v1/projects/{ref}/postgrest` →
campo `db_schema` (texto separado por comas) `[verificado: https://api.supabase.com/api/v1-json]`, **pero esa respuesta trae
también `jwt_secret`** (scope `rest:read`): si se usa, el backend descarta ese campo antes de guardar o loguear nada.

### 4.2 Funciones y tablas expuestas `[KUADRA: za §3.8 freno_resolver]`
- Funciones: `pg_proc` en esquemas expuestos, `prokind = 'f'`, sin `trigger`/`event_trigger`, y
  `has_function_privilege('anon'|'authenticated', oid, 'EXECUTE')`. Los argumentos de entrada salen de `proargnames` filtrando
  `proargmodes in ('i','b','v')`. Por ruta (`/rpc/<proname>`) se agrupan todas las sobrecargas y se queda con la expuesta.
- Tablas: `relkind in ('r','v','m','f','p')` con `has_table_privilege(rol, oid, 'INSERT'|'DELETE')` o
  `has_any_column_privilege(rol, oid, 'UPDATE')` para `anon` o `authenticated`. Solo cuenta escritura (las lecturas GET no se
  pueden contar: transacción de solo lectura).
- «Pegajosa»: una ruta que deja de estar expuesta conserva su fila y su clase (si vuelve a exponerse, no nace sin freno).
- **Deriva** (`freno_deriva`): `full join` entre lo que el resolvedor dice y lo que tiene el catálogo → `falta`, `sobra`,
  `rasgos`, `efectivo`, `sin_clase`. Es el C1.
- **Retención por umbral**: si una sincronización automática daría de baja/cambiaría techo a más de 20 rutas, no se aplica
  (queda `retenida`) hasta que un humano confirme con `p_forzar:true`.

---

## 5. Cómo lee la configuración del freno (el guardia)

### 5.1 ¿Está enganchado? `[KUADRA: 20260830222927 guardia_estado]`
```sql
select s.setting
  from pg_db_role_setting r
  cross join lateral unnest(r.setconfig) s(setting)
  join pg_roles ro on ro.oid = r.setrole
 where ro.rolname = 'authenticator' and s.setting like 'pgrst.db_pre_request=%';
-- con valor → 'protegido'; sin valor y con plazo de reencendido → 'apagado_a_proposito'; si no → 'nunca_encendido'
```
Encender/apagar (lo que documenta Supabase) `[verificado: https://supabase.com/docs/guides/api/securing-your-api]`:
`alter role authenticator set pgrst.db_pre_request = 'esquema.funcion'; notify pgrst, 'reload config';` y
`alter role authenticator reset pgrst.db_pre_request; notify pgrst, 'reload config';`. El pre-request solo cubre la Data API
(PostgREST), no Realtime ni Storage (misma URL).

### 5.2 Qué hace el guardia vivo, en orden `[KUADRA: etapa3_guardia_nuevo.sql]`
1. **IP bloqueada** (antes del filtro de métodos, para que una IP bloqueada tampoco lea): `PT403`. Bloque propio, falla abierta.
2. **GET/HEAD**: no se puede contar (transacción de solo lectura: `25006`)
   `[verificado: https://docs.postgrest.org/en/stable/references/transactions.html]`. Por eso: ruta con `%` →
   `PT400 ruta_no_canonica` (`request.path` llega sin decodificar y no casaría con el catálogo); `GET /rpc/x` cuya fila no diga
   STABLE/IMMUTABLE → `PT405 get_volatil`. Antes de esto un GET a una RPC VOLATILE se saltaba el contador entero
   `[KUADRA: medido por HTTP, «humo-http H1»]`.
3. **POST/PATCH/PUT/DELETE**: `service_role` exento. Identidad por orden: `auth.uid()` → cabecera del aparato del POS (solo si
   es UUID) → IP. Techo de la ruta por PK del catálogo (sin fila → fila `*`), contado por identidad con
   `contar_objetivo('rpc:'||ruta, origen||':'||clave, ventana)`.
4. **Techo global `@ip`**, se cuenta siempre: la identidad (uid anónimo, cabecera) se rota gratis; la IP no.
5. Rastro: al llegar justo al techo (`conteo = max`) anota el tope en `freno_hora` (en la última permitida, porque el `raise`
   desharía la transacción del corte). En el corte, `nextval` de la secuencia de la clase (no es transaccional: sobrevive).
6. Corte **fuera** del bloque `exception when others`: `PT429`. PostgREST traduce `PTxyz` a HTTP `xyz`
   `[verificado: https://docs.postgrest.org/en/stable/references/errors.html]`. Si el `raise` quedara dentro, el propio
   manejador se lo tragaría y el freno no frenaría nunca (lo comprueba un assert de la migración).
7. Falla abierta para todo lo no decidido (incluido `query_canceled`, que `when others` no atrapa).

Límites asumidos y escritos `[KUADRA: guardia v1]`: un cubo por ruta (repartir entre rutas multiplica el techo); ventana de
cubo fijo (hasta 2× en el borde); `statement_timeout = 8 s` en `authenticator` obliga a un solo upsert por petición.
Incidente real `[KUADRA: 20260830225900]`: el contador `contar_objetivo` quedó con EXECUTE para `anon`; cualquiera podía
inflar el contador de cualquier uid y dejarle un 429 permanente (comprobado con HTTP 200 a `/rest/v1/rpc/contar_objetivo`).

---

## 6. Orígenes por IP

- **Cadena canónica** (`plataforma.ip_peticion`, la misma en SQL y en `freno.ts`) `[KUADRA: zb_ip_helper]`:
  `cf-connecting-ip` → `sb-forwarded-for` → **último** de `x-forwarded-for`; descarta vacío, con `/` (una máscara haría de una
  red un solo cubo) o inválido (`pg_input_is_valid(v,'inet')`); `::ffff:a.b.c.d` → `a.b.c.d`. Del XFF vale el último porque
  cada proxy añade al final; el primero lo escribe el cliente. `cf-connecting-ip` falsificada a mano → el borde respondió 403
  `[KUADRA: medido]`.
- La guía oficial de Supabase toma `split_part(x-forwarded-for, ',', 1)`, el **primero**
  `[verificado: https://supabase.com/docs/guides/api/securing-your-api]`. Un limitador copiado de ahí se esquiva rotando esa
  cabecera. KUADRA lo vivió: una copia vieja de su helper de IP dejaba esquivar entero el freno por IP de una edge
  `[KUADRA: freno.ts]`.
- **Quién es la IP** (`crm_freno_topes p_por:'ip'` → `quien`), en orden: `aws` (heurística: la IP tocó en 7 d una edge o una
  RPC pública con `p_secreto`, o sea, es la salida de las Edge Functions) → `local` (sesión del POS o `login_pos_ok` en 7 d) →
  `comensal` (con sesión) → `sin_sesion`. **Solo `sin_sesion` es `bloqueable`**: bloquear la IP de un local o de AWS corta a
  todos los que salen por ella. La UI siempre ofrece «Copiar IP»; «Bloquear IP» solo en `sin_sesion` (`origen_ip.dart`).
- Columnas de Orígenes: IP · quién · nº de funciones · topes · rechazadas · última · acción (`seccion_origenes.dart`).
- «Cerca del techo» = `pico >= 0.8 * techo`. Sugerido «Subir a N»: siguiente escalón de
  `[3,5,6,10,12,20,30,50,60,120,300,600,900,1800,3000,9000,18000]` por encima del techo actual `[KUADRA: zd1 _crm_freno_sugerido]`.

---

## 7. La sección de Auditoría

`seccion_auditoria.dart` monta tres bloques, en este orden:

1. **Guardia, casilla a casilla**: Estado (`encendido` y `situacion='protegido'`), Versión (md5 de
   `pg_get_functiondef('…guardia_peticion()')`, comparado con el aceptado), Enganche (`pgrst.db_pre_request` apunta al
   guardia), Orden (el bloqueo de IP va antes del filtro de métodos), Reencendido (programado o cron de red 6 h). Verde solo si
   está encendido **y** enganche y orden están bien. «Apagar» exige plazo de 15 min a 6 h; encender es inmediato.
2. **Cobertura**: los checks C1-C15 en 0 (los distintos de 0 se ven arriba, como cifras con su acción).
3. **Historial**: cada cambio del freno con antes → después, vía (`CRM`, `Auto`, `Cron`, `Siembra`, `SQL`, `crm_sql`),
   IP del operador marcada «Nueva» si nunca se vio, y «Volver a N» (un cambio nuevo, nunca un deshacer silencioso).

Invariantes C1-C15 (`_crm_freno_cobertura`), con su portabilidad a un cliente cualquiera:

| C | Nombre | Lógica exacta en KUADRA | ¿Portable? |
|---|---|---|---|
| C1 | Deriva | `freno_deriva()` ≠ vacío | No (catálogo propio) |
| C2 | Huérfana | fila con `desaparecida_en` | No |
| C3 | Tráfico sin catálogo | rutas en `freno_hora` 31 d sin fila | Adaptable con logs (RL-14) |
| C4 | Mecanismo | event trigger, disparador, firma, fallo de sync, enganche, md5 del guardia | Parcial: enganche y md5 (RL-02/03) |
| C5 | Nombre repetido | misma `proname` expuesta ≥ 2 veces, sin las de extensión (`pg_depend deptype='e'`) | **Sí** (RL-10) |
| C6 | STABLE sin política | expuesta, `volatil in (s,i)`, no la usa ninguna política (`pg_depend` → `pg_policy`) | Sí, info (RL-11) |
| C7 | Sensible | clase no sensible y señal en nombre/args (regex §9.3) | **Sí** (RL-07) |
| C8 | Escribe dinero | clase no sensible e `insert/update/delete/merge` sobre tablas de dinero/credencial en `prosrc` sin comentarios | **Sí** (RL-08) |
| C9 | Pública | `quien='publico' and volatil='v'` | **Sí** (RL-06) |
| C10 | Interna expuesta | nombre `^(_|crm_|freno_|activar_|desactivar_)` o `^guardia_` (salvo el pre-request) con EXECUTE de anon/authenticated | **Sí** (RL-09) |
| C11 | Menos protección | auditoría: una vía automática subió el techo o quitó `contable` de una ruta sensible | Solo si instalamos rastro |
| C12 | Techos generales | faltan `*`/`@ip` o una clase contable sin techo | No |
| C13 | IP a mano | cuerpo (sin comentarios) con `cf-connecting-ip|x-forwarded-for|sb-forwarded-for` fuera del helper | **Sí** (RL-05) |
| C14 | Edge en código | edge cuyo freno no lee el catálogo o con `freno.ts` viejo (ámbar) | Adaptable (RL-12/13) |
| C15 | Rastro sin purga | `freno_hora` > 50.000 filas o > 31 d; contadores > ventana + 2 d | Sí si hay tabla contadora (RL-15) |

Aceptables con motivo: solo C4 (md5 del guardia), C6, C7, C8, C9, C11, C13. Un fallo de mecanismo no se puede silenciar.

---

## 8. Edge Functions

- **Inventario**: `GET https://api.supabase.com/v1/projects/{ref}/functions` (scope `edge_functions:read`). Campos de cada
  elemento: `id, slug, name, status (ACTIVE|REMOVED|THROTTLED), version, created_at, updated_at (epoch ms), verify_jwt,
  import_map, entrypoint_path, import_map_path, ezbr_sha256` `[verificado: https://api.supabase.com/api/v1-json]`.
  KUADRA lo pide con un token de **solo lectura** (permiso «Edge Functions R») y la base decide qué cambió; tope 100 edges.
- **Código**: `GET /v1/projects/{ref}/functions/{function_slug}/body` (mismo scope; responde un fichero en stream)
  `[verificado: https://api.supabase.com/api/v1-json]`. El formato exacto del cuerpo (eszip o multipart) `[no verificado]`;
  KUADRA lo pide con `Accept: multipart/form-data` en su backup (`supabase_gestion_api.dart`).
- **Estados del freno de una edge** (`edges_datos.dart`): `con_freno` (lee el catálogo), `techo_en_codigo` (freno.ts o
  limitador propio), `espera_despliegue`, `exenta`, `sin_freno` («nada la frena», rojo). Al darla de alta: sin `md5_freno_ts`
  → `ninguno`; con él → `codigo`.
- **`freno.ts` v3** `[KUADRA: _compartido/freno.ts]`: `servir(slug, {falla:'cerrada'|'abierta' (OBLIGATORIO), claves, max,
  ventanaMs, antes, cortar}, manejador)`; cada petición hace `POST /rest/v1/rpc/freno_edge` (service_role,
  `Content-Profile: plataforma`, timeout 5 s) con `p_ruta, p_clave ('<origen>:<clave>', >200 chars → sha256), p_max_codigo,
  p_ventana_codigo, p_version (md5 del fichero)`. `OPTIONS` no cuenta; lo no autorizado (secreto, método, origen) se contesta
  en `antes` sin gastar cubo. Corte por defecto `429 {"error":"demasiados_intentos"}`. Incidente real: un plazo de 5 s en frío
  hizo fallar cerrado un cron y la tasa quedó 13,5 h sin refrescar → el modo de falla se decide por edge.
- El comando de despliegue que copia el panel añade `--no-verify-jwt` solo si el `verify_jwt` vivo es `false`.

---

## 9. Cómo llevarlo al proyecto Supabase de un cliente cualquiera

### 9.1 Vía de acceso (solo lectura, sin service_role)

| Qué | Endpoint | Scope | Fuente |
|---|---|---|---|
| SQL al catálogo | `POST https://api.supabase.com/v1/projects/{ref}/database/query/read-only` cuerpo `{"query": "...", "parameters": []}` → 201 | `database:read` | Beta; corre como `supabase_read_only_user`; «todas las referencias calificadas con esquema» `[verificado: https://api.supabase.com/api/v1-json]` |
| Edges | `GET /v1/projects/{ref}/functions` y `/functions/{slug}/body` | `edge_functions:read` | `[verificado: ídem]` |
| Esquemas expuestos (respaldo) | `GET /v1/projects/{ref}/postgrest` → `db_schema` | `rest:read` | trae `jwt_secret`: descartarlo `[verificado: ídem]` |
| Spec de la Data API | `GET /v1/projects/{ref}/database/openapi?schema=` | `database:read` | `[verificado: ídem]` |
| Advisors | `GET /v1/projects/{ref}/advisors/security?lint_type=sql` | `database:read` | «experimental» `[verificado: ídem]` |
| Logs | `GET /v1/projects/{ref}/analytics/endpoints/logs?sql=&iso_timestamp_start=&iso_timestamp_end=` | `analytics:read` | `[verificado: ídem]` |
| Límites de Auth | `GET /v1/projects/{ref}/config/auth` → `rate_limit_email_sent, rate_limit_sms_sent, rate_limit_otp, rate_limit_verify, rate_limit_token_refresh, rate_limit_anonymous_users, security_captcha_enabled` | `auth:read` | trae `security_captcha_secret`: descartarlo `[verificado: ídem]` |

- Token: **PAT con alcance** (solo los proyectos y permisos elegidos) u OAuth2; el PAT «classic/Legacy» tiene todos los
  privilegios del usuario: rechazarlo en la UI. Límite: **120 req/min por usuario, por proyecto, por endpoint**;
  `logs.all` 30/min; cabeceras `X-RateLimit-*` `[verificado: https://supabase.com/docs/reference/api/introduction]`.
  Una auditoría completa son ~3 + N_edges llamadas: holgada.
- Alternativa equivalente: MCP oficial con `https://mcp.supabase.com/mcp?project_ref=<ref>&read_only=true`
  (`execute_sql`, `list_edge_functions`, `get_edge_function`, `get_advisors`, `query_logs`)
  `[verificado: https://supabase.com/docs/guides/getting-started/mcp]`. Coincide con la decisión 2.1 de `parte5`.
- **Ya no se puede descubrir desde fuera con la anon key**: `/rest/v1/` dejó de servir el OpenAPI a la anon key (anuncio del
  2026-02-17, retirada desde marzo) `[verificado: https://supabase.com/changelog/42949-breaking-change-removing-access-to-openapi-spec-via-the-anon-key]`.
- Que `supabase_read_only_user` pueda leer `pg_roles.rolconfig`, `pg_db_role_setting` y `pg_proc.prosrc` `[no verificado]`
  (son catálogos legibles por cualquier rol en Postgres estándar; probarlo en el proyecto de demo lo primero).
- No usar `advisors` como fuente única: la doc lista los lints `0028_anon_security_definer_function_executable` y
  `0029_authenticated_security_definer_function_executable` `[verificado: https://supabase.com/docs/guides/database/database-advisors]`,
  pero el enum de nombres de la respuesta en el OpenAPI de hoy no los incluye. Sirven como evidencia extra, no como detector.

### 9.2 La consulta única (portable, sin depender de ningún esquema de KUADRA)

Devuelve una fila por función expuesta con todas las señales; el clasificador (§9.4) hace el resto en TypeScript.
```sql
with cfg as (
  select
    (select split_part(c, '=', 2) from pg_catalog.pg_roles r, unnest(r.rolconfig) c
      where r.rolname = 'authenticator' and c like 'pgrst.db_pre_request=%' limit 1) as pre_request,
    coalesce((select string_to_array(replace(split_part(c, '=', 2), ' ', ''), ',')
                from pg_catalog.pg_roles r, unnest(r.rolconfig) c
               where r.rolname = 'authenticator' and c like 'pgrst.db_schemas=%' limit 1),
             array['public', 'graphql_public']) as esquemas
),
f as (
  select n.nspname as esquema, p.proname as nombre, p.oid::pg_catalog.regprocedure::text as identidad,
         p.provolatile::text as volatil, p.prosecdef as definer, l.lanname as lenguaje,
         pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
         pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as autenticado,
         coalesce((select pg_catalog.string_agg(x.nm, ',' order by x.o)
                     from unnest(p.proargnames,
                                 coalesce(p.proargmodes::text[],
                                          pg_catalog.array_fill('i'::text, array[coalesce(pg_catalog.cardinality(p.proargnames), 0)])))
                          with ordinality x(nm, md, o)
                    where x.md in ('i', 'b', 'v')), '') as args,
         pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.regexp_replace(p.prosrc, '/\*.*?\*/', ' ', 'g'),
                                                    '--[^\n]*', ' ', 'g')) as cuerpo
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_language l on l.oid = p.prolang
    cross join cfg
   where n.nspname = any(cfg.esquemas) and p.prokind = 'f'
     and p.prorettype not in ('pg_catalog.trigger'::pg_catalog.regtype, 'pg_catalog.event_trigger'::pg_catalog.regtype)
     and not exists (select 1 from pg_catalog.pg_depend d          -- fuera las de extensiones (C5 de KUADRA)
                      where d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.objid = p.oid and d.deptype = 'e')
)
select f.esquema, f.nombre, f.identidad, f.volatil, f.definer, f.lenguaje, f.anon, f.autenticado, f.args,
       (select cfg.pre_request from cfg) as pre_request,
       f.cuerpo ~ '(insert\s+into|update\s+(only\s+)?[a-z0-9_."]+\s+set|delete\s+from|merge\s+into)' as escribe,
       f.cuerpo ~ '(net\.http_(get|post|delete)|extensions\.http|http_(get|post)\s*\()'           as sale_a_red,
       f.cuerpo ~ '(rate_?limit|ratelimit|throttl|pt429|too many requests|demasiadas peticiones)'   as freno_en_cuerpo,
       f.cuerpo ~ '(cf-connecting-ip|x-forwarded-for|sb-forwarded-for)'                              as lee_ip,
       pg_catalog.count(*) over (partition by f.nombre)                                             as homonimas,
       pg_catalog.left(f.cuerpo, 3000)                                                              as extracto
  from f
 where f.anon or f.autenticado
 order by f.anon desc, f.volatil, f.nombre;
```
Segunda consulta, el cuerpo del pre-request si existe (para RL-03/04/05/16):
`select pg_catalog.pg_get_functiondef(pg_catalog.to_regproc($1)::oid)` con `$1 = pre_request` (va en `parameters`).
Tercera, tablas escribibles: la condición de §4.2 sobre `pg_catalog.pg_class` + `c.relrowsecurity` para cruzar con RLS.

### 9.3 Catálogo de chequeos portables

Severidad: **C** crítica (llamada de voz), **A** alta (WhatsApp), **M** media (panel), **I** informativa. «Sin freno» =
`pre_request` nulo **y** `freno_en_cuerpo = false`. Con `pre_request` puesto, la ruta queda «cubierta sin verificar techo»
(ámbar): el techo real vive en la tabla del limitador del cliente, que no conocemos.

| ID | Qué detecta | Fuente exacta | Lógica | Sev. | Corrección |
|---|---|---|---|---|---|
| RL-01 | Función expuesta a `anon`, VOLATILE, sin freno, de clase sensible | §9.2 | `anon and volatil='v' and sin_freno and clase ∈ {irreversible, envio, export, login, credencial*, dinero}` o `sale_a_red` | C | pre-request (plantilla §9.5) o freno dentro de la función; revisar si debe ser pública |
| RL-02 | No hay pre-request y hay rutas que escriben | §9.2 `pre_request` | `pre_request is null and count(anon or autenticado, volatil='v') > 0` | A | instalar el limitador global (§9.5) con techo `*` de 120/min |
| RL-03 | Limitador inerte: el `raise` del corte está dentro del `exception when others` | cuerpo del pre-request | posición de `raise … pt4` < posición de `when others` (mismo test que el assert de KUADRA) | A | sacar el `raise` fuera del bloque protegido |
| RL-04 | El limitador no cuenta GET y deja leer por GET RPC VOLATILE | cuerpo del pre-request | `return` temprano si `request.method` ≠ POST sin mirar volatilidad | M | responder `PT405` a `GET /rpc/x` VOLATILE (KUADRA §5.2.2) |
| RL-05 | IP leída del **primer** elemento de `x-forwarded-for` (falsificable) | `lee_ip` + cuerpo | regex `split_part\([^)]*x-forwarded-for[^)]*,\s*1\)` o `->>'x-forwarded-for'` sin `-1` | A | cadena `cf-connecting-ip` → `sb-forwarded-for` → último XFF (§6) |
| RL-06 | Pública VOLATILE (C9) | §9.2 | `anon and volatil='v'` (aunque tenga freno: se lista para revisión) | A sin freno / M con freno | quitar `anon` si no es pre-login; si lo es, techo apretado |
| RL-07 | Nombre o argumentos sensibles en función sin freno (C7) | §9.2 `nombre`, `args` | regex de señal (debajo) y `sin_freno` | A | techo propio bajo (5-12/min) |
| RL-08 | Escribe en tablas de dinero/credencial sin freno (C8) | §9.2 `cuerpo` | `(insert into|update( only)?|delete from( only)?|merge into)\s+(auth\.users|[a-z_]+\.(payments?|pagos?|transac[a-z_]*|invoices?|facturas?|credentials?|secrets?|tokens?|api_keys?|wallets?|balances?))\M` | C con `anon`, A con `authenticated` | techo de dinero (12-20/min) e idempotencia |
| RL-09 | Interna o helper del limitador expuesto (C10 + incidente `contar_objetivo`) | §9.2 | `(anon or autenticado)` y nombre `^(_|admin_|internal_|private_|crm_|cron_|rate_?limit|throttl|contar_|bump_|incr)` o `definer and anon` | C si el helper escribe contadores; A resto | `revoke all on function <identidad> from public, anon, authenticated; grant execute on function <identidad> to service_role;` |
| RL-10 | Nombre repetido en varios esquemas o sobrecargas (C5) | §9.2 `homonimas ≥ 2` | la ruta `/rpc/<nombre>` no lleva esquema: comparten cubo y confunden el techo | M | renombrar o fijar el techo a la más sensible |
| RL-11 | STABLE expuesta sin política que la use (C6) | `pg_depend` → `pg_policy` | `volatil in (s,i)` y ninguna política la referencia | I | aceptar «solo IP» o revocar |
| RL-12 | Edge con `verify_jwt = false` sin limitador en el código | `/functions` + `/body` | `verify_jwt === false` y el código no casa `/(rate.?limit|ratelimit|throttl|upstash|429|too many requests)/i` | C si el slug casa `^(enviar|notificar|send|email|sms|notify|otp)` o `(otp|webauthn|passkey|login|auth|kyc|verify|reset)`; A resto | limitador por IP (cadena §6) con modo de falla explícito |
| RL-13 | Edge con JWT pero sin limitador | ídem | `verify_jwt === true` y sin patrón | M | limitador por usuario (`sub` del JWT) |
| RL-14 | Ruta martilleada sin 429 | logs | por `/rest/v1/rpc/%` e IP: máx. peticiones/min > techo de su clase (§3.1) y 0 respuestas 429 en la ventana | A (C si clase sensible) | techo + bloqueo de IP solo si `sin_sesion` |
| RL-15 | Tabla contadora del limitador sin purga (C15) | `pg_stat_user_tables` de la tabla que cite el pre-request | `n_live_tup > 50000` o fila más vieja > 31 d | M | barrido probabilístico (0,5 %) o cron |
| RL-16 | Ruta con `%` esquiva el catálogo del limitador | cuerpo del pre-request | busca la ruta por `request.path` exacto y no rechaza `strpos(path,'%') > 0` | M | `PT400` a rutas con `%` antes de contar |
| RL-17 | Tabla escribible por `anon`/`authenticated` sin freno | consulta de tablas | `INSERT/UPDATE/DELETE` concedido y sin pre-request | M (A sin RLS) | pre-request cuenta también PATCH/PUT/DELETE de tablas |
| RL-18 | Límites de Auth abiertos | `config/auth` | `security_captcha_enabled = false` y `rate_limit_email_sent`/`rate_limit_sms_sent`/`rate_limit_otp` por encima de lo recomendado `[umbral no verificado]` | M | bajar límites o activar captcha |

Regex de señal sensible (C7 de KUADRA, más tokens en inglés añadidos por nosotros):
nombre `(?:^|_)(pago|pagar|cobro|cobrar|anular|reembols[a-z]*|devol[a-z]*|propina|monto|saldo|abon[a-z]*|transaccion|password|pin|clave|codigo|otp|secreto|passkey|credencial|kyc|pay|payment|charge|refund|withdraw|transfer|balance|secret|token|reset|verify)(?=_|$)`;
args `(?:^|,)p?_?(monto[a-z0-9_]*|amount[a-z0-9_]*|total[a-z0-9_]*|password[a-z0-9_]*|pin[a-z0-9_]*|code|codigo[a-z0-9_]*|otp[a-z0-9_]*|secret[a-z0-9_]*|token[a-z0-9_]*)(?=,|$)`.
Las regex de KUADRA (§3.2) están en español porque su código lo está; los proyectos de clientes usan sobre todo inglés.

### 9.4 Clasificador en TypeScript (port de `freno_regla` + severidad)

Techos sugeridos = los de KUADRA (§3.1), por minuto. Gana la primera regla que case, como en `freno_regla`.
```ts
type Volatil = 'v' | 's' | 'i';
type Sev = 'C' | 'A' | 'M' | 'I';
type Clase = 'irreversible' | 'envio' | 'export' | 'login' | 'credencial_critica' | 'credencial'
  | 'dinero' | 'lectura' | 'escritura' | 'solo_ip';

export interface FuncionExpuesta {            // una fila de la consulta §9.2
  esquema: string; nombre: string; identidad: string; volatil: Volatil; definer: boolean;
  anon: boolean; autenticado: boolean; args: string; pre_request: string | null;
  escribe: boolean; sale_a_red: boolean; freno_en_cuerpo: boolean; lee_ip: boolean; homonimas: number;
}
export interface Hallazgo { id: string; sev: Sev; objeto: string; clase: Clase; techoSugerido: number | null; evidencia: string[]; }

const REGLAS: { clase: Clase; nombre?: RegExp; args?: RegExp; volatil?: Volatil[] }[] = [
  { clase: 'solo_ip', volatil: ['s', 'i'] },
  { clase: 'irreversible', nombre: /^(eliminar_mi_cuenta$|delete_(my_)?account|migrar_|purgar_|purge_|vaciar_|wipe_)/ },
  { clase: 'envio', nombre: /^(enviar_|reenviar_|send_|resend_|notify_|solicitar_codigo|request_(otp|code))/ },
  { clase: 'export', nombre: /_export$|^export(ar)?_/ },
  { clase: 'login', nombre: /^(login|sign_?in)(_|$)/ },
  { clase: 'credencial_critica', nombre: /(^|_)(cambiar|fijar|resetear|restablecer|change|set|reset)_(password|pin|clave)(_|$)|^(rotar|rotate)_/ },
  { clase: 'credencial_critica', args: /(^|,)p?_?(password_nueva|pin_nuevo|new_password)(,|$)/ },
  { clase: 'credencial', nombre: /(passkey|credencial|credential|biometri|codigo|code|otp|token|device|dispositivo)/ },
  { clase: 'dinero', nombre: /(^|_)(pagar|pago|cobrar|cobro|pay|payment|charge|refund|transfer|withdraw|checkout|transaccion|transaction|propina|tip|saldo|balance)(_|$)/ },
  { clase: 'dinero', args: /(^|,)p?_?(monto|amount|metodo_pago|payment_method|total)/ },
  { clase: 'lectura', nombre: /^(get_|list_|listar_|cargar_|consultar_|check_|search_|buscar_|count_|estado_)/ },
  { clase: 'escritura' },
];
const TECHO: Record<Clase, number | null> = { irreversible: 3, envio: 5, credencial_critica: 5, export: 6,
  credencial: 10, dinero: 12, login: 50, lectura: 600, escritura: 60, solo_ip: null };
const SENSIBLE = new Set<Clase>(['irreversible', 'envio', 'export', 'login', 'credencial_critica', 'credencial', 'dinero']);
const INTERNA = /^(_|admin_|internal_|private_|crm_|cron_|rate_?limit|throttl|contar_|bump_|incr)/;
const TABLA_SENSIBLE = /(insert into|update( only)?|delete from( only)?|merge into)\s+(auth\.users|[a-z_]+\.(payments?|pagos?|transac[a-z_]*|invoices?|facturas?|credentials?|secrets?|tokens?|api_keys?|wallets?|balances?))\b/;

export function clasificar(f: FuncionExpuesta): Clase {
  for (const r of REGLAS) {
    if (r.volatil && !r.volatil.includes(f.volatil)) continue;
    if (r.nombre && !r.nombre.test(f.nombre)) continue;
    if (r.args && !r.args.test(f.args)) continue;
    return r.clase;
  }
  return 'escritura';
}

export function evaluar(f: FuncionExpuesta, extracto = ''): Hallazgo[] {
  const clase = clasificar(f);
  const sinFreno = !f.pre_request && !f.freno_en_cuerpo;
  const h = (id: string, sev: Sev, ...ev: string[]): Hallazgo =>
    ({ id, sev, objeto: f.identidad, clase, techoSugerido: f.anon && clase === 'lectura' ? 60 : TECHO[clase], evidencia: ev });
  const out: Hallazgo[] = [];
  const quien = f.anon ? 'anon' : 'authenticated';
  if (f.volatil === 'v' && sinFreno) {
    if ((SENSIBLE.has(clase) || f.sale_a_red) && f.anon) out.push(h('RL-01', 'C', `EXECUTE para ${quien}`, `clase ${clase}`, 'sin pre-request ni freno en el cuerpo'));
    else if (SENSIBLE.has(clase)) out.push(h('RL-07', 'A', `EXECUTE para ${quien}`, `clase ${clase}`));
    else if (f.anon) out.push(h('RL-06', 'A', 'pública VOLATILE sin freno'));
  }
  if (f.escribe && TABLA_SENSIBLE.test(extracto) && sinFreno) out.push(h('RL-08', f.anon ? 'C' : 'A', 'escribe en tabla de dinero/credencial'));
  if (INTERNA.test(f.nombre) || (f.definer && f.anon)) out.push(h('RL-09', /rate_?limit|throttl|contar_|bump_|incr/.test(f.nombre) && f.escribe ? 'C' : 'A', `${quien} puede ejecutarla`));
  if (f.homonimas >= 2) out.push(h('RL-10', 'M', `${f.homonimas} funciones comparten /rpc/${f.nombre}`));
  return out;
}
```
RL-02/03/04/05/16 se evalúan una vez por proyecto con el cuerpo del pre-request; RL-12/13 con las edges.

### 9.5 Corrección que se ofrece (el usuario la aplica; nosotros nunca escribimos en su base)

**Revocar una interna expuesta** (el `hint` literal de KUADRA): `revoke all on function <identidad> from public, anon,
authenticated; grant execute on function <identidad> to service_role;` (revocar también a `public`: si no, `anon` la hereda).

**Limitador mínimo por pre-request** (condensado de KUADRA: solo escrituras, identidad uid → IP, IP con la cadena buena,
falla abierta, corte fuera del bloque). Probarlo primero en el proyecto de demo:
```sql
create schema if not exists freno;                    -- NO añadirlo a los esquemas expuestos
create table freno.config (ruta text primary key, max int not null check (max > 0), ventana_s int not null default 60);
insert into freno.config values ('*', 120, 60);      -- más una fila por ruta sensible, p. ej. ('/rpc/send_otp', 5, 60)
create table freno.contador (clave text, ruta text, cubo bigint, n int not null default 1,
                             visto timestamptz not null default now(), primary key (clave, ruta, cubo));
revoke all on all tables in schema freno from public, anon, authenticated;

create or replace function freno.guardia() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ruta text := current_setting('request.path', true);
  v_cab json; v_ip text; v_clave text; c freno.config%rowtype; v_n int; v_cortar boolean := false;
begin
  begin
    if coalesce(current_setting('request.method', true), '') not in ('POST','PATCH','PUT','DELETE') or v_ruta is null then
      return;
    end if;
    if nullif(current_setting('request.jwt.claims', true), '')::json->>'role' = 'service_role' then return; end if;
    v_cab := nullif(current_setting('request.headers', true), '')::json;
    v_ip := coalesce(nullif(btrim(v_cab->>'cf-connecting-ip'), ''),
                     nullif(btrim(split_part(v_cab->>'x-forwarded-for', ',', -1)), ''));   -- el ÚLTIMO, nunca el primero
    v_clave := coalesce('uid:' || (select auth.uid())::text, 'ip:' || v_ip);
    if v_clave is null then return; end if;                       -- sin identidad no se bloquea
    select * into c from freno.config where ruta = v_ruta;
    if not found then select * into c from freno.config where ruta = '*'; end if;
    if not found then return; end if;
    insert into freno.contador as k (clave, ruta, cubo)
    values (md5(v_clave), v_ruta, floor(extract(epoch from now()) / c.ventana_s)::bigint)
    on conflict (clave, ruta, cubo) do update set n = k.n + 1, visto = now() returning k.n into v_n;
    v_cortar := v_n > c.max;
    if random() < 0.005 then delete from freno.contador where visto < now() - interval '1 day'; end if;
  exception when others then return;                              -- falla abierta, a propósito
  end;
  if v_cortar then raise exception 'Demasiadas peticiones' using errcode = 'PT429'; end if;   -- FUERA del bloque
end $$;
revoke all on function freno.guardia() from public;
grant usage on schema freno to anon, authenticated;            -- para resolver el nombre; las tablas siguen cerradas
grant execute on function freno.guardia() to anon, authenticated;
alter role authenticator set pgrst.db_pre_request = 'freno.guardia';
notify pgrst, 'reload config';
-- deshacer: alter role authenticator reset pgrst.db_pre_request; notify pgrst, 'reload config';
```
Que la función del pre-request pueda vivir en un esquema no expuesto `[no verificado]` (KUADRA la tiene en un esquema
expuesto; la guía de Supabase usa `public.check_request`). `split_part(…, -1)` exige Postgres ≥ 14 `[no verificado para cada
proyecto; Supabase alojado actual usa versiones superiores]`. Lo que este mínimo NO hace y KUADRA sí: techo global por IP,
`PT405` a GET de VOLATILE, `PT400` a rutas con `%`, rastro de topes.

### 9.6 Prompt de corrección que genera Claude (esqueleto)
Entrada: el hallazgo en JSON (`id, sev, objeto, clase, techoSugerido, evidencia`), el `extracto` de la función y el stack si se
conoce. Salida pedida: (1) qué riesgo concreto corre (una línea), (2) el SQL exacto (plantilla §9.5 rellenada con
`objeto` y `techoSugerido`), (3) cómo comprobar que quedó: volver a correr la consulta §9.2 y ver la ruta cubierta, (4) un aviso
si la función debe seguir siendo pública. Regla del motor (decisión de `parte5`): **la severidad la pone la regla, no el
modelo**; Claude solo redacta.

---

## Implicaciones para el plan

**Adoptar**
1. Detección determinista en **una consulta SQL de solo lectura** (§9.2) + inventario de edges, y el clasificador de §9.4.
   Cero tokens para detectar; Claude solo explica y redacta el prompt de corrección. Esfuerzo **M** (BACK, 3-4 h).
2. El modelo «clase → techo» de KUADRA como **techo sugerido** en cada hallazgo (3/5/6/10/12/50/60/600 por minuto). **S**.
3. **Aceptar con motivo + huella** (md5 de identidad, volatilidad, EXECUTE de anon/authenticated y clase): un hallazgo
   aceptado vuelve a salir si la función cambia. Tabla propia `hallazgo_aceptado(proyecto, chequeo, objeto, huella, motivo)`. **S**.
4. Severidades de §9.3 conectadas a las alertas: RL-01, RL-08 con `anon`, RL-09 de helper contador y RL-12 sensible → llamada
   ElevenLabs; el resto de A → WhatsApp Kapso; M/I → panel. Encaja con R5 de `parte5`. **S**.
5. Correcciones como **SQL para copiar** (revocar; limitador mínimo §9.5), nunca ejecutadas por nosotros en la base del
   cliente. Botón grande «Copiar corrección» + «Volver a auditar». **S**.
6. Demo: en nuestro proyecto de demo, una `send_otp` pública sin freno y un pre-request que lee el **primer** XFF →
   la auditoría da RL-01 y RL-05 → se aplica §9.5 → re-auditoría en verde → ataque en vivo devuelve 429. **S**.

**Evitar**
- Copiar la maquinaria interna de KUADRA (catálogo, event triggers, sincronización al COMMIT, sombra, 22 RPC): está hecha
  para su propia base y es invasiva en la de un cliente. Imposible en 36 h y fuera de «solo lectura».
- **Sondeo activo** (mandar N+1 POST para ver si sale 429) contra producción del cliente: puede mandar correos, cobrar o
  escribir. Solo contra nuestra app de demo.
- Pedir `service_role` o un PAT «classic»; pedir `rest:read` o `auth:read` sin filtrar: devuelven `jwt_secret` y
  `security_captcha_secret`. Si se piden, el backend borra esos campos antes de guardar, loguear o mandar a Claude.
- Depender de `advisors` (experimental, sin los lints 0028/0029 en su enum de hoy) o del OpenAPI con anon key (retirado).
- Presentar las regex de nombre como verdad: el hallazgo dice «sospecha por nombre» y enseña la evidencia.

**Riesgos**
- `database/query/read-only` está en **Beta**; respaldo: MCP con `read_only=true`. Verificar en la primera hora que
  `supabase_read_only_user` lee `pg_roles.rolconfig` y `prosrc`.
- `pgrst.db_schemas` puede no estar en `rolconfig` en todo proyecto: respaldo `GET /postgrest` (filtrando `jwt_secret`) o
  `public, graphql_public` por defecto, avisando en el informe.
- Falsos positivos: frenos fuera de Postgres (gateway, Cloudflare delante de un dominio propio, Upstash en la app). Mitiga
  «aceptar con motivo». Falsos negativos: un freno dentro de otra función llamada desde esta; `freno_en_cuerpo` solo mira el
  cuerpo propio (seguir un nivel de llamadas por regex de nombres es opcional, **M**).
- Con pre-request presente no sabemos el techo real (vive en su tabla): se marca «cubierta sin verificar techo».
- RL-14 (martilleo por logs): el dialecto SQL del endpoint de logs y las claves de IP no están verificados (la doc actual
  describe una tabla `logs` con `source = 'edge_logs'` y `log_attributes['request.path']`
  `[verificado: https://supabase.com/docs/guides/telemetry/advanced-log-filtering]`); dejarlo para P2. **M-L**.
- Formato de `/functions/{slug}/body` no verificado: si es eszip binario, la búsqueda de patrones necesita extraer el código. **M**.

**Esfuerzo total del módulo «Freno de tasa»**: BACK **M** (consulta + clasificador + edges + plantillas, ~6 h), FRONT **M**
(tarjeta «N funciones expuestas sin freno», tabla con chips Crítica/Alta/Media, detalle con evidencia y «Copiar corrección»,
~3 h), demo **S** (~1 h). RL-14 por logs y seguir llamadas entre funciones quedan como P2.
