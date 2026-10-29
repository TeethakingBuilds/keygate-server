import { describe, expect, it } from 'vitest';

import { LedgerMirror } from '../src/domain/mirror.js';
import type { Grant, LedgerEvent } from '../src/domain/types.js';

const HOLDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OTHER = 'GBLOP36QIWTFK74QJPIHQVV6J7Q4F3H6ZSNHJHBNZBLWFBPLHFXV6KZP';
const ISSUER = 'GDQRPVCOFKBQFTABGK36XGPRW6H6FJ6X6C3K5N3X4R3T2F2KQX7QAAAA';
const VAULT = { resource: 'vault:main', action: 'withdraw' };

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: 1,
    holder: HOLDER,
    issuer: ISSUER,
    triple: VAULT,
    expiresAt: 3_600,
    ...overrides,
  };
}

function issued(overrides: Partial<Grant> = {}): LedgerEvent {
  return { kind: 'grant_issued', grant: grant(overrides) };
}

describe('LedgerMirror readiness', () => {
  it('is not ready before any event has been applied', () => {
    const mirror = new LedgerMirror();
    expect(mirror.ready).toBe(false);
    expect(mirror.staleness(1_000)).toBeUndefined();
    // Absence of data must not be readable as "nobody has access".
    expect(mirror.snapshot(1_000).appliedEvents).toBe(0);
  });

  it('becomes ready and tracks the newest event time', () => {
    const mirror = new LedgerMirror();
    mirror.apply(issued(), 1_000);
    expect(mirror.ready).toBe(true);
    expect(mirror.staleness(1_050)).toBe(50);
  });

  it('ages against the last poll, not the last interesting event', () => {
    const mirror = new LedgerMirror();
    mirror.apply(issued(), 1_000);
    // A registry nobody used for an hour is still fully known, and a service that
    // forgot that would deny every request until someone issued a grant.
    mirror.markObserved(4_600);

    expect(mirror.staleness(4_650)).toBe(50);
    expect(mirror.snapshot(4_650).appliedEvents).toBe(1);
  });

  it('is ready on an empty registry that has been polled', () => {
    const mirror = new LedgerMirror();
    mirror.markObserved(1_000);

    expect(mirror.ready).toBe(true);
    expect(mirror.staleness(1_000)).toBe(0);
  });

  it('ignores an observation that is older than one already recorded', () => {
    const mirror = new LedgerMirror();
    mirror.markObserved(5_000);
    mirror.markObserved(4_000);

    expect(mirror.staleness(5_000)).toBe(0);
  });

  it('never reports a negative age when an event is from the future', () => {
    const mirror = new LedgerMirror();
    mirror.apply(issued(), 5_000);
    expect(mirror.staleness(1_000)).toBe(0);
  });

  it('clears back to unsynced', () => {
    const mirror = new LedgerMirror();
    mirror.apply(issued(), 1_000);
    mirror.clear();
    expect(mirror.ready).toBe(false);
    expect(mirror.liveGrant(VAULT, HOLDER, 1_000)).toBeUndefined();
  });
});

describe('LedgerMirror capabilities', () => {
  it('resolves a live grant and misses an unknown holder', () => {
    const mirror = new LedgerMirror();
    mirror.apply(issued(), 1_000);

    expect(mirror.liveGrant(VAULT, HOLDER, 1_500)?.id).toBe(1);
    expect(mirror.liveGrant(VAULT, OTHER, 1_500)).toBeUndefined();
  });

  it('treats expiry on the boundary as gone, matching keygate-core', () => {
    const mirror = new LedgerMirror();
    mirror.apply(issued({ expiresAt: 3_600 }), 1_000);

    expect(mirror.liveGrant(VAULT, HOLDER, 3_599)).toBeDefined();
    expect(mirror.liveGrant(VAULT, HOLDER, 3_600)).toBeUndefined();
  });

  it('drops the index entry when a grant is pruned on read', () => {
    const mirror = new LedgerMirror();
    mirror.apply(issued({ expiresAt: 3_600 }), 1_000);
    mirror.liveGrant(VAULT, HOLDER, 4_000);

    // Snapshot counts live grants only, so the pruned one must not linger.
    expect(mirror.snapshot(4_000).grants).toBe(0);
    expect(mirror.capabilitiesOf(HOLDER, 4_000)).toHaveLength(0);
  });

  it('applies a renewal in place without orphaning the capability', () => {
    const mirror = new LedgerMirror();
    mirror.apply(issued({ expiresAt: 1_100 }), 1_000);
    mirror.apply({ kind: 'grant_renewed', grant: grant({ expiresAt: 9_000 }) }, 1_050);

    expect(mirror.liveGrant(VAULT, HOLDER, 5_000)?.expiresAt).toBe(9_000);
    expect(mirror.snapshot(5_000).grants).toBe(1);
  });

  it('ignores a revocation for an id that no longer owns the capability', () => {
    const mirror = new LedgerMirror();
    mirror.apply(issued({ id: 1, expiresAt: 5_000 }), 1_000);
    // Two writers: id 2 now owns the triple.
    mirror.apply({ kind: 'grant_issued', grant: grant({ id: 2, expiresAt: 9_000 }) }, 1_100);
    // Late-arriving revocation of the superseded grant.
    mirror.apply({ kind: 'grant_revoked', grant: grant({ id: 1, expiresAt: 5_000 }) }, 1_200);

    expect(mirror.liveGrant(VAULT, HOLDER, 1_300)?.id).toBe(2);
  });

  it('keeps distinct actions on one resource independent', () => {
    const mirror = new LedgerMirror();
    const read = { resource: 'vault:main', action: 'read' };
    mirror.apply({ kind: 'grant_issued', grant: grant({ triple: read }) }, 1_000);

    expect(mirror.liveGrant(read, HOLDER, 1_000)).toBeDefined();
    expect(mirror.liveGrant(VAULT, HOLDER, 1_000)).toBeUndefined();
  });

  it('lists capabilities for one holder only', () => {
    const mirror = new LedgerMirror();
    mirror.apply(issued({ id: 1 }), 1_000);
    mirror.apply({ kind: 'grant_issued', grant: grant({ id: 2, holder: OTHER }) }, 1_000);
    mirror.apply(
      { kind: 'grant_issued', grant: grant({ id: 3, triple: { ...VAULT, action: 'read' } }) },
      1_000,
    );

    expect(mirror.capabilitiesOf(HOLDER, 1_000).map((g) => g.id)).toEqual([1, 3]);
    expect(mirror.capabilitiesOf(OTHER, 1_000)).toHaveLength(1);
  });
});

