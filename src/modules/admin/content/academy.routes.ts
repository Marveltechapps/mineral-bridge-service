import { z } from 'zod';
import { AppError, conflict, notFound, unprocessable } from '../../../common/errors/app-error.js';
import { nextId } from '../../../common/db/sequence.js';
import { withTx } from '../../../common/db/transaction.js';
import { Course, CourseCategory, Enrolment, Lesson } from '../../../models/content.models.js';
import { recordAudit } from '../../audit/audit.service.js';
import { MS_DAY } from '../shared/enums.js';
import { action, escapeRegex } from '../shared/http.js';
import { loadFileRefs } from '../shared/files.js';
import { route, type AdminRouteDef } from '../shared/route-kit.js';
import { auditActor } from '../shared/staff-context.js';
import { User } from '../../../models/people.models.js';
import { pct, round1 } from '../overview/reporting.js';

const courseDto = (c: Record<string, any>, lessonCount: number) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
  id: c.courseId,
  categoryId: c.categoryId,
  title: c.title,
  lessonCount,
  status: c.status,
  certified: !!c.certified,
  ...(c.summary ? { summary: c.summary } : {}),
});

const lessonDto = (l: Record<string, any>) => ({ id: l.lessonId, courseId: l.courseId, title: l.title, position: l.position, media: l.media, body: l.body ?? '', status: l.status }); // eslint-disable-line @typescript-eslint/no-explicit-any

