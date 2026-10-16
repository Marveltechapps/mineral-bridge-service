import type { ClientSession } from 'mongoose';
import { AppError, notFound } from '../../../common/errors/app-error.js';
import { nextId } from '../../../common/db/sequence.js';
import { sendSms } from '../../../common/notify/sms.js';
import { User } from '../../../models/people.models.js';
import { OutboundMessage } from '../../../models/platform.models.js';

export type Channel = 'sms' | 'in_app';

/**
 * Staff → customer message (#30, #33, #94). In-app messages are persisted for the customer inbox;
 * SMS goes through the configured provider. If NO channel can be delivered the call fails with the provider's 503.
 */
export async function sendCustomerMessage(input: {
  userId: string;
  subject?: string;
  body: string;
  channels: Channel[];
  draft?: boolean;
  related?: { type: string; id: string };
  sentBy: string;
  session?: ClientSession;
}) {
  const user = await User.findOne({ userId: input.userId }).lean();
  if (!user) throw notFound('resource/not-found', `User ${input.userId} not found`);
  const messageId = await nextId('message');
  const delivered: Channel[] = [];
  const failed: Array<{ channel: string; code: string }> = [];
  let firstError: AppError | null = null;

  if (!input.draft) {
    for (const ch of input.channels) {
      if (ch === 'in_app') {
        delivered.push('in_app');
      } else if (ch === 'sms') {
        try {
          if (!user.phone) throw new AppError({ status: 422, code: 'rule/no-phone-on-file', message: `${user.name} has no phone number on file` });
          await sendSms(user.phone, input.subject ? `${input.subject}: ${input.body}` : input.body);
          delivered.push('sms');
        } catch (err) {
          const e = err instanceof AppError ? err : new AppError({ status: 503, code: 'sms/provider-down', message: 'SMS delivery failed' });
          firstError ??= e;
          failed.push({ channel: 'sms', code: e.code });
        }
      }
    }
    if (delivered.length === 0 && firstError) throw firstError;
  }

  await OutboundMessage.create(
    [
      {
        messageId,
        toUserId: input.userId,
        subject: input.subject,
        body: input.body,
        channels: input.channels,
        deliveredVia: delivered,
        failedChannels: failed,
        status: input.draft ? 'draft' : 'sent',
        related: input.related,
        sentBy: input.sentBy,
      },
    ],
    { session: input.session },
  );
  return { id: messageId, deliveredVia: delivered, failedChannels: failed, user, draft: Boolean(input.draft) };
}
