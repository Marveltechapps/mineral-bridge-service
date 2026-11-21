import { createHash } from 'node:crypto';
import { conflict, unprocessable } from '../../common/errors/app-error.js';
import { references } from '../../common/utils/references.js';
import { ContractModel, type IContract } from '../../models/contract-lc.model.js';
import { QuotationModel } from '../../models/workflow.model.js';
import { OrderModel, type IOrder } from '../../models/order.model.js';
import { userRepository } from '../users/user.repository.js';
import { enqueueOutbox } from '../outbox/outbox.service.js';
import { notifyUser } from '../notifications/notifications.service.js';
import {
  assertOrderVersion,
  casAdvanceOrder,
  loadOwnedOrder,
  workflowStateFromOrder,
} from './v2.order-helpers.js';
import { assertCurrent } from '../workflow/workflow.service.js';
import { v2OrdersService } from './v2.orders.service.js';

function moneyLabel(m?: { amountMinor?: number; currency?: string } | null): string {
  if (!m || m.amountMinor === undefined) return 'TBD';
  return `${m.currency ?? 'USD'} ${(m.amountMinor / 100).toFixed(2)}`;
}

function renderHtml(order: IOrder, contract: IContract, quotationTotal?: { amountMinor?: number; currency?: string } | null) {
  const total = moneyLabel(quotationTotal ?? order.pricing?.lockedTotal ?? order.total);
  return `<!DOCTYPE html><html><body>
<h1>Mineral Bridge E-Contract ${contract.number ?? contract.reference}</h1>
<p>Order ${order.reference}</p>
<p>Total: ${total}</p>
<p>Document hash: ${contract.documentHash}</p>
</body></html>`;
}

function hashDocument(html: string): string {
  return `sha256:${createHash('sha256').update(html).digest('hex')}`;
}

