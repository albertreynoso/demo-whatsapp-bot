# Bot de WhatsApp con IA para agendar citas

Demo de portafolio: un asistente para una clínica dental (ficticia) que responde precios y horarios **solo con la información del negocio**, consulta la agenda, **reserva citas** y **deriva a una persona** cuando hace falta. Funciona por WhatsApp (API oficial de Meta) y en un chat web para probarlo sin WhatsApp.

> **EN:** AI WhatsApp assistant for appointment booking. Answers from the business's own document, checks real availability, books 30-min slots (Google Sheets or JSON), and hands off to a human. Node.js + TypeScript, Gemini API with function calling, WhatsApp Cloud API with signed webhooks.

## Qué hace

| Situación | Respuesta del bot |
|---|---|
| "¿Cuánto cuesta una limpieza?" | Precio del documento del negocio. Si no está, lo dice y ofrece recepción |
| "Quiero una cita mañana en la tarde" | Consulta horarios libres, ofrece 2–3 opciones, pide nombre y reserva |
| Dos pacientes eligen la misma hora | El segundo recibe "ya no está libre" y nuevas opciones |
| "Me duele mucho una muela" | Recomienda venir lo antes posible y avisa a recepción |
| "Quiero hablar con una persona" | Avisa a recepción por WhatsApp y deja de responder solo |

## Cómo está hecho

```
WhatsApp ──webhook firmado──▶ server.ts ──▶ bot.ts (Gemini + 3 herramientas) ──▶ agenda.ts (Google Sheets / JSON)
Chat web ──/api/chat──────────▶     │                                    └──▶ derivar a recepción (WhatsApp)
                                    └──▶ whatsapp.ts (envía la respuesta)
```

- `src/bot.ts` — conversación por paciente (30 min sin mensajes = conversación nueva), mensajes seguidos procesados en orden, herramientas `consultar_horarios`, `agendar_cita`, `derivar_a_recepcion` con esquemas JSON.
- `src/agenda.ts` — bloques de 30 min según el horario del negocio, zona horaria de Lima, sin horarios pasados ni repetidos.
- `src/whatsapp.ts` — valida la firma `X-Hub-Signature-256` de Meta, ignora reintentos y estados de entrega.
- `src/server.ts` — límite de 40 mensajes por hora e IP en la demo web, logs en JSON.
- `data/clinica.md` — **todo lo que el bot sabe del negocio.** Para otro cliente se cambia este archivo y el horario de `agenda.ts`.

## Probarlo en tu computadora

Requisitos: Node.js 22 o superior y una API key de Gemini (gratis en aistudio.google.com).

```bash
npm install
cp .env.example .env      # en Windows: copy .env.example .env
# completa GEMINI_API_KEY en .env
npm run dev
```

Abre http://localhost:3000 y escribe en el chat. Las citas se guardan en `data/citas.json`.

## Conectar WhatsApp (número de prueba gratis de Meta)

1. En [developers.facebook.com](https://developers.facebook.com) crea una app de tipo **Business** y agrega el producto **WhatsApp**.
2. En **WhatsApp → Configuración de la API** copia el **token temporal** y el **ID del número de teléfono** de prueba. Agrega tu celular como destinatario permitido.
3. En **Configuración de la app → Básica** copia la **clave secreta de la app**.
4. Completa en `.env`: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` y un `WHATSAPP_VERIFY_TOKEN` inventado.
5. El webhook necesita una URL pública: despliega el bot (abajo) o usa un túnel (`npx cloudflared tunnel --url http://localhost:3000`).
6. En **WhatsApp → Configuración → Webhook**: URL `https://TU-DOMINIO/webhook`, el mismo verify token, y suscríbete al campo **messages**.
7. Escribe desde tu celular al número de prueba.

El token temporal dura 24 horas. Para producción se crea un **usuario del sistema** con token permanente en el Business Manager del cliente.

## Guardar las citas en Google Sheets (opcional)

1. En Google Cloud crea una **cuenta de servicio**, activa la **Google Sheets API** y descarga su clave JSON como `credenciales-google.json` en la raíz.
2. Crea una hoja con una pestaña **Citas** y estos encabezados en la fila 1: `id, fecha, hora, nombre, telefono, tratamiento, creada`.
3. Comparte la hoja con el email de la cuenta de servicio (permiso de editor).
4. En `.env`: `GOOGLE_SHEET_ID` (está en la URL de la hoja) y `GOOGLE_APPLICATION_CREDENTIALS=./credenciales-google.json`.

## Desplegar (Render, plan gratuito)

1. Sube el proyecto a GitHub (el `.gitignore` ya excluye `.env` y las credenciales).
2. En [render.com](https://render.com): **New → Web Service**, conecta el repo. Build: `npm install`. Start: `npm start`.
3. Carga las variables de `.env` en **Environment**. En el plan gratuito, el servicio se duerme tras 15 min sin uso: el primer mensaje tarda unos segundos.

## Costos para un negocio real

- **IA:** depende del modelo (`GEMINI_MODEL`). Con `gemini-3.5-flash-lite` (por defecto) una conversación de agenda cuesta fracciones de centavo; `gemini-3.8-flash` responde con más cuidado y cuesta más, pero en la capa gratuita suele estar saturado (error 503). La capa gratuita alcanza para la demo. Gemini reutiliza en caché el contexto repetido para abaratar cada mensaje.
- **WhatsApp:** Meta cobra por mensaje según el país y el tipo (los recordatorios son plantillas pagadas). Revisar la tabla oficial de Meta antes de cotizar.
- **Servidor:** Render o Railway desde US$ 0–7 al mes.

## Límites conocidos (demo)

- Las conversaciones viven en memoria: se reinician si el servidor se reinicia.
- Dos reservas exactamente simultáneas al mismo horario podrían pasar; en producción se usa una base de datos con restricción única.
- Solo mensajes de texto (no audios ni imágenes).
