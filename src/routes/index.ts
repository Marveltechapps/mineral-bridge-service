import { Router } from 'express';
import { sampleRouter } from '../modules/sample/sample.routes.js';

export const apiRouter = Router();
apiRouter.use('/samples', sampleRouter);
