import { describe, expect, it } from 'vitest';
import type { INotification } from '../src/models/notification.model.js';
import { toWebNotification } from '../src/modules/notifications/notifications.dto.js';

function note(partial: Pick<INotification, 'event'> & Partial<INotification>): INotification {
  return {
    _id: 'ntf_1',
    userId: 'usr_1',
    kind: 'system',
    title: 'Title',
    body: 'Body',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...partial,
  };
}

describe('web notification deep links', () => {
  it('opens the order the event is about', () => {
    const action = toWebNotification(
      note({ event: 'order.stage_changed', target: { type: 'order', id: 'ord_9' } }),
    ).action;
    expect(action).toEqual({ label: 'View', route: 'orderDetail', params: { id: 'ord_9', type: 'order' } });
  });

  it('opens shipment tracking when an order-stage event is really a shipment', () => {
    const action = toWebNotification(
      note({ event: 'order.stage_changed', target: { type: 'shipment', id: 'shp_1' } }),
    ).action;
    expect(action?.route).toBe('shipment');
    expect(action?.params).toMatchObject({ id: 'shp_1', type: 'shipment' });
  });

  it('opens the auction, sell request, negotiation, contract, letter of credit and mining registration', () => {
    expect(toWebNotification(note({ event: 'auction.outbid', target: { type: 'auction', id: 'auc_1' } })).action?.route).toBe('auctionDetail');
    expect(toWebNotification(note({ event: 'sell.offer_ready', target: { type: 'sell_request', id: 'sel_1' } })).action?.route).toBe('sell');
    expect(toWebNotification(note({ event: 'negotiation.offer', target: { type: 'negotiation', id: 'neg_1' } })).action?.route).toBe('negotiation');
    expect(toWebNotification(note({ event: 'contract.signed', target: { type: 'contract', id: 'ct_1' } })).action?.route).toBe('contract');
    expect(toWebNotification(note({ event: 'lc.status_changed', target: { type: 'lc', id: 'lc_1' } })).action?.route).toBe('lc');
    expect(toWebNotification(note({ event: 'sell.status_changed', target: { type: 'asm', id: 'asm_1' } })).action?.route).toBe('asm');
  });

  it('opens the account section for documents, payouts, support and identity', () => {
    expect(toWebNotification(note({ event: 'document.reviewed' })).action).toMatchObject({
      route: 'account',
      params: { tab: 'documents' },
    });
    expect(toWebNotification(note({ event: 'payout.verified' })).action).toMatchObject({
      route: 'account',
      params: { tab: 'payouts' },
    });
    expect(toWebNotification(note({ event: 'support.reply', target: { type: 'ticket', id: 'tkt_1' } })).action).toMatchObject({
      route: 'account',
      params: { id: 'tkt_1', type: 'ticket', tab: 'support' },
    });
    expect(toWebNotification(note({ event: 'kyc.decided' })).action?.route).toBe('kyc');
  });

  it('opens the lesson when a course id is attached', () => {
    expect(
      toWebNotification(note({ event: 'learn.new_lesson', target: { type: 'lesson', id: 'c2' } })).action,
    ).toMatchObject({ route: 'course', params: { id: 'c2', type: 'lesson' } });
  });
});
