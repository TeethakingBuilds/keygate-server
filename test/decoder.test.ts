import { describe, expect, it } from 'vitest';

import { DecodeError, decodeEvent, type RawEvent, type ScNode } from '../src/ledger/decoder.js';

const HOLDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ISSUER = 'GDQRPVCOFKBQFTABGK36XGPRW6H6FJ6X6C3K5N3X4R3T2F2KQX7QAAAA';
const ADMIN = 'GCXDR4QF4BXOSJHMOMWKSYLTMJPTHGZ3E4Q6Q6Y5W2N2VVDKZBQAAAAA';

const sym = (value: string): ScNode => ({ kind: 'symbol', value });
const str = (value: string): ScNode => ({ kind: 'string', value });
const addr = (value: string): ScNode => ({ kind: 'address', value });
const u64 = (value: bigint): ScNode => ({ kind: 'u64', value });
const i128 = (value: bigint): ScNode => ({ kind: 'i128', value });
const bool = (value: boolean): ScNode => ({ kind: 'bool', value });
const vec = (...value: ScNode[]): ScNode => ({ kind: 'vec', value });
/** Mirrors how a Soroban `#[contracttype] struct` is encoded: a symbol-keyed map. */
const map = (fields: Record<string, ScNode>): ScNode => ({
  kind: 'map',
  value: Object.entries(fields).map(([key, value]) => [sym(key), value] as const),
});

function event(topic: string, data: ScNode, topicAddress?: ScNode): RawEvent {
  return {
    topics: topicAddress === undefined ? [sym(topic)] : [sym(topic), topicAddress],
    data,
  };
}

const grantData = map({
  id: u64(7n),
  resource: str('vault:main'),
  action: str('withdraw'),
  holder: addr(HOLDER),
  issuer: addr(ISSUER),
  expires_at: u64(10_000n),
});

describe('decodeEvent: keygate-core', () => {
  it('reads an issued grant struct', () => {
    expect(decodeEvent('core', event('issued', grantData, addr(HOLDER)), 9_000)).toEqual({
      kind: 'grant_issued',
      grant: {
        id: 7,
        triple: { resource: 'vault:main', action: 'withdraw' },
        holder: HOLDER,
        issuer: ISSUER,
        expiresAt: 10_000,
      },
    });
  });

  it('distinguishes renewal, revocation and lazy expiry', () => {
    expect(decodeEvent('core', event('renewed', grantData), 0)?.kind).toBe('grant_renewed');
    expect(decodeEvent('core', event('revoked', grantData), 0)?.kind).toBe('grant_revoked');
    expect(decodeEvent('core', event('expired', grantData), 0)?.kind).toBe('grant_expired');
  });

  it('maps the freeze switch', () => {
    expect(decodeEvent('core', event('paused', { kind: 'void' }), 0)).toEqual({
      kind: 'registry_paused',
      paused: true,
    });
    expect(decodeEvent('core', event('unpause', { kind: 'void' }), 0)).toEqual({
      kind: 'registry_paused',
      paused: false,
    });
  });

  it('maps an accepted admin handover', () => {
    expect(decodeEvent('core', event('admin', addr(ADMIN)), 0)).toEqual({
      kind: 'admin_changed',
      address: ADMIN,
    });
  });

  it('accepts a symbol where a string is expected', () => {
    const withSymbols = map({
      ...{
        id: u64(1n),
        resource: sym('vault'),
        action: sym('read'),
        holder: addr(HOLDER),
        issuer: addr(ISSUER),
        expires_at: u64(5n),
      },
    });
    const decoded = decodeEvent('core', event('issued', withSymbols), 0);
    expect(decoded?.kind === 'grant_issued' && decoded.grant.triple).toEqual({
      resource: 'vault',
      action: 'read',
    });
  });
});

