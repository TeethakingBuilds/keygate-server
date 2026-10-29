import { describe, expect, it } from 'vitest';

import { DecisionEngine, type DecisionRequest } from '../src/domain/decide.js';
import { LedgerMirror } from '../src/domain/mirror.js';
import type { Grant, Triple } from '../src/domain/types.js';

const HOLDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OTHER = 'GBLOP36QIWTFK74QJPIHQVV6J7Q4F3H6ZSNHJHBNZBLWFBPLHFXV6KZP';
const ISSUER = 'GDQRPVCOFKBQFTABGK36XGPRW6H6FJ6X6C3K5N3X4R3T2F2KQX7QAAAA';
const VAULT: Triple = { resource: 'vault:main', action: 'withdraw' };

const NOW = 2_000;
const EVENT_AT = 1_000;
const MAX_STALENESS = 120;

function grant(overrides: Partial<Grant> = {}): Grant {
  return { id: 1, holder: HOLDER, issuer: ISSUER, triple: VAULT, expiresAt: 10_000, ...overrides };
}

/**
 * Mirror as it looks after a sync that finished at `observedAt`: `vault:main`/
 * `withdraw` is allowed by rule, `holder` holds a live capability, and the
 * resource has a 1_000-per-hour budget starting at 1_000.
 *
 * `observedAt` is separate from the event times because the chain keeps closing
 * ledgers whether or not keygate was used; a decision service that treated the
 * last *interesting* event as the last *known* one would deny everything during a
 * quiet afternoon.
 */
function synced(
  options: {
    withGrant?: boolean;
    withBudget?: boolean;
    applyRule?: boolean;
    observedAt?: number;
  } = {},
) {
  const { withGrant = true, withBudget = true, applyRule = true, observedAt = NOW } = options;
  const mirror = new LedgerMirror();
  if (applyRule) {
    mirror.apply({ kind: 'rule_set', triple: VAULT, effect: 'allow' }, EVENT_AT);
  }
  if (withGrant) {
    mirror.apply({ kind: 'grant_issued', grant: grant() }, EVENT_AT);
  }
  if (withBudget) {
    mirror.apply(
      { kind: 'budget_configured', resource: VAULT.resource, limit: 1_000n, windowSeconds: 3_600 },
      EVENT_AT,
    );
  }
  mirror.markObserved(observedAt);
  return {
    mirror,
    engine: new DecisionEngine(mirror, { maxStalenessSeconds: MAX_STALENESS }),
  };
}

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return { holder: HOLDER, triple: VAULT, ...overrides };
}

describe('DecisionEngine fail-closed preconditions', () => {
  it('refuses to answer before the first sync', () => {
    const engine = new DecisionEngine(new LedgerMirror(), { maxStalenessSeconds: MAX_STALENESS });
    const decision = engine.decide(request(), NOW);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('state_unsynced');
      // No grant id may leak from a decision that could not have looked.
      expect(decision.grantId).toBeNull();
    }
  });

  it('refuses when the mirror has fallen behind', () => {
    const { engine } = synced();
    const decision = engine.decide(request(), NOW + MAX_STALENESS + 1);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('state_stale');
    }
  });

  it('answers at exactly the staleness limit', () => {
    const { engine } = synced();
    expect(engine.decide(request(), NOW + MAX_STALENESS).allowed).toBe(true);
  });

  it('keeps answering while the chain is quiet', () => {
    // Nothing keygate-related happened since 1_000, but ledgers keep closing, so
    // the mirror is current rather than stale.
    const { engine } = synced({ observedAt: 4_000 });
    const decision = engine.decide(request(), 4_000);

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.grantId).toBe(1);
    }
  });

  it('does not let staleness be mistaken for a missing capability', () => {
    // The distinction matters operationally: one is an incident, the other is a
    // normal "no".
    const { engine } = synced();
    const stale = engine.decide(request(), 999_999);
    const missing = synced().engine.decide(request({ holder: OTHER }), NOW);

    expect(!stale.allowed && stale.reason).toBe('state_stale');
    expect(!missing.allowed && missing.reason).toBe('capability_missing');
  });
});

