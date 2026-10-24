# Parte V. Decisiones del equipo, producto v1 y plan de 36 horas
**Platanus Hack 26 Caracas, team-22. Viernes 23 de octubre de 2026, 23:16 (hora de Caracas).**

> Esta parte recoge tus respuestas por voz a las 20 preguntas, el producto v1 que se desprende de ellas, la lista de lo que hay que conectar y construir, y el plan hasta el domingo a las 12:00. Lo que dijiste tal cual está marcado **Decidido**. Lo que completé yo está marcado **Propuesta** y hay que confirmarlo. Lo que dejaste para después queda **Pendiente**. Cuando la corrección cambia algo de lo que dijiste, lo digo en la sección 2.

---

## 1. Registro de decisiones

| # | Pregunta | Respuesta | Estado |
|---|---|---|---|
| 1 | ¿Monitoreo o exposición? | **Monitoreo.** El sistema debe estar construido el domingo, con voz de ElevenLabs para llamadas y WhatsApp (Kapso, "Capso" en tu audio; "Cernio" no lo pude identificar) para mensajes. | Decidido |
| 2 | Frase que nos distingue | "Avisamos en tiempo real, por llamada y WhatsApp, cuando tu servicio está bajo ataque, y cubrimos npm y PHP." Ver la corrección en 2.2. | Decidido, con ajuste |
| 3 | Lo único que debe funcionar de punta a punta | Detectar un ataque en tiempo real: saturar un servidor montado en Supabase y que el sistema llame o mande un mensaje. | Decidido |
| 4 | Ideas de UAGSO en la v1 | Se responde después. | **Pendiente** |
| 5 | ¿Competimos u orquestamos? | **Orquestamos**, conectando MCP con Claude y manejándolo en lenguaje natural. | Decidido |
| 6 | Primer cliente | Cuadra y SAGA: startups venezolanas de SaaS que operan con software y hardware. | Decidido. Las entrevistas a 5 ejecutivos siguen sin hacerse. |
| 7 | Stack de la demo | Lo define Andrés con Carlos. | **Pendiente** |
| 8 | A quién llamamos y qué puede hacer cada uno | La app es para desarrolladores y para personas no técnicas. Borrador en 3.4. | Propuesta |
| 9 | Qué es urgente (llamada) y qué va por mensaje | Escaneo de rutas, saturación, accesos sin autorización a rutas de administrador, bypasses, IPs insistentes y rate limit superado. Reglas y umbrales en 3.2. | Decidido, con propuesta de umbrales |
| 10 | Horas y criterios del jurado | Unas 36 horas. Originalidad 15 %, ambición 20 %, ejecución y despliegue 20 %, impacto 20 % (deducido: no lo dijiste, pero los demás suman 80), técnico 25 %. | Decidido |
| 11 | Quién construye qué | "Se define durante el rumbo." Ver el riesgo en 2.4. | **Pendiente** |
| 12 | Qué conectamos en la demo | Todo lo que haga falta, y nada se deja para después del domingo a las 12:00. Lista en la sección 4. | Decidido |
| 13 | Falla real o simulada | Real (PHP de la última semana) y simulada, etiquetada como tal. | Decidido |
| 14 | Plan B si falla internet o la llamada | Todavía no hay video de respaldo. Se complementa con el pitch. | **Pendiente**, ver 2.5 |
| 15 | Cómo protegemos el producto | Por módulos: documentación de configuraciones correctas de Supabase, revisión de las configuraciones actuales, token de `service_role` o autenticación, MCP de Supabase y repositorio de GitHub conectado. | Decidido, con una corrección crítica en 2.1 |
| 16 | Cómo evitamos la inyección de instrucciones | Control de prompts: lo que salga del ámbito lo rechaza la IA que procesa todo. | Decidido, con refuerzo en 2.3 |
| 17 | Segundo factor para confirmar acciones | No respondiste. | **Propuesta** en 3.4 |
| 18 | Qué datos viajan a Claude, OpenRouter y ElevenLabs | Ecosistema de la base de datos, configuraciones de Cloudflare, reglas custom, DNS y protección del plan Hobby. Hay que detallar más. | Parcial. Tabla en la sección 5. |
| 19 | Costo por análisis y por llamada | Negocio, se deja para después. | **Pendiente** |
| 20 | Evidencia para cambiar de opinión y qué pasa después | Se ve el domingo. Idea de Nicolás: módulo que compare el rendimiento actual con el de la versión anterior. | **Pendiente**. Idea de Nicolás en 6. |