describe('LedgerMirror policy projection', () => {
  it('defaults to deny until a rule says otherwise', () => {
    const mirror = new LedgerMirror();
    expect(mirror.defaultEffect).toBe('deny');
    expect(mirror.ruleFor(VAULT)).toBeUndefined();
  });

  it('tracks rules and their removal', () => {
    const mirror = new LedgerMirror();
    mirror.apply({ kind: 'rule_set', triple: VAULT, effect: 'allow' }, 1_000);
    expect(mirror.ruleFor(VAULT)).toBe('allow');

    mirror.apply({ kind: 'rule_removed', triple: VAULT }, 1_100);
    expect(mirror.ruleFor(VAULT)).toBeUndefined();

    mirror.apply({ kind: 'default_effect', effect: 'allow' }, 1_200);
    expect(mirror.defaultEffect).toBe('allow');
  });
});

describe('LedgerMirror budgets', () => {
  const configure: LedgerEvent = {
    kind: 'budget_configured',
    resource: 'vault:main',
    limit: 1_000n,
    windowSeconds: 3_600,
  };

  it('rolls the window forward lazily once it elapses', () => {
    const mirror = new LedgerMirror();
    mirror.apply(configure, 1_000);
    expect(mirror.budget('vault:main', 1_000)).toMatchObject({
      limit: 1_000n,
      used: 0n,
      windowStart: 1_000,
    });

    // Inside the window nothing changes.
    expect(mirror.budget('vault:main', 4_599)?.windowStart).toBe(1_000);
    // Past the boundary the read reports a new window anchored on `now`.
    const rolled = mirror.budget('vault:main', 9_000);
    expect(rolled?.windowStart).toBe(9_000);
    expect(rolled?.used).toBe(0n);
  });

  it('keeps a latched trip closed across the window boundary', () => {
    const mirror = new LedgerMirror();
    mirror.apply(configure, 1_000);
    mirror.apply({ kind: 'budget_tripped', resource: 'vault:main' }, 1_100);

    const latched = mirror.budget('vault:main', 999_999);
    expect(latched?.tripped).toBe(true);
    expect(latched?.windowStart).toBe(1_000);
  });

  it('reopens only on an explicit reset', () => {
    const mirror = new LedgerMirror();
    mirror.apply(configure, 1_000);
    mirror.apply({ kind: 'budget_tripped', resource: 'vault:main' }, 1_100);
    mirror.apply({ kind: 'budget_reset', resource: 'vault:main', at: 2_000 }, 2_000);

    const reopened = mirror.budget('vault:main', 2_100);
    expect(reopened?.tripped).toBe(false);
    expect(reopened?.windowStart).toBe(2_000);
  });

  it('records a trip for a resource that was never configured', () => {
    const mirror = new LedgerMirror();
    mirror.apply({ kind: 'budget_tripped', resource: 'bridge:out' }, 1_000);

    expect(mirror.budget('bridge:out', 1_000)).toMatchObject({ tripped: true, limit: 0n });
    expect(mirror.snapshot(1_000).budgets).toBe(1);
  });

  it('does not forgive a trip when the limit is reconfigured', () => {
    const mirror = new LedgerMirror();
    mirror.apply(configure, 1_000);
    mirror.apply({ kind: 'budget_tripped', resource: 'vault:main' }, 1_100);
    mirror.apply(
      { kind: 'budget_configured', resource: 'vault:main', limit: 10_000n, windowSeconds: 3_600 },
      1_200,
    );

    expect(mirror.budget('vault:main', 1_300)).toMatchObject({ tripped: true, limit: 10_000n });
  });
});

describe('LedgerMirror snapshot', () => {
  it('reports the projected state an operator needs', () => {
    const mirror = new LedgerMirror();
    mirror.apply(issued({ expiresAt: 5_000 }), 1_000);
    mirror.apply({ kind: 'rule_set', triple: VAULT, effect: 'allow' }, 1_000);
    mirror.apply(
      { kind: 'budget_configured', resource: 'vault:main', limit: 5n, windowSeconds: 60 },
      1_000,
    );
    mirror.apply({ kind: 'registry_paused', paused: true }, 1_000);
    mirror.apply({ kind: 'admin_changed', address: ISSUER }, 1_000);

    expect(mirror.snapshot(1_000)).toEqual({
      ready: true,
      grants: 1,
      rules: 1,
      budgets: 1,
      defaultEffect: 'deny',
      registryPaused: true,
      lastAppliedAt: 1_000,
      lastObservedAt: undefined,
      appliedEvents: 5,
    });
    expect(mirror.admin).toBe(ISSUER);
  });
});
