import { conflict } from '../../common/errors/app-error.js';
import type { ActorRef } from '../../models/schema-primitives.js';
import { stepsFor, stepIndex, type WorkflowDefinitionId } from './workflow.definitions.js';

export interface WorkflowState {
  definition: WorkflowDefinitionId;
  version: number;
  current: { key: string; index: number; owner: string; enteredAt: Date };
  history: { key: string; at: Date; by?: ActorRef; note?: string }[];
}

export function startWorkflow(definition: WorkflowDefinitionId, initialKey: string): WorkflowState {
  const steps = stepsFor(definition);
  const index = stepIndex(definition, initialKey);
  const step = steps[index]!;
  const now = new Date();
  return {
    definition,
    version: 1,
    current: { key: step.key, index, owner: step.owner, enteredAt: now },
    history: [{ key: step.key, at: now }],
  };
}

export function advanceWorkflow(
  state: WorkflowState,
  toKey: string,
  actor: ActorRef,
  note?: string,
  expectedVersion?: number,
): WorkflowState {
  if (expectedVersion !== undefined && state.version !== expectedVersion) {
    throw conflict('step/version', 'Order was updated elsewhere. Refresh and retry.', {
      details: { version: state.version },
    });
  }
  const steps = stepsFor(state.definition);
  const toIndex = stepIndex(state.definition, toKey);
  const step = steps[toIndex]!;
  const now = new Date();
  return {
    ...state,
    version: state.version + 1,
    current: { key: step.key, index: toIndex, owner: step.owner, enteredAt: now },
    history: [...state.history, { key: step.key, at: now, by: actor, note }],
  };
}

export function assertCurrent(state: WorkflowState | undefined, key: string): void {
  if (!state || state.current.key !== key) {
    throw conflict('step/invalid', `Order is not in the "${key}" step.`, {
      details: { current: state?.current.key ?? null },
    });
  }
}
