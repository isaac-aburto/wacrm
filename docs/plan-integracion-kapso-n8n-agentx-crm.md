# Plan de trabajo: integración Kapso + n8n + AgentX con el CRM

**Estado:** Propuesto  
**Fecha:** 2026-07-16  
**Repositorios involucrados:** `wacrm` y `agentx`  
**Infraestructura:** Docker Compose, Nginx, Supabase, PostgreSQL de LangGraph, Redis, n8n, Kapso y LangSmith

## 1. Objetivo

Integrar el flujo actual de WhatsApp operado por Kapso, n8n y AgentX con el CRM para que los usuarios puedan:

- Ver en tiempo real las conversaciones entre clientes y el agente.
- Distinguir mensajes del cliente, del agente de IA y de un operador humano.
- Ver estados de entrega, lectura y error.
- Tomar y devolver el control de una conversación.
- Responder desde el CRM utilizando el mismo canal de Kapso.
- Utilizar contactos, negocios y contexto comercial del CRM dentro de AgentX.

La integración debe preservar el flujo productivo existente y evitar que Meta, Kapso, n8n o el CRM envíen respuestas duplicadas.

## 2. Alcance

### Incluido

- Cambios aditivos en el esquema de Supabase.
- API interna, autenticada e idempotente, para eventos de canal.
- Integración bidireccional entre n8n y el CRM.
- Reflejo de mensajes entrantes, salientes y estados en la bandeja del CRM.
- Control humano/IA por conversación.
- Correlación entre conversación CRM, ejecución n8n, thread de LangGraph y mensaje Kapso.
- Pruebas, observabilidad, despliegue gradual y rollback.

### Fuera del MVP

- Reemplazar Kapso o n8n.
- Exponer checkpoints internos de LangGraph directamente al usuario.
- Migrar las tablas de checkpoints de LangGraph al esquema comercial del CRM.
- Permitir que Meta Cloud API y Kapso envíen simultáneamente por el mismo número.
- Rediseñar toda la bandeja de entrada del CRM.

## 3. Estado actual confirmado

### CRM

- Ya existen `contacts`, `conversations` y `messages`.
- `messages.sender_type` distingue `customer`, `agent` y `bot`.
- `messages.status` soporta `sending`, `sent`, `delivered`, `read` y `failed`.
- `messages` y `conversations` están publicados en Supabase Realtime.
- Las políticas RLS aíslan los datos por `account_id`.
- La API pública permite consultar conversaciones y mensajes.
- El webhook y el envío actual de WhatsApp están acoplados a Meta Cloud API y a `whatsapp_config`.
- `messages.message_id` tiene índice, pero no una restricción única apta para deduplicar eventos de distintos canales.

### n8n

- Recibe el webhook de Kapso y valida su firma.
- Deduplica, limita tráfico y agrupa ráfagas mediante Redis.
- Procesa texto, audio, imagen y otros tipos de contenido.
- Invoca `http://agentx-api:8000/chat`.
- Envía la respuesta a través de Kapso.
- Ya posee una rama `requires_human`, pero el envío al dashboard es provisional.
- El nodo de enriquecimiento de contexto comercial todavía es un stub.

### AgentX

- Utiliza `thread_id` como clave de persistencia de LangGraph.
- Mantiene `funnel_stage` en PostgreSQL mediante `PostgresSaver`.
- Devuelve `funnel_stage`, `requires_human`, `next_owner`, `route` y `thread_id`.
- Su PostgreSQL de checkpoints está separado del PostgreSQL utilizado por n8n y de Supabase.

## 4. Principios y decisiones de arquitectura

