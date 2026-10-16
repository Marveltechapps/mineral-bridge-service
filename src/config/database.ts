import mongoose from 'mongoose';
import { loadEnv } from './env.js';
import { logger } from './logger.js';

export async function connectDatabase(uri?: string): Promise<typeof mongoose> {
  const env = loadEnv();
  const connectionUri = uri ?? env.MONGODB_URI;

  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () => {
    logger.info('MongoDB connected');
  });
  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'MongoDB connection error');
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });

  await mongoose.connect(connectionUri, {
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 10_000,
  });

  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export function isDatabaseReady(): boolean {
  return mongoose.connection.readyState === 1;
}
