# 🤖 WhatsApp Gemini Bot

Bot inteligente de WhatsApp con Gemini AI para atención al cliente.

## 🚀 Características

- ✅ Registro automático de clientes (DNI/RUC vía RENIEC/SUNAT)
- ✅ Conversaciones naturales con Gemini AI
- ✅ Bloqueo de números y grupos
- ✅ Variables del sistema configurables
- ✅ Historial completo de conversaciones
- ✅ Compatible con Baileys v7 (LID support)

## 📋 Requisitos

- Node.js >= 18
- PostgreSQL >= 14
- Cuenta de Google (Gemini API Key)
- Número de WhatsApp

## 🛠️ Instalación

1. **Clonar repositorio**
```bash
git clone <tu-repo>
cd whatsapp-gemini-bot
```

2. **Instalar dependencias**
```bash
npm install
```

3. **Configurar variables de entorno**
```bash
cp .env.example .env
# Editar .env con tus credenciales
```

4. **Configurar base de datos**
```bash
npm run prisma:migrate
npm run prisma:generate
```

5. **Iniciar bot**
```bash
# Desarrollo
npm run dev

# Producción
npm run build
npm start
```

## 📱 Primer uso

1. Ejecutar `npm run dev`
2. Escanear QR code con WhatsApp
3. Esperar mensaje "Bot is running"
4. ¡Listo! El bot responderá automáticamente

## 🗄️ Variables del sistema


**Editar desde Prisma Studio:**
```bash
npm run prisma:studio
```

## 🔒 Bloquear números/grupos

**Desde Prisma Studio:**
1. `npm run prisma:studio`
2. Ir a tabla `blocked_numbers`
3. Crear registro con:
   - `identifier`: número (51975197717) o grupo JID
   - `type`: "PHONE" o "GROUP"
   - `reason`: motivo del bloqueo

**Grupos se bloquean automáticamente.**

## 📊 Base de datos

**4 tablas principales:**
- `contacts` - Usuarios registrados
- `blocked_numbers` - Números/grupos bloqueados
- `conversation_history` - Historial de chats
- `system_variables` - Variables configurables

## 🐛 Troubleshooting

**Error: "WhatsApp client not ready"**
- Verificar que QR fue escaneado correctamente
- Reiniciar bot: `Ctrl+C` y `npm run dev`

**Error: "Database connection failed"**
- Verificar PostgreSQL está corriendo
- Verificar `DATABASE_URL` en `.env`

**Bot no responde:**
- Verificar logs en consola
- Verificar número no esté bloqueado
- Verificar Gemini API Key válida

## 📝 Licencia

MIT

## 👤 Autor

Tu Nombre
```

docker compose --profile simple --env-file .env up -d --build 

---

## ✅ **PROYECTO COMPLETO - RESUMEN**

**Total archivos creados:** 17

### **Estructura final:**
```
whatsapp-gemini-bot/
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
├── prisma/
│   └── schema.prisma
└── src/
    ├── index.ts
    ├── config/
    │   ├── env.ts
    │   ├── database.ts
    │   └── gemini.ts
    ├── services/
    │   ├── whatsapp.ts
    │   ├── gemini.ts
    │   └── external.ts
    ├── models/
    │   ├── contact.ts
    │   ├── blocked.ts
    │   ├── conversation.ts
    │   └── systemVar.ts
    └── utils/
        ├── validators.ts
        ├── formatters.ts
        └── logger.ts