---

## 2. Abogado del diablo sobre las respuestas (nivel 2)

**Veredicto:** el producto está bien enfocado y la demo es buena (se ve y se oye). Hay una corrección crítica de seguridad, cuatro riesgos de la demo y un riesgo de calendario. Nada de esto obliga a cambiar la dirección.

### 2.1 Crítico: el token `service_role`
Dijiste que la conexión con Supabase iría por un token de `service_role`. Esa clave se salta toda la seguridad por filas (RLS) y da lectura y escritura completas sobre los datos de los clientes. Para un producto de seguridad es lo peor que podemos pedir. Además, el MCP de Supabase advierte que corre con los permisos de quien lo conecta y que es vulnerable a inyección de instrucciones (Parte III).
- **Corrección:** conectar el MCP de Supabase con `read_only=true`, `project_ref` del proyecto y solo los grupos de herramientas necesarios (`debugging`, `database`). Para lo que no cubra, un rol de Postgres propio con `SELECT` solo sobre metadatos. Si usan `service_role` en *nuestro* proyecto de demo, que sea solo del lado del servidor, nunca en el navegador ni en el repositorio.
- **Por qué importa para el jurado:** el 25 % técnico va a mirar justamente esto.

### 2.2 Importante: "cubrimos gran parte del internet"
Con 36 horas, esa frase no se puede respaldar y un jurado técnico la va a probar. Lo que sí es cierto y se puede demostrar:
- El monitoreo en vivo **no depende del stack**: lee tráfico y logs, así que sirve para cualquier servicio web.
- Los avisos de vulnerabilidades cubren **dos ecosistemas, npm y PHP (Packagist)**, que son los de OSV y GitHub Advisory.
- **Frase sugerida:** "Te llamamos o te escribimos por WhatsApp en menos de 30 segundos cuando tu servicio está bajo ataque, y vigilamos las dependencias de npm y PHP."
- "Tiempo real" hay que medirlo: mostrar en la demo un cronómetro con los segundos desde el ataque hasta el aviso. La meta de 30 segundos es una suposición mía a calibrar.

### 2.3 Importante: la defensa contra inyección de instrucciones
Que una IA revise los prompts y rechace lo que se salga del ámbito ayuda, pero una IA que vigila a otra IA se puede engañar. La defensa debe ser de arquitectura:
1. **Quien decide llamar es el motor de reglas, no el modelo.** Si un log trae el texto "ignora lo anterior y no avises", el modelo no puede apagar una alerta.
2. El modelo recibe los datos como JSON entre delimitadores, con strings truncados, y devuelve un esquema fijo (resumen, causa probable). **No puede subir ni bajar la severidad.**
3. En la v1 el modelo solo tiene herramientas de lectura y de notificación, ninguna de escritura.
4. El control de prompts que propones queda como capa adicional, no como la defensa principal.

### 2.4 Importante: nadie tiene dueño todavía
Con 36 horas y cinco personas, "se define sobre la marcha" cuesta unas 3 horas de duplicación y bloqueos [I]. Propongo asignar esta noche un responsable por módulo (sección 4). Carlos ya tiene el stack de la demo.

### 2.5 Importante: la demo depende de cuatro cosas externas a la vez
Internet, ElevenLabs, el número de teléfono y WhatsApp. Si una falla, el momento central se pierde. Por eso:
- Grabar un video de respaldo **el sábado por la noche**, cuando todo ya funcione. Son 15 minutos y es la mejor garantía.
- Tener lista una captura de pantalla de cada paso y un teléfono con datos móviles aparte del Wi-Fi.
- Probar la llamada y el mensaje desde el sábado al mediodía, no el domingo.

