# Dockerfile
FROM node:20-alpine AS builder

# Instalar dependencias del sistema
RUN apk add --no-cache \
    libc6-compat \
    openssl \
    postgresql-client

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./
COPY prisma ./prisma/

# Instalar TODAS las dependencias (incluidas dev) para poder compilar
RUN npm ci && \
    npm cache clean --force

# Generar cliente de Prisma
RUN npx prisma generate

# Copiar código fuente
COPY . .

# Compilar TypeScript
RUN npm run build

# ===== Etapa de producción =====
FROM node:20-alpine AS production

# Instalar dependencias del sistema
RUN apk add --no-cache \
    libc6-compat \
    openssl \
    postgresql-client

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./
COPY prisma ./prisma/

# Instalar SOLO dependencias de producción
RUN npm ci --only=production && \
    npm cache clean --force

# Generar cliente de Prisma
RUN npx prisma generate

# Copiar el código compilado desde builder
COPY --from=builder /app/dist ./dist

# Copiar otros archivos necesarios
COPY --from=builder /app/src/web/views ./src/web/views

# Crear usuario no-root
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodejs

# Cambiar permisos
RUN chown -R nodejs:nodejs /app

# Crear directorio para sesiones de WhatsApp
RUN mkdir -p /app/baileys_auth && \
    chown -R nodejs:nodejs /app/baileys_auth

# Copiar script de inicio
COPY docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh && \
    chown nodejs:nodejs /app/docker-entrypoint.sh

USER nodejs

# Exponer puerto
EXPOSE 3000

# Variables de entorno por defecto
ENV NODE_ENV=production \
    WEB_PORT=3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "start"]