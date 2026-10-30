/**
 * The decision engine: one place where the mirror's projections are combined
 * into an allow/deny answer, and where every failure mode is required to be
 * explicit.
 *
 * The ordering is not arbitrary. Policy is evaluated before capability so that
 * an incident-time `deny` rule costs nothing and cannot be bypassed by a
 * freshly issued grant. Staleness is evaluated before everything, because a
 * lagging mirror cannot prove absence of a revocation — the service would be
 * answering with last week's answer.
 */
import type { LedgerMirror } from './mirror.js';
import type { Address, Budget, Grant, Timestamp, Triple } from './types.js';

export type DenialReason =
  /** The mirror has not caught up, so no claim below can be trusted. */
  | 'state_stale'
  /** The mirror has never completed a sync. */
  | 'state_unsynced'
  /** A policy rule, or the default effect, forbids the action outright. */
  | 'policy_denied'
  /** No grant exists for this (resource, action, holder). */
  | 'capability_missing'
  /** The caller asked to charge zero or a negative amount. */
  | 'amount_invalid'
  /** The resource's breaker is latched closed. */
  | 'budget_tripped'
  /** The amount would cross the window limit, which would trip the breaker. */
  | 'budget_exhausted'
  /** An amount was requested for a resource that has no configured budget. */
  | 'budget_unconfigured';

export interface DecisionRequest {
  readonly holder: Address;
  readonly triple: Triple;
  /**
   * When present, the decision also accounts for the circuit breaker, because
   * the caller intends to charge this amount. Omit it for a pure "may they?"
   * question.
   */
  readonly amount?: bigint;
}

export interface AllowedDecision {
  readonly allowed: true;
  readonly reason: null;
  readonly grantId: number;
  readonly expiresAt: Timestamp;
  readonly budget: BudgetSummary | null;
  readonly evaluatedAt: Timestamp;
}

export interface DeniedDecision {
  readonly allowed: false;
  readonly reason: DenialReason;
  readonly grantId: number | null;
  readonly evaluatedAt: Timestamp;
}

export type Decision = AllowedDecision | DeniedDecision;

export interface BudgetSummary {
  readonly resource: string;
  /**
   * Headroom in the current window *before* this charge. The decision service
   * does not reserve anything — only the on-chain `enforce()` moves a counter —
   * so two callers approved for the whole remainder in the same instant will see
   * one of them trip the breaker. Reporting a post-charge figure would suggest a
   * reservation that was never made.
   */
  readonly remaining: string;
  /** The amount this decision approved, as a decimal string. */
  readonly requested: string;
  readonly windowSeconds: number;
}

export interface DecisionConfig {
  /** Maximum acceptable event age before decisions fail closed. */
  readonly maxStalenessSeconds: number;
}

export class DecisionEngine {
  constructor(
    private readonly mirror: LedgerMirror,
    private readonly config: DecisionConfig,
  ) {}

  decide(request: DecisionRequest, now: Timestamp): Decision {
    const { holder, triple } = request;

    if (!this.mirror.ready) {
      return this.deny('state_unsynced', null, now);
    }
    const staleness = this.mirror.staleness(now);
    if (staleness === undefined || staleness > this.config.maxStalenessSeconds) {
      return this.deny('state_stale', null, now);
    }

    const effect = this.mirror.ruleFor(triple) ?? this.mirror.defaultEffect;
    if (effect === 'deny') {
      return this.deny('policy_denied', null, now);
    }

    const grant = this.mirror.liveGrant(triple, holder, now);
    if (grant === undefined) {
      return this.deny('capability_missing', null, now);
    }

    if (request.amount === undefined) {
      return this.allow(grant, null, now);
    }
    if (request.amount <= 0n) {
      // Mirror keygate-core's InvalidAmount: a non-positive charge is a bug in
      // the caller, not a policy outcome.
      return this.deny('amount_invalid', grant.id, now);
    }

    const budget = this.mirror.budget(triple.resource, now);
    if (budget === undefined) {
      // The breaker would refuse the call outright: enforce() on an
      // unconfigured resource errors, so approving it here would be a promise
      // the chain cannot keep.
      return this.deny('budget_unconfigured', grant.id, now);
    }
    if (budget.tripped) {
      return this.deny('budget_tripped', grant.id, now);
    }
    if (budget.used + request.amount > budget.limit) {
      // Refusing here is the polite version of what the chain does: an attempt
      // that crosses the limit latches the breaker as well, so if this request
      // were forwarded the next one would be denied as `budget_tripped`.
      return this.deny('budget_exhausted', grant.id, now);
    }

    return this.allow(grant, summarise(budget, request.amount), now);
  }

  private allow(grant: Grant, budget: BudgetSummary | null, now: Timestamp): Decision {
    return {
      allowed: true,
      reason: null,
      grantId: grant.id,
      expiresAt: grant.expiresAt,
      budget,
      evaluatedAt: now,
    };
  }

  private deny(reason: DenialReason, grantId: number | null, now: Timestamp): Decision {
    return { allowed: false, reason, grantId, evaluatedAt: now };
  }
}

function summarise(budget: Budget, requested: bigint): BudgetSummary {
  return {
    resource: budget.resource,
    remaining: (budget.limit - budget.used).toString(),
    requested: requested.toString(),
    windowSeconds: budget.windowSeconds,
  };
}
