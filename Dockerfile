# ---- Base de build ----
FROM node:20-bookworm-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Dependencias nativas (bcrypt, prisma, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ openssl ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# Archivos para mejor cache
COPY package*.json ./
COPY prisma ./prisma

# Instala deps (dev + prod para compilar TS)
RUN npm ci

# Copiar el resto del código
COPY . .

# Prisma y build
RUN npx prisma generate || true
RUN npm run build

# ---- Runtime final ----
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# OpenSSL en runtime (evita el fallback a 1.1.x)
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copiamos solo lo necesario
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Vistas EJS (si no se transpilan)
COPY --from=builder /app/src/web/views ./dist/web/views

# Favicon opcional si lo tienes en raíz
# COPY ./favicon.ico ./favicon.ico

# Directorios de datos
RUN mkdir -p /app/logs /app/baileys_auth

EXPOSE 3000
CMD ["node", "dist/index.js"]
