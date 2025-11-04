FROM node:20-bookworm-slim AS runner
ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
ENV TZ=America/Lima
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package*.json ./
# instala solo prod
RUN npm ci --omit=dev
# instala prisma CLI para poder generar (prod o global; elige UNA de estas líneas):
RUN npm install --no-save prisma@^5
# RUN npm install -g prisma@^5

# copia build y schema
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src/web/views ./dist/web/views

# ahora sí, genera el cliente
RUN npx prisma generate

RUN mkdir -p /app/logs /app/baileys_auth && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
