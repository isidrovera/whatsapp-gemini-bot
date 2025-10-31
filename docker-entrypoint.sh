#!/bin/sh
set -e

echo "🚀 Iniciando WhatsApp Gemini Bot..."

# Esperar a que PostgreSQL esté listo
echo "⏳ Esperando a que PostgreSQL esté disponible..."
until pg_isready -h postgres -U ${POSTGRES_USER:-postgres} > /dev/null 2>&1; do
  echo "⏳ PostgreSQL no está listo - esperando..."
  sleep 2
done

echo "✅ PostgreSQL está listo!"

# Ejecutar migraciones de Prisma
echo "🔄 Ejecutando migraciones de base de datos..."
npx prisma migrate deploy

echo "✅ Migraciones completadas!"

# Ejecutar comando
exec "$@"