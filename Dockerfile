# ---- Stage de build ----
FROM node:20-bookworm-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Dependencias nativas para compilar deps (bcrypt, prisma engines, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ openssl ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# Mejor cache: manifests + prisma primero
COPY package*.json ./
COPY prisma ./prisma

# Instala TODAS las deps para compilar y generar cliente Prisma
RUN npm ci

# Copia el resto del código
COPY . .

# Genera Prisma y compila TypeScript
RUN npx prisma generate
RUN npm run build

# ---- Stage de runtime ----
FROM node:20-bookworm-slim AS runner
ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
ENV TZ=America/Lima
WORKDIR /app

# OpenSSL / certs para Prisma
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# package.json + lock para instalar SOLO prod
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev

# Copia artefactos de build y schema
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
# Vistas EJS si no se empaquetan en build
COPY --from=builder /app/src/web/views ./dist/web/views

# Copia los artefactos del cliente Prisma ya generado en builder
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Directorios de datos
RUN mkdir -p /app/logs /app/baileys_auth && chown -R node:node /app

# Ajuste de zona horaria del sistema (opcional)
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