describe('DecisionEngine policy precedence', () => {
  it('denies by default when nothing has been configured', () => {
    const { engine } = synced({ applyRule: false });
    const decision = engine.decide(request(), NOW);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('policy_denied');
    }
  });

  it('honours a deny rule over a live capability', () => {
    const { mirror, engine } = synced();
    // An incident rule added after the grant must take effect immediately.
    mirror.apply({ kind: 'rule_set', triple: VAULT, effect: 'deny' }, 1_500);

    const decision = engine.decide(request(), NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('policy_denied');
    }
  });

  it('lets an allow default carry a capability with no rule', () => {
    const { mirror, engine } = synced({ applyRule: false });
    mirror.apply({ kind: 'default_effect', effect: 'allow' }, 1_500);

    expect(engine.decide(request(), NOW).allowed).toBe(true);
  });
});

describe('DecisionEngine capability checks', () => {
  it('denies someone with no grant', () => {
    const decision = synced().engine.decide(request({ holder: OTHER }), NOW);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('capability_missing');
    }
  });

  it('denies an expired grant and reports no capability', () => {
    const { engine } = synced({ observedAt: 10_000 });
    const decision = engine.decide(request(), 10_000);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('capability_missing');
    }
  });

  it('allows and echoes the grant identity when everything checks out', () => {
    const decision = synced().engine.decide(request(), NOW);

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.grantId).toBe(1);
      expect(decision.expiresAt).toBe(10_000);
      expect(decision.evaluatedAt).toBe(NOW);
      // No amount was requested, so no budget was accounted.
      expect(decision.budget).toBeNull();
    }
  });
});

describe('DecisionEngine budget accounting', () => {
  function withUsage(used: bigint, extra: { tripped?: boolean; observedAt?: number } = {}) {
    const { mirror, engine } = synced({ observedAt: extra.observedAt ?? NOW });
    mirror.apply(
      { kind: 'budget_charged', resource: VAULT.resource, windowStart: EVENT_AT, used },
      1_500,
    );
    if (extra.tripped === true) {
      mirror.apply({ kind: 'budget_tripped', resource: VAULT.resource }, 1_600);
    }
    return engine;
  }

  it('denies a charge for a resource with no budget at all', () => {
    // keygate-core's enforce() would itself fail on an unconfigured resource,
    // so an approval here would be a promise the chain cannot keep.
    const decision = synced({ withBudget: false }).engine.decide(request({ amount: 10n }), NOW);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('budget_unconfigured');
      expect(decision.grantId).toBe(1);
    }
  });

  it('refuses a non-positive charge', () => {
    const { engine } = synced();
    for (const amount of [0n, -1n]) {
      const decision = engine.decide(request({ amount }), NOW);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('amount_invalid');
      }
    }
  });

  it('allows within the limit and reports what is left', () => {
    const decision = withUsage(400n).decide(request({ amount: 500n }), NOW);

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.budget).toEqual({
        resource: 'vault:main',
        // 1_000 limit with 400 already charged: the headroom is reported before
        // this charge, since nothing is reserved off-chain.
        remaining: '600',
        requested: '500',
        windowSeconds: 3_600,
      });
    }
  });

  it('allows spending exactly up to the limit', () => {
    expect(withUsage(400n).decide(request({ amount: 600n }), NOW).allowed).toBe(true);
  });

  it('denies the charge that would breach, because on-chain it would latch', () => {
    const decision = withUsage(400n).decide(request({ amount: 601n }), NOW);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('budget_exhausted');
    }
  });

  it('prefers a trip over the arithmetic', () => {
    const decision = withUsage(0n, { tripped: true }).decide(request({ amount: 1n }), NOW);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('budget_tripped');
    }
  });

  it('forgives usage once the window has rolled over', () => {
    // Charged 900 of 1000 in the window that opened at 1_000; by 5_000 the hourly
    // window has restarted, so the same amount is affordable again.
    const decision = withUsage(900n, { observedAt: 5_000 }).decide(
      request({ amount: 900n }),
      5_000,
    );
    expect(decision.allowed).toBe(true);
  });

  it('still denies usage after rollover when the latch is set', () => {
    const decision = withUsage(900n, { tripped: true, observedAt: 99_000 }).decide(
      request({ amount: 1n }),
      99_000,
    );
    expect(decision.allowed).toBe(false);
  });
});
