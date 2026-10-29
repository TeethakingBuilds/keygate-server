import { describe, expect, it } from 'vitest';

import type {
  AllowedDecision,
  BudgetSummary,
  Decision,
  DecisionRequest,
} from '../src/domain/decide.js';
import { canonicalDecision, signDecision, verifyDecision } from '../src/http/signing.js';

const KEY = 'a-signing-secret-worth-at-least-16-bytes';
const HOLDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OTHER = 'GBLOP36QIWTFK74QJPIHQVV6J7Q4F3H6ZSNHJHBNZBLWFBPLHFXV6KZP';
const NOW = 2_000;

function allowed(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return { holder: HOLDER, triple: { resource: 'vault:main', action: 'withdraw' }, ...overrides };
}

const BUDGET: BudgetSummary = {
  resource: 'vault:main',
  remaining: '100',
  requested: '600',
  windowSeconds: 3_600,
};

const yes: AllowedDecision = {
  allowed: true,
  reason: null,
  grantId: 7,
  expiresAt: 10_000,
  budget: BUDGET,
  evaluatedAt: NOW,
};

const no: Decision = { allowed: false, reason: 'policy_denied', grantId: null, evaluatedAt: NOW };

describe('canonicalDecision', () => {
  it('is a pure function of request and decision', () => {
    expect(canonicalDecision(allowed(), yes)).toBe(canonicalDecision(allowed(), yes));
  });

  it('cannot be confused by a resource that ends in the next field name', () => {
    // Without length prefixes these two would serialise identically: the whole
    // scheme collapses if a subject can forge a different (resource, action).
    const sneaky = allowed({ triple: { resource: 'vault:action', action: 'withdraw' } });
    const honest = allowed({ triple: { resource: 'vault', action: ':action withdraw' } });

    expect(canonicalDecision(sneaky, yes)).not.toBe(canonicalDecision(honest, yes));
  });

  it('separates "no amount" from "amount 0"', () => {
    expect(canonicalDecision(allowed(), yes)).not.toBe(
      canonicalDecision(allowed({ amount: 0n }), yes),
    );
    expect(canonicalDecision(allowed({ amount: 0n }), yes)).toContain('amount=0');
    expect(canonicalDecision(allowed(), yes)).toContain('amount=null');
  });

  it('signs the budget only when the decision carried one', () => {
    const withoutBudget: Decision = { ...yes, budget: null };
    expect(canonicalDecision(allowed(), yes)).toContain('remaining=100');
    expect(canonicalDecision(allowed(), withoutBudget)).not.toContain('remaining');
  });

  it('keeps a denial free of fields that did not apply', () => {
    const text = canonicalDecision(allowed(), no);
    expect(text).toContain('allowed=false');
    expect(text).toContain('reason=policy_denied');
    expect(text).toContain('expiresAt=null');
    expect(text).not.toContain('remaining');
    expect(text).not.toContain('budgetResource');
  });
});

describe('signDecision / verifyDecision', () => {
  it('round-trips a valid signature', () => {
    const request = allowed({ amount: 500n });
    const signature = signDecision(KEY, request, yes);

    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDecision(KEY, request, yes, signature)).toBe(true);
  });

  it('will not validate the same signature for another holder', () => {
    const signature = signDecision(KEY, allowed(), yes);
    // This is the property that matters: a cached decision must not be reusable
    // by whoever happens to ask the proxy next.
    expect(verifyDecision(KEY, allowed({ holder: OTHER }), yes, signature)).toBe(false);
  });

  it('will not validate a decision that was changed after signing', () => {
    const request = allowed();
    const signature = signDecision(KEY, request, yes);

    expect(verifyDecision(KEY, request, { ...yes, grantId: 8 }, signature)).toBe(false);
    expect(verifyDecision(KEY, request, { ...yes, evaluatedAt: NOW + 1 }, signature)).toBe(false);
    expect(
      verifyDecision(KEY, request, { ...yes, budget: { ...BUDGET, remaining: '999' } }, signature),
    ).toBe(false);
  });

  it('rejects a signature made under a different key', () => {
    const request = allowed();
    const signature = signDecision(`${KEY}-other`, request, yes);
    expect(verifyDecision(KEY, request, yes, signature)).toBe(false);
  });

  it('rejects malformed signatures rather than throwing', () => {
    const request = allowed();
    for (const bad of ['', 'zz', 'deadbeef', signDecision(KEY, request, yes) + '00']) {
      expect(verifyDecision(KEY, request, yes, bad)).toBe(false);
    }
  });

  it('signs denials too, so a "no" is equally attributable', () => {
    const request = allowed();
    const signature = signDecision(KEY, request, no);
    expect(verifyDecision(KEY, request, no, signature)).toBe(true);
    expect(verifyDecision(KEY, request, yes, signature)).toBe(false);
  });
});
