import { Router } from 'express';
import { forbidden, notFound } from '../../common/errors/app-error.js';
import { FileObject } from '../../models/platform.models.js';
import { openStoredFile, verifyFileSignature } from './storage.service.js';

/** Public signed-URL download target (the signature IS the credential; 5 min TTL). */
export const storageRouter = Router();

storageRouter.get('/storage/files/:fileId', async (req, res, next) => {
  try {
    const fileId = String(req.params.fileId);
    const exp = Number(req.query.exp);
    const disp = req.query.disp === 'attachment' ? 'attachment' : 'inline';
    if (!verifyFileSignature(fileId, exp, disp, String(req.query.sig ?? ''))) {
      throw forbidden('auth/forbidden', 'This link is invalid or has expired');
    }
    const file = await FileObject.findOne({ fileId }).lean();
    if (!file) throw notFound('resource/not-found', 'File not found');
    const stream = openStoredFile(file.storageKey);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `${disp}; filename="${encodeURIComponent(file.name)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.on('error', next);
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});
