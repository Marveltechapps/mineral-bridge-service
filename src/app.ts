import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { apiRouter } from './routes';
import { errorHandler, notFoundHandler } from './modules/error';
import { env } from './config/env';

export const app = express();
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGINS.split(',').map(origin => origin.trim()) }));
app.use(express.json());
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mineral-bridge-service' });
});
app.use('/api', apiRouter);
app.use(notFoundHandler);
app.use(errorHandler);
