import { Schema } from 'mongoose';
import { defineModel, timestampFields } from '../../common/db/define-model.js';
import { MODULES } from '../../models/shared.js';

/**
 * Editable role matrix (Settings → Roles, #129–#134). Staff accounts, sessions and sign-in live in
 * `modules/staff` and `modules/sessions`; a staff row embeds `{role:{id,name,scope}, permissions}`,
 * so changing a role here must be propagated to `StaffUser.role/permissions` (see settings.routes).
 * `roleId` equals `StaffShape.role.id` (e.g. ROLE-CEO).
 */
const accessShape = Object.fromEntries(MODULES.map((m) => [m, { type: String, enum: ['none', 'view', 'edit'], default: 'none' }]));

const roleSchema = new Schema<any>(
  {
    roleId: { type: String, required: true, unique: true },
    /** Canonical role key used by the dashboard RBAC. */
    key: {
      type: String,
      enum: ['super', 'ops', 'trading', 'compliance', 'inspection', 'finance', 'logistics', 'catalogue', 'support'],
    },
    name: { type: String, required: true },
    description: String,
    scope: { type: String, default: '' },
    access: accessShape,
    /** Action permissions; module levels in `access` are derived for `/admin/v1`. */
    actions: { type: [String], default: [] },
    limits: {
      payoutApproveMaxMinor: Number,
      refundApproveMaxMinor: Number,
    },
    system: { type: Boolean, default: false },
    /** Staff pickers (#19) filter by this kind. */
    kind: { type: String, enum: ['field_agent', 'desk', 'compliance', 'support', 'content', 'data_entry', 'executive'], default: 'desk' },
    ...timestampFields,
  },
  { timestamps: true },
);
roleSchema.index({ key: 1 }, { unique: true, sparse: true });
export const Role = defineModel('Role', roleSchema, 'roles');
