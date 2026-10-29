/**
 * Turns decoded Soroban event values into `LedgerEvent`s.
 *
 * `ScNode` is a deliberately small structural view of a Soroban `ScVal`, so
 * this module stays pure and unit-testable: the XDR layer in `soroban.ts` only
 * has to produce these shapes, and swapping the RPC library never touches the
 * domain mapping.
 *
 * Unknown topics decode to `null` rather than throwing. A contract upgrade that
 * adds events must not stop an already-running indexer, and a decision service
 * that cannot ingest is worse than one that is missing the new kinds.
 */
import type { Address, Effect, Grant, LedgerEvent, Timestamp, Triple } from '../domain/types.js';

export type ScNode =
  | { kind: 'void' }
  | { kind: 'bool'; value: boolean }
  | { kind: 'u32'; value: number }
  | { kind: 'u64'; value: bigint }
  | { kind: 'i128'; value: bigint }
  | { kind: 'symbol'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'address'; value: string }
  | { kind: 'vec'; value: readonly ScNode[] }
  | { kind: 'map'; value: readonly (readonly [ScNode, ScNode])[] }
  | { kind: 'other'; tag: string };

/** Which keygate contract emitted the event: the topic names overlap otherwise. */
export type ContractRole = 'core' | 'policy' | 'breaker';

export interface RawEvent {
  readonly topics: readonly ScNode[];
  readonly data: ScNode;
}

export class DecodeError extends Error {
  constructor(
    readonly reason: string,
    readonly topic: string,
  ) {
    super(`keygate event "${topic}": ${reason}`);
    this.name = 'DecodeError';
  }
}

function topicSymbol(raw: RawEvent): string | null {
  const first = raw.topics[0];
  return first && first.kind === 'symbol' ? first.value : null;
}

function text(node: ScNode | undefined, context: string): string {
  // Integrator-authored resource and action names are `String` on-chain, but a
  // future contract might use `Symbol` for a well-known action.
  if (node?.kind === 'string' || node?.kind === 'symbol') {
    return node.value;
  }
  throw new DecodeError(`${context} is not a string or symbol`, context);
}

function address(node: ScNode | undefined, context: string): Address {
  if (node?.kind !== 'address') {
    throw new DecodeError(`${context} is not an address`, context);
  }
  return node.value;
}

function unsigned(node: ScNode | undefined, context: string): bigint {
  if (node?.kind === 'u64' || node?.kind === 'u32') {
    return BigInt(node.value);
  }
  throw new DecodeError(`${context} is not an unsigned integer`, context);
}

function signed(node: ScNode | undefined, context: string): bigint {
  if (node?.kind === 'i128') {
    return node.value;
  }
  if (node?.kind === 'u64' || node?.kind === 'u32') {
    return BigInt(node.value);
  }
  throw new DecodeError(`${context} is not an integer`, context);
}

function boolean(node: ScNode | undefined, context: string): boolean {
  if (node?.kind !== 'bool') {
    throw new DecodeError(`${context} is not a boolean`, context);
  }
  return node.value;
}

function field(map: ScNode, name: string, context: string): ScNode {
  if (map.kind !== 'map') {
    throw new DecodeError(`${context} is not a struct`, context);
  }
  for (const [key, value] of map.value) {
    if ((key.kind === 'symbol' || key.kind === 'string') && key.value === name) {
      return value;
    }
  }
  throw new DecodeError(`${context} has no field "${name}"`, context);
}

function position(vec: ScNode, index: number, context: string): ScNode {
  if (vec.kind !== 'vec') {
    throw new DecodeError(`${context} is not a vector`, context);
  }
  const node = vec.value[index];
  if (node === undefined) {
    throw new DecodeError(`${context} is shorter than ${index + 1} elements`, context);
  }
  return node;
}

function tripleFrom(resource: ScNode, action: ScNode, context: string): Triple {
  return {
    resource: text(resource, `${context}.resource`),
    action: text(action, `${context}.action`),
  };
}

function grantFrom(data: ScNode, topic: string): Grant {
  const id = Number(unsigned(field(data, 'id', topic), `${topic}.id`));
  return {
    id,
    triple: tripleFrom(field(data, 'resource', topic), field(data, 'action', topic), topic),
    holder: address(field(data, 'holder', topic), `${topic}.holder`),
    issuer: address(field(data, 'issuer', topic), `${topic}.issuer`),
    expiresAt: Number(unsigned(field(data, 'expires_at', topic), `${topic}.expires_at`)),
  };
}

function effect(allow: boolean): Effect {
  return allow ? 'allow' : 'deny';
}

/**
 * @param role  which keygate contract produced this event
 * @param raw   topics and data, already lifted out of XDR
 * @param ledgerClosedAt  ledger timestamp of the closing ledger
 */
export function decodeEvent(
  role: ContractRole,
  raw: RawEvent,
  ledgerClosedAt: Timestamp,
): LedgerEvent | null {
  const topic = topicSymbol(raw);
  if (topic === null) {
    return null;
  }

  if (role === 'core') {
    switch (topic) {
      case 'issued':
        return { kind: 'grant_issued', grant: grantFrom(raw.data, topic) };
      case 'renewed':
        return { kind: 'grant_renewed', grant: grantFrom(raw.data, topic) };
      case 'revoked':
        return { kind: 'grant_revoked', grant: grantFrom(raw.data, topic) };
      case 'expired':
        return { kind: 'grant_expired', grant: grantFrom(raw.data, topic) };
      case 'paused':
        return { kind: 'registry_paused', paused: true };
      case 'unpause':
        return { kind: 'registry_paused', paused: false };
      case 'admin':
        return { kind: 'admin_changed', address: address(raw.data, topic) };
      // init and prop_adm carry no state the mirror projects.
      default:
        return null;
    }
  }

  if (role === 'policy') {
    switch (topic) {
      case 'rule_set': {
        const triple = tripleFrom(
          position(raw.data, 0, topic),
          position(raw.data, 1, topic),
          topic,
        );
        return {
          kind: 'rule_set',
          triple,
          effect: effect(boolean(position(raw.data, 2, topic), `${topic}.allow`)),
        };
      }
      case 'rule_del':
        return {
          kind: 'rule_removed',
          triple: tripleFrom(position(raw.data, 0, topic), position(raw.data, 1, topic), topic),
        };
      case 'default':
        return { kind: 'default_effect', effect: effect(boolean(raw.data, topic)) };
      case 'pol_adm':
        return { kind: 'admin_changed', address: address(raw.data, topic) };
      default:
        return null;
    }
  }

  switch (topic) {
    case 'cb_cfg':
      return {
        kind: 'budget_configured',
        resource: text(position(raw.data, 0, topic), `${topic}.resource`),
        limit: signed(position(raw.data, 1, topic), `${topic}.limit`),
        windowSeconds: Number(unsigned(position(raw.data, 2, topic), `${topic}.window`)),
      };
    case 'cb_use':
      return {
        kind: 'budget_charged',
        resource: text(position(raw.data, 0, topic), `${topic}.resource`),
        windowStart: Number(unsigned(position(raw.data, 1, topic), `${topic}.window_start`)),
        used: signed(position(raw.data, 2, topic), `${topic}.used`),
      };
    case 'cb_trip':
      return {
        kind: 'budget_tripped',
        resource: text(position(raw.data, 0, topic), `${topic}.resource`),
      };
    case 'cb_force':
      return { kind: 'budget_tripped', resource: text(raw.data, topic) };
    case 'cb_reset':
      return { kind: 'budget_reset', resource: text(raw.data, topic), at: ledgerClosedAt };
    default:
      return null;
  }
}
