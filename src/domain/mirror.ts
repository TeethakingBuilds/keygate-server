/**
 * The local mirror of on-chain keygate state.
 *
 * It is a projection, not a source of truth: it only ever applies events the
 * network produced, in order. Two consequences shape the code:
 *
 * - **Absence is not proof.** A holder missing from the mirror may simply not
 *   have been indexed yet, so `ready` stays false until the first sync.
 * - **Expiry is reclaimed lazily**, exactly as keygate-core does on-chain. A
 *   lookup past `expiresAt` drops the record instead of trusting it.
 */
import {
  tripleKey,
  capabilityKey,
  type Address,
  type Budget,
  type Effect,
  type Grant,
  type LedgerEvent,
  type Timestamp,
  type Triple,
} from './types.js';

export interface MirrorSnapshot {
  readonly ready: boolean;
  readonly grants: number;
  readonly rules: number;
  readonly budgets: number;
  readonly defaultEffect: Effect;
  readonly registryPaused: boolean;
  readonly lastAppliedAt: Timestamp | undefined;
  readonly lastObservedAt: Timestamp | undefined;
  readonly appliedEvents: number;
}

export class LedgerMirror {
  private readonly grantsById = new Map<number, Grant>();
  private readonly idsByCapability = new Map<string, number>();
  private readonly ruleEffects = new Map<string, Effect>();
  private readonly budgets = new Map<string, MutableBudget>();

  private defaultEffectValue: Effect = 'deny';
  private registryPausedValue = false;
  private adminValue: Address | undefined;
  private lastAppliedAtValue: Timestamp | undefined;
  private lastObservedAtValue: Timestamp | undefined;
  private appliedValue = 0;

  /**
   * Applies one decoded event. `at` is the ledger timestamp of the closing
   * ledger, used for staleness and window maths — never the local wall clock,
   * because a decision service must age against the network's clock.
   */
  apply(event: LedgerEvent, at: Timestamp): void {
    switch (event.kind) {
      case 'grant_issued':
      case 'grant_renewed': {
        const key = capabilityKey(event.grant.triple, event.grant.holder);
        const previous = this.idsByCapability.get(key);
        if (previous !== undefined && previous !== event.grant.id) {
          // Renewal keeps the id on-chain; a different id for the same
          // capability means two writers, which must not be silently merged.
          this.grantsById.delete(previous);
        }
        this.grantsById.set(event.grant.id, event.grant);
        this.idsByCapability.set(key, event.grant.id);
        break;
      }
      case 'grant_revoked':
      case 'grant_expired': {
        const { id, triple, holder } = event.grant;
        this.grantsById.delete(id);
        const key = capabilityKey(triple, holder);
        // Only unbind the capability if it still points at this grant; a newer
        // issue for the same triple owns the slot now.
        if (this.idsByCapability.get(key) === id) {
          this.idsByCapability.delete(key);
        }
        break;
      }
      case 'rule_set': {
        this.ruleEffects.set(tripleKey(event.triple), event.effect);
        break;
      }
      case 'rule_removed': {
        this.ruleEffects.delete(tripleKey(event.triple));
        break;
      }
      case 'default_effect': {
        this.defaultEffectValue = event.effect;
        break;
      }
      case 'budget_configured': {
        const existing = this.budgets.get(event.resource);
        this.budgets.set(event.resource, {
          resource: event.resource,
          limit: event.limit,
          windowSeconds: event.windowSeconds,
          // Re-configuring a limit must not forgive a trip, and must not
          // discard usage the network has already charged.
          used: existing?.used ?? 0n,
          tripped: existing?.tripped ?? false,
          windowStart: existing?.windowStart ?? at,
        });
        break;
      }
      case 'budget_charged': {
        const existing = this.budgets.get(event.resource);
        if (existing === undefined) {
          // A charge for an unknown resource means the mirror missed the
          // configuration event. Record the usage anyway rather than dropping
          // it: `used` is what makes a later decision deny.
          this.budgets.set(event.resource, {
            resource: event.resource,
            limit: 0n,
            windowSeconds: 0,
            used: event.used,
            tripped: false,
            windowStart: event.windowStart,
          });
        } else {
          existing.used = event.used;
          existing.windowStart = event.windowStart;
          // A charge only happens on the success path, so a latch set after it
          // must not be undone here.
        }
        break;
      }
      case 'budget_tripped': {
        const budget = this.budgets.get(event.resource);
        if (budget) {
          budget.tripped = true;
        } else {
          this.budgets.set(event.resource, {
            resource: event.resource,
            limit: 0n,
            windowSeconds: 0,
            used: 0n,
            tripped: true,
            windowStart: at,
          });
        }
        break;
      }
      case 'budget_reset': {
        const existing = this.budgets.get(event.resource);
        this.budgets.set(event.resource, {
          resource: event.resource,
          limit: existing?.limit ?? 0n,
          windowSeconds: existing?.windowSeconds ?? 0,
          used: 0n,
          tripped: false,
          windowStart: event.at,
        });
        break;
      }
      case 'registry_paused': {
        this.registryPausedValue = event.paused;
        break;
      }
      case 'admin_changed': {
        this.adminValue = event.address;
        break;
      }
    }

    this.appliedValue += 1;
    this.lastAppliedAtValue = at;
  }

