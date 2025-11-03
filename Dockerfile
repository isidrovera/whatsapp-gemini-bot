# ---- Base de build ----
FROM node:20-bookworm-slim AS builder

# Evita prompts
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Dependencias nativas (para paquetes que compilan, p.ej. bcrypt)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ openssl ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# Copiar manifests primero (para mejor cache)
COPY package*.json ./
# Si usas prisma, copia también su esquema para prisma generate
COPY prisma ./prisma

# Instalar deps (production + dev, para compilar TypeScript)
RUN npm ci

# Copiar el resto del código
COPY . .

# Generar Prisma si aplica
RUN npx prisma generate || true

# Compilar TypeScript
RUN npm run build

# ---- Runtime final ----
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copiamos únicamente lo necesario
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public
COPY --from=builder /app/src/web/views ./dist/web/views

# Directorios de datos
RUN mkdir -p /app/logs /app/baileys_auth

# Puerto del panel web
EXPOSE 3000

# Comando de arranque
CMD ["node", "dist/index.js"]