async function publishedCounts(courseIds?: string[]): Promise<Map<string, number>> {
  const rows = await Lesson.aggregate([{ $match: { status: 'published', ...(courseIds ? { courseId: { $in: courseIds } } : {}) } }, { $group: { _id: '$courseId', n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [r._id as string, r.n as number]));
}

async function requireCourse(courseId: string) {
  const c = await Course.findOne({ courseId }).lean();
  if (!c) throw notFound('resource/not-found', `Course ${courseId} not found`);
  return c;
}

async function requireCategory(categoryId: string) {
  const cat = await CourseCategory.findOne({ categoryId }).lean();
  if (!cat) throw unprocessable('Unknown category', { categoryId: 'Unknown category' });
  return cat;
}

const publishEmpty = (title: string) => new AppError({ status: 422, code: 'rule/publish-empty-course', message: `"${title}" has no published lessons yet — add one before publishing.`, fields: { status: 'Needs at least one published lesson' } });

export const academyRoutes: AdminRouteDef[] = [
  route(108, 'GET /academy/categories', ['content', 'view'], async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const [cats, courses, counts] = await Promise.all([
      CourseCategory.find().sort({ position: 1, categoryId: 1 }).lean(),
      Course.find(q ? { title: new RegExp(escapeRegex(q), 'i') } : {}).sort({ createdAt: 1, _id: 1 }).lean(),
      publishedCounts(),
    ]);
    res.json({
      data: cats.map((cat) => {
        const mine = courses.filter((c) => c.categoryId === cat.categoryId).map((c) => courseDto(c, counts.get(c.courseId) ?? 0));
        return { id: cat.categoryId, name: cat.name, lessonCount: mine.reduce((a, c) => a + c.lessonCount, 0), courses: mine };
      }),
    });
  }),

  route(109, 'POST /academy/courses', ['content', 'edit'], async (req, res) => {
    const b = req.body as { title: string; categoryId: string; plannedLessons: number; certified: boolean; summary?: string; draft: boolean };
    await requireCategory(b.categoryId);
    if (!b.draft) throw publishEmpty(b.title);
    const actor = auditActor(req);
    const course = await withTx(async (session) => {
      const courseId = await nextId('course', session);
      const [created] = await Course.create([{ courseId, categoryId: b.categoryId, title: b.title, summary: b.summary, status: 'draft', certified: b.certified, plannedLessons: b.plannedLessons, createdBy: actor.staffId }], { session });
      await recordAudit({ actor, category: 'content', action: 'Created course', record: { type: 'course', id: courseId, label: b.title }, after: { categoryId: b.categoryId, status: 'draft', certified: b.certified }, req, session });
      return created!.toObject();
    });
    res.status(201).json({ ...courseDto(course, 0), message: 'Course created as a draft' });
  }, {
    body: z.object({ title: z.string().trim().min(2).max(160), categoryId: z.string().min(1), plannedLessons: z.number().int().min(0).max(200).default(0), certified: z.boolean().default(false), summary: z.string().trim().max(1000).optional(), draft: z.boolean().default(true) }),
  }),

  route(110, 'PATCH /academy/courses/:courseId', ['content', 'edit'], async (req, res) => {
    const courseId = String(req.params.courseId);
    const b = req.body as { title?: string; categoryId?: string; status?: 'published' | 'draft'; certified?: boolean; summary?: string };
    const before = await requireCourse(courseId);
    if (b.categoryId) await requireCategory(b.categoryId);
    const publishedLessons = (await publishedCounts([courseId])).get(courseId) ?? 0;
    if (b.status === 'published' && publishedLessons === 0) throw publishEmpty(b.title ?? before.title);
    const actor = auditActor(req);
    const { updated, auditId } = await withTx(async (session) => {
      const updated = await Course.findOneAndUpdate({ courseId, __v: before.__v }, { $set: b, $inc: { __v: 1 } }, { new: true, session }).lean();
      if (!updated) throw conflict('conflict/stale-state', `${courseId} was changed by someone else — reload and retry.`);
      const auditId = await recordAudit({ actor, category: 'content', action: b.certified !== undefined && Object.keys(b).length === 1 ? (b.certified ? 'Marked course certified' : 'Removed certified track') : 'Updated course', record: { type: 'course', id: courseId, label: updated.title }, before: pick(before, b), after: b, req, session });
      return { updated, auditId };
    });
    const onlyCert = Object.keys(b).length === 1 && b.certified !== undefined;
    const message = onlyCert ? (b.certified ? `'${updated.title}' marked as a certified track` : `'${updated.title}' removed from certified tracks`) : `'${updated.title}' updated`;
    res.json(action(courseDto(updated, publishedLessons), message, auditId));
  }, {
    body: z.object({ title: z.string().trim().min(2).max(160), categoryId: z.string().min(1), status: z.enum(['published', 'draft']), certified: z.boolean(), summary: z.string().trim().max(1000) }).partial().refine((o) => Object.keys(o).length > 0, 'Nothing to update'),
  }),

  route(111, 'POST /academy/courses/:courseId/lessons', ['content', 'edit'], async (req, res) => {
    const courseId = String(req.params.courseId);
    const b = req.body as { title: string; position: 'end' | number; media: 'video_transcript' | 'video' | 'text' | 'quiz'; body: string; mediaFileId?: string; draft: boolean };
    const course = await requireCourse(courseId);
    if (b.mediaFileId && !(await loadFileRefs([b.mediaFileId])).has(b.mediaFileId)) throw unprocessable('Unknown media file', { mediaFileId: 'Unknown file' });
    const actor = auditActor(req);
    const lesson = await withTx(async (session) => {
      const last = await Lesson.findOne({ courseId }).sort({ position: -1 }).session(session ?? null).lean();
      const end = (last?.position ?? 0) + 1;
      const position = b.position === 'end' ? end : Math.min(b.position, end);
      if (position < end) await Lesson.updateMany({ courseId, position: { $gte: position } }, { $inc: { position: 1 } }, { session });
      const lessonId = await nextId('lesson', session);
      const [created] = await Lesson.create([{ lessonId, courseId, title: b.title, position, media: b.media, body: b.body, mediaFileId: b.mediaFileId, status: b.draft ? 'draft' : 'published', createdBy: actor.staffId }], { session });
      await recordAudit({ actor, category: 'content', action: b.draft ? 'Added draft lesson' : 'Added lesson', record: { type: 'course', id: courseId, label: course.title }, after: { lessonId, title: b.title, position }, req, session });
      return created!.toObject();
    });
    res.status(201).json(lessonDto(lesson));
  }, {
    body: z.object({ title: z.string().trim().min(2).max(200), position: z.union([z.literal('end'), z.number().int().min(1)]).default('end'), media: z.enum(['video_transcript', 'video', 'text', 'quiz']).default('text'), body: z.string().max(100_000).default(''), mediaFileId: z.string().optional(), draft: z.boolean().default(false) }),
  }),

  route(112, 'GET /academy/analytics', ['content', 'view'], async (_req, res) => {
    const since = new Date(Date.now() - 30 * MS_DAY);
    const prior = new Date(Date.now() - 60 * MS_DAY);
    const [courses, perTier, totals, recent, previous] = await Promise.all([
      Course.find({ status: 'published' }).sort({ createdAt: 1 }).lean(),
      Enrolment.aggregate([
        { $lookup: { from: User.collection.name, localField: 'userId', foreignField: 'userId', as: 'u' } },
        { $group: { _id: { courseId: '$courseId', tier: { $arrayElemAt: ['$u.tier', 0] } }, n: { $sum: 1 }, done: { $sum: { $cond: [{ $gt: ['$completedAt', null] }, 1, 0] } } } },
      ]),
      Enrolment.aggregate([{ $group: { _id: null, enrolments: { $sum: 1 }, completed: { $sum: { $cond: [{ $gt: ['$completedAt', null] }, 1, 0] } }, certificates: { $sum: { $cond: [{ $gt: ['$certificateId', null] }, 1, 0] } }, lessons: { $sum: '$lessonsCompleted' } } }]),
      Enrolment.countDocuments({ startedAt: { $gte: since } }),
      Enrolment.countDocuments({ startedAt: { $gte: prior, $lt: since } }),
    ]);
    const t = totals[0] ?? { enrolments: 0, completed: 0, certificates: 0, lessons: 0 };
    const growth = previous ? round1(((recent - previous) / previous) * 100) : 0;
    res.json({
      cards: [
        { key: 'enrolments', label: 'Enrolments', value: t.enrolments, sub: `${recent} in the last 30 days`, ...(previous ? { trend: { direction: growth >= 0 ? 'up' : 'down', text: `${Math.abs(growth)}% vs prior 30 days`, tone: growth >= 0 ? 'ok' : 'warn' } } : {}) },
        { key: 'completion_rate', label: 'Completion rate', value: pct(t.completed, t.enrolments), unit: '%' },
        { key: 'certificates', label: 'Certificates issued', value: t.certificates },
        { key: 'lessons_completed', label: 'Lessons completed', value: t.lessons },
      ],
      completion: courses.map((c) => {
        const rows = perTier.filter((r) => r._id.courseId === c.courseId);
        const n = rows.reduce((a, r) => a + r.n, 0);
        const done = rows.reduce((a, r) => a + r.done, 0);
        const byTier: Record<string, number> = {};
        for (const tier of [1, 2, 3]) {
          const r = rows.find((x) => x._id.tier === tier);
          byTier[String(tier)] = r ? pct(r.done, r.n) : 0;
        }
        return { courseId: c.courseId, title: c.title, ratePct: pct(done, n), byTier };
      }),
    });
  }),
];

function pick(obj: Record<string, any>, keys: Record<string, unknown>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  return Object.fromEntries(Object.keys(keys).map((k) => [k, obj[k]]));
}