  /**
   * Records that the network was polled successfully at `at`, even though nothing
   * keygate-related happened. Without it an idle registry would age out of the
   * staleness budget and every decision would fail closed while the mirror was in
   * fact perfectly current.
   */
  markObserved(at: Timestamp): void {
    this.lastObservedAtValue = Math.max(this.lastObservedAtValue ?? at, at);
  }

  /** True once a sync has populated or observed the mirror. */
  get ready(): boolean {
    return this.appliedValue > 0 || this.lastObservedAtValue !== undefined;
  }

  /**
   * The live grant for a capability, or undefined. Expired grants are pruned on
   * read rather than by a sweeper, mirroring on-chain behaviour.
   */
  liveGrant(triple: Triple, holder: Address, now: Timestamp): Grant | undefined {
    const key = capabilityKey(triple, holder);
    const id = this.idsByCapability.get(key);
    if (id === undefined) {
      return undefined;
    }
    const grant = this.grantsById.get(id);
    if (grant === undefined) {
      this.idsByCapability.delete(key);
      return undefined;
    }
    if (grant.expiresAt <= now) {
      this.grantsById.delete(id);
      this.idsByCapability.delete(key);
      return undefined;
    }
    return grant;
  }

  /** Grants held by `holder` that have not expired as of `now`. */
  capabilitiesOf(holder: Address, now: Timestamp): readonly Grant[] {
    const out: Grant[] = [];
    for (const grant of this.grantsById.values()) {
      if (grant.holder === holder && grant.expiresAt > now) {
        out.push(grant);
      }
    }
    return out;
  }

  /** The configured rule for a triple, or undefined when the default applies. */
  ruleFor(triple: Triple): Effect | undefined {
    return this.ruleEffects.get(tripleKey(triple));
  }

  get defaultEffect(): Effect {
    return this.defaultEffectValue;
  }

  /**
   * Budget as of `now`, with a latched trip overriding window arithmetic: time
   * passing never re-opens a resource that breached.
   */
  budget(resource: string, now: Timestamp): Budget | undefined {
    const stored = this.budgets.get(resource);
    if (stored === undefined) {
      return undefined;
    }
    const rolled = !stored.tripped && now >= stored.windowStart + stored.windowSeconds;
    return {
      resource: stored.resource,
      limit: stored.limit,
      windowSeconds: stored.windowSeconds,
      used: rolled ? 0n : stored.used,
      tripped: stored.tripped,
      windowStart: rolled ? now : stored.windowStart,
    };
  }

  get registryPaused(): boolean {
    return this.registryPausedValue;
  }

  get admin(): Address | undefined {
    return this.adminValue;
  }

  /**
   * Age of the newest thing the mirror can vouch for: an applied event or a
   * completed poll, whichever is later. Undefined when neither has happened,
   * which is what makes cold-start fail closed.
   */
  staleness(now: Timestamp): number | undefined {
    const seen = Math.max(this.lastAppliedAtValue ?? -1, this.lastObservedAtValue ?? -1);
    if (seen < 0) {
      return undefined;
    }
    return Math.max(0, now - seen);
  }

  snapshot(now: Timestamp): MirrorSnapshot {
    let live = 0;
    for (const grant of this.grantsById.values()) {
      if (grant.expiresAt > now) {
        live += 1;
      }
    }
    return {
      ready: this.ready,
      grants: live,
      rules: this.ruleEffects.size,
      budgets: this.budgets.size,
      defaultEffect: this.defaultEffectValue,
      registryPaused: this.registryPausedValue,
      lastAppliedAt: this.lastAppliedAtValue,
      lastObservedAt: this.lastObservedAtValue,
      appliedEvents: this.appliedValue,
    };
  }

  /** Drops every projection. The next sync must repopulate before decisions resume. */
  clear(): void {
    this.grantsById.clear();
    this.idsByCapability.clear();
    this.ruleEffects.clear();
    this.budgets.clear();
    this.defaultEffectValue = 'deny';
    this.registryPausedValue = false;
    this.adminValue = undefined;
    this.lastAppliedAtValue = undefined;
    this.lastObservedAtValue = undefined;
    this.appliedValue = 0;
  }
}

/** Internals are mutable; only the frozen `Budget` shape leaves the mirror. */
interface MutableBudget {
  resource: string;
  limit: bigint;
  windowSeconds: number;
  used: bigint;
  tripped: boolean;
  windowStart: Timestamp;
}