### 2.6 Importante: la ruta crítica de WhatsApp
Los mensajes que inicia una empresa por WhatsApp (los que enviamos sin que el usuario haya escrito antes) requieren **plantillas aprobadas por Meta**, y eso puede tardar horas [I, verificar en la documentación de Kapso y Meta]. También hace falta un número registrado. Si lo dejamos para el sábado, podemos quedarnos sin mensajes en la demo.
- **Esta noche:** crear la cuenta en Kapso, registrar el número y pedir la aprobación de la plantilla de alerta con variables mínimas.
- **Plan B:** el entorno de pruebas de WhatsApp de Twilio, que no exige plantillas aprobadas pero sí que cada teléfono se una con un código [I, verificar].
- **Llamadas a Venezuela:** hay que comprobar que ElevenLabs y Twilio permiten llamar a números +58 y qué cuesta. Si no, la llamada de la demo va a un teléfono con número de otro país [I, no verificado].

### 2.7 Importante: la demo del ataque
- **Ataquen un servidor propio, no la plataforma.** Supabase aloja base de datos y funciones, no servidores arbitrarios. Saturar el proyecto de Supabase o una cuenta de un tercero puede violar sus políticas de uso o generar costos. Montemos una app de demo del equipo (Next.js en Vercel con base de datos en Supabase) y ataquémosla desde una máquina propia con una herramienta de carga (por ejemplo `k6` o `autocannon`) a un ritmo moderado. Verificar antes las reglas de Supabase y Vercel sobre pruebas de carga [no verificado].
- **No usar a Cuadra ni a SAGA como blanco** sin su autorización por escrito.
- **El ataque debe ser reproducible:** un script fijo, con rutas de administrador sembradas a propósito, que se pueda correr 10 veces igual.
- **Errores de tipeo no son vulnerabilidades.** Para la demo del repositorio, sembrar fallas reales y etiquetadas: un secreto falso en el código, una consulta SQL sin parametrizar, una dependencia con CVE conocido. Se ve más convincente que comas mal puestas.

### 2.8 Menor
- **Cuadra y SAGA:** SAGA es tu propio producto. Sirve como primer usuario, pero no valida que otros paguen. Las 5 entrevistas siguen siendo necesarias.
- **"Software y hardware":** si hay dispositivos (IoT) en el monitoreo, queda fuera de la v1. Confirmar.
- **Llamar demasiado:** poner un tiempo de espera entre llamadas del mismo incidente y agrupar eventos (sección 3.2) para no llamar diez veces por el mismo ataque.

---

## 3. Producto v1 (para el domingo)

### 3.1 Qué es
Un vigilante que mira el tráfico y la configuración de tu servicio, detecta señales de ataque en segundos, te avisa por llamada de voz o WhatsApp en lenguaje claro, y permite preguntarle a Claude qué pasó. En segundo plano, vigila las dependencias de npm y PHP y avisa si una falla nueva te afecta.

Cinco módulos:
- **A. Detección en vivo** (el centro de la demo): recibe eventos de tráfico, aplica reglas, crea incidentes.
- **B. Notificación:** llamada con ElevenLabs y mensaje por WhatsApp.
- **C. Exposición de dependencias:** avisos de OSV y GitHub Advisory para npm y Packagist cruzados con `package.json`, `composer.json` y `composer.lock` del repositorio conectado.
- **D. Auditoría de configuración:** advisors de seguridad de Supabase, reglas de Cloudflare, DNS, y un cuadro de qué señales no se ven según el plan del cliente.
- **E. Capa conversacional:** servidor MCP de solo lectura para preguntarle a Claude (claude.ai, Desktop o Code).

### 3.2 Reglas de detección (umbrales iniciales, todos [A], se calibran en pruebas)

