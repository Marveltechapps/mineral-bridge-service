import { defineModel, pk, SubDocId } from './_shared.js';

/** Canonical ticket status (X-7): mobile & admin vocabularies map from it. */
export type TicketStatus = 'open' | 'agent_replied' | 'waiting_on_user' | 'escalated' | 'resolved' | 'closed';

export interface ITicketMessage {
  _id: string;
  author: 'user' | 'agent' | 'system';
  authorName?: string;
  body: string;
  attachmentIds: string[];
  at: Date;
}

export interface ISupportTicket {
  _id: string;
  reference: string;
  userId: string;
  topic: string;
  subject: string;
  body: string;
  relatedTo?: { type: string; id: string };
  status: TicketStatus;
  messages: ITicketMessage[];
  attachmentIds: string[];
  resolvedAt?: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const SupportTicketModel = defineModel<ISupportTicket>(
  'SupportTicket',
  {
    _id: pk('tkt'),
    reference: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    topic: { type: String, default: 'general' },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    relatedTo: { type: Object },
    status: {
      type: String,
      enum: ['open', 'agent_replied', 'waiting_on_user', 'escalated', 'resolved', 'closed'],
      default: 'open',
    },
    messages: [
      {
        _id: SubDocId('msg'),
        author: { type: String, enum: ['user', 'agent', 'system'], required: true },
        authorName: String,
        body: { type: String, required: true },
        attachmentIds: [String],
        at: { type: Date, default: Date.now },
      },
    ],
    attachmentIds: [String],
    resolvedAt: Date,
    version: { type: Number, default: 0 },
  },
  { indexes: [[{ userId: 1, updatedAt: -1 }]] },
);

export interface IChatMessage {
  _id: string;
  clientId?: string;
  author: 'user' | 'agent' | 'system';
  body: string;
  at: Date;
  readAt?: Date;
}

export interface IChatSession {
  _id: string;
  userId: string;
  status: 'waiting' | 'active' | 'ended';
  agent?: { id: string; name: string; initials: string };
  messages: IChatMessage[];
  endedBy?: 'user' | 'agent' | 'timeout';
  endedAt?: Date;
  topic?: string;
  createdAt: Date;
}

export const ChatSessionModel = defineModel<IChatSession>(
  'ChatSession',
  {
    _id: pk('cht'),
    userId: { type: String, required: true, index: true },
    status: { type: String, enum: ['waiting', 'active', 'ended'], default: 'waiting' },
    agent: { id: String, name: String, initials: String },
    messages: [
      {
        _id: SubDocId('cms'),
        clientId: String,
        author: { type: String, enum: ['user', 'agent', 'system'], required: true },
        body: { type: String, required: true },
        at: { type: Date, default: Date.now },
        readAt: Date,
      },
    ],
    endedBy: String,
    endedAt: Date,
    topic: String,
  },
);

export interface ICallbackRequest {
  _id: string;
  userId: string;
  phone?: string;
  topic?: string;
  note?: string;
  preferredWindow?: string;
  relatedTo?: { type: string; id: string };
  status: 'requested' | 'scheduled' | 'completed' | 'cancelled';
  createdAt: Date;
}

export const CallbackRequestModel = defineModel<ICallbackRequest>('CallbackRequest', {
  _id: pk('cbk'),
  userId: { type: String, required: true, index: true },
  phone: String,
  topic: String,
  note: String,
  preferredWindow: String,
  relatedTo: { type: Object },
  status: { type: String, enum: ['requested', 'scheduled', 'completed', 'cancelled'], default: 'requested' },
});
