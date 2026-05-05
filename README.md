# 🤖 Chatbot WhatsApp + Bsale

Chatbot para WhatsApp Business con integración a Bsale (precios, stock, productos) y respuestas inteligentes via **Google Gemini AI (gratis)**.

---

## ✅ Funcionalidades

- 💬 Responde mensajes de WhatsApp automáticamente con IA
- 🛍️ Consulta precios y stock en tiempo real desde Bsale
- 📦 Toma y gestiona pedidos
- 🔍 Seguimiento de pedidos por número
- 📊 Panel de administración con API REST
- 💾 Base de datos local SQLite (sin costo)
- 🔔 Notifica al cliente cuando cambia el estado de su pedido

---

## 🚀 Instalación paso a paso

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Edita el archivo `.env` con tus credenciales:

| Variable | Dónde obtenerla |
|---|---|
| `WHATSAPP_TOKEN` | [Meta for Developers](https://developers.facebook.com) → Tu App → WhatsApp → API Setup |
| `WHATSAPP_PHONE_ID` | Mismo lugar, "Phone Number ID" |
| `WEBHOOK_VERIFY_TOKEN` | Invéntalo tú: cualquier texto secreto (ej: `mi_tienda_2024`) |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/app/apikey) — ¡Gratis! |
| `BSALE_TOKEN` | Bsale → Configuración → API → Generar token |
| `ADMIN_KEY` | Inventalo tú para proteger el panel admin |

### 3. Iniciar el servidor

```bash
# Desarrollo (reinicio automático)
npm run dev

# Producción
npm start
```

---

## 🌐 Configurar Webhook en Meta

Para que WhatsApp envíe mensajes a tu servidor, necesitas una URL pública.

### Opción A: ngrok (para pruebas locales)

```bash
# Instalar ngrok desde https://ngrok.com
ngrok http 3000
```
Copia la URL que te da (ej: `https://abc123.ngrok.io`)

### Opción B: Railway (gratis, para producción)

1. Ve a [railway.app](https://railway.app)
2. "New Project" → "Deploy from GitHub"
3. Sube este proyecto a GitHub y conéctalo
4. Agrega las variables de entorno en Railway
5. Te dará una URL del tipo `https://tu-app.railway.app`

### Configurar en Meta for Developers

1. Ve a tu app en [developers.facebook.com](https://developers.facebook.com)
2. WhatsApp → Configuration → Webhook
3. Callback URL: `https://TU-URL/webhook`
4. Verify token: el mismo que pusiste en `WEBHOOK_VERIFY_TOKEN`
5. Subscribir a: `messages`

---

## 📊 Panel de Administración

### Ver estadísticas
```
GET /admin/stats
```

### Ver todos los pedidos
```
GET /admin/pedidos
GET /admin/pedidos?estado=pendiente
```

### Actualizar estado de pedido
```
PATCH /admin/pedidos/:id/estado
Body: { "estado": "confirmado" }
```
Estados válidos: `pendiente` → `confirmado` → `preparando` → `listo` → `entregado` / `cancelado`

> Al actualizar el estado, el bot notifica automáticamente al cliente por WhatsApp.

### Ver conversaciones de un cliente
```
GET /admin/conversaciones/56912345678
```

---

## 💬 Flujo de conversación

```
Cliente escribe → WhatsApp API → Tu servidor (webhook)
                                      ↓
                              Detecta intención
                              ┌─────────────────┐
                              │ ¿Busca producto? │ → Consulta Bsale → Precio + Stock
                              │ ¿Hace pedido?    │ → Crea pedido en DB
                              │ ¿Ve pedido?      │ → Busca en DB
                              │ ¿Otra consulta?  │ → Solo Gemini AI
                              └─────────────────┘
                                      ↓
                              Gemini AI genera respuesta
                                      ↓
                              WhatsApp API → Cliente
```

---

## 📁 Estructura del proyecto

```
chatbot-wsp/
├── src/
│   ├── index.js                  # Servidor Express
│   ├── config/
│   │   └── database.js           # SQLite (pedidos, conversaciones)
│   ├── routes/
│   │   ├── webhook.js            # Recibe mensajes de WhatsApp
│   │   └── admin.js              # Panel de administración
│   └── services/
│       ├── whatsappService.js    # Envía mensajes via Meta API
│       ├── bsaleService.js       # Precios y stock desde Bsale
│       ├── geminiService.js      # IA gratuita con Google Gemini
│       ├── pedidosService.js     # Gestión de pedidos
│       └── chatbotController.js  # Cerebro: une todo
├── data/                         # Base de datos SQLite (auto-creada)
├── .env.example
├── package.json
└── README.md
```

---

## 🆓 Límites del plan gratuito de Gemini

- **Gemini 1.5 Flash**: 15 requests/minuto, 1 millón tokens/día
- Más que suficiente para una tienda pequeña-mediana
- Si lo necesitas, puedes actualizar a Gemini Pro por ~$0.075/1M tokens

---

## 🐛 Troubleshooting

**El webhook no verifica:**
- Revisa que `WEBHOOK_VERIFY_TOKEN` sea exactamente igual en `.env` y en Meta

**Bsale no devuelve productos:**
- Verifica que `BSALE_TOKEN` sea correcto y tenga permisos de lectura
- Prueba la URL: `https://api.bsale.io/v1/products.json` con el token en header

**Gemini no responde:**
- Verifica `GEMINI_API_KEY` en aistudio.google.com
- El modelo `gemini-1.5-flash` es el gratuito; no cambiar a `gemini-1.5-pro` sin billing
