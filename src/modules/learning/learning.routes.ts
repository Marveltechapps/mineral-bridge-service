import { Router } from 'express';
import { currentUserId, getUserActor } from '../../common/http/actor.js';
import { ah } from '../../common/http/async-handler.js';
import { validate } from '../../common/middleware/validate.js';
import { iso } from '../../common/utils/time-display.js';
import type { ICertificate, ILesson, ILessonProgress } from '../../models/learning.model.js';
import { optionalUser, requireUser } from '../auth/auth.middleware.js';
import { learningService as svc } from './learning.service.js';
import type { CourseWithProgress } from './learning.service.js';
import * as v from './learning.validation.js';

const viewer = (req: Parameters<typeof getUserActor>[0]) => getUserActor(req)?.userId;

const lessonView = (l: ILesson, p?: ILessonProgress | null) => ({
  id: l._id,
  title: l.title,
  summary: l.summary ?? null,
  kind: l.kind,
  durationSec: l.durationSec,
  sectionId: l.sectionId ?? null,
  progress: { percent: p?.percent ?? 0, positionSec: p?.positionSec ?? 0, completed: Boolean(p?.completedAt), completedAt: iso(p?.completedAt) },
});

const lessonDetail = (l: ILesson, p?: ILessonProgress | null) => ({ ...lessonView(l, p), mediaUrl: l.mediaUrl ?? null, content: l.content ?? null });

const certView = (c: ICertificate, title: string) => ({ id: c._id, serial: c.serial, courseId: c.courseId, courseTitle: title, issuedAt: iso(c.issuedAt), verifyUrl: `/v1/academy/certificates/${c.serial}` });

const mobileTrack = (c: CourseWithProgress) => ({
  id: c.course._id,
  slug: c.course.slug,
  title: c.course.title,
  summary: c.course.summary ?? null,
  level: c.course.level,
  gradient: c.course.gradientFrom ? { from: c.course.gradientFrom, to: c.course.gradientTo ?? c.course.gradientFrom } : null,
  lessonCount: c.lessonCount,
  durationSec: c.durationSec,
  progress: { completed: c.completedCount, total: c.lessonCount, percent: c.percent },
});

const webCourse = (c: CourseWithProgress) => ({
  id: c.course._id,
  slug: c.course.slug,
  title: c.course.title,
  summary: c.course.summary ?? null,
  level: c.course.level,
  imageUrl: c.course.imageUrl ?? null,
  lessons: c.lessonCount,
  durationSec: c.durationSec,
  progress: { completedLessons: c.completedCount, totalLessons: c.lessonCount, percent: c.percent },
});

/** Mobile /learn/*. */
export function mobileLearnRouter(): Router {
  const r = Router();
  r.get('/learn/tracks', optionalUser, ah(async (req, res) => res.json({ data: (await svc.courses(viewer(req))).map(mobileTrack) })));

  r.get('/learn/tracks/:trackId', optionalUser, validate({ params: v.trackParam }), ah(async (req, res) => {
    const { course, lessons, progress } = await svc.course(String(req.params.trackId), viewer(req));
    const done = lessons.filter((l) => progress.get(l._id)?.completedAt).length;
    res.json({
      id: course._id,
      title: course.title,
      summary: course.summary ?? null,
      level: course.level,
      progress: { completed: done, total: lessons.length, percent: lessons.length ? Math.round((done / lessons.length) * 100) : 0 },
      sections: [...course.sections].sort((a, b) => a.sort - b.sort).map((s) => ({ id: s._id, title: s.title, lessons: lessons.filter((l) => l.sectionId === s._id).map((l) => lessonView(l, progress.get(l._id))) })),
      unsectioned: lessons.filter((l) => !l.sectionId).map((l) => lessonView(l, progress.get(l._id))),
    });
  }));

  r.get('/learn/tracks/:trackId/sections', optionalUser, validate({ params: v.trackParam }), ah(async (req, res) => {
    const { course, lessons, progress } = await svc.course(String(req.params.trackId), viewer(req));
    res.json({ data: [...course.sections].sort((a, b) => a.sort - b.sort).map((s) => ({ id: s._id, title: s.title, lessons: lessons.filter((l) => l.sectionId === s._id).map((l) => lessonView(l, progress.get(l._id))) })) });
  }));

  // Contract path: GET /learn/sections/{sectionId}
  r.get('/learn/sections/:sectionId', optionalUser, validate({ params: v.sectionParam }), ah(async (req, res) => {
    const sectionId = String(req.params.sectionId);
    const { course, lessons, progress } = await svc.section(sectionId, viewer(req));
    const section = course.sections.find((s) => s._id === sectionId);
    res.json({
      id: sectionId,
      title: section?.title ?? 'Section',
      trackId: course._id,
      lessons: lessons.filter((l) => l.sectionId === sectionId).map((l) => lessonView(l, progress.get(l._id))),
    });
  }));

  r.get('/learn/lessons/:lessonId', optionalUser, validate({ params: v.lessonParam }), ah(async (req, res) => {
    const { lesson, progress } = await svc.lesson(String(req.params.lessonId), viewer(req));
    res.json(lessonDetail(lesson, progress));
  }));

  r.get('/learn/progress', requireUser, ah(async (req, res) => res.json(await svc.overview(currentUserId(req)))));

  r.put('/learn/lessons/:lessonId/progress', requireUser, validate({ params: v.lessonParam, body: v.progressBody }), ah(async (req, res) => {
    const p = await svc.saveProgress(currentUserId(req), String(req.params.lessonId), req.body);
    res.json({ percent: p.percent, positionSec: p.positionSec, completed: Boolean(p.completedAt) });
  }));

  r.post('/learn/lessons/:lessonId/complete', requireUser, validate({ params: v.lessonParam }), ah(async (req, res) => {
    const out = await svc.complete(currentUserId(req), String(req.params.lessonId));
    res.json({ completed: true, percent: out.progress.percent, trackComplete: out.courseComplete, certificateSerial: out.certificate?.serial ?? null });
  }));

  return r;
}