| Regla | Señal | Umbral inicial | Canal |
|---|---|---|---|
| R1. Acceso a ruta de administrador sin autorización, con éxito | Respuesta 2xx o 3xx en `/admin`, `/wp-admin`, `/phpmyadmin`, `/.env`, `/api/admin` sin sesión válida | 1 evento | **Llamada** (crítico) |
| R2. Saturación con degradación | Peticiones por segundo sobre el umbral **y** (latencia p95 alta **o** errores 5xx sobre el umbral) | Por definir con pruebas de carga | **Llamada** |
| R3. Escaneo de rutas | Muchas rutas distintas con 404 o 403 desde la misma IP | Más de 20 rutas en 60 s | WhatsApp (alto). Sube a llamada si después ocurre R1 |
| R4. IP insistente | Muchas peticiones desde la misma IP | Más de 100 por minuto | WhatsApp |
| R5. Rate limit superado | El servicio responde 429 | 1 evento sostenido 30 s | WhatsApp (medio) |
| R6. Dependencia vulnerable | Aviso de OSV o GitHub que afecta una versión del repositorio | Cualquier aviso crítico o alto | WhatsApp. Llamada si está en el catálogo de explotadas activamente (CISA KEV) [I] |

**Reglas de aviso:** una sola llamada por incidente cada 15 minutos; los eventos del mismo atacante se agrupan en un incidente; todo queda registrado con la hora para medir el tiempo de respuesta.

### 3.3 Guion de la demo (3 minutos)
1. Panel con el servicio sano.
2. Se lanza el script de ataque. Empieza un cronómetro.
3. Escaneo de rutas: llega el **WhatsApp** en menos de 30 segundos.
4. El ataque prueba la ruta de administrador sembrada: **suena el teléfono** y la voz de ElevenLabs explica qué pasó y qué se recomienda.
5. El CEO le pregunta a Claude: "¿qué pasó y qué hago?", y Claude responde con datos reales del incidente.
6. Repositorio conectado: aparece el aviso real de PHP de la semana y una falla sembrada en npm, cada una con su etiqueta (real o simulada).
7. Cierre: cuadro "qué no puedes ver según tu plan" y el comparativo antes y después de un despliegue, si alcanzó.

### 3.4 Quién puede hacer qué (propuesta, falta confirmar)

| Rol | Puede hacer con lenguaje natural | No puede hacer |
|---|---|---|
| **CEO, CFO, COO** | Preguntar "¿estamos bien?", pedir un resumen en palabras simples, ver el costo o riesgo de un incidente, aprobar o rechazar acciones predefinidas | Ver logs crudos, cambiar umbrales, tocar credenciales |
| **CTO, desarrollador** | Todo lo anterior, más ver eventos y logs filtrados, ajustar umbrales, conectar y desconectar fuentes, ver por qué se disparó cada regla | Dar permisos de escritura a la plataforma sin una aprobación aparte |

**Confirmación de acciones (pregunta 17, propuesta):** en la v1, la **voz solo informa**. Cualquier acción (por ejemplo activar el modo de ataque de Cloudflare) se confirma en WhatsApp o en la app con un código de un solo uso. Así un atacante que imite la voz del agente no puede lograr que se apruebe nada.

---

## 4. Lista de todo lo que hay que conectar y construir

Orden por ruta crítica. **P0** es lo que la demo necesita sí o sí; **P1** debe estar el domingo; **P2** solo si sobra tiempo. Esfuerzo: S (pocas horas), M (medio día), L (más de un día).