| ID | Decisión |
|---|---|
| ARQ-01 | Durante la primera versión, n8n será el único propietario operativo del canal Kapso. |
| ARQ-02 | Supabase será la fuente de verdad comercial para contactos, conversaciones, mensajes, asignaciones y control humano/IA. |
| ARQ-03 | PostgreSQL de AgentX seguirá siendo la fuente de verdad para checkpoints y memoria interna de LangGraph. |
| ARQ-04 | Redis conservará solamente estado transitorio: buffers, rate limit, deduplicación temporal y caché de pausa. |
| ARQ-05 | LangSmith se utilizará para observabilidad técnica, no como fuente de datos del CRM. |
| ARQ-06 | n8n no escribirá directamente a Supabase usando `SUPABASE_SERVICE_ROLE_KEY`; utilizará una API interna del CRM. |
| ARQ-07 | La cuenta se resolverá en el servidor mediante el `phone_number_id` de Kapso; nunca desde un `account_id` no confiable incluido en el webhook. |
| ARQ-08 | El UUID de la conversación del CRM será el `thread_id` estable de AgentX una vez resuelta la conversación. |
| ARQ-09 | Todos los eventos y comandos deberán ser firmados e idempotentes. |
| ARQ-10 | Las migraciones serán aditivas y compatibles con el código actual para permitir rollback sin pérdida de datos. |

## 5. Arquitectura objetivo

```text
WhatsApp
   │
   ▼
 Kapso
   │ webhook y estados
   ▼
  n8n ───────────────► API interna CRM ───────────────► Supabase
   │                         │                            │
   │                         │                            ▼
   │                         │                    Realtime / Inbox
   ▼                         │
AgentX / LangGraph           │
   │                         │
   └──── respuesta ─► n8n ───┴──► Kapso ─► WhatsApp

CRM / operador ─► comando firmado ─► n8n ─► Kapso ─► WhatsApp
```

## 6. Modelo de datos propuesto

Los nombres definitivos deben validarse contra las convenciones del proyecto antes de crear la migración.

### 6.1 `channel_connections`

Representa un número/canal externo conectado a una cuenta.

| Columna | Tipo sugerido | Reglas |
|---|---|---|
| `id` | `uuid` | PK |
| `account_id` | `uuid` | FK a `accounts`, no nulo |
| `provider` | `text` | CHECK: `kapso`, `meta` |
| `external_phone_number_id` | `text` | No nulo |
| `display_phone` | `text` | Teléfono normalizado para visualización |
| `status` | `text` | CHECK: `connected`, `disconnected`, `error` |
| `metadata` | `jsonb` | Sólo datos no secretos y acotados |
| `created_at` | `timestamptz` | Default `now()` |
| `updated_at` | `timestamptz` | Actualización automática |

Restricciones:

- `UNIQUE(provider, external_phone_number_id)`.
- RLS por membresía de `account_id`.
- Las credenciales de Kapso permanecen en n8n durante el MVP.

### 6.2 Cambios en `conversations`

Agregar:

| Columna | Propósito |
|---|---|
| `channel_connection_id` | Canal por el cual se desarrolla la conversación. |
| `external_conversation_id` | ID de conversación entregado por el proveedor, cuando exista. |
| `agent_thread_id` | Identificador utilizado por LangGraph. |
| `automation_mode` | `agent`, `human` o `paused`. |
| `handoff_reason` | Motivo de escalamiento a humano. |
| `funnel_stage` | Proyección comercial de la etapa de AgentX. |
| `lead_temperature` | Temperatura actual del lead. |
| `last_agent_route` | Última ruta/nodo funcional informado por AgentX. |
| `automation_updated_at` | Momento del último cambio de control. |

Restricciones e índices:

- Índice por `(account_id, channel_connection_id, last_message_at)`.
- Índice parcial por `agent_thread_id`.
- Unicidad por canal y conversación externa cuando el proveedor entregue un ID estable.
- Cuando no exista `external_conversation_id`, resolver por `channel_connection_id + contact_id` según la política de conversaciones del negocio.

### 6.3 Cambios en `messages`

Agregar:

