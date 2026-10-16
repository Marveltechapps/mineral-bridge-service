import { conflict, notFound } from '../../common/errors/app-error.js';
import { now } from '../../common/utils/clock.js';
import { references } from '../../common/utils/references.js';
import { CertificateModel, CourseModel, LessonModel, LessonProgressModel } from '../../models/learning.model.js';
import type { ICertificate, ICourse, ILesson, ILessonProgress } from '../../models/learning.model.js';

export type CourseWithProgress = { course: ICourse; lessonCount: number; completedCount: number; percent: number; durationSec: number };

export const learningService = {
  async courses(userId: string | undefined): Promise<CourseWithProgress[]> {
    const courses = await CourseModel.find({ published: true }).sort({ sort: 1, createdAt: 1 }).lean<ICourse[]>();
    const ids = courses.map((c) => c._id);
    const [lessons, done] = await Promise.all([
      LessonModel.find({ courseId: { $in: ids }, published: true }).select('courseId durationSec').lean<ILesson[]>(),
      userId ? LessonProgressModel.find({ userId, courseId: { $in: ids }, completedAt: { $exists: true } }).select('courseId').lean<ILessonProgress[]>() : Promise.resolve([] as ILessonProgress[]),
    ]);
    return courses.map((course) => {
      const ls = lessons.filter((l) => l.courseId === course._id);
      const completedCount = done.filter((d) => d.courseId === course._id).length;
      return {
        course,
        lessonCount: ls.length,
        completedCount,
        percent: ls.length ? Math.round((completedCount / ls.length) * 100) : 0,
        durationSec: ls.reduce((s, l) => s + l.durationSec, 0),
      };
    });
  },

  async course(courseIdOrSlug: string, userId: string | undefined) {
    const course = await CourseModel.findOne({ $or: [{ _id: courseIdOrSlug }, { slug: courseIdOrSlug }], published: true }).lean<ICourse>();
    if (!course) throw notFound('learn/course-not-found', 'Course not found');
    const lessons = await LessonModel.find({ courseId: course._id, published: true }).sort({ sort: 1 }).lean<ILesson[]>();
    const progress = userId ? await LessonProgressModel.find({ userId, courseId: course._id }).lean<ILessonProgress[]>() : [];
    return { course, lessons, progress: new Map(progress.map((p) => [p.lessonId, p])) };
  },

  async lesson(lessonId: string, userId: string | undefined) {
    const lesson = await LessonModel.findOne({ _id: lessonId, published: true }).lean<ILesson>();
    if (!lesson) throw notFound('learn/lesson-not-found', 'Lesson not found');
    const progress = userId ? await LessonProgressModel.findOne({ userId, lessonId }).lean<ILessonProgress>() : null;
    return { lesson, progress };
  },

  async section(sectionId: string, userId: string | undefined) {
    const course = await CourseModel.findOne({ 'sections._id': sectionId, published: true }).lean<ICourse>();
    if (!course) throw notFound('learn/section-not-found', 'Section not found');
    return this.course(course._id, userId);
  },

  /** Progress only moves forward and never un-completes a lesson. */
  async saveProgress(userId: string, lessonId: string, input: { positionSec?: number; percent?: number }) {
    const { lesson, progress } = await this.lesson(lessonId, userId);
    const percent = Math.min(100, Math.max(progress?.percent ?? 0, Math.round(input.percent ?? 0)));
    const positionSec = Math.max(0, input.positionSec ?? progress?.positionSec ?? 0);
    await LessonProgressModel.updateOne(
      { userId, lessonId },
      { $set: { courseId: lesson.courseId, positionSec, percent, updatedAt: now() }, $setOnInsert: { userId, lessonId } },
      { upsert: true },
    );
    return (await LessonProgressModel.findOne({ userId, lessonId }).lean<ILessonProgress>())!;
  },

  async complete(userId: string, lessonId: string) {
    const { lesson } = await this.lesson(lessonId, userId);
    await LessonProgressModel.updateOne(
      { userId, lessonId },
      { $set: { courseId: lesson.courseId, percent: 100, updatedAt: now() }, $setOnInsert: { userId, lessonId, positionSec: 0, completedAt: now() } },
      { upsert: true },
    );
    // completedAt is only ever set once (setOnInsert) unless the row pre-existed without it.
    await LessonProgressModel.updateOne({ userId, lessonId, completedAt: { $exists: false } }, { $set: { completedAt: now() } });
    const courses = (await this.courses(userId)).find((c) => c.course._id === lesson.courseId);
    const courseComplete = Boolean(courses && courses.lessonCount > 0 && courses.completedCount >= courses.lessonCount);
    const certificate = courseComplete ? await this.issueCertificate(userId, lesson.courseId) : null;
    return { progress: (await LessonProgressModel.findOne({ userId, lessonId }).lean<ILessonProgress>())!, courseComplete, certificate };
  },

  async issueCertificate(userId: string, courseId: string): Promise<ICertificate> {
    const existing = await CertificateModel.findOne({ userId, courseId }).lean<ICertificate>();
    if (existing) return existing;
    try {
      const doc = await CertificateModel.create({ userId, courseId, serial: await references.certificate(), issuedAt: now() });
      return doc.toObject() as ICertificate;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return (await CertificateModel.findOne({ userId, courseId }).lean<ICertificate>())!;
      throw err;
    }
  },

  async certificate(userId: string, courseIdOrSlug: string) {
    const { course } = await this.course(courseIdOrSlug, userId);
    const stats = (await this.courses(userId)).find((c) => c.course._id === course._id);
    if (!stats || stats.lessonCount === 0 || stats.completedCount < stats.lessonCount) {
      throw conflict('academy/course-incomplete', 'Complete every lesson to earn your certificate.', { details: { completed: stats?.completedCount ?? 0, total: stats?.lessonCount ?? 0 } });
    }
    return { course, certificate: await this.issueCertificate(userId, course._id) };
  },

  async overview(userId: string) {
    const all = await this.courses(userId);
    const lessons = all.reduce((s, c) => s + c.lessonCount, 0);
    const done = all.reduce((s, c) => s + c.completedCount, 0);
    return { courses: all.length, lessons, completedLessons: done, percent: lessons ? Math.round((done / lessons) * 100) : 0 };
  },

  async certificatesFor(userId: string) {
    const certs = await CertificateModel.find({ userId }).sort({ issuedAt: -1 }).lean<ICertificate[]>();
    const courseIds = [...new Set(certs.map((c) => c.courseId))];
    const courses = await CourseModel.find({ _id: { $in: courseIds } }).select('_id title').lean<ICourse[]>();
    const titles = new Map(courses.map((c) => [c._id, c.title]));
    return certs.map((certificate) => ({ certificate, courseTitle: titles.get(certificate.courseId) ?? 'Course' }));
  },
};