describe('decodeEvent: keygate-policy', () => {
  it('reads the allow flag from a rule_set tuple', () => {
    expect(
      decodeEvent(
        'policy',
        event('rule_set', vec(str('vault:main'), str('withdraw'), bool(true))),
        0,
      ),
    ).toEqual({
      kind: 'rule_set',
      triple: { resource: 'vault:main', action: 'withdraw' },
      effect: 'allow',
    });
  });

  it('reads a deny rule and its removal', () => {
    expect(
      decodeEvent('policy', event('rule_set', vec(str('a'), str('b'), bool(false))), 0)?.kind,
    ).toBe('rule_set');
    expect(decodeEvent('policy', event('rule_del', vec(str('a'), str('b'))), 0)).toEqual({
      kind: 'rule_removed',
      triple: { resource: 'a', action: 'b' },
    });
  });

  it('reads the default effect', () => {
    expect(decodeEvent('policy', event('default', bool(true)), 0)).toEqual({
      kind: 'default_effect',
      effect: 'allow',
    });
  });
});

describe('decodeEvent: keygate-circuit-breaker', () => {
  it('reads a configured budget', () => {
    expect(
      decodeEvent('breaker', event('cb_cfg', vec(str('vault:main'), i128(1_000n), u64(3_600n))), 0),
    ).toEqual({
      kind: 'budget_configured',
      resource: 'vault:main',
      limit: 1_000n,
      windowSeconds: 3_600,
    });
  });

  it('reads a successful charge with its window anchor', () => {
    expect(
      decodeEvent('breaker', event('cb_use', vec(str('vault:main'), u64(1_000n), i128(400n))), 0),
    ).toEqual({
      kind: 'budget_charged',
      resource: 'vault:main',
      windowStart: 1_000,
      used: 400n,
    });
  });

  it('reads both trip causes as the same projection', () => {
    const breach = decodeEvent(
      'breaker',
      event('cb_trip', vec(str('vault:main'), i128(1_000n), i128(1_100n))),
      0,
    );
    const forced = decodeEvent('breaker', event('cb_force', str('vault:main')), 0);

    expect(breach).toEqual({ kind: 'budget_tripped', resource: 'vault:main' });
    expect(forced).toEqual({ kind: 'budget_tripped', resource: 'vault:main' });
  });

  it('stamps a reset with the ledger time it was observed at', () => {
    expect(decodeEvent('breaker', event('cb_reset', str('vault:main')), 4_321)).toEqual({
      kind: 'budget_reset',
      resource: 'vault:main',
      at: 4_321,
    });
  });
});

describe('decodeEvent: robustness', () => {
  it('ignores unknown topics instead of throwing', () => {
    // A contract upgrade that emits new events must not stall a running indexer.
    expect(decodeEvent('core', event('something_new', grantData), 0)).toBeNull();
    expect(decodeEvent('breaker', event('init', addr(ADMIN)), 0)).toBeNull();
  });

  it('ignores events with no symbol topic', () => {
    expect(decodeEvent('core', { topics: [], data: grantData }, 0)).toBeNull();
    expect(decodeEvent('core', { topics: [str('issued')], data: grantData }, 0)).toBeNull();
  });

  it('does not confuse a core topic with a policy one', () => {
    // Both contracts use short symbols; the role is what disambiguates.
    expect(decodeEvent('policy', event('issued', grantData), 0)).toBeNull();
    expect(
      decodeEvent('core', event('rule_set', vec(str('a'), str('b'), bool(true))), 0),
    ).toBeNull();
  });

  it('reports which field made a payload undecodable', () => {
    const missingExpiry = map({
      id: u64(1n),
      resource: str('vault:main'),
      action: str('withdraw'),
      holder: addr(HOLDER),
      issuer: addr(ISSUER),
    });
    expect(() => decodeEvent('core', event('issued', missingExpiry), 0)).toThrow(DecodeError);
    expect(() => decodeEvent('core', event('issued', missingExpiry), 0)).toThrow(/expires_at/);
  });

  it('rejects a struct payload that is really a vector', () => {
    expect(() => decodeEvent('core', event('issued', vec(u64(1n))), 0)).toThrow(/not a struct/);
  });

  it('rejects a short tuple', () => {
    expect(() => decodeEvent('policy', event('rule_set', vec(str('a'))), 0)).toThrow(
      /shorter than/,
    );
  });

  it('surfaces an unsupported scalar rather than coercing it', () => {
    const node: ScNode = { kind: 'other', tag: 'scvTimepoint' };
    expect(() => decodeEvent('policy', event('default', node), 0)).toThrow(/not a boolean/);
  });
});
