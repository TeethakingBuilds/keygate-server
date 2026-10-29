/**
 * Deterministic signing of decisions.
 *
 * A caller usually sits behind a TLS terminator, a CDN or a sidecar proxy, so
 * "the response came from the server" is not always a property of the transport.
 * An HMAC over a canonical rendering of the request and answer together means a
 * downstream service can check that a specific decision was issued for a
 * specific holder, and cannot be replayed for someone else.
 *
 * The input is built field by field rather than by serialising an object,
 * because `JSON.stringify` ordering depends on insertion order and a signature
 * scheme that silently changes its own input is worse than no scheme at all.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { DecisionRequest } from '../domain/decide.js';
import type { Decision } from '../domain/decide.js';

const VERSION = 'keygate-decision-v1';

function field(name: string, value: string | number | null | undefined): string {
  return `${name}=${value ?? 'null'}`;
}

/** The exact bytes that get signed. Exported so a client can reproduce it. */
export function canonicalDecision(request: DecisionRequest, decision: Decision): string {
  const amount = request.amount === undefined ? 'null' : request.amount.toString();
  const parts = [
    VERSION,
    field('holder', request.holder),
    field('resource', request.triple.resource),
    field('action', request.triple.action),
    field('amount', amount),
    field('allowed', decision.allowed ? 'true' : 'false'),
    field('reason', decision.allowed ? null : decision.reason),
    field('grantId', decision.grantId),
    field('evaluatedAt', decision.evaluatedAt),
    field('expiresAt', decision.allowed ? decision.expiresAt : null),
  ];

  if (decision.allowed && decision.budget !== null) {
    parts.push(field('budgetResource', decision.budget.resource));
    parts.push(field('remaining', decision.budget.remaining));
    parts.push(field('requested', decision.budget.requested));
    parts.push(field('windowSeconds', decision.budget.windowSeconds));
  }

  // Length-prefix every field: a resource ending in "action=x" would otherwise
  // be able to imitate a different (resource, action) pair.
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

export function signDecision(
  signingKey: string,
  request: DecisionRequest,
  decision: Decision,
): string {
  return createHmac('sha256', signingKey)
    .update(canonicalDecision(request, decision))
    .digest('hex');
}

/** Constant-time comparison; a signature of the wrong length is simply invalid. */
export function verifyDecision(
  signingKey: string,
  request: DecisionRequest,
  decision: Decision,
  signature: string,
): boolean {
  const expected = Buffer.from(signDecision(signingKey, request, decision), 'hex');
  const provided = Buffer.from(signature, 'hex');
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}
