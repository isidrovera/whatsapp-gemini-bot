#!/usr/bin/env sh
set -e

echo "$(date '+%Y-%m-%d %H:%M:%S.%3N') | Waiting for database to be ready..."
# Espera simple a que Postgres responda (evita carreras)
until nc -z -v -w30 postgres 5432 >/dev/null 2>&1; do
  sleep 2
done

echo "$(date '+%Y-%m-%d %H:%M:%S.%3N') | Running prisma generate (safety)..."
# Por si la imagen cambió, no hace daño y es rápido
npx prisma generate >/dev/null || true

echo "$(date '+%Y-%m-%d %H:%M:%S.%3N') | Checking migrations folder..."
if [ -d "prisma/migrations" ] && [ "$(ls -A prisma/migrations 2>/dev/null | wc -l)" -gt 0 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S.%3N') | Found migrations. Running prisma migrate deploy..."
  npx prisma migrate deploy
else
  echo "$(date '+%Y-%m-%d %H:%M:%S.%3N') | No migration found in prisma/migrations"
  echo "$(date '+%Y-%m-%d %H:%M:%S.%3N') | Running prisma db push to create tables from schema.prisma..."
  # --accept-data-loss no se agrega por seguridad; si cambias tipos con datos ya creados, Prisma lo pedirá explícitamente.
  npx prisma db push
fi

echo "$(date '+%Y-%m-%d %H:%M:%S.%3N') | Starting app..."
node dist/index.js