/** Web /academy/*. */
export function webAcademyRouter(): Router {
  const r = Router();
  r.get('/academy/courses', optionalUser, ah(async (req, res) => res.json({ items: (await svc.courses(viewer(req))).map(webCourse) })));

  r.get('/academy/courses/:courseId', optionalUser, validate({ params: v.courseParam }), ah(async (req, res) => {
    const { course, lessons, progress } = await svc.course(String(req.params.courseId), viewer(req));
    const done = lessons.filter((l) => progress.get(l._id)?.completedAt).length;
    res.json({
      id: course._id,
      title: course.title,
      summary: course.summary ?? null,
      level: course.level,
      progress: { completedLessons: done, totalLessons: lessons.length, percent: lessons.length ? Math.round((done / lessons.length) * 100) : 0 },
      lessons: lessons.map((l) => lessonView(l, progress.get(l._id))),
    });
  }));

  // Contract: GET /academy/courses/{courseId}/lessons
  r.get('/academy/courses/:courseId/lessons', optionalUser, validate({ params: v.courseParam }), ah(async (req, res) => {
    const { lessons, progress } = await svc.course(String(req.params.courseId), viewer(req));
    res.json({ items: lessons.map((l) => lessonView(l, progress.get(l._id))) });
  }));

  r.get('/academy/lessons/:lessonId', optionalUser, validate({ params: v.lessonParam }), ah(async (req, res) => {
    const { lesson, progress } = await svc.lesson(String(req.params.lessonId), viewer(req));
    res.json(lessonDetail(lesson, progress));
  }));

  // Contract: GET /academy/lessons/{lessonId}/media
  r.get('/academy/lessons/:lessonId/media', requireUser, validate({ params: v.lessonParam }), ah(async (req, res) => {
    const { lesson, progress } = await svc.lesson(String(req.params.lessonId), viewer(req));
    res.json({
      mediaUrl: lesson.mediaUrl ?? null,
      contentType: lesson.kind === 'video' ? 'video/mp4' : 'application/json',
      positionSec: progress?.positionSec ?? 0,
      durationSec: lesson.durationSec,
      expiresIn: 900,
    });
  }));

  r.get('/academy/progress', requireUser, ah(async (req, res) => res.json(await svc.overview(currentUserId(req)))));

  r.put('/academy/lessons/:lessonId/progress', requireUser, validate({ params: v.lessonParam, body: v.progressBody }), ah(async (req, res) => {
    const p = await svc.saveProgress(currentUserId(req), String(req.params.lessonId), req.body);
    res.json({ percent: p.percent, positionSec: p.positionSec, completed: Boolean(p.completedAt) });
  }));
  // Contract: POST /academy/lessons/{lessonId}/progress
  r.post('/academy/lessons/:lessonId/progress', requireUser, validate({ params: v.lessonParam, body: v.progressBody }), ah(async (req, res) => {
    const p = await svc.saveProgress(currentUserId(req), String(req.params.lessonId), req.body);
    res.json({ percent: p.percent, positionSec: p.positionSec, completed: Boolean(p.completedAt) });
  }));

  r.post('/academy/lessons/:lessonId/complete', requireUser, validate({ params: v.lessonParam }), ah(async (req, res) => {
    const out = await svc.complete(currentUserId(req), String(req.params.lessonId));
    res.json({ completed: true, percent: out.progress.percent, courseComplete: out.courseComplete, certificate: out.certificate ? { serial: out.certificate.serial } : null });
  }));

  r.get('/academy/courses/:courseId/certificate', requireUser, validate({ params: v.courseParam }), ah(async (req, res) => {
    const { course, certificate } = await svc.certificate(currentUserId(req), String(req.params.courseId));
    res.json(certView(certificate, course.title));
  }));
  // Contract: POST /academy/courses/{courseId}/certificate
  r.post('/academy/courses/:courseId/certificate', requireUser, validate({ params: v.courseParam }), ah(async (req, res) => {
    const { course, certificate } = await svc.certificate(currentUserId(req), String(req.params.courseId));
    res.status(201).json(certView(certificate, course.title));
  }));

  // Contract: GET /academy/certificates
  r.get('/academy/certificates', requireUser, ah(async (req, res) => {
    const rows = await svc.certificatesFor(currentUserId(req));
    res.json({ items: rows.map((c) => certView(c.certificate, c.courseTitle)) });
  }));

  return r;
}
