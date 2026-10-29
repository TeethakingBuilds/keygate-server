/**
 * Domain vocabulary shared by the mirror, the decision engine and the HTTP
 * layer. Everything here is transport-agnostic: no XDR, no RPC response shapes,
 * no Node types, so the interesting logic stays unit-testable.
 */

/** Seconds since the unix epoch, matching Soroban ledger timestamps. */
export type Timestamp = number;

/** A Stellar account (`G…`) or contract (`C…`) address. */
export type Address = string;

/**
 * The unit of authorisation: "may this address `action` on `resource`?".
 * Both halves are integrator-chosen strings, so keygate never has to know what
 * a "vault" is.
 */
export interface Triple {
  readonly resource: string;
  readonly action: string;
}

export interface Grant {
  readonly id: number;
  readonly holder: Address;
  readonly issuer: Address;
  readonly triple: Triple;
  /** Ledger timestamp after which the capability is invalid. */
  readonly expiresAt: Timestamp;
}

export type Effect = 'allow' | 'deny';

export interface Budget {
  readonly resource: string;
  readonly limit: bigint;
  readonly windowSeconds: number;
  readonly used: bigint;
  readonly tripped: boolean;
  readonly windowStart: Timestamp;
}

/**
 * A change observed on-chain, already decoded into domain terms.
 *
 * This is deliberately the *only* ingestion format: the mirror never learns
 * about XDR or RPC JSON, which is what keeps `decoder.ts` and `soroban.ts`
 * swappable for a test double or a different RPC provider.
 */
export type LedgerEvent =
  | { kind: 'grant_issued'; grant: Grant }
  | { kind: 'grant_renewed'; grant: Grant }
  | { kind: 'grant_revoked'; grant: Grant }
  | { kind: 'grant_expired'; grant: Grant }
  | { kind: 'rule_set'; triple: Triple; effect: Effect }
  | { kind: 'rule_removed'; triple: Triple }
  | { kind: 'default_effect'; effect: Effect }
  | { kind: 'budget_configured'; resource: string; limit: bigint; windowSeconds: number }
  | { kind: 'budget_charged'; resource: string; windowStart: Timestamp; used: bigint }
  | { kind: 'budget_tripped'; resource: string }
  | { kind: 'budget_reset'; resource: string; at: Timestamp }
  | { kind: 'registry_paused'; paused: boolean }
  | { kind: 'admin_changed'; address: Address };

/** Canonical, collision-free map key for a triple. */
export function tripleKey(triple: Triple): string {
  // Length prefixes rather than a separator: resource and action are arbitrary
  // strings, so any delimiter we pick could occur inside one.
  return `${triple.resource.length}:${triple.resource}|${triple.action.length}:${triple.action}`;
}

/** Map key for the single live grant covering a triple and holder. */
export function capabilityKey(triple: Triple, holder: Address): string {
  return `${tripleKey(triple)}|${holder.length}:${holder}`;
}
