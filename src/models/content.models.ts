import { Schema } from 'mongoose';
import { defineModel, timestampFields } from '../common/db/define-model.js';
import {
  BANNER_KINDS,
  BANNER_PLACEMENTS,
  PARTNER_STATUSES,
  PARTNER_TYPES,
  TICKET_STATUSES,
} from '../modules/admin/shared/enums.js';
import { refSchema } from './shared.js';

const opts = { timestamps: true } as const;

/* ───────── Academy ───────── */
const catSchema = new Schema<any>(
  { categoryId: { type: String, required: true, unique: true }, name: { type: String, required: true }, position: { type: Number, default: 0 } },
  { versionKey: false },
);
export const CourseCategory = defineModel('CourseCategory', catSchema, 'course_categories');

const courseSchema = new Schema<any>(
  {
    courseId: { type: String, required: true, unique: true },
    categoryId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    summary: String,
    status: { type: String, enum: ['published', 'draft'], default: 'draft' },
    certified: { type: Boolean, default: false },
    plannedLessons: { type: Number, default: 0 },
    createdBy: String,
    ...timestampFields,
  },
  opts,
);
export const Course = defineModel('Course', courseSchema, 'courses');

const lessonSchema = new Schema<any>(
  {
    lessonId: { type: String, required: true, unique: true },
    courseId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    position: { type: Number, default: 1 },
    media: { type: String, enum: ['video_transcript', 'video', 'text', 'quiz'], default: 'text' },
    body: { type: String, default: '' },
    mediaFileId: String,
    status: { type: String, enum: ['published', 'draft'], default: 'published' },
    createdBy: String,
    ...timestampFields,
  },
  opts,
);
export const Lesson = defineModel('Lesson', lessonSchema, 'lessons');

/** Written by customer learning APIs; read by admin academy analytics. */
const enrolmentSchema = new Schema<any>(
  {
    userId: { type: String, required: true },
    courseId: { type: String, required: true },
    startedAt: { type: Date, default: Date.now },
    completedAt: Date,
    certificateId: String,
    lessonsStarted: { type: Number, default: 0 },
    lessonsCompleted: { type: Number, default: 0 },
  },
  { versionKey: false },
);
enrolmentSchema.index({ courseId: 1, userId: 1 }, { unique: true });
export const Enrolment = defineModel('Enrolment', enrolmentSchema, 'enrolments');

/* ───────── Marketing ───────── */
const bannerSchema = new Schema<any>(
  {
    bannerId: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    placement: { type: String, enum: BANNER_PLACEMENTS, required: true },
    kind: { type: String, enum: BANNER_KINDS, default: 'hero' },
    activeFrom: Date,
    activeUntil: Date,
    linkTarget: { type: String, required: true },
    active: { type: Boolean, default: false },
    status: { type: String, enum: ['draft', 'saved'], default: 'saved' },
    imageFileId: String,
    createdBy: String,
    ...timestampFields,
  },
  opts,
);
export const Banner = defineModel('Banner', bannerSchema, 'banners');

/* ───────── Partners ───────── */
const partnerSchema = new Schema<any>(
  {
    partnerId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    type: { type: String, enum: PARTNER_TYPES, required: true, index: true },
    parentPartnerId: String,
    modes: [{ type: String, enum: ['road', 'rail', 'sea', 'air'] }],
    regions: [String],
    base: String,
    capacity: String,
    email: String,
    phone: String,
    contactName: String,
    accreditation: String,
    status: { type: String, enum: PARTNER_STATUSES, default: 'onboarding', index: true },
    internalNote: String,
    createdBy: String,
    ...timestampFields,
  },
  opts,
);
partnerSchema.index({ parentPartnerId: 1 });
export const Partner = defineModel('Partner', partnerSchema, 'partners');

/* ───────── Support ───────── */
const ticketSchema = new Schema<any>(
  {
    ticketId: { type: String, required: true, unique: true },
    subject: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    linked: refSchema,
    status: { type: String, enum: TICKET_STATUSES, default: 'open', index: true },
    ownerId: String,
    ownerTeam: String,
    channel: { type: String, enum: ['phone', 'whatsapp', 'email', 'app'], default: 'phone' },
    openedAt: { type: Date, default: Date.now },
    isDraft: { type: Boolean, default: false },
    notes: [{ _id: false, id: String, authorId: String, text: String, at: Date }],
    createdBy: String,
    ...timestampFields,
  },
  opts,
);
export const Ticket = defineModel('Ticket', ticketSchema, 'tickets');

const callSchema = new Schema<any>(
  {
    callId: { type: String, required: true, unique: true },
    at: { type: Date, default: Date.now, index: true },
    userId: String,
    phone: String,
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    durationSec: { type: Number, default: 0 },
    topic: String,
    agentId: String,
  },
  { versionKey: false },
);
export const Call = defineModel('Call', callSchema, 'calls');
