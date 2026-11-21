import { conflict, notFound } from '../../common/errors/app-error.js';
import { OrderModel, type IOrder, type IOrderWorkflow, type WorkflowOwner } from '../../models/order.model.js';
import { advanceWorkflow, assertCurrent, type WorkflowState } from '../workflow/workflow.service.js';
import { stepDef, type WorkflowDefinitionId } from '../workflow/workflow.definitions.js';

export function mapOwner(owner: string): WorkflowOwner {
  if (owner === 'customer') return 'customer';
  if (owner === 'logistics') return 'logistics';
  if (owner === 'inspection' || owner === 'inspector') return 'inspector';
  return 'platform';
}

export function workflowStateFromOrder(order: IOrder): WorkflowState {
  if (!order.workflow) throw conflict('step/invalid', 'Order has no workflow.');
  return {
    definition: order.workflow.definition as WorkflowDefinitionId,
    version: 1,
    current: {
      key: order.workflow.stepKey,
      index: order.workflow.stepIndex,
      owner: order.workflow.owner,
      enteredAt: order.workflow.enteredAt,
    },
    history: [],
  };
}

export function toPersistedWorkflow(state: WorkflowState): IOrderWorkflow {
  return {
    definition: state.definition,
    stepKey: state.current.key,
    stepIndex: state.current.index,
    phase: state.current.index + 1,
    owner: mapOwner(state.current.owner),
    role: stepDef(state.definition, state.current.key).action,
    enteredAt: state.current.enteredAt,
  };
}

export async function loadOwnedOrder(userId: string, ref: string): Promise<IOrder> {
  const order =
    (await OrderModel.findOne({ reference: ref, userId }).lean<IOrder>()) ??
    (await OrderModel.findOne({ _id: ref, userId }).lean<IOrder>());
  if (!order) throw notFound('order/not-found', 'Order not found');
  return order;
}

export async function loadOrderByRef(ref: string): Promise<IOrder> {
  const order =
    (await OrderModel.findOne({ reference: ref }).lean<IOrder>()) ??
    (await OrderModel.findById(ref).lean<IOrder>());
  if (!order) throw notFound('order/not-found', 'Order not found');
  return order;
}

export function assertOrderVersion(order: IOrder, version: number): void {
  if (order.version !== version) {
    throw conflict('step/version', 'Order was updated elsewhere. Refresh and retry.', {
      details: { version: order.version },
    });
  }
}

export async function casAdvanceOrder(input: {
  order: IOrder;
  toKey: string;
  actor: { kind: 'customer' | 'staff' | 'system'; id: string; name?: string; role?: string };
  note?: string;
  version: number;
  extraSet?: Record<string, unknown>;
  clearHold?: boolean;
}): Promise<IOrder> {
  assertOrderVersion(input.order, input.version);
  const state = workflowStateFromOrder(input.order);
  assertCurrent(state, state.current.key);
  const advanced = advanceWorkflow(state, input.toKey, input.actor, input.note);
  const $set: Record<string, unknown> = {
    workflow: toPersistedWorkflow(advanced),
    ...input.extraSet,
  };
  const $unset: Record<string, unknown> = {};
  if (input.clearHold) $unset.hold = 1;

  const updated = await OrderModel.findOneAndUpdate(
    { _id: input.order._id, version: input.version },
    {
      $set,
      ...(Object.keys($unset).length ? { $unset } : {}),
      $push: {
        timeline: {
          stepKey: input.toKey,
          label: stepDef(advanced.definition, input.toKey).label,
          actor: input.actor,
          note: input.note,
          at: new Date(),
        },
      },
      $inc: { version: 1 },
    },
    { new: true },
  ).lean<IOrder>();
  if (!updated) throw conflict('step/version', 'Order was updated elsewhere. Refresh and retry.');
  return updated;
}
