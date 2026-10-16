import http from 'node:http';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { loadEnv } from './config/env.js';
import { logger } from './config/logger.js';
import { startAuctionScheduler } from './modules/admin/auctions/auctions.service.js';
import { attachWebSocketServer } from './realtime/ws-server.js';

async function main(): Promise<void> {
  const env = loadEnv();
  await connectDatabase();

  const app = createApp();
  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000; // behind a load balancer with a 60 s idle timeout
  const wss = attachWebSocketServer(server);
  const stopScheduler = startAuctionScheduler();

  await new Promise<void>((resolve) => server.listen(env.PORT, env.HOST, resolve));
  logger.info({ port: env.PORT, host: env.HOST, env: env.NODE_ENV }, 'Mineral Bridge API listening');

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 15_000);
    force.unref();
    try {
      stopScheduler();
      for (const client of wss.clients) client.close(1001, 'server shutting down');
      wss.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();
      // Long-lived SSE streams would otherwise hold the server open: give in-flight requests 5 s, then cut.
      setTimeout(() => server.closeAllConnections?.(), 5_000).unref();
      await closed;
      await disconnectDatabase();
      clearTimeout(force);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