export const v2ContractService = {
  async getOrCreate(userId: string, ref: string) {
    const order = await loadOwnedOrder(userId, ref);
    if (!order.workflow) throw conflict('step/invalid', 'Order has no workflow.');

    let contract = await ContractModel.findOne({ orderId: order._id, status: { $ne: 'cancelled' } }).lean<IContract>();

    if (!contract) {
      if (order.workflow.stepKey !== 'contract') {
        throw conflict('step/invalid', 'Contract is not available yet.', {
          details: { current: order.workflow.stepKey },
        });
      }
      const q = await QuotationModel.findOne({ orderId: order._id, status: 'accepted' }).lean();
      const number = `EC-${order.reference.replace(/^MB-(ORD-|SELL-)?/, '')}`;
      const draftHtml = `<h1>Draft ${number}</h1><p>Order ${order.reference}</p>`;
      const documentHash = hashDocument(draftHtml);
      const created = await ContractModel.create({
        reference: await references.contract(),
        number,
        kind: 'order',
        status: 'draft',
        orderId: order._id,
        templateId: order.side === 'sell' ? 'sell_e_contract' : 'buy_e_contract',
        templateVersion: 1,
        documentHash,
        buyerId: order.side === 'buy' ? order.userId : 'platform',
        sellerId: order.side === 'sell' ? order.userId : 'platform',
        terms: {
          lotDescription: order.sell?.name ?? order.lines.map((l) => l.name).join(', '),
          total: q?.total ?? order.total,
          quantity: order.totalGrams,
          unit: 'g',
        },
        signatures: {},
        version: 0,
      });
      contract = created.toObject() as IContract;
      await OrderModel.updateOne(
        { _id: order._id },
        { $set: { 'links.contractId': contract._id } },
      );
    }

    const html = renderHtml(order, contract, order.pricing?.lockedTotal ?? order.pricing?.quotedTotal);
    // Keep hash stable for existing contracts.
    const documentHash = contract.documentHash ?? hashDocument(html);
    if (!contract.documentHash) {
      await ContractModel.updateOne({ _id: contract._id }, { $set: { documentHash } });
    }

    return {
      number: contract.number ?? contract.reference,
      html,
      pdfUrl: null as string | null,
      documentHash,
      parties: [
        { role: 'customer', id: order.userId },
        { role: 'platform', id: 'platform' },
      ],
      clauses: [
        { h: 'Payment', text: 'Payment terms as set out in the accepted quotation.' },
        { h: 'Delivery', text: 'Delivery and inspection per Mineral Bridge operating procedures.' },
      ],
      signatures: {
        customer: contract.signatures.buyer?.signedAt
          ? {
              nameTyped: contract.signatures.buyer.nameTyped,
              at: contract.signatures.buyer.signedAt.toISOString(),
            }
          : contract.signatures.seller?.signedAt
            ? {
                nameTyped: contract.signatures.seller.nameTyped,
                at: contract.signatures.seller.signedAt.toISOString(),
              }
            : null,
        platform: contract.signatures.platform
          ? {
              name: contract.signatures.platform.name,
              at: contract.signatures.platform.signedAt.toISOString(),
            }
          : null,
      },
    };
  },

  async sign(
    userId: string,
    ref: string,
    input: {
      documentHash: string;
      nameTyped: string;
      readConfirmed: boolean;
      version: number;
      ip?: string;
      userAgent?: string;
    },
  ) {
    if (input.readConfirmed !== true) {
      throw unprocessable('Confirm you have read the contract.', { readConfirmed: 'Required' });
    }
    const order = await loadOwnedOrder(userId, ref);
    assertOrderVersion(order, input.version);
    assertCurrent(workflowStateFromOrder(order), 'contract');

    const user = await userRepository.findById(userId);
    const expected = (user?.profile.fullName ?? '').trim().toLowerCase();
    if (!expected || input.nameTyped.trim().toLowerCase() !== expected) {
      throw unprocessable(
        'Type your full name exactly as on your account.',
        { nameTyped: 'Name mismatch' },
        'contract/name-mismatch',
      );
    }

    const contract = await ContractModel.findOne({ orderId: order._id, status: { $in: ['draft', 'signed'] } });
    if (!contract) throw conflict('contract/missing', 'Contract not found. Open the contract first.');
    if (contract.documentHash !== input.documentHash) {
      throw conflict('contract/hash-mismatch', 'Contract changed. Refresh and sign again.');
    }

    const now = new Date();
    const partyKey = order.side === 'sell' ? 'seller' : 'buyer';
    contract.signatures = {
      ...contract.signatures,
      [partyKey]: {
        userId,
        nameTyped: input.nameTyped.trim(),
        readConfirmed: true,
        ip: input.ip,
        userAgent: input.userAgent,
        signedAt: now,
      },
    };
    contract.status = 'signed';
    contract.version += 1;
    await contract.save();

    await casAdvanceOrder({
      order,
      toKey: 'contractMb',
      actor: { kind: 'customer', id: userId },
      note: 'E-contract signed by customer',
      version: input.version,
      extraSet: { 'links.contractId': contract._id },
    });

    void notifyUser(userId, {
      event: 'order.stage_changed',
      title: `Contract signed · ${order.reference}`,
      body: 'Mineral Bridge will countersign shortly.',
      target: { type: 'order', id: order._id },
    });
    void enqueueOutbox('audit.orders', {
      action: 'E-contract signed by customer',
      actorId: userId,
      orderId: order._id,
    });

    return v2OrdersService.get(userId, order.reference);
  },

  /** Staff countersign — used by admin step contractMb. */
  async countersign(order: IOrder, staff: { id: string; name: string; title?: string }, version: number) {
    assertOrderVersion(order, version);
    assertCurrent(workflowStateFromOrder(order), 'contractMb');
    const contract = await ContractModel.findOne({ orderId: order._id });
    if (!contract) throw conflict('contract/missing', 'Contract not found.');
    contract.signatures = {
      ...contract.signatures,
      platform: { staffId: staff.id, name: staff.name, title: staff.title, signedAt: new Date() },
    };
    contract.status = 'countersigned';
    contract.version += 1;
    await contract.save();

    const next = order.side === 'sell' ? 'form' : 'paid';
    return casAdvanceOrder({
      order,
      toKey: next,
      actor: { kind: 'staff', id: staff.id, name: staff.name },
      note: 'Contract countersigned',
      version,
    });
  },
};