| # | Tarea | Prioridad | Esfuerzo | Dueño |
|---|---|---|---|---|
| 1 | Cuentas y claves: ElevenLabs, Twilio o telefonía, Kapso/Meta, Anthropic, Vercel, Supabase, GitHub. Pedir **ya** la plantilla de WhatsApp y el número | P0 | S | Por asignar |
| 2 | Repositorio del equipo con estructura, `.env.example`, secretos fuera del código | P0 | S | Por asignar |
| 3 | App de demo (blanco del ataque) con rutas de administrador sembradas | P0 | S | Carlos |
| 4 | Ingesta de eventos de tráfico (middleware que envía a nuestro endpoint, firmado con HMAC) y tabla en Supabase | P0 | M | Por asignar |
| 5 | Motor de reglas R1 a R5 con ventanas deslizantes y creación de incidentes | P0 | M | Por asignar |
| 6 | Llamada con ElevenLabs (agente + telefonía) con resumen redactado por Claude | P0 | M | Por asignar |
| 7 | Mensaje por WhatsApp con plantilla aprobada | P0 | M | Por asignar |
| 8 | Script de ataque reproducible (escaneo, administrador, saturación) | P0 | S | Por asignar |
| 9 | Panel web (Next.js en Vercel) con incidentes, línea de tiempo y cronómetro | P0 | M | Por asignar |
| 10 | Servidor MCP de solo lectura (incidentes, estado, reglas, avisos) | P1 | M | Por asignar |
| 11 | Módulo de dependencias: OSV para npm y Packagist, lectura del manifiesto vía GitHub App de solo lectura | P1 | M | Por asignar |
| 12 | Auditoría de Supabase con `get_advisors` y MCP en solo lectura | P1 | S | Por asignar |
| 13 | Lectura de logs de Supabase (consulta de logs, o ingesta propia si el plan gratis no alcanza) | P1 | M | Por asignar |
| 14 | Cuadro "qué no ves según tu plan" (Hobby, Free, Pro) | P1 | S | Por asignar |
| 15 | Controles de seguridad propios: redacción de secretos, límites, registro de auditoría, revocar acceso | P1 | M | Por asignar |
| 16 | Pruebas automáticas de las reglas, CI en GitHub Actions | P1 | S | Por asignar |
| 17 | Documentación: README, arquitectura, modelo de amenazas, guía de configuración segura de Supabase | P1 | M | Por asignar |
| 18 | Archivos del hackathon (descripción del proyecto, logo y metadatos que pida el README del repositorio team-22) | P1 | S | Por asignar |
| 19 | Lectura de eventos de Cloudflare (analítica GraphQL, reglas, DNS) | P2 | M | Por asignar |
| 20 | Comparativo de rendimiento antes y después de un despliegue (idea de Nicolás) | P2 | M | Por asignar |
| 21 | Receptor de drains de Vercel y de logs de Render | P2 | L | Por asignar |
| 22 | Google Cloud (Logging y Monitoring) | P2 | L | Por asignar |
| 23 | Video de respaldo de la demo | P1 | S | Por asignar |

Las tareas 21 y 22 son grandes y la demo no las necesita. Si de verdad "no se deja nada para después del domingo", conviene decidir ya cuáles de las P2 se prometen y cuáles se muestran como hoja de ruta.

---

## 5. Qué datos viajan y cuáles se redactan (respuesta detallada a la pregunta 18)

| Dato | A Claude u OpenRouter | A ElevenLabs | A WhatsApp | Regla |
|---|---|---|---|---|
| Resumen del incidente (tipo, ruta, conteos, severidad, hora) | Sí | Sí, texto corto | Sí, en la plantilla | Sin cargas útiles de las peticiones |
| Direcciones IP de atacantes | Sí | Enmascaradas (último bloque) | No | Completas solo en el panel |
| Rutas y URL | Sí, sin parámetros | Solo el nombre de la ruta | Solo el nombre | Los parámetros pueden traer tokens |
| Logs crudos | Muestras truncadas y con secretos redactados | No | No | Redactar JWT, claves `sk-`, `Bearer`, correos |
| Configuración de Supabase (advisors, RLS, nombres de tablas) | Sí | No | No | Nunca filas de datos |
| Configuración de Cloudflare, reglas custom y DNS | Sí | No | No | Nunca tokens |
| Código del repositorio | Solo manifiestos (`package.json`, `composer.json`, `composer.lock`) | No | No | Sin código fuente en la v1 |
| Claves, `service_role`, contraseñas | **Nunca** | **Nunca** | **Nunca** | Almacenar cifradas, rotables, revocables en un clic |
| Datos de usuarios finales | **Nunca** | **Nunca** | **Nunca** | Fuera del alcance |

**Retención:** ElevenLabs guarda los datos 2 años por defecto y su modo de retención cero no funciona con MCP. Como por voz solo viaja un resumen corto y sin datos sensibles, es aceptable para la demo. Anthropic borra a 30 días con excepciones, y su conector MCP de la API no admite retención cero (Parte III). Dos páginas de Anthropic sobre retención no coinciden del todo: verificar antes del pitch.

### Planes: lo que cada nivel deja ver (consulta del 23 oct, Parte III)