| Columna | Propósito |
|---|---|
| `channel_connection_id` | Permite deduplicar y resolver estados sin joins ambiguos. |
| `provider_message_id` | ID real de Kapso/WhatsApp. |
| `source` | `customer`, `agentx`, `human`, `n8n` o `system`. |
| `provider_created_at` | Timestamp original del proveedor. |
| `provider_metadata` | Metadatos mínimos, validados y sin secretos. |
| `failure_code` | Código normalizado de error. |
| `failure_reason` | Motivo seguro para diagnóstico. |

Restricciones:

- Índice único parcial sobre `(channel_connection_id, provider_message_id)` cuando `provider_message_id IS NOT NULL`.
- Mantener `sender_type = bot` para AgentX, `agent` para humano y `customer` para el cliente.
- Revisar el CHECK de `content_type` para cubrir `interactive`, `reaction`, `sticker` y `contacts`, o definir una conversión explícita para tipos no soportados.
- Las transiciones de estado deben ser monotónicas: un evento atrasado no puede cambiar `read` nuevamente a `delivered`.

### 6.4 `integration_events`

Registro técnico para idempotencia y operación.

| Columna | Propósito |
|---|---|
| `id` | PK interna. |
| `channel_connection_id` | Canal asociado. |
| `external_event_id` | ID del evento o hash determinista. |
| `event_type` | Tipo normalizado. |
| `payload_hash` | Evidencia para detectar payloads distintos con el mismo ID. |
| `processing_status` | `received`, `processed`, `ignored`, `failed`. |
| `attempts` | Número de intentos. |
| `error_code` | Error normalizado sin datos sensibles. |
| `received_at` | Recepción original. |
| `processed_at` | Finalización. |

Restricción principal:

- `UNIQUE(channel_connection_id, external_event_id)`.

No almacenar el payload completo indefinidamente. Si se necesita para diagnóstico, aplicar cifrado, acceso restringido y retención corta.

## 7. Contratos de integración

### 7.1 n8n → CRM: eventos de canal

Endpoint propuesto:

```http
POST /api/internal/channel-events
```

Headers:

```http
Content-Type: application/json
X-Void-Timestamp: 2026-07-16T15:30:00Z
X-Void-Event-Id: evt_...
X-Void-Signature: v1=<hmac-sha256>
```

Sobre de evento:

```json
{
  "schema_version": "1",
  "event_id": "evt_01...",
  "event_type": "message.received",
  "provider": "kapso",
  "phone_number_id": "123456789",
  "occurred_at": "2026-07-16T15:30:00Z",
  "data": {
    "provider_message_id": "wamid...",
    "provider_conversation_id": "conv...",
    "from": "56912345678",
    "to": "56987654321",
    "contact_name": "Cliente",
    "content_type": "text",
    "text": "Hola, busco una propiedad",
    "media": null,
    "reply_to_provider_message_id": null
  }
}
```

Respuesta para un mensaje entrante:

```json
{
  "data": {
    "account_id": "uuid",
    "contact_id": "uuid",
    "conversation_id": "uuid",
    "message_id": "uuid",
    "agent_thread_id": "uuid",
    "automation_mode": "agent",
    "duplicate": false
  }
}
```

Eventos mínimos:

- `message.received`
- `message.sending`
- `message.sent`
- `message.delivered`
- `message.read`
- `message.failed`
- `conversation.handoff_requested`
- `conversation.agent_state_updated`

### 7.2 CRM → n8n: comandos de canal

Endpoint interno de n8n propuesto:

```http
POST /webhook/crm-channel-command
```

Comandos iniciales:

- `message.send`
- `conversation.takeover`
- `conversation.resume_agent`
- `conversation.pause`

Cada comando debe incluir:

- `command_id` único.
- `conversation_id`.
- `channel_connection_id`.
- Timestamp y firma HMAC.
- Actor autenticado cuando el comando provenga de una acción humana.
- Contenido acotado y validado.

