#!/usr/bin/env sh
set -e

echo "Waiting for database to be ready..."
# esta espera ya la maneja depends_on, pero mantener un pequeño sleep evita carreras
sleep 2

echo "Running prisma migrate deploy..."
npx prisma migrate deploy

echo "Starting app..."
node dist/index.js
