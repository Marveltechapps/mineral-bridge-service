import { z } from 'zod';

export const trackParam = z.object({ trackId: z.string().min(1) });
export const courseParam = z.object({ courseId: z.string().min(1) });
export const lessonParam = z.object({ lessonId: z.string().min(1) });
export const sectionParam = z.object({ sectionId: z.string().min(1) });
export const progressBody = z.object({ positionSec: z.number().int().min(0).optional(), percent: z.number().min(0).max(100).optional() });