n8n debe persistir/deduplicar el `command_id`, ejecutar Kapso y reportar el resultado al endpoint de eventos del CRM.

### 7.3 Autorización previa al envío automático

Para cerrar la carrera entre una respuesta de AgentX y una toma de control humana:

```http
POST /api/internal/channel-send-authorizations
```

n8n lo invocará inmediatamente antes de cada envío automático. La respuesta indicará si el mensaje sigue autorizado:

```json
{
  "allowed": false,
  "automation_mode": "human",
  "reason": "human_takeover"
}
```

Redis puede acelerar esta comprobación, pero Supabase seguirá siendo la fuente permanente de verdad.

## 8. Plan por fases

### Fase 0 — Contrato, inventario y línea base

#### Tareas

- [ ] `ARQ-11` Confirmar el número/`phone_number_id` productivo y su cuenta CRM correspondiente.
- [ ] `ARQ-12` Documentar eventos Kapso activos y si el webhook usa formato Kapso o forwarding Meta.
- [ ] `ARQ-13` Exportar una copia versionada del workflow n8n antes de modificarlo.
- [ ] `ARQ-14` Registrar versión de imágenes Docker, migraciones aplicadas y variables requeridas, sin copiar secretos.
- [ ] `ARQ-15` Definir retención de mensajes, medios y eventos técnicos.
- [ ] `ARQ-16` Definir el contrato JSON v1 y catálogo de errores.
- [ ] `ARQ-17` Definir métricas de línea base: mensajes recibidos, enviados, fallidos y handoffs.

#### Criterios de aceptación

- Existe un mapeo inequívoco `phone_number_id → account_id`.
- El workflow actual puede restaurarse.
- El contrato v1 está aprobado antes de escribir migraciones o nodos n8n.

### Fase 1 — Fundaciones de datos y seguridad

#### Tareas

- [ ] `DB-01` Crear `channel_connections`.
- [ ] `DB-02` Agregar columnas de canal y estado del agente a `conversations`.
- [ ] `DB-03` Agregar identidad del proveedor y metadatos seguros a `messages`.
- [ ] `DB-04` Crear `integration_events` e índices de idempotencia.
- [ ] `DB-05` Extender o normalizar los tipos de contenido soportados.
- [ ] `DB-06` Crear políticas RLS por cuenta y políticas de servicio estrictamente necesarias.
- [ ] `DB-07` Verificar que las nuevas columnas no rompan consultas ni tipos TypeScript existentes.
- [ ] `SEC-01` Crear secreto de integración independiente, rotatable y distinto de claves de Supabase/Kapso.
- [ ] `SEC-02` Implementar verificación HMAC sobre el cuerpo crudo, timestamp y event/command ID.
- [ ] `SEC-03` Rechazar timestamps con desfase mayor al umbral acordado y eventos repetidos.

#### Criterios de aceptación

- Las migraciones son aditivas y repetibles en un ambiente limpio.
- Las políticas RLS impiden lectura cruzada entre cuentas.
- Dos canales pueden recibir el mismo `provider_message_id` sin colisionar.
- El mismo evento en el mismo canal se procesa una sola vez.
- El CRM actual continúa funcionando sin utilizar todavía las columnas nuevas.

### Fase 2 — MVP de visibilidad en el CRM

#### Tareas en el CRM

- [ ] `API-01` Implementar `POST /api/internal/channel-events`.
- [ ] `API-02` Validar tamaño máximo, esquema, teléfono, timestamps, tipos y longitudes.
- [ ] `API-03` Resolver la cuenta exclusivamente por `channel_connections`.
- [ ] `API-04` Crear/upsert idempotente de contacto por teléfono normalizado.
- [ ] `API-05` Crear o resolver la conversación correcta.
- [ ] `API-06` Insertar el mensaje y actualizar la conversación dentro de una transacción.
- [ ] `API-07` Devolver contexto mínimo para n8n y AgentX.
- [ ] `API-08` Agregar IDs de correlación a logs sin registrar el contenido completo del mensaje.

