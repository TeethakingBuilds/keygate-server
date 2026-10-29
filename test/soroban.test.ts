/**
 * These tests lift real `xdr.ScVal` values, so they are the check that the
 * assumptions in `soroban.ts` about js-xdr's union shape and StrKey encoding
 * hold against the pinned SDK — the part of the boundary that a fake cannot
 * prove.
 */
import { Keypair, StrKey, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { decodeEvent } from '../src/ledger/decoder.js';
import { scValToNode, toTimestamp } from '../src/ledger/soroban.js';

const ACCOUNT = Keypair.random().publicKey();
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 9));

function symbol(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: 'symbol' });
}

/**
 * Map entries are real `ScMapEntry` structs here, not object literals, because
 * that is what js-xdr hands back when it decodes an event: their fields are
 * accessor methods, and a literal would test a shape the server never sees.
 */
function entry(key: xdr.ScVal, value: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key, val: value });
}

describe('scValToNode', () => {
  it('lifts symbols and strings to distinct kinds', () => {
    expect(scValToNode(symbol('withdraw'))).toEqual({ kind: 'symbol', value: 'withdraw' });
    expect(scValToNode(nativeToScVal('vault:main', { type: 'string' }))).toEqual({
      kind: 'string',
      value: 'vault:main',
    });
  });

  it('lifts unsigned and signed integers to bigints', () => {
    expect(scValToNode(nativeToScVal(4_000n, { type: 'u64' }))).toEqual({
      kind: 'u64',
      value: 4_000n,
    });
    expect(scValToNode(nativeToScVal(-1_100n, { type: 'i128' }))).toEqual({
      kind: 'i128',
      value: -1_100n,
    });
    expect(scValToNode(nativeToScVal(7, { type: 'u32' }))).toEqual({ kind: 'u32', value: 7 });
  });

  it('lifts booleans and void', () => {
    expect(scValToNode(xdr.ScVal.scvBool(true))).toEqual({ kind: 'bool', value: true });
    expect(scValToNode(xdr.ScVal.scvBool(false))).toEqual({ kind: 'bool', value: false });
    expect(scValToNode(xdr.ScVal.scvVoid())).toEqual({ kind: 'void' });
  });

  it('renders account addresses as G… strkeys', () => {
    expect(scValToNode(nativeToScVal(ACCOUNT, { type: 'address' }))).toEqual({
      kind: 'address',
      value: ACCOUNT,
    });
  });

  it('renders contract addresses as C… strkeys', () => {
    expect(scValToNode(nativeToScVal(CONTRACT, { type: 'address' }))).toEqual({
      kind: 'address',
      value: CONTRACT,
    });
  });

  it('recurses into vectors and maps', () => {
    const vector = xdr.ScVal.scvVec([symbol('a'), nativeToScVal(1n, { type: 'u64' })]);
    expect(scValToNode(vector)).toEqual({
      kind: 'vec',
      value: [
        { kind: 'symbol', value: 'a' },
        { kind: 'u64', value: 1n },
      ],
    });

    const mapping = xdr.ScVal.scvMap([entry(symbol('id'), nativeToScVal(3n, { type: 'u64' }))]);
    expect(scValToNode(mapping)).toEqual({
      kind: 'map',
      value: [
        [
          { kind: 'symbol', value: 'id' },
          { kind: 'u64', value: 3n },
        ],
      ],
    });
  });

  it('tags scalars keygate does not use instead of coercing them', () => {
    const node = scValToNode(xdr.ScVal.scvLedgerKeyContractInstance());
    expect(node.kind).toBe('other');
  });
});

describe('an encoded keygate-core event decodes end to end', () => {
  const grantMap = xdr.ScVal.scvMap([
    entry(symbol('id'), nativeToScVal(7n, { type: 'u64' })),
    entry(symbol('resource'), nativeToScVal('vault:main', { type: 'string' })),
    entry(symbol('action'), symbol('withdraw')),
    entry(symbol('holder'), nativeToScVal(ACCOUNT, { type: 'address' })),
    entry(symbol('issuer'), nativeToScVal(CONTRACT, { type: 'address' })),
    entry(symbol('expires_at'), nativeToScVal(10_000n, { type: 'u64' })),
  ]);

  /**
   * Soroban RPC hands events over as base64 XDR, so the lifting is fed through
   * the same encode/decode cycle rather than an in-memory ScVal.
   */
  function overTheWire(value: xdr.ScVal): xdr.ScVal {
    return xdr.ScVal.fromXDR(value.toXDR('base64'), 'base64');
  }

  it('produces the domain event the mirror consumes', () => {
    const decoded = decodeEvent(
      'core',
      {
        topics: [symbol('issued'), nativeToScVal(ACCOUNT, { type: 'address' })].map(scValToNode),
        data: scValToNode(overTheWire(grantMap)),
      },
      9_000,
    );

    expect(decoded).toEqual({
      kind: 'grant_issued',
      grant: {
        id: 7,
        triple: { resource: 'vault:main', action: 'withdraw' },
        holder: ACCOUNT,
        issuer: CONTRACT,
        expiresAt: 10_000,
      },
    });
  });
});

describe('toTimestamp', () => {
  it('converts an ISO ledger close time to epoch seconds', () => {
    expect(toTimestamp('2026-10-29T00:00:00Z')).toBe(
      Math.floor(Date.parse('2026-10-29T00:00:00Z') / 1000),
    );
  });

  it('rejects an unreadable time rather than yielding NaN', () => {
    expect(() => toTimestamp('not-a-date')).toThrow(TypeError);
  });
});
