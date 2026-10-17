import dns from 'node:dns';
import mongoose from 'mongoose';
import { loadEnv } from './env.js';
import { logger } from './logger.js';

const PUBLIC_DNS = ['8.8.8.8', '1.1.1.1'];

/**
 * c-ares on Windows falls back to 127.0.0.1 when it cannot read the adapter DNS list.
 * Nothing answers there, so `mongodb+srv` fails with `querySrv ECONNREFUSED` even though
 * the OS resolver can see the Atlas SRV record.
 */
async function ensureSrvResolver(uri: string): Promise<void> {
  if (!uri.startsWith('mongodb+srv://')) return;
  const servers = dns.getServers();
  if (servers.length > 0 && !servers.every(isLoopbackResolver)) return;

  const host = mongodbSrvHostname(uri);
  dns.setServers(PUBLIC_DNS);
  logger.warn(
    { previous: servers, next: PUBLIC_DNS },
    'Node DNS is loopback and cannot answer MongoDB SRV lookups; using public resolvers',
  );
  if (host) await dns.promises.resolveSrv(`_mongodb._tcp.${host}`);
}

function isLoopbackResolver(server: string): boolean {
  const host = resolverHost(server).toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === '0:0:0:0:0:0:0:1';
}

function resolverHost(server: string): string {
  if (server.startsWith('[')) {
    const end = server.indexOf(']');
    return end > 1 ? server.slice(1, end) : server;
  }
  const colon = server.lastIndexOf(':');
  if (colon > 0 && server.indexOf(':') === colon && /^\d+$/.test(server.slice(colon + 1))) {
    return server.slice(0, colon);
  }
  return server;
}

function mongodbSrvHostname(uri: string): string | undefined {
  const rest = uri.slice('mongodb+srv://'.length);
  const at = rest.lastIndexOf('@');
  const authority = (at >= 0 ? rest.slice(at + 1) : rest).split(/[/?]/)[0] ?? '';
  const host = authority.replace(/:\d+$/, '').trim();
  return host || undefined;
}

export async function connectDatabase(uri?: string): Promise<typeof mongoose> {
  const env = loadEnv();
  const connectionUri = uri ?? env.MONGODB_URI;

  await ensureSrvResolver(connectionUri);

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