#### Tareas en n8n

- [ ] `N8N-01` Llamar al endpoint de ingestión después de validar/deduplicar y antes del burst buffer.
- [ ] `N8N-02` Reemplazar el `client_id` fijo por el `account_id` resuelto por el CRM.
- [ ] `N8N-03` Usar `conversation_id`/`agent_thread_id` como `thread_id` de AgentX.
- [ ] `N8N-04` Registrar cada fragmento realmente enviado por Kapso como un mensaje separado.
- [ ] `N8N-05` Guardar el ID real devuelto por Kapso.
- [ ] `N8N-06` Incluir un identificador opaco del mensaje CRM en `biz_opaque_callback_data` cuando corresponda.
- [ ] `N8N-07` Definir manejo de reintentos con backoff sin duplicar mensajes.

#### Tareas de UI

- [ ] `UI-01` Verificar que Supabase Realtime muestre los mensajes nuevos sin refrescar.
- [ ] `UI-02` Mostrar claramente mensajes de cliente, AgentX y humano.
- [ ] `UI-03` Mostrar un indicador de conversación automatizada, aunque todavía sea sólo informativo.
- [ ] `UI-04` Confirmar comportamiento para texto, audio, imagen, documento y tipos no soportados.

#### Criterios de aceptación

- Un mensaje entrante aparece en el CRM una sola vez y en la cuenta correcta.
- Una respuesta de AgentX aparece con `sender_type = bot`.
- La latencia de visualización cumple el objetivo operativo acordado.
- Reejecutar un webhook o una ejecución n8n no duplica mensajes.
- Un fallo del CRM no provoca que n8n envíe dos respuestas al cliente.
- El flujo productivo existente de AgentX continúa respondiendo por Kapso.

### Fase 3 — Estados de entrega y reconciliación

#### Tareas

- [ ] `KAPSO-01` Suscribir `message.sent`, `message.delivered`, `message.read` y `message.failed`.
- [ ] `N8N-08` Normalizar los estados de Kapso al estado del CRM.
- [ ] `API-09` Procesar estados fuera de orden sin degradar un estado más avanzado.
- [ ] `API-10` Guardar códigos de fallo normalizados y mensajes seguros.
- [ ] `OPS-01` Crear consulta/reporte de reconciliación por rango de tiempo.
- [ ] `OPS-02` Detectar mensajes Kapso sin fila CRM y filas CRM sin confirmación del proveedor.

#### Criterios de aceptación

- `sent → delivered → read` se refleja correctamente.
- Un evento `delivered` tardío no degrada un mensaje que ya está `read`.
- Los fallos son visibles y diagnosticables sin exponer credenciales ni payloads sensibles.
- La reconciliación identifica diferencias sin modificar datos automáticamente.

### Fase 4 — Handoff y respuesta humana

#### Tareas en CRM

- [ ] `DB-08` Activar `automation_mode` como fuente de verdad por conversación.
- [ ] `API-11` Implementar transición atómica `agent → human`.
- [ ] `API-12` Implementar transición controlada `human → agent`.
- [ ] `API-13` Implementar autorización previa al envío automático.
- [ ] `API-14` Emitir comandos firmados e idempotentes hacia n8n.
- [ ] `UI-05` Agregar “Tomar conversación”.
- [ ] `UI-06` Agregar “Devolver al agente”.
- [ ] `UI-07` Mostrar quién tiene actualmente el control.
- [ ] `UI-08` Deshabilitar o adaptar el compositor según rol, canal y modo.
- [ ] `UI-09` Mostrar motivo de handoff y asignación.

#### Tareas en n8n

