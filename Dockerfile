# ---- Base de build ----
FROM node:20-bookworm-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Dependencias nativas para compilar deps (bcrypt, prisma engines, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ openssl ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# Mejor cache: solo manifests + prisma primero
COPY package*.json ./
COPY prisma ./prisma

# Instala TODAS las deps (dev + prod) para compilar y generar cliente
RUN npm ci

# Copia resto del código
COPY . .

# Genera Prisma y compila TypeScript
RUN npx prisma generate || true
RUN npm run build

# ---- Runtime final ----
FROM node:20-bookworm-slim AS runner
ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
ENV TZ=America/Lima

WORKDIR /app

# OpenSSL (Prisma) + certificados
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copiamos solo lo necesario
COPY --from=builder /app/package*.json ./
# Instala SOLO prod deps en runtime para achicar la imagen
RUN npm ci --omit=dev

# Copia artefactos de build y prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Vistas EJS si tu build no las empaqueta
COPY --from=builder /app/src/web/views ./dist/web/views

# Directorios de datos
RUN mkdir -p /app/logs /app/baileys_auth \
 && chown -R node:node /app

# (Opcional) setear TZ del sistema
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Seguridad: ejecutar como usuario no root
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
