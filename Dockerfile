# ===== BUILDER =====
FROM node:20-alpine AS builder

WORKDIR /app
ENV CI=true

# Herramientas nativas si alguna lib C lo requiere
RUN apk add --no-cache python3 make g++ git

# Instala TODAS las deps (incluyendo dev) para poder compilar TS y generar Prisma
COPY package*.json ./
RUN npm ci

# Copia código y prisma
COPY tsconfig.json ./tsconfig.json
COPY prisma ./prisma
COPY src ./src

# Genera Prisma Client y compila TS
RUN npx prisma generate
RUN npm run build

# Deja solo dependencias de producción (y conserva el Prisma Client generado)
RUN npm prune --omit=dev

# ===== RUNNER =====
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copia node_modules YA PRUNED + Prisma Client desde el builder
COPY --from=builder /app/node_modules ./node_modules

# Copia Prisma schema (para migrate deploy en runtime) y el build
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist

# Storage (Baileys, adjuntos, etc.)
RUN mkdir -p /app/storage/baileys

# Entrypoint: aplica migraciones y arranca
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