- [ ] `N8N-09` Sustituir la rama provisional `DASHBOARD_WEBHOOK` por el evento de handoff del CRM.
- [ ] `N8N-10` Procesar `conversation.takeover`, `resume_agent` y `pause`.
- [ ] `N8N-11` Mantener `paused:<waId>` como caché coherente con Supabase.
- [ ] `N8N-12` Consultar autorización justo antes de enviar cada respuesta automática.
- [ ] `N8N-13` Enviar mensajes humanos solicitados por el CRM y reportar su resultado.
- [ ] `N8N-14` Evitar que un mensaje humano dispare nuevamente al agente como si fuera entrante.

#### Tareas en AgentX

- [ ] `AGENT-01` Proyectar `requires_human`, `next_owner`, `route`, `funnel_stage` y temperatura al CRM.
- [ ] `AGENT-02` Confirmar el comportamiento al reanudar un thread después de una intervención humana.
- [ ] `AGENT-03` Definir si la intervención humana se incorpora a la memoria del thread y con qué formato.

#### Criterios de aceptación

- Tomar una conversación impide nuevas respuestas automáticas.
- No se envía una respuesta de IA que quedó en carrera después del takeover.
- Un humano puede responder desde el CRM y el mensaje aparece con `sender_type = agent`.
- Al devolver el control, AgentX continúa usando el mismo thread y contexto autorizado.
- Todas las transiciones quedan auditadas con actor y timestamp.

### Fase 5 — Contexto comercial y automatizaciones

#### Tareas

- [ ] `CTX-01` Reemplazar el nodo stub “Enrich context” por información real del CRM.
- [ ] `CTX-02` Entregar a AgentX sólo los campos comerciales estrictamente necesarios.
- [ ] `CTX-03` Proyectar `funnel_stage` y `lead_temperature` a contacto, conversación o negocio según la decisión funcional.
- [ ] `CTX-04` Vincular/crear negocios sin duplicarlos.
- [ ] `CTX-05` Definir reglas de asignación a agentes humanos.
- [ ] `CTX-06` Evaluar qué webhooks y automatizaciones existentes del CRM deben ejecutarse con mensajes Kapso.
- [ ] `CTX-07` Evitar ciclos CRM → n8n → CRM mediante `origin`, `event_id` y reglas explícitas.

#### Criterios de aceptación

- AgentX recibe contexto de la cuenta y contacto correctos.
- La actualización de etapa es idempotente y no crea negocios duplicados.
- Los datos de otra cuenta nunca aparecen en prompts, respuestas o logs.
- Las automatizaciones no generan bucles ni mensajes duplicados.

### Fase 6 — Hardening y operación productiva

#### Tareas

- [ ] `SEC-04` Conectar CRM y n8n por una red Docker interna compartida.
- [ ] `SEC-05` Mantener autenticación HMAC aun dentro de la red interna.
- [ ] `SEC-06` Configurar rotación de secretos y procedimiento de revocación.
- [ ] `SEC-07` Aplicar rate limit, límite de cuerpo y timeout a endpoints internos.
- [ ] `SEC-08` Proteger medios mediante almacenamiento privado y URLs firmadas de corta duración.
- [ ] `SEC-09` Revisar logs para ocultar tokens, contenido sensible y teléfonos completos.
- [ ] `OPS-03` Agregar healthchecks de la integración.
- [ ] `OPS-04` Crear métricas y alertas.
- [ ] `OPS-05` Documentar runbook de fallos de Kapso, n8n, AgentX, CRM y Supabase.
- [ ] `OPS-06` Probar backup y restauración de la información comercial.
- [ ] `OPS-07` Definir política de retención y eliminación de eventos técnicos.

#### Criterios de aceptación

- Los endpoints internos no quedan accesibles sin autenticación válida.
- La caída de AgentX no bloquea el registro del mensaje entrante.
- La caída temporal del CRM no produce duplicados al recuperarse.
- Existen alertas accionables y un procedimiento probado de recuperación.

## 9. Seguridad obligatoria