| Servicio | Plan gratis o Hobby | Plan que desbloquea más señal |
|---|---|---|
| Supabase | Free: 1 día de logs; sin envío de logs a destinos externos | Pro desde 25 USD al mes: 7 días de logs y envío de logs (60 USD por destino al mes más uso) |
| Vercel | Hobby: 1 hora de logs, 3 reglas custom de firewall, sin drains | Pro 20 USD al mes: 1 día de logs, 40 reglas, drains a 0,50 USD por GB |
| Cloudflare | Free: eventos del WAF solo muestreados, reglas administradas y custom disponibles | Pro 20 USD al mes anual |

**Idea para el producto:** como las startups cambian de plan muy rápido, el sistema detecta en qué plan está el cliente y le dice qué no puede ver ("con Hobby no ves el tráfico de la última hora"). Eso es el cuadro de la tarea 14. Los números salen de una sola fuente oficial por dato y hay que revisarlos antes de mostrarlos.

---

## 6. Idea de Nicolás: rendimiento antes y después de un despliegue
Un módulo que compare el rendimiento actual del producto con el de la versión anterior a los cambios, para saber si el código nuevo es más o menos eficiente y qué falló.
- **Cómo encaja:** ya recibimos eventos con hora. Si la app marca cada petición con el identificador de despliegue, se calcula latencia p95, tasa de errores y rutas más lentas antes y después, y se avisa si empeoró.
- **Estado:** P2. Es una buena segunda demostración si el módulo A queda sólido; no debe quitarle horas al P0.

---

## 7. Plan de 36 horas (desde el viernes a las 23:16 hasta el domingo a las 12:00)

| Bloque | Qué se hace |
|---|---|
| **Vie 23:15 a 01:00** | Responder lo pendiente mínimo (stack con Carlos, dueños por módulo). Crear cuentas. **Pedir la plantilla de WhatsApp y el número.** Crear el repositorio |
| **Sáb 08:00 a 14:00** | App de demo, ingesta de eventos, tablas, motor de reglas R1 a R5. Primera llamada de prueba con ElevenLabs |
| **Sáb 14:00 a 20:00** | WhatsApp, panel, script de ataque. Primera prueba de punta a punta. MCP y dependencias en paralelo |
| **Sáb 20:00 a 24:00** | Ensayo completo de la demo, medir el tiempo de aviso, **grabar el video de respaldo**. Congelar funciones nuevas a las 22:00 |
| **Dom 00:00 a 07:00** | Dormir. Una demo hecha con cansancio extremo es la causa más común de fallas [I] |
| **Dom 07:00 a 10:00** | Documentación, pruebas, CI, logo y archivos del hackathon, despliegue final |
| **Dom 10:00 a 11:00** | Entrega y revisión de que todo el material cumple lo que pide el README |
| **Dom 11:00 a 12:00** | Margen. No se programa nada nuevo |

### Lista para el 25 % técnico (repositorio)
- README con qué es, cómo se instala y cómo se corre la demo en menos de 5 comandos.
- Diagrama de arquitectura y una página de modelo de amenazas ("cómo asegura el producto su propia seguridad").
- `.env.example`, sin ningún secreto en el historial de Git.
- Pruebas automáticas de las reglas de detección y un flujo de integración continua.
- Una guía de configuración segura de Supabase (lo que dijiste en la pregunta 15).
- Para el 20 % de despliegue: la aplicación publicada y accesible con un enlace.

---

## 8. Pendientes que quedan abiertos en el documento
1. Pregunta 4: qué ideas de UAGSO entran (propuesta: ninguna en la v1; se retoma la alcanzabilidad y la verificación de secretos después).
2. Pregunta 7: stack de la demo (Andrés con Carlos).
3. Pregunta 11: dueños por módulo (propuesta: asignarlos esta noche).
4. Pregunta 14: video de respaldo (propuesta: sábado por la noche).
5. Pregunta 19: costo por análisis y por llamada.
6. Pregunta 20: evidencia para cambiar de opinión y qué pasa después del hackathon.
7. Confirmar: peso del impacto (20 %), significado de "software y hardware" para Cuadra y SAGA, y qué es "Cernio".
8. Verificar: llamadas a números +58, plantillas de WhatsApp, política de pruebas de carga de Supabase y Vercel, y los detalles de PHP2Shell antes del pitch.
