import { Router } from 'express';
import { getSamples } from './sample.controller';

export const sampleRouter = Router();
sampleRouter.get('/', getSamples);