- Firmar el cuerpo crudo con HMAC-SHA256 y comparación en tiempo constante.
- Incluir versión de firma, timestamp e ID idempotente.
- Rechazar replay fuera de la ventana temporal permitida.
- Mantener secretos de integración separados por ambiente.
- No exponer `SUPABASE_SERVICE_ROLE_KEY`, claves Kapso ni secretos HMAC al navegador.
- No asumir que la red Docker es un mecanismo de autenticación.
- Resolver tenant/cuenta desde una asociación interna confiable.
- Validar y limitar todos los strings, URLs, teléfonos, MIME types y tamaños.
- No descargar medios desde hosts arbitrarios sin allowlist y protección SSRF.
- Utilizar URLs firmadas para medios privados.
- Aplicar RLS a todas las tablas expuestas a Supabase API/Realtime.
- Auditar toma de control, reanudación, asignación y mensajes humanos.
- Evitar registrar prompts, mensajes completos o PII salvo que exista una necesidad y retención aprobadas.

## 10. Estrategia de pruebas

### Unitarias

- Firma HMAC válida, inválida y con timestamp expirado.
- Normalización de teléfonos.
- Conversión de eventos Kapso al contrato interno.
- Máquina monotónica de estados de mensaje.
- Cálculo de idempotency keys.
- Validación de tipos y límites de payload.

### Integración

- Upsert de contacto y conversación.
- Repetición del mismo evento.
- Mismo provider message ID en canales distintos.
- Separación RLS entre dos cuentas.
- Evento de estado antes del evento `sent`.
- Fallo parcial durante la transacción.
- Cambio de modo mientras AgentX está procesando.

### End-to-end

- Texto entrante → AgentX → texto saliente → delivered → read.
- Audio e imagen con contenido derivado.
- Respuesta dividida en varios mensajes.
- Handoff solicitado por AgentX.
- Takeover manual durante una ejecución.
- Mensaje enviado por humano.
- Reanudación del agente en el mismo thread.
- Reejecución de webhook y workflow n8n.
- Caída temporal de CRM, AgentX, Redis o Kapso.

### Seguridad

- Firma incorrecta.
- Replay.
- `phone_number_id` inexistente.
- Intento de forzar otro `account_id`.
- Payload excesivo.
- URL de medio hacia IP privada/metadata service.
- Comando duplicado o emitido por un actor sin permisos.

## 11. Observabilidad

Utilizar un `correlation_id` compartido entre:

- Evento Kapso.
- Ejecución n8n.
- Mensaje y conversación CRM.
- Thread y ejecución de AgentX.
- Traza LangSmith.

Métricas mínimas:

- Eventos recibidos/procesados/duplicados/fallidos.
- Latencia Kapso → CRM.
- Latencia Kapso → AgentX → Kapso.
- Mensajes por estado.
- Handoffs solicitados y completados.
- Mensajes bloqueados por takeover.
- Reintentos y eventos en dead-letter/manual review.
- Diferencias detectadas por reconciliación.

Alertas iniciales:

- Aumento sostenido de `message.failed`.
- Eventos internos con firma inválida.
- Cola o reintentos sobre el umbral acordado.
- Desconexión de Realtime o canal Kapso.
- Diferencia relevante entre mensajes enviados por Kapso y registrados en CRM.

## 12. Estrategia de despliegue

### Preparación

- Respaldar Supabase y exportar workflow n8n.
- Registrar imágenes y configuración Docker actuales.
- Aplicar migraciones primero; deben ser compatibles con la versión anterior.
- Desplegar endpoints internos sin conectarlos todavía al workflow productivo.
- Verificar healthchecks y firmas en un ambiente de prueba.

### Activación gradual

