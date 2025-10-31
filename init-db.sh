#!/bin/bash
set -e

# Este script se ejecuta automáticamente cuando PostgreSQL inicia por primera vez
echo "🔧 Inicializando base de datos..."

# Crear la base de datos si no existe
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "postgres" <<-EOSQL
    SELECT 'CREATE DATABASE ${POSTGRES_DB}'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${POSTGRES_DB}')\gexec
EOSQL

echo "✅ Base de datos ${POSTGRES_DB} lista!"