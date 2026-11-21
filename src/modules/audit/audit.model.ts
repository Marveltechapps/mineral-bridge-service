import { Schema } from 'mongoose';
import { defineModel } from '../../common/db/define-model.js';
import { AUDIT_CATEGORIES } from '../admin/shared/enums.js';
import { refSchema } from '../../models/shared.js';

/**
 * Append-only audit log. Every privileged write stores actor, record, before and after.
 * Update/delete operations are blocked at the Mongoose layer; in production also restrict the
 * DB user to insert/find on this collection (see docs/DATABASE.md).
 */
const auditSchema = new Schema<any>(
  {
    auditId: { type: String, required: true, unique: true },
    at: { type: Date, default: Date.now, index: true },
    actor: {
      kind: { type: String, enum: ['staff', 'customer', 'system', 'partner'], default: 'staff' },
      staffId: { type: String, index: true },
      userId: String,
      name: String,
      initials: String,
      role: String,
      roleId: String,
    },
    category: { type: String, enum: AUDIT_CATEGORIES, required: true, index: true },
    action: { type: String, required: true },
    record: { type: refSchema, required: true },
    /** Alias of `record` for v2 payloads. */
    entity: refSchema,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    beforeText: { type: String, default: '—' },
    afterText: { type: String, default: '—' },
    reason: String,
    requestId: String,
    ip: String,
  },
  { versionKey: false },
);
auditSchema.index({ 'record.type': 1, 'record.id': 1, at: -1 });
auditSchema.index({ 'actor.userId': 1, at: -1 }, { sparse: true });

const BLOCKED = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

for (const op of BLOCKED) {
   
  (auditSchema as any).pre(op, function () {
    throw new Error(`AuditLog is append-only: ${op} is not permitted`);
  });
}
auditSchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error('AuditLog is append-only: documents cannot be modified'));
  next();
});

export const AuditLog = defineModel('AuditLog', auditSchema, 'audit_log');