1. Activar sólo el reflejo de mensajes entrantes.
2. Comparar volumen e idempotencia con las ejecuciones de n8n.
3. Activar reflejo de mensajes salientes.
4. Activar estados de entrega.
5. Activar handoff sin respuesta humana.
6. Activar respuesta humana para usuarios autorizados.
7. Activar enriquecimiento comercial y automatizaciones.

### Rollback

- Desactivar las llamadas de integración desde n8n mediante una variable/feature flag.
- Restaurar el workflow n8n exportado.
- Mantener columnas y tablas aditivas; no eliminarlas durante el rollback operativo.
- Volver a modo `agent` sólo mediante una operación explícita y auditada.
- Reconciliar los eventos ocurridos durante la ventana de rollback antes de reactivar.

## 13. Riesgos principales

| Riesgo | Mitigación |
|---|---|
| Mensajes duplicados por reintentos | Restricciones únicas, event IDs y comandos idempotentes. |
| Respuesta del bot después de takeover | Autorización inmediata antes del envío y estado persistente en Supabase. |
| Cruce de datos entre clientes | Resolución server-side del canal, RLS y pruebas multi-tenant. |
| Estados fuera de orden | Máquina de estados monotónica y timestamps del proveedor. |
| Dos propietarios enviando por WhatsApp | n8n como propietario único de Kapso durante el MVP. |
| Pérdida de mensajes durante una caída | Reintentos, registro de eventos y reconciliación. |
| Ciclos entre webhooks/automatizaciones | `origin`, IDs idempotentes y catálogo explícito de eventos. |
| Crecimiento de datos técnicos | Retención corta y limpieza programada de `integration_events`. |
| Medios expirados o inseguros | Copia controlada a storage privado, allowlist y URLs firmadas. |

## 14. Definición de terminado

La integración se considera productivamente terminada cuando:

- [ ] Todos los mensajes entrantes y salientes aparecen una sola vez en el CRM.
- [ ] Los estados de entrega se reflejan correctamente.
- [ ] Cada conversación pertenece a la cuenta y canal correctos.
- [ ] El operador puede tomar, responder y devolver la conversación sin carreras.
- [ ] AgentX conserva el thread correcto y recibe contexto autorizado.
- [ ] RLS y pruebas multi-tenant están aprobadas.
- [ ] Existen métricas, alertas, reconciliación y runbook.
- [ ] Backup y rollback fueron probados.
- [ ] No se exponen secretos en navegador, logs, repositorio ni payloads persistidos.
- [ ] La documentación operativa y el contrato de eventos están versionados.

## 15. Orden recomendado para la primera iteración

La primera iteración debe entregar únicamente visibilidad confiable:

1. Aprobar contrato v1 y mapping `phone_number_id → account_id`.
2. Crear migración aditiva e idempotencia.
3. Implementar el endpoint de eventos.
4. Reflejar mensajes entrantes antes del burst buffer.
5. Reflejar cada mensaje saliente después de Kapso.
6. Verificar Realtime, RLS y ausencia de duplicados.
7. Operar en observación antes de habilitar controles humanos.

Después de estabilizar esta iteración se debe continuar con estados de entrega y, finalmente, con takeover y respuesta humana.

## 16. Decisiones pendientes

- [ ] ¿Una conversación se mantiene abierta indefinidamente por contacto o se crea una nueva según ventana/campaña?
- [ ] ¿Cuánto tiempo se conservarán mensajes, adjuntos y eventos técnicos?
- [ ] ¿Qué roles del CRM pueden tomar, reanudar y responder conversaciones?
- [ ] ¿Los mensajes humanos deben incorporarse a la memoria de AgentX al reanudar?
- [ ] ¿Dónde debe proyectarse `funnel_stage`: conversación, contacto, negocio o más de uno?
- [ ] ¿Qué tipos de medios se copiarán a Supabase Storage y cuáles se mantendrán sólo como metadatos?
- [ ] ¿Cuál será el SLO de visualización y envío?
- [ ] ¿Se utilizará un ambiente/número de prueba antes del número productivo?
