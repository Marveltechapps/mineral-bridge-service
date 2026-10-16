import { Router } from 'express';
import { z } from 'zod';
import { currentUserId } from '../../common/http/actor.js';
import { ah } from '../../common/http/async-handler.js';
import { validate } from '../../common/middleware/validate.js';
import { iso } from '../../common/utils/time-display.js';
import type { IAsmRegistration } from '../../models/web-trade.model.js';
import { requireUser } from '../auth/auth.middleware.js';
import { asmService as svc, evaluateEligibility, missingForSubmit } from './asm.service.js';

const answers = z.object({
  answers: z.array(z.object({ index: z.number().int().min(0).max(20), answer: z.boolean() })).min(1).max(20),
});
const idParam = z.object({ registrationId: z.string().min(1) });
const siteBody = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  country: z.string().length(2).optional(),
  region: z.string().max(100).optional(),
  minerals: z.array(z.string().max(20)).max(10).optional(),
  workerCount: z.number().int().min(0).max(100000).optional(),
});
const gpsBody = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMetres: z.number().min(0).max(100000).optional(),
});
const docBody = z.object({ key: z.enum(['id', 'licence', 'photos']), fileId: z.string().min(1) });

const toWebAsm = (r: IAsmRegistration) => ({
  id: r._id,
  reference: r.reference ?? null,
  status: r.status,
  step: r.step,
  eligibilityMet: r.eligibilityMet,
  site: r.site,
  gps: r.gps ? { latitude: r.gps.latitude, longitude: r.gps.longitude, accuracyMetres: r.gps.accuracyMetres ?? null, capturedAt: iso(r.gps.capturedAt) } : null,
  gpsRegion: r.gpsRegion ?? null,
  documents: r.documents.map((d) => ({ key: d.key, status: d.status, fileCount: d.fileIds.length, rejectionReason: d.rejectionReason ?? null })),
  missing: r.status === 'draft' ? missingForSubmit(r) : [],
  submittedAt: iso(r.submittedAt),
  visitScheduledFor: iso(r.visitScheduledFor),
  version: r.version,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

/** Web `/asm/*` (artisanal & small-scale miner onboarding). */
export function webAsmRouter(): Router {
  const r = Router();
  const id = validate({ params: idParam });

  r.get('/asm/eligibility', requireUser, ah(async (_req, res) => {
    res.json({ questions: svc.eligibilityQuestions(), rule: 'All required questions must be answered yes; at most one optional question may be no.' });
  }));
  // Contract: GET /asm/eligibility-criteria
  r.get('/asm/eligibility-criteria', ah(async (_req, res) => {
    res.json({ items: svc.eligibilityQuestions(), rule: 'All required questions must be answered yes; at most one optional question may be no.' });
  }));
  r.post('/asm/eligibility', requireUser, validate({ body: answers }), ah(async (req, res) => {
    const ev = evaluateEligibility(req.body.answers);
    res.json({ eligible: ev.met, failedQuestions: ev.failed });
  }));

  r.post('/asm/registrations', requireUser, validate({ body: answers }), ah(async (req, res) => {
    res.status(201).json(toWebAsm(await svc.create(currentUserId(req), req.body.answers)));
  }));
  r.get('/asm/registrations', requireUser, ah(async (req, res) => {
    res.json({ items: (await svc.list(currentUserId(req))).map(toWebAsm) });
  }));
  r.get('/asm/registrations/:registrationId', requireUser, id, ah(async (req, res) => {
    res.json(toWebAsm(await svc.get(currentUserId(req), String(req.params.registrationId))));
  }));
  r.patch('/asm/registrations/:registrationId', requireUser, id, validate({ body: siteBody }), ah(async (req, res) => {
    res.json(toWebAsm(await svc.patchSite(currentUserId(req), String(req.params.registrationId), req.body)));
  }));
  r.delete('/asm/registrations/:registrationId', requireUser, id, ah(async (req, res) => {
    await svc.remove(currentUserId(req), String(req.params.registrationId));
    res.status(204).end();
  }));
  r.put('/asm/registrations/:registrationId/gps', requireUser, id, validate({ body: gpsBody }), ah(async (req, res) => {
    res.json(toWebAsm(await svc.setGps(currentUserId(req), String(req.params.registrationId), req.body)));
  }));
  // Contract: POST /asm/registrations/{registrationId}/gps
  r.post('/asm/registrations/:registrationId/gps', requireUser, id, validate({ body: gpsBody }), ah(async (req, res) => {
    res.json(toWebAsm(await svc.setGps(currentUserId(req), String(req.params.registrationId), req.body)));
  }));
  r.post('/asm/registrations/:registrationId/documents', requireUser, id, validate({ body: docBody }), ah(async (req, res) => {
    res.status(201).json(toWebAsm(await svc.addDocument(currentUserId(req), String(req.params.registrationId), req.body.key, req.body.fileId)));
  }));
  r.post('/asm/registrations/:registrationId/submit', requireUser, id, ah(async (req, res) => {
    res.json(toWebAsm(await svc.submit(currentUserId(req), String(req.params.registrationId))));
  }));

  return r;
}
