import { Router } from 'express';
import { sampleRouter } from '../modules/sample/sample.routes';

export const apiRouter = Router();
apiRouter.use('/samples', sampleRouter);
