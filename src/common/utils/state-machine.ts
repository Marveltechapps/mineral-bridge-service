import { conflict } from '../errors/app-error.js';

/**
 * Declarative state machine. `assert` throws `409` with a stable code when a transition is not
 * permitted, so every service enforces the same rules (ARCHITECTURE §7).
 */
export class StateMachine<S extends string> {
  constructor(
    readonly name: string,
    private readonly transitions: Record<S, readonly S[]>,
    private readonly conflictCode: string,
  ) {}

  can(from: S, to: S): boolean {
    return this.transitions[from]?.includes(to) ?? false;
  }

  assert(from: S, to: S, message?: string): void {
    if (!this.can(from, to)) {
      throw conflict(this.conflictCode, message ?? `${this.name}: cannot move from '${from}' to '${to}'`, {
        current: { state: from },
      });
    }
  }

  /** Statuses from which `to` is reachable; useful for building atomic `{status: {$in}}` filters. */
  sourcesOf(to: S): S[] {
    return (Object.keys(this.transitions) as S[]).filter((from) => this.can(from, to));
  }

  isTerminal(state: S): boolean {
    return (this.transitions[state]?.length ?? 0) === 0;
  }
}
