import { defineModel, pk, SubDocId } from './_shared.js';

/** One catalogue serves mobile "tracks/sections/lessons" and web "courses/lessons" (X-4 style sharing). */
export interface ICourse {
  _id: string;
  slug: string;
  title: string;
  summary?: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  imageUrl?: string;
  gradientFrom?: string;
  gradientTo?: string;
  sections: { _id: string; title: string; sort: number }[];
  published: boolean;
  sort: number;
  createdAt: Date;
}

export const CourseModel = defineModel<ICourse>(
  'Course',
  {
    _id: pk('crs'),
    slug: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    summary: String,
    level: { type: String, enum: ['beginner', 'intermediate', 'advanced'], default: 'beginner' },
    imageUrl: String,
    gradientFrom: String,
    gradientTo: String,
    sections: [{ _id: SubDocId('sec'), title: String, sort: { type: Number, default: 0 } }],
    published: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
);

export interface ILesson {
  _id: string;
  courseId: string;
  sectionId?: string;
  title: string;
  summary?: string;
  kind: 'video' | 'article' | 'quiz';
  durationSec: number;
  sort: number;
  mediaUrl?: string;
  content?: string;
  published: boolean;
}

export const LessonModel = defineModel<ILesson>(
  'Lesson',
  {
    _id: pk('lsn'),
    courseId: { type: String, required: true, index: true },
    sectionId: String,
    title: { type: String, required: true },
    summary: String,
    kind: { type: String, enum: ['video', 'article', 'quiz'], default: 'video' },
    durationSec: { type: Number, default: 0 },
    sort: { type: Number, default: 0 },
    mediaUrl: String,
    content: String,
    published: { type: Boolean, default: true },
  },
);

export interface ILessonProgress {
  _id: string;
  userId: string;
  lessonId: string;
  courseId: string;
  positionSec: number;
  percent: number;
  completedAt?: Date;
  updatedAt: Date;
}

export const LessonProgressModel = defineModel<ILessonProgress>(
  'LessonProgress',
  {
    _id: pk('lpg'),
    userId: { type: String, required: true },
    lessonId: { type: String, required: true },
    courseId: { type: String, required: true },
    positionSec: { type: Number, default: 0 },
    percent: { type: Number, default: 0, min: 0, max: 100 },
    completedAt: Date,
  },
  { indexes: [[{ userId: 1, lessonId: 1 }, { unique: true }], [{ userId: 1, courseId: 1 }]] },
);

export interface ICertificate {
  _id: string;
  userId: string;
  courseId: string;
  serial: string;
  issuedAt: Date;
}

export const CertificateModel = defineModel<ICertificate>(
  'Certificate',
  {
    _id: pk('cer'),
    userId: { type: String, required: true },
    courseId: { type: String, required: true },
    serial: { type: String, required: true, unique: true },
    issuedAt: { type: Date, required: true },
  },
  { indexes: [[{ userId: 1, courseId: 1 }, { unique: true }]] },
);
