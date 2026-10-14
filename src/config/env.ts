import 'dotenv/config';
import { z } from 'zod';

export const env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173'),
}).parse(process.env);
