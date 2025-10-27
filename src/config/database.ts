// src/config/database.ts
import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient;

export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      // Desactivar el logging de queries para evitar confusión
      log: process.env.NODE_ENV === 'development' 
        ? ['error', 'warn'] // Solo errores y warnings, no queries
        : ['error'],
    });
  }
  return prisma;
}

export async function disconnectDatabase(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
  }
}