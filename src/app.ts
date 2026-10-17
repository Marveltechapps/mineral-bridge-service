import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { createAdminRouter } from './app-clients/admin/routes.js';
import { badRequest, AppError } from './common/errors/app-error.js';
import { errorHandler, notFoundHandler } from './common/middleware/error-handler.js';
import { requestContext } from './common/middleware/request-context.js';
import { buildCorsOptions } from './config/cors.js';
import { isDatabaseReady } from './config/database.js';
import { loadEnv } from './config/env.js';
import { helmetOptions } from './config/security.js';
import { setUnreadNotificationCounter } from './modules/auth/index.js';
import { notificationsRepository } from './modules/notifications/notifications.repository.js';
import { storageRouter } from './modules/storage/storage.routes.js';
import { buildV1Router } from './routes/v1.js';

setUnreadNotificationCounter((userId) => notificationsRepository.countUnread(userId));

function loadOpenApi(): Record<string, unknown> | null {
  const file = path.resolve(process.cwd(), 'openapi', 'openapi.yaml');
  if (!existsSync(file)) return null;
  return YAML.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** Turns body-parser failures (bad JSON, oversized payloads) into the standard error envelope. */
const bodyErrors: ErrorRequestHandler = (err, _req, _res, next) => {
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.parse.failed') return next(badRequest('request/malformed', 'Request body is not valid JSON'));
  if (e?.type === 'entity.too.large') return next(new AppError({ status: 413, code: 'request/too-large', message: 'Request body is too large' }));
  return next(err);
};

export function createApp(): Express {
  const env = loadEnv();
  const app = express();
  app.disable('x-powered-by');
  if (env.NODE_ENV === 'production') app.set('trust proxy', 1);

  app.use(helmet(helmetOptions));
  app.use(cors(buildCorsOptions()));
  app.use(requestContext);
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.RATE_LIMIT_MAX,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: (req) => env.NODE_ENV === 'test' || req.path === '/health' || req.path === '/ready',
      validate: false,
      handler: (_req, res) => {
        res.setHeader('Retry-After', String(Math.ceil(env.RATE_LIMIT_WINDOW_MS / 1000)));
        res.status(429).json({ code: 'rate-limited', message: 'Too many requests. Slow down and retry shortly.' });
      },
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });
  app.get('/ready', (_req, res) => {
    const ready = isDatabaseReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks: { mongo: ready ? 'up' : 'down' } });
  });

  const openapi = loadOpenApi();
  const publishDocs = env.NODE_ENV !== 'production' || env.ENABLE_API_DOCS;
  if (openapi && publishDocs) app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'Mineral Bridge API' }));

  app.use(storageRouter);
  app.use('/v1', buildV1Router());
  app.use('/admin/v1', createAdminRouter());

  app.use(notFoundHandler);
  app.use(bodyErrors);
  app.use(errorHandler);
  return app;
}
